export function toHttpBase(routerUrl: string): string {
	return routerUrl
		.replace(/^ws:\/\//, "http://")
		.replace(/^wss:\/\//, "https://")
		.replace(/\/+$/, "");
}

/**
 * The Claude Agent SDK keys transcript directories by the session cwd with
 * every non-alphanumeric character replaced by '-' (consecutive separators,
 * e.g. from "/.dotdir", are NOT collapsed — each becomes its own '-').
 *
 * Verified manually against the real `claude` CLI (2.1.207) on 2026-07-13:
 * running from a real (non-symlinked) directory produced a projects/ dir
 * name identical to `cwd.replace(/[^a-zA-Z0-9]/g, "-")`. Note: the SDK
 * sanitizes the *OS-resolved* (realpath) cwd, not necessarily the literal
 * path a caller passed to `cd`/spawn — on macOS, running under `/tmp/...`
 * (a symlink to `/private/tmp/...`) produced a dir name reflecting
 * `/private/tmp/...`, not `/tmp/...`. This has no effect on Cyrus's
 * canonical `/workspaces/<ISSUE-KEY>` path as long as that path is not
 * itself a symlink inside the container.
 */
export function sanitizeCwdForClaudeProjects(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
