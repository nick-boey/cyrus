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

Use an exact resource group by setting `resource_group_name`; otherwise it
defaults to `rg-<project>-<environment>`.

### 3. Initialize and create bootstrap resources

#### Terraform state backend

State lives in its own resource group, `rg-cyrus-tfstate`, which this stack does
**not** manage. It cannot live in `azurerm_resource_group.this`: that group is
created by the stack, so `terraform destroy` would delete the container holding
the state file it is mid-write to, and on a first run the container would not
exist at all.

Run once per environment, with Owner (or Contributor + Role Based Access Control
Administrator) on the subscription:

```bash
./scripts/bootstrap-tfstate.sh \
  --state-account <globally-unique-name> \
  --repo <owner>/<private-repo> \
  --location <region>
```

`--location` is required, matching `var.location` in the stack — neither has a
default, so nothing lands in a region nobody chose. It need not match the
stack's region: the state group holds only blobs and an identity, and carries
none of the ACA sandbox-group region restrictions.

It creates the storage account (blob versioning on — state loss is the one
unrecoverable failure in this stack), the `tfstate` container, and the
user-assigned identity that GitHub Actions assumes over OIDC. The federated
credential trusts exactly one branch of one private repo; no client secret is
created, so there is nothing to store or rotate. The script prints the values
for `env/backend.dev.hcl` and the three repository variables when it finishes.

`versions.tf` declares `backend "azurerm" {}` with no settings — a backend block
cannot interpolate variables, so naming the account there would both publish an
environment identifier and hardcode one environment into a parameterised stack.
Every setting is supplied at init time instead:

```bash
cp env/backend.dev.hcl.example env/backend.dev.hcl   # then fill it in
terraform init -backend-config=env/backend.dev.hcl
```

Migrating an existing local state file up is `terraform init -migrate-state
-backend-config=env/backend.dev.hcl`; answer `yes` to the copy prompt.

> A plan that proposes creating every resource from scratch against a stack you
> know exists means the `key` is wrong, not that the stack drifted. Check
> `env/backend.dev.hcl` before applying.

#### Bootstrap resources

The router image cannot be created until ACR exists. Create only the resource
group, vault, identities, sandbox group, and ACR first:

```bash
terraform init -backend-config=env/backend.dev.hcl
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

For the **router** image, `scripts/deploy-router-image.sh` does all of this —
build, digest resolution, repinning `router_image`, and `terraform plan` — in
one step, and refuses to build from a dirty tree so the tag cannot misname the
commit. Prefer it over the manual sequence below:

```bash
./scripts/deploy-router-image.sh          # then review the plan and apply
```

The manual steps below remain the reference for the **worker** image, which the
script does not handle: the worker is registered out of band as an ACA disk
(`aca sandboxgroup disk create`) and `aca_disk_name` must move with it.

Build with **`az acr build`**, not local `docker buildx --push`:

```bash
cd "$REPO_ROOT"
# Same shape as the `sha-<short-sha>` tag docker-router.yml publishes to GHCR.
TAG="sha-$(git rev-parse --short=7 HEAD)"   # or a release tag: TAG=v1.2.3

az acr build --registry <acr-name> --image cyrus-worker:$TAG \
  --platform linux/amd64 --file docker/worker/Dockerfile \
  --no-logs --query 'outputImages[0].digest' -o tsv .
```

> **Do not build the worker image with `docker buildx --push`.** Recent buildx
> attaches provenance/SBOM attestations by default, which makes the push an OCI
> **image index** (`application/vnd.oci.image.index.v1+json`) carrying the real
> `linux/amd64` manifest plus an `unknown/unknown` attestation child. Every
> worker disk that has ever imported successfully is a plain
> `application/vnd.docker.distribution.manifest.v2+json`. `az acr build`
> produces that shape, and as a server-side build it also runs natively on
> amd64 instead of under emulation on an arm64 workstation — minutes rather
> than tens of minutes.
>
> To check what you pushed:
>
> ```bash
> az acr manifest show <acr-name>.azurecr.io/cyrus-worker:$TAG \
>   --query mediaType -o tsv
> ```
>
> If you must use buildx, disable the attestations
> (`--provenance=false --sbom=false`) and confirm the media type before
> registering the disk.

Set `worker_image` in `dev.tfvars` to that exact ref. For the strongest pin,
use the digest the build printed instead of the tag:

```bash
az acr manifest show-metadata <acr-name>.azurecr.io/cyrus-worker:$TAG \
  --query digest -o tsv
