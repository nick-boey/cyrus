# Test Drive: CYR-78 — Observability commands

**Date**: 2026-09-09 (UTC)
**Issue**: CYR-78 — Validate observability commands with F1 and the dev fleet
**Goal**: Prove the remote-operator workflow — discovery, authorization, run
observation, log queries, guarded recovery, and trusted skill installation —
against deterministic F1 fixtures, before recovery is enabled anywhere.

> **Read the scope line first.** This drive covers the **automated F1 matrix**
> only. The **controlled dev-fleet drive** (steps 1–9 of CYR-78) was **not run**
> and is recorded as outstanding in [Not covered](#not-covered-and-why). Nothing
> below is evidence about Azure, Log Analytics, Entra tenant configuration, or
> the deployed `rg-cyrus-dev` router. **Production recovery remains disabled**,
> and this drive does not authorize enabling it.

## Environment

| Fact | Value |
| --- | --- |
| Commit under test | `3c21e0a5` (branch `nboey/cyr-78-validate-observability-commands-with-f1-and-the-dev-fleet`, base `main` @ `1cb084fe`) |
| Node | v22.20.0 |
| pnpm | 10.33.1 |
| Platform | Windows 11 Pro 10.0.26200 |
| Router under test | in-process `RouterServer` on `127.0.0.1`, ephemeral port |
| Container executor | `FakeContainerExecutor` with the **real** device-side WebSocket stack (`cyrus-router-client`) |
| Log source | `kind: "fake"`, resolved by the **shipped** `LogAdapterRegistry` |
| Azure resources touched | **none** |

## Commands run

```
pnpm --filter cyrus-f1 exec vitest run test/router/observability-commands.test.ts
pnpm --filter cyrus-f1 test:run
pnpm --filter cyrus-f1 typecheck
pnpm biome check apps/f1
pnpm typecheck
pnpm test:packages:run
```

Result at 2026-09-09T05:36Z (re-run after the review fixes below):

```
 Test Files  1 passed (1)
      Tests  42 passed (42)
```

and for the whole F1 package:

```
 Test Files  9 passed (9)
      Tests  86 passed (86)
```

## What the matrix actually asserts

Every row below runs against a **real `RouterServer`** over a real socket,
reading a real `RouterStore` whose rows were written by routing real webhooks
through `EventRouter`. No router document and no router response is faked
anywhere in the file.

Two kinds of client appear, and the tables say which. The **runs**, **logs**,
**recovery-through-`cyrus recover`**, and **skills** rows drive the *shipped CLI
command classes*. The remaining **recovery** rows and the **discovery**,
**principal**, and **restart** rows post raw HTTP, because they assert on router
status codes, response bodies, and refusals the CLI deliberately does not
surface verbatim. Both halves talk to the same router; only the recovery table
mixes them, so each of its rows is marked.

### Public discovery leaks no scoped data

| Scenario | Expected | Actual |
| --- | --- | --- |
| `GET /.well-known/cyrus` anonymously | 200 with router identity + auth methods only | ✅ exact-match on the whole document |
| The serialized body | contains no workspace id, issue key, session id, principal id, `logSource`, `budgets`, or `capabilities` | ✅ substring scan over the raw body |
| `GET /api/v1/logs`, `/api/v1/log-records`, `/logs` | 404 — the router serves no log records | ✅ |

### Principals receive exactly their roles and workspaces

| Principal | Expected | Actual |
| --- | --- | --- |
| Local token, `fleet.read` over `ws-1` | `runs.list`, `runs.changes`, `logs.query`; one workspace; descriptor + skill disclosed | ✅ |
| Local token, `fleet.read` + `fleet.recover` over both | adds `recoveries.request`; both workspaces in router order | ✅ |
| Entra `oid` matching the reader grant | `fleet.read`, `ws-1` only, no `recoveries.request` | ✅ |
| Entra token carrying the responder GROUP | union of both grants — `fleet.recover` and both workspaces | ✅ |
| Entra `idtyp: "app"` | 403 | ✅ |
| Entra wrong `tid` / wrong `aud` | 401 each | ✅ |
| Physical device token | `fleet.read`, and **`logs.query` withheld** (the router cannot narrow a log query to one owner) | ✅ |
| Container device token | 403, body `{"error":"forbidden"}` | ✅ |
| No credential / unknown token | 401, body `{"error":"unauthorized"}`, no explanation | ✅ |

The Entra verifier is injected in place of a remote JWKS, and returns the token's
own claims verbatim. `OperatorAuthorizer` re-checks tenant, issuer, audience,
expiry, `oid`, and `idtyp` itself, so the decision under test is the real one.

### Remote profile command tree

| Scenario | Expected | Actual |
| --- | --- | --- |
| `buildProgram(--profile remote)` | exactly `connection`, `runs`, `logs`, `recover`, `skills` | ✅ set equality |
| `buildProgram()` (full) | the same five, plus `router` and `start` | ✅ |

### Runs list / watch / wait

| Scenario | Expected | Actual |
| --- | --- | --- |
| `runs list` with two authorized workspaces and no `--workspace` | exit 2, diagnostic names `--workspace` | ✅ |
| `runs list --json --workspace ws-2` | only `ws-2`'s run | ✅ |
| `runs list` over seven seeded runs | `routed`, `waiting` (reason `elicitation`), `active` (pending work), `complete`, `error`, `stopped`, `unknown` | ✅ all seven |
| `runs wait` on a run that completes after the command started | exit 0, outcome `complete`, and the run was still `routed` when the command's opening snapshot was taken — so the transition can only have arrived over `/api/v1/run-changes` | ✅ (mutation-checked: finishing the run before the command starts fails the assertion) |
| `runs wait` on an elicitation | exit 3, outcome `waiting` — never a timeout | ✅ |
| `runs wait` on an `error` run | exit 3, outcome `error` | ✅ |
| `runs wait --timeout` on a run that never moves | exit 4, outcome `timeout`, last-observed lifecycle reported as an observation not a verdict | ✅ |
| `runs watch --timeout` | emits a `change` event carrying the NEW lifecycle (not merely the opening snapshot), then a `stopped`/`timeout` event, and exits 0 | ✅ (mutation-checked: denying the loop a poll inside the deadline fails the assertion) |

### Router-restart resynchronisation

| Scenario | Expected | Actual |
| --- | --- | --- |
| A cursor minted by one router process, replayed against a second process on the **same database** | `410` with `{"error":"stream_gone"}` — signature still valid, only the epoch rotated | ✅ |
| An in-flight recovery operation persisted by one process, then a second `RouterServer` started on the same database | the new process's start-up cleanup ends it `failed` with a restart message | ✅ (mutation-checked: removing `RouterServer.start()`'s `failInterruptedOperations()` call leaves the operation `accepted` and fails the test) |

