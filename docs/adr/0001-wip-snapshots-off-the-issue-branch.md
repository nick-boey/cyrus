---
status: accepted
---

# WIP snapshots live on a hidden ref, not the issue branch

The persistence floor originally published uncommitted work by running
`git add -A && git commit -m "wip: auto-saved by cyrus…"` on the issue branch and
pushing it, every five minutes. Because that is the same branch the agent opens
its pull request from, every PR carried a run of `wip:` commits authored by
`Cyrus WIP` — and when the timer beat the agent to its own commit, the agent
found a clean tree, wrote no commit at all, and the PR's *entire* history became
auto-generated `wip:` commits with no real message. We now capture the same state
as a **WIP snapshot** pushed to `refs/cyrus-wip/<branch>`, leaving the issue
branch written by the agent alone.

## Considered options

**Stop auto-saving.** Rejected: the exposure window widens from five minutes to
the length of a whole session. On the container executor there is no local
persistence at all, and a suspend delivers no `SIGTERM`, so there is no
shutdown hook to substitute a final flush into.

**Squash the `wip:` commits later — during a sweep, or before opening the PR.**
Rejected, and structurally impossible as stated. Squashing N `wip:` commits
yields one commit still titled `wip:` and still authored by `Cyrus WIP`, because
in the swallowed-commit case there is no real commit message anywhere to squash
*into*. The sweep also runs on the router, which has no checkout of the
repository and no protocol frame with which to ask a worker to do it.

**Push to a normal branch such as `refs/heads/cyrus/wip/*`.** Rejected: a real
branch is fetched by default, appears in the branch list, and — decisively —
fires a `push` webhook. Any workflow matching `branches: ['**']` would run
roughly twelve CI builds an hour per issue. Refs outside `refs/heads` fire no
webhooks and trigger no Actions runs.

## Consequences

The capture must not touch `HEAD`, the index, or the worktree. If it advanced the
local branch, the agent's own `git push` would carry every snapshot commit to the
remote and the pull request would be polluted identically. Capture therefore uses
a throwaway index (`GIT_INDEX_FILE` + `read-tree HEAD` + `add -A` + `write-tree` +
`commit-tree`) rather than porcelain. `git stash create` is not a substitute: it
has no `--include-untracked` option — the flag is silently swallowed as the
commit message — so it would drop every new file the agent created.

Snapshots are siblings parented on `HEAD`, never descendants, so each push after
the first is non-fast-forward and must be forced. This is deliberate: the ref
holds a snapshot, not accumulated history, and last-writer-wins is the intent.
`--force-with-lease` would make the floor fail in precisely the situations where
it most needs to succeed.

Restoring applies the snapshot's whole tree, not a patch, so a stale snapshot
could revert pushed work. Restore therefore applies a snapshot only when
`origin/<branch>` is an ancestor of the snapshot's parent, and otherwise takes
the branch clean and reports that WIP was found but not applied. It fails safe
toward work that has been pushed and reviewed.

Two things are deliberately not captured: files matched by `.gitignore`, which
are regenerable and would otherwise push `node_modules` to the remote every five
minutes; and changes inside a submodule's working tree, of which only the gitlink
is recorded.

Custom ref namespaces are accepted by GitHub in practice — every namespace except
the documented read-only `refs/pull/*` — but this is **observed, not
contractual**; no GitHub documentation covers it. Push rulesets are ref-agnostic,
so a repository's file-size or path rules can block a snapshot push. Because the
issue branch is no longer a fallback, a failed snapshot push means the only copy
of the agent's uncommitted work never left the machine, and must be surfaced to a
human rather than logged and swallowed.

Refs are advertised on every clone and fetch repository-wide, so they are deleted
at any terminal state and swept for orphans, rather than retained the way the
floor bundle is. The sweep only ever retries deletions Cyrus recorded and failed
to complete; it does not prune the namespace by inspection, because a snapshot
whose issue branch has never been pushed is indistinguishable from an orphan
from the remote alone, and deleting one would destroy the only copy of another
device's uncommitted work.

That deletion did not actually happen for the first several months this shipped.
Teardown resolved the checkout it reaped from as `<cyrusHome>/worktrees/<ISSUE>`
while creation used the repository's configured `workspaceBaseDir`; the two agree
on a default self-host install and differ on every container sandbox, so the
reaper spawned `git` in a directory that had never existed and gave up. NOR-411
fixed it by reaping from the repository's main checkout — ref deletion is a
remote operation, so any checkout carrying the same `origin` will do, and the
main checkout is the one that outlives teardown and so makes the sweep's retry
retryable at all.

The refs already leaked are **not** cleaned up by that fix, and deliberately are
not cleaned up automatically: the paragraph above is exactly why a namespace
sweep is unsafe. The decision recorded here is that they are removed by hand,
per remote, by an operator who can confirm the issue is closed —
`git ls-remote origin 'refs/cyrus-wip/*'` to enumerate, `git push origin
--delete <ref>` to remove. On `nick-boey/cyrus` the audit at the time of the fix
found 11 such refs, of which 2 belonged to issues still open.

Capture keeps a local `refs/cyrus-wip/<branch>` recording the last snapshot that
actually reached the remote, which is what lets an idle session skip the push
entirely. A consequence is that the ref IS visible to `git log --all` inside
Cyrus's own checkout — on a self-hosted device, the contributor's repository.
That is accepted: it is deleted at terminal teardown, and the guarantee that
matters (a third party's clone fetches neither the ref nor its objects) is
unaffected, since nothing outside `refs/heads` is fetched by default.

The agent-facing effect is that the workspace now stays dirty until the agent
commits. The stop guardrail — which blocks a session ending with uncommitted or
unpushed work — was previously satisfied by the floor's own commit and push, and
so never fired. It now fires as designed.

One further consequence surfaced while implementing this. Restoring a snapshot
meant reworking how a workspace is rebuilt, and that exposed a live data-loss
path sitting inside it: a repository with a commit-ish base branch had worktree
continuity suppressed entirely, because a base override was passed. Since a
session re-passes its original `[repo=name#branch]` selector on *every* workspace
recreation, the override won a second time and rebranched from base, discarding
whatever had already been published. Published work now wins over the override —
the override still decides where the issue branch starts, it just doesn't get to
decide twice.
