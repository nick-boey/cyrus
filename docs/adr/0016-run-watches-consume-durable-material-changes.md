---
status: accepted
---

# Run watches consume durable material changes

The router retains an append-only change feed beside current run observations.
It records material changes — routing, lifecycle and waiting transitions, worker
connectivity transitions, sampled executor-state changes, published activity,
and recovery effects — without copying prompt text or agent-activity content.

Run lists read current projections, while run watches consume the change feed
through opaque cursors retained for the same 24-hour window as terminal
observations. A cursor includes a stream epoch that rotates whenever the router
process starts. The router returns `410 Gone` for a cursor from an older epoch;
the CLI then takes a fresh snapshot and resumes from the new stream rather than
pretending it observed the restart interval. Repeated heartbeats and unchanged
gauge samples update freshness facts without producing redundant changes.

A durable feed prevents a polling client from missing a short transition between
snapshots and gives reconnecting orchestrators deterministic progress. It adds
storage and retention work, but keeps replay and ordering complexity in the
Fleet Operations module instead of every CLI or skill.
