# Test Drive: NOR-368 — leading `/skill` in a Linear comment

**Date**: 2026-08-31
**Goal**: Verify a leading `/<skill>` in a comment is echoed onto line 1 of the assembled prompt so the agent SDK expands it, including for skills marked `disable-model-invocation: true`.
**Test Repo**: `/tmp/f1-nor368-1788144221` (rate-limiter scaffold + a committed `f1probe` skill)
**Branch**: `nboey/nor-368-slash-command-in-linear-comments` — PR [#42](https://github.com/nick-boey/cyrus/pull/42)

The probe skill sets `disable-model-invocation: true` and replies with the token
`F1PROBE_RAN_NOR368` plus the most distinctive token of anything sent alongside
it — so one response proves both that the skill ran and that the wrapped comment
survived the prefix.

## Verification Results

### Issue-Tracker
- [x] Issue created (`issue-1`/`DEF-1`, `issue-2`/`DEF-2`)
- [x] Issue ID returned
- [x] Issue metadata accessible

### EdgeWorker
- [x] Session started
- [x] Worktree created — `worktrees/DEF-2`, with `.claude/skills/f1probe` present
- [x] Activities tracked (thought / prompt / response)
- [x] Agent processed issue

### Renderer
- [x] Activity format correct — types, timestamps, readable content
- [x] The `prompt` activity shows the comment verbatim
- [x] Pagination works

## Session Log

### Run 1 — negative, and it found a bug

`.claude/skills/f1probe` was created but left **untracked**, so the worktree
never received it.

```
prompt    @cyrus1 /f1probe the marker is ZEBRAFISH_7731
response  Unknown command: /f1probe
```

The prefix was applied and telemetry fired, but the SDK rejected the command —
and critically **the rest of the prompt never reached the model**. The comment
was swallowed.

This contradicted the implementation's own comment, which claimed unknown
commands "are left to the model as plain text, exactly as today". They are not.
A user opening a comment with any `/word` Cyrus does not own — `/deploy the app`
— would have had their message silently discarded. A regression introduced by
this very change, invisible to the unit tests, and found only here.

### Run 2 — positive, after committing the skill

```
prompt    @cyrus1 /f1probe the marker is ZEBRAFISH_7731
response  F1PROBE_RAN_NOR368 ZEBRAFISH_7731
```

```
[event:skill.slash_invoked] {"cyrus.skill":"f1probe","cyrus.prompt_type":"continuation",
                             "cyrus.issue_key":"DEF-2","cyrus.new_session":false,
                             "cyrus.streaming":false}
```

A `disable-model-invocation: true` skill invoked from a comment, with
`ZEBRAFISH_7731` quoted back — confirming in the real pipeline that this is a
prefix and not a rewrite.

### Fix

`prefixSlashCommand` now checks the command against
`SkillsPluginResolver.discoverSkillNames` — the same list handed to the SDK as
the `skills` allowlist, so it cannot drift from what is installed. It fails
**open**: on a discovery error the comment is left as prose, because losing a
slash invocation is far cheaper than losing the comment.

### Run 3 — both paths, with the fix built

Unknown command, previously fatal:

```
prompt    @cyrus1 /deploy the app to staging and tell me the marker WOMBAT_4412
response  I won't be doing that — this is a probe session with explicit...
```

The model read and answered the comment. No `skill.slash_invoked` event was
emitted (grep count: 0).

Known skill, same session:

```
prompt    @cyrus1 /f1probe the marker is ZEBRAFISH_7731
response  F1PROBE_RAN_NOR368 ZEBRAFISH_7731
```

Still works, and the event still fires.

## Result: PASS (after one fix)

| Criterion | |
| -- | -- |
| Server starts | ✓ |
| Issue created | ✓ |
| Session starts, activities appear | ✓ |
| Activity payloads coherent | ✓ |
| Session stops cleanly | ✓ |
| No unhandled errors | ✓ |

## Final Retrospective

**What worked.** The probe-skill technique — a skill whose entire job is to emit
a token and echo its context — collapsed two questions into one observable
response, and made the negative run unambiguous rather than a judgement call
about whether the model "seemed to" use the skill.

**What the drive caught that unit tests could not.** The unknown-command
failure mode is invisible to prompt-assembly tests: they assert on the prompt
Cyrus *builds*, and the prompt was built correctly. The damage happens one layer
down, inside the SDK, where an unrecognised command aborts the turn. Only an
end-to-end run reaches that layer. This is a concrete case for the CLAUDE.md
mandate rather than a formality.

**Process note.** Run 1's failure was initially misread as a product bug when it
was two things at once: a test-setup mistake (untracked skill) *and* a genuine
regression. Committing the fixture separated them. Worth resisting the urge to
fix the first explanation that fits.

**Recommendation.** Merge. Consider a follow-up so `discoverSkillNames` results
are cached per session — the check now runs an extra filesystem walk per
prompt. It is cheap and already done once per session for the runner config, so
this is tidiness, not a performance problem.
