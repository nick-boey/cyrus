import { ClaudeMessageFormatter } from "cyrus-claude-runner";
import { AgentSessionStatus } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

describe("AgentSessionManager stop-session behavior", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: any;
	const sessionId = "test-session-stop";
	const issueId = "issue-stop";

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
			createAgentSession: vi.fn().mockResolvedValue("session-1"),
		};

		postActivitySpy = vi.spyOn(mockActivitySink, "postActivity");

		manager = new AgentSessionManager();

		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "TEST-STOP",
				title: "Stop Session Test",
				description: "test",
				branchName: "test-stop",
			},
			{
				path: "/tmp/workspace",
				isGitWorktree: false,
			},
		);
		manager.setActivitySink(sessionId, mockActivitySink);
	});

	it("marks session as error when a session stop is requested", async () => {
		manager.requestSessionStop(sessionId);

		await manager.completeSession(sessionId, {
			type: "result",
			subtype: "success",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: false,
			num_turns: 1,
			result: "Stopped run should not continue",
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation: null,
			},
			modelUsage: {},
			permission_denials: [],
			uuid: "result-1",
			session_id: "sdk-session",
		} as any);

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Error,
		);
	});

	it("handles non max-turn execution errors gracefully", async () => {
		await manager.completeSession(sessionId, {
			type: "result",
			subtype: "error_during_execution",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: true,
			num_turns: 1,
			errors: ["aborted by user"],
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation: null,
			},
			modelUsage: {},
			permission_denials: [],
			uuid: "result-2",
			session_id: "sdk-session",
		} as any);

		// Session should be marked as error for execution errors
		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Error,
		);
	});

	it("posts actual error message to Linear for usage limit errors (not generic)", async () => {
		const usageLimitError =
			"You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Feb 16th, 2026 8:09 PM.";

		await manager.completeSession(sessionId, {
			type: "result",
			subtype: "error_during_execution",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: true,
			num_turns: 1,
			errors: [usageLimitError],
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation: null,
			},
			modelUsage: {},
			permission_denials: [],
			uuid: "result-3",
			session_id: "sdk-session",
		} as any);

		const postActivityCalls = postActivitySpy.mock.calls;
		const errorActivity = postActivityCalls.find(
			(call: any[]) => call[1]?.type === "error",
		);
		expect(errorActivity).toBeDefined();
		expect(errorActivity![1].body).toBe(usageLimitError);
	});

	// ── terminal-state signalling ──────────────────────────────────────────
	// "sessionTerminal" is what releases the router's issue lock + session
	// affinity. Emitting it is NOT optional: a session that ends without it
	// strands the issue on the router until an admin runs `cyrus router unlock`,
	// because the router's sweep only reclaims locks from devices that go
	// offline past the event TTL — not from a device that stays connected.

	it("abortSession emits sessionTerminal('stopped') when the query is killed without a result", () => {
		const terminal = vi.fn();
		manager.on("sessionTerminal", terminal);

		// The full-kill stop path: the runner is torn down, so the SDK never
		// yields an SDKResultMessage and completeSession() is never reached.
		manager.requestSessionStop(sessionId);
		manager.abortSession(sessionId);

		expect(terminal).toHaveBeenCalledTimes(1);
		expect(terminal).toHaveBeenCalledWith(sessionId, "stopped");
	});

	it("emits sessionTerminal at most once even if a killed session later yields a result", async () => {
		const terminal = vi.fn();
		manager.on("sessionTerminal", terminal);

		manager.requestSessionStop(sessionId);
		manager.abortSession(sessionId);

		// A late/duplicate result must not double-notify observers.
		await manager.completeSession(sessionId, {
			type: "result",
			subtype: "success",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: false,
			num_turns: 1,
			result: "done",
			total_cost_usd: 0,
			usage: {},
			modelUsage: {},
			permission_denials: [],
			uuid: "result-late",
			session_id: "sdk-session",
		} as any);

		expect(terminal).toHaveBeenCalledTimes(1);
		expect(terminal).toHaveBeenCalledWith(sessionId, "stopped");
	});

	it("still emits sessionTerminal('complete') on a normal finish", async () => {
		const terminal = vi.fn();
		manager.on("sessionTerminal", terminal);

		await manager.completeSession(sessionId, {
			type: "result",
			subtype: "success",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: false,
			num_turns: 1,
			result: "done",
			total_cost_usd: 0,
			usage: {},
			modelUsage: {},
			permission_denials: [],
			uuid: "result-ok",
			session_id: "sdk-session",
		} as any);

		expect(terminal).toHaveBeenCalledTimes(1);
		expect(terminal).toHaveBeenCalledWith(sessionId, "complete");
	});

	// ── terminal-state ordering ────────────────────────────────────────────
	// The router drops this device's ownership of the session as soon as it sees
	// the terminal state, so anything posted afterwards is rejected with
	// "session not owned by this device". The emit must therefore come last.

	it("emits sessionTerminal only AFTER the final result has been posted", async () => {
		const order: string[] = [];
		postActivitySpy.mockImplementation(async () => {
			order.push("postActivity");
			return { activityId: "activity-1" };
		});
		manager.on("sessionTerminal", () => order.push("sessionTerminal"));

		await manager.completeSession(sessionId, {
			type: "result",
			subtype: "success",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: false,
			num_turns: 1,
			result: "the final answer",
			total_cost_usd: 0,
			usage: {},
			modelUsage: {},
			permission_denials: [],
			uuid: "result-order",
			session_id: "sdk-session",
		} as any);

		// At least one activity (the result entry) must precede the terminal
		// signal, and nothing may follow it.
		expect(order).toContain("postActivity");
		expect(order.at(-1)).toBe("sessionTerminal");
		expect(order.indexOf("sessionTerminal")).toBe(order.length - 1);
	});

	// ── turn-terminal vs session-terminal ──────────────────────────────────
	// An SDKResultMessage ends a TURN. When the runner still holds scheduled or
	// backgrounded work it keeps the session open and streams more messages in
	// later, so going terminal here would strand the rest of the run unowned.

	it("does NOT emit sessionTerminal when the runner reports pending work", async () => {
		const terminal = vi.fn();
		manager.on("sessionTerminal", terminal);
		manager.addAgentRunner(sessionId, {
			getFormatter: () => new ClaudeMessageFormatter(),
			getPendingWork: () => ({
				sessionCrons: [
					{
						id: "cron-1",
						schedule: "27 12 * * *",
						recurring: false,
						prompt: "WAKEUP: check CI",
					},
				],
				backgroundTasks: [],
			}),
			constructor: { name: "ClaudeRunner" },
		} as unknown as Parameters<typeof manager.addAgentRunner>[1]);

		await manager.completeSession(sessionId, {
			type: "result",
			subtype: "success",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: false,
			num_turns: 1,
			result: "turn done, wakeup scheduled",
			total_cost_usd: 0,
			usage: {},
			modelUsage: {},
			permission_denials: [],
			uuid: "result-pending",
			session_id: "sdk-session",
		} as any);

		expect(terminal).not.toHaveBeenCalled();
	});

	it("emits sessionTerminal on the follow-up turn once pending work has drained", async () => {
		const terminal = vi.fn();
		manager.on("sessionTerminal", terminal);
		let pending = true;
		manager.addAgentRunner(sessionId, {
			getFormatter: () => new ClaudeMessageFormatter(),
			getPendingWork: () =>
				pending
					? {
							sessionCrons: [
								{
									id: "cron-1",
									schedule: "27 12 * * *",
									recurring: false,
									prompt: "WAKEUP: check CI",
								},
							],
							backgroundTasks: [],
						}
					: { sessionCrons: [], backgroundTasks: [] },
			constructor: { name: "ClaudeRunner" },
		} as unknown as Parameters<typeof manager.addAgentRunner>[1]);

		const result = (uuid: string) =>
			({
				type: "result",
				subtype: "success",
				duration_ms: 1,
				duration_api_ms: 1,
				is_error: false,
				num_turns: 1,
				result: "done",
				total_cost_usd: 0,
				usage: {},
				modelUsage: {},
				permission_denials: [],
				uuid,
				session_id: "sdk-session",
			}) as any;

		// Turn 1 ends with a wakeup scheduled: still owned, no terminal.
		await manager.completeSession(sessionId, result("result-turn-1"));
		expect(terminal).not.toHaveBeenCalled();

		// The wakeup fires, work drains, and turn 2 genuinely ends the session.
		pending = false;
		await manager.completeSession(sessionId, result("result-turn-2"));

		expect(terminal).toHaveBeenCalledTimes(1);
		expect(terminal).toHaveBeenCalledWith(sessionId, "complete");
	});
});
