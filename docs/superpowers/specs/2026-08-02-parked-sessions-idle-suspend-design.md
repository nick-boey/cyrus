# Parked Sessions and 5-Minute Idle Suspend

**Date:** 2026-08-02
**Status:** Design (approved in brainstorming; pending spec review)

## Goal

Suspend an ACA sandbox that has been idle for more than 5 minutes, including
when its agent is blocked waiting for a user's answer — without ever
suspending a sandbox that still has work in flight.

## Background — why this exists

On 2026-08-01 the sandbox for PAR-146 (`7a35b4ff`, device 10) was created at
12:09:07Z and was still `Running` at 12:50Z — 41 minutes, at 4 vCPU / 8 GiB —
having done nothing since 12:14:05Z, when the agent posted an elicitation
asking the user to pick an option. It would have stayed up indefinitely.

Two idle controllers exist, and neither fires in this state.

**ACA-side auto-suspend is deliberately disabled.** The deployed
`CYRUS_ROUTER_CONTAINERS_JSON` sets `autoSuspendSeconds: 0`, and the sandbox
reflects it (`autoSuspendPolicy.enabled: false`). This is intentional and must
stay: ACA's auto-suspend has no session-affinity gate, so it would freeze a
live session mid-task. See `AcaSandboxesProvider.ts:110`.

**The router's idle-stop is gated on session affinity.**
`ContainerLifecycle.sweep()` runs every 60s but opens with
`ContainerLifecycle.ts:88`:

```ts
const affinity = this.store.countSessionAffinityForDevice(row.deviceId);
if (affinity > 0) continue;   // never stopped, never destroyed
```

Affinity is released only by a terminal `session_state` frame
(`EventRouter.handleSessionState`, `EventRouter.ts:351`). And an elicitation
blocks *inside* the turn: `AskUserQuestionHandler.ts:193` returns a bare
`new Promise(...)` that settles only on the user's reply or a session abort.
There is no timeout on it, and `maxTurns` does not advance while blocked. So
the SDK query never returns, `completeSession` never runs, no terminal frame
is ever sent, and affinity is held forever.

The router log for PAR-146 confirms this: the session was routed at 12:09:05
and no "reached terminal state … released lock and affinity" line ever
followed. By contrast PAR-166's sandbox is `Stopped` with a snapshot
(`stoppedAt: 2026-07-31T22:58:32Z`), so the idle-stop path itself works —
elicitation-blocked sessions are simply exempt from it.

### What already works and must not be rebuilt

Cyrus already tracks background work. `ClaudeRunner` records the SDK Stop
hook's `session_crons` and `background_tasks` (`ClaudeRunner.ts:1049`) and
exposes `hasPendingWork()`; `AgentSessionManager` already *defers the terminal
signal* while pending work exists (`AgentSessionManager.ts:515`). A turn that
ends with a background build running therefore already holds affinity and is
already protected from idle-stop.

That predicate has one blind spot relevant here: it is populated only by the
Stop hook and reset at query start (`ClaudeRunner.ts:468`), so **mid-turn it
is always empty**. A turn that launches a background task and then blocks on
an elicitation reports no pending work at all.

## Decisions taken in brainstorming

1. **Driver is compute cost**, not a sandbox concurrency quota. Memory-mode
   suspend (the existing `stop()` — snapshot then suspend, ~1s warm resume)
   fully addresses it. No destroy path is needed.
2. **Never suspend if any pending work exists.** The conservative rule. A
   session that asks a question while a long build runs will *not* suspend; it
   holds affinity until the build finishes and the turn goes terminal. This is
   a deliberate cost/safety trade: that combination stays expensive.
3. **A lost elicitation on container recreate is accepted and logged**, not
   made durable. This is pre-existing behaviour — any recreate while blocked
   already loses the promise — and resume, not recreate, is the overwhelmingly
   common path.
4. **Overload `session_state` rather than add a new frame type**, accepting a
   non-terminal value in a type whose name says terminal, in exchange for the
   durability machinery.
5. **Tightening `hasPendingWork()` is accepted collateral.** It will make some
   turns hold open longer than they do today.

## Architecture

One new concept: a session can be **parked** — non-terminal, but not occupying
its device.

The split of responsibility is the load-bearing idea:

- The **worker** decides *"am I safe to suspend?"*. It alone knows whether it
  is blocked on an elicitation and whether background tasks are live.
- The **router** decides *"how long is too long?"*. It already owns
  `idleStopMs` and the 60s sweep.

