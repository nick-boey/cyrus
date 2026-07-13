# Test Drive: Cyrus Router (per-user device routing) validation

**Date**: 2026-07-09
**Goal**: Validate the `cyrus-router` feature end-to-end — (1) a baseline single-user (`platform: "cli"`) regression to confirm the Phase-0 credential-feature revert and the shared `GitService` worktree-continuity change did not break normal operation, and (2) confirm router-mode flow coverage.
**Test Repo**: `/tmp/f1-test-drive-1783546333` (init-test-repo rate-limiter library)
**Branch under test**: `cyrus-router` @ `d8efdb47`

## Verification Results

### Issue-Tracker
- [x] Issue created (`DEF-1` / `issue-1`)
- [x] Issue ID + identifier returned
- [x] Issue metadata accessible via view-session

### EdgeWorker (baseline cli-mode)
- [x] Server started (platform: cli, port 3600), healthy
- [x] Webhook received, routed (repository-selection elicitation → answered via prompt-session → `selectRepositoryFromResponse` matched "F1 Test Repository")
- [x] Worktree created (`worktrees/DEF-1` from local `main`)
- [x] **New GitService worktree-continuity path handled a no-remote repo gracefully**: `git fetch failed, proceeding with local branch` (WARN, not crash) — the Task 14 `remoteBranchExists`/start-point preference degrades cleanly when there is no `origin`.
- [x] Real Claude session ran (`claudeSessionId dddbe45e…`, model `claude-sonnet-5`) via macOS-keychain auth
- [x] Full subroutine flow: routing → implementation → verification (typecheck+build) → git-gh (committed locally) → concise-summary
- [x] Session completed successfully — `Session completed (subtype: success)`, `messageCount: 84`
- [x] Change actually landed: `peek()` implemented at `src/rate-limiter.ts:113`, committed `0dd0611 "Add peek() method to token bucket rate limiter"`

### Task 14 teardown path (terminal-state cleanup) — directly exercised
Made the worktree dirty, then `terminate-issue --action completed`:
- [x] `pushWipIfDirty` detected the dirty tree, committed WIP, attempted `git push origin HEAD:"def-1-add-a-peek()-method-to-the-tok"` — confirms the **derived branch name** (`GitService.deriveWorktreeBranchName`) is used
- [x] No-remote push failed and was **caught + logged as WARN**, NOT a crash: `Failed to push WIP for DEF-1 … before teardown`
- [x] Teardown proceeded anyway: `Deleting worktree directory … Removing git worktree … Deleted` — push failure did **not** block cleanup (the required invariant)
- [x] Worktree removed; **server stayed healthy** afterward

### Renderer / Activity output
- [x] Activity types present and well-formed: `elicitation`, `prompt`, `thought`, `action`, `response`
- [x] Timestamps present on every activity
- [x] Final `response` activity posted (concise summary)
- [x] 27 activities tracked and viewable; action payloads carry tool + parameter detail

### Router-mode coverage
- [~] **Live router-mode F1 drive: not run.** F1's `apps/f1/server.ts` harness only constructs a `platform: "cli"` EdgeWorker; there is no router-mode F1 harness (a `cyrus router start` + enrolled-device + delegated-issue rig). Building one is net-new F1 wiring beyond this change set.
- [x] **Router flows are covered by the in-process e2e** `packages/router/test/e2e.test.ts` (green), which exercises the same behaviors over a **real localhost WebSocket** with a real `CLIIssueTrackerService`: enrollment (`/enroll`), creator routing + **`agentSessionCreated`→`SessionStart` / `agentSessionPrompted`→`UserPrompt` message translation**, offline queue + one-time "Waiting for…" notice + reconnect delivery/drain, issue lock rejection, creator-only prompt rejection, and RPC round-trip with session-scoped authorization. That e2e caught and fixed two real integration bugs (a `this`-binding drop in `LinearExecutor.dispatch`; a `DeviceGateway.close()` shutdown race).

## Session Log (key outputs)
```
f1 create-issue → DEF-1
f1 start-session -i issue-1 → session-1 (active)
  RepositoryRouter: No routing match → posted repository selection elicitation (1 option)
f1 prompt-session -s session-1 -m "F1 Test Repository"
  GitService: git fetch failed, proceeding with local branch (WARN — no origin)
  GitService: Creating git worktree … from local main
  session_started (model sonnet), real Claude session dddbe45e…
  … thought/action stream: Read/Edit rate-limiter.ts, typecheck, build, git commit …
  AgentSessionManager: Session completed (subtype: success)  messageCount:84
  worktree src/rate-limiter.ts:113  async peek(...)   committed 0dd0611
f1 terminate-issue -i issue-1 --action completed
  Issue reached terminal state: DEF-1
  Stopping agent runner for DEF-1 (issue terminal)
  WARN Failed to push WIP … git push origin HEAD:"def-1-add-a-peek()-method-to-the-tok"  (no remote — caught)
  Deleting/Removing/Deleted worktree DEF-1
  server still healthy
```

## Final Retrospective
**What worked:** The single-user pipeline is fully intact after the Phase-0 revert — issue creation, routing/elicitation, worktree creation, a real Claude session running the full subroutine flow, a committed code change, well-formed activities, and clean success completion. Most importantly, the drive **directly validated the one deliberate core change (Task 14)**: the worktree-continuity start-point preference degrades gracefully on a no-remote repo, and the pre-teardown `pushWipIfDirty` behaves exactly to spec — commits WIP, attempts a push to the derived branch, and on failure logs a warning without blocking worktree removal or crashing the server.

**Gaps / follow-ups:**
- A **live router-mode F1 harness** does not exist and would be net-new work; router behavior is currently validated only by the (green) in-process e2e. Recommended follow-up: add a router-mode F1 rig (RouterServer with a CLI-tracker `trackerFactory` + a `platform:"router"` EdgeWorker enrolled as a device) for a live end-to-end drive.
- F1 note (pre-existing, not this change): a single configured repo with no matching routing label still triggers a repository-selection elicitation rather than auto-selecting the sole active repo.

**Verdict: PASS** for the single-user regression + Task 14 core change (live), with router-mode covered by automated e2e and a live router F1 harness noted as follow-up.
