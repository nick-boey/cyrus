import { execSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import {
	isAgentSessionCreatedWebhook,
	isAgentSessionPromptedWebhook,
} from "cyrus-core";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import {
	makeOriginAndClone,
	pushBranchOnlyToRemote,
} from "./helpers/git-fixtures.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

/**
 * Regression coverage for the restore-ladder gap: a resumed session (existing
 * `claudeSessionId`, prompted via a new comment/webhook) whose
 * `workspace.path` no longer exists on disk — the exact state left behind
 * when an ephemeral container is destroyed and a fresh one drains the queued
 * `agentSessionPrompted` event — must get its git worktree re-created from
 * the issue branch (including any WIP commits the persistence floor already
 * pushed to `origin/<branch>`) BEFORE the runner starts. Before the fix,
 * `resumeAgentSession` handed `RunnerConfigBuilder` a `cwd` that didn't
 * exist; `ClaudeRunner`'s own `mkdirSync(cwd, { recursive: true })` then
 * silently manufactured an empty directory and resumed the Claude
 * transcript into it — no repo, no `.git`, no visibility of the WIP work.
 *
 * These tests drive the REAL (non-mocked) `GitService.createGitWorktree`
 * against a real temporary git remote — the same style as
 * `GitService.continuity.test.ts` — wired through the real `EdgeWorker`
 * method under test (`resumeAgentSession`, called directly the same way
 * `EdgeWorker.runner-selection.test.ts` already does for its "Session
 * Continuation" cases). Only the runner constructors and Linear-facing
 * services are mocked.
 */

vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
}));

vi.mock("cyrus-claude-runner");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		isAgentSessionCreatedWebhook: vi.fn(),
		isAgentSessionPromptedWebhook: vi.fn(),
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});
vi.mock("file-type");

/**
 * Pushes a commit to `origin/<branchName>` without ever checking the branch
 * out anywhere durable — standing in for work published from a container that
 * has since been destroyed. Returns the pushed commit's SHA for a direct HEAD
 * comparison later.
 */
function pushWipOnlyToRemote(clone: string, branchName: string): string {
	return pushBranchOnlyToRemote(clone, branchName, "wip.txt");
}

/**
 * Minimal but structurally-real Issue fixture, mirroring the one in
 * `GitService.continuity.test.ts`: `determineBaseBranch` unconditionally
 * calls `issue.labels()` (Graphite check) and reads `issue.parent`, so both
 * must be real non-throwing stubs.
 */
function makeIssueFixture(overrides: {
	identifier: string;
	branchName: string;
	title?: string;
}) {
	return {
		id: `issue-${overrides.identifier}`,
		identifier: overrides.identifier,
		title: overrides.title ?? "Restore worktree test issue",
		description: "test description",
		url: `https://linear.app/test/issue/${overrides.identifier}`,
		branchName: overrides.branchName,
		state: { name: "In Progress" },
		team: { id: "team-123" },
		labels: () => Promise.resolve({ nodes: [] }),
		parent: Promise.resolve(undefined),
	};
}

