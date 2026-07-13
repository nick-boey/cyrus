# Ephemeral Container Executors for the Cyrus Router

**Date:** 2026-07-13
**Status:** Implemented (phase 1)
**Scope:** `packages/router`, `packages/router-protocol`, `packages/router-client`, new `packages/router-executors`, container entrypoint assets

## Goals

- Add a third deployment mode: the router launches **ephemeral containers** to run sessions, instead of (or alongside) persistent client devices.
- Preserve Linear-side ergonomics unchanged: sessions can be started and resumed; new sessions on the same issue share the same working directory.
- **Per-user executor selection.** Each enrolled user is served by one of: physical device (today's mode), Fly Machines, GitHub Codespaces, or a stateless container provider (local Docker now; ACA-class providers later).
- **Git-as-floor persistence in every mode**, so an issue can move between executors (including device → container) without losing committed or WIP work.
- Standalone mode and router+device mode keep working exactly as they do today.
- Sized for one organisation, 3–10 users. No isolation requirement *between* users; normal isolation from the outside world still applies.

## Non-goals

- Multi-tenancy across organisations.
- Warm-pool / sub-second cold starts (Fly stopped-machine restart is already seconds).
- Changing the EdgeWorker session model, prompt assembly, or runner implementations. Containers run the existing client stack unmodified.

## Architecture overview

```
Linear ──webhook──▶ Router (always-on, SQLite)
                      │  EventRouter.resolveTarget()
                      │    ├─ user → executor config
                      │    ├─ device target (existing)        ──WS──▶ teammate laptop / VM
                      │    └─ container target (new)
                      │         ExecutorRegistry.ensureRunning(issue)
                      │              ├─ FlyMachinesProvider      ──boot──▶ machine+volume per issue
                      │              ├─ CodespacesProvider       ──boot──▶ codespace per issue
                      │              └─ LocalDockerProvider      ──boot──▶ container+volume per issue
                      │
                      ▼ (existing durable per-device event queue absorbs boot latency)
              container connects back over the existing WS protocol
              with a minted device token and runs RouterConnection + EdgeWorker
```

The container is modelled as an **ephemeral device**: a `devices` row with `kind = 'container'`, provider metadata (machine id / codespace name), and a minted token. Session and issue affinity point at it exactly as they point at physical devices today. The existing offline-queueing behaviour is the cold-start mechanism: the router enqueues the event, ensures the container is running, and the queue drains when the container's WebSocket connects.

### Unit of execution: one container per issue

All sessions for an issue route to that issue's container (mirroring today's shared worktree per issue). Multi-repo issues use the existing `GitService` multi-repo layout inside the one workspace. Sub-issues have their own identifiers and therefore their own containers.

## Components

### 1. `ExecutorRegistry` + `ContainerExecutor` interface (new, router-side)

New package `packages/router-executors` consumed by `packages/router`:

```ts
interface ContainerExecutor {
  /** Idempotent. Boot or resume the container for this issue; returns the ephemeral device ref. */
  ensureRunning(ctx: IssueExecutionContext): Promise<EphemeralDeviceRef>;
  stop(issueKey: string): Promise<void>;      // park (volume/disk retained)
  destroy(issueKey: string): Promise<void>;   // after teardown + final floor sync
  status(issueKey: string): Promise<"running" | "stopped" | "absent">;
}

interface IssueExecutionContext {
  issueKey: string;              // e.g. "CYHOST-123"
  repositories: RepoRef[];       // from routing decision
  user: EnrolledUser;            // selects the secret bundle
  deviceToken: string;           // minted for this container
  routerUrl: string;
  size?: MachineSize;            // per-user or per-repo override
}
```

Providers in scope: `FlyMachinesProvider` (primary), `CodespacesProvider`, `LocalDockerProvider` (dev, f1 testing, and the "one beefy host" on-ramp). ACA or similar can be added later behind the same interface using the stateless persistence path.

### 2. Router changes (`packages/router`)

