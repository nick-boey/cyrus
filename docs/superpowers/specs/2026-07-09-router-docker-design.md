# Cyrus Router — Docker Deployment (design)

**Date:** 2026-07-09
**Status:** Approved for planning
**Scope:** New `docker/router/` build assets, a `GET /healthz` route in
`packages/router`, a `cyrus-setup-router-docker` skill, a GHCR publish workflow
in `.github/workflows/`, and a Docker section in `docs/ROUTER.md`.

## Problem

The router host (`cyrus router start`) currently assumes a hand-configured VM:
install Node + `cyrus-ai`, write `~/.cyrus/router-config.json` by hand or via
the `cyrus-setup-router` skill, keep the process alive with pm2/systemd. There
is no container path. We want to:

1. Collect the required configuration as **environment variables**.
2. Build a **Docker image** of the router from this monorepo.
3. Run it anywhere — a VM with compose, or a container platform — and publish
   it to **GHCR under the `nick-boey/cyrus` fork** so deploy targets can pull a
   prebuilt image.

### Architecture facts this design is built on (verified against code)

- `cyrus router start` (`apps/cli/src/commands/RouterCommand.ts`) reads
  `<cyrusHome>/router-config.json` (Zod-validated), opens SQLite at
  `<cyrusHome>/router/router.db` (better-sqlite3, WAL), and serves everything —
  `/linear-webhook`, `POST /enroll`, and the device WebSocket upgrade — on a
  single Fastify port (default `8787`).
- Default bind host is `127.0.0.1` (`RouterServer.ts:177`); a container must
  bind `0.0.0.0`. `host` is already a supported config field.
- `cyrusHome` defaults to `~/.cyrus` and is overridable with the global
  `--cyrus-home <path>` CLI flag (`apps/cli/src/app.ts`). The `CYRUS_HOME` env
  var is only honoured for the bootstrap `.env` preload, **not** for the actual
  home resolution — so the container invokes `--cyrus-home /data` explicitly.
- Admin subcommands (`users add/list/remove`, `devices revoke`, `unlock`) open
  the SQLite file directly; WAL makes this safe alongside a running server. In
  Docker they run via `docker exec` in the same container.
- `RouterCommand.start()` installs SIGINT/SIGTERM handlers that call
  `server.stop()` — clean shutdown works if the node process is PID 1.
- Fastify v5 forbids registering routes after `listen()` (already documented in
  `RouterServer.ts`), so the new `/healthz` route registers in the constructor.
- `better-sqlite3` is in `pnpm-workspace.yaml` `onlyBuiltDependencies`; it ships
  prebuilt glibc binaries for Node 22 on linux amd64/arm64, so `node:22-slim`
  (Debian) needs no compiler toolchain at runtime.
- `cyrus-ai@0.2.66` (router included) is published to npm, but we build from
  source so the image can carry unreleased router changes on this branch.

## Decisions (settled with the user)

| Decision | Choice |
|----------|--------|
| Image source | **Build from monorepo source** (multi-stage pnpm build), not `npm install -g cyrus-ai` |
| Env → config | **Entrypoint script generates `router-config.json`** from env vars; no product config-loading changes |
| Scope | Dockerfile + compose + setup skill + docs + `/healthz` endpoint + GHCR workflow |
| Registry | `ghcr.io/<repository_owner>/cyrus-router` (resolves to `ghcr.io/nick-boey/cyrus-router` on the fork) |

## Detailed design

### 1. Image — `docker/router/Dockerfile` + root `.dockerignore`

Multi-stage, both stages `node:22-slim` (same glibc → native modules built in
the builder run unmodified in the runtime stage):

**Builder stage**

```dockerfile
FROM node:22-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable                     # pins pnpm@10.33.1 via packageManager
WORKDIR /repo
COPY . .
RUN pnpm install --filter cyrus-ai... --frozen-lockfile
RUN pnpm --filter cyrus-ai... build
RUN pnpm --filter cyrus-ai deploy --prod --legacy /out
```

- `--filter cyrus-ai...` scopes install/build to the CLI and its workspace
  dependency graph — `apps/electron` and other non-dependencies are skipped.
- `pnpm deploy --legacy` produces a self-contained production bundle (workspace
  deps copied, dev deps pruned). `--legacy` avoids flipping
  `injectWorkspacePackages: true` repo-wide, which pnpm 10's default deploy mode
  would require. **Validate during implementation**; fallback if deploy
  misbehaves: `pnpm install --prod --filter cyrus-ai...` in place and copy the
  workspace (bigger image, same behavior).

**Runtime stage**

```dockerfile
FROM node:22-slim
RUN useradd --create-home --uid 1001 cyrus \
 && mkdir /data && chown cyrus:cyrus /data
COPY --from=build /out /app
COPY docker/router/entrypoint.mjs /app/docker-entrypoint.mjs
USER cyrus
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e 'fetch("http://127.0.0.1:"+(process.env.CYRUS_ROUTER_PORT??8787)+"/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'
ENTRYPOINT ["node", "/app/docker-entrypoint.mjs"]
```