# → worker_image = "<acr-name>.azurecr.io/cyrus-worker@sha256:<64 hex>"
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

**Gate on `disk list` showing `Ready`, not on the exit code.** `aca
sandboxgroup disk create` piped into another command (`| tail`, `| grep`)
reports the *pipeline's* status, so a failed import reads as exit 0. The
authoritative check is the disk appearing in `aca sandboxgroup disk list` with
state `Ready`.

> **`Error: Network issue — retry policy expired`.** This message is emitted
> for any transport-level failure of the `PUT …/diskimages` call and is
> frequently *not* a network fault. Before treating it as one:
>
> - Re-run with `--verbose`. A genuine network problem shows a real HTTP status;
>   a client-side timeout shows `failed to execute 'reqwest' request` with no
>   status, retried once, failing at roughly 120 s total (two ~60 s attempts).
> - Confirm the pushed image is a plain Docker v2 manifest, not an OCI index
>   (see step 4) — the importer cannot consume an index.
> - Check reachability independently. `curl` a GET *and* a PUT against the same
>   `…/diskimages` URL: a 401 from both means the endpoint and method are fine
>   and the problem is not your egress path.
> - Run `aca doctor` to rule out auth, region, group, and the
>   *SandboxGroup Data Owner* role assignment.
>
> If all of those pass and the PUT still times out with no HTTP status, the
> preview data-plane service is the remaining suspect; retry later rather than
> rebuilding images. A failed registration changes nothing, so it is safe to
> deploy the router alone and register the disk afterwards — an older worker
> parses `CYRUS_REPOS_JSON` with a non-strict schema and ignores fields it does
> not know, and the router scopes that list before the worker ever sees it.

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

### 11. Optional: the setup management UI (`/setup`)

`/setup` lets a teammate manage their own container environment variables in a
browser instead of through `az containerapp exec`. It is off by default, and
turning it on is a **two-apply sequence with a live verification gate in the
middle**. Read this whole section before starting; the ordering is the security
property, not a suggestion.

#### Why two applies

`authConfigs` — the ACA built-in auth ("EasyAuth") sidecar — is an ARM **child**
of the Container App. Terraform must create the app, and therefore publish the
revision that serves `/setup`, *before* it can attach the sidecar. A single
`enable_setup_ui` flag would guarantee a window in which an unauthenticated
`/setup` is reachable on the public internet, and no post-apply check can close
a window that opens mid-apply.

So the flags are split, and Terraform refuses to let you collapse them:

| Variable | Apply | Effect |
| --- | --- | --- |
| `enable_setup_auth` | **first, alone** | Entra client secret, token store, `authConfigs`. `/setup` still 404s. |
| — | **verification gate** | Steps 4a–4c below. Recorded in `setup_auth_stage1_verified`. **Ordering is enforced against Azure, not by that flag** — see below. |
| `enable_setup_ui` | **second, separate apply** | Sets `CYRUS_ROUTER_SETUP_UI_*`, which is what registers the routes. |

`enable_setup_ui = true` fails variable validation unless both
`enable_setup_auth` and `setup_auth_stage1_verified` are already true — and,
more importantly, `azurerm_container_app.router` carries preconditions over a
data source that reads the **already-deployed** `authConfigs` child out of
Azure. Setting all three in one tfvars edit therefore fails at **plan** time,
because on that plan the auth child genuinely does not exist yet.

The booleans are a fast, readable first line of defence; the data source is the
actual control. A boolean an operator supplies in the same plan can only ever
attest to intent — it cannot establish that a prior apply happened.

**Rollback reverses the order**: clear `enable_setup_ui`, apply, confirm `/setup`
returns 404, and only then clear `enable_setup_auth`.

