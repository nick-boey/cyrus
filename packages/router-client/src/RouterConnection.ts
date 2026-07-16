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
	type SessionStateAckFrame,
} from "cyrus-router-protocol";
import { WebSocket } from "ws";
import { reviveDates } from "./date-revival.js";

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
	/**
	 * Returns the session IDs the device is currently tracking, sent in every
	 * hello so the router can reclaim issue locks for sessions the device has
	 * lost (e.g. after a corrupt-state restart). Evaluated fresh on each
	 * (re)connect. Omitting it sends no list, which the router reads as
	 * "unknown" and skips reconciliation for.
	 */
	getActiveSessions?: () => string[];
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

/**
 * A terminal `session_state` frame awaiting the router's `session_state_ack`.
 * Durable: the router releases the issue lock + session affinity only on this
 * frame, so losing it strands the issue until an operator runs
 * `cyrus router unlock`.
 */
interface SessionStateEntry {
	id: string;
	sessionId: string;
	state: "complete" | "error" | "stopped";
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
 *  - Buffers mutating RPCs while offline (`bufferedRpc`) — and now also when a
 *    mid-call router outage rejects an in-flight RPC retryably — to a durable
 *    JSONL file, replaying them FIFO with a stable `mutationId` so the router
 *    dedupes idempotent replays (finding 4).
 *
 * ── CONSUMER CONTRACT for the "event" listener (read before wiring this up) ──
 * The `"event"` listener MUST be attached synchronously, before/around
 * `connect()`, and MUST complete its durable handoff **synchronously within the
 * emit** (i.e. before the listener returns). This is load-bearing:
 *  - `lastAckedSeq` is persisted and the durable inbox entry is marked
 *    processed **immediately after `emit("event", …)` returns**. A listener that
 *    returns a still-pending promise (async handoff) can lose the event if the
 *    process crashes mid-dispatch, because the inbox entry may already be gone.
 *  - If `emit("event", …)` reaches **zero** listeners it returns `false`; in
 *    that case the inbox entry is deliberately left unprocessed on disk (and a
 *    warning is logged) so it survives to the next startup/replay rather than
 *    being silently dropped. Attaching the listener a tick late therefore
 *    delays — but never loses — the event.
 * (Task 12's RouterEventTransport/EdgeWorker integration depends on honoring
 * this: do the durable write inside the listener body, synchronously.)
 */
export class RouterConnection extends EventEmitter {
	private readonly wsUrl: string;
	private readonly deviceToken: string;
	private readonly reconnectBaseMs: number;
	private readonly rpcTimeoutMs: number;
	private readonly getActiveSessions: (() => string[]) | undefined;

	private readonly stateFile: string;
	private readonly outboundFile: string;
	private readonly inboxFile: string;
	private readonly sessionStateFile: string;

	private ws: WebSocket | undefined;
	private started = false;
	private stopped = false;
	private _connected = false;
	private reconnectAttempts = 0;
	private reconnectTimer: NodeJS.Timeout | undefined;

	private lastAckedSeq: number;
	private outboundEntries: OutboundEntry[];
	private inboxEntries: InboxEntry[];
	private sessionStateEntries: SessionStateEntry[];
	private readonly pending = new Map<string, PendingRpc>();

