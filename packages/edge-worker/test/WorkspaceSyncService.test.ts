import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitService } from "../src/GitService.js";
import { WorkspaceSyncService } from "../src/WorkspaceSyncService.js";

/**
 * Task 10 — WorkspaceSyncService is the client side of the persistence
 * floor: it WIP-pushes any dirty worktree(s) for an issue and uploads a
 * bundle of the Claude transcripts + session state to the router, so a
 * fresh container (or another device) can resume the issue after this one
 * dies. `buildBundle`/`uploadBundle` are the real implementations from
 * `cyrus-workspace-sync` (already tested there) — only `fetch` and
 * `gitService` are mocked here.
 */

const ROUTER_URL = "ws://router.example.com";
const DEVICE_TOKEN = "device-token-123";

function mkCyrusHome(): string {
	return mkdtempSync(join(tmpdir(), "cyrus-home-"));
}

/** A directory that looks like a git repo for the `.git`-entry detection — GitService itself is mocked, so no real git plumbing is needed. */
function mkGitRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "cyrus-repo-"));
	mkdirSync(join(dir, ".git"));
	return dir;
}

function writeState(
	cyrusHome: string,
	sessions: Record<string, unknown>,
): void {
	mkdirSync(join(cyrusHome, "state"), { recursive: true });
	writeFileSync(
		join(cyrusHome, "state", "edge-worker-state.json"),
		JSON.stringify({
			version: "4.0",
			savedAt: new Date().toISOString(),
			state: { agentSessions: sessions, agentSessionEntries: {} },
		}),
	);
}

function makeSession(issueKey: string, workspacePath: string) {
	return {
		issue: {
			id: `${issueKey}-uuid`,
			identifier: issueKey,
			title: "Test issue",
			branchName: "",
		},
		workspace: { path: workspacePath, isGitWorktree: true },
	};
}

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn() };
}

