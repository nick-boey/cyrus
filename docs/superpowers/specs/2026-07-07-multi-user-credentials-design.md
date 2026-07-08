# PRD: Per-User Credentials for Cyrus Sessions

**Date:** 2026-07-07 (revised 2026-07-08 after adversarial review)
**Status:** Approved — revised per Codex GPT-5.5 adversarial review (session 019f3a75-1e6f-7843-904a-af4023d17452); see §13
**Scope decision:** Implemented in this fork of Cyrus (additive, upstream-friendly changes), not as a separate application.

## 1. Problem Statement

Cyrus currently authenticates every AI runner and GitHub operation with a single set of
credentials loaded once from `~/.cyrus/.env` into `process.env` at boot
(`apps/cli/src/app.ts`, `packages/claude-runner/src/session-env.ts`). Every session —
regardless of which Linear user triggered it — runs as the same Claude account, the same
Codex account, and the same GitHub identity.

For a team sharing one Cyrus deployment this means:

- Claude/Codex usage cannot use each team member's individual subscription seat, and
  cannot be attributed to the person who requested the work.
- Nested-CLI workflows break identity expectations: when a Claude Code session invokes
  the Codex CLI (e.g. for an automated review pass), Codex authenticates as whatever
  global account happens to be configured, not as the user who kicked off the session.
- Git commits and PRs are authored by a shared bot identity rather than the requesting
  user.

## 2. Goals

1. When a Linear user starts or is assigned an agent session, the session runs with
   **that user's** credentials for Claude Code, the Codex CLI, and GitHub.
2. Credentials cascade to child processes: a Codex CLI invoked from inside a Claude
   session authenticates as the session's user.
3. Git work carries the user's full identity: pushes/PRs use their GitHub PAT, and
   commits set their author name/email.
4. Users who have not registered credentials are **blocked** with a helpful Linear
   message explaining how to register.
5. Registration happens via a CLI command run on the Cyrus host (`cyrus users add`).
6. Changes are additive and isolated so they can be proposed upstream and rebased
   cheaply.

## 3. Non-Goals

- **Containers.** Per-session environment injection solves the auth problem without a
  container runtime (see §5). Container isolation may be revisited later as a separate
  concern (isolation strength / reproducible environments), and nothing in this design
  precludes it.
- **Per-user Linear tokens.** Cyrus's Linear workspace OAuth token remains app-level;
  activities are still posted as the Cyrus agent. Only the *work* (AI inference, git,
  GitHub) is per-user.
- **Gemini / Cursor runners.** The registry schema leaves room, but v1 wires only
  Claude, Codex, and GitHub.
- **Web UI for registration**, credential encryption at rest beyond file permissions,
  and cross-user filesystem isolation (all users are in the same organisation; see §9).
- **Non-Linear entry points** (Slack chat, GitHub webhook-triggered sessions) keep
  today's global-credential behavior in v1 (see §11 Open Questions).

## 4. Background: How Credentials Flow Today

| Concern | Today | Key code |
|---|---|---|
| Claude auth | `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN` from global `~/.cyrus/.env`, forwarded into every session | `packages/claude-runner/src/session-env.ts:12-16,48-73`; merged in `ClaudeRunner.ts:670-683` |
| Codex auth | `OPENAI_API_KEY` env or ChatGPT-subscription `auth.json` under `CODEX_HOME` (default `~/.codex`) | `packages/codex-runner/src/config/CodexConfigBuilder.ts:96-116,161-208` |
| GitHub (bot ops) | Proxy-forwarded installation token → self-minted GitHub App token → `GITHUB_TOKEN` PAT | `EdgeWorker.resolveGitHubToken()` (`EdgeWorker.ts:1190-1205`) |
| GitHub (session work) | `gh` CLI / git credentials from inherited global env | `cyrus-setup-github` skill; no per-session override |
| Triggering user | Already parsed from webhook: `webhook.agentSession.creator` (id/email/name) — but only used for allow/block access control | `EdgeWorker.ts:6607-6622`, `UserAccessControl.ts:99-152` |
| Per-session env seam | `ClaudeRunnerConfig.additionalEnv` merged last over the base env; `buildBaseSessionEnv(extra?)` accepts an override arg no caller uses yet | `claude-runner/src/types.ts:53-54`, `session-env.ts:48-49` |

