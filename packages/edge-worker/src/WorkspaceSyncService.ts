import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
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
	private readonly touchedIssues = new Set<string>();
	private readonly inFlight = new Map<string, Promise<void>>();
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
	}

	/** Marks an issue as having activity; it will be flushed on the next interval tick. */
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

	/** Stops the timer and flushes every touched issue (used on shutdown/SIGTERM). */
	async stop(): Promise<void> {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
		await this.flushTouched();
	}

	private async flushTouched(): Promise<void> {
		const issueKeys = [...this.touchedIssues];
		this.touchedIssues.clear();
		await Promise.all(issueKeys.map((issueKey) => this.syncIssue(issueKey)));
	}

	/** WIP-push + bundle + upload for one issue. Serialized per issue; never throws. */
	syncIssue(issueKey: string): Promise<void> {
		const existing = this.inFlight.get(issueKey);
		if (existing) return existing;
		const promise = this.doSyncIssue(issueKey).finally(() => {
			this.inFlight.delete(issueKey);
		});
		this.inFlight.set(issueKey, promise);
		return promise;
	}

	private async doSyncIssue(issueKey: string): Promise<void> {
		try {
			const state = await this.readState();
			if (!state) return;

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
			}
		} catch (error) {
			this.logger.warn(
				`WorkspaceSyncService: sync failed for issue ${issueKey}: ${(error as Error).message}`,
			);
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
				`WorkspaceSyncService: could not list workspace ${workspacePath} for issue ${issueKey}: ${(error as Error).message}`,
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
				`WorkspaceSyncService: WIP push failed for issue ${issueKey} at ${repoPath}: ${(error as Error).message}`,
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
				`WorkspaceSyncService: failed to read state file ${stateFile}: ${(error as Error).message}`,
			);
			return null;
		}
	}
}