### Log query and follow

| Scenario | Expected | Actual |
| --- | --- | --- |
| `logs query --json` against the advertised `fake` source | resolved by the **shipped** registry; the ONLY router path touched is `/api/v1/operator/context` | ✅ (fetch paths captured and asserted as a single-element list) |
| `logs query --since 6h` against a 3600s `maxRangeSeconds` budget | exit 2 — refused, never truncated | ✅ |
| A backend record containing the operator token verbatim | token absent from output, `[redacted]` present, compiled query carries the authorized workspace and no query language | ✅ |
| `logs follow --interval 10 --timeout 25` over a record re-served by the next, overlapping window | the record prints ONCE, the new one prints, and the second query's window provably starts before the first record's timestamp | ✅ |
| `logs follow` diagnostics | say it is a historical store polled on a delay, never a live router stream | ✅ |
| `logs follow --interval 1` against a 5s `minFollowIntervalSeconds` | exit 2, naming the floor | ✅ |

### Guarded recovery

| Scenario | Client | Expected | Actual |
| --- | --- | --- | --- |
| Read-only principal requests recovery | HTTP | 403 **before** any operation exists; `recovery.refused` audited, `recovery.accepted` not | ✅ |
| Quoted revision is stale | HTTP | 409 `stale_revision` | ✅ |
| Run waiting on an elicitation | HTTP | terminal phase `needs_input` | ✅ |
| Worker connected and still claiming the run | HTTP | terminal phase `refused`, reason `worker_owns_active_work` | ✅ |
| Same idempotency key retried | HTTP | first 202, second **200** joining the same `operationId`; `recovery.joined` audited | ✅ |
| Stranded run (worker ran it, then died; container stopped; affinity + issue lock held) | HTTP | phases `accepted → starting_executor → reconciling → replaying → recovered`; affinity cleared, issue lock cleared, run marked `unknown`; `recovery.accepted` / `phase_changed` / `settled` audited | ✅ |
| Same, but the recovered worker still claims the session | HTTP | `recovered` with "nothing was released"; **no** `releasing_stale_ownership` phase; affinity and run state untouched | ✅ |
| Recovery left disabled (the shipped default) | HTTP | `recoveries.request` absent from the context; the route still exists and refuses with 403 | ✅ |
| Operation interrupted by a router restart | HTTP | a SECOND `RouterServer` starts on the same file database and its start-up cleanup moves the persisted in-flight operation to `failed`; the operation resource on the new process reports it | ✅ |
| The whole thing through `cyrus recover <runId> --json` | **CLI** | exit 0, `operation.phase = "recovered"`, and every request the process made went to the router's own origin — so no Linear comment, by evidence rather than by output-scanning | ✅ |

