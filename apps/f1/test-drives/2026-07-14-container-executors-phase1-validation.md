# Test Drive: Ephemeral container executors (phase 1) validation

**Date**: 2026-07-14
**Goal**: Validate the phase-1 container-executor work — real container boot, the restore ladder, git-token hygiene, device→container migration, and the "floor is container-only" gate.
**Branch under test**: `cyrus-containers` @ `069148e9` (PR #2 → `deploy`)
**Test Repo**: `/tmp/f1-test-drive-1783986251` (init-test-repo rate-limiter library) + real `octocat/Hello-World` clones inside containers

## Scope note — why this drive is not a stock F1 run

The F1 harness (`apps/f1/server.ts`) constructs a **`platform: "cli"`** EdgeWorker only. It has no router mode,
no executor selection, and no container support, and this branch did not extend it. The 2026-07-09 router drive
already recorded this gap and recommended building a router-mode rig as follow-up; that rig still does not exist.

So a stock F1 drive **cannot boot a container** and would say nothing about the feature under test. Worse, the
existing automated coverage is also blind here: `packages/router/test/containers-e2e.test.ts` uses a
`FakeBootExecutor` and states outright that it "never shells out to a real Docker daemon", and
`packages/router-executors/test/LocalDockerProvider.test.ts` is mock-based. **All 1,898 passing unit tests
exercise zero real Docker.** Before this drive, the image, the entrypoint, and the in-container restore ladder
had never actually been executed.

This drive therefore does two things:
1. Drives the **real container** against a real Docker daemon with a stubbed router artifact endpoint (new).
2. Runs the **stock F1 CLI-mode drive** as a regression check of the shared EdgeWorker/GitService changes.

## Verification Results

### Container image + entrypoint (real Docker 29.2.1)
- [x] `docker build -f docker/worker/Dockerfile` succeeds (first time the image has ever been built)
- [x] Entrypoint env validation: with no env it exits **1** naming all five missing vars
      (`CYRUS_ROUTER_URL, CYRUS_DEVICE_TOKEN, CYRUS_ISSUE_KEY, CYRUS_REPOS_JSON, CLAUDE_CODE_OAUTH_TOKEN`)

### Restore ladder — all three rungs exercised in a real container
- [x] **Rung 3 (fresh)**: artifact endpoint 404s → `No floor bundle found for this issue — fresh start.` →
      real clone of `octocat/Hello-World` → EdgeWorker starts, manages 1 repo at `/workspaces/repos/hello`
- [x] **Rung 1 (warm)**: `docker stop` + `docker start` on the same volume →
      `Warm volume: edge-worker state already present, skipping restore.` + `hello: already cloned, skipping.`
      (boot is idempotent, as the runbook claims)
- [x] **Rung 2 (restore)**: fresh container + fresh volume, served a real floor bundle →
      `Restored 1 session(s) from the floor bundle.`
- [x] `~/.claude/projects` → symlink to `/workspaces/.claude-projects` (transcripts persist on the volume)
- [x] Warm-path state file (`edge-worker-state.json`) is written **at graceful shutdown**, not during the run —
      the warm rung depends on a clean stop

### Device → container migration (the interesting one)
Built a real bundle with the shipped `workspace-sync` code, carrying a session whose `workspace.path` was a
**macOS host path that cannot exist in a container** (`/Users/alice/code/myrepo/worktrees/TEST-3`) plus a Claude
transcript keyed to that path's sanitized cwd. Booted a fresh container against it:

- [x] `workspace.path` rewritten to the canonical `/workspaces/TEST-3`
- [x] Transcript **relocated** from `-Users-alice-code-myrepo-worktrees-TEST-3` → `-workspaces-TEST-3`
      (the sanitized canonical cwd the Agent SDK will actually look under)
- [x] No orphaned transcript left at the old device-keyed name
- [x] `claudeSessionId` preserved → the Claude conversation survives the migration
- [x] Transcript content intact

### Git token hygiene (commit `d12941c6`)
Booted with `GIT_TOKEN=ghp_SUPERSECRET_TOKEN_SHOULD_NOT_LEAK` and grepped the **entire durable volume**:

- [x] Token appears **nowhere** under `/workspaces` — it never lands on the volume
- [x] `.git/config` remote URL is clean (`https://github.com/octocat/Hello-World.git`, no embedded credentials)
- [x] `~/.git-credentials` is `0600`, in the container home (not the volume), `credential.helper=store`
- [x] Git identity from the secret bundle applied (`Alice Example <alice@example.com>`)

### The persistence-floor gate (the riskiest regression in this PR)
The changelog claims WIP auto-push happens **only** inside containers, so nobody's laptop starts auto-committing
to their issue branches (including open PRs). Verified on the CLI-mode F1 drive:

- [x] **Zero** `pushWip` / `WIP commit` / `push origin` calls in the entire CLI-mode session log
- [x] `WorkspaceSyncService` is never even constructed — F1 is `platform: "cli"` with no `router.floorSync` block,
      and the floor is gated behind `config.router.floorSync === true`

### EdgeWorker regression (stock F1, CLI mode)
- [x] Issue created (`DEF-1` / `issue-1`), session started
- [x] Repository-selection elicitation → answered via `prompt-session` (same as the 2026-07-09 drive)
- [x] Worktree created (`worktrees/DEF-1` from local `main`) — the changed `GitService` behaves correctly
- [x] Real Claude session ran (`58a44f06…`, `claude-sonnet-5`), 188 messages, `subtype: success`, **zero errors**
- [x] Change actually landed: `peek()` at `src/rate-limiter.ts:114`, committed `b4dd0f3`
- [x] Activities well-formed with timestamps (`elicitation`, `thought`, `action`); pagination works
- [x] `stop-session` clean: status `active` → `complete`, server stayed healthy

## Anomaly (pre-existing — NOT introduced by this branch)

The Claude session completed successfully on the server (`Session completed (subtype: success)`, 188 messages,
`Result message emitted to Linear (activity activity-89)`) and committed its work — but the **issue tracker still
reported `status: active` with 30 activities and no final `response` activity** until the session was explicitly
stopped. The 2026-07-09 drive did record a final `response` (concise summary), so this is a delta against that run.

**Attribution — this is not caused by the PR**, on the following evidence:
- `AgentSessionManager` (which owns activity posting and completion) is **untouched** by this branch.
- The only edge-worker additions are gated behind `router.floorSync === true` and fire-and-forget
  (`void this.workspaceSync?.syncIssueOnTermination(...)`). F1 is `platform: "cli"` with no router block.
- The F1 log contains **zero** `WorkspaceSync`/floor lines — the new code demonstrably never executed.
- `GitService` did change and did run, but it created the worktree correctly and does not post activities.

**Caveat**: I did not A/B this against `origin/deploy` to confirm empirically. The attribution above is a
code-path argument, not an experiment. Worth a follow-up issue either way — a session that finishes its work
but never reports a final response is a real product problem regardless of which change introduced it.

## What this drive did NOT cover

These need a live router, a real Linear workspace, and a real Claude OAuth token, and were **not** exercised:

- The container's **WebSocket connection to a real router** with a real minted device token (a stub HTTP artifact
  endpoint was used; there is deliberately no CLI command that prints a container's device token).
- A **real Claude session running inside a container**.
- The **floor's upload path** (`pushWipIfDirty` + bundle `PUT`) actually firing — no session ran in-container, so
  nothing was ever uploaded. Only the download/restore half of the floor is proven.
- The **router's container lifecycle against real Docker** — boot serialization, idle-stop, stale-destroy, orphan
  GC. Every one of these is fake-executor-only in tests.
- `/workspaces/<ISSUE-KEY>` being a **real directory, never a symlink**, under a live session. The boot path never
  creates a symlink there and `realpath` resolves clean, but the worktree itself is only created by `GitService`
  at session start, which needs a live router — so the spec's hard requirement is argued, not observed end-to-end.

## Final Retrospective

**What worked:** Everything that could be driven without live Linear/Claude credentials passed, and several of the
riskiest claims in the PR are now backed by real evidence rather than mocks — the image builds and boots, all three
restore-ladder rungs behave as specified, the git token provably never touches the durable volume, device→container
migration rewrites the impossible host path and carries the Claude transcript across, and the WIP floor stays off on
non-container setups. The CLI-mode regression is clean: worktree, real Claude session, landed commit, clean stop.

**Gaps:** The half of the feature that only exists under a live router — in-container sessions, the floor's upload
path, and the whole container lifecycle (idle-stop/destroy/GC) — remains unexercised by anything, tests included.
The fake-executor e2e gives no coverage of real `docker run` behavior.

**Verdict: PASS** on everything reachable without live credentials, with the explicit caveat that the router-driven
half of the feature (in-container sessions, floor upload, lifecycle sweeps) is **still unvalidated end-to-end** and
should not be assumed working. Recommended follow-ups: (1) a router-mode F1 rig — the same gap the 2026-07-09 drive
flagged, now blocking a second feature; (2) a real-Docker e2e for the lifecycle sweeps; (3) an issue for the
missing final `response` anomaly above.
