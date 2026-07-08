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

Pick a machine that stays on (a small VPS or an always-on box). It needs the
same Linear OAuth app + public webhook URL you would set up for self-hosting —
follow [SELF_HOSTING.md](./SELF_HOSTING.md) to obtain the workspace Linear token
and webhook secret, then configure the router instead of the single-host worker.

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

## Device setup (each client)

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

### 3. Run

```bash
cyrus start
```

Your device dials the router, authenticates with its token, and begins receiving
the agent sessions **you** create in Linear. Sessions run locally in isolated
git worktrees exactly as in single-host mode.

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
