# Cyrus Router Docker Deployment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the cyrus-router as a Docker image configured entirely by environment variables, with a compose file, a GHCR publish workflow on the `nick-boey/cyrus` fork, a guided setup skill, and docs.

**Architecture:** A multi-stage Dockerfile builds `cyrus-ai` from monorepo source (pnpm filtered install + `pnpm deploy`) into a slim runtime image. A Node entrypoint script generates `/data/router-config.json` from env vars, then spawns `cyrus router start --cyrus-home /data`. All state (config + SQLite DB) lives on a single `/data` volume. A new `GET /healthz` route in `packages/router` serves container health probes.

**Tech Stack:** Docker (multi-stage, node:22-slim), pnpm 10.33.1 via corepack, docker compose, GitHub Actions (docker/build-push-action → GHCR), Fastify (healthz route), Vitest.

**Spec:** `docs/superpowers/specs/2026-07-09-router-docker-design.md`

## Global Constraints

- Both Dockerfile stages use base image `node:22-slim`; pnpm is pinned to `10.33.1` via corepack (`packageManager` field in root `package.json`).
- Container state directory is `/data` (passed as `--cyrus-home /data`); it holds `router-config.json` and `router/router.db`.
- Env var contract (exact names): `LINEAR_WORKSPACE_ID`, `LINEAR_WORKSPACE_TOKEN`, `LINEAR_WEBHOOK_SECRET` (required trio), `CYRUS_ROUTER_PORT` (default `8787`), `CYRUS_ROUTER_HOST` (default `0.0.0.0`), `CYRUS_ROUTER_WEBHOOK_MODE` (default `direct`), `CYRUS_ROUTER_EVENT_TTL_MS`, `CYRUS_ROUTER_ISSUE_LOCK`, `CYRUS_ROUTER_CREATOR_ONLY_PROMPTING`, `CYRUS_ROUTER_HEARTBEAT_MS`, `CYRUS_ROUTER_WORKSPACES_JSON` (multi-workspace escape hatch), plus internal test seams `CYRUS_DATA_DIR`, `CYRUS_APP_PATH`.
- Published image name: `ghcr.io/${{ github.repository_owner }}/cyrus-router` (resolves to `ghcr.io/nick-boey/cyrus-router` on this fork).
- Skills must never `Read`/`Edit`/`Write` files containing secrets (`~/.cyrus/*`, `docker/router/.env`) — Bash-only interaction, per the convention at the top of `skills/cyrus-setup-router/SKILL.md`.
- All JS/TS (including `docker/router/entrypoint.mjs`) must pass `pnpm biome check <path>` (repo uses tabs).
- Work happens on the current `cyrus-router` branch; commit after every task.
- Docker Desktop / a Docker daemon must be running for Tasks 3–4 verification.

---

### Task 1: `GET /healthz` endpoint in RouterServer

**Files:**
- Modify: `packages/router/src/RouterServer.ts` (constructor, after the `registerEnrollmentRoute` call at line ~111)
- Test: `packages/router/test/RouterServer.test.ts`
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)

**Interfaces:**
- Consumes: existing `RouterServer` + the `makeServer()` helper already defined at the top of `RouterServer.test.ts`.
- Produces: `GET /healthz` → HTTP 200, body `{"status":"ok"}` — Tasks 3, 4, 6, and 7 probe this exact route and expect this exact body.

- [ ] **Step 1: Write the failing test**

Append to `packages/router/test/RouterServer.test.ts` (reuses the existing `makeServer` helper; same afterEach pattern as the `/enroll` suite):

```typescript
describe("RouterServer /healthz", () => {
	let server: RouterServer | undefined;

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = undefined;
		}
	});

	it("returns 200 ok for liveness probes", async () => {
		server = makeServer();
		await server.start();

		const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router test:run -- test/RouterServer.test.ts`
Expected: the new test FAILS with `expected 404 to be 200` (Fastify returns 404 for the unregistered route); the two `/enroll` tests still pass.

- [ ] **Step 3: Implement the route**

In `packages/router/src/RouterServer.ts`, directly after `registerEnrollmentRoute(this.fastify, this.store);` in the constructor:

```typescript
		// Liveness probe for container orchestrators (Docker HEALTHCHECK,
		// serverless platforms). Registered in the constructor because Fastify
		// v5 forbids adding routes once the server is listening.
		this.fastify.get("/healthz", async () => ({ status: "ok" }));
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter cyrus-router test:run` and `pnpm --filter cyrus-router typecheck`
Expected: all tests PASS, no type errors.

- [ ] **Step 5: Add changelog entry**

In `CHANGELOG.md` under `## [Unreleased]` → `### Added`, append:

```markdown
- The router now exposes a `GET /healthz` liveness endpoint for container health checks and uptime monitors.
```

- [ ] **Step 6: Commit**

```bash
git add packages/router/src/RouterServer.ts packages/router/test/RouterServer.test.ts CHANGELOG.md
git commit -m "feat(router): add GET /healthz liveness endpoint"
```

---

### Task 2: Container entrypoint script

