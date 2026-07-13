# Cyrus worker image — local Docker mode runbook

This is the image a Cyrus Router boots **one per issue** when a user's
executor is set to `docker` (`cyrus router users set-executor <email>
docker`). `LocalDockerProvider` (in `cyrus-router-executors`) starts each
container from this image and mounts a per-issue Docker volume at
`/workspaces`; the container's entrypoint (`entrypoint.sh` -> `cyrus
container-boot`) runs the restore ladder — warm volume fast path, then
restore-from-floor, then fresh start — before launching the normal `cyrus
start` process (`platform: "router"`).

This doc is an **operator runbook**: it walks through building the image,
configuring the router, delegating an issue, and verifying that everything
actually works, start to finish. If you just want the image's environment
variable reference, jump to [Environment variables](#environment-variables).

Prerequisites:

- A router host already running per [docs/ROUTER.md](../../docs/ROUTER.md) —
  `router-config.json` written, `cyrus router start` running, Linear webhooks
  reaching it.
- Docker installed on the machine that will run the worker containers. This
  can be the router host itself, or a separate machine — as long as it can
  reach the router over WebSocket (see step 3 below) and can be reached BY the
  router for `docker` CLI calls if `LocalDockerProvider` is running remotely
  (it isn't, by default: the router shells out to the local `docker` CLI, so
  in practice the router process and the Docker daemon need to be on the same
  host).

## 1. Build the worker image

From the repo root:

```bash
docker build -f docker/worker/Dockerfile -t cyrus-worker:dev .
```

This is a multi-stage build: it compiles `cyrus-ai` and its workspace
dependencies from monorepo source, then produces a slim `node:22-slim` runtime
image with `git`, `gh`, `curl`, `jq`, and `ca-certificates` installed (the
restore ladder and Claude sessions themselves need all four). Tag it however
you like — `router-config.json`'s `containers.image` field (below) must match
whatever tag you use. For a real deployment, push this to a registry (GHCR,
ECR, etc.) and reference the pushed tag instead of a locally-built `:dev` tag,
so the image is available even if the router restarts on a different host.

## 2. Add a `containers` block to `router-config.json`

Add a top-level `containers` object to `~/.cyrus/router-config.json` (the same
file [docs/ROUTER.md](../../docs/ROUTER.md) has you write for router mode).
Here is a copy-pasteable example. It deliberately **omits** `artifactsDir` and
`secretsPath` — both are optional and their defaults are already correct on
every platform; see the optional-fields table below for why you should leave
them out unless you have a specific reason to relocate those paths:

```json
{
  "port": 8787,
  "workspaces": {
    "<linear-organization-id>": { "linearToken": "<workspace-linear-token>" }
  },
  "webhook": { "verificationMode": "direct", "secret": "<linear-webhook-secret>" },
  "containers": {
    "image": "cyrus-worker:dev",
    "routerUrlForContainers": "ws://host.docker.internal:8787",
    "repositories": [
      {
        "name": "my-repo",
        "githubSlug": "my-org/my-repo",
        "linearWorkspaceId": "<linear-organization-id>",
        "baseBranch": "main"
      }
    ],
    "idleStopMs": 900000,
    "staleDestroyMs": 1209600000,
    "docker": {
      "memoryLimit": "2g",
      "network": "bridge"
    }
  }
}
```

> **This is not a complete `router-config.json`.** `port`, `workspaces`, and
> `webhook` above are reproduced only for context, so you can see where
> `containers` slots into the file you already wrote for
> [docs/ROUTER.md](../../docs/ROUTER.md) — copy the `containers` block into
> your existing file, don't replace the whole file with this snippet. In
> particular, each entry under `workspaces` also needs a `linearRefreshToken`
> (not shown above), or the router's Linear access token silently stops
> working ~24 hours after setup — see the `## [Unreleased]` "Fixed" entry in
> `CHANGELOG.md` about router token refresh, and `docs/ROUTER.md` for the full
> field list.

**Required fields:**

