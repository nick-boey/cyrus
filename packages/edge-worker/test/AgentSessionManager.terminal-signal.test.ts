import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeMessageFormatter } from "cyrus-claude-runner";
import type { AgentPendingWork } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * "sessionTerminal" is what makes the router release a session's issue lock AND
 * its device affinity — and the router authorizes `createAgentActivity` against
 * that affinity. So the device must not signal terminal until it has finished
 * posting for the session, or its own final result is rejected with "session not
 * owned by this device" and the Linear timeline stops mid-flow.
 *
 * Two properties are pinned here:
 *   1. terminal is emitted strictly AFTER the final result entry is posted;
 *   2. terminal is NOT emitted while the runner still holds pending work — an
 *      SDKResultMessage ends a turn, not necessarily the session.
 */
describe("AgentSessionManager terminal signal ordering", () => {
	const sessionId = "session-terminal";
	const issueId = "issue-terminal";

	let manager: AgentSessionManager;
	let sink: IActivitySink;
	/** Interleaved log of activity posts and terminal emits, in real order. */
	let events: string[];

	function setup(pendingWork: AgentPendingWork | null = null) {
		events = [];
		sink = {
			id: "test-workspace",
			postActivity: vi.fn().mockImplementation(async () => {
				events.push("activity");
				return { activityId: "activity-1" };
			}),
			createAgentSession: vi.fn().mockResolvedValue("ext-session-1"),
		};

		manager = new AgentSessionManager();
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "PAR-98",
				title: "Terminal signal ordering",
				description: "",
				branchName: "test-branch",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, sink);

		const runnerStub = {
			getFormatter: () => new ClaudeMessageFormatter(),
			...(pendingWork && { getPendingWork: () => pendingWork }),
			constructor: { name: "ClaudeRunner" },
		} as unknown as Parameters<typeof manager.addAgentRunner>[1];
		manager.addAgentRunner(sessionId, runnerStub);

		manager.on("sessionTerminal", (_id: string, state: string) => {
			events.push(`terminal:${state}`);
		});
	}

	function result(subtype = "success"): SDKResultMessage {
		return {
			type: "result",
			subtype,
			is_error: subtype !== "success",
			duration_ms: 1,
			duration_api_ms: 1,
			num_turns: 1,
			result: "done",
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
		} as unknown as SDKResultMessage;
	}

	const PENDING: AgentPendingWork = {
		sessionCrons: [
			{ id: "cron-1", schedule: "in 5 minutes", prompt: "check" },
		] as unknown as AgentPendingWork["sessionCrons"],
		backgroundTasks: [],
	};

	beforeEach(() => {
		vi.clearAllMocks();
	});

	// The regression: terminal used to fire before addResultEntry, disowning the
	// device 6ms before it posted its final result.
	it("emits terminal only after the final result entry is posted", async () => {
		setup();

		await manager.completeSession(sessionId, result());

		expect(events).toContain("terminal:complete");
		expect(events).toContain("activity");
		const terminalAt = events.indexOf("terminal:complete");
		const lastActivityAt = events.lastIndexOf("activity");
		expect(lastActivityAt).toBeLessThan(terminalAt);
	});

	it("emits terminal for an errored result, still after posting", async () => {
		setup();

		await manager.completeSession(sessionId, result("error_during_execution"));

		expect(events).toContain("terminal:error");
		expect(events.lastIndexOf("activity")).toBeLessThan(
			events.indexOf("terminal:error"),
		);
	});

	// An SDKResultMessage is turn-terminal, not session-terminal. Signalling here
	// left the session ownership-dead for the rest of its run (PAR-97: 467
	// subsequent messages, all rejected).
	it("does NOT emit terminal while the runner reports pending work", async () => {
		setup(PENDING);

		await manager.completeSession(sessionId, result());

		expect(events.some((e) => e.startsWith("terminal:"))).toBe(false);
		// The result entry and the pending-work thought still post.
		expect(
			events.filter((e) => e === "activity").length,
		).toBeGreaterThanOrEqual(2);
	});

	it("emits terminal on the later result once the runner has closed", async () => {
		setup(PENDING);
		await manager.completeSession(sessionId, result());
		expect(events.some((e) => e.startsWith("terminal:"))).toBe(false);

		// The wakeup fired, the runner drained its work and yielded a final result.
		const runnerStub = {
			getFormatter: () => new ClaudeMessageFormatter(),
			constructor: { name: "ClaudeRunner" },
		} as unknown as Parameters<typeof manager.addAgentRunner>[1];
		manager.addAgentRunner(sessionId, runnerStub);

		await manager.completeSession(sessionId, result());

		expect(events).toContain("terminal:complete");
		expect(events.lastIndexOf("activity")).toBeLessThan(
			events.indexOf("terminal:complete"),
		);
	});

	it("emits terminal exactly once across repeated results", async () => {
		setup();

		await manager.completeSession(sessionId, result());
		await manager.completeSession(sessionId, result());

		expect(events.filter((e) => e.startsWith("terminal:"))).toEqual([
			"terminal:complete",
		]);
	});

	// A stop posts no result entry, so there is nothing left to own.
	it("emits terminal:stopped immediately on a user stop", async () => {
		setup();
		manager.requestSessionStop(sessionId);

		await manager.completeSession(sessionId, result());

		expect(events).toContain("terminal:stopped");
	});

	// A lost result entry is recoverable; an issue locked until an admin runs
	// `cyrus router unlock` is not. `syncEntryToActivitySink` swallows sink
	// failures today (it logs "Failed to sync entry…"), so completeSession still
	// resolves — but the terminal signal must survive either way, which is why
	// the emit sits in a `finally`.
	it("still emits terminal when the activity sink rejects every post", async () => {
		setup();
		(sink.postActivity as ReturnType<typeof vi.fn>).mockImplementation(
			async () => {
				events.push("activity");
				throw new Error("router rejected the post");
			},
		);

		await expect(
			manager.completeSession(sessionId, result()),
		).resolves.toBeUndefined();

		expect(events).toContain("activity");
		expect(events).toContain("terminal:complete");
		expect(events.lastIndexOf("activity")).toBeLessThan(
			events.indexOf("terminal:complete"),
		);
	});
});
