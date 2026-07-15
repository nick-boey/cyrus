# Design: Container-executor validation harness + "no final response" anomaly

**Date**: 2026-07-15
**Status**: Approved; revised after Codex (GPT-5.6-Sol) design review — all six findings verified against source and incorporated
**Branch**: `cyrus-containers`
**Source**: `TODO.md` — follow-ups from `apps/f1/test-drives/2026-07-14-container-executors-phase1-validation.md`

## Review history

A Codex (GPT-5.6-Sol) read-only design review raised six issues, each verified against the
codebase before being folded in:

1. **Host-daemon isolation (safety)** — the real-Docker suite shares the global `cyrus.issue`
   label / `cyrus-issue-*` namespace; orphan GC + wildcard teardown could destroy a
   developer's real Cyrus containers. → A2 rewritten with a dedicated-daemon requirement.
2. **Exposed F1 control plane (safety)** — the F1 drive routes are an unauthenticated control
   surface. → A1 binds them to loopback behind a bearer token.
3. **Late-bound router port (wiring)** — `routerUrlForContainers` is consumed at construction
   but the port isn't known until after `listen()`. → A1 uses a fixed pre-allocated port.
4. **Private Fastify / no `/cli/rpc` (wiring)** — `RouterServer` keeps Fastify private, forbids
   post-`listen()` routes, and never mounts `/cli/rpc` (that is `EdgeWorker`-only; verified at
   `EdgeWorker.ts:880` vs `CLIIssueTrackerService.createEventTransport`). → A1 drives the router
   in-process and adds no routes to `RouterServer`; Open Question #1 resolved **no**.
5. **Invalid CLI-status oracle (Track B)** — CLI-tracker status semantics aren't Linear's, so
   "stuck `active`" is not a reliable anomaly signal. → Track B uses a layered evidence oracle.
6. **Suspect list vs. the log (Track B)** — the report's `Result message emitted … activity-89`
   log fires only inside `if (result.activityId)` (`AgentSessionManager.ts:1458-1463`), which is
   impossible if the empty-content/sink-skip suspects had fired. → Track B reframed around the
   contradiction.

## Context

The phase-1 container-executor work shipped: a `cyrus-worker` image, an in-container
restore ladder, a router-side artifact endpoint, device→container migration, and a
persistence "floor" that auto-pushes WIP and uploads state bundles. The 2026-07-14 test
drive validated everything reachable **without a live router**: the image builds and
boots, all three restore-ladder rungs behave, the git token never lands on the durable
volume, and the floor stays off on non-container setups.

The half of the feature that only exists **under a live router** remains unexercised by
anything, tests included:

- No F1 harness can boot a container or drive anything router-driven — `apps/f1/server.ts`
  builds a `platform: "cli"` EdgeWorker only.
- `packages/router/test/containers-e2e.test.ts` uses a `FakeBootExecutor` and never shells
  out to Docker; `packages/router-executors/test/LocalDockerProvider.test.ts` is mock-based.
  **All passing unit tests exercise zero real Docker.**
- The floor's **upload** path (`pushWipIfDirty` + bundle `PUT`) has never fired — no session
  has ever run inside a container.
- The `/workspaces/<ISSUE-KEY>` real-directory invariant is argued from code, not observed
  under a live session.

Plus one surfaced anomaly: a CLI-mode session completed successfully and committed its work
but posted **no final `response` activity** and left the issue `status: active` until
explicitly stopped. Attribution to this branch was argued from code paths, not A/B tested.

## Goals

- A **router-mode F1 harness** that can boot a container, run an in-container session, and
  drive the floor's upload path end-to-end (item 1).
- **Opt-in real-Docker coverage** of the container lifecycle sweeps — boot serialization,
  idle-stop, stale-destroy, orphan GC (item 2).
- Proof that the floor's **upload → artifact endpoint → fresh-container restore** round-trip
  works (item 3).
- The `/workspaces/<ISSUE-KEY>` **real-directory (never symlink)** invariant asserted
  directly (item 4).
- Empirical attribution and disposition of the **missing-final-`response`** anomaly (item 5).

## Non-goals

