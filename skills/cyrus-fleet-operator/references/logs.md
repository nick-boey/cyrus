# Narrow log evidence

Use `cyrus logs query --run <id> --from <timestamp> --to <timestamp> --json` for a bounded historical window derived from the run observation. Add `--issue`, `--session`, `--level`, or `--contains` only to narrow further. Use `cyrus logs follow --run <id> --since <duration> --timeout <seconds> --json` only for a bounded period of active observation; every follow must name its timeout.

When `runs list` returned nothing for an issue, query the container-lifecycle events instead of the run: `sandbox.stranded_session` carries `cyrus.issue_key`, `cyrus.device_id`, `cyrus.reason` (`no_progress` or `offline_pinned`) and how long it has been quiet. Note that `cyrus.issue_key` is the log attribute; `cyrus.issue` is the sandbox label and reads as null in a query.

Report a concise evidence summary with timestamps and correlations. Quote only the few records needed to support it. Never dump the raw result set wholesale.
