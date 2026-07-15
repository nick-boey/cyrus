/**
 * Local, self-contained copy of the webhook-fixture helpers used by
 * `apps/f1/src/router/fixtures.ts` (itself lifted from this package's own
 * `containers-e2e.test.ts`). `packages/router` must not depend on an app, so
 * `createdFixture`, `seedSession`, and `WORKSPACE` are repackaged here
 * verbatim rather than imported from `apps/f1`.
 */

import {
	type AgentEvent,
	AgentSessionStatus,
	AgentSessionType,
	type CLIIssueTrackerService,
} from "cyrus-core";

interface Creator {
	id: string;
	email: string;
	name: string;
}

const WORKSPACE = "ws-1";

/** A minimal but type-guard-valid agentSessionCreated webhook fixture. */
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

/** Seed a session directly so the CLI tracker's `createAgentActivity` (used by
 * the router to post offline/lock/boot-failure notices) finds it. */
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
