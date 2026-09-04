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
 * Advertised by the ROUTER in `hello_ack.capabilities` when it accepts `span`
 * frames. A device forwards worker spans ONLY after seeing this.
 *
 * Exactly the {@link LOG_INGEST_CAPABILITY} pattern, and for exactly the same
 * reason: `span` is a device→router frame type an older router cannot parse,
 * and `DeviceGateway.handleMessage` closes the socket on any frame it cannot
 * parse. Negotiating router-first means an old router simply never advertises,
 * the worker never forwards, and a mixed-version fleet keeps working. Bumping
 * {@link PROTOCOL_VERSION} instead would reject every not-yet-updated worker
 * outright — a far worse failure than not shipping its traces.
 *
 * Separate from `log_ingest` rather than folded into it because the two are
 * independently useful: a deployment can accept a sandbox's warnings and errors
 * (cheap, always on) while its trace pipeline is off, and turning tracing off
 * during an incident must not also blind the operator to the logs.
 */
export const SPAN_INGEST_CAPABILITY = "span_ingest";

/**
 * Advertised by the ROUTER in `hello_ack.capabilities` when it understands the
 * explicit run facts on a `session_state` frame — the `waiting` state in
 * particular. A device reports `waiting` ONLY after seeing this, and otherwise
 * falls back to the legacy `parked` frame.
 *
 * Exactly the {@link LOG_INGEST_CAPABILITY} pattern, for the same reason, with
 * one wrinkle worth spelling out. The additive *fields* (`wait`, `runner`,
 * `model`, `pendingWorkCount`, `executorMayPark`) are already safe against an
 * older router on their own: `z.object` strips unknown keys rather than
 * rejecting them, so an old router silently ignores facts it cannot use. The
 * new `state` VALUE is not safe — `state` is a closed enum, so `waiting` fails
 * to parse and `DeviceGateway.handleMessage` closes the socket on any frame it
 * cannot parse (`ws.close(1002, "invalid frame")`). A worker that reported
 * `waiting` at an old router would be disconnected on its first elicitation and
 * reconnect into the same loop.
 *
 * So this gate is what lets `waiting` ship without the deploy-ordering
 * requirement that `parked`/`active` carry (router before worker image, or the
 * fleet drops connections). Bumping {@link PROTOCOL_VERSION} instead would
 * reject every not-yet-updated worker outright, which is strictly worse.
 */
export const RUN_FACTS_CAPABILITY = "run_facts";

/**
 * W3C Trace Context fields, carried on the frames that hand a unit of work from
 * one process to the other.
 *
 * Optional on both ends, always. A frame from a build that predates tracing
 * carries neither, and a process with tracing disabled produces neither — so
 * "absent" is the common case and must never be an error. The receiving side
 * reads them into a remote parent context; a missing or malformed
 * `traceparent` simply means the work starts its own trace.
 */
const traceContextFields = {
	traceparent: z.string().optional(),
	tracestate: z.string().optional(),
};

/**
 * Attribute values a span may carry. Primitive-only, matching what
 * `serializeSpan` in `cyrus-otel-traces` projects a `ReadableSpan`'s attributes
 * down to. `null` is deliberately NOT permitted (unlike {@link logAttributeValue}):
 * OTel has no null attribute value, so accepting one would mean inventing a
 * representation for it on the way back out.
 */
const spanAttributeValue = z.union([z.string(), z.number(), z.boolean()]);

/**
 * `[epochSeconds, nanos]` — OpenTelemetry's `HrTime`, carried verbatim.
 *
 * Not a single millisecond number: that would discard the sub-millisecond
 * precision which is the entire reason to look at a span. Not a nanosecond
 * integer either — every real timestamp in nanoseconds exceeds
 * `Number.MAX_SAFE_INTEGER`, so JSON would round it.
 */
const hrTime = z.tuple([z.number(), z.number()]);

const spanAttributes = z.record(z.string(), spanAttributeValue);

