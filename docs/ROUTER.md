# Router Mode — Per-User Device Routing

Router mode runs Cyrus sessions **on each team member's own machine**, using
that machine's native credentials (cloud CLI logins like `az`/`gcloud`/`aws`,
`gh`, SSH keys, and a local Claude subscription), while a single always-on
**router host** handles Linear OAuth, webhooks, and cross-user policy.

This is a sibling deployment model to the single-host setup in
[SELF_HOSTING.md](./SELF_HOSTING.md). In self-hosting, one machine receives
webhooks *and* runs every session under one identity. In router mode those two
responsibilities are split:

- The **router host** owns the Linear app token, the webhook endpoint, the
  device registry, and the durable event queue. It never runs Claude.
- Each **client device** enrolls once, then receives its owner's agent sessions
  over an authenticated WebSocket and runs them locally.

```
Linear ──webhook──▶  Router host  ──WebSocket──▶  Alice's laptop  (runs Alice's sessions)
                     (OAuth,                 └──▶  Bob's laptop    (runs Bob's sessions)
                      queue, policy)
```

## Why router mode

- **Native, per-user credentials.** A session that Alice delegates runs as Alice
  on Alice's machine — her cloud logins, her SSH keys, her Claude subscription.
  No shared service account, no secret injection.
- **Attributed Linear tool use.** The agent's Linear reads/writes are performed
  through Alice's own locally-OAuth'd Linear MCP, so sub-issues and comments are
  attributed to her and scoped to her real Linear permissions.
- **Graceful offline behavior.** If a device is offline, its owner's events queue
  on the router and the user is told loudly (an activity is posted to the Linear
  session). Work resumes automatically when the device reconnects.

## What it is not

