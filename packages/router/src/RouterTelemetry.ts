import {
	cyrusAttributes,
	type ILogger,
	type LogEventAttributes,
	type RunAttribution,
	runAttributionAttributes,
} from "cyrus-core";
import { activeTraceIds } from "cyrus-otel-traces";
import type { AgentRunInfo, AgentRunRouting } from "./RouterStore.js";

/**
 * The routing-decision event vocabulary.
 *
 * Shares the naming scheme of `cyrus-core`'s `CYRUS_EVENTS` and the router's
 * own `SANDBOX_EVENTS`: dotted lowercase, domain segment first, emitted through
 * {@link ILogger.event} so it reaches the structured stream regardless of the
 * sink's level threshold. One KQL predicate (`event startswith "routing."`)
 * selects the whole family.
 *
 * Separate from `SANDBOX_EVENTS` because these describe what the router did
 * with an inbound webhook, not what happened to a container. A routing refusal
 * has no sandbox — that is usually the point.
 */
export const ROUTING_EVENTS = {
	/**
	 * The router refused to route an agent session it could otherwise have
	 * delivered. `cyrus.reason` says why.
	 *
	 * Exists because a refusal used to be indistinguishable from a webhook that
	 * never arrived. On CAN-133 three separate prompts were rejected at the issue
	 * lock over four hours, each answered with a Linear activity posted into the
	 * brand-new (and immediately abandoned) session's own thread — i.e. nowhere
	 * the operator was looking — and an `info` log line among 220 near-identical
	 * ones. The issue was write-only for 5h17m and nothing said so (NOR-402).
	 */
	rejected: "routing.rejected",
} as const;

export type RoutingEventName =
	(typeof ROUTING_EVENTS)[keyof typeof ROUTING_EVENTS];

/**
 * Why the router refused to route a session. Kept closed so a KQL
 * `summarize by reason` has a bounded set of values.
 *
 * The set spans BOTH the `created` and the `prompted` paths, and that is
 * load-bearing rather than tidy. `ISSUE_LOCKED_MESSAGE` answers a lock rejection
 * by directing the user to reply inside the holding session's thread — i.e. it
 * routes every lock-rejected user out of `routeCreated` and into
 * `routePrompted`. Instrumenting only the first of those leaves the refusal the
 * product's own recovery advice steers people into as the invisible one, which
 * reproduces NOR-402's "a comment did not reach an agent and nothing said so" a
 * step further down the path.
 */
export type RoutingRejectReason =
	| "issue_locked"
	| "unenrolled_creator"
	| "invalid_issue_key"
	/** A prompt from someone who did not create the session (`routePrompted`). */
	| "non_creator_prompt"
	/** A prompt that resolved to no device at all (`routePrompted`). */
	| "prompt_unroutable"
	/** A `created` event with no registered repository to route it to. */
	| "repositories_unavailable";

export interface RoutingRejection {
	reason: RoutingRejectReason;
	sessionId: string;
	issueId?: string;
	issueKey?: string;
	/** The session already holding the issue lock, for `issue_locked`. */
	heldBySessionId?: string;
	/** The device that session is pinned to, for `issue_locked`. */
	heldByDeviceId?: number;
	/**
	 * The workspace/owner/team/project snapshot, when the router could resolve
	 * one. A rejection has no run by definition, so the run-scoped canonical
	 * facts stay null here — which is itself the queryable statement that this
	 * session never got one.
	 */
	attribution?: RunAttribution;
}

/**
 * Emit one routing rejection.
 *
 * Deliberately paired with a WARN-level log line at every call site rather than
 * the `info` these paths used to carry alone: `event()` is what makes the
 * refusal queryable, and WARN is what makes it visible to an operator reading a
 * console or a sink whose threshold is WARN+ (every sandbox worker's default).
 *
 * `agent_session_id` and `issue_id` predate the canonical set and are kept
 * verbatim: `monitoring.bicep`'s `Cyrus-Routing-Rejections` saved search reads
 * them by name, and renaming them would silently empty it. `cyrus.session_id`
 * and `cyrus.issue_key` carry the same two facts under the canonical spelling,
 * so a query written either way finds this event.
 */
