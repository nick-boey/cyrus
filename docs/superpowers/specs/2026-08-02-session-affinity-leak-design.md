# Stale Session Affinity Pins Containers Out of the Idle Sweep

**Date:** 2026-08-02
**Status:** Design (approved in brainstorming; pending spec review)

## Goal

Stop a leaked `session_affinity` row from exempting a container device from the
idle sweep indefinitely — without ever suspending a device that still has a live
session on it.

## Background — why this exists

On 2026-08-02 the sandbox for PAR-146 (`5bce3626`, device 10) parked correctly
and then ran for 28+ minutes at 4 vCPU / 8 GiB anyway. The park feature shipped
the day before worked exactly as designed:

```
02:24:56  Queued session 2371fca2… for container device 10, dispatched boot
02:25:51  Session 2371fca2… parked on device 10; released affinity, retained the issue lock
```

`devices.parked_at_ms` was stamped (1785637551974 = 02:25:51Z), `idleStopMs` was
300_000, and the sweep ran every 60s. Nothing stopped the container.

`ContainerLifecycle.sweep()` never reaches the parked clock, because it returns
two lines earlier (`ContainerLifecycle.ts:88`):

```ts
const affinity = this.store.countSessionAffinityForDevice(row.deviceId);
if (affinity > 0) continue;   // never stopped, never destroyed
```

The live router store held an affinity row for a **different, already-terminal
session**:

| session_id | device_id |
|---|---|
| `7b6ab935-c718-4f42-892b-f51f060e8a30` | 10 |

`7b6ab935` is the previous agent session on PAR-146. It reached terminal state
twice and was logged as cleared both times — 08-01 14:24:21 and 08-02 00:09:12,
each `released lock and affinity`. So `countSessionAffinityForDevice(10)` was
permanently 1 and device 10 was exempt from idle-stop forever.

### How the row came back

`session_affinity` is written only by `setSessionAffinity`, which has three call
sites: `EventRouter.ts:423` (unpark), `:630` (created route), `:778` (prompted
route). The first two log the session id, and no such log exists for `7b6ab935`
after 00:09:12. The third is **silent** — `deliverOrNotify` returns early with no
log when the device is online (`EventRouter.ts:1007-1010`), and `routePrompted`
has no success log of its own.

The webhook ledger has an unaccounted-for prompt in exactly the right window:

```
00:07:57  prompted  → "Queued session 7b6ab935…"   (device offline → logged)
00:09:12  7b6ab935 terminal, affinity cleared
00:11:17  prompted  → NO LOG                        (device online → silent)
00:12:05  created   → new session 2371fca2…
```

That 00:11:17 prompt landed on the already-completed `7b6ab935`. This is
deliberate: the comment at `EventRouter.ts:699-704` explains a Linear agent
session outlives its turns, so prompts re-resolve through the full chain and
re-establish affinity. The user then started a fresh session instead, so
`7b6ab935` never sent another terminal frame and its affinity was never cleared.

Two details confirm this path rather than a stale blob restore:

- **`issue_locks` was empty** while affinity was set. `routeCreated` takes a lock
  *and* affinity together; only `routePrompted` (`:778`) sets affinity without
  acquiring a lock. `affinity ✓ / lock ✗` is unreachable any other way.
- `rpc_mutations` carried rows from 00:28, so the DB lineage runs through the
  00:09:12 delete — the row was not resurrected by a restore.

### Why nothing cleaned it up

`reconcileDeviceLocks` is the only reclaim path and it misses this on both
counts: it was skipped at 02:25:36 (`it has undelivered events`), and even when
it runs it iterates `getIssueLocksForDevice` — a session with no lock is never
considered.

## The invariant being fixed

Affinity is written on routing and cleared only by a frame the worker may never
send. That makes it a two-party state machine with no reconvergence: every lost
or never-sent frame is a permanent divergence. The park work already patched one
instance (the `active` frame in 7626e6ae); this patches the class.

**New rule: a device's affinity set is a claim the router periodically
re-derives from the device, not a ledger it accumulates.**

The device is already the authority. `hello.activeSessions` exists for exactly
this (`frames.ts:53-60`) and its comment names this failure — "the device lost
its persisted state and can never send those sessions' terminal frames". Three
things are wrong with it, all fixable without changing that idea:

1. it reclaims **issue locks only**, never affinity — and `routePrompted` sets
   affinity *without* a lock, so a leaked row is invisible to it by construction;
2. it fires **only on connect**, and the device in this incident connected once
   and stayed up;
3. it bails **device-wide** on pending events (`EventRouter.ts:468`) — precisely
   when a fresh boot is reconciling.

The affinity gate itself is untouched. `if (affinity > 0) continue` still holds;
we only make the set it counts honest.

## Architecture

```
ContainerLifecycle.sweep(60s tick)
  └─ device blocked ONLY by affinity?
       ├─ online + supports query ─→ sessions_query ──→ worker
       │                             sessions_report ←── worker
       │                             └─ reclaim affinity rows not declared
       │                                AND older than affinityGraceMs
       │                                └─ re-evaluate idle clock this same tick
       ├─ online, no support / no reply → skip, log on transition
       └─ offline ─→ ignore rows older than offlineAgeOutMs,
                     letting stale-destroy proceed
```

