# Test Drive: NOR-299 split RBAC bootstrap

**Date:** 2026-08-24
**Goal:** Verify the issue-tracker, EdgeWorker, and activity-rendering pipeline
after separating privileged Azure runtime RBAC from routine Bicep deployment.
**Test Repo:** `/private/tmp/f1-nor299-rbac.o2ilcS/repo`

## Verification Results

### Issue-Tracker

- [x] Server healthy and ready on port 3602
- [x] Issue created (`issue-1` / `DEF-1`)
- [x] Issue metadata accessible

### EdgeWorker

- [x] Session started (`session-1`)
- [x] Isolated `DEF-1` worktree created from local `main`
- [x] Activities tracked throughout the run
- [x] Agent inspected the test repository without modifying it
- [x] Session completed successfully after 36 runner messages

### Renderer

- [x] Thought, action, and final response activities rendered
- [x] Timestamps and content were present and readable
- [x] Final response was posted as a `response` activity
- [x] Pagination returned five requested activities out of twelve
- [x] Session and server stopped cleanly

## Infrastructure Validation

The public bootstrap script ran an Azure resource-group what-if against the
existing `rg-cyrus` deployment in `dit-development`, using Northrop's secretless
parameter file. It targeted the same deterministic role-assignment resource IDs
as the pre-split deployment. Azure proposed no create, delete, or replacement.

Seven assignments were displayed as modifications only because what-if compared
their concrete current principal GUID with the template's unevaluated
`reference(...).principalId` expression. The sandbox-group Data Owner assignment
was marked unsupported for the same runtime-resolution reason. The source-level
`guid(...)`, scope, role-definition, and principal formulas were also compared
against the pre-refactor `foundation.bicep` and `sandbox-group.bicep`; all nine
match.

A second full subscription what-if used the private Northrop parameter file with
`manageRoleAssignments = false`. It completed through the normal
`deploy-azure.sh` gates and contained no `Microsoft.Authorization/roleAssignments`
resource at all. The remaining output was the already-known ARM expression and
read-only/default-property noise plus the four disabled OpenTelemetry environment
variables introduced by merged PR 29.

## Session Log

- Port 3600 was unavailable; sandboxed listeners also cannot bind locally, so
  the server ran with approved local access on port 3602.
- The fresh test repository intentionally has no `origin`. The handled fetch and
  WIP-snapshot lookup warnings appeared before Cyrus used local `main`.
- `ping` and `status` succeeded.
- The final session contained 12 coherent activities and status `complete`.
- `stop-session` succeeded and SIGINT produced a graceful server shutdown.

## Final Retrospective

The application pipeline remains healthy after the infrastructure-only refactor.
The live Azure preview and deterministic-name comparison show that the already
running deployment can reconcile the new bootstrap module without migrating or
replacing its runtime grants. Routine CD can then omit the module under ARM
Incremental mode.
