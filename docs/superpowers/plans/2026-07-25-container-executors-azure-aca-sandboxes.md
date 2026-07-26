# Container Executors: Azure Container Apps Sandboxes Provider + Azure Router Hosting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **Revision history:**
> - **2026-07-25 (r1):** Initial plan.
> - **2026-07-25 (r2):** Incorporated an adversarial review (GLM-5.2, read-only subagent; transcript preserved): 5 blockers (B1–B5), 9 majors (M1–M9), 10 minors (N1–N10), 4 nits (n1–n4). Largest changes: terminal-destroy now rides the `issueStatusChanged` **notification** webhook (B1/B2) with a new delivery spike S0; the floor flush is re-ordered before `removeSession`/`deleteWorktree` (B3/M9); snapshot restore is device-lineage-checked via an additive `ctx.deviceId` (B5); D5's "CLI UX unchanged" claim replaced with the honest remote-operator story (B4); the egress allowlist is expanded for OAuth refresh + polyglot package managers (M4); ACA-side auto-suspend defaults to **disabled** (N5); the live Azure smoke is a merge gate (M8). Findings are cited inline as (B#)/(M#)/(N#)/(n#).

**Goal:** Users with `executor: aca` get an Azure Container Apps (ACA) Sandbox per issue — fast resume from memory-mode suspend (sub-second target, measured in spike S3 — n2), storage-only cost while parked, deny-by-default egress — with the router itself optionally hosted as a single-replica Container App whose secrets live in Key Vault and whose users authenticate with Entra ID.

**Architecture:** `AcaSandboxesProvider implements ContainerExecutor` against the ACA Sandboxes data-plane REST API, with a typed `AcaSandboxClient` wrapper (injectable `fetch` + injectable Entra token provider for tests). Snapshots (memory+disk, implicit on suspend) are the warm-resume path — lineage-checked per D3; the phase 1 floor (git WIP push + artifact bundle upload) remains the durable/cold path and is the *only* egress route for session records and workspace state — unchanged. The router deploys to Azure via Terraform (primary) + Bicep (reference) under `infra/azure/`.

**Tech Stack:** TypeScript strict, Vitest, ACA Sandboxes data plane `2026-02-01-preview` (hand-rolled REST — no preview SDK dependency), `@azure/identity` (lazy-imported), `jose` (Entra JWT validation, lazy-imported), Terraform azurerm + AzAPI providers, Bicep.

**Prerequisite:** Phase 1 plan fully landed (`docs/superpowers/plans/2026-07-13-container-executors-phase1-floor-docker.md`).

**Relationship to other phases:** Takes the design spec's phase-4 slot ("ACA-class stateless provider — falls out of the floor") and serves Azure shops as the alternative to phase 2 (Fly). The task structure extends the Fly template (typed client → provider → validation) with three net-new surfaces the Fly plan did not need: Azure hosting infra (Tasks 1–3), terminal-state destroy (Task 6), and Entra enrollment (Task 8) — it does not merely "mirror" the Fly plan (N9). Phases 2/3 remain valid; operators pick one provider per deployment.

---

## Research Summary: ACA Sandboxes (public preview, announced 2026-06)

Confirmed from Microsoft Learn, the sandboxes.azure.com docs, and the shipped Python SDK source (see Risks for confidence flags):

