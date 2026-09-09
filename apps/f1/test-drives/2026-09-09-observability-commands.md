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
| Commit | `1cb084fe` (`main`) |
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

Result at 2026-09-09T04:47Z:

```
 Test Files  1 passed (1)
      Tests  40 passed (40)
```

and for the whole F1 package:

```
 Test Files  9 passed (9)
      Tests  84 passed (84)
```

## What the matrix actually asserts

Every row below runs the **shipped CLI command classes** against a **real
`RouterServer`** over a real socket, reading a real `RouterStore` whose rows were
written by routing real webhooks through `EventRouter`. No router document and no
router response is faked anywhere in the file.

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
| `runs wait` on a run that completes after the command started | exit 0, outcome `complete`, observed through the **change feed** | ✅ |
| `runs wait` on an elicitation | exit 3, outcome `waiting` — never a timeout | ✅ |
| `runs wait` on an `error` run | exit 3, outcome `error` | ✅ |
| `runs wait --timeout` on a run that never moves | exit 4, outcome `timeout`, last-observed lifecycle reported as an observation not a verdict | ✅ |
| `runs watch --timeout` | streams the material change and exits 0 | ✅ |

### Router-restart resynchronisation

| Scenario | Expected | Actual |
| --- | --- | --- |
| A cursor minted by one router process, replayed against a second process on the **same database** | `410` with `{"error":"stream_gone"}` — signature still valid, only the epoch rotated | ✅ |

### Log query and follow

| Scenario | Expected | Actual |
| --- | --- | --- |
| `logs query --json` against the advertised `fake` source | resolved by the **shipped** registry; the ONLY router path touched is `/api/v1/operator/context` | ✅ (fetch paths captured and asserted as a single-element list) |
| `logs query --since 6h` against a 3600s `maxRangeSeconds` budget | exit 2 — refused, never truncated | ✅ |
| A backend record containing the operator token verbatim | token absent from output, `[redacted]` present, compiled query carries the authorized workspace and no query language | ✅ |

### Guarded recovery

| Scenario | Expected | Actual |
| --- | --- | --- |
| Read-only principal requests recovery | 403 **before** any operation exists; `recovery.refused` audited, `recovery.accepted` not | ✅ |
| Quoted revision is stale | 409 `stale_revision` | ✅ |
| Run waiting on an elicitation | terminal phase `needs_input` | ✅ |
| Worker connected and still claiming the run | terminal phase `refused`, reason `worker_owns_active_work` | ✅ |
| Same idempotency key retried | first 202, second **200** joining the same `operationId`; `recovery.joined` audited | ✅ |
| Stranded run (worker ran it, then died; container stopped; affinity + issue lock held) | phases `accepted → starting_executor → reconciling → replaying → recovered`; affinity cleared, issue lock cleared, run marked `unknown`; `recovery.accepted` / `phase_changed` / `settled` audited | ✅ |
| Same, but the recovered worker still claims the session | `recovered` with "nothing was released"; **no** `releasing_stale_ownership` phase; affinity and run state untouched | ✅ |
| Recovery left disabled (the shipped default) | `recoveries.request` absent from the context; the route still exists and refuses with 403 | ✅ |
| Operation interrupted by a router restart | `failInterruptedRecoveryOperations` moves it to `failed`; the operation resource reports `failed` | ✅ |
| The whole thing through `cyrus recover <runId> --json` | exit 0, `operation.phase = "recovered"`, **no Linear comment** (the command has no Linear client) | ✅ |

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

### Scripted skill decisions

| Scenario | Expected | Actual |
| --- | --- | --- |
| `skills/cyrus-fleet-operator/SKILL.md` + every `references/*.md` | names an observe path, a narrow-log path, a recover path (idempotency + revision), and a stop path (`needs_input`, refusal, stale) | ✅ |
| Every `cyrus <verb>` the instructions mention | is a member of `REMOTE_PROFILE_REGISTERED` — no `router unlock`, no `containers destroy`, no `start` | ✅ |

## New F1 controls

`./f1 router:strand-run` (and its `POST /router/strand-run` control endpoint)
routes an issue and reports the run facts a guarded recovery needs — run id,
revision, device id, worker connectivity, executor state. It fabricates no state:
`EventRouter` writes the run row, the session affinity, and the issue lock on the
way through, and the fake executor simply never dials back. It exists because
`cyrus recover` takes a run id and the operator surface will not hand one out for
a run the caller has not already listed.

```
./f1 router:strand-run --session-id sess-1 --issue-id issue-1 \
  --identifier CYOBS-1 --creator-id lin-1 --creator-email dev@example.com --json
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

## Retrospective

Pass, for the automated matrix. The integration seam earned its keep: writing it
surfaced that a fake worker with no event consumer leaves the router's queue
unacked, which makes every recovery refuse — the same shape a real cold-booted
sandbox produces, and precisely the guard CYR-81 added. Nothing in the CLI or the
router had to change to make the matrix pass, which is the outcome that would be
expected if the two halves already agreed; the value of the file is that a future
disagreement now fails here rather than in a fleet.

The project's exit criterion is **not** met by this document alone. CYR-78 asks
for both halves, and the dev-fleet half is outstanding.
