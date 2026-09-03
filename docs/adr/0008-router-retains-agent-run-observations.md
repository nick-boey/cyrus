---
status: accepted
---

# The router retains user-scoped agent run observations

Linear's session timeline is the user-facing activity stream, but it is not a
reliable inventory of work the router has accepted. A routed comment can be
waiting on a worker, a worker can disappear before a terminal update, and an
executor can remain running after its worker exits. Operators and orchestration
agents need those facts without access to deployment logs.

The router therefore retains an **agent run** for each continuous episode of
work in an agent session. A run starts when input is routed, may move between
`active` and `parked`, and ends as `complete`, `error`, `stopped`, or `unknown`.
`unknown` means ownership was lost without an exact terminal outcome; it is not
a failure verdict. New input joins the current non-terminal run, while input
after a terminal outcome starts a new run with a stable ID.

The non-terminal `parked` state above is a **waiting run** — amended for
CYR-63, which reserved *park* for stopping an idle container and named the
run-level concept separately. The wire and store still spell it `parked`;
[ADR-0012](0012-run-observations-preserve-event-time-facts.md) replaces it with
an explicitly worker-reported wait reason.

Each observation stores only correlation and lifecycle facts: issue and session
IDs, Linear activity/comment IDs, routed and terminal times, the latest
successfully published agent activity, executor kind/provider, worker heartbeat,
and the executor state already sampled by the lifecycle sweep. Prompt text and
comment previews are not retained. Queries do not call the executor provider.

`GET /runs` is authenticated with the device bearer already issued by
`cyrus connect`. A physical device token sees all runs owned by its user; a
container token sees only its issue. The `cyrus runs` command derives HTTP(S)
from the saved router WebSocket connection and polls this route when watching.
Streaming transport is deferred because run transitions are infrequent and
polling needs no second connection protocol.

Terminal runs are retained for a fixed 24 hours. The route reports raw facts,
including observation timestamps, rather than embedding a healthy/stalled
policy that different callers would immediately need to override.

## When to revisit

- If polling load becomes material, add conditional requests before adding a
  streaming protocol.
- If cross-router queries or longer history are required, move observations to
  shared storage and make retention configurable.
- If callers converge on one stall policy, add it as a derived client view, not
  as stored lifecycle state.
