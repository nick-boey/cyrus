import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
// Pure ref-name helper only — the reaper stays decoupled from GitService
// itself, which it reaches through the injected `deleteSnapshot` callback.
import { wipSnapshotRef } from "./GitService.js";

/** One `refs/cyrus-wip/<branch>` that still needs deleting from a remote. */
interface PendingDeletion {
	/** A checkout of the repository whose `origin` carries the ref. */
	repoPath: string;
	branch: string;
	recordedMs: number;
}

export interface WipSnapshotReaperOptions {
	/** Durable list of deletions still owed, normally under `cyrusHome`. */
	stateFile: string;
	/** Deletes one snapshot ref. Rejects if the remote could not be reached. */
	deleteSnapshot: (repoPath: string, branch: string) => Promise<unknown>;
	logger: { info(msg: string): void; warn(msg: string): void };
	now?: () => number;
}

/**
 * Deletes WIP snapshot refs at terminal teardown, and sweeps up the ones whose
 * deletion failed.
 *
 * Refs are advertised on every clone and fetch, repository-wide, and count
 * toward the repository's size limit — so unlike the floor bundle, they are
 * pruned when an issue ends rather than retained. But deletion is a network
 * call, and a network call can fail: without a sweep, one unreachable remote
 * at the wrong moment leaks a ref into a contributor's repository permanently,
 * with nothing left afterwards that knows it should be gone (the issue is
 * closed, the worktree deleted, the session removed).
 *
 * So a failed deletion is recorded on disk and retried on the next sweep —
 * every subsequent terminal teardown, and once at start-up. Deleting a ref
 * that is already gone is a no-op, so replaying an entry that actually
 * succeeded costs nothing.
 *
 * Deliberately not a heuristic sweep over the whole `refs/cyrus-wip/*`
 * namespace: a snapshot whose issue branch has never been pushed is
 * indistinguishable from an orphan by looking at the remote alone, and
 * deleting one would destroy the only copy of another device's uncommitted
 * work. Only refs this process knows it was told to delete are ever removed.
 */
export class WipSnapshotReaper {
	private readonly stateFile: string;
	private readonly deleteSnapshot: WipSnapshotReaperOptions["deleteSnapshot"];
	private readonly logger: WipSnapshotReaperOptions["logger"];
	private readonly now: () => number;

	constructor(opts: WipSnapshotReaperOptions) {
		this.stateFile = opts.stateFile;
		this.deleteSnapshot = opts.deleteSnapshot;
		this.logger = opts.logger;
		this.now = opts.now ?? Date.now;
	}

	/**
	 * Delete `branch`'s snapshot from `repoPath`'s origin, recording it for a
	 * later sweep if the remote could not be reached. Never throws: a failed
	 * deletion must not block the rest of terminal cleanup.
	 */
	async reap(repoPath: string, branch: string): Promise<void> {
		// Checked before spawning, not after failing. `deleteSnapshot` shells out
		// to git with `repoPath` as its `cwd`, and Node reports a missing `cwd`
		// as `spawn git ENOENT` — indistinguishable from git not being installed,
		// which is what the first investigation of NOR-411 concluded. There is
		// also nothing to retry: without a checkout there is no remote to reach,
		// and `sweep()` would drop the entry on sight anyway.
		if (!existsSync(repoPath)) {
			this.logger.warn(
				`WipSnapshotReaper: giving up on ${branch} — the checkout at ${repoPath} does not exist, so there is no remote to delete the ref from and it must be removed by hand`,
			);
			this.forget(repoPath, branch);
			return;
		}
		try {
			await this.deleteSnapshot(repoPath, branch);
			this.forget(repoPath, branch);
		} catch (error) {
			// "It will be retried" was an overpromise. The retry needs a later
			// `sweep()` in a process that can still read this state file, and in a
			// container sandbox there is no such process: the file lives under
			// `cyrusHome` inside the per-issue sandbox, and a failure here happens
			// during the teardown that destroys it. Say what is actually recorded
			// and name the manual remedy, so a log line that outlives the container
			// is enough to act on.
			this.logger.warn(
				`WipSnapshotReaper: could not delete the WIP snapshot for ${branch} in ${repoPath} (${String(error)}); recorded for retry on the next sweep. If this checkout does not outlive the current teardown — it does not in a container sandbox — remove the ref by hand with \`git push origin --delete ${wipSnapshotRef(branch)}\``,
			);
			this.record(repoPath, branch);
		}
	}

	/** Retry every deletion still owed. Never throws. */
	async sweep(): Promise<void> {
		const pending = this.read();
		if (pending.length === 0) return;
		this.logger.info(
			`WipSnapshotReaper: retrying ${pending.length} leaked WIP snapshot ref(s)`,
		);
		for (const entry of pending) {
			// `reap` drops an entry whose checkout has since been removed — there
			// is no remote to talk to without one, so no way to ever delete the
			// ref, so no reason to keep carrying the entry.
			await this.reap(entry.repoPath, entry.branch);
		}
	}

	private record(repoPath: string, branch: string): void {
		const pending = this.read();
		if (pending.some((e) => e.repoPath === repoPath && e.branch === branch)) {
			return;
		}
		pending.push({ repoPath, branch, recordedMs: this.now() });
		this.write(pending);
	}

	private forget(repoPath: string, branch: string): void {
		const pending = this.read();
		const remaining = pending.filter(
			(e) => e.repoPath !== repoPath || e.branch !== branch,
		);
		if (remaining.length !== pending.length) this.write(remaining);
	}

	private read(): PendingDeletion[] {
		if (!existsSync(this.stateFile)) return [];
		try {
			const parsed = JSON.parse(readFileSync(this.stateFile, "utf-8"));
			return Array.isArray(parsed) ? (parsed as PendingDeletion[]) : [];
		} catch (error) {
			this.logger.warn(
				`WipSnapshotReaper: could not read ${this.stateFile}: ${String(error)}`,
			);
			return [];
		}
	}

	private write(pending: PendingDeletion[]): void {
		try {
			mkdirSync(dirname(this.stateFile), { recursive: true });
			writeFileSync(this.stateFile, JSON.stringify(pending, null, 2));
		} catch (error) {
			this.logger.warn(
				`WipSnapshotReaper: could not write ${this.stateFile}: ${String(error)}`,
			);
		}
	}
}