function stubFetchOk(): ReturnType<typeof vi.fn> {
	const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function baseOpts(cyrusHome: string) {
	return {
		cyrusHome,
		routerUrl: ROUTER_URL,
		deviceToken: DEVICE_TOKEN,
		claudeProjectsDir: join(cyrusHome, "claude-projects"),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("WorkspaceSyncService.syncIssue", () => {
	it("WIP-pushes the single-repo workspace and uploads a bundle", async () => {
		const cyrusHome = mkCyrusHome();
		const workspacePath = mkGitRepo();
		writeState(cyrusHome, { "sess-1": makeSession("CYPACK-9", workspacePath) });

		const pushWipIfDirty = vi.fn(async () => true);
		const deriveWorktreeBranchName = vi.fn(() => "cypack-9-branch");
		const fetchMock = stubFetchOk();

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: { pushWipIfDirty, deriveWorktreeBranchName },
			logger: makeLogger(),
		});

		await service.syncIssue("CYPACK-9");

		expect(pushWipIfDirty).toHaveBeenCalledTimes(1);
		expect(pushWipIfDirty).toHaveBeenCalledWith(
			workspacePath,
			"cypack-9-branch",
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			"http://router.example.com/artifacts/issues/CYPACK-9/bundle",
		);
		expect(init.method).toBe("PUT");
		// Housekeeping: the local tarball is deleted after a successful upload
		// so bundles don't pile up on disk forever — the router now holds the
		// copy of record.
		expect(existsSync(join(cyrusHome, "sync", "CYPACK-9.tar.gz"))).toBe(false);
	});

	it("fans out to each immediate subdirectory containing a .git entry for a multi-repo root", async () => {
		const cyrusHome = mkCyrusHome();
		const root = mkdtempSync(join(tmpdir(), "cyrus-multi-"));
		const repoA = join(root, "repo-a");
		const repoB = join(root, "repo-b");
		const notARepo = join(root, "docs");
		mkdirSync(join(repoA, ".git"), { recursive: true });
		mkdirSync(join(repoB, ".git"), { recursive: true });
		mkdirSync(notARepo, { recursive: true });
		writeState(cyrusHome, { "sess-1": makeSession("CYPACK-9", root) });

		const pushWipIfDirty = vi.fn(async () => true);
		const deriveWorktreeBranchName = vi.fn(() => "cypack-9-branch");
		stubFetchOk();

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: { pushWipIfDirty, deriveWorktreeBranchName },
			logger: makeLogger(),
		});

		await service.syncIssue("CYPACK-9");

		expect(pushWipIfDirty).toHaveBeenCalledTimes(2);
		const calledPaths = pushWipIfDirty.mock.calls.map((call) => call[0]).sort();
		expect(calledPaths).toEqual([repoA, repoB].sort());
		// The root itself (not a repo) and the non-repo subdirectory must never
		// be passed to pushWipIfDirty.
		expect(pushWipIfDirty).not.toHaveBeenCalledWith(root, expect.anything());
		expect(pushWipIfDirty).not.toHaveBeenCalledWith(
			notARepo,
			expect.anything(),
		);
	});

	it("skips the git push and the upload when no sessions match the issue key", async () => {
		const cyrusHome = mkCyrusHome();
		const workspacePath = mkGitRepo();
		writeState(cyrusHome, { "sess-1": makeSession("CYPACK-9", workspacePath) });

		const pushWipIfDirty = vi.fn(async () => true);
		const fetchMock = stubFetchOk();

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: {
				pushWipIfDirty,
				deriveWorktreeBranchName: vi.fn(() => "branch"),
			},
			logger: makeLogger(),
		});

		await service.syncIssue("OTHER-1");

		expect(pushWipIfDirty).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
		expect(existsSync(join(cyrusHome, "sync", "OTHER-1.tar.gz"))).toBe(false);
	});

	it("logs and continues past a per-workspace git push failure so the bundle upload still proceeds", async () => {
		const cyrusHome = mkCyrusHome();
		const root = mkdtempSync(join(tmpdir(), "cyrus-multi-"));
		const repoA = join(root, "repo-a");
		const repoB = join(root, "repo-b");
		mkdirSync(join(repoA, ".git"), { recursive: true });
		mkdirSync(join(repoB, ".git"), { recursive: true });
		writeState(cyrusHome, { "sess-1": makeSession("CYPACK-9", root) });

		const pushWipIfDirty = vi.fn(async (path: string) => {
			if (path === repoA) {
				throw new Error("git push failed: network unreachable");
			}
			return true;
		});
		const fetchMock = stubFetchOk();
		const logger = makeLogger();

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: {
				pushWipIfDirty,
				deriveWorktreeBranchName: vi.fn(() => "branch"),
			},
			logger,
		});

		// A per-workspace push failure is caught and logged internally — it
		// does not fail the overall sync, so this resolves `true`.
		await expect(service.syncIssue("CYPACK-9")).resolves.toBe(true);

		expect(pushWipIfDirty).toHaveBeenCalledTimes(2);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("repo-a"));
		// The failure on repo-a must not have aborted the upload.
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("resolves false (not success) when the state file is missing, so a racing terminal sync doesn't drop protection", async () => {
		const cyrusHome = mkCyrusHome();
		const fetchMock = stubFetchOk();

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: {
				pushWipIfDirty: vi.fn(),
				deriveWorktreeBranchName: vi.fn(),
			},
			logger: makeLogger(),
		});

		// Task 10 fix pass 2 — Finding 2 minor fix: a missing state file (e.g.
		// a terminal sync racing EdgeWorker's very first
		// `savePersistedState()`) is "nothing synced", NOT success. Resolving
		// `true` here used to let `syncIssueOnTermination` untouch an issue
		// whose work was never actually captured anywhere — resolving
		// `false` instead means the issue stays protected until a later tick
		// finds real state to sync.
		await expect(service.syncIssue("CYPACK-9")).resolves.toBe(false);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps a terminal sync's issue touched when it races a missing state file, and syncs it once state appears", async () => {
		const cyrusHome = mkCyrusHome();
		const fetchMock = stubFetchOk();
		const gitService = {
			pushWipIfDirty: vi.fn(async () => true),
			deriveWorktreeBranchName: vi.fn(() => "branch"),
		};

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService,
			logger: makeLogger(),
		});

		service.touch("CYPACK-9", "sess-a");
		// State file does not exist yet — session ended before EdgeWorker's
		// first savePersistedState() call.
		await service.syncIssueOnTermination("CYPACK-9", "sess-a");
		expect(fetchMock).not.toHaveBeenCalled();

		// State now appears (EdgeWorker's own periodic state save caught up).
		const workspacePath = mkGitRepo();
		writeState(cyrusHome, { "sess-1": makeSession("CYPACK-9", workspacePath) });

		// A later flush (periodic tick or shutdown) must still retry this
		// issue — proving it was NOT dropped by the earlier no-state-file
		// attempt — and this time it actually syncs.
		await service.stop();
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("resolves false (and leaves the issue eligible for retry) when the router rejects the upload", async () => {
		const cyrusHome = mkCyrusHome();
		const workspacePath = mkGitRepo();
		writeState(cyrusHome, { "sess-1": makeSession("CYPACK-9", workspacePath) });
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 500 })),
		);
		const logger = makeLogger();

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: {
				pushWipIfDirty: vi.fn(async () => true),
				deriveWorktreeBranchName: vi.fn(() => "branch"),
			},
			logger,
		});

		// A genuine failure (router rejected the upload) resolves `false` —
		// this is the signal `syncIssueOnTermination` uses to decide whether
		// it's safe to stop protecting the issue.
		await expect(service.syncIssue("CYPACK-9")).resolves.toBe(false);
		expect(logger.warn).toHaveBeenCalled();
	});
});

