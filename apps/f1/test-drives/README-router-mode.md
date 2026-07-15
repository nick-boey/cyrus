# Runbook: Router-mode container executor test drive (real credentials)

**Goal**: Manually drive the router-mode F1 rig (`apps/f1/router-server.ts`) end-to-end against
the **real** container executor — a real `docker build`, a real per-issue container boot, a real
Claude Code session inside that container, and a real floor bundle upload/restore round-trip —
using a real Claude Code OAuth token. This is the credential-bearing counterpart to the two CI
validations that a stock automated run cannot cover:

- **A3 (floor upload round-trip)** — CI (`packages/router/test/containers-real-docker.e2e.test.ts`,
  `"floor upload round-trip"` describe) proves the transport + artifact endpoint + container-side
  restore using a synthetic bundle built directly by `WorkspaceSyncService`/`buildBundle`. It never
  runs a real Claude session, so it never exercises the actual *trigger* (`syncIssueOnTermination`
  firing because a real session actually ended). This drive does.
- **A4 (`/workspaces/<ISSUE-KEY>` real-directory invariant)** — the CI assertion for this
  (`"/workspaces/<ISSUE-KEY> invariant"` describe, `it.skip(...)` at
  `containers-real-docker.e2e.test.ts:587`) is currently **skipped**. Per
  `.superpowers/sdd/vh-task-11-report.md`, Task 11's code trace found the invariant should hold
  (worktree creation structurally precedes runner start, and no step before it depends on a valid
  Claude token) but could not empirically confirm it — no Docker daemon was available in that
  task's environment, so the assertion was left conservatively skipped rather than enabled on an
  unverified assumption. **Step 7 below is that empirical confirmation.** Once you've run it and
  confirmed `/workspaces/<KEY>` is a real directory (never a symlink), remove the `it.skip` in
  `packages/router/test/containers-real-docker.e2e.test.ts` per Task 11/12's recommendation.

## Scope note — why this is a manual drive, not a CI test

The real-Docker CI suite (`containers-real-docker.e2e.test.ts`) is deliberately credential-free —
it uses synthetic bundles and a placeholder Claude token (`"fake-oauth-not-used-for-boot"`) so it
never needs a real Linear workspace or a real `claude setup-token` output. That's the right
default for CI, but it means two of the spec's four validation items (A3's real trigger, A4's live
confirmation) can only be checked by a human running a real session against real credentials. This
runbook is that check. It complements, not replaces, the CI suite — run both.

## Prerequisites

