# TODO

## ACA live-deployment follow-ups

Follow-ups from the live Azure drive documented in
`apps/f1/test-drives/2026-07-26-live-aca-nor-252.md`.

All seven items below are **implemented and merged to `deploy`**. Every acceptance
criterion that could be met without live Azure is covered by automated tests; the
criteria written as live-sandbox procedures are called out per item as still
needing a real drive.

### 1. Reconnect the worker WebSocket after ACA memory resume

**Status:** fixed. **Priority:** was critical.

`RouterConnection` stamps every inbound router signal with wall-clock time and
terminates the socket once the stamp is older than two router heartbeats, feeding
the existing reconnect path. Wall clock rather than tick counting is the point:
timers are frozen for the whole suspend and fire late on resume. The heartbeat
interval moved into `cyrus-router-protocol` and `hello_ack` now advertises the
gateway's configured `heartbeatMs`, so the threshold is derived rather than
hardcoded. `AcaSandboxesProvider` polls device connectivity after `resumeSandbox`
instead of trusting infrastructure state, and replaces a sandbox whose worker
never rejoins.

Covered by fake-timer tests that jump the system clock past two heartbeats while
no timer runs, then assert the socket closes and a second `hello` arrives after
redial, plus a negative test proving pings keep it alive.

**Still needs a live drive:** suspend/resume a real sandbox, observe a new
authenticated hello without a second prompt, and confirm the queued prompt is
delivered exactly once on the same sandbox ID. The 90s `resumeConnectTimeoutMs`
default was chosen analytically and is unvalidated against real Azure latency.

### 2. Prevent duplicate webhook execution during router rollouts

**Status:** fixed. **Priority:** was critical.

A `webhook_claims` table plus `RouterStore.claimWebhookEvent` — one
`INSERT OR IGNORE` inside an immediate transaction, arbitrated by the PRIMARY KEY,
never a read-then-write. `EventRouter.route()` claims before any dispatch, so no
queue row, issue lock, activity, or MCP mutation can happen twice for one
delivery. Bounded retention sweep rides the existing 60s tick. Terraform already
had `revision_mode = "Single"` and one replica; a `/healthz` readiness probe was
added so ingress cannot shift before the router has opened SQLite.

Linear's payload carries no delivery id — verified against the SDK's generated
types, it lives in an HTTP header the transport never surfaces — so the key is
`<type>/<action>:<organizationId>:<entityRef>:<createdAt>`. `createdAt` is a
property of the payload, so a redelivery reproduces it exactly.

**Known limit, not closed:** each ACA router revision keeps `router.db` on
ephemeral local storage, so during a rollout overlap the two revisions have
*separate* databases. A duplicate whose original claim postdates the last Blob
backup is not caught. Making that airtight needs a shared claim store (or a much
shorter backup interval) and is deliberately out of scope here.

### 3. Preserve clean session completion across cold restore and reopen

**Status:** fixed. **Priority:** was high.

Root cause: `updateSessionStatus` mutated memory only. `savePersistedState()` ran
at runner attach and in `stop()` but never on completion, so the last durable
snapshot of a cleanly-finished session read `active` with no runner — byte-identical
to a host that died mid-run. Reconciliation could not tell them apart and posted a
bogus terminal `error`. The floor inherited the same lie, because the bundle is
built by re-reading that file off disk.

Terminal emission now flushes durable state before signalling, a `terminalState`
marker makes reconciliation skip finished sessions, terminal-frame replay is
monotonic by session state, and reconcile runs before the HTTP server accepts a
webhook so no queued prompt can race a terminal signal.

**Still needs a live drive:** the router-side half — `EventRouter.handleSessionState`
clearing affinity mid-turn and the resulting `LinearExecutor` "session not owned by
this device" rejection — is read from the code, not observed.

### 4. Make terminal teardown callback reliable after idle stop

**Status:** fixed. **Priority:** was high.

