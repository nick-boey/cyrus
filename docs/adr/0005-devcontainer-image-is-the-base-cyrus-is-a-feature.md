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