- **`users`**: add `executor` config (`{ type: "device" } | { type: "fly", size? } | { type: "codespaces" } | { type: "stateless", provider }`). Default `device` — existing enrollments are unaffected.
- **Per-user secret bundle** (router-held; single-org threat model): Claude Code OAuth token (from `claude setup-token`), git author identity, optional dotfiles repo URL, optional GitHub PAT (see Credentials). Stored alongside `router-config.json` with 0600 perms. CLI: `cyrus router users set-executor`, `cyrus router users secrets set`.
- **`EventRouter.resolveTarget`**: when the resolved user's executor is a container type, derive the issue's ephemeral device id (creating the device row on first route), call `ExecutorRegistry.ensureRunning`, and enqueue as normal.
- **Artifact store** (the floor's server side): authenticated HTTP endpoints on the existing Fastify app, device-token auth:
  - `PUT /artifacts/issues/:issueKey/bundle` — tarball of Claude transcripts + workspace metadata
  - `GET /artifacts/issues/:issueKey/bundle`
  Stored under `<cyrusHome>/router/artifacts/`. At 3–10 users this is megabytes, not gigabytes; it joins `router.db` in the router backup story.
- **Session-state persistence**: per-session metadata (`claudeSessionId`, workspace path, repo set) travels inside the artifact bundle (`state/sessions.json`) rather than over new protocol frames — `PROTOCOL_VERSION` stays at 2 and `session_state` frames keep their existing terminal-state-only role. A freshly booted container reconstructs its `edge-worker-state.json` from the downloaded bundle.
- **Lifecycle policies**: stop a container after an idle timeout (no sessions holding affinity; default 15 min). Destroy (and delete volume/codespace) after a stale timeout (default 14 days) or via `cyrus router containers destroy <issueKey>`. Issue-terminal-state destruction is a future enhancement — the router does not currently forward issue-update webhooks to devices, and the floor sync at session end already guarantees WIP is pushed before any destroy. Aggressive GC is safe *because* of the floor.

### 3. Container image + entrypoint contract

- **Image**: per-repo runtime image built in GitHub Actions from the repo's `devcontainer.json` (via the devcontainer CLI), pushed to GHCR. Includes the Cyrus client, a baked bare-repo cache, and warmed dependency/build caches where feasible. This is the "prebuild" for non-Codespaces providers; Codespaces uses native prebuilds from the same `devcontainer.json`.
- **Boot env**: `ROUTER_URL`, `DEVICE_TOKEN`, `ISSUE_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, git identity, GitHub token bootstrap.
- **Canonical workspace path**: `/workspaces/<ISSUE-KEY>` must be a **real directory** — not a symlink — in **every** container executor. **Corrected during Task 3, verified against the live `claude` CLI (v2.1.207):** the Agent SDK keys transcripts by the **realpath-resolved** session cwd (`~/.claude/projects/<sanitized-cwd>/`), not the literal cwd string passed to it. An earlier draft of this section proposed satisfying platform-dictated clone locations (e.g. Codespaces' `/workspaces/<repo>`) by symlinking `/workspaces/<ISSUE-KEY>` to the real location and having the EdgeWorker use the symlink as cwd — that does NOT work: the SDK resolves the symlink before sanitizing, so it sees wherever the symlink points, not the canonical string, and two executors (or two boots) whose symlink targets differ silently break Claude-session resume. Every executor must therefore make `/workspaces/<ISSUE-KEY>` itself a real directory containing the worktree (clone/checkout directly there, or bind/volume-mount it there) — never a symlink to elsewhere.
- **Restore ladder** (run at boot, in order):
  1. Workspace already present on the volume / codespace disk → use it (fast path).
  2. Else: `GET` the artifact bundle from the router (transcripts + metadata), clone from the baked repo cache, fetch and check out the issue branch — including remote WIP commits if present.
  3. Else (brand-new issue): fresh worktree from the base branch, run `cyrus-setup.sh`.

  Then apply dotfiles, hydrate session state from the router, and start `RouterConnection` + `EdgeWorker` (`platform: "router"`).
- **Hard requirement — graceful resume degradation**: if a session's transcript file is missing at restore time (e.g. device → container switch, lost volume), the runner session id is stripped during bundle restore so the EdgeWorker's existing `needsNewSession` path starts a *fresh* runner session re-primed from the Linear thread and the restored branch rather than failing the prompt. This is the floor's escape hatch and must be covered by tests.

## Persistence model

Layered: the **floor applies to every executor**; native persistence sits on top for speed.

### Floor (all modes) — git + router artifact store

- On session end, on idle-stop, and periodically during long sessions (default every 5 min): `pushWipIfDirty` (already implemented in `GitService`) pushes uncommitted work as WIP commits to the issue branch; the transcript dir for the canonical cwd plus session metadata is tarred and `PUT` to the router.
- Crash window: at most the sync interval. Fly/Codespaces narrow this further because their disks survive crashes.

### Native layers per provider

| Provider | Worktree + caches | Claude transcripts | Notes |
|---|---|---|---|
| **Fly Machines** | Volume per issue mounted at `/workspaces`; stopped machine retains volume + rootfs | On the volume (symlinked from `~/.claude/projects`) | Stop/start in seconds; the latency winner |
| **Codespaces** | Codespace disk persists while stopped | Codespace home dir | Native devcontainer/prebuilds/dotfiles; 30-day retention expiry is caught by the floor |
| **Stateless (Docker/ACA)** | Local Docker: named volume per issue. ACA-class: nothing — floor *is* the persistence | Restored from artifact bundle each boot | Works anywhere; slowest resume |
| **Physical device** (existing) | Device disk (unchanged) | Device disk (unchanged) | Floor sync added here too, enabling device → container migration |

### Executor switching

`cyrus router users set-executor <user> <type>` flips the stored config; the floor sync at each session end means idle containers already hold a current bundle, the old provider's container is destroyed lazily when the issue next routes (provider-mismatch replacement) or by the idle/stale sweeps, and the next event boots on the new executor via the restore ladder. Branch + WIP always survive. Claude-native session resume survives **container ↔ container** switches (canonical cwd + transcript bundle). **Device → container** switches lose in-flight Claude resume (device cwds are arbitrary paths) and fall back to the re-prime path; committed/WIP work is preserved.

## Credentials

| Credential | Where it lives | How it reaches the container |
|---|---|---|
| Linear | Router only (unchanged) | Never — all Linear calls proxied via existing RPC (`LinearExecutor`) |
| Claude (per-user OAuth) | Router secret bundle | `CLAUDE_CODE_OAUTH_TOKEN` env at launch (Fly secrets / Codespaces user secrets) |
| GitHub | GitHub App (exists: `GitHubAppTokenProvider`) | Router mints installation tokens; new allowlisted RPC method `github.token` lets a long-lived container refresh (installation tokens live 1 h). Fallback: per-user PAT in the secret bundle if per-user PR attribution is wanted. Codespaces containers may also use the native `GITHUB_TOKEN`. |
| Git author | Router secret bundle | Env → `git config` at boot, so commits are attributed to the owning user |

## Failure modes

- **Container crash mid-session**: Fly/Codespaces — disk intact, restart resumes fully. Stateless — lose at most one sync interval; restore ladder + re-prime fallback recovers.
- **Volume/host loss**: floor restore (branch from GitHub, transcripts from router).
- **Router down**: containers buffer outbound via existing `RouterConnection` durable buffers; Linear webhooks are missed exactly as in today's router mode (unchanged risk).
- **Boot failure (image pull, provider outage)**: event stays in the durable queue with TTL; router surfaces an activity to Linear after N failed boot attempts (reuse the existing "device offline" messaging path).

## Cost sketch (Fly, primary path)

Verified against Fly pricing (2026): shared-cpu-4x/8GB ≈ $44/mo continuous ≈ **$0.06/hr**; volumes and stopped-machine rootfs **$0.15/GB-month**.

Assumptions: 10 users, ~15 issue-machines doing 4 active hrs/weekday, ~15 parked machines at any time (aggressive GC), 10 GB volume + ~8 GB rootfs each.

- Active compute: 15 × 4 h × 22 d × $0.06 ≈ **$80/mo**
- Parked storage: 15 × 18 GB × $0.15 ≈ **$40/mo**
- Total ≈ **$120–150/mo**, scaling roughly linearly with concurrent active issues. Codespaces for comparison: $0.36/hr for a 4-core machine ≈ $475/mo for the same 1,320 active hours (≈ $238 on 2-core), before storage — Fly is ~3–4× cheaper for equivalent activity.

## Testing

- `ContainerExecutor` is faked in unit tests; provider adapters get thin contract tests.
- `LocalDockerProvider` is the f1 end-to-end vehicle: full test drives covering cold boot, prompt-resume on a stopped container, executor switch (docker → docker fresh volume, simulating fly volume loss), and device → container migration with re-prime fallback.
- Replay tests for the new artifact endpoints and `session_state` persistence.
- Restore-ladder unit tests: each rung reached under the right preconditions; graceful-degradation test for missing transcripts.

## Rollout phases

1. **Floor + LocalDockerProvider**: artifact endpoints, periodic sync, session-state persistence/hydration, restore ladder, entrypoint, ephemeral-device model in the router. This alone delivers the full ergonomics on a single Docker host (and fixes the small-VM OOM problem via per-container memory limits).
2. **FlyMachinesProvider**: volumes, stop/start lifecycle, GC, Fly secrets.
3. **CodespacesProvider**: `gh codespace` orchestration, prebuild guidance, retention-expiry handling.
4. (Optional, later) ACA-class stateless provider — falls out of the floor.

Each phase leaves standalone and router+device modes untouched; container mode is opt-in per user.
