import { z } from "zod";

/**
 * 2 — `session_state` carries an `id` and is acknowledged by
 * `session_state_ack`, so the device can durably buffer the frame and replay it
 * until the router confirms. Bumped from 1 because both sides must agree: a v2
 * device against a v1 router would buffer terminal frames forever (no ack ever
 * arrives), and a v1 device would reject the unknown ack frame. The handshake
 * fails closed on mismatch, which surfaces the skew immediately.
 */
export const PROTOCOL_VERSION = 2;

/**
 * Router → device ping cadence, in milliseconds. `DeviceGateway` pings every
 * registered socket on this interval; a socket that misses
 * {@link MAX_MISSED_HEARTBEATS} consecutive cycles is terminated.
 *
 * Shared here because BOTH sides derive liveness deadlines from it: the
 * router's own sweep, and the device's inbound-activity watchdog in
 * `RouterConnection`. Keeping one constant is what makes
 * {@link DEVICE_LIVENESS_TIMEOUT_MS} a real relationship rather than two
 * numbers that silently drift apart.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * "Misses two heartbeats" — two consecutive ping cycles pass with no pong
 * before the router terminates the socket, and (symmetrically) two cycles with
 * no inbound server activity before the device gives up on its socket.
 */
export const MAX_MISSED_HEARTBEATS = 2;

/**
 * How long a device tolerates total silence from the router before deciding
 * its socket is dead. Derived from the router's own heartbeat policy, so the
 * device gives up at the same point the router does rather than at some
 * unrelated hardcoded number.
 *
 * The device must measure this against WALL-CLOCK time (`Date.now()`), never
 * by counting timer ticks: an Azure Container Apps sandbox suspended in
 * `Memory` mode freezes every JavaScript timer, so on resume the ticks simply
 * fire late and a tick-counting watchdog observes no gap at all — while the
 * router has long since terminated its side of the socket.
 */
export const DEVICE_LIVENESS_TIMEOUT_MS =
	HEARTBEAT_INTERVAL_MS * MAX_MISSED_HEARTBEATS;

/**
 * Advertised in `hello.capabilities` by a device that answers `sessions_query`.
 *
 * NOT a safety mechanism: a device that omits it simply ignores the frame
 * (`RouterConnection.handleMessage` swallows unknown server frames), and the
 * router's query times out into its "can't tell, skip" path. This exists to
 * turn that 5s timeout per old device per sweep tick into an immediate skip.
 */
export const SESSIONS_QUERY_CAPABILITY = "sessions_query";

/**
 * Advertised by the ROUTER in `hello_ack.capabilities` when it accepts `log`
 * frames. A device forwards worker logs ONLY after seeing this.
 *
 * This gate is what keeps the `log` frame additive rather than a deploy-ordering
 * hazard. `DeviceGateway.handleMessage` closes a socket on any frame it cannot
 * parse (`ws.close(1002, "invalid frame")`), so a new worker logging at an old
 * router would be disconnected on its first forwarded line and reconnect into
 * the same loop. Negotiating the direction that matters — router first — means
 * an old router simply never advertises, the worker never forwards, and nothing
 * breaks. That is also why {@link PROTOCOL_VERSION} is deliberately NOT bumped:
 * a bump would reject every not-yet-updated worker outright, which is a far
 * worse failure than not shipping its logs.
 */
export const LOG_INGEST_CAPABILITY = "log_ingest";

/**
 * Log levels carried on a {@link LogFrame}. Mirrors `cyrus-core`'s `LogLevel`
 * enum minus `SILENT` (never emitted) — spelled as strings so the wire format
 * survives a renumbering of the enum, and so a router-side KQL predicate reads
 * `level == "error"` rather than `level == 3`.
 */
export const LOG_FRAME_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogFrameLevel = (typeof LOG_FRAME_LEVELS)[number];

/**
 * Attribute values a {@link LogFrame} may carry. Primitive-only, matching
 * `cyrus-core`'s `LogEventAttributes`, so the router can spread them straight
 * into a JSON log line and Log Analytics projects each into its own column.
 */
const logAttributeValue = z.union([
	z.string(),
	z.number(),
	z.boolean(),
	z.null(),
]);

