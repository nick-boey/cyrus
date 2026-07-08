---
name: cyrus-setup-router
description: Set up a Cyrus router host — the always-on machine that receives Linear webhooks and routes each session to the teammate who owns it. Configures Linear and a public tunnel, writes router-config.json, starts the router, and enrolls teammates. Never runs Claude or touches GitHub.
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.cyrus/.env`, `~/.cyrus/router-config.json`, or any file inside `~/.cyrus/`. Use only `Bash` commands (`grep`, `printf >>`, `cat > … <<'JSON'`, etc.) to interact with these files — secrets must never be read into the conversation context.**

# Setup Router Host

Sets up a **router host**: a shared, always-on machine that receives Linear
webhooks and routes each agent session to the teammate who owns it, over an
authenticated WebSocket. Each teammate runs their own sessions locally on their
[client device](../cyrus-setup-client/SKILL.md).

**A router host never runs Claude and never touches GitHub.** It only needs
Linear (an OAuth app + webhook) and a public URL. Git operations (push, PRs)
happen on each client device with that person's own `gh` credentials.

Full reference and rationale: `docs/ROUTER.md`.

> **Prerequisite context.** This sub-skill is normally reached from
> `/cyrus-setup` after the user chooses "Router host" in Step -1. The shared
> **CRITICAL rules** and **Browser Automation** guidance in
> `cyrus-setup/SKILL.md` apply here too (browser automation is used for the
> Linear OAuth app creation).

---

## Step 1: Prerequisites

**Read** the `cyrus-setup-prerequisites/SKILL.md` sub-skill and follow its
instructions to install `cyrus-ai` and its system dependencies.

Notes for the router role:
- `gh` (GitHub CLI) is **not** required on a router host — it never makes commits
  or PRs. If the prerequisites check flags `gh` as missing, that is fine; do not
  block on it.
- The router host still needs Node.js and `cyrus-ai`.

## Step 2: Public Endpoint / Tunnel

The router listens on its own port (**default `8787`**, set by `port` in
`router-config.json` — see Step 4), *not* the single-host port `3456`. You need a
public URL that forwards to that port. That URL is used both for the **Linear
webhook** and, behind TLS, for **devices to dial `wss://`**.

**Read** the `cyrus-setup-endpoint/SKILL.md` sub-skill and follow it in its
**router variant**:

- Tell the endpoint skill the **upstream/target port is `8787`** (the router
  port) instead of `3456`.
- Only `CYRUS_BASE_URL` needs to be written to `~/.cyrus/.env` (the Linear step
  below reads it to build the webhook/callback URLs). **Skip** the single-host
  common vars (`CYRUS_SERVER_PORT`, `LINEAR_DIRECT_WEBHOOKS`,
  `CYRUS_HOST_EXTERNAL`) — the router reads `router-config.json`, not those.

After this step you should have `CYRUS_BASE_URL` set to your public router URL
(e.g. `https://router.example.com`).

## Step 3: Linear OAuth App + Workspace Token

The router needs (a) a Linear OAuth app whose webhook points at the router, and
(b) the workspace Linear token + webhook signing secret.

**Read** the `cyrus-setup-linear/SKILL.md` sub-skill and follow it. It will:

- Create the Linear OAuth app with webhook URL `<CYRUS_BASE_URL>/linear-webhook`
  and callback URL `<CYRUS_BASE_URL>/callback` (same paths the router serves).
- Have you paste `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET`, and
  `LINEAR_WEBHOOK_SECRET` into `~/.cyrus/.env`.
- Run `cyrus self-auth-linear`, which authorizes the workspace and writes the
  workspace token into `~/.cyrus/config.json` under
  `linearWorkspaces["<workspace-id>"].linearToken`.

> On a headless VPS the OAuth browser step of `self-auth-linear` still needs a
> browser to click **Authorize**. Complete it from a machine that can reach both
> the callback URL and a browser, or use SSH port-forwarding for the temporary
> callback server. See `docs/ROUTER.md` / `docs/SELF_HOSTING.md`.

## Step 4: Write `~/.cyrus/router-config.json`

Transplant the workspace token and webhook secret into the router config. Do
**not** open the file in an editor — write it via a reviewable `Bash` heredoc.

First, read back the values you need (these come from the previous steps):

