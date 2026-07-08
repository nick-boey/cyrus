import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
	appendFileSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	type EventFrame,
	type HelloAckFrame,
	type HelloErrorFrame,
	type HelloFrame,
	PROTOCOL_VERSION,
	parseServerFrame,
	type RpcRequestFrame,
	type RpcResponseFrame,
	type ServerFrame,
} from "cyrus-router-protocol";
import { WebSocket } from "ws";

const BACKOFF_CAP_MS = 60_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;

export interface RouterConnectionOptions {
	/** Base router URL; the `/device` path is appended automatically. */
	url: string;
	deviceToken: string;
	/** Persists last-acked seq, the outbound buffer, and the durable inbox. */
	stateDir: string;
	/** Default 1_000ms; exponential backoff capped at 60_000ms. */
	reconnectBaseMs?: number;
	/** Default 30_000ms. */
	rpcTimeoutMs?: number;
}

/**
 * Documented event map (see EventEmitter): the class extends EventEmitter so
 * `on`/`once` stay untyped at the call site, but this describes the contract.
 *  - "connected"   (helloAck: HelloAckFrame)
 *  - "disconnected"()
 *  - "event"       (event: unknown, seq: number)
 *  - "error"       (error: Error)
 */
export interface RouterConnectionEventMap {
	connected: [helloAck: HelloAckFrame];
	disconnected: [];
	event: [event: unknown, seq: number];
	error: [error: Error];
}

/** Error thrown/rejected for RPC failures; `retryable` distinguishes transient
 * transport failures (disconnect, timeout, offline) from a server-side reject. */
export class RouterRpcError extends Error {
	readonly retryable: boolean;
	constructor(message: string, retryable: boolean) {
		super(message);
		this.name = "RouterRpcError";
		this.retryable = retryable;
	}
}

interface PendingRpc {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
}

interface OutboundEntry {
	mutationId: string;
	method: string;
	params: unknown[];
}

interface InboxEntry {
	seq: number;
	event: unknown;
}

interface PersistedState {
	lastAckedSeq: number;
}

/**
 * Device-side WebSocket client for the Cyrus Router.
 *
 * Responsibilities:
 *  - Dials `<url>/device`, authenticates via a `hello` frame carrying the
 *    persisted `lastAckedSeq`, and reconnects with exponential backoff.
 *  - Delivers server `event` frames exactly-once-ish: an event is durably
 *    written to a local inbox BEFORE it is acked, so a crash between ack and
 *    consumer dispatch replays the event on the next startup rather than
 *    dropping it (Codex finding 3).
 *  - Issues RPCs with a pending map + per-call timeout.
 *  - Buffers mutating RPCs while offline (`bufferedRpc`) to a durable JSONL
 *    file and replays them FIFO — carrying a stable `mutationId` so the router
 *    dedupes idempotent replays (finding 4).
 */
export class RouterConnection extends EventEmitter {
	private readonly wsUrl: string;
	private readonly deviceToken: string;
	private readonly reconnectBaseMs: number;
	private readonly rpcTimeoutMs: number;

	private readonly stateFile: string;
	private readonly outboundFile: string;
	private readonly inboxFile: string;

	private ws: WebSocket | undefined;
	private started = false;
	private stopped = false;
	private _connected = false;
	private reconnectAttempts = 0;
	private reconnectTimer: NodeJS.Timeout | undefined;

	private lastAckedSeq: number;
	private outboundEntries: OutboundEntry[];
	private inboxEntries: InboxEntry[];
	private readonly pending = new Map<string, PendingRpc>();

	constructor(opts: RouterConnectionOptions) {
		super();
		this.wsUrl = `${opts.url.replace(/\/+$/, "")}/device`;
		this.deviceToken = opts.deviceToken;
		this.reconnectBaseMs = opts.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
		this.rpcTimeoutMs = opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;

		mkdirSync(opts.stateDir, { recursive: true });
		this.stateFile = join(opts.stateDir, "router-connection.json");
		this.outboundFile = join(opts.stateDir, "outbound-buffer.jsonl");
		this.inboxFile = join(opts.stateDir, "inbox.jsonl");

		this.lastAckedSeq = this.loadLastAckedSeq();
		this.outboundEntries = this.loadOutboundEntries();
		this.inboxEntries = this.loadInboxEntries();
	}