> **If you already applied an earlier revision of this stack**, the Table and
> KEK were created unconditionally at that time. Set
> `enable_setup_secret_store = true` to keep them. Leaving it false produces a
> `prevent_destroy` plan error naming the protected resource — deliberately, so
> the flag can never silently destroy the only key that can decrypt existing
> records. Only the dev stack should be affected; this has not shipped.

#### Prerequisites

- **Only when `enable_setup_secret_store = true`:** the applying principal
  needs **Key Vault Crypto Officer** on the vault. The
  stack creates an RSA KEK (`azurerm_key_vault_key.setup_kek`), and the existing
  Secrets User / Secrets Officer grants are for the *router* identity and cover
  secrets only — no role in this stack permits creating a key.

  ```bash
  KV_ID=$(az keyvault show -n "$(terraform output -raw key_vault_name)" --query id -o tsv)
  az role assignment create \
    --assignee "<your-object-id>" \
    --role "Key Vault Crypto Officer" \
    --scope "$KV_ID"
  ```

- The storage account must allow shared-key access, because
  `azurerm_storage_table` and the token-store SAS are both data-plane operations
  keyed on the account key. If you have disabled shared key, set
  `storage_use_azuread = true` in the `provider "azurerm"` block and grant the
  applying principal *Storage Table Data Contributor* first.

- Entra tenant admin (or Application Administrator) to edit the app
  registration in step 2.

> **The Azure Table and the KEK are created unconditionally and are not part of
> this feature flag.** They are cheap and inert until something reads them, and
> they are deliberately *not* gated: see "Decommissioning the per-user secret
> store" for why, and for the only supported way to remove them.

#### Step 1 — read the values Terraform already knows

```bash
cd infra/azure/terraform
FQDN=$(terraform output -raw router_fqdn)
REDIRECT=$(terraform output -raw setup_ui_redirect_uri)
RG=$(terraform output -raw resource_group_name)
APP=$(terraform output -raw router_app_name)
```

`setup_ui_redirect_uri` is emitted unconditionally, precisely so it is available
*before* stage 1 — you cannot configure Entra from a value that only exists once
the thing you are configuring is already live.

#### Step 2 — extend the EXISTING router app registration

Do not mint a second app. "One app registration/audience per router deployment"
is a standing invariant, and `entra_audience` (the `api://<client-id>`
Application ID URI used by `/enroll` access tokens) and the setup UI's ID-token
audience (the bare client-id GUID) are two audiences of the *same* app.

```bash
APP_ID="<the existing router app registration's client id>"

# EasyAuth performs an implicit ID-token flow.
az ad app update --id "$APP_ID" --enable-id-token-issuance true

# `--web-redirect-uris` REPLACES the whole list. Read it back first or you will
# silently break enrollment sign-in.
EXISTING=$(az ad app show --id "$APP_ID" --query "web.redirectUris" -o tsv | tr '\n' ' ')
az ad app update --id "$APP_ID" --web-redirect-uris $EXISTING "$REDIRECT"

# Verify the old URIs survived.
az ad app show --id "$APP_ID" --query "web.redirectUris" -o tsv

# One client secret for the sidecar. The value is shown ONCE.
az ad app credential reset --id "$APP_ID" \
  --display-name "cyrus-router-easyauth" --years 2 --query password -o tsv
```

Record both values in your gitignored tfvars:

```hcl
setup_ui_client_id     = "<APP_ID>"
setup_ui_client_secret = "<the password printed above>"

# Static SAS window for the ACA token store. Must NOT be derived from
# timestamp(): that re-evaluates every plan and would roll a new router
# revision on every apply. Diarise the expiry — see "Rotating the setup UI
# secrets".
setup_ui_token_store_sas_start  = "2026-01-01T00:00:00Z"
setup_ui_token_store_sas_expiry = "2027-01-01T00:00:00Z"
```

#### Step 3 — restrict who can sign in (HARD PREREQUISITE for auto-provisioning)

