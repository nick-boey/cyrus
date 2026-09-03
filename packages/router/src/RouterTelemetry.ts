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
		cyrusAttributes({
			reason: refusal.reason,
			agent_session_id: refusal.sessionId ?? null,
			device_id: refusal.deviceId,
			owner_device_id: refusal.ownerDeviceId ?? null,
			rpc_method: refusal.rpcMethod ?? null,
			session_state: refusal.sessionState ?? null,
		}),
	);
}
