# Cyrus on Azure — router hosting + ACA Sandboxes

This directory provisions the Azure footprint that runs a **Cyrus router** as a
single-replica Azure Container App and creates an **Azure Container Apps
sandbox group** that the router spins per-issue workers up inside.

> **Bicep is the deploy path**, and the only one. Everything lives under
> [`bicep/`](bicep/README.md); `scripts/deploy-azure.sh` is the entry point. The
> Terraform stack that used to live in `terraform/` has been deleted, along with
> its state storage account, its state resource group, `bootstrap-tfstate.sh`,
> `backend.dev.hcl`, and the ARM-parity gate that existed only to keep two copies
> of the sandbox-group shape in step. **The deployment is now stateless:** ARM
> holds the state and `az deployment sub what-if` reads the real resources
> instead of a recorded belief about them.
>
> The spike findings that override the original plan live in
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
  Apps, Key Vaults, and Storage in the target subscription. (`az account set
  --subscription <sub>`.) Routine deployment needs **Contributor**. The
  separate RBAC bootstrap also needs `Microsoft.Authorization/roleAssignments/write`
  for the roles and scopes in `modules/role-assignments.bicep` (for example
  Owner, or an appropriately constrained Role Based Access Control
  Administrator).
- **Bicep.** `az bicep install` (the CLI installs it to `~/.azure/bin`), or the
  standalone CLI. Verify with `bicep --version`.
- **`jq`**, used by `scripts/deploy-azure.sh` for the stage-2 gate.
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
- **A pre-registered worker disk image.** The template owns the sandbox group but
  not its data-plane disk images. Registration is step 6 below.
- **Private images -> enable ACR.** The staged flow below creates ACR before the
  router app so the current source can be built and pushed without a bootstrap
  image. Public registries can skip the ACR-specific steps.
- **S6 RBAC propagation note.** The first sandbox data-plane call after a
  fresh role assignment may 403 for up to ~100 s (spike measured < 1 min, but
  the client retries). `aca sandboxgroup create` auto-assigns the
  *Container Apps SandboxGroup Data Owner* role to the caller unless
  `--skip-role-check` is passed — so if you create the group via the CLI
  instead of via this template you may already have it.
- **Key Vault is RBAC-only** (`enableRbacAuthorization: true`). The stack uses
  fixed, versionless references to the Linear app/workspace secrets. Their
  values are written only during an explicitly enabled bootstrap or rotation.

### Key Vault permissions: what changed

Under Terraform, seeding a secret was a **data-plane** write, so the deploying
principal needed **Key Vault Secrets Officer**, and creating the `/setup` KEK
needed **Key Vault Crypto Officer**. Neither is required for the Bicep path:
when deliberately enabled, Bicep declares
`Microsoft.KeyVault/vaults/secrets` and `Microsoft.KeyVault/vaults/keys` as ARM
child resources, which are **management-plane** writes covered by Contributor
(or Key Vault Contributor) on the vault. A routine deployment omits the secret
children entirely and cannot overwrite an operator rotation. You still need
Secrets Officer to rotate a secret directly with `az keyvault secret set`.

Every secret parameter is marked `@secure()`. That is not cosmetic: a secure
parameter's value is not persisted into ARM deployment history, which is the one
way an ARM-declared Key Vault secret could otherwise leak to anyone with
management-plane read on the resource group.

Fresh Key Vault **role assignments** can still take several minutes to
propagate. Bootstrap them before the first routine deployment, as described
below. If the first deployment reports that a Key Vault secret reference cannot
be resolved, wait and re-run `./scripts/deploy-azure.sh --apply`; the deployment
is idempotent and will converge.

## End-to-end deployment

The sequence below covers a fresh private-ACR deployment through its first ACA
user. A bootstrap parameter file temporarily contains OAuth values; keep it and
all user credentials out of the public repository. `.gitignore` covers
`*.bicepparam` and un-ignores only `*.bicepparam.example`. Private CD should use
a secretless environment parameter file and pass it with `--params`.

> **There is no state to bootstrap.** ARM incremental deployments also *adopt*
> resources that already exist with a matching name and type, so there is no
> import step either: if you create a resource group or a registry by hand, the
> template converges onto it rather than colliding with it. That is what makes
> step 3 below two `az` commands instead of a targeted apply.

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
slug, for `linearWorkspaceId` and every repository's `linearWorkspaceId`. List
workspace UUIDs without printing tokens:

```bash
jq -r '.linearWorkspaces | to_entries[] | [.key, .value.linearWorkspaceSlug] | @tsv' \
  ~/.cyrus/config.json
```

### 2. Prepare the parameter file

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"
cp infra/azure/bicep/main.bicepparam.example infra/azure/bicep/main.bicepparam
chmod 600 infra/azure/bicep/main.bicepparam
```

Fill the non-secret environment placeholders. For a private registry set
`enableAcr = true` and point
`routerImage`/`workerImage` at the ACR login server that the naming convention
will create. Both image refs must be immutable — the template rejects `:latest`,
`:deploy`, and other floating tags; see
[Router image tag policy](#router-image-tag-policy). You fill in the real refs in
step 4, once there is a build to pin; the example's placeholders are deliberately
shape-valid so the earlier steps pass validation. Set:

- `linearWorkspaceId` to the organization UUID from step 1.
- Each `cyrusRepositories[*].linearWorkspaceId` to the same UUID.
- `operatorPrincipalId` to `az ad signed-in-user show --query id -o tsv` for
  backup break-glass access.

For the first bootstrap only, also set `writeLinearSecrets = true` and supply
`linearWorkspaceToken`, `linearWorkspaceRefreshToken`, `linearClientId`,
`linearClientSecret`, and `linearWebhookSecret`. The deploy script additionally
requires `--allow-secret-writes`; this two-key guard prevents a routine CD run
from restoring stale parameter values over a direct Key Vault rotation.

If this environment was already deployed with the earlier PR 29 Bicep shape,
the secrets already exist. Do **not** bootstrap them again: add both write flags
as `false` and clear the five Linear plus three setup-auth value fields before
the next deployment. Incremental mode retains the existing Key Vault versions.

Leave `routerUrlForContainers` empty. Unlike the Terraform stack, the router's
WSS URL is derived from the Container Apps environment's `defaultDomain` — a
separate resource from the app — so there is no dependency cycle and no second
apply. Set it only to point containers at a custom domain or a proxy.

Use an exact resource group by setting `resourceGroupName`; empty defaults to
`rg-<project>-<environment>`.

Set `manageRoleAssignments = true` for a fresh all-in-one operator deployment.
For routine CD, bootstrap the grants separately as described next and set it to
`false`; the deployment identity then needs Contributor only. An Incremental
deployment that omits the RBAC module retains every existing assignment.

`project` and `environment` are capped at 10 and 9 characters. The binding
constraint is the Key Vault name `kv-<project>-<environment>` and Key Vault's
24-character limit; the caps make an over-long pair fail at validation rather
than at create time.

Validate before you deploy anything:

```bash
./scripts/check-bicep.sh
```

### 2a. Bootstrap runtime RBAC

Use an operator identity allowed to create the runtime roles, preview the exact
assignments, then apply them:

```bash
./scripts/bootstrap-azure-role-assignments.sh \
  --params infra/azure/bicep/main.bicepparam
