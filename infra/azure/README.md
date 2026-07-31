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
- **Terraform >= 1.9.** (`terraform -version`.)
- **Docker Buildx** when images are not already published to a registry.
- **The standalone `aca` CLI** for sandbox data-plane operations. Install it on
  Linux/macOS with `curl -fsSL https://aka.ms/aca-cli-install | sh`. This same
  install path is also used inside sandboxes and containers for agent-driven
  self-installs. Verify and authenticate without unnecessarily reopening login:
  ```bash
  aca --version
  az account show -o none 2>/dev/null || az login
  aca auth status >/dev/null 2>&1 || aca auth login
  ```
- **A Linear OAuth application** configured for app-actor authorization. The
  deployment needs its client ID, client secret, webhook signing secret,
  workspace access token, and workspace refresh token.
- **A pre-registered worker disk image.** Terraform owns the sandbox group but
  not its data-plane disk images. Registration is step 6 below.
- **Private images -> enable ACR.** The staged flow below creates ACR before the
  router app so the current source can be built and pushed without a bootstrap
  image. Public registries can skip the ACR-specific steps.
- **S6 RBAC propagation note.** The first sandbox data-plane call after a
  fresh role assignment may 403 for up to ~100 s (spike measured < 1 min, but
  the client retries). `aca sandboxgroup create` auto-assigns the
  *Container Apps SandboxGroup Data Owner* role to the caller unless
  `--skip-role-check` is passed — so if you create the group via the CLI
  instead of Terraform you may already have it.
- **Key Vault is RBAC-only** (`rbac_authorization_enabled = true`). The stack
  seeds the Linear app/workspace secrets from tfvars on first deploy, which
  requires the deployer
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

## End-to-end deployment

The sequence below covers a fresh private-ACR deployment through its first ACA
user. Keep `dev.tfvars`, Terraform state, OAuth tokens, and user credentials out
of git. This repository ignores local `*.tfvars`, `.terraform/`, and `*.tfstate`;
use a remote encrypted Terraform backend for a shared or production deployment.

### 1. Create and authorize the Linear app

Create a private OAuth app in **Linear workspace settings -> API -> OAuth
Applications** with:

- Redirect callback: `http://localhost:3457/callback` for initial authorization.
- Webhook URL: a temporary HTTPS placeholder; replace it in step 7.
- Webhook events: Agent sessions, Inbox notifications, Permission changes, Issues.
- Public: disabled.

Put the new app values in a temporary mode-0600 env file outside the repository:

```dotenv
LINEAR_CLIENT_ID=<client-id>
LINEAR_CLIENT_SECRET=<client-secret>
LINEAR_WEBHOOK_SECRET=<webhook-signing-secret>
CYRUS_BASE_URL=http://localhost:3457
CYRUS_SERVER_PORT=3457
CYRUS_HOST_EXTERNAL=false
```

Authorize the app actor and select the target workspace in the browser:

```bash
chmod 600 /secure/path/linear-app.env
cyrus --env-file /secure/path/linear-app.env self-auth-linear
```

The command writes `linearToken`, `linearRefreshToken`, and the real Linear
organization UUID to `~/.cyrus/config.json`. Use the UUID, not the workspace
slug, for `linear_workspace_id` and every repository's
`linear_workspace_id`. List workspace UUIDs without printing tokens:

```bash
jq -r '.linearWorkspaces | to_entries[] | [.key, .value.linearWorkspaceSlug] | @tsv' \
  ~/.cyrus/config.json
```

### 2. Prepare Terraform variables

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT/infra/azure/terraform"
cp env/dev.tfvars.example dev.tfvars
chmod 600 dev.tfvars
```

Fill every placeholder. For a private registry set `enable_acr = true` and point
`router_image`/`worker_image` at the ACR login server that the naming convention
will create. Both image refs must be immutable — Terraform rejects `:latest`,
`:deploy`, and other floating tags; see
[Router image tag policy](#router-image-tag-policy). You fill in the real refs in
step 4, once there is a build to pin. Set:

- `linear_workspace_id` to the organization UUID from step 1.
- `linear_workspace_token` and `linear_workspace_refresh_token` to the OAuth
  pair saved by `self-auth-linear`.
- `linear_client_id`, `linear_client_secret`, and `linear_webhook_secret` to
  the same app's values.
- Each `cyrus_repositories[*].linear_workspace_id` to the same UUID.
- `router_url_for_containers = null` for the first apply.
- `operator_principal_id` to `az ad signed-in-user show --query id -o tsv` for
  backup break-glass access.

Use an exact resource group such as `rg-cyrus` by setting
`resource_group_name`; otherwise it defaults to `rg-<project>-<environment>`.

### 3. Initialize and create bootstrap resources

The router image cannot be created until ACR exists. Create only the resource
group, vault, identities, sandbox group, and ACR first:

```bash
terraform init
terraform fmt -check
terraform validate
terraform apply -var-file=dev.tfvars \
  -target=azurerm_key_vault.this \
  -target=azurerm_user_assigned_identity.router \
  -target='azurerm_container_registry.this[0]' \
  -target=azapi_resource.sandbox_group
