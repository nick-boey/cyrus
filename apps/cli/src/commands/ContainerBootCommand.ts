import { execFile, spawn } from "node:child_process";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { EdgeConfigSchema, RepositoryConfigSchema } from "cyrus-core";
import {
	downloadBundle as defaultDownloadBundle,
	restoreBundle as defaultRestoreBundle,
	RUNNER_ID_KEYS,
	sanitizeCwdForClaudeProjects,
	toHttpBase,
} from "cyrus-workspace-sync";
import { z } from "zod";
import type { ICommand } from "./ICommand.js";

/**
 * Env vars that MUST be present for `cyrus container-boot` to run at all.
 * Mirrors how `docker/router/entrypoint.mjs` validates its own required set:
 * missing ones are named explicitly in a single error before anything else
 * happens, rather than failing deep inside some later step.
 */
export const REQUIRED_ENV_VARS = [
	"CYRUS_ROUTER_URL",
	"CYRUS_DEVICE_TOKEN",
	"CYRUS_ISSUE_KEY",
	"CYRUS_REPOS_JSON",
	"CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export const DEFAULT_WORKSPACES_DIR = "/workspaces";
export const DEFAULT_REPO_CACHE_DIR = "/var/cache/repos";

/** Returns the names of any required env vars that are unset/empty. */
export function findMissingEnvVars(env: NodeJS.ProcessEnv): string[] {
	return REQUIRED_ENV_VARS.filter((key) => !env[key]);
}

/**
 * `CYRUS_ISSUE_KEY` crosses an env-var boundary here and is then interpolated
 * unencoded into filesystem paths and the artifact URL
 * (`${httpBase}/artifacts/issues/${issueKey}/bundle`). Mirrors the router's
 * own gate (`ISSUE_KEY_RE` in `packages/router/src/artifacts.ts` and
 * `ContainerTargets.ts`) so a malformed key is rejected here, at the one
 * place it enters the container, instead of failing deep inside a later
 * fetch with a 400 from the router.
 */
export const ISSUE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Validates `CYRUS_ISSUE_KEY` against {@link ISSUE_KEY_PATTERN}. */
export function isValidIssueKey(key: string): boolean {
	return ISSUE_KEY_PATTERN.test(key);
}

const RepoSpecSchema = z.object({
	name: z.string().min(1),
	githubSlug: z.string().min(1),
	linearWorkspaceId: z.string().min(1),
	baseBranch: z.string().optional(),
});
export type RepoSpec = z.infer<typeof RepoSpecSchema>;

const ReposJsonSchema = z.array(RepoSpecSchema);

/** Parses/validates `CYRUS_REPOS_JSON`. Throws a descriptive error on failure. */
export function parseReposJson(raw: string): RepoSpec[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`not valid JSON (${(error as Error).message})`);
	}
	const result = ReposJsonSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(
			`does not match the expected shape: ${result.error.message}`,
		);
	}
	return result.data;
}

export type ExecFn = (
	cmd: string,
	args: string[],
) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export const defaultExec: ExecFn = (cmd, args) =>
	new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ maxBuffer: 8 * 1024 * 1024 },
			(err, stdout, stderr) => {
				let stderrStr = stderr?.toString() ?? "";
				// A spawn-level failure (e.g. ENOENT when the binary itself is
				// missing from the image) never touches the child's stderr, so
				// `stderrStr` is empty and the caller's thrown error loses the
				// cause entirely. Fold the underlying error's own message in so
				// a broken image is diagnosable instead of producing e.g.
				// "git clone failed for repo1: " with nothing after the colon.
				if (err && !stderrStr) {
					stderrStr = err.message;
				}
				const exitCode = err
					? typeof (err as { code?: unknown }).code === "number"
						? ((err as { code: number }).code as number)
						: 1
					: 0;
				resolve({
					stdout: stdout?.toString() ?? "",
					stderr: stderrStr,
					exitCode,
				});
			},
		);
	});

