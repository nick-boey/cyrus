---
status: accepted
---

# A registered repository is trusted to define its environment; the builder is what we constrain

Under NOR-309 a repository's own devcontainer decides what its container is
built from. That is repository-controlled content — an arbitrary Dockerfile and
arbitrary third-party features — becoming an image that then boots holding a
device token, a GitHub installation token, and the user's agent credentials.

**We trust the repository and constrain the builder, rather than allowlisting
permitted bases and features.**

## Why trust the repository

The line an allowlist would defend has already been crossed. Registering a
repository is an operator action, and `cyrus-setup.sh` already executes
repository-controlled code inside the container on every workspace setup. A
repository that wanted to run something hostile does not need a devcontainer to
do it. An allowlist would therefore add real friction — every base and every
feature needing approval, which is precisely the bottleneck NOR-309 exists to
remove — while defending nothing that is not already open.

## What is genuinely new, and where the constraint goes

The new exposure is not at runtime, it is at build time. Today nothing in the
deployment can push to the registry at all: both the router identity and the
sandbox-group identity hold pull rights only, and worker images are built by an
operator under their own credentials. Building repository-controlled content
means something in the deployment gains push rights for the first time.

So that is what we scope. Builds run as Azure Container Registry tasks under a
dedicated identity that can push to one registry path and nothing else — not
under the router's identity, and not on the router host. Keeping it off the
router host matters independently of credentials: the router is a single replica
holding the SQLite database the whole deployment depends on, and it is the last
place to execute someone else's build.

## The asymmetry we are accepting

Sandboxes run deny-by-default egress against a small host allowlist. Registry
tasks have no egress restriction, so a repository's Dockerfile can reach
anywhere while it builds, and nowhere once it runs. That is a real gap and it is
deliberate: a build that could not reach a repository's own package registries,
private feeds, or toolchain mirrors could not build most real devcontainers, and
the allowlist would have to grow to a superset of every ecosystem's
infrastructure — reproducing at build time exactly the central bottleneck this
work removes.

It is recorded here because it is invisible from either side. Reading the egress
policy suggests everything is locked down; reading the build task suggests
nothing ever was.

## When to revisit

- If repositories stop being registered by an operator — self-service
  registration would remove the act this entire decision rests on.
- If build-time egress is ever implicated in an incident, the answer is a
  proxy with an allowlist at the build step, not an allowlist of bases and
  features at the repository step.
