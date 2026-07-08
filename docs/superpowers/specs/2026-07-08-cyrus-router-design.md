# Cyrus Router — Per-User Device Routing

**Date:** 2026-07-08
**Status:** Draft for review
**Related:** `docs/superpowers/specs/2026-07-07-multi-user-credentials-design.md` (single-host multi-user credentials)

## Problem

The single-host multi-user credential architecture (shipped on the
`multi-user-credentials` branch) injects per-user credentials into runner
environments on one shared host. It has a hard ceiling: it can only inject
what fits in an environment variable. Machine-bound auth — `az` (MSAL token
cache in `~/.azure`), `gcloud`, macOS keychain-backed tools, docker credential
helpers, SSH agents, device-bound conditional-access policies — cannot be
centralized. It also concentrates every team member's Claude OAuth token,
GitHub PAT, and Codex auth in `~/.cyrus/users/*/.env` on one host: a
high-value target and an offboarding liability.

This design routes work to each user's own machine instead. A **router**
process (run by an administrator) registers as the Linear agent application,
receives all webhooks, and forwards each agent session to the device of the
user who created it. Each device runs Cyrus with the full, native auth of
that machine. Credentials never leave the machines where they were
established.

## Goals

- Sessions execute on the creator's own device with machine-inherited auth.
- The Linear workspace app token never leaves the router host.
- Offline devices degrade gracefully: events queue, users are told loudly.
- The router feature is a separate module; core Cyrus (`packages/edge-worker`
  and below) is not contaminated by router awareness.
- Switching a deployment from single-user mode to router mode is seamless and
  driven by the same setup skill.

## Non-goals

- Router high availability / failover (single process with durable state is
  sufficient at the target scale of ~10 users).
