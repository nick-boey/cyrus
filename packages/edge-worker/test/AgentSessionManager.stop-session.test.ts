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

// ── crash / stop reporting to Linear ─────────────────────────────────────
// Linear derives session state from the LAST EMITTED ACTIVITY. A path that
// goes terminal without posting one leaves the session at `active`
// ("Working...") forever, indistinguishable from a session still running.
describe("AgentSessionManager reports terminal state to Linear", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: any;
	const sessionId = "test-session-terminal";
	const issueId = "issue-terminal";

	const errorActivity = () =>
		postActivitySpy.mock.calls.find((c: any[]) => c[1]?.type === "error")?.[1];
	const responseActivity = () =>
		postActivitySpy.mock.calls.find(
			(c: any[]) => c[1]?.type === "response",
		)?.[1];

	function result(overrides: Record<string, unknown>) {
		return {
			type: "result",
			subtype: "success",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: false,
			num_turns: 1,
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
			uuid: "result-x",
			session_id: "sdk-session",
			...overrides,
		} as any;
	}

	function newSession(id: string) {
		manager.createCyrusAgentSession(
			id,
			issueId,
			{
				id: issueId,
				identifier: "TEST-TERM",
				title: "Terminal Test",
				description: "test",
				branchName: "test-term",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
		manager.setActivitySink(id, mockActivitySink);
	}

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
			createAgentSession: vi.fn().mockResolvedValue("session-1"),
		};
		postActivitySpy = vi.spyOn(mockActivitySink, "postActivity");
		manager = new AgentSessionManager();
		newSession(sessionId);
	});

	it("posts an error activity when the user stops the session", async () => {
		manager.requestSessionStop(sessionId);

		await manager.completeSession(sessionId, result({ result: "ignored" }));

		// Without this the session sits at "Working..." in Linear forever.
		expect(errorActivity()).toBeDefined();
		expect(errorActivity().body).toBe("Session stopped by user.");
	});

	it("still goes terminal when the stop activity fails to post", async () => {
		// The terminal signal is the only thing that releases the router's issue
		// lock, so a post failure must not strand it.
		postActivitySpy.mockRejectedValue(new Error("linear is down"));
		const terminal = vi.fn();
		manager.on("sessionTerminal", terminal);
		manager.requestSessionStop(sessionId);

		await manager.completeSession(sessionId, result({ result: "ignored" }));

		expect(terminal).toHaveBeenCalledWith(sessionId, "stopped");
	});

	it("posts a synthesized error when a killed runner yields an empty error result", async () => {
		// A SIGTERM'd SDK yields is_error with neither errors[] nor result text.
		await manager.completeSession(
			sessionId,
			result({
				subtype: "error_during_execution",
				is_error: true,
				errors: [],
				result: "",
			}),
		);

		expect(errorActivity()).toBeDefined();
		expect(errorActivity().body).toBe(
			"Session ended unexpectedly (error_during_execution).",
		);
	});

	it("still posts nothing for an empty SUCCESS result (no bare 'Finished')", async () => {
		await manager.completeSession(sessionId, result({ result: "   " }));

		expect(responseActivity()).toBeUndefined();
	});

	it("clearStopRequest drops a stale latch so the next turn is not swallowed", async () => {
		// A stop delivered to an already-dead runner never gets consumed, and
		// would otherwise poison the first turn of the next resume.
		manager.requestSessionStop(sessionId);
		manager.clearStopRequest(sessionId);

		await manager.completeSession(sessionId, result({ result: "real answer" }));

		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Complete,
		);
		expect(responseActivity()?.body).toBe("real answer");
		expect(errorActivity()).toBeUndefined();
	});
});