The affinity gate is untouched. The invariant "a device with a live session is
never yanked out from under it" still holds — this changes what counts as a
live session, not the strength of the gate.

## Protocol change

`sessionStateFrame.state` (`packages/router-protocol/src/frames.ts:81`) gains
`"parked"`:

```ts
state: z.enum(["complete", "error", "stopped", "parked"]),
```

Reusing this frame buys three properties the park signal genuinely needs:
it is persisted before transmit, replayed on every reconnect until acked, and
compacted per-session so a newer frame supersedes an older unacked one
(`RouterConnection.ts:798`). That last property is what makes a later
`complete` correctly replace a still-unacked `parked`.

`PROTOCOL_VERSION` is **not** bumped. The change is additive from the router's
side, and an old worker simply never sends the new value — bumping would
instead reject old workers outright.

### Deploy ordering is load-bearing

The router must be deployed **before** the worker image. An old router's
`deviceFrame` discriminated union would fail to parse `parked` and drop the
device connection. A worker image bump already forces sandbox replacement via
the `cyrus.disk` label, so correct ordering falls out of the normal rollout —
but it must be stated in the runbook rather than left implicit.

## Worker changes

### Live background-task tracking (`ClaudeRunner`)

The SDK emits `SDKBackgroundTasksChangedMessage` (`system` /
`background_tasks_changed`) whenever background-task membership changes —
start, completion, kill, or a foreground agent being backgrounded. It is a
**level** signal carrying the full live set, and the SDK's own contract says
consumers that only need "is background work running?" should replace their
set with each payload rather than pairing start/stop edges, so a missed
bookend cannot wedge a stale indicator.

- Add `private liveBackgroundTasks = new Map<string, { task_type: string;
  description: string }>()`, keyed by the payload's `task_id`. Note this is
  the `background_tasks_changed` payload shape, which is narrower than the
  Stop hook's `BackgroundTaskSummary` — the two sources stay separate fields
  rather than being coerced into one type.
- In the message loop (`ClaudeRunner.ts` ~820), branch on the message and
  **replace the map wholesale**. Do not merge.
- Clear it in the query-start reset block (`ClaudeRunner.ts:468`). The SDK
  emits nothing at startup and the level is per-CLI-process, so a stale set
  carried across a restart would wrongly block suspends forever.
- `hasPendingWork()` becomes
  `crons.length > 0 || stopHookTasks.length > 0 || liveBackgroundTasks.size > 0`.
- `getPendingWork()` returns the live set alongside the existing fields so
  `PendingWorkFormatter` can surface it.

This also tightens the existing terminal-deferral at `ClaudeRunner.ts:842`:
turns will now be held open for background tasks the Stop hook missed. That is
a behaviour change to a currently-working path and requires its own coverage,
not just coverage of the new code.

### Park and unpark (`AgentSessionManager` + `EdgeWorker`)

- `AgentSessionManager` gains `sessionParked` and `sessionUnparked` events,
  mirroring the existing `sessionTerminal` emit (`AgentSessionManager.ts:616`).
- `EdgeWorker.createAskUserQuestionCallback` (`EdgeWorker.ts:7129`) wraps the
  handler await: emit `sessionParked` before awaiting **only if**
  `!runner.hasPendingWork()`; emit `sessionUnparked` in a `finally`.
- The repository-selection elicitation (`EdgeWorker.ts:5611`) gets the same
  wrap. It is the same "blocked on the user" category and has the same bug.
- New listeners alongside the existing ones at `EdgeWorker.ts:554`:
  - `sessionParked` → `routerConnection?.sendSessionState(sessionId, "parked")`
  - `sessionUnparked` → `routerConnection?.discardBufferedSessionState(sessionId)`

The unpark discard matters. Terminal frames are durable precisely because
losing one strands an issue lock, but that durability cuts the other way once
a session resumes: replaying a stale `parked` on a later reconnect would clear
the affinity a live turn is posting under. This is exactly the hazard the
existing `sessionResumed` listener already guards (`EdgeWorker.ts:538`), and
the same remedy applies.

Both listeners are guarded by `platform === "router"` and are non-fatal on
error. A failed park is a missed cost saving, not a correctness failure — the
container simply stays up.

## Router changes

### `EventRouter.handleSessionState` (`EventRouter.ts:351`)

Splits into two branches. Terminal states (`complete` / `error` / `stopped`)
behave exactly as today. `parked` does strictly less:

