# TODO

## Run this host's Cyrus under systemd instead of a detached background process

**Status:** open.
**Where:** this host (`nb-cyrus-runner`), not the codebase.

### Symptom

Cyrus is running as PID 71835 (`node /root/.local/share/pnpm/bin/cyrus start`),
reparented to init with `SID == PID` — it was `setsid`'d away from the shell that
launched it. There is no supervisor: pm2 is not installed, and no systemd unit,
user unit, or supervisor config references Cyrus.

Consequences:

- **No restart on failure.** If the process dies, nothing brings it back, and the
  only symptom is Linear issues silently going unprocessed.
- **No start on boot.**
- **Logs land in `/tmp`.** stdout/stderr point at
  `/tmp/claude-0/-root-cyrus/e4b5321b-.../scratchpad/cyrus-v3.log` — the scratchpad
  of a Claude Code session that has since ended. Nothing rotates it, and a reboot
  or `/tmp` sweep takes the logs with it.

It was started as a background job from an agent session and orphaned when that
session exited.

### Fix

`skills/cyrus-setup-launch/SKILL.md` step 3, "Option 2: systemd (Linux only)",
already has the unit file and the enable/start commands. Two corrections are
needed before that recipe works on this host, and both should be fixed in the
skill so the next host doesn't hit them:

1. `EnvironmentFile=/home/$CYRUS_USER/.cyrus/.env` hardcodes `/home/$USER`. We run
   as root, whose home is `/root`, not `/home/root`. Use `$HOME` (or
   `getent passwd "$CYRUS_USER" | cut -d: -f6`) rather than interpolating
   `/home/`.
2. `ExecStart=$CYRUS_BIN` resolves to the `cyrus` symlink with no subcommand. That
   happens to work — `start` is registered with `isDefault: true` in
   `apps/cli/dist/src/app.js` — but the unit should say `ExecStart=$CYRUS_BIN start`
   explicitly so the behaviour doesn't depend on the default staying put.

Also note `which cyrus` here points at `/root/cyrus/apps/cli/dist/src/app.js`, the
local dev build from this working tree, not the published `cyrus-ai` package. The
unit will pin whatever that symlink resolves to.

Cut over when no sessions are in flight — installing the unit means killing the
current process and any Claude Agent SDK children still working an issue.

## `sessionTerminal` is emitted too early, killing the device's session ownership

**Status:** FIXED. Both the premature emit and a second, previously unrecorded
consequence of it (below) are addressed.
**Where:** `packages/edge-worker/src/AgentSessionManager.ts`, `completeSession()`,
and `packages/router/src/EventRouter.ts`, `routePrompted()`.

### The half this TODO missed: the session also becomes unpromptable

`handleSessionState()` on the router releases the issue lock **and calls
`clearSessionAffinity()`**. `routePrompted()` resolved a prompt through session
affinity *and nothing else*, then `return`ed without posting anything when the
lookup missed. So the premature emit did not merely lose the final result entry —
it permanently severed the session's routing, and every later prompt was dropped
silently, leaving the Linear agent session in "Waiting for Cyrus" forever. Starting
a new session was the only recovery, because `routeCreated()` re-resolves through
the creator.

Confirmed in the router logs: 10 prompts dropped on 2026-07-09, every one for a
session that had earlier logged `reached terminal state ... released lock and
affinity` — including `4c16c133` (PAR-97) dropped at 13:05 and again at 21:48,
hours after it "completed".

The fix therefore has two halves, and both are needed:

1. **Edge worker** — emit `sessionTerminal` last (after every Linear write) and
   only when the runner reports no pending work. Stops sessions being bricked.
   The emit sits in a `finally`, so an unexpected throw still relinquishes the
   lock; pending work is sampled only on `success`, since an errored result ends
   the session regardless and deferring on it would strand the lock.
2. **Router** — give `routePrompted()` the same creator → issue-affinity fallback
   chain `routeCreated()` already has, re-establish affinity on success, and post
   a message instead of dropping when nothing resolves. Rescues sessions already
   bricked, and makes affinity loss (router restart, DB loss, offline sweep)
   recoverable rather than terminal.

Regression coverage: `AgentSessionManager.terminal-signal.test.ts` (5 of 7 fail
against the old ordering), the added cases in
`AgentSessionManager.stop-session.test.ts`, and `EventRouter.test.ts`.

The "one unverified link" below was confirmed on the router host before patching:
`EventRouter.handleSessionState` calls `releaseIssueLockForSession` **and**
`clearSessionAffinity`, and `createAgentActivity` is in
`SESSION_SCOPED_RPC_METHODS`, so `LinearExecutor.dispatch` rejects it once
affinity is gone. PAR-98's session `85303860` was observed losing its final
result exactly this way: last activity 22:00:56, terminal 'complete' 22:01:35,
zero `Response` activities across all 625.

