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

**Agent session**:
The conversation thread through which Cyrus works an issue. It can contain
several agent runs and become active again after a run ends.
_Avoid_: run, agent

**Agent run**:
A continuous episode of work within an agent session. Prompts received while it
is active join the same run; it moves from routed to active, may wait when it
cannot progress, and ends as complete, error, stopped, or unknown.
_Avoid_: session, turn

**Waiting run**:
A non-terminal agent run that cannot currently progress until a stated condition
changes. Its wait reason and the time it began waiting are observable facts;
waiting alone is not evidence that the run has failed or stalled.
_Avoid_: parked run, paused runner, stalled run

**Elicitation**:
A user decision or answer that an agent run has explicitly requested before it
can continue. It is a wait reason, not an executor state.
_Avoid_: pause, park, generic prompt

**Unknown run**:
An agent run whose ownership ended without Cyrus receiving a terminal outcome.
It is not evidence that the run failed or succeeded.
_Avoid_: failed run, stopped run

**Issue branch**:
The branch named for an issue, which an issue's pull request is opened from. It
is written by the agent and by nobody else — Cyrus's own machinery never commits
to it.
_Avoid_: feature branch, working branch

**Workspace**:
The isolated checkout an agent works in for a single issue. May contain more than
one repository.
_Avoid_: worktree (that's the git mechanism, not the concept), sandbox

**Primary repository**:
The one repository among an issue's several that gets to decide things only one
repository can decide — chiefly which environment the agent works in. Chosen
deliberately when a repository is registered, never inferred from the order the
router happened to return them in.

**Subroutine**:
A named stage in an agent's run for an issue — implementing, verifying, shipping,
summarizing. A procedure is an ordered sequence of them.

**Agent activity**:
A progress update, action, question, or response successfully published from an
agent run to its issue's session timeline.
_Avoid_: message, heartbeat, log

**Run observation**:
The router's durable facts about an agent run: its routing-time context, inputs,
lifecycle and waiting state, latest published agent activity, worker liveness,
and last sampled executor state. It reports evidence, not a healthy/stalled
verdict.

**Run observation change**:
A durable record that a material fact in a run observation changed. It carries
no prompt or activity content and is distinct from an agent activity or log
record.
_Avoid_: agent activity, log event, heartbeat

**Router connection**:
A named relationship between a Cyrus CLI and a router, including how that CLI
authenticates and which workspaces and capabilities the router advertises. One
connection may serve several workspaces.
_Avoid_: endpoint, environment, command profile

**Command profile**:
The set of commands a Cyrus CLI presents for a particular role. It limits the
visible product surface but grants no authority; the router still authorizes
every remote operation.
_Avoid_: permission, role, security profile

**Fleet operator**:
A human or orchestrating agent authorized to observe agent runs across users and
request guarded recovery through a router. It is a principal role, not a runner,
executor, or device.
_Avoid_: runner, device, administrator

**Log source**:
The configured system in which a router's and its devices' log records can be
searched. A router connection advertises how to locate it; the querying client
authenticates to it independently.
_Avoid_: log stream, telemetry sink

**Run recovery**:
A router-owned reconciliation of a non-terminal agent run whose ownership,
worker, or executor evidence no longer agrees. It may restore execution or
release ownership proven stale, but it does not answer an elicitation or
forcibly end live work.
_Avoid_: unlock, restart, retry, unstick

**Recovery operation**:
The durable record of one run-recovery attempt, including its target, progress,
actor, and outcome. Retrying the same request joins the same operation rather
than starting competing recovery work.
_Avoid_: agent run, job, session

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
resumes on the next prompt. Distinct from a waiting run and from teardown, which
ends the issue.
_Avoid_: wait, pause, suspend, sleep

**Terminal teardown**:
The end of an issue's life — the workspace is removed, the container destroyed,
and the issue's held resources released. Triggered by an issue reaching a
completed, canceled, or deleted state.

**Credential rotation**:
A user replacing one of the credentials their containers run with. A rotation
takes effect by replacing the container, never by updating a running one.
_Avoid_: token refresh, re-auth

**Worker image**:
What a container boots from: the agent CLIs, the language toolchains, and
Cyrus's own worker, together in one artifact. A repository that declares its own
environment gets its own; every other repository gets the default one.
_Avoid_: base image, sandbox image, container image (ambiguous — see *Disk
image*)

**Default worker image**:
The worker image used by a repository that declares no environment of its own,
and the one a container falls back to when a repository's own image cannot be
built. It carries a toolchain for every language Cyrus has been asked to work
in, which is why it is large and why it keeps growing.
_Avoid_: base worker image, fallback image

**Worker feature**:
What makes an arbitrary image able to host a Cyrus agent — the worker and
everything it needs to run, packaged so that an image can carry it without
being built for Cyrus. Self-contained by requirement: it assumes nothing of the
image it is added to.

**Disk image**:
Azure Container Apps' registration of a worker image, and the thing a sandbox
is actually created from. Registering one is a separate, slow, and separately
named act from publishing the worker image it points at, which is why the two
are distinguished at all. Same confinement as *Sandbox*: Azure-API-facing code
and docs only — elsewhere the concept is the worker image.

**Stale container**:
A container built from inputs that have since been superseded — an older worker
image, or credentials the user has since rotated. A stale container is replaced
rather than reused; replacement is safe because the persistence floor holds the
work.
_Avoid_: outdated container, dirty container
