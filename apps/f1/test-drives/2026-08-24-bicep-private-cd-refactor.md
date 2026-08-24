# Test Drive: Bicep private-CD refactor regression check

**Date:** 2026-08-24
**Objective:** Verify the issue-tracker, EdgeWorker, and activity-rendering path
still works after making Azure Bicep secret writes opt-in and adding the private
deployment-repository invocation seam.

## Setup

- Server: `localhost:3600`
- Repository: `/private/tmp/f1-nor299-bicep-cd.hqaOTP/repo`
- Issue: `issue-1` / `DEF-1`
- Session: `session-1`
- Runner: Claude Sonnet 5

The repository was created fresh with `f1 init-test-repo`. The issue asked the
agent to inspect the rate-limiter implementation, report implemented versus TODO
algorithms, and make no file changes.

## Results

### Issue tracker

- [x] `ping` reported healthy and `status` reported ready.
- [x] The issue was created with an identifier and URL.
- [x] Starting the issue created an active agent session.

### EdgeWorker

- [x] The single repository was selected and a dedicated `DEF-1` worktree was
      created from local `main`.
- [x] The agent inspected the repository and completed successfully in 31 runner
      messages.
- [x] The source repository remained clean; the read-only instruction produced
      no file changes.

### Activity renderer

- [x] The final timeline contained 12 activities.
- [x] Thought, skill, Bash, Read, and final response activities were visible.
- [x] The final response was posted as a `response` activity.
- [x] Pagination returned the requested five-activity window and reported the
      total correctly.
- [x] `stop-session` succeeded and the server shut down cleanly on SIGINT.

## Observations

The fresh test repository intentionally has no `origin`, so the handled fetch
and WIP-snapshot lookup warnings appeared before Cyrus fell back to local
`main`. They did not affect the session. No unhandled server error occurred.

This drive is the application-level regression check required by the F1
protocol; the infrastructure behavior was validated separately with a live
`az deployment sub what-if` against `rg-cyrus`, which proposed no Key Vault
secret child-resource writes in steady state.

## Conclusion

The issue lifecycle, isolated worktree creation, runner execution, tool activity
mapping, final response posting, pagination, and graceful shutdown remain
functional after the Bicep deployment refactor.
