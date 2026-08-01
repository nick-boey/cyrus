# Router Mode — Per-User Device Routing

Router mode runs Cyrus sessions **on each team member's own machine**, using
that machine's native credentials (cloud CLI logins like `az`/`gcloud`/`aws`,
`gh`, SSH keys, and a local Claude subscription), while a single always-on
**router host** handles Linear OAuth, webhooks, and cross-user policy.

This is a sibling deployment model to the single-host setup in
[SELF_HOSTING.md](./SELF_HOSTING.md). In self-hosting, one machine receives
webhooks *and* runs every session under one identity. In router mode those two
responsibilities are split:

- The **router host** owns the Linear app token, the webhook endpoint, the
  device registry, and the durable event queue. It never runs Claude.
- Each **client device** enrolls once, then receives its owner's agent sessions
  over an authenticated WebSocket and runs them locally.

```
Linear ──webhook──▶  Router host  ──WebSocket──▶  Alice's laptop  (runs Alice's sessions)
                     (OAuth,                 └──▶  Bob's laptop    (runs Bob's sessions)
                      queue, policy)
```

## Why router mode

- **Native, per-user credentials.** A session that Alice delegates runs as Alice
  on Alice's machine — her cloud logins, her SSH keys, her Claude subscription.
  No shared service account, no secret injection.
- **Attributed Linear tool use.** The agent's Linear reads/writes are performed
  through Alice's own locally-OAuth'd Linear MCP, so sub-issues and comments are
  attributed to her and scoped to her real Linear permissions.
- **Graceful offline behavior.** If a device is offline, its owner's events queue
  on the router and the user is told loudly (an activity is posted to the Linear
  session). Work resumes automatically when the device reconnects.

## What it is not