describe("WorkspaceSyncService concurrency", () => {
	it("coalesces concurrent syncIssue calls for the same issue into a single upload", async () => {
		const cyrusHome = mkCyrusHome();
		const workspacePath = mkGitRepo();
		writeState(cyrusHome, { "sess-1": makeSession("CYPACK-9", workspacePath) });

		let releasePush: (() => void) | undefined;
		const pushGate = new Promise<void>((resolve) => {
			releasePush = resolve;
		});
		const pushWipIfDirty = vi.fn(async () => {
			await pushGate;
			return true;
		});
		const fetchMock = stubFetchOk();

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: {
				pushWipIfDirty,
				deriveWorktreeBranchName: vi.fn(() => "branch"),
			},
			logger: makeLogger(),
		});

		const p1 = service.syncIssue("CYPACK-9");
		// Let p1 genuinely progress past readState/derive-branch and into the
		// gated git push before firing the second call, so this proves
		// coalescing survives real async interleaving rather than just the
		// synchronous-call-in-the-same-tick case.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const p2 = service.syncIssue("CYPACK-9");

		expect(p2).toBe(p1);

		releasePush?.();
		await Promise.all([p1, p2]);

		expect(pushWipIfDirty).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("does not coalesce syncIssue calls for different issues", async () => {
		const cyrusHome = mkCyrusHome();
		const wsA = mkGitRepo();
		const wsB = mkGitRepo();
		writeState(cyrusHome, {
			"sess-1": makeSession("CYPACK-1", wsA),
			"sess-2": makeSession("CYPACK-2", wsB),
		});
		const pushWipIfDirty = vi.fn(async () => true);
		stubFetchOk();

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: {
				pushWipIfDirty,
				deriveWorktreeBranchName: vi.fn(() => "branch"),
			},
			logger: makeLogger(),
		});

		const p1 = service.syncIssue("CYPACK-1");
		const p2 = service.syncIssue("CYPACK-2");
		expect(p1).not.toBe(p2);
		await Promise.all([p1, p2]);
		expect(pushWipIfDirty).toHaveBeenCalledTimes(2);
	});
});

describe("WorkspaceSyncService.stop", () => {
	it("stops the timer and flushes every touched issue", async () => {
		const cyrusHome = mkCyrusHome();
		const wsA = mkGitRepo();
		const wsB = mkGitRepo();
		writeState(cyrusHome, {
			"sess-1": makeSession("CYPACK-1", wsA),
			"sess-2": makeSession("CYPACK-2", wsB),
		});
		const pushWipIfDirty = vi.fn(async () => true);
		const fetchMock = stubFetchOk();

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: {
				pushWipIfDirty,
				deriveWorktreeBranchName: vi.fn(() => "branch"),
			},
			logger: makeLogger(),
			intervalMs: 60_000,
		});
		service.start();
		service.touch("CYPACK-1", "sess-a");
		service.touch("CYPACK-2", "sess-b");

		await service.stop();

		expect(pushWipIfDirty).toHaveBeenCalledTimes(2);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("is safe to call stop() without start() and with nothing touched", async () => {
		const cyrusHome = mkCyrusHome();
		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: {
				pushWipIfDirty: vi.fn(),
				deriveWorktreeBranchName: vi.fn(),
			},
			logger: makeLogger(),
		});
		await expect(service.stop()).resolves.toBeUndefined();
	});
});

