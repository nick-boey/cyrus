---
status: accepted
---

# Traces use parent-based head sampling, decided once at the router

Telemetry Phase 5 (NOR-283) traces a unit of work from a Linear webhook through
routing, container boot, and device dispatch, into the sandbox worker's agent
session. Its own brief says sampling "matters here in a way it does not for
logs — decide a strategy before instrumenting broadly." This records that
decision.

**We sample at the head, with `ParentBased(root = TraceIdRatioBased(ratio))`,
and the root decision is only ever taken by the router.**

## Why the decision has to be parent-based

A Cyrus trace is split across two processes that cannot see each other's
sampler. The router receives the webhook and starts the trace; the sandbox
worker picks it up minutes later off a queued `event` frame and runs the agent
session that is the expensive, interesting part.

If both sides sampled independently, a trace would routinely be *half*
collected: the router's root span kept and the worker's session spans dropped,
or the reverse. A half-collected trace is worse than no trace. It renders in a
backend as a complete story with a hole in the middle, and the hole is
indistinguishable from work that never happened — which is exactly the
conclusion someone asking "why did this take four minutes" would draw.

Parent-based sampling removes the possibility. The worker's spans are always
children of a remote parent, and `ParentBasedSampler` consults the incoming
`traceparent`'s sampled flag rather than its own root sampler. So the worker
never makes a decision; it inherits one. The `remoteParentNotSampled` branch is
`AlwaysOff` and `remoteParentSampled` is `AlwaysOn`, which is the default
composition and the one we want spelled out rather than assumed.

This is also what makes the WSS relay affordable. An unsampled trace produces no
spans in the sandbox at all, so nothing is serialised into `span` frames and
nothing crosses the socket — the sampling decision the router took is enforced
at the far end for free, without the router having to filter what it is handed.

## Why head sampling rather than tail

Tail sampling — buffer the whole trace, then decide, so that every error and
every slow request is kept — is the strategy that best fits "why did this take
four minutes". We are not adopting it, for two reasons that are about this
deployment rather than about the technique.

First, it needs a collector. Tail sampling is a component that holds all spans
for a trace until the trace completes, which means an OpenTelemetry Collector
deployment sitting between the router and Application Insights. That is a new
always-on stateful service, a new failure mode in the path of every trace, and a
second thing to deploy on a router that is deliberately a single replica with
ephemeral local storage.

Second, our trace durations defeat the buffering assumption. A collector's tail
sampler holds a trace for a decision window measured in seconds. A Cyrus trace
routinely spans *minutes* — a cold ACA sandbox boot is around 60s on its own,
and the agent session after it is unbounded. A trace that outlives the decision
window is emitted as a partial anyway, which is the failure mode we adopted
parent-based sampling to avoid.

So: head sampling, and accept the known cost — a head sampler cannot preferentially
keep the traces that failed, because at root-span time nothing has failed yet.

## What mitigates that cost

The error path is already covered by a different signal. Phase 3 and Phase 4
put every `ILogger` record through OTLP with `exception.*` semconv attached, and
those are *not* sampled — the sandbox forwarder's threshold is WARN, so every
warning and error from every session already reaches Log Analytics regardless of
whether its trace was sampled.

Phase 5 stamps `traceparent` onto those records. So an unsampled trace still
leaves a complete, queryable error record; what it loses is the timing
breakdown, not the fact of the failure. A sampled trace gets both, joined on
trace id.

## The default ratio, and why it is 1.0

`CYRUS_OTEL_TRACES_SAMPLE_RATIO` defaults to `1.0` — sample everything.

That is defensible because of what generates a root span here. Cyrus root spans
are driven by human actions: someone assigns an issue, someone posts a prompt.
The rate is issues-per-day, not requests-per-second, and the resulting span
volume is far below the point where per-GB ingestion is the thing to worry about
in this workspace. Sampling a signal that is already cheap in order to save
nothing, at the cost of not having the one trace someone asks about, is a bad
trade.

The knob exists because that reasoning is about today's volume and not a law.
`TraceIdRatioBasedSampler` is deterministic on the trace id, so lowering the
ratio degrades gracefully: it keeps a consistent random subset of whole traces,
never a subset of the spans within one.

The ACA data-plane and Linear API dependency spans are the one place volume
could plausibly grow without a human doing anything, since the lifecycle sweep
runs every 60s. Those are emitted under the sweep's own root span, so the ratio
governs them too.

## When to revisit

Revisit if any of these becomes true:

- Root-span volume stops tracking human activity — e.g. a polling or webhook
  source starts producing traces at machine rate. Lower the ratio first; that is
  what it is for.
- The router stops being a single replica, or an OpenTelemetry Collector arrives
  in the deployment for some other reason. Tail sampling's main cost is the
  collector; if something else has already paid it, the trade changes.
- We start wanting "keep every trace that errored" specifically, and the
  unsampled-log-record mitigation above stops being enough — most likely because
  the question moves from "did it fail" to "which span was slow when it failed".