- Docker installed and reachable (`docker info` succeeds).
- A real Claude Code OAuth token: `claude setup-token`.
- Repo built at least once: `pnpm install && pnpm build` from the repo root.
- `apps/f1` uses [Bun](https://bun.sh) to run TypeScript directly (`router-server.ts`, `./f1`).

## Steps

### 1. Build the worker image

From the repo root:

```bash
docker build -f docker/worker/Dockerfile -t cyrus-worker:test .
```

Use the `cyrus-worker:test` tag exactly — `RouterRig` (`apps/f1/src/router/RouterRig.ts:55`)
defaults `containers.image` to `"cyrus-worker:test"`, matching the tag the real-Docker CI suite
also builds (`containers-real-docker.e2e.test.ts:43`).

### 2. Start the router-mode server with the REAL executor

From `apps/f1`:

```bash
cd apps/f1
F1_ROUTER_CONTROL_TOKEN=<pick-a-token> F1_ROUTER_CONTROL_PORT=3601 bun run router-server.ts
```

(equivalently: `pnpm run router-server`, wired to the same script — see `apps/f1/package.json`'s
`"router-server": "bun run router-server.ts"`).

Env vars the entrypoint reads (`apps/f1/router-server.ts:87-93`):

| Var | Purpose |
|---|---|
| `F1_ROUTER_CONTROL_TOKEN` | Bearer token guarding the `/router/*` control-plane endpoints. Defaults to `"f1-router"` if unset — set your own for anything beyond a throwaway local run. |
| `F1_ROUTER_CONTROL_PORT` | Port the control server binds. If unset, an ephemeral port is allocated (`allocatePort()`, `apps/f1/src/router/allocatePort.ts`) and only shown in the startup log — **set this explicitly to `3601`** so it matches the `./f1 router:*` CLI's default (`F1_ROUTER_CONTROL_URL` defaults to `http://127.0.0.1:3601`, `apps/f1/src/commands/router/controlClient.ts:12`) and you don't have to export `F1_ROUTER_CONTROL_URL` separately. |
| `CYRUS_ROUTER_FAKE_EXECUTOR` | **Do NOT set this for a real drive.** Setting it to `1` swaps in `NoopFakeExecutor` (`router-server.ts:31-44`) — a no-Docker stub that never actually boots a container. This is the selector between the fake path (control-plane-only smoke tests) and the real `LocalDockerProvider` path this drive needs. |

The router's own WebSocket port (separate from the control-plane port above) is always allocated
automatically (`RouterRig.ts` calls `allocatePort()` unconditionally — no env var controls it) and
is printed at startup; you don't need to configure it, `RouterRig` already wires
`routerUrlForContainers` to match.

On startup you should see (from `router-server.ts:95-101`):

```
  🚦 F1 Router-Mode Server
  Router WS:   ws://0.0.0.0:<port> (binds all interfaces; containers reach it via host.docker.internal:<port>)
  Control:     http://127.0.0.1:3601  (token: <your-token>)
```

The router binds `0.0.0.0` — required so a worker container can reach it via
`host.docker.internal` (Linux/macOS Docker gateway naming; see `RouterRig.ts:44-49`'s comment).
The control plane always binds loopback only (`ControlServer.ts:117`, `host: "127.0.0.1"`), which
is why `./f1 router:*` commands run from the same machine.

`RouterRig` also bakes in one fixed repo for every drive run: `cyrus` →
`octocat/Hello-World`, `baseBranch: "master"`, `linearWorkspaceId: "ws-1"`
(`RouterRig.ts:58-65`). That's the repo any container this rig boots will clone — there's currently
no CLI flag to point it at a different repo.

**In every following terminal**, export the matching client env so `./f1 router:*` talks to this
server:

```bash
export F1_ROUTER_CONTROL_URL=http://127.0.0.1:3601
export F1_ROUTER_CONTROL_TOKEN=<the same token you started the server with>
```

(`F1_ROUTER_CONTROL_URL` defaults to `http://127.0.0.1:3601` if unset — only export it if you
picked a different `F1_ROUTER_CONTROL_PORT` in step 2. `F1_ROUTER_CONTROL_TOKEN` has no client-side
default beyond an empty string, so it must always be exported to match the server's token.)

### 3. Seed a user

```bash
./f1 router:seed-user \
  --email you@example.com \
  --linear-id lin-you \
  --claude-token <CLAUDE_CODE_OAUTH_TOKEN-from-`claude setup-token`>
```

Flags verified against `apps/f1/src/commands/router/seedUser.ts:16-37`:

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `-e, --email <email>` | yes | — | User email. |
| `-l, --linear-id <id>` | yes | — | User's Linear id — this is the value you'll pass as `--creator-id` to `router:inject` in step 4; they must match, or the router won't route the event to this user. |
| `-p, --provider <provider>` | no | `"docker"` | Executor provider. Leave as `docker` for this drive. |
| `--claude-token <token>` | yes | — | The `CLAUDE_CODE_OAUTH_TOKEN` value the container will use to run the real Claude session. |

Under the hood this calls `POST /router/seed-user` (`ControlServer.ts:57-66`), which registers the
user, sets their executor to `docker`, and stores the Claude token via `SecretStore`.

`./f1 router:*` commands read their target/auth from `F1_ROUTER_CONTROL_URL` /
`F1_ROUTER_CONTROL_TOKEN` (`apps/f1/src/commands/router/controlClient.ts:11-13`) — make sure these
are exported in this shell to match step 2's server, or the command fails with `HTTP 401`
(mismatched token) or `ECONNREFUSED` (wrong port).

### 4. Create an issue, then inject the webhook

The control server also registers the ordinary F1 `/cli/rpc` endpoint on the **same port** as the
control plane (`ControlServer.ts:41-47`, "Reuse EdgeWorker's pattern so existing ./f1 issue/session
commands work"). `./f1 create-issue` talks to `/cli/rpc` on `CYRUS_PORT` (default `3600`,
`apps/f1/src/utils/rpc.ts:34-37`) — **not** `F1_ROUTER_CONTROL_URL` — so point it at the control
server's port explicitly:

```bash
CYRUS_PORT=3601 ./f1 create-issue --title "Router-mode drive smoke test"
```

Note the `id` and `identifier` printed in the output (e.g. `issue-1`, `DEF-1`). Then inject the
`agentSessionCreated` webhook to actually kick off routing/boot:

```bash
./f1 router:inject \
  --kind created \
  --session-id sess-1 \
  --issue-id <id-from-create-issue> \
  --identifier <identifier-from-create-issue> \
  --title "Router-mode drive smoke test" \
  --creator-id lin-you \
  --creator-email you@example.com
```

Flags verified against `apps/f1/src/commands/router/inject.ts:21-56`:

| Flag | Required | Default | Meaning |
|---|---|---|---|
| `-s, --session-id <id>` | yes | — | Any session id you pick; seeds a session in the CLI tracker and becomes the agent session's id. |
| `-i, --issue-id <id>` | yes | — | The Linear-style issue id from `create-issue`'s output. |
| `--identifier <key>` | yes | — | The issue identifier, e.g. `DEF-1`. |
| `-t, --title <title>` | no | `"F1 router issue"` | Issue title. |
| `-k, --kind <kind>` | no | `"created"` | `created` or `prompted`. Use `created` here. |
| `-b, --body <text>` | no | — | Only used for `kind=prompted`. |
| `--creator-id <id>` | yes | — | **Must equal the `--linear-id` you passed to `router:seed-user`** — this is how the router matches the event to a seeded user/executor. |
| `--creator-email <email>` | yes | — | Should match the seeded user's email. |
| `--creator-name <name>` | no | `"F1 User"` | Display name only. |

### 5. Observe the container boot and the live session

```bash
docker ps
```

You should see a container named `cyrus-issue-<IDENTIFIER>` (naming from
`LocalDockerProvider.name()`, `packages/router-executors/src/LocalDockerProvider.ts:76`,
`` `cyrus-issue-${sanitizeKey(issueKey)}` ``) with a matching named volume
(`docker volume ls | grep cyrus-issue`). `docker logs -f cyrus-issue-<IDENTIFIER>` shows the
restore ladder (fresh start on a first boot: `No floor bundle found for this issue — fresh start.`)
followed by the normal `cyrus start` output as the real Claude session runs inside the container.

Watch activities stream back over RPC (same control-server port as step 4):

```bash
CYRUS_PORT=3601 ./f1 view-session --session-id sess-1
```

### 6. Let the session end; confirm the floor bundle landed

Once the Claude session completes (or you stop it), check that a real bundle was uploaded — this
is the item-3 (floor upload) validation, exercised via a **real** in-container trigger rather than
CI's synthetic bundle:

```bash
./f1 router:artifact --identifier <IDENTIFIER>
```

Flags verified against `apps/f1/src/commands/router/artifact.ts:17-29` — the single required flag
is `--identifier <key>`; it prints `{"present":true,"bytes":<n>}` (or `{"present":false}`) by
hitting `GET /router/artifact/:issueKey` (`ControlServer.ts:102-115`), which checks for
`<artifactsDir>/<issueKey>/bundle.tar.gz` on disk.

### 7. Confirm the `/workspaces/<KEY>` directory invariant (item 4, live)

This is the empirical check Task 11's report explicitly deferred (see the Scope note above):

```bash
docker exec cyrus-issue-<IDENTIFIER> test ! -L /workspaces/<IDENTIFIER>
echo $?   # 0 = not a symlink (pass)

docker exec cyrus-issue-<IDENTIFIER> realpath /workspaces/<IDENTIFIER>
# should print /workspaces/<IDENTIFIER> itself (resolves to itself, no symlink indirection)
```

If both checks pass on a live, real-Claude-driven session, that's the confirmation Task 11's
Step 3 was missing — go remove the `it.skip(...)` at
`packages/router/test/containers-real-docker.e2e.test.ts:587` per the recommendation recorded in
`.superpowers/sdd/vh-task-11-report.md` and `vh-task-12-report.md`, and let the CI assertion run
for real.

### 8. Stop the container, boot a fresh one, confirm rung-2 restore

```bash
docker stop -t 30 cyrus-issue-<IDENTIFIER>
```

Use `-t 30`, not the bare `docker stop` — `EdgeWorker.stop()`'s final floor flush is capped at 20s
(`DEFAULT_STOP_FLUSH_TIMEOUT_MS`), and Docker's default 10s grace period would SIGKILL the
container mid-flush (see `docker/worker/README.md`'s "Verify persistence" section for the full
rationale).

To exercise the harder rung-2 path (volume gone, not just the container — the real restore-from-floor
case), remove both and re-prompt or re-inject:

```bash
docker rm -f cyrus-issue-<IDENTIFIER>
docker volume rm cyrus-issue-<IDENTIFIER>
./f1 router:inject --kind prompted --session-id sess-1 --issue-id <id> --identifier <IDENTIFIER> \
  --creator-id lin-you --creator-email you@example.com --body "continue"
docker logs -f cyrus-issue-<IDENTIFIER>
```

Look for the rung-2 log line from `ContainerBootCommand.restoreState()`
(`apps/cli/src/commands/ContainerBootCommand.ts:379-381`):

```
Restored N session(s) from the floor bundle.
```

**Restore-only shortcut**: `container-boot` (the `apps/cli` command booted as this image's
entrypoint) accepts a `--restore-only` flag that runs only the restore ladder (env validation,
`linkClaudeProjects`, `restoreState`) and exits — skipping git configuration, cloning, config
writing, and launching `cyrus start`. Verified in `apps/cli/src/buildProgram.ts:315-328` (the
`container-boot` command definition, `.option("--restore-only", ...)`) and
`apps/cli/src/commands/ContainerBootCommand.ts:262-264` (`if (_args.includes("--restore-only")) { return; }`).
Useful if you want to assert restore behavior deterministically without waiting for a full
`cyrus start` boot, e.g. by overriding the entrypoint on a one-off container:

```bash
docker run --rm --name restore-check \
  -v cyrus-issue-<IDENTIFIER>:/workspaces \
  -e CYRUS_ROUTER_URL=http://host.docker.internal:<router-ws-port> \
  -e CYRUS_DEVICE_TOKEN=<device-token> \
  -e CYRUS_ISSUE_KEY=<IDENTIFIER> \
  -e CYRUS_REPOS_JSON='[]' \
  -e CLAUDE_CODE_OAUTH_TOKEN=unused \
  --entrypoint node \
  cyrus-worker:test /app/dist/src/app.js container-boot --restore-only
```

(`/app/dist/src/app.js` is the exact path the image's own `entrypoint.sh` invokes for a normal
boot — `docker/worker/entrypoint.sh:2`, `exec node /app/dist/src/app.js container-boot`.)

## Verification checklist

- [ ] `docker build -f docker/worker/Dockerfile -t cyrus-worker:test .` succeeds
- [ ] `bun run router-server.ts` (no `CYRUS_ROUTER_FAKE_EXECUTOR`) starts and prints the router WS
      and control-plane URLs
- [ ] `router:seed-user` returns success
- [ ] `create-issue` + `router:inject --kind created` results in `docker ps` showing a new
      `cyrus-issue-<KEY>` container within a couple of minutes
- [ ] `./f1 view-session` shows activities streaming in as the real Claude session runs
- [ ] `router:artifact --identifier <KEY>` reports `present: true` with nonzero `bytes` after the
      session ends (real floor upload, item 3)
- [ ] `docker exec <container> test ! -L /workspaces/<KEY>` exits 0, and `realpath` resolves to
      itself (item 4, live — see step 7 and the Scope note above)
- [ ] After `docker stop -t 30` + volume removal + re-inject, the container's logs show
      `Restored N session(s) from the floor bundle.`

## Reporting the drive

The **runbook you're reading is not the report**. When you actually run this drive with real
credentials, write up what happened as a new dated file following the existing
`apps/f1/test-drives/` convention (see `apps/f1/test-drives/README.md` for the naming/template and
`apps/f1/test-drives/2026-07-14-container-executors-phase1-validation.md` for a worked example):

```
apps/f1/test-drives/YYYY-MM-DD-router-mode-container-drive.md
```

Include: date, branch/commit under test, what passed/failed against the checklist above, any
anomalies, and — if step 7 confirms the directory invariant — a note that you removed the Task 12
`it.skip` and its verification result.

## Appendix: the opt-in real-Docker CI suite

There is also a scripted, credential-free real-Docker suite that covers container lifecycle
(boot/idle-stop/stale-destroy/orphan-GC), the floor upload round-trip with a synthetic bundle, and
(once un-skipped per step 7 above) the `/workspaces/<KEY>` directory invariant. It's opt-in and
skipped by default:

```bash
CYRUS_E2E_DEDICATED_DOCKER=1 pnpm --filter cyrus-router vitest run test/containers-real-docker.e2e.test.ts
```

`CYRUS_E2E_DEDICATED_DOCKER` verified in `packages/router/test/helpers/dockerDaemon.ts:10-12`
(`dedicatedDaemonOptIn()`); every `describe` block in the suite is gated on
`dockerAvailable() && dedicatedDaemonOptIn()`.

**SAFETY WARNING — this suite runs orphan-GC against the live Docker daemon it's pointed at.**
`ContainerLifecycle.sweep()`'s orphan-GC pass (`packages/router/src/ContainerLifecycle.ts:114-141`)
calls `destroy()` on **every** container the executor's `listManaged()` reports that has no
matching device row in that test run's own (in-memory/temp) SQLite store.
`LocalDockerProvider.listManaged()` (`packages/router-executors/src/LocalDockerProvider.ts:157-170`)
lists **every** container on the daemon labeled `cyrus.issue` — not scoped to this test run. On a
shared or production Docker daemon, that means the orphan-GC test (`it.skipIf(!dedicatedDaemonOptIn())`
at `containers-real-docker.e2e.test.ts:220`) can `docker rm -f` / `docker volume rm` **real,
in-use `cyrus-issue-*` containers and volumes it doesn't own** — including someone else's live
Cyrus sessions. This suite MUST target a dedicated/disposable Docker context or an explicit
`DOCKER_HOST` pointed at a throwaway daemon (e.g. a fresh Colima/Docker Desktop VM, or a CI
runner's ephemeral daemon) — **never** a daemon with containers you or anyone else cares about.