By default **any** account in the tenant can obtain a token for the app.
`setup_ui_allowed_domain` does not change that — a domain check cannot tell an
assigned teammate from any other account in the same tenant. So if
`setup_ui_auto_provision_users` is left at its default of `false`, an unknown
signer is refused and you can skip to step 4. If you want first sign-in to
create the user, you must restrict membership first, and Terraform enforces it:
`setup_ui_auto_provision_users = true` fails validation unless one of the two
options below is in place.

**Option A — `authConfigs` allowed principals (no Entra premium licence).**
Terraform renders these into
`identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy.allowedPrincipals`:

```hcl
setup_ui_allowed_group_object_ids     = ["00000000-0000-0000-0000-000000000000"]
# or, less maintainably, one entry per person:
setup_ui_allowed_principal_object_ids = []
setup_ui_auto_provision_users         = true
```

An empty list sends **no** policy at all — an empty policy is not the same as an
absent one, so do not treat `[]` as "deny everyone".

**Option B — Entra assignment requirement.** Two changes, and *both* are
required: `appRoleAssignmentRequired` without an assignment locks everyone out,
and an assignment without the flag restricts nobody.

```bash
SP_OID=$(az ad sp show --id "$APP_ID" --query id -o tsv)
GROUP_OID=$(az ad group show --group "<your Cyrus users group>" --query id -o tsv)

az ad sp update --id "$APP_ID" --set appRoleAssignmentRequired=true

# Assign the group to the app's "default access" role. The all-zero GUID is the
# documented well-known id for that role, not a placeholder to fill in.
az rest --method POST \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_OID/appRoleAssignedTo" \
  --headers 'Content-Type=application/json' \
  --body "{\"principalId\":\"$GROUP_OID\",\"resourceId\":\"$SP_OID\",\"appRoleId\":\"00000000-0000-0000-0000-000000000000\"}"
```

Read both back, and keep the output:

```bash
az ad sp show --id "$APP_ID" --query appRoleAssignmentRequired -o tsv   # expect: true
az rest --method GET \
  --uri "https://graph.microsoft.com/v1.0/servicePrincipals/$SP_OID/appRoleAssignedTo" \
  --query 'value[].principalDisplayName' -o tsv                        # expect: your group
```

Only then:

```hcl
setup_ui_assignment_required_verified = true
setup_ui_auto_provision_users         = true
```

> **Licensing:** assigning a *group* to an app role requires Entra ID P1/P2.
> Without it, assign users individually or use Option A, which has no licence
> requirement.

#### Step 4 — STAGE 1 APPLY: auth only

```hcl
enable_setup_auth = true
# enable_setup_ui stays FALSE. Do not set it in this edit.
```

```bash
terraform plan  -var-file=dev.tfvars -out=tfplan
terraform apply tfplan
```

Expected diff: one Key Vault secret for the client secret, one blob container +
one Key Vault secret for the token-store SAS, two new `secret {}` blocks on the
Container App (so a new revision), and the `azapi_resource.router_auth` child.
No `/setup` route is created.

#### Step 5 — THE GATE

**This is an acceptance criterion, not a formality.** `authConfigs` changes
ingress behaviour for *every* path on the app. Steps 5a and 5c are the required
behavioural checks recorded in `setup_auth_stage1_verified`; 5b is retained as a
defence-in-depth probe rather than the trust basis of a selectable mode, since
Terraform no longer offers `easyauth-headers`. Do not proceed to stage 2 until all three
pass. Paste the output into the change record.

**5a — machine routes still reach the app.** A `302` to `/.auth/login/aad` on
any of these means the auth config is wrong and webhook delivery and worker
reconnects are broken *right now*:

```bash
curl -fsS "https://$FQDN/healthz"                                     # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' "https://$FQDN/workspaces"   # 401 from OUR app, not 302
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  "https://$FQDN/linear-webhook"                                      # 4xx from our handler, not 302

# Force a real reconnect rather than trusting a stale row: bounce the revision,
# then confirm a worker re-completes its hello + heartbeat.
az containerapp exec --name "$APP" --resource-group "$RG"
#   inside: cyrus router containers list   → an existing worker shows connected
```

**5b — the header-strip probe.** A forged identity header with no session cookie
must not authenticate:

