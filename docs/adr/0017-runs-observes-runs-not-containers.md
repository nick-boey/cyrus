---
status: accepted
---

# `runs` observes runs; a container that outlives its run is found in logs

CYR-78's dev-fleet drive found a sandbox that had been stranded for six days on
an issue closed since 2026-09-03, and `cyrus runs list --issue NOR-402` returned
zero rows for it — with `--all-runs` too. The filter was not at fault
(`--issue CYR-87` returned 1, `--issue PAR-200` returned 2). The run row had
aged out 24 hours past terminal per
[ADR-0008](0008-router-retains-agent-run-observations.md), while the container
and its session affinity survived. At the time of writing it has been quiet for
6.87 days and `sandbox.stranded_session` is still firing on it every minute.

That is a hole in the workflow the fleet-operator skill scripts —
`runs list` → investigate → recover — because an operator following it sees
nothing at all for the single worst-stranded sandbox on the fleet, and would
reasonably conclude there is nothing to look at.

**`cyrus runs` keeps observing runs only. A container holding affinity for a
run that no longer exists is reached through `cyrus logs query`, and the
fleet-operator skill says so, rather than through a new run row, a longer
retention, or a `containers` resource on the operator surface.**

## Why not each of the alternatives

**Not a longer run retention.** It moves the cliff without removing it. The
container outlived its run by six days against a 24-hour window, and nothing
bounds how far it can: the whole reason the strand is interesting is that
nothing was reclaiming it. Any fixed retention has a NOR-402 just past its edge.

**Not a synthesized run row.** The router has no lifecycle facts for a run it
has forgotten — no routed time, no terminal outcome, no observation revision.
A row assembled from the container's labels would carry an issue key and
nothing else, in a shape whose every other field callers are entitled to read.
ADR-0008 stores observations of episodes of work; inventing one for an episode
that ended is a different thing wearing its name.

**Not a `containers` resource on the operator surface.** This is the option
with a real case, and it fails on what the operator would then DO. `cyrus
recover` reconciles a RUN against a fresh observation revision — that is
ADR-0013's whole guard. A container with no run has no revision to be fresh
against, so a `containers` view could only ever hand the operator a row that
every mutation on the operator surface must refuse. It would advertise an
action that cannot be taken, which
[ADR-0014](0014-operator-http-capabilities-are-discovered-and-versioned.md)
treats as worse than advertising nothing.

## Why logs are sufficient rather than merely available

The container-lifecycle half of the system already sees this and already acts
on it. `sandbox.stranded_session` with `reason=no_progress` is emitted every
tick a container is pinned and quiet, and CYR-84's `reclaimStranded` destroys a
container quiet for 72 hours, unattended. The residual operator need is to SEE
it inside that window, not to act on it — and seeing it is a log query.

The operator surface gained exactly the right path for that in the same change
that raised the question: a router that advertises a `logSource` grants
`logs.query` to a `fleet.read` principal, who then queries the workspace with
their own credential ([ADR-0010](0010-clients-query-log-sources-described-by-router.md)).
So the answer needs no new route, no new capability and no schema change — only
that the skill stop treating an empty `runs list` as an answer.

## When to revisit

- If an operator action is ever defined for a container with no run — anything
  `recover` cannot express — it needs its own resource and its own capability,
  not a synthetic run row.
- If the reclaim's 72-hour window and the detector's quiet threshold diverge
  far enough that a container can be collected before it is ever reported, the
  log path stops being sufficient on its own.
- If a deployment runs without a `logSource`, this decision leaves it with no
  path at all. That is the correct trade today, because such a deployment has
  no operator log access to narrow anyway; it stops being correct if
  run-less containers become common on unconfigured stacks.
