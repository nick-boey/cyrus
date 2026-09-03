import { cyrusAttributes, type ILogger } from "cyrus-core";

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
 */
export type RoutingRejectReason =
	| "issue_locked"
	| "unenrolled_creator"
	| "invalid_issue_key";

export interface RoutingRejection {
	reason: RoutingRejectReason;
	sessionId: string;
	issueId?: string;
	issueKey?: string;
	/** The session already holding the issue lock, for `issue_locked`. */
	heldBySessionId?: string;
	/** The device that session is pinned to, for `issue_locked`. */
	heldByDeviceId?: number;
}

/**
 * Emit one routing rejection.
 *
 * Deliberately paired with a WARN-level log line at every call site rather than
 * the `info` these paths used to carry alone: `event()` is what makes the
 * refusal queryable, and WARN is what makes it visible to an operator reading a
 * console or a sink whose threshold is WARN+ (every sandbox worker's default).
 */
export function emitRoutingRejection(
	logger: ILogger,
	rejection: RoutingRejection,
): void {
	logger.event(
		ROUTING_EVENTS.rejected,
		cyrusAttributes({
			reason: rejection.reason,
			agent_session_id: rejection.sessionId,
			issue_id: rejection.issueId ?? null,
			issue_key: rejection.issueKey ?? null,
			held_by_session_id: rejection.heldBySessionId ?? null,
			held_by_device_id: rejection.heldByDeviceId ?? null,
		}),
	);
}
