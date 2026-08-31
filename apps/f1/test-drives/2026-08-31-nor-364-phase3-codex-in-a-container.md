# Test Drive: NOR-364 phase 3 — Codex in a container

**Date:** 2026-08-31
**Issue:** [NOR-364](https://linear.app/northrop-digital/issue/NOR-364/allow-users-to-select-default-runners) phase 3 · [PR #41](https://github.com/nick-boey/cyrus/pull/41)
**Branch under test:** `cyrus1/nor-364-allow-users-to-select-default-runners`, rebased onto `main` (`a6f24eda`)
**Objective:** Prove Codex-in-a-container works, on the credential the product mandates.

## Why this drive exists

Phase 3's premise was that **Codex-in-a-container has never been run**: every Codex F1
drive to date is local macOS, and every container drive is Claude-only. Nothing in
phases 1–2 was wrong on inspection; the entire value here is what only running it
could reveal. It revealed three product defects and one documentation defect — plus a
two further defects found while reviewing the fixes — and the worst of them presents as
success.

## Setup

| | |
|---|---|
| Executor | `LocalDockerProvider` (real `docker run`, real worker image) via the F1 router-mode rig |
| Worker image | `cyrus-worker:test`, built from the branch (`codex-cli 0.144.6`) |
| Router | `apps/f1/router-server.ts`, control plane on `:3601`, router WS on an ephemeral port |
| Repository | `nick-boey/cyrus-f1-codex-drive` (throwaway, private, `main`) |
| User | `codexonly@example.com` — default runner Codex, **no `CLAUDE_CODE_OAUTH_TOKEN`**, real ChatGPT-subscription `auth.json` |
| Not covered | Live Azure/ACA — so ACA *memory* suspend/resume and the create-time egress allowlist remain unrun. Park/resume is covered in its Docker form. |

Three F1 gaps had to be closed before the drive could start, and each was itself a
sign that this path had never been exercised:

- `router:seed-user` **required** `--claude-token`, so a Codex-only user — the exact
  precondition of phase 3's first check — could not be expressed at all. Now optional,
  with `--default-runner <runner:model>` and `--codex-auth <path>` alongside it.
- The rig passed no `containers.codex`, so `RouterServer` built no `CodexTokenStore`
  and a Codex user silently degraded to the `OPENAI_API_KEY` path — i.e. the drive
  would have quietly tested the fallback instead of the subscription path.
- The rig hardcoded `octocat/Hello-World`, which cannot be pushed to, so "opens a pull
  request" was untestable. Added `F1_ROUTER_REPO=owner/repo[@branch]`.

The startup banner also still printed `Boot gate: CLAUDE_CODE_OAUTH_TOKEN required per
user`, which phase 1 had made false.

## Results

| # | Phase 3 criterion | Result |
|---|---|---|
| 1 | Container boots for a Codex-default user holding **no** Claude token | **PASS**, unchanged |
| 2 | Session posts tool-use and file-edit activities | **PASS** after fix 1 |
| 3 | Session survives a park/resume | **PASS** |
| 4 | It opens a pull request | **PASS** after fix 1 + `GH_TOKEN` |
| 5 | Negative: revoked token gets the phase-2 failure message | **PASS**, unchanged |

Every criterion passes. Checks 2 and 4 required the fixes below; nothing in 1, 3 or 5
needed a production change.

### The end state

[PR #1](https://github.com/nick-boey/cyrus-f1-codex-drive/pull/1) — *Add multiply
function*, one commit, on `def-1-add-a-multiply-function-to-cal`:

```diff
+export function multiply(a, b) {
+	return a * b;
+}
```

Opened by a Codex session, on a ChatGPT subscription, inside a container, for a user
who holds no Anthropic credential of any kind. That had never happened before.

### Check 3 — park and resume, both rungs

`docker stop -t 30` (the graceful stop that lets the floor flush) then a re-injected
`prompted` event: the container restarted, minted a **fresh** Codex credential, and kept
the worktree, the branch and the commit. A second Codex session ran to
`Session completed (subtype: success)`.

Then the harder rung: container **and volume** destroyed, so the state could only come
back over the wire. `Restored 1 session(s) from the floor bundle.` — and that boot is the
one that opened the pull request.

### Check 5 — a revoked credential, against the live endpoint

A structurally-valid credential carrying a dead refresh token and an already-expired
access token, so the boot was forced to refresh. The router called
`https://auth.openai.com/oauth/token` for real, took an HTTP 401, and refused the boot:

```
Container boot failed for DEF-2 Error: Your Codex account could not be refreshed.
https://auth.openai.com/oauth/token refused the refresh with HTTP 401:
{ "message": "Your refresh token has already been used to generate a new access
  token. Please try signing in again.", "code": "refresh_token_reused" }
Your Codex credential is no longer valid — a `codex logout` anywhere revokes every
copy, and a lapsed ChatGPT subscription has the same effect. Run
`codex login --device-auth` again and paste the new auth.json into /setup, or set
OPENAI_API_KEY to use metered billing instead.
```

**No container was created**, and the user got a Linear activity naming the remedy —
not a dead session, which is what this check exists to rule out.

**This partially de-risks `DEFAULT_CODEX_OAUTH_CLIENT_ID`**, the PR's largest stated
unknown, without rotating anything. OpenAI answered with a *token-state* error
(`refresh_token_reused`), not `invalid_client` — so the token endpoint recognised and
accepted our client id and got as far as evaluating the token. That is not proof a
successful refresh returns usable tokens, but it does rule out the failure mode that
would have made every refresh fail identically forever.

### Other things this confirmed

- **Rung-2 floor restore works for a Codex session**, not just a Claude one — the volume
  was destroyed and the session came back from the bundle.
- **The router is the sole refresher, as ADR 0005 requires**: `Wrote Codex credentials to
  /home/cyrus/.codex/auth.json` appears once per boot, freshly minted each time.

### Passed unchanged

- **The boot gate let a Codex-default user with no Claude token through.**
  `requiredSecretKeysFor` did exactly its job; this is the defect phase 1 named as
  making the picker "a lie for anyone without an Anthropic subscription", and it is
  genuinely fixed.
- **The sealed credential is absent from `router.db` and its WAL.** Checked by grepping
  the live database for the first 40 characters of the real refresh token.
- **`parseCodexAuthPaste` accepts a real `codex login --device-auth` file**, and
  `renderCodexAuthFile` round-trips it byte-identically (field order aside) — verified
  against the operator's own `~/.codex/auth.json`, status `connected`.
- **The delivery chain works end to end:** router `mint()` → `CODEX_AUTH_JSON` →
  `$CODEX_HOME/auth.json` at `0600`, with `codex-cli 0.144.6` on `PATH`.

## Defects found

### 1. Codex's sandbox cannot nest inside a worker container — and the session reports success anyway

```
bwrap: No permissions to create a new namespace, likely because the kernel does not
allow non-privileged user namespaces.
```

Codex enforces **every** sandbox mode — including the granular permission profile
`RunnerConfigBuilder` builds — by running each command under bubblewrap, and bubblewrap
needs a user namespace a container does not get. So every shell command exits 1 *before
it starts*. The agent burned its turns discovering it could not read a file, tried the
patch tool, tried MCP resources, and then terminated with
`Session completed (subtype: success)` having changed nothing and opened no pull
request.

That last part is what makes this the defect phase 3 existed to find: in the timeline it
looks like a healthy session that simply had nothing to do. A Claude-only container
fleet could never surface it.

**Fix:** disable the nested sandbox under `isHeadlessContainerMode()` only. This is the
same reasoning that already disables Cyrus's own egress sandbox there — the ephemeral,
single-issue container *is* the boundary, and a second OS sandbox inside it buys nothing
it does not already have. A workstation `cyrus start` keeps its sandbox, where it is the
only boundary there is. The test asserts both container signals are required, so a stray
`CYRUS_ISSUE_KEY` in a developer shell cannot disarm it.

### 2. Three of the four catalog models cannot run on a ChatGPT subscription

```
400 invalid_request_error — The 'gpt-5.5-codex' model is not supported when using
Codex with a ChatGPT account.
```

This is a **semantic** rejection *after* a successful auth, so it cannot be probed for
and does not degrade — the session simply dies. Measured against a live subscription
inside the worker image:

| Model | Result |
|---|---|
| `gpt-5.5` | **works** |
| `gpt-5.5-codex`, `gpt-5.2-codex`, `gpt-5.1-codex`, `gpt-5`, `gpt-5-codex` | rejected |
| `gpt-5.5-codex-mini`, `gpt-5.5-mini`, `gpt-5.5-pro`, `codex-mini-latest` | rejected |

The picker offered `gpt-5.5-codex` as its first Codex option, so the default choice was
a guaranteed dead session.

**Fix:** the Codex catalog is now `gpt-5.5` alone. Keeping the others for the
`OPENAI_API_KEY` fallback's sake would invert the point of a curated control — rendering
an option that fails for every user on the credential the product *mandates*, in order
to serve the path documented as the fallback. Same rule that keeps Gemini and Cursor out
of the picker entirely.

### 3. `CODEX_AUTH_JSON` stayed set after the credential was written to disk

Two costs, and the second is visible in the transcript:

- It is a live OAuth access **and** refresh token sitting in the environment of every
  command the agent runs, so any `env` / `printenv` / process dump would print it into
  the session transcript.
- It is multi-line JSON, and the Codex CLI snapshots the shell environment into a
  `/bin/sh` script at session start. The embedded newlines and quotes make that script
  unparseable — `Syntax error: Unterminated quoted string` — so the snapshot is discarded
  and the agent spends the session narrating a broken shell (*"The shell runner is
  failing before commands start…"*, *"I'm retrying…"*).

**Fix:** delete it from both `this.env` and `process.env` once `auth.json` exists.
Nothing downstream reads it — `codex` reads the file. Verified live: the session worker
process (`cyrus start`) shows zero occurrences, and the rebuilt image logged zero
shell-snapshot errors.

### 4. `.env.user.example` said `GIT_TOKEN` was enough to create pull requests

It is not, and this cost the drive a run. `GH_TOKEN` is canonical — `gh` reads it
natively and `gh auth setup-git` makes git ride the same credential, so one variable
covers clone, push *and* `gh pr create`. `GIT_TOKEN` is the legacy git-only fallback: it
writes `~/.git-credentials`, which `gh` never sees. A session seeded with `GIT_TOKEN`
alone gets as far as a pushed branch with a real commit on it and then silently stops
short of the pull request — which is exactly what happened here, and is easy to misread
as an agent failure. Corrected in `.env.user.example` and the router-mode runbook.

### 5. Retiring a model dropped the user's runner along with it

Found reviewing fix 2, not by the drive itself, but caused by it.
`resolveDefaultRunner` discarded the **entire** stored selection when a model left the
catalog — and the selection carries the runner, which is what `requiredSecretKeysFor`
keys off. So retiring `gpt-5.5-codex` (the picker's own default) would have turned every
user who had chosen it back into a Claude user, demanded a `CLAUDE_CODE_OAUTH_TOKEN`
they were never required to hold, and refused to boot any of their containers — undoing
phase 1's central fix by way of a catalog edit.

A one-off migration would have covered this instance. A same-runner model fallback
covers the class, and retiring a model is the routine change here: this diff retires
three on its first live run. The runner is the axis the user chose; the model is the
axis the catalog controls, and only that one moves.

### 6. Wiring the rig's Codex store dropped a key file into the package directory

Also found in review. `RouterServer` derives the local KEK path from
`dirname(dbPath)`, and the F1 tests pass `":memory:"`, whose dirname is `"."` — so
enabling `containers.codex` on the rig wrote a 0600 key-encryption key into `apps/f1/`
on every test run, and it was very nearly committed. The rig now names the path
explicitly, beside its own temp `secretsPath`, and `codex-kek.key` is gitignored so a
stray one can never be committed by any route.

## Drive-harness limitations (not product defects)

- The F1 rig backs `cyrus-tools` with the CLI issue tracker, so the agent's
  `mcp__codex_apps__linear_get_issue` calls return `INVALID_ARGUMENT` for `DEF-1`. A real
  Linear workspace would not.
- `Failed to move issue issue-1 to a started state` — the CLI tracker has no state
  machine.
- Codex warns `could not find bubblewrap on PATH` and falls back to a bundled copy. This
  is [#8](https://github.com/nick-boey/cyrus/issues/8) and is now moot inside a container,
  since the sandbox is off there.

## Still unrun

- **ACA memory park/resume**, and the egress allowlist as actually applied at
  sandbox-create time. Both are Azure-only; this drive was local Docker.
- **`DEFAULT_CODEX_OAUTH_CLIENT_ID` against a live refresh**, deliberately: a refresh
  rotates and invalidates the refresh token, which would break the operator's own local
  `codex` login. It stays overridable via `containers.codex.clientId`, and
  `OPENAI_API_KEY` stays supported as the fallback.