```

Grant the deployer temporary data-plane rights needed to seed Key Vault and push
the images. Terraform separately grants runtime identities their permanent roles:

```bash
DEPLOYER_ID=$(az ad signed-in-user show --query id -o tsv)
KV_ID=$(az keyvault show --name <vault-name> --query id -o tsv)
ACR_ID=$(az acr show --name <acr-name> --query id -o tsv)

az role assignment create --assignee-object-id "$DEPLOYER_ID" \
  --assignee-principal-type User --role "Key Vault Secrets Officer" --scope "$KV_ID"
az role assignment create --assignee-object-id "$DEPLOYER_ID" \
  --assignee-principal-type User --role AcrPush --scope "$ACR_ID"
```

Allow several minutes for fresh RBAC assignments to propagate.

### 4. Build and push immutable images

Derive the tag from the commit you are deploying so the tag names exactly one
build. Never push `:latest`, `:deploy`, a branch name, or an ad-hoc hotfix tag
into a durable environment — Terraform rejects those refs (see
[Router image tag policy](#router-image-tag-policy)).

```bash
cd "$REPO_ROOT"
az acr login --name <acr-name>
# Same shape as the `sha-<short-sha>` tag docker-router.yml publishes to GHCR.
TAG="sha-$(git rev-parse --short=7 HEAD)"   # or a release tag: TAG=v1.2.3

docker buildx build --platform linux/amd64 \
  --file docker/router/Dockerfile \
  --tag <acr-name>.azurecr.io/cyrus-router:$TAG --push .
docker buildx build --platform linux/amd64 \
  --file docker/worker/Dockerfile \
  --tag <acr-name>.azurecr.io/cyrus-worker:$TAG --push .
```

Set `router_image` and `worker_image` in `dev.tfvars` to those exact refs. For
the strongest pin, resolve the pushed digest and use that instead of the tag:

```bash
az acr manifest show-metadata <acr-name>.azurecr.io/cyrus-router:$TAG \
  --query digest -o tsv
# → router_image = "<acr-name>.azurecr.io/cyrus-router@sha256:<64 hex>"
```

Confirm the build actually contains the commit you intend to deploy before you
pin it — a tag is only as trustworthy as the commit it was cut from.

### 5. Apply the complete stack

```bash
cd "$REPO_ROOT/infra/azure/terraform"
terraform plan -var-file=dev.tfvars -out=tfplan
terraform apply tfplan
```

If Container Apps cannot resolve a new Key Vault reference, wait for RBAC
propagation and apply again. The router can start before the worker disk is
registered, but do not delegate an issue until step 6 is complete.

### 6. Configure ACA and register the worker disk

```bash
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
RESOURCE_GROUP=$(terraform output -raw resource_group_name)
SANDBOX_GROUP=$(terraform output -raw sandbox_group_name)
DEPLOYER_ID=$(az ad signed-in-user show --query id -o tsv)

aca config set --subscription "$SUBSCRIPTION_ID" \
  --resource-group "$RESOURCE_GROUP" --region <region>
aca config sandbox set --group "$SANDBOX_GROUP"
aca sandboxgroup role create \
  --role "Container Apps SandboxGroup Data Owner" \
  --principal-id "$DEPLOYER_ID" --group "$SANDBOX_GROUP"
aca doctor
```

For a public worker image, register it directly. For private ACR, the preview CLI
may not resolve the sandbox group's system identity during disk import; use a
short-lived ACR refresh token for this one operation. Runtime pulls still use the
group's managed identity:

```bash
ACR_TOKEN=$(az acr login --name <acr-name> --expose-token \
  --query accessToken -o tsv)
aca sandboxgroup disk create \
  --image <acr-name>.azurecr.io/cyrus-worker:<immutable-tag> \
  --name <aca-disk-name> \
  --username 00000000-0000-0000-0000-000000000000 \
  --token "$ACR_TOKEN" \
  --group "$SANDBOX_GROUP"
unset ACR_TOKEN