describe("EdgeWorker - resumed session workspace recreation", () => {
	let mockClaudeRunner: any;
	let capturedClaudeRunnerConfig: any;
	let mockAgentSessionManager: any;

	beforeEach(() => {
		vi.clearAllMocks();
		capturedClaudeRunnerConfig = null;

		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		vi.mocked(LinearClient).mockImplementation(function () {
			return { rawRequest: vi.fn() } as any;
		});

		mockClaudeRunner = {
			supportsStreamingInput: true,
			start: vi.fn().mockResolvedValue({ sessionId: "claude-session-new" }),
			startStreaming: vi
				.fn()
				.mockResolvedValue({ sessionId: "claude-session-new" }),
			stop: vi.fn(),
			isRunning: vi.fn().mockReturnValue(false),
			addStreamMessage: vi.fn(),
			updatePromptVersions: vi.fn(),
		};
		vi.mocked(ClaudeRunner).mockImplementation(function (config: any) {
			capturedClaudeRunnerConfig = config;
			return mockClaudeRunner;
		});

		mockAgentSessionManager = {
			createCyrusAgentSession: vi.fn(),
			clearStopRequest: vi.fn(),
			addAgentRunner: vi.fn(),
			getAllAgentRunners: vi.fn().mockReturnValue([]),
			serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
			restoreState: vi.fn(),
			postAnalyzingThought: vi.fn().mockResolvedValue(null),
			createThoughtActivity: vi.fn().mockResolvedValue(undefined),
			setActivitySink: vi.fn(),
			on: vi.fn(),
		};
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockAgentSessionManager;
		});

		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
				registerOAuthCallbackHandler: vi.fn(),
			};
		} as any);

		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return {
				register: vi.fn(),
				on: vi.fn(),
				removeAllListeners: vi.fn(),
			};
		} as any);

		vi.mocked(isAgentSessionCreatedWebhook).mockReturnValue(false);
		vi.mocked(isAgentSessionPromptedWebhook).mockReturnValue(false);

		vi.mocked(readFile).mockImplementation(async () => {
			return `<version-tag value="default-v1.0.0" />
# Default Template

Repository: {{repository_name}}
Issue: {{issue_identifier}}`;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function buildEdgeWorker(
		mockRepository: RepositoryConfig,
		issueFixture: any,
	) {
		const mockConfig: EdgeWorkerConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		} as EdgeWorkerConfig;

		const edgeWorker = new EdgeWorker(mockConfig);

		const mockIssueTracker = {
			fetchIssue: vi.fn().mockResolvedValue(issueFixture),
			getIssueLabels: vi.fn().mockResolvedValue([]),
			getClient: vi.fn().mockReturnValue({}),
		};
		(edgeWorker as any).issueTrackers.set(
			mockRepository.linearWorkspaceId,
			mockIssueTracker,
		);

		return edgeWorker;
	}

	it("re-creates a missing worktree from the issue branch, including WIP commits already pushed to origin, before resuming (regression guard for the restore-ladder gap)", async () => {
		const { origin, clone } = makeOriginAndClone();
		const branchName = "RESTORE-1-restore-worktree-test-issue";
		const wipTip = pushWipOnlyToRemote(clone, branchName);
		const mainTip = execSync(`git -C ${origin} rev-parse main`)
			.toString()
			.trim();
		expect(wipTip).not.toBe(mainTip);

		const workspaceBaseDir = mkdtempSync(join(tmpdir(), "cyrus-resume-ws-"));
		const missingWorkspacePath = join(workspaceBaseDir, "RESTORE-1");
		// Simulates the state left behind by a destroyed-and-recreated
		// container: the session record survived (bundle restore), but the
		// worktree it points at is simply gone.
		expect(existsSync(missingWorkspacePath)).toBe(false);

		const mockRepository: RepositoryConfig = {
			id: "repo-1",
			name: "test-repo",
			repositoryPath: clone,
			workspaceBaseDir,
			baseBranch: "main",
			linearWorkspaceId: "test-workspace",
			isActive: true,
		} as RepositoryConfig;

		const issueFixture = makeIssueFixture({
			identifier: "RESTORE-1",
			branchName,
		});
		const edgeWorker = buildEdgeWorker(mockRepository, issueFixture);

		const session: any = {
			id: "agent-session-1",
			issueId: "issue-RESTORE-1",
			issueContext: {
				trackerId: "linear",
				issueId: "issue-RESTORE-1",
				issueIdentifier: "RESTORE-1",
			},
			issue: {
				id: "issue-RESTORE-1",
				identifier: "RESTORE-1",
				title: "Restore worktree test issue",
				branchName,
			},
			repositories: [
				{ repositoryId: "repo-1", branchName, baseBranchName: "main" },
			],
			workspace: { path: missingWorkspacePath, isGitWorktree: true },
			claudeSessionId: "prior-claude-session-abc",
		};

		await (edgeWorker as any).resumeAgentSession(
			session,
			mockRepository,
			"agent-session-1",
			mockAgentSessionManager,
			"please continue",
		);

		// The worktree exists for real now — not an empty mkdir placeholder.
		expect(existsSync(join(missingWorkspacePath, ".git"))).toBe(true);
		const headAfterResume = execSync(
			`git -C ${missingWorkspacePath} rev-parse HEAD`,
		)
			.toString()
			.trim();
		// The actual proof of continuity: HEAD is bit-identical to the WIP
		// commit pushed to origin (not main's tip, and not some other fresh
		// commit) — the WIP work survived the missing -> recreated round trip.
		expect(headAfterResume).toBe(wipTip);
		expect(headAfterResume).not.toBe(mainTip);

		// The runner was started against the recreated worktree, still
		// resuming the prior Claude session id (this is a resume, not a
		// re-prime).
		expect(capturedClaudeRunnerConfig).toBeDefined();
		expect(capturedClaudeRunnerConfig.workingDirectory).toBe(
			missingWorkspacePath,
		);
		expect(capturedClaudeRunnerConfig.resumeSessionId).toBe(
			"prior-claude-session-abc",
		);
		expect(mockClaudeRunner.startStreaming).toHaveBeenCalledOnce();

		// The session object was updated in place so downstream code (WIP
		// push, attachments dir, etc.) also sees the real, valid workspace.
		expect(session.workspace.path).toBe(missingWorkspacePath);
		expect(session.workspace.isGitWorktree).toBe(true);
	});

	it("does not touch an already-valid worktree (happy path unaffected)", async () => {
		const { clone } = makeOriginAndClone();
		const branchName = "RESTORE-2-existing-worktree";

		const workspaceBaseDir = mkdtempSync(join(tmpdir(), "cyrus-resume-ws-"));
		const workspacePath = join(workspaceBaseDir, "RESTORE-2");
		execSync(
			`git -C ${clone} worktree add ${workspacePath} -b ${branchName} main`,
		);
		const originalHead = execSync(`git -C ${workspacePath} rev-parse HEAD`)
			.toString()
			.trim();

		const mockRepository: RepositoryConfig = {
			id: "repo-1",
			name: "test-repo",
			repositoryPath: clone,
			workspaceBaseDir,
			baseBranch: "main",
			linearWorkspaceId: "test-workspace",
			isActive: true,
		} as RepositoryConfig;

		const issueFixture = makeIssueFixture({
			identifier: "RESTORE-2",
			branchName,
		});
		const edgeWorker = buildEdgeWorker(mockRepository, issueFixture);
		const createGitWorktreeSpy = vi.spyOn(
			(edgeWorker as any).gitService,
			"createGitWorktree",
		);

		const session: any = {
			id: "agent-session-2",
			issueId: "issue-RESTORE-2",
			issueContext: {
				trackerId: "linear",
				issueId: "issue-RESTORE-2",
				issueIdentifier: "RESTORE-2",
			},
			issue: {
				id: "issue-RESTORE-2",
				identifier: "RESTORE-2",
				title: "Existing worktree test issue",
				branchName,
			},
			repositories: [
				{ repositoryId: "repo-1", branchName, baseBranchName: "main" },
			],
			workspace: { path: workspacePath, isGitWorktree: true },
			claudeSessionId: "prior-claude-session-xyz",
		};

		await (edgeWorker as any).resumeAgentSession(
			session,
			mockRepository,
			"agent-session-2",
			mockAgentSessionManager,
			"please continue",
		);

		expect(createGitWorktreeSpy).not.toHaveBeenCalled();
		expect(capturedClaudeRunnerConfig.workingDirectory).toBe(workspacePath);
		const headAfterResume = execSync(`git -C ${workspacePath} rev-parse HEAD`)
			.toString()
			.trim();
		expect(headAfterResume).toBe(originalHead);
	});

	/**
	 * Regression guard for the base-branch-override drop: a session created
	 * with an explicit `[repo=name#branch]` description selector persists
	 * that resolution as `RepositoryContext.baseBranchName` +
	 * `baseBranchSource: "commit-ish"` (see `createCyrusAgentSession`). If
	 * the worktree is later destroyed and recreated on resume, it must be
	 * rebuilt from that same persisted override — NOT the repository's own
	 * default base branch — or the session silently continues on the wrong
	 * base.
	 */
	it("recreates a missing worktree from the session's persisted base-branch override, not the repo's default base branch", async () => {
		const { clone } = makeOriginAndClone();
		const branchName = "RESTORE-3-base-override-test-issue";

		// A release branch, diverged from `main`, marked by a file that only
		// exists there — proof of which branch the recreated worktree came from.
		execSync(`git -C ${clone} checkout -b release/2.0`);
		execSync(`echo release-marker > ${join(clone, "release-marker.txt")}`);
		execSync(`git -C ${clone} add release-marker.txt`);
		execSync(
			`git -C ${clone} -c user.email=t@t -c user.name=t commit -m "release 2.0 marker"`,
		);
		execSync(`git -C ${clone} push origin release/2.0`);
		execSync(`git -C ${clone} checkout main`);

		const workspaceBaseDir = mkdtempSync(join(tmpdir(), "cyrus-resume-ws-"));
		const missingWorkspacePath = join(workspaceBaseDir, "RESTORE-3");
		expect(existsSync(missingWorkspacePath)).toBe(false);

		const mockRepository: RepositoryConfig = {
			id: "repo-1",
			name: "test-repo",
			repositoryPath: clone,
			workspaceBaseDir,
			// The repo's own default base branch — deliberately NOT the branch
			// the session should recreate from, so the test fails if the
			// override is dropped and `determineBaseBranch` falls back to this.
			baseBranch: "main",
			linearWorkspaceId: "test-workspace",
			isActive: true,
		} as RepositoryConfig;

		const issueFixture = makeIssueFixture({
			identifier: "RESTORE-3",
			branchName,
		});
		const edgeWorker = buildEdgeWorker(mockRepository, issueFixture);

		const session: any = {
			id: "agent-session-3",
			issueId: "issue-RESTORE-3",
			issueContext: {
				trackerId: "linear",
				issueId: "issue-RESTORE-3",
				issueIdentifier: "RESTORE-3",
			},
			issue: {
				id: "issue-RESTORE-3",
				identifier: "RESTORE-3",
				title: "Base override test issue",
				branchName,
			},
			repositories: [
				// Persisted from the original `[repo=test-repo#release/2.0]`
				// selector — this is what `ensureSessionWorkspaceExists` must
				// reuse. `baseBranchSource: "commit-ish"` is what marks this as
				// a real override rather than an ordinary default/graphite/
				// parent-issue resolution.
				{
					repositoryId: "repo-1",
					branchName,
					baseBranchName: "release/2.0",
					baseBranchSource: "commit-ish",
				},
			],
			workspace: { path: missingWorkspacePath, isGitWorktree: true },
			claudeSessionId: "prior-claude-session-override",
		};

		await (edgeWorker as any).resumeAgentSession(
			session,
			mockRepository,
			"agent-session-3",
			mockAgentSessionManager,
			"please continue",
		);

		// The recreated worktree must be based on the session's persisted
		// override (release/2.0) — proven by the marker file only present on
		// that branch — not the repo's default base branch (main).
		expect(existsSync(join(missingWorkspacePath, "release-marker.txt"))).toBe(
			true,
		);
	});

	/**
	 * The commit-ish data-loss path. A session created with a
	 * `[repo=name#branch]` selector re-passes that override on EVERY workspace
	 * recreation, so while the override suppressed worktree continuity, a
	 * destroyed-and-recreated container silently rebranched from the override
	 * target and discarded everything already published on the issue branch.
	 * Published work must win.
	 */
	it("recovers published work for a repository with a commit-ish base instead of discarding it", async () => {
		const { clone } = makeOriginAndClone();
		const branchName = "RESTORE-4-commit-ish-recovery";

		// The override target, diverged from main.
		execSync(`git -C ${clone} checkout -b release/3.0`);
		execSync(`echo release > ${join(clone, "release-marker.txt")}`);
		execSync(`git -C ${clone} add release-marker.txt`);
		execSync(
			`git -C ${clone} -c user.email=t@t -c user.name=t commit -m "release 3.0 marker"`,
		);
		execSync(`git -C ${clone} push origin release/3.0`);
		execSync(`git -C ${clone} checkout main`);

		// Work the agent already published on the issue branch, from a
		// container that has since been destroyed.
		const publishedTip = pushWipOnlyToRemote(clone, branchName);

		const workspaceBaseDir = mkdtempSync(join(tmpdir(), "cyrus-resume-ws-"));
		const missingWorkspacePath = join(workspaceBaseDir, "RESTORE-4");

		const mockRepository: RepositoryConfig = {
			id: "repo-1",
			name: "test-repo",
			repositoryPath: clone,
			workspaceBaseDir,
			baseBranch: "main",
			linearWorkspaceId: "test-workspace",
			isActive: true,
		} as RepositoryConfig;

		const edgeWorker = buildEdgeWorker(
			mockRepository,
			makeIssueFixture({ identifier: "RESTORE-4", branchName }),
		);

		const session: any = {
			id: "agent-session-4",
			issueId: "issue-RESTORE-4",
			issueContext: {
				trackerId: "linear",
				issueId: "issue-RESTORE-4",
				issueIdentifier: "RESTORE-4",
			},
			issue: {
				id: "issue-RESTORE-4",
				identifier: "RESTORE-4",
				title: "Commit-ish recovery test issue",
				branchName,
			},
			repositories: [
				{
					repositoryId: "repo-1",
					branchName,
					baseBranchName: "release/3.0",
					baseBranchSource: "commit-ish",
				},
			],
			workspace: { path: missingWorkspacePath, isGitWorktree: true },
			claudeSessionId: "prior-claude-session-commit-ish",
		};

		await (edgeWorker as any).resumeAgentSession(
			session,
			mockRepository,
			"agent-session-4",
			mockAgentSessionManager,
			"please continue",
		);

		// HEAD is the published issue-branch commit, not the override target —
		// the work survived the missing -> recreated round trip.
		const headAfterResume = execSync(
			`git -C ${missingWorkspacePath} rev-parse HEAD`,
		)
			.toString()
			.trim();
		expect(headAfterResume).toBe(publishedTip);
		expect(existsSync(join(missingWorkspacePath, "wip.txt"))).toBe(true);
	});
});