- Per-prompt identity switching (running user B's prompt under B's
  credentials inside user A's session). Machine auth forecloses this
  permanently; the creator-only prompting policy makes it unnecessary.
- Live worktree synchronization between devices. The git remote is the sync
  layer (see Worktree continuity).
- Retaining the single-host multi-user credential mode (`cyrus users`,
  env-var injection). It is **removed** as part of this work — machine-inherited
  auth on personal devices supersedes it. Only its `SessionCreator` threading
  and F1 creator payloads are kept (the router's routing key).

## Architecture overview

Three mutually exclusive process modes:

| Mode | Command | Role |
|------|---------|------|
| Single-user | `cyrus start` | Status quo. Unchanged. |
| Router | `cyrus router start` | Admin host. Owns Linear OAuth + webhooks; routes to devices. |
| Router-client | `cyrus connect` | User device. Executes sessions with machine auth. |

```
Linear ──webhooks──▶ Router (admin host, always on)
                       • webhook verification (linear-event-transport)
                       • device registry + enrollment
                       • user → device routing, session/issue affinity
                       • issue locks, creator-only prompt policy
                       • durable per-device event queues (SQLite)
                       • Linear executor: the ONLY holder of the app token,
                         wrapping the existing Linear IIssueTrackerService
                       ▲
                       │ outbound persistent connections (WebSocket,
                       │ dialed by devices; nothing inbound to devices)
        ┌──────────────┴──────────────┐
   Device: Alice                 Device: Bob
   cyrus connect                 cyrus connect
   EdgeWorker (core, unchanged)  EdgeWorker (core, unchanged)
   + RouterEventTransport        + RouterEventTransport
   + RouterIssueTrackerService   + RouterIssueTrackerService
   machine auth: az, gh, ssh,    machine auth: ...
   Claude subscription, local
   Linear MCP (user OAuth)
```

## Module boundaries

Core Cyrus already consumes two interfaces from `packages/core/src/issue-tracker/`:

- `IAgentEventTransport` — inbound event source (today: `LinearEventTransport`
  webhook server; F1 substitutes `CLIEventTransport`).
- `IIssueTrackerService` — outbound issue-tracker API (today: Linear-backed;
  F1 substitutes `CLIIssueTrackerService`).

Router-client mode is a third pair of adapters behind the same interfaces.
The F1 framework proves this seam works end-to-end.

New packages:

| Package | Contents |
|---------|----------|
| `packages/router-protocol` | Wire message types only: hello/ack, event/event_ack, RPC request/response frames, session-state reports, enrollment exchange. The only code shared between router and client. |
| `packages/router` | Server: webhook receipt (reuses `linear-event-transport`), device registry + enrollment, affinity maps, issue locks, durable queues, Linear executor. Wraps the existing Linear `IIssueTrackerService` as a privileged client. |
| `packages/router-client` | `RouterEventTransport` (implements `IAgentEventTransport`), `RouterIssueTrackerService` (implements `IIssueTrackerService`), connection management (dial, heartbeat, reconnect, replay, outbound buffer). |

`apps/cli` gains mode selection (`cyrus router …`, `cyrus connect`) only.

**Boundary invariant:** the router and client interact with core Cyrus only
through `IAgentEventTransport` and `IIssueTrackerService`, and
`router-protocol` is the only shared code between the two sides. A change to
`packages/router` that requires touching `EdgeWorker.ts` is a design smell to
be caught in review.

The single deliberate core change is in `GitService` (see Worktree
continuity); it is small and benefits all modes.

## Routing model

Routing key is the **agent session creator** (`webhook.agentSession.creator`,
already threaded end-to-end by the multi-user credentials work).

- **User → device:** exactly one device per user. Enrollment of a new device
  replaces the old one and invalidates its token. Users who want always-on
  behavior run their device on a VPS and interact with its repos by cloning
  and branching from the git remote.
- **Session affinity:** the creator's device owns a session for its lifetime.
  All subsequent events for that session route to the owning device
  regardless of actor. Affinity is recorded when the session-created event is
  routed and released on terminal state.
- **Issue affinity for sub-issues:**
  1. Sub-issues created via the user's local Linear MCP are attributed to the
     human, so the delegation webhook's creator is routable natively — no
     special handling.
  2. Sub-issues created via cyrus-tools (router RPC, app-attributed) get
     affinity registered atomically at creation: the router creates the issue
     and maps `issue → requesting device` in one step.
  3. Fallback: an app-created session with no affinity inherits the parent
     issue's owning device.
- **Unroutable creator** (not enrolled, or enrolled with no device): the
  router posts a fail-closed activity to the session with router-specific
  enrollment instructions (`cyrus router users add` by the admin, then
  `cyrus connect` on the user's machine) and does not deliver.

Repository routing (`RepositoryRouter`) is untouched and runs on the device
after delivery, exactly as today.

## Transport

Devices dial the router over a single outbound WebSocket (wss) and hold it
open with heartbeats. Nothing listens on the device; this traverses
NAT/firewalls/VPNs and requires no per-device tunnels. The connection carries,
as JSON frames defined in `router-protocol`:

- `hello` / `hello_ack` — device token auth, protocol version, last-acked
  event sequence number; router replies with the user's identity and config
  snapshot.
- `event` / `event_ack` — webhook delivery, per-device monotonic sequence.
- `rpc_request` / `rpc_response` — `RouterIssueTrackerService` calls
  (mirroring the `IIssueTrackerService` subset the client needs).
- `session_state` — device reports session terminal states (drives affinity
  and lock release).
- `ping` / `pong` — liveness.

Connection state doubles as the liveness signal: connected = online. Devices
reconnect with exponential backoff and resume from their last-acked sequence.

The router-client does not run `SharedApplicationServer`'s webhook endpoint
or tunnels; it has no inbound surface.

## Delivery semantics and queues

**Router → device (events):** durable per-device FIFO (SQLite in the router
state dir). The router ACKs Linear immediately, enqueues, and delivers over
the connection; an event is dequeued only when acked. Per-device FIFO
preserves per-session prompt ordering. Delivery is at-least-once; devices
dedupe by webhook ID.

**Offline handling — queue-until-online with TTL + loud failure:**

- On enqueueing for an offline device, the router posts an activity to the
  Linear session ("Waiting for <user>'s machine to come online"), rate-limited
  to once per session.
- Events expire after a TTL (default 48h, configurable). On expiry the router
  posts a failure activity and drops the event. Delivering stale prompts to a
  returning laptop is worse than failing.

**Device → router (mutations):** activity posts and other mutating RPCs are
buffered durably on the device when the router is unreachable and replayed in
order on reconnect, deduplicated by client-generated UUID. Read RPCs fail
with retry/backoff (if the router is down, no new events arrive either, so
sessions quiesce rather than corrupt).

## Linear access: two planes

**Infrastructure plane — router-mediated, app token.** Only the app token can
drive the agent-session API (posting agent activities, managing sessions), and
it stays on the router host exclusively. The device's
`RouterIssueTrackerService` forwards all infrastructure calls (activities,
issue/comment fetching for prompt assembly, attachment pass-through, state
transitions, cyrus-tools issue creation) as RPCs. The router enforces
per-device authorization: a device may only act on sessions routed to it.
Attachments stream through the router with a size cap.

**Agent tool plane — user-local Linear MCP, user OAuth.** In router-client
mode Cyrus does not configure the app-token Linear MCP server. Users install
the official Linear MCP on their own device (one interactive OAuth at
`cyrus connect` time, checked by the setup flow). The agent's Linear tool use
is then attributed to the human, scoped by the human's actual Linear
permissions, and consistent with the machine-auth philosophy. `cyrus connect`
verifies MCP auth health; headless sessions cannot complete a browser OAuth
flow, so expired auth is surfaced at connect/session start rather than
mid-session.

cyrus-tools remains available in sessions, backed by the router RPC
(app-attributed, atomic affinity). If its tool list changes, the cyrus-hosted
catalog must be updated per CLAUDE.md item 10.

## Cross-user policy

**Creator-only prompting (default on in router mode, configurable).** The
router compares each prompt's actor against the session creator. Non-creator
prompts are not delivered; the router posts a polite activity ("this session
belongs to <creator>; delegate the issue to start your own session").
Rationale: sessions run under the creator's full machine identity; letting
other users drive it is a larger exposure than the env-injection model, and
two users steering one session is chaotic in practice.

**Issue lock (new, configurable, default on in router mode).** While any
session is active on issue X — on any device — new agent sessions on X are
rejected with a polite activity naming the active user/device. No such
protection exists today (worktrees are keyed by issue identifier, so
concurrent sessions collide on one host and diverge across hosts); the router
is the only component that sees all sessions, so it is the natural
enforcement point. Lock release: session terminal state (via
`session_state`), device token revocation, device offline beyond TTL, or
`cyrus router unlock <issue>`.

## Device enrollment and security model

Enrollment is admin-mediated with one-time codes bound to a Linear identity:

1. `cyrus router users add <email>` — router stores the Linear identity and
   prints a single-use, short-lived (15 min) enrollment code.
2. Admin hands the code to the user out-of-band. User runs
   `cyrus connect <router-url> --code XXXX-XXXX`.
3. Device exchanges the code for a long-lived per-device secret token
   (stored 0600 in the client config); the code is burned. Re-enrollment
   replaces the device and invalidates the old token immediately.

Management: `cyrus router users list|remove`, `cyrus router devices
list|revoke`, `cyrus router unlock <issue>`.

Trust boundaries:

- **Workspace app token:** router host only. Devices never see it.
- **Device token:** grants receipt of one user's sessions and RPC scoped to
  that user's own sessions. A stolen device token cannot act workspace-wide.
- **Linear-side triggers** are protected by Linear workspace auth as today.
- Device auth protects issue-content confidentiality and timeline-posting
  integrity — the residual surface after router mediation.

## Worktree continuity

No sync mechanism. **The git remote is the sync layer.** Two rules:

1. **Push before terminal states.** If the worktree is dirty when a session
   ends or parks, auto-commit to the issue branch as WIP and push
   (configurable off). This shrinks the unreachable-work window to
   mid-session crashes.
2. **Prefer the issue branch on the remote.** `GitService` worktree creation
   checks for an existing `origin/<issue-branch>` and bases the new worktree
   on it instead of the base branch. This is the single deliberate core
   change; it also improves single-host behavior (e.g. after worktree
   cleanup).

A new session by user B on an issue previously worked by user A then
reconstructs state on B's machine from the remote, like any developer would.
Uncommitted work on a crashed/sleeping machine is out of scope by design.

## Configuration and CLI

**Router host** (`~/.cyrus/router/`): Linear OAuth credentials (existing
flow), webhook secret, device registry, queue database, and settings
(`eventTtlHours`, `issueLock`, `creatorOnlyPrompting`, `attachmentMaxMb`).

**Client device:** config shrinks to `{ routerUrl, deviceToken }` plus
repository configuration. No Linear token, no webhook/tunnel config, no
`users[]` credential profiles (the env-injection feature is removed entirely;
machine auth replaces it). Warm sessions may remain enabled
in router-client mode: the device serves exactly one identity, so the
multi-user warm-session guard does not apply.

The cyrus-setup skill gains the two new modes; moving an existing single-user
setup to router-client keeps repository config as-is and removes the
Linear/webhook sections.

## Error handling summary

| Failure | Behavior |
|---------|----------|
| Device offline | Queue + Linear activity; TTL expiry posts failure and drops. |
| Router down | Linear retries webhooks briefly; devices buffer mutations, reconnect with backoff, replay. In-flight sessions quiesce (no event source, buffered posting) rather than corrupt. |
| Linear API down | Router retries with backoff; RPC errors propagate to devices as today's Linear SDK errors. |
| Duplicate delivery | Device dedupes events by webhook ID; router dedupes mutations by client UUID. |
| Unenrolled creator | Fail-closed activity, no delivery (mirrors multi-user gate). |
| Stale issue lock | Released by offline-TTL or `cyrus router unlock`. |

## Testing

- Unit tests per new package (registry, queue ordering/TTL, lock lifecycle,
  protocol framing, RPC scoping/authorization).
- Protocol replay tests from recorded frame transcripts (mirroring the
  runner-transcript replay pattern).
- Adapter conformance: `RouterIssueTrackerService` and `RouterEventTransport`
  against the same expectations as the CLI/F1 adapters.
- F1 end-to-end: a router-mode test drive — router + two simulated devices,
  covering creator routing, offline queue + TTL activities, creator-only
  prompt rejection, issue lock, sub-issue affinity (both creation paths), and
  worktree continuation from a pushed branch. F1 already emits
  `agentSession.creator` payloads.

## Rollout

1. `router-protocol` + `router-client` adapters against a stub router
   (conformance tests).
2. `packages/router` with registry, queues, routing, Linear executor.
3. CLI modes + enrollment + setup-skill integration.
4. Policy features: issue lock, creator-only prompting, TTL activities.
5. F1 router-mode scenarios; docs (`docs/SELF_HOSTING.md` sibling page).

## Deferred

- Hybrid fallback executor (an always-on host serving offline users'
  sessions) — would require reintroducing a credential-injection mode;
  composes later via the registry if ever needed.
- Multiple Linear workspaces per router.
- Router HA / multi-region.