/**
 * Task 10 fix pass 1 — Finding 1 regression guards.
 *
 * Before this fix, `touch()` was only ever called from the session-end
 * listener, and `flushTouched()` cleared the touched set before awaiting
 * anything — so a session that was still running when the periodic timer
 * fired was never synced, and `stop()` (SIGTERM mid-session) flushed
 * nothing. These tests drive the service the same way EdgeWorker now does:
 * `touch()` at session *start*, with no corresponding terminal sync, to
 * prove a still-running session is protected by both the timer and stop().
 */
describe("WorkspaceSyncService — protects a live (un-ended) session", () => {
	it("keeps re-syncing a touched issue on every periodic tick while its session has not ended", async () => {
		// Real timers with a short interval + polling assertions — real
		// `node:fs/promises` I/O (readState/buildBundle) doesn't reliably
		// advance under vitest's fake timers, so this exercises the actual
		// `setInterval` callback rather than a simulated clock.
		const cyrusHome = mkCyrusHome();
		const workspacePath = mkGitRepo();
		writeState(cyrusHome, { "sess-1": makeSession("CYPACK-9", workspacePath) });

		const pushWipIfDirty = vi.fn(async () => true);
		const fetchMock = stubFetchOk();

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: {
				pushWipIfDirty,
				deriveWorktreeBranchName: vi.fn(() => "branch"),
			},
			logger: makeLogger(),
			intervalMs: 20,
		});

		try {
			// Simulates the session-START touch() hook (added in EdgeWorker's
			// `initializeAgentRunner` / `resumeAgentSession`) with no
			// session-end ever occurring during this test — the agent is
			// still working.
			service.touch("CYPACK-9", "sess-a");
			service.start();

			// Wait for the first tick to sync the still-running session.
			await vi.waitFor(() => {
				expect(pushWipIfDirty.mock.calls.length).toBeGreaterThanOrEqual(1);
			});
			const afterFirstTick = pushWipIfDirty.mock.calls.length;

			// Wait for at least one MORE tick, still with no termination: this
			// is exactly the regression this fix guards against. Before the
			// fix, `flushTouched()` cleared the touched set after the first
			// tick, so a session still running many intervals later would
			// never be synced again — the count would freeze at
			// `afterFirstTick` forever instead of continuing to climb.
			await vi.waitFor(() => {
				expect(pushWipIfDirty.mock.calls.length).toBeGreaterThan(
					afterFirstTick,
				);
			});
			expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
		} finally {
			await service.stop();
		}
	});

	it("flushes a live (un-ended) session's work on stop()", async () => {
		const cyrusHome = mkCyrusHome();
		const workspacePath = mkGitRepo();
		writeState(cyrusHome, { "sess-1": makeSession("CYPACK-9", workspacePath) });

		const pushWipIfDirty = vi.fn(async () => true);
		const fetchMock = stubFetchOk();

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: {
				pushWipIfDirty,
				deriveWorktreeBranchName: vi.fn(() => "branch"),
			},
			logger: makeLogger(),
		});

		// Session start touch(), no terminal sync — mirrors a container
		// receiving SIGTERM while the agent is still mid-task.
		service.touch("CYPACK-9", "sess-a");

		await service.stop();

		expect(pushWipIfDirty).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});
});

