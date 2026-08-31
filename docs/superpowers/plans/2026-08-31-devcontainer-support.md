# Devcontainer Support Implementation Plan (NOR-309)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a registered repository declare its own environment via the Dev
Containers standard, so adding a toolchain no longer requires a PR to this
repository and a full worker-image redeploy. Targets the ACA router + sandbox
mode.

**Status:** Design settled over four grilling rounds on NOR-309. Two questions
remain open (see *Open questions*). **Task 0 is a spike that can falsify the
central assumption — do not start Task 1 until it has reported.**

## Why this exists

`docker/worker/Dockerfile` has accreted .NET 10 + PowerShell + the Fleece CLI,
a full Rust toolchain, Playwright's Chromium, `codex`, `opencode` and
`actionlint`, reaching 18.4 GB. Every one of those landed because a repository
needed it and the only route was a commit here plus a redeploy that NOR-295
showed can silently fail to happen for four days. That bottleneck is the target.

**Explicit non-goal: this does not shrink the default worker image.** Per-repo
images *add* to the artifact count, they do not replace the shared one — which
must keep every toolchain, because it is the fallback when a repo's own build
fails (Task 7). Cost reduction is not a success criterion here.

## Decisions already recorded

| Decision | Where |
| --- | --- |
| The repository's devcontainer is the base; Cyrus rides on top as a feature | `docs/adr/0005-devcontainer-image-is-the-base-cyrus-is-a-feature.md` |
| A registered repository is trusted; the builder is what we constrain | `docs/adr/0006-repositories-are-trusted-the-builder-is-constrained.md` |
| Vocabulary: worker image, default worker image, worker feature, disk image, primary repository | `CONTEXT.md` |

## Global constraints

- **Spec subset.** In: `image`, `build.*`, `features`, `containerEnv`. Out, and
  must fail loudly at registration rather than half-work: `dockerComposeFile`
  (a compose devcontainer is N containers; a sandbox is one, with no daemon
  inside it). Silently ignored: `mounts`, `forwardPorts`, `customizations`.
- **Lifecycle commands.** `postCreateCommand` only, at boot after the clone,
  alongside `cyrus-setup.sh` — devcontainer first, then the script, both run.
  `onCreateCommand`/`updateContentCommand` cannot be honoured faithfully (the
  source is cloned at boot, never baked into the image). `postStartCommand` is
  actively wrong: a parked container resumes many times per issue and would
  re-run it every unpark. `postAttachCommand` has no analogue.
- **Cache key** is a content hash of the devcontainer files on the repo's base
  branch. Builds are lazy — first issue for a repo triggers one — with a
  fire-and-forget warm build at registration that must never block or fail
  registration.
- **Reads happen over the GitHub contents API** with the installation token the
  router already mints. No sandbox is needed to decide what the sandbox is, and
  the file is re-read on every issue creation: one API call against a build that
  costs minutes, so there is no TTL and no staleness window.
- **A devcontainer change must not retro-replace live containers.** It applies
  to containers created after it. The existing `cyrus.disk` rule replaces on
  mismatch *and deletes the sandbox's snapshots*, so treating a repo author's
  edit like a worker-image bump would cold-restart every in-flight issue on that
  repo and destroy the warm path that would have made the restore cheap. This
  forces `cyrus.disk` to distinguish "the deployment's image moved" from "this
  repo's devcontainer moved".
- **Disk name budget is 63 characters** (`LABEL_VALUE_MAX`), and the disk name
  *is* the `cyrus.disk` label value — while `REPOSITORY_NAME_RE` permits repo
  names up to 64. The name must therefore be a derived digest, not a readable
  composition, and full identity must be recoverable from a mapping we keep.
- **Disk-image GC** deletes only what nothing references — no container on it,
  no snapshot from it — and never the current image for a repo, nor the default
  worker image's. Slow cadence, well away from the 60s lifecycle sweep, which is
  non-reentrant by contract.
- **Never commit with `--no-verify`.** The pre-commit hook runs `pnpm build` and
  `pnpm typecheck`; both must pass.

## Open questions

1. **Multi-repo environment selection (Q16).** Superseded the earlier "rank on
   the registry entry" proposal. Current direction: build and cache an image per
   repository as normal, and when an issue selects more than one, have the
   router post an elicitation asking which environment to use. Three amendments
   need confirming before this is implementable: the answer must be persisted
   **per issue** (like `issue_repositories`), not re-asked per session; the
   options must include **the default worker image**, which is the only image
   carrying every toolchain and therefore often the right answer for a genuinely
   polyglot issue; and the prompt must state that repositories other than the
   chosen one are cloned into an environment lacking their toolchain.
2. **Devcontainer file precedence (Q17).** The requested order is
   `.devcontainer.json` then `.devcontainer/devcontainer.json`. The spec's
   documented order is the reverse. See *Task 0* — the spike should settle it.

## Task dependency order

Task 0 gates everything. Tasks 1–3 are independent of each other. Task 4
depends on 1–3. Tasks 5–8 depend on 4.

---

### Task 0: Spike — can the default worker image be expressed as a devcontainer?

**This is a falsification exercise, not a build exercise.** ADR 0005 rests on
one assumption: that an arbitrary base image plus a self-contained worker
feature can produce something that boots Cyrus. The current
`docker/worker/Dockerfile` is the hardest available test of that assumption, and
it is a test we can run before writing any product code. If it fails, ADR 0005
needs revisiting *now* rather than after the router, registry, and build
pipeline have been built on top of it.