./scripts/bootstrap-azure-role-assignments.sh \
  --params infra/azure/bicep/main.bicepparam --apply
```

The script reads no Linear or `/setup` secret values. Its template and the
optional module in `main.bicep` both call the same role-assignment module, with
the same deterministic resource names and scopes.

If the environment is the existing `rg-cyrus` deployment that already received
the pre-split Bicep template, the assignments are already present. Run the two
commands above once as a reconciliation check; Azure should retain the same
assignment resources rather than replace them. Then set
`manageRoleAssignments = false` in the private environment file. There is no
resource migration and no need to grant the private CD identity an RBAC-admin
role.

### 3. Bootstrap the registry (private images only)

The router image cannot be pushed until a registry exists. Create the resource
group and the registry with the names the template will use, then let the full
deployment adopt them:

```bash
PROJECT=cyrus ENVIRONMENT=dev LOCATION=<region>
RG="rg-${PROJECT}-${ENVIRONMENT}"
ACR="acr${PROJECT}${ENVIRONMENT}"

az group create --name "$RG" --location "$LOCATION" -o none
az acr create --name "$ACR" --resource-group "$RG" --sku Basic \
  --admin-enabled false -o none
```

Grant yourself push rights for the build in step 4. The template separately
grants the runtime identities their permanent roles:

```bash
DEPLOYER_ID=$(az ad signed-in-user show --query id -o tsv)
ACR_ID=$(az acr show --name "$ACR" --query id -o tsv)

az role assignment create --assignee-object-id "$DEPLOYER_ID" \
  --assignee-principal-type User --role AcrPush --scope "$ACR_ID"
```

Allow several minutes for fresh RBAC assignments to propagate.

For a **public** registry, skip this step entirely and go straight to step 5.

### 4. Build and push immutable images

Derive the tag from the commit you are deploying so the tag names exactly one
build. Never push `:latest`, `:deploy`, a branch name, or an ad-hoc hotfix tag
into a durable environment — the template rejects those refs (see
[Router image tag policy](#router-image-tag-policy)).

For the **router** image, `scripts/deploy-router-image.sh` does all of this —
build, digest resolution, repinning `routerImage`, and a what-if preview — in one
step, and refuses to build from a dirty tree so the tag cannot misname the
commit. Prefer it over the manual sequence below:

```bash
./scripts/deploy-router-image.sh          # then review the what-if and deploy
```

The manual steps below remain the reference for the **worker** image, which the
script does not handle: the worker is registered out of band as an ACA disk
(`aca sandboxgroup disk create`) and `acaDiskName` must move with it.

Build with **`az acr build`**, not local `docker buildx --push`:

```bash
cd "$REPO_ROOT"
# Same shape as the `sha-<short-sha>` tag docker-router.yml publishes to GHCR.
TAG="sha-$(git rev-parse --short=7 HEAD)"   # or a release tag: TAG=v1.2.3

az acr build --registry "$ACR" --image cyrus-worker:$TAG \
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
> az acr manifest show "$ACR.azurecr.io/cyrus-worker:$TAG" \
>   --query mediaType -o tsv
> ```
>
> If you must use buildx, disable the attestations
> (`--provenance=false --sbom=false`) and confirm the media type before
> registering the disk.

Set `workerImage` in `main.bicepparam` to that exact ref. For the strongest pin,
use the digest the build printed instead of the tag:

```bash
az acr manifest show-metadata "$ACR.azurecr.io/cyrus-worker:$TAG" \
  --query digest -o tsv
# → param workerImage = '<acr>.azurecr.io/cyrus-worker@sha256:<64 hex>'
```

Confirm the build actually contains the commit you intend to deploy before you
pin it — a tag is only as trustworthy as the commit it was cut from.

### 5. Deploy the stack

```bash
# Bootstrap only: the parameter file has writeLinearSecrets=true and all five
# values. Routine deployments omit --allow-secret-writes.
./scripts/deploy-azure.sh --allow-secret-writes            # what-if: read it
./scripts/deploy-azure.sh --allow-secret-writes --apply
```

The script checks the image pins at full fidelity and the `/setup` staging gate
before it calls `az`. It also refuses either secret-write parameter unless the
independent `--allow-secret-writes` switch is present. It prints the deployment
outputs when it finishes. Read them straight back at any time with:

```bash
az deployment sub show --name cyrus-cyrus-dev --query 'properties.outputs' -o json
```

Immediately after a successful bootstrap, set `writeLinearSecrets = false` and
clear all five secret values. Every later deployment is then secretless:

```bash
./scripts/deploy-azure.sh
./scripts/deploy-azure.sh --apply
```

The omitted Key Vault child resources remain in place under Incremental mode,
and the router keeps reading their latest versions through versionless URIs.

For the private deployment repository, check out a reviewed public Cyrus commit
and invoke this same entry point; do not copy the Bicep modules into the private
repository. Keep its secretless environment parameters separately and override
the newly published immutable router image at invocation time:

```bash
./scripts/deploy-azure.sh \
  --params /private/deploy/environments/dev.bicepparam \
  --router-image "$PINNED_ROUTER_IMAGE" \
  --apply