| Field | Meaning |
|---|---|
| `image` | The image tag built in step 1 (or pulled from a registry). |
| `routerUrlForContainers` | The router's WebSocket URL **as reachable from inside a container** — see the callout below, this is the single most common setup mistake. |
| `repositories[]` | The repos worker containers may clone: `name`, `githubSlug` (`owner/repo`), `linearWorkspaceId` (must match a key in `workspaces` above), optional `baseBranch` (defaults to the repo's default branch). |

**Optional fields (with defaults):**

| Field | Default | Meaning |
|---|---|---|
| `artifactsDir` | `<cyrusHome>/router/artifacts` (e.g. `~/.cyrus/router/artifacts`) | Where the router stores per-issue floor bundles (git branch + Claude transcripts) uploaded by containers. **Leave this unset** — only set it if you deliberately want the bundles stored somewhere other than the default. Setting it to a Linux path like `/home/cyrus/...` will fail on macOS, where `/home` is an unwritable autofs mount. |
| `secretsPath` | `<cyrusHome>/router/user-secrets.json` (e.g. `~/.cyrus/router/user-secrets.json`) | Where per-user container secrets (Claude token, git identity, GitHub PAT) are stored. `cyrus router secrets set` writes here. **Leave this unset** for the same reason as `artifactsDir` above. |
| `idleStopMs` | `900000` (15 min) | A running container with no active session is `stop()`ped after this long — parked, volume retained, cheap to resume. |
| `staleDestroyMs` | `1209600000` (14 days) | A container untouched this long is fully destroyed (container **and** volume). Safe because the floor (git branch + artifact bundle) survives — a later prompt rebuilds the workspace from scratch via the restore ladder. |
| `docker.memoryLimit` | (none — host default) | Passed as `docker run --memory <value>`, e.g. `"2g"`. Strongly recommended if you're running several containers on one host — this is the fix for the small-VM OOM problem the design doc mentions. |
| `docker.network` | (none — Docker's default bridge) | Passed as `docker run --network <value>` if your containers need a specific Docker network (e.g. to reach an internal registry or reverse proxy). |

> ### `routerUrlForContainers` must be reachable from *inside* the container
>
> This is **not** the same as the router's own listen address (`port`/`host`
> above) — that's only reachable from the router process's own host. A worker
> container needs a URL that resolves and connects from *inside its own
> network namespace*.
>
> - **Docker Desktop (macOS/Windows):** use `ws://host.docker.internal:<port>`
>   — `host.docker.internal` is Docker Desktop's built-in DNS name for "the
>   host machine", and it is NOT `ws://localhost:<port>`. `localhost` inside a
>   container refers to the container itself, not your host — a container
>   configured with `ws://localhost:8787` will fail to connect at all (nothing
>   is listening on port 8787 inside the container's own network namespace).
> - **Linux with Docker's default bridge network:** `host.docker.internal`
>   generally does **not** resolve by default (it's a Docker Desktop
>   convenience). Either add `--add-host=host.docker.internal:host-gateway` to
>   how containers are launched (not exposed as a router config today — use
>   the router host's real LAN/Docker-bridge IP instead, e.g.
>   `ws://172.17.0.1:8787`), or run the router itself as a container on the
>   same Docker network and reference it by container/service name (e.g.
>   `ws://cyrus-router:8787` if using Docker Compose).
> - **Cloud/remote:** use the router's public `wss://` URL (the same one
>   client devices dial with `cyrus connect`), fronted by a TLS-terminating
>   reverse proxy.
>
> If you get this wrong, the symptom is: the container starts (`docker ps`
> shows it), but it never connects to the router, `cyrus router containers
> list` never shows fresh `LAST SEEN` timestamps for it, and no activity ever
> reaches Linear. Check the container's own logs (`docker logs
> cyrus-issue-<KEY>`) for a WebSocket connection error.

## 3. Point a user at the `docker` executor and set their secrets

```bash
# Route this user's sessions to per-issue Docker containers instead of a
# physical enrolled device.
cyrus router users set-executor alice@example.com docker

# Required: a Claude Code OAuth token, generated on ANY machine with the
# Claude CLI installed (does not need to be the router host).
claude setup-token
cyrus router secrets set alice@example.com claudeOauthToken <token from claude setup-token>

# Recommended: git identity, so commits inside the container are attributed
# to Alice rather than the image's baked-in default ("Cyrus" / "cyrus@localhost").
cyrus router secrets set alice@example.com gitUserName "Alice Example"
cyrus router secrets set alice@example.com gitUserEmail alice@example.com

# Optional: a GitHub PAT, if you want Alice's own PR/commit attribution
# instead of the repo's shared GitHub App installation token, or if a
# repository is private and the GitHub App path isn't configured.
cyrus router secrets set alice@example.com githubPat <github-personal-access-token>

# Optional: a dotfiles repo cloned to ~/dotfiles at boot (its install.sh, if
# present, is run — failures are logged and never block boot).
cyrus router secrets set alice@example.com dotfilesRepo https://github.com/alice/dotfiles.git
```

`alice@example.com` must already be an enrolled router user (`cyrus router
users add alice@example.com` if not — see
[docs/ROUTER.md](../../docs/ROUTER.md)). Setting an executor and secrets does
NOT require a physical device enrollment; `docker`-executor users never
connect a laptop at all.

Secrets are stored in the file named by `containers.secretsPath` (or its
default), 0600-permissioned, keyed by lowercased email. `cyrus router secrets
set` never echoes the value back to stdout or logs.

## 4. Delegate an issue and watch it boot

Delegate (or `@mention`) an issue on `my-repo` to Alice in Linear, same as any
other Cyrus workflow. What you should see, roughly in order:

1. **A container starts.** Within a few seconds to a couple of minutes (a
   cold `docker run` may need to pull the image first), `docker ps` shows a
   new container named `cyrus-issue-<ISSUE-KEY>` (e.g. `cyrus-issue-CYPACK-11`),
   with a matching named volume (`docker volume ls | grep cyrus-issue`).
2. **The router sees it.** `cyrus router containers list` shows a row for the
   issue key, with `PROVIDER` = `docker`, the owning user's email, and
   `LAST ROUTED` / `LAST SEEN` timestamps once the container has connected
   back over WebSocket.
3. **Activities flow to Linear.** The session's thoughts/actions/response
   activities appear in the Linear agent session timeline exactly as they
   would for a physical device or standalone session — the container is
   running the ordinary `cyrus start` process underneath.

If step 1 happens but step 2 never shows a fresh `LAST SEEN`, or step 3 never
happens, see [Troubleshooting](#troubleshooting) below — this is almost always
the `routerUrlForContainers` mistake described in step 2 above.

## 5. Verify persistence: stop mid-session and re-prompt

This is the point of the whole design — work should survive a container being
killed:

```bash
docker stop cyrus-issue-<ISSUE-KEY>
```

Then send a follow-up prompt to the same Linear agent session (a comment
mentioning Cyrus, or a new message in the agent session thread). You should see
the **restore ladder** run:

- The router notices the container is not running for that issue (`status()`
  returns `"stopped"` or `"absent"`) and calls `ensureRunning` again.
- `LocalDockerProvider.ensureRunning` finds the existing stopped container +
  volume and `docker start`s it (fast path) rather than creating a fresh one —
  the volume at `/workspaces` still has the git worktree and any local state.
- The container's entrypoint re-runs `cyrus container-boot`, which is
  idempotent: warm-volume fast path first, then (only if the volume were
  somehow gone) restore-from-floor via the artifact bundle, then (only if
  that's also gone) a fresh worktree from the base branch.
- The session resumes and the new prompt is processed — `docker ps` and
  `cyrus router containers list` show the same container/row as before,
  now running again.

To exercise the harder case — the volume itself is gone, not just the
container — `docker rm -f cyrus-issue-<ISSUE-KEY> && docker volume rm
cyrus-issue-<ISSUE-KEY>` before re-prompting. The container-boot restore ladder
should then pull from the router's artifact bundle (git branch + Claude
transcripts) instead of the volume, and the session should resume from the
last synced state rather than starting over.

## Troubleshooting

**A boot failure in Linear** looks like an activity on the session reading
something like:

> I couldn't start the workspace container for this issue (CYPACK-11): <error
> detail>. An operator should check the router logs; I'll retry on the next
> prompt.

This is posted **once per issue** by the router (not repeated on every
subsequent event) until a boot actually succeeds — so if you see it once and
then the issue goes quiet, that's expected; fix the underlying problem and
re-prompt (or wait for the next event) to trigger a retry. Note a *cold* boot
(first `docker run`, pulling the image) is never reported as a failure — only
an actual `ensureRunning` rejection is.

**Where router logs go:** `cyrus router start` logs to its own stdout/stderr.
If you're running it directly in a terminal, that's where to look. If it's
under a process manager, check that instead — `journalctl -u
cyrus-router` for a systemd unit, `pm2 logs cyrus-router` for pm2. The log line
for a boot failure looks like `container boot failed for <issueKey>: <error>`.

**Common causes of a boot failure / a container that never connects:**

- `routerUrlForContainers` isn't reachable from inside the container — see the
  callout in step 2. Confirm with `docker exec cyrus-issue-<KEY> curl -v
  <routerUrlForContainers as http(s)>` (swap `ws(s)://` for `http(s)://`) if
  the container is still running long enough to exec into.
- No Claude OAuth token stored for the user — the error detail will read `no
  Claude OAuth token stored for <email>`. Run `cyrus router secrets set
  <email> claudeOauthToken <token>`.
- Docker itself isn't reachable from the router process (wrong host, daemon
  not running, permission denied on the Docker socket) — the error detail
  surfaces whatever the `docker` CLI printed to stderr.
