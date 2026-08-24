---
status: accepted
---

# GenAI semantic conventions are deferred, not adopted

Telemetry Phase 4 (NOR-282) applies OpenTelemetry semantic conventions to the
two places they pay: exception attributes on error paths, and a normalised event
vocabulary. Its fourth work item was to *evaluate* the GenAI conventions
(`gen_ai.*`) for session, token, and cost attributes — explicitly sequenced last
and explicitly gated on a stability check. This records the outcome of that
check: **we do not adopt `gen_ai.*` yet.**

## What the check found

As of August 2026 the GenAI conventions are still pre-stable, and the situation
is worse for a would-be adopter than "experimental" alone suggests:

- **They have no 1.0 and are not stable.** Attribute names can still change
  between versions. That was already true when the phase was planned; it is
  still true.
- **They moved out of the main repository.** The v1.42.0 cut of
  `open-telemetry/semantic-conventions` (12 June 2026) was the last versioned
  release to contain them; they now live in
  `open-telemetry/semantic-conventions-genai`, created 2026-05-05, so the
  GenAI work can move at its own cadence away from the stability-bound core.
- **There is nothing to pin against.** The dedicated repository has no releases
  or tags, and its schema-URL section is still a TODO. The best available
  reference is a commit SHA. Everything else in our telemetry program pins a
  semconv version; this one could not.
- **The agent and tool-orchestration attributes — the ones we would actually
  want — are the least settled part.** Chat and embeddings attributes have
  largely converged. Cyrus is not a chat client: what we would be describing is
  an agent session running tools across many turns, which is the part still in
  motion.

## Why deferring costs us nothing right now

The data GenAI semconv would carry already exists and is already queryable, just
under Cyrus-native names:

- `session.completed` carries `cyrus.message_count`.
- `session.started` / `session.resumed` carry `cyrus.model` and
  `cyrus.fallback_model`.
- Cost and usage land on the session record (`totalCostUsd`, `usage`; see
  `AgentSessionManager`), sourced from the SDK result message.

Adopting `gen_ai.*` would rename these. It would not make any new fact
observable. The whole benefit is *interoperability* — a backend that
special-cases the standard names, or a dashboard shared with another tool — and
that benefit only exists once the names stop moving. Renaming now buys the
interoperability of a moving target and costs a second rename later.

This is the same trade Phase 3 made for the log-record context keys and Phase 4
makes for the ~950 prose log calls: a rename that adds no queryability is not
worth breaking saved queries for.

## What we did instead

Everything Cyrus-specific — Linear issues, sandboxes, devices, agent sessions —
has no OTel convention covering it and lives under the private `cyrus.*`
namespace (`cyrusAttributes` in `packages/core/src/logging/events.ts`). That
namespace is deliberately reserved for exactly this: names OTel does not own.

`cyrusAttributes` passes any key containing a `.` through untouched. That is not
incidental — it is what makes this decision cheaply reversible. Adopting
`gen_ai.*` later means emitting `gen_ai.request.model` at a call site and having
it flow to Log Analytics and OTLP unmodified, with no change to the namespacing
helper, the sinks, or the wire format. The same mechanism already carries
`exception.*`.

## When to revisit

Revisit when `open-telemetry/semantic-conventions-genai` cuts a tagged release
with a schema URL, and the agent/tool-orchestration attributes are marked stable
rather than development. At that point the migration is a rename at ~15 event
call sites plus the KQL in `infra/azure/bicep/modules/monitoring.bicep` — the
same shape as the Phase 4 rename, and about the same size.

Sources consulted: the `open-telemetry/semantic-conventions` release history and
the `open-telemetry/semantic-conventions-genai` repository (August 2026).
