import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Issue, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { GitService } from "../src/GitService.js";

function makeOriginAndClone() {
	const dir = mkdtempSync(join(tmpdir(), "cyrus-git-"));
	const origin = join(dir, "origin.git");
	const clone = join(dir, "clone");
	execSync(`git init --bare ${origin} -b main`);
	execSync(`git clone ${origin} ${clone}`);
	execSync(
		`git -C ${clone} -c user.email=t@t -c user.name=t commit --allow-empty -m init`,
	);
	execSync(`git -C ${clone} push origin main`);
	return { origin, clone };
}

/**
 * Minimal but structurally-real Issue fixture for driving the actual
 * `createSingleRepoWorktree` (via the public `createGitWorktree` 1-repo path)
 * without mocking `node:child_process`. `determineBaseBranch` unconditionally
 * calls `issue.labels()` (for the Graphite check) and reads `issue.parent`, so
 * both must be real non-throwing stubs rather than left `undefined` — mirrors
 * the `makeIssue` fixture in `GitService.test.ts`.
 */
function makeIssue(overrides: {
	identifier: string;
	branchName: string;
	title?: string;
}): Issue {
	return {
		id: overrides.identifier,
		identifier: overrides.identifier,
		title: overrides.title ?? "Test issue",
		description: null,
		url: "",
		branchName: overrides.branchName,
		assigneeId: null,
		stateId: null,
		teamId: null,
		labelIds: [],
		priority: 0,
		createdAt: new Date(),
		updatedAt: new Date(),
		archivedAt: null,
		state: Promise.resolve(undefined),
		assignee: Promise.resolve(undefined),
		team: Promise.resolve(undefined),
		parent: Promise.resolve(undefined),
		project: Promise.resolve(undefined),
		labels: () => Promise.resolve({ nodes: [] }),
		comments: () => Promise.resolve({ nodes: [] }),
		attachments: () => Promise.resolve({ nodes: [] }),
		children: () => Promise.resolve({ nodes: [] }),
		inverseRelations: () => Promise.resolve({ nodes: [] }),
		update: () =>
			Promise.resolve({ success: true, issue: undefined, lastSyncId: 0 }),
	} as unknown as Issue;
}

/**
 * Checks out a new branch in `clone` from the current HEAD, adds a uniquely
 * identifiable commit, pushes it to origin, then returns to `main` and
 * deletes the local branch — so the branch exists ONLY on origin (matching
 * the real-world "pushed from another device" scenario `remoteBranchExists`
 * is meant to detect) while the clone used as `repository.repositoryPath`
 * still resolves `git rev-parse --verify <branchName>` to nothing locally.
 * Returns the pushed branch's tip commit SHA for direct HEAD comparison.
 */
function pushBranchOnlyToRemote(clone: string, branchName: string): string {
	execSync(`git -C ${clone} checkout -b ${branchName}`);
	execSync(`echo ${branchName} > ${join(clone, `${branchName}.marker`)}`);
	execSync(`git -C ${clone} add ${branchName}.marker`);
	execSync(
		`git -C ${clone} -c user.email=t@t -c user.name=t commit -m "wip on ${branchName}"`,
	);
	execSync(`git -C ${clone} push origin ${branchName}`);
	const tip = execSync(`git -C ${clone} rev-parse HEAD`).toString().trim();
	execSync(`git -C ${clone} checkout main`);
	execSync(`git -C ${clone} branch -D ${branchName}`);
	return tip;
}

function makeRepository(
	repositoryPath: string,
	workspaceBaseDir: string,
): RepositoryConfig {
	return {
		id: "repo-1",
		name: "test-repo",
		repositoryPath,
		workspaceBaseDir,
		baseBranch: "main",
	};
}

describe("worktree continuity", () => {
	it("remoteBranchExists is true only for pushed branches", () => {
		const { clone } = makeOriginAndClone();
		// Real ctor is (options?: GitServiceOptions, logger?: ILogger); console
		// satisfies the ILogger surface these tests exercise closely enough
		// for a `never`-cast in a test file.
		const svc = new GitService(undefined, console as never);
		expect(svc.remoteBranchExists(clone, "main")).toBe(true);
		expect(svc.remoteBranchExists(clone, "nope-branch")).toBe(false);
	});

	it("pushWipIfDirty commits and pushes dirty state to the branch", async () => {
		const { origin, clone } = makeOriginAndClone();
		execSync(`git -C ${clone} checkout -b ISS-1`);
		execSync(`echo wip > ${join(clone, "file.txt")}`);
		const svc = new GitService(undefined, console as never);
		expect(await svc.pushWipIfDirty(clone, "ISS-1")).toBe(true);
		const remoteBranches = execSync(`git -C ${origin} branch`).toString();
		expect(remoteBranches).toContain("ISS-1");
	});

	it("pushWipIfDirty is a no-op on a clean tree", async () => {
		const { clone } = makeOriginAndClone();
		const svc = new GitService(undefined, console as never);
		expect(await svc.pushWipIfDirty(clone, "main")).toBe(false);
	});
});

