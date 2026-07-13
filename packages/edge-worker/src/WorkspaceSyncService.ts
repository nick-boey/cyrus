import { existsSync, readdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	IssueMinimal,
	SerializableEdgeWorkerState,
	SerializedCyrusAgentSession,
} from "cyrus-core";
import { buildBundle, toHttpBase, uploadBundle } from "cyrus-workspace-sync";
import type { GitService } from "./GitService.js";

const DEFAULT_INTERVAL_MS = 5 * 60_000;

/**
 * Upper bound on how long {@link WorkspaceSyncService.stop} will wait for the
 * final flush before giving up and letting shutdown proceed. Individual git
 * operations and the bundle upload each have their own timeouts (see
 * `GitService.pushWipIfDirty` and `cyrus-workspace-sync`'s `uploadBundle`) —
 * this is a second, outer cap so that even several touched issues fanned out
 * together can't collectively stall shutdown far beyond that. A best-effort
 * flush that gives up is strictly better than a shutdown that never
 * completes (SIGKILL lands mid-flush either way once the grace period
 * expires).
 */
const DEFAULT_STOP_FLUSH_TIMEOUT_MS = 20_000;

export interface WorkspaceSyncServiceOptions {
	cyrusHome: string;
	routerUrl: string;
	deviceToken: string;
	gitService: Pick<GitService, "pushWipIfDirty" | "deriveWorktreeBranchName">;
	logger: { info(msg: string): void; warn(msg: string): void };
	/** How often the periodic flush runs. Default 5 minutes. */
	intervalMs?: number;
	/** Test seam. Defaults to `~/.claude/projects`. */
	claudeProjectsDir?: string;
	/**
	 * Upper bound on how long `stop()` waits for the final flush. Default
	 * {@link DEFAULT_STOP_FLUSH_TIMEOUT_MS}.
	 */
	stopFlushTimeoutMs?: number;
}

function sessionsForIssue(
	state: SerializableEdgeWorkerState,
	issueKey: string,
): (SerializedCyrusAgentSession & { issue: IssueMinimal })[] {
	return Object.values(state.agentSessions ?? {}).filter(
		(
			session,
		): session is SerializedCyrusAgentSession & { issue: IssueMinimal } =>
			session.issue?.identifier === issueKey,
	);
}

/**
 * Client side of the persistence floor. A container running an agent
 * session can be destroyed at any time (idle-stop, crash, host loss, user
 * switching executors); this is what guarantees nothing is lost when that
 * happens. On session end, on shutdown, and on a timer, it:
 *
 *  1. Pushes any uncommitted worktree changes for the issue to its git
 *     branch as WIP commits ({@link GitService.pushWipIfDirty}).
 *  2. Bundles the Claude session transcripts + session metadata and
 *     uploads them to the router ({@link buildBundle} / {@link uploadBundle}).
 *
 * Runs on physical devices too, not just containers — that's what enables
 * device -> container migration.
 *
 * `syncIssue` never throws: it is invoked from a session-end listener and
 * from an unattended timer, so a failed git push or a router that is
 * briefly unreachable must never crash the edge worker or fail a user's
 * session. Concurrent calls for the same issue are coalesced through a
 * per-issue in-flight promise map.
 *
 * An issue stays in the touched set for as long as it has activity to
 * protect — not just after a session ends. `touch()` is called both when a
 * session *starts* (EdgeWorker hooks this at session creation/resume) and
 * at session end, so the periodic timer keeps re-syncing a long-running
 * session on every tick while it's active, not only after it finishes. The
 * set only shrinks via {@link syncIssueOnTermination}, called once a
 * session on the issue has actually ended — and only when that terminal
 * sync succeeds; a failure (e.g. a router blip) leaves the issue touched so
 * a later periodic tick retries it instead of silently dropping it forever.
 */
