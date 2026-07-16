# Test Drive: Router-mode container executor with per-user secrets (real credentials)

**Date**: 2026-07-17
**Branch/commit under test**: `cyrus-containers` @ `2f96ab8a` (fix(router): guard legacy-key normalization against Object.prototype member names) + uncommitted F1 `requiredSecretKeys` plumbing (RouterRig/router-server + `.env.user.example` split)
**Goal**: Credentialed end-to-end drive of the router-mode container executor validating (a) the per-user secrets boot gate (`requiredSecretKeys`), (b) the `LINEAR_API_TOKEN → linearWorkspaces → hosted Linear MCP` wiring inside the container (plan Task 8), (c) A3 — real floor bundle upload triggered by a real session ending, (d) A4 — the `/workspaces/<KEY>` real-directory invariant, live, and (e) rung-2 restore (container + volume destroyed).
**Runbook**: `apps/f1/test-drives/README-router-mode.md`
**Rig**: `node --env-file=.env dist/router-server.js` (real `LocalDockerProvider`, no fake executor), worker image `cyrus-worker:test` rebuilt from this working tree. Router/control config in `.env`; per-user secrets in `.env.user` (new split, templates committed as `.env.example` / `.env.user.example`).
**Boot gate under test**: `F1_ROUTER_REQUIRED_SECRET_KEYS=LINEAR_API_TOKEN,GIT_TOKEN` (additive on the always-required `CLAUDE_CODE_OAUTH_TOKEN`).

## Verification checklist (runbook + plan Task 8)

