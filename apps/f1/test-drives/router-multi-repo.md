# Test Drive: Router multi-repository routing (Task 18)

**Date**: 2026-08-06
**Goal**: End-to-end validate registry-based repository routing for router-mode Cyrus — registry seeding, the four routing-priority scenarios, ambiguity elicitation, the `/setup/repositories` UI, and the clone-saving `CYRUS_REPOS_JSON` scoping — per `.superpowers/sdd/2026-08-05-router-multi-repo-routing/task-18-brief.md`.
**Test Repo**: none (no worktree needed — this drive exercises the router's own repository-registry/routing logic, not a Claude coding session)
**Rig**: Real in-process `RouterServer` (`packages/router`) constructed via a purpose-extended F1 `RouterRig`, with a real `RepositoryRegistry` (file-backed), real `EventRouter`/`RepositoryResolver`/`ContainerTargets`, F1's real `CLIIssueTrackerService` (wrapped only at `fetchIssue` to inject team/project facts — see Finding 1), and a fake `ContainerExecutor` that records what it was asked to boot instead of touching Docker. Real HTTP (`fetch`) against the router's own Fastify instance drives the `/setup/repositories` UI.

## Scope note — why this isn't a Docker/Linear drive

The brief's four scenarios and the setup-UI checks are entirely router-side: they exercise `RepositoryRegistry` → `RepositoryResolver` → `EventRouter` → `ContainerTargetService.buildEnv`, all of which run before any container boots. Following the precedent of `2026-07-26-router-mode-fake-aca-lifecycle.md` (real in-process `RouterServer`, fake control plane where a real one isn't needed), this drive uses a fake `ContainerExecutor` and never touches Docker or a live Linear workspace. Docker itself is available in this environment (confirmed with `docker info`), but a real container boot was not the right tool here: the brief's example repository slugs (`f1/alpha`, `f1/beta`, `f1/gamma`) are not real GitHub repositories, so a real `git clone` inside a real container would fail regardless of routing correctness. See Step 5 / Finding 3 below for what this means for the literal "one directory" check.

## What changed to run this drive

- **`apps/f1/src/router/RouterRig.ts`**: extended `RouterRigOptions` with three new optional fields — `repositories` (overrides the rig's hardcoded single "cyrus" repo), `setupUi` (forwarded verbatim to `RouterServerConfig.setupUi`, off by default as today), and `wrapTracker` (lets a caller wrap the rig's real `CLIIssueTrackerService` before `RouterServer` receives it as `trackerFactory`, while `rig.tracker` stays the unwrapped instance for direct seeding via `getState()`). All three default to today's exact behavior — every existing F1 router test still passes unmodified (see Local Gates). This was necessary because the stock rig hardcodes exactly one repository and never enables the setup UI; see Finding 1 for why `wrapTracker` was also necessary.
- **`apps/f1/test/router/repo-routing.test.ts`** (new): the drive itself, a 10-case Vitest file described scenario-by-scenario below. This *is* the recorded drive — it is real production code run for real, not a rehearsal for a manual run I then had to describe.

No other files were touched. No fixtures outside `apps/f1` were modified.

## Verification Results

### Step 2 — Registry seeding

- [x] Seeded `containers.repositories` with `alpha` (`teamKeys:[ALPHA]`, `projectKeys:[Platform]`), `beta` (`teamKeys:[BETA]`), `gamma` (`isDefault:true`).
- [x] Router start logged: `Seeded the repository registry with 3 repositories from containers.repositories. The stored registry is authoritative from now on.`
- [x] `rig.server.repositoryRegistry.list()` confirms exactly `["alpha","beta","gamma"]` stored.

### Step 3 — The four scenarios

