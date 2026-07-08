# Cyrus Setup — Three Deployment Modes (design)

**Date:** 2026-07-09
**Status:** Approved for planning
**Scope:** Installation skills under `skills/` + sync of `docs/ROUTER.md` and
`docs/SELF_HOSTING.md`.

## Problem

The router feature (`packages/router`, `packages/router-client`,
`cyrus router`/`cyrus connect` CLI commands) has shipped, but the installation
skills still only walk a user through **single-host** setup. Router topology is
tacked on as an appendix ("Router Mode Setup (split host + device)") at the end
of `skills/cyrus-setup/SKILL.md`, with two paths (Path H, Path C) that are easy
to miss and are not offered as a first-class choice.

Users should be asked, up front, which of three deployment modes they want, and
then be walked through exactly the steps that mode needs — nothing more.

## The three modes

| Mode | Meaning | Auth it sets up |
|------|---------|-----------------|
| **Standalone** (single-host, default) | One machine receives webhooks *and* runs every session under one identity. Today's flow. | Linear (OAuth app + webhook) + GitHub (CLI + optional App/webhooks) + Claude Code + public tunnel |
| **Router host** | Always-on coordinator. Receives Linear webhooks and routes each session to the owning teammate's device over an authenticated WebSocket. **Never runs Claude. Never touches GitHub.** | Linear (OAuth app + webhook) + public tunnel. Writes `router-config.json`, starts `cyrus router`, enrolls teammates. |
| **Client device** | A teammate's own machine that runs *their* sessions locally with *their* native credentials. | Claude Code + GitHub CLI (native `gh` + git identity, for pushing/PRs) + local official Linear MCP (OAuth'd as them) + `cyrus connect` to the router. **No Linear OAuth app, no tunnel, no GitHub App/webhook.** |

### Architecture facts this design is built on (verified against code)

- `packages/router` has **zero GitHub handling** — it routes Linear only. So the
  router host never needs GitHub. Git push/PR happens on each client device with
  that person's own `gh` credentials.
- The router serves the Linear webhook at the **same `/linear-webhook` path** as
  single-host (it reuses `LinearIssueTrackerService.createEventTransport` with
  `platform: "linear"`), just on the **router's own port** (default `8787`,
  configurable via `router-config.json` `port`).
- `cyrus self-auth-linear` writes the workspace token to `config.json`
  (`linearWorkspaces[wsId].linearToken`). `router-config.json` needs the same
  value at `workspaces[orgId].linearToken`, plus the webhook signing secret at
  `webhook.secret`. The router-mode Linear step therefore reuses the standard
  OAuth-app + `self-auth-linear` flow and transplants those two values into
  `router-config.json`.
- `cyrus connect <url> --code <code>` writes `platform: "router"` +
  `router: { url, deviceToken }` (mode `0600`) into `config.json`.

## Chosen approach

