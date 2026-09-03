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
  the user/device registry, the per-device event queue, issue locks, and recent
  agent-run observations.

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
| `CYRUS_LOG_LEVEL` | no | `INFO` | not config-backed — `DEBUG`, `INFO`, `WARN`, `ERROR`, or `SILENT` |
| `CYRUS_LOG_FORMAT` | no | `text` | not config-backed — `json` emits one JSON object per log line for log aggregators |
| `CYRUS_LOG_FORWARD_LEVEL` | no | `WARN` | worker-side only — minimum level a sandbox worker forwards to the router (see "Sandbox worker logs") |
| `CYRUS_LOG_FORWARD_RATE` | no | `2` | worker-side only — sustained forwarded records/second |
| `CYRUS_LOG_FORWARD_BURST` | no | `40` | worker-side only — forwarding burst capacity |
| `CYRUS_OTEL_LOGS_ENABLED` | no | `false` | not config-backed — master switch for OTLP log export (see "OpenTelemetry log export") |
| `CYRUS_OTEL_LOGS_LEVEL` | no | `INFO` | minimum level exported over OTLP; independent of `CYRUS_LOG_LEVEL` |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | when OTLP is on | — | the OTLP endpoint. Absent while `CYRUS_OTEL_LOGS_ENABLED` is set, the router warns and stays on stdout only |
| `CYRUS_OTEL_TRACES_ENABLED` | no | `false` | not config-backed — master switch for distributed tracing (see "Distributed tracing"). Propagated into every sandbox the router boots |
| `CYRUS_OTEL_TRACES_SAMPLE_RATIO` | no | `1` | root-span head-sampling ratio, `0`–`1`. Never consulted for a span with a remote parent |
| `CYRUS_SPAN_FORWARD_RATE` | no | `200` | worker-side only — sustained forwarded spans/second |
| `CYRUS_SPAN_FORWARD_BURST` | no | `2000` | worker-side only — span-forwarding burst capacity |
| `CYRUS_OTEL_SERVICE_NAME` | no | `CONTAINER_APP_NAME`, else `cyrus-router` | `service.name` |
| `CYRUS_OTEL_SERVICE_VERSION` | no | the CLI version, else `CONTAINER_APP_REVISION` | `service.version` |
| `CYRUS_OTEL_SERVICE_INSTANCE_ID` | no | `CONTAINER_APP_REPLICA_NAME`, else the hostname | `service.instance.id` |
| `CYRUS_OTEL_DEPLOYMENT_ENV` | no | — | `deployment.environment.name` |
| `CYRUS_OTEL_CLOUD_REGION` | no | `containers.aca.region` | `cloud.region` |

Set `CYRUS_LOG_FORMAT=json` when the router's stdout is collected by something
that indexes fields (Azure Log Analytics, Loki, CloudWatch). Each line becomes a
single object with `timestamp`, `level`, `component`, `message`, any session /
issue / repository context, and — for a failure — an `error` object carrying the
original stack:

```json
{"timestamp":"2026-08-06T04:15:10.398Z","level":"error","component":"ContainerTargets","message":"Container boot failed for NOR-278","error":{"name":"Error","message":"ACA sandbox create timed out","stack":"…"}}
```

In Log Analytics that makes the console stream queryable by field rather than by
substring — for example, to see worker liveness for a cloud sandbox (ACA reports
a sandbox as `Running` even when its entrypoint has exited, so device
connect/disconnect is the more truthful signal):

```kql
ContainerAppConsoleLogs_CL
| extend p = parse_json(Log_s)
| where p.component == "DeviceGateway"
| project TimeGenerated, level = tostring(p.level), message = tostring(p.message)
| order by TimeGenerated desc
```

Leave it unset for local use; the default human-readable output is unchanged.

### OpenTelemetry log export

The JSON stdout stream above is collected by whatever runs the router — on Azure
Container Apps, the environment ships it to Log Analytics as
`ContainerAppConsoleLogs_CL`. That path stays the default and is unchanged.

Setting `CYRUS_OTEL_LOGS_ENABLED=true` additionally backs `ILogger` with the
OpenTelemetry Logs API, so every one of the router's existing log calls also
leaves the process as a structured OTLP record. No call site changed: the
`LogSink` seam in `cyrus-core` is the interception point, and the console sink
keeps working exactly as before. Adopting `ILogger` alone would not have been
enough — the console sink renders `prefix + message`, i.e. prose, so the
structured payload only exists on the forwarding path.

**The instrumentation is vendor-neutral.** `cyrus-otel-logs` depends on nothing
but `@opentelemetry/*` and `cyrus-core`, and takes its exporter as an argument;
`cyrus-core` has no Azure dependency at all. Only the router's own bootstrap
knows about Azure, where it supplies an Azure Monitor exporter and the
`cloud.provider` / `cloud.platform` values. Point a different exporter at it and
nothing else changes.

Every record carries resource semconv — `service.name`, `service.version`,
`service.instance.id`, `deployment.environment.name`, `cloud.provider`,
`cloud.platform=azure_container_apps`, `cloud.region` — plus the same per-line
attributes the JSON console format emits (`component`, `sessionId`,
`issueIdentifier`, `repository`, `event`, `args`), under the same key names, so
existing queries transfer.

**Errors carry exception semconv.** Any log call handed an `Error` — at any
level, so `logger.warn("retrying", err)` counts — emits `exception.type`,
`exception.message` and `exception.stacktrace`. Those three are STABLE OTel
semconv and describe nothing Cyrus-specific, which is why they are the one place
the sink uses standard names rather than Cyrus-native ones: a backend that
special-cases them renders the record as an exception rather than a line of
text. The stacktrace includes any `cause` chain, appended as `Caused by:` blocks
— a transport that wraps `ECONNREFUSED` in `new Error("failed to send", {
cause })` has an outer stack that points only at our own retry helper. A
sandbox worker's exception survives the trip to the router intact: it rides its
own field on the `log` frame rather than being flattened into `args`, and the
router re-emits it with the *worker's* stack, not its own.