export function emitRoutingRejection(
	logger: ILogger,
	rejection: RoutingRejection,
): void {
	logger.event(
		ROUTING_EVENTS.rejected,
		routerAttributes(
			{
				...(rejection.attribution ?? { source: ROUTER_LOG_SOURCE }),
				sessionId: rejection.sessionId,
				// The rejection's own view first, then the run's. A rejection often
				// has no issue key to hand (the `prompted` path reads it off an
				// activity that need not carry one) while the run it refused always
				// does — and nulling the column there would hide the refusal from the
				// per-issue query an operator reaches for first.
				issueKey: rejection.issueKey ?? rejection.attribution?.issueKey ?? null,
			},
			{
				reason: rejection.reason,
				agent_session_id: rejection.sessionId,
				issue_id: rejection.issueId ?? null,
				held_by_session_id: rejection.heldBySessionId ?? null,
				held_by_device_id: rejection.heldByDeviceId ?? null,
			},
		),
	);
}

/**
 * The session-ownership vocabulary: every point at which the router refuses a
 * device's claim on a session.
 *
 * One event, discriminated by a closed `cyrus.reason`, rather than four —
 * `summarize by reason` is the question an operator actually asks here, and the
 * four sites differ only in which claim was being made.
 *
 * Exists because the absence of this signal is what made NOR-405 invisible for a
 * day: 161 activities were refused and dropped, and the only trace was the
 * sandbox's own relayed console — below the WARN threshold a worker's forwarder
 * ships by default. A refusal on this path is user-visible data loss when it is
 * wrong, and an attempt to act on someone else's session when it is right;
 * neither may be silent.
 */
export const SESSION_OWNERSHIP_EVENTS = {
	refused: "session.ownership_refused",
} as const;

/**
 * Why the router refused a device's claim on a session. Closed so a KQL
 * `summarize by reason` has a bounded set of values.
 *
 * - `rpc_not_owned` — a session-scoped RPC from a device that owns nothing. The
 *   data-loss case: this is the activity that never reaches Linear.
 * - `park_not_owned` — a `parked` frame for a session the sender does not own.
 * - `unpark_not_parker` — an `active` frame from a device other than the one
 *   that parked the session.
 * - `terminal_not_owned` — a terminal frame for a session the sender does not
 *   own, excluding its own replay (which is expected and not refused).
 */
export type SessionOwnershipRefusalReason =
	| "rpc_not_owned"
	| "park_not_owned"
	| "unpark_not_parker"
	| "terminal_not_owned";

export interface SessionOwnershipRefusal {
	reason: SessionOwnershipRefusalReason;
	sessionId: string | undefined;
	deviceId: number;
	/** The device that does own the session, when one does. */
	ownerDeviceId?: number | undefined;
	/** The RPC method refused, for `rpc_not_owned`. */
	rpcMethod?: string;
	/** The frame's declared state, for the three frame reasons. */
	sessionState?: string;
	/** Canonical facts of the run the refused claim was aimed at, if any. */
	attribution?: RunAttribution;
}

/**
 * Emit one session-ownership refusal.
 *
 * Paired with a WARN at every call site for the same reason
 * {@link emitRoutingRejection} is: `event()` is what makes the refusal
 * queryable and bypasses the sink's level threshold, WARN is what makes it
 * visible to an operator reading a console.
 */
