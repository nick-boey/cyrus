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

export function createdFixture(opts: {
	sessionId: string;
	issue: { id: string; identifier: string; title: string };
	creator: Creator;
}): AgentEvent {
	return {
		type: "AgentSessionEvent",
		action: "created",
		organizationId: WORKSPACE,
		createdAt: new Date().toISOString(),
		agentSession: {
			id: opts.sessionId,
			organizationId: WORKSPACE,
			status: "active",
			type: "issue",
			creator: opts.creator,
			issueId: opts.issue.id,
			issue: {
				id: opts.issue.id,
				identifier: opts.issue.identifier,
				title: opts.issue.title,
				url: `linear://issue/${opts.issue.identifier}`,
				team: { id: "team-1", key: "DEF", name: "Default" },
			},
		},
		guidance: [],
	} as unknown as AgentEvent;
}

export function promptedFixture(opts: {
	sessionId: string;
	actorUserId: string;
	creator: Creator;
	issue: { id: string; identifier: string; title: string };
	body: string;
}): AgentEvent {
	return {
		type: "AgentSessionEvent",
		action: "prompted",
		organizationId: WORKSPACE,
		createdAt: new Date().toISOString(),
		agentActivity: {
			id: `act-${opts.sessionId}-${opts.actorUserId}`,
			userId: opts.actorUserId,
			content: { type: "prompt", body: opts.body },
		},
		agentSession: {
			id: opts.sessionId,
			organizationId: WORKSPACE,
			status: "active",
			type: "issue",
			creator: opts.creator,
			issueId: opts.issue.id,
			issue: {
				id: opts.issue.id,
				identifier: opts.issue.identifier,
				title: opts.issue.title,
				url: `linear://issue/${opts.issue.identifier}`,
				team: { id: "team-1", key: "DEF", name: "Default" },
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
