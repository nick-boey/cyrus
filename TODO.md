# TODO

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