Router mode does **not** synchronize live worktrees between machines. The git
remote is the sync layer (see [Worktree continuity](#worktree-continuity)).
There is no hybrid fallback that runs an offline user's session elsewhere, and a
single router serves a single Linear workspace unless you configure multiple
`workspaces` entries.

---

## Admin setup (the router host)

> **Guided path.** Run `/cyrus-setup` and choose **Router host** at the mode
> prompt (or invoke the `cyrus-setup-router` skill directly). It walks through
> everything in this section — prerequisites, the tunnel (pointed at the router
> port), the Linear OAuth app, writing `router-config.json`, starting the router,
> and enrolling teammates. The steps below are the manual reference.

Pick a machine that stays on (a small VPS or an always-on box). It needs the
same Linear OAuth app + public webhook URL you would set up for self-hosting —
follow [SELF_HOSTING.md](./SELF_HOSTING.md) to obtain the workspace Linear token
and webhook secret, then configure the router instead of the single-host worker.
A router host **never runs Claude and never needs GitHub** — git operations
happen on each client device with that person's own `gh` credentials.

### 1. Write `router-config.json`

The router reads `~/.cyrus/router-config.json` (JSON). Minimal shape:

```json
{
  "port": 8787,
  "workspaces": {
    "<linear-organization-id>": { "linearToken": "<workspace-linear-token>" }
  },
  "webhook": { "verificationMode": "direct", "secret": "<linear-webhook-secret>" }
}
```

Optional fields (with defaults):

| Field | Default | Meaning |
|-------|---------|---------|
| `eventTtlMs` | `172800000` (48h) | How long a queued event lives before it expires and the user is asked to re-delegate. |
| `issueLock` | `true` | Reject a second session on an issue already being worked (see [Issue lock](#issue-lock)). |
| `creatorOnlyPrompting` | `true` | Only the session's creator may send it new prompts (see [Creator-only prompting](#creator-only-prompting)). |
| `heartbeatMs` | `30000` | WebSocket keepalive interval. |
| `host` | `127.0.0.1` | Bind address. Put the router behind a TLS-terminating reverse proxy for `wss://`. |

- `verificationMode: "direct"` verifies Linear's webhook signature with `secret`.
  Use `"proxy"` (Bearer token) if the router sits behind the Cyrus proxy.
- The database lives at `~/.cyrus/router/router.db` (SQLite, WAL mode). It holds
  the user/device registry, the per-device event queue, and issue locks.

### 2. Start the router

```bash
cyrus router start
```

The process listens on the configured port and stays up (Ctrl-C / SIGTERM shuts
it down cleanly). Put it behind a process manager (systemd, pm2) and a
TLS-terminating reverse proxy so devices can dial `wss://router.example.com`.

### 3. Enroll each teammate

For every person who should run sessions on their own machine:

```bash
cyrus router users add alice@example.com --name "Alice"
```

This registers the user (keyed by their Linear email/identity) and prints a
**one-time enrollment code that expires in 15 minutes**. Hand the code to that
person out-of-band (chat/DM) along with the router URL. They finish enrollment
with `cyrus connect` (below).

Admin management commands (all operate directly on the SQLite db, safe to run
alongside a live `router start`):

```bash
cyrus router users list                 # show users + whether a device is enrolled
cyrus router users remove <email>       # remove a user (and their device)
cyrus router devices revoke <email>     # revoke a user's device token
cyrus router unlock <issueId>           # release a stuck issue lock
```

Re-running `users add` for someone who is already enrolled mints a fresh code;
redeeming it **replaces** their device and immediately invalidates the old
token.

---

## Running the router in Docker

> **Guided path.** Run the `cyrus-setup-router-docker` skill. The steps below
> are the manual reference.

The router ships as a container image configured entirely by environment
variables. All state — the generated `router-config.json` and the SQLite
database — lives in a single volume mounted at `/data`.

### Quickstart (compose)

```bash
cd docker/router
cp .env.example .env      # fill in the three required values
docker compose up -d --build
curl -fsS http://127.0.0.1:8787/healthz   # → {"status":"ok"}
```

Or pull the prebuilt image instead of building: in `docker-compose.yml`,
replace the `build:` block with `image: ghcr.io/nick-boey/cyrus-router:latest`.
(If the GHCR package is private, `docker login ghcr.io` with a `read:packages`
PAT first — or make the package public once in its GitHub settings.)

Images are published by `.github/workflows/docker-router.yml`: `latest` on the
default branch, `v*` semver tags on releases, and — on manual `workflow_dispatch`
runs — branch and `sha-*` tags (amd64 + arm64).

### Environment variables

| Variable | Required | Default | Maps to (`router-config.json`) |
|----------|----------|---------|--------------------------------|
| `LINEAR_WORKSPACE_ID` | yes | — | key of `workspaces` |
| `LINEAR_WORKSPACE_TOKEN` | yes | — | `workspaces[id].linearToken` |
| `LINEAR_WEBHOOK_SECRET` | yes | — | `webhook.secret` |
| `CYRUS_ROUTER_PORT` | no | `8787` | `port` |
| `CYRUS_ROUTER_HOST` | no | `0.0.0.0` | `host` |
| `CYRUS_ROUTER_WEBHOOK_MODE` | no | `direct` | `webhook.verificationMode` |
| `CYRUS_ROUTER_EVENT_TTL_MS` | no | `172800000` | `eventTtlMs` |
| `CYRUS_ROUTER_ISSUE_LOCK` | no | `true` | `issueLock` |
| `CYRUS_ROUTER_CREATOR_ONLY_PROMPTING` | no | `true` | `creatorOnlyPrompting` |
| `CYRUS_ROUTER_HEARTBEAT_MS` | no | `30000` | `heartbeatMs` |
| `CYRUS_ROUTER_WORKSPACES_JSON` | no | — | full `workspaces` map (supersedes the ID/token pair) |

On every start, if the required variables are set the entrypoint regenerates
`/data/router-config.json` from them (env is the source of truth). With no
config variables set, an existing (e.g. bind-mounted) `router-config.json` is
used as-is. Neither → the container exits 1 naming the missing variables.

If you change the router port — via `CYRUS_ROUTER_PORT` or a mounted config — set `CYRUS_ROUTER_PORT` in the container environment either way (the image's HEALTHCHECK reads it) and adjust the compose port mapping to match.

### Admin commands

The image bundles a `cyrus` shim pointing at `/data`:

```bash
docker compose exec cyrus-router cyrus router users add alice@example.com --name "Alice"
docker compose exec cyrus-router cyrus router users list
docker compose exec cyrus-router cyrus router devices revoke alice@example.com
docker compose exec cyrus-router cyrus router unlock <issueId>
```

### Deployment constraints

- **Exactly one replica.** SQLite plus in-memory WebSocket/device state means
  the router cannot scale horizontally. On serverless container platforms pin
  min = max = 1 instance, and confirm the platform supports WebSockets and
  long-lived connections.
- **The `/data` volume must be a real local filesystem.** Network-backed
  storage (Azure Files, GCS FUSE, EFS/NFS) is unsafe for SQLite WAL mode. A
  small VM running the compose file is the recommended default; serverless
  only with block-storage volumes.
- **TLS stays in front.** The container serves plain HTTP on 8787; put a
  TLS-terminating reverse proxy or the bundled cloudflared sidecar
  (`docker compose --profile tunnel up -d`) in front so devices can dial
  `wss://` and Linear can reach `https://…/linear-webhook`.
- **Backups:** the `cyrus-router-data` volume is the only state; snapshot it
  (or `sqlite3 /data/router/router.db ".backup …"`) to back up the router.

---

## Device setup (each client)

> **Guided path.** Run `/cyrus-setup` and choose **Client device** at the mode
> prompt (or invoke the `cyrus-setup-client` skill directly). It walks through
> prerequisites, Claude auth, native `gh`/git config, `cyrus connect`, the local
> Linear MCP OAuth, adding repositories, and launching. The steps below are the
> manual reference.

On your own machine, in the repo(s) you want Cyrus to work in:

### 1. Connect to the router

```bash
cyrus connect https://router.example.com --code <your-enrollment-code>
```

`<url>` is the router's public **HTTP(S)** origin; the CLI derives the matching
`ws://`/`wss://` form automatically (`https://` → `wss://`, `http://` → `ws://`
for local/dev). On success it exchanges the code for a long-lived per-device
token and writes it — `chmod 0600` — into your `config.json` as
`platform: "router"` with `router: { url, deviceToken }`. The enrollment code is
burned after one use.

`cyrus connect` does **not** enable the persistence-floor sync
(`WorkspaceSyncService`) on your device — `router.floorSync` defaults to off
and is left unset. That's deliberate: without it, every session end and a
5-minute timer would start pushing `wip: auto-saved by cyrus…` commits onto
your issue branches (including open PRs) whether you wanted that or not. If
you want your device's in-progress work backed up to the router the same way
an ephemeral container's is — for example so a session can later be migrated
from your laptop onto a container — add `"floorSync": true` to the `router`
block in your `config.json` by hand.

### 2. Install and OAuth the official Linear MCP locally

In router-client mode Cyrus does **not** configure the app-token Linear MCP —
the router holds the workspace token, not your device. So the agent's *own*
Linear tool use is routed through **your** locally-installed official Linear MCP,
authenticated with **your** Linear OAuth. Install it and complete the one-time
interactive browser OAuth **now**, at connect time:

- A headless agent session cannot complete a browser OAuth flow. If your Linear
  MCP auth is missing or expired, that must surface **at connect / session
  start**, not halfway through a run.
- Attributing Linear actions to you (scoped to your real permissions) is the
  whole point — infrastructure calls (posting activities, fetching issue content
  for prompt assembly, attachments, state transitions) still flow through the
  router's app token as RPCs, but user-facing Linear tool use is yours.

Verify MCP auth health before relying on it; re-run the OAuth if it has expired.

### 3. Add repositories

Add each repo to the `repositories` array of your `config.json`. A router-mode
entry carries **no** `linearToken` (the router holds it), but it does need
`linearWorkspaceId` — `EdgeWorker` keys its issue trackers by workspace id, so a
mismatched id makes the device accept routed events and then silently drop them
for want of a tracker.

`cyrus self-add-repo` does **not** work here: it resolves the workspace from a
local `linearToken` and exits with `No Linear credentials found` on a client
device. Write the entry directly instead.

You do not need to copy the workspace id off the router host. At enrollment
`cyrus connect` calls `GET /workspaces` (authenticated with the device token) and
stores the result at `router.workspaceIds`:

```bash
jq -r '.router.workspaceIds // [] | .[]' ~/.cyrus/config.json
```

An empty result means the router predates that route — update it, or read the key
under `workspaces` in the router's `router-config.json`.

### 4. Run

```bash
cyrus start
```

Your device dials the router, authenticates with its token, and begins receiving
the agent sessions **you** create in Linear. Sessions run locally in isolated
git worktrees exactly as in single-host mode.

---

## Issue payloads cross a JSON boundary

`Issue` is not plain data. Alongside its fields it carries five async getters
(`state`, `assignee`, `team`, `parent`, `project`) and six methods (`labels()`,
`comments()`, `attachments()`, `children()`, `inverseRelations()`, `update()`),
all defined on the Linear SDK class's prototype. `JSON.stringify` keeps only own
enumerable properties, so **every one of them is lost** when an issue is sent
over the device RPC.

`RouterIssueTrackerService.hydrateIssue` rebuilds them on the device, backing
each with an RPC (`fetchTeam`, `fetchWorkflowState`, `fetchUser`, `fetchLabel`,
`fetchIssueAttachments`, `fetchIssueInverseRelations`, …). Getters are memoized
per issue.

Two rules follow for anyone adding to the RPC surface:

1. **Never send a `Promise` across the wire** — it serializes to `{}`. Resolve it
   on the router, where the Linear token lives, and send data. This is why
   `IssueRelation` (whose `issue` is a `Promise`) has the wire-safe twin
   `IssueRelationSummary`, and why `fetchIssueInverseRelations` exists rather
   than callers reaching for `issue.inverseRelations()`.
2. **Any new `Issue`-returning RPC must hydrate its result**, including nested
   issues (`fetchIssueChildren` hydrates each child).

Skipping hydration does not fail loudly. A missing method throws
`TypeError: issue.labels is not a function`, but a missing getter is worse:
`await undefined` is `undefined`, so `await issue.team` silently yields nothing
and the caller concludes the issue has no team.

Adding a method to `IIssueTrackerService` is not enough to make it callable —
`RPC_METHODS` in `packages/router-protocol` is an allowlist checked before
dispatch reflects onto the tracker. Omit it there and the call typechecks, then
fails at runtime.

---

## Offline and queue semantics

The router ACKs Linear immediately, enqueues each event in a durable per-device
SQLite queue, and delivers it over the WebSocket. Delivery is per-device FIFO and
**exactly-once-ish**: an event is removed from the queue only once the device
acks it, and the device durably records an event to a local inbox before acking,
so a crash between ack and processing replays it rather than dropping it.

- **Offline device:** events queue. The **first** time a session is queued for an
  offline device, the router posts a one-time activity to the Linear session
  ("Waiting for `<user>`'s machine to come online…"), so the delegator isn't left
  guessing. When the device reconnects it resumes from its last-acked sequence
  and drains the backlog.
- **TTL expiry:** a queued event that outlives `eventTtlMs` (default 48h) is
  dropped; the router posts an activity asking the user to re-delegate, and if the
  event never started work its issue lock is released.
- **Reconnect:** the client reconnects with exponential backoff and replays any
  activity posts it buffered while offline (idempotently, so no duplicate
  timeline entries).

---

## Cross-user policy

### Issue lock

**Default on** (`issueLock: true`). While any session is active on an issue — on
*any* device — new agent sessions on that same issue are rejected with a polite
activity naming the active session's owner. The router is the only component that
sees every session across every device, so it is the natural enforcement point
against two machines diverging on one issue.

A lock is released when: the session reaches a terminal state (complete / error /
stopped), the device's token is revoked, the device stays offline past the TTL,
or an admin runs `cyrus router unlock <issueId>`.

The terminal-state signal is delivered durably. The device writes the
`session_state` frame to `session-state-buffer.jsonl` before sending it, and
replays it on every reconnect until the router acknowledges with
`session_state_ack`. Delivery is therefore at-least-once, and the router's
release is idempotent so a replayed frame is a no-op. This matters because the
offline-past-TTL sweep only reclaims locks from devices that have gone *dark*: a
device that stays connected but loses its terminal frame would otherwise strand
the issue indefinitely, recoverable only via `cyrus router unlock`.

### Creator-only prompting

**Default on** (`creatorOnlyPrompting: true`). A session runs under its creator's
full machine identity, so the router only delivers **new prompts from the
session's creator**. A prompt from anyone else is not delivered; the router posts
an activity explaining that the session belongs to its creator and inviting the
other person to delegate the issue to start their own session. The gate fails
**closed**: if the prompt's actor cannot be positively identified, it is rejected
rather than assumed to be the creator.

Set either flag to `false` in `router-config.json` to opt out.

---

## Worktree continuity

There is no live worktree sync between devices — **the git remote is the sync
layer.** Two rules make cross-device and post-cleanup handoff work:

1. **Resume from the pushed branch.** When creating a worktree for an issue,
   Cyrus checks whether `origin/<issue-branch>` already exists and, if so, bases
   the new worktree on that remote branch instead of the repository's base
   branch. A session that another device (or an earlier, cleaned-up session)
   pushed is reconstructed from the remote, like any developer picking up a
   branch.
2. **Push WIP before a worktree is removed.** If the worktree is dirty when a
   session ends or the issue reaches a terminal state, Cyrus auto-commits the
   uncommitted changes to the issue branch as a `wip:` commit and pushes it
   before the worktree is torn down. This shrinks the window of unreachable work
   to mid-session crashes only.

Uncommitted work stranded on a crashed or sleeping machine is out of scope by
design — commit and push (which rule 2 does automatically at session end) is the
handoff mechanism.

---

## Trust boundaries

- **Workspace Linear app token:** lives only on the router host. Devices never
  see it.
- **Device token:** grants a device receipt of *one user's* sessions plus RPC
  access scoped to that user's own sessions. A stolen device token cannot act
  workspace-wide.
- **Attachments** stream through the router (which holds the token needed to
  fetch them) with a size cap, so a device never needs the workspace token to
  download issue attachments.

---

## Command reference

| Command | Where | Purpose |
|---------|-------|---------|
| `cyrus router start` | host | Start the router server (reads `~/.cyrus/router-config.json`). |
| `cyrus router users add <email> [--name <name>]` | host | Register a user + mint a 15-minute enrollment code. |
| `cyrus router users list` | host | List users and whether each has an enrolled device. |
| `cyrus router users remove <email>` | host | Remove a user and their device. |
| `cyrus router devices revoke <email>` | host | Revoke a user's device token. |
| `cyrus router unlock <issueId>` | host | Release a stuck issue lock. |
| `cyrus connect <url> --code <code>` | device | Enroll this device with the router. |
| `cyrus start` | device | Begin receiving and running your routed sessions. |
