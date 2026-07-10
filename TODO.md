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

**Status:** FIXED. Both parts of the proposed fix landed in `completeSession()`:
the emit moved after `addResultEntry()` (inside a `finally`, so a throw still
releases the lock), and it is skipped entirely while `getRunnerPendingWork()`
reports work in flight — the runner emits on the later result when it actually
closes. Regression coverage:
`packages/edge-worker/test/AgentSessionManager.terminal-signal.test.ts`
(5 of its 7 tests fail against the old ordering).

The "one unverified link" below was confirmed on the router host before patching:
`EventRouter.handleSessionState` calls `releaseIssueLockForSession` **and**
`clearSessionAffinity`, and `createAgentActivity` is in
`SESSION_SCOPED_RPC_METHODS`, so `LinearExecutor.dispatch` rejects it once
affinity is gone. PAR-98's session `85303860` was observed losing its final
result exactly this way: last activity 22:00:56, terminal 'complete' 22:01:35,
zero `Response` activities across all 625.

**Where:** `packages/edge-worker/src/AgentSessionManager.ts`, `completeSession()`.

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

### Proposed fix

In `completeSession()`:

1. Move `emitTerminalOnce()` to **after** the final result is posted.
2. Do not emit terminal at all when `getRunnerPendingWork(sessionId)` reports work
   still in flight — that is already the exact condition checked a few lines below
   for the pending-work thought. Emit when the runner actually closes.

Keep `abortSession()` on the kill path as-is.

### Before patching — one unverified link

The conclusion that the router drops **session affinity** on receiving
`session_state` (rather than the rejection originating elsewhere) was inferred
from the client log plus the edge-worker source. It has not been confirmed against
`RouterStore` / `DeviceGateway` on the router host. 177 consecutive rejections
starting 6ms before PAR-97's first completion make it hard to explain otherwise,
but confirm router-side before writing the patch.

### Regression test

`packages/edge-worker/test/AgentSessionManager.stop-session.test.ts` covers the
kill path. Add coverage for the result path:

- a session whose runner reports pending work emits **no** `sessionTerminal` on
  the first `SDKResultMessage`;
- `sessionTerminal` is emitted only after `addResultEntry()` has resolved.
