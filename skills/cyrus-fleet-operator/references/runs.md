# Run observation

Begin with `cyrus runs list --issue <key> --json`, or another narrow documented filter. Use `cyrus runs watch --run <id> --json` for changing fleet state and `cyrus runs wait <runId> --json` only when waiting for that run's terminal outcome.

An active or waiting run is pending work, not evidence of failure. Silence and elapsed time do not prove a stall. Preserve the latest observation revision if recovery may be warranted.