```bash
curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'X-MS-CLIENT-PRINCIPAL-NAME: attacker@example.com' \
  "https://$FQDN/setup"
# expect 404 at this stage (routes do not exist yet) — and, after stage 2, 401.
# A 200 at any point means STOP AND ESCALATE.
```

Terraform refuses `easyauth-headers` outright — `setup_ui_auth_mode` accepts only `entra-token`, because the header mode's trust boundary is proxy topology the configuration cannot verify. A 200 here is still STOP-AND-ESCALATE: it means the ingress is injecting or passing identity you did not expect.
Use the default `entra-token` mode, which verifies the forwarded ID token
cryptographically and ignores `X-MS-CLIENT-PRINCIPAL-*` entirely — its trust
boundary is a signature, not proxy topology.

**5c — sign-in works.** Stage 1 is what makes this provable before any route
exists:

```bash
open "$(terraform output -raw setup_ui_sign_in_url)"
```

You should complete an Entra sign-in and land back on the app. If step 3 Option
B is in place, confirm an **unassigned** tenant account is refused here.

Record the result:

```hcl
setup_auth_stage1_verified = true
```

#### Step 6 — STAGE 2 APPLY: enable the routes

```hcl
enable_setup_ui = true
setup_ui_auth_mode      = "entra-token"   # recommended; the default
setup_ui_allowed_domain = "example.com"   # optional defence in depth
```

```bash
terraform plan  -var-file=dev.tfvars -out=tfplan
terraform apply tfplan
terraform output -raw setup_ui_url
```

Expected diff: `CYRUS_ROUTER_SETUP_UI_*` env vars on the container, and the
resulting revision. Then re-run **5b** — it must now return `401`, not `200` —
and sign in to `setup_ui_url` as a real teammate.

#### Rolling back

1. `enable_setup_ui = false`; apply. Confirm `curl -o /dev/null -w '%{http_code}'
   "https://$FQDN/setup"` returns `404`.
2. Only then `enable_setup_auth = false`; apply. This destroys the token-store
   container (session state only — everyone is signed out, nothing is lost) and
   the `authConfigs` child.
3. Leave `setup_auth_stage1_verified` as it is; it records history, not intent.

Never do these in one apply, and never step 2 before step 1 — that is the
unauthenticated-`/setup` window again, in reverse.

### Key Vault → Table migration for per-user secrets

The Azure Table (`cyrussetup`), the envelope-encryption KEK, and the router's
*Storage Table Data Contributor* + *Key Vault Crypto User* role assignments are
created by every apply and are independent of the `/setup` flags. Cutting the
router **over** to them is a separate, ordered operation:

1. Set `enable_setup_secret_store = true` and apply. The Table and KEK now exist; the router still reads Key
   Vault, because `enable_setup_table_backend` is `false`.
2. `az containerapp exec` into the replica and dry-run the copy. The target is
   named explicitly, because `containers.tableStore` is deliberately NOT in the
   config yet — adding it is what makes the router start *reading* from the
   Table, which must come after the data is verified in place. Take the two
   values from `terraform output`:
   ```bash
   cyrus router secrets migrate --from keyvault --to table --dry-run \
     --to-endpoint "$(terraform output -raw setup_table_endpoint)" \
     --to-key-id  "$(terraform output -raw setup_kek_versioned_key_id)"
   ```
   Eyeball the `email  KEY  (n bytes)` list. Values are never printed.
3. Re-run without `--dry-run`, same flags.
4. Set `enable_setup_table_backend = true` and apply. This adds
   `containers.tableStore` to `CYRUS_ROUTER_CONTAINERS_JSON` and rolls one
   revision.
5. `cyrus router secrets list <email>` for two users — the key sets must match
   what step 2 reported.
6. Delegate a test issue and confirm the worker boots with its environment.
7. **Leave the Key Vault secrets in place for at least a week.** They are the
   rollback path. Deleting them is a separate change.

**Rollback is only safe until the first write through the UI.** Flipping
`enable_setup_table_backend = false` drops the router back to the Key Vault
backend, and nothing is destroyed — but migration is one-way, so every value a
user has added, changed, or rotated through `/setup` since cutover exists only
in the Table. Rolling back after that point silently restores the migration-time
snapshot, which can reinstate a credential the user believed they had replaced
or revoked.