- The image tag in `containers.image` doesn't exist locally and isn't
  pullable from a registry — rebuild/push it, or fix the tag.

**Dropping a stuck container device:**

```bash
cyrus router containers destroy <issueKey>
```

This deletes only the router's bookkeeping row for that issue — the actual
`docker rm`/`docker volume rm` happens lazily, the next time the router's
lifecycle sweep runs an orphan-GC pass (it destroys any provider-managed
container with no matching device row). If you need the container gone
immediately, `docker rm -f cyrus-issue-<KEY> && docker volume rm
cyrus-issue-<KEY>` yourself.

## Manual smoke test (without a router)

Normally the router starts and manages this container for you. For debugging
the image itself, you can run it by hand against a running router:

```bash
docker volume create cyrus-issue-TEST-1

docker run --rm \
	--name cyrus-issue-TEST-1 \
	-v cyrus-issue-TEST-1:/workspaces \
	-e CYRUS_ROUTER_URL=ws://host.docker.internal:8787 \
	-e CYRUS_DEVICE_TOKEN=<device-token-for-this-issue> \
	-e CYRUS_ISSUE_KEY=TEST-1 \
	-e CYRUS_REPOS_JSON='[{"name":"my-repo","githubSlug":"org/my-repo","linearWorkspaceId":"<ws-id>","baseBranch":"main"}]' \
	-e CLAUDE_CODE_OAUTH_TOKEN=<token from `claude setup-token`> \
	-e GIT_TOKEN=<github token, optional for public repos> \
	cyrus-worker:dev
```