/** Minimal shape of the object `spawn()` returns — enough for launch()'s needs. */
export interface SpawnedChild {
	on(
		event: "exit",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void,
	): void;
	kill(signal: NodeJS.Signals): void;
}

export type SpawnFn = (
	command: string,
	args: string[],
	options: { stdio: "inherit" },
) => SpawnedChild;

const defaultSpawn: SpawnFn = (command, args, options) =>
	spawn(command, args, options) as unknown as SpawnedChild;

export interface ContainerBootLogger {
	info(message: string): void;
	warn(message: string): void;
	error(message: string): void;
}

const defaultLogger: ContainerBootLogger = {
	info: (m) => console.log(`[container-boot] ${m}`),
	warn: (m) => console.warn(`[container-boot] ${m}`),
	error: (m) => console.error(`[container-boot] ${m}`),
};

export interface ContainerBootDeps {
	env?: NodeJS.ProcessEnv;
	exec?: ExecFn;
	spawnFn?: SpawnFn;
	/** Overrides `os.homedir()` — test seam for `~/.claude`, `~/.git-credentials`, `~/dotfiles`. */
	homeDir?: string;
	logger?: ContainerBootLogger;
	/** Overrides the script path re-spawned by `launch()` — defaults to `process.argv[1]`. */
	appPath?: string;
	downloadBundleFn?: typeof defaultDownloadBundle;
	restoreBundleFn?: typeof defaultRestoreBundle;
}

/**
 * `cyrus container-boot` — the entrypoint that runs *inside* an ephemeral
 * worker container (see `docker/worker/`). Driven entirely by environment
 * variables (no `--cyrus-home` flag; its home is `$CYRUS_WORKSPACES_DIR/.cyrus`).
 *
 * Runs the restore ladder — warm volume fast path, then restore-from-floor,
 * then fresh start — and finishes by launching the normal `cyrus start`
 * process. Every step is idempotent: a restarted container re-running this
 * command from scratch must not duplicate work or corrupt state.
 *
 * See the canonical-path note in `packages/workspace-sync/src/paths.ts`:
 * `$CYRUS_WORKSPACES_DIR/<ISSUE-KEY>` worktrees must be real directories
 * (never symlinks) because the Claude Agent SDK keys transcripts off the
 * *realpath-resolved* cwd. `linkClaudeProjects()` symlinks the opposite
 * direction — `~/.claude/projects` -> a directory on the volume — which is
 * safe because that path is never used as a session cwd.
 */
export class ContainerBootCommand implements ICommand {
	private readonly env: NodeJS.ProcessEnv;
	private readonly exec: ExecFn;
	private readonly spawnFn: SpawnFn;
	private readonly homeDir: string;
	private readonly logger: ContainerBootLogger;
	private readonly appPath: string;
	private readonly downloadBundleFn: typeof defaultDownloadBundle;
	private readonly restoreBundleFn: typeof defaultRestoreBundle;

	constructor(deps: ContainerBootDeps = {}) {
		this.env = deps.env ?? process.env;
		this.exec = deps.exec ?? defaultExec;
		this.spawnFn = deps.spawnFn ?? defaultSpawn;
		this.homeDir = deps.homeDir ?? homedir();
		this.logger = deps.logger ?? defaultLogger;
		this.appPath = deps.appPath ?? process.argv[1] ?? "";
		this.downloadBundleFn = deps.downloadBundleFn ?? defaultDownloadBundle;
		this.restoreBundleFn = deps.restoreBundleFn ?? defaultRestoreBundle;
	}