- [x] `docker build -f docker/worker/Dockerfile -t cyrus-worker:test .` succeeds (rebuilt so the image includes the `LINEAR_API_TOKEN → linearWorkspaces` writeConfig change)
- [x] `node --env-file=.env dist/router-server.js` starts; banner prints router WS, control URL, and the new **Boot gate** line: `CLAUDE_CODE_OAUTH_TOKEN, LINEAR_API_TOKEN, GIT_TOKEN required per user`
- [x] **Gate blocks an under-seeded user**: seeding only `--claude-token` then injecting `created` produced `[router] container boot failed for DEF-1: … drive@example.com is not fully authenticated for containers: missing LINEAR_API_TOKEN, GIT_TOKEN …`, a matching `thought` activity on the session timeline ("I couldn't start the workspace container…"), and **no** `cyrus-issue-*` container
- [x] **Idempotent re-seed unblocks**: re-running `router:seed-user` for the same email with `--env LINEAR_API_TOKEN/GIT_TOKEN/GIT_USER_NAME/GIT_USER_EMAIL` succeeded (no UNIQUE-constraint crash); re-injecting `created` booted `cyrus-issue-DEF-1` within seconds
- [x] Container boot log shows the fresh-start rung: `[container-boot] No floor bundle found for this issue — fresh start.`
- [x] Worktree created at `/workspaces/DEF-1` from `origin/master`
- [x] **Per-user secrets present in container env** (from `claude_query_options` telemetry): `CLAUDE_CODE_OAUTH_TOKEN`, `LINEAR_API_TOKEN`, `GIT_TOKEN`, `GIT_USER_NAME`, `GIT_USER_EMAIL` — alongside router-reserved `CYRUS_*` vars
- [x] **`cqo.mcpServerNames` includes `linear`** (`linear\ncyrus-tools\ncyrus-docs`) — the hosted Linear MCP was wired from the per-user `LINEAR_API_TOKEN` with no static workspace token
- [x] **Authenticated Linear MCP ops succeed in-session**: the session called `mcp__linear__get_user("me")` → the real seeded user (name/email/admin, matching the owner of the seeded `LINEAR_API_TOKEN`) and `mcp__linear__list_teams` → the 6 real workspace teams. `get_issue("DEF-1")` failed as expected (synthetic F1 identifier; no `DEF` team exists in the real workspace) — property of the test fixture, not the MCP
- [x] `./f1 view-session` streamed activities live during the run
- [x] **A3 (real floor upload trigger)**: 3s after the first real session completed — `WorkspaceSyncService: synced issue DEF-1 (1 workspace(s), bundle uploaded)`; `./f1 router:artifact --identifier DEF-1` → `{"present":true,"bytes":23393}`
- [x] **A4 (live)**: `docker exec cyrus-issue-DEF-1 test ! -L /workspaces/DEF-1` → exit 0; `realpath /workspaces/DEF-1` → `/workspaces/DEF-1`; `stat -c %F` → `directory`
- [x] **A4 CI follow-through**: removed the `it.skip` on `"is a real directory, not a symlink, and realpath-stable"` in `packages/router/test/containers-real-docker.e2e.test.ts` per the Task 11/12 recommendation, updated its comment to record this drive as the empirical confirmation, and ran that single test for real (`CYRUS_E2E_DEDICATED_DOCKER=1 … vitest run … -t "real directory"`, after removing all drive containers/volumes from the daemon per the suite's safety warning). **Its first-ever execution FAILED and exposed a latent test bug** (Finding 2 below); after fixing the fixture it **passes in 14s** (`1 passed | 4 skipped`)
- [x] **Rung-2 restore (state level)**: `docker stop -t 30` + `docker rm` + `docker volume rm`, then `router:inject --kind prompted` → fresh container logged `[container-boot] Restored 1 session(s) from the floor bundle.`, recreated the missing worktree, ran a real Claude session (`session_started` → `claude_session_id_assigned` → `session_completed`, 6 messages), and re-uploaded the bundle on completion

## FINDING 1 (bug): restored session's activities are all rejected — `session not owned by this device`

**Severity**: high for restore UX — after a rung-2 restore, the session *works* (Claude runs, floor sync runs) but posts **nothing** to the timeline, so the user sees a dead session.

**Evidence** (post-restore container log, 7 ms window):

```
22:34:26.035 [INFO ] [AgentSessionManager] Reconciled session interrupted by a host restart
22:34:26.035 [WARN ] [EdgeWorker] Reconciled 1 session(s) interrupted by a host restart
22:34:26.040 [INFO ] [EdgeWorker] [event:webhook_received] {"action":"prompted",…}
22:34:26.042 [ERROR] [EdgeWorker] Error creating prompted acknowledgment: RouterRpcError: session not owned by this device
```

and on the router:

```
[router] Session sess-1 reached terminal state 'complete' on device 1; released lock and affinity
[router] Session sess-1 reached terminal state 'error' on device 1; released lock and affinity
```

**Reconstructed chain**:
1. `routePrompted` re-establishes session affinity to the (reused) container device row (`EventRouter.ts:413`) and delivers the queued prompt — this part works as designed.
2. On boot, the restored EdgeWorker **reconciles the bundle-restored session as "interrupted by a host restart"**, which reports a **terminal `error` state** for `sess-1` up to the router.
3. The router's terminal-state handler (`EventRouter.ts:168`) releases the lock **and the session affinity** — clobbering the affinity that step 1 just wrote, since the reconciliation frame arrives between routing and the ack.
4. Every subsequent session-scoped RPC from the same device (`LinearExecutor.ts:111-118`: `getSessionAffinity(sessionId) !== deviceId` → fail) is rejected: the prompted acknowledgment, and **all** thought/action/response activities of the restored run. Zero rung-2 activities reached the tracker (searches for the rung-2 reply return 0 matches) even though the session completed successfully.

**Related observation**: the pre-destroy continuation session's final `response` is also missing from the timeline (last visible activity is the `ToolSearch: mcp__linear__list_teams` load at 22:30:15; the session completed at 22:30:27). Plausibly the same race in its non-restore form — the final response post racing the terminal-state frame that releases affinity — but this leg is less evidenced; treat as a secondary lead, not a conclusion.

**Suggested fix directions** (follow-up work, not attempted in this drive):
- Don't release affinity on a terminal-state frame that arrives from the device that *currently holds* a just-re-established affinity for a *newer* prompted delivery (ordering/generation check), or
- Have the boot-time reconciliation not replay a terminal state for sessions that have a pending queued prompt, or
- For container devices, let `LinearExecutor`'s session-scoped auth fall back to issue-affinity/`getContainerDeviceForIssue` when session affinity is absent.

## FINDING 2 (test bug, fixed in this drive): the never-run A4 e2e test seeded a session but not its issue

The un-skipped invariant test had never executed (skipped since creation, written from a code trace). Its first run timed out after 90s waiting for `/workspaces/CYDIR-…` to exist. A log-capture watcher on the second run caught the real cause inside the container:

```
[ERROR] [EdgeWorker] Failed to fetch issue details for issue-dir: RouterRpcError: Issue issue-dir not found
[ERROR] [EdgeWorker] Failed to process webhook: created Error: Failed to fetch full issue details for issue-dir
    at EdgeWorker.createCyrusAgentSession (…)
```

The container booted, authenticated, and received the queued `created` event fine — but `seedSession()` (the suite's fixture) seeds only an **agent session** record, never the **issue**, and the in-container EdgeWorker fetches the full issue over router RPC *before* creating the worktree. The manual drive never hit this because `./f1 create-issue` creates a real tracker issue first.

**Fix (this branch)**: new `seedIssue()` helper in `packages/router/test/helpers/fixtures.ts` (direct state insert mirroring `createIssue`'s stored shape, with caller-chosen id/identifier since `createIssue` auto-generates both), called by the invariant test. After the fix the test passes against real Docker in ~14s.

**Secondary gotcha discovered while re-running**: the suite's `beforeAll` runs `docker build` with a 300s hook timeout. Any change to the repo (build context) invalidates the image's COPY layer, and the resulting full rebuild (~8min here) blows the hook timeout — the run reports `Tests 5 skipped` with a file-level failure and a red herring duration. Pre-building `cyrus-worker:test` before running the suite (or raising that hook timeout) avoids it.

## Anomalies / secondary observations

1. **Duplicate activities and log lines**: early-session activities appear twice in the timeline ("I've received your request…", the Routing thought) and most EdgeWorker log lines are emitted twice in the container. Cosmetic but noisy; worth a look at double event-handler registration in the container EdgeWorker.
2. **`.env.user` values with spaces must be quoted** — an unquoted `GIT_USER_NAME=First Last` breaks `source` (`command not found`) and silently seeds nothing. Fixed during the drive; `.env.user.example` now carries a quoting hint.
3. **`./f1 ping` prints `Status: undefined`** — cosmetic RPC response-shape mismatch.
4. **`Failed to move issue issue-1 to a started state: issue issue-1 has no team`** — CLI-tracker fixture issue lacks a team; harmless in F1 but noisy on every `created` injection.
5. **Sandbox env-scrub warnings in-container**: `socat`/`bwrap` absent in the worker image, so `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is skipped. Expected for now; decide whether the image should ship them.
6. **Restore resumes state, not the Claude transcript**: post-restore, `[resumeAgentSession] needsNewSession=true, resumeSessionId=none` — the restored run started a fresh Claude session (with restored workspace + comment history as context) rather than `--resume`-ing the bundled transcript. Matches current design of the restore ladder (sessions restored ≠ transcript continuation), noted so nobody mistakes it for a regression.

## New tooling exercised by this drive (added on this branch)

- `.env` / `.env.user` split with committed templates (`apps/f1/.env.example`, `apps/f1/.env.user.example`); `.gitignore` unignores the new template.
- `F1_ROUTER_REQUIRED_SECRET_KEYS` (comma-separated) → `RouterRigOptions.requiredSecretKeys` → `containers.requiredSecretKeys`; effective gate printed in the startup banner.
- `router-server.ts` now passes a console-backed `[router]`-prefixed logger to the rig — previously the rig's silent default logger swallowed exactly the boot-gate warnings this drive needed to observe.
- `RouterRig.seedUser` made idempotent (re-seed updates executor + secrets) — required for the "blocked → seed missing key → re-inject" flow this drive validates.

## Verdict

**Per-user container secrets: validated end-to-end** — gate blocks (naming missing keys, on console and timeline), re-seed unblocks, secrets land in the container env, and a per-user `LINEAR_API_TOKEN` yields a working authenticated hosted Linear MCP inside the container's Claude session. **A3 and A4 confirmed with real credentials**; the A4 CI skip has been removed and the un-skipped test now genuinely passes against real Docker (after fixing its latent fixture bug, Finding 2). **Rung-2 restore restores state and work continues, but the restored session is invisible on the timeline** due to the affinity-release race documented above (Finding 1) — file and fix before relying on restore in front of users.
