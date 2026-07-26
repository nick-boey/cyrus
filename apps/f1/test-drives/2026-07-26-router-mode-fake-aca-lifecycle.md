# Test Drive: Router-mode fake ACA lifecycle

**Date**: 2026-07-26
**Goal**: Validate the ACA container control-plane lifecycle through the F1 router rig without creating live Azure resources.
**Test Repo**: `/Users/nboey/code/cyrus/cyrus-containers`
**Rig**: Real in-process `RouterServer`, `CLIIssueTrackerService`, store, event router, lifecycle sweep, artifact and teardown HTTP routes, plus a real device-side `RouterConnection` / `RouterEventTransport` over localhost WebSocket; injected fake `aca` control plane and deterministic credential-free cleanup consumer.

## Verification Results

### Router and executor lifecycle

- [x] User seeded with executor `aca` and a fake Claude credential.
- [x] Synthetic delegation creates the container device, calls `ensureRunning`, mints its token, and connects a real device transport.
- [x] Synthetic prompt routes through the queue to the online device without a redundant provider boot.
- [x] A terminal `session_state` releases affinity and the real lifecycle sweep idle-stops the fake sandbox.
- [x] Idle stop disconnects the device; a later prompt queues, resumes the stopped sandbox, reconnects with durable device state, and is acknowledged.

### Terminal garbage collection

- [x] Synthetic `AppUserNotification` / `issueStatusChanged` enters through `server.eventRouter.route()`.
- [x] The router queues the raw terminal event while the device is offline, registers teardown, and wakes/resumes the stopped sandbox.
- [x] `RouterConnection` receives and acknowledges the queued sequence; `RouterEventTransport` emits both the verbatim webhook and the real translator's terminal `IssueStateChangeMessage`.
- [x] The deterministic device consumer creates a local forced-floor analogue and uploads it through the issue-scoped, device-token-authenticated artifact route. No server-side bundle is pre-created by the test.
- [x] The consumer simulates stop-sessions, teardown-script, and worktree deletion after upload, then pauses. The test proves the queue is drained, the bundle exists, and provider destroy has not run before releasing the callback.
- [x] The device-token-authenticated `teardown-complete` callback then destroys the provider resource and removes the container device row.
- [x] A completed/canceled issue's uploaded persistence-floor bundle is retained for reopen.
- [x] Synthetic `Issue` / `remove` follows the same wake/callback/destroy/device-row path.
- [x] A deleted issue's device-uploaded persistence-floor bundle exists before callback and is removed by terminal teardown.
- [x] Both artifact upload and teardown callback reject the old device token with HTTP 401 after its row is removed.

### Scope and liveness caveat

- [x] No Docker daemon, Linear workspace, or Azure resource is required.
- [ ] This F1 drive does not instantiate a full `EdgeWorker`: the current router rig has no credential-free terminal-only EdgeWorker harness and constructing one would pull in repository/session/runner setup unrelated to this control-plane drive. The consumer deliberately models only its externally observable cleanup handoff. Exact EdgeWorker ordering (force floor sync before response/session removal/worktree deletion, callback last) remains covered by `packages/edge-worker/test/EdgeWorker.issue-state-change.test.ts`; forced sync behavior remains covered by `WorkspaceSyncService.test.ts`.
- [ ] Actual ACA worker-process liveness is not covered. The fake records provider state transitions; it cannot reproduce spike F1, where an exited entrypoint leaves `tini` and the sandbox in infrastructure state `Running`. The live smoke must verify router WSS/device heartbeat liveness with the real worker image.

## Session Log

Relevant builds, including refreshed package `dist` output:

```bash
pnpm --filter cyrus-router-executors build
pnpm --filter cyrus-router build
pnpm --filter cyrus-f1 build
```

F1 drive:

```bash
pnpm --filter cyrus-f1 exec vitest run test/router
```

Result: **PASS**, 7 test files / 24 tests, including the strengthened lifecycle drive.

Focused supporting suites:

```bash
pnpm --filter cyrus-router exec vitest run test/EventRouter.test.ts test/terminal-teardown.test.ts test/artifacts.test.ts test/containers-e2e.test.ts
pnpm --filter cyrus-edge-worker exec vitest run test/EdgeWorker.issue-state-change.test.ts test/WorkspaceSyncService.test.ts
pnpm --filter cyrus-router-client exec vitest run test/RouterConnection.test.ts test/RouterIssueTrackerService.test.ts
```

Results: **PASS**, router 4 files / 66 tests; edge-worker 2 files / 29 tests; router-client 2 files / 43 tests.

Initial failure while writing the drive:

```text
TypeError: ContainerLifecycle is not a constructor
```

