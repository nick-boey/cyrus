---
status: accepted
---

# One CLI exposes role-specific command profiles

Cyrus continues to ship one CLI executable. Its normal profile retains the
complete worker and router command surface, while a remote-orchestrator profile
registers only commands for connecting to, observing, and safely recovering work
through a remote router.

The remote profile is selected explicitly with `cyrus --profile remote`; an
orchestrator installation may set `CYRUS_COMMAND_PROFILE=remote` as its default.
The complete profile remains the default, so the same installation can still
perform both roles deliberately.

Both profiles use one top-level remote vocabulary: `cyrus connection`,
`cyrus runs list|watch|wait`, `cyrus logs query|follow`, `cyrus recover`, and
`cyrus skills`. The complete profile registers these beside the existing worker
and router commands; the remote profile registers only these plus help and
version. There is no second `cyrus remote` namespace. The existing
device-enrollment meaning of `cyrus connect` remains unchanged.

Automation receives stable exit categories: `0` for success or a satisfied wait
condition; `2` for invalid invocation, invalid configuration, or an unsupported
capability; `3` for a valid non-success run outcome or refused recovery; `4` for
timeout; `5` for authentication or authorization failure; and `6` for a
transient router or log-source failure. A successful list reports facts with
exit `0` even when some runs are in error or unknown states. Versioned JSON or
NDJSON is written to stdout, while diagnostics go to stderr.

A command profile is a product and discoverability boundary, not an
authorization boundary. Selecting the remote profile prevents accidental use of
irrelevant local-router and executor commands, but every remote read or mutation
is still authorized by the router. The CLI stores multiple named router
connections and requires an explicit workspace whenever the selected router
serves more than one. This avoids maintaining and releasing a second client
package without presenting the full operational surface to an orchestrating
agent.
