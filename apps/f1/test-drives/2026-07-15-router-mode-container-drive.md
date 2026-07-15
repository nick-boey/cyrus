# Test Drive: Router-mode container executor — real-Claude credentialed drive

**Date**: 2026-07-15
**Goal**: Validate the router-mode container executor end-to-end with **real Claude credentials** — the credential-bearing counterpart to the CI-scripted A3 (floor upload) and A4 (`/workspaces/<KEY>` invariant) that the automated suite defers. This is the Task 13 Step-2 drive from the container-executor validation-harness plan.
**Branch under test**: `cyrus-containers` @ `e5e6a9e4`
**Environment**: real Docker Desktop (`desktop-linux`), `cyrus-worker:test` image (1.47GB), real `CLAUDE_CODE_OAUTH_TOKEN`, test repo `octocat/Hello-World`. Run **alongside** a live production Cyrus (the developer's `deploy` worktree) on port 3456 — see Safety below.

## Safety notes for this environment

- The developer's real Cyrus was running on this same daemon (port 3456). The router-server WS port was left auto-allocated (`51424`) and the F1 control plane pinned to 3601, so **3456 was never touched**.
- The scripted real-Docker suite's **orphan-GC test was skipped** for this run (it uses an unscoped daemon-wide `sweep()` that could destroy a foreign `cyrus.issue` container the live Cyrus might boot). The lifecycle-suite fixed port 3456 was locally remapped to 3466 to avoid the live Cyrus; both edits were reverted after the run.
- The F1 router-server itself runs an unscoped internal sweep every 60s; it was stopped immediately after the drive to close that window.

## Verification Results

### Scripted real-Docker suite (`packages/router/test/containers-real-docker.e2e.test.ts`, opt-in)
- [x] **cold-boot + idle-stop** (container reaches `running`, injected-clock `sweep()` stops it, **volume retained**) — PASS on real Docker
- [x] **stale-destroy** (injected-clock `sweep()` removes **container AND volume**) — PASS on real Docker
- [x] **floor upload round-trip** (rung-2 restore) — PASS **after a deadlock fix** (see Bug 1)
- [ ] orphan-GC — skipped (safety; unscoped daemon-wide sweep, live Cyrus present)
- [ ] `/workspaces/<KEY>` invariant — `it.skip` per Task 11 (validated live below instead)

Result: `Tests 1 failed | 2 passed | 2 skipped` on first run (the floor deadlock), then `1 passed | 4 skipped` after the fix.

### Router-mode drive (real Claude)
- [x] `router-server` boots with the **real** `LocalDockerProvider` — Router WS `ws://0.0.0.0:51424`, Control `http://127.0.0.1:3601` (run under **Node**, not Bun — see Bug 2)
- [x] `./f1 router:seed-user` seeds a user + Claude secret (docker executor)
- [x] `./f1 create-issue` (via `/cli/rpc`) → `issue-1` / `DEF-1`
- [x] `./f1 router:inject --kind created` → container `cyrus-issue-DEF-1` boots
- [x] **Real Claude session authenticated with the token** — `claudeSessionId` assigned, model `opus`, streamed 52 messages, `Session completed (subtype: success)`
- [x] Activities stream back via `./f1 view-session` (15+ activities: routing, task list, `Write GREETING.md`, commit, push/PR attempt)

### Item 4 — `/workspaces/DEF-1` real-directory invariant (LIVE, in-container)
- [x] `test -d /workspaces/DEF-1` → **yes**
- [x] `test ! -L /workspaces/DEF-1` → **yes (real directory, not a symlink)**
- [x] `realpath /workspaces/DEF-1` → `/workspaces/DEF-1` (self, stable)
- [x] Real git checkout present: branch `def-1-add-a-hello-file`, contains `GREETING.md` (created by Claude) + `README`

### Item 3 — floor upload (LIVE)
- [x] `WorkspaceSyncService: synced issue DEF-1 (1 workspace(s), bundle uploaded)`
- [x] `floorSync: true` in the container config (correctly enabled for containers)
- [x] `./f1 router:artifact --identifier DEF-1` → `{"present":true,"bytes":11661}`; also confirmed on the host artifacts dir
- [x] WIP push failed (read-only `Hello-World`) but the bundle **still uploaded** (P1 unpushed-commit handling)

### Rung-2 restore from a fresh container (LIVE)
- [x] Destroyed the container **and its volume**, re-injected `--kind prompted` → router booted a FRESH container
- [x] `[container-boot] Restored 1 session(s) from the floor bundle.` — rung 2 confirmed
- [x] `Workspace missing/invalid … recreating the worktree from the issue branch before resuming` — the P1 worktree-recreation fix fired; worktree rebuilt at `/workspaces/DEF-1`
- [x] Session resumed (new Claude session in the restored worktree, processed the follow-up prompt)

## Bugs found (by actually running — both were latent because the suite skips by default / the entrypoint was only smoke-tested under vitest)

### Bug 1 — floor round-trip e2e deadlock (FIXED, test-only)
`containers-real-docker.e2e.test.ts` booted the restore container with **synchronous `execFileSync`**, which blocks the Node event loop — but the in-process `RouterServer` that must serve the container's bundle **download** runs on that same loop. The container connected but never got response headers → `UND_ERR_HEADERS_TIMEOUT` at ~300s. **Product code is fine** (in production the router and container are separate processes). Fixed by booting the container asynchronously (`promisify(execFile)` + `await`), keeping the loop free. Re-ran: floor round-trip PASSES.

### Bug 2 — `router-server` entrypoint can't run under Bun (worked around; source fix still needed)
`bun run router-server.ts` fails with `ERR_DLOPEN_FAILED: 'better-sqlite3' is not yet supported in Bun` — `RouterStore` uses the native `better-sqlite3`, which Bun can't load. Task 6's smoke test only exercised `startRouterServer` under **vitest/Node**, so this never surfaced. The real production router runs under Node for the same reason.
**Workaround used for this drive:** `node --env-file=apps/f1/.env apps/f1/dist/router-server.js` (Node 26 supports `import.meta.main`; `--env-file` replaces Bun's auto-`.env`).
**Follow-up (source fix):** update `apps/f1/package.json`'s `"router-server"` script and the runbook from `bun run router-server.ts` to a Node invocation.

## Observations (not failures)

- **Transcript resume after fresh-volume restore:** the bundle restored the session **state** (rung 2 ✓), but the Claude **transcript** did not resume (`needsNewSession=true, resumeSessionId=none`) — Claude started a new session in the restored worktree. Worth a closer look at whether the transcript relocation is expected to survive a container→container (fresh-volume) migration, or whether this is specific to the read-only test repo.
- **Worktree content on read-only repo:** because the WIP push to `octocat/Hello-World` fails (no write access), the restored worktree is recreated from `origin/master` and does **not** contain the earlier `GREETING.md`. This is expected for a read-only repo; a writable repo would push the WIP commit and restore the content.
- **Worker image missing `socat`/`bubblewrap`:** sandbox subprocess env-scrubbing is disabled with a warning (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` skipped). Non-fatal; consider adding these to `docker/worker/Dockerfile` for full sandbox support.

## Net

The router-mode container executor works end-to-end with real credentials: a container boots from an injected webhook, authenticates a real Claude session, works in a **real** `/workspaces/<KEY>` directory, uploads a floor bundle, and a fresh container restores that bundle (rung 2) and resumes. Two latent bugs were found by running for real — one fixed (floor deadlock), one worked around with a documented source follow-up (Bun→Node).