Cause: `ContainerLifecycle` is not exported from the `cyrus-router` package root. The drive was corrected to use the real lifecycle instance already exposed by `RouterServer` as its integration-test seam. Active session affinity correctly protects a running worker, so the drive emits the same terminal `session_state` a real worker emits before asking the lifecycle sweep to idle-stop it. The strengthened drive also waits until the gateway observes each disconnect before injecting the next event, ensuring prompts and terminal webhooks genuinely queue and wake the stopped device rather than racing a closing socket.

## Local Gates

Run in the mandated order:

| Gate | Result |
|---|---|
| Relevant builds: `cyrus-router-executors`, `cyrus-router`, `cyrus-f1` | **PASS** |
| `pnpm test:packages:run` | **PASS**: 2,044 tests passed, 6 skipped across package suites |
| `pnpm typecheck` | **PASS**: all 21 participating workspace projects |
| `pnpm build` | **PASS**: all 22 workspace projects (the root filter printed a harmless "No projects matched @cyrus/electron" warning, then built the full scope) |
| `pnpm lint` | **FAIL, pre-existing Tasks 1-8/worktree diagnostics**: after formatting the new F1 file and verifying it independently clean, the rerun reports 18 errors, 17 warnings, and 2 infos elsewhere |
| `pnpm audit` | **BLOCKED**: registry response is gzip bytes parsed as JSON, `Unexpected token '\u001f', "\u001f�\b..." is not valid JSON` |
| `az bicep build --file infra/azure/bicep/sandbox-group.bicep --stdout` | **PASS** with expected BCP081 warning for unavailable preview resource types; emitted `properties: {}` |
| `./scripts/check-aca-arm-parity.sh` | **PASS**: Bicep and Terraform sandbox-group properties both `{}` |

Full lint's errors are not caused by this task's new file. The remaining
formatter errors name existing Task 1-8 files including
`packages/router-executors/src/aca/tokenProvider.ts`,
`packages/router-executors/test/AcaSandboxClient.test.ts`,
`apps/cli/src/commands/RouterCommand.ts`, and `docker/router/entrypoint*`;
warnings also include older runner/core/edge-worker files. They were not
mass-formatted because this task must preserve the current uncommitted Tasks
1-8. The new file passes `pnpm exec biome check
apps/f1/test/router/aca-lifecycle.test.ts`.

All commands warn that the host is Node 26.5.0 while the repository requests
Node 22.x, and that pnpm 10 ignores the stale root `package.json` `pnpm` field.
Neither warning caused a passing gate to fail.

## Live Azure Smoke Assessment

**Status: BLOCKED, merge-blocking. Not run and not claimed as passed.**

Safe prerequisite checks found:

- Azure CLI authentication is present for subscription `dit-development` (`1efb7cc3-4a62-4f9b-9c01-d9f532c0c526`) and tenant `c9857cc6-342b-4bb3-b831-2899b80237dd`.
- Azure Bicep CLI is available through `az bicep` (v0.44.1).

Exact blockers:

- `terraform` is not installed, so the maintained stack cannot be initialized, validated, planned, or applied locally.
- The standalone `aca` CLI is not installed, so the required disk registration, sandbox/snapshot observation, and teardown commands are unavailable.
- Spike S1 records that the actual `cyrus-worker` image exists only as a local tag and has never been published. Only a public stand-in image was booted. There is therefore no verified pullable worker image to register as the ACA disk image.
- `infra/azure/terraform/env/dev.tfvars.example` is a template with placeholder Linear credentials, a null first-apply router WSS URL, and sample image references. The repository contains no explicit completed dev tfvars suitable for a safe ready-to-run deployment.
- Task 9's live proof also requires published router and worker images from this implementation, a configured Linear test user, and an approved paid-resource deployment. Those prerequisites are not established by repository state.

No Azure resources were created or modified. The live smoke remains required before merge: real worker boot/WSS liveness, data-plane behavior, idle suspend/resume continuity and latency, image-bump floor restore, terminal destroy/snapshot cleanup, completed reopen, deleted-bundle cleanup, manual destroy, and ACA-to-Docker floor handoff.

## Final Retrospective

The local router control plane is covered end-to-end at its real seams: both Linear terminal payload kinds, offline queue/wake, real WebSocket delivery and ack, real translation, authenticated floor upload, callback, destroy, row deletion, retention/deletion policy, and stale-token rejection. The in-device cleanup implementation is deterministic rather than a full EdgeWorker; its internal force-sync/callback ordering is explicitly delegated to the focused EdgeWorker unit test. ACA process liveness and preview API/RBAC/snapshot/egress behavior remain live-smoke gates rather than being hidden behind green local tests.