**Mode-select entry point + dedicated sub-skills**, with light reuse tweaks to
two shared sub-skills. (Selected over "inline branches" and "three independent
top-level skills"; and over "fully self-contained new sub-skills".)

- `cyrus-setup` becomes the single entry point. Its first action is a mode
  question; standalone continues inline, router/client dispatch to new
  sub-skills.
- Two new sub-skills: `cyrus-setup-router`, `cyrus-setup-client`.
- Existing sub-skills are reused. Two get small, backward-compatible tweaks
  (`cyrus-setup-endpoint`, `cyrus-setup-launch`); the rest are reused as-is.

## Detailed design

### 1. `skills/cyrus-setup/SKILL.md` (orchestrator)

- Add a new **Step -1: Choose deployment mode** *before* today's "Step 0:
  Identity & Surface Selection", using `AskUserQuestion`. Present the three
  modes with the one-line meanings from the table above; **Standalone** is the
  default/recommended.
  - **Standalone** → continue with the existing Step 0 → Step 8 flow, unchanged.
  - **Router host** → "Read `cyrus-setup-router/SKILL.md` and follow it," then
    stop (do not run Steps 0–8).
  - **Client device** → "Read `cyrus-setup-client/SKILL.md` and follow it," then
    stop.
- Rewrite the top-of-file **"Two topologies"** note into a **"Three modes"**
  note that points at the mode question.
- **Remove** the entire "Router Mode Setup (split host + device)" appendix
  (Path H + Path C). Its content is promoted into the two new sub-skills (and
  the incorrect "run … Claude auth" instruction in old Path H is dropped — the
  router never runs Claude).
- Add the two new sub-skills to the "Loading Sub-Skills" table.
- The CRITICAL rules and Browser Automation sections at the top are shared and
  stay as-is (both new sub-skills rely on them).

### 2. New `skills/cyrus-setup-router/SKILL.md`

Front-matter `name: cyrus-setup-router`, description one-liner. Same "never
read/write `~/.cyrus/` files directly — Bash only" CRITICAL banner as the other
sub-skills. Steps:

1. **Prerequisites** — Read/run `cyrus-setup-prerequisites` (node, jq, cyrus-ai;
   note `gh` is not required for a router host).
2. **Endpoint / tunnel** — Read/run `cyrus-setup-endpoint` in **router variant**:
   tunnel upstream points at the **router port** (default `8787`), and it writes
   only `CYRUS_BASE_URL` (needed by the Linear step) — not the single-host server
   vars. (See tweak in §4.) Explain this URL is used both for the Linear webhook
   and, behind TLS, for devices to dial `wss://`.
3. **Linear OAuth app** — Read/run `cyrus-setup-linear` (webhook URL
   `<CYRUS_BASE_URL>/linear-webhook`, callback `<CYRUS_BASE_URL>/callback`), then
   `cyrus self-auth-linear` to obtain the workspace token.
4. **Write `~/.cyrus/router-config.json`** (new, router-specific) — via a Bash
   heredoc the user can review (never Read/Edit/Write a file under `~/.cyrus/`
   directly). Populate `port`, `workspaces[<org-id>].linearToken` (transplanted
   from `config.json` `linearWorkspaces`), and
   `webhook: { verificationMode: "direct", secret: <LINEAR_WEBHOOK_SECRET> }`.
   `chmod 600`. Document optional keys with defaults (`eventTtlMs`, `issueLock`,
   `creatorOnlyPrompting`, `heartbeatMs`, `host`).
5. **Start the router** — `cyrus router start`; guidance on a process manager
   (pm2/systemd) and a TLS-terminating reverse proxy so devices reach
   `wss://router.example.com`.
6. **Enroll teammates** — `cyrus router users add <email> [--name]` prints a
   one-time 15-minute code; hand it out with the router URL. List management
   commands: `users list/remove`, `devices revoke <email>`, `unlock <issueId>`.

Explicitly **not** in this flow: Claude auth, GitHub, repository config, launch
of a single-host `cyrus`.

### 3. New `skills/cyrus-setup-client/SKILL.md`

Front-matter `name: cyrus-setup-client`, description one-liner, same CRITICAL
banner. Steps:

1. **Prerequisites** — Read/run `cyrus-setup-prerequisites` (node, jq, `gh`,
   cyrus-ai).
2. **Claude auth** — Read/run `cyrus-setup-claude-auth` unchanged.
3. **GitHub CLI + git identity** — Read/run `cyrus-setup-github` **Part A only**
   (`gh auth login` + `git config` name/email). Instruct to **stop before
   Part B** (App/webhooks); inbound GitHub events are the standalone/router
   host's concern, not the device's.
4. **Connect to the router** — `cyrus connect <url> --code <code>` (the admin
   provides both). Note the code is single-use; success writes `platform:
   "router"` + a `0600` device token into `config.json`.
5. **Local official Linear MCP** (new) — install the official Linear MCP and
   complete the interactive browser OAuth **now**, at connect time; verify auth
   health. Rationale: agent Linear tool use is attributed to the teammate via
   their own OAuth, and a headless session can't complete a browser flow, so
   expiry must surface here, not mid-run.
6. **Add repositories** — Read/run `cyrus-setup-repository` unchanged.
7. **Launch** — `cyrus start`; reuse `cyrus-setup-launch` in **client variant**
   (skip ngrok, router-oriented summary). (See tweak in §4.)

Explicitly **not** in this flow: Linear OAuth app creation, endpoint/tunnel,
GitHub App/webhooks.

### 4. Light tweaks to shared sub-skills

- **`skills/cyrus-setup-endpoint/SKILL.md`** — accept an optional **target
  upstream port** (default `3456`; router passes `8787`). Use it in the ngrok
  `upstream.url`, the Cloudflare/own-URL guidance, and the "start ngrok"
  messaging. Add a short **router-variant note**: in router mode write only
  `CYRUS_BASE_URL`, and skip the single-host common vars in Step 4
  (`CYRUS_SERVER_PORT`, `LINEAR_DIRECT_WEBHOOKS`, `CYRUS_HOST_EXTERNAL`) since
  the router reads `router-config.json`. Default behavior (no port passed,
  standalone) is unchanged.
- **`skills/cyrus-setup-launch/SKILL.md`** — add a **client-mode branch**: skip
  the "Start ngrok" step, run `cyrus start` (device dials the router), and print
  a router-connection summary (router URL + "connected") instead of the
  Linear/GitHub/Slack surface summary. Standalone behavior is unchanged. The
  pm2/systemd persistence blocks are shared by both.

Reused **as-is** (no edits): `cyrus-setup-prerequisites`,
`cyrus-setup-claude-auth`, `cyrus-setup-github` (Part A invoked by client),
`cyrus-setup-repository`.

### 5. Docs sync

- **`docs/ROUTER.md`** — update the admin/device setup sections to reference the
  new mode-select flow (`/cyrus-setup` → "Router host" / "Client device") as the
  guided path, keeping the manual CLI reference. Ensure GitHub-on-client (native
  `gh`) is stated for the device role.
- **`docs/SELF_HOSTING.md`** — note that `/cyrus-setup` now offers three modes;
  cross-link `docs/ROUTER.md` for the router/client modes.

## Out of scope

- No code changes to `packages/*` or `apps/*`. This is a skills + docs change.
- No new CLI commands — `cyrus router …` and `cyrus connect …` already exist.
- No live worktree sync or GitHub-webhook routing on the router (not implemented;
  the git remote remains the cross-device sync layer per `docs/ROUTER.md`).

## Success criteria

- Running `/cyrus-setup` first asks which of the three modes to set up.
- **Standalone** produces exactly today's outcome (regression-safe).
- **Router host** ends with `router-config.json` written, `cyrus router start`
  running behind a tunnel, and at least one teammate enrollable — and never
  prompts for Claude auth or GitHub.
- **Client device** ends with Claude auth, native `gh`/git configured, a local
  OAuth'd Linear MCP verified healthy, `cyrus connect` done, repositories added,
  and `cyrus start` running — and never prompts to create a Linear OAuth app,
  tunnel, or GitHub App.
- `cyrus-setup-endpoint` and `cyrus-setup-launch` remain backward-compatible when
  invoked with no mode/port (standalone).
- `docs/ROUTER.md` and `docs/SELF_HOSTING.md` reference the three-mode flow.
