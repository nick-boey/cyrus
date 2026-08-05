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
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		ca-certificates \
		curl \
		gh \
		git \
		jq \
	&& rm -rf /var/lib/apt/lists/*
# .NET SDK: repos targeting .NET (e.g. net10.0/net8.0 solutions) need `dotnet`
# for Claude sessions to build, test, restore, and run local tools. Installed
# from Microsoft's package feed, which auto-resolves the native runtime deps
# (libicu, libssl, …) that node:22-slim does not ship. Pinned to the base
# image's Debian release (12/bookworm) — update the feed URL if the base moves.
# `powershell` (pwsh) comes from the same feed — repos that ship .ps1 build or
# deploy scripts need it, and it publishes for both amd64 and arm64 on
# bookworm, so no arch special-casing is required. Left unpinned like the SDK
# above; `apt-get install powershell=<ver>` if you need a reproducible pin.
RUN curl -fsSL https://packages.microsoft.com/config/debian/12/packages-microsoft-prod.deb -o /tmp/packages-microsoft-prod.deb \
	&& dpkg -i /tmp/packages-microsoft-prod.deb \
	&& rm /tmp/packages-microsoft-prod.deb \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends dotnet-sdk-10.0 powershell \
	&& rm -rf /var/lib/apt/lists/*
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 \
	DOTNET_NOLOGO=1 \
	DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1
# Fleece CLI: installed to a shared --tool-path rather than `-g`. A global
# install lands in $HOME/.dotnet/tools, and $HOME is /root at build time —
# unreachable for the non-root `cyrus` user this image actually runs as.
# Intentionally unpinned (tracks the latest published Fleece.Cli); pin the
# version here if you need byte-identical rebuilds.
ENV PATH="/usr/local/dotnet-tools:${PATH}"
RUN dotnet tool install Fleece.Cli --tool-path /usr/local/dotnet-tools \
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
# Agent CLIs on PATH: `codex` and `opencode`. Both npm packages resolve their
# native binary through per-platform optionalDependencies, so `npm install -g`
# picks the right linux-x64/linux-arm64 build without arch special-casing here.
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
# baking them into a layer would leak them into the image. How `codex` should
# get its credentials inside a worker container is still open; see NOR-290.
# Until that lands, this image only puts the CLI on PATH.
ARG CODEX_VERSION=0.144.6
ARG OPENCODE_VERSION=1.18.13
RUN npm install -g \
		"@openai/codex@${CODEX_VERSION}" \
		"opencode-ai@${OPENCODE_VERSION}" \
	&& rm -rf /root/.npm
RUN useradd --create-home --uid 1001 cyrus \
	&& mkdir -p /workspaces /var/cache/repos \
	&& chown -R cyrus:cyrus /workspaces /var/cache/repos \
	&& printf '#!/bin/sh\nexec node /app/dist/src/app.js "$@"\n' > /usr/local/bin/cyrus \
	&& chmod +x /usr/local/bin/cyrus
# Chromium for Playwright. Baked in rather than fetched on demand: ACA
# sandboxes run a Deny-by-default egress policy whose allowlist
# (DEFAULT_EGRESS_HOSTS in cyrus-router-executors) has no Playwright CDN
# entry, so a session's own `playwright install` would hang there.
# --with-deps is the part sessions genuinely cannot do themselves — it
# apt-installs Chromium's shared libraries and fonts, which needs root, and
# this image drops to `cyrus` below.
# PLAYWRIGHT_BROWSERS_PATH puts the browsers at a shared path (instead of
# ~/.cache/ms-playwright) so they survive regardless of which user or repo
# invokes Playwright; it is chowned to `cyrus` so a session can still add a
# browser build at runtime if its repo pins a Playwright whose Chromium
# revision differs from the one baked here.
ARG PLAYWRIGHT_VERSION=1.62.0
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