- Node cannot `exec` in-place, so the entrypoint writes the config, then spawns
  `node /app/dist/src/app.js --cyrus-home /data router start` with
  `stdio: "inherit"`, forwards SIGTERM/SIGINT to the child, and exits with the
  child's exit code. (Alternative considered: a bash entrypoint ending in
  `exec node …` — rejected to keep JSON generation in Node and avoid shell
  escaping bugs; signal forwarding is a few lines.)
- `/data` (owned by `cyrus`) holds the generated `router-config.json` (mode
  `600`) and `router/router.db`. One volume persists all state.

**Root `.dockerignore`**: `node_modules`, `**/dist`, `.git`, `worktrees`,
`docs`, `spec`, `code`, `apps/electron`, test artifacts — keeps the build
context small and cache-stable.

### 2. Entrypoint — `docker/router/entrypoint.mjs`

Env contract:

| Env var | Required | Default | Maps to |
|---------|----------|---------|---------|
| `LINEAR_WORKSPACE_ID` | yes* | — | key of `workspaces` |
| `LINEAR_WORKSPACE_TOKEN` | yes* | — | `workspaces[id].linearToken` |
| `LINEAR_WEBHOOK_SECRET` | yes* | — | `webhook.secret` |
| `CYRUS_ROUTER_PORT` | no | `8787` | `port` |
| `CYRUS_ROUTER_HOST` | no | `0.0.0.0` | `host` |
| `CYRUS_ROUTER_WEBHOOK_MODE` | no | `direct` | `webhook.verificationMode` |
| `CYRUS_ROUTER_EVENT_TTL_MS` | no | upstream default | `eventTtlMs` |
| `CYRUS_ROUTER_ISSUE_LOCK` | no | upstream default | `issueLock` (`"true"`/`"false"`) |
| `CYRUS_ROUTER_CREATOR_ONLY_PROMPTING` | no | upstream default | `creatorOnlyPrompting` |
| `CYRUS_ROUTER_HEARTBEAT_MS` | no | upstream default | `heartbeatMs` |
| `CYRUS_ROUTER_WORKSPACES_JSON` | no | — | full `workspaces` map (multi-workspace escape hatch; supersedes the `LINEAR_WORKSPACE_ID`/`_TOKEN` pair) |

\* required unless `CYRUS_ROUTER_WORKSPACES_JSON` (for the workspace pair) or a
mounted config file (see precedence) is provided.

Precedence, in order:

1. Required env vars present → **(re)generate** `/data/router-config.json`
   (env is the source of truth on every start; mode `600`).
2. Env vars absent, `/data/router-config.json` exists → use it as-is (mounted
   config file path still works).
3. Neither → exit 1 with a message listing exactly which vars are missing.

Optional vars are only written into the JSON when set, so upstream defaults in
`RouterCommand`/`RouterServer` stay authoritative.

### 3. Compose — `docker/router/docker-compose.yml` + `.env.example`

```yaml
services:
  cyrus-router:
    build: { context: ../.., dockerfile: docker/router/Dockerfile }
    # or: image: ghcr.io/nick-boey/cyrus-router:latest
    env_file: .env
    ports: ["127.0.0.1:8787:8787"]
    volumes: [cyrus-router-data:/data]
    restart: unless-stopped

  cloudflared:
    profiles: [tunnel]
    image: cloudflare/cloudflared:latest
    command: tunnel run --token ${TUNNEL_TOKEN}
    restart: unless-stopped
    depends_on: [cyrus-router]

volumes:
  cyrus-router-data:
```

- Port published to localhost only; TLS/`wss://` stays with a fronting reverse
  proxy or the optional `cloudflared` sidecar (`docker compose --profile tunnel
  up -d`, tunnel target `http://cyrus-router:8787`).
- `.env.example` documents every variable from the entrypoint contract plus
  `TUNNEL_TOKEN`.
- Admin flows: `docker compose exec cyrus-router node /app/dist/src/app.js
  --cyrus-home /data router users add alice@example.com --name "Alice"` (the
  skill and docs wrap this so nobody types it by hand).

### 4. Healthcheck endpoint — `packages/router` (product change)

- `GET /healthz` → `200 {"status":"ok"}`, registered in the `RouterServer`
  constructor next to `registerEnrollmentRoute`.
- Unit test in `packages/router/test/RouterServer.test.ts`.
- `CHANGELOG.md` (user-facing: router exposes a health endpoint) — the rest of
  this design is deployment assets and goes in `CHANGELOG.internal.md`.

### 5. Setup skill — `skills/cyrus-setup-router-docker/SKILL.md`

A sibling of `cyrus-setup-router`, same conventions (secrets never Read into
context; `Bash`-only interaction with secret files; symlinked into harness
dirs via `scripts/symlink-skills.sh`). `cyrus-setup-router` gains an early
fork: "Run the router directly on this machine, or as a Docker container?" —
Docker dispatches to the new skill.