- Provider executors other than `LocalDockerProvider` (e.g. Fly). The rig's executor seam
  stays open, but no new provider is built here.
- Changing production floor/lifecycle/boot behavior beyond any minimal fix the item-5
  investigation demands.
- Making the real-Docker e2e suite run in credential-constrained CI by default — it is
  opt-in and `skipIf(no daemon)`.

## Decomposition — two tracks

The five TODO items are not five independent tasks. Items 1–4 are one cohesive
**harness-and-validation** effort (item 1 is the keystone that unblocks 3 & 4 and backs 2).
Item 5 is a separate **debugging** effort sharing no code with the harness.

- **Track A** — Router-mode validation harness (items 1–4).
- **Track B** — "No final `response`" anomaly investigation (item 5).

Track B runs in parallel with Track A throughout.

## Track A — Router-mode validation harness

Built in dependency order: **A1** (the rig) first, then **A2/A3/A4** hang off it in parallel.

### Existing seams this leans on

The container e2e test already demonstrates most of the router-mode wiring; the rig
generalizes it from fake to real:

- `RouterServer` (`packages/router/src/RouterServer.ts:149`) — Fastify composition root.
  Constructor `RouterServerConfig` at `:80-142`. Test seams: `trackerFactory` (`:114-118`)
  and `executorRegistryFactory` (`:128-130`). Auto-registers the artifact route (`:237`),
  enrollment route (`:231`), and device WS gateway at `/device` (`:323`). Public readonly
  `server.eventRouter` (`:157`) accepts webhook fixtures via `route(event)`. `server.port`
  (`:293`) returns the bound port after `port: 0` — but the Fastify instance is **private** and
  Fastify v5 forbids adding routes after `listen()` (`:246`). Note `buildTransportConfig`
  (`:470-482`) special-cases a `getPlatformType() === "cli"` tracker to a CLI transport — this
  wires event *ingress* only; it does **not** mount `/cli/rpc` (that is `EdgeWorker`-only). See
  A1.
- `CLIIssueTrackerService` (`packages/core`) — injected via `trackerFactory` so no Linear is
  touched; holds activities in memory, readable the same way F1's CLI mode reads them.
- `LocalDockerProvider` (`packages/router-executors/src/LocalDockerProvider.ts:53`) — the
  real executor. `ensureRunning`/`stop`/`destroy`/`status`/`listManaged` per
  `ContainerExecutor` (`packages/router-executors/src/types.ts`).
- `ContainerBootCommand` (`apps/cli/src/commands/ContainerBootCommand.ts:189`) — the
  in-container entrypoint (`docker/worker/entrypoint.sh` → `container-boot`). Restore ladder
  `restoreState()` at `:328` returns `"warm" | "restored" | "fresh"`; writes a
  `platform:"router"` + `floorSync:true` config (`:679`) and launches `cyrus start`.
- Enrollment: `RouterStore.mintEnrollmentCode` / `redeemEnrollmentCode`
  (`packages/router/src/RouterStore.ts`), `POST /enroll` (`enrollment.ts:13`).
- Container routing seed: `store.setUserExecutor(email, JSON.stringify({type:"docker"}))`
  + `SecretStore.set(email, "claudeOauthToken", ...)`.

### A1 — Router-mode F1 server (item 1)

A new `apps/f1/router-server.ts`, sibling to `apps/f1/server.ts` (not a modification of it —
CLI mode stays intact as its own regression surface).

**Verified constraints (Codex review) that shape this component:**
- `RouterServer` keeps its Fastify instance **private** — no `getFastifyInstance()`, and all
  routes (`/enroll`, `/workspaces`, `/artifacts`, `/healthz`) are registered in the constructor
  because **Fastify v5 forbids adding routes after `listen()`** (`RouterServer.ts:246`,
  `:301-314`). The original "add F1 routes on the shared Fastify" is therefore impossible.
