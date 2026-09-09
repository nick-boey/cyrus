import {
	type AgentEvent,
	AgentSessionStatus,
	AgentSessionType,
	type CLIIssueTrackerService,
} from "cyrus-core";

export interface Creator {
	id: string;
	email: string;
	name: string;
}

const WORKSPACE = "ws-1";

/**
 * Makes each synthesized AgentActivity id unique, the way Linear's are. The
 * router claims a webhook idempotency key derived from the payload's entity id
 * and `createdAt` before routing it (see `webhookIdempotencyKey`), so two prompt
 * fixtures that shared an activity id AND landed in the same millisecond would
 * be treated as one redelivered prompt and the second silently dropped.
 */
let activitySeq = 0;

/** Linear team carried on a fixture's issue, and so onto the run's routing snapshot. */
export interface FixtureTeam {
	id: string;
	key: string;
	name: string;
}

const DEFAULT_TEAM: FixtureTeam = { id: "team-1", key: "DEF", name: "Default" };

/**
 * Overrides shared by both event fixtures.
 *
 * `workspace` and `team` exist for the fleet-operations drives: the operator
 * API's workspace narrowing and its team filter are both read off the routing
 * snapshot captured at route time, so a rig serving one workspace with one team
 * cannot distinguish a router that applies them from one that ignores them.
 */
interface FixtureScope {
	workspace?: string;
	team?: FixtureTeam;
}

export function createdFixture(
	opts: {
		sessionId: string;
		issue: { id: string; identifier: string; title: string };
		creator: Creator;
	} & FixtureScope,
): AgentEvent {
	const workspace = opts.workspace ?? WORKSPACE;
	return {
		type: "AgentSessionEvent",
		action: "created",
		organizationId: workspace,
		createdAt: new Date().toISOString(),
		agentSession: {
			id: opts.sessionId,
			organizationId: workspace,
			status: "active",
			type: "issue",
			creator: opts.creator,
			issueId: opts.issue.id,
			issue: {
				id: opts.issue.id,
				identifier: opts.issue.identifier,
				title: opts.issue.title,
				url: `linear://issue/${opts.issue.identifier}`,
				team: opts.team ?? DEFAULT_TEAM,
			},
		},
		guidance: [],
	} as unknown as AgentEvent;
}

export function promptedFixture(
	opts: {
		sessionId: string;
		actorUserId: string;
		creator: Creator;
		issue: { id: string; identifier: string; title: string };
		body: string;
	} & FixtureScope,
): AgentEvent {
	const workspace = opts.workspace ?? WORKSPACE;
	return {
		type: "AgentSessionEvent",
		action: "prompted",
		organizationId: workspace,
		createdAt: new Date().toISOString(),
		agentActivity: {
			id: `act-${opts.sessionId}-${opts.actorUserId}-${++activitySeq}`,
			userId: opts.actorUserId,
			content: { type: "prompt", body: opts.body },
		},
		agentSession: {
			id: opts.sessionId,
			organizationId: workspace,
			status: "active",
			type: "issue",
			creator: opts.creator,
			issueId: opts.issue.id,
			issue: {
				id: opts.issue.id,
				identifier: opts.issue.identifier,
				title: opts.issue.title,
				url: `linear://issue/${opts.issue.identifier}`,
				team: opts.team ?? DEFAULT_TEAM,
			},
		},
	} as unknown as AgentEvent;
}

export function seedSession(
	tracker: CLIIssueTrackerService,
	sessionId: string,
	issueId: string,
): void {
	tracker.getState().agentSessions.set(sessionId, {
		id: sessionId,
		status: AgentSessionStatus.Active,
		type: AgentSessionType.CommentThread,
		createdAt: new Date(),
		updatedAt: new Date(),
		issueId,
	});
}

export { WORKSPACE };