Flow:

1. **Prerequisites:** Docker Engine + compose plugin (not Node/cyrus-ai for the
   router itself); a clone of this repo for the build context — or skip the
   clone entirely when pulling the GHCR image.
2. **Public endpoint:** reuse `cyrus-setup-endpoint` (router variant, upstream
   port `8787`), or choose the `cloudflared` compose profile.
3. **Linear OAuth app + workspace token:** reuse `cyrus-setup-linear`. The
   one-time `self-auth-linear` browser flow runs on the setup machine via
   `npx cyrus-ai self-auth-linear` (a headless container cannot complete
   browser OAuth). Extract `LINEAR_WORKSPACE_ID` / `LINEAR_WORKSPACE_TOKEN`
   from `~/.cyrus/config.json` with `jq`; `LINEAR_WEBHOOK_SECRET` comes from
   the OAuth-app step.
4. **Write `docker/router/.env`** via Bash heredoc (chmod `600`).
5. **Launch:** `docker compose up -d --build` (or `pull` + `up -d` for the GHCR
   image), verify `GET /healthz` returns 200, then enroll teammates via the
   `docker compose exec … users add` wrapper. Hand each teammate the code +
   router URL; they proceed with `cyrus-setup-client` unchanged.

### 6. Docs — `docs/ROUTER.md` "Docker deployment" section

- Env var reference table (same as §2), quickstart for both compose-with-build
  and GHCR-pull paths, admin-via-`docker exec` commands, volume backup note.
- **Deployment caveats, stated explicitly:**
  - **Exactly one replica.** SQLite + in-memory WebSocket/device state means
    the router cannot scale horizontally. Serverless platforms must pin
    min=max=1 instances and support WebSockets + long-lived connections.
  - **SQLite WAL needs a real local filesystem.** Network-backed volumes
    (Azure Files, GCS FUSE, EFS) are unsafe for WAL mode. A small VM with the
    compose file is the recommended default; serverless only with block
    storage.
  - **Private GHCR packages** need `docker login ghcr.io` with a read-only PAT
    on each deploy target; making the package public removes that step.

### 7. GHCR publish workflow — `.github/workflows/docker-router.yml`

- **Triggers:** push to `main`, tags `v*`, and `workflow_dispatch` (publish
  from any branch — e.g. `cyrus-router` — while this is fork-only work).
- **Permissions:** `contents: read, packages: write`; login to `ghcr.io` with
  the built-in `GITHUB_TOKEN` (no PAT/secret setup).
- **Image:** `ghcr.io/${{ github.repository_owner }}/cyrus-router`.
- **Tags** (`docker/metadata-action`): `latest` on the default branch, semver
  from git tags, branch name, and commit SHA.
- **Build** (`docker/build-push-action`): context `.`, file
  `docker/router/Dockerfile`, platforms `linux/amd64,linux/arm64` (QEMU via
  `docker/setup-qemu-action`; better-sqlite3 prebuilds keep emulated builds
  cheap), `cache-from/to: type=gha`. Drop arm64 later if build times hurt.

## Error handling

- Entrypoint fails fast (exit 1, names the missing vars) when neither env vars
  nor a mounted config are present; malformed `CYRUS_ROUTER_WORKSPACES_JSON`
  is a fatal parse error with a clear message.
- Config validation stays where it is: `RouterCommand.start()`'s Zod schema
  rejects a bad generated config with its existing error path — the entrypoint
  does not duplicate validation.
- SIGTERM (docker stop / platform scale-down): entrypoint forwards to the
  child; `RouterCommand`'s handler stops the server cleanly; default 10s grace
  is sufficient.
- Docker `HEALTHCHECK` + `restart: unless-stopped` handle crash recovery.

## Testing & verification

1. Existing suites: `pnpm test:packages:run`, `pnpm typecheck` (covers the new
   `/healthz` test).
2. Local image build (`docker build -f docker/router/Dockerfile .`), then boot
   with a synthetic `.env` and assert:
   - `GET /healthz` → 200,
   - `POST /enroll` with garbage → 4xx (proves routes are live),
   - `users add`/`users list` via `docker exec`,
   - state survives `docker compose down && up` (volume persistence),
   - `docker stop` exits cleanly within the grace period.
3. Missing-env negative test: container exits 1 and names the missing vars.
4. Workflow: validated on the fork via `workflow_dispatch` from the
   `cyrus-router` branch; confirm the package appears at
   `ghcr.io/nick-boey/cyrus-router` and `docker pull` of the SHA tag works.

## Out of scope

- Containerizing client devices or the single-host worker (sessions need local
  credentials/worktrees — a different problem).
- Kubernetes manifests / Helm.
- Changing `RouterCommand` to read env vars natively (superseded by the
  entrypoint approach; can be revisited if non-Docker users want it).
- TLS termination inside the container (stays with the fronting proxy/tunnel).
