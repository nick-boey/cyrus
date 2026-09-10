# Run observation

Begin with `cyrus runs list --issue <key> --json`, or another narrow documented filter. Use `cyrus runs watch --run <id> --json` for changing fleet state and `cyrus runs wait <runId> --json` only when waiting for that run's terminal outcome.

An active or waiting run is pending work, not evidence of failure. Silence and elapsed time do not prove a stall. Preserve the latest observation revision if recovery may be warranted.

**Zero rows is not an answer.** Terminal runs are retained for 24 hours, and a
container can hold session affinity for an issue long after its run has aged
out — one was found six days past its last run, still pinned. An empty
`runs list` for an issue you have other reason to suspect means the run is gone,
not that the fleet is idle: go to [logs](logs.md) and query
`sandbox.stranded_session` by issue key. There is no run to recover in that
state; report it instead.
