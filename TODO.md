# TODO

## ACA live-deployment follow-ups

Follow-ups from the live Azure drive documented in
`apps/f1/test-drives/2026-07-26-live-aca-nor-252.md`.

### 1. Reconnect the worker WebSocket after ACA memory resume

**Status:** open. **Priority:** critical.

ACA resumed the sandbox to `Running` in 1.25 seconds, but the worker retained a
stale WebSocket and never reconnected. The router safely queued the prompt, but
work did not resume until another prompt crossed the 120-second disconnected
threshold and forced a cold replacement.

Implement a device-side liveness watchdog in `RouterConnection`. Track inbound
server pings/messages using wall-clock time; if no server activity arrives for
more than two router heartbeat intervals, terminate the local socket and use the
existing reconnect path. Wall-clock comparison is important because JavaScript
timers are frozen while an ACA sandbox is suspended and fire late after resume.
Also make the ACA provider verify connectivity after `resumeSandbox` rather than
returning solely because infrastructure state changed.

Acceptance criteria:

- Suspend a connected live sandbox for longer than two router heartbeats.
- Resume it and observe a new authenticated device hello without a second prompt.
- Deliver the already-queued prompt exactly once on the same sandbox ID.
- Add fake-timer tests that model a long wall-clock jump while timers are frozen.

### 2. Prevent duplicate webhook execution during router rollouts

**Status:** open. **Priority:** critical.

The emergency router image rollout briefly ran old and new revisions together.
Both accepted/replayed the same durable work, producing doubled Linear activity
and two `linear-mcp-ok` comments even though only one worker sandbox survived.
Single revision mode does not eliminate the normal rolling-overlap window.

Persist a webhook/event idempotency key in SQLite before routing. Prefer Linear's
delivery/event identifier; otherwise derive a stable key from organization,
session, action, and event timestamp. Reject an already-claimed key transactionally
across replicas. Add a bounded retention sweep. Deployment should still keep
`revision_mode = "Single"`, min/max replicas at one, and wait for the new revision
to become healthy before deactivating the old revision.

Acceptance criteria:

- Run two router processes against the same durable store and submit one webhook.
- Exactly one queue row, agent execution, activity stream, and MCP mutation occur.
- Restart during the enqueue/ack window and confirm at-least-once delivery does not
  become at-least-twice execution.

### 3. Preserve clean session completion across cold restore and reopen

**Status:** open. **Priority:** high.

Disconnected replacement and completed-issue reopen restored the branch and
worktree successfully, but both emitted terminal `error` before `complete` and
omitted the requested final response. Git work survived; transcript/session
continuity did not finish cleanly.

Trace restored `EdgeWorker` state, Claude transcript relocation, active-session
reconciliation, and buffered terminal frames. A completed session should either
resume cleanly or deliberately start a new session while retaining prior context;
it must not replay stale terminal error state. Persist the final response before
releasing affinity and make terminal-frame replay monotonic by session state.

Acceptance criteria:

- Destroy a worker after a completed turn, then route a follow-up from its bundle.
- Observe no transient `error`, one `complete`, and one final response activity.
- Repeat after Done -> reopen and verify the same behavior.

### 4. Make terminal teardown callback reliable after idle stop

**Status:** open. **Priority:** high.

The Done webhook woke the idle-stopped sandbox, but the authenticated teardown
callback never arrived. The documented 10-minute grace fallback eventually
deleted the sandbox and snapshots, so resources did not leak, but cleanup was
slow and billed during the grace window.

Fix this together with the resume WebSocket watchdog. Persist terminal cleanup
intent in the worker inbox before acknowledging it, reconnect before processing,
and retry the teardown callback with its idempotency key until acknowledged.
Expose callback-pending state in `router containers list` and log callback retry
attempts distinctly from grace expiry.

Acceptance criteria:

- Idle-stop a worker, mark its issue Done, and observe wake -> final floor flush ->
  callback -> sandbox/snapshot deletion without waiting for grace expiry.
- Kill the worker between flush and callback; restart and confirm callback replay.

### 5. Stabilize MCP connections in long-lived and restored workers

**Status:** open. **Priority:** medium.

The live worker reported that the Linear and `cyrus-tools` MCP servers disconnected
and were reconnecting. Linear MCP completed its mutation first, but long-running
sessions need predictable reconnect behavior. The optional `cyrus-docs` MCP also
required interactive OAuth, which is unsuitable inside a headless sandbox.

Add MCP connection health to startup/session diagnostics, retry transient server
disconnects with bounded backoff, and omit or preconfigure MCP servers that require
interactive OAuth in ACA mode. Add a multi-turn container test that invokes Linear
MCP before and after idle/reconnect.

### 6. Document and optionally enforce GitHub token scopes

**Status:** open. **Priority:** low.