	get connected(): boolean {
		return this._connected;
	}

	/** Begins the dial loop. Safe to call once; later calls are ignored. */
	connect(): void {
		if (this.started) return;
		this.started = true;
		this.stopped = false;
		// Replay any acked-but-unprocessed inbox entries BEFORE handling any
		// new frames, so a crash between ack and dispatch never drops an event.
		// Deferred to a microtask so callers that attach listeners immediately
		// after connect() still observe the replay; it still runs before any
		// socket IO (dial's "open"/"event" frames are later macrotasks).
		queueMicrotask(() => this.replayInbox());
		this.dial();
	}

	/** Stops reconnecting and closes the socket. */
	close(): void {
		this.stopped = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		this._connected = false;
		this.teardownSocket();
	}

	/** Issues an RPC. Rejects if called while disconnected, on `{ok:false}`,
	 * or on timeout. A disconnect rejects all in-flight RPCs (retryable). */
	rpc(method: string, params: unknown[]): Promise<unknown> {
		return this.sendRpc(method, params);
	}

	/**
	 * Mutating RPC with offline durability. Online → `rpc()` carrying a fresh
	 * `mutationId`. Offline → durably append `{mutationId, method, params}` and
	 * resolve immediately with a synthetic `{ success: true }` payload
	 * (compatible with AgentActivityPayload — LinearActivitySink reads
	 * `.success`). Replayed FIFO on reconnect with the same `mutationId`.
	 */
	bufferedRpc(method: string, params: unknown[]): Promise<unknown> {
		const mutationId = randomUUID();
		if (this.isOnline()) {
			return this.sendRpc(method, params, mutationId);
		}
		this.appendOutboundEntry({ mutationId, method, params });
		return Promise.resolve({ success: true });
	}

	/** Sends a session_state frame (best-effort; dropped if offline). */
	sendSessionState(
		sessionId: string,
		state: "complete" | "error" | "stopped",
	): void {
		if (!this.isOnline() || !this.ws) return;
		this.ws.send(JSON.stringify({ type: "session_state", sessionId, state }));
	}

	// ── Dialing / lifecycle ────────────────────────────────────────────────

	private isOnline(): boolean {
		return (
			this._connected &&
			this.ws !== undefined &&
			this.ws.readyState === WebSocket.OPEN
		);
	}

	private dial(): void {
		if (this.stopped) return;
		const ws = new WebSocket(this.wsUrl);
		this.ws = ws;
		let settled = false;
		const onDown = (): void => {
			if (settled) return;
			settled = true;
			if (this.ws === ws) this.ws = undefined;
			this.handleDisconnect();
		};
		ws.on("open", () => this.sendHello(ws));
		ws.on("message", (raw) => this.handleMessage(raw.toString()));
		ws.on("close", onDown);
		ws.on("error", onDown);
	}

	/** Detaches our lifecycle listeners and closes the current socket. A
	 * swallowing error handler absorbs the late "closed before established"
	 * error ws emits when a still-CONNECTING socket is closed during teardown. */
	private teardownSocket(): void {
		const ws = this.ws;
		this.ws = undefined;
		if (!ws) return;
		ws.removeAllListeners();
		ws.on("error", () => {});
		ws.close();
	}

	private sendHello(ws: WebSocket): void {
		const frame: HelloFrame = {
			type: "hello",
			deviceToken: this.deviceToken,
			protocolVersion: PROTOCOL_VERSION,
			lastAckedSeq: this.lastAckedSeq,
		};
		ws.send(JSON.stringify(frame));
	}

	private handleDisconnect(): void {
		const wasConnected = this._connected;
		this._connected = false;
		this.rejectAllPending(new RouterRpcError("connection lost", true));
		if (wasConnected) this.emit("disconnected");
		if (!this.stopped) this.scheduleReconnect();
	}