Two defects, one durability and one correctness:

- The worker marked its inbox entry processed as soon as the event emit returned,
  long before the async cleanup that emit started had finished, so anything still
  owed to the router died with the process. Cleanup intent is now persisted with
  its idempotency key before the first `await`, replayed on reconnect, and retried
  until acknowledged. `router containers list` gained a `TEARDOWN` column and
  callback retries log distinctly from grace expiry.
- **The live symptom's actual cause:** joining an in-flight boot was treated as
  proof the container was running. The joined attempt may have begun before the
  event the joiner is reacting to and can finish having achieved nothing, so a
  teardown wake returned believing the container was up — nothing started it, the
  terminal webhook was never delivered, and only the grace deadline reclaimed it.
  `bootStart` now re-checks `executor.status()` after joining. Boots are also
  bounded so a hung `ensureRunning` cannot wedge a device permanently.

Covered end-to-end by the F1 fake-ACA lifecycle drive, which now exercises
idle-stop → Done → wake → flush → callback → destroy without grace expiry.

### 5. Stabilize MCP connections in long-lived and restored workers

**Status:** fixed. **Priority:** was medium.

The disconnects were invisible by construction: `ClaudeRunner`'s `case "system":`
was a no-op, discarding the SDK's only per-server status report, while
`MCP_CONNECTION_NONBLOCKING=true` meant a failing server never failed the session.
Status is now surfaced in startup/session diagnostics, transient disconnects retry
with bounded backoff behind an ordered transient/permanent classifier, and
`cyrus-docs` (interactive OAuth, impossible in a container) is omitted in headless
mode. A multi-turn container test invokes Linear MCP before and after an
idle/reconnect cycle and runs in the default suite — no daemon or network needed.

**Not verified:** no live Azure or Linear credentials, so the exact failure status
codes those services return are inferred from the classifier table, not observed.
Whether `atcyrus.com/docs/mcp` accepts the `CYRUS_DOCS_MCP_TOKEN` bearer escape
hatch is unconfirmed; if it does not, `cyrus-docs` is simply always omitted in
containers, which is the safe failure mode.

### 6. Document and optionally enforce GitHub token scopes

**Status:** fixed. **Priority:** was low.

`repo` documented as the functional minimum, `read:org` as required only for
organization-level queries, in `docs/GIT_GITHUB.md` and the `cyrus-setup-github`
skill. Opt-in `cyrus router secrets list <email> --check-scopes` warns but never
rejects, and distinguishes an absent `X-OAuth-Scopes` header (fine-grained PAT or
App token, un-introspectable) from a present-but-empty one so it cannot report a
false deficiency. Token values are never printed.

Correction found while verifying against the code: `EdgeWorker.resolveGitHubToken()`
reads `GITHUB_TOKEN` only. `GH_TOKEN` is exclusively a router/container credential
consumed by `ContainerBootCommand`.

### 7. Reconcile the emergency router image with Terraform

**Status:** fixed in config and docs; **the image publish remains a manual
operator step.** **Priority:** was high before the next apply.

`router_image`/`worker_image` now validate as a digest, release tag, or git-SHA
tag, with `allow_mutable_image_tags` as a deliberate escape hatch that shows up in
the tfvars diff. A positive allowlist, not a blocklist — a blocklist would have
missed `deploy-aca-disk-fix`. Terraform state records the tag *string*, so a
re-pointed mutable tag produces no plan diff while the deployed bits change, which
is exactly how `:deploy-aca-disk-fix` and `:deploy` diverged.

**Before the next apply, an operator must:** build and push an immutable tag from
the commit carrying the private-disk fix, then set `router_image` to it. Otherwise
the next apply fails validation — which is the intended fail-loud. Identifying
which commit `:deploy-aca-disk-fix` was built from needs access to the live
environment. `terraform fmt -check` and `terraform validate` have not been run
(no toolchain here) and still should be.

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