## Protocol change

Two new frames, both additive:

- `sessionsQueryFrame` → `serverFrame`: `{ type: "sessions_query", id }`
- `sessionsReportFrame` → `deviceFrame`: `{ type: "sessions_report", id, activeSessions: string[] }`

`helloFrame` gains `capabilities: z.array(z.string()).optional()` — one
extensible field rather than a boolean per feature. The router sends
`sessions_query` only to devices advertising `"sessions_query"`.

**`PROTOCOL_VERSION` is not bumped.** The two sides handle unknown frames
asymmetrically, and the direction matters:

- **Client is lenient.** `RouterConnection.handleMessage` catches the
  `parseServerFrame` throw and returns (`RouterConnection.ts:524-525`,
  `// Ignore unparseable / unknown frames`). An old worker sent a
  `sessions_query` therefore ignores it and simply never replies — which lands
  on the `undefined` "can't tell, skip" path that is already correct. Sending
  the frame to an old worker is safe.
- **Router is strict.** `DeviceGateway.handleMessage` closes the socket with
  `1002 invalid frame` on a parse failure (`DeviceGateway.ts:173-176`). An
  **old router** receiving `sessions_report` from a new worker would drop that
  device's connection.

So the capability flag is **not** a safety mechanism — it is a latency
optimization that turns a 5s timeout per old device per sweep tick into an
immediate skip. The genuine compatibility constraint is the router-side
strictness, which is exactly why deploy ordering below is load-bearing.

The existing three-way distinction carries over unchanged: **absent** = "can't
tell, skip"; **empty array** = "device tracks nothing, reclaim everything".

### Deploy ordering

Router before worker, same as the park change. A worker image bump already
forces sandbox replacement via the `cyrus.disk` label, so correct ordering falls
out of the normal rollout — but it belongs in the runbook rather than left
implicit.

## Components

### `RouterStore`

- `session_affinity` gains `established_ms INTEGER`, stamped by
  `setSessionAffinity` and refreshed on re-affinity (a re-prompt is a fresh
  claim).
- Migration backfills existing rows to migration time, so the offline age-out
  path has a sane clock instead of treating every pre-upgrade row as ancient.
- New read: `listSessionAffinityForDevice(deviceId)` → `{sessionId, establishedMs}[]`.

### `EventRouter`

New `reconcileDeviceAffinity(deviceId, declared, nowMs)`, **separate from**
`reconcileDeviceLocks`. It reclaims rows that are both undeclared *and* older
than `affinityGraceMs`.

Deliberately not an extension of the existing method: its device-wide
pending-events bail is correct for locks and has tests, and the per-row grace
window is a better guard for affinity anyway — it fixes the "skipped exactly
when a fresh boot needed it" hole without touching lock behaviour.

### `DeviceGateway`

`querySessions(deviceId, timeoutMs): Promise<string[] | undefined>`, correlated
by frame id. Returns `undefined` for offline, unsupported, or timed-out — never
a guess.

### `ContainerLifecycle`

Takes an injected `SessionReconciler` seam (`reconcile(deviceId): Promise<number>`
returning remaining affinity) rather than reaching into `EventRouter` or the
gateway. Keeps the sweep unit-testable with a fake and the dependency direction
clean.

### `RouterConnection` (router-client)

Advertises the capability and answers `sessions_query` from the existing
`getActiveSessions` provider — already wired as
`() => this.agentSessionManager.getLiveSessionIds()` (`EdgeWorker.ts:681`). No
new worker-side truth source.

### `EdgeWorker`

Emits a terminal frame for a prompted event it cannot service (no runner,
session already complete). Defence in depth: reconciliation now catches this
within a sweep tick anyway, so this stops the row being *created* — it is not
the thing we rely on.

## Configuration

| Knob | Default | Why |
|---|---|---|
| `affinityGraceMs` | 10 min | Must exceed worst-case route→worker-tracking. The incident's cold boot was ~60s (02:24:56 route → 02:25:36 connect). Only ever relevant to a *just-routed* session — a long-running session is protected by being **declared**, not by the grace. |
| `offlineAgeOutMs` | 1 hour | Only lifts the affinity gate; `staleDestroyMs` still decides actual destruction. |
| `sessionsQueryTimeoutMs` | 5 s | Well inside the 60s tick. |

`affinityGraceMs` and `offlineAgeOutMs` are `ContainerLifecycleOptions` fields
alongside the existing `idleStopMs` / `staleDestroyMs`, defaulted in
`RouterServer.ts` next to `DEFAULT_IDLE_STOP_MS` and overridable from
`CYRUS_ROUTER_CONTAINERS_JSON`. `sessionsQueryTimeoutMs` belongs to
`DeviceGateway`, since it is a transport deadline rather than a lifecycle policy.

