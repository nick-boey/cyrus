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
RUN useradd --create-home --uid 1001 cyrus \
	&& mkdir -p /workspaces /var/cache/repos \
	&& chown -R cyrus:cyrus /workspaces /var/cache/repos \
	&& printf '#!/bin/sh\nexec node /app/dist/src/app.js "$@"\n' > /usr/local/bin/cyrus \
	&& chmod +x /usr/local/bin/cyrus
COPY --from=build /out /app
COPY docker/worker/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
USER cyrus
# No `VOLUME /workspaces` here: LocalDockerProvider always mounts a named
# volume at this path itself, and a `VOLUME` directive would additionally
# cause an anonymous volume to be created on any hand-run `docker run`
# without `-v` — never what we want.
ENTRYPOINT ["/entrypoint.sh"]
