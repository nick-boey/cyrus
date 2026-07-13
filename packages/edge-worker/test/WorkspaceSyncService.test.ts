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
		expect(existsSync(join(cyrusHome, "sync", "CYPACK-9.tar.gz"))).toBe(true);
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

		await expect(service.syncIssue("CYPACK-9")).resolves.toBeUndefined();

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

		await expect(service.syncIssue("CYPACK-9")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("never throws when the router rejects the upload", async () => {
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

		await expect(service.syncIssue("CYPACK-9")).resolves.toBeUndefined();
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