describe("worktree continuity — createSingleRepoWorktree wiring", () => {
	// These tests drive the REAL createSingleRepoWorktree (through the public
	// createGitWorktree 1-repo delegation path) against a real temp git repo —
	// no execSync mocking — so the start-point preference at GitService.ts's
	// "if (createBranch)" block (continuity vs. override vs. default base
	// branch) is exercised end-to-end rather than just its two helper methods
	// in isolation.

	it("bases the worktree on origin/<branchName> when the issue branch already exists on remote and no baseBranchOverride is given (continuity active)", async () => {
		const { origin, clone } = makeOriginAndClone();
		const branchName = "wt-cont-active";
		const issueBranchTip = pushBranchOnlyToRemote(clone, branchName);
		const mainTip = execSync(`git -C ${origin} rev-parse main`)
			.toString()
			.trim();
		// Sanity: the pushed issue-branch commit must differ from main's tip,
		// otherwise a HEAD match below wouldn't distinguish continuity from
		// "just checked out main".
		expect(issueBranchTip).not.toBe(mainTip);

		const workspaceBaseDir = mkdtempSync(join(tmpdir(), "cyrus-wt-"));
		const repository = makeRepository(clone, workspaceBaseDir);
		const issue = makeIssue({ identifier: "CONT-A", branchName });
		const svc = new GitService(undefined, console as never);

		const result = await svc.createGitWorktree(issue, [repository]);

		expect(result.isGitWorktree).toBe(true);
		const worktreeHead = execSync(`git -C ${result.path} rev-parse HEAD`)
			.toString()
			.trim();
		// The real proof the checkout came from origin/<branchName>: the
		// worktree's HEAD is bit-identical to the commit we pushed on that
		// branch (and NOT to main's tip), and its configured upstream is
		// literally `origin/<branchName>` (set via `--track` in the continuity
		// code path).
		expect(worktreeHead).toBe(issueBranchTip);
		expect(worktreeHead).not.toBe(mainTip);
		const upstream = execSync(
			`git -C ${result.path} rev-parse --abbrev-ref --symbolic-full-name @{u}`,
		)
			.toString()
			.trim();
		expect(upstream).toBe(`origin/${branchName}`);
	});

	it("uses the explicit baseBranchOverride instead of the pushed issue branch (override wins)", async () => {
		const { origin, clone } = makeOriginAndClone();
		const branchName = "wt-cont-override";
		const issueBranchTip = pushBranchOnlyToRemote(clone, branchName);
		const overrideBranch = "override-target";
		const overrideTip = pushBranchOnlyToRemote(clone, overrideBranch);
		const mainTip = execSync(`git -C ${origin} rev-parse main`)
			.toString()
			.trim();
		expect(overrideTip).not.toBe(issueBranchTip);
		expect(overrideTip).not.toBe(mainTip);

		const workspaceBaseDir = mkdtempSync(join(tmpdir(), "cyrus-wt-"));
		const repository = makeRepository(clone, workspaceBaseDir);
		const issue = makeIssue({ identifier: "CONT-B", branchName });
		const svc = new GitService(undefined, console as never);

		const result = await svc.createGitWorktree(issue, [repository], {
			baseBranchOverrides: new Map([[repository.id, overrideBranch]]),
		});

		expect(result.isGitWorktree).toBe(true);
		const worktreeHead = execSync(`git -C ${result.path} rev-parse HEAD`)
			.toString()
			.trim();
		// Proves the override suppressed the continuity preference: HEAD
		// matches the override target's tip, not the (also-pushed) issue
		// branch's tip.
		expect(worktreeHead).toBe(overrideTip);
		expect(worktreeHead).not.toBe(issueBranchTip);
	});

	it("falls back to the repository's default base branch when the issue branch does not exist on remote", async () => {
		const { origin, clone } = makeOriginAndClone();
		const branchName = "wt-cont-none"; // deliberately never pushed anywhere
		const mainTip = execSync(`git -C ${origin} rev-parse main`)
			.toString()
			.trim();

		const workspaceBaseDir = mkdtempSync(join(tmpdir(), "cyrus-wt-"));
		const repository = makeRepository(clone, workspaceBaseDir);
		const issue = makeIssue({ identifier: "CONT-C", branchName });
		const svc = new GitService(undefined, console as never);

		expect(svc.remoteBranchExists(clone, branchName)).toBe(false);

		const result = await svc.createGitWorktree(issue, [repository]);

		expect(result.isGitWorktree).toBe(true);
		const worktreeHead = execSync(`git -C ${result.path} rev-parse HEAD`)
			.toString()
			.trim();
		// Unchanged pre-continuity behavior: falls back to the resolved base
		// branch (repository.baseBranch = "main"), tracking origin/main.
		expect(worktreeHead).toBe(mainTip);
		const upstream = execSync(
			`git -C ${result.path} rev-parse --abbrev-ref --symbolic-full-name @{u}`,
		)
			.toString()
			.trim();
		expect(upstream).toBe("origin/main");
	});
});
