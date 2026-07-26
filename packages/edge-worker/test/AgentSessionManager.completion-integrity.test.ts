import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeMessageFormatter } from "cyrus-claude-runner";
import { PersistenceManager } from "cyrus-core";
import { buildBundle, restoreBundle } from "cyrus-workspace-sync";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * Session completion across cold restore and reopen.
 *
 * The failure this pins down (observed on the live ACA drive, and reproduced
 * below): a worker is destroyed after a session completed a turn, a follow-up
 * prompt is routed to a fresh worker restored from that session's floor bundle,
 * and the fresh worker opens by posting a terminal `error` activity —
 * "Session interrupted — the agent host restarted…" — for a session that had in
 * fact finished cleanly, then emits a stale terminal frame that strips the
 * router affinity the follow-up turn needs to post its own final response.
 *
 * Root cause: session status transitions were in-memory only. `savePersistedState`
 * runs when a runner is *attached* and (on a graceful shutdown) in `stop()` —
 * never when a session completes. So the last durable snapshot of a
 * cleanly-completed session still read `active` with no runner, which is exactly
 * the shape of a session whose host died mid-run, and
 * `reconcileInterruptedSessions` could not tell them apart. Everything
 * downstream reads that snapshot: a cold restore, and the floor bundle (which
 * `WorkspaceSyncService` builds by re-reading `edge-worker-state.json` off disk).
 *
 * The fix flushes state — with a `terminalState` marker — from inside
 * `emitTerminalOnce`, *before* the signal reaches its observers.
 */