- **Resource model:** ARM resource `Microsoft.App/sandboxGroups` (api-version `2026-02-01-preview`) is the identity/quota/secret boundary. Sandboxes themselves are created/managed via a **regional data plane**: `https://management.{region}.azuredevcompute.io`, paths of the form `/subscriptions/{sub}/resourceGroups/{rg}/sandboxGroups/{group}/sandboxes/{id}?api-version=2026-02-01-preview` (note: **no** `/providers/Microsoft.App` segment on the data plane).
- **Auth:** Entra ID only. Control-plane token audience `https://management.azure.com/.default`; **data-plane audience `https://dynamicsessions.io/.default`** (lineage quirk — dynamic sessions predecessor). Data plane requires the built-in role **Container Apps SandboxGroup Data Owner** (role definition id `c24cf47c-5077-412d-a19c-45202126392c` — verify in-tenant in S6, N2).
- **Boot sources:** sandboxes boot from group-scoped **disk images** (public built-ins; custom OCI images registered via the group's disk API, with registry auth incl. managed identity for ACR; or `commit`ted sandbox filesystems) **or from snapshots**.
- **Suspend/resume/snapshot:** `POST /stop` suspends (memory mode default: full memory+disk state; spike S3 measured 0.52 s resume and no SIGTERM). `POST /snapshot` captures an explicit group-scoped snapshot; a new sandbox can be created from a snapshot, and spike S3b verified resource tier, entrypoint, memory, disk, and env/device-token inheritance. Snapshots are **not garbage-collected by Azure** — retention is our problem. No official snapshot-specific meter was published during the spike; post-preview snapshot cost is unquantified, not proven to be free during preview or ordinary Blob pricing afterward.
- **Egress:** per-sandbox egress policy — `defaultAction: Allow|Deny`, ordered host rules with wildcards (wildcard semantics confirmed in S4, n1), CIDR rules, header Transform/Rewrite actions, inspection modes `Full|Partial|None`. Full mode enforces deny rules and **blocks non-HTTP TCP/UDP** (Azure DNS excepted) — this kills `git+ssh://` and similar; documented v1 limitation (M4).
- **Ingress:** no traditional ingress; per-port generated HTTPS URLs (anonymous or Entra-gated, IP ACLs). Cyrus containers need **no inbound ports** (they dial out to the router over WSS) — a nice security property vs Docker/Fly.
- **Scale/cost:** per-second vCPU+memory billing (Consumption-plan rates) and scale-to-zero while suspended. The sandbox-group ARM resource has `properties: {}` and **no** `maxSandboxCount` or default CPU/memory/disk properties; Cyrus applies resources and lifecycle policy per sandbox. ACA's 300 s lifecycle default is explicitly disabled on every create path (N5/F2). Tiers range up to 4 vCPU / 8 GiB / 80 GB.
- **IaC:** Bicep natively supports `Microsoft.App/sandboxGroups@2026-02-01-preview`. Terraform azurerm has **no** resource (same as dynamic sessions before it) → use the **AzAPI provider** (`azapi_resource`).
- **Tooling:** standalone `aca` CLI (no `az containerapp sandbox` commands), Python SDK `azure-containerapps-sandbox`, dedicated portal `sandboxes.azure.com`. Example regions in docs: eastus2, westus2, westus3.

## Architecture

```
                 ┌──────────────────────────── Azure (per deployment) ───────────────────────────┐
                 │                                                                                │
 Linear webhook  │   ┌──────────────────────┐        data plane (Entra, RBAC)                     │
 ────────────────┼──▶│ Router Container App │────────────────────────────────┐                   │
  (HTTPS, HMAC)  │   │ 1 replica, KV env    │                                ▼                   │
                 │   │ secrets, MI          │        ┌──────────────────────────────────┐        │
                 │   │                      │        │ Sandbox Group (shared, v1)        │        │
                 │   │ /data ephemeral      │        │  ┌───────────┐   ┌───────────┐    │        │
                 │   │  └─ router.db        │        │  │ sandbox    │   │ sandbox    │   │        │
                 │   │     + blob backup ◀──┼────────┼─▶│  DEF-1     │   │  DEF-2     │…  │        │
                 │   │ /data/artifacts      │        │  │ /workspaces│   │ /workspaces│   │        │
                 │   │  (Azure Files)       │        │  └─────┬─────┘   └─────┬─────┘    │        │
                 │   └──────▲───────────────┘        └────────┼───────────────┼──────────┘        │
                 │          │ WSS (device)                    │ WSS + HTTPS   │                   │
                 │          └─────────────────────────────────┴───────────────┘                   │
                 │            (sandboxes dial OUT; no inbound ports; egress policy = deny-by-      │
                 │             default allowlist — D7)                                            │
                 │   Key Vault: router config secrets + per-user secret bundles (router MI)       │
                 │   Blob: router.db backups   Files: artifact bundles   Log Analytics: logs      │
                 └────────────────────────────────────────────────────────────────────────────────┘
```

Persistence model (unchanged from the design spec, with snapshots added as the warm tier):

| Tier | Mechanism | Survives | Used when |
|---|---|---|---|
| Warm | ACA suspend snapshot (memory+disk, implicit) | idle-stop, reboots | resume — fast (measured in S3) |
| Cool | Explicit snapshot (labeled per issue, **lineage-checked per D3**) | sandbox deletion (auto-delete, preview recreate) | create-from-snapshot fast path |
| Floor | git WIP push + artifact bundle PUT | **everything** (region loss, group recreation, provider switch) | cold boot, image upgrade, executor switch, issue reopen |

## Key Design Decisions

- **D1 — Shared sandbox group, per-sandbox env injection (migratable).** One group per router deployment. Per-user secrets (`CLAUDE_CODE_OAUTH_TOKEN`, `GIT_TOKEN`, …) are injected as sandbox env vars at create time — matching today's Docker posture (`buildEnv`). Group-scoped ACA secrets are **not** used for per-user values in v1: docs conflict on whether sandbox code can read arbitrary group secrets at runtime, so we treat the group as a shared-trust boundary. (Caveat carried from review focus area 5: sandbox env may be inspectable via a data-plane GET by anyone with SandboxGroup Data Owner — same trust set as the router MI, acceptable.) The provider takes the group name from config, so a later move to per-user groups (which would unlock egress-proxy header injection of per-user tokens) is a config/provisioning change, not a rewrite.
- **D2 — Snapshots are the warm path; the floor is unconditional.** `WorkspaceSyncService` (git WIP push + bundle upload on session end / 5-min tick / shutdown) keeps running exactly as today. Snapshots never replace it: they are region-pinned, group-bound, preview-lifecycle-risky, and cannot cross providers (the aca→docker floor proof depends on the floor). No executor "capabilities" flag — all snapshot logic is provider-internal.
- **D3 — Stop = memory-mode suspend; resume keeps the original device token; snapshot restore is lineage-checked (B5).** `mintDeviceToken()` is called **only** on create-from-image. Resume inherits env from the suspended state. Create-from-snapshot *also* inherits env (verified by spike S3b; if env is **not** inherited, the create-from-snapshot path is cut from v1 — suspend/resume + floor only). Because the baked-in `CYRUS_DEVICE_TOKEN` must still match the live device row, the provider labels sandboxes and explicit snapshots with `cyrus.device-id` and restores from snapshot **only** when the label matches the current boot's `ctx.deviceId` — an additive, optional field on `IssueExecutionContext` (backward-compatible; Docker/Fly ignore it). Unlabeled or mismatched snapshots fall back to create-from-image + floor. (Review B5: an unconditional "no re-mint on create-from-snapshot" yields permanently-unauthable sandboxes after device-row rotation/recreation.)
- **D4 — Router as a single-replica Container App.** `minReplicas = maxReplicas = 1` (SQLite + in-memory WS state). Config arrives as env vars sourced from Key Vault via ACA's native KV secret references — the existing router image entrypoint already materializes `router-config.json` from env. SQLite lives on **ephemeral** container storage (router docs: Azure Files-class network filesystems are unsafe for SQLite WAL) with a new blob backup/restore loop; artifact bundles (plain tar.gz files, no locking) go on an Azure Files mount. Custom domain optional — the default `*.azurecontainerapps.io` FQDN is stable and fine for webhooks + WSS. ACA ingress supports WebSockets; router heartbeats keep long-lived connections alive.
- **D5 — User secrets in Key Vault behind a pluggable SecretStore backend; honest operator UX (B4).** Backend selected by `containers.keyVaultUrl` presence (KV) else the existing 0600 file. With the router remote in ACA, a laptop-run `cyrus router secrets set` can no longer reach the router's store (`RouterCommand.openSecretStore` is file-only — B4). The v1 operator paths, documented in the runbook: **(a)** `az containerapp exec` into the single replica and run `cyrus router secrets set …` in-container (the replica's MI already has KV data-plane rights); **(b)** `az keyvault secret set` directly using the documented name/tag convention; **(c)** optional v1.1 convenience — `cyrus router secrets set --key-vault <url>` from the laptop via `DefaultAzureCredential`. Non-Azure deployments keep today's file UX byte-identical.
- **D6 — Entra everywhere it fits, device tokens where it doesn't.** Router→Azure: user-assigned managed identity (RBAC: SandboxGroup Data Owner on the group, KV Secrets User + Secrets Officer on the vault, Blob Data Contributor on backups). Operators: `az login` (the `aca` CLI delegates to it; local dev uses `DefaultAzureCredential`). Enrollment: optional Entra JWT validation on `POST /enroll` (Task 8, severable), with **one app registration per router deployment** so tokens can't be replayed across routers sharing a tenant (N6). Containers→router: existing per-issue device tokens, unchanged.
- **D7 — Deny-by-default egress per sandbox, allowlist sized for real workloads (M4).** Default allow (operator-extensible via `containers.aca.egress.allowHosts`): the router host (derived from `routerUrlForContainers`); GitHub (`github.com`, `*.github.com`, `*.githubusercontent.com` — wildcard semantics confirmed in S4, n1); Anthropic API **and OAuth refresh** (`api.anthropic.com`, `console.anthropic.com` — without the refresh host, sessions silently start 401ing when the first token expires, M4); Linear (`mcp.linear.app`, `api.linear.app`, `*.linear.app`); package ecosystems real sessions need (the worker image ships .NET and AGENTS.md documents CA-cert env vars for Python/Ruby/Rust/AWS/Deno): npm (`registry.npmjs.org`, `*.npmjs.org`, `registry.yarnpkg.com`), Python (`pypi.org`, `files.pythonhosted.org`), Go (`proxy.golang.org`, `sum.golang.org`), Rust (`crates.io`, `static.crates.io`), Ruby (`rubygems.org`), Maven (`repo.maven.apache.org`, `repo1.maven.org`), NuGet (`api.nuget.org`, `*.nuget.org`). **Known v1 limitation, documented:** `Full` inspection blocks non-HTTP TCP/UDP, so `git@…:`/`git+ssh://` (e.g. SSH submodule URLs) is unsupported — use HTTPS submodule URLs. S4 validates the whole list (including an Anthropic OAuth-refresh call and a `pip install`), not just npm.
- **D8 — Terraform primary, Bicep reference.** `infra/azure/terraform` is the maintained deploy path (azurerm for everything ARM-supported, one `azapi_resource` for the sandbox group). `infra/azure/bicep` contains the native-ARM reference for the sandbox group (+ optional VNet connection) — it is the canonical shape the AzAPI body mirrors, with a CI parity gate (M5), not a second full stack.
- **D9 — Destruction is event-driven: an issue reaching a terminal state destroys its container.** In direct (non-router) mode, worktrees are deleted exactly when an issue is closed — `EdgeWorker.handleIssueStateChangeMessage` fires on `completed` / `canceled` / `deleted` and runs stop-sessions → WIP push → `cyrus-teardown.sh` → `deleteWorktree`. Container GC fires on the same trigger. **Review correction (B1):** the signal is Linear's **`AppUserNotification`/`issueStatusChanged`** (terminal-by-construction — `LinearMessageTranslator.ts:369–374`) and **`Issue` remove** webhooks — NOT the entity `Issue` update webhook, which the translator handles only as a title/description/attachments content update (`LinearMessageTranslator.ts:317–348`). Delivery of both types to a router-mode workspace integration is verified by spike S0 **before** Task 6 starts (B2). The time-based sweeps remain strictly as backstops. See the explicit GC table below.

