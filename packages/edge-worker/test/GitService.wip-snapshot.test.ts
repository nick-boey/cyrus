import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitService, wipSnapshotRef } from "../src/GitService.js";
import {
	commitAll,
	fileUrl,
	git,
	gitOut,
	makeOriginAndClone,
} from "./helpers/git-fixtures.js";

/**
 * The WIP snapshot is the persistence floor's git half. It must capture
 * everything the agent has not published — modifications, deletions, new
 * files, and commits made but never pushed — WITHOUT touching the issue
 * branch, `HEAD`, the index, or the working tree, and without any of it
 * being visible to an ordinary clone.
 *
 * Every assertion here is on observable git state (`rev-parse`,
 * `status --porcelain`, `ls-remote`, `cat-file`) against real repositories on
 * disk. Asserting on mocked `execSync` arguments would pass against a capture
 * that silently drops every untracked file — the exact failure mode this
 * design exists to avoid.
 */

const BRANCH = "ISS-1-do-the-thing";

function newService(): GitService {
	// Real ctor is (options?: GitServiceOptions, logger?: ILogger); console
	// satisfies the ILogger surface these tests exercise closely enough for a
	// `never`-cast in a test file.
	return new GitService(undefined, console as never);
}

/**
 * An origin plus a clone checked out on the issue branch, with a dirty
 * working tree: one modified tracked file, one deleted tracked file, one new
 * untracked file, and one `.gitignore`d file that must NOT be captured.
 */
function makeDirtyIssueWorkspace() {
	const { origin, clone } = makeOriginAndClone("cyrus-wip-snap-");
	writeFileSync(join(clone, ".gitignore"), "ignored.txt\nbuild/\n");
	writeFileSync(join(clone, "keep.txt"), "keep\n");
	writeFileSync(join(clone, "modify-me.txt"), "original\n");
	writeFileSync(join(clone, "delete-me.txt"), "doomed\n");
	commitAll(clone, "seed tracked files");
	git(clone, "push origin main");
	git(clone, `checkout -b ${BRANCH}`);

	writeFileSync(join(clone, "modify-me.txt"), "modified by the agent\n");
	rmSync(join(clone, "delete-me.txt"));
	writeFileSync(join(clone, "brand-new.txt"), "written by the agent\n");
	writeFileSync(join(clone, "ignored.txt"), "regenerable\n");
	mkdirSync(join(clone, "build"), { recursive: true });
	writeFileSync(join(clone, "build", "out.js"), "compiled\n");

	return { origin, clone };
}

/** A fresh clone of `origin` — stands in for a replacement container. */
function freshClone(origin: string, label: string): string {
	const dir = mkdtempSync(join(tmpdir(), `cyrus-wip-fresh-${label}-`));
	const path = join(dir, "clone");
	execFileSync("git", ["clone", fileUrl(origin), path]);
	return path;
}

describe("wipSnapshotRef", () => {
	it("keys the ref on the branch, under a namespace outside refs/heads", () => {
		expect(wipSnapshotRef(BRANCH)).toBe(`refs/cyrus-wip/${BRANCH}`);
	});
});