	private scheduleReconnect(): void {
		if (this.stopped) return;
		const delay = Math.min(
			this.reconnectBaseMs * 2 ** this.reconnectAttempts,
			BACKOFF_CAP_MS,
		);
		this.reconnectAttempts += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			this.dial();
		}, delay);
	}

	// ── Frame handling ─────────────────────────────────────────────────────

	private handleMessage(raw: string): void {
		let frame: ServerFrame;
		try {
			frame = parseServerFrame(raw);
		} catch {
			return; // Ignore unparseable / unknown frames.
		}
		switch (frame.type) {
			case "hello_ack":
				this.onHelloAck(frame);
				break;
			case "hello_error":
				this.onHelloError(frame);
				break;
			case "event":
				this.onEvent(frame);
				break;
			case "rpc_response":
				this.onRpcResponse(frame);
				break;
		}
	}

	private onHelloAck(frame: HelloAckFrame): void {
		this._connected = true;
		this.reconnectAttempts = 0;
		// Replay the outbound buffer FIFO, then announce the connection.
		void this.replayOutboundBuffer();
		this.emit("connected", frame);
	}

	private onHelloError(frame: HelloErrorFrame): void {
		// Bad token is fatal — stop reconnecting and surface to the user.
		this.stopped = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = undefined;
		}
		this._connected = false;
		this.teardownSocket();
		this.emit("error", new Error(`hello rejected: ${frame.reason}`));
	}

	private onEvent(frame: EventFrame): void {
		if (frame.seq <= this.lastAckedSeq) {
			// Duplicate: re-ack and drop without re-emitting.
			this.sendAck(frame.seq);
			return;
		}
		// Durability order: append to inbox FIRST, then ack + persist seq, then
		// emit, then mark processed once the emit returns.
		this.appendInboxEntry({ seq: frame.seq, event: frame.event });
		this.sendAck(frame.seq);
		this.lastAckedSeq = frame.seq;
		this.persistLastAckedSeq(frame.seq);
		this.emit("event", frame.event, frame.seq);
		// If we were shut down/closed during the emit (e.g. a crash), leave the
		// entry unprocessed so it replays on the next startup.
		if (!this.stopped) this.markInboxProcessed(frame.seq);
	}

	private onRpcResponse(frame: RpcResponseFrame): void {
		const pending = this.pending.get(frame.id);
		if (!pending) return;
		this.pending.delete(frame.id);
		clearTimeout(pending.timer);
		if (frame.ok) {
			pending.resolve(frame.result);
		} else {
			pending.reject(new RouterRpcError(frame.error ?? "rpc failed", false));
		}
	}

	private sendAck(seq: number): void {
		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			this.ws.send(JSON.stringify({ type: "event_ack", seq }));
		}
	}

	// ── RPC plumbing ───────────────────────────────────────────────────────

	private sendRpc(
		method: string,
		params: unknown[],
		mutationId?: string,
	): Promise<unknown> {
		if (!this.isOnline() || !this.ws) {
			return Promise.reject(new RouterRpcError("not connected", true));
		}
		const ws = this.ws;
		const id = randomUUID();
		const frame: RpcRequestFrame = {
			type: "rpc_request",
			id,
			method,
			params,
			...(mutationId ? { mutationId } : {}),
		};
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new RouterRpcError("rpc timeout", true));
			}, this.rpcTimeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			ws.send(JSON.stringify(frame));
		});
	}

	private rejectAllPending(error: RouterRpcError): void {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}

	private async replayOutboundBuffer(): Promise<void> {
		const snapshot = [...this.outboundEntries];
		for (const entry of snapshot) {
			try {
				await this.sendRpc(entry.method, entry.params, entry.mutationId);
			} catch (err) {
				// Transient failure (disconnect/timeout): keep the entry and stop;
				// it replays on the next reconnect with the same mutationId.
				if (err instanceof RouterRpcError && err.retryable) return;
				// Non-retryable (server rejected): the call was delivered, so drop
				// it to avoid an infinite replay loop.
			}
			this.removeOutboundEntry(entry.mutationId);
		}
	}

	// ── Inbox (durable event delivery) ─────────────────────────────────────

	private replayInbox(): void {
		const surviving = [...this.inboxEntries];
		for (const entry of surviving) {
			this.emit("event", entry.event, entry.seq);
			if (this.stopped) return;
			this.markInboxProcessed(entry.seq);
		}
	}

	// ── Persistence ────────────────────────────────────────────────────────

	private loadLastAckedSeq(): number {
		try {
			const parsed = JSON.parse(
				readFileSync(this.stateFile, "utf8"),
			) as Partial<PersistedState>;
			if (typeof parsed.lastAckedSeq === "number" && parsed.lastAckedSeq >= 0) {
				return parsed.lastAckedSeq;
			}
		} catch {
			// Missing/corrupt file → default.
		}
		return 0;
	}

	private persistLastAckedSeq(seq: number): void {
		this.atomicWrite(this.stateFile, JSON.stringify({ lastAckedSeq: seq }));
	}

	private loadOutboundEntries(): OutboundEntry[] {
		return this.readJsonlLines(
			this.outboundFile,
			(value): OutboundEntry | undefined => {
				if (
					typeof value === "object" &&
					value !== null &&
					"mutationId" in value &&
					"method" in value &&
					"params" in value
				) {
					const v = value as Record<string, unknown>;
					if (
						typeof v.mutationId === "string" &&
						typeof v.method === "string" &&
						Array.isArray(v.params)
					) {
						return {
							mutationId: v.mutationId,
							method: v.method,
							params: v.params,
						};
					}
				}
				return undefined;
			},
		);
	}

	private appendOutboundEntry(entry: OutboundEntry): void {
		this.outboundEntries.push(entry);
		appendFileSync(this.outboundFile, `${JSON.stringify(entry)}\n`);
	}

	private removeOutboundEntry(mutationId: string): void {
		this.outboundEntries = this.outboundEntries.filter(
			(e) => e.mutationId !== mutationId,
		);
		this.rewriteJsonl(this.outboundFile, this.outboundEntries);
	}

	private loadInboxEntries(): InboxEntry[] {
		return this.readJsonlLines(
			this.inboxFile,
			(value): InboxEntry | undefined => {
				if (
					typeof value === "object" &&
					value !== null &&
					"seq" in value &&
					"event" in value
				) {
					const v = value as Record<string, unknown>;
					if (typeof v.seq === "number") {
						return { seq: v.seq, event: v.event };
					}
				}
				return undefined;
			},
		);
	}

	private appendInboxEntry(entry: InboxEntry): void {
		this.inboxEntries.push(entry);
		appendFileSync(this.inboxFile, `${JSON.stringify(entry)}\n`);
	}

	private markInboxProcessed(seq: number): void {
		this.inboxEntries = this.inboxEntries.filter((e) => e.seq !== seq);
		this.rewriteJsonl(this.inboxFile, this.inboxEntries);
	}

	private readJsonlLines<T>(
		path: string,
		map: (value: unknown) => T | undefined,
	): T[] {
		let raw: string;
		try {
			raw = readFileSync(path, "utf8");
		} catch {
			return [];
		}
		const out: T[] = [];
		for (const line of raw.split("\n")) {
			if (line.trim().length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				// Tolerate a partially-written trailing line.
				continue;
			}
			const mapped = map(parsed);
			if (mapped !== undefined) out.push(mapped);
		}
		return out;
	}

	private rewriteJsonl(path: string, entries: unknown[]): void {
		const body =
			entries.length === 0
				? ""
				: `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
		this.atomicWrite(path, body);
	}

	private atomicWrite(path: string, contents: string): void {
		const tmp = `${path}.${randomUUID()}.tmp`;
		writeFileSync(tmp, contents);
		renameSync(tmp, path);
	}
}
