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
RUN useradd --create-home --uid 1001 cyrus \
	&& mkdir /data && chown cyrus:cyrus /data \
	&& printf '#!/bin/sh\nexec node /app/dist/src/app.js --cyrus-home /data "$@"\n' > /usr/local/bin/cyrus \
	&& chmod +x /usr/local/bin/cyrus
COPY --from=build /out /app
COPY docker/router/entrypoint.mjs /app/docker-entrypoint.mjs
USER cyrus
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
	CMD node -e 'fetch("http://127.0.0.1:"+(process.env.CYRUS_ROUTER_PORT??8787)+"/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
ENTRYPOINT ["node", "/app/docker-entrypoint.mjs"]