## Garbage Collection Timing (explicit)

Every path that reclaims a container or its state, and exactly when it fires:

| Trigger | Fires when | Action | Normal-mode equivalent |
|---|---|---|---|
| **Terminal-destroy** (primary, NEW — Task 6) | Router receives `issueStatusChanged` (completed/canceled) or `Issue` remove (deleted) for the issue | wake container if suspended → relay raw webhook → in-container teardown (stop sessions, **force floor flush first**, WIP push, `cyrus-teardown.sh`, `deleteWorktree`) → `teardown-complete` callback (or grace expiry) → `destroy()` (ACA: sandbox **and** its snapshots) + delete device row; bundle file also deleted when action is `deleted` | **Identical trigger** to `deleteWorktree` in `handleIssueStateChangeMessage` |
| Idle-stop (existing) | `idleStopMs` (default 15 min) with no session affinity and no routing activity | `stop()` / memory-mode suspend — **never destruction** | n/a — parked, fast resume |
| Stale-destroy (backstop, existing) | `staleDestroyMs` (default 14 days) untouched | `destroy()` + delete device row (+ ACA snapshots) | Bounds issues abandoned *without* being closed (webhook missed, router down, issue left open forever) |
| Orphan GC (backstop, existing) | provider lists a container whose device row is gone | `destroy()` | Bookkeeping drift only (manual row deletion, user removal) |
| Manual (existing) | `cyrus router containers destroy <issueKey>`; `gc-snapshots` (Task 7) | immediate destroy | Operator override |
| Bundle retention | artifact bundle kept for `completed`/`canceled` (reopen → floor restore); deleted for `deleted` (action recorded router-side — B3) | file under `artifactsDir` | Floor lifecycle follows the issue's reopen-ability |

## Global Constraints

- Same repo conventions as phase 1 (tabs, Vitest in `test/`, package filters, changelog rules).
- **No breaking `ContainerExecutor` interface changes.** One additive, optional ctx field — `deviceId?: string` on `IssueExecutionContext` — supports the ACA token-lineage check (D3); existing providers ignore it (B5). All other snapshot logic stays provider-internal; ACA-specific operations (e.g. snapshot GC) are optional provider methods invoked structurally (`typeof x === "function"`).
- **No new WebSocket protocol frames** (`PROTOCOL_VERSION` stays 2); no changes to `WorkspaceSyncService`/`container-boot` behavior beyond the terminal-teardown epilogue and `syncIssue`'s new `force` option (Task 6). New container→router signals travel as plain HTTP with device-token auth, mirroring the artifact-bundle and (phase 2) GitHub-token endpoints.
- Terminal-state relay reuses the existing durable per-device event queue (raw webhook JSON in, standard translation out). **No `LinearMessageTranslator` changes** — `translateIssueStateChange` (notification) and `translateIssueDeleted` (remove) already exist; relaying the entity `Issue` update webhook would NOT work (B1) and is not attempted.
- `mintDeviceToken()` only on create-from-image (D3).
- Canonical-path invariant unchanged: `/workspaces/<ISSUE-KEY>` is a real directory on the sandbox rootfs. No separate volume mount in v1.
- New runtime deps allowed: `@azure/identity`, `jose` — both **lazy-imported** behind Azure-only code paths so non-Azure installs never load them. No `@azure/storage-blob`, no data-plane SDK (preview churn): hand-rolled REST for the data plane, Key Vault, and Blob.
- One pinned api-version constant (`2026-02-01-preview`) in the client, overridable via config escape hatch.
- The worker image must be pullable by the sandbox group: public GHCR works anonymously; private GHCR requires the ACR module (`enable_acr`) + group-identity AcrPull — called out as a prerequisite in the runbook (N7).
- ACA-side auto-suspend defaults to **disabled** (`autoSuspendSeconds: 0`): it has no session-affinity gate and can freeze a live session mid-task (N5). The router's affinity-aware `idleStopMs` remains the sole idle controller.
- Suspend freezes processes mid-flight (no documented SIGTERM grace — spike S3). The floor tolerates a frozen flush by design (server-side tmp+rename, client never throws, retries next tick); document the difference from Docker's 30s grace in the runbook.
- "Sub-second resume" is a Microsoft doc claim, not a measured figure — operator-facing prose says "fast resume (measured in S3)" until S3 records real numbers (n2).

---

### Task 0: Validation spikes (operator-run, blocks Tasks 4–6)

Cheap, manual, de-risks every unconfirmed fact before code is written. Record findings in `docs/superpowers/specs/2026-07-25-aca-sandboxes-spike-findings.md` (including **pricing-page citations** for snapshot billing — n4) and adjust Tasks 4–6 to match reality.