`GH_TOKEN` successfully cloned, committed, pushed, and queried the repository, but
`gh auth status` warned that `read:org` was absent. Keep `repo` as the functional
minimum for private repository work and document `read:org` as required only for
organization-level queries. Optionally add scope diagnostics to `router secrets
list` without rejecting otherwise usable tokens.

### 7. Reconcile the emergency router image with Terraform

**Status:** open. **Priority:** high before the next apply.

The running Container App uses `cyrus-router:deploy-aca-disk-fix`, while the
deployment tfvars used during initial provisioning referenced `:deploy`. Publish
an immutable release or SHA tag containing the private-disk fix and update the
deployment input before the next Terraform apply. Avoid mutable tags in durable
environments.

### Completed during the drive: private ACA disk IDs

**Status:** fixed locally and deployed for validation.

The ACA data plane rejects a registered private disk expressed as
`sourcesRef.diskImage.name`; it requires `sourcesRef.diskImage.id`. Disk list
responses also expose the operator name under `labels.name`. The typed client and
provider now recognize that shape and create private-image sandboxes by ID. Keep
the live-wire regression tests as a release gate.

Follow-ups from the phase-1 container-executor test drive
(`apps/f1/test-drives/2026-07-14-container-executors-phase1-validation.md`).

The drive validated everything reachable without a live router: image build,
the three restore-ladder rungs, git-token hygiene, device→container migration,
and the container-only WIP-floor gate. The items below are what it could **not**
reach, plus one anomaly it surfaced.

## 1. Router-mode F1 harness

**Status:** open. **Priority:** high — blocks live validation of the whole feature.

`apps/f1/server.ts` builds a `platform: "cli"` EdgeWorker only. It has no router
mode, no executor selection, and no container support, so a stock F1 drive cannot
boot a container or exercise anything router-driven. The 2026-07-09 router drive
already flagged this gap and recommended the same rig; it is now blocking a second
feature.

Build a router-mode F1 rig — a `RouterServer` with a CLI-tracker `trackerFactory`
plus a `platform: "router"` EdgeWorker enrolled as a device — so container boot,
in-container sessions, and the floor's upload path can be driven end-to-end.

## 2. Real-Docker coverage for the container lifecycle

**Status:** open. **Priority:** high.

`packages/router/test/containers-e2e.test.ts` uses a `FakeBootExecutor` and never
shells out to Docker; `packages/router-executors/test/LocalDockerProvider.test.ts`
is mock-based. So **none** of the container lifecycle — boot serialization,
idle-stop, stale-destroy, orphan GC — has run against a real daemon.

Add a real-Docker e2e (opt-in / skipped when no daemon) that exercises the
lifecycle sweeps against actual containers and volumes.

## 3. The floor's upload path is unproven

**Status:** open. **Priority:** high.

The drive proved the **download/restore** half of the floor. The **upload** half —
`pushWipIfDirty` plus the bundle `PUT` firing on session end / idle-stop / the
periodic timer — never ran, because no session ran inside a container. Drive an
in-container session (needs item 1) and assert a bundle actually lands at the
router artifact endpoint, then that a fresh container restores from it.

## 4. `/workspaces/<ISSUE-KEY>` real-directory invariant, observed under a live session

**Status:** open. **Priority:** medium.

The spec's hard requirement — `/workspaces/<ISSUE-KEY>` is a real directory, never
a symlink, because the Agent SDK keys transcripts off the realpath-resolved cwd —
is currently argued, not observed. The boot path never creates a symlink there and
`realpath` resolves clean, but the worktree itself is only created by `GitService`
at session start, which needs a live router. Once item 1 exists, assert the
directory type directly during a running session.

## 5. Anomaly: a completed session posts no final `response` activity

**Status:** open. **Priority:** medium — needs attribution before it's actionable.

In the CLI-mode drive the Claude session completed successfully on the server
(`Session completed (subtype: success)`, 188 messages, `activity-89`) and committed
its work, but the issue tracker stayed `status: active` with no final `response`
activity until the session was explicitly stopped. The 2026-07-09 drive **did**
record a final concise-summary response, so this is a regression against that run.

Evidence says it is **not** from this branch: `AgentSessionManager` (which owns
activity posting) is untouched, the new floor code is gated behind
`router.floorSync === true` and never executed in CLI mode (zero `WorkspaceSync`
lines in the log). But that is a code-path argument, not an experiment — nobody
A/B'd it against `origin/deploy`.

Next step: reproduce on `origin/deploy` to confirm it predates this branch, then
open a standalone issue. A session that finishes its work but never reports a final
response is a real product problem regardless of which change introduced it.

Note the failure *shape* — "final result never posted, zero Response activities" —
rhymes with the router-side `sessionTerminal`-ordering bug fixed earlier on this
branch's lineage. Different trigger (that one needed router affinity loss; this
reproduces in CLI mode with no router), but worth checking they aren't two faces of
one completion-path gap.
