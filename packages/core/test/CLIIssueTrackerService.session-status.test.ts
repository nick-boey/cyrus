import { beforeEach, describe, expect, it } from "vitest";
import { CLIIssueTrackerService } from "../src/issue-tracker/adapters/CLIIssueTrackerService.js";
import {
	AgentActivityType,
	AgentSessionStatus,
} from "../src/issue-tracker/types.js";

/**
 * The CLI tracker must derive agent-session status from the activity log the way
 * Linear does server-side, because nothing in Cyrus ever calls
 * `updateAgentSessionStatus` for a session that finishes normally — on the real
 * tracker it does not have to.
 *
 * Without this, every F1 session read `active` ("Working…") no matter what it
 * had posted, and only reached `complete` if an operator ran `stop-session`.
 * That is the false alarm recorded in
 * `apps/f1/test-drives/2026-07-14-container-executors-phase1-validation.md`,
 * where a drive saw `status: active` after a successful run and concluded the
 * final response had gone missing — while the log showed the response activity
 * had been posted (`activity-89`). A harness that cannot distinguish "finished"
 * from "still working" cannot validate session completion at all.
 */
describe("CLIIssueTrackerService derived session status", () => {
	let service: CLIIssueTrackerService;
	let issueId: string;

	async function newSession(): Promise<string> {
		const payload = await service.createAgentSessionOnIssue({ issueId });
		return (await payload.agentSession).id;
	}

	async function post(
		sessionId: string,
		type: AgentActivityType,
		body = "x",
	): Promise<void> {
		await service.createAgentActivity({
			agentSessionId: sessionId,
			content: { type, body },
		});
	}

	async function statusOf(sessionId: string): Promise<AgentSessionStatus> {
		const session = await service.fetchAgentSession(sessionId);
		return session.status;
	}

	beforeEach(async () => {
		service = new CLIIssueTrackerService();
		service.seedDefaultData();
		const issue = await service.createIssue({
			teamId: "team-default",
			title: "Derived status",
		});
		issueId = issue.id;
	});

	it("reports complete after a response activity, with no explicit stop", async () => {
		const sessionId = await newSession();
		await post(sessionId, AgentActivityType.Thought, "thinking");
		expect(await statusOf(sessionId)).toBe(AgentSessionStatus.Active);

		await post(sessionId, AgentActivityType.Response, "all done");

		expect(await statusOf(sessionId)).toBe(AgentSessionStatus.Complete);
		expect(service.listAgentActivities(sessionId).map((a) => a.type)).toEqual([
			"thought",
			"response",
		]);
	});

	it("reports error after an error activity", async () => {
		const sessionId = await newSession();
		await post(sessionId, AgentActivityType.Error, "it broke");
		expect(await statusOf(sessionId)).toBe(AgentSessionStatus.Error);
	});

	it("reports awaitingInput after an elicitation", async () => {
		const sessionId = await newSession();
		await post(sessionId, AgentActivityType.Elicitation, "which repo?");
		expect(await statusOf(sessionId)).toBe(AgentSessionStatus.AwaitingInput);
	});

	it("returns to active when work resumes after a response", async () => {
		const sessionId = await newSession();
		await post(sessionId, AgentActivityType.Response, "turn one");
		expect(await statusOf(sessionId)).toBe(AgentSessionStatus.Complete);

		await post(sessionId, AgentActivityType.Thought, "turn two");
		expect(await statusOf(sessionId)).toBe(AgentSessionStatus.Active);
	});

	// A finished session is still promptable: that is Cyrus's follow-up model,
	// and Linear allows it. Rejecting it would make the follow-up and Done→reopen
	// flows untestable now that a response derives `complete`.
	it("accepts a follow-up prompt on a completed session and reactivates it", async () => {
		const sessionId = await newSession();
		await post(sessionId, AgentActivityType.Response, "turn one");
		expect(await statusOf(sessionId)).toBe(AgentSessionStatus.Complete);

		await service.promptAgentSession(sessionId, "one more thing");

		// The prompt activity itself puts the session back to work.
		expect(await statusOf(sessionId)).toBe(AgentSessionStatus.Active);
		expect(service.listAgentActivities(sessionId).map((a) => a.type)).toEqual([
			"response",
			"prompt",
		]);
	});
});
