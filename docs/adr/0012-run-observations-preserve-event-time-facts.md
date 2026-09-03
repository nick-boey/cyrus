---
status: accepted
---

# Run observations preserve event-time facts

Agent-run waiting is reported explicitly by the worker rather than inferred by
the router from silence, elapsed time, or executor state. In v1, `elicitation`
is the only specific wait reason; `other` preserves a worker-reported condition
that the schema does not yet model. The router retains that evidence and does
not turn elapsed time into a healthy or stalled verdict. `pending_work` remains
an active-run fact with a background-work count rather than a wait reason, and
rate limits remain terminal until a separate resumable-backoff design changes
that behavior.

A run observation also snapshots its workspace, owning Cyrus user, Linear team,
and Linear project when input is routed. Historical filters use those event-time
facts rather than calling Linear at query time or rewriting history when an
issue later moves.

This extends ADR-0008's principle that observations report facts rather than
policy. It makes waiting and routing context deterministic for orchestrators
while keeping health thresholds and escalation policy in clients and skills.
