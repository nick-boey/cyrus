# Telemetry program — design

**Date:** 2026-08-02
**Linear:** NOR-278 … NOR-283 (one issue per phase)

## Purpose

Take Cyrus from "logs exist somewhere" to a coherent OpenTelemetry-based
telemetry setup, in shippable increments. The immediate operational questions
that motivated this:

- How many sandboxes are currently open?
- Which issues are currently in progress?
- How many sessions and messages are associated with each issue?
- Alert when a sandbox has been running for more than six hours.

## Where we are starting from

Established by direct inspection of the codebase, not assumption.

**The router's logs reach Log Analytics; the sandboxes' logs reach nothing.**
The Container Apps environment is wired to a Log Analytics workspace
(`infra/azure/terraform/main.tf:38`, `:116`) and the router app sets no log
override, so its stdout is captured. The ACA sandbox group is a separate ARM
resource (`Microsoft.App/sandboxGroups@2026-02-01-preview`, `sandbox.tf:27`)
that the environment's workspace wiring does not reach. Its data-plane API has
no logs endpoint at all — the spike inventory
(`2026-07-25-aca-sandboxes-spike-findings.md:280`) lists `/stats` and
`/egress-decisions` and nothing for console output. The worker entrypoint is a
bare `exec node …` (`docker/worker/entrypoint.sh:2`), so worker output goes to a
stdout nothing collects and which dies with the sandbox.

**A capable structured logger already exists, and the router does not use it.**
`packages/core/src/logging/ILogger.ts` provides `debug`/`info`/`warn`/`error`,
an `event(name, attributes)` call for named structured events, and
`withContext({ sessionId, platform, issueIdentifier, repository })`. The CLI
narrows it to `{ info, warn }` before handing it to the router
(`RouterCommand.ts:552`), discarding `error`, `...args`, `withContext`, and
`event`. Consequently `packages/router/src` contains zero `logger.error` calls,
and failures are logged as `warn` with `String(err)` — destroying the stack
before anything can capture it (e.g. `ContainerTargets.ts:431`).

**The sink is prose, not structure.** Even via `ILogger`, output is
`console.log(prefix + message, ...args)`. Structure only materialises on the
forwarding path and inside `event()`. Adopting the interface alone does not make
Log Analytics queryable.

**Scale.** 957 logger call sites across 95 files; 161 raw `console.*` calls that
bypass `ILogger` entirely (56 in core, 72 in `apps/cli`, 19 in `EdgeWorker.ts`,
8 in `RouterConnection.ts`); 13 existing `event()` call sites with good names;
44 test files asserting on log output.

**Most of the operational data already exists.** `ContainerLifecycle.sweep()`
runs every 60s (`ContainerLifecycle.ts:65`), lists every container device, and
computes session affinity. `countSessionAffinityForDevice()` gives live sessions
per issue. Message counts per session live in the worker's
`edge-worker-state.json` (`agentSessionEntries[sessionId].length`), which is
already on the router host inside the per-issue persistence-floor bundles.
Nothing emits any of it in a queryable form.

**Two blind spots sit directly on the monitoring targets.** `DeviceGateway.ts`
— the WebSocket gateway handling every device connect and disconnect, the truest
sandbox liveness signal — contains no logging calls at all. `RouterConnection.ts`
uses eight raw `console.*` calls including the heartbeat watchdog.

## Constraints

Decided with the user:

1. **Upstream-mergeable.** This is a fork (`nick-boey/cyrus`) with an active
   `upstream` remote (`ceedaragents/cyrus`). The telemetry layer goes in
   `packages/core` as vendor-neutral code with a pluggable exporter; Azure
   specifics stay in this fork's router bootstrap. Diverging `Logger.ts` — a file
   upstream actively develops — would mean re-resolving the same conflict on
   every sync.
2. **Sentry is untouched.** It is a deliberate, documented upstream product
   feature (CYPACK-1142) with tenant gating, scrubbing, and sampling. It stays
   exactly as-is; OTel is an additional sink, not a replacement.
3. **Logs first, traces later.** Traces are the more valuable signal but depend
   on both the OTel foundation and the protocol frame change.

**Do not enable Sentry as a shortcut.** `createErrorReporter` falls back to a
`DEFAULT_SENTRY_DSN` pointing at the upstream vendor's org, so setting
`CYRUS_TEAM_ID` on this deployment would ship its operational data to a third
party.

## Sequencing strategy

Value-first rather than foundation-first.

The first two phases answer every operational question above without adding a
single dependency. Everything they produce survives the OTel migration
unchanged, because `event()` maps almost one-to-one onto OTel Events — the
vocabulary defined in Phase 1 is the vocabulary OTel exports in Phase 3. If the
OTel work stalls or semantic conventions churn, a working setup still exists.

Foundation-first would avoid defining the event vocabulary twice, but it puts
months between now and the first queryable dashboard — and the vocabulary is not
in fact defined twice if it is shaped correctly the first time.

