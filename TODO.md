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
delivery. Bounded retention sweep rides the existing 60s tick. The deployment
already had single-revision mode and one replica; a `/healthz` readiness probe
was added so ingress cannot shift before the router has opened SQLite.

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

### 7. Reconcile the emergency router image with the deployment

**Status:** fixed in config and docs; **the image publish remains a manual
operator step.** **Priority:** was high before the next deployment.

`routerImage`/`workerImage` now validate as a digest, release tag, or `sha-`
git-SHA tag, with `allowMutableImageTags` as a deliberate escape hatch that shows
up in the parameter-file diff. A positive allowlist, not a blocklist — a
blocklist would have missed `deploy-aca-disk-fix`. ARM compares the container
spec it is given against the spec on the resource, so a re-pointed mutable tag
produces no change list while the deployed bits change, which is exactly how
`:deploy-aca-disk-fix` and `:deploy` diverged.

The check is split across two layers now that the stack is Bicep: `main.bicep`
enforces the ref *shape* (ARM has no regex engine) and
`scripts/deploy-azure.sh` applies the full character-level regex. See
`infra/azure/bicep/README.md` → "Where enforcement lives".

**Before the next deployment, an operator must:** build and push an immutable tag
from the commit carrying the private-disk fix, then set `routerImage` to it.
Otherwise the deployment fails validation — which is the intended fail-loud.
Identifying which commit `:deploy-aca-disk-fix` was built from needs access to
the live environment. `./scripts/check-bicep.sh` compiles every template and
type-checks the parameter checklist and runs in CI; `az deployment sub what-if`
against the live subscription has not been run (no Azure credential here) and
still should be, before the next apply.

### Completed during the drive: private ACA disk IDs

**Status:** fixed locally and deployed for validation.

The ACA data plane rejects a registered private disk expressed as
`sourcesRef.diskImage.name`; it requires `sourcesRef.diskImage.id`. Disk list
responses also expose the operator name under `labels.name`. The typed client and
provider now recognize that shape and create private-image sandboxes by ID. Keep
the live-wire regression tests as a release gate.

## Phase-1 container-executor follow-ups

Follow-ups from the phase-1 container-executor test drive
(`apps/f1/test-drives/2026-07-14-container-executors-phase1-validation.md`).

**This section was substantially stale.** Items 1, 2 and 4 had already been built
or largely built in the days after the drive; the section was never updated. All
five are now closed. Verdicts below are backed by commit and file evidence, and by
tests actually executed against a real Docker daemon.

### 1. Router-mode F1 harness

**Status:** done — was already built when this item was written.

Landed the day after the drive: `7eb87dca` (in-process router rig — a `RouterServer`
with a CLI-tracker `trackerFactory`), `ba29c460` (token-guarded control server),
`fe1fc736` (`./f1 router:*` subcommands), `c2c4608f` (`router-server.ts` entrypoint).
See `apps/f1/src/router/RouterRig.ts`, `apps/f1/src/router/ControlServer.ts`,
`apps/f1/router-server.ts`, `apps/f1/test/router/`. The `platform: "router"`
EdgeWorker is the one `ContainerBootCommand.writeConfig` writes inside each booted
container, and the whole path was driven with real credentials in
`apps/f1/test-drives/2026-07-17-router-mode-container-drive.md`.

Never built: the optional physical-device attach sub-mode (an in-process host
EdgeWorker enrolled as a device), a documented fallback for machines without
Docker. It was not blocking anything this item was blocking.

### 2. Real-Docker coverage for the container lifecycle

**Status:** done. Was 3 of 4 behaviours; the fourth is now covered.

`7226e3dc` / `022baa45` added cold boot, idle-stop, stale-destroy and orphan GC
against a real daemon in `packages/router/test/containers-real-docker.e2e.test.ts`.
**Boot serialization/dedup** — the fourth behaviour in spec A2 — had only a
`FakeBootExecutor` test with a hand-held gate. Now covered against a real
`LocalDockerProvider`: created-then-prompted mid-`docker run`, asserting one
`ensureRunning` call, one labelled container, one container device row. Container
count alone cannot detect a broken dedup, since a duplicate `docker run` just
name-clashes — hence a counting provider.