	constructor(opts: RouterConnectionOptions) {
		super();
		this.wsUrl = `${opts.url.replace(/\/+$/, "")}/device`;
		this.deviceToken = opts.deviceToken;
		this.reconnectBaseMs = opts.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
		this.rpcTimeoutMs = opts.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS;
		this.getActiveSessions = opts.getActiveSessions;

		mkdirSync(opts.stateDir, { recursive: true });
		this.stateFile = join(opts.stateDir, "router-connection.json");
		this.outboundFile = join(opts.stateDir, "outbound-buffer.jsonl");
		this.inboxFile = join(opts.stateDir, "inbox.jsonl");
		this.sessionStateFile = join(opts.stateDir, "session-state-buffer.jsonl");

		this.lastAckedSeq = this.loadLastAckedSeq();
		this.outboundEntries = this.loadOutboundEntries();
		this.inboxEntries = this.loadInboxEntries();
		this.sessionStateEntries = this.loadSessionStateEntries();
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
	 *
	 * Mid-call outage: if the connection is online at call time but the socket
	 * drops (or the call times out) WHILE the RPC is in flight, `sendRpc`
	 * rejects with a *retryable* `RouterRpcError`. Rather than lose the mutation
	 * (the activity post), we durably buffer it and resolve with the same
	 * synthetic `{ success: true }` — the router dedupes by the shared
	 * `mutationId`, so a partially-delivered-then-replayed call is idempotent. A
	 * non-retryable rejection is a genuine server-side `{ok:false}` and still
	 * rejects.
	 */
	async bufferedRpc(method: string, params: unknown[]): Promise<unknown> {
		const mutationId = randomUUID();
		if (this.isOnline()) {
			try {
				return await this.sendRpc(method, params, mutationId);
			} catch (err) {
				if (err instanceof RouterRpcError && err.retryable) {
					// Mid-call router outage (disconnect/timeout): buffer for replay
					// instead of dropping the mutation. Idempotent via mutationId.
					this.appendOutboundEntry({ mutationId, method, params });
					return { success: true };
				}
				throw err;
			}
		}
		this.appendOutboundEntry({ mutationId, method, params });
		return { success: true };
	}

	/**
	 * Durably records a terminal `session_state` and sends it.
	 *
	 * This frame is the ONLY thing that releases the router's issue lock and
	 * session affinity, and the router's own sweep reclaims locks only for
	 * devices that have been offline past the event TTL (48h by default). So a
	 * frame lost here — sent while the socket was down, or dropped in flight —
	 * strands the issue indefinitely on an otherwise-healthy device, recoverable
	 * only via `cyrus router unlock`. It is therefore persisted before any send
	 * attempt and replayed on every reconnect until the router acks it.
	 *
	 * Delivery is at-least-once: a lost ack replays the frame, and the router's
	 * release is idempotent.
	 */
	sendSessionState(
		sessionId: string,
		state: "complete" | "error" | "stopped",
	): void {
		const entry: SessionStateEntry = { id: randomUUID(), sessionId, state };
		this.appendSessionStateEntry(entry);
		this.trySendSessionState(entry);
	}

	/** Best-effort transmit; the durable entry survives until acked. */
	private trySendSessionState(entry: SessionStateEntry): void {
		if (!this.isOnline() || !this.ws) return;
		this.ws.send(
			JSON.stringify({
				type: "session_state",
				id: entry.id,
				sessionId: entry.sessionId,
				state: entry.state,
			}),
		);
	}

	private replaySessionStateBuffer(): void {
		for (const entry of [...this.sessionStateEntries]) {
			this.trySendSessionState(entry);
		}
	}

	private onSessionStateAck(frame: SessionStateAckFrame): void {
		this.removeSessionStateEntry(frame.id);
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
			// Evaluated fresh each (re)connect so the router reconciles against
			// the device's current sessions. Omit the field entirely when no
			// provider is wired — the router distinguishes "no list" (skip) from
			// an empty list (device tracks nothing; reclaim all its locks).
			...(this.getActiveSessions
				? { activeSessions: this.getActiveSessions() }
				: {}),
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
			case "session_state_ack":
				this.onSessionStateAck(frame);
				break;
		}
	}