Note that adding these to `CYRUS_ROUTER_CONTAINERS_JSON` means the router config
schema in `apps/cli/src/commands/RouterCommand.ts` needs the matching optional
fields, or they will be stripped before reaching `RouterServer`.

## Startup reconciliation

No separate mechanism is needed, and adding one would duplicate two that already
exist. Restored rows keep their real `established_ms`; devices reconcile on hello
as they reconnect; devices that never reconnect are handled by the offline
age-out.

## Visibility

The diagnostic log currently sits *after* `if (affinity > 0) continue`, so a
pinned device is completely silent — the reason this incident required
downloading and querying the blob backup to diagnose. It moves above the gate.

To avoid 60s spam the router logs on **transition**: once when a device becomes
pinned-and-unreconcilable (naming the holding sessions), once when it clears,
tracked in an in-memory set.

## Error handling and edge cases

| Case | Behaviour |
|---|---|
| Device declares the session | Affinity kept — the normal case |
| Undeclared, older than grace | Reclaimed and logged — the bug in this incident |
| Undeclared, within grace | Kept. Covers the routed-but-not-yet-tracked race the pending-events bail was reaching for |
| Old worker, no capability | Never queried, never guessed. Heals on next reconnect via the connect path. Even if queried it would ignore the frame and time out into the same path |
| Query times out or errors | Skip, log, retry next tick. Never reclaim on silence |
| Reclaim races a terminal frame | Both delete the same row — idempotent |
| Reclaim races a fresh route | Grace window covers it; store is re-read before acting |
| Device offline within age-out | Kept — a suspended sandbox burns no compute |
| Device offline past age-out | Gate lifted; `staleDestroyMs` governs destruction. The rows are **not** deleted here — the sweep only stops counting them, and they disappear with the device row when stale-destroy runs. Deleting them outright would discard `creator_json` for a session that may still be legitimately re-prompted |
| Worker declares a session the router has no row for | Ignored; not this mechanism's job |

## Testing

**Regression test first**, reproducing the incident state exactly: a device has
an affinity row for a session that already went terminal (**affinity ✓ /
lock ✗** — only `routePrompted` produces that shape); a second session parks;
`sweep()` runs. Today the device is skipped forever; expected is reconciled then
idle-stopped.

**Unit — `RouterStore`:** `established_ms` stamped on set, refreshed on re-set;
migration backfills existing rows to migration time.

**Unit — `EventRouter.reconcileDeviceAffinity`:** reclaims undeclared *and* past
grace; keeps undeclared-within-grace; keeps declared regardless of age;
`undefined` declared list is a no-op; empty array reclaims all past-grace rows.
Plus: `reconcileDeviceLocks` behaviour is byte-for-byte unchanged.

**Unit — `DeviceGateway.querySessions`:** reply, timeout, offline, and
no-capability all return `undefined` distinctly from an empty list.

**Unit — `ContainerLifecycle`:** reconcile invoked only when affinity > 0; a
cleared device stops in the *same* tick; offline age-out lifts the gate; a
declared session is never stopped at any age; pinned/cleared transitions log
exactly once each.

**Unit — protocol:** a device that omits the capability is never sent
`sessions_query` (the parse-throw hazard); both new frames round-trip.

**Unit — `EdgeWorker`:** an unserviceable prompted event emits a terminal frame.

**E2E:** extend the existing park variant in
`containers-mcp-reconnect.e2e.test.ts` with a pre-seeded leaked affinity row.

## Operational remediation

**Stop the running sandbox**, mirroring `stop()` faithfully so the blocked
elicitation survives — `AcaSandboxesProvider.stop()` is `createSnapshot` then
`stopSandbox` (`AcaSandboxesProvider.ts:704-708`), and the wake path depends on
memory state being restored on resume. A bare `aca sandbox stop` skips the
snapshot.

**The stale DB row is deliberately left in place.** The router's SQLite is
ephemeral per replica, so editing it means patching the blob and restarting —
and the outgoing replica flushes its own copy on shutdown, so the edit must land
in a few-second window between that flush and the new replica's restore. Losing
that race silently reverts the edit, and the cost of getting it wrong is a
hand-edited store that every device row depends on. The row is harmless once the
sandbox is stopped (offline device, no compute) and is reclaimed automatically on
the first sweep tick after deploy. The only thing it blocks in the interim is
stale-destroy of one device row.

## Out of scope

- Changing the affinity gate itself. `if (affinity > 0) continue` is correct; the
  set it counts was not.
- Suspending on a heuristic. The router cannot distinguish "session working hard
  for 40 minutes" from "affinity leaked 40 minutes ago", which is why every path
  here either asks the device or does nothing. This is the same reason ACA's
  affinity-unaware `autoSuspendSeconds` remains disabled.
- Making `routePrompted` refuse to route terminal sessions. Re-prompting a
  finished Linear agent session is legitimate and must keep working
  (`EventRouter.ts:699-704`).
- Durable elicitation state surviving a container rebuild — unchanged from the
  park design's decision 3.
