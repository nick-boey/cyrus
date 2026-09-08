---
name: cyrus-fleet-operator
description: Operate a remote Cyrus fleet by observing runs, narrowing log evidence, and requesting guarded recovery when fresh evidence makes it safe.
---

# Cyrus fleet operator

Use only the remote-profile commands documented here. Start with `cyrus connection show`, selecting `--connection` and `--workspace` when required. Stop and ask the user when the context or a required capability is unavailable.

1. Read [connections](references/connections.md), then identify the relevant work with [runs](references/runs.md). Keep watching while work is active or pending.
2. When the run needs investigation, use the bounded, correlated queries in [logs](references/logs.md). Summarize evidence; keep raw records out of chat and issue trackers.
3. When the observation proves the run is stranded, read [safety](references/safety.md) and [recovery](references/recovery.md). Recovery is autonomous only with the fresh observation revision and one stable idempotency key.
4. Follow the recovery operation to a terminal result, then resume the run watch.

Stop and ask for help on `needs_input`, refusal, stale evidence, unsupported capability, or any break-glass action.
