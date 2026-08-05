# Cyrus worker image — Docker and ACA runbook

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

The same image can run in Azure Container Apps Sandboxes. See
[ACA Sandboxes](#aca-sandboxes) for the provider-specific setup and verified
runtime differences.

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
dependencies from monorepo source, then produces a `node:22-slim` runtime
image with a baked-in toolchain (see
[What's in the image](#whats-in-the-image) for the full list and why each
piece is there). Tag it however
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
  "host": "0.0.0.0",
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
    "idleStopMs": 300000,
    "staleDestroyMs": 1209600000,
    "docker": {
      "memoryLimit": "2g",
      "network": "bridge"
    }
  }
}
```

> **This is not a complete `router-config.json`.** `port`, `host`, `workspaces`,
> and `webhook` above are reproduced only for context, so you can see where
> `containers` slots into the file you already wrote for
> [docs/ROUTER.md](../../docs/ROUTER.md) — copy the `containers` block (and
> the `"host": "0.0.0.0"` line — see the callout immediately below) into your
> existing file, don't replace the whole file with this snippet. In
> particular, each entry under `workspaces` also needs a `linearRefreshToken`
> (not shown above), or the router's Linear access token silently stops
> working ~24 hours after setup — see the `## [Unreleased]` "Fixed" entry in
> `CHANGELOG.md` about router token refresh, and `docs/ROUTER.md` for the full
> field list.