Treat the Key Vault copy as a rollback path for the cutover window only. Once
users are editing through the UI, a return to Key Vault requires an explicit
reverse export that does not exist yet — do not assume it is a flag flip.

### Rotating the setup UI secrets

- **Entra client secret.** Rotate in Entra first
  (`az ad app credential reset --id "$APP_ID" --display-name cyrus-router-easyauth`),
  then `az keyvault secret set --vault-name <vault> --name setup-ui-client-secret
  --value <new>`. The Container App references it by *versionless* id, so the
  sidecar picks it up on the next revision without a Terraform apply. Update
  `setup_ui_client_secret` in tfvars in the same change or the next apply will
  overwrite the rotation.
- **Token-store SAS.** `setup_ui_token_store_sas_expiry` is a **live failure
  deadline**: past it, the sidecar can no longer persist sessions and sign-in
  breaks. Bump both window variables and apply. `Microsoft.App/containerApps/
  authConfigs@2024-03-01` models the token store as `sasUrlSettingName` only —
  there is no managed-identity token store on any shipped Microsoft.App auth
  API version — so a SAS is the only available shape, not a shortcut.
- **KEK.** Rotating the key does **not** re-wrap existing rows. Each record
  pins the key *version* it was wrapped with, so old versions must stay
  **enabled** until a re-wrap pass has run.

### Decommissioning the per-user secret store

There is deliberately no flag that removes the Table, the KEK, or the two role
assignments. Both the Table and the KEK carry `prevent_destroy = true`, so
`terraform destroy` — and any plan that would remove them — **fails on purpose**.
Destroying the KEK makes every wrapped record permanently unreadable; the
wrapped DEKs are useless without it. That is not a state a boolean should be
able to reach.

The supported workflow, in order:

1. Export every record and verify the export opens (`cyrus router secrets list`
   per user against the Table backend, plus a read-back of at least two users'
   full key sets).
2. `enable_setup_table_backend = false`; apply. The router is now off the Table.
3. Confirm workers still boot for a migrated user.
4. Retire KEK versions in Key Vault only after step 3 has held for a full
   retention window.
5. Only then remove the resources: delete the blocks from `setup_ui.tf`, drop
   the `prevent_destroy` guards in the same commit, and apply. To retire the
   Azure resources while keeping them out of Terraform's hands instead, use
   `terraform state rm` and delete them manually.

The same applies to whole-stack teardown — see "Teardown (M5)", which now has a
step for this.

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
  the actual idle and abandon controllers. `idleStopMs` defaults to 5 minutes
  and is set explicitly by Terraform (`var.idle_stop_ms`). It counts from the
  later of the last routed event and the moment a session *parked*.
- Set up `gc-snapshots` (Task 7) on a schedule.
- Rate-limit issue assignment (Linear automation) if you want a hard ceiling
  on concurrent workers — the platform will not enforce one.

## Monitoring and alerts

`monitoring.tf` provisions saved KQL searches and alert rules over the router's
JSON log stream. No agent, no exporter, no OpenTelemetry dependency — the
Container Apps environment already ships the router's stdout to the Log
Analytics workspace created in `main.tf`, and the router already writes one flat
JSON object per line (`CYRUS_LOG_FORMAT=json`, set in `router.tf`).

The data comes from the `sandbox_*` event family documented in
[`docs/ROUTER.md`](../../docs/ROUTER.md) → "Sandbox lifecycle telemetry". The
load-bearing one is `sandbox_gauge`: one sample per sandbox per 60-second
lifecycle sweep, carrying the issue key, provider state, live session count, and
both uptime clocks.