**Deliverable:** a findings document at
`docs/superpowers/specs/2026-XX-XX-devcontainer-spike-findings.md`, plus the
devcontainer definition itself, whether or not it fully succeeds. A partial
failure with a clear account of what could not be expressed is a successful
spike.

#### Steps

- [ ] Express `docker/worker/Dockerfile` as a devcontainer definition. Record,
      per component, whether it maps to a published Feature, needs a
      `build.dockerfile`, or cannot be expressed:
  - .NET SDK 10 + PowerShell from the Microsoft feed
  - The Fleece CLI, installed to a shared `--tool-path` rather than `-g`
  - Rust via rustup into `/usr/local` with `build-essential`, `pkg-config`,
    `libssl-dev`
  - Playwright + Chromium via `--with-deps` (needs root at build time)
  - `actionlint` from a checksum-verified release tarball
  - `codex` and `opencode` via `npm install -g`
  - The pnpm-deployed `/app` tree and the `cyrus` shim
- [ ] Build it with `devcontainer build` and confirm it produces an image.
- [ ] **Verify the boot contract survives.** The image must enter at
      `/entrypoint.sh` running `container-boot`, as a non-root user owning
      `/workspaces` and `/var/cache/repos`, with `git`, `gh`, `curl`, `jq` and
      `ca-certificates` present.
- [ ] **Answer the non-root question explicitly.** This is the highest-risk
      unknown. The Dockerfile's comments document a series of workarounds for
      `$HOME` being `/root` at build time while the image runs as `cyrus` at
      uid 1001 — the Fleece `--tool-path`, `RUSTUP_HOME`/`CARGO_HOME` under
      `/usr/local`, the `chown` of `/ms-playwright`. Features have their own
      `_REMOTE_USER` conventions. Confirm a feature-installed toolchain is
      actually usable by the non-root user, or document precisely where it
      isn't.
- [ ] **Record size and build duration.** Both feed hard downstream limits: the
      disk-image import has a 900 s ceiling, and image size is what pushed the
      import past what the preview CLI could do at all (NOR-337).
- [ ] Confirm `devcontainer build` runs inside an ACR task, since ADR 0006 puts
      builds there and nowhere else.
- [ ] **Settle open question 2.** Check what the reference implementation
      actually does when both `.devcontainer.json` and
      `.devcontainer/devcontainer.json` exist, and report it against the spec's
      stated precedence.

#### Success criteria

- A built image that boots `container-boot` and reaches the point of cloning a
  repository.
- A per-component table of what mapped cleanly, what needed a Dockerfile, and
  what could not be expressed at all.
- A stated verdict on whether the worker feature can be self-contained.

#### What a failure means

If the worker feature cannot be made self-contained, ADR 0005 is unsound as
written and the fallback is narrower support: honour `features` on top of our
own base and reject `image`/`build.dockerfile`. ADR 0005 already records why
that is a poor outcome — it silently ignores the field most devcontainers use to
say what they are — so this should be treated as a real setback, not a graceful
degradation. Update ADR 0005's status rather than quietly changing course.

---

### Task 1: Devcontainer discovery and the cache key

Read the devcontainer file over the GitHub contents API for a repository's base
branch; compute the content hash that keys the cache. Precedence per open
question 2. Multi-config (`.devcontainer/<folder>/devcontainer.json`) is
unsupported: it exists so a human can choose, and we have nowhere to ask.
Reject `dockerComposeFile` here, at registration, with a clear message.

### Task 2: The worker feature

Package the worker and its runtime as a devcontainer Feature that assumes
nothing of its base. Shape follows Task 0's findings.

### Task 3: Build pipeline

ACR task invocation under a dedicated identity scoped to push to one registry
path (ADR 0006). Bounded log tail plus the task run id on failure — the run id
is the load-bearing part, since it is what makes `az acr task logs` possible.
Never relay the full log: that build ran with unrestricted egress over
repository-controlled content.

### Task 4: Disk-image registration and naming

Derived-digest naming within the 63-character budget, over (repository,
devcontainer content, worker feature version). A queryable repo → disk mapping,
which Task 6's GC also depends on.

### Task 5: `cyrus.disk` staleness split

Teach the label to distinguish a deployment worker-image move (replace) from a
repo devcontainer move (do not replace).

### Task 6: Disk-image garbage collection

Reference-counted against containers and snapshots, on a slow cadence, with the
floor that the current image per repo is never deleted.

### Task 7: Failure and progress surfacing

"Building image…" posted by the router, with the `created` event held exactly as
`pending_repo_selections` already holds it — nothing boots while it waits. Post
terminal states too: a "Building image…" that never visibly resolves is the same
debugging problem as saying nothing. On failure, fall back to the default worker
image and say so on the issue. Warm-build status surfaces on the
`/setup/repositories` row, since a fire-and-forget build's failures are
otherwise invisible by construction and the person who needs to know is an
operator on a web page.

### Task 8: Multi-repo environment selection

Blocked on open question 1.

### Task 9: Documentation and changelog

Document the known gap that an issue editing its own devcontainer gets the base
branch's environment — this was chosen deliberately (per-issue builds multiply
disk imports by issue count) and needs to be written down before someone files
it as a bug.
