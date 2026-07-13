# Cyrus worker image

The image a Cyrus Router boots one per issue when a user's executor is set to
`docker` (`cyrus router users set-executor <email> docker`). `LocalDockerProvider`
(in `cyrus-router-executors`) starts each container from this image and mounts
a per-issue Docker volume at `/workspaces`; the container's entrypoint
(`entrypoint.sh` -> `cyrus container-boot`) runs the restore ladder — warm
volume fast path, then restore-from-floor, then fresh start — before launching
the normal `cyrus start` process.

## Build

From the repo root:

```bash
docker build -f docker/worker/Dockerfile -t cyrus-worker:dev .
```

## Run standalone (manual smoke test)

Normally the router starts this container for you, but it can be run by hand
against a running router for debugging:

```bash
docker volume create cyrus-issue-TEST-1

docker run --rm \
	--name cyrus-issue-TEST-1 \
	-v cyrus-issue-TEST-1:/workspaces \
	-e CYRUS_ROUTER_URL=https://router.example.com \
	-e CYRUS_DEVICE_TOKEN=<device-token-for-this-issue> \
	-e CYRUS_ISSUE_KEY=TEST-1 \
	-e CYRUS_REPOS_JSON='[{"name":"my-repo","githubSlug":"org/my-repo","linearWorkspaceId":"<ws-id>","baseBranch":"main"}]' \
	-e CLAUDE_CODE_OAUTH_TOKEN=<token from `claude setup-token`> \
	-e GIT_TOKEN=<github token, optional for public repos> \
	cyrus-worker:dev
```

Stopping and re-running the same container (or `docker start`ing it again
against the same volume) re-runs `container-boot` from scratch — every step
of the restore ladder is idempotent, so this is safe and is exactly what
happens when a container restarts after being stopped mid-session.

## Environment variables

**Required** (the entrypoint exits 1, naming any that are missing):

| Variable | Purpose |
|---|---|
| `CYRUS_ROUTER_URL` | Base URL of the Cyrus Router this device enrolls against. |
| `CYRUS_DEVICE_TOKEN` | Bearer token authenticating this container as a device to the router. |
| `CYRUS_ISSUE_KEY` | The Linear issue key this container is dedicated to (e.g. `CYPACK-11`). |
| `CYRUS_REPOS_JSON` | JSON array of `{name, githubSlug, linearWorkspaceId, baseBranch?}` — the repositories to clone and route for this issue. |
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code OAuth token (from `claude setup-token`) used by the launched `cyrus start` session. |

**Optional:**

| Variable | Default | Purpose |
|---|---|---|
| `GIT_TOKEN` | (none — anonymous clone) | GitHub token written to `~/.git-credentials` (mode 0600) and used via `credential.helper store` for cloning, pushing, and PR access. Never embedded in a clone URL, so it never lands in `.git/config`. Public repos work without it. |
| `GIT_USER_NAME` | `Cyrus` | `git config --global user.name`. |
| `GIT_USER_EMAIL` | `cyrus@localhost` | `git config --global user.email`. |
| `DOTFILES_REPO` | (none) | Git URL cloned to `~/dotfiles`; its `install.sh` is run if present. Failures are logged and do not block boot. |
| `CYRUS_WORKSPACES_DIR` | `/workspaces` | Root of the persistent volume. Test seam — the Dockerfile relies on the default. |
| `CYRUS_REPO_CACHE_DIR` | `/var/cache/repos` | Optional local bare-repo cache used via `git clone --reference-if-able` to speed up repeat clones. |

## Why the workspace path matters

Every container for a given issue must use the identical path
`/workspaces/<ISSUE-KEY>` for its git worktree. The Claude Agent SDK keys its
transcript directory by the *realpath-resolved* session cwd
(`~/.claude/projects/<sanitized-cwd>/`), so an identical, non-symlinked cwd
string across container restarts (and across different executors) is what
lets a Claude session resume. `workspaceBaseDir: /workspaces` in the generated
`config.json` is what makes worktrees land there — see the doc comment on
`ContainerBootCommand.linkClaudeProjects()` for the (opposite-direction, and
therefore safe) symlink this image does use: `~/.claude/projects` -> a
directory on the volume, so transcripts persist across container rebuilds.