**Files:**
- Create: `docker/router/entrypoint.mjs`

**Interfaces:**
- Consumes: the env var contract from Global Constraints; `cyrus-ai`'s CLI entry `dist/src/app.js` with global flag `--cyrus-home <path>` and subcommand `router start`.
- Produces: `/data/router-config.json` matching `RouterConfigFileSchema` in `apps/cli/src/commands/RouterCommand.ts` (`port: number`, `host?: string`, `workspaces: Record<string, {linearToken: string}>`, `webhook: {verificationMode: "direct"|"proxy", secret: string}`, optional `eventTtlMs`/`issueLock`/`creatorOnlyPrompting`/`heartbeatMs`). Task 3's Dockerfile sets this file as `ENTRYPOINT ["node", "/app/docker-entrypoint.mjs"]`.

- [ ] **Step 1: Write the entrypoint**

Create `docker/router/entrypoint.mjs` (tabs, biome style):

```javascript
#!/usr/bin/env node
/**
 * Container entrypoint for the Cyrus router image.
 *
 * Materializes <dataDir>/router-config.json from environment variables, then
 * spawns `cyrus router start` with --cyrus-home pointed at the data dir and
 * forwards SIGTERM/SIGINT so `docker stop` shuts the server down cleanly.
 *
 * Config precedence:
 *   1. Config env vars set and complete -> (re)generate router-config.json
 *      (env is the source of truth on every start).
 *   2. Config env vars set but incomplete -> exit 1 naming what is missing.
 *   3. No config env vars, router-config.json exists -> use the file as-is.
 *   4. Neither -> exit 1 listing the required variables.
 *
 * CYRUS_DATA_DIR and CYRUS_APP_PATH exist as test seams so this script can be
 * exercised outside the image; the Dockerfile relies on their defaults.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.CYRUS_DATA_DIR ?? "/data";
const APP_PATH = process.env.CYRUS_APP_PATH ?? "/app/dist/src/app.js";
const CONFIG_PATH = join(DATA_DIR, "router-config.json");

function fail(message) {
	console.error(`[entrypoint] ${message}`);
	process.exit(1);
}

/** workspaces map from env: JSON escape hatch wins over the single ID+token pair. */
function buildWorkspaces(env) {
	if (env.CYRUS_ROUTER_WORKSPACES_JSON) {
		let parsed;
		try {
			parsed = JSON.parse(env.CYRUS_ROUTER_WORKSPACES_JSON);
		} catch (error) {
			fail(`CYRUS_ROUTER_WORKSPACES_JSON is not valid JSON: ${error.message}`);
		}
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			fail(
				'CYRUS_ROUTER_WORKSPACES_JSON must be a JSON object: {"<workspace-id>": {"linearToken": "..."}}',
			);
		}
		return parsed;
	}
	if (env.LINEAR_WORKSPACE_ID && env.LINEAR_WORKSPACE_TOKEN) {
		return {
			[env.LINEAR_WORKSPACE_ID]: { linearToken: env.LINEAR_WORKSPACE_TOKEN },
		};
	}
	return undefined;
}

function generateConfig(env) {
	const anyProvided = Boolean(
		env.CYRUS_ROUTER_WORKSPACES_JSON ||
			env.LINEAR_WORKSPACE_ID ||
			env.LINEAR_WORKSPACE_TOKEN ||
			env.LINEAR_WEBHOOK_SECRET,
	);

	if (!anyProvided) {
		if (existsSync(CONFIG_PATH)) {
			console.log(
				`[entrypoint] no config env vars set — using existing ${CONFIG_PATH}`,
			);
			return;
		}
		fail(
			"missing required environment variables: LINEAR_WORKSPACE_ID, LINEAR_WORKSPACE_TOKEN, LINEAR_WEBHOOK_SECRET. " +
				`Set them (see docker/router/.env.example) or mount a router-config.json at ${CONFIG_PATH}.`,
		);
	}

	const workspaces = buildWorkspaces(env);
	const missing = [];
	if (!workspaces) {
		missing.push(
			"LINEAR_WORKSPACE_ID + LINEAR_WORKSPACE_TOKEN (or CYRUS_ROUTER_WORKSPACES_JSON)",
		);
	}
	if (!env.LINEAR_WEBHOOK_SECRET) {
		missing.push("LINEAR_WEBHOOK_SECRET");
	}
	if (missing.length > 0) {
		fail(`missing required environment variables: ${missing.join(", ")}`);
	}

	const config = {
		port: Number(env.CYRUS_ROUTER_PORT ?? 8787),
		host: env.CYRUS_ROUTER_HOST ?? "0.0.0.0",
		workspaces,
		webhook: {
			verificationMode: env.CYRUS_ROUTER_WEBHOOK_MODE ?? "direct",
			secret: env.LINEAR_WEBHOOK_SECRET,
		},
	};
	if (env.CYRUS_ROUTER_EVENT_TTL_MS) {
		config.eventTtlMs = Number(env.CYRUS_ROUTER_EVENT_TTL_MS);
	}
	if (env.CYRUS_ROUTER_ISSUE_LOCK) {
		config.issueLock = env.CYRUS_ROUTER_ISSUE_LOCK === "true";
	}
	if (env.CYRUS_ROUTER_CREATOR_ONLY_PROMPTING) {
		config.creatorOnlyPrompting =
			env.CYRUS_ROUTER_CREATOR_ONLY_PROMPTING === "true";
	}
	if (env.CYRUS_ROUTER_HEARTBEAT_MS) {
		config.heartbeatMs = Number(env.CYRUS_ROUTER_HEARTBEAT_MS);
	}

	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
		mode: 0o600,
	});
	// writeFileSync's mode only applies on creation; enforce on regeneration too.
	chmodSync(CONFIG_PATH, 0o600);
	console.log(`[entrypoint] wrote ${CONFIG_PATH} from environment variables`);
}

generateConfig(process.env);

const child = spawn(
	process.execPath,
	[APP_PATH, "--cyrus-home", DATA_DIR, "router", "start"],
	{ stdio: "inherit" },
);
for (const signal of ["SIGTERM", "SIGINT"]) {
	process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
	process.exit(code ?? (signal ? 1 : 0));
});
```