There is no CLI command that prints a container's device token directly (it's
minted internally when the router boots the container) — this manual path is
useful for testing the image against a stubbed/dev router, not for obtaining a
real token out-of-band.

Stopping and re-running the same container (or `docker start`ing it again
against the same volume) re-runs `container-boot` from scratch — every step of
the restore ladder is idempotent, so this is safe and is exactly what happens
when a container restarts after being stopped mid-session.

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

`GIT_TOKEN`, `GIT_USER_NAME`, `GIT_USER_EMAIL`, and `DOTFILES_REPO` are
populated automatically from the per-user secret bundle (`cyrus router
secrets set <email> <key> <value>` in step 3) whenever that secret has been
set for the user — omitted entirely otherwise, in which case the container
falls back to its own defaults shown above. `CYRUS_WORKSPACES_DIR` and
`CYRUS_REPO_CACHE_DIR` are never populated by the router at all (`docker
run`'s env never includes them); the container always falls back to the
defaults above for those two. You don't set any of these six by hand except
in the manual smoke test above.

## Why the workspace path matters

Every container for a given issue must use the identical path
`/workspaces/<ISSUE-KEY>` for its git worktree, and — this is load-bearing —
it must be a **real directory**, not a symlink to one. The Claude Agent SDK
keys its transcript directory by the **realpath-resolved** session cwd
(`~/.claude/projects/<sanitized-cwd>/`): verified against the live `claude` CLI
(v2.1.207), the SDK resolves symlinks before sanitizing the path, so a
symlinked workspace directory resolves to whatever it points at and silently
breaks Claude-session resume the moment two executors (or two boots) disagree
about where that symlink points. `workspaceBaseDir: /workspaces` in the
generated `config.json` is what makes worktrees land at a real
`/workspaces/<ISSUE-KEY>` directory — see the doc comment on
`ContainerBootCommand.linkClaudeProjects()` for the (opposite-direction, and
therefore safe) symlink this image does use: `~/.claude/projects` -> a
directory on the volume, so transcripts persist across container rebuilds.
