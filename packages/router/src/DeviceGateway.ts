import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Server as HttpServer } from "node:http";
import {
	type DeviceFrame,
	HEARTBEAT_INTERVAL_MS,
	type HelloFrame,
	MAX_MISSED_HEARTBEATS,
	PROTOCOL_VERSION,
	parseDeviceFrame,
	type RpcResponseFrame,
	SESSIONS_QUERY_CAPABILITY,
} from "cyrus-router-protocol";
import { WebSocket, WebSocketServer } from "ws";
import type { RouterStore } from "./RouterStore.js";

const HELLO_TIMEOUT_MS = 10_000;

interface SocketState {
	deviceId?: number;
	isAlive: boolean;
	missedHeartbeats: number;
	helloTimer?: NodeJS.Timeout;
	capabilities?: Set<string>;
}

/**
 * WebSocket server that authenticates devices, delivers queued events in
 * order, receives acks, and emits ingress events (rpc / session_state).
 *
 * Emits:
 *  - "deviceConnected"(deviceId: number, activeSessions?: string[])
 *  - "deviceDisconnected"(deviceId: number)
 *  - "rpc"(deviceId: number, frame: RpcRequestFrame)
 *  - "sessionState"(deviceId: number, frame: SessionStateFrame)
 *  - "eventAck"(deviceId: number, seq: number)
 */
export class DeviceGateway extends EventEmitter {
	private readonly store: RouterStore;
	private readonly heartbeatMs: number;
	private readonly sockets = new Map<number, WebSocket>();
	private readonly socketState = new WeakMap<WebSocket, SocketState>();
	private readonly capabilities = new Map<number, Set<string>>();
	private readonly pendingSessionQueries = new Map<
		string,
		{ resolve: (v: string[] | undefined) => void; timer: NodeJS.Timeout }
	>();
	private wss: WebSocketServer | undefined;
	private heartbeatInterval: NodeJS.Timeout | undefined;

	constructor(store: RouterStore, opts?: { heartbeatMs?: number }) {
		super();
		this.store = store;
		this.heartbeatMs = opts?.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
	}

	attach(httpServer: HttpServer, path: string): void {
		const wss = new WebSocketServer({ server: httpServer, path });
		this.wss = wss;

		wss.on("connection", (ws) => {
			this.handleConnection(ws);
		});

		this.heartbeatInterval = setInterval(() => {
			this.runHeartbeat();
		}, this.heartbeatMs);
	}

	isOnline(deviceId: number): boolean {
		const ws = this.sockets.get(deviceId);
		return ws !== undefined && ws.readyState === WebSocket.OPEN;
	}

	deliverPending(deviceId: number): void {
		const ws = this.sockets.get(deviceId);
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		// Enforce TTL at delivery time: an event whose expires_ms has already
		// passed must never be handed to a reconnecting client, even if the
		// periodic store.expireEvents(Date.now()) sweep (owned elsewhere)
		// hasn't physically deleted the row yet. Delivering a stale prompt to
		// a returning device is worse than failing, per the design spec.
		const pending = this.store.pendingEvents(deviceId, 0, Date.now());
		for (const { seq, payloadJson } of pending) {
			ws.send(
				JSON.stringify({
					type: "event",
					seq,
					event: JSON.parse(payloadJson) as unknown,
				}),
			);
		}
	}

