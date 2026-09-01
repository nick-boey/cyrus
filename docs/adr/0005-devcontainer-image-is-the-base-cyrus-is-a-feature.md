---
status: accepted
---

# A repository's devcontainer image is the base; Cyrus rides on top as a feature

NOR-309 lets a repository declare its own environment via the Dev Containers
standard instead of getting one toolchain image shared by every repository.
Something then has to reconcile two claims on the same container: the repository
says what the environment is, and Cyrus's worker has to be the thing that boots
in it.

**We build the repository's devcontainer as the base and add Cyrus on top as a
devcontainer Feature, rather than keeping our own image as the base and applying
the repository's declarations to it.**

## Why not the other way round

Keeping the default worker image as the base is the smaller change and the
obvious one, so it is worth recording why it loses. It can only honour the
`features` section of a devcontainer. It cannot honour `image` or
`build.dockerfile`, which is what most real devcontainers actually use to say
what they are — a repository pinning a specific .NET or Rust base would find
that its central declaration was the one thing ignored. That is not "supporting
devcontainers"; it is supporting a corner of the file while appearing to support
the standard, which is worse than not supporting it, because the failure is
silent and looks like a bug in the repository's own config.

Inverting it costs us the guarantee that the base is one we built. That is the
real trade, and it is what makes this hard to reverse: every constraint below
follows from it.

## What that forces

**The worker feature must be self-contained.** Once the base is arbitrary, we
cannot assume Node, a package manager, a distro family, or a libc. The feature
brings its own runtime. Skipping this appears to work — the common bases are
Debian and often ship Node — and then fails on the first Alpine or Fedora repo
with an error that points anywhere but here. This is the single constraint most
likely to be quietly dropped during implementation, and it should not be.

**The boot contract becomes an interface, not an implementation detail.** The
container is entered at `/entrypoint.sh` running `container-boot`, as a
non-root user owning the workspaces and repository-cache paths, with `git`, `gh`,
`curl` and `jq` present. Today all of that is guaranteed by the fact that we
wrote the Dockerfile. Under this decision the feature has to establish it on a
base that knows nothing about Cyrus.

**We use the standard's own composition mechanism.** A Feature is how the Dev
Containers spec already expresses "add this capability to any image." The
alternative — appending our own final stage to the repository's Dockerfile —
means maintaining bespoke grafting logic against every shape a base can take,
and it does not compose with the features the repository itself declares.

## Consequences worth naming

`dockerComposeFile` devcontainers cannot be supported at all: a compose
devcontainer is several containers with a network between them, and a sandbox is
one container with no daemon inside it. This must fail loudly when a repository
is registered rather than half-work.

Lifecycle commands are not resolved by this decision. The repository's source is
cloned into the workspace at boot, not baked into the image, so any devcontainer
command that expects to see the source cannot run at build time. Which commands
we honour, and where they sit relative to the existing `cyrus-setup.sh` hook, is
a separate decision.

## Amendment: two instructions the feature cannot contribute

The Task 0 spike
(`docs/spikes/2026-09-01-nor-309-devcontainer-spike.md`) upheld this decision but
found that "the boot contract becomes an interface the feature establishes" is
too strong. A Feature contributes `RUN` layers only, and two clauses of the
contract are outside that:

- **`USER`.** The devcontainer CLI's generated Dockerfile ends with
  `USER $_DEV_CONTAINERS_IMAGE_USER`, and that build arg is bound to the *base
  image's* user — never to `containerUser`. `containerUser`/`remoteUser` become
  a `devcontainer.metadata` label that only the devcontainer CLI reads when it
  execs into a container. ACA does not read it.
- **`ENTRYPOINT`.** The CLI never emits one, so the built image inherits the
  base's.

Both are applied by the build pipeline as a uniform two-instruction stage over
the built image. That stage does not vary with the shape of the repository's
base, so it is not the bespoke grafting rejected above — it grafts onto the
built image, not into the repository's Dockerfile. It must assert that the
feature actually ran: otherwise a missing worker feature yields an image that
builds cleanly and presents as a sandbox stuck `Running` with no worker
attached.

A second consequence of "assumes nothing of its base": the worker's Node runtime
must be installed **off `PATH`**. The agent runs the repository's own builds, so
the Node the repository pinned must be the one its sessions see; a worker Node
shadowing it makes a version mismatch look like a bug in the repository.