/**
 * One finished span, shipped device → router.
 *
 * Structurally identical to `SerializedSpan` in `cyrus-otel-traces`, which is
 * the OTel-aware projection of a `ReadableSpan`. The two are declared
 * separately so this package stays free of an OpenTelemetry dependency (it is
 * imported by the CLI and by every runner) and that one stays free of a
 * protocol dependency. `packages/router` sees both and asserts their mutual
 * assignability, so drift between them fails typecheck rather than failing
 * silently on the wire.
 */
const spanRecord = z.object({
	/** 32 lowercase hex chars. Length-checked, not regex-matched: a malformed
	 *  id is the exporter's problem, but a wrong-length one breaks the backend's
	 *  own parsing and is worth rejecting at the door. */
	traceId: z.string().length(32),
	spanId: z.string().length(16),
	parentSpanId: z.string().length(16).optional(),
	traceFlags: z.number().int().nonnegative(),
	traceState: z.string().optional(),
	name: z.string().min(1),
	kind: z.number().int().nonnegative(),
	startTime: hrTime,
	endTime: hrTime,
	statusCode: z.number().int().nonnegative(),
	statusMessage: z.string().optional(),
	attributes: spanAttributes.optional(),
	events: z
		.array(
			z.object({
				name: z.string(),
				time: hrTime,
				attributes: spanAttributes.optional(),
			}),
		)
		.optional(),
	droppedAttributesCount: z.number().int().nonnegative().optional(),
	droppedEventsCount: z.number().int().nonnegative().optional(),
	droppedLinksCount: z.number().int().nonnegative().optional(),
	scopeName: z.string().optional(),
	scopeVersion: z.string().optional(),
});

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
	// The worker's active span, so the router's own work for this call — the
	// Linear API dependency span in particular — lands inside the worker's
	// trace rather than dangling as a root of its own.
	...traceContextFields,
});
/**
 * Why a worker reports that a run cannot currently progress.
 *
 * Mirrors `waitReasonV1Schema` in `cyrus-operator-protocol` — declared
 * separately so this package (imported by the CLI and every runner) stays free
 * of an operator-contract dependency, exactly as {@link spanRecord} is declared
 * separately from `cyrus-otel-traces`'s `SerializedSpan`.
 *
 * `elicitation` is the only condition v1 models. `other` carries a condition
 * the schema does not model yet, which is why it is useless — and therefore
 * refused — without the condition text.
 */
const sessionWait = z
	.object({
		reason: z.enum(["elicitation", "other"]),
		/** ISO-8601, from the DEVICE's clock: when the wait began. */
		since: z.string().min(1),
		/** The worker's own description of the condition. */
		reportedCondition: z.string().min(1).optional(),
	})
	.refine(
		(wait) => wait.reason !== "other" || wait.reportedCondition !== undefined,
		{
			path: ["reportedCondition"],
			message: "An `other` wait must carry the condition the worker reported",
		},
	);