The strand is produced the way a real one occurs: route the issue, let the
container boot, let its worker connect and drain the router's queue, then kill
the worker. A run whose event was never delivered is *un-started*, not stranded,
and the reconciler correctly refuses to judge a worker's silence about work it
may not have received — testing that refusal while calling it recovery would have
been the easy mistake here.

### Trusted skill archive, checksum, and install

| Scenario | Expected | Actual |
| --- | --- | --- |
| Bytes match the router-advertised and published checksum | installed; every non-router fetch is under `https://github.com/cyrusagents/cyrus/releases/` | ✅ |
| One byte flipped after publication | exit 2, refused | ✅ |
| Router advertises a checksum the published sidecar disagrees with | exit 2, refused | ✅ |
| Router advertises a skill version out of lockstep with the CLI | exit 2, refused **before any download** (asserted: zero non-router fetches) | ✅ |

### Skill decisions — a STRUCTURAL check, not a behavioural one

Whether an agent *follows* these instructions is not something an assertion in
this file can answer. CYR-77's drive
([`2026-09-08-cyr-77-fleet-skill.md`](2026-09-08-cyr-77-fleet-skill.md)) walked
the six response branches by hand against scripted JSON, and that remains the
behavioural evidence. What is checkable here is that a later edit cannot quietly
delete a branch or introduce a break-glass command.

| Scenario | Expected | Actual |
| --- | --- | --- |
| `skills/cyrus-fleet-operator/SKILL.md` + every `references/*.md` | names an observe path, a narrow-log path, a recover path (idempotency + revision), and a stop path (`needs_input`, refusal, stale) | ✅ |
| Every `cyrus <verb>` the instructions mention | is a member of `REMOTE_PROFILE_REGISTERED` — no `router unlock`, no `containers destroy`, no `start` | ✅ |

## New F1 controls

`./f1 router:strand-run` (and its `POST /router/strand-run` control endpoint)
routes an issue and reports whether the resulting run has reached the strand a
guarded recovery needs — run id, revision, device id, worker connectivity,
queued-event state, the affinity and issue-lock holders, and how long ago the
session was claimed.

