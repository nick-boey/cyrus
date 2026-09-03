---
status: accepted
---

# Run recovery reconciles ownership before releasing it

A remote recovery request targets one agent run and asks the router to reconcile
its durable observation, worker ownership, and executor state. It is idempotent
and conditional on the observation version the caller inspected, so a concurrent
transition cannot be overwritten by a stale recovery decision.

Recovery is represented by a persisted operation. The router accepts it with
`202` and records progress through accepted, starting executor, reconciling,
replaying, releasing stale ownership, recovered, needs input, refused, or
failed. The CLI waits by default, may return immediately with `--no-wait`, and
joins an existing operation when the idempotency key is retried.

The router refuses recovery when a connected worker still owns active work. For
an offline or parked executor it starts the executor, requests session
reconciliation, and allows durable frames to replay. Only when the reconnected
worker does not claim the run may the router atomically release stale affinity
and the issue lock and mark the outcome unknown.

The stable target is a run ID. An issue-key convenience is accepted only when it
resolves to exactly one non-terminal run; ambiguity returns the candidates
without acting. Safe reconciliation requires no interactive confirmation.
Unlock-only, forced termination, and executor destruction remain separate
break-glass commands.

A user-scoped device token may recover only its owner's runs. An Entra read role
cannot recover; an Entra recovery role may recover runs across users within its
authorized workspaces. Container-device tokens cannot initiate recovery.

Each recovery operation persists its actor, target, idempotency key, checked
observation version, phases, and before-and-after evidence, and emits matching
structured audit logs. Recovery correctness does not depend on posting to
Linear; the operator skill may publish a concise summary afterward.

The fleet-operator skill may request this guarded recovery without pausing for
human confirmation only after reading a fresh observation, supplying its version
and an idempotency key, and following the recovery operation before resuming the
run watch. It stops for `needs_input`, refusal, stale evidence, or any
break-glass action.

A run awaiting elicitation returns `needs_input`; recovery cannot manufacture
the missing answer. Recovery never terminates a live run or destroys an
executor.