const sessionStateFrame = z
	.object({
		type: z.literal("session_state"),
		// Correlates the router's `session_state_ack`. Stable across replays so a
		// frame delivered twice (ack lost, device reconnects and resends) is deduped
		// by the router's idempotent lock release rather than double-applied.
		id: z.string().min(1),
		sessionId: z.string().min(1),
		// `complete`/`error`/`stopped` are terminal: the router releases both the
		// issue lock and session affinity.
		//
		// `waiting` is NOT terminal. It is the worker saying, explicitly, that the
		// run cannot progress — carrying `wait` as the evidence for why. The router
		// NEVER infers this from silence, elapsed time, or executor state.
		//
		// `parked` is the LEGACY spelling of `waiting`, kept on the wire so a
		// pre-run-facts worker keeps working. It conflated two independent facts:
		// that the run is blocked on a user answer, and that its container may be
		// suspended. The router reads it as waiting-on-elicitation with
		// `executorMayPark`, which is exactly what it always meant. New workers
		// send `waiting` once the router advertises {@link RUN_FACTS_CAPABILITY}.
		//
		// `active` is the counterpart to both and is likewise NOT terminal: the run
		// is progressing. After a park it restores session affinity and clears the
		// idle stamp — without it a park is one-way, the device keeps running with
		// no affinity, and every session-scoped RPC it makes is rejected with
		// "session not owned by this device", dropping the whole turn in silence
		// (PAR-146). It also carries run facts for a run that is simply still
		// working, which is how a long `pendingWorkCount` run stays observable
		// without being mislabelled as waiting.
		//
		// Additive: PROTOCOL_VERSION is deliberately NOT bumped, since an older
		// worker simply never sends these values and bumping would reject it
		// outright. `parked`/`active` shipped with a deploy-ordering requirement
		// instead (router before worker image); `waiting` does not need one, since
		// it is gated on {@link RUN_FACTS_CAPABILITY}.
		state: z.enum([
			"complete",
			"error",
			"stopped",
			"parked",
			"active",
			"waiting",
		]),
		/** Required on `waiting`, and meaningless anywhere else. */
		wait: sessionWait.optional(),
		/**
		 * Set on a `waiting` frame whose executor may be suspended while the wait
		 * lasts. Separate from the wait itself because the two facts are
		 * independent: a run blocked on an elicitation with a background build
		 * still in flight is waiting, but suspending its container would freeze
		 * that build — and the completion that would wake the session could then
		 * never arrive. Absent reads as "do not park", which is the safe direction.
		 */
		executorMayPark: z.boolean().optional(),
		/** The agent CLI executing this run, e.g. "claude", "codex". */
		runner: z.string().min(1).optional(),
		model: z.string().min(1).optional(),
		/**
		 * Scheduled wakeups, crons, and in-flight background tasks the run is
		 * still carrying. An ACTIVE-run fact, never a wait reason — which is why
		 * the `wait` enum above does not contain it, rather than the two being
		 * forbidden to coexist.
		 */
		pendingWorkCount: z.int().nonnegative().optional(),
	})
	.superRefine((frame, ctx) => {
		// Waiting is worker-reported, so the state and the evidence for it travel
		// together or not at all. A `waiting` frame with no wait would be asking
		// the router to guess, which is the thing this whole frame exists to stop.
		if (frame.state === "waiting" && frame.wait === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["wait"],
				message: "A `waiting` frame must carry the wait the worker reported",
			});
		}
		// Deliberately NOT extended to `runner`/`model`/`pendingWorkCount`, which
		// are true of a run in any state. Every cross-field rule here is a way for
		// a worker bug to get its socket closed, so the bar for adding one is that
		// the field would otherwise be unreadable — as a wait on a non-waiting
		// frame is.
		if (frame.state !== "waiting" && frame.wait !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["wait"],
				message: `Wait evidence does not apply to a \`${frame.state}\` frame`,
			});
		}
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
	 * OTel exception semconv for the Error the worker's call site passed, if any.
	 *
	 * Carried structured rather than left inside `args` so a sandbox error keeps
	 * its type and stack when the router re-emits it: `args` is a lossy one-line
	 * summary, and a stack trace flattened into it is the one thing an operator
	 * opening a sandbox error is actually looking for.
	 *
	 * Optional and additive — it does NOT bump PROTOCOL_VERSION. An older device
	 * omits it and the router simply has no exception to re-stamp.
	 */
	exception: z
		.object({
			type: z.string(),
			message: z.string(),
			stacktrace: z.string().optional(),
		})
		.optional(),
	/**
	 * How many records the device's volume guard dropped since the last frame it
	 * managed to send. Carried inline rather than as its own periodic frame so a
	 * truncated log stream is never silently truncated: a KQL
	 * `summarize sum(dropped)` gives the real loss with no extra traffic.
	 */
	dropped: z.number().int().nonnegative().optional(),
	/**
	 * W3C Trace Context for the span this record was emitted under. Reserved in
	 * Phase 2 and populated as of Phase 5 (NOR-283): the router re-stamps them
	 * so a worker's log record joins the span that produced it.
	 *
	 * Deliberately populated even for a trace the root did NOT sample. That is
	 * what makes the head-sampling trade in
	 * `docs/adr/0004-parent-based-head-sampling-for-traces.md` acceptable — an
	 * unsampled trace still leaves a complete, queryable error record carrying
	 * the trace id, so it can be correlated with anything else that shares it.
	 *
	 * Both sides must still tolerate their absence: a build without tracing
	 * enabled sends neither.
	 */
	traceparent: z.string().optional(),
	tracestate: z.string().optional(),
});