The **workers themselves** reach the same workspace by the same route. A sandbox
writes to a stdout nothing collects — the ACA sandbox group is a separate ARM
resource from the Container Apps environment, so the environment's diagnostic
wiring does not reach it, and the sandbox data-plane API has no logs endpoint.
Workers therefore forward level-filtered logs to the router over their existing
WebSocket, and the router re-emits them into the stream above, tagged
`source: "sandbox"` and attributed to the device row it authenticated. That
needs no widening of the sandbox egress allowlist and no workload credential
inside the sandbox. See [`docs/ROUTER.md`](../../docs/ROUTER.md) → "Sandbox
worker logs" for the queries and the `CYRUS_LOG_FORWARD_*` volume guard — the
defaults (WARN and above, 2/sec sustained) exist because this workspace is
PerGB2018 and unfiltered session stdout from every sandbox is not cheap.

### Saved searches (category "Cyrus Sandboxes")

| Search | Answers |
|--------|---------|
| Open sandboxes | how many sandboxes are open right now, for which issues, holding how many sessions, up for how long |
| Sandbox fleet size over time | the same counts as a time series |
| Sessions per issue | peak concurrent sessions and peak uptime per issue |
| Sandbox lifecycle for one issue | every transition for one issue, in order (edit the issue key first) |
| Sandbox boot outcomes | boots that failed, and boots that started but reached neither running nor failed |

### Alert rules

| Rule | Fires when | Severity |
|------|-----------|----------|
| `…-sandbox-long-running` | a sandbox has been running continuously for more than `var.sandbox_uptime_alert_hours` (default 6) | 2 |
| `…-sandbox-sweep-stalled` | no lifecycle sweep has reported in for 15 minutes | 1 |
| `…-sandbox-boot-failures` | any sandbox failed to boot | 2 |

Two things about the long-running rule are worth understanding before tuning it.

**Why six hours means something.** `idleStopMs` defaults to 5 minutes, so an
affinity-free sandbox is parked within one sweep tick of going quiet. A sandbox
only reaches six *continuous* hours by holding session affinity for essentially
that entire period. At the ACA XL tier (4 vCPU / 8 GiB) that is simultaneously a
real cost signal and a strong stuck-agent signal.

**Why it does not key on ACA state alone.** ACA reports `Running` for a sandbox
whose entrypoint has exited — `tini` keeps the container alive. An alert on
state alone would fire on zombies and stay silent on hung workers. So the rule
combines provider state with the router's heartbeat view and splits every fired
alert by a `worker` dimension:

- `live` — the worker is answering heartbeats. A genuinely long-running agent,
  or one stuck in a loop. Investigate the session.
- `stale-heartbeat` — `Running` but the worker stopped answering. Almost
  certainly a zombie burning 4 vCPU; destroy it.
- `never-connected` — reached `Running` but never dialled back at all. A boot or
  egress-policy problem, not an agent problem.

The sweep-stalled rule is what makes the other two trustworthy: every sandbox
alert derives from the 60-second sweep, so if the sweep stops emitting they all
go quietly blind and look exactly like "nothing is wrong". It keys on the
absence of `sandbox_sweep_completed`, which is emitted on every tick including
ticks with zero sandboxes, precisely so a quiet fleet stays distinguishable from
a dead router.

### Configuration

```hcl
# Where alerts land. Empty (the default) still creates the rules and still
# records fired alerts in Azure Monitor — it just emails nobody.
alert_email_receivers = ["oncall@example.com"]

# Tune the uptime threshold, or turn the rules off entirely.
sandbox_uptime_alert_hours = 6
enable_monitoring_alerts   = true
```

The saved searches are created regardless of `enable_monitoring_alerts`; they
are free and evaluate nothing until someone opens them. Setting the flag to
false removes the three scheduled-query rules (and their Azure Monitor per-rule
charge) while leaving the queries in place.

### Verifying the long-running alert

Synthetic test, no six-hour wait required — the rule reads `running_since_ms`
from the router's SQLite, so backdate it:

```bash
# 1. Note the device id of a live container.
az containerapp exec -n <router-app> -g <rg> --command \
  "cyrus router containers list --cyrus-home /data"

# 2. Backdate its uptime clock past the threshold.
az containerapp exec -n <router-app> -g <rg> --command \
  "sqlite3 /data/router/router.db \"UPDATE devices SET running_since_ms = \
   (strftime('%s','now') - 25200) * 1000 WHERE device_id = <id>\""

# 3. Wait one sweep tick (60s), then confirm the gauge reports it.
#    In Log Analytics, run the 'Open sandboxes' saved search — the row should
#    show an uptime of ~7h. The alert evaluates every 15 minutes after that.
```

