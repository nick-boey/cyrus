import { join } from "node:path";

/**
 * Shared constants used across Cyrus packages
 */

/**
 * Default proxy URL for Cyrus hosted services
 */
export const DEFAULT_PROXY_URL = "https://cyrus-proxy.ceedar.workers.dev";

/**
 * Default directory name for git worktrees
 */
export const DEFAULT_WORKTREES_DIR = "worktrees";

/**
 * Default directory name for cloned repositories
 */
export const DEFAULT_REPOS_DIR = "repos";

/**
 * Resolves the repos directory, preferring CYRUS_REPOS_DIR env var over the default.
 */
export function getDefaultReposDir(cyrusHome: string): string {
	return (
		process.env.CYRUS_REPOS_DIR?.trim() || join(cyrusHome, DEFAULT_REPOS_DIR)
	);
}

/**
 * Resolves the worktrees directory, preferring CYRUS_WORKTREES_DIR env var over the default.
 */
export function getDefaultWorktreesDir(cyrusHome: string): string {
	return (
		process.env.CYRUS_WORKTREES_DIR?.trim() ||
		join(cyrusHome, DEFAULT_WORKTREES_DIR)
	);
}

/** Where a resolved workspace base directory came from. */
export type WorkspaceBaseDirSource = "override" | "repository" | "default";

/** The directory an issue's workspace lives in, and how it was arrived at. */
export interface ResolvedWorkspacePath {
	/** `<baseDir>/<issueIdentifier>` — the issue's workspace root. */
	path: string;
	baseDir: string;
	source: WorkspaceBaseDirSource;
}

/** The only part of a repository config this resolution depends on. */
export interface WorkspaceBaseDirCarrier {
	workspaceBaseDir?: string;
}

/**
 * Resolve an issue's workspace directory — the ONE place both worktree
 * creation and worktree teardown derive it from.
 *
 * Creation has always used the repository's configured `workspaceBaseDir`
 * while teardown hardcoded `getDefaultWorktreesDir(cyrusHome)`. Those two
 * agree on a default self-host install and disagree on every container
 * sandbox, where `workspaceBaseDir` is `/workspaces` but `<cyrusHome>/worktrees`
 * is `/workspaces/.cyrus/worktrees` — so teardown pointed at a directory that
 * had never existed, and worktrees were silently never removed (NOR-411).
 * Creation and teardown both call this so the two cannot drift again.
 *
 * Precedence mirrors `GitService.createGitWorktree`: an explicit override
 * first, then the first repository's `workspaceBaseDir`, then the default. The
 * default is a last resort for callers that have no repository to resolve
 * from; `source` reports which one applied so a caller can say so when the
 * resolved path turns out not to exist.
 *
 * Every path in is joined verbatim — run config-supplied values through
 * `resolvePath` first. cyrus-hosted emits self-host paths with a literal `~/`
 * prefix, and `fs` does not expand it, so an unresolved `workspaceBaseDir`
 * produces exactly the ENOENT this function exists to make legible.
 */
export function resolveIssueWorkspacePath(params: {
	issueIdentifier: string;
	cyrusHome: string;
	/** Repositories sharing this workspace; the first one decides the base. */
	repositories?: readonly WorkspaceBaseDirCarrier[];
	/** Explicit base directory, e.g. a 0-repo or N-repo layout override. */
	overrideBaseDir?: string;
}): ResolvedWorkspacePath {
	const { issueIdentifier, cyrusHome, repositories, overrideBaseDir } = params;

	const repositoryBaseDir = repositories?.find(
		(repository) => repository.workspaceBaseDir,
	)?.workspaceBaseDir;

	const [baseDir, source]: [string, WorkspaceBaseDirSource] = overrideBaseDir
		? [overrideBaseDir, "override"]
		: repositoryBaseDir
			? [repositoryBaseDir, "repository"]
			: [getDefaultWorktreesDir(cyrusHome), "default"];

	return { path: join(baseDir, issueIdentifier), baseDir, source };
}

/**
 * Default base branch for new repositories
 */
export const DEFAULT_BASE_BRANCH = "main";

/**
 * Default config filename
 */
export const DEFAULT_CONFIG_FILENAME = "config.json";