/**
 * A batch of finished worker spans, shipped device → router.
 *
 * Batched rather than one-span-per-frame because a span exporter is handed a
 * batch by the SDK's `BatchSpanProcessor` and splitting it would multiply the
 * per-frame overhead for no benefit — and because a batch shares one `resource`,
 * which is otherwise repeated on every span.
 *
 * ── WHY THIS EXISTS AT ALL ──
 * The same reason as {@link LogFrame}: the sandbox's egress allowlist is
 * deny-by-default with the router's host as its only entry, so a worker cannot
 * reach an Azure ingestion endpoint. Widening the allowlist to let it would be a
 * policy change and would need an Azure credential inside the sandbox. Spans
 * ride the WSS connection the worker already holds instead, and the router
 * re-exports them through its own pipeline.
 *
 * ── DURABILITY ──
 * Fire-and-forget, with no ack and no durable buffer — like `log`, unlike
 * `session_state`. An unsampled trace produces no spans at all, and a sampled
 * one that loses its tail to a disconnect is a legible partial rather than a
 * corruption. Neither is worth the disk writes that making the frame durable
 * would cost.
 *
 * ── ATTRIBUTION ──
 * As with `log`, the router stamps identity (`cyrus.device_id`,
 * `cyrus.issue_key`) from the device row it authenticated, over the top of the
 * span's own attributes. A worker cannot label its spans with someone else's
 * issue.
 */
const spanFrame = z.object({
	type: z.literal("span"),
	/**
	 * The ORIGINATING process's resource semconv, applied to every span in this
	 * frame. Carried because the router must not re-stamp its own: a sandbox
	 * span claiming `service.name = cyrus-router` would be indistinguishable
	 * from one the router really emitted.
	 */
	resource: z.record(z.string(), z.string()).optional(),
	spans: z.array(spanRecord).min(1),
	/**
	 * How many spans the device's volume guard dropped since the last frame it
	 * managed to send. Same contract as `LogFrame.dropped`: a truncated stream
	 * that does not say it was truncated reads as complete.
	 */
	dropped: z.number().int().nonnegative().optional(),
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
	// The span the router was in when it ENQUEUED this event — not when it
	// delivered it. The two can be minutes apart (an offline device, a cold
	// sandbox boot), which is exactly the gap a trace exists to make visible, so
	// the context is persisted with the queued row rather than re-derived at
	// send time. See RouterStore's `events.traceparent` column.
	...traceContextFields,
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
	spanFrame,
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
export type SessionWait = z.infer<typeof sessionWait>;
/** Every state a worker may report for a run, legacy `parked` included. */
export type SessionStateValue = SessionStateFrame["state"];
export type SessionStateAckFrame = z.infer<typeof sessionStateAckFrame>;
export type SessionsQueryFrame = z.infer<typeof sessionsQueryFrame>;
export type SessionsReportFrame = z.infer<typeof sessionsReportFrame>;
export type LogFrame = z.infer<typeof logFrame>;
export type SpanFrame = z.infer<typeof spanFrame>;
export type SpanRecord = z.infer<typeof spanRecord>;
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