Two facts make this feature tractable without containers:

1. **Environment variables are per-process, and child processes inherit them.** Each
   `ClaudeRunner` session already gets its own env. A Codex CLI spawned via the Bash
   tool inside that session inherits `CODEX_HOME`, `GH_TOKEN`, etc.
2. **The identity signal already exists.** `agentSession.creator` arrives on every
   AgentSessionEvent webhook; it just isn't threaded into runner config assembly.

## 5. Options Considered

### 5.1 Execution environment

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. Per-session env injection** (chosen) | Smallest change; reuses existing `additionalEnv` seam; worktrees unchanged; nested CLIs (Codex) inherit identity automatically; compatible with existing OS sandbox + egress proxy | Credentials of all users readable on the shared host by anyone with shell access or by another user's session via Bash (acceptable: same-org trust; mitigable later via sandbox `denyRead`) | ✅ Chosen |
| B. Container per session | Strong isolation; reproducible toolchains; per-container credential mounts | Large build: image management, lifecycle, resource limits; git worktrees embed an **absolute path** to the parent repo's `.git` dir, so `~/.cyrus` must be mounted at an identical path inside the container (or switch to full clones); Cyrus's OS sandbox (Seatbelt/bubblewrap) and egress-proxy features don't carry over directly; slower session start | ❌ Rejected for v1 — solves a problem (isolation) we don't have yet, not the problem we do have (auth) |
| C. Egress-proxy credential brokering | Tokens never enter the session env (proxy injects per-domain auth headers); the `NetworkPolicy` header-transform machinery already exists | Only intercepts Bash-subprocess traffic — **not** Claude's own inference calls, MCP, or SDK-internal requests, so it cannot carry the primary Claude/Codex auth; requires sandbox+MITM always on | ❌ Rejected as primary mechanism; possible future hardening layer |

### 5.2 Where to implement

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **A. In this fork of Cyrus** (chosen) | The injection seam is internal to `edge-worker` (`buildAgentRunnerConfig` → `RunnerConfigBuilder.buildIssueConfig`); changes are additive (~1 new service, 1 schema field, 1 threaded parameter, 1 CLI subcommand); upstreamable; low rebase burden | Fork must track upstream until/unless merged | ✅ Chosen |
| B. Separate app on Cyrus packages | Clean separation from upstream | `edge-worker` *is* the application — webhook handling, repo routing, session management, activity posting, and config assembly are not exposed as extension points; a separate app would reimplement or vendor most of it, then still need to patch the same internal seam | ❌ Rejected — strictly more work for the same result |

### 5.3 Upstream landscape (surveyed 2026-07-07)

A sweep of `cyrusagents/cyrus` issues, PRs, and branches found **no existing or planned
per-user credential routing** — this feature does not exist upstream. Relevant context:

