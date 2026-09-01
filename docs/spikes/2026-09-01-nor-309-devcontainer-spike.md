# NOR-309 Task 0 — can the default worker image be expressed as a devcontainer?

**Verdict: the worker feature can be made self-contained. ADR 0005 survives, with
two amendments — one to the ADR's text and one to the plan's Task 2.**

Every component of `docker/worker/Dockerfile` maps onto the Dev Containers
model. Nothing was found that cannot be expressed. But two things ADR 0005
assumes a Feature can do, a Feature structurally cannot, and one delivery
mechanism the plan implies does not exist yet.

**This spike did not build an image.** The sandbox it ran in has no container
runtime and no `sudo`, and its egress allowlist blocks `nodejs.org`. Everything
under [What was executed](#what-was-executed) is real evidence; everything under
[What was not](#what-was-not-executed) is analysis of primary sources.
`docker/worker/devcontainer/build.sh` exists so the unexecuted half is one
command rather than a reconstruction. Treat a failure there as new evidence.

## The two amendments

### 1. A Feature cannot set `USER` or `ENTRYPOINT`. ADR 0005 says it must.

ADR 0005 states the boot contract becomes an interface the feature establishes:
"The container is entered at `/entrypoint.sh` running `container-boot`, as a
non-root user…". A Feature contributes `RUN` layers only, and the devcontainer
CLI does not close the gap:

- The generated Dockerfile ends with `ARG _DEV_CONTAINERS_IMAGE_USER=root` /
  `USER $_DEV_CONTAINERS_IMAGE_USER`
  (`spec-configuration/containerFeaturesConfiguration.ts:228`), and that arg is
  bound to `imageBuildInfo.user` (`spec-node/containerFeatures.ts:355`), which
  is `imageDetails.Config.User || 'root'` (`spec-node/imageMetadata.ts:386`) —
  **the base image's user, never `containerUser`**.
- The CLI emits **no `ENTRYPOINT` at all**. Nothing in its source does.
- `containerUser`/`remoteUser` become a `devcontainer.metadata` label that only
  the devcontainer CLI reads when it execs into a container. ACA does not read
  it; it boots the image's own OCI `ENTRYPOINT` as the image's own `USER`.

So a `devcontainer build` of a repo whose base is, say, `node:22-slim` produces
an image that runs as **root** with **node's** entrypoint, no matter what the
composed config says.

**This does not falsify ADR 0005.** The fix is a two-instruction stage over the
built image (`docker/worker/devcontainer/Dockerfile.finalize`):

```dockerfile
FROM ${BUILT_IMAGE}
USER cyrus
ENTRYPOINT ["/entrypoint.sh"]
```

That stage is **uniform** — it does not vary with the shape of the repository's
base — so it is not the "bespoke grafting logic against every shape a base can
take" the ADR rejects. It grafts onto the built image, not into the repository's
Dockerfile. But ADR 0005's claim that the standard's own composition mechanism
carries the whole boot contract is too strong as written, and the build pipeline
(Task 3) owns two instructions the ADR does not currently account for.

The finalize stage asserts `/entrypoint.sh` exists and the user exists, failing
the **build**. Without that, a missing worker feature produces an image that
builds happily and then presents as a sandbox stuck `Running` with no worker
attached — per `CLAUDE.md`'s ACA invariants, the hardest symptom to trace back
to its cause.

### 2. The worker payload cannot come from public npm. This is new.

The Dockerfile `COPY`s a `pnpm deploy` tree out of a build stage. A Feature is
an OCI artifact holding only its own files and cannot `COPY` from a build stage
of this monorepo, so the payload must arrive over the network. The obvious
answer is `npm install -g cyrus-ai`, since `cyrus-ai` is a published package.

**It does not work.** Verified by installing it:

```
$ npm install -g --prefix /tmp/w cyrus-ai@latest      # → 0.2.70, 922 MB
$ node /tmp/w/lib/node_modules/cyrus-ai/dist/src/app.js --help
Commands:
  start / auth / check-tokens / refresh-token / self-auth-linear / self-add-repo
$ grep -rl container-boot /tmp/w/lib/node_modules/cyrus-ai/
(nothing)
```

`cyrus-ai@0.2.70` on public npm is a different, older CLI: 21 dist files, no
`buildProgram`, and **no `container-boot` command anywhere in the package**. The
worker in this repository registers it at `apps/cli/src/buildProgram.ts:420`.

The failure mode is the dangerous kind. The image builds cleanly, and the
container dies at boot with:

```
error: too many arguments for 'start'. Expected 0 arguments but got 1.
```

— the argument parser treating `container-boot` as a positional to `start`.
That message names neither the missing command nor the wrong package, and it
appears only at runtime in ACA, where nothing collects the worker's stdout
before the log relay attaches.

### …and the tarball must be extracted, not `npm install`ed

The obvious repair — `npm install -g <tarball>` from an `npm pack` — does not
work either. `cyrus-ai` declares **nine `workspace:*` dependencies**
(`cyrus-core`, `cyrus-router`, `cyrus-edge-worker`, …). A packed tarball is
unresolvable from any registry, and a `pnpm deploy` tree's `package.json` still
carries those specifiers with no `bundledDependencies`, so npm would discard the
`node_modules` the tree already has and then fail to rebuild it.

The payload is therefore a gzipped `pnpm deploy --prod --legacy` tree,
**extracted as-is** — exactly what the Dockerfile `COPY`s today. Verified:

```
$ pnpm --filter cyrus-ai deploy --prod --legacy /tmp/out   # 956 MB
$ tar -czf /tmp/worker.tgz -C /tmp out                     # 256 MB
$ tar -xzf /tmp/worker.tgz -C /tmp/wh/app --strip-components=1
$ node /tmp/wh/app/dist/src/app.js --help | grep container-boot
  container-boot [options]   Internal: boots an ephemeral worker container …
$ HOME=/tmp/fh /tmp/wh/entrypoint.sh
  [ERROR] [container-boot] Missing required environment variable(s): …
```

That last line is the spike's decisive success criterion — the whole chain
(private node → extracted tree → app path → argv → command registration →
`$HOME` boot log) is intact. It has now been executed, just not inside a
container.

**Consequences for the plan:**

- The Feature's `tarball` option is the **primary** delivery mechanism, not the
  escape hatch the plan's Task 2 implies. Task 3's build pipeline must publish a
  `pnpm deploy` tarball per Cyrus release and pass its URL. That is ~256 MB
  compressed / ~956 MB extracted per build, which is new artifact storage the
  plan does not currently account for.
- `install.sh` asserts `container-boot` is registered and **fails the build** if
  not. This is the single highest-value line in the feature: it converts that
  runtime riddle into a build error naming the cause. Verified to fire against
  `cyrus-ai@0.2.70` and to pass against the deploy tree.

## The non-root question — answered, and better than expected

This was flagged as the highest-risk unknown: the Dockerfile carries documented
workarounds for `$HOME` being `/root` at build time while the image runs as
`cyrus` at uid 1001. **The official Features already implement the same
workarounds, and in two cases arrive at byte-identical paths.**

| Dockerfile workaround | Feature equivalent |
| -- | -- |
| `RUSTUP_HOME=/usr/local/rustup`, `CARGO_HOME=/usr/local/cargo`, `chown -R cyrus` | `rust` declares exactly those two `containerEnv` values, then `groupadd -r rustlang`, `usermod -a -G rustlang "${USERNAME}"`, `chown "${USERNAME}:rustlang"`, `chmod g+r+w+s` (`rust/install.sh:353-360`) |
| Fleece to `--tool-path /usr/local/dotnet-tools` because `-g` lands in `/root` | No published Feature; reproduced as a local Feature with the same `--tool-path` |
| `chown -R cyrus:cyrus /ms-playwright` | No published Feature; reproduced as a local Feature using `_REMOTE_USER` |

`rust`, `node`, and `github-cli` all resolve
`USERNAME="${USERNAME:-"${_REMOTE_USER:-"automatic"}"}"`, and `_REMOTE_USER` is
supplied by the CLI from the composed config's `remoteUser`/`containerUser`
(`spec-node/containerFeatures.ts:253-256`). So a feature-installed toolchain
**is** usable by the non-root user.

### The ordering hazard this creates

Those same features contain:

```sh
elif [ "${USERNAME}" = "none" ] || ! id -u "${USERNAME}" > /dev/null 2>&1; then
    USERNAME=root
```

If `rust` runs **before** the feature that creates the `cyrus` user, `id -u`
fails, `USERNAME` silently becomes `root`, and `CARGO_HOME` ends up root-owned.
Cargo writes its registry index cache and crate downloads into `CARGO_HOME` at
runtime, so the symptom is every `cargo build` failing on a permission error,
in a container that built without a single warning.

**Mitigation:** the composed devcontainer must list the worker feature first in
`overrideFeatureInstallOrder` (honoured at
`spec-configuration/containerFeaturesOrder.ts:298-326, 562-566`). This is a
requirement on Task 3's composition step, not a nicety.

## Per-component mapping

| Component | Maps to | Notes |
| -- | -- | -- |
| `ca-certificates`, `curl`, `git`, `jq` | worker Feature | Per-family (`apt`/`apk`/`dnf`/`tdnf`) |
| `gh` | worker Feature | Checksum-verified release tarball. Not the `github-cli` Feature: absent from Debian's archive, Alpine main and RHEL, so no package branch covers every base. **Executed: passes.** |
| Node runtime for the worker | worker Feature | Installed **privately** at `/opt/cyrus-worker/node` and deliberately kept **off PATH** — see below |
| `/app` tree + `cyrus` shim | worker Feature | Extracted `pnpm deploy` tarball; see amendment 2. **Executed: passes.** |
| `/entrypoint.sh` | worker Feature writes it; **pipeline selects it** | See amendment 1 |
| non-root user, `/workspaces`, `/var/cache/repos` | worker Feature | `USER` itself: pipeline |
| .NET SDK 10 | `ghcr.io/devcontainers/features/dotnet:2` | `10.0` is a listed proposal; uses `dotnet-install.sh` and `check_packages … icu-devtools`, so the ICU deps the Microsoft apt feed resolved are covered. **Debian-family only** (`dpkg -s`/`apt-get`) |
| PowerShell | `ghcr.io/devcontainers/features/powershell:2` | Microsoft apt feed, with a GitHub-release fallback |
| Rust + rustfmt/clippy | `ghcr.io/devcontainers/features/rust:1` | `build-essential`/`pkg-config`/`libssl-dev`: the Feature installs its own deps; verify `cargo build` links |
| Fleece CLI | **local Feature**, `installsAfter` dotnet | No published Feature |
| actionlint | **local Feature** | No published Feature, no distro package |
| `codex`, `opencode` | **local Feature**, `installsAfter` node | Base image's npm, not the private one |
| Playwright + Chromium | **local Feature**, `installsAfter` node | `--with-deps` needs root at build time, which a Feature has |

Nothing landed in the "cannot be expressed" column.

### Two structural findings from that table

**Anything needing a toolchain must be a Feature, not a `build.dockerfile`
step.** Features install strictly *after* the base image is built, so a
Dockerfile step can never see `dotnet`, `cargo` or a Feature-installed `npm`.
Fleece, Playwright and the agent CLIs all need one, so all three become local
Features with `installsAfter` rather than the Dockerfile lines they are today.
This is a better outcome than the plan assumed — `build.dockerfile` is needed
for none of it — but it means Task 2 ships a small **set** of features, not one.

**The worker's Node must be private and off PATH.** The agent runs the
repository's own builds and tests, so the Node the repository's devcontainer
pins must be the one its sessions see. A worker Node on PATH would shadow it,
and a repo pinned to Node 18 building against 22 looks like a bug in the
repository. `container-boot`'s `launch()` re-execs `process.execPath`
(`ContainerBootCommand.ts:1041`), which keeps the agent process on the private
Node without it ever being resolvable as `node`. The `cyrus` shim is a script
rather than npm's bin symlink for the same reason: the symlink resolves through
`#!/usr/bin/env node`, which would pick up the repository's Node.

## Build location — ACR tasks

**Plausible, not verified.** The mechanism exists:

- ACR Tasks `cmd` steps "support run parameters including volumes and other
  familiar `docker run` parameters"
  (`Azure/acr:docs/tasks/container-registry-tasks-overview.md`).
- The build agent has a Docker daemon at `/var/run/docker.sock` — `acr-builder`
  mounts `"/var/run/docker.sock:/var/run/docker.sock"` for its own steps
  (`util/sock_unix.go`, used at `builder/builder.go:404`).

So a `cmd` step running a Node image with the docker CLI and that socket mounted
can run `devcontainer build`. `az acr build` alone cannot: it builds a single
Dockerfile, and this needs the CLI. **Nobody has run it. Task 3 should confirm
before building on it.**

### The constraint that will bite

`devcontainer build` shells out to the daemon, and a recent buildx attaches
provenance/SBOM attestations by default, producing an **OCI image index**. The
ACA disk importer cannot consume one — `scripts/deploy-worker-image.sh:390-398`
already gates on the manifest media type and tells operators to rebuild with
`az acr build`. That advice does not apply on this path.

The lever is `devcontainer build --buildkit never`
(`spec-node/devContainersSpecCLI.ts:163`), which uses classic docker build and
yields the plain Docker v2 manifest the import needs. `--output` carrying
`--provenance=false --sbom=false` is the alternative if BuildKit is wanted.

### Registry SKU

`infra/azure/bicep/modules/foundation.bicep:238-248` provisions ACR at **Basic**
with `adminUserEnabled: false`. Task 3 should confirm Basic's included task
compute and concurrency are enough for per-repository builds before assuming the
SKU stays.

## Devcontainer file precedence — spec and implementation agree

The reference implementation's well-known paths are, in order:

```ts
// spec-configuration/configurationCommonUtils.ts:47-52
path_.join(folderPath, '.devcontainer', 'devcontainer.json'),
path_.join(folderPath, '.devcontainer.json'),
```

`getDevContainerConfigPathIn` returns the first that is a file. This matches the
spec text and the order already chosen in commit `9bb3e8e`. No change needed.

**Bonus:** the list has only those two entries. The CLI does not implement
`.devcontainer/<folder>/devcontainer.json` discovery at all — that is VS Code's
own. Treating multi-config as unsupported (plan, Task 1) therefore matches the
reference implementation rather than diverging from it.

## Size and build duration

**Not measured** — no build ran. Two data points that bound expectations:

- The worker payload alone is **956 MB extracted / 256 MB compressed**
  (measured on this repo's `pnpm deploy` tree). It is not a rounding error
  against the 18.4 GB image, and Task 3 must store one per release.
- The devcontainer expression installs the same toolchains from the same
  upstreams, so the total should land near 18.4 GB. Per NOR-337 that is already
  past what the preview CLI can import, which is why
  `scripts/deploy-worker-image.sh` issues the disk-image `PUT` directly with the
  900 s `SLOW_OPERATION_TIMEOUT_MS`. **Nothing here reduces that**, consistent
  with the plan's explicit non-goal.

`build.sh` prints both numbers when it runs.

## What was executed

Real evidence, run in this sandbox:

- `cyrus-ai@0.2.70` installed from npm; confirmed to lack `container-boot`
  in `--help` and in the entire package tree; confirmed the runtime failure text
  (`error: too many arguments for 'start'`).
- The build-time assertion that catches it — confirmed to fire on the npm
  package and to pass on a `pnpm deploy` tree.
- **The whole worker-payload path, end to end:** `pnpm build`,
  `pnpm --filter cyrus-ai deploy`, tar, extract with `--strip-components=1`,
  and `/entrypoint.sh` reaching `container-boot`'s
  "Missing required environment variable(s)" with the boot log written to
  `$HOME`. This is the spike's decisive criterion, short of running in a
  container.
- `pnpm build` and `pnpm typecheck` across the monorepo: both pass.
- The `gh` install path end to end: download, checksum-column parse, digest
  compare, extract, `gh --version` → `2.63.2`. This is the path most likely to
  have a silent parsing bug, and it passes.
- All shell verified with `dash -n` (strict POSIX, no bashisms) and all JSON
  parsed.
- Every CLI and Feature source claim above read from
  `raw.githubusercontent.com` at `main`.

## What was not executed

- `devcontainer build`. **No container runtime, no `sudo`.**
- The boot contract checks **against a built image**. Written as 23 assertions
  in `build.sh`. The decisive one — `/entrypoint.sh` reaching `container-boot`'s
  "Missing required environment variable(s)" — was run outside a container and
  passes (see above); what remains unproven is that it still holds after the
  Features have composed and the finalize stage has dropped to the non-root
  user. The toolchain-as-non-root checks (`CARGO_HOME` writable, `dotnet`,
  `pwsh`, `/ms-playwright` writable) have not run in any form.
- The Node install path. `nodejs.org` and `unofficial-builds.nodejs.org` both
  return 403 through this sandbox's egress allowlist.
- `devcontainer build` inside an ACR task.
- Alpine and RHEL bases. The worker Feature is written for four families; only
  the Debian branch is exercised by the reproduction devcontainer, and none of
  it has run. ADR 0005 names this as "the single constraint most likely to be
  quietly dropped during implementation" — it has not been dropped, but it has
  not been proven either.

## Artifacts

- `features/src/cyrus-worker/` — the worker Feature, in the canonical layout so
  Task 2 can publish it as-is.
- `docker/worker/devcontainer/` — the Dockerfile expressed as a devcontainer:
  `devcontainer.json`, four local Features, `Dockerfile.finalize`, `build.sh`.

## Recommended plan changes

1. **Amend ADR 0005** to record that `USER` and `ENTRYPOINT` are the build
   pipeline's, not the feature's, and why that does not reopen the decision.
2. **Task 2 becomes a set of Features**, not one, and `tarball` is its primary
   delivery mechanism.
3. **Task 3 gains three requirements:** publish a worker payload artifact per
   release; emit `overrideFeatureInstallOrder` with the worker feature first;
   build with `--buildkit never` (or attestations disabled).
4. **Run `build.sh` on a Docker host before Task 1 starts.** Task 0's gate is
   not fully discharged until it passes.
