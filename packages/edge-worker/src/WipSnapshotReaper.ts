import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

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
		try {
			await this.deleteSnapshot(repoPath, branch);
			this.forget(repoPath, branch);
		} catch (error) {
			this.logger.warn(
				`WipSnapshotReaper: could not delete the WIP snapshot for ${branch} in ${repoPath} (${String(error)}); it will be retried`,
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
			// `repoPath` is a checkout that terminal teardown may since have
			// removed; without it there is no remote to talk to, and no way to
			// ever delete the ref, so stop carrying the entry.
			if (!existsSync(entry.repoPath)) {
				this.logger.warn(
					`WipSnapshotReaper: giving up on ${entry.branch} — ${entry.repoPath} no longer exists, so the ref must be removed by hand`,
				);
				this.forget(entry.repoPath, entry.branch);
				continue;
			}
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