It **observes; it does not fabricate**, and that distinction was the review's
first finding against an earlier version of it. Routing writes the run row, the
affinity and the issue lock, and the executor boots the container whose worker
drains the router's queue — but what makes a run *stranded* is that worker then
going away, which is the drive's own act (stop the container, suspend the
sandbox, kill the process). The first cut instead wrote
`executor_state = 'stopped'` and returned immediately, which recorded a fact
about an executor nobody had stopped and handed back a run whose event was still
queued — a run `RouterRunReconciler` correctly refuses to judge ("the worker's
session list is not yet authoritative"). A drive would have read that refusal as
a recovery bug. It now waits up to `--timeout` for the strand and reports
`recoverable: false` with `blockedBy` when it has not appeared.

It cannot check the third precondition — `containers.affinityGraceMs`, ten
minutes by default — because that value is not readable from the control plane,
so `sessionClaimedMsAgo` is reported raw for the drive to measure against its own
router configuration rather than guessed at.

```
./f1 router:strand-run --session-id sess-1 --issue-id issue-1   --identifier CYOBS-1 --creator-id lin-1 --creator-email dev@example.com   --timeout 60 --json
```

## Not covered, and why

The **controlled dev-fleet drive** — CYR-78 steps 1 through 9 — was **not run**.
It requires provisioning that this session could not perform and that is not the
agent's to authorize:

1. Deploying read-only observation/log capabilities to the `rg-cyrus-dev` router.
2. An Entra read principal, its grant, and an `az login` able to mint a token for
   the router audience. (`cyrus connection add --auth entra` is refused in this
   environment; fleet CLI access there goes through `az containerapp exec`.)
3. Read-only `az monitor log-analytics query` runs against `rg-cyrus-dev` /
   `ContainerAppConsoleLogs_CL`, compared field-by-field to source rows —
   including correlation fields, trace IDs, redaction, budgets, and ingestion lag.
4. Network/audit evidence that the CLI reached Azure directly and the router
   returned only the descriptor.
5. Enabling `fleet.recover` for an isolated test workspace/principal, running a
   live recovery, and **disabling the grant again** afterwards.

Consequences, stated plainly:

- **`enableFleetRecovery` stays `false`.** The deployment-side kill switch is
  unchanged by this drive, and this drive is not the evidence that unlocks it.
- The **Azure Log Analytics adapter** is exercised only by its own unit and
  contract suites (`apps/cli/src/remote/logs/*.test.ts`), never against a live
  workspace. Ingestion lag, redaction over real rows, and the KQL the adapter
  compiles remain unverified end to end.
- **Entra token acquisition** — the credential chain, the audience, the tenant's
  app registration — is unverified. What is verified is the router's *decision*
  given claims, which is the half F1 can own.
- Concurrency shapes that need two real racing clients (concurrent recovery of
  one run, concurrent revision change mid-flight) are covered by
  `packages/router/test/fleet-operations/RecoveryService.test.ts` and
  `RouterRunReconciler.test.ts` at the unit level, not here.

## Cleanup

Every scenario allocates its own temp directory (`f1-obs-*`), its own ephemeral
port, and an in-memory SQLite database except the restart case, which uses a file
database in its own temp directory. All are removed in `afterEach`/`finally`.
Device sockets are closed by the harness's `stop()`. Nothing outside the temp
directories is written, and no external service is contacted.

## Independent review

The change was reviewed by an independent cross-model reviewer (Codex CLI,
read-only, against the branch diff). It returned `inconclusive` with three
medium findings, all of which were real and all of which are fixed above:

1. **The `router:strand-run` control produced the un-started shape the matrix
   explicitly excludes** — it wrote an executor state nobody had established and
   returned a run whose event was still queued. Rewritten to observe and wait.
2. **The change-feed assertions could pass without observing a change** — the
   `watch` assertion was satisfied by the opening snapshot, and the `wait`
   scenario used a 20ms wall-clock delay that a slow first request would lose.
   Both now mutate from inside the injected `sleep` and assert on the change
   event itself; both were mutation-checked.
3. **The restart scenario called the store method rather than exercising
   start-up** — removing `RouterServer.start()`'s cleanup would have left it
   passing. It now starts a second `RouterServer` on the same file database, and
   was mutation-checked against exactly that deletion.

Its remaining next-steps were taken as follows. The missing `logs follow`
scenarios were added. The documentation claims were narrowed: the CLI-versus-HTTP
split is now stated per row, and the "no Linear comment" assertion — previously a
scan of stdout for `linear.app`, which proves nothing, since a post leaves no
trace in stdout — is now an assertion that every request the process made went to
the router's own origin. The skill-decision check is relabelled as structural,
with CYR-77's drive named as the behavioural evidence.

One next-step was **not** adopted: the reviewer flagged clean-checkout CLI build
ordering as a possible hazard of `cyrus-f1` deep-importing `cyrus-ai/dist`. It is
not a new one. `cyrus-f1` already resolves every workspace dependency to its
built `dist` (`cyrus-router`'s `main` is `dist/index.js`), so its tests already
require a prior `pnpm build`, and CI runs `pnpm build` before `pnpm -r test:run`.
The reviewer also could not read the repository — its sandbox blocked file
access — so its verdict is `inconclusive` on evidence completeness rather than on
a defect, and its concurrency-substitution question was answered from the unit
suites named above.

## Retrospective

Pass, for the automated matrix, after the review pass. The integration seam
earned its keep twice over: writing it surfaced that a fake worker with no event
consumer leaves the router's queue unacked, which makes every recovery refuse —
the same shape a real cold-booted sandbox produces, and precisely the guard
CYR-81 added — and reviewing it surfaced that the F1 command shipped alongside
the matrix reproduced that un-started shape rather than the strand. Nothing in
the CLI or the router had to change to make the matrix pass, which is the outcome
expected if the two halves already agreed; the value of the file is that a future
disagreement now fails here rather than in a fleet.

The project's exit criterion is **not** met by this document alone. CYR-78 asks
for both halves, and the dev-fleet half is outstanding.
