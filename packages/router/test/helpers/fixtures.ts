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

/**
 * Seed an issue directly, mirroring the stored shape of
 * `CLIIssueTrackerService.createIssue` but with a CALLER-CHOSEN id and
 * identifier (createIssue always auto-generates `issue-<n>` / `<TEAM>-<n>`,
 * which can never match a run-scoped key like `CYDIR-xxxx`).
 *
 * `seedSession` alone is NOT enough for a suite that boots a REAL container:
 * the container-side EdgeWorker fetches the full issue over router RPC while
 * processing the created webhook (`EdgeWorker.createCyrusAgentSession`) and
 * aborts BEFORE creating the worktree when that fetch 404s — first observed
 * as the 2026-07-17 drive's `RouterRpcError: Issue issue-dir not found`.
 * Requires `tracker.seedDefaultData()` (for `team-default`) to have run.
 */
export function seedIssue(
	tracker: CLIIssueTrackerService,
	issue: { id: string; identifier: string; title: string },
): void {
	tracker.getState().issues.set(issue.id, {
		id: issue.id,
		identifier: issue.identifier,
		title: issue.title,
		number: 1,
		url: `https://linear.app/test/issue/${issue.identifier}`,
		branchName: issue.identifier.toLowerCase(),
		priority: 0,
		priorityLabel: "No priority",
		boardOrder: 0,
		sortOrder: 0,
		prioritySortOrder: 0,
		labelIds: [],
		previousIdentifiers: [],
		customerTicketCount: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
		teamId: "team-default",
	});
}

export { WORKSPACE };