- The CLI-tracker path does **not** mount `/cli/rpc` on `RouterServer` — `createEventTransport`
  only builds a `CLIEventTransport` for event ingress; `/cli/rpc` is registered solely by
  `CLIRPCServer.register()`, which only `EdgeWorker` constructs (`EdgeWorker.ts:880`). So the
  existing `./f1` issue/session commands do **not** drive a router-mode server for free
  (Open Question #1 resolved: **no**).
- `routerUrlForContainers` is consumed at **construction** (`buildContainerTargets`,
  `RouterServer.ts:371-407`), but the bound port is only known after `start()`/`listen()`
  (`:293-299`, `:316`). A `port: 0` server cannot name its own `host.docker.internal:<port>`.

**Resulting design:**
- Drive the router **in-process**, exactly as the e2e suite does: feed webhooks via
  `server.eventRouter.route(fixture)`; seed users / executor / Claude secret directly through
  `server.store` + `SecretStore`; read artifacts from the artifacts dir; read session
  activities off the injected `CLIIssueTrackerService`. No routes are added to `RouterServer`.
- Bind `RouterServer` to a **fixed, pre-allocated port** (grab a free port, close it, pass it
  as `port`), so `routerUrlForContainers: ws://host.docker.internal:<port>` is known before
  construction and containers can dial back.
- Expose the human/agent control surface as a **separate Fastify on `127.0.0.1`, guarded by a
  bearer token** (its own port, owned by the F1 harness), with routes to: enroll+print a device
  token, inject `created`/`prompted`, seed user+executor+secret, inspect the artifact store,
  and view session activities. This keeps the control plane off any externally reachable
  interface (safety finding #2). `RouterServer`'s own `/device`, `/enroll`, and `/artifacts`
  remain the surfaces the container legitimately uses.
- `RouterServer` config: `trackerFactory: () => sharedCliTracker` (one shared
  `CLIIssueTrackerService`), `webhook: { verificationMode: "direct", secret }`, temp `dbPath`,
  `workspaces: { [ws]: { linearToken: "unused" } }`, and `containers: RouterContainersConfig`
  (real `cyrus-worker` image, fixed-port `routerUrlForContainers`, repositories, `secretsPath`,
  `idleStopMs`/`staleDestroyMs`). Default `executorRegistryFactory` (real `LocalDockerProvider`)
  or a `--fake-executor` flag selecting `FakeBootExecutor` for the no-Docker smoke path.
- New `./f1 router:*` CLI subcommands talk to the loopback control server (not `/cli/rpc`).
- Two device-attach modes:
  - **container** (default for this feature) — routing boots a real Docker container.
  - **physical device** (fallback / no-Docker) — an in-process `platform:"router"` EdgeWorker
    enrolled as a device (shape per `packages/edge-worker/test/router-platform.test.ts:17-31`).

**Alternative to weigh in the plan:** instead of a separate control server, add a small,
explicit loopback+token test-route seam to `RouterServer` (registered pre-`listen()`). The
in-process + separate-loopback approach is the default because it needs no production change to
`RouterServer`; pick during planning.

### A2 — Real-Docker lifecycle e2e (item 2)

New opt-in `packages/router/test/containers-real-docker.e2e.test.ts`, `describe.skipIf(no
daemon)` (probe `docker info`). Same harness shape as `containers-e2e.test.ts` but injects a
**real `LocalDockerProvider`** in `executorRegistryFactory`. Asserts against the real daemon:

- **boot serialization / dedup** — created+prompted for the same still-cold issue coalesces
  to one `docker run` (mirrors scenario 5, now real).
- **idle-stop** — `docker stop` after `idleStopMs`, driven by a second `ContainerLifecycle`
  with an injected clock (the technique at `containers-e2e.test.ts:500-514`); container →
  stopped, volume retained.
- **stale-destroy** — container + volume removed after `staleDestroyMs`.
- **orphan GC** — a container carrying a `cyrus.issue` label but no device row is swept.

**Host-daemon isolation (safety finding #1 — verified).** `LocalDockerProvider` hardcodes the
global `cyrus-issue-<KEY>` container/volume names and the `cyrus.issue` label
(`LocalDockerProvider.test.ts` confirms; the constructor exposes no prefix override), and
`listManaged()` enumerates **every** container on the daemon carrying that label. So a naive
suite would (a) let **orphan GC destroy a developer's real, running Cyrus containers** on the
same host, and (b) let a wildcard `cyrus-issue-*` teardown remove unrelated resources.
Mandatory mitigations:

- Run the suite against a **dedicated, disposable daemon** — a separate Docker context or an
  explicit `DOCKER_HOST` the suite requires (throwaway colima/DinD), never the developer's
  default daemon. The **orphan-GC scenario must not run against a shared daemon at all**, since
  orphan GC is host-global by construction.
- Use **run-scoped, collision-proof issue keys** (per-run random suffix) so created resources
  are identifiable.
- Scope teardown to the **exact** container/volume names the run created — never a
  `cyrus-issue-*` wildcard.
- Consider making the provider's name/label prefix **injectable** so tests can namespace their
  resources (`cyrus-e2e-<run>-issue-*`); flagged as a plan decision since it touches production
  `LocalDockerProvider` (Open Question #5).

### A3 — Floor upload round-trip (item 3)

**CI / scripted (credential-free):**
- Build a real WIP bundle from a real dirty worktree via `WorkspaceSyncService` /
  `buildBundle` (`packages/workspace-sync/src/bundle.ts:27`).
- `uploadBundle(httpBase, deviceToken, issueKey, file)`
  (`packages/workspace-sync/src/transport.ts:36`) → real `PUT
  /artifacts/issues/:issueKey/bundle` on the running RouterServer
  (`packages/router/src/artifacts.ts:80`).
- Boot a real **fresh** container (fresh volume) and assert `ContainerBootCommand.restoreState`
  hits **rung 2** (`downloadBundle` → `restoreBundle`, returns `"restored"`), reconstructing
  the session on the volume.
- This proves upload transport + artifact endpoint + container-side restore end-to-end,
  without a Claude token.

**Manual drive (real Claude):**
- Full path: real container, real Claude session dirties the worktree, floor fires on
  session-end (`syncIssueOnTermination`, wired at `EdgeWorker.ts:540`), idle-stop, and the
  periodic timer; a fresh container restores. Observed via `./f1`.

**Open choice (resolve in plan):** whether to add a test-only stub runner so the in-container
*trigger* (session-end → `syncIssue`) also runs in CI. **Recommendation: do not.** Keep CI at
the transport+restore seam; leave the trigger→upload integration hop to the real-Claude drive.
The trigger itself is already unit-tested in `WorkspaceSyncService` tests; a stub runner adds
surface for little marginal coverage.

### A4 — `/workspaces/<ISSUE-KEY>` real-directory invariant (item 4)

The invariant (`ContainerBootCommand.ts:182-187`, rationale in
`packages/workspace-sync/src/paths.ts:8-25`): `/workspaces/<ISSUE-KEY>` must be a real
directory, never a symlink, because the Agent SDK keys transcripts off the realpath-resolved
cwd.

**CI:** boot a real container, route an event that reaches `GitService` worktree creation
(`createSingleRepoWorktree`, `packages/edge-worker/src/GitService.ts:924`, workspace path at
`:960-962`), then `docker exec` to assert `/workspaces/<KEY>` exists, is a directory, is
**not** a symlink (`test ! -L`), and `realpath` resolves to itself.

**To confirm in the plan:** that worktree creation precedes the runner stream, so this holds
even with no valid Claude token (a session that starts and stalls still creates the worktree).

**Manual drive:** observe the same directory type live during a real running session.

## Track B — "No final `response`" anomaly (item 5)

Independent systematic-debugging flow. **The Codex review reframed this track** — the original
suspect list was inconsistent with the recorded evidence.

**The evidence contradiction (resolve this first).** The 2026-07-14 report quotes the server
log `Result message emitted to Linear (activity activity-89)`. That exact line fires **only**
inside `if (result.activityId)` and **only** for `entry.type === "result"`
(`AgentSessionManager.ts:1458-1463`) — proof that a `type: "response"` activity was built (past
the empty-content guard at `:896`), passed the `externalSessionId` and activity-sink checks
(`:1432`, `:1444`), was posted, and returned a truthy id. So the original suspects
(empty-content guard / sink skips) are **inconsistent with the evidence**: those paths would
have prevented that very log line. A response *was* emitted at the `AgentSessionManager` layer,
yet the tracker showed none and the issue stayed `active`. The gap is therefore **downstream of
the emit or in the terminal/status path** — not in `addResultEntry`'s guards.

1. **Fix the oracle.** Do not use issue `status: active` as the signal — CLI-tracker status
   semantics are not Linear's, so "stuck `active`" is not a reliable oracle in CLI mode. Use a
   layered, concrete oracle: (a) did `AgentSessionManager` log the result emit with an activity
   id? (b) did a `type: "response"` activity actually persist in the tracker's activity list?
   (c) did the terminal/status transition fire? The bug lives wherever (a) and (b)/(c) disagree.
2. **Reproduce** on `cyrus-containers` via a CLI-mode F1 drive, capturing all three oracle
   signals so the contradiction is observed directly rather than inferred.
3. **A/B against `origin/deploy`** — same drive, same oracle — to empirically confirm whether
   the anomaly predates this branch (the report only argued this from code paths).
4. **Root-cause from the contradiction**, with reframed suspects:
   - tracker-side persistence of the emitted `response` — does the CLI tracker's `postActivity`
     return an id without surfacing the activity? does `view-session` render `response`-type
     entries?
   - the terminal-state / issue-status path — `emitTerminalOnce` and the move-to-complete
     transition in the completion path, which governs whether the issue leaves `active`;
   - only then fall back to the `addResultEntry` guards, and only if the repro shows the emit
     log **absent** (which would flip the whole picture).
5. **Test the TODO's hypothesis** that this "rhymes with" the router-side
   `sessionTerminal`-ordering bug fixed earlier on this lineage — check whether both are faces
   of one completion/terminal-ordering gap.
6. **Deliver:** either a minimal fix with a failing-first regression test (if in scope), or a
   standalone issue carrying the reproduction + empirical attribution (if it is a pre-existing
   product bug out of this branch's scope).

## Sequencing

```
A1 (rig) ──► A2 (lifecycle e2e)
          ├► A3 (floor round-trip)
          └► A4 (dir invariant)

B (anomaly) ───────────────────►  (parallel throughout; no shared code)
```

## Testing strategy

- **A1:** the router-server boots and a `./f1 router:*` smoke drive routes an event to a
  `--fake-executor` (no Docker) in CI. The real-Docker device path is opt-in.
- **A2 / A3 / A4:** one opt-in real-Docker suite, `skipIf(no daemon)`, against a dedicated
  daemon with run-scoped teardown of exactly the resources it created (never a `cyrus-issue-*`
  wildcard). Credential-free (scripted); the real-Claude paths are manual test drives.
- **B:** failing-first regression test if a fix lands; otherwise a documented reproduction.
- All existing unit suites stay green; CLI-mode F1 remains an untouched regression surface.

## Open questions to resolve during planning

1. **Resolved (Codex review):** `RouterServer` does **not** expose `/cli/rpc` and keeps its
   Fastify private; the F1 control surface is a separate loopback+token server driving the
   router in-process (A1). Remaining sub-decision: separate control server vs. a loopback
   test-route seam added to `RouterServer`.
2. Add a test-only stub runner for the in-container floor trigger, or rely on the real-Claude
   drive? (A3 — recommendation: rely on the drive.)
3. Does `GitService` worktree creation precede the runner stream, enabling the A4 CI assertion
   without a valid Claude token? (A4)
4. Is item 5 in scope for a fix on this branch, or does A/B attribution to `origin/deploy`
   route it to a standalone issue? (B — decided by the A/B result.)
5. Should `LocalDockerProvider` gain an injectable name/label prefix so the A2 suite can
   namespace its resources, or is a dedicated-daemon requirement sufficient isolation? (A2)

## Success criteria

- A router-mode F1 server exists and can boot a container and route an in-container session
  end-to-end.
- The container lifecycle sweeps are proven against a real daemon (opt-in suite).
- The floor upload → artifact endpoint → fresh-container restore round-trip is asserted.
- The `/workspaces/<ISSUE-KEY>` real-directory invariant is asserted directly.
- The missing-final-`response` anomaly is empirically attributed and either fixed (with a
  regression test) or filed as a standalone issue with a reproduction.