	private onHelloAck(frame: HelloAckFrame): void {
		this._connected = true;
		this.reconnectAttempts = 0;
		// Resend any terminal frames the router never acked. Done before the
		// outbound replay so a stranded issue lock is released as early as
		// possible; both are independent of each other.
		this.replaySessionStateBuffer();
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
		const error = new Error(`hello rejected: ${frame.reason}`);
		// Node's EventEmitter THROWS on `emit("error")` when there is no "error"
		// listener — that would turn this fatal-but-expected bad-token case into
		// an uncaught exception that crashes the whole EdgeWorker process. Guard
		// it: emit if someone is listening, otherwise log. Either way we stay
		// stopped (no reconnect).
		if (this.listenerCount("error") > 0) {
			this.emit("error", error);
		} else {
			console.error(
				`[RouterConnection] fatal (no error listener attached; not reconnecting): ${error.message}`,
			);
		}
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
		// CONSUMER CONTRACT (see class doc): the "event" listener must complete
		// its durable handoff synchronously within this emit — the inbox entry is
		// marked processed the instant emit returns.
		const delivered = this.emit("event", frame.event, frame.seq);
		// If we were shut down/closed during the emit (e.g. a crash), leave the
		// entry unprocessed so it replays on the next startup.
		if (this.stopped) return;
		if (delivered) {
			this.markInboxProcessed(frame.seq);
		} else {
			// Zero "event" listeners: do NOT mark processed — leave the entry on
			// disk so it survives to the next startup/replay rather than being
			// silently dropped (already acked, so the router won't resend it).
			console.warn(
				`[RouterConnection] inbox event seq=${frame.seq} had no consumer; kept on disk for replay`,
			);
		}
	}

	private onRpcResponse(frame: RpcResponseFrame): void {
		const pending = this.pending.get(frame.id);
		if (!pending) return;
		this.pending.delete(frame.id);
		clearTimeout(pending.timer);
		if (frame.ok) {
			// The issue-tracker types promise `Date` for createdAt/updatedAt/
			// archivedAt, but JSON.parse yields strings. Revive here, at the single
			// point every RPC result passes through, rather than at each call site.
			pending.resolve(reviveDates(frame.result));
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
				// it below to avoid an infinite replay loop.
			}
			// Remove the (delivered or server-rejected) entry. Guard the disk I/O:
			// this method is `void`-ed from onHelloAck, so a write/rename failure
			// here would otherwise become an UNHANDLED promise rejection.
			try {
				this.removeOutboundEntry(entry.mutationId);
			} catch (err) {
				console.error(
					`[RouterConnection] failed to remove replayed outbound entry ${entry.mutationId}:`,
					err,
				);
			}
		}
	}

	// ── Inbox (durable event delivery) ─────────────────────────────────────

	private replayInbox(): void {
		const surviving = [...this.inboxEntries];
		for (const entry of surviving) {
			const delivered = this.emit("event", entry.event, entry.seq);
			if (this.stopped) return;
			if (delivered) {
				this.markInboxProcessed(entry.seq);
			} else {
				// No "event" consumer attached yet: leave the entry unprocessed so
				// it replays on the next startup rather than being silently dropped
				// (e.g. the consumer attached its listener a tick late). We do NOT
				// loop/retry here — the entry simply stays on disk for next time.
				console.warn(
					`[RouterConnection] inbox replay for seq=${entry.seq} had no consumer; kept on disk for next replay`,
				);
			}
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

	private loadSessionStateEntries(): SessionStateEntry[] {
		return this.readJsonlLines(
			this.sessionStateFile,
			(value): SessionStateEntry | undefined => {
				if (typeof value !== "object" || value === null) return undefined;
				const v = value as Record<string, unknown>;
				if (
					typeof v.id === "string" &&
					typeof v.sessionId === "string" &&
					(v.state === "complete" ||
						v.state === "error" ||
						v.state === "stopped")
				) {
					return { id: v.id, sessionId: v.sessionId, state: v.state };
				}
				return undefined;
			},
		);
	}

	private appendSessionStateEntry(entry: SessionStateEntry): void {
		this.sessionStateEntries.push(entry);
		appendFileSync(this.sessionStateFile, `${JSON.stringify(entry)}\n`);
	}

	private removeSessionStateEntry(id: string): void {
		const before = this.sessionStateEntries.length;
		this.sessionStateEntries = this.sessionStateEntries.filter(
			(e) => e.id !== id,
		);
		if (this.sessionStateEntries.length === before) return; // unknown/duplicate ack
		try {
			this.rewriteJsonl(this.sessionStateFile, this.sessionStateEntries);
		} catch (err) {
			// A failed rewrite would otherwise leave the entry on disk to be
			// replayed forever. It is harmless (the release is idempotent), but
			// surface it rather than failing silently.
			console.error(
				`[RouterConnection] failed to remove acked session_state entry ${id}:`,
				err,
			);
		}
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
