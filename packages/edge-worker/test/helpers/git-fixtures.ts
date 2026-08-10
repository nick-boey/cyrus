import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Real-git fixtures shared by every edge-worker suite that asserts on
 * observable git state rather than on the commands used to produce it
 * (`GitService.continuity`, `GitService.wip-snapshot`,
 * `EdgeWorker.resume-workspace-recreation`,
 * `RunnerConfigBuilder.stop-hook-guardrail`).
 *
 * These deliberately shell out to a real `git` against real temp
 * repositories — mocking `node:child_process` here would let a capture that
 * silently drops every untracked file pass, which is exactly the failure mode
 * the WIP-snapshot design exists to avoid.
 */

/**
 * Git for Windows ships `core.autocrlf=true`, which rewrites line endings on
 * checkout and would make "the restored working tree matches what the agent
 * left" assertions pass or fail depending on the developer's OS. Pin it off
 * for every git invocation in this worker — including the ones `GitService`
 * itself makes, which inherit `process.env`.
 */
process.env.GIT_CONFIG_COUNT = "1";
process.env.GIT_CONFIG_KEY_0 = "core.autocrlf";
process.env.GIT_CONFIG_VALUE_0 = "false";

/** Identity for fixture commits so tests never depend on the host's git config. */
const FIXTURE_IDENTITY = ["-c", "user.email=t@t", "-c", "user.name=t"];

/**
 * Splits a command string into argv, honouring double quotes. Deliberately
 * shell-free: `execSync` routes through `cmd.exe` on Windows, where `^` is the
 * escape character — so a shelled-out `git rev-parse <sha>^` silently loses
 * its caret and resolves to the commit itself rather than its parent.
 */
function tokenize(args: string): string[] {
	return [...args.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2] ?? "");
}

/** Runs `git <args>` in `cwd`, throwing on a non-zero exit. */
export function git(cwd: string, args: string | string[]): string {
	const argv = Array.isArray(args) ? args : tokenize(args);
	return execFileSync("git", argv, { cwd, encoding: "utf-8" });
}

/** Runs `git <args>` in `cwd`, returning trimmed stdout. */
export function gitOut(cwd: string, args: string | string[]): string {
	return git(cwd, args).trim();
}

/** A freshly-initialised bare repository, usable as an `origin`. */
export function makeBareRemote(prefix = "cyrus-git-remote-"): string {
	const remote = mkdtempSync(join(tmpdir(), prefix));
	execFileSync("git", ["init", "--bare"], { cwd: remote, stdio: "ignore" });
	return remote;
}

/**
 * A `file://` URL for `path`. Cloning a bare repo by plain filesystem path
 * hardlinks its whole object database into the clone, so objects that are NOT
 * reachable from any fetched ref still end up present — which would make
 * "an ordinary clone fetches none of Cyrus's internal objects" trivially and
 * wrongly fail. The `file://` transport goes through real pack negotiation.
 */
export function fileUrl(path: string): string {
	return pathToFileURL(path).href;
}

export interface OriginAndClone {
	/** The temp directory holding both, for cleanup. */
	dir: string;
	/** Bare repository standing in for `origin`. */
	origin: string;
	/** Working clone of `origin`, already on `main` with one commit pushed. */
	clone: string;
}

/**
 * A bare `origin` plus a working clone with a single empty commit already
 * pushed to `main` — the starting point for every worktree/continuity/
 * snapshot test.
 */
export function makeOriginAndClone(prefix = "cyrus-git-"): OriginAndClone {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	const origin = join(dir, "origin.git");
	const clone = join(dir, "clone");
	execFileSync("git", ["init", "--bare", origin, "-b", "main"]);
	execFileSync("git", ["clone", fileUrl(origin), clone]);
	git(clone, [...FIXTURE_IDENTITY, "commit", "--allow-empty", "-m", "init"]);
	git(clone, "push origin main");
	return { dir, origin, clone };
}

/**
 * Creates `branchName` in `clone`, commits a uniquely identifiable file on it,
 * pushes it to origin, then returns to `main` and deletes the local branch —
 * so the branch exists ONLY on origin (the real-world "pushed from another
 * device" scenario) while `git rev-parse --verify <branchName>` still resolves
 * to nothing locally. Returns the pushed branch's tip SHA.
 */
export function pushBranchOnlyToRemote(
	clone: string,
	branchName: string,
	fileName = `${branchName}.marker`,
): string {
	git(clone, `checkout -b ${branchName}`);
	writeFileSync(join(clone, fileName), `${branchName}\n`);
	git(clone, ["add", fileName]);
	git(clone, [...FIXTURE_IDENTITY, "commit", "-m", `work on ${branchName}`]);
	git(clone, `push origin ${branchName}`);
	const tip = gitOut(clone, "rev-parse HEAD");
	git(clone, "checkout main");
	git(clone, `branch -D ${branchName}`);
	return tip;
}

/** Commits everything currently in `repoPath` with the fixture identity. */
export function commitAll(repoPath: string, message: string): string {
	git(repoPath, "add -A");
	git(repoPath, [...FIXTURE_IDENTITY, "commit", "-m", message]);
	return gitOut(repoPath, "rev-parse HEAD");
}
