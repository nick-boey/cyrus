# cyrus-worker

Makes an arbitrary image able to host a Cyrus agent.

Under [ADR 0006](../../../docs/adr/0006-devcontainer-image-is-the-base-cyrus-is-a-feature.md)
a repository's own devcontainer is the base and Cyrus rides on top. That inverts
who guarantees the boot contract: everything `docker/worker/Dockerfile` gets for
free by owning the whole image, this Feature has to establish on a base that
knows nothing about Cyrus.

**Status: written, not yet built.** See
[the Task 0 spike](../../../docs/spikes/2026-09-01-nor-309-devcontainer-spike.md)
for what was verified and what was not.

## What it establishes

- A **private** Node runtime at `/opt/cyrus-worker/node`, deliberately **not on
  `PATH`**. The agent runs the repository's own builds, so the repository's Node
  must be the one its sessions see.
- The `cyrus-ai` worker, `/usr/local/bin/cyrus`, and `/entrypoint.sh`.
- The non-root worker user, `/workspaces` and `/var/cache/repos`.
- `git`, `gh`, `curl`, `jq`, `ca-certificates` across Debian, Alpine, RHEL and
  Azure Linux bases.

## What it deliberately does not do

**Set `USER` or `ENTRYPOINT`** — a Feature structurally cannot, and the
devcontainer CLI does not do it either. The build pipeline applies both over the
built image; see `docker/worker/devcontainer/Dockerfile.finalize`.

## Options that are not optional

`tarball` — a URL for a gzipped `pnpm deploy --prod --legacy` tree built from
this repository, which the install **extracts as-is**. Two reasons it is not
`npm install`:

1. The `cyrus-ai` package on public npm is a **different, older CLI with no
   `container-boot` command**, so the `version` option is only valid where the
   resolved registry publishes this worker.
2. `cyrus-ai` declares nine `workspace:*` dependencies and the deploy tree sets
   no `bundledDependencies`, so npm would discard the `node_modules` the tree
   carries and then fail to resolve them.

The install asserts `container-boot` exists and fails the build if it does not,
because the alternative is a container that dies at boot with `error: too many
arguments for 'start'` — a message naming neither the missing command nor the
wrong payload.

## Install order

List this Feature **first** in `overrideFeatureInstallOrder`. It creates the
worker user, and `rust`, `node` and `github-cli` all silently fall back to
`USERNAME=root` when the user does not exist yet — producing a `CARGO_HOME` the
agent cannot write to, with no error at build time.

It declares **no `installsAfter`**, deliberately. The obvious entry would be
`common-utils`, which most Features depend on — but this one assumes nothing of
its base and needs nothing from it, and declaring the dependency would put
`common-utils` ahead of the Feature that has to run first, contradicting the
override above.