	async execute(_args: string[]): Promise<void> {
		const missing = findMissingEnvVars(this.env);
		if (missing.length > 0) {
			this.logger.error(
				`Missing required environment variable(s): ${missing.join(", ")}`,
			);
			process.exit(1);
			return;
		}

		const issueKey = this.env.CYRUS_ISSUE_KEY as string;
		if (!isValidIssueKey(issueKey)) {
			this.logger.error(
				`CYRUS_ISSUE_KEY is invalid: ${JSON.stringify(issueKey)} does not match ${ISSUE_KEY_PATTERN}`,
			);
			process.exit(1);
			return;
		}

		const workspacesDir =
			this.env.CYRUS_WORKSPACES_DIR ?? DEFAULT_WORKSPACES_DIR;
		const repoCacheDir =
			this.env.CYRUS_REPO_CACHE_DIR ?? DEFAULT_REPO_CACHE_DIR;
		const routerUrl = this.env.CYRUS_ROUTER_URL as string;
		const deviceToken = this.env.CYRUS_DEVICE_TOKEN as string;
		const gitToken = this.env.GIT_TOKEN;

		let repos: RepoSpec[];
		try {
			repos = parseReposJson(this.env.CYRUS_REPOS_JSON as string);
		} catch (error) {
			this.logger.error(
				`CYRUS_REPOS_JSON is invalid: ${(error as Error).message}`,
			);
			process.exit(1);
			return;
		}

		this.linkClaudeProjects(workspacesDir);
		await this.restoreState({
			workspacesDir,
			routerUrl,
			deviceToken,
			issueKey,
		});

		// `--restore-only`: run only the restore ladder (env validation,
		// linkClaudeProjects, restoreState — everything above this point) and
		// stop. Used by tests/tooling that need to assert restore behavior
		// deterministically without booting a full `cyrus start` session.
		// Everything below this point (configureGit/cloneRepos/writeConfig/
		// applyDotfiles/launch) is skipped.
		if (_args.includes("--restore-only")) {
			return;
		}

		// configureGit MUST run before cloneRepos: it installs the credential
		// helper that authenticates the clone, so the clone URL itself never
		// needs (and never gets) GIT_TOKEN embedded in it. That keeps the
		// token out of `.git/config` on the durable volume, where it would
		// otherwise resurface in `git fetch` failures and any `git remote -v`
		// Claude runs inside the worktree (both logged/posted to Linear).
		await this.configureGit({
			gitUserName: this.env.GIT_USER_NAME ?? "Cyrus",
			gitUserEmail: this.env.GIT_USER_EMAIL ?? "cyrus@localhost",
			gitToken,
		});
		await this.cloneRepos({ workspacesDir, repoCacheDir, repos, gitToken });
		this.writeConfig({ workspacesDir, routerUrl, deviceToken, repos });
		await this.applyDotfiles({ dotfilesRepo: this.env.DOTFILES_REPO });
		this.launch({ cyrusHome: this.cyrusHomeFor(workspacesDir) });
	}

	private cyrusHomeFor(workspacesDir: string): string {
		return join(workspacesDir, ".cyrus");
	}

	/** Redacts a secret from a string before it can reach a log line or thrown error. */
	private redact(text: string, secret?: string): string {
		if (!secret) return text;
		return text.split(secret).join("***");
	}

	/**
	 * Step 1: symlink `~/.claude/projects` -> `$WORKSPACES/.claude-projects` so
	 * Claude transcripts live on the persistent volume. Idempotent: re-running
	 * on a warm volume where the link already points at the right target is a
	 * no-op; a stale symlink is replaced (`ln -sfn` semantics); a real
	 * directory that predates this (e.g. a fresh container image) is renamed
	 * aside rather than deleted, so nothing already there is lost.
	 */
	linkClaudeProjects(workspacesDir: string): void {
		const target = join(workspacesDir, ".claude-projects");
		mkdirSync(target, { recursive: true });

		const linkPath = join(this.homeDir, ".claude", "projects");
		mkdirSync(dirname(linkPath), { recursive: true });

		let existing: ReturnType<typeof lstatSync> | undefined;
		try {
			existing = lstatSync(linkPath);
		} catch {
			existing = undefined;
		}

		if (existing) {
			if (existing.isSymbolicLink()) {
				rmSync(linkPath, { force: true });
			} else {
				renameSync(linkPath, `${linkPath}.bak-${Date.now()}`);
			}
		}

		symlinkSync(target, linkPath, "dir");
	}