describe("GitService.captureWipSnapshot", () => {
	it("captures modifications, deletions and new files without touching HEAD, the index or the working tree", async () => {
		const { origin, clone } = makeDirtyIssueWorkspace();
		const headBefore = gitOut(clone, "rev-parse HEAD");
		const statusBefore = git(clone, "status --porcelain");
		const indexBefore = gitOut(clone, "write-tree");

		const result = await newService().captureWipSnapshot(clone, BRANCH);

		expect(result.status).toBe("captured");

		// The three things a capture must never disturb.
		expect(gitOut(clone, "rev-parse HEAD")).toBe(headBefore);
		expect(git(clone, "status --porcelain")).toBe(statusBefore);
		expect(gitOut(clone, "write-tree")).toBe(indexBefore);

		// The snapshot itself carries the agent's uncommitted state.
		const snapshot = gitOut(origin, `rev-parse ${wipSnapshotRef(BRANCH)}`);
		const files = git(origin, `ls-tree -r --name-only ${snapshot}`)
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.sort();
		expect(files).toContain("brand-new.txt");
		expect(files).toContain("modify-me.txt");
		expect(files).not.toContain("delete-me.txt");
		expect(gitOut(origin, `cat-file -p ${snapshot}:modify-me.txt`)).toBe(
			"modified by the agent",
		);
	});

	it("excludes .gitignore'd files", async () => {
		const { origin, clone } = makeDirtyIssueWorkspace();
		await newService().captureWipSnapshot(clone, BRANCH);

		const snapshot = gitOut(origin, `rev-parse ${wipSnapshotRef(BRANCH)}`);
		const files = git(origin, `ls-tree -r --name-only ${snapshot}`);
		expect(files).not.toContain("ignored.txt");
		expect(files).not.toContain("build/out.js");
	});

	it("never writes the issue branch", async () => {
		const { origin, clone } = makeDirtyIssueWorkspace();
		await newService().captureWipSnapshot(clone, BRANCH);

		// `ls-remote --heads` exits 0 with empty output when nothing matches,
		// so assert on the output rather than the exit code.
		const heads = git(origin, "ls-remote --heads .");
		expect(heads).not.toContain(BRANCH);
		expect(() =>
			git(origin, `rev-parse --verify refs/heads/${BRANCH}`),
		).toThrow();
	});

	it("stays invisible to an ordinary clone: neither the ref nor its objects are fetched", async () => {
		const { origin, clone } = makeDirtyIssueWorkspace();
		await newService().captureWipSnapshot(clone, BRANCH);
		const snapshot = gitOut(origin, `rev-parse ${wipSnapshotRef(BRANCH)}`);

		const contributor = freshClone(origin, "contributor");
		git(contributor, "fetch --all");

		expect(git(contributor, "branch -a")).not.toContain("cyrus-wip");
		expect(git(contributor, "log --all --oneline")).not.toContain("cyrus");
		expect(() =>
			git(contributor, `rev-parse --verify ${wipSnapshotRef(BRANCH)}`),
		).toThrow();
		// The objects themselves never came across either.
		expect(() => git(contributor, `cat-file -e ${snapshot}`)).toThrow();
	});

	it("succeeds on a second capture even though snapshots are siblings, not descendants", async () => {
		const { origin, clone } = makeDirtyIssueWorkspace();
		const service = newService();

		const first = await service.captureWipSnapshot(clone, BRANCH);
		expect(first.status).toBe("captured");
		const firstSnapshot = gitOut(origin, `rev-parse ${wipSnapshotRef(BRANCH)}`);

		writeFileSync(join(clone, "brand-new.txt"), "second pass\n");
		const second = await service.captureWipSnapshot(clone, BRANCH);
		expect(second.status).toBe("captured");
		const secondSnapshot = gitOut(
			origin,
			`rev-parse ${wipSnapshotRef(BRANCH)}`,
		);

		expect(secondSnapshot).not.toBe(firstSnapshot);
		// Proof the forced push was genuinely non-fast-forward: the two
		// snapshots share a parent rather than one descending from the other.
		expect(gitOut(origin, `rev-parse ${secondSnapshot}^`)).toBe(
			gitOut(origin, `rev-parse ${firstSnapshot}^`),
		);
	});

	it("skips the push when nothing has changed since the last snapshot", async () => {
		const { origin, clone } = makeDirtyIssueWorkspace();
		const service = newService();

		expect((await service.captureWipSnapshot(clone, BRANCH)).status).toBe(
			"captured",
		);
		const afterFirst = gitOut(origin, `rev-parse ${wipSnapshotRef(BRANCH)}`);

		const second = await service.captureWipSnapshot(clone, BRANCH);
		expect(second.status).toBe("unchanged");
		expect(gitOut(origin, `rev-parse ${wipSnapshotRef(BRANCH)}`)).toBe(
			afterFirst,
		);
	});

	/**
	 * A capture that failed to push must not be recorded as pushed.
	 *
	 * The no-op check reads a LOCAL ref describing the last snapshot that
	 * actually reached the remote, so that ref is only advanced after the push
	 * succeeds. Advance it first and a single network blip would convince every
	 * later tick that the remote was already up to date — stranding the work on
	 * this machine forever while reporting no error, which is exactly the class
	 * of silent loss the floor exists to prevent.
	 */
	it("retries on the next capture when a push failed, rather than believing the remote is up to date", async () => {
		const { origin, clone } = makeDirtyIssueWorkspace();
		const service = newService();

		// A bogus local path stands in for "remote unreachable" and fails fast
		// rather than hanging.
		const brokenUrl = join(tmpdir(), "cyrus-no-such-remote");
		git(clone, ["remote", "set-url", "origin", brokenUrl]);
		await expect(service.captureWipSnapshot(clone, BRANCH)).rejects.toThrow();

		git(clone, ["remote", "set-url", "origin", fileUrl(origin)]);

		// Nothing about the workspace changed in between, so a naive
		// "unchanged" check would skip this and lose the work.
		const retry = await service.captureWipSnapshot(clone, BRANCH);
		expect(retry.status).toBe("captured");
		expect(service.wipSnapshotExists(clone, BRANCH)).toBe(true);
	});

	it("captures again when the agent commits, because the snapshot's parent moved", async () => {
		const { origin, clone } = makeDirtyIssueWorkspace();
		const service = newService();
		await service.captureWipSnapshot(clone, BRANCH);
		const afterFirst = gitOut(origin, `rev-parse ${wipSnapshotRef(BRANCH)}`);

		commitAll(clone, "feat: a real commit with a real message");

		const second = await service.captureWipSnapshot(clone, BRANCH);
		expect(second.status).toBe("captured");
		expect(gitOut(origin, `rev-parse ${wipSnapshotRef(BRANCH)}`)).not.toBe(
			afterFirst,
		);
	});
});