> ### `"host": "0.0.0.0"` is required for container mode — read this before you skip it
>
> The router binds `127.0.0.1` (loopback-only) by default, which is the right
> secure default when nothing but your own CLI ever talks to it. **Container
> mode breaks that assumption.** A worker container reaches the router at
> `routerUrlForContainers` (e.g. `ws://host.docker.internal:8787` on Docker
> Desktop) — and `host.docker.internal` resolves to Docker Desktop's internal
> gateway IP, **not** `127.0.0.1`. The connection arrives at your router
> process over that gateway interface, not loopback, so a router still bound
> to `127.0.0.1` refuses it outright before your application code ever sees
> the request. The same is true on Linux with the default bridge network: the
> connection arrives over the `docker0` bridge IP, not loopback.
>
> Add `"host": "0.0.0.0"` (bind every interface) to `router-config.json`
> whenever `containers` is configured. This is a router-config change only —
> **do not** try to "fix" this by editing `routerUrlForContainers` instead;
> that field controls where the *container* dials out to, not where the
> *router* listens, and changing it will not fix a refused connection caused
> by a loopback-bound router. If you skip this, see
> [Troubleshooting](#troubleshooting) below — it's the first thing to check
> when a container starts but never connects.
>
> Binding `0.0.0.0` also exposes the router's device WebSocket and artifact
> endpoints (which serve issue bundles containing Claude transcripts) on
> **every** network interface, not just the Docker bridge — auth is
> device-token-only, so do this on a trusted network or behind a firewall
> (not on open café/office Wi-Fi without one).

**Required fields:**

| Field | Meaning |
|---|---|
| `image` | The image tag built in step 1 (or pulled from a registry). |
| `routerUrlForContainers` | The router's WebSocket URL **as reachable from inside a container** — see the callout below, this is the single most common setup mistake. |
| `repositories[]` | The repos worker containers may clone: `name`, `githubSlug` (`owner/repo`), `linearWorkspaceId` (must match a key in `workspaces` above), optional `baseBranch` (defaults to the repo's default branch). |

**Also required, but lives at the top level of `router-config.json` (not inside `containers`) — see the callout above:**

| Field | Meaning |
|---|---|
| `host` | Must be `"0.0.0.0"` whenever `containers` is configured — a container reaches the router over the Docker bridge, not loopback, and the router's own default (`127.0.0.1`) refuses that connection. Not needed (and not recommended) for a router with no containers. |

**Optional fields (with defaults):**

| Field | Default | Meaning |
|---|---|---|
| `artifactsDir` | `<cyrusHome>/router/artifacts` (e.g. `~/.cyrus/router/artifacts`) | Where the router stores per-issue floor bundles (git branch + Claude transcripts) uploaded by containers. **Leave this unset** — only set it if you deliberately want the bundles stored somewhere other than the default. Setting it to a Linux path like `/home/cyrus/...` will fail on macOS, where `/home` is an unwritable autofs mount. |
| `secretsPath` | `<cyrusHome>/router/user-secrets.json` (e.g. `~/.cyrus/router/user-secrets.json`) | Where per-user container secrets are stored — an arbitrary set of environment-variable-named credentials per user (Claude token, git identity, GitHub token, and anything else a session needs; see [Per-user tool credentials and secrets management](#per-user-tool-credentials-and-secrets-management)). `cyrus router secrets set` writes here. **Leave this unset** for the same reason as `artifactsDir` above. |
| `requiredSecretKeys` | `[]` (only the Claude OAuth token is required) | Extra secret keys a user must have stored before their containers are allowed to boot, on top of the always-required `CLAUDE_CODE_OAUTH_TOKEN` — e.g. `["GIT_TOKEN", "LINEAR_API_TOKEN"]`. See [Per-user tool credentials and secrets management](#per-user-tool-credentials-and-secrets-management). |
| `idleStopMs` | `300000` (5 min) | A running container with no active session is `stop()`ped after this long — parked, volume retained, cheap to resume. The clock runs from the later of the last routed event and the moment a session *parked* (see below), so an agent that works for a long time and only then asks a question is not suspended on the next sweep tick. |
| `staleDestroyMs` | `1209600000` (14 days) | A container untouched this long is fully destroyed (container **and** volume). Safe because the floor (git branch + artifact bundle) survives — a later prompt rebuilds the workspace from scratch via the restore ladder. |
| `docker.memoryLimit` | (none — host default) | Passed as `docker run --memory <value>`, e.g. `"2g"`. Strongly recommended if you're running several containers on one host — this is the fix for the small-VM OOM problem the design doc mentions. |
| `docker.network` | (none — Docker's default bridge) | Passed as `docker run --network <value>` if your containers need a specific Docker network (e.g. to reach an internal registry or reverse proxy). |

> ### Parked sessions
>
> A session blocked on a user answer — an `AskUserQuestion` elicitation, or the
> repository-selection prompt — is **parked**: it tells the router it is waiting,
> which releases its session affinity so the idle sweep can suspend the container,
> while keeping its issue lock so no other session claims the issue. The user's
> reply resumes the same container warm, with the pending question intact.
>
> A session is only parked when nothing will wake it on its own. If it has a
> scheduled wakeup, a cron, or a background task in flight, it holds its device and
> the container keeps running — suspending it would freeze that work, and the
> completion that would normally wake the session could then never arrive.
>
> Before this, an elicitation held the container up indefinitely: the SDK query
> stays open inside the tool call, so no terminal frame is ever sent and the
> affinity gate never opens.

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

**Restart the router after saving `router-config.json`.** `cyrus router
start` reads this file once at startup — there is no watcher, so neither the
new `containers` block nor the `host`/`port` bind change take effect on a
process that's already running. Stop the running `cyrus router start` (Ctrl-C
in its terminal, or via whatever process manager runs it — see
[Troubleshooting](#troubleshooting) below for `journalctl`/`pm2` examples) and
start it again before moving on to step 3.

## 3. Point a user at the `docker` executor and set their secrets

```bash
# Route this user's sessions to per-issue Docker containers instead of a
# physical enrolled device.
cyrus router users set-executor alice@example.com docker

# Required: a Claude Code OAuth token, generated on ANY machine with the
# Claude CLI installed (does not need to be the router host).
claude setup-token
cyrus router secrets set alice@example.com CLAUDE_CODE_OAUTH_TOKEN <token from claude setup-token>

# Recommended: git identity, so commits inside the container are attributed
# to Alice rather than the image's baked-in default ("Cyrus" / "cyrus@localhost").
cyrus router secrets set alice@example.com GIT_USER_NAME "Alice Example"
cyrus router secrets set alice@example.com GIT_USER_EMAIL alice@example.com

# Optional: a GitHub token, if you want Alice's own PR/commit attribution
# instead of the repo's shared GitHub App installation token, or if a
# repository is private and the GitHub App path isn't configured.
cyrus router secrets set alice@example.com GIT_TOKEN <github-personal-access-token>

# Optional: a dotfiles repo cloned to ~/dotfiles at boot (its install.sh, if
# present, is run — failures are logged and never block boot).
cyrus router secrets set alice@example.com DOTFILES_REPO https://github.com/alice/dotfiles.git
```

Any of these — and any other tool credential a session needs — can be stored
this way: `cyrus router secrets set <email> <ENV_VAR_NAME> <value>` accepts
**any valid environment-variable name** that isn't one of the container's
own [reserved keys](#per-user-tool-credentials-and-secrets-management)
(`CYRUS_ROUTER_URL`, `CYRUS_DEVICE_TOKEN`, etc. — see that section for the
full list and for `containers.requiredSecretKeys`, `secrets list`, secret
rotation, and the hosted Linear MCP). The five names above are just the ones
this walkthrough happens to set up first.

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
killed. It works because every container this image boots has the
persistence floor turned on automatically: `cyrus container-boot` always
writes `"floorSync": true` into the container's generated `config.json`
(alongside `platform: "router"` and the `router` block), which is what makes
`WorkspaceSyncService` push WIP branches and upload session bundles to the
router in the first place. **You never set this yourself for a container —
it is not one of the environment variables in [Environment
variables](#environment-variables) below.**

`floorSync` defaults to **off** for everything else — in particular, a
physical device a teammate connected via `cyrus connect` does NOT get this
behavior unless they explicitly add `"floorSync": true` to their own
`config.json`'s `router` block. This is deliberate: before this feature, a
WIP push only ever happened when a worktree was torn down. Defaulting the
floor on for every router-platform device would have made every teammate's
laptop start pushing `wip: auto-saved by cyrus…` commits onto their issue
branches — including open PRs — on every session end and every 5-minute
tick, whether or not they asked for it. The one reason a teammate would opt a
physical device in is to enable migrating a session from their laptop onto a
container later.

```bash
docker stop -t 30 cyrus-issue-<ISSUE-KEY>
```

**Use `-t 30`, not the bare `docker stop`.** `docker stop`'s default grace
period is 10 seconds before Docker SIGKILLs the container. But
`EdgeWorker.stop()` runs `WorkspaceSyncService`'s final floor flush (WIP
branch push + bundle upload) **last**, and that flush is capped at 20 seconds
(`DEFAULT_STOP_FLUSH_TIMEOUT_MS`) — comfortably inside a 30-second grace
period, but not a 10-second one. Stop with the default timeout here and
Docker kills the container mid-`git push`, so this exact verification step
would show fewer WIP commits than expected (or none) — not because
persistence is broken, but because the container never got time to finish
writing them.

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
cyrus-issue-<ISSUE-KEY>` before re-prompting. Here is what actually happens
now, in order (this scenario has a specific fix behind it — see the note at
the end of this section):

1. **`container-boot` restores the floor bundle, not a worktree.**
   `docker logs cyrus-issue-<ISSUE-KEY>` shows no warm state on the fresh
   volume, so it downloads the issue's floor bundle from the router (git
   branch + Claude transcripts + edge-worker session state), unpacks the
   Claude transcripts and state file, and rewrites the restored session's
   workspace path to the canonical `/workspaces/<ISSUE-KEY>` — relocating the
   transcript to match that path. It then clones the repo(s) fresh into
   `/workspaces/repos/<name>` and launches `cyrus start`. **The per-issue git
   worktree itself is not created at this point** — nothing has put anything
   at `/workspaces/<ISSUE-KEY>` yet, only the state that *describes* it has
   been restored.
2. **The worktree is rebuilt on the next resume, not during boot.** When your
   follow-up prompt reaches the container, `cyrus start`'s `EdgeWorker` notices
   the workspace path from the restored state doesn't exist and recreates it
   using the exact same worktree-creation path a brand-new session uses.
   Because the persistence floor already pushed the issue's branch (and any
   WIP commits) to origin, this checks out `origin/<issue-branch>` rather than
   branching fresh from the base branch — so the recreated worktree is not
   empty. Look for a log line containing `recreating the worktree from the
   issue branch before resuming`.
3. **What you should actually see:** the worktree directory reappears at
   `/workspaces/<ISSUE-KEY>` populated with the issue's branch, including any
   `wip: auto-saved by cyrus…` commits the floor had already pushed before you
   destroyed the volume — not an empty directory with no code and no history.
   The Claude session resumes with its prior conversation visible in Linear
   (the transcript relocation in step 1 is what makes this possible), rather
   than starting a brand-new session with no memory of earlier turns.

This exact scenario used to fail: the worktree was never recreated, so a
session resumed straight into an empty, freshly-`mkdir`'d directory with no
repo and no history. If you're on a build predating that fix, you will not
see the behavior described above — update first.

## What's in the image

| Tool | Why it's baked in |
|---|---|
| `git`, `gh`, `curl`, `jq`, `ca-certificates` | The restore ladder (clone, credential helper) and sessions themselves (PR creation, fetching raw files). `ca-certificates` is what makes node's `fetch` able to reach the router at all — `node:22-slim` ships no root store. |
| `dotnet` (SDK 10.0) | Repos targeting .NET need it to build/test/restore and to run repo-local `dotnet tool`s. |
| `fleece` (Fleece.Cli) | Fleece issue tracking. Installed via `dotnet tool install --tool-path /usr/local/dotnet-tools` — **not** `-g`, which would put it under build-time `/root` where the non-root `cyrus` user cannot reach it. Unpinned: rebuilding the image picks up the latest published `Fleece.Cli`. |
| `actionlint` | GitHub Actions workflow linting. Pinned by the `ACTIONLINT_VERSION` build arg, checksum-verified, arch-resolved from `dpkg` so the same Dockerfile produces a working `amd64` (ACA) and `arm64` (local Apple Silicon) image. |
| `pwsh` (PowerShell 7) | Repos that ship `.ps1` build or deploy scripts. From the same Microsoft feed as the .NET SDK, which publishes `powershell` for both `amd64` and `arm64` on bookworm — no arch special-casing. Unpinned, like the SDK. |
| `codex` (`@openai/codex`) | The Codex agent CLI, on `PATH` for sessions. Pinned by the `CODEX_VERSION` build arg — keep it in step with the `@openai/codex` version resolved in `pnpm-lock.yaml`. Authentication is not set up yet; see the note below. |
| `opencode` (`opencode-ai`) | The OpenCode agent CLI. Pinned by the `OPENCODE_VERSION` build arg. Like `codex`, it resolves its native binary through per-platform `optionalDependencies`, so `npm install -g` gets the right `linux-x64`/`linux-arm64` build. |
| `playwright` + Chromium | Browser automation. Pinned by the `PLAYWRIGHT_VERSION` build arg; the browser lives at `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright`, owned by `cyrus`. See the caveats below. |

Override a pinned version at build time without editing the Dockerfile:

```bash
docker build -f docker/worker/Dockerfile \
  --build-arg ACTIONLINT_VERSION=1.7.12 \
  --build-arg CODEX_VERSION=0.144.6 \
  --build-arg OPENCODE_VERSION=1.18.13 \
  --build-arg PLAYWRIGHT_VERSION=1.62.0 \
  -t cyrus-worker:dev .
```

> **`codex` is on `PATH` but not yet authenticated.** Nothing is authenticated
> at build time — credentials are a runtime concern, and baking them into a
> layer would leak them into the image. How Codex should get its credentials
> inside a worker container is still being worked out (NOR-290), so this
> runbook does not yet document a setup for it.

### Playwright caveats

- **The browser is baked in because it cannot be fetched later on ACA.** ACA
  sandboxes run Deny-by-default egress and the built-in allowlist
  (`DEFAULT_EGRESS_HOSTS` in `cyrus-router-executors`) has no Playwright CDN
  entry, so a session running `playwright install` inside an ACA sandbox will
  fail to download. Under the `docker` executor it would work (no egress
  policy), which is exactly the kind of drift baking it in avoids.
- **Version mismatch is possible.** Playwright refuses to run against a
  Chromium revision it did not ship with. If a repo pins a Playwright far from
  the image's `PLAYWRIGHT_VERSION`, its tests will ask for a
  `playwright install`. `/ms-playwright` is writable by `cyrus` so that
  install can succeed — but on ACA it will be blocked by egress (above). The
  durable fix for a repo like that is an overlay image (option 1 below) that
  installs the matching browser at build time.
- **Only Chromium is installed.** Firefox and WebKit are not; a repo whose
  Playwright config runs the full three-browser matrix will fail on the other
  two. Add them in an overlay image if you need them.
- `--with-deps` was used, so Chromium's shared libraries and fonts are present.
  That part is genuinely un-fixable at runtime — it needs root, and sessions
  run as `cyrus`.
- **It costs about 1.3 GB of image size** — 984 MB of browsers
  (`chromium` 641 MB + `chromium-headless-shell` 340 MB + ffmpeg), 37 MB for
  the `playwright` npm package, and ~300 MB of apt dependencies (Mesa/LLVM and
  X11 libraries) that `--with-deps` pulls in. That is in line with Microsoft's
  own Playwright image, but it is a real cold-start cost on ACA, which pulls
  the image when it creates a sandbox from the disk image. If your sessions
  only ever drive headless Chromium, changing `playwright install` to
  `playwright install --with-deps --only-shell chromium` drops the 641 MB full
  browser and keeps the headless shell — at the cost of breaking any repo that
  uses Playwright's default (non-`chromium-headless-shell`) channel or runs
  headed.

## Adding tools to the worker container

If a session needs a CLI that isn't in the table above — say, a
language-specific package manager, another linter, or another agent CLI —
there are three ways to get it there, in order of preference:

1. **Overlay image (recommended).** Build a thin image on top of the one you
   built in step 1, install whatever you need as root, then drop back to the
   non-root `cyrus` user the base image runs as (`useradd --uid 1001 cyrus`
   + `USER cyrus`, see `docker/worker/Dockerfile`):

   ```dockerfile
   FROM cyrus-worker:dev
   USER root
   RUN npm install -g @google/gemini-cli   # example: add the Gemini CLI
   USER cyrus
   ```

   Build it, push it to whatever registry you use (see step 1's note on
   pushing `cyrus-worker:dev` — replace the `FROM` line with your own pushed
   tag, e.g. `ghcr.io/<your-org>/cyrus-worker:<tag>`, once you have one),
   point `containers.image` in `router-config.json` at the new tag, and
   restart the router. No application rebuild required — this only touches
   the image.

2. **`cyrus-setup.sh` and a dotfiles repo.** Two existing per-worktree /
   per-user hooks also run inside the container, without needing a new
   image:
   - **`cyrus-setup.sh`** at the repository root (see the top-level
     [CLAUDE.md](../../CLAUDE.md) "Git Worktrees" note) runs whenever the
     git worktree is (re)created — the container's first boot for a fresh
     issue, and again if the worktree has to be rebuilt after a volume-loss
     restore (see [step 5](#5-verify-persistence-stop-mid-session-and-re-prompt)
     above) — but not on an ordinary warm restart where the worktree already
     exists on the volume. It does **not** run with sudo; keep it to
     repo-local setup only (installing packages that need root is not
     possible this way — use the overlay image instead).
   - **`DOTFILES_REPO`** (a per-user secret, see below) is cloned to
     `~/dotfiles` and its `install.sh`, if present, is run — on **every**
     `cyrus container-boot` invocation (every container start, not just the
     first; the clone itself is skipped once `~/dotfiles/.git` already
     exists, but `install.sh` always re-runs). It also runs as the
     non-root `cyrus` user, and a failure is logged and never blocks boot.

3. **Per-user tool credentials.** If the "tool" is really just an API key or
   token a session needs (for example, Linear's own hosted MCP), store it as
   a per-user secret instead of touching the image at all:

   ```bash
   cyrus router secrets set alice@example.com LINEAR_API_TOKEN lin_api_xxx
   cyrus router secrets list alice@example.com   # keys masked; shows missing required
   ```

   See [Per-user tool credentials and secrets management](#per-user-tool-credentials-and-secrets-management)
   below for the full picture: how these values reach the container, the
   reserved keys you can't use, how to make a credential mandatory before a
   user's containers boot, and how to apply a changed secret to an
   already-running container.

## Per-user tool credentials and secrets management

`cyrus router secrets set <email> <ENV_VAR_NAME> <value>` (see
[step 3](#3-point-a-user-at-the-docker-executor-and-set-their-secrets) above)
accepts **any valid environment-variable name** that isn't reserved (below)
— not just the five names that walkthrough happens to set up. Whatever you
store is passed straight into the container's environment for that user's
sessions, so any tool that authenticates via an env var works without a code
change.

- **The value appears verbatim in the container's environment.**
  Interactive OAuth flows are **not possible inside a container** — there is
  no browser to complete them in — so for anything that would normally
  prompt an OAuth consent screen, use a long-lived credential instead: a
  personal API key, or an access token obtained ahead of time on a machine
  that *can* do the interactive flow. `LINEAR_API_TOKEN` is the concrete
  example above: set it to a Linear Personal API Key (or a pre-obtained
  OAuth access token) and, in addition to being visible to Claude as an
  ordinary env var, it also authenticates the **hosted Linear MCP** for that
  user's sessions (the same MCP server device-mode sessions get) — see the
  `LINEAR_API_TOKEN` handling in `ContainerBootCommand.writeConfig()`.

- **Required set.** `CLAUDE_CODE_OAUTH_TOKEN` is always required — a
  container refuses to boot without it. Operators can require additional
  credentials on top of that with `containers.requiredSecretKeys` in
  `router-config.json`:

  ```json
  {
    "containers": {
      "requiredSecretKeys": ["GIT_TOKEN", "LINEAR_API_TOKEN"]
    }
  }
  ```

  A user missing any key in the effective required set (the Claude token
  plus whatever `requiredSecretKeys` adds) is blocked from booting, with a
  Linear boot-failure activity naming the missing keys — see
  [Troubleshooting](#troubleshooting) below for what that activity looks
  like. Check what a given user currently has and still needs with `cyrus
  router secrets list <email>`.

- **Reserved keys** (rejected by `secrets set`, and by `requiredSecretKeys`
  in `router-config.json`): `CYRUS_ROUTER_URL`, `CYRUS_DEVICE_TOKEN`,
  `CYRUS_ISSUE_KEY`, `CYRUS_REPOS_JSON`, `CYRUS_WORKSPACES_DIR`,
  `CYRUS_REPO_CACHE_DIR`, `PATH`, `HOME`, `NODE_OPTIONS` — these are the
  container's own wiring and can't be overridden per-user. Stored keys must
  also be valid environment-variable names.

- **Rotation limitation.** Changing or adding a secret takes effect the next
  time that issue's container gets a **fresh** boot — an already-running
  container keeps the environment it started with. To apply a changed
  secret to an in-flight issue immediately, destroy its container first:

  ```bash
  cyrus router containers destroy <issueKey>
  ```

  The router recreates the container on the next routed event (a new
  prompt, a Linear webhook), with the updated environment. This only drops
  the router's bookkeeping row for the issue — see the "Dropping a stuck
  container device" note in [Troubleshooting](#troubleshooting) below for
  what it does and doesn't clean up immediately.

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

- **Check this FIRST: the router is still bound to loopback (`127.0.0.1`,
  the default) instead of `"host": "0.0.0.0"` in `router-config.json`.** This
  is the single most common cause of "the container starts (`docker ps` shows
  it) but never connects" — see the callout in step 2. The symptom is
  distinctive: `docker exec cyrus-issue-<KEY> curl -v <routerUrlForContainers
  as http(s)>` (swap `ws(s)://` for `http(s)://`) returns "connection refused"
  from *inside* the container even though `routerUrlForContainers` itself is
  spelled correctly (e.g. `host.docker.internal` resolves fine) — because the
  connection reaches your host's network stack, over the Docker gateway/bridge
  rather than loopback, and the router process itself isn't listening there.
  Fixing this is a `router-config.json` change (`"host": "0.0.0.0"`), **not** a
  `routerUrlForContainers` change — don't waste time re-checking or rewriting
  that field if `host` is the actual problem.
- `routerUrlForContainers` is misspelled or points somewhere that genuinely
  isn't reachable at all (wrong hostname, container on an isolated Docker
  network, firewall) — see the callout in step 2. The same `curl -v` above
  distinguishes this from the `host` problem above: a bad
  `routerUrlForContainers` typically fails to resolve or times out, rather
  than returning an immediate "connection refused".
- No Claude OAuth token stored for the user — the error detail will read `no
  Claude OAuth token stored for <email>`. Run `cyrus router secrets set
  <email> CLAUDE_CODE_OAUTH_TOKEN <token>`.
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

## ACA Sandboxes

Use [`infra/azure/README.md`](../../infra/azure/README.md) for the maintained
deployment and [`docs/ROUTER.md`](../../docs/ROUTER.md#azure-hosting-and-aca-sandboxes)
for operations. The short setup sequence is:

1. Publish this worker image to a registry reachable by the sandbox group.
   Private GHCR requires importing it to ACR and granting the group identity
   `AcrPull`; the 2026-07-26 spike did not publish the actual worker image, so a
   local-only tag is not sufficient.
2. Register the OCI image as a group disk image with `aca sandboxgroup disk
   create`, and set `containers.aca.disk` to that disk name.
3. Set `containers.routerUrlForContainers` to the router's public `wss://` URL,
   configure the ACA subscription/resource-group/group/region block, and set the
   user with `cyrus router users set-executor <email> aca`.

ACA maps issues by labels only because sandbox IDs are server-assigned GUIDs.
Memory-mode resume measured **0.52 s** in the spike. Suspend sends no SIGTERM
and provides no shutdown grace, unlike Docker's `docker stop -t 30`; periodic
and session-end floor sync is therefore mandatory protection rather than a
guaranteed suspend-time flush. Also, ACA can report `Running` after this image's
entrypoint has exited, so confirm the router device is connected/fresh instead
of treating infrastructure state as worker liveness.

Leave `autoSuspendSeconds: 0`: the router's `idleStopMs` is affinity-aware,
whereas ACA auto-suspend can freeze live work and snapshot restore otherwise
resets the policy to 300 seconds. The default egress policy is Deny + Full
inspection. HTTPS clones, package registries, Anthropic/Linear, and router WSS
are allowlisted; SSH remotes/submodules are not supported.

Explicit snapshots retain memory, disk, and env, including the device token.
Restore is device-lineage checked. Azure does not collect explicit snapshots,
so keep `keepSnapshots` small and schedule `cyrus router containers
gc-snapshots --yes` after reviewing its plan. No official snapshot-specific
price was published during the spike; do not budget from the stale claim that
preview snapshots are free or later billed as ordinary Blob storage.

Key Vault secret rotation reaches only a fresh create-from-image. Resume and
snapshot restore retain the old env; run `cyrus router containers destroy
<issueKey>` and re-prompt to force updated credentials. Closing/deleting an
issue normally wakes the sandbox for a forced floor flush and teardown before
destroying it; see the router runbook for Linear's self-acted/duplicate terminal
notification blind spots and the 14-day GC backstop.

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
