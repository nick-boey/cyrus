---
status: accepted
---

# Operator HTTP capabilities are discovered and versioned

A client first reads `/.well-known/cyrus`, which exposes only router identity,
supported operator-interface versions, and authentication metadata such as the
Entra tenant and audience. After authentication, a scoped identity response
exposes the caller's roles, authorized workspaces, router capabilities,
log-source descriptor, and compatible operator-skill metadata.

New operator routes live under `/api/v1` and return schema-versioned documents.
Granular capabilities, not the Cyrus package version, determine whether a client
may use an optional command. The existing unversioned `/runs` route remains
available for current clients while both routes share one internal
run-observation module.

Fleet observation has distinct interfaces: list returns a successful snapshot
regardless of reported run states; watch emits fleet changes and fails only for
command errors or timeout; wait targets one run and reports complete, error,
stopped, unknown, needs input, or timeout as distinct outcomes. Cursor
pagination and conditional or change-since polling prevent workspace-wide
watches from repeatedly downloading the full fleet.

Compatible operator skills are published with official Cyrus releases. Discovery
advertises their release URL, version, checksum, and compatibility requirements,
but the CLI verifies that metadata against its trusted Cyrus source and never
installs instructions merely because a router supplied a URL.

This split permits connection setup without manually copying Entra
configuration, prevents unauthenticated discovery from revealing workspace or
log-source details, and lets CLIs, routers, and skills update independently
without optimistic version guessing.

Human-friendly filters may use exact captured names, but immutable IDs remain
canonical and ambiguous names fail. The run-wait command reports its own
unsatisfied condition separately from a worker-reported waiting state.
