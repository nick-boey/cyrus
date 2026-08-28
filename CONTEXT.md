# Cyrus

Cyrus runs coding agents against issues tracked in an issue tracker, giving each
issue an isolated workspace and posting the agent's work back to the issue as it
happens. This glossary fixes the vocabulary for the concepts that are specific to
Cyrus — not for general programming ideas that happen to appear in the codebase.

## Language

### Work and workspaces

**Issue**:
The unit of work Cyrus acts on. One issue maps to one workspace, one branch, and
one conversation thread.
_Avoid_: ticket, task, card

**Issue branch**:
The branch named for an issue, which an issue's pull request is opened from. It
is written by the agent and by nobody else — Cyrus's own machinery never commits
to it.
_Avoid_: feature branch, working branch

**Workspace**:
The isolated checkout an agent works in for a single issue. May contain more than
one repository.
_Avoid_: worktree (that's the git mechanism, not the concept), sandbox

**Subroutine**:
A named stage in an agent's run for an issue — implementing, verifying, shipping,
summarizing. A procedure is an ordered sequence of them.

### Persistence

**Persistence floor**:
The durability guarantee that holds for every executor: an issue's work survives
the loss of the machine it was running on. Named a *floor* because faster
native persistence may sit on top of it, but never below.
_Avoid_: backup, sync

**WIP snapshot**:
A point-in-time capture of everything in a workspace that isn't yet on the issue
branch — uncommitted edits, deletions, new files, and any commits the agent has
made but not pushed. Restoring one reproduces the workspace exactly as the agent
left it, still uncommitted.
_Avoid_: WIP commit, auto-commit, auto-save, checkpoint

**Floor bundle**:
The archive of an issue's agent transcripts and session state, held by the
router. It contains **no git data** — the WIP snapshot and the issue branch carry
all of that.
_Avoid_: git bundle, artifact, state dump

**Worktree continuity**:
Rebuilding a workspace from what was published for that issue rather than from
the repository's base branch, so a session picks up where the last one stopped.
There is no live sync between machines; publishing is the handoff.

### Execution

**Executor**:
The kind of machine an issue's agent runs on — a contributor's own device, or an
ephemeral container. Which executor is used changes nothing about the persistence
floor.

**Runner**:
The coding agent an issue's work is done by — Claude Code, Codex, Gemini, or
Cursor. Orthogonal to the executor: the runner is *what* works the issue, the
executor is *where* it runs.
_Avoid_: agent, harness, backend, provider (a provider implements an executor)

**Model**:
The specific model a runner drives, such as `opus` or `gpt-5.5`. Every model
belongs to exactly one runner, so naming a model can name the runner by
implication.
_Avoid_: LLM

**Sandbox**:
Azure Container Apps' own name for a container. Confined to code and docs facing
the Azure API — the concept is a *container* everywhere else, including in
conversation about it.

**Device**:
An enrolled machine authorised to receive one user's sessions. A container gets
its own device identity, distinct from the person's physical device.

**Router**:
The single service that owns the workspace-wide integration credentials, decides
which repository an issue belongs to, and brokers work out to devices. Devices
never hold workspace-wide credentials.

**Park**:
Stopping an idle container without ending the work — the issue stays live and
resumes on the next prompt. Distinct from teardown, which ends the issue.
_Avoid_: pause, suspend, sleep

**Terminal teardown**:
The end of an issue's life — the workspace is removed, the container destroyed,
and the issue's held resources released. Triggered by an issue reaching a
completed, canceled, or deleted state.

**Credential rotation**:
A user replacing one of the credentials their containers run with. A rotation
takes effect by replacing the container, never by updating a running one.
_Avoid_: token refresh, re-auth

**Stale container**:
A container built from inputs that have since been superseded — an older worker
image, or credentials the user has since rotated. A stale container is replaced
rather than reused; replacement is safe because the persistence floor holds the
work.
_Avoid_: outdated container, dirty container
