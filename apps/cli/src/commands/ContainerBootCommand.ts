import { execFile, spawn } from "node:child_process";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { EdgeConfigSchema, RepositoryConfigSchema } from "cyrus-core";
import {
	downloadBundle as defaultDownloadBundle,
	restoreBundle as defaultRestoreBundle,
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

const defaultExec: ExecFn = (cmd, args) =>
	new Promise((resolve) => {
		execFile(
			cmd,
			args,
			{ maxBuffer: 8 * 1024 * 1024 },
			(err, stdout, stderr) => {
				resolve({
					stdout: stdout?.toString() ?? "",
					stderr: stderr?.toString() ?? "",
					exitCode: err ? ((err as { code?: number }).code ?? 1) : 0,
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

		const workspacesDir =
			this.env.CYRUS_WORKSPACES_DIR ?? DEFAULT_WORKSPACES_DIR;
		const repoCacheDir =
			this.env.CYRUS_REPO_CACHE_DIR ?? DEFAULT_REPO_CACHE_DIR;
		const routerUrl = this.env.CYRUS_ROUTER_URL as string;
		const deviceToken = this.env.CYRUS_DEVICE_TOKEN as string;
		const issueKey = this.env.CYRUS_ISSUE_KEY as string;
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
		await this.cloneRepos({ workspacesDir, repoCacheDir, repos, gitToken });
		this.writeConfig({ workspacesDir, routerUrl, deviceToken, repos });
		await this.configureGit({
			gitUserName: this.env.GIT_USER_NAME ?? "Cyrus",
			gitUserEmail: this.env.GIT_USER_EMAIL ?? "cyrus@localhost",
			gitToken,
		});
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
			this.logger.info(
				`Restored ${restoredSessions} session(s) from the floor bundle.`,
			);
			return "restored";
		} finally {
			await rm(tmpDir, { recursive: true, force: true });
		}
	}

	/**
	 * Step 3: clone every configured repo, skipping any that already have a
	 * `.git` dir (idempotent on a warm volume). Uses `--reference-if-able`
	 * against a local cache dir to speed up repeat clones across containers;
	 * git silently ignores that flag when the cache doesn't exist/isn't
	 * usable, so it's always safe to pass. With `GIT_TOKEN` set, the token is
	 * embedded in the clone URL (`x-access-token:<token>@github.com`) and
	 * never otherwise logged; without it, the clone is anonymous (public
	 * repos only).
	 */
	async cloneRepos(opts: {
		workspacesDir: string;
		repoCacheDir: string;
		repos: RepoSpec[];
		gitToken?: string;
	}): Promise<void> {
		for (const repo of opts.repos) {
			const repoDir = join(opts.workspacesDir, "repos", repo.name);
			if (existsSync(join(repoDir, ".git"))) {
				this.logger.info(`${repo.name}: already cloned, skipping.`);
				continue;
			}

			const cloneUrl = opts.gitToken
				? `https://x-access-token:${opts.gitToken}@github.com/${repo.githubSlug}.git`
				: `https://github.com/${repo.githubSlug}.git`;
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
	 * Step 4: writes `<cyrusHome>/config.json`, validated against the real
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
	 * Step 5: global git identity + (when `GIT_TOKEN` is set) a credential
	 * helper so subsequent git operations (push, PR creation) authenticate
	 * without re-embedding the token. `~/.git-credentials` holds a live
	 * bearer credential, so it is written at mode 0600 and re-chmod'd on
	 * every boot in case an image/volume default umask is looser.
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
	 */
	async applyDotfiles(opts: { dotfilesRepo?: string }): Promise<void> {
		if (!opts.dotfilesRepo) return;

		try {
			const dotfilesDir = join(this.homeDir, "dotfiles");
			if (!existsSync(join(dotfilesDir, ".git"))) {
				const { exitCode, stderr } = await this.exec("git", [
					"clone",
					opts.dotfilesRepo,
					dotfilesDir,
				]);
				if (exitCode !== 0) {
					throw new Error(`git clone failed: ${stderr}`);
				}
			}

			const installScript = join(dotfilesDir, "install.sh");
			if (existsSync(installScript)) {
				const { exitCode, stderr } = await this.exec("sh", [installScript]);
				if (exitCode !== 0) {
					throw new Error(`install.sh exited ${exitCode}: ${stderr}`);
				}
			}
		} catch (error) {
			this.logger.warn(
				`applyDotfiles failed, continuing without it: ${(error as Error).message}`,
			);
		}
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