describe("WorkspaceSyncService.syncIssueOnTermination", () => {
	it("removes the issue from the touched set once the terminal sync succeeds", async () => {
		const cyrusHome = mkCyrusHome();
		const workspacePath = mkGitRepo();
		writeState(cyrusHome, { "sess-1": makeSession("CYPACK-9", workspacePath) });

		const pushWipIfDirty = vi.fn(async () => true);
		const fetchMock = stubFetchOk();

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: {
				pushWipIfDirty,
				deriveWorktreeBranchName: vi.fn(() => "branch"),
			},
			logger: makeLogger(),
		});

		service.touch("CYPACK-9", "sess-a"); // session start
		await service.syncIssueOnTermination("CYPACK-9", "sess-a"); // session end, sync succeeds
		expect(pushWipIfDirty).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// A later flush (e.g. a shutdown moments afterward) must not re-sync
		// an issue whose session already ended and was synced successfully.
		await service.stop();
		expect(pushWipIfDirty).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("leaves the issue touched when the terminal sync fails, converges once a later flush succeeds, and does not re-sync after that", async () => {
		const cyrusHome = mkCyrusHome();
		const workspacePath = mkGitRepo();
		writeState(cyrusHome, { "sess-1": makeSession("CYPACK-9", workspacePath) });

		const pushWipIfDirty = vi.fn(async () => true);
		let uploadAttempts = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				uploadAttempts++;
				// First attempt (the terminal sync) fails like a router blip;
				// the retry from the later flush succeeds.
				return new Response(null, {
					status: uploadAttempts === 1 ? 500 : 200,
				});
			}),
		);
		const logger = makeLogger();

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: {
				pushWipIfDirty,
				deriveWorktreeBranchName: vi.fn(() => "branch"),
			},
			logger,
		});

		service.touch("CYPACK-9", "sess-a");
		await service.syncIssueOnTermination("CYPACK-9", "sess-a");
		expect(uploadAttempts).toBe(1);
		expect(logger.warn).toHaveBeenCalled();

		// Router recovered — a subsequent flush (periodic tick or shutdown)
		// retries the same issue and this time it succeeds. Task 10 fix pass
		// 2 — Finding 2: `syncIssue` (used by both the terminal path and the
		// periodic `flushTouched` path) now completes the removal here, not
		// just `syncIssueOnTermination`.
		await service.stop();
		expect(uploadAttempts).toBe(2);

		// Convergence proof: a THIRD flush must not touch this issue again —
		// if the touched set never converged (the pre-fix bug), this would
		// re-sync forever.
		await service.stop();
		expect(uploadAttempts).toBe(2);
	});
});

/**
 * Task 10 fix pass 2 — Finding 2 (workspace-gone) and the paired minor fix
 * (session-keyed refcount instead of issue-keyed removal).
 */