- `clearSessionAffinity(sessionId)` — the only thing that unblocks the sweep.
- **Keeps the issue lock.** A parked session still owns its issue; releasing
  the lock would let a different session claim it mid-conversation.
- **Keeps** `notifiedSessions` and `sessionWorkspace`, and leaves the session
  non-terminal.
- Stamps `parkedAtMs` on the container device row.

### `RouterStore`

Nullable `parked_at_ms` on the container device row, cleared whenever
`setSessionAffinity` re-establishes affinity.

### `ContainerLifecycle.sweep` (`ContainerLifecycle.ts:108`)

The idle clock becomes `max(lastRoutedMs ?? 0, parkedAtMs ?? 0, createdMs)`.

Without the `parkedAtMs` term the clock stays `lastRoutedMs`, so an agent that
works for 20 minutes and *then* asks a question would be suspended on the very
next sweep tick — the clock having expired while it was legitimately busy.
The existing diagnostic log line should print `parkedAtMs` alongside the other
inputs so a suspend that looks wrong stays diagnosable from one line.

### Configuration

`DEFAULT_IDLE_STOP_MS` (`RouterServer.ts:63`) drops from 900_000 to 300_000,
and `idleStopMs` is set explicitly in `CYRUS_ROUTER_CONTAINERS_JSON` rather
than left to the default.

## Wake path

Unchanged, and already exercised. The user replies → prompted webhook →
`resolveTarget` finds no affinity and falls through to the creator's container
device, which resolves to the same device row → `ensureRunning` sees a
`Suspended` sandbox and calls `resumeSandbox` → memory state is restored, so
the in-memory `pendingQuestions` map is intact → the worker reconnects →
`EventRouter` re-establishes affinity (`EventRouter.ts:702`) and clears
`parked_at_ms` → the event is delivered → `EdgeWorker` Branch 2.5 finds the
pending question and resolves the promise → the turn continues.

## Error handling and edge cases

| Case | Behaviour |
|---|---|
| Park frame lost in flight | Container stays up; frame replays on reconnect until acked |
| Stale `parked` replayed after resume | Dropped by `discardBufferedSessionState` on unpark |
| Sandbox recreated instead of resumed | Pending promise lost; prompted event falls through to Branch 3 leaving a dangling `tool_use`. Accepted per decision 3 — log loudly |
| Device hosts multiple sessions | One parks, another still active → affinity > 0 → sweep skips. Falls out of the existing gate with no extra logic |
| Background task completes while parked | Cannot occur: we only park when the live set is empty |
| Cron/ScheduleWakeup fires while parked | Cannot occur: `hasPendingWork()` covers crons, so a session with a pending timer never parks |
| Old worker, new router | Never sends `parked`; behaves exactly as today |
| Router restarts while a session is parked | `parked_at_ms` is in the SQLite store and restored from the blob backup |
| Session parked beyond 48h | `sweepExpired` releases the issue lock and posts the courtesy message — existing behaviour, unchanged |

## Testing

**Unit — `ClaudeRunner`:** `background_tasks_changed` replaces (not merges)
the live set; the set clears on query start; `hasPendingWork()` reflects live
tasks; the terminal-deferral at `:842` now holds for a live task the Stop hook
never reported.

**Unit — `EdgeWorker`:** park is emitted only when no pending work exists;
unpark is emitted even when the handler throws (the `finally`); the
repository-selection path behaves identically.

**Unit — `EventRouter`:** `parked` clears affinity, retains the issue lock,
leaves the session non-terminal, and stamps the clock; the terminal path is
byte-for-byte unchanged.

**Unit — `ContainerLifecycle`:** with an injected clock, a parked device is
stopped 5 minutes after `parkedAtMs` rather than after `lastRoutedMs`; a
device with affinity is never stopped regardless of timestamps.

**E2E:** `containers-mcp-reconnect.e2e.test.ts` already drives boot → deliver
`created` → idle → real `ContainerLifecycle.sweep()` idle-stop → reconnect →
MCP call over the restored socket. Add an elicitation-park variant to the same
rig: block on a question → park → sweep suspends → prompted event → resume →
pending question resolves and the turn completes.

## Out of scope

- Any destroy-on-idle path. Decision 1 settled on suspend.
- Durable elicitation state surviving a container rebuild (decision 3).
- Changing ACA's `autoSuspendSeconds` away from 0. The affinity-unaware
  auto-suspend remains the wrong tool.
- Revisiting the 48h `eventTtlMs` lock-reclaim behaviour.