describe("AgentSessionManager.reconcileInterruptedSessions", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: any;

	function newSession(id: string) {
		manager.createCyrusAgentSession(
			id,
			`issue-${id}`,
			{
				id: `issue-${id}`,
				identifier: "TEST-REC",
				title: "Reconcile Test",
				description: "test",
				branchName: "test-rec",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
		manager.setActivitySink(id, mockActivitySink);
	}

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
			createAgentSession: vi.fn().mockResolvedValue("session-1"),
		};
		postActivitySpy = vi.spyOn(mockActivitySink, "postActivity");
		manager = new AgentSessionManager();
	});

	it("reports an active runner-less session as errored and signals terminal", async () => {
		// Exactly the SIGKILL shape: restored from disk as active, no runner,
		// because runners are never serialized.
		newSession("crashed");
		const terminal = vi.fn();
		manager.on("sessionTerminal", terminal);

		const reconciled = await manager.reconcileInterruptedSessions();

		expect(reconciled).toEqual(["crashed"]);
		expect(manager.getSession("crashed")?.status).toBe(
			AgentSessionStatus.Error,
		);
		// Releases the router's issue lock + affinity.
		expect(terminal).toHaveBeenCalledWith("crashed", "error");
		const posted = postActivitySpy.mock.calls.find(
			(c: any[]) => c[1]?.type === "error",
		);
		expect(posted).toBeDefined();
		expect(posted[1].body).toContain("Session interrupted");
	});

	it("leaves a session that still has a runner alone", async () => {
		newSession("live");
		manager.addAgentRunner("live", { isRunning: () => true } as any);

		expect(await manager.reconcileInterruptedSessions()).toEqual([]);
		expect(manager.getSession("live")?.status).toBe(AgentSessionStatus.Active);
	});

	it("leaves an already-completed session alone", async () => {
		newSession("done");
		const session = manager.getSession("done");
		if (session) session.status = AgentSessionStatus.Complete;

		expect(await manager.reconcileInterruptedSessions()).toEqual([]);
		expect(manager.getSession("done")?.status).toBe(
			AgentSessionStatus.Complete,
		);
	});

	it("leaves an awaitingInput session alone (a legitimate paused state)", async () => {
		newSession("asking");
		const session = manager.getSession("asking");
		if (session) session.status = AgentSessionStatus.AwaitingInput;

		expect(await manager.reconcileInterruptedSessions()).toEqual([]);
		expect(manager.getSession("asking")?.status).toBe(
			AgentSessionStatus.AwaitingInput,
		);
	});

	it("still signals terminal when the activity post fails", async () => {
		newSession("crashed");
		postActivitySpy.mockRejectedValue(new Error("router offline"));
		const terminal = vi.fn();
		manager.on("sessionTerminal", terminal);

		expect(await manager.reconcileInterruptedSessions()).toEqual(["crashed"]);
		expect(terminal).toHaveBeenCalledWith("crashed", "error");
	});
});

describe("AgentSessionManager.getLiveSessionIds", () => {
	let manager: AgentSessionManager;

	function newSession(id: string) {
		manager.createCyrusAgentSession(
			id,
			`issue-${id}`,
			{
				id: `issue-${id}`,
				identifier: "TEST-LIVE",
				title: "Live Test",
				description: "test",
				branchName: "test-live",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
	}

	beforeEach(() => {
		manager = new AgentSessionManager();
	});

	it("declares active and pending sessions", () => {
		newSession("active");
		newSession("pending");
		const pending = manager.getSession("pending");
		if (pending) pending.status = AgentSessionStatus.Pending;

		expect(manager.getLiveSessionIds().sort()).toEqual(["active", "pending"]);
	});

	it("omits a terminal session with no runner (deferred-terminal signal died on restart)", () => {
		// The leak shape: completeSession set status=complete, then deferred the
		// terminal signal for pending work; a restart killed the wakeup, so the
		// lock will never be released by this device. It must NOT be declared, so
		// the router reclaims the stranded lock.
		newSession("done");
		const done = manager.getSession("done");
		if (done) done.status = AgentSessionStatus.Complete;

		expect(manager.getLiveSessionIds()).toEqual([]);
	});

	it("omits an errored session with no runner", () => {
		newSession("failed");
		const failed = manager.getSession("failed");
		if (failed) failed.status = AgentSessionStatus.Error;

		expect(manager.getLiveSessionIds()).toEqual([]);
	});

	it("still declares a terminal-status session that has a live runner (deferred-terminal window)", () => {
		// completeSession flips status to complete BEFORE deferring the terminal
		// signal while the runner has pending work. A reconnect mid-deferral must
		// not let the router reclaim this still-working session's lock.
		newSession("deferring");
		const deferring = manager.getSession("deferring");
		if (deferring) deferring.status = AgentSessionStatus.Complete;
		manager.addAgentRunner("deferring", { isRunning: () => true } as never);

		expect(manager.getLiveSessionIds()).toEqual(["deferring"]);
	});

	it("declares an awaitingInput session (paused, still the device's responsibility)", () => {
		newSession("asking");
		const asking = manager.getSession("asking");
		if (asking) asking.status = AgentSessionStatus.AwaitingInput;

		expect(manager.getLiveSessionIds()).toEqual(["asking"]);
	});
});