describe("WorkspaceSyncService — touched-set convergence", () => {
	it("drops an issue whose workspace no longer exists on disk, without warning, instead of retrying forever", async () => {
		const cyrusHome = mkCyrusHome();
		// Deliberately never created — simulates a worktree torn down through
		// a path that never told WorkspaceSyncService (e.g. the session
		// crashed without reaching syncIssueOnTermination, then the issue
		// was independently cleaned up elsewhere).
		const missingWorkspacePath = join(tmpdir(), `cyrus-gone-${Date.now()}`);
		writeState(cyrusHome, {
			"sess-1": makeSession("CYPACK-9", missingWorkspacePath),
		});

		const pushWipIfDirty = vi.fn(async () => true);
		const fetchMock = stubFetchOk();
		const logger = makeLogger();

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: {
				pushWipIfDirty,
				deriveWorktreeBranchName: vi.fn(() => "branch"),
			},
			logger,
		});

		service.touch("CYPACK-9", "sess-a");
		await service.syncIssue("CYPACK-9");

		// No git push was attempted against the missing path, and no warning
		// was logged for it (this is an expected, one-time condition, not a
		// recurring error).
		expect(pushWipIfDirty).not.toHaveBeenCalled();
		expect(logger.warn).not.toHaveBeenCalled();

		// The issue must be gone from the touched set now — a later flush
		// (periodic tick or shutdown) must not attempt it again.
		fetchMock.mockClear();
		await service.stop();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("keeps protecting an issue with a live session even after a DIFFERENT session on the same issue terminates successfully (refcount)", async () => {
		const cyrusHome = mkCyrusHome();
		const workspacePath = mkGitRepo();
		writeState(cyrusHome, { "sess-1": makeSession("CYPACK-9", workspacePath) });

		const pushWipIfDirty = vi.fn(async () => true);
		const fetchMock = stubFetchOk();

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: {
				pushWipIfDirty,
				deriveWorktreeBranchName: vi.fn(() => "branch"),
			},
			logger: makeLogger(),
		});

		// Two sessions (e.g. a parent and a child) both running against the
		// same Linear issue.
		service.touch("CYPACK-9", "session-a");
		service.touch("CYPACK-9", "session-b");

		// Session A ends and its terminal sync succeeds.
		await service.syncIssueOnTermination("CYPACK-9", "session-a");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Session B is still live — a later flush MUST still protect this
		// issue. Before the refcount fix, session A's successful terminal
		// sync would have removed the issue from the touched set outright,
		// silently un-protecting session B's still-uncommitted work.
		await service.stop();
		expect(fetchMock).toHaveBeenCalledTimes(2);

		// Now session B also ends successfully — only now should the issue
		// actually leave the touched set.
		await service.syncIssueOnTermination("CYPACK-9", "session-b");
		expect(fetchMock).toHaveBeenCalledTimes(3);

		fetchMock.mockClear();
		await service.stop();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

/**
 * Task 10 fix pass 3 — Finding 2. The class doc previously claimed a
 * convergence guarantee it did not actually provide: a session that dies
 * without a terminal event (crash, OOM, `kill -9`) never has its id removed
 * from `liveSessionsByIssue`, because that only happens inside
 * `syncIssueOnTermination` — which, by definition, a crashed session never
 * calls. This is a real (bounded) leak, not a doc typo; this test proves it
 * rather than merely asserting the corrected prose. Contrast with "leaves
 * the issue touched when the terminal sync fails..." above, which DOES
 * converge because `syncIssueOnTermination` was called (so the refcount was
 * already at zero) — the difference is entirely whether that method ever ran.
 */
describe("WorkspaceSyncService — documented gap: a crashed session never converges via the refcount alone", () => {
	it("keeps re-syncing an issue on every flush indefinitely when its only live session never reaches syncIssueOnTermination", async () => {
		const cyrusHome = mkCyrusHome();
		const workspacePath = mkGitRepo();
		writeState(cyrusHome, { "sess-1": makeSession("CYPACK-9", workspacePath) });

		const pushWipIfDirty = vi.fn(async () => true);
		const fetchMock = stubFetchOk();

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: {
				pushWipIfDirty,
				deriveWorktreeBranchName: vi.fn(() => "branch"),
			},
			logger: makeLogger(),
		});

		// Session-start touch(), simulating a session whose underlying process
		// is later killed (crash/OOM/kill -9) WITHOUT ever calling
		// syncIssueOnTermination — the refcount is never decremented, unlike
		// every other scenario covered above.
		service.touch("CYPACK-9", "sess-crashed");

		// Three independent flush cycles (three periodic ticks / shutdown
		// attempts) must each still sync the issue — proving it was never
		// dropped from the touched set. If this ever starts failing (i.e. the
		// issue stops being re-synced after the first flush), the documented
		// gap has been closed and the class doc should be revisited.
		await service.stop();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await service.stop();
		expect(fetchMock).toHaveBeenCalledTimes(2);

		await service.stop();
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});
});

/**
 * Writes a fake `git` executable that sleeps for `delayMs` before responding
 * to any invocation, and returns the directory it lives in (prepend this to
 * `PATH` so `execFile("git", ...)` resolves to it instead of the real git).
 * Reports a dirty tree for `status --porcelain` so the real
 * `GitService.pushWipIfDirty` proceeds through add/commit/push, each of
 * which also pays the `delayMs` cost — letting a test assert real wall-clock
 * behavior without touching an actual repo or network.
 */
function makeSlowGitBinary(delayMs: number): string {
	const dir = mkdtempSync(join(tmpdir(), "cyrus-slow-git-"));
	const gitPath = join(dir, "git");
	const delaySeconds = (delayMs / 1000).toFixed(3);
	writeFileSync(
		gitPath,
		[
			"#!/bin/sh",
			`sleep ${delaySeconds}`,
			'for arg in "$@"; do',
			'  if [ "$arg" = "status" ]; then',
			'    echo " M file.txt"',
			"    exit 0",
			"  fi",
			"done",
			"exit 0",
			"",
		].join("\n"),
	);
	chmodSync(gitPath, 0o755);
	return dir;
}

