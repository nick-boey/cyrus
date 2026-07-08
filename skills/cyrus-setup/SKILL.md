---
name: cyrus-setup
description: Set up Cyrus end-to-end — install prerequisites, configure authentication, create integrations (Linear, GitHub, Slack), add repositories, and launch. Run this once to get Cyrus running as a background agent.
---

# Cyrus Setup

One-command setup for self-hosted Cyrus. This orchestrator walks you through everything needed to run Claude Code as a background agent from Linear, Slack, and GitHub.

## CRITICAL Rules

### Never Read or Write ~/.cyrus/.env Directly

**FORBIDDEN:** Do NOT use `Read`, `Edit`, or `Write` tools on `~/.cyrus/.env` or any file inside `~/.cyrus/`. This file contains secrets (API keys, tokens, signing secrets). All interaction with this file MUST go through `Bash` commands (`grep`, `printf >> ...`, etc.) which the user can see and approve. Never read its contents into the conversation context.

### Browser Automation

The goal of browser automation in this skill is to **reduce sign-in and setup fatigue** — the agent navigates web UIs, fills forms, and scrapes credentials so the user doesn't have to do it all manually.

**Three modes, in order of preference:**

1. **`claude-in-chrome`** (preferred when available) — if the user is running Claude Code and has the `claude-in-chrome` MCP extension connected, use it. This has the huge advantage of using the user's existing Chrome with all their signed-in sessions (Linear, Slack, GitHub). Check availability by seeing if `mcp__claude-in-chrome__*` tools exist.
2. **`agent-browser` CLI** — a standalone Playwright-based binary invoked via `Bash`. Requires launching a **fresh Chrome profile** with remote debugging enabled (the user will need to sign in to services in that profile). Check with `which agent-browser`.
3. **Manual guided flow** — the user follows the agent's step-by-step instructions and does the clicks themselves. Always available as Path B in each sub-skill.

**Determining which mode to use:**

1. First, check if `claude-in-chrome` MCP tools are available in the current session. If yes, use those — no setup needed.
2. If not, check `which agent-browser`. If installed, launch a fresh Chrome profile (see below).
3. If neither is available, ask the user: install `agent-browser`, or follow manual instructions?

**`agent-browser` setup — fresh Chrome profile:**

`agent-browser` needs a Chrome instance with remote debugging enabled. Launch one with an isolated profile:

```bash
# Find an open port
for port in $(seq 9222 9322); do
  if ! lsof -i :"$port" > /dev/null 2>&1; then
    echo "Open port found: $port"
    break
  fi
done
```

```bash
# Create a fresh profile directory
mkdir -p ~/.cyrus/chrome-profile
```

```bash
# Launch Chrome with remote debugging (runs in background)
# macOS:
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=<port> \
  --user-data-dir="$HOME/.cyrus/chrome-profile" &

# Linux:
google-chrome --remote-debugging-port=<port> \
  --user-data-dir="$HOME/.cyrus/chrome-profile" &
```

```bash
# Connect agent-browser to it
agent-browser connect <port>
```

After connecting, commands work normally:

```bash
agent-browser navigate "https://example.com"
agent-browser click "button:text('Submit')"
agent-browser fill "#input-id" "value"
agent-browser screenshot
agent-browser eval "document.title"
```

**Important:** The user will need to **sign in to Linear, Slack, and GitHub** in this fresh Chrome profile before the agent can automate app creation. The agent should navigate to each service and pause for the user to sign in before proceeding with automation.

**Cleanup:** After setup is complete, close the Chrome instance:

```bash
lsof -ti :<port> | xargs kill 2>/dev/null
```

## How This Works

This skill runs sub-skills in order, skipping any that are already complete. You can re-run `/cyrus-setup` at any time to add integrations or fix configuration.