	sendRpcResponse(deviceId: number, frame: RpcResponseFrame): void {
		const ws = this.sockets.get(deviceId);
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify(frame));
	}

	/**
	 * Confirms a `session_state` frame so the device can drop it from its
	 * durable buffer. Only sent AFTER the lock/affinity release has been applied
	 * — an unacked frame is replayed on the device's next reconnect, and the
	 * release is idempotent, so at-least-once delivery is safe.
	 */
	sendSessionStateAck(deviceId: number, id: string): void {
		const ws = this.sockets.get(deviceId);
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		ws.send(JSON.stringify({ type: "session_state_ack", id }));
	}

	/**
	 * Asks a device which sessions it is currently running.
	 *
	 * Resolves `undefined` — never an empty array — when the device is offline,
	 * does not advertise the capability, or fails to answer in time. Callers
	 * treat `undefined` as "can't tell, skip" and an empty array as "running
	 * nothing". Collapsing the two would let a silent device be read as
	 * permission to reclaim its affinity.
	 */
	async querySessions(
		deviceId: number,
		timeoutMs: number,
	): Promise<string[] | undefined> {
		const ws = this.sockets.get(deviceId);
		if (!ws || ws.readyState !== WebSocket.OPEN) return undefined;
		if (!this.capabilities.get(deviceId)?.has(SESSIONS_QUERY_CAPABILITY)) {
			return undefined;
		}

		const id = randomUUID();
		return new Promise<string[] | undefined>((resolve) => {
			const timer = setTimeout(() => {
				this.pendingSessionQueries.delete(id);
				resolve(undefined);
			}, timeoutMs);
			timer.unref?.();
			this.pendingSessionQueries.set(id, { resolve, timer });
			ws.send(JSON.stringify({ type: "sessions_query", id }));
		});
	}

	close(): void {
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = undefined;
		}
		for (const ws of this.sockets.values()) {
			// Detach our lifecycle handlers BEFORE closing: the "close" handler
			// calls store.touchDevice(), and on a full gateway shutdown the store
			// may be torn down moments later — a late close event would then throw
			// "database connection is not open". A swallowing error handler absorbs
			// any socket error surfaced during the close. Disconnect bookkeeping is
			// irrelevant once the whole gateway is going away.
			ws.removeAllListeners();
			ws.on("error", () => {});
			ws.close();
		}
		// Settle anything in flight so a shutdown cannot hang a caller.
		for (const [id, pending] of this.pendingSessionQueries) {
			clearTimeout(pending.timer);
			pending.resolve(undefined);
			this.pendingSessionQueries.delete(id);
		}
		this.capabilities.clear();
		this.sockets.clear();
		if (this.wss) {
			this.wss.close();
			this.wss = undefined;
		}
	}

	private handleConnection(ws: WebSocket): void {
		const state: SocketState = { isAlive: true, missedHeartbeats: 0 };
		this.socketState.set(ws, state);

		state.helloTimer = setTimeout(() => {
			ws.close(1002, "hello timeout");
		}, HELLO_TIMEOUT_MS);

		ws.on("pong", () => {
			state.isAlive = true;
			state.missedHeartbeats = 0;
			if (state.deviceId !== undefined) {
				this.store.touchDevice(state.deviceId, Date.now());
			}
		});

		ws.on("message", (raw) => {
			this.handleMessage(ws, state, raw.toString());
		});

		ws.on("close", () => {
			if (state.helloTimer) clearTimeout(state.helloTimer);
			const deviceId = state.deviceId;
			if (deviceId === undefined) return;
			this.store.touchDevice(deviceId, Date.now());
			// Only treat this as a real disconnect if this socket is still
			// the one on record for the device — a newer connection may
			// have already replaced it (second-connection-wins), in which
			// case the registry already points at the new socket and this
			// stale close must not clear it or report the device offline.
			if (this.sockets.get(deviceId) === ws) {
				this.sockets.delete(deviceId);
				this.capabilities.delete(deviceId);
				this.emit("deviceDisconnected", deviceId);
			}
		});

		ws.on("error", () => {
			// Swallow — "close" will follow and handle cleanup.
		});
	}

	private handleMessage(ws: WebSocket, state: SocketState, raw: string): void {
		let frame: DeviceFrame;
		try {
			frame = parseDeviceFrame(raw);
		} catch {
			ws.close(1002, "invalid frame");
			return;
		}

		if (frame.type === "hello") {
			this.handleHello(ws, state, frame);
			return;
		}

		// All other frame types require a prior successful hello.
		if (state.deviceId === undefined) {
			ws.close(1002, "hello required");
			return;
		}
		const deviceId = state.deviceId;

		switch (frame.type) {
			case "event_ack":
				this.store.ackEvent(deviceId, frame.seq);
				this.emit("eventAck", deviceId, frame.seq);
				break;
			case "rpc_request":
				this.emit("rpc", deviceId, frame);
				break;
			case "session_state":
				this.emit("sessionState", deviceId, frame);
				break;
			case "sessions_report": {
				const pending = this.pendingSessionQueries.get(frame.id);
				if (!pending) break; // Late or unsolicited reply — the timeout already won.
				this.pendingSessionQueries.delete(frame.id);
				clearTimeout(pending.timer);
				pending.resolve(frame.activeSessions);
				break;
			}
		}
	}

	private handleHello(
		ws: WebSocket,
		state: SocketState,
		frame: HelloFrame,
	): void {
		if (state.helloTimer) {
			clearTimeout(state.helloTimer);
			state.helloTimer = undefined;
		}

		// Fail closed on a protocol version mismatch, checked BEFORE token
		// lookup so a version-skewed device never reaches authentication —
		// this turns a future protocol/device skew into a clean handshake
		// rejection (the client treats hello_error as fatal and stops
		// reconnecting) instead of an opaque frame-parse failure later on.
		if (frame.protocolVersion !== PROTOCOL_VERSION) {
			ws.send(
				JSON.stringify({
					type: "hello_error",
					reason: `protocol version mismatch: server expects ${PROTOCOL_VERSION}, device sent ${frame.protocolVersion}`,
				}),
			);
			ws.close();
			return;
		}

		const found = this.store.getDeviceByToken(frame.deviceToken);
		if (!found) {
			ws.send(JSON.stringify({ type: "hello_error", reason: "invalid token" }));
			ws.close();
			return;
		}

		const { deviceId, userId } = found;

		// Single device, newest wins: terminate any existing connection for
		// this device before registering the new one.
		const existing = this.sockets.get(deviceId);
		if (existing && existing !== ws) {
			existing.terminate();
		}

		state.deviceId = deviceId;
		this.sockets.set(deviceId, ws);
		state.capabilities = new Set(frame.capabilities ?? []);
		this.capabilities.set(deviceId, state.capabilities);

		ws.send(
			JSON.stringify({
				type: "hello_ack",
				user: { id: String(userId) },
				serverVersion: "1",
				// Advertise our real ping cadence so the device's liveness
				// watchdog terminates its socket at the same point we terminate
				// ours, even when this router runs a non-default heartbeatMs.
				heartbeatMs: this.heartbeatMs,
			}),
		);

		this.store.touchDevice(deviceId, Date.now());

		// Ack everything <= lastAckedSeq the client already has. Uses the
		// same real-clock nowMs as deliverPending for consistency; an
		// already-expired row simply won't be returned here and is left for
		// the periodic store.expireEvents(Date.now()) sweep to remove
		// instead — functionally equivalent, since deliverPending would
		// filter it out too.
		const alreadyAcked = this.store
			.pendingEvents(deviceId, 0, Date.now())
			.filter((e) => e.seq <= frame.lastAckedSeq);
		for (const e of alreadyAcked) {
			this.store.ackEvent(deviceId, e.seq);
		}

		// Carry the device's declared active sessions so a listener can
		// reconcile stale issue locks. Emitted after the lastAckedSeq purge
		// above and before deliverPending, so a reconcile handler sees the true
		// set of still-undelivered events (via store.hasPendingEvents).
		this.emit("deviceConnected", deviceId, frame.activeSessions);

		this.deliverPending(deviceId);
	}

	private runHeartbeat(): void {
		for (const ws of this.sockets.values()) {
			const state = this.socketState.get(ws);
			if (!state) continue;
			if (!state.isAlive) {
				state.missedHeartbeats += 1;
				if (state.missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
					ws.terminate();
					continue;
				}
			} else {
				state.missedHeartbeats = 0;
			}
			state.isAlive = false;
			ws.ping();
		}
	}
}