describe("WorkspaceSyncService.stop bounded flush", () => {
	it("gives up waiting after stopFlushTimeoutMs when a sync step hangs forever (e.g. an unreachable router)", async () => {
		const cyrusHome = mkCyrusHome();
		const workspacePath = mkGitRepo();
		writeState(cyrusHome, { "sess-1": makeSession("CYPACK-9", workspacePath) });

		// Never resolves — simulates a hung fetch against an unreachable
		// router, or any other stuck async sync step. This is a legitimate
		// hang mode (async work that genuinely never settles), distinct from
		// the synchronous-blocking mode covered by the real-subprocess test
		// below.
		const pushWipIfDirty = vi.fn(() => new Promise<boolean>(() => {}));

		const service = new WorkspaceSyncService({
			...baseOpts(cyrusHome),
			gitService: {
				pushWipIfDirty,
				deriveWorktreeBranchName: vi.fn(() => "branch"),
			},
			logger: makeLogger(),
			stopFlushTimeoutMs: 50,
		});

		service.touch("CYPACK-9", "sess-a");

		const start = Date.now();
		await service.stop();
		const elapsed = Date.now() - start;

		// Well under the hang duration (which is infinite) — proves stop()
		// gave up rather than waiting forever.
		expect(elapsed).toBeLessThan(2000);
	});

	/**
	 * Task 10 fix pass 2 — Finding 3. The test above mocks `pushWipIfDirty`
	 * as a promise that never resolves, which `Promise.race` always wins
	 * against regardless of whether the *real* implementation blocks the
	 * event loop — so it gave false confidence about the actual regression
	 * (`GitService.pushWipIfDirty` used `execSync`, which blocks the whole
	 * JS thread for as long as git takes; while blocked, the `setTimeout`
	 * backing `stopFlushTimeout()` cannot fire no matter how small
	 * `stopFlushTimeoutMs` is, so the cap was inert against that hang mode).
	 *
	 * This test drives the REAL (unmocked) `GitService.pushWipIfDirty`
	 * against a real, slow child process — a fake `git` binary — so it would
	 * fail against the old `execSync`-based implementation (stop() would
	 * take at least `delayMs` per git invocation to return, since the whole
	 * synchronous chain has to finish before the overdue timer ever gets a
	 * turn) and passes against the current `execFile`-based one (stop()
	 * returns close to `stopFlushTimeoutMs`, while the slow git calls keep
	 * running in the background, unawaited).
	 */
	it("gives up waiting after stopFlushTimeoutMs against a real, slow (non-mocked) git subprocess", async () => {
		const cyrusHome = mkCyrusHome();
		const workspacePath = mkGitRepo();
		writeState(cyrusHome, { "sess-1": makeSession("CYPACK-9", workspacePath) });
		stubFetchOk();

		const slowGitDir = makeSlowGitBinary(300);
		const originalPath = process.env.PATH;
		process.env.PATH = `${slowGitDir}${originalPath ? `:${originalPath}` : ""}`;

		try {
			// Real implementation, not mocked. `console as never` matches the
			// convention in GitService.continuity.test.ts.
			const gitService = new GitService(undefined, console as never);
			const service = new WorkspaceSyncService({
				...baseOpts(cyrusHome),
				gitService,
				logger: makeLogger(),
				stopFlushTimeoutMs: 50,
			});

			service.touch("CYPACK-9", "sess-a");
			// Kick off the sync explicitly first — `stop()`'s `flushTouched()`
			// then coalesces onto this SAME in-flight promise (the existing
			// per-issue in-flight map), so we can await it to completion below
			// without racing `process.env.PATH` restoration against a step
			// that hasn't been spawned yet.
			const syncPromise = service.syncIssue("CYPACK-9");

			const start = Date.now();
			await service.stop();
			const elapsed = Date.now() - start;

			// The full status+add+commit chain against the fake git would take
			// at least ~900ms (3 x 300ms) if awaited to completion. Returning
			// well under that — close to stopFlushTimeoutMs — proves the cap
			// preempted a real, slow subprocess rather than blocking on it.
			expect(elapsed).toBeLessThan(700);

			// Drain the background sync (still against the fake, slow git)
			// before restoring PATH in `finally` — otherwise a step that
			// hasn't been spawned yet could resolve to the REAL `git` acting
			// on `workspacePath`'s non-initialized `.git` directory.
			await expect(syncPromise).resolves.toBe(true);
		} finally {
			process.env.PATH = originalPath;
			// Test hygiene: mkdtempSync leaves this directory (and the fake git
			// binary inside it) on disk otherwise — clean it up regardless of
			// pass/fail so repeated runs don't accumulate temp dirs.
			rmSync(slowGitDir, { recursive: true, force: true });
		}
	});
});