```

The private workflow owns Azure OIDC, approval/environment policy, and the
choice of public commit and image digest. The public repository owns the Bicep
implementation, validation, and deployment contract. A separate manual
bootstrap/rotation operation may use `--allow-secret-writes`; the routine CD job
must not receive those secret values. Its Azure identity also needs Contributor
only: runtime role assignments are reconciled through the separate bootstrap
entry point above, while the private parameter file keeps
`manageRoleAssignments = false`.

If Container Apps cannot resolve a new Key Vault reference, wait for RBAC
propagation and deploy again. The router can start before the worker disk is
registered, but do not delegate an issue until step 6 is complete.

> **Never pass `--mode Complete`.** `deploy-azure.sh` does not offer it, and it
> is the one thing that would delete the per-user secret store's Table and KEK —
> the key that unwraps every stored per-user secret. Incremental mode (the
> default, and the only mode for a subscription-scope deployment) never deletes a
> resource merely because the template stopped mentioning it.

### 6. Configure ACA and register the worker disk

```bash
SUBSCRIPTION_ID=$(az account show --query id -o tsv)
OUT=$(az deployment sub show --name cyrus-cyrus-dev --query 'properties.outputs' -o json)
RESOURCE_GROUP=$(echo "$OUT" | jq -r .resourceGroupName.value)
SANDBOX_GROUP=$(echo "$OUT" | jq -r .sandboxGroupName.value)
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
group's managed identity, which the template grants AcrPull:

```bash
ACR_TOKEN=$(az acr login --name "$ACR" --expose-token \
  --query accessToken -o tsv)
aca sandboxgroup disk create \
  --image "$ACR.azurecr.io/cyrus-worker:<immutable-tag>" \
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

### 7. Set the Linear webhook

The router's stable ingress FQDN is a deployment output. Read it, not a
revision-specific FQDN:

```bash
az deployment sub show --name cyrus-cyrus-dev \
  --query 'properties.outputs.routerFqdn.value' -o tsv
az deployment sub show --name cyrus-cyrus-dev \
  --query 'properties.outputs.routerWssUrl.value' -o tsv
```

There is **no second deployment** for this. The WSS URL is already embedded in
`CYRUS_ROUTER_CONTAINERS_JSON` — see
[the two-apply flow is gone](#the-routerurlforcontainers-two-apply-flow-is-gone).

In the Linear app, set the webhook URL to:

```text
https://<routerFqdn>/linear-webhook
```

Keep the signing secret identical to `linearWebhookSecret`. `/webhook` is a
deprecated compatibility alias; use `/linear-webhook` for new deployments.

Verify the router:

```bash
FQDN=$(az deployment sub show --name cyrus-cyrus-dev \
  --query 'properties.outputs.routerFqdn.value' -o tsv)
curl -fsS "https://$FQDN/healthz"
az containerapp logs show --name <router-app> --resource-group "$RESOURCE_GROUP" \
  --type console --tail 100
```

### 8. Optional Entra-gated device enrollment

ACA executor users do not enroll a physical device, so Entra is not required for
their worker. To protect future `cyrus connect` enrollment, create one single-
tenant app registration per router, expose a delegated `user_impersonation`
scope, pre-authorize Microsoft Azure CLI (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`),
and set the exact Application ID URI as `entraAudience`. Set `entraTenantId` and
optionally `entraAllowedDomain`, then verify:

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
`LINEAR_API_TOKEN` is a personal key used by the hosted Linear MCP, separate from
the router app's workspace OAuth token. ACA users do not redeem the printed
enrollment code and do not run `cyrus connect`; their per-issue sandbox is their
device.

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
turning it on is a **two-deployment sequence with a live verification gate in the
middle**. Read this whole section before starting; the ordering is the security
property, not a suggestion.

#### Why two deployments

`authConfigs` — the ACA built-in auth ("EasyAuth") sidecar — is an ARM **child**
of the Container App. ARM must create the app, and therefore publish the revision
that serves `/setup`, *before* it can attach the sidecar. A single
`enableSetupUi` flag would guarantee a window in which an unauthenticated
`/setup` is reachable on the public internet, and no post-deploy check can close
a window that opens mid-deployment.

So the flags are split, and the deploy script refuses to let you collapse them:

| Parameter | Deployment | Effect |
| --- | --- | --- |
| `enableSetupAuth` | **first, alone** | Token store infrastructure and `authConfigs`. A bootstrap also writes its two secrets with `writeSetupAuthSecrets`. `/setup` still 404s. |
| — | **verification gate** | Steps 5a–5c below. Recorded in `setupAuthStage1Verified`. **Ordering is enforced against Azure, not by that flag** — see below. |
| `enableSetupUi` | **second, separate deployment** | Sets `CYRUS_ROUTER_SETUP_UI_*`, which is what registers the routes. |

`enableSetupUi = true` fails `main.bicep`'s cross-parameter validation unless
both `enableSetupAuth` and `setupAuthStage1Verified` are already true — and, more
importantly, `scripts/deploy-azure.sh` reads the **already-deployed**
`authConfigs` child out of Azure with `az containerapp auth show` and refuses to
proceed unless it exists *and* reports `platform.enabled` and
`identityProviders.azureActiveDirectory.enabled`.

The booleans are a fast, readable first line of defence; the live read is the
actual control. A boolean an operator supplies in the same edit can only ever
attest to intent — it cannot establish that a prior deployment happened.

> **This is where the enforcement moved.** Terraform proved the ordering at plan
> time, with a data source ARM answered before any resource was touched. Bicep
> has no plan phase and no equivalent read, so the check now lives in the deploy
> script. Same class of evidence — a question answered by ARM about real remote
> state — with one new weakness: running `az deployment sub create` by hand
> bypasses it. Use the script.

**Rollback reverses the order**: clear `enableSetupUi`, deploy, confirm `/setup`
returns 404, and only then clear `enableSetupAuth`.

#### Prerequisites

- The storage account must allow shared-key access, because the token-store SAS
  is generated with `listServiceSas`, which is keyed on the account key. The
  template keeps `allowSharedKeyAccess: true` for this reason and for the Azure
  Files mount.

- Entra tenant admin (or Application Administrator) to edit the app
  registration in step 2.

- **No special Key Vault data-plane role.** Terraform needed Key Vault Crypto
  Officer to create the KEK; the ARM `vaults/keys` child resource is a
  management-plane write covered by Contributor.