const helloFrame = z.object({
	type: z.literal("hello"),
	deviceToken: z.string().min(1),
	protocolVersion: z.number().int(),
	lastAckedSeq: z.number().int().nonnegative(),
	// Session IDs the device is currently tracking. Lets the router reclaim
	// issue locks it holds for this device whose session the device no longer
	// knows about — e.g. after the device lost its persisted state and can
	// never send those sessions' terminal frames. Optional and additive: it
	// does NOT bump PROTOCOL_VERSION. An older client omits it, which the
	// router reads as "unknown" and skips reclamation for — preserving
	// pre-reconcile behavior rather than wrongly releasing every lock.
	activeSessions: z.array(z.string()).optional(),
	// Feature flags the device supports, e.g. SESSIONS_QUERY_CAPABILITY.
	// Optional and additive: it does NOT bump PROTOCOL_VERSION.
	capabilities: z.array(z.string()).optional(),
});
const eventAckFrame = z.object({
	type: z.literal("event_ack"),
	seq: z.number().int().positive(),
});
const rpcRequestFrame = z.object({
	type: z.literal("rpc_request"),
	id: z.string().min(1),
	method: z.string().min(1),
	params: z.array(z.unknown()),
	// Present on mutating calls: stable across buffer replays so the router
	// can dedupe (idempotent replay — see Task 9).
	mutationId: z.string().min(1).optional(),
});
const sessionStateFrame = z.object({
	type: z.literal("session_state"),
	// Correlates the router's `session_state_ack`. Stable across replays so a
	// frame delivered twice (ack lost, device reconnects and resends) is deduped
	// by the router's idempotent lock release rather than double-applied.
	id: z.string().min(1),
	sessionId: z.string().min(1),
	// `complete`/`error`/`stopped` are terminal: the router releases both the
	// issue lock and session affinity.
	//
	// `parked` is NOT terminal. It says the session is blocked on a user answer
	// with no work in flight, so the router releases session affinity ONLY —
	// which is what lets ContainerLifecycle idle-stop the container — while
	// keeping the issue lock so no other session claims the issue mid-
	// conversation.
	//
	// `active` is `parked`'s counterpart and is likewise NOT terminal: the
	// session resumed without the user ever answering (the elicitation was
	// abandoned, replaced, or failed). It restores session affinity and clears
	// the idle stamp. Without it a park is one-way — the device keeps running
	// with no affinity, so every session-scoped RPC it makes is rejected with
	// "session not owned by this device" and the whole turn is dropped in
	// silence (PAR-146).
	//
	// Additive: PROTOCOL_VERSION is deliberately NOT bumped, since an older
	// worker simply never sends these values and bumping would reject it
	// outright. The corollary is a deploy-ordering requirement — the router must
	// ship BEFORE the worker image, because an older router cannot parse
	// `parked`/`active` and would drop the device connection on receiving one.
	state: z.enum(["complete", "error", "stopped", "parked", "active"]),
});
/**
 * One worker log line, shipped device → router.
 *
 * A sandbox worker's stdout dies with the sandbox: the ACA `sandboxGroups`
 * resource is separate from the Container Apps environment that has the Log
 * Analytics wiring, and its data-plane API exposes no logs endpoint. So logs
 * ride the WSS connection the worker already holds — the router's host is the
 * one entry in the sandbox's deny-by-default egress allowlist, which means this
 * needs no policy change and no Azure credential inside the sandbox.
 *
 * Emitted only after the router advertises {@link LOG_INGEST_CAPABILITY}, and
 * only for records that clear the device-side level threshold and rate limit —
 * a `log` frame is fire-and-forget with NO ack and NO durable buffer, unlike
 * `session_state`. That is intentional: losing a log line costs visibility,
 * whereas the disk writes and replay machinery that make a frame durable would
 * cost far more than the line is worth, and replaying stale logs after a
 * reconnect is actively unhelpful.
 *
 * Attribution (which issue, which device) is deliberately NOT on the frame. The
 * router already knows both from the device row it authenticated, and taking
 * them from there rather than from the device makes a worker unable to
 * mis-attribute its logs to someone else's issue.
 */