	/**
	 * Step 2: the restore ladder's middle rung.
	 *
	 * - Warm volume fast path: `<cyrusHome>/state/edge-worker-state.json`
	 *   already exists (a previous boot on this same volume already restored
	 *   or created it) -> skip entirely, using it as-is.
	 * - Otherwise, ask the router for the issue's floor bundle. A 404
	 *   (`downloadBundle` resolving `false`) means a brand-new issue -> fresh
	 *   start, nothing to restore.
	 * - Otherwise unpack the bundle: Claude transcripts land under
	 *   `$WORKSPACES/.claude-projects`, and the edge-worker state file is
	 *   rebuilt at `<cyrusHome>/state/edge-worker-state.json`.
	 */
	async restoreState(opts: {
		workspacesDir: string;
		routerUrl: string;
		deviceToken: string;
		issueKey: string;
	}): Promise<"warm" | "restored" | "fresh"> {
		const cyrusHome = this.cyrusHomeFor(opts.workspacesDir);
		const stateFile = join(cyrusHome, "state", "edge-worker-state.json");
		if (existsSync(stateFile)) {
			this.logger.info(
				"Warm volume: edge-worker state already present, skipping restore.",
			);
			return "warm";
		}

		const claudeProjectsDir = join(opts.workspacesDir, ".claude-projects");
		const tmpDir = await mkdtemp(join(tmpdir(), "cyrus-container-boot-"));
		try {
			const tmpBundle = join(tmpDir, "bundle.tar.gz");
			const found = await this.downloadBundleFn(
				toHttpBase(opts.routerUrl),
				opts.deviceToken,
				opts.issueKey,
				tmpBundle,
			);
			if (!found) {
				this.logger.info("No floor bundle found for this issue — fresh start.");
				return "fresh";
			}
			const { restoredSessions } = await this.restoreBundleFn({
				bundleFile: tmpBundle,
				claudeProjectsDir,
				stateFile,
			});
			this.canonicalizeRestoredWorkspaces({
				workspacesDir: opts.workspacesDir,
				issueKey: opts.issueKey,
				stateFile,
				claudeProjectsDir,
			});
			this.logger.info(
				`Restored ${restoredSessions} session(s) from the floor bundle.`,
			);
			return "restored";
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	}

	/**
	 * Canonicalizes a restored session's workspace path and relocates its
	 * Claude transcript alongside it — the fix for **device -> container
	 * migration**.
	 *
	 * A session bundled from a **physical device** carries a host path (e.g.
	 * `/Users/alice/code/repo/worktrees/CYC-1`) in `workspace.path`. That path
	 * can never exist inside this container: left as-is, the next resume
	 * would hand the runner a `cwd` that doesn't exist, and `ClaudeRunner`'s
	 * own `mkdirSync(cwd, { recursive: true })` would silently manufacture an
	 * empty directory there instead of failing loudly.
	 *
	 * This rewrites `workspace.path` (and any multi-repo `repoPaths` entries)
	 * to the canonical `$CYRUS_WORKSPACES_DIR/<ISSUE-KEY>` path — the same
	 * path `GitService.createGitWorktree` independently computes, so the
	 * edge-worker's "recreate a missing worktree on resume" logic and this
	 * rewrite always agree on where the worktree belongs.
	 *
	 * Because the Claude Agent SDK keys transcript directories by the
	 * sanitized, realpath-resolved cwd (`~/.claude/projects/<sanitized-cwd>/`,
	 * see `sanitizeCwdForClaudeProjects`), a path rewrite alone would orphan
	 * the transcript the bundle just restored under the OLD sanitized name.
	 * So the transcript directory is relocated alongside the rewrite — get
	 * this right and a Claude session survives a device -> container
	 * migration, which the original design assumed was impossible.
	 *
	 * If relocation isn't possible (no transcript was ever captured for this
	 * workspace, or an I/O error), this falls back to the existing
	 * graceful-degradation mechanism already implemented by
	 * `restoreBundle`/`RUNNER_ID_KEYS`: the runner session ids are stripped so
	 * the EdgeWorker's `needsNewSession` path re-primes a fresh session
	 * against the restored branch instead of resuming into an empty tree.
	 *
	 * A no-op (including the file read) when the state file doesn't exist,
	 * and a no-op write when nothing needed rewriting (e.g. every session's
	 * workspace path is already canonical, as on a warm volume this boot
	 * created itself).
	 */
	canonicalizeRestoredWorkspaces(opts: {
		workspacesDir: string;
		issueKey: string;
		stateFile: string;
		claudeProjectsDir: string;
	}): void {
		if (!existsSync(opts.stateFile)) return;

		let parsed: {
			version: string;
			savedAt: string;
			state: {
				agentSessions?: Record<string, Record<string, unknown>>;
				agentSessionEntries?: Record<string, unknown[]>;
			};
		};
		try {
			parsed = JSON.parse(readFileSync(opts.stateFile, "utf-8"));
		} catch (error) {
			this.logger.warn(
				`Failed to parse ${opts.stateFile} while canonicalizing restored workspaces: ${(error as Error).message}`,
			);
			return;
		}

		const sessions = parsed.state?.agentSessions;
		if (!sessions) return;

		const canonicalPath = join(opts.workspacesDir, opts.issueKey);
		// Cache relocation outcomes by old path — multiple sessions on the same
		// issue (or repos within one multi-repo session) can share the same
		// old workspace path, and relocation must only ever run once per path.
		const relocatedFrom = new Map<string, boolean>();
		let changed = false;

		for (const session of Object.values(sessions)) {
			const issue = session.issue as { identifier?: string } | undefined;
			if (issue?.identifier !== opts.issueKey) continue;

			const workspace = session.workspace as
				| { path?: string; repoPaths?: Record<string, string> }
				| undefined;
			const oldPath = workspace?.path;
			if (!workspace || !oldPath || oldPath === canonicalPath) continue;

			changed = true;
			let relocated = relocatedFrom.get(oldPath);
			if (relocated === undefined) {
				relocated = this.relocateTranscriptDir(
					opts.claudeProjectsDir,
					oldPath,
					canonicalPath,
				);
				relocatedFrom.set(oldPath, relocated);
			}

			if (workspace.repoPaths) {
				for (const [repoId, repoPath] of Object.entries(workspace.repoPaths)) {
					workspace.repoPaths[repoId] = join(
						canonicalPath,
						relative(oldPath, repoPath),
					);
				}
			}
			workspace.path = canonicalPath;

			if (!relocated) {
				this.logger.warn(
					`${opts.issueKey}: could not relocate the Claude transcript for a restored session from ${oldPath} — stripping runner session ids so the EdgeWorker re-primes a fresh session against the restored branch instead of resuming into an empty tree.`,
				);
				for (const key of RUNNER_ID_KEYS) {
					delete session[key];
				}
			}
		}

		if (!changed) return;

		const tmpPath = `${opts.stateFile}.tmp`;
		writeFileSync(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`);
		renameSync(tmpPath, opts.stateFile);
	}

	/**
	 * Moves (or, if the canonical directory already has content, merges into)
	 * the Claude transcript directory for `oldWorkspacePath` to the directory
	 * `newWorkspacePath` sanitizes to. Returns `false` — never throws — when
	 * there is nothing to relocate (no transcript was ever bundled for this
	 * workspace) or the move fails, so the caller can fall back to stripping
	 * runner session ids.
	 */
	private relocateTranscriptDir(
		claudeProjectsDir: string,
		oldWorkspacePath: string,
		newWorkspacePath: string,
	): boolean {
		const oldDir = join(
			claudeProjectsDir,
			sanitizeCwdForClaudeProjects(oldWorkspacePath),
		);
		const newDir = join(
			claudeProjectsDir,
			sanitizeCwdForClaudeProjects(newWorkspacePath),
		);
		if (oldDir === newDir) return true;
		if (!existsSync(oldDir)) return false;

		try {
			if (existsSync(newDir)) {
				// Defensive: a previous (interrupted) boot may have already
				// relocated some files here. Merge rather than clobber.
				cpSync(oldDir, newDir, { recursive: true });
				rmSync(oldDir, { recursive: true, force: true });
			} else {
				mkdirSync(dirname(newDir), { recursive: true });
				renameSync(oldDir, newDir);
			}
			return true;
		} catch (error) {
			this.logger.warn(
				`Failed to relocate Claude transcript from ${oldDir} to ${newDir}: ${(error as Error).message}`,
			);
			return false;
		}
	}

	/**
	 * Step 4: clone every configured repo. Never embeds `GIT_TOKEN` in the
	 * clone URL — `configureGit()` has already run (see `execute()`) and
	 * installed a credential helper, which is sufficient to authenticate the
	 * clone on its own. This matters because git stores the clone URL
	 * *verbatim* as `remote.origin.url` in `.git/config` on the durable
	 * volume: an embedded token there would resurface in `git fetch`
	 * failures and in any `git remote -v` Claude runs inside the worktree
	 * (both end up logged / posted to Linear as activity).
	 *
	 * A repo is skipped as "already cloned" only when it's actually usable
	 * (`.git` exists AND `git rev-parse --verify HEAD` succeeds) — not
	 * merely when `.git` exists. `git clone` creates `.git` at the *start*
	 * of the transfer, so a container killed mid-clone (the longest step of
	 * a cold boot) leaves a `.git` dir with no HEAD/worktree behind. Gating
	 * on `.git` alone would make that state permanent: every future boot
	 * would see `.git`, skip the clone, and hand `GitService` a broken repo
	 * forever. A repo present but unusable is removed and re-cloned instead.
	 *
	 * Regardless of which path was taken, `remote.origin.url` is healed back
	 * to the clean (tokenless) URL afterward — belt and braces for a warm
	 * volume that was cloned by an older version of this code with the
	 * token embedded.
	 *
	 * Uses `--reference-if-able` against a local cache dir to speed up
	 * repeat clones across containers; git silently ignores that flag when
	 * the cache doesn't exist/isn't usable, so it's always safe to pass.
	 */
	async cloneRepos(opts: {
		workspacesDir: string;
		repoCacheDir: string;
		repos: RepoSpec[];
		gitToken?: string;
	}): Promise<void> {
		for (const repo of opts.repos) {
			const repoDir = join(opts.workspacesDir, "repos", repo.name);
			const cloneUrl = `https://github.com/${repo.githubSlug}.git`;

			if (await this.isUsableClone(repoDir)) {
				this.logger.info(`${repo.name}: already cloned, skipping.`);
				await this.healRemoteUrl(repoDir, cloneUrl, opts.gitToken);
				continue;
			}

			if (existsSync(repoDir)) {
				this.logger.warn(
					`${repo.name}: existing clone at ${repoDir} has no usable HEAD (likely an interrupted clone) — removing and re-cloning.`,
				);
				rmSync(repoDir, { recursive: true, force: true });
			}

			const cacheDir = join(opts.repoCacheDir, `${repo.name}.git`);

			const { exitCode, stderr } = await this.exec("git", [
				"clone",
				"--reference-if-able",
				cacheDir,
				cloneUrl,
				repoDir,
			]);
			if (exitCode !== 0) {
				throw new Error(
					`git clone failed for ${repo.name}: ${this.redact(stderr, opts.gitToken)}`,
				);
			}
			this.logger.info(`${repo.name}: cloned.`);
			await this.healRemoteUrl(repoDir, cloneUrl, opts.gitToken);
		}
	}

	/** True iff `repoDir` is a git repo with a resolvable HEAD — i.e. a complete clone, not one interrupted mid-transfer. */
	private async isUsableClone(repoDir: string): Promise<boolean> {
		if (!existsSync(join(repoDir, ".git"))) return false;
		const { exitCode } = await this.exec("git", [
			"-C",
			repoDir,
			"rev-parse",
			"--verify",
			"HEAD",
		]);
		return exitCode === 0;
	}

	/**
	 * Forces `remote.origin.url` back to the clean (tokenless) URL. Belt and
	 * braces for warm volumes cloned by an older version of this code that
	 * embedded `GIT_TOKEN` in the clone URL — self-heals on the next boot
	 * without requiring the volume to be destroyed.
	 */
	private async healRemoteUrl(
		repoDir: string,
		cleanUrl: string,
		gitToken?: string,
	): Promise<void> {
		const { exitCode, stderr } = await this.exec("git", [
			"-C",
			repoDir,
			"remote",
			"set-url",
			"origin",
			cleanUrl,
		]);
		if (exitCode !== 0) {
			this.logger.warn(
				`${repoDir}: failed to heal remote.origin.url: ${this.redact(stderr, gitToken)}`,
			);
		}
	}

	/**
	 * Builds a single repository entry matching `RepositoryConfigSchema`. All
	 * fields the schema requires (`id`, `name`, `repositoryPath`, `baseBranch`,
	 * `workspaceBaseDir`) are set explicitly — `workspaceBaseDir` is always the
	 * shared `$WORKSPACES` root, which is what makes worktrees land at the
	 * canonical `/workspaces/<ISSUE-KEY>` path.
	 */
	private buildRepositoryConfig(repo: RepoSpec, workspacesDir: string) {
		return {
			id: repo.name,
			name: repo.name,
			repositoryPath: join(workspacesDir, "repos", repo.name),
			workspaceBaseDir: workspacesDir,
			baseBranch: repo.baseBranch ?? "main",
			linearWorkspaceId: repo.linearWorkspaceId,
			isActive: true,
		};
	}

	/**
	 * Step 5: writes `<cyrusHome>/config.json`, validated against the real
	 * `EdgeConfigSchema`/`RepositoryConfigSchema` (not just the brief's example
	 * shape) so a malformed `CYRUS_REPOS_JSON` entry fails loudly here rather
	 * than producing a config the edge worker silently can't load. Written
	 * atomically (tmp + rename) at mode 0600 since `router.deviceToken` is a
	 * bearer credential. Overwriting on every boot is intentionally
	 * idempotent — env is always the source of truth, mirroring
	 * `docker/router/entrypoint.mjs`.
	 */
	writeConfig(opts: {
		workspacesDir: string;
		routerUrl: string;
		deviceToken: string;
		repos: RepoSpec[];
	}): void {
		const repositories = opts.repos.map((repo) => {
			const repoConfig = this.buildRepositoryConfig(repo, opts.workspacesDir);
			RepositoryConfigSchema.parse(repoConfig);
			return repoConfig;
		});

		const config = EdgeConfigSchema.parse({
			platform: "router" as const,
			router: {
				url: opts.routerUrl,
				deviceToken: opts.deviceToken,
				floorSync: true,
			},
			repositories,
		});

		const cyrusHome = this.cyrusHomeFor(opts.workspacesDir);
		mkdirSync(cyrusHome, { recursive: true });
		const configPath = join(cyrusHome, "config.json");
		const tmpPath = `${configPath}.tmp`;
		writeFileSync(tmpPath, `${JSON.stringify(config, null, 2)}\n`, {
			mode: 0o600,
		});
		renameSync(tmpPath, configPath);
		// writeFileSync's mode only applies on creation; enforce on overwrite too.
		chmodSync(configPath, 0o600);
	}

	/**
	 * Step 3: global git identity + (when `GIT_TOKEN` is set) a credential
	 * helper so subsequent git operations (clone, push, PR creation)
	 * authenticate without ever embedding the token in a URL.
	 * `~/.git-credentials` holds a live bearer credential, so it is written
	 * at mode 0600 and re-chmod'd on every boot in case an image/volume
	 * default umask is looser. Runs *before* `cloneRepos()` — see the note
	 * there for why that ordering is load-bearing.
	 */
	async configureGit(opts: {
		gitUserName: string;
		gitUserEmail: string;
		gitToken?: string;
	}): Promise<void> {
		await this.exec("git", [
			"config",
			"--global",
			"user.name",
			opts.gitUserName,
		]);
		await this.exec("git", [
			"config",
			"--global",
			"user.email",
			opts.gitUserEmail,
		]);

		if (opts.gitToken) {
			const credentialsPath = join(this.homeDir, ".git-credentials");
			writeFileSync(
				credentialsPath,
				`https://x-access-token:${opts.gitToken}@github.com\n`,
				{ mode: 0o600 },
			);
			chmodSync(credentialsPath, 0o600);
			await this.exec("git", [
				"config",
				"--global",
				"credential.helper",
				"store",
			]);
		}
	}

	/**
	 * Step 6: best-effort dotfiles application. Any failure (clone or
	 * install.sh) is logged as a warning and swallowed — a broken dotfiles
	 * repo must never prevent the container from booting.
	 *
	 * `DOTFILES_REPO` commonly takes the form
	 * `https://<pat>@github.com/me/dotfiles` — a PAT embedded directly in the
	 * URL, distinct from `GIT_TOKEN`. A failed clone's stderr echoes that URL
	 * back verbatim (git's `fatal: unable to access '<url>'`), so the
	 * credential is extracted from the URL and redacted before it can reach
	 * the warning log.
	 */
	async applyDotfiles(opts: { dotfilesRepo?: string }): Promise<void> {
		if (!opts.dotfilesRepo) return;

		const embeddedCredential = this.extractUrlCredential(opts.dotfilesRepo);

		try {
			const dotfilesDir = join(this.homeDir, "dotfiles");
			if (!existsSync(join(dotfilesDir, ".git"))) {
				const { exitCode, stderr } = await this.exec("git", [
					"clone",
					opts.dotfilesRepo,
					dotfilesDir,
				]);
				if (exitCode !== 0) {
					throw new Error(
						`git clone failed: ${this.redact(stderr, embeddedCredential)}`,
					);
				}
			}

			const installScript = join(dotfilesDir, "install.sh");
			if (existsSync(installScript)) {
				const { exitCode, stderr } = await this.exec("sh", [installScript]);
				if (exitCode !== 0) {
					throw new Error(
						`install.sh exited ${exitCode}: ${this.redact(stderr, embeddedCredential)}`,
					);
				}
			}
		} catch (error) {
			this.logger.warn(
				`applyDotfiles failed, continuing without it: ${(error as Error).message}`,
			);
		}
	}

	/**
	 * Extracts a `user[:pass]`-style credential embedded in a URL's authority
	 * component (e.g. the `<pat>` in `https://<pat>@github.com/...`), so it
	 * can be passed to {@link redact}. Returns `undefined` when the URL has
	 * no embedded credential or isn't a URL at all.
	 */
	private extractUrlCredential(url: string): string | undefined {
		const match = url.match(/^[a-zA-Z][a-zA-Z\d+.-]*:\/\/([^@/]+)@/);
		return match?.[1];
	}

	/**
	 * Step 7: spawns the normal `cyrus start` path against this container's
	 * `$WORKSPACES/.cyrus` home, mirroring how `docker/router/entrypoint.mjs`
	 * spawns `app.js` and forwards signals so `docker stop` shuts down
	 * cleanly.
	 */
	launch(opts: { cyrusHome: string }): void {
		const child = this.spawnFn(
			process.execPath,
			[this.appPath, "--cyrus-home", opts.cyrusHome, "start"],
			{ stdio: "inherit" },
		);
		for (const signal of ["SIGTERM", "SIGINT"] as const) {
			process.on(signal, () => child.kill(signal));
		}
		child.on("exit", (code, signal) => {
			process.exit(code ?? (signal ? 1 : 0));
		});
	}
}