- [ ] **Step 2: Biome check**

Run: `pnpm biome check docker/router/entrypoint.mjs`
Expected: no errors (run `pnpm biome check --write docker/router/entrypoint.mjs` to autofix formatting if needed).

- [ ] **Step 3: Verify fail-fast with no env vars (precedence rule 4)**

```bash
TMP=$(mktemp -d) && CYRUS_DATA_DIR="$TMP" node docker/router/entrypoint.mjs; echo "exit=$?"
```
Expected: prints `[entrypoint] missing required environment variables: LINEAR_WORKSPACE_ID, LINEAR_WORKSPACE_TOKEN, LINEAR_WEBHOOK_SECRET. ...` and `exit=1`.

- [ ] **Step 4: Verify fail-fast with partial env (precedence rule 2)**

```bash
TMP=$(mktemp -d) && CYRUS_DATA_DIR="$TMP" LINEAR_WEBHOOK_SECRET=x node docker/router/entrypoint.mjs; echo "exit=$?"
```
Expected: `[entrypoint] missing required environment variables: LINEAR_WORKSPACE_ID + LINEAR_WORKSPACE_TOKEN (or CYRUS_ROUTER_WORKSPACES_JSON)` and `exit=1`.

- [ ] **Step 5: Verify config generation (precedence rule 1)**

`CYRUS_APP_PATH=/dev/null` makes the spawn run an empty script that exits immediately, so only the config write is exercised:

```bash
TMP=$(mktemp -d)
CYRUS_DATA_DIR="$TMP" CYRUS_APP_PATH=/dev/null \
  LINEAR_WORKSPACE_ID=ws-1 LINEAR_WORKSPACE_TOKEN=tok LINEAR_WEBHOOK_SECRET=sec \
  CYRUS_ROUTER_ISSUE_LOCK=false node docker/router/entrypoint.mjs
jq . "$TMP/router-config.json"
stat -f '%Lp' "$TMP/router-config.json"   # macOS; on Linux: stat -c '%a'
```
Expected: exit 0; JSON is `{"port": 8787, "host": "0.0.0.0", "workspaces": {"ws-1": {"linearToken": "tok"}}, "webhook": {"verificationMode": "direct", "secret": "sec"}, "issueLock": false}`; mode `600`.

- [ ] **Step 6: Verify mounted-config passthrough (precedence rule 3)**

Re-run against the same `$TMP` (config now exists) with no config env vars:

```bash
CYRUS_DATA_DIR="$TMP" CYRUS_APP_PATH=/dev/null node docker/router/entrypoint.mjs
```
Expected: exit 0, logs `no config env vars set — using existing .../router-config.json`.

- [ ] **Step 7: Commit**

```bash
git add docker/router/entrypoint.mjs
git commit -m "feat(docker): env-driven entrypoint for the router container"
```

---

### Task 3: Dockerfile, .dockerignore, and image smoke test

**Files:**
- Create: `docker/router/Dockerfile`
- Create: `.dockerignore` (repo root — build context is the repo root)

**Interfaces:**
- Consumes: `docker/router/entrypoint.mjs` (Task 2); `GET /healthz` (Task 1); root `package.json` `packageManager: pnpm@10.33.1`.
- Produces: image with `ENTRYPOINT ["node", "/app/docker-entrypoint.mjs"]`, `EXPOSE 8787`, `VOLUME /data`, and an admin shim at `/usr/local/bin/cyrus` (`cyrus router users add …` works inside the container). Tasks 4–7 rely on the shim and the `docker build -f docker/router/Dockerfile .` invocation.

- [ ] **Step 1: Write the root `.dockerignore`**

