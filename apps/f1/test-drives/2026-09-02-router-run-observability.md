# F1 Test Drive: Router run observability

**Date**: 2026-09-02
**Goal**: Verify a fresh issue runs end to end and produces the activity and
terminal signals used by router run observations.
**Test Repo**: `/private/tmp/cyrus-runs-f1.gt5SK4/repo`

## Verification Results

### Issue tracker

- [x] Server health and ready status returned
- [x] Issue `DEF-1` created with accessible metadata
- [x] Session `session-1` started

### EdgeWorker

- [x] Isolated worktree created
- [x] Agent wrote the requested `STATUS.md`
- [x] Session completed successfully
- [x] Session stopped cleanly

### Activity stream

- [x] Thought, action, and response activities appeared
- [x] Final response was published before completion
- [x] Pagination returned the requested five-activity page

### Router observation seam

- [x] `GET /runs` bearer authorization and owner/container scoping passed in
  the router integration suite
- [x] Routed input IDs, latest posted activity, worker liveness, sampled
  sandbox state, and exact terminal state passed across the router tests
- [x] `cyrus runs --watch --json` observed a transition and exited successfully
  on completion in the CLI integration suite
- [x] The built CLI reused an ephemeral `cyrus connect`-format config and queried
  a live F1 router over HTTP, returning the routed `F1RUN-1` observation

## Session Log

```text
./f1 ping                                      -> healthy
./f1 status                                    -> ready
./f1 create-issue ...                          -> DEF-1 / issue-1
./f1 start-session --issue-id issue-1          -> session-1 active
./f1 view-session --session-id session-1       -> complete, 15 activities
./f1 view-session ... --limit 5 --offset 10    -> 5 of 15 activities
STATUS.md                                      -> router run observability works
./f1 stop-session --session-id session-1       -> stopped cleanly
node apps/cli/dist/src/app.js ... runs ...      -> routed run JSON from live router
```

The fresh repository intentionally had no remote. The ship subroutine reported
that limitation, while the implementation, final activity, and terminal signal
still completed correctly.

## Final Retrospective

Pass. The live F1 session supplied the real activity/terminal behavior; the
router and CLI integration suites covered the new authenticated observation
path without requiring a public deployment.