export function emitSessionOwnershipRefusal(
	logger: ILogger,
	refusal: SessionOwnershipRefusal,
): void {
	logger.event(
		SESSION_OWNERSHIP_EVENTS.refused,
		routerAttributes(
			{
				...(refusal.attribution ?? { source: ROUTER_LOG_SOURCE }),
				sessionId: refusal.sessionId ?? null,
				// The REFUSED device, deliberately, not the run's owner — the whole
				// point of the event is which device made a claim it did not hold.
				// `cyrus.owner_device_id` below carries the device that does own it.
				deviceId: refusal.deviceId,
			},
			{
				reason: refusal.reason,
				agent_session_id: refusal.sessionId ?? null,
				owner_device_id: refusal.ownerDeviceId ?? null,
				rpc_method: refusal.rpcMethod ?? null,
				session_state: refusal.sessionState ?? null,
			},
		),
	);
}

/** Which process wrote a log line. Pairs with `sandbox` on relayed lines. */
export const ROUTER_LOG_SOURCE = "router";

/**
 * The run-lifecycle vocabulary: the three points at which the ROUTER's view of
 * an agent run changes state.
 *
 * Separate from `ROUTING_EVENTS`, which is about what happened to an inbound
 * webhook. These are about the run itself, so `event startswith "run."` selects
 * exactly the series an operator follows to answer "what became of this run?".
 *
 * Every one of them carries the full canonical attribution bag (see
 * {@link runAttribution}), which is what makes that question answerable from
 * one `where p["cyrus.run_id"] == …` rather than from three partial views
 * joined by hand.
 */
export const RUN_EVENTS = {
	/**
	 * An input was routed to a device and recorded against a run. The first one
	 * for a session creates the run; later ones extend it.
	 */
	routed: "run.routed",
	/**
	 * The worker reported a terminal state and the router released the run's
	 * issue lock and affinity. Its ABSENCE for a run that stopped producing
	 * activity is the signature of a stranded session.
	 */
	finished: "run.finished",
	/**
	 * The router ended a run WITHOUT a terminal report from its worker — a
	 * reconnecting device that no longer tracks the session, or an affinity row
	 * pointing at a device that no longer exists.
	 *
	 * Distinct from {@link finished} on purpose: both end the run, but only this
	 * one means the outcome was never observed, and conflating them would hide
	 * every silently-lost run inside the healthy series.
	 */
	unknown: "run.unknown",
} as const;

export type RunEventName = (typeof RUN_EVENTS)[keyof typeof RUN_EVENTS];

/** Why the router ended a run it never got a terminal report for. */
export type RunUnknownReason =
	/** A device reconnected without declaring a session it holds the lock for. */
	| "lock_reconciled"
	/** Affinity pointed at a device row that no longer exists. */
	| "dangling_affinity"
	/** The affinity reconciler found no live session backing the row. */
	| "affinity_reconciled"
	/** A `created` event outlived its TTL before any device took delivery. */
	| "event_expired";

/**
 * Map the router's own run row into the shared canonical attribution shape.
 *
 * The ONE place `AgentRunInfo`'s field names are translated into the
 * `cyrus.*` log vocabulary. Duplicating this mapping is how one emitter comes
 * to say `owner_user_id` while another says `owner_id` — a divergence that
 * produces no error, just a saved query that quietly matches fewer rows.
 *
 * Note `ownerId` is the router's `users.user_id` rendered as a string, matching
 * the run row's own `owner_user_id` column rather than the numeric `user_id` on
 * the run: the two are different keys and only the former is stable across a
 * device being destroyed and recreated.
 */
export function runAttribution(
	run: AgentRunInfo,
	overrides?: Partial<RunAttribution>,
): RunAttribution {
	return {
		...routingAttribution(run.routing),
		issueKey: run.issueKey,
		runId: run.runId,
		sessionId: run.sessionId,
		deviceId: run.deviceId,
		runner: run.runner ?? null,
		model: run.model ?? null,
		provider: run.provider ?? null,
		source: ROUTER_LOG_SOURCE,
		...overrides,
	};
}