## The phases

| Phase | Issue | Outcome |
|---|---|---|
| 0 | NOR-278 | Router logs queryable in Log Analytics as JSON. No new dependencies. |
| 1 | NOR-279 | Sandbox inventory, uptime, and the six-hour alert. |
| 2 | NOR-280 | Sandbox worker logs exist at all. |
| 3 | NOR-281 | Vendor-neutral OTel logging foundation. |
| 4 | NOR-282 | Semantic conventions on errors and events. |
| 5 | NOR-283 | Distributed tracing. |

Dependencies: 0 blocks 1, 2, and 3. 3 blocks 4 (as does 0). 2 and 3 both block 5.

Full work items live in the Linear issues rather than being duplicated here.

### Phase 0 — make ACA output usable (NOR-278)

Widen the router's logger to the full `ILogger`; add `error` call sites; stop
pre-stringifying exceptions; add JSON rendering behind `CYRUS_LOG_FORMAT=json`
and set it in `router.tf`; fill the `DeviceGateway` and `RouterConnection` blind
spots.

The JSON rendering flag is the single highest-value change in the program: it
makes ACA console output KQL-parseable with no exporter, no egress change, and
no OTel.

### Phase 1 — answer the operational questions (NOR-279)

Define a sandbox lifecycle event vocabulary on the existing `event()` API; emit
a per-tick gauge from the 60-second sweep; add `running_since_ms` for true
continuous uptime; add Azure alert rules.

Two correctness notes carry into implementation. The gauge must use a single
label-filtered `listSandboxes()` call rather than N `executor.status()` calls,
because the sweep only calls `status()` once a row's idle clock already
qualifies (`ContainerLifecycle.ts:122`). And the six-hour alert must combine ACA
state with the `last_seen_ms` heartbeat, because ACA `Running` is infrastructure
state, not worker liveness — an exited entrypoint leaves `tini` alive and the
sandbox `Running`.

### Phase 2 — ship sandbox logs (NOR-280)

Add a log frame to `router-protocol` and forward level-filtered worker logs over
the existing WSS connection. The router's host is already the sole entry in the
sandbox's deny-by-default egress allowlist, so this needs no policy change and
no new credential inside the sandbox. Direct-to-Azure export from sandboxes
would require both.

Design the frame with Phase 5's `traceparent` propagation in mind.

### Phase 3 — OTel foundation (NOR-281)

Introduce a pluggable `LogSink` seam in core mirroring the existing
`setGlobalErrorReporter` pattern, implement an OTel logs sink behind it, set
resource semconv at bootstrap, and wire the Azure Monitor OTLP exporter in the
fork's router bootstrap only.

The 44 log-assertion test files are rewritten here to assert on structured
records — once, rather than being patched in Phases 0 and 4 separately.

Budget time for the ESM loader hook; the repo is `"type": "module"` with
`NodeNext` throughout.

### Phase 4 — semconv where it pays (NOR-282)

Exception semconv on error paths; normalise the event vocabulary to OTel event
naming and a `cyrus.*` attribute namespace (matching the ACA labels already in
use); clean up the remaining raw `console.*` calls; evaluate GenAI semconv last,
after verifying its stability.

**Explicitly out of scope:** the exhaustive semconv rewrite of the ~950
interpolated prose log calls. That is 3–6 weeks across 95 files and the least
valuable slice; those calls become OTel log records with good resource
attributes and stay prose, which is what they are for.

### Phase 5 — tracing (NOR-283)

W3C `traceparent` through the protocol frames; spans across webhook → route →
boot → session; HTTP server instrumentation (Fastify is currently constructed
with no options, so there is no request logging or timing at all); dependency
spans for the Linear API and ACA data plane.

## On Application Insights

Not an alternative to Log Analytics. Workspace-based Application Insights writes
into the same workspace and is queried with the same KQL. In this design it is
used purely as an OTLP endpoint via `@azure/monitor-opentelemetry-exporter`,
which keeps instrumentation vendor-neutral and the fork upstream-mergeable.

## Risks

- **Test churn.** 44 files assert on log output. Concentrated in Phase 3 by
  design; Phases 0 and 4 patch minimally.
- **Log volume and cost.** The workspace is PerGB2018 with 30-day retention.
  Full Claude session stdout from every sandbox is not cheap — hence the level
  filter and rate guard in Phase 2.
- **GenAI semconv instability.** Experimental as of early 2026. Sequenced last
  and explicitly gated on a stability check.
- **Upstream drift.** Every phase touching `packages/core` should be shaped as
  an upstream contribution, not a fork patch.
- **Router ownership unconfirmed.** Whether `packages/router` is upstream-shared
  or fork-local affects where Phase 2 lands. The changelog's "Router mode:"
  prefix convention suggests shared; confirm before starting that phase.