describe("GitService.wipSnapshotExists", () => {
	it("is false for a ref that was never pushed, and true once one is", async () => {
		const { clone } = makeDirtyIssueWorkspace();
		const service = newService();

		// `git ls-remote` exits 0 even when nothing matches; this check decides
		// whether an agent's work gets restored, so a false positive strands it.
		expect(service.wipSnapshotExists(clone, BRANCH)).toBe(false);

		await service.captureWipSnapshot(clone, BRANCH);

		expect(service.wipSnapshotExists(clone, BRANCH)).toBe(true);
		expect(service.wipSnapshotExists(clone, "never-touched-branch")).toBe(
			false,
		);
	});
});

describe("GitService.restoreWipSnapshot", () => {
	it("round-trips a dirty workspace through a fresh clone with byte-identical status", async () => {
		const { origin, clone } = makeDirtyIssueWorkspace();
		const statusBefore = git(clone, "status --porcelain");
		const headBefore = gitOut(clone, "rev-parse HEAD");
		await newService().captureWipSnapshot(clone, BRANCH);

		// The container dies; a replacement clones the repository afresh.
		const replacement = freshClone(origin, "restore");
		const result = await newService().restoreWipSnapshot(replacement, BRANCH);

		expect(result.status).toBe("applied");
		expect(git(replacement, "status --porcelain")).toBe(statusBefore);
		expect(gitOut(replacement, "rev-parse HEAD")).toBe(headBefore);
		expect(gitOut(replacement, "rev-parse --abbrev-ref HEAD")).toBe(BRANCH);

		// The content is really there, not just the status lines: the working
		// tree carries the agent's edits, while HEAD and the index are still
		// the un-edited parent — i.e. the work is genuinely *uncommitted*.
		expect(readFileSync(join(replacement, "modify-me.txt"), "utf-8")).toBe(
			"modified by the agent\n",
		);
		expect(readFileSync(join(replacement, "brand-new.txt"), "utf-8")).toBe(
			"written by the agent\n",
		);
		expect(existsSync(join(replacement, "delete-me.txt"))).toBe(false);
		expect(gitOut(replacement, "show :0:modify-me.txt")).toBe("original");
		expect(gitOut(replacement, "cat-file blob HEAD:modify-me.txt")).toBe(
			"original",
		);
		// `.gitignore`d output is regenerated, never transported.
		expect(existsSync(join(replacement, "ignored.txt"))).toBe(false);
	});

	it("restores a commit the agent made but never pushed, on top of which the WIP still sits", async () => {
		const { origin, clone } = makeDirtyIssueWorkspace();
		const unpushed = commitAll(clone, "feat: agent's own commit, never pushed");
		writeFileSync(join(clone, "still-dirty.txt"), "uncommitted again\n");
		const statusBefore = git(clone, "status --porcelain");
		await newService().captureWipSnapshot(clone, BRANCH);

		const replacement = freshClone(origin, "unpushed");
		const result = await newService().restoreWipSnapshot(replacement, BRANCH);

		expect(result.status).toBe("applied");
		// The agent's own commit — message and all — survived.
		expect(gitOut(replacement, "rev-parse HEAD")).toBe(unpushed);
		expect(gitOut(replacement, "log -1 --pretty=%s")).toBe(
			"feat: agent's own commit, never pushed",
		);
		// And the work that was still uncommitted on top of it is uncommitted again.
		expect(git(replacement, "status --porcelain")).toBe(statusBefore);
	});

	it("reports absent when there is no snapshot, leaving the workspace untouched", async () => {
		const { origin } = makeDirtyIssueWorkspace();
		const replacement = freshClone(origin, "absent");
		const statusBefore = git(replacement, "status --porcelain");

		const result = await newService().restoreWipSnapshot(replacement, BRANCH);

		expect(result.status).toBe("absent");
		expect(git(replacement, "status --porcelain")).toBe(statusBefore);
	});

	it("refuses to apply a snapshot whose parent does not descend from the remote issue branch", async () => {
		const { origin, clone } = makeDirtyIssueWorkspace();
		await newService().captureWipSnapshot(clone, BRANCH);

		// Someone else pushes reviewed work to the issue branch after the
		// snapshot was taken. Applying the snapshot writes its whole tree, so
		// it would revert that work.
		const other = freshClone(origin, "other-device");
		git(other, `checkout -b ${BRANCH}`);
		writeFileSync(join(other, "reviewed.txt"), "reviewed and merged\n");
		commitAll(other, "feat: reviewed work pushed from elsewhere");
		git(other, `push origin ${BRANCH}`);

		// A replacement container builds its workspace the ordinary way: the
		// issue branch exists on origin, so worktree continuity checks it out.
		const replacement = freshClone(origin, "stale");
		git(replacement, `checkout -B ${BRANCH} origin/${BRANCH}`);
		const result = await newService().restoreWipSnapshot(replacement, BRANCH);

		expect(result.status).toBe("stale");
		// The branch is left exactly as published — the reviewed commit is
		// still there and the tree is clean, because applying the snapshot
		// would have written its whole tree over the top.
		expect(gitOut(replacement, "rev-parse HEAD")).toBe(
			gitOut(replacement, `rev-parse origin/${BRANCH}`),
		);
		expect(git(replacement, "status --porcelain").trim()).toBe("");
		expect(existsSync(join(replacement, "reviewed.txt"))).toBe(true);
		// ...and the snapshot is left in place so it can be recovered by hand.
		expect(newService().wipSnapshotExists(replacement, BRANCH)).toBe(true);
	});
});

describe("GitService.deleteWipSnapshot", () => {
	it("removes the ref from the remote so it stops being advertised", async () => {
		const { origin, clone } = makeDirtyIssueWorkspace();
		const service = newService();
		await service.captureWipSnapshot(clone, BRANCH);
		expect(service.wipSnapshotExists(clone, BRANCH)).toBe(true);

		await service.deleteWipSnapshot(clone, BRANCH);

		expect(service.wipSnapshotExists(clone, BRANCH)).toBe(false);
		expect(git(origin, "for-each-ref --format=%(refname)")).not.toContain(
			"cyrus-wip",
		);
	});

	it("is a no-op when there is no snapshot to delete", async () => {
		const { clone } = makeDirtyIssueWorkspace();
		await expect(newService().deleteWipSnapshot(clone, BRANCH)).resolves.toBe(
			false,
		);
	});
});