> **Two topologies.** The Steps below set up **single-host** Cyrus: one machine
> receives webhooks *and* runs every session under one identity. If instead you
> want **router mode** — sessions run on each teammate's own machine with their
> native credentials, behind a shared always-on router — jump to
> [Router Mode Setup](#router-mode-setup-split-host--device) at the end of this
> skill. Full reference: `docs/ROUTER.md`.

### Loading Sub-Skills

Each step references a sub-skill file. To execute a sub-skill, **read the SKILL.md file** using the `Read` tool and follow its instructions. The sub-skill files are sibling directories to this skill:

| Step | Sub-skill | File to read |
|------|-----------|-------------|
| 1 | setup-prerequisites | `cyrus-setup-prerequisites/SKILL.md` (relative to skills directory) |
| 2 | setup-claude-auth | `cyrus-setup-claude-auth/SKILL.md` |
| 3 | setup-endpoint | `cyrus-setup-endpoint/SKILL.md` |
| 4 | setup-linear | `cyrus-setup-linear/SKILL.md` |
| 5 | setup-github | `cyrus-setup-github/SKILL.md` |
| 5b | setup-gitlab | `cyrus-setup-gitlab/SKILL.md` |
| 6 | setup-slack | `cyrus-setup-slack/SKILL.md` |
| 7 | setup-repository | `cyrus-setup-repository/SKILL.md` |
| 8 | setup-launch | `cyrus-setup-launch/SKILL.md` |

To find the files, look for them relative to this file's directory (go up one level, then into the sub-skill directory). For example, if this file is at `~/.claude/skills/cyrus-setup/SKILL.md`, the sub-skills are at `~/.claude/skills/cyrus-setup-prerequisites/SKILL.md`, etc.

If a sub-skill file is not found, use `Glob` to search for it: `**/cyrus-setup-prerequisites/SKILL.md`

---

## Step 0: Identity & Surface Selection

Before anything else, collect preferences from the user. **Use the `AskUserQuestion` tool if available** — ask questions interactively rather than printing them as a text block. You may bundle related questions into a single ask, or ask them one at a time.

### Question 1: Name & Description

Ask the user (defaults in parentheses):

- **What would you like to name your agent?** — This name appears in Linear, Slack, and GitHub integrations. (default: `Cyrus`)
- **Give your agent a short description** — one sentence, shown in integration app listings. (default: `AI coding agent for automated development`)

Store as `AGENT_NAME` and `AGENT_DESCRIPTION` — used when creating Linear, Slack, and GitHub apps.

### Question 2: Which surfaces?

Ask the user to select one or more:

- **Linear** — issue tracking, recommended for most users
- **GitHub** — PR comments and issues
- **GitLab** — MR comments and issues
- **Slack** — chat messages

At least one is required. Store the selection — it determines which integration sub-skills run (Steps 4-6).

### Question 3: Package manager?

Ask: **npm, pnpm, bun, or yarn?**

Store the answer — used by the prerequisites skill.

---

## Step 1: Prerequisites

**Read** the `cyrus-setup-prerequisites/SKILL.md` sub-skill and follow its instructions.

Pass the user's package manager preference from Step 0.

---

## Step 2: Claude Auth

**Read** the `cyrus-setup-claude-auth/SKILL.md` sub-skill and follow its instructions.

---

## Step 3: Webhook Endpoint

**Read** the `cyrus-setup-endpoint/SKILL.md` sub-skill and follow its instructions.

---

## Step 4: Linear (if selected)

**Only if the user selected Linear in Step 0.**

**Read** the `cyrus-setup-linear/SKILL.md` sub-skill and follow its instructions.

---

## Step 5: GitHub (if selected)

**Only if the user selected GitHub in Step 0.**

**Read** the `cyrus-setup-github/SKILL.md` sub-skill and follow its instructions.

---

## Step 5b: GitLab (if selected)

**Only if the user selected GitLab in Step 0.**

**Read** the `cyrus-setup-gitlab/SKILL.md` sub-skill and follow its instructions.

---

## Step 6: Slack (if selected)

**Only if the user selected Slack in Step 0.**

**Read** the `cyrus-setup-slack/SKILL.md` sub-skill and follow its instructions. **All paths (A-1, A-2, and B) must use the manifest-based creation flow** — never create the Slack app "from scratch" with manual scope/event configuration.

---

## Step 7: Add Repositories

**Read** the `cyrus-setup-repository/SKILL.md` sub-skill and follow its instructions.

---

## Step 8: Launch

**Read** the `cyrus-setup-launch/SKILL.md` sub-skill and follow its instructions.

---

## Router Mode Setup (split host + device)

Use this instead of single-host mode when each teammate should run their own
sessions locally (native `az`/`gh`/SSH/Claude credentials), coordinated by one
always-on router. There are **two roles** — set up the host once, then each
device once. Full reference and rationale live in `docs/ROUTER.md`.

Which role am I setting up?

- **Router host** — the shared always-on machine that receives Linear webhooks
  and coordinates everyone. Follow **Path H**.
- **Client device** — a teammate's own laptop/workstation that runs their
  sessions. Follow **Path C**.

### Path H — Router host

Prereqs are the same Linear OAuth app + public webhook URL as single-host: run
**Steps 1–4** above (prerequisites, Claude auth, endpoint, Linear) to obtain the
workspace Linear token and webhook secret. Then, instead of Steps 5–8:

1. **Write `~/.cyrus/router-config.json`.** Do NOT read/write files under
   `~/.cyrus/` directly (secrets) — write it via a `Bash` heredoc the user can
   review, e.g.:

   ```bash
   cat > ~/.cyrus/router-config.json <<'JSON'
   {
     "port": 8787,
     "workspaces": {
       "<linear-organization-id>": { "linearToken": "<workspace-linear-token>" }
     },
     "webhook": { "verificationMode": "direct", "secret": "<linear-webhook-secret>" }
   }
   JSON
   chmod 600 ~/.cyrus/router-config.json
   ```

   Optional keys: `eventTtlMs` (default 48h), `issueLock` (default `true`),
   `creatorOnlyPrompting` (default `true`), `heartbeatMs`, `host`. See
   `docs/ROUTER.md` for the field table.

2. **Start the router** (put it behind a process manager + TLS reverse proxy so
   devices can dial `wss://`):

   ```bash
   cyrus router start
   ```

3. **Enroll each teammate — one `users add` per person.** Each call prints a
   **one-time, 15-minute** enrollment code; hand it to that teammate out-of-band
   with the router URL:

   ```bash
   cyrus router users add alice@example.com --name "Alice"
   ```

   Management: `cyrus router users list|remove <email>`,
   `cyrus router devices revoke <email>`, `cyrus router unlock <issueId>`.

### Path C — Client device

On the teammate's own machine (no Linear app, no webhook/tunnel setup needed):

1. **Prerequisites + Claude auth.** Run **Steps 1–2** above only.

2. **Connect to the router** using the code from the admin (`<url>` is the
   router's HTTP(S) origin; the CLI derives `ws://`/`wss://`):

   ```bash
   cyrus connect https://router.example.com --code <enrollment-code>
   ```

   This writes `platform: "router"` + a `0600` device token into `config.json`.
   The code is single-use.

3. **Install + OAuth the official Linear MCP locally, and verify auth health
   now.** In router mode Cyrus does NOT configure the app-token Linear MCP — the
   agent's own Linear tool use runs through the teammate's **own** locally-OAuth'd
   Linear MCP so actions are attributed to them and scoped to their real Linear
   permissions. Complete the one-time interactive browser OAuth at connect time:
   a headless session cannot complete a browser flow, so expired/missing auth
   must surface **at connect / session start**, not mid-run. Confirm the MCP
   reports healthy auth before continuing; re-run the OAuth if it has expired.

4. **Add repositories** (Step 7 above) and **launch** with `cyrus start`. The
   device dials the router and begins running the sessions this teammate creates
   in Linear.

---

## Design Principles

1. **Skip-if-done** — Every sub-skill checks existing state first. Re-running `/setup` is safe.
2. **Secrets never enter chat** — Credentials are either scraped via agent-browser or written via clipboard-to-env shell commands the user runs in their terminal.
3. **Agent writes non-secret config** — Values like `CYRUS_SERVER_PORT` and `LINEAR_DIRECT_WEBHOOKS` are written directly by the agent.
4. **Browser automation when available** — Uses `agent-browser` for Linear/Slack app creation; falls back to guided manual steps if not installed.
5. **Package manager aware** — The user's choice is used consistently throughout.
