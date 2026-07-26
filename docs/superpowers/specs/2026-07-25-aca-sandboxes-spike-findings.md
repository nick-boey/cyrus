# ACA Sandboxes — Task 0 Spike Findings

> Companion to `docs/superpowers/plans/2026-07-25-container-executors-azure-aca-sandboxes.md`.
> **Run date:** 2026-07-26 · **Operator:** nick.boey
> **Environment:** subscription `dit-development` (`1efb7cc3-4a62-4f9b-9c01-d9f532c0c526`),
> tenant `c9857cc6-…` (Northrop), resource group `rg-cyrus-aca-spike`, region **australiaeast**,
> sandbox group `cyrus-spike-grp`.
> **Cost posture:** all sandboxes, snapshots and disk images created during the spike were
> deleted at the end of the run. Only the (compute-free) sandbox group remains.

## Status summary

| Spike | Verdict | Impact on plan |
|---|---|---|
| S0 — Linear webhook delivery | **NOT RUN — not an Azure spike** | Task 6 still gated. See "S0" below. |
| S1 — Worker image boot | **PASS (mechanism), PARTIAL (real image)** | Custom OCI registration + env + entrypoint proven with a stand-in image. **New risk found — see F1.** |
| S2 — Data-plane shapes | **PASS — with 6 corrections** | Client interface in Task 4 needs rework. |
| S3 — Suspend semantics | **PASS** | Resume measured **0.52 s**. No SIGTERM. |
| S3b — Snapshot env inheritance | **PASS — decisively** | Task 5 create-from-snapshot fast path is **viable**. |
| S4 — Egress | **PASS — better than planned** | WSS works under `Full`. No `Partial` fallback needed. |
| S5 — Names/labels | **PASS — question was mis-framed** | Sandbox names don't exist (GUIDs). Labels cap at 63 chars. |
| S6 — RBAC | **PASS** | Documented role GUID is correct. Propagation < 1 min. |
| S7 — Region availability | **PASS** | 35 regions incl. **australiaeast**. |

**Bottom line: no blocker was found.** Every load-bearing assumption in the plan either held or
was replaced by something better. The corrections below are mostly mechanical (wire shapes),
with two genuine design consequences (**F1** and **F2**).

---

## Headline findings that change the plan

### F1 — Sandbox liveness is decoupled from the entrypoint process (NEW RISK, not in the plan)

A sandbox whose entrypoint runs and then **exits** stays in state `Running` indefinitely, with
PID 1 = `tini`. Verified directly: entrypoint `sh -c 'echo … > /tmp/boot.log; exit 0'` →
`boot.log` written, process gone, sandbox still `Running` minutes later.

Two consequences:

1. The plan's S1 premise — *"a long-lived PID 1 keeps the sandbox `Running`"* — is **false but
   harmless**; `container-boot` does not need to hold PID 1.
2. **The real problem:** if `container-boot` crashes, the sandbox still reports `Running`.
   `AcaSandboxesProvider.status()` mapping `Running → running` would report a **dead worker as
   healthy**, and `ensureRunning` would no-op forever on a sandbox that can never reconnect.
   Docker's provider does not have this failure mode (a dead PID 1 exits the container).

**Recommended plan change (Task 5):** treat sandbox state as *infrastructure* liveness only.
Health must come from the router's existing device/WSS connection state. At minimum, add a
`Running`-but-not-connected reconciliation path (recreate after N missed heartbeats) rather than
trusting `status()`.

### F2 — `create-from-snapshot` silently resets the lifecycle policy to the 300 s default

The original sandbox was created with auto-suspend disabled. After
snapshot → delete → create-from-snapshot, the new sandbox came back with:

```json
"lifecycle": {"autoSuspendPolicy": {"enabled": true, "interval": 300, "mode": "Memory"}}
```

Combined with the documented idle definition — *"no ingress traffic, no code execution, no
interactive shell sessions, and no file operations"* — note that **outbound WSS traffic is not
activity**. A restored Cyrus worker sitting on an open WSS connection is "idle" by ACA's
definition and would be frozen mid-task after 5 minutes.

This independently confirms **N5** and makes it stronger: the provider must set the lifecycle
policy **explicitly on every create path**, including create-from-snapshot. Passing it in the
create body works; a follow-up `POST /lifecycle` also works.

---

## S0 — Linear webhook delivery — NOT RUN

S0 is a **Linear** spike (does the router-mode OAuth app receive `AppUserNotification` /
`issueStatusChanged` and `Issue` remove?). It involves no Azure resources and cannot be run with
`az`. It was therefore out of scope for this session.