### Symptom

The device logs `RouterRpcError: session not owned by this device` when syncing
activities, and those activities never reach Linear. Observed 181 times on
2026-07-09 across five sessions:

| Issue  | Session    | Errors | Effect |
|--------|------------|--------|--------|
| PAR-97 | `4c16c133` | 177    | ~16 min / 467 messages of work missing from the timeline |
| PAR-99 | `c531d2a8` | 1      | completed 1039 messages successfully; **final result never posted** |
| PAR-95 | `9fbc86be` | 1      | final result entry lost |
| PAR-82 | `123048a4` | 1      | final result entry lost |
| PAR-80 | `ed10abfa` | 1      | final result entry lost |
| PAR-98 | `45227bef` | 0      | never completed — see "inverse mode" below |

### Root cause

`completeSession()` calls `emitTerminalOnce(sessionId, terminalState)` — the event
that makes the router release the issue lock **and session affinity** — *before*
`await this.addResultEntry(sessionId, resultMessage)`. The router drops ownership,
then the device tries to post the final result and is rejected. Hence exactly one
trailing error per normally-completing session.

PAR-97 is the same bug amplified. It emitted **3 result messages from a single
runner** (one `session_started`, one `claude_session_id_assigned`) and logged
`Posted pending-work thought` twice. As the comment in `completeSession()` itself
notes, when a turn ends with background work in flight "the runner holds its
session open and the wakeup will stream new messages in later" — so an
`SDKResultMessage` is only **turn**-terminal, not **session**-terminal. The code
treats it as session-terminal anyway. The first result released the lock at
05:40:22; the runner streamed 467 more messages over the next 16 minutes, every
one of them rejected.

Evidence of the ordering, from the client log — the sync is rejected 6ms *before*
the completion line is even written:

```
05:40:22.757 [ERROR] {session=4c16c133, issue=PAR-97} Failed to sync entry ... not owned by this device
05:40:22.763 [INFO ] {session=4c16c133, issue=PAR-97} Session completed (subtype: success)
```

### Why `bbc0c33` does not fix it (and slightly entrenches it)

`bbc0c33` added `emitTerminalOnce` + `abortSession()` to fix the **inverse** mode:
a session *killed* without the SDK yielding a result never emitted a terminal
state at all, so its lock leaked forever. That is PAR-98 / issue
`3b0b8641-0cc8-4f39-9c9b-009c6677a5e5`, whose lock is still held and needs
`cyrus router unlock`.

The `terminalEmittedSessions` guard makes the emit exactly-once, so PAR-97's 2nd
and 3rd results no longer re-emit — but **the first emit is the premature one**,
and its ordering relative to `addResultEntry()` is unchanged. On v2 we should
still expect (a) every session to lose its final result entry, and (b) any session
with pending background work to go ownership-dead for the rest of its run.

So the terminal signal has two opposite bugs: fired *never* on the kill path
(fixed), and fired *too early* on the result path (open).

### Fix as applied

In `completeSession()`:

1. `emitTerminalOnce()` moved to **after** the final result is posted (and after
   the pending-work thought and any parent-session resume — every write needs
   ownership, not just the result entry).
2. No terminal emit at all when `getRunnerPendingWork(sessionId)` reports work
   still in flight. The wakeup's own result lands back in `completeSession()` with
   no pending work and emits then; a session killed before that reaches
   `abortSession()`, which emits instead — so the lock still cannot leak.

`abortSession()` on the kill path is unchanged.

In `routePrompted()`: resolve through the shared `resolveTarget()` chain (session
affinity → creator's enrolled device → issue affinity → parent-issue affinity),
write the affinity back on success, and post `PROMPT_UNROUTABLE_MESSAGE` when
nothing resolves.

### The unverified link, now verified

The TODO flagged one inference to confirm before patching: that the router drops
**session affinity** on receiving `session_state`, rather than the rejection
originating elsewhere. Confirmed router-side — `EventRouter.handleSessionState()`
calls `store.releaseIssueLockForSession()` *and* `store.clearSessionAffinity()`,
and `RouterStore.clearSessionAffinity()` deletes the row outright.

### Regression tests

`packages/edge-worker/test/AgentSessionManager.stop-session.test.ts`:

- `sessionTerminal` is emitted only after the final result has been posted;
- a runner reporting pending work emits **no** `sessionTerminal` on the first
  `SDKResultMessage`;
- it *is* emitted on the follow-up turn once pending work has drained.

`packages/router/test/EventRouter.test.ts`:

- a prompt whose affinity was released by a terminal state still routes, and
  affinity is re-established;
- an unroutable prompt notifies the user instead of being dropped silently.

All five fail against the pre-fix code.
