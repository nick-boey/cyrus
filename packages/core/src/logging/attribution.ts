import { cyrusAttributes } from "./events.js";
import type { LogEventAttributes } from "./ILogger.js";

/**
 * The canonical correlation facts a fleet log line is filtered on.
 *
 * ── WHY ONE BUILDER ──
 * Before CYR-72 each logger spelled its own subset of these by hand: the relay
 * knew `issue_key`/`device_id`/`provider`, the routing events knew
 * `agent_session_id`/`issue_id`, and nothing knew the workspace, owner, team or
 * project a run belonged to. An operator answering "show me everything that
 * happened on this run" therefore had to join three differently-named partial
 * views and infer the rest. Constructing the keys in one place is what makes
 * "filter on a stored fact" true rather than aspirational — a second copy of
 * the key list is how one emitter starts saying `owner_id` while another says
 * `owner_user_id`, and the symptom is a saved query that returns fewer rows
 * without erroring.
 *
 * ── SHAPE ──
 * Deliberately structural, not a router type. `cyrus-core` is depended on by
 * every runner and the CLI, so it must not learn about `AgentRunInfo`,
 * `agent_runs`, or SQLite. Each host maps its own observation into this and
 * hands it over; see `runAttribution` in the router's `RouterTelemetry`.
 *
 * `null` and `undefined` mean the same thing here — "this fact was not known at
 * emission time" — because the two arrive interchangeably from a nullable SQL
 * column (`row.issue_key ?? null`) and an optional field (`run.issueKey`), and
 * a builder that treated them differently would make the emitted shape depend
 * on which of the two a call site happened to have.
 */
export interface RunAttribution {
	workspaceId?: string | null;
	workspaceName?: string | null;
	/** The Cyrus user who owns the run — the router's own `users.user_id`. */
	ownerId?: string | null;
	ownerName?: string | null;
	teamId?: string | null;
	teamName?: string | null;
	projectId?: string | null;
	projectName?: string | null;
	issueKey?: string | null;
	runId?: string | null;
	/**
	 * The Linear agent session id — the id the router keys affinity, issue locks
	 * and runs on.
	 *
	 * NOT the agent SDK's own session id, which several `session.*` events carry
	 * as `cyrus.agent_session_id`. The two families do not join, and a KQL query
	 * that mixes them returns nothing rather than erroring, so they keep distinct
	 * names on purpose.
	 */
	sessionId?: string | null;
	deviceId?: number | null;
	runner?: string | null;
	model?: string | null;
	provider?: string | null;
	/** Which process wrote the line: `router`, `sandbox`, … */
	source?: string | null;
}

/**
 * W3C trace correlation for one record, when the emitter has it.
 *
 * Separate from {@link RunAttribution} because it obeys a different rule: the
 * canonical facts are always emitted (as `null` when unknown) so `isnull()`
 * filters work, while these are emitted only when present. An always-null
 * `trace_id` on every line would be per-GB cost for a column no query can
 * usefully narrow on — "this line has no trace" is not a question anyone asks.
 */
export interface TraceAttribution {
	/** A W3C `traceparent` header value, e.g. from a relayed worker frame. */
	traceparent?: string | null;
	/** Overrides the carrier when the emitter has the ids directly. */
	traceId?: string | null;
	spanId?: string | null;
}

/**
 * Every key {@link runAttributionAttributes} emits, in order.
 *
 * Exported so a test can assert the whole contract at once and so
 * `monitoring.bicep`'s projections have one authoritative list to be checked
 * against. Remember the bracket rule when reading any of them in KQL:
 * `p["cyrus.run_id"]`, never `p.cyrus.run_id`, which parses as a nested lookup
 * and silently returns null.
 */
export const CANONICAL_RUN_ATTRIBUTE_KEYS = [
	"cyrus.workspace_id",
	"cyrus.workspace_name",
	"cyrus.owner_id",
	"cyrus.owner_name",
	"cyrus.team_id",
	"cyrus.team_name",
	"cyrus.project_id",
	"cyrus.project_name",
	"cyrus.issue_key",
	"cyrus.run_id",
	"cyrus.session_id",
	"cyrus.device_id",
	"cyrus.runner",
	"cyrus.model",
	"cyrus.provider",
	"cyrus.source",
] as const;

export type CanonicalRunAttributeKey =
	(typeof CANONICAL_RUN_ATTRIBUTE_KEYS)[number];

