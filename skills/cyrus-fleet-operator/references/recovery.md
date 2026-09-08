# Guarded recovery

Recovery is warranted only for an explicitly stranded observation, never merely a slow, active, waiting, or quiet run.

Use one stable key for the semantic attempt:

`cyrus recover <runId> --expected-revision <revision> --idempotency-key <key> --json`

Let the command follow the operation. If a prior invocation timed out, resume it with `cyrus recover status <operationId> --wait --json`; do not invent a second recovery intent. On `recovered`, resume `cyrus runs watch --run <id> --json`. On `needs_input`, refusal, stale revision, or failure, stop and ask for help.

The command owns reconciliation order. Do not post a recovery comment to Linear automatically.