**Task 6 remains gated on S0.** Nothing in this document unblocks it.

---

## S1 — Worker image boot — PASS (mechanism) / PARTIAL (real image)

The real `cyrus-worker` image exists only as a local tag (`cyrus-worker:dev`); it has never been
pushed to a registry, so it could not be registered as a disk image. The **mechanism** was
validated end-to-end with a public stand-in (`docker.io/library/redis:alpine`).

- `PUT /diskimages` with `{"image":{"base":"docker.io/library/redis:alpine"}}` → `Ready` in
  **~17 s**, `sizeInMB: 188`. Docker Hub pulled anonymously with no credentials.
- Booting it: image `ENTRYPOINT` ran (`redis-server` present in `ps`), injected env arrived
  (`WORKER_ENV=hello-from-env`), state `Running`, PID 1 = `tini`.
- `entrypoint` / `cmd` overrides in the create body work and are echoed back on `GET`.
- **No entrypoint/command override is needed** for an image that already has a correct
  `ENTRYPOINT`.
- Private registries: `registryCredentials: {username, token}` or `managedIdentityResourceId`
  on the disk-image create — confirms **N7** (ACR + MI is a supported path).
- Dockerfile-based images are also supported (`dockerfileContent` on the DiskImage model), which
  is a cheaper option than a registry for the worker image if desired.

**Outstanding:** boot the *actual* `cyrus-worker` image and confirm `container-boot` runs. This
requires pushing the image somewhere first — a Task 1 prerequisite regardless. See **F1** for the
risk this leaves open.

---

## S2 — Data-plane shapes — PASS with corrections

### Confirmed as planned

- Data-plane host format `https://management.{region}.azuredevcompute.io` ✓ — **and better:**
  the ARM resource returns it directly as `properties.managementEndpoint`. The provider should
  read it rather than string-templating the region.
- Path layout has **no** `/providers/Microsoft.App` segment ✓ (that form 404s).
- Token audience `https://dynamicsessions.io/.default` ✓ (the dynamic-sessions lineage quirk is real).
- api-version `2026-02-01-preview` ✓ (the only version the provider advertises).

### Corrections required in Task 4's `AcaSandboxClient`

