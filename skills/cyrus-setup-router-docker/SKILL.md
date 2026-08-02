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
one-time browser OAuth cannot run inside the container; run it on the setup
machine, **before `docker compose up`**, with the router port set inline:

```bash
CYRUS_SERVER_PORT=8787 npx cyrus-ai self-auth-linear
```

`self-auth-linear` binds its temporary callback server to
`CYRUS_SERVER_PORT || 3456`, but the tunnel forwards `<CYRUS_BASE_URL>/callback`
to `8787`. Without the inline override the redirect reaches nothing and the
command waits forever. The container must not be running yet, or it will already
hold `8787`. If `~/.cyrus/config.json` does not exist, seed it first —
`self-auth-linear` exits with `Config file not found` otherwise:

```bash
[ -f ~/.cyrus/config.json ] || printf '{\n\t"repositories": []\n}\n' > ~/.cyrus/config.json
```

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

From the repo root (still holding the shell vars):

```bash
cd docker/router
cat > .env <<EOF
LINEAR_WORKSPACE_ID=$WS_ID
LINEAR_WORKSPACE_TOKEN=$LINEAR_TOKEN
LINEAR_WEBHOOK_SECRET=$WEBHOOK_SECRET
EOF
chmod 600 .env
echo "✓ wrote docker/router/.env"
```

Optional overrides (append only if needed): `CYRUS_ROUTER_PORT`,
`CYRUS_ROUTER_HOST`, `CYRUS_ROUTER_WEBHOOK_MODE`,
`CYRUS_ROUTER_EVENT_TTL_MS`, `CYRUS_ROUTER_ISSUE_LOCK`,
`CYRUS_ROUTER_CREATOR_ONLY_PROMPTING`, `CYRUS_ROUTER_HEARTBEAT_MS`,
`CYRUS_ROUTER_WORKSPACES_JSON`, `TUNNEL_TOKEN` — see `.env.example`.

## Step 5: Launch

```bash
cd docker/router
docker compose up -d --build        # building from source
# or, using the prebuilt image (in docker-compose.yml, comment out the
# `build:` block and uncomment `image:`):
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