- [x] **Scenario 1, team hit.** Issue `BETA-1`, facts `{teamKey: "BETA"}`. Log: `Repositories for BETA-1: [beta] (team-based)`. `CYRUS_REPOS_JSON` for the booted container: `[{"name":"beta","githubSlug":"f1/beta","linearWorkspaceId":"ws-1","teamKeys":["BETA"]}]` — exactly one repository.
- [x] **Scenario 2, project beats team.** Issue `BETA-2`, facts `{teamKey: "BETA", projectName: "Platform"}`. Log: `Repositories for BETA-2: [alpha] (project-based)`. `CYRUS_REPOS_JSON`: one entry, `alpha`. Confirms the priority order (project tier resolved before team tier ran at all) rather than merely "alpha also happening to match."
- [x] **Scenario 3, default fallback.** Issue `ZETA-1`, facts `{teamKey: "ZETA"}` (a team no repository claims). Log: `Repositories for ZETA-1: [gamma] (default)`. `CYRUS_REPOS_JSON`: one entry, `gamma`.
- [x] **Scenario 4, ambiguity elicitation.** Gave `beta` `projectKeys:["Platform"]` too (via `repositoryRegistry.put`, a real conditional write against the same store the setup UI uses), then delegated issue `PLAT-4` with facts `{projectName: "Platform"}`:
  - Log: `Posted a repository selection for PLAT-4 (ambiguous) with options [alpha, beta]; holding the created event`.
  - `store.getIssueRepositories("PLAT-4")` — `undefined` (nothing decided yet).
  - `store.getContainerDeviceForIssue("PLAT-4")` — `undefined` (**no container device row**, confirmed).
  - `store.getPendingRepoSelection("sess-plat-4")` — `{issueKey: "PLAT-4", options: ["alpha","beta"]}`.
  - No boot was recorded for `PLAT-4` at this point.
  - The actual Linear-shaped activity posted (captured straight from the CLI tracker's in-memory activity log, not reconstructed): `{"type":"elicitation","content":"Which repository should I work in for this issue?","signal":"select"}`.
  - Answering with body `"beta"`: log `Repositories for PLAT-4: [beta] (user-selected)`, then `Session sess-plat-4 selected repository beta`. `store.getPendingRepoSelection` is now `undefined`. The held `created` webhook is replayed and a container boots — log: `booting docker container for PLAT-4 (device 4)` → `docker container for PLAT-4 (device 4) reported running`. `CYRUS_REPOS_JSON`: one entry, `beta`.

### Step 4 — Setup UI

Driven with real HTTP (`fetch`) against the router's own listening Fastify instance, `setupUi.auth.mode: "dev-insecure-headers"`, bound to `127.0.0.1` (required — this mode refuses to start off loopback).

- [x] `GET /setup/repositories` lists all three, rendered as `assoc:<name>` input values: `alpha` → `p=Platform,t=ALPHA`, `beta` → `t=BETA` (before the tie), `gamma` → `""` (empty, it routes only via `isDefault`).
- [x] After tying `beta` to `projectKeys:["Platform"]` (Scenario 4's setup), the same `GET` now renders `<article role="alert" data-testid="ambiguity-banner">` containing: `Repositories "alpha" and "beta" both claim project "Platform" — Cyrus will have to ask which one to use.` (HTML-escaped as `&quot;` in the raw response, confirmed).
- [x] Adding a repository: `POST /setup/repositories` with `name=delta, githubSlug=f1/delta` → 200, `delta` appears on the next `GET`.
- [x] Moving the default: `POST /setup/repositories/save` with `isDefault=delta` (resubmitting all four rows, since `applyRepositoryEdits` drops any row not resubmitted) → 200; registry snapshot shows `delta.isDefault === true`, `gamma.isDefault === undefined`.
- [x] Reflected in the next issue's routing: delegating issue `OMEGA-1` on unclaimed team `OMEGA` immediately after the move resolves to `Repositories for OMEGA-1: [delta] (default)` — **not** `gamma`.
- [x] Deleting `delta`: `DELETE /setup/repositories/delta` with the CSRF token as a header → 200; the next registry snapshot is back to exactly `["alpha","beta","gamma"]`.

### Step 5 — Clone saving

- [x] **Router-side mechanism, confirmed for real.** Every `CYRUS_REPOS_JSON` captured above (Scenarios 1–4) contains exactly **one** repository object, never all three — this is the literal env var a real container-boot would read to decide what to `git clone`, built by `ContainerTargetService.buildEnv` → `reposForIssue` from the router's own persisted decision (`RouterStore.getIssueRepositories`), not from the full registry.
- [ ] **Not executed: literal `$WORKSPACES/repos/` directory count inside a real booted container.** This requires the full credentialed pipeline in `apps/f1/test-drives/README-router-mode.md` (build `cyrus-worker:test`, a real Claude OAuth token, real Docker networking) *and* GitHub-reachable repository slugs. The brief's own example slugs (`f1/alpha`, `f1/beta`, `f1/gamma`) don't exist on GitHub, so a real `git clone` would fail on repo-not-found regardless of whether routing picked the right one — that failure mode would tell us nothing about this feature. Doing this properly would mean re-registering the three test repositories against real, reachable GitHub repos and running the full README-router-mode.md pipeline; that is a materially bigger, credential-bearing drive and was left out of scope here. Flagging this explicitly rather than claiming it passed.

## Findings

**Finding 1 (real, not smoothed over): F1's `CLIIssueTrackerService` cannot itself drive team- or project-based repository routing.** `CLIIssueTrackerService.fetchIssue()` returns an `Issue` built by `createCLIIssue()` (`packages/core/src/issue-tracker/adapters/CLITypes.ts:328-339`), whose `.team` and `.project` getters are hardcoded `return undefined;` regardless of the issue's real `teamId`/`projectId`. `RepositoryResolver`'s facts come from `LinearExecutor.fetchIssueFacts()`, which reads exactly those two getters (`packages/router/src/LinearExecutor.ts:265-286`). The result: routing an issue created through F1's own `create-issue`/`router:inject` commands against a real, unmodified `CLIIssueTrackerService` would **always** fall through team/project matching to the `isDefault` tier (or "unmatched"), no matter what team or project the issue actually has — Scenarios 1, 2, and 4 as literally described in the brief ("delegate an issue on team BETA") are not drivable through F1's stock CLI tracker today. `CLITypes.ts:640-641` even says so explicitly: *"The F1 test harness has no project data store — there is nothing to seed and no test drive exercises project-based routing on this adapter."* This drive worked around the gap with `wrapTracker`, a `RouterServer` test seam already documented as such in its own JSDoc (`trackerFactory` — "Test seam...lets tests inject fake trackers"), rather than modifying `packages/core`. That keeps this drive's footprint to `apps/f1` only, but it means the workaround, not the stock harness, is what actually exercised the resolver's team/project logic. If the team wants F1's own CLI (`./f1 router:inject`) able to drive these scenarios without a custom test harness, `CLIIssueTrackerService` needs real team/project resolution wired into `fetchIssue`.

**Finding 2 (minor, cosmetic): a synthetic `moveIssueToStartedState` warning fires on every resolved scenario.** Each successful routing (Scenarios 1, 2, 3, and the post-answer half of 4) also logged `Failed to move issue <id> to a started state: Team undefined not found` / `...has no team`. This is a side effect of this drive's synthetic issues existing only in the `wrapTracker` facts map, not as full `CLIIssueData` records with a real team/workflow-state — a gap in this drive's own setup, not a router bug. A real Linear-backed deployment (or an F1 issue actually created via `tracker.createIssue()`) has this data and would not hit it. Noted for completeness since the instruction was to record surprises rather than filter them.

**Finding 3 (scope limit, not a failure): Step 5's literal directory check was not executed** — see Step 5 above. The router-side mechanism that this check exists to validate (scoped `CYRUS_REPOS_JSON`) was verified directly and repeatedly; the downstream `git clone` behavior inside `apps/cli`'s container-boot command is unrelated to this task's own code (Tasks 1-17 touch the router side only) and is already the credentialed drive's job, not this one's.

**Finding 4 (confirms a known pre-existing gap, not new): running the full `test/router/` suite still leaks `apps/f1/repositories.json`.** Three already-committed sibling test files (`router-rig.test.ts`, `control-server.test.ts`, `aca-lifecycle.test.ts`) construct their rig with `dbPath: ":memory:"` and no explicit `repositoriesPath`; `RouterContainersConfig.repositoriesPath` then defaults to `join(dirname(":memory:"), "repositories.json")` = `./repositories.json`, i.e. the process cwd (`apps/f1` under `pnpm --filter cyrus-f1 exec vitest`). This is exactly the leak the task instructions warned about, and it reproduced during this drive's "no regressions" run (Session Log, below) even though this drive's own new test always passes an explicit tmpdir `dbPath`/`repositoriesPath` via `artifactsDir`/`dbPath` and never leaks. The leaked file was deleted before committing this drive. Fixing the three pre-existing test files to pass an explicit `repositoriesPath` is straightforward but out of scope for Task 18 (they predate this task); flagging it here so it isn't silently rediscovered again.

**No other surprises.** Routing priority (description tag > labels > project > team > default — only project/team/default were exercised, since the brief's scenarios don't cover description-tag or label routing), the ambiguity/no-container-device/held-event behavior, the replay-on-answer behavior, the setup UI's association rendering/ambiguity banner/add/edit/move-default/delete, and the `CYRUS_REPOS_JSON` scoping all behaved exactly as `.superpowers/sdd/2026-08-05-router-multi-repo-routing-design.md` and the task-18 brief predicted.

## Session Log

Relevant builds:

```bash
pnpm --filter cyrus-core --filter cyrus-router-protocol --filter cyrus-router-executors --filter cyrus-router build
```

Result: **PASS** — 4/4 packages built.

The drive itself:

```bash
pnpm --filter cyrus-f1 exec vitest run test/router/repo-routing.test.ts
```

Result: **PASS**, 1 file / 10 tests. (An identical scenario run through a throwaway, unbuilt evidence script — deleted before commit, never part of the diff — is what produced the exact log-line and JSON transcripts quoted under Step 3/Step 4 above; every quoted line is real captured output, not reconstructed from reading the source.)

No-regression check — every existing F1 router test, including the new file:

```bash
pnpm --filter cyrus-f1 exec vitest run test/router/
```

Result: **PASS**, 8 files / 34 tests.

## Local Gates

| Gate | Result |
|---|---|
| `pnpm --filter cyrus-f1 exec vitest run test/router/` | **PASS**: 8 files / 34 tests |
| `pnpm --filter cyrus-f1 typecheck` | **PASS** |
| `pnpm build` | **PASS**: all 21 participating workspace projects |
| `pnpm typecheck` | **PASS**: all 21 participating workspace projects |

`pnpm test:packages:run`, `pnpm lint`, and `pnpm audit` (repo-wide) were not re-run for this drive beyond the scoped commands above — this task's own diff is two files in `apps/f1` with no product-code changes, and the scoped gates above cover both directly.

All commands warn that the host is Node 26.5.0 while the repository requests Node 22.x, and that pnpm 10 ignores the stale root `package.json` `pnpm` field (per this repo's standing note in `pnpm-workspace.yaml`). Neither warning affected any gate above.

## Final Retrospective

The registry-seeding, routing-priority, elicitation/hold/replay, `CYRUS_REPOS_JSON` scoping, and setup-UI mechanics from Tasks 1-17 all behaved exactly as designed when driven end-to-end through the real `RouterServer`/`EventRouter`/`RepositoryResolver`/`ContainerTargetService`/`RepositoryRegistry` stack — this is a genuine pass, not a smoothed-over one. The one real gap this drive surfaced is upstream of Tasks 1-17 entirely: F1's own `CLIIssueTrackerService` cannot supply team/project facts, so F1's stock CLI (`create-issue` + `router:inject`) cannot itself drive team- or project-based routing without the `wrapTracker` seam this drive added. That's a pre-existing F1 harness limitation (documented in the adapter's own comment) surfaced by being the first drive to actually need it, not a defect in the multi-repo routing feature. The literal container-directory clone check (Step 5's second half) is the only checklist item left unexecuted, and only because the brief's example repository slugs aren't real GitHub repositories — the mechanism it would confirm (that the container reads exactly the repositories named in `CYRUS_REPOS_JSON`) is not in question and not something Tasks 1-17 could break; that logic lives in `apps/cli`'s container-boot command, outside this task's diff.