### 3. The floor's upload path

**Status:** done for the session-end trigger; two triggers remain unit-covered only.

The earlier round-trip test built and PUT the bundle *from the test process*, so
the trigger → `pushWipIfDirty` → PUT chain was never exercised in CI. There is now
a test where the bundle at the router artifact endpoint is attributed to the
*container's own* `WorkspaceSyncService`, followed by a fresh container restoring
from that bundle.

Not pinned: idle-stop's flush and the 5-minute periodic tick, as *in-container*
observations. Both funnel through the same `syncIssue` and are unit-covered in
`packages/edge-worker/test/WorkspaceSyncService.test.ts`, but neither could be
forced in a container — by the time the container can be stopped the floor has
usually converged and deliberately dropped the issue from its touched set. Making
the interval configurable purely for the test was judged out of scope.

### 4. `/workspaces/<ISSUE-KEY>` real-directory invariant

**Status:** done — and it was not actually running on Linux until now.

`f54562a5` added the docker-exec assertion, `90b04811` un-skipped it after the
2026-07-17 drive observed it live. It now also asserts the explicit lstat form the
spec is stated in (`stat -c %F` → `directory`, alongside `test ! -L` and
`realpath`).

**Worth knowing:** every Docker e2e suite hardcoded `host.docker.internal`, which
does not resolve on plain Linux Docker Engine — `LocalDockerProvider` passes no
`--add-host`, and `getent hosts host.docker.internal` was confirmed to fail here.
So on Linux this invariant test and the floor round-trip test could never have
passed; they would have failed or flaked rather than validated anything. A
`routerHostForContainers` helper now probes the name and falls back to the bridge
gateway. `dockerAvailable()` was also hardened: a transient `spawnSync` failure
used to silently skip the entire opt-in suite, indistinguishable in the reporter
from "no daemon" — i.e. a green run that tested nothing.

### 5. Anomaly: a completed session posts no final `response` activity

**Status:** resolved — it was two separate bugs, and the headline symptom was a
mis-observation.

Reproduced rather than argued. The response activity **was** posted: the drive's
own log line `Result message emitted to Linear (activity activity-89)` is emitted
only for a posted result, and a direct reproduction confirms
`posted: [{"type":"response", ...}]`. The "no final `response`" half is not
reproducible and is contradicted by the drive's own evidence.

What was real is `status: active`. `updateAgentSessionStatus` had exactly one
caller in the repo (`CLIRPCServer.handleStopSession`), so the F1 CLI tracker never
modelled Linear's derive-state-from-last-activity behaviour and every F1 session
read `active` until an operator ran `stop-session`, regardless of what it had
posted. Fixed via `deriveSessionStatusFromActivity`. That is harness infidelity,
which is what made the drive misdiagnose a healthy run.

Separately, the genuine product defect in this area was ACA item 3's — session
status transitions were never persisted — which is why a *restored* session
reported a spurious terminal `error`. The two are unrelated despite the similar
shape; the suspicion recorded here that they were "two faces of one completion-path
gap" was wrong.

**Left open deliberately, needs a ticket owner's call:** `addResultEntry` returns
early when a successful result yields empty content — a turn ending on a tool call
with no trailing prose and no SDK result text. No `response` activity is posted at
all, and since Linear derives state from the last activity, such a session sits at
"Working…" forever. This is the exact shape item 5 described, and it is a real
product hole. It is currently pinned by `AgentSessionManager.pending-work.test.ts`
under CYPACK-1177 / CYHOST-905 ("never post raw tool-input JSON"). A neutral
synthesized body would satisfy both constraints, but overturning that decision
belongs to that ticket's owner.

## Environment note for future Docker drives

Under load (concurrent `docker build`, polling watchers) a booted container was
observed dying ~10s in, before its floor could flush. It was not attributable: the
router logged no sweep destroy, `.Config.Image` matched so it was not
`ensureRunning`'s image-mismatch path, and no terminal webhook was sent. It stopped
happening once the machine was quiet (8 consecutive clean runs). The new tests skip
loudly on that condition rather than reporting a false floor failure. Worth
re-checking if it recurs on a dedicated daemon.