Keep every workspace `package.json` in context (pnpm's `--frozen-lockfile` validates the full importer set against `pnpm-lock.yaml`, so do NOT exclude any `apps/*` or `packages/*` directory wholesale). `skills/` must also stay in context: `packages/edge-worker/cyrus-skills-plugin/skills/*` are symlinks into it and the edge-worker build (`cp -rL`) dereferences them:

```
.git
node_modules
**/node_modules
**/dist
**/coverage
**/worktrees
**/.env
docs
spec
code
.claude
.codex
.opencode
.superpowers
.husky
.github
```

- [ ] **Step 2: Write `docker/router/Dockerfile`**

```dockerfile
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
```

- [ ] **Step 3: Build the image**

Run: `docker build -f docker/router/Dockerfile -t cyrus-router:dev .`
Expected: build succeeds. Known failure modes and their fixes (apply, don't improvise):
- `corepack: command not found` → add `RUN npm install -g corepack@latest` before `corepack enable`.
- `pnpm deploy` errors about `injectWorkspacePackages` even with `--legacy`, or `/out` is missing workspace deps' `dist/` → fall back per spec: replace the deploy line with `RUN pnpm --filter cyrus-ai... prune --prod` and change the runtime `COPY` to `COPY --from=build /repo /app` with the app path `/app/apps/cli/dist/src/app.js` (update the shim, entrypoint default `CYRUS_APP_PATH`, and HEALTHCHECK accordingly). Prefer making `--legacy` work first.

- [ ] **Step 4: Negative smoke test — missing env fails fast**

```bash
docker run --rm cyrus-router:dev; echo "exit=$?"
```
Expected: logs the `[entrypoint] missing required environment variables: …` message, `exit=1`.

- [ ] **Step 5: Positive smoke test — boot, probe, admin, clean stop**

```bash
docker run -d --name cyrus-router-smoke \
  -e LINEAR_WORKSPACE_ID=ws-test \
  -e LINEAR_WORKSPACE_TOKEN=lin_api_test \
  -e LINEAR_WEBHOOK_SECRET=whsec_test \
  -p 127.0.0.1:8787:8787 cyrus-router:dev
sleep 3
docker logs cyrus-router-smoke                       # expect: "Router server listening on port 8787"
curl -fsS http://127.0.0.1:8787/healthz              # expect: {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8787/enroll \
  -H 'content-type: application/json' -d '{"code":"bogus"}'   # expect: 401
docker exec cyrus-router-smoke cyrus router users add alice@example.com --name Alice
                                                     # expect: "Added alice@example.com." + an enrollment code
docker exec cyrus-router-smoke cyrus router users list
                                                     # expect: table row for alice@example.com, DEVICE ENROLLED "no"
time docker stop cyrus-router-smoke                  # expect: well under 10s (SIGTERM handled, not killed)
docker rm cyrus-router-smoke
```

- [ ] **Step 6: Verify healthcheck status**

```bash
docker run -d --name cyrus-router-hc \
  -e LINEAR_WORKSPACE_ID=ws-test -e LINEAR_WORKSPACE_TOKEN=t -e LINEAR_WEBHOOK_SECRET=s \
  cyrus-router:dev
sleep 35 && docker inspect --format '{{.State.Health.Status}}' cyrus-router-hc   # expect: healthy
docker rm -f cyrus-router-hc
```

- [ ] **Step 7: Commit**

```bash
git add .dockerignore docker/router/Dockerfile
git commit -m "feat(docker): multi-stage router image built from monorepo source"
```

---

### Task 4: docker-compose.yml + .env.example + gitignore guard

**Files:**
- Create: `docker/router/docker-compose.yml`
- Create: `docker/router/.env.example`
- Modify: `.gitignore` (add `docker/router/.env`)

**Interfaces:**
- Consumes: the Dockerfile (Task 3) via `build`, the env contract (Task 2), the `/usr/local/bin/cyrus` shim (Task 3).
- Produces: `docker compose` service named `cyrus-router`, volume `cyrus-router-data`, optional profile `tunnel`. Task 6's skill and Task 7's docs reference these names verbatim.

- [ ] **Step 1: Write `docker/router/docker-compose.yml`**

```yaml
services:
  cyrus-router:
    build:
      context: ../..
      dockerfile: docker/router/Dockerfile
    # To use the prebuilt image instead of building locally, comment out
    # `build:` above and uncomment:
    # image: ghcr.io/nick-boey/cyrus-router:latest
    env_file: .env
    ports:
      # Localhost-only: TLS/wss termination belongs to a fronting reverse
      # proxy or the cloudflared sidecar below, never the container itself.
      - "127.0.0.1:8787:8787"
    volumes:
      - cyrus-router-data:/data
    restart: unless-stopped

  # Optional public tunnel: docker compose --profile tunnel up -d
  # Point the Cloudflare tunnel's public hostname at http://cyrus-router:8787.
  cloudflared:
    profiles: [tunnel]
    image: cloudflare/cloudflared:latest
    command: tunnel run --token ${TUNNEL_TOKEN}
    restart: unless-stopped
    depends_on:
      - cyrus-router

volumes:
  cyrus-router-data:
```

- [ ] **Step 2: Write `docker/router/.env.example`**

```bash
# --- Required -----------------------------------------------------------
# Linear organization id (key under linearWorkspaces in ~/.cyrus/config.json
# after `cyrus self-auth-linear`).
LINEAR_WORKSPACE_ID=
# Workspace Linear token (linearWorkspaces.<id>.linearToken from the same file).
LINEAR_WORKSPACE_TOKEN=
# Webhook signing secret from the Linear OAuth app.
LINEAR_WEBHOOK_SECRET=

# --- Optional (defaults shown) -------------------------------------------
# CYRUS_ROUTER_PORT=8787
# CYRUS_ROUTER_HOST=0.0.0.0
# CYRUS_ROUTER_WEBHOOK_MODE=direct          # or "proxy" behind the Cyrus proxy
# CYRUS_ROUTER_EVENT_TTL_MS=172800000       # 48h queued-event TTL
# CYRUS_ROUTER_ISSUE_LOCK=true
# CYRUS_ROUTER_CREATOR_ONLY_PROMPTING=true
# CYRUS_ROUTER_HEARTBEAT_MS=30000
# Multi-workspace escape hatch (supersedes LINEAR_WORKSPACE_ID/_TOKEN):
# CYRUS_ROUTER_WORKSPACES_JSON={"<workspace-id>":{"linearToken":"..."}}

# --- cloudflared sidecar (only with: docker compose --profile tunnel up) --
# TUNNEL_TOKEN=
```

- [ ] **Step 3: Add the real env file to `.gitignore`**

Append to the repo root `.gitignore`:

```
docker/router/.env
```

- [ ] **Step 4: Validate compose config**

```bash
cd docker/router
printf 'LINEAR_WORKSPACE_ID=ws-test\nLINEAR_WORKSPACE_TOKEN=t\nLINEAR_WEBHOOK_SECRET=s\n' > .env
docker compose config --quiet && echo OK
```
Expected: `OK` (and a warning about `TUNNEL_TOKEN` being unset is acceptable).

- [ ] **Step 5: Verify persistence across container recreation**

```bash
cd docker/router
docker compose up -d --build
sleep 3
docker compose exec cyrus-router cyrus router users add alice@example.com --name Alice
docker compose down            # NOTE: no -v — the volume must survive
docker compose up -d
sleep 3
docker compose exec cyrus-router cyrus router users list   # expect: alice@example.com still listed
curl -fsS http://127.0.0.1:8787/healthz                    # expect: {"status":"ok"}
docker compose down
rm .env
```

- [ ] **Step 6: Commit**

```bash
git add docker/router/docker-compose.yml docker/router/.env.example .gitignore
git commit -m "feat(docker): compose file with persistent volume and optional cloudflared tunnel"
```

---

### Task 5: GHCR publish workflow

**Files:**
- Create: `.github/workflows/docker-router.yml`

**Interfaces:**
- Consumes: `docker/router/Dockerfile` + root `.dockerignore` (Task 3).
- Produces: multi-arch images at `ghcr.io/nick-boey/cyrus-router` with tags `latest` (default branch), `<branch>`, `v*` semver, and `sha-*`. Task 7's docs reference `ghcr.io/nick-boey/cyrus-router:latest`.

- [ ] **Step 1: Write `.github/workflows/docker-router.yml`**

```yaml
name: Docker Router Image

on:
  push:
    branches:
      - main
    tags:
      - 'v*'
  workflow_dispatch:

concurrency:
  group: docker-router-${{ github.ref }}
  cancel-in-progress: true

permissions:
  contents: read
  packages: write

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: docker/setup-qemu-action@v3

      - uses: docker/setup-buildx-action@v3

      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}

      - name: Extract image metadata
        id: meta
        uses: docker/metadata-action@v5
        with:
          images: ghcr.io/${{ github.repository_owner }}/cyrus-router
          tags: |
            type=ref,event=branch
            type=semver,pattern={{version}}
            type=semver,pattern={{major}}.{{minor}}
            type=sha
            type=raw,value=latest,enable={{is_default_branch}}

      - name: Build and push
        uses: docker/build-push-action@v6
        with:
          context: .
          file: docker/router/Dockerfile
          platforms: linux/amd64,linux/arm64
          push: true
          tags: ${{ steps.meta.outputs.tags }}
          labels: ${{ steps.meta.outputs.labels }}
          cache-from: type=gha
          cache-to: type=gha,mode=max
```

- [ ] **Step 2: Commit and push**

```bash
git add .github/workflows/docker-router.yml
git commit -m "ci: publish router Docker image to GHCR"
git push origin cyrus-router
```

- [ ] **Step 3: Dispatch the workflow from the branch and watch it**

```bash
gh workflow run docker-router.yml --ref cyrus-router
sleep 5
gh run list --workflow=docker-router.yml --limit 1
gh run watch $(gh run list --workflow=docker-router.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```
Expected: run completes successfully (first multi-arch run takes a while; QEMU arm64 is the slow leg).
Note: `workflow_dispatch` only becomes available once the workflow file exists on a pushed branch — the push in Step 2 is what enables it. If `gh workflow run` reports the workflow is not found, GitHub hasn't registered it yet: wait a minute, or check the repo's Actions tab and dispatch from there.

- [ ] **Step 4: Verify the published image**

```bash
docker pull ghcr.io/nick-boey/cyrus-router:cyrus-router
docker run --rm ghcr.io/nick-boey/cyrus-router:cyrus-router; echo "exit=$?"
```
Expected: pull succeeds (branch-name tag); run prints the missing-env-vars entrypoint error with exit 1 — proving the published image boots. If the pull is denied, the package is private: either `docker login ghcr.io` with a PAT (`read:packages`) or flip the package to public at https://github.com/users/nick-boey/packages/container/cyrus-router/settings.

---

### Task 6: Setup skill + fork in cyrus-setup-router

**Files:**
- Create: `skills/cyrus-setup-router-docker/SKILL.md`
- Modify: `skills/cyrus-setup-router/SKILL.md` (add the deployment-target fork right after the "Prerequisite context" blockquote, before "## Step 1")
- Create (via script): symlinks under `.claude/skills/`, `.codex/skills/`, `.opencode/skills/`

**Interfaces:**
- Consumes: compose service/volume names (Task 4), env contract (Task 2), `/healthz` (Task 1), GHCR image (Task 5), existing sub-skills `cyrus-setup-prerequisites`, `cyrus-setup-endpoint`, `cyrus-setup-linear`.
- Produces: skill name `cyrus-setup-router-docker` referenced from `cyrus-setup-router` and Task 7's docs.

- [ ] **Step 1: Write `skills/cyrus-setup-router-docker/SKILL.md`**

````markdown
---
name: cyrus-setup-router-docker
description: Set up a Cyrus router host as a Docker container — collect Linear credentials as environment variables, build or pull the router image, run it with docker compose, and enroll teammates. The container never runs Claude and never touches GitHub.
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.cyrus/.env`, `~/.cyrus/config.json`, `docker/router/.env`, or any file containing secrets. Use only `Bash` commands (`grep`, `jq`, `printf >>`, `cat > … <<'EOF'`, etc.) to interact with these files — secrets must never be read into the conversation context.**

# Setup Router Host (Docker)

Runs the Cyrus **router host** as a Docker container instead of a bare
`cyrus router start` process. Same responsibilities as the bare-metal router
(see `../cyrus-setup-router/SKILL.md` and `docs/ROUTER.md`): receive Linear
webhooks, route sessions to teammates' devices, enforce cross-user policy.
**It never runs Claude and never touches GitHub.**

All configuration is environment variables in `docker/router/.env`; all state
(config + SQLite db) lives in the `cyrus-router-data` Docker volume.

> **Prerequisite context.** Normally reached from `cyrus-setup-router` after
> the user chooses Docker deployment. The shared CRITICAL rules and Browser
> Automation guidance in `cyrus-setup/SKILL.md` apply here too.

---

## Step 1: Prerequisites

Docker replaces the Node/cyrus-ai install for the router itself:

```bash
docker version --format '{{.Server.Version}}' && docker compose version
```

- If Docker is missing, install Docker Engine (Linux) or Docker Desktop
  (macOS/Windows) and re-check.
- **Node.js is still needed once on the setup machine** for the Linear OAuth
  step below (`npx cyrus-ai self-auth-linear`), and `jq` for extracting the
  resulting credentials. Check with `node --version` and `which jq`.
- Decide the image source:
  - **Prebuilt (default):** `ghcr.io/nick-boey/cyrus-router:latest` — no
    clone needed beyond the `docker/router/` directory contents.
  - **Build from source:** a full clone of the repo (the compose file builds
    with the repo root as context).

## Step 2: Public Endpoint / Tunnel

Identical to the bare-metal router. **Read** `../cyrus-setup-endpoint/SKILL.md`
and follow its **router variant** (upstream port `8787`). Alternatively, use
the bundled cloudflared sidecar: create a Cloudflare Tunnel with a public
hostname pointing at `http://cyrus-router:8787`, and keep its token for
Step 4 (`TUNNEL_TOKEN`).

After this step you have a public router URL (`CYRUS_BASE_URL`), e.g.
`https://router.example.com`.

## Step 3: Linear OAuth App + Workspace Token

**Read** `../cyrus-setup-linear/SKILL.md` and follow it — webhook URL
`<CYRUS_BASE_URL>/linear-webhook`, callback `<CYRUS_BASE_URL>/callback`. The
one-time browser OAuth (`cyrus self-auth-linear`) cannot run inside the
container; run it on the setup machine via `npx cyrus-ai self-auth-linear`.

Then extract the values for the container env (do NOT print the secrets):

```bash
WS_ID=$(jq -r '.linearWorkspaces | keys[0]' ~/.cyrus/config.json)
LINEAR_TOKEN=$(jq -r --arg ws "$WS_ID" '.linearWorkspaces[$ws].linearToken' ~/.cyrus/config.json)
WEBHOOK_SECRET=$(grep '^LINEAR_WEBHOOK_SECRET=' ~/.cyrus/.env | cut -d= -f2-)
test -n "$WS_ID" && test -n "$LINEAR_TOKEN" && test -n "$WEBHOOK_SECRET" \
  && echo "✓ have workspace id, token, and webhook secret" \
  || echo "✗ missing one or more values — re-check Steps 2–3"
```

## Step 4: Write `docker/router/.env`

From the repo's `docker/router/` directory (still holding the shell vars):

```bash
cat > .env <<EOF
LINEAR_WORKSPACE_ID=$WS_ID
LINEAR_WORKSPACE_TOKEN=$LINEAR_TOKEN
LINEAR_WEBHOOK_SECRET=$WEBHOOK_SECRET
EOF
chmod 600 .env
echo "✓ wrote docker/router/.env"
```

Optional overrides (append only if needed): `CYRUS_ROUTER_PORT`,
`CYRUS_ROUTER_EVENT_TTL_MS`, `CYRUS_ROUTER_ISSUE_LOCK`,
`CYRUS_ROUTER_CREATOR_ONLY_PROMPTING`, `CYRUS_ROUTER_HEARTBEAT_MS`,
`CYRUS_ROUTER_WORKSPACES_JSON`, `TUNNEL_TOKEN` — see `.env.example`.

## Step 5: Launch

```bash
cd docker/router
docker compose up -d --build        # building from source
# or, using the prebuilt image (edit docker-compose.yml to use `image:`):
# docker compose pull && docker compose up -d
# with the cloudflared sidecar:
# docker compose --profile tunnel up -d --build
```

Verify:

```bash
curl -fsS http://127.0.0.1:8787/healthz    # → {"status":"ok"}
docker compose logs cyrus-router | tail -5 # → "Router server listening on port 8787"
```

`restart: unless-stopped` replaces pm2/systemd — the container survives
crashes and reboots (as long as the Docker daemon starts on boot).

## Step 6: Enroll Teammates

Same flow as bare-metal, wrapped in `docker compose exec`:

```bash
docker compose exec cyrus-router cyrus router users add alice@example.com --name "Alice"
```

Hand each person the printed one-time code (expires in 15 minutes) plus the
router URL; they finish with the `cyrus-setup-client` skill
(`cyrus connect <url> --code <code>`).

Management commands:

```bash
docker compose exec cyrus-router cyrus router users list
docker compose exec cyrus-router cyrus router users remove <email>
docker compose exec cyrus-router cyrus router devices revoke <email>
docker compose exec cyrus-router cyrus router unlock <issueId>
```

## Completion

> ✓ Router container running (`docker compose ps`), healthy (`/healthz`)
> ✓ Linear OAuth app webhook → `<CYRUS_BASE_URL>/linear-webhook`
> ✓ Config from `docker/router/.env`; state in the `cyrus-router-data` volume
> ✓ Teammates enrolled — each runs `/cyrus-setup` → **Client device**
>
> **Caveats:** exactly one replica (SQLite + in-memory WebSocket state — never
> scale horizontally); the volume must be a real local filesystem (no NFS/
> Azure Files/GCS FUSE — SQLite WAL is unsafe there).
````

- [ ] **Step 2: Add the fork to `skills/cyrus-setup-router/SKILL.md`**

Insert after the "Prerequisite context" blockquote (which ends at line 25, before `---`):

```markdown
> **Docker deployment.** To run the router as a Docker container instead of a
> bare process on this machine — configuration via environment variables,
> state in a Docker volume, prebuilt images from GHCR — **read**
> `../cyrus-setup-router-docker/SKILL.md` and follow it instead of the steps
> below. The Linear and endpoint steps are shared; only prerequisites,
> config, and launch differ.
```

- [ ] **Step 3: Create harness symlinks**

Run: `./scripts/symlink-skills.sh`
Expected output includes three `Linked .../cyrus-setup-router-docker -> ../../skills/cyrus-setup-router-docker` lines (one per harness dir).

- [ ] **Step 4: Commit**

```bash
git add skills/cyrus-setup-router-docker skills/cyrus-setup-router/SKILL.md \
  .claude/skills/cyrus-setup-router-docker .codex/skills/cyrus-setup-router-docker \
  .opencode/skills/cyrus-setup-router-docker
git commit -m "feat(skills): guided Docker deployment for the router host"
```

---

### Task 7: Docs + changelogs

**Files:**
- Modify: `docs/ROUTER.md` (new section between "Admin setup (the router host)" and "## Device setup (each client)", i.e. before line ~129)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)
- Modify: `CHANGELOG.internal.md` (`## [Unreleased]` → `### Added`)

**Interfaces:**
- Consumes: everything above — env contract (Task 2), image + shim (Task 3), compose names (Task 4), GHCR image (Task 5), skill name (Task 6).

- [ ] **Step 1: Add the Docker section to `docs/ROUTER.md`**

Insert before `## Device setup (each client)`:

````markdown
## Running the router in Docker

> **Guided path.** Run the `cyrus-setup-router-docker` skill. The steps below
> are the manual reference.

The router ships as a container image configured entirely by environment
variables. All state — the generated `router-config.json` and the SQLite
database — lives in a single volume mounted at `/data`.

### Quickstart (compose)

```bash
cd docker/router
cp .env.example .env      # fill in the three required values
docker compose up -d --build
curl -fsS http://127.0.0.1:8787/healthz   # → {"status":"ok"}
```

Or pull the prebuilt image instead of building: in `docker-compose.yml`,
replace the `build:` block with `image: ghcr.io/nick-boey/cyrus-router:latest`.
(If the GHCR package is private, `docker login ghcr.io` with a `read:packages`
PAT first — or make the package public once in its GitHub settings.)

Images are published by `.github/workflows/docker-router.yml`: `latest` on the
default branch, `v*` semver tags on releases, branch and `sha-*` tags for
everything else (amd64 + arm64).

### Environment variables

| Variable | Required | Default | Maps to (`router-config.json`) |
|----------|----------|---------|--------------------------------|
| `LINEAR_WORKSPACE_ID` | yes | — | key of `workspaces` |
| `LINEAR_WORKSPACE_TOKEN` | yes | — | `workspaces[id].linearToken` |
| `LINEAR_WEBHOOK_SECRET` | yes | — | `webhook.secret` |
| `CYRUS_ROUTER_PORT` | no | `8787` | `port` |
| `CYRUS_ROUTER_HOST` | no | `0.0.0.0` | `host` |
| `CYRUS_ROUTER_WEBHOOK_MODE` | no | `direct` | `webhook.verificationMode` |
| `CYRUS_ROUTER_EVENT_TTL_MS` | no | `172800000` | `eventTtlMs` |
| `CYRUS_ROUTER_ISSUE_LOCK` | no | `true` | `issueLock` |
| `CYRUS_ROUTER_CREATOR_ONLY_PROMPTING` | no | `true` | `creatorOnlyPrompting` |
| `CYRUS_ROUTER_HEARTBEAT_MS` | no | `30000` | `heartbeatMs` |
| `CYRUS_ROUTER_WORKSPACES_JSON` | no | — | full `workspaces` map (supersedes the ID/token pair) |

On every start, if the required variables are set the entrypoint regenerates
`/data/router-config.json` from them (env is the source of truth). With no
config variables set, an existing (e.g. bind-mounted) `router-config.json` is
used as-is. Neither → the container exits 1 naming the missing variables.

### Admin commands

The image bundles a `cyrus` shim pointing at `/data`:

```bash
docker compose exec cyrus-router cyrus router users add alice@example.com --name "Alice"
docker compose exec cyrus-router cyrus router users list
docker compose exec cyrus-router cyrus router devices revoke alice@example.com
docker compose exec cyrus-router cyrus router unlock <issueId>
```

### Deployment constraints

- **Exactly one replica.** SQLite plus in-memory WebSocket/device state means
  the router cannot scale horizontally. On serverless container platforms pin
  min = max = 1 instance, and confirm the platform supports WebSockets and
  long-lived connections.
- **The `/data` volume must be a real local filesystem.** Network-backed
  storage (Azure Files, GCS FUSE, EFS/NFS) is unsafe for SQLite WAL mode. A
  small VM running the compose file is the recommended default; serverless
  only with block-storage volumes.
- **TLS stays in front.** The container serves plain HTTP on 8787; put a
  TLS-terminating reverse proxy or the bundled cloudflared sidecar
  (`docker compose --profile tunnel up -d`) in front so devices can dial
  `wss://` and Linear can reach `https://…/linear-webhook`.
- **Backups:** the `cyrus-router-data` volume is the only state; snapshot it
  (or `sqlite3 /data/router/router.db ".backup …"`) to back up the router.
````

- [ ] **Step 2: Changelog entries**

`CHANGELOG.md` under `## [Unreleased]` → `### Added` (user-facing):

```markdown
- The router host can now run as a Docker container: configuration via environment variables, one persistent volume for all state, a compose file with an optional Cloudflare tunnel sidecar, and prebuilt images on GHCR. A guided `cyrus-setup-router-docker` skill walks through the whole setup. See "Running the router in Docker" in `docs/ROUTER.md`.
```

`CHANGELOG.internal.md` under `## [Unreleased]` → `### Added` (internal):

```markdown
- Docker deployment assets for the router: multi-stage `docker/router/Dockerfile` (pnpm filtered install + `pnpm deploy --legacy` from monorepo source, node:22-slim, non-root, HEALTHCHECK against `/healthz`), env-driven `entrypoint.mjs`, compose file + `.env.example`, root `.dockerignore`, and a GHCR publish workflow (`.github/workflows/docker-router.yml`, multi-arch, `ghcr.io/<owner>/cyrus-router`).
```

- [ ] **Step 3: Full verification sweep**

```bash
pnpm test:packages:run
pnpm typecheck
pnpm biome ci
```
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add docs/ROUTER.md CHANGELOG.md CHANGELOG.internal.md
git commit -m "docs(router): Docker deployment reference and changelog entries"
```
