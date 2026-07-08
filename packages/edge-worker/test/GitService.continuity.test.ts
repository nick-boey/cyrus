import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
