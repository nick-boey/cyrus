import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

	it("never throws when the state file is missing", async () => {
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

		// Nothing to sync is not a failure — resolves `true` so the issue
		// isn't kept touched forever waiting for a state file that may never
		// appear.
		await expect(service.syncIssue("CYPACK-9")).resolves.toBe(true);
		expect(fetchMock).not.toHaveBeenCalled();
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
		service.touch("CYPACK-1");
		service.touch("CYPACK-2");

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
			service.touch("CYPACK-9");
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
		service.touch("CYPACK-9");

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

		service.touch("CYPACK-9"); // session start
		await service.syncIssueOnTermination("CYPACK-9"); // session end, sync succeeds
		expect(pushWipIfDirty).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// A later flush (e.g. a shutdown moments afterward) must not re-sync
		// an issue whose session already ended and was synced successfully.
		await service.stop();
		expect(pushWipIfDirty).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("leaves the issue touched when the terminal sync fails, so a later flush retries it", async () => {
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

		service.touch("CYPACK-9");
		await service.syncIssueOnTermination("CYPACK-9");
		expect(uploadAttempts).toBe(1);
		expect(logger.warn).toHaveBeenCalled();

		// Router recovered — a subsequent flush (periodic tick or shutdown)
		// retries the same issue and this time it succeeds.
		await service.stop();
		expect(uploadAttempts).toBe(2);
	});
});

describe("WorkspaceSyncService.stop bounded flush", () => {
	it("gives up waiting after stopFlushTimeoutMs so shutdown is never blocked indefinitely", async () => {
		const cyrusHome = mkCyrusHome();
		const workspacePath = mkGitRepo();
		writeState(cyrusHome, { "sess-1": makeSession("CYPACK-9", workspacePath) });

		// Never resolves — simulates a hung git push against an unreachable
		// router, or any other stuck sync step.
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

		service.touch("CYPACK-9");

		const start = Date.now();
		await service.stop();
		const elapsed = Date.now() - start;

		// Well under the hang duration (which is infinite) — proves stop()
		// gave up rather than waiting forever.
		expect(elapsed).toBeLessThan(2000);
	});
});