- [x] **S0 — Linear webhook delivery (B2 — gates Task 6):** **PASS — Task 6 unblocked.** Both kinds delivered and the existing type guards match unmodified; the translator-extension fallback is NOT needed. Two blind spots found (F3): self-actored closes and the `duplicate` state type fire no notification. Prior art `2aa0c24a` on `fix/router-forward-terminal-state` already implements the relay (routes on `issue_affinity`) and is unmerged. See the findings doc. confirm the router-mode Linear OAuth app's webhook subscription actually delivers `AppUserNotification` (`issueStatusChanged`) **and** `Issue` remove events; capture real payloads for both; verify the cyrus-core type guards (`isIssueStateChangeWebhook` and the `Issue` remove guard) match the delivered shapes. If `issueStatusChanged` is NOT deliverable to the router's subscription, Task 6 falls back to extending `LinearMessageTranslator` for entity `Issue` update webhooks + tracker state resolution — a bigger change; re-plan before proceeding.
- [ ] **S1 — Worker image boot:** register the phase 1 worker image as a group disk image (`aca sandboxgroup disk create --image ghcr.io/…/cyrus-worker:<tag>`); create a sandbox with dummy env; confirm the image ENTRYPOINT runs `container-boot`, env vars arrive, and a long-lived PID 1 keeps the sandbox `Running`. Note any entrypoint/command override needed.
- [ ] **S2 — Data-plane shapes with raw curl** (no SDK): `az account get-access-token --resource https://dynamicsessions.io` → `GET/POST` against `https://management.{region}.azuredevcompute.io/…`. Confirm: exact route layout, sandbox **state enum**, whether GET returns the disk/image ref, label charset/length limits, sandbox name constraints, create-from-image vs create-from-snapshot bodies, async/LRO behavior (202 + poll?), error body shape.
- [ ] **S3 — Suspend semantics:** does `POST /stop` deliver SIGTERM (and wait) before freezing? Are implicit suspend snapshots listable/restorable via create-from-snapshot, or only via `POST /resume` on the same sandbox? **Measure** real suspend/resume latencies (n2). Also query the docs/`[Sandbox]` feedback channel for any **max sandbox lifetime**; if a hard lifetime < `staleDestroyMs` exists, record it and lower the ACA default accordingly (N10).
- [ ] **S3b — Snapshot env/token inheritance (B5 — gates Task 5's fast path):** create a sandbox with env `MARKER=1` + a dummy `CYRUS_DEVICE_TOKEN`; `POST /snapshot`; delete the sandbox; create-from-snapshot; `executeShellCommand env`. If the env (and entrypoint) is NOT inherited, **cut create-from-snapshot from v1** (suspend/resume + floor only; the client keeps the snapshot methods) and delete the corresponding Task 5 semantics before writing any provider code.
- [ ] **S4 — Egress (M4):** apply deny-by-default + the D7 allowlist with `inspectionMode: Full`; from inside the sandbox verify: `git clone`/`push` over HTTPS, `git submodule update --init` (HTTPS), `npm install` (including tarball CDN download), `pip install` of a small package, Linear MCP reachability, `api.anthropic.com` **and** `console.anthropic.com` (OAuth refresh host) reachability, and **a WSS connection to the router**. Confirm wildcard semantics (does `*.github.com` match `github.com`? — n1) and list both forms where needed. If WSS fails, retest with `Partial` and record the required posture. Record `git+ssh://` failure as the documented v1 limitation.
- [ ] **S5 — Names/labels:** finalize sanitization regexes from observed constraints (target: reuse Docker's `[^A-Za-z0-9_.-] → -`).
- [ ] **S6 — RBAC propagation:** `az role definition list --name "Container Apps SandboxGroup Data Owner" --query "[].id"` — record the **in-tenant** role definition GUID (do not assume the documented constant — N2); assign it to a test identity; measure time-to-effective (docs say 30–60s; client must retry 403s ~100s on first use). Feed the GUID to Terraform as a variable/data source.
- [ ] **S7 — Region availability:** enumerate where `Microsoft.App/sandboxGroups` deploys (portal region dropdown / `az provider show -n Microsoft.App`); pick the default region for IaC (docs examples use eastus2/westus2/westus3).

---

### Task 1: `infra/azure/terraform` — primary deploy stack

**Files (all new):**
```
infra/azure/README.md                  # architecture, prereqs, deploy/teardown, ops + break-glass runbook
infra/azure/terraform/versions.tf      # azurerm ~>4, azapi ~>2 (+ azuread, optional)
infra/azure/terraform/variables.tf     # project, location, images, KV secret values (sensitive), flags,
                                       # sandboxgroup_data_owner_role_id (from S6), operator_principal_id
infra/azure/terraform/main.tf          # RG, Log Analytics, KV, UAI, storage, CAE, providers config
infra/azure/terraform/router.tf        # router Container App + env storage mount + KV secret refs
infra/azure/terraform/sandbox.tf       # azapi_resource sandbox group + role assignments + optional ACR
infra/azure/terraform/outputs.tf       # see below
infra/azure/terraform/env/dev.tfvars.example
```

**Resources:** resource group; Log Analytics workspace; Key Vault (RBAC mode) seeded from sensitive TF vars (`linear-workspace-token`, `linear-webhook-secret`, `linear-client-id`, `linear-client-secret`); user-assigned identity (router); one storage account with an Azure Files share (`artifacts`) + blob container (`router-backups`); Container Apps environment; router Container App (`min/maxReplicas = 1`, external ingress targetPort 8787, env vars as KV `secretRef`s — `LINEAR_WORKSPACE_ID` plain + `CYRUS_ROUTER_CONTAINERS_JSON` rendered by TF including `artifactsDir: "/data/artifacts"` and `keyVaultUrl`, Files share mounted at `/data/artifacts`); `azapi_resource` `Microsoft.App/sandboxGroups@2026-02-01-preview` (`schema_validation_enabled = false`, system-assigned identity, `properties: {}`); CPU/memory/disk/lifecycle are per-sandbox provider config, and no ARM `maxSandboxCount` exists. Role assignments — router UAI → *Container Apps SandboxGroup Data Owner* scoped to the group (**role definition referenced via `data "azurerm_role_definition"` by name, falling back to the `sandboxgroup_data_owner_role_id` variable from S6 — never a hardcoded GUID**, N2), router UAI → *Key Vault Secrets User* + *Key Vault Secrets Officer*, router UAI → *Storage Blob Data Contributor* (backups), **and `operator_principal_id` → *Storage Blob Data Contributor* on the backups container as break-glass** (M2 — without it an operator cannot delete a corrupt blob to unwedge a fatal-restore CrashLoopBackOff). Optional flag modules: `enable_acr` (registry + `az acr import` of both images + AcrPull for group identity — **required for private GHCR**, N7), `enable_custom_domain` (managed cert).

**Outputs (N8 — complete, paste-ready values, not fragments):** `router_fqdn`, `router_wss_url`, `key_vault_name`, `sandbox_group_name`, `cyrus_router_backup_blob_url`, and `cyrus_router_containers_json` — the **complete** `CYRUS_ROUTER_CONTAINERS_JSON` value merging `image`, `routerUrlForContainers` (`wss://<fqdn>`), `repositories` (from a TF variable), `keyVaultUrl`, and the full `aca` block.

**README must include:** prereqs (az login, TF ≥1.9, `enable_acr` for private registries); deploy; Linear webhook cutover; `cyrus router users set-executor <email> aca`; cost posture (per-second while running; snapshot pricing unquantified per n4); **teardown (M5): before `terraform destroy`, sweep-destroy every managed container (`cyrus router containers list` / `containers destroy`) and delete leftover snapshots (`aca sandbox snapshot list/delete`) — Azure never GCs snapshots and Terraform does not track data-plane children, so destroying a non-empty group can strand snapshots with no Cyrus-side way to enumerate them once the router is gone**; break-glass recovery (delete a corrupt `router.db` blob via the operator role, then restart the replica).

- [ ] **Step 1: Scaffold + `terraform validate`** — all files compile; sensitive vars marked; `env/dev.tfvars.example` documents every variable.
- [ ] **Step 2: `terraform plan` clean** against a throwaway subscription/RG.
- [ ] **Step 3: Live apply + verify** — router healthy (`/healthz`), KV env resolved, sandbox group visible via `aca sandboxgroup list`, role assignment effective (S6 retry window).
- [ ] **Step 4: README** — per the required-contents list above.
- [ ] **Step 5: Commit** — `git commit -m "feat(infra): Terraform stack for Azure router hosting + ACA sandbox group"`

---

### Task 2: `infra/azure/bicep` — sandbox group reference modules + parity gate

**Files (all new):**
```
infra/azure/bicep/README.md                        # "reference shape; Terraform is the deploy path"
infra/azure/bicep/sandbox-group.bicep              # Microsoft.App/sandboxGroups@2026-02-01-preview
infra/azure/bicep/sandbox-group-rbac.bicep         # Data Owner assignment for a given principal
infra/azure/bicep/sandbox-group-vnet.bicep         # optional vnetConnections child (deferred subnet)
infra/azure/bicep/sandbox-group.bicepparam.example
scripts/check-aca-arm-parity.sh                    # CI drift gate (M5)
```

The AzAPI body in Task 1 must mirror `sandbox-group.bicep` property-for-property. **This rule is enforced, not aspirational (M5):** `check-aca-arm-parity.sh` runs `bicep build sandbox-group.bicep --stdout` → JSON, extracts the `azapi_resource` body from `sandbox.tf`, and fails on any property-order-insensitive diff; it runs in `ci.yml`.

- [ ] **Step 1: Author + `bicep build`** clean (accept preview-type warnings; pin api-version).
- [ ] **Step 2: Parity script green** against Task 1's `sandbox.tf`; wired into CI.
- [ ] **Step 3: Deploy once to the spike RG** and diff live properties vs the Terraform-managed group — no drift beyond computed fields (one-time live check; the CI gate covers ongoing drift).
- [ ] **Step 4: Commit** — `git commit -m "feat(infra): Bicep reference modules + ARM parity gate for ACA sandbox groups"`

---

### Task 3: Router Azure-readiness (entrypoint passthrough, SQLite blob backup, Key Vault secret backend)

Independent of the provider tasks (4–5); lands behind config flags so non-Azure deployments are byte-for-byte unchanged.

**3a — Containers config passthrough in the router image entrypoint.**
- Modify: `docker/router/entrypoint.mjs` (+ its tests).
- `CYRUS_ROUTER_CONTAINERS_JSON` (JSON object, validated non-array) is written verbatim as `config.containers` (TF emits the complete value — N8); `CYRUS_ROUTER_BACKUP_BLOB_URL` → `config.backup.blobContainerUrl`; `CYRUS_ROUTER_ENTRA_*` → `config.entra` (Task 8). Incomplete-but-present env fails fast naming what's missing, per existing entrypoint style.

**3b — SQLite backup/restore to Blob.**
- Create: `packages/router/src/StateBackup.ts`; modify: `packages/router/src/RouterServer.ts` (config gains `backup?: { blobContainerUrl: string; intervalMs?: number }`, start/stop hooks), `apps/cli/src/commands/RouterCommand.ts` (Zod).
- Behavior: **start** — if the DB file is absent, try downloading `router.db` from the container (404 = fresh start; any other restore failure is **fatal and loud** — the runbook documents the break-glass fix: delete the blob via the operator Storage role from Task 1, M2). **Run** — every `intervalMs` (default 300_000) and once on shutdown: better-sqlite3 `.backup(tmp)` then hand-rolled single-request `PutBlob` (`x-ms-blob-type: BlockBlob`, Bearer token for `https://storage.azure.com/.default` via the lazy `@azure/identity` provider). Never throws at runtime (log + next tick).
- **Documented semantics (M2):** single-request PutBlob is atomic — an interrupted upload leaves the previous blob intact. ACA single-revision rollouts may briefly overlap old/new replicas; ordering is not guaranteed, so a restore can be staler than the dying replica's final flush — **the accepted loss window is `intervalMs` of event-queue state, and events delivered inside that window may be re-delivered after restore (at-least-once cutover; no idempotency key is added in v1)**. Both facts go in the runbook, not just the code.
- Tests: fake token provider + scripted `fetchFn`; covers restore-miss, restore-corrupt (fatal), periodic upload, shutdown flush, never-throws.

**3c — Pluggable SecretStore backend (Key Vault).**
- Modify: `packages/router/src/SecretStore.ts` — extract `SecretStoreBackend` (`get(email)`, `set(email, key, value|undefined)`, `isFullyAuthenticated(email, keys)`) with the existing file impl becoming `FileSecretStore` (re-exported as `SecretStore` for compatibility).
- Create: `packages/router/src/KeyVaultSecretStore.ts` — hand-rolled KV REST (`{vaultUrl}/secrets/{name}?api-version=7.4`, Bearer `https://vault.azure.net/.default`). Secret name: `u{sha256(email):20}-{sha256(key):10}` (KV names forbid `_`; fidelity lives in tags `email` + `key`). Reads: point GET with 60s in-process cache; writes: PUT/DELETE with cache invalidation. `secrets list` enumerates via list-with-tags **with `nextLink` pagination handled** (N3). Same validations as the file store (reserved keys, env-name regex) enforced client-side before any network call.
- **Async ripple — correctly scoped (M3):** `buildEnv`/`isFullyAuthenticated` are called only inside the already-async `bootInner`, so the conversion is small. The real work is the call sites the review enumerated: `RouterCommand.openSecretStore()` (constructs the file store directly — gains backend selection for CLI-direct KV mode) and the `secrets list` subcommand (goes async). Also enumerated explicitly (n3): the `new SecretStore(secretsPath)` construction branch in `RouterServer.buildContainerTargets` selects `KeyVaultSecretStore` when `containers.keyVaultUrl` is set.
- **Rotation propagation — documented limit (N4):** a rotated KV secret is picked up only by the next **create-from-image**; resume and create-from-snapshot keep their baked env (D3). To propagate a rotated secret to an existing issue's worker: `cyrus router containers destroy <issueKey>` + re-prompt. This goes in the runbook.
- **Operator UX (B4/D5):** runbook documents (a) `az containerapp exec` into the replica → `cyrus router secrets set …`, (b) `az keyvault secret set` with the naming convention, (c) optional v1.1: `cyrus router secrets set --key-vault <url>` from the laptop.
- Config: `containers.keyVaultUrl?: string` (presence selects KV backend; Zod + entrypoint per 3a).

- [ ] **Step 1: Failing tests** — 3a entrypoint matrix (present/absent/malformed env); 3b backup lifecycle (incl. fatal-restore); 3c KV store against scripted `fetchFn` (naming, tags, cache, pagination, validation parity with file store) + `openSecretStore` backend selection + async `secrets list`.
- [ ] **Step 2: Verify failure** — `pnpm --filter cyrus-router test:run` (and cli filter) → FAIL.
- [ ] **Step 3: Implement.** **Step 4: Verify pass** + full `pnpm test:packages:run`.
- [ ] **Step 5: Commit** — `git commit -m "feat(router): Azure hosting readiness — env passthrough, SQLite blob backup, Key Vault secret backend"`

---

### Task 4: `AcaSandboxClient` — typed data-plane wrapper

**Files:**
- Create: `packages/router-executors/src/aca/AcaSandboxClient.ts`, `packages/router-executors/src/aca/tokenProvider.ts`
- Test: `packages/router-executors/test/AcaSandboxClient.test.ts`

**Interfaces (produced for Task 5):**

```typescript
export interface AcaSandbox {
	name: string;
	state: string; // enum confirmed in S2 (Creating|Running|Suspending|Suspended|Resuming|Deleting|…)
	diskImage?: string; // field name confirmed in S2 — used for staleness
	labels?: Record<string, string>;
}
export interface AcaSnapshot { id: string; name: string; labels?: Record<string, string>; createdAt?: string; diskImage?: string }
export interface AcaDiskImage { name: string; image: string }
export interface AcaEgressPolicy { defaultAction: "Allow" | "Deny"; allowHosts?: string[]; inspectionMode?: "Full" | "Partial" }

export class AcaSandboxClient {
	constructor(opts: {
		subscriptionId: string; resourceGroup: string; sandboxGroup: string; region: string;
		tokenProvider: () => Promise<string>; // Entra token, audience https://dynamicsessions.io/.default
		apiVersion?: string;                  // default pinned: "2026-02-01-preview"
		fetchFn?: typeof fetch;
		baseUrl?: string;                     // default https://management.{region}.azuredevcompute.io
	});
	getSandbox(name: string): Promise<AcaSandbox | null>;
	listSandboxes(): Promise<AcaSandbox[]>;
	createSandbox(body: {
		name: string;
		disk?: string; snapshotId?: string;   // exactly one — from image or from snapshot
		env?: Record<string, string>;         // create-from-image only
		cpu?: string; memory?: string;
		autoSuspendSeconds?: number;          // 0 = disabled (our default — N5)
		labels?: Record<string, string>;
		egressPolicy?: AcaEgressPolicy;
	}): Promise<AcaSandbox>;                // polls to Running/Failed if the API is async (S2)
	stopSandbox(name: string): Promise<void>;    // memory-mode suspend
	resumeSandbox(name: string): Promise<void>;
	deleteSandbox(name: string): Promise<void>;  // tolerates 404
	listSnapshots(): Promise<AcaSnapshot[]>;
	createSnapshot(sandbox: string, name: string, labels?: Record<string, string>): Promise<AcaSnapshot>;
	deleteSnapshot(id: string): Promise<void>;   // tolerates 404
	listDiskImages(): Promise<AcaDiskImage[]>;
	createDiskImage(name: string, image: string): Promise<AcaDiskImage>; // idempotent on 409
}

// tokenProvider.ts
export function createDefaultTokenProvider(): () => Promise<string>;
// lazy `await import("@azure/identity")` INSIDE the returned closure (keeps module load
// sync + optional for non-Azure installs); caches until 5 min before expiry; audience
// constant documented with the dynamicsessions.io lineage note.
```

Every method: `fetch` with `authorization: Bearer <token>`; non-2xx throws `Error` including status + body; DELETE tolerates 404; first-use 403 retried ~100s total (S6 RBAC propagation). Route table + body shapes adjusted to S2 findings before implementation starts.

- [ ] **Step 1: Write failing tests** — `fakeFetch` capturing `(url, init)` returning scripted `Response`s: URL/method/auth per endpoint, api-version pin, error bodies surfaced, 404-tolerant DELETEs, LRO polling, 403 retry-then-succeed.
- [ ] **Step 2: Verify failure** — `pnpm --filter cyrus-router-executors test:run` → FAIL.
- [ ] **Step 3: Implement** — private `request<T>(method, path, body?, okOn404?)`; one public call per method.
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(router-executors): typed ACA Sandboxes data-plane client"`

---

### Task 5: `AcaSandboxesProvider` + config wiring

**Gates before starting:** S2 (shapes), S3 (suspend semantics), S3b (env inheritance — if negative, the create-from-snapshot path below is **deleted**, not softened — B5).

**Files:**
- Create: `packages/router-executors/src/aca/AcaSandboxesProvider.ts`
- Modify: `packages/router-executors/src/types.ts` (**additive**: `IssueExecutionContext.deviceId?: string` — B5), `packages/router-executors/src/index.ts`, `packages/router/src/ContainerTargets.ts` (pass the device row's id as `deviceId` in ctx), `packages/router/src/RouterServer.ts` (registry gains `"aca"` when configured), `apps/cli/src/commands/RouterCommand.ts` (`EXECUTOR_TYPES` gains `"aca"`; Zod gains `containers.aca`)
- Test: `packages/router-executors/test/AcaSandboxesProvider.test.ts`

**Config (`RouterContainersConfig`, + Zod mirror):**

```typescript
aca?: {
	subscriptionId: string; resourceGroup: string; sandboxGroup: string; region: string;
	disk?: string;                 // pre-registered disk image name; default derived from containers.image
	cpu?: string; memory?: string; // default "4000m" / "8192Mi" (bounds per S2)
	autoSuspendSeconds?: number;   // default 0 = DISABLED (N5: ACA-side auto-suspend has no
	                               // session-affinity gate and can freeze a live session mid-task;
	                               // the router's affinity-aware idleStopMs stays the sole idle controller)
	egress?: AcaEgressPolicy;      // default: Deny + the full D7 allowlist (M4)
	keepSnapshots?: number;        // default 2 — retention pruning of EXPLICIT labeled snapshots
	apiVersion?: string;           // escape hatch
}
```

Registry wiring (in `buildContainerTargets`, mirroring the existing `"docker"` default):

```typescript
if (cfg.aca) executors.set("aca", new AcaSandboxesProvider({
	client: new AcaSandboxClient({ ...cfg.aca, tokenProvider: createDefaultTokenProvider() }),
	image: cfg.image,
}));
```

**Provider semantics (encode as tests, client mocked):**
- Identity: sandbox IDs are server-assigned GUIDs (no operator-selected names). Labels `cyrus.issue=<exact key>` (source of truth for `listManaged`), `cyrus.managed=true`, `cyrus.disk=<disk name>` (disk name encodes the image tag → staleness check), **`cyrus.device-id=<ctx.deviceId>` on sandboxes AND explicit snapshots (B5/D3)**.
- `ensureRunning(ctx)`:
  - `Running` + disk match → no-op.
  - `Suspended` + disk match → `resumeSandbox` (**no re-mint** — env/token baked into the suspended state).
  - transitional state → no-op (next sweep retries).
  - present + disk stale → `deleteSandbox` + delete that issue's snapshots (a snapshot always restores the old image lineage) → fall through to create-from-image.
  - absent → **lineage check (B5):** newest explicit snapshot labeled `cyrus.issue=<key>` whose **`cyrus.device-id` label equals `ctx.deviceId`** and whose disk matches? `createSandbox({ snapshotId })` (no re-mint — env inherited and still matches the live row) : `ensureDisk(image)` then `createSandbox({ disk, env: { ...ctx.env, CYRUS_DEVICE_TOKEN: ctx.mintDeviceToken() }, labels (incl. device-id), cpu, memory, autoSuspendSeconds, egressPolicy })`. **Unlabeled or device-id-mismatched snapshots are never restored** (their baked token may not match the row).
  - after a successful **create path only** (not plain stop/resume — N1): prune the issue's explicit labeled snapshots to `keepSnapshots` newest, **serialized with the create inside a provider-internal per-issue mutex** keyed by issueKey, so pruning can never race a concurrent `ensureRunning` for the same issue (M1).
- `stop` → `stopSandbox` when `Running` (memory-mode suspend); else no-op.
- `destroy` → `deleteSandbox` (tolerate absent) + delete **all** snapshots labeled `cyrus.issue=<key>`, best-effort per snapshot with failures logged (partial-failure sequence documented for Task 6's handler — M1).
- `status` → absent / `Running`→running / anything else present → stopped.
- `listManaged` → `cyrus.issue` label values from the sandbox list — **only** that one network call (M1: no snapshot listing piggybacked on the 60s sweep path; orphan-snapshot reclamation happens via `destroy`, create-path pruning, and Task 7's `gc-snapshots`).

- [ ] **Step 1: Write failing tests** — one per semantic bullet, incl.: lineage-match restore, lineage-mismatch falls back to create-from-image **and re-mints**, unlabeled snapshot never restored, prune serialized with create (concurrent ensureRunning), `listManaged` performs exactly one client call.
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Verify pass** (`router-executors` + `router` + `cli` filters).
- [ ] **Step 5: Extend `docker/worker/README.md`** with the ACA runbook: spike-verified setup, `containers.aca` config example, `routerUrlForContainers` = the router's public `wss://` URL (local dev works today via the documented cloudflared path — full Azure router hosting is Task 1/3 but not required for provider development), the N4 secret-rotation note, the N5 auto-suspend note, and the snapshot-retention cost note (n4 citation).
- [ ] **Step 6: Commit** — `git commit -m "feat(router-executors): ACA Sandboxes provider — suspend/resume per-issue cloud workers"`

---

### Task 6: Terminal-state destroy — GC timing parity with normal mode (D9)

**Gates before starting:** S0 (Linear actually delivers `issueStatusChanged` + `Issue` remove to the router's webhook subscription — B2).

**Why:** in direct mode, worktree deletion fires exactly when an issue is closed. In router mode today the signal is dropped (`EventRouter.route()` ignores every non-`AgentSessionEvent` webhook — `EventRouter.ts:152`), so containers **and** physical-device worktrees linger until the 14-day backstop. This task makes terminal state the primary, explicit destroy trigger — and as a side effect fixes worktree teardown for physical devices in router mode too.

**Sequence (container target):**
1. Router handles two additional webhook kinds — everything else stays ignored (relaying entity `Issue` *update* webhooks is NOT attempted: the translator handles them only as content updates — B1): `isIssueStateChangeWebhook` (`AppUserNotification`/`issueStatusChanged` — terminal-by-construction, **no tracker fetch needed**) and the `Issue` remove guard (deleted). The router records the action: `deleted` iff `Issue` remove, else `closed`. This registry-recorded action — not anything in `IssueStateChangeMessage`, which intentionally keeps its current shape (B3) — is the source of truth for bundle deletion in step 5.
2. Resolve the issue's target device (container **or** physical — kind-agnostic) and enqueue the **raw webhook** on the existing durable per-device queue (48h TTL). Device-side, `RouterEventTransport` feeds it to the same `LinearMessageTranslator` the direct path uses (`translateIssueStateChange` / `translateIssueDeleted` — both exist), so `handleIssueStateChangeMessage` runs byte-identically to direct mode. Physical device: stop here — queued event survives offline, no destroy semantics.
3. Container target: register a pending teardown `{ issueKey, deviceId, action, deadline = now + containers.teardownGraceMs }` (in-memory map, default grace 600_000). **Dedup (M7):** first registration wins; repeat terminal webhooks for the same `issueKey` are logged and ignored. Wake the container via the existing offline-boot path (`ContainerTargetService.boot`).
4. EdgeWorker runs its terminal handler with **two router-platform insertions** (B3/M9 ordering):
   - **(a) Force floor flush FIRST** — immediately after the session-stop/response-activity loop and **before** `removeSession` and the pre-teardown WIP push/`deleteWorktree`: `await this.workspaceSyncService?.syncIssue(issueKey, { force: true })`. This extends the **existing** public `syncIssue` (no new method — M9) with a `force` option that awaits in-flight syncs and bypasses touched-set/workspaceGone suppression, pushing WIP and uploading the bundle **while session state and transcripts still exist** (after `removeSession`, `buildBundle` finds zero sessions and returns false; after `deleteWorktree`, the workspaceGone branch suppresses the upload — B3).
   - **(b) Callback LAST** — at the very end of the handler (after `deleteWorktree`): POST `teardown-complete` via a new `transport.ts` helper (`toHttpBase(router.url)` + device token, same pattern as `uploadBundle`).
5. `POST /containers/issues/:issueKey/teardown-complete` (device-token auth, issue-scoped for container devices; physical-device tokens → 200 no-op; a stale token from a since-recreated container → 401 no-op — mirrors `artifacts.ts` auth) resolves the pending entry by `issueKey`: `executor.destroy(issueKey)`; **on success** delete the device row; for `action === "deleted"` also delete the artifact bundle file (a deleted issue can't be reopened; `completed`/`canceled` retain it for the reopen path). **On destroy failure: keep the device row and log loudly — the stale-destroy sweep retries every 60s** (M1 partial-failure sequence).
6. Grace deadline fires with no callback ⇒ same destroy path, loudly logged (loss bounded by the forced flush in 4a, or by the last periodic/session-end flush if the container died before 4a). **Manual `containers destroy` during the grace window:** the later callback 401s (token rotated/gone) or finds the row already deleted → no-op + log (M7). **Router restart:** pending entries lost (documented); worst case, a container woken for teardown keeps Running until the next idle-stop (+≤15 min) and is reclaimed by stale-destroy (M7).

**Files:**
- Create: `packages/router/src/TerminalTeardown.ts` (pending-teardown registry + route), `packages/router/test/terminal-teardown.test.ts`
- Modify: `packages/router/src/EventRouter.ts` (handle the two webhook kinds; action classification; enqueue; register+wake for containers), `packages/router/src/RouterServer.ts` (wire route; `RouterContainersConfig.teardownGraceMs?: number`), `apps/cli/src/commands/RouterCommand.ts` (Zod), `packages/router/src/ContainerLifecycle.ts` (header comment: stale-destroy is now explicitly the *backstop* for never-closed issues), `packages/edge-worker/src/EdgeWorker.ts` (insertions 4a/4b in `handleIssueStateChangeMessage`), `packages/edge-worker/src/WorkspaceSyncService.ts` (`syncIssue` gains `{ force?: boolean }`), `packages/workspace-sync/src/transport.ts` (`postTeardownComplete(issueKey)` beside `uploadBundle`), `packages/router-client/src/RouterEventTransport.ts` (**verify** relayed notification/remove webhooks reach the translator unfiltered; extend only if type-filtered)
- **Explicitly NOT modified (review-verified, B1/B3):** `LinearMessageTranslator` (both terminal translations already exist), `messages/types.ts` (no `kind` discriminator — the registry holds the action), the `ContainerExecutor` interface (the one additive ctx field is Task 5's).

- [ ] **Step 1: Write failing tests** — terminal classification (notification → `closed`; remove → `deleted`); non-terminal webhooks still ignored; kind-agnostic relay to the durable queue; dedup on repeat terminal webhooks; wake-on-suspended container; callback → destroy + device row gone + `deleted`-action bundle removal; destroy failure keeps the row; grace-timeout destroy; manual-destroy-during-grace no-op; stale-token callback → 401 no-op; physical-device target gets the event with **no** pending-teardown; **epilogue ordering — forced `syncIssue` runs before `removeSession`/`deleteWorktree` and uploads a bundle that contains the terminal session; POST fires after `deleteWorktree`** (B3/M9).
- [ ] **Step 2: Verify failure** — `pnpm --filter cyrus-router test:run && pnpm --filter cyrus-edge-worker test:run` → FAIL.
- [ ] **Step 3: Implement.** **Step 4: Verify pass** + full `pnpm test:packages:run`.
- [ ] **Step 5: Commit** — `git commit -m "feat(router): destroy containers when issues reach a terminal state — GC parity with worktree deletion"`

---

### Task 7: Snapshot lifecycle + operator GC command

- Create: `apps/cli/src/commands/` subcommand `cyrus router containers gc-snapshots` — structural check for the provider's optional `gcOrphanSnapshots(activeIssueKeys: string[])`; deletes labeled snapshots whose issue has neither a live sandbox nor a container device row (store supplies the rows). Prints a plan first; `--yes` to execute.
- Provider: implement `gcOrphanSnapshots` + any `keepSnapshots` pruning deferred from Task 5.
- Runbook: snapshot cost/retention section in `docker/worker/README.md` (post-preview blob billing per the n4 citation; manual `aca sandbox snapshot list/delete` escape hatch — including the post-`terraform destroy` case where the router is gone, M5).

- [ ] **Step 1: Failing tests** — gc planning (keeps in-use and lineage-current, deletes orphans, `--yes` gate), pruning keeps newest N.
- [ ] **Step 2–4: Fail → implement → pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(router-executors): ACA snapshot retention + gc-snapshots admin command"`

---

### Task 8: Entra-gated enrollment (severable hardening)

- Modify: `packages/router/src/RouterServer.ts` (config gains `entra?: { tenantId: string; audience: string; allowedDomain?: string }`), enrollment route; `apps/cli/src/commands/RouterCommand.ts` (Zod); `docker/router/entrypoint.mjs` (3a env); `apps/cli/src/commands/ConnectCommand.ts` (`--entra` flag: shells `az account get-access-token --scope <audience>/.default` and enrolls with the token).
- When `entra` is set, `POST /enroll` requires `Authorization: Bearer <Entra JWT>`, validated with `jose` `createRemoteJWKSet` against `login.microsoftonline.com/{tenant}` (kid rollover: `jose` refetches on kid-miss — covered by a test). **Validation rules, fully specified (M6):**
  - `iss` must match **either** `https://sts.windows.net/{tenantId}/` **or** `https://login.microsoftonline.com/{tenantId}/v2.0` (single- vs multi-tenant app registrations emit different forms).
  - `aud` exact-match against `entra.audience`; the runbook documents that this is the app registration's **Application ID URI** (default `api://<client-id>`), obtained via `az ad app show --id <client-id> --query identifierUris`, and that **each router deployment gets its own app registration** so a token minted for router A is rejected by router B (N6).
  - Email extraction: `preferred_username` → `upn` → `email`; if **none** is present (e.g. a service-principal token), enrollment fails with a clear 400 naming the missing claims — never an opaque `undefined`.
  - `allowedDomain` (when set): exact domain-part match — `email.split("@")[1]?.toLowerCase() === domain.toLowerCase()` — never `endsWith` (M6).
  - The enrolled user is bound to the token's email. Unset `entra` ⇒ today's enrollment behavior, unchanged.
- Docs: app-registration walkthrough in `docs/ROUTER.md` (manual path primary — many operators lack Entra admin; an optional azuread TF module may follow later).

- [ ] **Step 1: Failing tests** — valid token enrolls bound email; wrong aud/iss/expired → 401; **both issuer variants accepted**; domain mismatch → 403; `evil.com@contoso.com`-style suffix attack → 403; **token with no email claim → 400 naming the missing claims**; JWKS kid-miss refetch path; unset config preserves legacy flow.
- [ ] **Step 2–4: Fail → implement → pass.**
- [ ] **Step 5: Commit** — `git commit -m "feat(router): optional Entra ID authentication for device enrollment"`

---

### Task 9: Validation (gates + live Azure smoke + F1 test drive) + docs + changelog

- [ ] **Step 1: Full gates** — `pnpm test:packages:run && pnpm typecheck && pnpm build && pnpm lint` → all pass.
- [ ] **Step 2: F1 test drive (mandatory per AGENTS.md)** — router-mode rig (`apps/f1/src/router`) with `executorRegistryFactory` injecting a recording fake ACA executor: full lifecycle drive (delegate → boot → prompt → idle-stop → resume → destroy) + a report under `apps/f1/test-drives/`. GC drive: the rig **injects synthetic `AppUserNotification`/`issueStatusChanged` and `Issue` remove payloads at the router** (control-plane seam) to exercise the Task 6 router-side chain — relay → wake → teardown → callback → destroy + device row gone (+ bundle deleted for `deleted`); F1's existing `terminateIssue` RPC remains the device-side lever (it emits `IssueStateChangeMessage` on the bus directly).
- [ ] **Step 3: Live Azure smoke — MERGE-BLOCKING (M8):** results (commands + observed output) are pasted into the PR before merge and the PR is labeled `needs-live-azure-smoke`. Green CI is **not** sufficient — none of the five load-bearing Azure assumptions (data-plane shapes, RBAC propagation, snapshot inheritance, suspend SIGTERM behavior, egress inspection) are exercised by CI. Script: deploy the dev stack (Task 1), `set-executor <you> aca`, delegate a test issue → sandbox appears (`aca sandbox list`); wait for idle-stop → `Suspended`; prompt → fast resume with the same worktree and transcript continuity (record the measured resume latency); bump `containers.image` → sandbox recreated, state restored from the floor. **GC proof:** close the issue in Linear (Done) → sandbox resumes, tears down, and is destroyed within the grace window (`aca sandbox list` empty, snapshots gone, `cyrus router containers list` empty); reopen a *completed* issue and prompt → container recreated, state restored from the retained bundle; verify a *deleted* issue's bundle is removed. `cyrus router containers destroy` on a fresh issue → sandbox **and** snapshots gone. Then switch the same user `aca → docker` and re-prompt: work continues from the WIP branch + bundle (**executor-switch floor proof**).
- [ ] **Step 4: Docs** — `docs/ROUTER.md` (Azure hosting section: single replica, backup/restore incl. the M2 cutover semantics, exec-based admin runbook incl. the D5 secret UX, Entra option), `docs/SELF_HOSTING.md` (Azure deployment option), AGENTS.md (ACA executor + KV secret backend + backup notes), `infra/azure/README.md` cross-links.
- [ ] **Step 5: Changelog** — `CHANGELOG.md` Added: "Azure Container Apps Sandboxes executor: per-issue cloud workers that suspend when idle (storage-only cost) and resume in seconds, with deny-by-default network egress" + "Containers are now destroyed automatically when their Linear issue is closed — matching worktree cleanup" + "The router can now run as an Azure Container App with Key Vault secrets and managed identity". Internal changelog: client/provider, terminal-destroy, backup service, KV store, Entra enrollment, IaC.
- [ ] **Step 6: Commit** — `git commit -m "docs: ACA executor validation notes + changelog"`

---

## Risks & Open Questions

- **Preview churn** — `2026-02-01-preview` is not yet in the public azure-rest-api-specs repo; shapes above come from the shipped Python SDK + Bicep docs. Mitigation: single pinned api-version constant, all HTTP in one client, Task 0 spikes before provider code, config escape hatch.
- **Snapshot env inheritance is unconfirmed (B5)** — if S3b shows create-from-snapshot does not inherit env/entrypoint, the fast path is cut from v1 (suspend/resume + floor only). Even with inheritance, snapshot restore is lineage-checked (D3) so a stale `CYRUS_DEVICE_TOKEN` can never produce a permanently-unauthable sandbox.
- **Linear webhook delivery is unconfirmed (B2)** — the entire terminal-destroy feature depends on `issueStatusChanged`/`Issue` remove reaching the router; S0 gates Task 6, with the translator-extension fallback documented if delivery fails.
- **Missed terminal-state webhooks** (router down past Linear's retry window) leave a closed issue's container alive — bounded by the 14-day stale-destroy backstop; optional later hardening is a slow Linear poll of managed issues' states.
- **Pending-teardown state is in-memory** (Task 6) — a router restart mid-grace-window loses the destroy trigger; worst case the woken container runs until the next idle-stop (+≤15 min, M7) and is reclaimed by stale-destroy.
- **WSS through `Full` egress inspection** (S4) — fallback `Partial` posture weakens deny-by-default; escalate via the preview feedback channel if hit.
- **No azurerm resource for sandboxGroups** — AzAPI + Bicep reference + the CI parity gate (M5); revisit when azurerm ships one.
- **Region availability** unconfirmed beyond doc examples (S7); `location` is a top-level TF variable.
- **Data-plane private endpoints** undocumented — router reaches the data plane over its public endpoint with Entra auth; VNet egress for the router app is a later hardening.
- **Max sandbox lifetime** undocumented (queried in S3 — N10) — if Microsoft enforces a lifetime < `staleDestroyMs` during preview, the backstop never fires and snapshots may be force-deleted with the sandbox; the floor covers state, and the ACA `staleDestroyMs` default is lowered if S3 finds a smaller lifetime.
- **Snapshot cost post-preview is unquantified** — no official snapshot-specific meter was published during Task 0. `keepSnapshots` pruning + `gc-snapshots` bound retained snapshots; there is no group `maxSandboxCount` cost guard.
- **Group-secret readability from inside sandboxes** is doc-conflicted — D1's env-injection posture sidesteps it; re-evaluate per-user groups when Microsoft clarifies.
- **SQLite cutover semantics (M2)** — restore-after-rollout can be staler than the dying replica's final flush; accepted window is `intervalMs` + at-least-once event re-delivery. Documented in the runbook; revisit if self-host HA ever becomes a goal.

## Non-Goals (v1)

- Per-user sandbox groups (migration path preserved via config — D1).
- Golden-image/`commit`-warmed disk images (pre-baked repo caches for faster cold boot) — later optimization.
- Remote admin API (users/secrets/containers over HTTPS) — v1 admin is `az containerapp exec` into the replica (D5); the `--key-vault` laptop CLI flag is a v1.1 convenience (B4).
- `git+ssh://` egress (SSH remotes/submodules) — blocked by `Full` inspection; use HTTPS (documented limitation — M4).
- Azure Repos / Azure DevOps egress tuning; multi-region or HA router (single replica by design); changes to the Fly/Codespaces phases.
