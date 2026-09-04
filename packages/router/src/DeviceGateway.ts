import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { Server as HttpServer } from "node:http";
import { createNoopLogger, type ILogger } from "cyrus-core";
import {
	type DeviceFrame,
	HEARTBEAT_INTERVAL_MS,
	type HelloFrame,
	LOG_INGEST_CAPABILITY,
	MAX_MISSED_HEARTBEATS,
	PROTOCOL_VERSION,
	parseDeviceFrame,
	type RpcResponseFrame,
	RUN_FACTS_CAPABILITY,
	SESSIONS_QUERY_CAPABILITY,
	SPAN_INGEST_CAPABILITY,
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
 *  - "log"(deviceId: number, frame: LogFrame)
 *  - "span"(deviceId: number, frame: SpanFrame)
 */
export class DeviceGateway extends EventEmitter {
	private readonly store: RouterStore;
	private readonly heartbeatMs: number;
	private readonly logger: ILogger;
	private readonly sockets = new Map<number, WebSocket>();
	private readonly socketState = new WeakMap<WebSocket, SocketState>();
	private readonly capabilities = new Map<number, Set<string>>();
	/**
	 * Devices whose progress-clock stamp is currently failing, so the warning is
	 * logged once per device per outage rather than once per `rpc_request`.
	 */
	private readonly progressStampFailed = new Set<number>();
	private readonly pendingSessionQueries = new Map<
		string,
		{ resolve: (v: string[] | undefined) => void; timer: NodeJS.Timeout }
	>();
	private wss: WebSocketServer | undefined;
	private heartbeatInterval: NodeJS.Timeout | undefined;

	constructor(
		store: RouterStore,
		opts?: { heartbeatMs?: number; logger?: ILogger },
	) {
		super();
		this.store = store;
		this.heartbeatMs = opts?.heartbeatMs ?? HEARTBEAT_INTERVAL_MS;
		this.logger = opts?.logger ?? createNoopLogger();
	}

	attach(httpServer: HttpServer, path: string): void {
		const wss = new WebSocketServer({ server: httpServer, path });
		this.wss = wss;

		this.logger.info(
			`Device gateway listening on ${path} (heartbeat ${this.heartbeatMs}ms)`,
		);

		wss.on("connection", (ws) => {
			this.handleConnection(ws);
		});

		wss.on("error", (err) => {
			this.logger.error("Device gateway WebSocket server error", err);
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
		if (pending.length > 0) {
			this.logger.info(
				`Delivering ${pending.length} pending event(s) to device ${deviceId}`,
			);
		}
		for (const { seq, payloadJson, traceparent, tracestate } of pending) {
			ws.send(
				JSON.stringify({
					type: "event",
					seq,
					event: JSON.parse(payloadJson) as unknown,
					// The trace context stored WITH the row, not one captured here.
					// This loop runs from a socket "connection" handler or a
					// reconnect, which is an unrelated call stack — re-deriving the
					// context at send time would attach the event to whatever the
					// gateway happened to be doing, which is the one thing that is
					// certainly not its cause.
					...(traceparent ? { traceparent } : {}),
					...(tracestate ? { tracestate } : {}),
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
			this.logger.warn(
				`Closing device socket: no hello within ${HELLO_TIMEOUT_MS}ms`,
			);
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

		ws.on("close", (code, reason) => {
			if (state.helloTimer) clearTimeout(state.helloTimer);
			const deviceId = state.deviceId;
			if (deviceId === undefined) {
				// Never got past hello — worth a line, since a device stuck in a
				// reconnect loop shows up here and nowhere else.
				this.logger.info(
					`Unauthenticated device socket closed (code ${code}${
						reason.length > 0 ? `, ${reason.toString()}` : ""
					})`,
				);
				return;
			}
			this.store.touchDevice(deviceId, Date.now());
			// Only treat this as a real disconnect if this socket is still
			// the one on record for the device — a newer connection may
			// have already replaced it (second-connection-wins), in which
			// case the registry already points at the new socket and this
			// stale close must not clear it or report the device offline.
			if (this.sockets.get(deviceId) === ws) {
				this.sockets.delete(deviceId);
				this.capabilities.delete(deviceId);
				this.recordRunConnectivity(deviceId, false);
				this.logger.info(
					`Device ${deviceId} disconnected (code ${code}${
						reason.length > 0 ? `, ${reason.toString()}` : ""
					})`,
				);
				this.emit("deviceDisconnected", deviceId);
			} else {
				this.logger.info(
					`Stale socket for device ${deviceId} closed (code ${code}); a newer connection already replaced it`,
				);
			}
		});

		ws.on("error", (err) => {
			// "close" still follows and handles cleanup — but the error itself was
			// previously swallowed entirely, which hid every transport-level
			// failure behind an unexplained disconnect.
			this.logger.warn(
				`Device socket error${
					state.deviceId !== undefined ? ` for device ${state.deviceId}` : ""
				}`,
				err,
			);
		});
	}

	private handleMessage(ws: WebSocket, state: SocketState, raw: string): void {
		let frame: DeviceFrame;
		try {
			frame = parseDeviceFrame(raw);
		} catch (err) {
			this.logger.warn(
				`Closing device socket${
					state.deviceId !== undefined ? ` for device ${state.deviceId}` : ""
				}: unparseable frame`,
				err,
			);
			ws.close(1002, "invalid frame");
			return;
		}

		if (frame.type === "hello") {
			this.handleHello(ws, state, frame);
			return;
		}

		// All other frame types require a prior successful hello.
		if (state.deviceId === undefined) {
			this.logger.warn(
				`Closing device socket: received '${frame.type}' before hello`,
			);
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
				// The device's PROGRESS stamp, and the only proof-of-work signal the
				// router has. A sandbox holds no Linear token, so every thought,
				// action and response its agent posts arrives as one of these: a
				// working session stamps this every few seconds, and one that has
				// silently stopped working never stamps it again.
				// `ContainerLifecycle.noteStranded` thresholds on it (NOR-402).
				//
				// Sits next to the `touchDevice` heartbeat stamps above deliberately —
				// both are "what did this device just do", and keeping them in one
				// place is what stops a future frame type being added with liveness
				// bookkeeping half-done. Stamped for the ATTEMPT, before dispatch: a
				// refused or failed RPC is still an agent that is awake and trying,
				// and counting it as no progress would report a session stuck in a
				// retry loop as stranded.
				//
				// Guarded, unlike its neighbours: `handleMessage` runs straight off
				// `ws.on("message")` with only `parseDeviceFrame` inside a try, so a
				// store throw here (SQLITE_FULL on the router's ephemeral disk, a
				// readonly database after a bad restore) would escape into the socket
				// callback as an unhandled exception and take the router down for
				// every teammate. The `log` and `span` branches below both carry an
				// explicit contract that a device frame must never break the socket it
				// arrived on; a purely diagnostic stamp has even less business doing
				// so, and losing one sample only delays the detector by a tick.
				//
				// Latched. `rpc_request` is the highest-frequency device->router
				// frame there is — every thought, action and response an agent posts
				// — and the failures named above are persistent, not transient, so
				// an unlatched warn turns one full disk into a per-frame log storm
				// billed per GB. Reported once per device, re-armed on the next
				// success so a recovered store reports again if it breaks later.
				try {
					this.store.markDeviceProgress(deviceId, Date.now());
					this.progressStampFailed.delete(deviceId);
				} catch (err) {
					if (!this.progressStampFailed.has(deviceId)) {
						this.progressStampFailed.add(deviceId);
						this.logger.warn(
							`Failed to stamp the progress clock for device ${deviceId}; ` +
								`the stranded-session detector may report it early. ` +
								`Further failures for this device are suppressed until one succeeds.`,
							err,
						);
					}
				}
				this.emit("rpc", deviceId, frame);
				break;
			case "session_state":
				this.emit("sessionState", deviceId, frame);
				break;
			case "log":
				// Never logged or acked here — a device's log line must not be able
				// to generate router log lines of its own, and there is nothing to
				// confirm (see the `log` frame's fire-and-forget contract).
				this.emit("log", deviceId, frame);
				break;
			case "span":
				// Same contract as `log`: fire-and-forget, nothing to ack, and
				// never logged here — a relayed span must not be able to generate
				// router log lines, which would in turn generate router spans.
				this.emit("span", deviceId, frame);
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
			this.logger.error(
				`Rejecting device hello: protocol version mismatch (server ${PROTOCOL_VERSION}, device ${frame.protocolVersion}). The device will stop reconnecting.`,
			);
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
			this.logger.error(
				"Rejecting device hello: no device matches the presented token",
			);
			ws.send(JSON.stringify({ type: "hello_error", reason: "invalid token" }));
			ws.close();
			return;
		}

		const { deviceId, userId } = found;

		// Single device, newest wins: terminate any existing connection for
		// this device before registering the new one.
		const existing = this.sockets.get(deviceId);
		if (existing && existing !== ws) {
			this.logger.warn(
				`Device ${deviceId} reconnected while an older socket was still open; terminating the older one`,
			);
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
				// Tell the device which newer frame types and frame VALUES we can
				// parse. Without this a worker that forwarded logs to an older
				// router would have its socket closed as "invalid frame" on every
				// log line — see LOG_INGEST_CAPABILITY. RUN_FACTS_CAPABILITY is the
				// same gate for the `waiting` session_state value, which an older
				// router's closed `state` enum rejects the same way.
				capabilities: [
					LOG_INGEST_CAPABILITY,
					SPAN_INGEST_CAPABILITY,
					RUN_FACTS_CAPABILITY,
				],
			}),
		);

		this.store.touchDevice(deviceId, Date.now());

		// Detect and repair a regressed event-sequence counter BEFORE the purge
		// below, which would otherwise delete the very events the regression
		// stranded. A device whose lastAckedSeq has overtaken our next_seq
		// discards everything we send it as a duplicate, forever and silently
		// — this is the only point at which the two numbers are ever in the
		// same place, so it is the only place the skew can be caught. See
		// NOR-263 and RouterStore.reconcileDeviceSeq.
		const seqRepair = this.store.reconcileDeviceSeq(
			deviceId,
			frame.lastAckedSeq,
			Date.now(),
		);
		if (seqRepair.repaired) {
			// ERROR, not WARN: this is router-side data loss, and because a
			// dropped event's row is deleted by the device's re-ack, this line
			// is the only durable trace the skew ever existed.
			this.logger.error(
				`Device ${deviceId} event sequence regressed: stored next_seq ${seqRepair.previousNextSeq} <= device lastAckedSeq ${frame.lastAckedSeq}. ` +
					`Every event issued to this device would have been discarded as a duplicate. ` +
					`Fast-forwarded next_seq to ${seqRepair.nextSeq}` +
					(seqRepair.resequenced > 0
						? ` and resequenced ${seqRepair.resequenced} queued event(s) above the device's mark.`
						: ".") +
					` Likely cause: the router restored SQLite from a stale state backup (see StateBackup).`,
			);
		}

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

		// The single most useful liveness line in the router: for a container
		// target this is the first proof the sandbox's worker process actually
		// came up, which ACA's "Running" infrastructure state does not tell us.
		this.logger.info(
			`Device ${deviceId} connected (user ${userId}, lastAckedSeq ${frame.lastAckedSeq}, ${
				frame.activeSessions?.length ?? 0
			} active session(s), capabilities: ${
				state.capabilities && state.capabilities.size > 0
					? [...state.capabilities].join(",")
					: "none"
			})`,
		);

		// Connectivity is recorded onto the device's live runs HERE rather than
		// from a "deviceConnected" listener, so it cannot be lost to listener
		// ordering or to a listener that throws before reaching the store. It is
		// what makes a drop-and-reconnect between two operator polls observable at
		// all: the socket registry is in-memory, so without this the transition
		// leaves no trace anywhere.
		this.recordRunConnectivity(deviceId, true);

		// Carry the device's declared active sessions so a listener can
		// reconcile stale issue locks. Emitted after the lastAckedSeq purge
		// above and before deliverPending, so a reconcile handler sees the true
		// set of still-undelivered events (via store.hasPendingEvents).
		this.emit("deviceConnected", deviceId, frame.activeSessions);

		this.deliverPending(deviceId);
	}

	/**
	 * Mirrors the socket registry onto the device's non-terminal runs.
	 *
	 * Best-effort: a store failure must never take down a connect or a close.
	 * Losing one connectivity entry costs an operator a transition in the change
	 * feed; throwing here would leave a socket half-registered, or abort the
	 * cleanup that removes it — a far worse trade for a monitoring fact.
	 *
	 * Idempotent in the store, so a reconnect from a device that was already
	 * recorded online appends nothing.
	 */
	private recordRunConnectivity(deviceId: number, online: boolean): void {
		try {
			this.store.setRunWorkerConnectivity(deviceId, online, Date.now());
		} catch (err) {
			this.logger.warn(
				`Could not record worker connectivity for device ${deviceId}`,
				err,
			);
		}
	}

	private runHeartbeat(): void {
		for (const ws of this.sockets.values()) {
			const state = this.socketState.get(ws);
			if (!state) continue;
			if (!state.isAlive) {
				state.missedHeartbeats += 1;
				if (state.missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
					this.logger.warn(
						`Terminating device ${state.deviceId} socket: missed ${state.missedHeartbeats} consecutive heartbeats (${
							state.missedHeartbeats * this.heartbeatMs
						}ms of silence)`,
					);
					ws.terminate();
					continue;
				}
				this.logger.debug(
					`Device ${state.deviceId} missed heartbeat ${state.missedHeartbeats}/${MAX_MISSED_HEARTBEATS}`,
				);
			} else {
				state.missedHeartbeats = 0;
			}
			state.isAlive = false;
			ws.ping();
		}
	}
}
