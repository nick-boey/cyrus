import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeMessageFormatter } from "cyrus-claude-runner";
import {
	type AgentPendingWork,
	type InstalledRecordingLogSink,
	installRecordingLogSink,
} from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

	let logs: InstalledRecordingLogSink;

	beforeEach(() => {
		vi.clearAllMocks();
		logs = installRecordingLogSink();
	});

	afterEach(() => {
		logs.restore();
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

	// NOR-402. Withholding the terminal signal is unbounded — it is retried only
	// if a wakeup or a background task yields another result — so a task that
	// never exits holds the issue lock forever. Until this event existed the
	// state was unfalsifiable from the logs: the branch logged `info`, and a
	// sandbox worker's log forwarder is WARN+ by default, so the line never left
	// the container. `event()` records bypass that threshold.
	it("emits a queryable event when it withholds the terminal signal", async () => {
		setup(PENDING);

		await manager.completeSession(sessionId, result());

		const deferred = logs.sink.find({ event: "session.terminal_deferred" });
		expect(deferred?.attributes).toMatchObject({
			"cyrus.agent_session_id": sessionId,
			"cyrus.terminal_state": "complete",
			"cyrus.session_cron_count": 1,
			"cyrus.background_task_count": 0,
			"cyrus.live_background_task_count": 0,
		});
		// The IDENTITY of what is holding the session open, so the event gives an
		// operator something to act on rather than just a count — but identity
		// only. The cron's prompt text is user content and this attribute leaves
		// the sandbox for a billed backend, so it must not be carried.
		expect(deferred?.attributes?.["cyrus.pending_work"]).toBe(
			"cron(cron-1 once in 5 minutes)",
		);
		expect(deferred?.attributes?.["cyrus.pending_work"]).not.toContain("check");
		// The pair is what makes "did this session ever finish?" answerable.
		expect(logs.sink.find({ event: "session.terminal_signalled" })).toBe(
			undefined,
		);
	});

	// The prime suspect for a session that never terminates is a background task
	// that never exits — and `formatPendingWorkThought`, which renders the
	// user-facing "standing by" message, returns null for exactly that case: it
	// lists only scheduled wakeups. Reporting `pending_work: null` there would
	// leave the operator with a count and no identity in the one case that
	// matters most.
	it("names the live background task when that alone is what defers the session", async () => {
		setup({
			sessionCrons: [],
			backgroundTasks: [],
			liveBackgroundTasks: [
				{ taskId: "bash-7", taskType: "shell", description: "pnpm dev" },
			],
		});

		await manager.completeSession(sessionId, result());

		const deferred = logs.sink.find({ event: "session.terminal_deferred" });
		expect(deferred?.attributes).toMatchObject({
			"cyrus.session_cron_count": 0,
			"cyrus.background_task_count": 0,
			"cyrus.live_background_task_count": 1,
		});
		// Named by task id and type. The description is free text — for a shell
		// task the SDK's sibling `command` field is the literal command line — so
		// it stays on the device.
		expect(deferred?.attributes?.["cyrus.pending_work"]).toBe(
			"live-background(bash-7 shell)",
		);
		expect(deferred?.attributes?.["cyrus.pending_work"]).not.toContain(
			"pnpm dev",
		);
		expect(logs.sink.find({ event: "session.terminal_signalled" })).toBe(
			undefined,
		);
	});

	// The third outcome of a deferral, and the one that made the never-terminal
	// report wrong in the benign direction. `completeSession` sets the status to
	// Complete BEFORE deciding to defer, so a deferred session restores with a
	// terminal status, no runner and no terminalState — reconciled by nobody,
	// because the interrupt loop only looks at Active/Pending and `restoreState`
	// only arms the one-shot when terminalState is set. The router releases the
	// lock at hello regardless, but nothing recorded that, so the session would
	// sit in `Cyrus-Sessions-Never-Terminal` forever claiming a locked issue.
	it("closes the pairing for a deferred session whose host went away", async () => {
		setup(PENDING);
		await manager.completeSession(sessionId, result());
		expect(
			logs.sink.find({ event: "session.terminal_deferred" }),
		).toBeDefined();
		expect(logs.sink.find({ event: "session.terminal_signalled" })).toBe(
			undefined,
		);

		// Host restart: state is persisted and reloaded into a fresh manager, and
		// `agentRunner` is deliberately not serializable.
		const persisted = manager.serializeState();
		const revived = new AgentSessionManager();
		revived.restoreState(persisted.sessions, persisted.entries);
		logs.sink.clear();

		await revived.reconcileInterruptedSessions();

		const abandoned = logs.sink.find({
			event: "session.terminal_abandoned",
		});
		expect(abandoned?.attributes).toMatchObject({
			"cyrus.agent_session_id": sessionId,
			"cyrus.issue_key": "PAR-98",
		});
	});

	it("does not report an abandoned deferral for a session that signalled normally", async () => {
		setup();
		await manager.completeSession(sessionId, result());
		expect(
			logs.sink.find({ event: "session.terminal_signalled" }),
		).toBeDefined();

		const persisted = manager.serializeState();
		const revived = new AgentSessionManager();
		revived.restoreState(persisted.sessions, persisted.entries);
		logs.sink.clear();

		await revived.reconcileInterruptedSessions();

		expect(logs.sink.find({ event: "session.terminal_abandoned" })).toBe(
			undefined,
		);
	});

	it("emits a queryable event when the terminal signal is actually sent", async () => {
		setup();

		await manager.completeSession(sessionId, result());

		expect(
			logs.sink.find({ event: "session.terminal_signalled" })?.attributes,
		).toMatchObject({
			"cyrus.agent_session_id": sessionId,
			"cyrus.terminal_state": "complete",
			"cyrus.forced": false,
		});
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

	// Container/floor restore: a session that was mid-run when its host was
	// destroyed is reconciled to `error` (terminal one-shot spent, router lock
	// released) at startup, then the same queued prompt re-attaches a runner and
	// resumes it. Without reviving the session, the resumed run's completion
	// cannot emit a fresh terminal — the re-acquired router issue lock leaks —
	// and its status stays `error`. Re-attaching a runner must re-arm both.
	it("resuming a reconciled session re-arms its terminal signal and status", async () => {
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
				title: "Reconcile then resume",
				description: "",
				branchName: "test-branch",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, sink);
		manager.on("sessionTerminal", (_id: string, state: string) => {
			events.push(`terminal:${state}`);
		});

		// Restart with the session active but runner-less -> reconcile marks it
		// error and emits terminal:error (releasing the router lock).
		const reconciled = await manager.reconcileInterruptedSessions();
		expect(reconciled).toContain(sessionId);
		expect(events).toContain("terminal:error");
		expect(manager.getSession(sessionId)?.status).toBe("error");

		// The queued prompt re-attaches a runner: the session is live again.
		const runnerStub = {
			getFormatter: () => new ClaudeMessageFormatter(),
			constructor: { name: "ClaudeRunner" },
		} as unknown as Parameters<typeof manager.addAgentRunner>[1];
		manager.addAgentRunner(sessionId, runnerStub);
		expect(manager.getSession(sessionId)?.status).toBe("active");

		// The resumed run completes: its final result posts AND a fresh terminal
		// fires (the reconcile-era one no longer covers the re-acquired lock).
		events.length = 0;
		await manager.completeSession(sessionId, result());
		expect(events).toContain("activity");
		expect(events).toContain("terminal:complete");
		expect(manager.getSession(sessionId)?.status).toBe("complete");
	});
});
