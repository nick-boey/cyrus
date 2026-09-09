# Test Drive: CYR-78 — Observability commands

**Date**: 2026-09-09 (UTC)
**Issue**: CYR-78 — Validate observability commands with F1 and the dev fleet
**Pull request**: [#77](https://github.com/nick-boey/cyrus/pull/77)
**Follow-up**: [CYR-89](https://linear.app/northrop-digital/issue/CYR-89/verify-the-operator-surface-post-deployment-and-decide-the-recovery) — everything below that is gated on a deployment change
**Goal**: Prove the remote-operator workflow — discovery, authorization, run
observation, log queries, guarded recovery, and trusted skill installation —
against deterministic F1 fixtures, before recovery is enabled anywhere.

> **Read the scope line first.** This drive has two halves. The **automated F1
> matrix** ran in full. The **controlled dev-fleet drive** (steps 1–9 of CYR-78)
> ran only in part, **read-only**, against the live `rg-cyrus` router — steps 3
> and 4 partially, steps 1 and 2 blocked by deployment configuration, and steps
> 5–9 not run at all. What was and was not reached is enumerated in
> [Controlled dev-fleet drive](#controlled-dev-fleet-drive--partial-read-only).
> Nothing was deployed, enabled, unlocked or destroyed. **Recovery remains
> disabled**, and this drive does not authorize enabling it.

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

## Controlled dev-fleet drive — partial, read-only

Run 2026-09-09 05:5x–06:33Z against the **live** dev fleet, subscription
`dit-development`, resource group `rg-cyrus`, router
`app-cyrus-dev-router.calmsea-e4dd7bc4.australiaeast.azurecontainerapps.io`,
revision `app-cyrus-dev-router--0000039`, image
`ghcr.io/nick-boey/cyrus-router:sha-a51fcca`. That image is built from `a51fccad`
(PR #74), so it carries the whole CYR-64…CYR-77 operator surface — it is new
enough for this drive.

**Every action below is a read.** Nothing was deployed, enabled, unlocked,
destroyed or written. `enableFleetRecovery` was not touched.

### The deployment's own posture, read rather than assumed

`az containerapp show` reports **no `CYRUS_ROUTER_FLEET_OPERATIONS_JSON` env var
at all**, so the router runs with no `fleetOperations` block: no Entra grants, no
log source, no recovery. That is the safe default holding in production, and it
is what the two gaps below follow from.

```bash
az containerapp show -g rg-cyrus -n app-cyrus-dev-router \
  --query "properties.template.containers[0].env[].name" -o tsv
```

### F1 matrix predictions, checked against the real router

Each of these is an assertion in `observability-commands.test.ts`, re-run by hand
against the deployment. All matched.

| Prediction | Live result |
| --- | --- |
| Discovery answers anonymously with identity and auth methods only | `{"schemaVersion":1,"routerId":"cyrus-router","operatorApiVersions":["v1"],"authentication":{"methods":["device-token","local-operator-token"]}}` — HTTP 200 |
| Discovery leaks no scoped data | No workspace id, issue key, session id, principal id, `logSource`, `budgets` or `capabilities` in the body |
| `entra` advertised only when configured | Absent, and the deployment has no grants — consistent |
| Unauthenticated operator routes refuse without explaining | `/api/v1/operator/context`, `/api/v1/runs`, `/api/v1/run-changes` → `401 {"error":"unauthorized"}` |
| The router serves no route returning log records | `/api/v1/logs` → `404 Route GET:/api/v1/logs not found` |

```bash
ROUTER=https://app-cyrus-dev-router.calmsea-e4dd7bc4.australiaeast.azurecontainerapps.io
curl -sS -w "\nHTTP %{http_code}\n" "$ROUTER/.well-known/cyrus"
for p in /api/v1/operator/context /api/v1/runs /api/v1/run-changes /api/v1/logs; do
  curl -sS -o /tmp/body -w "%{http_code}" "$ROUTER$p"; head -c 120 /tmp/body; done
```

### The router's own view of the fleet

```bash
MSYS_NO_PATHCONV=1 az containerapp exec -g rg-cyrus -n app-cyrus-dev-router \
  --command "cyrus router sessions list"
MSYS_NO_PATHCONV=1 az containerapp exec -g rg-cyrus -n app-cyrus-dev-router \
  --command "cyrus router containers list"
MSYS_NO_PATHCONV=1 az containerapp exec -g rg-cyrus -n app-cyrus-dev-router \
  --command "cyrus router operators list"
```

21 ACA containers, 4 sessions (one `locked`, three `running`), 2 pre-existing
`fleet.read` operator tokens over workspace
`75294f85-72ad-42ef-b9d7-c6ded611fc42`.

### CYR-72's canonical attribution, verified on live rows

Every `cyrus.*` field CYR-72 specifies is present on a real
`session.terminal_signalled` record emitted by a sandbox minutes earlier:

```
cyrus.workspace_id, cyrus.workspace_name, cyrus.owner_id, cyrus.owner_name,
cyrus.team_id, cyrus.team_name, cyrus.project_id, cyrus.project_name,
cyrus.issue_key, cyrus.run_id, cyrus.session_id, cyrus.device_id,
cyrus.runner, cyrus.model, cyrus.provider, cyrus.source, cyrus.emitted_at
```

This is the correlation set the runs API and the log commands both key on, and it
is the one CYR-78 asks to "verify new correlation fields" for.

### Ingestion lag, measured

| Source | Rows (1h) | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| `router` | 6 | 713 ms | 1181 ms | 1181 ms |
| `sandbox` | 456 | 756 ms | 1237 ms | 2745 ms |
| (unattributed) | 1406 | 924 ms | 1268 ms | 1751 ms |

Newest record emitted 5 s before the query. A backend lagging reality by about a
second is comfortably inside anything `logs follow` would need, and it is a real
number rather than the assumption the F1 fake stands in for.

### Verbatim Log Analytics invocations

All read-only, against workspace `7f02622b-26ce-47b0-8cd1-ded57e9053b4`
(`log-cyrus-dev`), table `ContainerAppConsoleLogs_CL`:

```bash
PYTHONIOENCODING=utf-8 MSYS_NO_PATHCONV=1 az monitor log-analytics query \
  --workspace 7f02622b-26ce-47b0-8cd1-ded57e9053b4 \
  --analytics-query "$(cat q.kql)" -o table
```

with `q.kql` in turn:

```kusto
// 1. Which events the router family emits, sandbox.gauge excluded (it is one row
//    per device per minute and drowns everything).
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(2h)
| where ContainerName_s == "router"
| extend p = parse_json(Log_s)
| where isnotempty(tostring(p["event"]))
| where tostring(p["event"]) !startswith "sandbox.gauge"
| summarize count() by event = tostring(p["event"])
| order by count_ desc
| take 30

// 2. Which sandboxes the stranded-session detector is firing on, and for how long.
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(4h)
| extend p = parse_json(Log_s)
| where tostring(p["event"]) == "sandbox.stranded_session"
| summarize events = count(),
            lastSeen = max(TimeGenerated),
            maxNoProgressMs = max(tolong(p["cyrus.no_progress_for_ms"])),
            maxStrandedMs = max(tolong(p["cyrus.stranded_for_ms"]))
    by issueKey = tostring(p["cyrus.issue_key"]),
       deviceId = tostring(p["cyrus.device_id"]),
       reason = tostring(p["cyrus.reason"]),
       state = tostring(p["cyrus.state"]),
       online = tostring(p["cyrus.online"])
| order by events desc

// 3. The deferred/signalled disambiguation CLAUDE.md gates `cyrus router unlock`
//    on. Compared BY TIME, never by membership.
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(14d)
| extend p = parse_json(Log_s)
| where tostring(p["event"]) in ("session.terminal_deferred", "session.terminal_signalled")
| where tostring(p["cyrus.issue_key"]) in ("NOR-402", "NOR-373", "PAR-200")
| summarize lastDeferred = maxif(TimeGenerated, tostring(p["event"]) == "session.terminal_deferred"),
            lastSignalled = maxif(TimeGenerated, tostring(p["event"]) == "session.terminal_signalled"),
            deferrals = countif(tostring(p["event"]) == "session.terminal_deferred")
    by issueKey = tostring(p["cyrus.issue_key"]),
       sessionId = tostring(p["cyrus.session_id"])
| extend stillWaiting = iff(isnull(lastSignalled) or lastDeferred > lastSignalled, "DEFERRED (waiting)", "signalled")
| order by issueKey asc

// 4. Ingestion lag by source.
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(1h)
| extend p = parse_json(Log_s)
| where isnotempty(tostring(p["event"]))
| extend emittedAt = todatetime(p["timestamp"])
| extend ingestionLagMs = datetime_diff('millisecond', TimeGenerated, emittedAt)
| summarize rows = count(),
            p50 = percentile(ingestionLagMs, 50),
            p95 = percentile(ingestionLagMs, 95),
            maxLag = max(ingestionLagMs),
            newestEmitted = max(emittedAt)
    by source = tostring(p["cyrus.source"])
```

**One query wrote itself wrong before it wrote itself right, and the failure mode
is worth recording**: keying on `p["cyrus.issue"]` returned rows with an empty
issue column rather than an error. `cyrus.issue` is the ACA **sandbox label**;
the **log attribute** is `cyrus.issue_key`. A mistyped `cyrus.*` key in KQL is
silently null, exactly as CLAUDE.md §13 warns about dot syntax — so an operator
query that looks like it found nothing may simply be asking for a field that does
not exist. Read the raw `Log_s` of one row before trusting a summarize.

### Two live findings, reported and NOT acted on

1. **`NOR-402`'s sandbox (device 151) has been stranded for 6.1 days.**
   `sandbox.stranded_session reason=no_progress`, `state=running`, `online=true`,
   `sessions=1`, `cyrus.no_progress_for_ms = 528,095,176` against a 4-hour
   threshold — still firing every minute at 06:31Z, 235 events in four hours. The
   issue it belongs to (now `CYR-1`) has been **Done since 2026-09-03**. It has
   no `session.terminal_deferred` in 14 days, so it is not waiting on pending
   work — it simply never signalled terminal.
   The deployed router predates **CYR-84** (`c181b249`, PR #75), whose
   `reclaimStranded` destroys a container quiet for 72 h. Deploying current
   `main` would reclaim this one. That is the fix; no manual destroy is needed.

2. **`PAR-200`'s issue lock is held by a session whose container is stopped and
   offline.** `cyrus router sessions list` shows session
   `6af36850-4991-45aa-b1ad-807d999fa24d` `locked` on issue
   `686e298f-8da3-419c-bff9-af17c886df86` = PAR-200, and the detector reported
   `reason=offline_pinned`, `state=stopped`, `online=false` 28 times between
   05:18Z and 05:47Z. PAR-200 is **In Progress with Cyrus delegated**. Per
   `CLAUDE.md` §12 a new top-level comment on it would be rejected at the lock;
   replying inside the existing thread still reaches it.
   **Not unlocked.** `cyrus router unlock` is a mutation on a live fleet and is
   gated on confirming the session is not waiting; that confirmation belongs to
   the operator, not to this drive.

### The CLI, driven against the live router

A `fleet.read` operator token (`cyr-78-drive`, token id 3) was minted on the
router at 06:42Z, over workspace `75294f85-72ad-42ef-b9d7-c6ded611fc42`, and
used from this machine. Its value never entered a file in this repository.

```bash
# Minted on the router host (a write; run by the operator, not the agent)
MSYS_NO_PATHCONV=1 az containerapp exec -g rg-cyrus -n app-cyrus-dev-router \
  --command "cyrus router operators create-token --label cyr-78-drive \
             --role fleet.read --workspace 75294f85-72ad-42ef-b9d7-c6ded611fc42"

export CYRUS_OPERATOR_TOKEN='cyop_…'
node apps/cli/dist/src/app.js connection add cyrus-dev \
  https://app-cyrus-dev-router.calmsea-e4dd7bc4.australiaeast.azurecontainerapps.io \
  --auth local --token-env CYRUS_OPERATOR_TOKEN
```

| Command | Expected | Live result |
| --- | --- | --- |
| `connection add … --auth local` | verifies against the router and stores nothing privileged | `Connection "cyrus-dev" verified against cyrus-router and saved.` — `local-token:3`, `fleet.read`, 1 workspace |
| `connection show cyrus-dev` | the principal's own authority, and only it | Capabilities exactly `runs.list, runs.changes`; `Log source: none (this connection cannot query logs)`; `Operator skill: none advertised` |
| `runs list` | one row per session, canonical routing resolved | 30 runs, every one carrying workspace, owner, team **and project names**, runner/model, executor kind+state, worker connectivity, routedAt |
| `runs list --issue CYR-87 --json` | exact-key filter | 1 run |
| `runs list --issue PAR-200 --json` | exact-key filter | 2 runs |
| `runs wait <terminal runId> --json` | exit 0, outcome `complete`, one full `RunObservationV1` | exit 0; document carries `revision: 489`, `endedAt`, `lastPublishedActivityAt`, the whole routing block |
| `logs query --since 15m` | refuse: the router advertises no log source | `This router connection does not provide the "logs.query" capability. Available: runs.list, runs.changes.` — **exit 2** |
| `skills list` | nothing advertised, and say so rather than installing | `No trusted compatible fleet skills are advertised…` — exit 0 |

The `logs query` row is CYR-78's **"unsupported capability" negative case, live**:
the client gates on the capability it read from `/api/v1/operator/context`,
names what it needs and what it has, and exits `2` — the code ADR 0011 fixes for
it. It never reached a backend.

`cyrus recover` was **not** run against the live router. It would refuse at the
same capability check (`recoveries.request` is not advertised), and that path is
covered by the F1 matrix's recovery-disabled scenario, but the invocation was
blocked by this session's own tooling and is recorded as unrun rather than
inferred.

### Two findings the CLI surfaced that the logs did not

**1. `PAR-200` is a live, naturally occurring instance of the exact strand
guarded recovery exists for.**

```
runId       4ddc55fd-afe8-4d46-bfad-0bcdeb86a97e
lifecycle   active
executor    container / stopped
worker      offline
issue lock  held by session 6af36850-4991-45aa-b1ad-807d999fa24d
```

A non-terminal run, a stopped container, an offline worker, and the issue lock
still held — byte for byte the fixture `strandRun()` builds in the F1 matrix,
happening on its own. If recovery were enabled, this is the run
`cyrus recover 4ddc55fd-…` would reconcile. It is the strongest available
evidence that the fixture models something real, and it was found by the
operator surface rather than constructed.

**2. `NOR-402`'s six-day strand is INVISIBLE to `cyrus runs`.**

```
$ cyrus runs list --issue NOR-402 --json            → 0 runs
$ cyrus runs list --issue NOR-402 --all-runs --json → 0 runs
```

The filter is not at fault: `--issue CYR-87` returns 1 and `--issue PAR-200`
returns 2. NOR-402 genuinely has no `agent_runs` row — runs are swept 24 hours
past terminal — while its **container and its session affinity have survived six
days**, which is why `sandbox.stranded_session` fires on it every minute.

This is a real seam in the observability story, and worth stating precisely
rather than as an alarm:

- It is not a bug in `cyrus runs`. That command observes RUNS, and this run
  ended six days ago. Its retention is deliberate.
- It IS a gap in the workflow the fleet-operator skill scripts, which is
  `runs list` → investigate → recover. An operator following it sees nothing for
  the single worst-stranded sandbox on the fleet, and would reasonably conclude
  there is nothing to look at.
- The container-lifecycle half of the system does see it — `sandbox.stranded_session`
  with `reason=no_progress` — and **CYR-84's `reclaimStranded` would destroy it**
  after 72 hours quiet. That fix exists on `main` and is simply not deployed
  (the router runs PR #74; the reclaim landed in PR #75).
- So the residual question is a product one, not a defect: should the operator
  surface expose a container holding affinity for a run that no longer exists —
  through `runs`, through a `containers` view, or not at all — given that the
  reclaim will collect it unattended once deployed. That belongs in the project's
  follow-up, not in this drive.

### What this drive still could NOT reach

| CYR-78 step | Status |
| --- | --- |
| 1. Deploy read-only observation/log capabilities | **Not run.** Read instead: the deployment already has no `fleetOperations` block, which is the safe posture, so nothing needed deploying to observe it. A *log* capability would need a real deploy. |
| 2. Connect an Entra read principal; prove workspace denial/ambiguity | **Partly done, by a different credential.** A **local** operator token connected, and its context proved the narrowing works — one workspace, `fleet.read`, and exactly the two capabilities the router serves. The **Entra** half is still blocked: `main.bicep` renders that block only when `fleetOperatorGrants` is non-empty and `northrop-dev.bicepparam` does not set it, so the router advertises no `entra` method and `cyrus connection add --auth entra` is refused. Workspace **ambiguity** is unprovable here at all: this router serves exactly one workspace, so no principal can be ambiguous. |
| 3. Narrow read-only Log Analytics queries; correlation fields, redaction, budgets, ingestion lag | **Mostly done** — see above. **Redaction and budgets were not exercised through `cyrus logs`**, because the router advertises no log source; they are covered only by `apps/cli/src/remote/logs/*.test.ts` and the F1 fake. |
| 4. Prove with network/audit evidence that the CLI contacted Azure directly and the router returned only the descriptor | **Blocked** by the same missing `logSource`, and the refusal was observed rather than assumed: `cyrus logs query --since 15m` exits `2` naming the missing capability. Two halves *are* proven — the router serves no log-records route at all (404), and the client refuses before touching any backend. What is unproven is the positive path, where a descriptor exists and the CLI queries Azure with its own credentials. |
| 5-9. Enable recovery for an isolated principal, run `cyrus recover`, negative cases, skill install from a versioned release, disable the grant | **Not run, and not authorized.** Each needs a deploy that turns `fleet.recover` on. The *target* for step 5 now exists naturally and did not need constructing — `PAR-200`'s run `4ddc55fd-…` is `active` with a stopped container, an offline worker and the issue lock held. `skills list` reports nothing advertised, so step 8's install has nothing to resolve against on this deployment. |

The `cyrus runs` half needed no deploy and **was run**: see
[The CLI, driven against the live router](#the-cli-driven-against-the-live-router)
above. Everything still outstanding is gated on a deployment change —
`fleetOperatorGrants` for Entra, a `logSource` for logs, `enableFleetRecovery`
for recovery — each a separately authorized rollout rather than an agent's to
make.

## Cleanup

**F1 half.** Every scenario allocates its own temp directory (`f1-obs-*`), its
own ephemeral port, and an in-memory SQLite database except the two restart
cases, which use file databases in their own temp directories. All are removed in
`afterEach`/`finally`. Device sockets are closed by the harness's `stop()`.
Nothing outside the temp directories is written, and no external service is
contacted.

**Dev-fleet half.** Two writes happened, both deliberate, and one is still
outstanding:

- A `fleet.read` operator token `cyr-78-drive` (**token id 3**) was minted on the
  router, scoped to one workspace and holding no recovery authority. It was
  **revoked at 06:51:03Z** (`cyrus router operators revoke 3`), and the
  revocation was then verified from outside:

  ```
  curl -H "authorization: Bearer cyop_…" $ROUTER/api/v1/operator/context
  → 401 {"error":"unauthorized"}
  ```

  Note the body: a revoked token gets the SAME opaque refusal an unknown one
  gets, which is `getOperatorTokenByToken` resolving a revoked row to
  `undefined` on purpose — telling them apart would confirm to the holder of a
  stolen token that it was once valid. That security property is now verified
  live, not just in the unit suite.

  One caveat the CLI prints itself and which this drive did not test: the router
  database is on ephemeral storage and backed up periodically, so a restore from
  before 06:51Z would resurrect the token. Immaterial for a read credential that
  never left one machine; it is why a genuine compromise wants rotation rather
  than revocation.
- A local connection `cyrus-dev` was written to `~/.cyrus/config.json` and has
  been **removed** (`cyrus connection remove cyrus-dev`); `connection list` now
  reports none. The token value was passed by environment variable and was never
  written to this repository.

Nothing else was mutated: no container app update, no revision change, no issue
lock released, no container stopped or destroyed, and no Log Analytics query
writes. The two pre-existing operator tokens (`nboey-laptop`, `orca-observer`)
were listed but not used — a token's value is unrecoverable after minting — and
were left in place.

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

Pass for the automated matrix, after the review pass. Partial for the dev fleet,
read-only, with the blocked steps named rather than glossed.

The integration seam earned its keep three times over. Writing it surfaced that a
fake worker with no event consumer leaves the router's queue unacked, which makes
every recovery refuse — the same shape a real cold-booted sandbox produces, and
precisely the guard CYR-81 added. Reviewing it surfaced that the F1 command
shipped alongside the matrix reproduced that un-started shape rather than the
strand. And running its predictions against the live router found two genuine
operational faults that no test could have: a sandbox stranded for six days on a
closed issue, and an issue lock held by a stopped container on work that is
currently in progress.

Nothing in the CLI or the router had to change to make the matrix pass, and every
prediction it makes about discovery, refusals and route absence held against the
real deployment. That is the outcome expected if the two halves already agreed;
the value of the file is that a future disagreement now fails there rather than
in a fleet.

The project's exit criterion is **not** met. CYR-78 asks for both halves in full,
and steps 1, 2 and 5-9 of the fleet drive are outstanding — each blocked on a
deployment change (`fleetOperatorGrants`, a `logSource`, `enableFleetRecovery`)
that is a separately authorized rollout, not an agent's to make.