```bash
# Workspace id + token from config.json (written by `cyrus self-auth-linear`)
WS_ID=$(jq -r '.linearWorkspaces | keys[0]' ~/.cyrus/config.json)
LINEAR_TOKEN=$(jq -r --arg ws "$WS_ID" '.linearWorkspaces[$ws].linearToken' ~/.cyrus/config.json)

# Webhook signing secret from .env
WEBHOOK_SECRET=$(grep '^LINEAR_WEBHOOK_SECRET=' ~/.cyrus/.env | cut -d= -f2-)

# Sanity check (values must be non-empty; do NOT print the secrets themselves)
test -n "$WS_ID" && test -n "$LINEAR_TOKEN" && test -n "$WEBHOOK_SECRET" \
  && echo "✓ have workspace id, token, and webhook secret" \
  || echo "✗ missing one or more values — re-check Steps 2–3"
```

> **Workspace id vs. organization id.** `router-config.json` keys `workspaces` by
> the Linear **organization id**. In Linear the organization *is* the workspace,
> so the key produced by `self-auth-linear` above is the right one. If the router
> later reports it can't match the workspace for incoming webhooks, verify this
> key against the `organizationId` in a sample webhook payload.

Then write the config (still holding the shell vars from the block above):

```bash
cat > ~/.cyrus/router-config.json <<JSON
{
  "port": 8787,
  "workspaces": {
    "$WS_ID": { "linearToken": "$LINEAR_TOKEN" }
  },
  "webhook": { "verificationMode": "direct", "secret": "$WEBHOOK_SECRET" }
}
JSON
chmod 600 ~/.cyrus/router-config.json
echo "✓ wrote ~/.cyrus/router-config.json"
```

**Optional keys** (add inside the JSON object if you want to override defaults):

| Field | Default | Meaning |
|-------|---------|---------|
| `eventTtlMs` | `172800000` (48h) | How long a queued event lives before it expires and the user is asked to re-delegate. |
| `issueLock` | `true` | Reject a second session on an issue already being worked on any device. |
| `creatorOnlyPrompting` | `true` | Only the session's creator may send it new prompts. |
| `heartbeatMs` | `30000` | WebSocket keepalive interval. |
| `host` | `127.0.0.1` | Bind address. Keep the router behind a TLS-terminating reverse proxy for `wss://`. |

Set `verificationMode: "proxy"` (Bearer token) instead of `"direct"` only if the
router sits behind the Cyrus proxy. The database lives at
`~/.cyrus/router/router.db` (SQLite, WAL) and holds the user/device registry, the
per-device event queue, and issue locks.

Verify the config parses:

```bash
jq empty ~/.cyrus/router-config.json && echo "✓ router-config.json is valid JSON"
```

## Step 5: Start the Router

```bash
cyrus router start
```

The process listens on the configured port and stays up (Ctrl-C / SIGTERM shuts
it down cleanly). For a real deployment:

- **Process manager** — keep it running across reboots/crashes. For example with
  pm2:

  ```bash
  which pm2 || npm install -g pm2
  pm2 start "cyrus router start" --name cyrus-router
  pm2 save
  pm2 startup   # run the command it prints (usually needs sudo)
  ```

  (systemd works too — mirror the unit file in `cyrus-setup-launch/SKILL.md`,
  but set `ExecStart` to `cyrus router start`.)

- **TLS reverse proxy** — put nginx/Caddy/Cloudflare in front so devices can dial
  `wss://router.example.com` and Linear can reach `https://router.example.com/linear-webhook`.

## Step 6: Enroll Teammates

For every person who should run sessions on their own machine, mint a one-time
enrollment code:

```bash
cyrus router users add alice@example.com --name "Alice"
```

This registers the user (keyed by their Linear email/identity) and prints a
**one-time enrollment code that expires in 15 minutes**. Hand the code to that
person out-of-band (chat/DM) along with the router URL. They finish on their own
machine with the `cyrus-setup-client` skill (`cyrus connect <url> --code <code>`).

Re-running `users add` for someone already enrolled mints a fresh code;
redeeming it **replaces** their device and invalidates the old token.

**Management commands** (safe to run alongside a live `cyrus router start`):

```bash
cyrus router users list                 # show users + whether a device is enrolled
cyrus router users remove <email>       # remove a user (and their device)
cyrus router devices revoke <email>     # revoke a user's device token
cyrus router unlock <issueId>           # release a stuck issue lock
```

## Completion

> ✓ Router host configured
> ✓ Linear OAuth app created; webhook → `<CYRUS_BASE_URL>/linear-webhook`
> ✓ `~/.cyrus/router-config.json` written (port 8787, direct webhook verification)
> ✓ Router running via `cyrus router start` (behind a process manager + TLS proxy)
> ✓ Teammates enrolled — hand each their one-time code + the router URL
>
> Each teammate now runs `/cyrus-setup` → **Client device** (or the
> `cyrus-setup-client` skill) on their own machine to connect.