const logFrame = z.object({
	type: z.literal("log"),
	/** ISO-8601 emission time, from the DEVICE's clock. */
	ts: z.string().min(1),
	level: z.enum(LOG_FRAME_LEVELS),
	/** The emitting logger's component, e.g. "EdgeWorker", "ClaudeRunner". */
	component: z.string().min(1),
	message: z.string(),
	/** Set when the line came from `ILogger.event` — the event name. */
	event: z.string().optional(),
	sessionId: z.string().optional(),
	/** The device's own view of the issue. Advisory only — see the note above. */
	issueIdentifier: z.string().optional(),
	repository: z.string().optional(),
	attributes: z.record(z.string(), logAttributeValue).optional(),
	/** Summarised trailing `logger.x(msg, ...args)` arguments. */
	args: z.string().optional(),
	/**
	 * How many records the device's volume guard dropped since the last frame it
	 * managed to send. Carried inline rather than as its own periodic frame so a
	 * truncated log stream is never silently truncated: a KQL
	 * `summarize sum(dropped)` gives the real loss with no extra traffic.
	 */
	dropped: z.number().int().nonnegative().optional(),
	/**
	 * W3C Trace Context, reserved for Phase 5 (NOR-283). Present here from the
	 * start so propagating a trace across the sandbox boundary is a matter of
	 * populating a field rather than renegotiating the frame: the router will
	 * read these to stitch a worker's log records onto the span that produced
	 * them. Nothing writes them yet; both sides must tolerate their absence.
	 */
	traceparent: z.string().optional(),
	tracestate: z.string().optional(),
});

const sessionStateAckFrame = z.object({
	type: z.literal("session_state_ack"),
	id: z.string().min(1),
});
const sessionsQueryFrame = z.object({
	type: z.literal("sessions_query"),
	id: z.string().min(1),
});
const sessionsReportFrame = z.object({
	type: z.literal("sessions_report"),
	id: z.string().min(1),
	// Required, not optional: an ABSENT list means "can't tell" and an EMPTY
	// list means "I am running nothing". Collapsing them would let a malformed
	// reply be read as permission to reclaim every row.
	activeSessions: z.array(z.string()),
});
const helloAckFrame = z.object({
	type: z.literal("hello_ack"),
	user: z.object({
		id: z.string().optional(),
		email: z.string().optional(),
		name: z.string().optional(),
	}),
	serverVersion: z.string(),
	// The router's actual ping cadence, so the device's liveness watchdog can
	// derive its deadline from the server it is really talking to rather than
	// from a compiled-in default. Optional and additive: it does NOT bump
	// PROTOCOL_VERSION. An older router omits it and the device falls back to
	// HEARTBEAT_INTERVAL_MS.
	heartbeatMs: z.number().int().positive().optional(),
	// Feature flags the ROUTER supports, e.g. LOG_INGEST_CAPABILITY. The mirror
	// image of `hello.capabilities`, and the mechanism by which a device learns
	// it is safe to send a frame type an older router would reject. Optional and
	// additive: it does NOT bump PROTOCOL_VERSION, and an older router omitting
	// it reads as "supports nothing new".
	capabilities: z.array(z.string()).optional(),
});
const helloErrorFrame = z.object({
	type: z.literal("hello_error"),
	reason: z.string(),
});
const eventFrame = z.object({
	type: z.literal("event"),
	seq: z.number().int().positive(),
	event: z.unknown(),
});
const rpcResponseFrame = z.object({
	type: z.literal("rpc_response"),
	id: z.string().min(1),
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z.string().optional(),
});

const deviceFrame = z.discriminatedUnion("type", [
	helloFrame,
	eventAckFrame,
	rpcRequestFrame,
	sessionStateFrame,
	sessionsReportFrame,
	logFrame,
]);
const serverFrame = z.discriminatedUnion("type", [
	helloAckFrame,
	helloErrorFrame,
	eventFrame,
	rpcResponseFrame,
	sessionStateAckFrame,
	sessionsQueryFrame,
]);

export type HelloFrame = z.infer<typeof helloFrame>;
export type EventAckFrame = z.infer<typeof eventAckFrame>;
export type RpcRequestFrame = z.infer<typeof rpcRequestFrame>;
export type SessionStateFrame = z.infer<typeof sessionStateFrame>;
export type SessionStateAckFrame = z.infer<typeof sessionStateAckFrame>;
export type SessionsQueryFrame = z.infer<typeof sessionsQueryFrame>;
export type SessionsReportFrame = z.infer<typeof sessionsReportFrame>;
export type LogFrame = z.infer<typeof logFrame>;
export type HelloAckFrame = z.infer<typeof helloAckFrame>;
export type HelloErrorFrame = z.infer<typeof helloErrorFrame>;
export type EventFrame = z.infer<typeof eventFrame>;
export type RpcResponseFrame = z.infer<typeof rpcResponseFrame>;
export type DeviceFrame = z.infer<typeof deviceFrame>;
export type ServerFrame = z.infer<typeof serverFrame>;

export function parseDeviceFrame(raw: string): DeviceFrame {
	return deviceFrame.parse(JSON.parse(raw));
}
export function parseServerFrame(raw: string): ServerFrame {
	return serverFrame.parse(JSON.parse(raw));
}