```kql
AppTraces
| where AppRoleName == "cyrus-router"
| where isnotempty(Properties["exception.type"])
| summarize failures = count(), sample = any(Message)
    by type = tostring(Properties["exception.type"]),
       component = tostring(Properties.component)
| order by failures desc
```

Everything Cyrus-specific goes under the private `cyrus.*` namespace instead —
OTel defines no convention for a Linear issue, a sandbox, a device, or an agent
session. GenAI semconv (`gen_ai.*`) was evaluated for session/token/cost
attributes and deliberately **not** adopted; see
[ADR 0003](adr/0003-defer-genai-semantic-conventions.md).

**Records land in `AppTraces`, not `ContainerAppConsoleLogs_CL`.** This is the
one thing to know before querying them; the saved searches and alert rules in
`infra/azure/bicep/modules/monitoring.bicep` all read the console table and do not see
OTLP records.

```kql
AppTraces
| where AppRoleName == "cyrus-router"
| extend component = tostring(Properties.component), event = tostring(Properties.event)
| project TimeGenerated, SeverityLevel, component, event, Message
| order by TimeGenerated desc
```

`service.name` arrives as `AppRoleName` and `service.instance.id` as
`AppRoleInstance`; everything else is a key inside `Properties`.

Two operational notes:

- **`CYRUS_OTEL_LOGS_LEVEL` is what you pay for**, and is independent of
  `CYRUS_LOG_LEVEL` (which only governs the container's own stdout). It defaults
  to `INFO`, which carries the `sandbox.*` event family and every warning and
  error while leaving debug volume local. `SILENT` stops export without tearing
  the pipeline down — but does not suppress named `event()` records, which ride
  past the threshold by contract.
- **No ESM loader hook or `--import` flag is needed.** OTel on ESM requires
  those only for auto-instrumentation, which monkey-patches modules and so must
  run before they are imported. This is a logs bridge that patches nothing, so it
  can start at any point in the bootstrap. It is deliberately not registered as
  the OTel *global* logger provider either, which would otherwise capture any
  dependency that grabs a logger off the global API and make the volume you pay
  for depend on your dependency tree.

On the Bicep stack this is on by default: `enableOtelLogs` creates a
workspace-based Application Insights component wired to the *same* Log Analytics
workspace (so no second data store and no separate retention), and sets the env
vars above. Application Insights is used purely as an OTLP endpoint.

### Sandbox lifecycle telemetry

On top of the JSON lines above, the router emits a named **event** family for
every ephemeral sandbox. Events go through the logger's `event()` channel rather
than `info()` — `debug` and `info` are deliberately never forwarded to the
structured stream, so anything an operator needs to query has to be an event.
Each one carries `cyrus.issue_key`, `cyrus.device_id` and `cyrus.provider`, and
every name is prefixed `sandbox.`, so a single predicate selects the whole
family.

Names are dotted lowercase and every Cyrus-specific attribute lives under
`cyrus.*` (matching the labels already stamped on ACA sandboxes). A dotted key
is NOT reachable with dot syntax in KQL — `p.cyrus.issue_key` parses as a nested
lookup and silently returns null — so read them with bracket syntax:
`p["cyrus.issue_key"]`. The structural keys the JSON renderer owns (`event`,
`component`, `level`, `message`, `timestamp`, `args`) keep their bare names.

| Event | Emitted when |
|-------|--------------|
| `sandbox.boot_started` | the router asked a provider to boot or resume a sandbox |
| `sandbox.running` | the provider reported it running (`transitioned` is false for a re-route that found it already up) |
| `sandbox.boot_failed` | `ensureRunning` rejected; `reason` carries the message |
| `sandbox.parked` | a session blocked on a user answer and released affinity. Despite the name this is the **run** waiting, not a container stop — nothing is stopped here, and the container keeps running (and billing) until the idle sweep stops it as `sandbox.idle_stopped`. See [Observe agent runs](#observe-agent-runs) |
| `sandbox.unparked` | a park was reversed and the agent went back to work |
| `sandbox.idle_stopped` | the lifecycle sweep parked an affinity-free sandbox past `idleStopMs` |
| `sandbox.destroyed` | the sandbox and its disk were removed; `reason` is `stale`, `orphan`, `terminal_teardown` or `provider_switch` |
| `sandbox.teardown_completed` | a terminal teardown finished; carries `action` and whether the worker's callback or the grace deadline triggered it |
| `sandbox.stranded_session` | a sandbox holds session affinity it is not working on. `cyrus.reason` is `offline_pinned` (stopped and disconnected, past `strandedSessionGraceMs`) or `no_progress` (running and connected, but nothing routed to it and nothing posted by it past `containers.sessionNoProgressMs`, default 4h). Detection only — neither boots nor releases anything |
| `sandbox.gauge` | once per sandbox per 60s lifecycle sweep — the point-in-time inventory |
| `sandbox.sweep_completed` | once per completed sweep, even with zero sandboxes — the fleet rollup. The sweep is non-reentrant, so a tick that fires while the previous one is still running is skipped and logs a warning instead |

Two attributes on `sandbox.gauge` are easy to confuse and mean different things:

- **`cyrus.age_ms`** is the device row's age (`devices.created_ms`). The row survives
  every stop/resume cycle, so this answers "how long has this issue had a
  sandbox", never "how long has it been burning 4 vCPU".
- **`cyrus.uptime_ms`** is CONTINUOUS running time (`devices.running_since_ms`),
  stamped when a sandbox transitions to running and cleared on every transition
  out. This is the one an uptime alert must key on. Null while stopped.

`sandbox.gauge` also carries the router's own liveness view — `cyrus.online` (a live
WSS socket) and `cyrus.last_seen_age_ms` (age of the last heartbeat pong) —
alongside the provider's `cyrus.state`. Both are needed: ACA reports a sandbox as `Running` even
when its entrypoint has exited, so a query keyed on `cyrus.state` alone will happily
report a zombie as a healthy agent.

Current open sandboxes, with issue keys and uptimes, in one query:

```kql
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(15m)
| extend p = parse_json(Log_s)
| where tostring(p.event) == "sandbox.gauge"
| extend issue_key = tostring(p["cyrus.issue_key"]),
         device_id = tostring(p["cyrus.device_id"]),
         state = tostring(p["cyrus.state"]),
         sessions = toint(p["cyrus.sessions"]),
         online = tobool(p["cyrus.online"]),
         uptime_ms = tolong(p["cyrus.uptime_ms"]),
         last_seen_age_ms = tolong(p["cyrus.last_seen_age_ms"])
| summarize arg_max(TimeGenerated, *) by device_id
| where state == "running"
| project issue_key, device_id, sessions, uptime = uptime_ms * 1ms,
          worker = case(online and last_seen_age_ms < 180000, "live",
                        isnull(last_seen_age_ms), "never-connected",
                        "stale-heartbeat")
| order by uptime desc
```

The Azure stack provisions this and several sibling queries as saved searches,
plus alert rules for long-running sandboxes, boot failures, and a stalled sweep.
See [`infra/azure/README.md`](../infra/azure/README.md) → "Monitoring and
alerts".

### Sandbox worker logs

A cloud sandbox's worker process writes to a stdout that **nothing collects**.
The ACA sandbox group is a separate ARM resource from the Container Apps
environment, so the environment's Log Analytics wiring never reaches it, and the
sandbox data-plane API has no logs endpoint at all — everything the worker
printed died with the sandbox.

Workers therefore forward their logs to the router over the WebSocket connection
they already hold, as a `log` protocol frame, and the router re-emits each one
through its own logger. That makes them inherit the router's existing path into
`ContainerAppConsoleLogs_CL` with no exporter, **no change to the sandbox's
deny-by-default egress allowlist** (the router's own host is already its one
entry), and no Azure credential inside the sandbox.

Relayed lines are tagged `cyrus.source: "sandbox"` and their component is prefixed
`sandbox/`, so one predicate separates them from the router's own output:

```kql
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(1h)
| extend p = parse_json(Log_s)
| where tostring(p["cyrus.source"]) == "sandbox"
| project TimeGenerated, issue_key = tostring(p["cyrus.issue_key"]),
          device_id = toint(p["cyrus.device_id"]), level = tostring(p.level),
          component = tostring(p.component), message = tostring(p.message)
| order by TimeGenerated desc
```

`cyrus.issue_key`, `cyrus.device_id` and `cyrus.provider` come from the **device
row the router authenticated**, not from the frame — a worker cannot label its
logs with someone else's issue. If the worker's own view of the issue disagrees, it
is recorded separately as `cyrus.reported_issue_identifier` rather than silently
resolved. `cyrus.emitted_at` carries the device's clock alongside the router's own
timestamp, so sandbox/router clock skew is visible.

**Volume guard.** Piping full session stdout from every sandbox into a PerGB2018
workspace is not cheap, so the device filters before forwarding:

| Variable | Default | Effect |
|---|---|---|
| `CYRUS_LOG_FORWARD_LEVEL` | `WARN` | Minimum level forwarded. `SILENT` turns forwarding off without changing anything else. |
| `CYRUS_LOG_FORWARD_RATE` | `2` | Sustained records/second (token-bucket refill). |
| `CYRUS_LOG_FORWARD_BURST` | `40` | Bucket capacity — how large a burst passes untouched. |

Two things ride *past* the level threshold by design: named `event()` records
(the `sandbox.*` vocabulary above), because a lifecycle event is low-volume and
always meant to reach the structured stream. They still pay a rate-limit token.

Nothing is dropped silently. Records the guard discards — rate-limited, or
emitted while the socket was down — are counted and the count rides the next
frame that does get through, as a `cyrus.dropped` attribute:

```kql
ContainerAppConsoleLogs_CL
| extend p = parse_json(Log_s)
| where tostring(p["cyrus.source"]) == "sandbox"
| summarize lost = sum(tolong(p["cyrus.dropped"]))
    by issue_key = tostring(p["cyrus.issue_key"])
| where lost > 0
```

`log` frames are fire-and-forget: no ack, no durable buffer, no replay. Losing a
log line costs visibility, whereas the disk writes that would make it durable
cost more than the line is worth — and replaying a reconnecting worker's backlog
would bill for stale lines exactly when an operator wants live ones.

**Version skew is negotiated, not assumed.** The router advertises a
`log_ingest` capability in `hello_ack`, and a device forwards nothing until it
sees that. This is load-bearing: the gateway closes any socket that sends a frame
it cannot parse, so a new worker logging at an old router would be disconnected
on its first line and reconnect straight into the same loop. The protocol version
is deliberately *not* bumped for this — a bump would reject every not-yet-updated
worker outright, which is far worse than not shipping its logs. An old router
simply never advertises, and an old worker never sends.

### Distributed tracing

Logs answer *what happened*. Traces answer *why did this take four minutes*. A
Cyrus trace follows one unit of work — Linear webhook → routing decision →
container boot → device dispatch → agent session — across the router/sandbox
process boundary, so the whole thing renders as a single timeline.

Off by default. `CYRUS_OTEL_TRACES_ENABLED=true` turns it on, and it needs
`APPLICATIONINSIGHTS_CONNECTION_STRING` (the same endpoint OTLP log export uses).
The Azure stack wires both from `enableOtelTraces`, which the template refuses to
accept without `enableOtelLogs` — that flag is what creates the Application
Insights component.

**Where the spans land is a third pair of tables.** Not
`ContainerAppConsoleLogs_CL` (router stdout), not `AppTraces` (OTLP log records)
— Application Insights splits spans by kind:

| Span kind | Table |
|---|---|
| `SERVER`, `CONSUMER` | `AppRequests` |
| `CLIENT`, `PRODUCER`, `INTERNAL` | `AppDependencies` |

Everything joins on `OperationId`, which is Application Insights' name for the
W3C trace id. `service.name` becomes `AppRoleName`; every `cyrus.*` attribute is
a key in `Properties` and **must be read with bracket syntax** —
`Properties.cyrus.issue_key` parses as a nested lookup and silently returns
null.

The span vocabulary:

| Span | Kind | What it measures |
|---|---|---|
| `{METHOD} {route}` | server | One HTTP request. `/healthz` is deliberately excluded. |
| `router.route` | consumer | One webhook, from idempotency claim to dispatch or refusal. |
| `router.resolve_target` | internal | The routing decision. `cyrus.outcome` says why it went where it went. |
| `router.resolve_repository` | internal | Repository selection — including a `held` wait on a human answering an elicitation. |
| `router.dispatch` | producer | Queueing the event, and sending it if the device is online. |
| `sandbox.boot` | client | Booting or resuming a container. Usually the answer to "why four minutes". |
| `sandbox.sweep` | internal | One lifecycle sweep tick; root for the ACA calls it makes. |
| `aca.request` | client | One ACA data-plane call. Carries `cyrus.aca.timeout_ms`. |
| `linear.request` | client | One device RPC and the Linear round-trip behind it. |
| `worker.event_received` | consumer | The sandbox picking the event up. **This is where the two halves join.** |
| `session.query` / `session.resume` | internal | One agent query, start to terminal state. The far end of the trace. |

**How the join works.** `router.dispatch` captures W3C trace context at *enqueue*
time and persists it in the `events` row, not just on the wire. The gap between
enqueue and delivery is routinely minutes — an offline device, a cold sandbox
boot — and that gap is precisely what the trace exists to show, so a context
derived at send time would attach the event to an unrelated socket callback.
`RouterConnection` then activates the extracted context around its `event` emit,
which means every span the worker starts afterwards joins the router's trace with
no call-site changes at all.

**Sandbox spans ride the same WSS connection as its logs**, as a `span` frame,
gated by a router-advertised `span_ingest` capability — the same
negotiate-don't-bump discipline as `log_ingest`. The router rebuilds each span
and hands it to its own exporter *without re-minting it through a tracer*: a
tracer would assign a new span id and orphan every child the worker had already
recorded. Attribution (`cyrus.source: "sandbox"`, `cyrus.device_id`,
`cyrus.issue_key`) is stamped from the authenticated device row and overrides
anything the worker claimed; the worker's own `resource` is preserved, so a
relayed span still says `service.name = cyrus-worker`.

**Sampling is decided once, by the router.** The sampler is
`ParentBased(root = TraceIdRatioBased(ratio))`, so a sandbox worker never takes
its own decision — it inherits the one on the incoming `traceparent`. That is
what stops a trace being *half* collected, which renders as a complete story
with a hole in the middle and is worse than no trace at all.

| Variable | Default | Effect |
|---|---|---|
| `CYRUS_OTEL_TRACES_ENABLED` | `false` | Master switch. Propagated by the router into every sandbox it boots. |
| `CYRUS_OTEL_TRACES_SAMPLE_RATIO` | `1` | Root-span ratio, `0`–`1`. Only applies where there is no remote parent. |
| `CYRUS_SPAN_FORWARD_RATE` | `200` | Device-side sustained spans/second. |
| `CYRUS_SPAN_FORWARD_BURST` | `2000` | Device-side bucket capacity. |

The ratio defaults to 1 because root spans here are driven by human actions —
someone assigns an issue, someone posts a prompt — so the rate is issues-per-day,
not requests-per-second. Both switches are reserved env keys: a user cannot set
them on their own sandbox, because a sandbox that disagreed with the router about
sampling is exactly how you get a half-collected trace. The full reasoning,
including why tail sampling is not used, is in
[`docs/adr/0004-parent-based-head-sampling-for-traces.md`](adr/0004-parent-based-head-sampling-for-traces.md).

One issue's whole trace, both processes:

```kql
let target_issue = "NOR-283";
let trace_ids =
    union AppRequests, AppDependencies
    | where tostring(Properties["cyrus.issue_key"]) == target_issue
    | distinct OperationId;
union AppRequests, AppDependencies
| where OperationId in (trace_ids)
| project TimeGenerated, trace_id = OperationId, span = Name,
          service = AppRoleName, duration_ms = DurationMs, ok = Success,
          origin = coalesce(tostring(Properties["cyrus.source"]), "router")
| order by trace_id asc, TimeGenerated asc
```

**Logs stay correlatable even when a trace is not sampled.** A head sampler
cannot preferentially keep the traces that failed — nothing has failed yet at
root-span time. What covers that gap is that `traceparent` is stamped onto every
forwarded log record regardless of the sampled flag, and the sandbox forwarder's
threshold is `WARN`. So an unsampled trace still leaves a complete, queryable
error record carrying its trace id; what it loses is the timing breakdown, not
the fact of the failure.

**HTTP request logging arrived with this.** The router's Fastify instance is
constructed with no options, which disables its built-in pino logger — until now
there was no request logging and no timing of any kind. The tracing plugin adds
both, deliberately through `ILogger` rather than by switching pino on: pino
writes straight to stdout on its own path, bypassing the `LogSink` seam and
therefore the OTLP export. 5xx logs at `error`, 4xx at `warn`, everything else at
`debug`. Query strings are stripped from span names and attributes — several
router routes carry tokens in query position.

The Azure stack provisions five trace saved searches under the **Cyrus Traces**
category, including boot-latency percentiles and a query for outbound calls that
sat on their own deadline.

`cyrus router containers list` renders the same three clocks locally, as
elapsed durations:

```
ISSUE KEY   PROVIDER  USER              LAST ROUTED  LAST SEEN  AGE   UPTIME  PARKED  TEARDOWN
NOR-279     aca       alice@example.com 2026-08-…    2026-08-…  3d4h  6h13m   45m     -
```

`AGE 3d4h` with `UPTIME 6h13m` is a three-day-old issue whose sandbox has been
up continuously for six hours — not a sandbox that has been running for
three days.

`PARKED` renders `devices.parked_at_ms`, which is stamped when a *run* blocks on
a user answer — so it measures how long the run has been waiting, not how long
the container has been stopped. A row can show a `PARKED` duration while the
container is still running; `UPTIME` is what says whether it is up.

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
- **Deploy the router before the worker image.** `sessions_report` is a new
  device→router frame, and `DeviceGateway` closes a socket with
  `1002 invalid frame` on any frame it cannot parse — so a worker that ships
  ahead of the router would have its connection dropped on the first reply. The
  reverse is safe: `RouterConnection` ignores unknown server frames, so a router
  that ships first simply gets no answer and skips reconciliation for that
  device. A worker image bump already forces sandbox replacement via the
  `cyrus.disk` label, so correct ordering falls out of the normal rollout.

---

## Azure hosting and ACA Sandboxes

The maintained Azure deployment in [`infra/azure/`](../infra/azure/README.md)
runs the router as one Azure Container App replica and gives users one
Azure Container Apps (ACA) Sandbox per issue.

**Where an ACA provider is registered, every user's sessions run in an ACA
container** and `executor_json` is not consulted (NOR-364). ACA is the only
executor that works on such a deployment, so there is no choice left to
express — and the alternative, degrading to a physical device the user may
never have enrolled, silently discards the routed event. The stored values are
left untouched, so removing `containers.aca` restores the previous behaviour
exactly. On a router with no ACA provider, set the executor with:

```bash
cyrus router users set-executor alice@example.com docker
```

The router also refuses to start when `containers.defaultExecutor` names a
provider that is not registered: without that check, every user inheriting the
default creates a device row, queues their event onto it, and only then fails
at boot — leaving the event stranded on a device nothing will ever connect to.

### Per-user runner and model defaults

Each user picks their default coding agent and model under **Session defaults**
on `/setup`. It is per-user and workspace-wide, and it sits *below* the existing
per-issue overrides: an `[agent=…]`/`[model=…]` tag in an issue description, or
an agent/model label on the issue, still wins for that issue.

The picker is a curated list, not free text, and it offers only Claude and
Codex. Gemini and Cursor are absent rather than disabled: neither runs in a
container today. `CYRUS_DEFAULT_RUNNER` and the per-runner model variables are
reserved — the router owns them, so a hand-set value in a user's secret bundle
is ignored (with a warning) rather than silently shadowing the picker.

Which credentials a user must have set follows their chosen runner. A user
whose default is Codex is not asked for `CLAUDE_CODE_OAUTH_TOKEN`; a Codex user
supplies a ChatGPT subscription in the **Codex account** section instead (see
[`docs/adr/0005`](adr/0005-codex-authenticates-by-router-held-subscription-tokens.md)),
or `OPENAI_API_KEY` for metered billing. Connecting a subscription needs
`containers.codex` in `router-config.json`; without it the section is not
rendered, and a Codex user with no `OPENAI_API_KEY` is told so rather than being
pointed at a control their deployment does not have.

**The sealing key must outlive the host.** Stored credentials are sealed with a
KEK, and `containers.codex.keyId` (a versioned Key Vault key) is the durable
choice. Without one the router falls back to a 0600 local file —
`containers.codex.localKeyPath`, defaulting to `codex-kek.key` beside the
database — and warns at startup, because **nothing backs that file up**:
`StateBackup` uploads `router.db` alone. On a host whose disk does not survive a
restart the database returns and the key does not, `openBundle` fails, and every
stored credential reads as "no account connected" — indistinguishable, days
later, from never having connected one. On Azure this is why the Bicep renders
`containers.codex` only under `enableSetupSecretStore` (the flag that provisions
the KEK *and* the router's *Key Vault Crypto User* role): the router database
sits on the container's ephemeral disk, so the local-key path there would
guarantee that loss. `codex.keyId` is read independently of
`tableStore.keyId`, so using a subscription never requires the separate
`enableSetupTableBackend` migration.

Changing a default applies to issues that start a container **after** the save.
An issue that already has one keeps the runner it booted with, because
`resolveTarget`'s affinity fast path returns the bound device before
`executorFor` is consulted — so there may be no next `ensureDevice` for that
issue at all. To move a live issue, run
`cyrus router containers destroy <issueKey>` and re-prompt it.

The deployment is Bicep, at `infra/azure/bicep`, applied with
`scripts/deploy-azure.sh`. It is stateless: there is no state file, and
`az deployment sub what-if` reads the real resources rather than a recorded
belief about them.

Both the router and worker image refs must be pinned to an **immutable**
reference — a digest, a release tag (`v1.2.3`), or a git-SHA tag
(`sha-a1b2c3d`). The template rejects mutable tags such as `:latest` or
`:deploy`: an unchanged tag string is an unchanged deployment as far as ARM is
concerned, while the registry re-points that tag at different bits, so a later
unrelated deployment can silently roll the router backwards onto an older build.
See [Router image tag policy](../infra/azure/README.md#router-image-tag-policy)
for the build/push/pin runbook and for reconciling a hand-patched Container App.

The Bicep stack produces the complete `containers` configuration. Its ACA
provider needs a pre-registered worker disk image and these provider fields:

```json
{
  "containers": {
    "image": "ghcr.io/your-org/cyrus-worker:tag",
    "routerUrlForContainers": "wss://<router-fqdn>",
    "repositories": [{
      "name": "cyrus-api",
      "githubSlug": "org/cyrus-api",
      "linearWorkspaceId": "<workspace-id>",
      "baseBranch": "main",
      "projectKeys": ["Platform"],
      "teamKeys": ["NOR"]
    }, {
      "name": "cyrus-infra",
      "githubSlug": "org/cyrus-infra",
      "linearWorkspaceId": "<workspace-id>",
      "baseBranch": "main",
      "isDefault": true
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

### The repository registry

`containers.repositories` **seeds** the registry the first time the router
starts with an empty one. After that the stored registry is authoritative and
the config array is ignored — the router logs this on every start. Manage
repositories at `https://<router-fqdn>/setup/repositories`, which any registered
Cyrus user can edit. Seeding keys on the registry being empty, not on whether it
was ever seeded before — so if every repository is later removed through the
setup UI, the next router restart re-seeds it from `containers.repositories`
rather than leaving it empty.

Each repository may be associated with Linear project names and team keys. In
the setup UI these are written as one string:

```
p=Platform,p=Billing,t=NOR
```

`p=` is a Linear **project name**, `t=` is a **team key**, both repeatable, both
matched case-insensitively against the whole name. Quote a value that contains
a comma: `p="Q3 Migration, Phase 2"`.

Cyrus picks a repository in this order, highest first:

1. `[repo=name]` / `[repo=name#branch]` in the issue description
2. Routing labels on the issue
3. The issue's project name
4. The issue's team key
5. The repository marked **Default**

Routing labels (tier 2) have no field in the setup UI — `p=`/`t=` only cover
project and team. An existing `routingLabels` entry seeded from
`containers.repositories` on first boot is preserved across edits, but the UI
gives you no way to add or change one; that tier is otherwise unreachable for
a router deployment.

The decision is made **on the router**, before any sandbox starts, so each
sandbox clones only the repository it needs. It is made once per issue and
reused for every later session on that issue — a sandbox is per-issue and cannot
change repository once cloned.

When two repositories match on the same project name, the same team key, or
are both marked default, Cyrus posts a selection prompt in Linear and waits.
**No container runs while it waits.** The setup UI warns about these
collisions at configuration time so they can be fixed before they interrupt
anyone. A workspace with exactly one repository in scope is never asked to
choose, even with no default set and no match above it — the sole repository
is used directly.

### Per-repository devcontainer images

A registered repository may declare its own environment with a `devcontainer.json`,
and Cyrus builds that repository its own worker image. Adding a toolchain then
needs a commit to that repository, not a commit to Cyrus plus a full worker-image
redeploy.

This is **off by default**. Turn it on with a `containers.devcontainers` block —
it additionally requires `containers.aca`, because a per-repository image is a
per-repository ACA disk image and there is nothing for it to do on a provider
with no concept of one:

```json
{
  "containers": {
    "devcontainers": {
      "githubToken": "ghp_…",
      "registry": "cyrusacr",
      "loginServer": "cyrusacr.azurecr.io",
      "imageRepository": "cyrus/devcontainers",
      "workerFeatureRef": "ghcr.io/<owner>/cyrus-features/cyrus-worker:0.2.0",
      "workerFeatureVersion": "0.2.0",
      "workerPayloadTarball": "https://…/worker-payload.tgz"
    }
  }
}
```

`githubToken` is **router-level, not per-user**: the repository registry is
global, so the environment a repository declares is a property of the repository
rather than of whoever delegated the issue. The same credential reads the
devcontainer file and clones inside the build.

`workerFeatureVersion` and `workerPayloadTarball` are part of every image's cache
key. Bumping either rebuilds every repository image — which is the point: the
worker rides on top of all of them, so a deployment must never keep booting
repositories on a worker it has since replaced. They are published together by
`.github/workflows/devcontainer-feature.yml`; a feature version published against
a payload from a different commit builds cleanly and dies at boot.

#### What is honoured, and what is not

| Field | Behaviour |
| -- | -- |
| `image`, `build.dockerfile`, `build.context`, `build.args` | Used |
| `features`, `overrideFeatureInstallOrder` | Used. The Cyrus worker feature is always installed **first** |
| `containerEnv` | Used. Applied as real image `ENV`, since ACA boots the image's own OCI config and reads no devcontainer metadata. `${containerEnv:VAR}` becomes Docker's own `${VAR}` expansion, so extending `PATH` works |
| `postCreateCommand` | Run at boot after the clone, alongside `cyrus-setup.sh` — devcontainer first, then the script. **Sandbox workers only**: a `devcontainer.json` is written for VS Code rather than for Cyrus, so it is not treated as consent to run shell on a teammate's own machine the way `cyrus-setup.sh` is |
| `dockerComposeFile` | **Rejected at registration.** A Compose devcontainer is several containers; a sandbox is one, with no Docker daemon inside it |
| `mounts`, `forwardPorts`, `customizations`, `remoteUser`, `containerUser` | Silently ignored |
| `onCreateCommand`, `updateContentCommand` | Ignored — the source is cloned at boot, never baked into the image |
| `postStartCommand` | Ignored, deliberately: a parked container resumes many times per issue and this would run on every unpark |
| `postAttachCommand` | No analogue |

File precedence follows the spec: `.devcontainer/devcontainer.json`, then
`.devcontainer.json`. `.devcontainer/<folder>/devcontainer.json` is **not**
supported — it exists so a human can choose between configurations, and there is
nowhere to ask. The reference CLI does not implement that discovery either.

#### Known gaps

- **An issue that edits its own devcontainer gets the base branch's
  environment.** The file is read from the repository's base branch, not from
  the issue's own branch, so an issue whose whole job is to add a toolchain does
  not get it. This was chosen deliberately — per-issue builds would multiply
  disk imports by issue count — and is written down here so it is not filed as a
  bug.
- **A devcontainer change never applies retroactively.** An issue is pinned to
  its image the first time it routes. Treating an author's edit like a
  worker-image bump would replace every in-flight sandbox on that repository
  *and delete its snapshots*, cold-restarting work that was mid-flight and
  destroying the warm path that would have made the restore cheap. A move of the
  **deployment's** own worker image is different, and does still replace
  everything.
- **An issue spanning several repositories uses the default worker image**, and
  says so on the issue. It is the only image carrying every toolchain, and a
  deliberate multi-repository fan-out is exactly the polyglot case. Asking the
  user which environment they want is a possible future refinement.
- **The cache key covers `devcontainer.json` and the `build.dockerfile` it
  references, and nothing else.** A repository whose Dockerfile `COPY`s or
  `ADD`s another file in the repository will not rebuild when only that file
  changes; bump something in the devcontainer to force it.
- **Builds are not verified inside an ACR task yet.** The mechanism exists (ACR
  `cmd` steps accept `docker run` parameters, and the agent has a Docker socket)
  and the build has been proven on an ordinary Docker host, but not on an ACR
  agent.

#### Failure behaviour

A build failure falls back to the default worker image and posts why on the
issue, including the ACR run id — the run id is the load-bearing part, because it
is what makes `az acr task logs --run-id` possible. The full build log is never
relayed: that build ran with unrestricted egress over repository-controlled
content, so it stays behind Azure's own authorization.

A repository registered through the setup UI is **validated before it is
registered** — a `dockerComposeFile` devcontainer is refused on the form, with
the reason, rather than half-working. That is one GitHub API call; a devcontainer
that cannot be read (GitHub unreachable) is not treated as a rejection.

Registration then gets a **warm build**, fire-and-forget. It never blocks or
fails registration; its status appears in the Environment column of
`/setup/repositories`, which is the only place a fire-and-forget failure is
visible at all.

A build interrupted by a router restart is **rescheduled on the next start**, and
anything held on it released. The `building` marker is durable but the callback
that clears it is not, so without this an issue would wait on "Building image…"
that nothing alive could ever resolve.

Unreferenced disk images are collected every 6 hours. Nothing is deleted while
any issue is pinned to it, while any snapshot was taken from it, while it is the
newest ready image for its repository, or if it is the deployment's own default.

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
[`infra/azure/README.md`](../infra/azure/README.md#teardown): destroy all
router-managed containers, delete leftover data-plane snapshots (and optional
disk images), export the per-user secret store if it was ever enabled, and only
then `az group delete`. The Bicep stack owns the ARM sandbox group but none of
its data-plane children.

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

### Custom skills via a dotfiles repo

Two per-user variables, set on this page like any other, let a teammate bring
their own agent skills into their containers:

| Variable | Effect |
|----------|--------|
| `DOTFILES_REPO` | A git URL cloned into `$HOME/dotfiles`; its `install.sh` is run on every boot |
| `CYRUS_DEFAULT_SKILLS` | Which of the **bundled Cyrus** skills to keep — unset or `all` (default), `none`, or a comma-separated list |

`install.sh` delivers skills by copying directories into `$HOME/.claude/skills`,
which Cyrus unions into the session's skill set:

```sh
# install.sh
mkdir -p ~/.claude/skills
cp -R "$(dirname "$0")"/skills/. ~/.claude/skills/
```

The clone happens once per container filesystem — `applyDotfiles` skips it when
`$HOME/dotfiles/.git` already exists, and only re-runs `install.sh`. A container
that is suspended and resumed keeps the copy it cloned, so **pushing a new skill
to your dotfiles repo does not reach a container that already exists**. Destroy
the container (or re-prompt the issue so a fresh one is created) to pick it up.

A plain directory copy is the supported route. `claude` is not on `PATH` in the
worker image — Claude Code reaches the container only as the SDK-bundled copy —
so `claude plugin install` and `claude plugin marketplace add` are unavailable
to `install.sh`, and `~/.claude/plugins/installed_plugins.json` is an internal
format that should not be hand-written.

`CYRUS_DEFAULT_SKILLS` affects **only** the five bundled Cyrus skills. Skills
from a dotfiles repo, from the CYHOST-managed user plugin, and from a repo's own
`.claude/skills` are never filtered by it.

Two of the bundled five are product plumbing rather than workflow opinion:
`summarize` is what streams a session's final message into the Linear agent
session, and `verify-and-ship` is what opens the pull request. Turning them off
is supported, but you are then responsible for supplying replacements —
otherwise sessions quietly stop opening PRs and stop posting summaries. If you
are replacing the set, `CYRUS_DEFAULT_SKILLS=summarize,verify-and-ship` is the
recommended starting point: none of Cyrus's routing advice is emitted (every
rule it describes opens with a skill you have removed), but the agent is still
told to run `verify-and-ship` after a code change and to close with
`summarize`.

Scope note: skills reach **Claude and Codex** sessions — Claude discovers
`~/.claude/skills` natively, and Cyrus stages the same directories into Codex's
`.agents/skills` layout. Gemini and Cursor sessions get no skills; note that the
skills listing is still appended to their system prompt, so an agent on those
runners may be told about skills it cannot invoke. And since this repo symlinks
its own skills into `.claude/skills`, `CYRUS_DEFAULT_SKILLS=none` will not hide
them when the session is working on cyrus itself — they arrive repo-locally as
well.

The same variables work for physical-device targets, sourced from
`~/.cyrus/.env` rather than from the router's per-user secret store.

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

For the full staged rollout — the two-deployment sequence, the live
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

The same saved connection is used by `cyrus runs`; there is no second login or
router URL to configure. The CLI converts the stored WebSocket URL back to the
matching HTTP(S) origin and sends the device token as a bearer token.

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

> This is your device's own routing config, separate from the router-wide
> repository registry described under [The repository
> registry](#the-repository-registry). Router-side repository selection is
> skipped for physical-device targets, so it still routes locally from the
> array below. Container-target sessions are routed by the registry instead —
> manage those at `https://<router-fqdn>/setup/repositories`.

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

### Observe agent runs

Use the connection created by `cyrus connect` to see what the router currently
knows about your runs:

```bash
cyrus runs                         # recent runs owned by this user
cyrus runs NOR-402                 # runs for one issue
cyrus runs NOR-402 --comment <id>  # the run that received a Linear comment
cyrus runs NOR-402 --watch         # wait for a terminal outcome
```

`--after <ISO timestamp>` narrows the result by the time input was last routed.
It is a fallback for clients that did not retain the Linear comment ID.
`--json` emits one JSON object per observation (NDJSON while watching), and
`--timeout <seconds>` bounds a watch. A watch exits successfully only for
`complete`; `error`, `stopped`, `unknown`, timeout, and connection failure are
non-zero outcomes. A watch requires an issue or comment filter.

The router records a stable run ID, issue and agent-session IDs, routed input
references, lifecycle timestamps, the latest successfully published Linear
agent activity, worker heartbeat/liveness, and the executor's last sampled
state. It does not persist the comment body or its first line: `commentId` and
`activityId` are the correlation keys. Executor state is sampled by the normal
one-minute lifecycle sweep, so `sandboxStateObservedAt` tells callers how fresh
that fact is. The endpoint deliberately reports facts rather than guessing that
a run is healthy or stalled.

Terminal observations are retained for 24 hours. If the router loses ownership
without receiving an exact terminal result, the run becomes `unknown`; that
means the outcome is unavailable, not necessarily that the work failed.

The underlying `GET /runs` route uses the same device bearer token. A physical
device token may query its owner's runs; a container token is restricted to its
own issue. Query parameters are `issueKey`, `commentId`, and `since`.

**An agent run waiting is not the same fact as its container being parked.** A
run waits when it cannot progress until a stated condition changes — today the
only such condition is an elicitation, a user decision the run explicitly asked
for. A container is parked when it is stopped while idle to save money. They
usually coincide, because a run that blocks on a user answer releases affinity
and lets the idle sweep park the container, but either can happen without the
other: a container is parked for plain idleness with no run waiting on anything,
and a run on a physical device waits with no container to park. The wire and
store still spell the waiting run state `parked`, which is the older name for
it; [ADR-0012](adr/0012-run-observations-preserve-event-time-facts.md) replaces
that with an explicitly worker-reported wait reason, and the rename lands with
that work rather than here.

Neither fact is a verdict. A waiting run has not failed and has not stalled, and
elapsed waiting time is reported so callers can apply their own thresholds —
`CONTEXT.md` fixes this vocabulary under *Waiting run*, *Elicitation*, and
*Park*. The decisions behind the observability surface this route is growing
into are recorded in
[ADR-0009](adr/0009-separate-remote-observability-principals.md) (user and fleet
operator are separate principals),
[ADR-0010](adr/0010-clients-query-log-sources-described-by-router.md) (clients
query the log source the router describes; logs are never proxied),
[ADR-0011](adr/0011-one-cli-exposes-role-specific-command-profiles.md) (one CLI,
role-specific command profiles),
[ADR-0012](adr/0012-run-observations-preserve-event-time-facts.md),
[ADR-0013](adr/0013-run-recovery-reconciles-ownership-before-releasing-it.md)
(recovery reconciles ownership before releasing it),
[ADR-0014](adr/0014-operator-http-capabilities-are-discovered-and-versioned.md)
(operator HTTP capabilities are discovered and versioned),
[ADR-0015](adr/0015-remote-operations-use-a-resource-interface-and-workflow-cli.md)
(resource interface on the router, workflow CLI on the client), and
[ADR-0016](adr/0016-run-watches-consume-durable-material-changes.md) (watches
consume a durable change feed). They extend
[ADR-0008](adr/0008-router-retains-agent-run-observations.md), which established
that these observations report evidence rather than policy.

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
*any* device — new agent sessions on that same issue are rejected with an
activity explaining that the comment did not reach the running session. The
router is the only component that sees every session across every device, so it
is the natural enforcement point against two machines diverging on one issue.

A lock is released when: the session reaches a terminal state (complete / error /
stopped), the device's token is revoked, the device stays offline past the TTL,
or an admin runs `cyrus router unlock <issueId>`.

> **A new top-level `@cyrus1` comment on a locked issue does not start a fresh
> session.** Linear *does* create an agent session for it and the router *does*
> route it — it is then rejected here, and the explanation is posted into the
> new (and immediately abandoned) session's own thread, where nobody is looking.
> **Reply inside the running session's thread instead**: that produces
> `AgentSessionEvent/prompted`, which is not lock-gated and reaches the sandbox.
>
> If the holder is someone ELSE's session and `creatorOnlyPrompting` is on (the
> default), replying in its thread will not work either — the creator-only gate
> rejects it — so the rejection says so instead of sending you round a loop.
>
> Every refusal emits `routing.rejected` and logs at WARN, on both the `created`
> and the `prompted` path: `issue_locked`, `unenrolled_creator`,
> `invalid_issue_key`, `non_creator_prompt`, `prompt_unroutable`,
> `repositories_unavailable`. That is what lets an operator tell a dropped
> comment from a webhook that never arrived — see the `Cyrus-Routing-Rejections`
> saved search.
>
> If the holding session has stopped working, its sandbox is also reported by
> `sandbox.stranded_session` with `cyrus.reason = no_progress`. **Do not run
> `cyrus router unlock` on the strength of that alone**: the router cannot
> distinguish a strand from a session deliberately waiting on a scheduled
> wakeup, because the deferral is recorded only on the device. Establish which
> it is from the `Cyrus-Sessions-Never-Terminal` saved search (a row means the
> newest deferral postdates the newest terminal signal, and names what it is
> waiting on) and from `cyrus router sessions list`. Unlocking a session that is
> about to resume releases the lock but NOT its session affinity, which
> manufactures the lock-without-affinity divergence the detector cannot see.
> See NOR-402.

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
| `cyrus runs [issue] [--comment <id>] [--after <time>] [--watch] [--timeout <seconds>] [--json]` | device | Query or watch owner-scoped agent runs using the connection saved by `cyrus connect`. |
| `cyrus start` | device | Begin receiving and running your routed sessions. |
