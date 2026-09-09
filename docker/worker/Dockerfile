# syntax=docker/dockerfile:1

# ---- build: compile cyrus-ai + workspace deps from monorepo source ----
FROM node:22-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --filter cyrus-ai... --frozen-lockfile
RUN pnpm --filter cyrus-ai... build
# --legacy: pnpm 10's default deploy mode wants injectWorkspacePackages=true
# repo-wide, which we don't flip just for Docker.
RUN pnpm --filter cyrus-ai deploy --prod --legacy /out

# ---- runtime ----
FROM node:22-slim
# git/curl/jq/gh: needed by the restore ladder (git clone/config, credential
# helper) and by Claude sessions themselves (PR creation via `gh`, fetching
# raw files via `curl`/`jq`). ca-certificates: node's fetch (used to reach the
# router for bundle download/upload) needs a real root store, which node:22-slim
# does not ship with by default.
#
# bubblewrap/socat: the two host prerequisites of the Claude Code SDK's
# subprocess env scrub (`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`), which keeps the
# session's Anthropic credentials out of the env of every Bash subprocess the
# agent spawns. Without them `checkLinuxSandboxRequirements()` reports the host
# as unsupported and the scrub can never be turned on here (NOR-412).
#
# The third prerequisite — creating an unprivileged user namespace — is a
# property of the runtime, not the image, and cannot be baked in. It was
# verified to hold inside a live ACA sandbox: the exact probe
# `sandbox-requirements.ts` runs (`bwrap --ro-bind / / --proc /proc --dev /dev
# --unshare-user --unshare-pid --unshare-net -- true`) exits 0 there. It does
# NOT hold under every local Docker daemon — NOR-364 phase 3 hit `bwrap: No
# permissions to create a new namespace` on a Docker Desktop drive — which is
# why the scrub is opt-in per host rather than assumed available.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bubblewrap \
		ca-certificates \
		curl \
		gh \
		git \
		jq \
		socat \
	&& rm -rf /var/lib/apt/lists/*
# .NET SDK: repos targeting .NET (e.g. net10.0/net8.0 solutions) need `dotnet`
# for Claude sessions to build, test, restore, and run local tools. Installed
# from Microsoft's package feed, which auto-resolves the native runtime deps
# (libicu, libssl, …) that node:22-slim does not ship. Pinned to the base
# image's Debian release (12/bookworm) — update the feed URL if the base moves.
# `powershell` (pwsh) comes from the same feed — repos that ship .ps1 build or
# deploy scripts need it, and it publishes for both amd64 and arm64 on
# bookworm, so no arch special-casing is required. Azure CLI uses its own
# Microsoft apt repository; the Log Analytics and Application Insights
# extensions are installed in the system extension directory so the non-root
# cyrus user can load them. Microsoft documents their query commands as GA, but
# currently marks every published wheel as preview in the extension index, so
# installation must allow that metadata. All three tools and both extensions are
# intentionally unpinned: the immutable image digest fixes each build.
#
# `application-insights` is not a nice-to-have. It is what provides
# `az monitor app-insights query` — the command a repository's telemetry-estate
# inventory uses to decide whether a component still emits anything. When the
# extension is absent that query surfaces as an EMPTY RESULT rather than as an
# error (CYR-88), and an empty result is precisely the answer that authorises
# deleting the component. A missing gate that reports "nothing found" is worse
# than one that fails.
#
# `aspnetcore-runtime-8.0` sits alongside the .NET 10 SDK because the SDK can
# BUILD `net8.0` (targeting packs come from NuGet) but cannot RUN it: `dotnet
# test -f net8.0` dies with "You must install or update .NET to run this
# application… Framework 'Microsoft.NETCore.App', version '8.0.0'". A repo with
# a tier-1 lane still on `net8.0` therefore has no runnable test suite here at
# all. The ASP.NET Core variant is installed rather than the bare
# `dotnet-runtime-8.0` it depends on, because a web test project additionally
# needs `Microsoft.AspNetCore.App` and the bare runtime alone fails it the same
# way.
ENV AZURE_CORE_COLLECT_TELEMETRY=no
RUN curl -fsSL https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb -o /tmp/packages-microsoft-prod.deb \
	&& dpkg -i /tmp/packages-microsoft-prod.deb \
	&& rm /tmp/packages-microsoft-prod.deb \
	&& printf 'Types: deb\nURIs: https://packages.microsoft.com/repos/azure-cli/\nSuites: bookworm\nComponents: main\nArchitectures: %s\nSigned-By: /usr/share/keyrings/microsoft-prod.gpg\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/azure-cli.sources \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends azure-cli dotnet-sdk-10.0 aspnetcore-runtime-8.0 powershell \
	&& rm -rf /var/lib/apt/lists/* \
	&& az extension add --name log-analytics --system --allow-preview true --yes --only-show-errors \
	&& az extension add --name application-insights --system --allow-preview true --yes --only-show-errors
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
	DOTNET_NOLOGO=1 \
	DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
# Bicep CLI, and the config that stops Azure CLI trying to fetch its own.
#
# `az bicep build` auto-installs on first use, and that install — plus the
# upgrade check it runs on every subsequent invocation — goes to
# `https://aka.ms/BicepLatestRelease`, which a Deny-by-default sandbox answers
# with `403 Client Error: Forbidden`. The failure is at BOOTSTRAP, before a
# single template is parsed, so the gate is not failing: it is absent, and a PR
# can carry infrastructure changes validated by nothing (CYR-88, NOR-334).
#
# Baking `az bicep install` would not fix it: that writes to `~/.azure/bin`,
# and $HOME is /root at build time — the same trap the Fleece CLI's --tool-path
# avoids. So the binary goes on PATH and `bicep.use_binary_from_path` is set,
# which `run_bicep_command` reads as "the user manages the Bicep CLI" and which
# disables the version check outright rather than merely caching it. Setting it
# via the env var (Azure CLI maps `AZURE_<SECTION>_<OPTION>` onto config, the
# same mechanism as AZURE_CORE_COLLECT_TELEMETRY above) rather than
# `az config set` keeps it independent of AZURE_CONFIG_DIR, which is per-user
# and is where a runtime `az login` writes.
#
# Pinned, and the checksums are pinned WITH it: Azure/bicep publishes no
# checksums file beside its release assets, so unlike actionlint above there is
# nothing to derive them from at build time. BICEP_VERSION and the two digests
# describe one release and must move together — a bump that lands the version
# without the digests fails the build loudly, which is the intended behaviour.
# Get the replacements from the release API's per-asset `digest` field:
#   curl -s https://api.github.com/repos/Azure/bicep/releases/tags/v<VERSION> \
#     | jq -r '.assets[] | select(.name|startswith("bicep-linux")) | "\(.name) \(.digest)"'
# The binary is a self-contained AOT publish and does not use the .NET runtime
# installed above.
ARG BICEP_VERSION=0.47.16
ARG BICEP_SHA256_AMD64=64c345a58e0c3e48b1bc98a4e62d6b3adb1d238281297de3400aeafb2697aa5a
ARG BICEP_SHA256_ARM64=4406214cc274cfac7c821552aec2178b80aec637d91ed8b244282964c1cf24e3
ENV AZURE_BICEP_USE_BINARY_FROM_PATH=true
RUN set -eu; \
	arch="$(dpkg --print-architecture)"; \
	case "${arch}" in \
		amd64) asset='bicep-linux-x64'; expected="${BICEP_SHA256_AMD64}" ;; \
		arm64) asset='bicep-linux-arm64'; expected="${BICEP_SHA256_ARM64}" ;; \
		*) echo "no Bicep CLI build for architecture ${arch}" >&2; exit 1 ;; \
	esac; \
	cd /tmp; \
	curl -fsSLO "https://github.com/Azure/bicep/releases/download/v${BICEP_VERSION}/${asset}"; \
	actual="$(sha256sum "${asset}" | awk '{print $1}')"; \
	if [ "${expected}" != "${actual}" ]; then \
		echo "bicep ${BICEP_VERSION} ${arch} checksum mismatch: expected '${expected}', got '${actual}'" >&2; \
		exit 1; \
	fi; \
	install -m 0755 "${asset}" /usr/local/bin/bicep; \
	rm -f "${asset}"; \
	bicep --version
# Pester, the PowerShell test framework, installed for AllUsers.
#
# This one CANNOT be left to runtime under any allowlist we control with
# confidence. A repo's `bootstrap.ps1` reaching PSGallery fails at
# `Get-PackageSource: Unable to find repository 'PSGallery'`, and the endpoint
# set behind it is a moving target — Microsoft retired the `*.azureedge.net`
# CDN hosts its own firewall guidance named for years. DEFAULT_EGRESS_HOSTS
# carries the currently-documented set as a convenience for repos installing
# their own modules, but the gate itself is made a property of the image rather
# than of the network (CYR-88).
#
# AllUsers puts it under /usr/local/share/powershell/Modules, readable by the
# non-root `cyrus` user; the default (CurrentUser) would land in /root, which
# is the same $HOME-at-build-time trap the Fleece CLI's --tool-path avoids.
# Unpinned, like pwsh itself — that resolves to Pester 5.x, whose syntax is what
# current suites are written against.
#
# `Install-PSResource` (PSResourceGet, shipped with pwsh since 7.4) rather than
# PowerShellGet's `Install-Module`: the latter bootstraps the NuGet package
# provider from a separate CDN on first use, adding a second network dependency
# and an interactive prompt to a build that can answer neither.
# `-TrustRepository` is what suppresses the untrusted-repository confirmation
# that would otherwise block forever.
#
# The import runs as a SEPARATE invocation, and is the actual gate: it proves
# the module resolves from a clean session rather than from the state the
# install left behind, and it fails the build if AllUsers ever stops being a
# path pwsh searches.
RUN pwsh -NoProfile -NonInteractive -Command "Install-PSResource -Name Pester -Scope AllUsers -TrustRepository -ErrorAction Stop" \
	&& pwsh -NoProfile -NonInteractive -Command "Import-Module Pester -ErrorAction Stop; Write-Output (Get-Module Pester).Version.ToString()"
# .NET global tools: installed to a shared --tool-path rather than `-g`. A
# global install lands in $HOME/.dotnet/tools, and $HOME is /root at build
# time — unreachable for the non-root `cyrus` user this image actually runs as.
# Intentionally unpinned; pin the versions here if you need byte-identical
# rebuilds.
#
# `dotnet-affected` computes which projects a diff touches, and repos drive
# their tier-1 test lane off it. Installing it at runtime with
# `dotnet tool install --global` appears to succeed and then leaves the command
# unresolvable, because ~/.dotnet/tools is not on the session's PATH — so the
# repo's own script reports the tool as missing until PATH is amended by hand
# (CYR-88). Putting it on the same --tool-path as Fleece, which IS on PATH
# below, removes the manual step entirely.
ENV PATH="/usr/local/dotnet-tools:${PATH}"
RUN dotnet tool install Fleece.Cli --tool-path /usr/local/dotnet-tools \
	&& dotnet tool install dotnet-affected --tool-path /usr/local/dotnet-tools \
	&& rm -rf /root/.nuget/packages /tmp/NuGetScratch
# actionlint: GitHub Actions workflow linter. No Debian package exists, so we
# pull the pinned release tarball and verify its published checksum. Arch is
# derived from dpkg (amd64/arm64) because ACA builds --platform linux/amd64
# while local dev builds native on Apple Silicon.
ARG ACTIONLINT_VERSION=1.7.12
RUN set -eu; \
	arch="$(dpkg --print-architecture)"; \
	base="https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}"; \
	tarball="actionlint_${ACTIONLINT_VERSION}_linux_${arch}.tar.gz"; \
	cd /tmp; \
	curl -fsSLO "${base}/${tarball}"; \
	curl -fsSLO "${base}/actionlint_${ACTIONLINT_VERSION}_checksums.txt"; \
	grep " ${tarball}\$" "actionlint_${ACTIONLINT_VERSION}_checksums.txt" | sha256sum -c -; \
	tar -xzf "${tarball}" actionlint; \
	install -m 0755 actionlint /usr/local/bin/actionlint; \
	rm -f "${tarball}" "actionlint_${ACTIONLINT_VERSION}_checksums.txt" actionlint
# npm-installed CLIs on PATH: `codex`, `opencode` and `argos`. The two agent
# CLI packages resolve their native binary through per-platform
# optionalDependencies, so `npm install -g` picks the right
# linux-x64/linux-arm64 build without arch special-casing here.
#
# `codex` is deliberately installed a second time even though `@openai/codex`
# already ships inside /app as a transitive dependency of cyrus-codex-runner:
# CodexRunner resolves that copy through `require.resolve` from its own package
# directory (see packages/codex-runner/src/backend/codexBinary.ts), and its
# path inside a `pnpm deploy` tree is an implementation detail we don't want to
# put on PATH. Keep CODEX_VERSION in step with the `@openai/codex` version
# resolved in pnpm-lock.yaml so a session invoking `codex` directly gets the
# same CLI Cyrus itself drives.
#
# Neither CLI is authenticated here — credentials are runtime concerns, and
# baking them into a layer would leak them into the image.
#
# `codex` gets its credentials at boot, not from this image (NOR-290, resolved
# by NOR-364): the router holds each user's ChatGPT subscription tokens, is the
# sole process that refreshes them, and injects a freshly-minted short-lived
# copy as `CODEX_AUTH_JSON`. `cyrus container-boot` writes that to
# `$CODEX_HOME/auth.json` at 0600 before launching the session. `OPENAI_API_KEY`
# remains supported as the metered fallback. See
# docs/adr/0005-codex-authenticates-by-router-held-subscription-tokens.md.
#
# `argos` is the Argos visual-testing CLI — the upload half of the Playwright
# screenshots the browser layer below exists for. It authenticates purely from
# the session env (`ARGOS_TOKEN`), which reaches the sandbox from the user's
# secret bundle, and talks to `api.argos-ci.com`, allowlisted in
# `DEFAULT_EGRESS_HOSTS` because ACA sandboxes deny egress by default.
ARG CODEX_VERSION=0.144.6
ARG OPENCODE_VERSION=1.18.13
ARG ARGOS_CLI_VERSION=6.9.2
RUN npm install -g \
		"@openai/codex@${CODEX_VERSION}" \
		"opencode-ai@${OPENCODE_VERSION}" \
		"@argos-ci/cli@${ARGOS_CLI_VERSION}" \
	&& rm -rf /root/.npm
RUN useradd --create-home --uid 1001 cyrus \
	&& mkdir -p /workspaces /var/cache/repos \
	&& chown -R cyrus:cyrus /workspaces /var/cache/repos \
	&& printf '#!/bin/sh\nexec node /app/dist/src/app.js "$@"\n' > /usr/local/bin/cyrus \
	&& chmod +x /usr/local/bin/cyrus
# pnpm, by way of corepack, which node:22-slim ships but does not activate.
#
# `corepack enable` has to happen HERE, at build time as root, and not be left
# to the session: it writes its shims next to the `node` binary, i.e. into
# root-owned /usr/local/bin, so the same command run as `cyrus` dies with
# `EACCES: permission denied, symlink … -> '/usr/local/bin/pnpm'`. That is the
# whole of the "pnpm: command not found; corepack enable fails" report in
# CYR-88 — the npm registry was reachable all along, the shim directory was
# not. It sits after `useradd` only because COREPACK_HOME below is chowned.
#
# Which pnpm actually runs is still the REPOSITORY's decision, exactly as with
# Playwright's browser revision: corepack reads the `packageManager` field of
# the project it is invoked in and fetches that version from
# `registry.npmjs.org`, which is allowlisted. PNPM_VERSION only supplies the
# global default for a repo that pins nothing, so a bump here cannot break a
# pinned repo — and pre-installing it means the common unpinned case costs no
# download at all.
#
# COREPACK_HOME is moved off ~/.cache so the download is paid once per sandbox
# rather than once per worktree, the same reasoning as
# PLAYWRIGHT_BROWSERS_PATH; it is chowned to `cyrus` because that is who
# fetches a pinned version at runtime. COREPACK_ENABLE_DOWNLOAD_PROMPT=0 is
# required for the non-interactive case: without it corepack stops and waits
# for a "do you want to download pnpm@x.y.z?" confirmation that a session has
# no way to answer, which presents as a hang rather than as a prompt.
ARG PNPM_VERSION=10.33.1
ENV COREPACK_HOME=/usr/local/corepack \
	COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable \
	&& corepack install --global "pnpm@${PNPM_VERSION}" \
	&& chown -R cyrus:cyrus "${COREPACK_HOME}" \
	&& pnpm --version
# Rust toolchain: repos with Cargo crates need `cargo`/`rustc` to build and
# test. Installed via rustup into shared paths under /usr/local rather than
# rustup's default ~/.cargo, for the same reason the Fleece CLI is: $HOME is
# /root at build time and this image runs as the non-root `cyrus` user, which
# could never reach a /root install. Both trees are chowned to `cyrus` (hence
# this block sitting after `useradd`) because they are not read-only at
# runtime — cargo writes the registry index cache, crate downloads, and git
# checkouts into CARGO_HOME, and rustup writes into RUSTUP_HOME whenever a
# repo's rust-toolchain.toml pins a toolchain other than the one baked here.
#
# build-essential/pkg-config/libssl-dev are not optional extras. rustc shells
# out to `cc` for the final link step, so without a C toolchain every
# `cargo build` fails with "linker `cc` not found", and the `-sys` crates that
# wrap C libraries (openssl-sys and friends) need pkg-config plus headers.
#
# rustup-init comes from the unversioned `dist` path (always the current
# rustup) and is verified against the .sha256 published beside it. We compare
# the hash field ourselves instead of piping to `sha256sum -c` because
# rustup's checksum files have not been consistent about their filename
# column, and `-c` fails on the format it does not expect.
#
# The toolchain is `stable` and left unpinned, like the .NET SDK above; build
# with --build-arg RUST_TOOLCHAIN=1.89.0 for a reproducible pin. `--profile
# minimal` keeps rust-docs (a few hundred MB of generated HTML no session
# reads) out of the image; rustfmt and clippy are added back explicitly since
# `cargo fmt --check` and `cargo clippy` are standard steps in the
# verification commands Rust repos ship.
ARG RUST_TOOLCHAIN=stable
ENV RUSTUP_HOME=/usr/local/rustup \
	CARGO_HOME=/usr/local/cargo \
	PATH="/usr/local/cargo/bin:${PATH}"
RUN set -eu; \
	apt-get update; \
	apt-get install -y --no-install-recommends \
		build-essential \
		libssl-dev \
		pkg-config; \
	rm -rf /var/lib/apt/lists/*; \
	arch="$(dpkg --print-architecture)"; \
	case "${arch}" in \
		amd64) triple='x86_64-unknown-linux-gnu' ;; \
		arm64) triple='aarch64-unknown-linux-gnu' ;; \
		*) echo "no rustup-init build for architecture ${arch}" >&2; exit 1 ;; \
	esac; \
	base="https://static.rust-lang.org/rustup/dist/${triple}"; \
	cd /tmp; \
	curl -fsSLO "${base}/rustup-init"; \
	expected="$(curl -fsSL "${base}/rustup-init.sha256" | awk '{print $1}')"; \
	actual="$(sha256sum rustup-init | awk '{print $1}')"; \
	if [ -z "${expected}" ] || [ "${expected}" != "${actual}" ]; then \
		echo "rustup-init checksum mismatch: expected '${expected}', got '${actual}'" >&2; \
		exit 1; \
	fi; \
	chmod +x rustup-init; \
	./rustup-init -y --no-modify-path --profile minimal \
		--default-toolchain "${RUST_TOOLCHAIN}" \
		--component rustfmt --component clippy; \
	rm -f rustup-init; \
	chown -R cyrus:cyrus "${RUSTUP_HOME}" "${CARGO_HOME}"; \
	rustc --version; \
	cargo --version
# Chromium for Playwright. Two halves, and only one of them is a version pin.
#
# The half that MUST be baked is `--with-deps`: it apt-installs Chromium's
# shared libraries and fonts, which needs root, and this image drops to `cyrus`
# below. That half is revision-independent — the same Mesa/X11/font packages
# serve any Chromium build — so it never drifts.
#
# The browser binary itself is only a WARM CACHE. Which revision Playwright
# will actually launch is decided by the REPOSITORY's `playwright-core` pin,
# not by this image: every Playwright version ships its own `browsers.json`,
# and Playwright ignores a browser directory whose revision does not match
# rather than falling back to it. So a repo pinning a different Playwright than
# the ARG below sees the baked browser as dead weight and asks for a
# `playwright install`. That is now survivable: every Playwright download host
# is in DEFAULT_EGRESS_HOSTS (cyrus-router-executors) — `cdn.playwright.dev`
# and `playwright.download.prss.microsoft.com` for >=1.50, plus the three
# `*.azureedge.net` mirrors <=1.49 is hard-coded to — so the mismatch costs a
# one-time download into the shared /ms-playwright instead of failing the suite
# outright (CYR-87).
#
# Keep PLAYWRIGHT_VERSION matched to the pin of the repository whose sessions
# actually run Playwright here, so the common case needs no download — but
# treat that as an optimisation, not a correctness requirement. No cross-repo
# lockstep is enforceable from inside this image (it cannot see a downstream
# repo's package.json), which is why the CDN allowlist, not this ARG, is what
# makes a bump safe. A repo that wants the reconcile to be automatic rather
# than agent-initiated should run `playwright install chromium` from its
# `cyrus-setup.sh`; it is a no-op when the revision below already matches.
#
# PLAYWRIGHT_BROWSERS_PATH puts the browsers at a shared path (instead of
# ~/.cache/ms-playwright) so they survive regardless of which user or repo
# invokes Playwright, and so a runtime `playwright install` is paid once per
# sandbox rather than once per worktree; it is chowned to `cyrus` because that
# install runs as `cyrus`.
ARG PLAYWRIGHT_VERSION=1.60.0
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npm install -g "playwright@${PLAYWRIGHT_VERSION}" \
	&& playwright install --with-deps chromium \
	&& chown -R cyrus:cyrus /ms-playwright \
	&& rm -rf /var/lib/apt/lists/* /root/.npm
COPY --from=build /out /app
COPY docker/worker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
USER cyrus
# No `VOLUME /workspaces` here: LocalDockerProvider always mounts a named
# volume at this path itself, and a `VOLUME` directive would additionally
# cause an anonymous volume to be created on any hand-run `docker run`
# without `-v` — never what we want.
ENTRYPOINT ["/entrypoint.sh"]