| # | Plan assumed | Reality |
|---|---|---|
| C1 | `name: string` identifies a sandbox; naming `cyrus-issue-<key>` | **Ids are server-assigned GUIDs.** A non-GUID path segment fails validation (`{"errors":{"id":["The input was not valid."]}}`). There is no user-supplied name. Issue→sandbox mapping **must** go through labels. |
| C2 | `createSandbox` = `PUT /sandboxes/{name}` | Create is **`PUT /sandboxes`** on the *collection*; the id comes back in the response. |
| C3 | `disk` / `snapshotId` as flat create fields | Nested: `sourcesRef: { diskImage: {id\|name, isPublic} }` **or** `sourcesRef: { snapshot: {id} }`. |
| C4 | `egressPolicy.inspectionMode` | Field is **`trafficInspection`**, values `Legacy\|Full\|Partial\|None`. Host rules are `hostRules: [{pattern, action}]`, plus a separate `rules: []`. |
| C5 | `autoSuspendSeconds` as a create field | Nested lifecycle object, and the **wire field names differ from the SDK's TS model**: the wire uses `autoSuspendPolicy` / `autoDeletePolicy` (`{enabled, interval, mode}`), *not* `autoSuspend` / `autoDelete`. Sending the SDK's names is silently ignored — this is how F2 was found. |
| C6 | `AcaSnapshot.diskImage` for staleness | **No such field.** Snapshot = `{id, labels, sandboxId, status, vmmType, createdAtUtc, resources, sizeInMB}`. Image lineage must be carried in a label (the plan's `cyrus.disk` label is therefore *required*, not optional). |

### Corrected route table (verified live)

All paths prefixed `/subscriptions/{sub}/resourceGroups/{rg}/sandboxGroups/{group}`:

```
GET    /sandboxes                       list (optional ?labels=k=v,k2=v2)
PUT    /sandboxes                       create  → returns Sandbox with server-assigned id
GET    /sandboxes/{id}                  get
DELETE /sandboxes/{id}                  delete
POST   /sandboxes/{id}/stop             suspend  (requires a JSON body — see C7)
POST   /sandboxes/{id}/resume           resume
POST   /sandboxes/{id}/snapshot         explicit snapshot (labels in body)
POST   /sandboxes/{id}/lifecycle        set auto-suspend / auto-delete
POST   /sandboxes/{id}/executeShellCommand
POST   /sandboxes/{id}/commit           filesystem → disk image
POST   /sandboxes/{id}/egresspolicy     replace egress policy on a live sandbox
GET    /sandboxes/{id}/egress-decisions egress allow/deny observability
GET    /sandboxes/{id}/stats
GET/PUT/DELETE /sandboxes/{id}/files , /files/list , /files/stat , POST /files/mkdir
POST   /sandboxes/{id}/ports/add|remove , PUT /ports
POST   /sandboxes/{id}/volumes/add
GET    /snapshots , GET/DELETE /snapshots/{id}
GET    /diskimages , PUT /diskimages , GET/DELETE /diskimages/{id}
GET    /diskimages/public , /diskimages/public/{name}
GET    /secrets , PUT/DELETE /secrets/{id} , GET /secrets/{id}/keys , POST /secrets/{id}/peek
GET    /volumes , PUT/GET/DELETE /volumes/{name}
```

Note `/diskimages` is **lowercase** on the wire.

### Additional wire behaviours the client must handle

- **C7 — `POST /stop` requires a body.** With `Content-Length: 0` and no `Content-Type` the
  request **hangs until timeout** (observed: >120 s, `http=000`). Sending `{}` with
  `content-type: application/json` returns in ~6 s. The same applies to `/resume`. This is a
  sharp edge worth an explicit comment in the client.
- **Create is synchronous.** `PUT /sandboxes` returned `200` with `state: "Running"` in **~1 s**
  from a disk image and **0.52 s** from a snapshot. No `azure-asyncoperation` / `Location`
  header, no polling needed. (The SDK still models these as `begin*` LROs, so a polling fallback
  is prudent but was never exercised.)
- **List responses are a bare JSON array** (`[...]`) at small sizes — *not* ARM's
  `{"value": […]}`. But the official SDK's paging helper declares
  `itemName: "value", nextLinkName: "nextLink"`, so at scale the envelope form appears.
  **The client must accept both shapes.**
- **`DELETE` is naturally idempotent**: first delete `200`, second delete `204` — never 404.
  Snapshot/disk-image deletes return `202` (async).
- **Error shapes are RFC 9110 ProblemDetails, not ARM errors.** Two variants observed:
  - validation: `{"title":"One or more validation errors occurred.","status":400,"errors":{"<field>":["…"]},"traceId":…,"requestId":…}`
  - domain: `{"title":"SandboxNotFound","status":404,"detail":"Requested document not found.","errorCode":1,…}`
  There is **no** `{"error":{"code","message"}}` envelope. Surface `title` + `errors`/`detail`.
- **Wrong token audience → `401`** (not 403).
- **`api-version` is not enforced** — `?api-version=1999-01-01` returned `200`. Do not rely on it
  for version pinning safety.
- **State enum** (from the SDK, matching observation):
  `Running | Stopped | Suspended | Idle | Resuming | Stopping | Creating | Deleting`.
  The plan guessed `Suspending`; the real transitional value is `Stopping`. **In practice a
  suspended sandbox reports `Stopped`, not `Suspended`** — the docs only describe `Running` and
  `Stopped`. Map `Stopped` → stopped.
- `GET /sandboxes/{id}` also returns `outboundIpAddresses` (10 IPs observed) — useful if the
  router ever needs an inbound firewall allowlist.
- **`environment` is write-only.** It is accepted on create and reaches the process, but is
  **never returned** by `GET`. This is *better* than D1 assumed: the plan's caveat that "sandbox
  env may be inspectable via a data-plane GET" does not hold. Worth relaxing that note in D1.

### Server-side label filtering (improves Task 5)

`GET /sandboxes?labels=cyrus.issue=DEF-1` filters server-side (verified: exact match returns the
one sandbox, a bogus key returns `[]`). Multiple pairs are comma-joined.

This means `listManaged` and the per-issue lookup can each be a **single filtered call** — better
than the plan's "one unfiltered list + client-side filter" and fully consistent with M1's
"exactly one network call" requirement.

---

## S3 — Suspend semantics — PASS

Method: installed a daemon in the sandbox that traps `SIGTERM` (appending to `evidence.log`) and
writes a 1 Hz heartbeat, then suspended and resumed.

| Measurement | Result |
|---|---|
| **Suspend latency** (`POST /stop`, synchronous) | **6.47 s** |
| **Resume latency** (`POST /resume`, synchronous) | **0.52 s** |
| Snapshot size for a 1 vCPU / 2 GiB idle sandbox | **40–41 MB** |

- **"Sub-second resume" is real** — 0.52 s measured. **n2 is resolved**; operator-facing prose can
  state a measured figure rather than hedging.
- **No SIGTERM is delivered.** `evidence.log` contained only the daemon's `started` line — no
  `SIGTERM_RECEIVED`. Confirms the plan's assumption that suspend freezes processes mid-flight
  with no grace period, and that the floor's "tolerate a frozen flush" design is required.
- **Processes survive the freeze intact.** The heartbeat log shows a clean 167-second gap
  (`tick 1785031514` → `tick 1785031681`) with the daemon still alive and ticking afterwards.
  True memory-mode suspend, exactly as D3 assumes.
- **`POST /stop` returns a Snapshot object** (`{id, sandboxId, createdAtUtc, resources, sizeInMB}`),
  so the implicit suspend snapshot is materialised and addressable. **However it is not listed by
  `GET /snapshots`** and disappears after resume — it is transient state consumed by `/resume`,
  not a durable artifact. Do not try to garbage-collect or restore from it.
- **Max sandbox lifetime (N10): none found.** Nothing in the docs or API imposes a hard lifetime.
  `autoDeletePolicy` is opt-in and documented in *days after stop*. No change needed to the
  ACA `staleDestroyMs` default, but this is absence-of-evidence, not a guarantee.

---

## S3b — Snapshot env/token inheritance — PASS (decisively)

**This was the gate on Task 5's create-from-snapshot fast path. It passes.**

Procedure: created a sandbox with `MARKER=spike-s3b` and `CYRUS_DEVICE_TOKEN=dummy-token-abc123`,
wrote a disk marker, started a heartbeat daemon, took a labelled explicit snapshot,
**deleted the sandbox**, then created a new one from the snapshot passing **no `environment` at all**.

Result inside the restored sandbox (a different sandbox id):

```
MARKER=[spike-s3b]
CYRUS_DEVICE_TOKEN=[dummy-token-abc123]
/root/ondisk.txt        -> disk-state-marker
daemon                  -> DAEMON_ALIVE   (heartbeat still ticking)
```

- **Env is inherited** ✓ — including the device token.
- **Disk state is inherited** ✓.
- **Live process memory is inherited** ✓ — the running daemon survived
  snapshot → sandbox deletion → restore into a *new* sandbox id.
- Explicit snapshot creation took **0.92 s**; restore **0.52 s**.
- Labels on the snapshot are preserved verbatim and are queryable.

**Consequences for the plan:**

1. The Task 5 create-from-snapshot fast path **stays in v1** (it is not cut).
2. **D3's lineage check (B5) is not merely defensive — it is essential.** Because the device token
   is genuinely baked into the restored memory image, restoring a snapshot from a previous device
   generation would produce exactly the permanently-unauthable sandbox B5 predicted. The
   `cyrus.device-id` label check must be implemented as specified.
3. Snapshots are **not** garbage-collected: a snapshot whose source sandbox was deleted remained
   listed, still pointing at the dead `sandboxId`. Retention (`keepSnapshots`, `gc-snapshots`) is
   confirmed as our problem — Task 7 is justified.

---

## S4 — Egress — PASS (better than planned)

Applied `defaultAction: Deny` + the D7 allowlist with `trafficInspection: "Full"`.

### Allowlist behaviour

| Host | Result |
|---|---|
| `github.com`, `api.github.com`, `raw.githubusercontent.com` | 200 ✓ |
| `api.anthropic.com` | 401 ✓ (reached; auth expected) |
| `console.anthropic.com` (OAuth refresh — M4) | 301 ✓ (reached) |
| `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org` | 200 ✓ |
| `mcp.linear.app` | 302 ✓ (reached) |
| `example.com`, `google.com`, `cdn.jsdelivr.net` | **403** (blocked) ✓ |

- **Blocked hosts fail fast with HTTP 403** from the egress proxy — not a hang or TCP timeout.
  Good for diagnostics; worth documenting so operators recognise the signature.
- **`git clone` over HTTPS works** (verified against a real repo).
- Policy changes via `POST /egresspolicy` apply to a **live sandbox** within seconds — verified
  with a negative control (hosts allowed under the old policy returned 403 under the new one).

### n1 — wildcard semantics: RESOLVED

**`*.github.com` matches the apex `github.com`.** Verified in isolation: with a policy listing
*only* `*.github.com` (no bare entry), `https://github.com` returned 200 while the previously
allowed `api.anthropic.com` and `registry.npmjs.org` correctly returned 403.

⇒ The D7 list can drop redundant apex entries (`github.com`, and the bare `*.npmjs.org` /
`*.linear.app` companions). Keeping both forms is harmless, so this is a tidy-up, not a fix.

### WSS through `Full` inspection: WORKS — biggest risk retired

A raw WebSocket upgrade against an allowlisted host returned:

```
ws.postman-echo.com  ->  HTTP/1.1 101 Switching Protocols
```

⇒ **The plan's `Partial`-inspection fallback is not needed.** Deny-by-default + `Full` inspection
+ router WSS is a viable v1 posture, and the "WSS through Full egress inspection" entry in
Risks & Open Questions can be closed.

### `git+ssh://` — limitation confirmed, and properly isolated

The plan's M4 limitation is real, and this was verified at the network layer rather than inferred
from a git error message (a git-only test is ambiguous — it fails identically with no SSH key):

```
TCP github.com:22   -> ConnectionRefusedError [Errno 111]
TCP github.com:443  -> CONNECTED
DNS github.com      -> 4.237.22.38   (resolves; egress proxy intercepts DNS)
```

Same host, allowlisted, port 443 fine and port 22 refused ⇒ `Full` inspection blocks non-HTTP TCP
as documented. HTTPS submodule URLs are required. Documented v1 limitation stands.

### Not covered

- `pip install` was **not** exercised — the `ubuntu` public image ships no `pip` and installing it
  requires egress that was itself under test. The HTTPS reachability of `pypi.org` and
  `files.pythonhosted.org` (both 200) is the meaningful half; a real `pip install` should be
  re-checked on the actual worker image.
- `npm install` likewise not run (no npm in the stand-in image); `registry.npmjs.org` returned 200.

---

## S5 — Names and labels — PASS (question was mis-framed)

The plan asked for sanitization regexes for sandbox **names**. **There are no sandbox names** —
ids are server-assigned GUIDs (C1). So the naming rule `cyrus-issue-<key sanitized>` should be
deleted from Task 5; the issue→sandbox mapping is labels-only.

Label constraints, probed directly:

| Input | Result |
|---|---|
| `cyrus.issue=DEF-123` (dotted key, Linear key value) | ✓ accepted |
| `TEAM_ABC-999` (uppercase + underscore) | ✓ accepted |
| `a/b` (slash) | ✓ accepted |
| empty value | ✓ accepted |
| 20 labels on one sandbox | ✓ accepted |
| 256-char value | ✗ `400 — Label value for key 'cyrus.issue' exceeds 63 characters` |

⇒ **Label values are capped at 63 characters** (Kubernetes-style); keys may contain dots. Linear
issue keys and GUID device ids both fit comfortably. **No sanitization is required** — store the
exact issue key. A defensive length guard (truncate/reject >63) is the only validation worth adding.

---

## S6 — RBAC — PASS

- **Role definition GUID: `c24cf47c-5077-412d-a19c-45202126392c`** — the in-tenant lookup
  **matches** the constant documented in the plan. N2's caution turned out to be unnecessary, but
  Task 1 should still resolve it via `data "azurerm_role_definition"` by name as specified
  (correct practice, now with a verified fallback value).
- A **second, undocumented role exists**: *Container Apps SandboxGroup Contributor*
  (`11b23f7a-6229-4518-88db-0576f10dd2a0`). Not needed for our data-plane access, but worth
  knowing it exists when scoping least privilege.
- **Propagation was effectively immediate** — assignment at `02:00:02Z`, first successful
  data-plane call under a minute later, no 403s observed at all. The plan's ~100 s 403-retry
  window is still worth keeping (this was a single sample, on a fresh scope).
- Assignment at sandbox-group scope works; docs also show subscription/RG scope.
- Per the docs, `aca sandboxgroup create` auto-assigns this role to the caller unless
  `--skip-role-check` is passed — relevant to the Task 1 runbook.

---

## S7 — Region availability — PASS

`Microsoft.App` is **Registered** in `dit-development`; `sandboxGroups` and
`sandboxGroups/vnetConnections` both advertise api-version `2026-02-01-preview` only.

**35 regions** are supported — far beyond the eastus2/westus2/westus3 doc examples. Notably
**Australia East is supported**, which is the natural default for this tenant rather than a US
region. Full list includes: australiaeast, eastus, eastus2, westus, westus2, westus3, centralus,
northcentralus, southcentralus, westcentralus, canadacentral, canadaeast, brazilsouth,
mexicocentral, northeurope, westeurope, uksouth, ukwest, francecentral, germanywestcentral,
norwayeast, polandcentral, spaincentral, swedencentral, switzerlandnorth, italynorth,
eastasia, southeastasia, japaneast, japanwest, koreacentral, centralindia, southindia,
southafricanorth, uaenorth.

⇒ Recommend `australiaeast` as the Terraform default `location` for this deployment.

---

## Other facts worth carrying into the plan

- **Resource tiers are fixed** (docs): XS 0.25/0.5 GB, S 0.5/1 GB, **M (default) 1 core/2 GB/20 GB**,
  L 2/4 GB/40 GB, XL 4/8 GB/80 GB. Requested `resources` are normalised server-side
  (`"2Gi"` → `"2048Mi"`, `"10Gi"` → `"10240Mi"`). Task 5's proposed default of 4 vCPU / 8 GiB is
  the **XL** tier — the most expensive; worth a conscious decision rather than a default.
- **Group-scoped `secrets` and `volumes` APIs exist** (`/secrets/{id}` with `peek` and `keys`;
  Azure Blob volumes mountable to *many* sandboxes, Data Disk to one). D1 chose env injection over
  group secrets and that still looks right for v1, but the Azure Blob volume type is a plausible
  future home for artifact bundles — worth noting against the "Non-Goals" list.
- **Public built-in images** available: `ubuntu`, `claude`, `copilot`, `dotnet-8`, `dotnet-9`,
  `php-8.3`, `php-8.4`, and others. A `claude` image exists and may be worth comparing against our
  own worker image.
- **Preview compatibility warning (docs, verbatim):** *"Sandboxes created during preview might not
  be compatible with future releases and might need to be recreated."* This is a direct argument
  for D2 — the floor must stay unconditional.
- **The ARM `sandboxGroups` resource takes almost no properties.** Created successfully with
  `properties: {}`; the server returned `allowedLocations`, `connections`, `managementEndpoint`,
  `provisioningState`. The plan's assumed `defaultCpu` / `defaultMemory` / `defaultDisk` /
  `maxSandboxCount` properties **do not appear** — Tasks 1 and 2 (Terraform AzAPI body and the
  Bicep reference) must be rewritten against the real shape, and `maxSandboxCount` cannot be
  relied on as a cost guard.

### n4 — snapshot pricing citation: PARTIALLY RESOLVED

The Container Apps pricing page states only:

> "Azure Container Apps Express and Sandboxes follow the same pay-per-second pricing as Consumption Plan."

**No sandbox-specific or snapshot-storage meter is published.** The plan's claim that snapshots are
"free during preview, billed as blob storage afterwards" **could not be substantiated from an
official pricing source**. Since snapshots are never GC'd by Azure, treat post-preview snapshot
cost as an unquantified risk; keep `keepSnapshots` pruning and `gc-snapshots` (Task 7), and
re-check the pricing page at GA.

---

## Reproduction

```bash
SUB=1efb7cc3-4a62-4f9b-9c01-d9f532c0c526; RG=rg-cyrus-aca-spike; GRP=cyrus-spike-grp
BASE=https://management.australiaeast.azuredevcompute.io; AV=2026-02-01-preview
ROOT="/subscriptions/$SUB/resourceGroups/$RG/sandboxGroups/$GRP"
TOK=$(az account get-access-token --resource https://dynamicsessions.io --query accessToken -o tsv)

curl -s -H "authorization: Bearer $TOK" "$BASE$ROOT/sandboxes?api-version=$AV"
```

The official TypeScript SDK — the source of truth used to recover the route table and models — is
`npm pack @azure/containerapps-sandbox` (v1.0.0-beta.1); routes live in
`dist/esm/api/*/operations.js`, models in `dist/esm/models/models.d.ts`. **Reading it is strongly
recommended before writing Task 4**, but note C5: its TS model field names (`autoSuspend`) differ
from the wire (`autoSuspendPolicy`), so verify against live HTTP rather than trusting the types.

## Teardown

```bash
az group delete -n rg-cyrus-aca-spike --subscription 1efb7cc3-4a62-4f9b-9c01-d9f532c0c526 --yes
```

Sandboxes, snapshots and disk images were already deleted; only the empty sandbox group remains.
Per the M5 teardown note — validated here — **snapshots survive their source sandbox and are not
GC'd by Azure**, so a real deployment must sweep snapshots before destroying the group.