aca sandboxgroup disk list --group "$SANDBOX_GROUP"
```

Wait for the disk state to become `Ready`. Private disks are created by their
server-assigned disk ID; the router resolves the configured operator name from
`labels.name` and sends that ID on sandbox create.

### 7. Set the stable router URL and Linear webhook

Read the stable app ingress, not a revision-specific FQDN:

```bash
terraform output -raw router_fqdn
terraform output -raw router_wss_url
```

Set `router_url_for_containers` in `dev.tfvars` to the `router_wss_url` output and
apply again:

```bash
terraform apply -var-file=dev.tfvars
```

In the Linear app, set the webhook URL to:

```text
https://<router_fqdn>/linear-webhook
```

Keep the signing secret identical to `linear_webhook_secret`. `/webhook` is a
deprecated compatibility alias; use `/linear-webhook` for new deployments.

Verify the router:

```bash
curl -fsS "https://$(terraform output -raw router_fqdn)/healthz"
az containerapp logs show --name <router-app> --resource-group "$RESOURCE_GROUP" \
  --type console --tail 100
```

### 8. Optional Entra-gated device enrollment

ACA executor users do not enroll a physical device, so Entra is not required for
their worker. To protect future `cyrus connect` enrollment, create one single-
tenant app registration per router, expose a delegated `user_impersonation`
scope, pre-authorize Microsoft Azure CLI (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`),
and set the exact Application ID URI as `entra_audience`. Set
`entra_tenant_id` and optionally `entra_allowed_domain`, then verify:

```bash
az account get-access-token --scope '<entra-audience>/.default' -o none
```