Restore by letting the next idle-stop clear the clock, or set the column back to
its real value. Note the sweep reconciles this column against real provider
state each tick, so a backdated value on a sandbox that is genuinely running
persists, while one on a stopped sandbox is cleared within a tick.

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

# 4. Clear the per-user secret store guards. `azurerm_storage_table.setup` and
#    `azurerm_key_vault_key.setup_kek` carry `prevent_destroy = true`, so the
#    destroy below FAILS while they are in state. That is intentional: the KEK
#    unwraps every stored per-user secret, and losing it is unrecoverable.
#    Export and verify first (README → "Decommissioning the per-user secret
#    store"), then either delete the resource blocks together with their
#    `prevent_destroy` guards, or drop them from state and remove them by hand:
terraform -chdir=infra/azure/terraform state rm \
  azurerm_storage_table.setup azurerm_key_vault_key.setup_kek

# 5. THEN destroy the stack.
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

### Parked sessions and deploy ordering

A session blocked on a user answer holds the SDK query open, so it never sends
a terminal frame. It instead sends a non-terminal `session_state: "parked"`,
which releases its session affinity — letting the idle sweep suspend the
container — while keeping its issue lock. A session with a scheduled wakeup,
cron, or in-flight background task never parks, so suspension cannot freeze
work that nothing would later wake.

> **Deploy the router BEFORE bumping the worker image.** `parked` is an
> additive frame value and `PROTOCOL_VERSION` is deliberately unchanged, so a
> new router accepts old workers indefinitely. The reverse does not hold: an
> older router cannot parse `parked` and drops the device connection on
> receiving one. A worker image bump already forces sandbox replacement via the
> `cyrus.disk` label, so the correct order falls out of the normal rollout —
> but do not invert it.

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

RG=$(terraform -chdir=infra/azure/terraform output -raw resource_group_name)
APP=$(terraform -chdir=infra/azure/terraform output -raw router_app_name)

az containerapp revision restart -g "$RG" -n "$APP" \
  --revision "$(az containerapp show -g "$RG" -n "$APP" \
    --query properties.latestRevisionName -o tsv)"

# Verify INSIDE the replica. Run from a laptop, `cyrus router linear status`
# reads the laptop's ~/.cyrus/router-config.json, not the replica's
# /data/router-config.json — same constraint as `cyrus router secrets set`.
az containerapp exec --name "$APP" --resource-group "$RG"
# Inside the replica:
cyrus router linear status   # expect: ACCESS TOKEN = ok
```

`ACCESS TOKEN` is the only column that probes Linear. `expired (refresh
available)` means the seeded *access* token has aged out but a refresh token is
present — normal, and not a reason to re-authorize again; the router mints a new
access token on its first call. Only `rejected` with no refresh token, or a
repeat of the HTTP 400 refusal in the logs, means the credential is genuinely
dead.

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

That **same** app registration is reused for `/setup` sign-in (§11) — one app,
two audiences: the `api://<client-id>` Application ID URI in `entra_audience`
for `/enroll` **access** tokens, and the bare client-id GUID for the **ID**
token the auth sidecar forwards. Do not mint a second app, and do not set
`setup_ui_id_token_audience` to the `api://` form.

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
  setup_ui.tf     /setup: staged EasyAuth (authConfigs + token store) AND the
                  opt-in, then create-once Table/KEK/RBAC for per-user secrets — see §11
  monitoring.tf   saved KQL searches + alert rules over the router's JSON logs
  outputs.tf      paste-ready outputs (N8)
  env/dev.tfvars.example  complete variable checklist
bicep/
  README.md                     reference shape; parity-gate usage
  sandbox-group.bicep           canonical ARM shape (properties: {})
  sandbox-group-rbac.bicep     Data Owner assignment for a principal
  sandbox-group-vnet.bicep      optional vnetConnections child (deferred)
  sandbox-group.bicepparam.example
```
