import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WipSnapshotReaper } from "../src/WipSnapshotReaper.js";

function makeReaper(
	deleteSnapshot: (repoPath: string, branch: string) => Promise<unknown>,
) {
	// The state file lives under `cyrusHome`, deliberately NOT inside the
	// repository — terminal teardown removes the worktree, and an entry that
	// vanished with it could never be retried.
	const home = mkdtempSync(join(tmpdir(), "cyrus-reaper-home-"));
	const dir = mkdtempSync(join(tmpdir(), "cyrus-reaper-repo-"));
	const stateFile = join(home, "state", "wip-snapshot-deletions.json");
	const logger = { info: vi.fn(), warn: vi.fn() };
	const reaper = new WipSnapshotReaper({
		stateFile,
		deleteSnapshot,
		logger,
		now: () => 1_000,
	});
	return { reaper, dir, stateFile, logger };
}

describe("WipSnapshotReaper", () => {
	it("deletes the ref and records nothing when the remote is reachable", async () => {
		const deleteSnapshot = vi.fn(async () => true);
		const { reaper, dir, stateFile } = makeReaper(deleteSnapshot);

		await reaper.reap(dir, "ISS-1");

		expect(deleteSnapshot).toHaveBeenCalledWith(dir, "ISS-1");
		expect(existsSync(stateFile)).toBe(false);
	});

	it("never throws when the remote is unreachable, so terminal cleanup continues", async () => {
		const { reaper, dir } = makeReaper(async () => {
			throw new Error("remote unreachable");
		});

		await expect(reaper.reap(dir, "ISS-1")).resolves.toBeUndefined();
	});

	/**
	 * The leak this class exists to prevent: once the issue is closed, the
	 * worktree deleted and the session removed, nothing else in the system
	 * remembers that this ref should be gone.
	 */
	it("retries a failed deletion on the next sweep, and stops once it succeeds", async () => {
		let failing = true;
		const deleteSnapshot = vi.fn(async () => {
			if (failing) throw new Error("remote unreachable");
			return true;
		});
		const { reaper, dir } = makeReaper(deleteSnapshot);

		await reaper.reap(dir, "ISS-1");
		expect(deleteSnapshot).toHaveBeenCalledTimes(1);

		// Still unreachable — the entry survives for another attempt.
		await reaper.sweep();
		expect(deleteSnapshot).toHaveBeenCalledTimes(2);

		failing = false;
		await reaper.sweep();
		expect(deleteSnapshot).toHaveBeenCalledTimes(3);

		// Now that it succeeded, later sweeps have nothing left to do.
		await reaper.sweep();
		expect(deleteSnapshot).toHaveBeenCalledTimes(3);
	});

	it("survives a process restart — the pending deletion is read back from disk", async () => {
		const home = mkdtempSync(join(tmpdir(), "cyrus-reaper-home-"));
		const dir = mkdtempSync(join(tmpdir(), "cyrus-reaper-repo-"));
		const stateFile = join(home, "state", "wip-snapshot-deletions.json");
		const logger = { info: vi.fn(), warn: vi.fn() };

		const firstRun = new WipSnapshotReaper({
			stateFile,
			deleteSnapshot: async () => {
				throw new Error("remote unreachable");
			},
			logger,
		});
		await firstRun.reap(dir, "ISS-1");

		const deleteSnapshot = vi.fn(async () => true);
		const secondRun = new WipSnapshotReaper({
			stateFile,
			deleteSnapshot,
			logger,
		});
		await secondRun.sweep();

		expect(deleteSnapshot).toHaveBeenCalledWith(dir, "ISS-1");
	});

	/**
	 * NOR-411: teardown handed the reaper a worktree path that had never
	 * existed, and `execFileAsync` reported the missing `cwd` as
	 * `spawn git ENOENT` — which reads as "git is not installed on this image",
	 * and is what the first investigation concluded. Check before spawning so
	 * the log names the real problem.
	 */
	it("names the missing checkout rather than letting git report ENOENT", async () => {
		const deleteSnapshot = vi.fn(async () => true);
		const { reaper, dir, logger, stateFile } = makeReaper(deleteSnapshot);
		rmSync(dir, { recursive: true, force: true });

		await reaper.reap(dir, "ISS-1");

		expect(deleteSnapshot).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining(`the checkout at ${dir} does not exist`),
		);
		// Nothing to retry without a checkout, so nothing is recorded either.
		expect(existsSync(stateFile)).toBe(false);
	});

	it("gives up on an entry whose repository is gone, rather than retrying it forever", async () => {
		const deleteSnapshot = vi.fn(async () => {
			throw new Error("remote unreachable");
		});
		const { reaper, dir, logger } = makeReaper(deleteSnapshot);
		await reaper.reap(dir, "ISS-1");

		// The checkout that provided the remote is removed by terminal
		// teardown; without it there is no way to ever delete the ref.
		rmSync(dir, { recursive: true, force: true });

		await reaper.sweep();
		expect(deleteSnapshot).toHaveBeenCalledTimes(1);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("by hand"),
		);
	});
});