export class WorkspaceSyncService {
	private readonly cyrusHome: string;
	private readonly routerUrl: string;
	private readonly deviceToken: string;
	private readonly gitService: Pick<
		GitService,
		"pushWipIfDirty" | "deriveWorktreeBranchName"
	>;
	private readonly logger: { info(msg: string): void; warn(msg: string): void };
	private readonly intervalMs: number;
	private readonly claudeProjectsDir: string;
	private readonly stopFlushTimeoutMs: number;
	private readonly touchedIssues = new Set<string>();
	private readonly inFlight = new Map<string, Promise<boolean>>();
	private timer?: NodeJS.Timeout;

	constructor(opts: WorkspaceSyncServiceOptions) {
		this.cyrusHome = opts.cyrusHome;
		this.routerUrl = opts.routerUrl;
		this.deviceToken = opts.deviceToken;
		this.gitService = opts.gitService;
		this.logger = opts.logger;
		this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.claudeProjectsDir =
			opts.claudeProjectsDir ?? join(homedir(), ".claude", "projects");
		this.stopFlushTimeoutMs =
			opts.stopFlushTimeoutMs ?? DEFAULT_STOP_FLUSH_TIMEOUT_MS;
	}

	/**
	 * Marks an issue as having activity that needs protecting. Call this both
	 * when a session starts (so a still-running session is covered by the
	 * next periodic tick) and — defensively — at session end. It will be
	 * flushed on the next interval tick or shutdown; it is only removed by a
	 * successful {@link syncIssueOnTermination} call.
	 */
	touch(issueKey: string): void {
		this.touchedIssues.add(issueKey);
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			void this.flushTouched();
		}, this.intervalMs);
		this.timer.unref?.();
	}

	/**
	 * Stops the timer and flushes every touched issue (used on
	 * shutdown/SIGTERM). Bounded by `stopFlushTimeoutMs` — a best-effort
	 * flush that gives up is strictly better than a shutdown that never
	 * completes, so this never blocks teardown indefinitely even if a
	 * touched issue's sync (router unreachable, slow git push, etc.) is
	 * still in flight when the cap is hit.
	 */
	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		await Promise.race([this.flushTouched(), this.stopFlushTimeout()]);
	}

	private stopFlushTimeout(): Promise<void> {
		return new Promise((resolve) => {
			const t = setTimeout(resolve, this.stopFlushTimeoutMs);
			t.unref?.();
		});
	}

	/**
	 * Syncs every currently-touched issue. Does NOT remove issues from the
	 * touched set on success — that would stop protecting a still-running
	 * session after its first successful periodic sync. Only
	 * {@link syncIssueOnTermination} removes an issue, and only once its
	 * session has actually ended.
	 */
	private async flushTouched(): Promise<void> {
		const issueKeys = [...this.touchedIssues];
		await Promise.all(issueKeys.map((issueKey) => this.syncIssue(issueKey)));
	}

	/**
	 * Terminal-time sync: call this once a session on `issueKey` has ended.
	 * Ensures the issue is touched (defensive — covers any session-end path
	 * that isn't paired with an earlier session-start `touch()`), syncs it,
	 * and removes it from the touched set only when that sync succeeds. A
	 * failed terminal sync leaves the issue touched so a later periodic tick
	 * retries it instead of silently dropping protection forever.
	 */
	async syncIssueOnTermination(issueKey: string): Promise<void> {
		this.touch(issueKey);
		const success = await this.syncIssue(issueKey);
		if (success) {
			this.touchedIssues.delete(issueKey);
		}
	}

	/**
	 * WIP-push + bundle + upload for one issue. Serialized per issue; never
	 * throws. Resolves `true` on success, `false` on failure (the failure is
	 * already logged) — callers that need to react to failure (e.g.
	 * {@link syncIssueOnTermination}) can branch on the result; `flushTouched`
	 * ignores it.
	 */
	syncIssue(issueKey: string): Promise<boolean> {
		const existing = this.inFlight.get(issueKey);
		if (existing) return existing;
		const promise = this.doSyncIssue(issueKey).finally(() => {
			this.inFlight.delete(issueKey);
		});
		this.inFlight.set(issueKey, promise);
		return promise;
	}

	private async doSyncIssue(issueKey: string): Promise<boolean> {
		try {
			const state = await this.readState();
			if (!state) return true;

			const sessions = sessionsForIssue(state, issueKey);
			const workspacePaths = [
				...new Set(
					sessions
						.map((session) => session.workspace?.path)
						.filter((p): p is string => Boolean(p)),
				),
			];

			for (const workspacePath of workspacePaths) {
				const session = sessions.find(
					(s) => s.workspace?.path === workspacePath,
				);
				if (!session) continue;
				const branch = this.gitService.deriveWorktreeBranchName(session.issue);
				await this.pushWipForWorkspace(workspacePath, branch, issueKey);
			}

			const outFile = join(this.cyrusHome, "sync", `${issueKey}.tar.gz`);
			const wrote = await buildBundle({
				issueKey,
				state,
				claudeProjectsDir: this.claudeProjectsDir,
				outFile,
			});
			if (wrote) {
				await uploadBundle(
					toHttpBase(this.routerUrl),
					this.deviceToken,
					issueKey,
					outFile,
				);
				// Housekeeping: don't let uploaded bundles pile up on disk forever —
				// the router now holds the copy of record.
				await rm(outFile, { force: true });
			}

			this.logger.info(
				`WorkspaceSyncService: synced issue ${issueKey} (${workspacePaths.length} workspace(s)${wrote ? ", bundle uploaded" : ", no bundle (no matching sessions)"})`,
			);
			return true;
		} catch (error) {
			this.logger.warn(
				`WorkspaceSyncService: sync failed for issue ${issueKey}: ${String(error)}`,
			);
			return false;
		}
	}

	/**
	 * Pushes WIP for a single-repo workspace, or — when `workspacePath` isn't
	 * itself a git repo (the multi-repo layout root) — fans out to each
	 * immediate subdirectory that contains a `.git` entry. Errors are logged
	 * per-workspace and never propagate, so one bad repo can't block the
	 * others or abort the bundle upload.
	 */
	private async pushWipForWorkspace(
		workspacePath: string,
		branch: string,
		issueKey: string,
	): Promise<void> {
		if (existsSync(join(workspacePath, ".git"))) {
			await this.pushWipSafely(workspacePath, branch, issueKey);
			return;
		}

		let entries: string[];
		try {
			entries = readdirSync(workspacePath);
		} catch (error) {
			this.logger.warn(
				`WorkspaceSyncService: could not list workspace ${workspacePath} for issue ${issueKey}: ${String(error)}`,
			);
			return;
		}
		for (const entry of entries) {
			const subdir = join(workspacePath, entry);
			if (existsSync(join(subdir, ".git"))) {
				await this.pushWipSafely(subdir, branch, issueKey);
			}
		}
	}

	private async pushWipSafely(
		repoPath: string,
		branch: string,
		issueKey: string,
	): Promise<void> {
		try {
			await this.gitService.pushWipIfDirty(repoPath, branch);
		} catch (error) {
			this.logger.warn(
				`WorkspaceSyncService: WIP push failed for issue ${issueKey} at ${repoPath}: ${String(error)}`,
			);
		}
	}

	private async readState(): Promise<SerializableEdgeWorkerState | null> {
		const stateFile = join(this.cyrusHome, "state", "edge-worker-state.json");
		if (!existsSync(stateFile)) return null;
		try {
			const raw = await readFile(stateFile, "utf-8");
			const parsed = JSON.parse(raw) as { state?: SerializableEdgeWorkerState };
			return parsed.state ?? null;
		} catch (error) {
			this.logger.warn(
				`WorkspaceSyncService: failed to read state file ${stateFile}: ${String(error)}`,
			);
			return null;
		}
	}
}
