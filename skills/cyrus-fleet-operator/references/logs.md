# Narrow log evidence

Use `cyrus logs query --run <id> --from <timestamp> --to <timestamp> --json` for a bounded historical window derived from the run observation. Add `--issue`, `--session`, `--level`, or `--contains` only to narrow further. Use `cyrus logs follow --run <id> --since <duration> --timeout <seconds> --json` only for a bounded period of active observation; every follow must name its timeout.

Report a concise evidence summary with timestamps and correlations. Quote only the few records needed to support it. Never dump the raw result set wholesale.