/**
 * Build the canonical `cyrus.*` attribution bag for one log record.
 *
 * Every key in {@link CANONICAL_RUN_ATTRIBUTE_KEYS} is present on the result,
 * carrying `null` for any fact the caller did not know. That is the property
 * the whole contract rests on and it buys two separate things:
 *
 *  1. `where isnull(p["cyrus.project_id"])` finds runs on issues that belong to
 *     no project. A dropped key answers that question with silence, and silence
 *     reads as "there are none".
 *  2. On the sandbox relay it is also the ANTI-SPOOF mechanism. Worker-supplied
 *     attributes are merged only into keys the router has not already claimed,
 *     so a canonical key that is always present — even as `null` — can never be
 *     filled in by the worker. A key omitted when unknown would be exactly the
 *     gap a container could label with someone else's workspace.
 *
 * Nothing is ever inferred. An absent runner is `null`, not `"claude"`; an
 * absent workspace is `null`, not the router's default. A guessed value is
 * indistinguishable from a measured one once it is in the log stream.
 */
export function runAttributionAttributes(
	attribution: RunAttribution,
	trace?: TraceAttribution,
): LogEventAttributes {
	const attributes = cyrusAttributes({
		workspace_id: attribution.workspaceId ?? null,
		workspace_name: attribution.workspaceName ?? null,
		owner_id: attribution.ownerId ?? null,
		owner_name: attribution.ownerName ?? null,
		team_id: attribution.teamId ?? null,
		team_name: attribution.teamName ?? null,
		project_id: attribution.projectId ?? null,
		project_name: attribution.projectName ?? null,
		issue_key: attribution.issueKey ?? null,
		run_id: attribution.runId ?? null,
		session_id: attribution.sessionId ?? null,
		device_id: attribution.deviceId ?? null,
		runner: attribution.runner ?? null,
		model: attribution.model ?? null,
		provider: attribution.provider ?? null,
		source: attribution.source ?? null,
	});

	const ids = resolveTraceIds(trace);
	// Left UNNAMESPACED, unlike everything above. These are W3C-owned names, and
	// their value is the same trace id Azure surfaces as `OperationId` on span
	// records — so a query can join a log line to its trace by comparing the two
	// columns. (It is a manual join: a log record does not itself carry
	// `OperationId`.) Prefixing would make the pairing non-obvious for no gain.
	if (ids.traceId !== undefined) attributes.trace_id = ids.traceId;
	if (ids.spanId !== undefined) attributes.span_id = ids.spanId;
	return attributes;
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const INVALID_TRACE_ID = "0".repeat(32);
const INVALID_SPAN_ID = "0".repeat(16);

/**
 * Resolve `trace_id` / `span_id` from explicit ids first, then from a carrier.
 *
 * Explicit wins because a caller that has a live span context knows more than
 * whatever carrier it happens to be holding — the carrier may describe the
 * PARENT of the span actually recording the line.
 */
function resolveTraceIds(trace: TraceAttribution | undefined): {
	traceId?: string;
	spanId?: string;
} {
	if (!trace) return {};
	const parsed = parseTraceparent(trace.traceparent);
	const traceId = validTraceId(trace.traceId) ?? parsed?.traceId;
	const spanId = validSpanId(trace.spanId) ?? parsed?.spanId;
	return {
		...(traceId !== undefined ? { traceId } : {}),
		...(spanId !== undefined ? { spanId } : {}),
	};
}

/**
 * Parse a W3C `traceparent` into its ids, or `undefined` if it is not one.
 *
 * Version-tolerant on purpose: the spec requires a parser to accept an unknown
 * version whose first four fields are well-formed and ignore any trailing ones,
 * so a future `01-` carrier still correlates instead of silently losing its
 * trace. `ff` is the one reserved version and is refused.
 *
 * An id that fails validation yields nothing at all rather than being passed
 * through. An invalid id in the log stream would join a line to a trace that
 * does not exist, which is worse than no correlation: it looks like an answer.
 */
function parseTraceparent(
	traceparent: string | null | undefined,
): { traceId: string; spanId: string } | undefined {
	if (!traceparent) return undefined;
	const parts = traceparent.split("-");
	if (parts.length < 4) return undefined;
	const [version, traceId, spanId, flags] = parts;
	if (version === undefined || !/^[0-9a-f]{2}$/.test(version)) return undefined;
	if (version === "ff") return undefined;
	if (flags === undefined || !/^[0-9a-f]{2}$/.test(flags)) return undefined;
	const validTrace = validTraceId(traceId);
	const validSpan = validSpanId(spanId);
	if (validTrace === undefined || validSpan === undefined) return undefined;
	return { traceId: validTrace, spanId: validSpan };
}

function validTraceId(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	if (!TRACE_ID_RE.test(value) || value === INVALID_TRACE_ID) return undefined;
	return value;
}

function validSpanId(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	if (!SPAN_ID_RE.test(value) || value === INVALID_SPAN_ID) return undefined;
	return value;
}