/**
 * When a snapshot is applied AND the agent's transcript could not be resumed,
 * the agent wakes with no memory of work it appears to have done. Without a
 * word of explanation the likely failure mode is that it "tidies up" the
 * unexplained changes by reverting them — throwing away exactly what the
 * persistence floor just saved. A resuming agent needs no such explanation.
 */
describe("EdgeWorker - restored-work preamble", () => {
	function preambleFor(
		wipRestores: Record<string, "applied" | "stale"> | undefined,
		needsNewSession: boolean,
	): string {
		const worker = Object.create(EdgeWorker.prototype) as unknown as EdgeWorker;
		const session = {
			workspace: { path: "/tmp/ws", isGitWorktree: true, wipRestores },
		} as any;
		return (worker as any).withRestoredWorkPreamble(
			"ORIGINAL PROMPT",
			session,
			needsNewSession,
		);
	}

	it("explains restored work to an agent that could not resume its transcript", () => {
		const prompt = preambleFor({ "repo-1": "applied" }, true);
		expect(prompt).toContain("restored from a previous run");
		expect(prompt).toContain("rather than reverting them");
		expect(prompt.endsWith("ORIGINAL PROMPT")).toBe(true);
	});

	it("says nothing to an agent that did resume its transcript", () => {
		expect(preambleFor({ "repo-1": "applied" }, false)).toBe("ORIGINAL PROMPT");
	});

	it("says nothing when there was no snapshot to restore", () => {
		expect(preambleFor(undefined, true)).toBe("ORIGINAL PROMPT");
	});

	it("tells the agent when work was found but deliberately not applied", () => {
		const prompt = preambleFor({ "repo-1": "stale" }, true);
		expect(prompt).toContain("deliberately not restored");
		expect(prompt).toContain("ORIGINAL PROMPT");
	});

	it("only says it once — a later un-resumable turn is not re-explained", () => {
		const worker = Object.create(EdgeWorker.prototype) as unknown as EdgeWorker;
		const session = {
			workspace: {
				path: "/tmp/ws",
				isGitWorktree: true,
				wipRestores: { "repo-1": "applied" as const },
			},
		} as any;
		const first = (worker as any).withRestoredWorkPreamble("P", session, true);
		const second = (worker as any).withRestoredWorkPreamble("P", session, true);
		expect(first).not.toBe("P");
		expect(second).toBe("P");
	});
});
