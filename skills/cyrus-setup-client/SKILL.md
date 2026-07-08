---
name: cyrus-setup-client
description: Set up a Cyrus client device — a teammate's own machine that runs their sessions locally with their native credentials, connected to a router. Configures Claude Code, native gh/git, and a locally-OAuth'd Linear MCP, then connects to the router. No Linear OAuth app, no tunnel, no GitHub App.
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.cyrus/.env`, `~/.cyrus/config.json`, or any file inside `~/.cyrus/`. Use only `Bash` commands (`grep`, `printf >>`, etc.) to interact with these files — secrets must never be read into the conversation context.**

# Setup Client Device

Sets up a **client device**: your own laptop/workstation that runs *your* Cyrus
sessions locally, using *your* native credentials (cloud CLI logins, `gh`, SSH
keys, your Claude subscription), coordinated by a shared
[router host](../cyrus-setup-router/SKILL.md).

**A client device does not create a Linear OAuth app, does not run a public
tunnel, and does not create a GitHub App.** The router holds the workspace Linear
token and receives webhooks; your device just connects to it and runs the
sessions you own.

Full reference and rationale: `docs/ROUTER.md`.

> **Before you start**, get two things from your router admin (out-of-band):
> 1. the **router URL** (e.g. `https://router.example.com`), and
> 2. your **one-time enrollment code** (expires 15 minutes after it is minted).
>
> This sub-skill is normally reached from `/cyrus-setup` after the user chooses
> "Client device" in Step -1. The shared **CRITICAL rules** and **Browser
> Automation** guidance in `cyrus-setup/SKILL.md` apply here too.

---

## Step 1: Prerequisites

**Read** the `cyrus-setup-prerequisites/SKILL.md` sub-skill and follow its
instructions. A client device needs Node.js, `jq`, `gh`, and `cyrus-ai` — the
full set, since it runs Claude locally and makes real git commits/PRs.

## Step 2: Claude Auth

**Read** the `cyrus-setup-claude-auth/SKILL.md` sub-skill and follow it. Your
device runs Claude locally, so it needs Claude Code credentials (your account,
an API key, an OAuth token, or a third-party provider).

## Step 3: GitHub CLI + Git Identity (native credentials)

Your device pushes branches and opens PRs as **you**, using your own GitHub
credentials.

**Read** the `cyrus-setup-github/SKILL.md` sub-skill and follow **Part A only**
(`gh auth login` + `git config` name/email). **Stop before Part B** — do not
create a GitHub App or webhooks. Inbound GitHub events (@mention responses, etc.)
are the concern of a standalone or router host, not a client device.

## Step 4: Connect to the Router

Use the router URL and one-time code from your admin. `<url>` is the router's
public **HTTP(S)** origin; the CLI derives the matching `ws://`/`wss://` form
automatically (`https://` → `wss://`, `http://` → `ws://`).

```bash
cyrus connect https://router.example.com --code <your-enrollment-code>
```

On success this exchanges the code for a long-lived per-device token and writes
it — `chmod 0600` — into `~/.cyrus/config.json` as `platform: "router"` with
`router: { url, deviceToken }`. The enrollment code is single-use.

Verify the connection was written:

```bash
jq -r '.platform' ~/.cyrus/config.json   # should print: router
```

If the code has expired or was already used, ask your admin to re-run
`cyrus router users add <your-email>` for a fresh one.

## Step 5: Local Official Linear MCP (OAuth as you)

In router-client mode Cyrus does **not** configure the app-token Linear MCP — the
router holds the workspace token, not your device. So the agent's *own* Linear
tool use runs through **your** locally-installed official Linear MCP,
authenticated with **your** Linear OAuth. This attributes sub-issues and comments
to you and scopes them to your real Linear permissions.

Install the official Linear MCP and complete the one-time interactive browser
OAuth **now**, at connect time:

- A headless agent session cannot complete a browser OAuth flow. If your Linear
  MCP auth is missing or expired, that must surface **here**, not halfway through
  a run.
- Infrastructure calls (posting activities, fetching issue content for prompt
  assembly, attachments, state transitions) still flow through the router's app
  token as RPCs; only user-facing Linear tool use is yours.

Complete the OAuth and confirm the MCP reports **healthy auth** before
continuing. Re-run the OAuth if it has expired.

## Step 6: Add Repositories

**Read** the `cyrus-setup-repository/SKILL.md` sub-skill and follow it to add the
repositories you want Cyrus to work in on this machine.

## Step 7: Launch

**Read** the `cyrus-setup-launch/SKILL.md` sub-skill and follow it in its
**client variant**:

- Use `cyrus start` (your device dials the router and begins receiving the
  sessions you create in Linear).
- **Skip the ngrok / tunnel step** — a client device has no public endpoint.
- The persistence options (pm2 / systemd / foreground) apply the same way.

Sessions run locally in isolated git worktrees exactly as in single-host mode.
There is no live worktree sync between machines — the git remote is the sync
layer (Cyrus resumes from a pushed issue branch and pushes WIP at teardown). See
`docs/ROUTER.md` → *Worktree continuity*.

## Completion

> ✓ Claude Code authenticated
> ✓ GitHub CLI + git identity configured (native credentials for PRs)
> ✓ Connected to router — `platform: "router"` device token written
> ✓ Local official Linear MCP installed and OAuth'd (auth verified healthy)
> ✓ Repositories added
> ✓ Running via `cyrus start` — receiving the sessions you create in Linear
>
> Delegate a Linear issue to the agent to see it run on this machine!