describe("AgentSessionManager completion integrity", () => {
	const sessionId = "linear-sess-1";
	const issueId = "issue-uuid-1";
	const issueKey = "DEF-1";
	const workspacePath = "/workspaces/DEF-1";
	const claudeSessionId = "claude-abc";

	interface PostedActivity {
		type: string;
		body?: string;
	}

	/**
	 * One worker process's view of a session: a manager with a real
	 * {@link PersistenceManager} behind the terminal-path flush hook, so what
	 * lands on disk is exactly what a cold restore (or the floor bundle) would
	 * read.
	 */
	function bootWorker(cyrusHome: string) {
		const posted: PostedActivity[] = [];
		const terminals: string[] = [];
		/** Interleaved log of every post and terminal emit, in real order. */
		const events: string[] = [];

		const sink: IActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockImplementation(async (_s, content) => {
				posted.push(content);
				events.push(`post:${content.type}`);
				return { activityId: `activity-${posted.length}` };
			}),
			createAgentSession: vi.fn().mockResolvedValue("ext-session-1"),
		} as unknown as IActivitySink;

		const manager = new AgentSessionManager();
		const persistence = new PersistenceManager(join(cyrusHome, "state"));
		let flushes = 0;
		manager.setPersistStateHook(async () => {
			flushes++;
			events.push("flush");
			const { sessions, entries } = manager.serializeState();
			await persistence.saveEdgeWorkerState({
				agentSessions: sessions,
				agentSessionEntries: entries,
			});
		});
		manager.on("sessionTerminal", (_id: string, state: string) => {
			terminals.push(state);
			events.push(`terminal:${state}`);
		});

		return {
			manager,
			persistence,
			sink,
			posted,
			terminals,
			events,
			get flushes() {
				return flushes;
			},
			/** Mirrors EdgeWorker: save state right after a runner is attached. */
			async attachRunner() {
				manager.addAgentRunner(sessionId, {
					getFormatter: () => new ClaudeMessageFormatter(),
					constructor: { name: "ClaudeRunner" },
				} as unknown as Parameters<typeof manager.addAgentRunner>[1]);
				const { sessions, entries } = manager.serializeState();
				await persistence.saveEdgeWorkerState({
					agentSessions: sessions,
					agentSessionEntries: entries,
				});
			},
			createSession() {
				manager.createCyrusAgentSession(
					sessionId,
					issueId,
					{
						id: issueId,
						identifier: issueKey,
						title: "Completion integrity",
						description: "",
						branchName: issueKey,
					},
					{ path: workspacePath, isGitWorktree: true },
				);
				manager.setActivitySink(sessionId, sink);
			},
			/** Mirrors EdgeWorker.start(): restore, then reconcile. */
			async restoreAndReconcile() {
				const state = await persistence.loadEdgeWorkerState();
				manager.restoreState(
					state?.agentSessions ?? {},
					state?.agentSessionEntries ?? {},
				);
				manager.setActivitySink(sessionId, sink);
				return manager.reconcileInterruptedSessions();
			},
		};
	}

	function result(subtype = "success"): SDKResultMessage {
		return {
			type: "result",
			subtype,
			is_error: subtype !== "success",
			duration_ms: 1,
			duration_api_ms: 1,
			num_turns: 1,
			result: "The change is implemented and committed.",
			stop_reason: null,
			total_cost_usd: 0,
			usage: {},
			modelUsage: {},
			permission_denials: [],
			uuid: "result-1",
			session_id: claudeSessionId,
		} as unknown as SDKResultMessage;
	}

	/**
	 * The persistence floor, faithfully: read the state file off disk (never the
	 * live manager) and tar it up with the session transcripts.
	 */
	async function pushFloorBundle(cyrusHome: string): Promise<string> {
		const persistence = new PersistenceManager(join(cyrusHome, "state"));
		const state = await persistence.loadEdgeWorkerState();
		if (!state) throw new Error("no persisted state to bundle");

		const claudeProjectsDir = join(cyrusHome, "projects");
		const transcriptDir = join(
			claudeProjectsDir,
			workspacePath.replace(/[^a-zA-Z0-9]/g, "-"),
		);
		mkdirSync(transcriptDir, { recursive: true });
		writeFileSync(
			join(transcriptDir, `${claudeSessionId}.jsonl`),
			'{"type":"noop"}\n',
		);

		const bundleFile = join(cyrusHome, "bundle.tar.gz");
		const wrote = await buildBundle({
			issueKey,
			state,
			claudeProjectsDir,
			outFile: bundleFile,
		});
		expect(wrote).toBe(true);
		return bundleFile;
	}

	/** Cold-start a replacement host from the bundle the destroyed one left. */
	async function restoreFromFloorBundle(
		bundleFile: string,
		cyrusHome: string,
	): Promise<void> {
		mkdirSync(join(cyrusHome, "state"), { recursive: true });
		const restored = await restoreBundle({
			bundleFile,
			claudeProjectsDir: join(cyrusHome, "projects"),
			stateFile: join(cyrusHome, "state", "edge-worker-state.json"),
		});
		expect(restored.restoredSessions).toBe(1);
	}

	function home(prefix: string): string {
		return mkdtempSync(join(tmpdir(), prefix));
	}

	// The core regression. The acceptance criteria are asserted on the
	// replacement worker: no transient `error`, exactly one `complete`, exactly
	// one final `response`.
	it("routes a follow-up from a destroyed worker's bundle with no transient error, one complete and one response", async () => {
		const homeA = home("cyrus-completion-a-");
		const workerA = bootWorker(homeA);
		workerA.createSession();
		await workerA.attachRunner();

		await workerA.manager.completeSession(sessionId, result());
		expect(workerA.terminals).toEqual(["complete"]);
		expect(workerA.posted.filter((a) => a.type === "response")).toHaveLength(1);

		// The durable snapshot must show the session finished. This is the
		// assertion that fails without the fix: it read `active`.
		const snapshotA = await workerA.persistence.loadEdgeWorkerState();
		expect(snapshotA?.agentSessions?.[sessionId]?.status).toBe("complete");
		expect(snapshotA?.agentSessions?.[sessionId]?.terminalState).toBe(
			"complete",
		);

		const bundleFile = await pushFloorBundle(homeA);

		// Worker A is destroyed. A replacement cold-starts from its bundle.
		const homeB = home("cyrus-completion-b-");
		await restoreFromFloorBundle(bundleFile, homeB);
		const workerB = bootWorker(homeB);
		const reconciled = await workerB.restoreAndReconcile();

		// The restored session is complete, not interrupted.
		expect(reconciled).toEqual([]);
		expect(workerB.posted).toEqual([]);
		expect(workerB.terminals).toEqual([]);

		// The follow-up prompt arrives and runs another turn.
		await workerB.attachRunner();
		expect(workerB.manager.getSession(sessionId)?.status).toBe("active");
		expect(
			workerB.manager.getSession(sessionId)?.terminalState,
		).toBeUndefined();
		await workerB.manager.completeSession(sessionId, result());

		expect(workerB.posted.filter((a) => a.type === "error")).toEqual([]);
		expect(workerB.terminals).toEqual(["complete"]);
		expect(workerB.posted.filter((a) => a.type === "response")).toHaveLength(1);
	});

	// Same guarantee after the issue was closed and reopened. `handleIssueStateChangeMessage`
	// posts a closing response and drops the session in-memory, but the floor
	// bundle is captured BEFORE that removal (deliberately — so a reopen can
	// resume with its transcripts), which is why the reopened worker still
	// restores the finished session and must not reconcile it.
	it("routes a reopen from the retained bundle with no transient error, one complete and one response", async () => {
		const homeA = home("cyrus-reopen-a-");
		const workerA = bootWorker(homeA);
		workerA.createSession();
		await workerA.attachRunner();
		await workerA.manager.completeSession(sessionId, result());

		// Issue marked Done: the closing response, then the retained bundle.
		await workerA.manager.createResponseActivity(
			sessionId,
			`Session stopped — ${issueKey} was marked as Done or Canceled.`,
		);
		const bundleFile = await pushFloorBundle(homeA);
		workerA.manager.removeSession(sessionId);

		// Issue reopened: a fresh host restores the retained bundle.
		const homeB = home("cyrus-reopen-b-");
		await restoreFromFloorBundle(bundleFile, homeB);
		const workerB = bootWorker(homeB);

		expect(await workerB.restoreAndReconcile()).toEqual([]);
		expect(workerB.posted).toEqual([]);
		expect(workerB.terminals).toEqual([]);

		await workerB.attachRunner();
		await workerB.manager.completeSession(sessionId, result());

		expect(workerB.posted.filter((a) => a.type === "error")).toEqual([]);
		expect(workerB.terminals).toEqual(["complete"]);
		expect(workerB.posted.filter((a) => a.type === "response")).toHaveLength(1);
	});

	// Monotonicity, in-process: reviving a session clears the terminal marker, so
	// a second restore of the *older* snapshot cannot re-apply it. This is the
	// state-side counterpart to RouterConnection dropping the stale terminal
	// frame (see RouterConnection.session-state-monotonic.test.ts).
	it("does not re-apply a stale terminal state once the session has advanced", async () => {
		const homeA = home("cyrus-stale-a-");
		const workerA = bootWorker(homeA);
		workerA.createSession();
		await workerA.attachRunner();
		await workerA.manager.completeSession(sessionId, result());

		// Snapshot taken while the session read terminal.
		const staleSnapshot = await workerA.persistence.loadEdgeWorkerState();
		expect(staleSnapshot?.agentSessions?.[sessionId]?.terminalState).toBe(
			"complete",
		);

		// The session advances: a follow-up attaches a runner.
		await workerA.attachRunner();
		const advanced = await workerA.persistence.loadEdgeWorkerState();
		expect(advanced?.agentSessions?.[sessionId]?.terminalState).toBeUndefined();
		expect(advanced?.agentSessions?.[sessionId]?.status).toBe("active");

		// A restore of the stale snapshot must not resurrect the spent one-shot:
		// this turn still owes the router a terminal signal, and still owes Linear
		// a response.
		const workerC = bootWorker(homeA);
		workerC.manager.restoreState(
			staleSnapshot?.agentSessions ?? {},
			staleSnapshot?.agentSessionEntries ?? {},
		);
		workerC.manager.setActivitySink(sessionId, workerC.sink);
		expect(await workerC.manager.reconcileInterruptedSessions()).toEqual([]);
		await workerC.attachRunner();
		await workerC.manager.completeSession(sessionId, result());
		expect(workerC.terminals).toEqual(["complete"]);
		expect(workerC.posted.filter((a) => a.type === "response")).toHaveLength(1);
	});

	// Symptom B: the CLI-mode drive reported a completed session with no final
	// response and no completion, only reaching `complete` once stopped by hand.
	// The product path does post one, unprompted — this pins that so the next
	// drive can attribute a repeat to the harness rather than to the runner.
	it("posts exactly one final response and reports complete without an explicit stop", async () => {
		const homeA = home("cyrus-final-response-");
		const workerA = bootWorker(homeA);
		workerA.createSession();
		await workerA.attachRunner();

		await workerA.manager.completeSession(sessionId, result());

		expect(workerA.posted).toEqual([
			{ type: "response", body: "The change is implemented and committed." },
		]);
		expect(workerA.manager.getSession(sessionId)?.status).toBe("complete");
		expect(workerA.terminals).toEqual(["complete"]);
	});

	// Ordering: the flush must land between the final post and the terminal
	// signal. The router releases affinity — and the floor takes its bundle —
	// the instant the signal is observed, so anything written afterwards is
	// invisible to the replacement host.
	it("flushes durable state after the final response and before the terminal signal", async () => {
		const homeA = home("cyrus-order-");
		const workerA = bootWorker(homeA);
		workerA.createSession();
		await workerA.attachRunner();

		await workerA.manager.completeSession(sessionId, result());

		expect(workerA.events).toEqual([
			"post:response",
			"flush",
			"terminal:complete",
		]);
	});

	// A failed flush must not strand the issue lock: the terminal signal is the
	// only thing that releases it.
	it("still signals terminal when the durable flush fails", async () => {
		const homeA = home("cyrus-flush-fail-");
		const workerA = bootWorker(homeA);
		workerA.createSession();
		await workerA.attachRunner();
		workerA.manager.setPersistStateHook(async () => {
			throw new Error("ENOSPC");
		});

		await expect(
			workerA.manager.completeSession(sessionId, result()),
		).resolves.toBeUndefined();
		expect(workerA.terminals).toEqual(["complete"]);
	});

	// The pre-existing behaviour this must not regress: a session whose host
	// really did die mid-run has no terminal state recorded, so it is still
	// reported and its router lock still released.
	it("still reconciles a session that was genuinely interrupted mid-run", async () => {
		const homeA = home("cyrus-interrupted-");
		const workerA = bootWorker(homeA);
		workerA.createSession();
		await workerA.attachRunner();
		// No completion — the host is destroyed mid-turn.

		const homeB = home("cyrus-interrupted-b-");
		mkdirSync(join(homeB, "state"), { recursive: true });
		const snapshot = await workerA.persistence.loadEdgeWorkerState();
		expect(snapshot?.agentSessions?.[sessionId]?.terminalState).toBeUndefined();

		const workerB = bootWorker(homeB);
		await workerB.persistence.saveEdgeWorkerState(snapshot ?? {});
		expect(await workerB.restoreAndReconcile()).toEqual([sessionId]);
		expect(workerB.terminals).toEqual(["error"]);
		expect(workerB.posted.map((a) => a.type)).toEqual(["error"]);
	});
});