#### Step 1 — read the values the deployment already knows

```bash
OUT=$(az deployment sub show --name cyrus-cyrus-dev --query 'properties.outputs' -o json)
FQDN=$(echo "$OUT" | jq -r .routerFqdn.value)
REDIRECT=$(echo "$OUT" | jq -r .setupUiRedirectUri.value)
RG=$(echo "$OUT" | jq -r .resourceGroupName.value)
APP=$(echo "$OUT" | jq -r .routerAppName.value)
```

`setupUiRedirectUri` is emitted unconditionally, precisely so it is available
*before* stage 1 — you cannot configure Entra from a value that only exists once
the thing you are configuring is already live.

#### Step 2 — extend the EXISTING router app registration

Do not mint a second app. "One app registration/audience per router deployment"
is a standing invariant, and `entraAudience` (the `api://<client-id>`
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

Record the client id and, temporarily, the generated secret and SAS window in
your gitignored bootstrap parameter file:

```bicep
param setupUiClientId = '<APP_ID>'
param writeSetupAuthSecrets = true
param setupUiClientSecret = '<the password printed above>'

// Static SAS window for the ACA token store. Must NOT be derived from
// utcNow(): that re-evaluates every deployment and would roll a new router
// revision each time. Diarise the expiry — see "Rotating the setup UI secrets".
param setupUiTokenStoreSasStart = '2026-01-01T00:00:00Z'
param setupUiTokenStoreSasExpiry = '2027-01-01T00:00:00Z'
```

#### Step 3 — restrict who can sign in (HARD PREREQUISITE for auto-provisioning)

By default **any** account in the tenant can obtain a token for the app.
`setupUiAllowedDomain` does not change that — a domain check cannot tell an
assigned teammate from any other account in the same tenant. So if
`setupUiAutoProvisionUsers` is left at its default of `false`, an unknown signer
is refused and you can skip to step 4. If you want first sign-in to create the
user, you must restrict membership first, and the template enforces it:
`setupUiAutoProvisionUsers = true` fails validation unless one of the two options
below is in place.

> The Terraform variable defaulted to `true` while its own README documented
> `false` and claimed an enforcement that was never written. The Bicep parameter
> implements the documented, stricter contract: default `false`, and the
> membership gate is genuinely required.

**Option A — `authConfigs` allowed principals (no Entra premium licence).**
The template renders these into
`identityProviders.azureActiveDirectory.validation.defaultAuthorizationPolicy.allowedPrincipals`:

```bicep
param setupUiAllowedGroupObjectIds = ['00000000-0000-0000-0000-000000000000']
// or, less maintainably, one entry per person:
param setupUiAllowedPrincipalObjectIds = []
param setupUiAutoProvisionUsers = true
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

```bicep
param setupUiAssignmentRequiredVerified = true
param setupUiAutoProvisionUsers = true
```

> **Licensing:** assigning a *group* to an app role requires Entra ID P1/P2.
> Without it, assign users individually or use Option A, which has no licence
> requirement.

#### Step 4 — STAGE 1 DEPLOYMENT: auth only

```bicep
param enableSetupAuth = true
param writeSetupAuthSecrets = true
// enableSetupUi stays FALSE. Do not set it in this edit.
```

```bash
./scripts/deploy-azure.sh --allow-secret-writes            # read the what-if
./scripts/deploy-azure.sh --allow-secret-writes --apply
```

Expected change list: one Key Vault secret for the client secret, one blob
container + one Key Vault secret for the token-store SAS, two new `secrets`
entries on the Container App (so a new revision), and the `authConfigs` child. No
`/setup` route is created.

Immediately set `writeSetupAuthSecrets = false` and clear
`setupUiClientSecret`, `setupUiTokenStoreSasStart`, and
`setupUiTokenStoreSasExpiry`. Leave `enableSetupAuth = true`. The stage-2 and
all routine deployments now need no setup secret values and cannot overwrite a
direct rotation.

#### Step 5 — THE GATE

**This is an acceptance criterion, not a formality.** `authConfigs` changes
ingress behaviour for *every* path on the app. Steps 5a and 5c are the required
behavioural checks recorded in `setupAuthStage1Verified`; 5b is retained as a
defence-in-depth probe rather than the trust basis of a selectable mode, since the
template no longer offers `easyauth-headers`. Do not proceed to stage 2 until all
three pass. Paste the output into the change record.

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

`setupUiAuthMode` accepts only `entra-token`, because the header mode's trust
boundary is proxy topology the configuration cannot verify. A 200 here is still
STOP-AND-ESCALATE: it means the ingress is injecting or passing identity you did
not expect. `entra-token` verifies the forwarded ID token cryptographically and
ignores `X-MS-CLIENT-PRINCIPAL-*` entirely — its trust boundary is a signature,
not proxy topology.

**5c — sign-in works.** Stage 1 is what makes this provable before any route
exists:

```bash
open "$(az deployment sub show --name cyrus-cyrus-dev \
  --query 'properties.outputs.setupUiSignInUrl.value' -o tsv)"
```

You should complete an Entra sign-in and land back on the app. If step 3 Option
B is in place, confirm an **unassigned** tenant account is refused here.

Record the result:

```bicep
param setupAuthStage1Verified = true
```

#### Step 6 — STAGE 2 DEPLOYMENT: enable the routes

```bicep
param enableSetupUi = true
param setupUiAuthMode = 'entra-token'   // the only accepted value
param setupUiAllowedDomain = 'example.com'   // optional defence in depth
```

```bash
./scripts/deploy-azure.sh            # the stage-2 gate runs here
./scripts/deploy-azure.sh --apply
az deployment sub show --name cyrus-cyrus-dev \
  --query 'properties.outputs.setupUiUrl.value' -o tsv
```

Expected change list: `CYRUS_ROUTER_SETUP_UI_*` env vars on the container, and the
resulting revision. Then re-run **5b** — it must now return `401`, not `200` —
and sign in to `setupUiUrl` as a real teammate.

#### Rolling back

1. `enableSetupUi = false`; deploy. Confirm `curl -o /dev/null -w '%{http_code}'
   "https://$FQDN/setup"` returns `404`.
2. Only then `enableSetupAuth = false`; deploy. This removes the `authConfigs`
   child and the two Container App secret entries. The token-store blob container
   is left in place — incremental deployments do not delete it — which is
   harmless: it holds only cached OAuth sessions. Delete it by hand if you want
   everyone signed out.
3. Leave `setupAuthStage1Verified` as it is; it records history, not intent.

Never do these in one deployment, and never step 2 before step 1 — that is the
unauthenticated-`/setup` window again, in reverse.

### Key Vault → Table migration for per-user secrets

The Azure Table (`cyrussetup`), the envelope-encryption KEK, and the router's
*Storage Table Data Contributor* + *Key Vault Crypto User* role assignments are
created by `enableSetupSecretStore`. Cutting the router **over** to them is a
separate, ordered operation:

1. Set `enableSetupSecretStore = true` and deploy. The Table and KEK now exist;
   the router still reads Key Vault, because `enableSetupTableBackend` is
   `false`.
2. `az containerapp exec` into the replica and dry-run the copy. The target is
   named explicitly, because `containers.tableStore` is deliberately NOT in the
   config yet — adding it is what makes the router start *reading* from the
   Table, which must come after the data is verified in place. Take the two
   values from the deployment outputs:
   ```bash
   OUT=$(az deployment sub show --name cyrus-cyrus-dev --query 'properties.outputs' -o json)
   cyrus router secrets migrate --from keyvault --to table --dry-run \
     --to-endpoint "$(echo "$OUT" | jq -r .setupTableEndpoint.value)" \
     --to-key-id  "$(echo "$OUT" | jq -r .setupKekVersionedKeyId.value)"
   ```
   Eyeball the `email  KEY  (n bytes)` list. Values are never printed.
3. Re-run without `--dry-run`, same flags.
4. Set `enableSetupTableBackend = true` and deploy. This adds
   `containers.tableStore` to `CYRUS_ROUTER_CONTAINERS_JSON` and rolls one
   revision.
5. `cyrus router secrets list <email>` for two users — the key sets must match
   what step 2 reported.
6. Delegate a test issue and confirm the worker boots with its environment.
7. **Leave the Key Vault secrets in place for at least a week.** They are the
   rollback path. Deleting them is a separate change.

**Rollback is only safe until the first write through the UI.** Flipping
`enableSetupTableBackend = false` drops the router back to the Key Vault backend,
and nothing is destroyed — but migration is one-way, so every value a user has
added, changed, or rotated through `/setup` since cutover exists only in the
Table. Rolling back after that point silently restores the migration-time
snapshot, which can reinstate a credential the user believed they had replaced or
revoked.

Treat the Key Vault copy as a rollback path for the cutover window only. Once
users are editing through the UI, a return to Key Vault requires an explicit
reverse export that does not exist yet — do not assume it is a flag flip.

### Rotating the setup UI secrets

- **Entra client secret.** Rotate in Entra first
  (`az ad app credential reset --id "$APP_ID" --display-name cyrus-router-easyauth`),
  then `az keyvault secret set --vault-name <vault> --name setup-ui-client-secret
  --value <new>`. The Container App references it by *versionless* URI, so the
  sidecar picks it up on the next revision. Leave `writeSetupAuthSecrets = false`;
  routine deployments omit the secret resource and cannot overwrite the new
  version.
- **Token-store SAS.** `setupUiTokenStoreSasExpiry` is a **live failure
  deadline**: past it, the sidecar can no longer persist sessions and sign-in
  breaks. Renew the two setup-auth credentials as a coordinated pair: create a
  new Entra client secret first, temporarily set `writeSetupAuthSecrets = true`,
  supply that new client secret plus a new SAS start and expiry, deploy with
  `--allow-secret-writes`, then restore the flag to `false` and clear all three
  values.
  `Microsoft.App/containerApps/authConfigs@2024-03-01` models the token store as
  `sasUrlSettingName` only — there is no managed-identity token store on any
  shipped Microsoft.App auth API version — so a SAS is the only available shape,
  not a shortcut. The template generates it with `listServiceSas`, which is
  deterministic for a fixed window and account key, so the secret does not churn
  between deployments.
- **KEK.** Rotating the key does **not** re-wrap existing rows. Each record
  pins the key *version* it was wrapped with, so old versions must stay
  **enabled** until a re-wrap pass has run.

### Decommissioning the per-user secret store

Clearing `enableSetupSecretStore` does **not** delete the Table or the KEK.
Incremental ARM deployments do not delete a resource that leaves the template, so
the flag simply stops managing them: the data stays readable, and setting the
flag again re-adopts them. This is a straight improvement over the Terraform
stack, where the same safety needed `prevent_destroy`, a deliberately asymmetric
flag whose "off" position failed the plan, and a `terraform state rm` step in this
runbook. All three are gone.

Destroying the KEK makes every wrapped record permanently unreadable — the
wrapped DEKs are useless without it — so removal stays a deliberate, manual act:

1. Export every record and verify the export opens (`cyrus router secrets list`
   per user against the Table backend, plus a read-back of at least two users'
   full key sets).
2. `enableSetupTableBackend = false`; deploy. The router is now off the Table.
3. Confirm workers still boot for a migrated user.
4. Retire KEK versions in Key Vault only after step 3 has held for a full
   retention window.
5. Only then remove the resources by hand:
   ```bash
   az keyvault key delete --vault-name <vault> --name cyrus-setup-kek
   az storage entity query --table-name cyrussetup --auth-mode login \
     --account-name <account>          # confirm what you are about to lose
   az storage table delete --name cyrussetup --auth-mode login \
     --account-name <account>
   ```
6. Set `enableSetupSecretStore = false` so the template stops trying to recreate
   them.

The same applies to whole-stack teardown — see [Teardown](#teardown).

### The `routerUrlForContainers` two-apply flow is gone

Terraform needed two applies here: the stable ingress FQDN was only knowable from
`azurerm_container_app.router` itself, and embedding it into that same resource's
environment created a dependency cycle. The first apply used a placeholder and
step 7 copied the real value into tfvars for a second apply.

Bicep derives the FQDN as `<app-name>.<managedEnvironment.defaultDomain>`. The
Container Apps **environment** is a separate resource from the app, so reading
`defaultDomain` from it is not self-referential, and the router's own environment
gets the correct WSS URL on the very first deployment. `routerUrlForContainers`
remains as an override for a custom domain or a proxy in front of the app.

The `cyrusRouterContainersJson` output is non-sensitive and contains the
complete, merge-ready config (image, router WSS URL, repositories, `aca`
block with subscriptionId/resourceGroup/sandboxGroup/region/disk/cpu/memory/
autoSuspendSeconds/egress/keepSnapshots/disconnectedRecreateMs/managementEndpoint,
`keyVaultUrl`, `artifactsDir`, `backupBlobUrl`). It does not contain secret
values; per-user secrets live in Key Vault and are injected per-sandbox on create
(D1/D5).

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
  risk; default `acaKeepSnapshots = 2` and run `gc-snapshots` (Task 7). Re-check
  the pricing page at GA.

### `maxSandboxCount` does NOT exist as a cost guard

Spike finding: the ARM `Microsoft.App/sandboxGroups` resource accepts
`properties: {}` ONLY — there is no `maxSandboxCount` (or `defaultCpu`/
`defaultMemory`/`defaultDisk`) on the group resource. **You cannot cap the
number of sandboxes via the group's ARM properties.** Cost control is the
router's job:

- Keep `idleStopMs` and `staleDestroyMs` (router config) healthy — these are
  the actual idle and abandon controllers. `idleStopMs` defaults to 5 minutes
  and is set explicitly by the template (the `idleStopMs` parameter). It counts
  from the later of the last routed event and the moment a session *parked*.
- Set up `gc-snapshots` (Task 7) on a schedule.
- Rate-limit issue assignment (Linear automation) if you want a hard ceiling
  on concurrent workers — the platform will not enforce one.

## Monitoring and alerts

`bicep/modules/monitoring.bicep` provisions saved KQL searches and alert rules
over the router's JSON log stream. No agent, no exporter, no OpenTelemetry
dependency — the Container Apps environment already ships the router's stdout to
the Log Analytics workspace created in `bicep/modules/foundation.bicep`, and the
router already writes one flat JSON object per line (`CYRUS_LOG_FORMAT=json`, set
in `bicep/modules/router-app.bicep`).

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

### OpenTelemetry log export (`enableOtelLogs`, default on)

Everything above reads `ContainerAppConsoleLogs_CL` and needs no exporter. On top
of it, `enableOtelLogs` also backs the router's `ILogger` with the OpenTelemetry
Logs API, so each of its existing log calls additionally leaves the process as a
structured OTLP record. Set `CYRUS_OTEL_LOGS_ENABLED=false` — or the Bicep
parameter to `false` — to turn it off completely; the console path is unchanged
either way.

`Microsoft.Insights/components` in `bicep/modules/monitoring.bicep` is the OTLP
endpoint and nothing more. It is **workspace-based**, pointed at the same Log Analytics workspace
the environment already ships stdout to, so there is no second data store, no
separate retention setting, and no new billing surface beyond the ingested
volume. Classic (non-workspace) mode would keep its own store, out of reach of
every query above — hence the explicit `WorkspaceResourceId`.

**The one thing to know: OTLP records land in `AppTraces`, not
`ContainerAppConsoleLogs_CL`.** Every saved search and alert rule in this file
reads the console table and is therefore blind to them; enabling this changes
nothing about their behaviour. The deployment's `otelLogsQuery` output is
paste-ready KQL. `service.name` arrives as `AppRoleName`,
`service.instance.id` as `AppRoleInstance`, and the rest of the resource semconv
(`cloud.*`, `deployment.environment.name`) as keys inside `Properties`.

Volume is governed by `otelLogsLevel` (default `INFO`), which is
independent of what the container prints locally. Same PerGB2018 economics as the
worker forwarder above: `INFO` carries the `sandbox_*` event family and every
warning and error, while debug volume stays on stdout only. Named `event()`
records ride past the threshold by contract, so raising the level never loses the
lifecycle vocabulary the alerts depend on.

The instrumentation itself is vendor-neutral — `cyrus-otel-logs` takes its
exporter as an argument and `cyrus-core` has no Azure dependency. Only the
router's bootstrap knows this is Azure. See
[`docs/ROUTER.md`](../../docs/ROUTER.md) → "OpenTelemetry log export".

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
| `…-sandbox-long-running` | a sandbox has been running continuously for more than `sandboxUptimeAlertHours` (default 6) | 2 |
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

```bicep
// Where alerts land. Empty (the default) still creates the rules and still
// records fired alerts in Azure Monitor — it just emails nobody.
param alertEmailReceivers = ['oncall@example.com']

// Tune the uptime threshold, or turn the rules off entirely.
param sandboxUptimeAlertHours = 6
param enableMonitoringAlerts = true
```

The saved searches are created regardless of `enableMonitoringAlerts`; they
are free and evaluate nothing until someone opens them. Setting the flag to
false stops managing the three scheduled-query rules — but note that, unlike
`terraform destroy`, an incremental deployment does not delete them. Remove them
with `az monitor scheduled-query delete` if you want the per-rule Azure Monitor
charge to stop.

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

## Teardown

The template tracks the **ARM group** but NOT its **data-plane children**
(sandboxes, snapshots, disk images). **Azure never GCs snapshots** (spike S3b
confirmed: a snapshot whose source sandbox was deleted stayed listed and still
pointed at the dead `sandboxId`). Deleting a non-empty group can strand billed
snapshots with no Cyrus-side way to enumerate them once the router is gone.

Before deleting the resource group:

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

# 4. EXPORT AND VERIFY the per-user secret store first, if it was ever enabled.
#    Deleting the resource group destroys the KEK, and every wrapped per-user
#    record becomes permanently unreadable. See "Decommissioning the per-user
#    secret store" — that runbook is the only safe order.

# 5. THEN delete the group.
az group delete --name <rg> --yes
```

There is no state file to clean up afterwards, and no state resource group to
remember to delete separately.

(If the router itself is already gone and `cyrus router containers list`
fails, fall back to the `aca` CLI directly: `aca sandbox list --labels
cyrus.managed=true` then `aca sandbox delete --id <id>` per row — spike S2
confirmed server-side label filtering works with `cyrus.managed=true`.)

## Ops runbook

### Router image tag policy

`routerImage` and `workerImage` must be pinned to an **immutable** reference:

| Form | Example | Use |
| --- | --- | --- |
| Digest | `…/cyrus-router@sha256:<64 hex>` | Strongest pin. Preferred. |
| Release tag | `…/cyrus-router:v1.2.3` | Published by `docker-router.yml` on `v*` tags. |
| Git-SHA tag | `…/cyrus-router:sha-a1b2c3d` | Published by `docker-router.yml` on every push to `main`. |

Anything else is **rejected** (`:latest`, `:deploy`, a branch name, an ad-hoc
hotfix tag, or an untagged ref). The escape hatch `allowMutableImageTags = true`
exists for throwaway stacks only and must stay `false` in a durable environment.

Enforcement is split between the template and the deploy script, which is worth
knowing when you read a rejection message:

- `main.bicep` checks the ref **shape** and fails template evaluation. ARM has no
  regex engine, so this cannot check character classes.
- `scripts/deploy-azure.sh` applies the full regex — 64 **hex** for a digest,
  7–40 **hex** after `sha-`, decimal components for a semver tag. This is the
  layer a raw `az deployment` invocation skips.

One narrowing versus the Terraform regex: a **bare hex tag** (`repo:a1b2c3d`,
with no `sha-` prefix) is no longer accepted. `docker-router.yml` only ever
publishes `sha-<sha>` and `v<semver>`, so nothing in practice regresses.

Why any of this matters: a mutable tag does not identify a build. ARM compares
the container spec it is given against the spec on the resource, so an unchanged
tag string is an unchanged deployment — while the registry quietly re-points that
tag at different bits. The next unrelated deployment then pulls whatever the tag
means at that moment, which can roll the router **backwards** onto an older
image, silently reverting a fix, with nothing in the change list to warn you.

#### Reconciling a hand-patched (emergency) router image

This is the situation to look for: someone hotfixed the live Container App with
`az containerapp update --image …:deploy-aca-disk-fix` while the parameter file
still said `:deploy`. The running revision and the declared input now disagree,
and the next deployment reverts the hotfix. Reconcile **before** the next
deployment:

1. Diff what is actually running against what the template declares. If these
   two differ, a deployment right now would change the running image:

   ```bash
   OUT=$(az deployment sub show --name cyrus-cyrus-dev --query 'properties.outputs' -o json)
   RG=$(echo "$OUT" | jq -r .resourceGroupName.value)
   APP=$(echo "$OUT" | jq -r .routerAppName.value)

   echo "live:     $(az containerapp show -g "$RG" -n "$APP" \
     --query 'properties.template.containers[0].image' -o tsv)"
   echo "declared: $(echo "$OUT" | jq -r .routerImageRef.value)"
   ```

   `./scripts/deploy-azure.sh` (what-if, no `--apply`) shows the same thing as a
   change list, which is the better check when more than the image has drifted.

2. Identify the commit that image was built from. If it is not obvious, inspect
   the image's revision/source labels, or rebuild from the commit you know
   carries the fix (here: the private-disk fix) and diff behaviour.

3. Build and push an **immutable** tag from that commit — step 4 above. Do not
   reuse the hotfix tag; cut `sha-<short-sha>` (or a release tag) from the exact
   commit.

4. Pin it in `main.bicepparam`:

   ```bicep
   param routerImage = '<acr>.azurecr.io/cyrus-router:sha-<short-sha>'
   ```

5. Preview and read the change list **before** deploying. Expect either no image
   change (if the immutable tag resolves to the same bits already running) or a
   single deliberate image change. A change list that reverts the image to an
   older ref means you pinned the wrong commit — stop and go back to step 2.

   ```bash
   ./scripts/deploy-azure.sh
   ./scripts/deploy-azure.sh --apply
   ```

6. Verify the new revision is serving and healthy before closing out:

   ```bash
   az containerapp revision list -g "$RG" -n "$APP" \
     --query '[].{name:name,active:properties.active,image:properties.template.containers[0].image}' -o table
   ```

Rolling back is then just re-pinning the previous immutable ref and deploying —
which is the whole point of the policy. Note the router runs a single replica by
design, so a deployment that changes the image is a brief interruption, not a
zero-downtime rollout; drain or expect in-flight sessions to reconnect.

### Break-glass: corrupt `router.db`

If the replica enters a CrashLoopBackOff because a restored `router.db` blob is
corrupt:

1. `az storage blob delete` the blob from the `router-backups` container (your
   `operatorPrincipalId` parameter value has **Storage Blob Data Contributor**
   on that container — without that role assignment you cannot do this; M2).
2. Restart the replica (`az containerapp revision restart …` or redeploy). The
   router starts fresh (404 on `router.db` = empty DB; `StateBackup.ts` treats
   anything other than 404 as a fatal restore failure — see the Task 3 runbook).

### Auto-suspend (N5 / F2)

`acaAutoSuspendSeconds` defaults to **0 = DISABLED**. ACA-side auto-suspend
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

#### Diagnosing a sandbox that boots but never connects

The failure above — `Running`, no device connection — is almost always
`container-boot` dying before it reaches `launch()`. Read its log:

```bash
aca sandbox list --selector 'cyrus.issue=<ISSUE-KEY>'
aca sandbox exec --id <sandbox-id> -c 'cat ~/cyrus-boot.log'
```

`~/cyrus-boot.log` is written by `container-boot` itself and holds every step
plus the fatal error and its stack. It exists because the Phase 2 log relay
cannot help here: `SandboxLogRelay` forwards only after the router advertises
`log_ingest` in `hello_ack`, so a boot that fails *before* connecting produces
nothing on the WSS and its stdout is collected by nothing. The file is on the
sandbox disk, so it survives for the sandbox's lifetime but dies with it —
read it before destroying the container.

It is written to `$HOME` rather than `/var/log` because the worker image runs
as the unprivileged `cyrus` user (uid 1001) and `/var/log` is root-owned.

To confirm a process-level diagnosis rather than infer it:

```bash
aca sandbox exec --id <sandbox-id> \
  -c 'for p in /proc/[0-9]*; do tr "\0" " " < $p/cmdline; echo; done'
```

A healthy worker shows `node /app/dist/src/app.js --cyrus-home /workspaces/.cyrus start`.
Only `tini -- sleep infinity` and `sleep infinity` means the workload exited
(`ps` is not installed in the image).

The most common cause is an expired GitHub credential. `container-boot`
preflights it and fails with `GH_TOKEN was rejected by GitHub (HTTP 401)`;
classic PATs (`ghp_…`) expire on a schedule. Verify and rotate:

```bash
aca sandbox exec --id <sandbox-id> \
  -c 'curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $GH_TOKEN" https://api.github.com/user'
```

Rotate the secret (`/setup`, or `cyrus router secrets set` via `az containerapp
exec`), then **destroy the container and re-prompt** — a rotated per-user secret
reaches only a create-from-image, never a resume or a create-from-snapshot.

### Secret rotation (N4)

The Linear app and workspace secrets in Key Vault are **seeded once and then
operator-owned**. Keep `writeLinearSecrets = false` and all five secret
parameters empty during routine deployments. Bicep then omits those secret child
resources, Incremental mode preserves their existing versions, and a stale
parameter file cannot revert a rotation. The router references fixed secret
names through versionless Key Vault URIs.

Rotate directly with `az keyvault secret set`. If a controlled bootstrap job
must perform the write through Bicep instead, temporarily supply all five values,
set `writeLinearSecrets = true`, and deploy with `--allow-secret-writes`. Restore
the flag to `false` and clear the values immediately afterwards. Both controls
are required so a routine CD identity never receives or rewrites secrets by
accident.

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
# Deliberate Bicep rotation path: update all five Linear values in the protected
# parameter file, temporarily set writeLinearSecrets=true, then:
./scripts/deploy-azure.sh --allow-secret-writes
./scripts/deploy-azure.sh --allow-secret-writes --apply
# Immediately restore writeLinearSecrets=false and clear all five values.

OUT=$(az deployment sub show --name cyrus-cyrus-dev --query 'properties.outputs' -o json)
RG=$(echo "$OUT" | jq -r .resourceGroupName.value)
APP=$(echo "$OUT" | jq -r .routerAppName.value)

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
`cyrus-linear-refresh-<workspaceId>`. That secret is **not** declared by the
template, so a deployment never reverts it. Changing the seed in the parameter
file during an explicitly authorized write is what tells the router to abandon
the stored chain and adopt the new credential.

### Entra enrollment

Entra-gated device enrollment is optional and separate from the managed
identity used for ACA data-plane calls. Follow
[`docs/ROUTER.md`](../../docs/ROUTER.md#optional-entra-gated-enrollment): create
one app registration per router deployment, use its Application ID URI as the
exact audience, and authenticate operators/users with `az login`. Set
`entraTenantId` and `entraAudience` together; optionally set
`entraAllowedDomain`. The template maps these to the canonical
`CYRUS_ROUTER_ENTRA_TENANT_ID`, `CYRUS_ROUTER_ENTRA_AUDIENCE`, and
`CYRUS_ROUTER_ENTRA_ALLOWED_DOMAIN` environment variables.

That **same** app registration is reused for `/setup` sign-in (§11) — one app,
two audiences: the `api://<client-id>` Application ID URI in `entraAudience`
for `/enroll` **access** tokens, and the bare client-id GUID for the **ID**
token the auth sidecar forwards. Do not mint a second app, and do not set
`setupUiIdTokenAudience` to the `api://` form.

### Egress (D7 / M4)

Default `acaEgressDefaultAction = 'Deny'` + `acaEgressTrafficInspection = 'Full'`.
The router injects the full D7 allowlist per sandbox on create (router, GitHub
+ `*.github.com` + `*.githubusercontent.com`, `api.anthropic.com` AND
`console.anthropic.com` (OAuth refresh — without it sessions 401 on first
token expiry), Linear, npm/PyPI/Go/Rust/Ruby/Maven/NuGet). Spike S4 confirmed
WSS works through `Full`; blocked hosts fail fast with HTTP 403. **`Full`
blocks non-HTTP TCP/UDP** → `git+ssh://` / SSH submodule URLs are unsupported —
use HTTPS submodule URLs (documented v1 limitation).

Leave `acaEgressHostRules = []` to retain that provider-managed list and the
dynamically appended router host. Setting explicit host rules replaces the
provider defaults.

### Custom domains

`routerCustomDomains` is passed straight into
`configuration.ingress.customDomains`. Certificate issuance and DNS validation
happen out of band; supply the resulting certificate resource id per entry.

The default `*.azurecontainerapps.io` FQDN is stable and fine for webhooks and
WSS, so only enable this if you need a branded hostname. **Do not add a hostname
with `az containerapp hostname add` and leave it out of the parameter file:** ARM
owns the whole ingress object, so the next deployment removes any custom domain
the template does not list.

### VNet / private endpoints

Out of scope for v1. The Key Vault is created with `networkAcls.defaultAction:
'Allow'` for dev ergonomics; tighten to your VNet/IP list in prod. The deferred
VNet shape for the sandbox group lives in
`bicep/modules/sandbox-group-vnet.bicep` (reference only — not called by
`main.bicep`).

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
bicep/
  README.md                       template layout, and where enforcement lives
  main.bicep                      subscription scope: parameters, cross-parameter
                                  validation, RG, module orchestration, outputs
  bootstrap-role-assignments.bicep resource-group RBAC bootstrap entry point
  main.bicepparam.example         complete parameter checklist
  modules/
    foundation.bicep              Log Analytics, Key Vault + opt-in secret writes,
                                  router identity, storage + Files share + blob
                                  containers + optional Table/KEK, Container Apps
                                  environment + Files link, optional ACR
    sandbox-group.bicep           sandboxGroups (properties: {})
    role-assignments.bicep        all deterministic runtime/break-glass RBAC
    router-app.bicep              router Container App + env + Files mount +
                                  readiness probe + optional custom domains
    router-auth.bicep             authConfigs child (stage 1 of /setup)
    monitoring.bicep              saved KQL searches + alert rules
    sandbox-group-vnet.bicep      optional vnetConnections child (deferred)
```

Deploy and check scripts:

```
scripts/deploy-azure.sh           what-if / deploy, image-pin, secret-write and stage-2 gates
scripts/bootstrap-azure-role-assignments.sh privileged runtime-RBAC what-if / apply
scripts/deploy-router-image.sh    build router image into ACR, repin, what-if
scripts/deploy-router-image.test.sh   covers the repin rewrite and the pin gate
scripts/check-bicep.sh            compile every template; warnings are failures
```