- **[Issue #138](https://github.com/cyrusagents/cyrus/issues/138)** (closed): two
  teammates asked for exactly this (own Claude Max subscription + GitHub account under
  one Cyrus). Closed without a feature — the sanctioned workaround was running a fully
  separate Cyrus instance per person. Confirms both the demand and the gap.
- **[PR #1307](https://github.com/cyrusagents/cyrus/pull/1307)** (open): multi-**org**
  GitHub credentials — adds a `GitHubTokenStore`, a git credential helper, and
  per-session `GH_TOKEN`, keyed by repository org. Touches the same code
  (`resolveGitHubToken`, `RunnerConfigBuilder`) as this design. If it merges, the
  per-user GitHub PAT should flow through that token store rather than a parallel
  mechanism. Watch before implementing §6.7. ([PR #1311](https://github.com/cyrusagents/cyrus/pull/1311)
  generalizes the same store to GitLab.)
- **[PR #1229](https://github.com/cyrusagents/cyrus/pull/1229)** (open, ~12k lines):
  sandboxed agent runtime with per-session state dirs — already plumbs
  `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `CURSOR_DATA_DIR`, `GEMINI_CLI_HOME` per session
  binding. Its `bindingId` is not tied to Linear-user identity, but it validates the
  env-var mechanism this design relies on, and would be the natural substrate if
  containers are revisited later (as would [PR #1007](https://github.com/cyrusagents/cyrus/pull/1007),
  a community per-issue container proposal).
- **[PR #790](https://github.com/cyrusagents/cyrus/pull/790)** (open): pushes toward a
  single shared `cyrusagent` committer identity — a design tension with the "full git
  identity" decision below. Fine for the fork; flag it if upstreaming.
- **[PR #779](https://github.com/cyrusagents/cyrus/pull/779)** (merged):
  `userAccessControl` allow/block lists — this design composes with it (§6.5) rather
  than duplicating the "which Linear user" dimension.

### 5.4 Decisions locked in with the product owner

| Question | Decision |
|---|---|
| Claude auth type | Personal Claude subscriptions — each user registers a long-lived `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token` |
| Codex auth type | ChatGPT subscription — each user's `auth.json` lives in a per-user `CODEX_HOME` (required: Codex rotates the refresh token and rewrites `auth.json` in place) |
| Execution environment | Env injection only; no containers |
| Unregistered user | Block the session and post a Linear message with registration instructions |
| Registration UX | `cyrus users add` CLI on the host |
| Git identity | Push/PR auth is always the user's PAT. Commit **authorship is configurable** per deployment: `user` mode (default) sets `GIT_AUTHOR_*`/`GIT_COMMITTER_*` to the requesting user; `shared` mode attributes commits to a global "Cyrus agent" identity |
| Runner scope v1 | Claude + Codex + GitHub (Gemini/Cursor later) |

## 6. Design

### 6.1 Directory layout

```
~/.cyrus/users/
  alice/                      # slug chosen at registration
    .env                      # chmod 600 — CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN
    codex/                    # per-user CODEX_HOME
      auth.json               # imported from the user's machine; rewritten by Codex on token refresh
    claude/                   # optional per-user CLAUDE_CONFIG_DIR (state isolation)
```

### 6.2 Config schema (`packages/core/src/config-schemas.ts`)

New top-level `EdgeConfig` field — credentials themselves stay **out** of `config.json`;
only the mapping and non-secret identity live here:

```jsonc
"users": [
  {
    "linearUser": { "email": "alice@org.com" },   // reuses existing UserIdentifier (id or email)
    "credentialsDir": "~/.cyrus/users/alice",
    "gitAuthor": { "name": "Alice Example", "email": "alice@org.com" }
  }
],
"gitCommitAuthor": {
  "mode": "user",                                  // "user" (default) | "shared"
  "shared": { "name": "Cyrus Agent", "email": "cyrus@org.com" }  // used when mode = "shared"
}
```

Follows the precedent set by `linearWorkspaces` (keyed credential-map pattern,
`config-schemas.ts:260-267`).

`gitCommitAuthor` controls commit **authorship** only — push/PR **auth** is always the
session user's PAT. In `shared` mode with `shared` omitted, no author env is injected
and the host's global git config applies (today's behavior).

### 6.3 Resolution: `UserCredentialResolver` (new, `packages/edge-worker/src/`)

- `resolve(creator: { id?, email? }) → UserCredentialProfile | null`
- Matches `agentSession.creator` against `users[]` by id first, then email
  (case-insensitive), mirroring `UserAccessControl` semantics.
- Loads `<credentialsDir>/.env` and produces an env bundle:

```
CLAUDE_CODE_OAUTH_TOKEN=<user's token>
CODEX_HOME=<credentialsDir>/codex
GH_TOKEN=<user's PAT>            # gh CLI + gh-as-git-credential-helper
GITHUB_TOKEN=<user's PAT>        # tools that read the older name
GIT_AUTHOR_NAME / GIT_AUTHOR_EMAIL / GIT_COMMITTER_NAME / GIT_COMMITTER_EMAIL
                                 # source depends on gitCommitAuthor.mode:
                                 #   "user"   → profile.gitAuthor
                                 #   "shared" → gitCommitAuthor.shared (omitted → not injected)
CLAUDE_CONFIG_DIR=<credentialsDir>/claude   # if the dir exists
```

### 6.4 Injection path

1. `handleAgentSessionCreatedWebhook` (`EdgeWorker.ts:4234`) already reads
   `webhook.agentSession.creator` (`:6607-6610`). Thread the creator through
   `buildAgentRunnerConfig` (`EdgeWorker.ts:6426`) into
   `RunnerConfigBuilder.buildIssueConfig` (`RunnerConfigBuilder.ts:303`).
2. `RunnerConfigBuilder` merges the profile's env bundle into the runner config:
   - Claude: `additionalEnv` (merged last in `ClaudeRunner.ts:677-678`).
   - Codex-as-primary-runner: set `codexHome` (already supported,
     `CodexConfigBuilder.ts:96-101`).
3. **Auth-key precedence fix:** `buildBaseSessionEnv()` re-forwards the *global*
   `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_AUTH_TOKEN` from
   `process.env`, and a plain object-spread merge cannot *delete* keys. Because
   `ANTHROPIC_API_KEY` takes precedence inside Claude Code, a stale global API key would
   silently shadow the injected per-user OAuth token. Extend `buildBaseSessionEnv`
   (its unused `extra` arg / a new option) to **omit global auth keys when a per-user
   profile is active**, so the session env contains exactly one Claude credential.
4. **All runner instantiation sites** must receive the profile — including the
   `simple-agent-runner` variants used for subroutines/summaries (audit call sites at
   `EdgeWorker.ts:1533, 2210, 4571, 7283`). A summary call running with no/global
   credentials would break mid-session for a registered user.
5. **Credentials follow the session creator.** If a different user prompts an existing
   session mid-flight, the session keeps the creator's credentials (documented
   behavior; revisit if it surprises people).

### 6.5 Blocking unregistered users

In the same place `UserAccessControl.checkAccess` runs today
(`EdgeWorker.ts:6603-6622`): if multi-user mode is enabled (i.e. `users[]` is
non-empty) and the creator resolves to no profile, do not start the session; post an
activity/comment using the existing block-message templating
(`EdgeWorker.ts:6647-6649`) with registration instructions
(“ask your Cyrus admin to run `cyrus users add` …”).

### 6.6 Warm sessions

Warm/pre-spawned Claude sessions (`ClaudeRunner.ts:770-772`) launch with global env
*before* the creator is known, so an already-warm process cannot receive per-user
credentials. **v1: disable warm sessions when `users[]` is configured** (log a clear
notice). A per-user warm pool is a possible later optimization.

### 6.7 GitHub identity details

- One-time host setup: `gh auth setup-git` so git uses `gh` as its credential helper;
  thereafter the per-session `GH_TOKEN` drives push identity with no further git
  config.
- `EdgeWorker.resolveGitHubToken()` (bot replies/reactions on PRs) intentionally stays
  on the app-level token — that is Cyrus-the-app's voice, distinct from the user's
  work.
- PRs created via `gh pr create` inside a session open under the user's account;
  commit authorship follows `gitCommitAuthor.mode` (§6.2) — the user's identity by
  default, or a global "Cyrus agent" identity when the deployment prefers a single
  bot author (which also dissolves the tension with upstream PR #790).

### 6.8 Registration CLI (`apps/cli`)

```
cyrus users add       # interactive: Linear email, git author name/email,
                      #   Claude OAuth token, GitHub PAT, path to codex auth.json
cyrus users list      # show registered users (no secrets)
cyrus users remove <email>
```

`add` creates `~/.cyrus/users/<slug>/` (dirs `codex/`, `claude/`), writes `.env` with
`chmod 600`, copies the supplied `auth.json` into `codex/`, and appends the entry to
`config.json` `users[]`. Slug derived from the email local-part, de-duplicated.

What each user runs **on their own machine** to produce the secrets:
- `claude setup-token` → long-lived `CLAUDE_CODE_OAUTH_TOKEN`
- `codex login` → `~/.codex/auth.json` (then securely copy to the host)
- GitHub → fine-grained PAT with repo read/write + PR scopes

## 7. Implementation Gotchas (repo-specific, from CLAUDE.md)

1. **New top-level `EdgeWorkerConfig` fields** (`users` **and** `gitCommitAuthor`)
   require updating **both** `ConfigManager.loadConfigSafely()`'s hardcoded merge
   whitelist and the `globalKeys` array in `detectGlobalConfigChanges()`
   (`packages/edge-worker/src/ConfigManager.ts`) — otherwise they are silently dropped
   on config reload.
2. **`credentialsDir` is path-bearing with a `~/` prefix.** It must go through
   `resolvePath` in `EdgeWorker.normalizeConfigPaths()` (constructor + `configChanged`)
   or self-host sessions will crash with `ENOENT: ... '~/.cyrus/...'`.
3. **Auth-key shadowing** (§6.4.3): merge order alone is insufficient; global auth keys
   must be *omitted*, not just overridden.
4. **Codex `auth.json` write contention:** two concurrent sessions for the same user can
   both trigger a token refresh and race on rewriting `auth.json`. Low likelihood;
   note in docs, revisit if observed (per-session copy-on-start is a cheap fix).
5. **`RunnerSelectionService.getDefaultRunner`** auto-detects available providers from
   global env (`:32-43`); with global keys removed in favor of per-user ones, detection
   should also consider whether `users[]` is configured.

## 8. Failure Modes & Handling

| Failure | Behavior |
|---|---|
| Creator has no registered profile | Session blocked; Linear message with registration instructions (§6.5) |
| Profile exists but `.env` missing/unreadable | Treat as unregistered; block with a message naming the missing file (admin-facing detail in logs) |
| User's Claude token expired/revoked | Session starts and fails at first inference; the existing error-activity path posts the provider error to Linear. Registration doc tells users to re-run `claude setup-token` and `cyrus users add` (idempotent update) |
| Codex `auth.json` refresh fails mid-session | Codex CLI surfaces its own auth error inside the session transcript; same re-registration path |
| Webhook carries no creator (edge case) | Treat as unregistered → block (fail closed, consistent with the blocking decision) |

## 9. Security Considerations

Accepted risk (explicit product decision — all users are members of one organisation):

- Credentials live unencrypted (file-permission-protected, `600`) on a shared host.
- One user's session could read another user's credential dir via the Bash tool when
  the OS sandbox is off. When the sandbox **is** enabled, the existing
  `denyRead: ["~/"]` filesystem rule (`RunnerConfigBuilder.ts:527-537`) already covers
  `~/.cyrus/users/` — worth stating in docs as the hardening option that exists today.
- The registration CLI never echoes secrets and writes with restrictive permissions.

## 10. Testing Plan

- **Unit** (`packages/edge-worker/test/`): `UserCredentialResolver` (match by id, by
  email case-insensitively, no match, malformed dir); env-bundle assembly incl.
  global-auth-key omission; `RunnerConfigBuilder` injection for Claude and Codex
  configs; blocking path posts the right activity and does not create a session.
- **Config plumbing:** round-trip test that `users[]` survives
  `loadConfigSafely()` reload and fires `configChanged` (guards Gotcha 1).
- **F1 test drives** (mandated for major work): end-to-end scenarios for
  (a) registered user → session env contains their tokens, nested `env | grep CODEX_HOME`
  proves inheritance; (b) unregistered user → blocked with message;
  (c) git commit author/PR identity matches the registered user.

## 11. Open Questions

1. **Non-Linear entry points** (Slack chat sessions, GitHub-webhook-triggered work):
   map to profiles via email in a later phase, or leave on global credentials
   permanently?
2. **`CLAUDE_CONFIG_DIR` per user:** on by default (clean state isolation, but loses
   shared caches/settings between users) or opt-in? v1 proposal: create the dir and set
   the var only if the admin passes `--isolate-claude-state` at registration.
3. **Upstream appetite:** closed issue #138 shows real demand that upstream declined to
   productize, and open PR #1307 is building adjacent (org-keyed) credential plumbing.
   Decide whether to open a discussion issue on `cyrusagents/cyrus` before implementing
   (to align with #1307's token store) or after the fork implementation proves itself.

## 12. Rollout

1. Phase 1 — schema + resolver + Claude/Codex/GitHub injection + blocking + CLI
   (this PRD).
2. Phase 2 — candidates, in no committed order: Gemini/Cursor slots, per-user warm
   pools, Slack/GitHub entry-point mapping, sandbox-enforced credential-dir isolation,
   upstream PR.

## 13. Adversarial-review revisions (2026-07-08)

An independent Codex (GPT-5.5) review of the implementation plan surfaced verified
defects; the design is amended as follows:

1. **Fail-closed enforcement boundary.** Blocking at the two webhook handlers alone is
   bypassable: runner creation is also reachable via repository-selection responses,
   parked-session auto-wake, and parked reprompts, and the prompted handler's early
   branches precede any late-placed gate. Amendment: (a) the webhook gates move to the
   **top** of both handlers (after the stop-signal branch — stopping a session never
   requires credentials); (b) `buildAgentRunnerConfig` gains a **fail-closed backstop**:
   in multi-user mode, a Linear session whose creator resolves to no profile posts the
   registration message and throws instead of building a config. This also covers
   pre-feature persisted sessions with no stored creator (they block; a fresh session
   fixes it) and users deregistered while a session was parked.
2. **Full credential-group scrubbing.** Scrubbing only Claude auth keys leaves the
   global `GITHUB_TOKEN`/`GH_TOKEN`, `OPENAI_API_KEY`, and git author identity visible
   to multi-user sessions. Amendment: a `credentialIsolation` flag on the runner config
   (set whenever a per-user profile is active) scrubs **all** credential groups —
   Claude auth, OpenAI auth, GitHub tokens, git author/committer — from the inherited
   env before the per-user bundle merges. A user without a registered PAT gets a
   visible push failure, never a silent push as the shared bot identity.
3. **Codex runner env support.** `CodexConfigBuilder` builds its child env from
   `process.env` + `CODEX_HOME` only; it ignores `additionalEnv`, forwards a global
   `OPENAI_API_KEY` (which would shadow per-user subscription auth), and runs
   `codex login status` against the wrong home. Amendment: `CodexRunnerConfig` gains
   `additionalEnv` + `credentialIsolation`; the env builder merges/scrubs accordingly;
   the subscription check runs with the resolved `CODEX_HOME`.
4. **Config pass-through at boot.** `WorkerService` constructs `EdgeWorkerConfig` from
   an explicit field list; `users`/`gitCommitAuthor` must be added there (in addition
   to the ConfigManager hot-reload lists) or multi-user mode is off at startup.
5. **Registration hardening.** `cyrus users add` chmods dirs (700) and files (600) on
   every run including re-registration, sets 600 on the copied Codex `auth.json`, and
   writes credential files **before** the config entry so a hot-reload can never
   observe a profile whose files aren't ready. The resolver warns when multiple
   registry entries match one creator (first match wins).
6. **Debug-log redaction.** ClaudeRunner's local debug logging serializes full query
   options including env; credential-shaped keys are now redacted there (Sentry
   output was already projected).
7. **F1 support.** Synthetic agent-session webhooks from `CLIIssueTrackerService` now
   carry a `creator`, so F1 drives can validate creator-based credential routing.

Explicitly **not** adopted from the review (spec-accepted risks reaffirmed): sandbox-off
cross-user credential reads (§9) and Codex `auth.json` refresh races (§7.4) remain
accepted same-org risks; a per-user GitHub PAT is not mandatory (isolation via
scrubbing makes the failure visible instead).