See [`docs/ROUTER.md`](../../docs/ROUTER.md#optional-entra-gated-enrollment) for
the token validation and client connection flow.

### 9. Register an ACA user and their secrets

Run hosted administration inside the router replica so commands use its Key
Vault-backed secret store and SQLite database. Start an interactive shell:

```bash
az containerapp exec --name <router-app> --resource-group "$RESOURCE_GROUP"
```

Then run inside the replica:

```bash
cyrus router users add alice@example.com --name "Alice Example"
cyrus router users set-executor alice@example.com aca

# Always required. Generate on a trusted machine with `claude setup-token`.
cyrus router secrets set alice@example.com CLAUDE_CODE_OAUTH_TOKEN <value>

# Recommended for user-attributed Linear MCP, GitHub, and commits.
cyrus router secrets set alice@example.com LINEAR_API_TOKEN <personal-linear-key>
cyrus router secrets set alice@example.com GH_TOKEN <github-token>
cyrus router secrets set alice@example.com GIT_USER_NAME "Alice Example"
cyrus router secrets set alice@example.com GIT_USER_EMAIL alice@example.com

cyrus router secrets list alice@example.com

# Optional: also report the stored GitHub token's OAuth scopes (advisory only —
# never rejects a usable token, never prints token values).
cyrus router secrets list alice@example.com --check-scopes

cyrus router users list
```

`CLAUDE_CODE_OAUTH_TOKEN` is the only unconditional boot requirement. For a
private repository, a classic-PAT `GH_TOKEN` needs the `repo` scope — that is the
functional minimum and covers clone, commit, push, and issue/PR access. Add
`read:org` **only** when organization-level queries are required; `gh auth
status` warns about its absence even for tokens that work correctly, so that
warning is not a failure. Fine-grained PATs use per-resource permissions instead
of scopes (grant Contents read/write at minimum) and report no scope list, so
`--check-scopes` reports them as un-introspectable rather than deficient. Full
breakdown: [docs/GIT_GITHUB.md](../../docs/GIT_GITHUB.md#token-scopes).
`LINEAR_API_TOKEN` is a
personal key used by the hosted Linear MCP, separate from the router app's
workspace OAuth token. ACA users do not redeem the printed enrollment code and
do not run `cyrus connect`; their per-issue sandbox is their device.

Additional arbitrary tool credentials can be stored under any non-reserved env
name. Secret values are injected only during a fresh create-from-image. To apply
a rotation immediately:

```bash
cyrus router containers destroy <issue-key>
```

Re-prompt the issue to create a worker with the new environment.

### 10. Smoke test the deployment

Create a disposable Linear issue assigned to the registered email and delegate it
to the app. Confirm:

```bash
aca sandbox list --selector 'cyrus.issue=<ISSUE-KEY>'
az containerapp exec --name <router-app> --resource-group "$RESOURCE_GROUP"
# Inside the replica:
cyrus router containers list
```

The sandbox must reference the private disk by `sourcesRef.diskImage.id`, connect
to the router, execute a Claude prompt, push with the user's GitHub identity, and
perform a Linear MCP read/write. Then test idle stop, follow-up recovery, Done
cleanup, and snapshot removal. Current live-test defects and their acceptance
criteria are tracked in [`TODO.md`](../../TODO.md).

### `routerUrlForContainers` two-apply rationale

The stable ingress FQDN is known only after the Container App exists. Embedding
it into the router's own environment in the same plan creates a Terraform
dependency cycle. The first apply therefore uses a placeholder; step 7 copies the
stable `azurerm_container_app.router.ingress[0].fqdn` output into tfvars and
applies a second revision.

The `cyrus_router_containers_json` output is non-sensitive and contains the
complete, merge-ready config (image, router WSS URL, repositories, `aca`
block with subscriptionId/resourceGroup/sandboxGroup/region/disk/cpu/memory/
autoSuspendSeconds/egress*/keepSnapshots/managementEndpoint, `keyVaultUrl`,
`artifactsDir`, `backupBlobUrl`). It does not contain secret values; per-user
secrets live in Key Vault and are injected per-sandbox on create (D1/D5).

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

### Router image tag policy

`router_image` and `worker_image` must be pinned to an **immutable** reference:

| Form | Example | Use |
| --- | --- | --- |
| Digest | `…/cyrus-router@sha256:<64 hex>` | Strongest pin. Preferred. |
| Release tag | `…/cyrus-router:v1.2.3` | Published by `docker-router.yml` on `v*` tags. |
| Git-SHA tag | `…/cyrus-router:sha-a1b2c3d` | Published by `docker-router.yml` on every push to `main`. |

Terraform **rejects** anything else (`:latest`, `:deploy`, a branch name, an
ad-hoc hotfix tag, or an untagged ref). The escape hatch
`allow_mutable_image_tags = true` exists for throwaway stacks only and must stay
`false` in a durable environment.

Why: a mutable tag does not identify a build. The tag string recorded in
Terraform state never changes, so Terraform reports **no diff** while the
registry quietly re-points the tag at different bits. The next unrelated
`terraform apply` then pulls whatever that tag means at that moment — which can
roll the router **backwards** onto an older image, silently reverting a fix, with
nothing in the plan output to warn you.

#### Reconciling a hand-patched (emergency) router image

This is the situation to look for: someone hotfixed the live Container App with
`az containerapp update --image …:deploy-aca-disk-fix` while `dev.tfvars` still
said `:deploy`. The running revision and the Terraform input now disagree, and
the next apply reverts the hotfix. Reconcile **before** the next apply:

1. Diff what is actually running against what Terraform declares. If these two
   differ, an apply right now would change the running image:

   ```bash
   RG=$(terraform output -raw resource_group_name)
   APP=$(terraform output -raw router_app_name)

   echo "live:     $(az containerapp show -g "$RG" -n "$APP" \
     --query 'properties.template.containers[0].image' -o tsv)"
   echo "declared: $(terraform output -raw router_image)"
   ```

2. Identify the commit that image was built from. If it is not obvious, inspect
   the image's revision/source labels, or rebuild from the commit you know
   carries the fix (here: the private-disk fix) and diff behaviour.

3. Build and push an **immutable** tag from that commit — step 4 above. Do not
   reuse the hotfix tag; cut `sha-<short-sha>` (or a release tag) from the exact
   commit.

4. Pin it in `dev.tfvars`:

   ```hcl
   router_image = "<acr-name>.azurecr.io/cyrus-router:sha-<short-sha>"
   ```

5. Plan and read the diff **before** applying. Expect either no image change
   (if the immutable tag resolves to the same bits already running) or a single
   deliberate image change. A plan that reverts the image to an older ref means
   you pinned the wrong commit — stop and go back to step 2.

   ```bash
   terraform plan -var-file=dev.tfvars -out=tfplan
   terraform apply tfplan
   ```

6. Verify the new revision is serving and healthy before closing out:

   ```bash
   az containerapp revision list -g "$RG" -n "$APP" \
     --query '[].{name:name,active:properties.active,image:properties.template.containers[0].image}' -o table
   ```

Rolling back is then just re-pinning the previous immutable ref and applying —
which is the whole point of the policy. Note the router runs a single replica by
design, so an apply that changes the image is a brief interruption, not a
zero-downtime rollout; drain or expect in-flight sessions to reconnect.

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

The Linear app and workspace secrets in Key Vault are **seeded from Terraform vars on first
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

### Re-authorizing Linear

Symptom: router logs `Linear refused the refresh token for workspace … (HTTP 400)`,
and every Linear read/write fails — including all worker activity posting, which
proxies through the router.

```bash
cyrus --env-file /secure/path/linear-app.env self-auth-linear
# update linear_workspace_token + linear_workspace_refresh_token in tfvars,
# then apply so the Key Vault secrets are updated:
terraform -chdir=infra/azure/terraform apply -var-file=dev.tfvars
az containerapp revision restart -g rg-cyrus -n app-cyrus-dev-router \
  --revision "$(az containerapp show -g rg-cyrus -n app-cyrus-dev-router \
    --query properties.latestRevisionName -o tsv)"
cyrus router linear status   # expect: ok
```

The router stores each rotated token in the runtime-created Key Vault secret
`cyrus-linear-refresh-<workspaceId>`. That secret is **not** managed by
Terraform, so `terraform apply` never reverts it. Changing the seed in tfvars is
what tells the router to abandon the stored chain and adopt the new credential.

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