/**
 * The routing half alone, for the paths that have a snapshot but no run yet —
 * chiefly a routing rejection, which by definition never produced one.
 */
export function routingAttribution(
	routing: AgentRunRouting | undefined,
): RunAttribution {
	return {
		workspaceId: routing?.workspaceId ?? null,
		workspaceName: routing?.workspaceName ?? null,
		ownerId: routing?.ownerUserId ?? null,
		ownerName: routing?.ownerName ?? null,
		teamId: routing?.linearTeamId ?? null,
		teamName: routing?.linearTeamName ?? null,
		projectId: routing?.linearProjectId ?? null,
		projectName: routing?.linearProjectName ?? null,
		source: ROUTER_LOG_SOURCE,
	};
}

/**
 * Build the attribute bag for a router-emitted line, correlating it to the
 * process's currently-active span when there is one.
 *
 * The trace ids come from the live span context rather than from a carrier: on
 * the router side that context IS the authority, whereas a carrier it happens
 * to be holding may describe the parent of the span actually recording the
 * line. Absent tracing, `activeTraceIds` returns undefined and nothing is
 * emitted — an untraced router pays nothing for these call sites.
 */
export function routerAttributes(
	attribution: RunAttribution,
	extra?: LogEventAttributes,
): LogEventAttributes {
	const ids = activeTraceIds();
	const attributes = runAttributionAttributes(attribution, {
		traceId: ids?.traceId ?? null,
		spanId: ids?.spanId ?? null,
	});
	// The event's own payload fills in around the canonical set, never over it.
	// An event that passed `issue_key` would otherwise be free to disagree with
	// the run row about which issue it describes — and only one of the two can be
	// the fact every other line was filtered on.
	for (const [key, value] of Object.entries(cyrusAttributes(extra ?? {}))) {
		if (key in attributes) continue;
		attributes[key] = value;
	}
	return attributes;
}

/** The two run reads {@link resolveLogRunAttribution} needs from the store. */
export interface RunAttributionLookup {
	getAgentRunForSession(sessionId: string): AgentRunInfo | undefined;
	getLatestAgentRunForDevice(deviceId: number): AgentRunInfo | undefined;
}

/**
 * The run a forwarded log line should be attributed to.
 *
 * Two strategies, and the distinction is a correctness one rather than an
 * optimisation:
 *
 *  - When the frame names a session, the run for THAT session — gated on the
 *    router's own run row agreeing the session belongs to this device.
 *    `frame.sessionId` is device-supplied, so without that check a worker could
 *    label its lines with another run's id, which is exactly what router-side
 *    attribution exists to prevent. A claim that fails the gate attributes to
 *    nothing; the relay records the disagreement as `cyrus.reported_session_id`.
 *  - When it does not, the device's most recent run — but ONLY for a container.
 *    A container serves exactly one issue for its whole life, so its latest run
 *    is the one its unlabelled boot and teardown lines belong to. A PHYSICAL
 *    device serves many issues and can run several sessions at once, so "latest
 *    run" there would attribute one session's lines to another session's run.
 *    A wrong answer is worse than the null columns declining to answer.
 */
export function resolveLogRunAttribution(
	lookup: RunAttributionLookup,
	origin: {
		deviceId: number;
		kind?: "device" | "container";
		sessionId?: string;
	},
): AgentRunInfo | undefined {
	if (origin.sessionId) {
		const run = lookup.getAgentRunForSession(origin.sessionId);
		return run?.deviceId === origin.deviceId ? run : undefined;
	}
	if (origin.kind !== "container") return undefined;
	return lookup.getLatestAgentRunForDevice(origin.deviceId);
}

/** Emit one run-lifecycle event with the full canonical attribution bag. */
export function emitRunEvent(
	logger: ILogger,
	name: RunEventName,
	attribution: RunAttribution,
	extra?: LogEventAttributes,
): void {
	logger.event(name, routerAttributes(attribution, extra));
}
