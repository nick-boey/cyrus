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
 * Outcome of a single sync attempt. Kept internal to {@link doSyncIssue} /
 * {@link WorkspaceSyncService.syncIssue} — the public `syncIssue` API stays a
 * plain `Promise<boolean>` (existing callers, including `EdgeWorker`, only
 * ever need "did this succeed").
 */
interface SyncOutcome {
	/** Whether the sync (git push(es) + bundle upload) completed successfully. */
	ok: boolean;
	/**
	 * True when every workspace path this issue's sessions point at has been
	 * confirmed absent from disk (the worktree was torn down through some
	 * path other than {@link WorkspaceSyncService.syncIssueOnTermination} —
	 * e.g. the session's process crashed/OOM'd/was killed without ever
	 * reaching its termination hook, or cleanup ran through a different
	 * code path entirely). Retrying can only ever hit ENOENT forever, so
	 * this unconditionally drops the issue from the touched set regardless
	 * of `ok` or of any (necessarily stale) "live session" bookkeeping.
	 */
	workspaceGone: boolean;
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
 * ## Touched-set lifecycle
 *
 * An issue stays in the touched set for as long as it has activity to
 * protect — not just after a session ends. `touch(issueKey, sessionId)` is
 * called both when a session *starts* (EdgeWorker hooks this at session
 * creation/resume) and at session end (defensively, via
 * {@link syncIssueOnTermination}), so the periodic timer keeps re-syncing a
 * long-running session on every tick while it's active.
 *
 * Protection is tracked per **session**, not just per issue, via
 * `liveSessionsByIssue: Map<issueKey, Set<sessionId>>` — a simple refcount.
 * Two sessions can run concurrently on one issue (e.g. a parent and a child
 * session); `touch()` adds the session id to the issue's live set, and
 * {@link syncIssueOnTermination} removes it. An issue is only a *candidate*
 * for removal from the touched set once its live-session set is empty — a
 * successful terminal sync for session A must not un-protect an issue that
 * session B is still actively working on.
 *
 * Once an issue has no live sessions, removal itself converges through
 * {@link syncIssue}: every successful sync (whether triggered by
 * {@link syncIssueOnTermination} or by the ordinary periodic
 * {@link flushTouched} tick) removes the issue from the touched set when its
 * live-session set is empty. This means a terminal sync that fails (e.g. a
 * router blip) is NOT stuck forever — the very next periodic tick retries
 * the same issue (it's still in the touched set) and, on success, completes
 * the removal. Without this, a session that ends abnormally (crash, OOM,
 * `kill -9`) without ever reaching {@link syncIssueOnTermination} — or whose
 * terminal sync simply fails — would stay touched, WIP-pushed, and
 * re-bundled every tick for the life of the process.
 *
 * Separately, if an issue's workspace has been removed from disk entirely
 * (torn down through some path that never told this service), retrying is
 * pointless (every attempt would just hit ENOENT). `doSyncIssue` detects
 * this and {@link syncIssue} drops the issue from the touched set
 * unconditionally in that case — see {@link SyncOutcome.workspaceGone}.
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
	/** Refcount of live sessions per issue — see the class doc's "Touched-set lifecycle" section. */
	private readonly liveSessionsByIssue = new Map<string, Set<string>>();
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
	 * Marks an issue as having activity that needs protecting, and registers
	 * `sessionId` as a live session on it (the refcount described in the
	 * class doc). Call this when a session starts (so a still-running
	 * session is covered by the next periodic tick); {@link syncIssueOnTermination}
	 * removes the session id again at session end. It will be flushed on the
	 * next interval tick or shutdown; the issue itself is only removed from
	 * the touched set once its live-session set is empty AND a sync
	 * succeeds (see {@link syncIssue}).
	 */
	touch(issueKey: string, sessionId: string): void {
		this.touchedIssues.add(issueKey);
		let sessions = this.liveSessionsByIssue.get(issueKey);
		if (!sessions) {
			sessions = new Set<string>();
			this.liveSessionsByIssue.set(issueKey, sessions);
		}
		sessions.add(sessionId);
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
	 * Syncs every currently-touched issue. Removal from the touched set is
	 * handled inside {@link syncIssue} itself (via the live-session refcount
	 * and the workspace-gone check), so a periodic tick converges exactly
	 * like a terminal one: an issue whose live-session set is already empty
	 * (e.g. a prior terminal sync failed, or the session crashed without
	 * ever calling {@link syncIssueOnTermination}) gets dropped here too, as
	 * soon as a sync for it actually succeeds — see the class doc's
	 * "Touched-set lifecycle" section.
	 */
	private async flushTouched(): Promise<void> {
		const issueKeys = [...this.touchedIssues];
		await Promise.all(issueKeys.map((issueKey) => this.syncIssue(issueKey)));
	}

	/**
	 * Terminal-time sync: call this once the session `sessionId` on
	 * `issueKey` has ended. Ensures the issue is touched (defensive — covers
	 * any session-end path that isn't paired with an earlier session-start
	 * `touch()`), removes `sessionId` from the issue's live-session set (this
	 * session is no longer live, regardless of what the sync below finds),
	 * then syncs. Whether the issue actually leaves the touched set is
	 * decided by {@link syncIssue} — it does so only when this was the last
	 * live session on the issue AND the sync succeeded. A failed terminal
	 * sync, or one where another session on the same issue is still live,
	 * leaves the issue touched so a later periodic tick retries/re-evaluates
	 * it instead of silently dropping protection forever.
	 */
	async syncIssueOnTermination(
		issueKey: string,
		sessionId: string,
	): Promise<void> {
		this.touchedIssues.add(issueKey);
		this.liveSessionsByIssue.get(issueKey)?.delete(sessionId);
		await this.syncIssue(issueKey);
	}

	/**
	 * WIP-push + bundle + upload for one issue. Serialized per issue; never
	 * throws. Resolves `true` on success, `false` on failure (the failure is
	 * already logged).
	 *
	 * Also owns touched-set convergence (see the class doc): after a sync
	 * completes, this removes `issueKey` from the touched set when either
	 * (a) its workspace has been confirmed gone from disk (unconditional —
	 * retrying is pointless), or (b) the sync succeeded AND the issue has no
	 * live sessions left. Both `flushTouched` (periodic) and
	 * `syncIssueOnTermination` go through this, so either path can complete
	 * the removal.
	 */
	syncIssue(issueKey: string): Promise<boolean> {
		const existing = this.inFlight.get(issueKey);
		if (existing) return existing;
		const promise = this.doSyncIssue(issueKey)
			.then(({ ok, workspaceGone }) => {
				if (workspaceGone) {
					this.touchedIssues.delete(issueKey);
					this.liveSessionsByIssue.delete(issueKey);
				} else if (ok) {
					const liveSessions = this.liveSessionsByIssue.get(issueKey);
					if (!liveSessions || liveSessions.size === 0) {
						this.touchedIssues.delete(issueKey);
						this.liveSessionsByIssue.delete(issueKey);
					}
				}
				return ok;
			})
			.finally(() => {
				this.inFlight.delete(issueKey);
			});
		this.inFlight.set(issueKey, promise);
		return promise;
	}

	private async doSyncIssue(issueKey: string): Promise<SyncOutcome> {
		try {
			const state = await this.readState();
			if (!state) {
				// The state file may not exist yet — e.g. a terminal sync racing
				// EdgeWorker's very first `savePersistedState()` call. This is
				// "nothing synced", NOT success: returning `ok: true` here would
				// tell `syncIssue` it's safe to stop protecting an issue whose
				// work was never actually captured anywhere.
				return { ok: false, workspaceGone: false };
			}

			const sessions = sessionsForIssue(state, issueKey);
			const workspacePaths = [
				...new Set(
					sessions
						.map((session) => session.workspace?.path)
						.filter((p): p is string => Boolean(p)),
				),
			];

			let missingWorkspaces = 0;
			for (const workspacePath of workspacePaths) {
				if (!existsSync(workspacePath)) {
					// The worktree was torn down through some path other than
					// syncIssueOnTermination (issue reached a terminal state via a
					// different code path, or the session died without ever
					// reaching its termination hook). Pushing WIP here would just
					// hit ENOENT — and would keep hitting it every tick forever —
					// so skip it. `workspaceGone` below drops the issue from the
					// touched set entirely once every workspace path is confirmed
					// missing, so this is a one-time skip, not a recurring one.
					missingWorkspaces++;
					this.logger.info(
						`WorkspaceSyncService: workspace ${workspacePath} for issue ${issueKey} no longer exists on disk; skipping WIP push for it`,
					);
					continue;
				}
				const session = sessions.find(
					(s) => s.workspace?.path === workspacePath,
				);
				if (!session) continue;
				const branch = this.gitService.deriveWorktreeBranchName(session.issue);
				await this.pushWipForWorkspace(workspacePath, branch, issueKey);
			}
			const workspaceGone =
				workspacePaths.length > 0 &&
				missingWorkspaces === workspacePaths.length;

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
			return { ok: true, workspaceGone };
		} catch (error) {
			this.logger.warn(
				`WorkspaceSyncService: sync failed for issue ${issueKey}: ${String(error)}`,
			);
			return { ok: false, workspaceGone: false };
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