Router mode does **not** synchronize live worktrees between machines. The git
remote is the sync layer (see [Worktree continuity](#worktree-continuity)).
There is no hybrid fallback that runs an offline user's session elsewhere, and a
single router serves a single Linear workspace unless you configure multiple
`workspaces` entries.

---

## Admin setup (the router host)

> **Guided path.** Run `/cyrus-setup` and choose **Router host** at the mode
> prompt (or invoke the `cyrus-setup-router` skill directly). It walks through
> everything in this section — prerequisites, the tunnel (pointed at the router
> port), the Linear OAuth app, writing `router-config.json`, starting the router,
> and enrolling teammates. The steps below are the manual reference.

Pick a machine that stays on (a small VPS or an always-on box). It needs the
same Linear OAuth app + public webhook URL you would set up for self-hosting —
follow [SELF_HOSTING.md](./SELF_HOSTING.md) to obtain the workspace Linear token
and webhook secret, then configure the router instead of the single-host worker.
A router host **never runs Claude and never needs GitHub** — git operations
happen on each client device with that person's own `gh` credentials.

### 1. Write `router-config.json`

The router reads `~/.cyrus/router-config.json` (JSON). Minimal shape:

```json
{
  "port": 8787,
  "workspaces": {
    "<linear-organization-id>": { "linearToken": "<workspace-linear-token>" }
  },
  "webhook": { "verificationMode": "direct", "secret": "<linear-webhook-secret>" }
}
```

Optional fields (with defaults):

| Field | Default | Meaning |
|-------|---------|---------|
| `eventTtlMs` | `172800000` (48h) | How long a queued event lives before it expires and the user is asked to re-delegate. |
| `issueLock` | `true` | Reject a second session on an issue already being worked (see [Issue lock](#issue-lock)). |
| `creatorOnlyPrompting` | `true` | Only the session's creator may send it new prompts (see [Creator-only prompting](#creator-only-prompting)). |
| `heartbeatMs` | `30000` | WebSocket keepalive interval. The router terminates a socket that misses two consecutive pings, and advertises this value in `hello_ack` so each device's watchdog gives up at the same point (see [Device liveness watchdog](#device-liveness-watchdog)). |
| `host` | `127.0.0.1` | Bind address. Put the router behind a TLS-terminating reverse proxy for `wss://`. |

- `verificationMode: "direct"` verifies Linear's webhook signature with `secret`.
  Use `"proxy"` (Bearer token) if the router sits behind the Cyrus proxy.
- The database lives at `~/.cyrus/router/router.db` (SQLite, WAL mode). It holds
  the user/device registry, the per-device event queue, and issue locks.

### 2. Start the router

```bash
cyrus router start
```

The process listens on the configured port and stays up (Ctrl-C / SIGTERM shuts
it down cleanly). Put it behind a process manager (systemd, pm2) and a
TLS-terminating reverse proxy so devices can dial `wss://router.example.com`.

### 3. Enroll each teammate

For every person who should run sessions on their own machine:

```bash
cyrus router users add alice@example.com --name "Alice"
```

This registers the user (keyed by their Linear email/identity) and prints a
**one-time enrollment code that expires in 15 minutes**. Hand the code to that
person out-of-band (chat/DM) along with the router URL. They finish enrollment
with `cyrus connect` (below).

Admin management commands (all operate directly on the SQLite db, safe to run
alongside a live `router start`):

```bash
cyrus router users list                 # show users + device + running/locked session counts
cyrus router users remove <email>       # remove a user (and their device)
cyrus router devices list               # show enrolled devices and who owns them
cyrus router devices revoke <email>     # revoke a user's device token
cyrus router sessions list              # show running + locked sessions (Linear issue id + session GUID)
cyrus router unlock <issueId|PAR-123>   # release a stuck issue lock (GUID or Linear identifier)
```

To release a stuck lock, the simplest path is the human identifier straight from
Linear: `cyrus router unlock PAR-169`. The router resolves the identifier to the
issue's GUID via Linear (using a workspace token from `router-config.json`) and
releases the matching lock. You can still pass the raw GUID — run
`cyrus router sessions list` and copy the `ISSUE ID` column — which needs no
Linear token and works even when identifier resolution can't (e.g. an expired
token). Sessions shown as `stranded` are leaked locks
with no live session behind them and are the usual unlock candidates.

Re-running `users add` for someone who is already enrolled mints a fresh code;
redeeming it **replaces** their device and immediately invalidates the old
token.

### Optional Entra-gated enrollment

Entra authentication can protect `POST /enroll` in addition to the one-time
code. Create **one app registration per router deployment** so a token issued
for one router cannot be replayed against another router in the same tenant:

1. In Microsoft Entra admin center, create a single-tenant app registration for
   the router deployment.
2. Under **Expose an API**, accept or set its Application ID URI (normally
   `api://<client-id>`). This URI is the router audience.
3. Confirm the exact URI with:

   ```bash
   az ad app show --id <client-id> --query identifierUris
   ```

4. Add the following block to `router-config.json` (or set the corresponding
   `CYRUS_ROUTER_ENTRA_TENANT_ID`, `CYRUS_ROUTER_ENTRA_AUDIENCE`, and optional
   `CYRUS_ROUTER_ENTRA_ALLOWED_DOMAIN` container environment variables):

   ```json
   {
     "entra": {
       "tenantId": "<tenant-guid>",
       "audience": "api://<client-id>",
       "allowedDomain": "example.com"
     }
   }
   ```

Users first run `az login`, then pass the same Application ID URI when
connecting:

```bash
cyrus connect https://router.example.com --code <code> --entra api://<client-id>
```

The CLI non-interactively requests `<audience>/.default` with
`az account get-access-token`. The router verifies the token signature, expiry,
exact audience, and tenant issuer, binds the code to the token's email, and, if
configured, compares the exact lowercased email domain. With no `entra` block,
enrollment remains code-only.

---

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
default branch, `v*` semver tags on releases, and — on manual `workflow_dispatch`
runs — branch and `sha-*` tags (amd64 + arm64).

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
| `CYRUS_ROUTER_ENTRA_TENANT_ID` | no | — | `entra.tenantId` (requires audience) |
| `CYRUS_ROUTER_ENTRA_AUDIENCE` | no | — | `entra.audience` Application ID URI (requires tenant) |
| `CYRUS_ROUTER_ENTRA_ALLOWED_DOMAIN` | no | — | `entra.allowedDomain` exact email domain |
| `CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL` | no | — | `linearTokenStore.keyVaultUrl` — durable store for rotated Linear OAuth tokens |

On every start, if the required variables are set the entrypoint regenerates
`/data/router-config.json` from them. With no config variables set, an existing
(e.g. bind-mounted) `router-config.json` is used as-is. Neither → the container
exits 1 naming the missing variables.

**Exception — Linear OAuth tokens.** Env is *not* the source of truth for
`linearToken` / `linearRefreshToken` when `CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL`
is set. Linear rotates the refresh token on every use and access tokens live
24 hours, so a config regenerated from a fixed env value replays an
already-consumed token and fails permanently with HTTP 400. The router
therefore persists each rotated pair to Key Vault and prefers the stored value
at startup — unless the env/config refresh token has changed, which is read as
a deliberate re-authorization and resets the chain. To re-authorize: run
`cyrus self-auth-linear`, update the env/Key Vault seed, and restart.

If you change the router port — via `CYRUS_ROUTER_PORT` or a mounted config — set `CYRUS_ROUTER_PORT` in the container environment either way (the image's HEALTHCHECK reads it) and adjust the compose port mapping to match.

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

---

## Azure hosting and ACA Sandboxes

The maintained Azure deployment in [`infra/azure/`](../infra/azure/README.md)
runs the router as one Azure Container App replica and gives selected users one
Azure Container Apps (ACA) Sandbox per issue. Set the executor with:

```bash
cyrus router users set-executor alice@example.com aca
```

Both the router and worker image refs must be pinned to an **immutable**
reference — a digest, a release tag (`v1.2.3`), or a git-SHA tag
(`sha-a1b2c3d`). Terraform rejects mutable tags such as `:latest` or `:deploy`:
a floating tag leaves the tag string in state unchanged while the registry
re-points it, so a later unrelated `terraform apply` can silently roll the router
backwards onto an older build. See
[Router image tag policy](../infra/azure/README.md#router-image-tag-policy) for
the build/push/pin runbook and for reconciling a hand-patched Container App.

The Terraform stack produces the complete `containers` configuration. Its ACA
provider needs a pre-registered worker disk image and these provider fields:

```json
{
  "containers": {
    "image": "ghcr.io/your-org/cyrus-worker:tag",
    "routerUrlForContainers": "wss://<router-fqdn>",
    "repositories": [{
      "name": "repo",
      "githubSlug": "org/repo",
      "linearWorkspaceId": "<workspace-id>",
      "baseBranch": "main"
    }],
    "keyVaultUrl": "https://<vault>.vault.azure.net",
    "aca": {
      "subscriptionId": "<subscription-guid>",
      "resourceGroup": "<resource-group>",
      "sandboxGroup": "<sandbox-group>",
      "region": "australiaeast",
      "disk": "cyrus-worker",
      "cpu": "4000m",
      "memory": "8192Mi",
      "autoSuspendSeconds": 0,
	  "keepSnapshots": 2,
	  "disconnectedRecreateMs": 120000
    }
  },
  "backup": {
    "blobContainerUrl": "https://<account>.blob.core.windows.net/router-backups",
    "intervalMs": 300000
  }
}
```

### Observed ACA behavior

- Sandboxes have server-assigned GUIDs, not operator-selected names. Cyrus maps
  issues exclusively through labels (`cyrus.managed`, `cyrus.issue`,
  `cyrus.disk`, and `cyrus.device-id`); label values are limited to 63
  characters. The sandbox-group ARM resource is `properties: {}`. It has no
  `maxSandboxCount`, `defaultCpu`, `defaultMemory`, or `defaultDisk` properties;
  resource sizing and lifecycle policy are applied to each sandbox.
- Memory-mode resume measured **0.52 seconds** in the 2026-07-26 spike. Suspend
  took 6.47 seconds and delivered **no SIGTERM**: processes freeze in place, so
  there is no Docker-style shutdown grace in which to force a final flush.
  Cyrus therefore keeps periodic/session-end floor sync enabled and tolerates a
  frozen upload until the next retry.
- ACA's `Running` state describes infrastructure, not worker health. An
  entrypoint can exit while `tini` leaves the sandbox `Running`; Cyrus also
  checks router WSS state and recreates workers disconnected longer than
  `disconnectedRecreateMs` (default 120 seconds). The grace tolerates startup
  and transient disconnects, and connected workers are never replaced.
- The same rule applies to a **resume**. `resumeSandbox` returning is only an
  infrastructure signal, so after resuming the provider polls the router's device
  connectivity every `resumeConnectPollMs` (default 2 seconds) for up to
  `resumeConnectTimeoutMs` (default 90 seconds — comfortably longer than the two
  heartbeats the device's own watchdog needs to notice its frozen socket). A
  worker that rejoins is kept; one that never does is replaced immediately rather
  than leaving queued work stranded. Set `resumeConnectTimeoutMs: 0` to skip the
  check and trust ACA's state alone.
- `autoSuspendSeconds` defaults to `0`. ACA auto-suspend has no Cyrus session
  affinity gate, and snapshot restore otherwise resets it to ACA's 300-second
  default. The provider reapplies the disabled policy on every create path;
  `idleStopMs` remains the recommended, affinity-aware controller.
- Egress defaults to **Deny** with `Full` inspection and an HTTP/WSS allowlist
  for the router, GitHub, Anthropic API and OAuth refresh, Linear, and supported
  package registries. The spike confirmed WSS works. Blocked HTTP hosts return
  403. `Full` inspection blocks non-HTTP TCP/UDP, including SSH on port 22, so
  `git@...` and `git+ssh://` remotes/submodules are unsupported; use HTTPS.
- Explicit snapshots preserve memory, disk, and environment, including the
  device token. Cyrus restores one only when its `cyrus.device-id` lineage
  matches the current row. Azure does not garbage-collect explicit snapshots;
  `keepSnapshots` prunes per issue and `cyrus router containers gc-snapshots`
  plans orphan cleanup (`--yes` applies it). Published pricing does not identify
  a snapshot-storage meter, so snapshot cost after preview is unquantified, not
  proven to be free or equivalent to ordinary Blob pricing.

### Key Vault and Entra operations

Setting `containers.keyVaultUrl` selects the Key Vault per-user secret backend.
The router's managed identity needs data-plane secret access. Because the
router is remote, do not expect a laptop command pointed at its local
`router-config.json` to mutate the hosted store. Use either path:

```bash
# Preferred: run the normal Cyrus command under the replica's managed identity.
az containerapp exec --name <router-app> --resource-group <rg> \
  --command "cyrus router secrets set alice@example.com CLAUDE_CODE_OAUTH_TOKEN <value>"

# Or use az keyvault secret set with the hashed name/tag convention below;
# preserve both email and key tags.
```

The Key Vault name is `u<first-20-hex-of-sha256(lowercase-email)>-<first-10-hex-of-sha256(key)>`;
set tags `email=<lowercase-email>` and `key=<ENV_VAR_NAME>`. The tags are what
make `secrets list` reversible; the hashed name alone is intentionally opaque.

Secret reads are cached briefly. A rotation affects the next
**create-from-image** only; a running, suspended, or snapshot-restored sandbox
keeps its baked environment. Apply a rotation immediately with `cyrus router
containers destroy <issueKey>` followed by a new prompt.

Optional Entra-gated enrollment is described in
[Optional Entra-gated enrollment](#optional-entra-gated-enrollment). Use one app
registration per router deployment, set its Application ID URI as the exact
audience, and have operators/users authenticate with `az login`. Entra protects
enrollment; sandbox data-plane calls separately use the router managed identity
and the `https://dynamicsessions.io/.default` audience.

### Router state and recovery

Azure hosting is deliberately **single replica** (`minReplicas = maxReplicas =
1`) because SQLite and live WebSockets are not multi-writer state. `router.db`
lives on local ephemeral storage; `StateBackup` restores it from Blob when the
file is absent, then uploads a SQLite backup every five minutes by default and
once on graceful shutdown. A single-request `PutBlob` is atomic, so an
interrupted upload retains the previous blob. During a Container Apps revision
rollout, however, old and new replicas can overlap and upload out of order. The
accepted recovery window is `intervalMs`; restored queue events are
at-least-once and may be delivered again.

If restore fails on a corrupt blob, startup fails loudly rather than silently
discarding state. Break glass: use the operator's **Storage Blob Data
Contributor** grant to delete `router.db` from the backup container, then
restart/redeploy the single replica. This starts an empty router registry; users
and devices must be re-enrolled.

### Terminal teardown and known gaps

For a human-acted completed/canceled notification or an `Issue/remove` webhook,
the router queues the raw webhook, wakes a suspended worker, and the worker stops
sessions, force-flushes the persistence floor, pushes WIP, runs
`cyrus-teardown.sh`, and removes the worktree. Its authenticated
`teardown-complete` callback then destroys the sandbox and all issue snapshots
before deleting the device row. Completed/canceled issues retain the bundle for
reopen; deleted issues also remove it. A missed callback falls back to the
10-minute grace timer, and stale/orphan sweeps remain backstops.

The callback is durable on both sides, because falling back to grace expiry means
paying for a sandbox that has already finished its work:

- The worker records the callback (with an idempotency key) to
  `~/.cyrus/router-client/teardown-callbacks.jsonl` **before** it starts any
  cleanup, and retries that same key with backoff until the router accepts it. A
  worker killed anywhere in the sequence — including between the floor flush and
  the callback — replays it once it reconnects.
- The router mirrors each registered teardown into its SQLite `container_teardowns`
  table, so `cyrus router containers list` shows a `TEARDOWN` column:
  `callback-pending(<action>, grace <N>s)` while it is still waiting on the
  worker, or `destroying(<action>, callbacks <N>)` once a callback has arrived and
  only the provider destroy is retrying. A re-delivered callback is logged as
  `callback retry`, distinct from the `grace expired` warning that means no worker
  ever reported in.

The mirror is observability plus retry accounting, not a restart journal: the
rows are cleared when the router builds its teardown coordinator, matching that
coordinator's empty in-memory starting state.

Waking the container for teardown has its own hazard. `ContainerTargets` dedupes
concurrent boots for a device by joining the in-flight attempt, which is
necessary — two parallel `ensureRunning` calls would each mint a device token and
orphan the container the other just started — but it is *only* a dedup, never
evidence that the container ended up running. An attempt that began before the
teardown webhook arrived can finish having achieved nothing, most realistically
when the idle sweep parks the container while it is still starting. A teardown
wake that joined such an attempt would return believing the container is up, so
nothing would ever start it and the grace deadline would be the only thing that
reclaimed it. After joining, the router therefore re-checks `executor.status()`
and boots for real if the container is not running; and an attempt still in
flight past ten minutes is abandoned rather than joined, so a provider call that
hangs cannot permanently disable booting for that device.

Relatedly, every ACA data-plane request carries a 120-second deadline
(`requestTimeoutMs`). Node's `fetch` has no overall request timeout, and an
unbounded call would block `ensureRunning`, the provider's per-issue mutex, and
the device's boot slot behind it.

Linear has two verified notification blind spots: it sends no
`issueStatusChanged` notification for a close performed by the Cyrus app's own
OAuth identity, and sends none for the `duplicate` state. Those cases wait for
the 14-day stale-destroy backstop unless an operator destroys the container.
Router restart during the in-memory teardown grace also loses that immediate
callback registration; idle-stop and stale GC still bound it.

Before deleting Azure infrastructure, follow the ordered sweep in
[`infra/azure/README.md`](../infra/azure/README.md#teardown-m5): destroy all
router-managed containers, delete leftover data-plane snapshots (and optional
disk images), then run `terraform destroy`. Terraform does not own those
data-plane children.

---

## Setup management UI

`/setup` is an authenticated page where a teammate manages their own per-user
container environment variables in a browser. It replaces `az containerapp
exec` + `az keyvault secret set` (or `cyrus router secrets set`) as the
*documented* path for a teammate to add their own `CLAUDE_CODE_OAUTH_TOKEN`,
`GH_TOKEN`, or any other tool credential — those commands still work and
remain the break-glass path.

It is **off by default**, and enabling it requires a `containers` block: the
page edits the same per-user secret bundle that container launches consume,
and no secret backend exists without one. `setupUi.enabled: true` with no
`containers` block refuses to start, naming the reason.

### Choosing an auth mode

`setupUi.auth` has no default — you state how identity is established, or the
router refuses to start. Three modes:

- **`entra-token` (recommended).** Cryptographically verifies the Entra ID
  token the ACA auth ("EasyAuth") sidecar forwards in
  `X-MS-TOKEN-AAD-ID-TOKEN`. The trust boundary is a signature, not proxy
  topology, so it does not matter how a request physically reached the
  router.
- **`easyauth-headers`.** Trusts the `X-MS-CLIENT-PRINCIPAL*` identity headers
  the EasyAuth sidecar injects. Only sound if every request that can reach the
  router has passed through that sidecar, which strips any client-supplied
  copy of those headers first. The router refuses to start in this mode
  unless you also set `verifiedHeaderStrip: true` by hand — this is not
  something the router can check for you; you set it only after verifying,
  live, against your real ingress, that a forged `X-MS-CLIENT-PRINCIPAL-NAME`
  header with no session cookie is rejected.
- **`dev-insecure-headers`.** Local development only. Reads the same headers
  with no verification, and the router refuses to start unless it is bound to
  a loopback address (`127.0.0.1`, `::1`, `localhost`).

**The header-strip guarantee cannot be confirmed from documentation alone.**
Microsoft documents that guarantee for external, internet-facing requests.
This router additionally attaches its `/device` WebSocket endpoint to the same
raw HTTP server and, under Docker, listens on `0.0.0.0` — neither is something
that guarantee was written to cover. Until you have verified live, from every
path a request can take to reach the router, prefer `entra-token`.

### Configuration

`router-config.json`:

```json
{
  "containers": { "...": "..." },
  "setupUi": {
    "enabled": true,
    "auth": {
      "mode": "entra-token",
      "idTokenAudience": "00000000-0000-0000-0000-000000000000"
    },
    "allowedDomain": "example.com",
    "autoProvisionUsers": true
  }
}
```

`entra-token` mode also requires `entra.tenantId` elsewhere in the file — it
names the tenant whose JWKS signs the ID token, reusing the app registration
`entra.audience` already names for `/enroll` under a different audience (see
"Optional Entra-gated enrollment" above). `idTokenAudience` is the bare
client-id GUID, **not** the `api://` Application ID URI used for enrollment
access tokens; the router rejects the `api://` form at startup.

Equivalent Docker environment variables:

| Variable | Required | Maps to |
|----------|----------|---------|
| `CYRUS_ROUTER_SETUP_UI_ENABLED` | no (default off) | `setupUi.enabled` |
| `CYRUS_ROUTER_SETUP_UI_AUTH_MODE` | yes if enabled | `setupUi.auth.mode` — `entra-token`, `easyauth-headers`, or `dev-insecure-headers` |
| `CYRUS_ROUTER_SETUP_UI_ID_TOKEN_AUDIENCE` | yes if mode is `entra-token` | `setupUi.auth.idTokenAudience` |
| `CYRUS_ROUTER_SETUP_UI_VERIFIED_HEADER_STRIP` | yes, must be `true`, if mode is `easyauth-headers` | `setupUi.auth.verifiedHeaderStrip` |
| `CYRUS_ROUTER_SETUP_UI_ALLOWED_DOMAIN` | no | `setupUi.allowedDomain` |
| `CYRUS_ROUTER_SETUP_UI_AUTO_PROVISION` | no (default `true`) | `setupUi.autoProvisionUsers` |

### Auto-provisioning is on by default

`autoProvisionUsers` defaults to **true**: a teammate's first visit shows a
"Set up your account" button, and clicking it registers them. That is the
intended posture for a single-organisation deployment, where you want people
to onboard themselves.

Be clear about what it does and does not grant. Registering creates a user row
and an **empty** secret record — no credentials. The user still has to supply
their own Claude token, and nothing routes to them until they appear as the
creator or assignee of a Linear issue. So in practice the gates on doing
anything useful are *having a Claude subscription* and *being in Linear*,
neither of which this page hands out.

The case for turning it off is when your Entra tenant is materially larger
than the set of people who should be able to hold Cyrus credentials — a big
company with a small Cyrus team. Then set it false, and add a real membership
gate: an Entra app-role assignment or an `authConfigs` allowed-principals
policy. Note that `allowedDomain` is *not* that gate — a domain check confirms
an account is in the right tenant, not that it belongs to a teammate — but it
is worth setting anyway, because it is the cheapest way to keep guest and
cross-tenant accounts out. See "Restrict who can sign in" in
`infra/azure/README.md` for both supported gates.

With auto-provisioning off, an unregistered visitor gets a 403 naming the
exact `cyrus router users add <email>` command to run.

### Rotation: a saved value doesn't reach a running worker

Saving a value here only changes what the *next* container is created with —
a running, suspended, or snapshot-restored sandbox keeps the environment it
already has, because injection happens once, at create-from-image. To push a
rotated value out immediately:

```bash
cyrus router containers destroy <issueKey>
```

Then re-prompt the issue so its replacement container is created fresh with
the new value. This is the single most common point of confusion with the
feature — a save that looks like it "did nothing" is almost always this.

### Storage backend

Per-user secrets live in one of three places, selected by what's present under
`containers`: a local JSON file (`secretsPath`, single-host only), Azure Key
Vault (`keyVaultUrl`), or an Azure Table (`tableStore`) with envelope
encryption, where each user's bundle is encrypted with its own data key,
wrapped by a Key Vault RSA key. `/setup` works against all three; the
"someone else changed this while you were editing" conflict check only
applies to the Table backend, the only one of the three with a row version to
check against.

Move from Key Vault to the Table backend with:

```bash
cyrus router secrets migrate --from keyvault --to table --dry-run
cyrus router secrets migrate --from keyvault --to table
```

Both `containers.keyVaultUrl` (source) and `containers.tableStore` (target)
must already be present in `router-config.json` — the command copies between
whatever the config names; it does not infer which backend is active. It
never prints a value, only key names and byte counts; it skips a user with
nothing to migrate, and never overwrites a record the target already has. The
router keeps reading Key Vault until you separately add `containers.tableStore`
to the config it starts with. `cyrus router secrets set/list/unset` keep
working against whichever backend is active, and remain the break-glass path
when the UI itself is unreachable.

For the full staged Terraform rollout — the two-apply sequence, the live
verification gate in between, and how to decommission the Table and its
encryption key safely — see
["Optional: the setup management UI (`/setup`)"](../infra/azure/README.md#11-optional-the-setup-management-ui-setup)
in `infra/azure/README.md`. That runbook is the source of truth for the Azure
deployment path; nothing here should contradict it.

---

## Device setup (each client)

> **Guided path.** Run `/cyrus-setup` and choose **Client device** at the mode
> prompt (or invoke the `cyrus-setup-client` skill directly). It walks through
> prerequisites, Claude auth, native `gh`/git config, `cyrus connect`, the local
> Linear MCP OAuth, adding repositories, and launching. The steps below are the
> manual reference.

On your own machine, in the repo(s) you want Cyrus to work in:

### 1. Connect to the router

```bash
cyrus connect https://router.example.com --code <your-enrollment-code>
```

`<url>` is the router's public **HTTP(S)** origin; the CLI derives the matching
`ws://`/`wss://` form automatically (`https://` → `wss://`, `http://` → `ws://`
for local/dev). On success it exchanges the code for a long-lived per-device
token and writes it — `chmod 0600` — into your `config.json` as
`platform: "router"` with `router: { url, deviceToken }`. The enrollment code is
burned after one use.

`cyrus connect` does **not** enable the persistence-floor sync
(`WorkspaceSyncService`) on your device — `router.floorSync` defaults to off
and is left unset. That's deliberate: without it, every session end and a
5-minute timer would start pushing `wip: auto-saved by cyrus…` commits onto
your issue branches (including open PRs) whether you wanted that or not. If
you want your device's in-progress work backed up to the router the same way
an ephemeral container's is — for example so a session can later be migrated
from your laptop onto a container — add `"floorSync": true` to the `router`
block in your `config.json` by hand.

### 2. Install and OAuth the official Linear MCP locally

In router-client mode Cyrus does **not** configure the app-token Linear MCP —
the router holds the workspace token, not your device. So the agent's *own*
Linear tool use is routed through **your** locally-installed official Linear MCP,
authenticated with **your** Linear OAuth. Install it and complete the one-time
interactive browser OAuth **now**, at connect time:

- A headless agent session cannot complete a browser OAuth flow. If your Linear
  MCP auth is missing or expired, that must surface **at connect / session
  start**, not halfway through a run.
- Attributing Linear actions to you (scoped to your real permissions) is the
  whole point — infrastructure calls (posting activities, fetching issue content
  for prompt assembly, attachments, state transitions) still flow through the
  router's app token as RPCs, but user-facing Linear tool use is yours.

Verify MCP auth health before relying on it; re-run the OAuth if it has expired.

### 3. Add repositories

Add each repo to the `repositories` array of your `config.json`. A router-mode
entry carries **no** `linearToken` (the router holds it), but it does need
`linearWorkspaceId` — `EdgeWorker` keys its issue trackers by workspace id, so a
mismatched id makes the device accept routed events and then silently drop them
for want of a tracker.

`cyrus self-add-repo` does **not** work here: it resolves the workspace from a
local `linearToken` and exits with `No Linear credentials found` on a client
device. Write the entry directly instead.

You do not need to copy the workspace id off the router host. At enrollment
`cyrus connect` calls `GET /workspaces` (authenticated with the device token) and
stores the result at `router.workspaceIds`:

```bash
jq -r '.router.workspaceIds // [] | .[]' ~/.cyrus/config.json
```

An empty result means the router predates that route — update it, or read the key
under `workspaces` in the router's `router-config.json`.

### 4. Run

```bash
cyrus start
```

Your device dials the router, authenticates with its token, and begins receiving
the agent sessions **you** create in Linear. Sessions run locally in isolated
git worktrees exactly as in single-host mode.

---

## Issue payloads cross a JSON boundary

`Issue` is not plain data. Alongside its fields it carries five async getters
(`state`, `assignee`, `team`, `parent`, `project`) and six methods (`labels()`,
`comments()`, `attachments()`, `children()`, `inverseRelations()`, `update()`),
all defined on the Linear SDK class's prototype. `JSON.stringify` keeps only own
enumerable properties, so **every one of them is lost** when an issue is sent
over the device RPC.

`RouterIssueTrackerService.hydrateIssue` rebuilds them on the device, backing
each with an RPC (`fetchTeam`, `fetchWorkflowState`, `fetchUser`, `fetchLabel`,
`fetchIssueAttachments`, `fetchIssueInverseRelations`, …). Getters are memoized
per issue.

Two rules follow for anyone adding to the RPC surface:

1. **Never send a `Promise` across the wire** — it serializes to `{}`. Resolve it
   on the router, where the Linear token lives, and send data. This is why
   `IssueRelation` (whose `issue` is a `Promise`) has the wire-safe twin
   `IssueRelationSummary`, and why `fetchIssueInverseRelations` exists rather
   than callers reaching for `issue.inverseRelations()`.
2. **Any new `Issue`-returning RPC must hydrate its result**, including nested
   issues (`fetchIssueChildren` hydrates each child).

Skipping hydration does not fail loudly. A missing method throws
`TypeError: issue.labels is not a function`, but a missing getter is worse:
`await undefined` is `undefined`, so `await issue.team` silently yields nothing
and the caller concludes the issue has no team.

Adding a method to `IIssueTrackerService` is not enough to make it callable —
`RPC_METHODS` in `packages/router-protocol` is an allowlist checked before
dispatch reflects onto the tracker. Omit it there and the call typechecks, then
fails at runtime.

---

## Offline and queue semantics

The router ACKs Linear immediately, enqueues each event in a durable per-device
SQLite queue, and delivers it over the WebSocket. Delivery is per-device FIFO and
**exactly-once-ish**: an event is removed from the queue only once the device
acks it, and the device durably records an event to a local inbox before acking,
so a crash between ack and processing replays it rather than dropping it.

- **Offline device:** events queue. The **first** time a session is queued for an
  offline device, the router posts a one-time activity to the Linear session
  ("Waiting for `<user>`'s machine to come online…"), so the delegator isn't left
  guessing. When the device reconnects it resumes from its last-acked sequence
  and drains the backlog.
- **TTL expiry:** a queued event that outlives `eventTtlMs` (default 48h) is
  dropped; the router posts an activity asking the user to re-delegate, and if the
  event never started work its issue lock is released.
- **Reconnect:** the client reconnects with exponential backoff and replays any
  activity posts it buffered while offline (idempotently, so no duplicate
  timeline entries).

### Device liveness watchdog

A TCP connection can stay half-open on the device long after the router has
terminated its end, in which case the device believes it is connected, sends no
new `hello`, and the router's queued events are never delivered. The device
therefore runs its own watchdog: it timestamps every inbound signal from the
router (ping, pong, or any frame) and terminates its socket once that timestamp
is older than two `heartbeatMs` intervals — the same point at which the router
gives up on a device that stops answering pings. Termination feeds the ordinary
reconnect path, so a fresh authenticated `hello` drains the backlog.

The comparison uses **wall-clock** time, not elapsed timer ticks. An ACA
memory-mode suspend freezes every JavaScript timer in the sandbox, so after a
resume the watchdog's own interval fires late; only a wall-clock check reveals
the gap. This is what makes a resumed sandbox rejoin on its own instead of
waiting for a later prompt to cross `disconnectedRecreateMs` and force a cold
replacement.

---

## Cross-user policy

### Issue lock

**Default on** (`issueLock: true`). While any session is active on an issue — on
*any* device — new agent sessions on that same issue are rejected with a polite
activity naming the active session's owner. The router is the only component that
sees every session across every device, so it is the natural enforcement point
against two machines diverging on one issue.

A lock is released when: the session reaches a terminal state (complete / error /
stopped), the device's token is revoked, the device stays offline past the TTL,
or an admin runs `cyrus router unlock <issueId>`.

The terminal-state signal is delivered durably. The device writes the
`session_state` frame to `session-state-buffer.jsonl` before sending it, and
replays it on every reconnect until the router acknowledges with
`session_state_ack`. Delivery is therefore at-least-once, and the router's
release is idempotent so a replayed frame is a no-op. This matters because the
offline-past-TTL sweep only reclaims locks from devices that have gone *dark*: a
device that stays connected but loses its terminal frame would otherwise strand
the issue indefinitely, recoverable only via `cyrus router unlock`.

### Creator-only prompting

**Default on** (`creatorOnlyPrompting: true`). A session runs under its creator's
full machine identity, so the router only delivers **new prompts from the
session's creator**. A prompt from anyone else is not delivered; the router posts
an activity explaining that the session belongs to its creator and inviting the
other person to delegate the issue to start their own session. The gate fails
**closed**: if the prompt's actor cannot be positively identified, it is rejected
rather than assumed to be the creator.

Set either flag to `false` in `router-config.json` to opt out.

---

## Worktree continuity

There is no live worktree sync between devices — **the git remote is the sync
layer.** Two rules make cross-device and post-cleanup handoff work:

1. **Resume from the pushed branch.** When creating a worktree for an issue,
   Cyrus checks whether `origin/<issue-branch>` already exists and, if so, bases
   the new worktree on that remote branch instead of the repository's base
   branch. A session that another device (or an earlier, cleaned-up session)
   pushed is reconstructed from the remote, like any developer picking up a
   branch.
2. **Push WIP before a worktree is removed.** If the worktree is dirty when a
   session ends or the issue reaches a terminal state, Cyrus auto-commits the
   uncommitted changes to the issue branch as a `wip:` commit and pushes it
   before the worktree is torn down. This shrinks the window of unreachable work
   to mid-session crashes only.

Uncommitted work stranded on a crashed or sleeping machine is out of scope by
design — commit and push (which rule 2 does automatically at session end) is the
handoff mechanism.

---

## Trust boundaries

- **Workspace Linear app token:** lives only on the router host. Devices never
  see it.
- **Device token:** grants a device receipt of *one user's* sessions plus RPC
  access scoped to that user's own sessions. A stolen device token cannot act
  workspace-wide.
- **Attachments** stream through the router (which holds the token needed to
  fetch them) with a size cap, so a device never needs the workspace token to
  download issue attachments.

---

## Command reference

| Command | Where | Purpose |
|---------|-------|---------|
| `cyrus router start` | host | Start the router server (reads `~/.cyrus/router-config.json`). |
| `cyrus router users add <email> [--name <name>]` | host | Register a user + mint a 15-minute enrollment code. |
| `cyrus router users list` | host | List users with device status and running/locked session counts. |
| `cyrus router users remove <email>` | host | Remove a user and their device. |
| `cyrus router devices list` | host | List enrolled devices (physical + container) and their owners. |
| `cyrus router devices revoke <email>` | host | Revoke a user's device token. |
| `cyrus router sessions list` | host | List running + locked sessions with their Linear issue id and session GUID. |
| `cyrus router unlock <issueId\|PAR-123>` | host | Release a stuck issue lock, by GUID or Linear identifier. |
| `cyrus router secrets set <email> <ENV_VAR_NAME> <value>` | host | Store a per-user container secret. Never echoes the value. |
| `cyrus router secrets unset <email> <ENV_VAR_NAME>` | host | Remove a per-user container secret. |
| `cyrus router secrets list <email> [--check-scopes]` | host | List stored secret keys (values masked) + any missing required keys. `--check-scopes` additionally reports the stored `GH_TOKEN`/`GIT_TOKEN` OAuth scopes — advisory only, never rejects a usable token, never prints values. |
| `cyrus router secrets migrate --from keyvault --to table [--dry-run]` | host | Copy every user's per-user secrets from the Key Vault backend to the Table backend named in `containers`. Never prints values; `--dry-run` lists what would move without writing anything. |
| `cyrus connect <url> --code <code> [--entra <audience>]` | device | Enroll this device, optionally using an Azure CLI Entra token. |
| `cyrus start` | device | Begin receiving and running your routed sessions. |
