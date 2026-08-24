import type { LogEventAttributes } from "./ILogger.js";

/**
 * The `ILogger.event` vocabulary and its attribute namespace.
 *
 * ── NAMING ──
 * Event names are dotted lowercase (`session.completed`, not
 * `session_completed`), following OpenTelemetry's event-naming guidance: a
 * domain segment, then the specific event. The domain prefix is load-bearing —
 * `event startswith "sandbox."` selects the whole sandbox family in one KQL
 * predicate, which is how every alert rule in `monitoring.bicep` is scoped.
 *
 * ── ATTRIBUTE NAMESPACE ──
 * Attributes go under `cyrus.*` (see {@link cyrusAttributes}). Nothing in OTel
 * semconv covers "Linear issue", "sandbox", "device", or "agent session", so a
 * private namespace is the correct home for them rather than a bare key that
 * could one day collide with a standard attribute. `cyrus.*` also matches the
 * labels already stamped on ACA sandboxes (`cyrus.issue`, `cyrus.device-id`,
 * `cyrus.disk`), so one naming scheme runs from the ARM resource through to the
 * log record.
 *
 * ── WHAT IS DELIBERATELY *NOT* NAMESPACED ──
 * The `LogRecord` context fields (`component`, `sessionId`, `issueIdentifier`,
 * `repository`, `platform`, `event`, `args`) keep their Phase 0 names. They are
 * carried on EVERY record, prose lines included, so renaming them is the
 * exhaustive rewrite Phase 4 explicitly excludes — and it would break every
 * saved query for no new queryability. `exception.*` is likewise left alone:
 * that one IS stable OTel semconv and should stay recognisable as such.
 */
export const CYRUS_EVENTS = {
	/** An inbound platform webhook reached the worker. */
	webhookReceived: "webhook.received",

	/** A new agent session's query began. */
	sessionStarted: "session.started",
	/** A session resumed from a previously-persisted session id. */
	sessionResumed: "session.resumed",
	/** The query loop finished normally. Carries the message count. */
	sessionCompleted: "session.completed",
	/** The query ended by abort or SIGTERM. `cyrus.reason` says which. */
	sessionStopped: "session.stopped",
	/** Someone called `stop()`; the abort has been signalled but not observed. */
	sessionStopRequested: "session.stop_requested",
	/** The streaming prompt was held open because pending work will wake it. */
	sessionHeldOpen: "session.held_open",
	/** The sanitized options the agent SDK query was constructed with. */
	sessionQueryOptions: "session.query_options",
	/** The agent SDK assigned its own session id to this run. */
	sessionAgentIdAssigned: "session.agent_id_assigned",
	/** One SDK message was emitted to listeners. */
	sessionMessageEmitted: "session.message_emitted",
	/** A Stop hook reported crons/background tasks that will wake the session. */
	sessionPendingWorkRecorded: "session.pending_work_recorded",
	/** The set of in-flight background tasks changed. */
	sessionBackgroundTasksChanged: "session.background_tasks_changed",
} as const;

export type CyrusEventName = (typeof CYRUS_EVENTS)[keyof typeof CYRUS_EVENTS];

/** The namespace every Cyrus-specific log attribute lives under. */
export const CYRUS_ATTRIBUTE_NAMESPACE = "cyrus";

/**
 * Move a bag of event attributes into the `cyrus.*` namespace.
 *
 * Applied at the CALL SITE rather than inside `Logger`, deliberately. A sink
 * that silently rewrote keys would have to keep a list of reserved ones
 * (`event`, `args`, `dropped`, `traceparent`, …) that must NOT be rewritten, and
 * that list would rot the first time someone added a structural field. Doing it
 * here means what you read at the call site is what lands in Log Analytics.
 *
 * A key that already carries a namespace — anything containing a `.`, such as
 * `exception.type`, a future `gen_ai.*`, or an already-prefixed `cyrus.foo` — is
 * passed through untouched, so this is idempotent and never double-prefixes.
 */
export function cyrusAttributes(
	attributes: LogEventAttributes,
): LogEventAttributes {
	const namespaced: LogEventAttributes = {};
	for (const [key, value] of Object.entries(attributes)) {
		namespaced[
			key.includes(".") ? key : `${CYRUS_ATTRIBUTE_NAMESPACE}.${key}`
		] = value;
	}
	return namespaced;
}
