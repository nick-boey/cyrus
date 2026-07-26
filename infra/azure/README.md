# Cyrus on Azure — router hosting + ACA Sandboxes

This directory provisions the Azure footprint that runs a **Cyrus router** as a
single-replica Azure Container App and creates an **Azure Container Apps
sandbox group** that the router spins per-issue workers up inside.

> **Terraform is the deploy path.** A Bicep reference shape lives under
> `bicep/` and is kept property-for-property in sync with the AzAPI body in
> `terraform/sandbox.tf` by `scripts/check-aca-arm-parity.sh` (M5). Do not
> deploy from Bicep in production. The spike findings that override the
> original plan live in
> `docs/superpowers/specs/2026-07-25-aca-sandboxes-spike-findings.md`.
> Router configuration, Key Vault/Entra operations, lifecycle semantics, and
> terminal-GC blind spots are documented in
> [`docs/ROUTER.md`](../../docs/ROUTER.md#azure-hosting-and-aca-sandboxes).
> Worker-image details are in [`docker/worker/README.md`](../../docker/worker/README.md#aca-sandboxes).

## Architecture

```
        Linear webhook (HTTPS, HMAC)
                │
                ▼
   ┌──────────────────────────────────────────────────────────┐
   │ Router Container App (1 replica, SQLite + WSS state)     │
   │  • env: Linear secrets via Key Vault secretRefs          │
   │  • identity: user-assigned MI                            │
   │  • /data/artifacts  ← Azure Files share "artifacts"     │
   │  • router.db        ← ephemeral; backed up to blob       │
   └────────────┬───────────────────────────┬─────────────────┘
                │ WSS (device dial-out)     │ Entra data plane
                ▼                           ▼
   ┌────────────────────────────┐   ┌─────────────────────────────────┐
   │ ACA Sandbox Group           │   │ Key Vault (RBAC)                 │
   │  Microsoft.App/sandboxGroups│   │  linear-workspace-token          │
   │  @2026-02-01-preview         │   │  linear-webhook-secret           │
   │  properties: {}              │   │  linear-client-id/secret         │
   │  ┌──────────┐ ┌──────────┐  │   │  (router MI = Secrets User+Off.) │
   │  │ sandbox  │ │ sandbox  │… │   └─────────────────────────────────┘
   │  │ DEF-1    │ │ DEF-2    │  │   ┌─────────────────────────────────┐
   │  └────┬─────┘ └────┬─────┘  │   │ Storage account                 │
   │       │egress Deny+allowlist│  │  • Files share "artifacts"       │
   └───────┴────────────────────┘  │  • Blob container "router-backups"│
                                    └─────────────────────────────────┘
```

- The router is the **only** inbound endpoint (Linear webhook + WSS dial-in).
- Sandboxes dial OUT to the router; they expose **no inbound ports** by design
  (a security win vs Docker/Fly).
- The sandbox group resource itself is near-empty (`properties: {}`); per-sandbox
  CPU/memory/disk/egress are injected on each `PUT /sandboxes` create by the
  router from the config embedded in `CYRUS_ROUTER_CONTAINERS_JSON`.

## Prerequisites

- **`az login`** with an account that can create resource groups, Container
  Apps, Key Vaults, Storage, and RBAC role assignments in the target
  subscription. (`az account set --subscription <sub>`.)
- **Terraform ≥ 1.9.** (`terraform -version`.)
- **The `aca` CLI** (standalone) for out-of-band sandbox/snapshot ops and the
  teardown sweep — see "Teardown".
- **A pre-registered worker disk image.** The router does NOT pull
  `worker_image`; you must register it as a group disk image OUT OF BAND after
  the first apply:
  ```bash
  aca sandboxgroup disk create \
    --image <worker_image> \
    --name <aca_disk_name> \
    --resource-group "$(terraform -chdir=infra/azure/terraform output -raw resource_group_name)" \
    --sandbox-group "$(terraform -chdir=infra/azure/terraform output -raw sandbox_group_name)"
  ```
- **Private GHCR → enable ACR.** Set `enable_acr = true` and `az acr import`
  BOTH images into the new ACR (router + worker). The stack grants `AcrPull` to
  both the router UAI and sandbox-group system identity and configures the
  Container App to use its UAI; repoint `router_image` and `worker_image` at
  the ACR endpoints. With `enable_acr = false`, no registry block or ACR role
  assignment is emitted, preserving anonymous public-image pulls. See
  `env/dev.tfvars.example`. (Spike S1 / N7.)
- **S6 RBAC propagation note.** The first sandbox data-plane call after a
  fresh role assignment may 403 for up to ~100 s (spike measured < 1 min, but
  the client retries). `aca sandboxgroup create` auto-assigns the
  *Container Apps SandboxGroup Data Owner* role to the caller unless
  `--skip-role-check` is passed — so if you create the group via the CLI
  instead of Terraform you may already have it.
- **Key Vault is RBAC-only** (`enable_rbac_authorization = true`). The stack
  seeds four secrets from tfvars on first deploy, which requires the deployer
  principal to hold **Key Vault Secrets Officer** on the vault (or be Owner,
  which can self-grant). After first deploy, rotate via
  `az keyvault secret set` and stop touching the tfvars — re-applying with the
  old value will overwrite operator rotations.

Fresh Key Vault role assignments can take several minutes to propagate even
though the Container App explicitly depends on both required assignments. If
the first apply reports that a Key Vault secret reference cannot be resolved,
wait for RBAC propagation and apply again. In restrictive subscriptions, use a
two-stage deployment: apply through the vault, identity, roles, and secrets;
wait for propagation; then apply the Container App.

## Deploy

```bash
cd infra/azure/terraform
terraform init
cp env/dev.tfvars.example dev.tfvars      # fill in secrets
terraform plan  -var-file=dev.tfvars -out=tfplan
terraform apply tfplan
```

This stack was authored against `terraform fmt` (2-space) and `terraform
validate`. **`terraform` was not installed at authoring time** — run
`terraform -chdir=infra/azure/terraform fmt -check`, `init -backend=false`, and
`validate` after pulling, and fix any provider-version schema drift (azurerm
4.x container_app block layout is the `template { ... }` form).

### `routerUrlForContainers` two-apply flow (N8)

The router's real ingress FQDN (`azurerm_container_app.router.latest_revision_fqdn`)
is only known AFTER the first apply. Embedding it into the router's own env
block is a Terraform dependency cycle. Instead:

1. **First apply:** leave `router_url_for_containers = null` (default).
   The embedded JSON carries the literal
   `wss://REPLACE-ME-set-router_url_for_containers-from-terraform-output`;
   the router boots and accepts webhooks, but containers cannot dial back.
2. Read the canonical value:
   ```bash
   terraform -chdir=infra/azure/terraform output router_wss_url
   ```
3. Set `router_url_for_containers` in `dev.tfvars` to that value and
   `terraform apply` again. From now on the JSON is accurate and the operator
   can copy the full paste-ready value from the `cyrus_router_containers_json`
   output.

The `cyrus_router_containers_json` output is non-sensitive and contains the
complete, merge-ready config (image, router WSS URL, repositories, `aca`
block with subscriptionId/resourceGroup/sandboxGroup/region/disk/cpu/memory/
autoSuspendSeconds/egress*/keepSnapshots/managementEndpoint, `keyVaultUrl`,
`artifactsDir`, `backupBlobUrl`). It does not contain secret values; per-user
secrets live in Key Vault and are injected per-sandbox on create (D1/D5).

### Linear webhook cutover

After `router_fqdn` is known, point the Linear workspace-integration webhook
at:

```
https://<router_fqdn>/webhook
```

with the shared HMAC secret = `linear_webhook_secret` (the value you put in
tfvars, also stored in Key Vault secret `linear-webhook-secret`).

### Set the executor per user

```bash
cyrus router users set-executor <user-email> aca
```

(Requires the CLI build that ships the `aca` executor — see Task 5.)

## Cost posture

- **Per-second vCPU + memory** while a sandbox is `Running` (Consumption-plan
  rates, per the Container Apps pricing page).
- **Scale-to-zero while suspended** — no compute cost while parked; resume is
  sub-second (spike S3 measured 0.52 s).
- **Snapshots: UNQUANTIFIED RISK (n4).** The Container Apps pricing page only
  confirms that "Azure Container Apps Express and Sandboxes follow the same
  pay-per-second pricing as Consumption Plan." No sandbox-specific or
  snapshot-storage meter is published, and the plan's "free during preview,
  billed as blob storage afterwards" claim **could not be substantiated from
  an official source**. Treat post-preview snapshot cost as an unquantified
  risk; default `keep_snapshots = 2` and run `gc-snapshots` (Task 7). Re-check
  the pricing page at GA.

### `maxSandboxCount` does NOT exist as a cost guard

Spike finding: the ARM `Microsoft.App/sandboxGroups` resource accepts
`properties: {}` ONLY — there is no `maxSandboxCount` (or `defaultCpu`/
`defaultMemory`/`defaultDisk`) on the group resource. **You cannot cap the
number of sandboxes via the group's ARM properties.** Cost control is the
router's job:

- Keep `idleStopMs` and `staleDestroyMs` (router config) healthy — these are
  the actual idle and abandon controllers.
- Set up `gc-snapshots` (Task 7) on a schedule.
- Rate-limit issue assignment (Linear automation) if you want a hard ceiling
  on concurrent workers — the platform will not enforce one.

## Teardown (M5)

Terraform tracks the **ARM group** but NOT its **data-plane children**
(sandboxes, snapshots, disk images). **Azure never GCs snapshots** (spike S3b
confirmed: a snapshot whose source sandbox was deleted stayed listed and still
pointed at the dead `sandboxId`). Destroying a non-empty group can strand
billed snapshots with no Cyrus-side way to enumerate them once the router is
gone.

Before `terraform destroy`:

```bash
# 1. Sweep-destroy every managed container the router knows about:
cyrus router containers list                      # via the running router
cyrus router containers destroy <issueKey>        # per issue; or:
#   for k in $(cyrus router containers list --field issueKey); do
#     cyrus router containers destroy "$k"
#   done

# 2. Delete leftover snapshots the router does NOT track (orphans / explicit
#    labeled snapshots from old runs). The `aca` CLI walks the data plane:
aca sandbox snapshot list   --resource-group <rg> --sandbox-group <group>
aca sandbox snapshot delete --resource-group <rg> --sandbox-group <group> --id <id>
#   (loop over the list output)

# 3. Optional: delete disk images too.
aca sandboxgroup disk list  --resource-group <rg> --sandbox-group <group>
aca sandboxgroup disk delete --name <disk> --resource-group <rg> --sandbox-group <group>

# 4. THEN destroy the stack.
terraform -chdir=infra/azure/terraform destroy -var-file=dev.tfvars
```

(If the router itself is already gone and `cyrus router containers list`
fails, fall back to the `aca` CLI directly: `aca sandbox list --labels
cyrus.managed=true` then `aca sandbox delete --id <id>` per row — spike S2
confirmed server-side label filtering works with `cyrus.managed=true`.)

## Ops runbook

### Break-glass: corrupt `router.db`

If the replica enters a CrashLoopBackOff because a restored `router.db` blob is
corrupt:

1. `az storage blob delete` the blob from the `router-backups` container (your
   `operator_principal_id` tfvars value has **Storage Blob Data Contributor**
   on that container — without that role assignment, set in main.tf via the
   `operator_principal_id` variable, you cannot do this; M2).
2. Restart the replica (`az containerapp revision restart …` or redeploy). The
   router starts fresh (404 on `router.db` = empty DB; `StateBackup.ts` treats
   anything other than 404 as a fatal restore failure — see the Task 3 runbook).

### Auto-suspend (N5 / F2)

`aca_auto_suspend_seconds` defaults to **0 = DISABLED**. ACA-side auto-suspend
has NO session-affinity gate and can freeze a live worker mid-task (spike F2:
create-from-snapshot silently reset the policy to the 300 s default). The
provider sets the lifecycle policy explicitly on every create path. **Do not
flip this to a non-zero value** unless you have also turned the router's
session-affinity gate off. The router's `idleStopMs` remains the sole idle
controller.

### Labels and liveness (S5 / F1)

Sandboxes have server-assigned GUIDs and are mapped to issues only by labels;
there is no `cyrus-issue-<key>` sandbox name. ACA `Running` is infrastructure
state: the spike proved an entrypoint can exit while PID 1 `tini` keeps the
sandbox Running. Use router device/WebSocket freshness as worker liveness. A
Running sandbox that does not connect is not healthy and must be recreated.

Suspend sends no SIGTERM. The measured memory-mode resume was **0.52 s**;
suspend took 6.47 s. Do not assume a shutdown hook runs at park time.

### Secret rotation (N4)

The four Linear secrets in Key Vault are **seeded from Terraform vars on first
deploy and then operator-owned** — re-apply may overwrite operator rotations.
After first deploy, rotate via `az keyvault secret set` (or
`az containerapp exec` into the replica and `cyrus router secrets set …`).

**Propagation limit:** a rotated per-user secret is picked up only by the next
**create-from-image**. Resume and create-from-snapshot keep their baked env
(D3). To push a rotated secret to an existing issue's worker:
`cyrus router containers destroy <issueKey>` + re-prompt the issue.

For hosted administration, run `cyrus router secrets set` through `az
containerapp exec` so it executes under the router managed identity, or write
the Key Vault secret directly as
`u<sha256(lowercase-email):20>-<sha256(key):10>` with `email` and `key` tags. A
laptop's default local file store does not mutate the remote replica's store.

### Entra enrollment

Entra-gated device enrollment is optional and separate from the managed
identity used for ACA data-plane calls. Follow
[`docs/ROUTER.md`](../../docs/ROUTER.md#optional-entra-gated-enrollment): create
one app registration per router deployment, use its Application ID URI as the
exact audience, and authenticate operators/users with `az login`. Set
`entra_tenant_id` and `entra_audience` together; optionally set
`entra_allowed_domain`. Terraform maps these to the canonical
`CYRUS_ROUTER_ENTRA_TENANT_ID`, `CYRUS_ROUTER_ENTRA_AUDIENCE`, and
`CYRUS_ROUTER_ENTRA_ALLOWED_DOMAIN` environment variables.

### Egress (D7 / M4)

Default `aca_egress_default_action = "Deny"` + `trafficInspection = "Full"`.
The router injects the full D7 allowlist per sandbox on create (router, GitHub
+ `*.github.com` + `*.githubusercontent.com`, `api.anthropic.com` AND
`console.anthropic.com` (OAuth refresh — without it sessions 401 on first
token expiry), Linear, npm/PyPI/Go/Rust/Ruby/Maven/NuGet). Spike S4 confirmed
WSS works through `Full`; blocked hosts fail fast with HTTP 403. **`Full`
blocks non-HTTP TCP/UDP** → `git+ssh://` / SSH submodule URLs are unsupported —
use HTTPS submodule URLs (documented v1 limitation).

Leave `aca_egress_host_rules = null` to retain that provider-managed list and
the dynamically appended router host. Setting explicit host rules replaces the
provider defaults.

### VNet / private endpoints

Out of scope for v1. The Key Vault is created with `default_action = "Allow"`
for dev ergonomics; tighten to your VNet/IP list in prod. The deferred VNet
shape for the sandbox group lives in `bicep/sandbox-group-vnet.bicep`
(reference only — not wired into Terraform).

### Terminal GC blind spots

The normal close/delete path wakes the sandbox, relays the raw terminal webhook,
forces the persistence-floor flush, waits for the authenticated teardown
callback, destroys sandbox plus snapshots, and then deletes the device row.
Deleted issues also lose their bundle; completed/canceled bundles are retained
for reopen. Linear sends no `issueStatusChanged` notification for closes made by
the Cyrus app identity or for the `duplicate` state. Those cases rely on manual
destroy or the 14-day stale-GC backstop. A router restart during the in-memory
10-minute teardown grace has the same immediate-GC blind spot.

The router-mode fake-ACA lifecycle is covered by the dated F1 report under
[`apps/f1/test-drives/`](../../apps/f1/test-drives/). It validates Cyrus control
flow without Azure, but cannot validate data-plane wire compatibility, RBAC,
actual worker-image boot/liveness, snapshot inheritance, or egress. The live
Azure smoke remains a merge gate until those checks pass with the published
router and worker images.

## Files

```
terraform/
  versions.tf     providers + terraform >=1.9
  variables.tf    every variable (documented)
  main.tf         RG, Log Analytics, KV, UAI, storage, CAE, RBAC, seed secrets
  router.tf       router Container App + env + Files mount + custom domain flag
  sandbox.tf      azapi_resource sandbox group + Data Owner RBAC + optional ACR
  outputs.tf      paste-ready outputs (N8)
  env/dev.tfvars.example  complete variable checklist
bicep/
  README.md                     reference shape; parity-gate usage
  sandbox-group.bicep           canonical ARM shape (properties: {})
  sandbox-group-rbac.bicep     Data Owner assignment for a principal
  sandbox-group-vnet.bicep      optional vnetConnections child (deferred)
  sandbox-group.bicepparam.example
```
