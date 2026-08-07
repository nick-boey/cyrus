#!/usr/bin/env bash
# scripts/bootstrap-tfstate.sh — create the Terraform state backend and the
# GitHub Actions deploy identity.
#
# This is the ONE step that cannot be automated by the deploy workflow, because
# the workflow authenticates with the identity this script creates. Run it once
# per environment, by hand, with an account holding Owner (or Contributor +
# Role Based Access Control Administrator) on the subscription.
#
# It creates, in a resource group that this repo's Terraform stack does NOT
# manage:
#
#   rg-cyrus-tfstate/
#     <state-account>/tfstate/          blob container holding *.tfstate
#     id-cyrus-deploy                   user-assigned identity for CI
#       └── federated credential        trusts one branch of one GitHub repo
#
# Why a separate resource group: `azurerm_resource_group.this` (main.tf:28) is
# created and owned by the stack. State kept inside it would be deleted by
# `terraform destroy` — while Terraform was mid-write to it — and would not
# exist at all on a first `terraform init`, before the stack has ever run.
#
# Safe to re-run. Every step is idempotent; nothing is deleted.
set -euo pipefail

STATE_RG="rg-cyrus-tfstate"
STATE_ACCOUNT=""
CONTAINER="tfstate"
LOCATION=""
IDENTITY_NAME="id-cyrus-deploy"
REPO=""
BRANCH="deploy"
SUBSCRIPTION=""

usage() {
  cat >&2 <<'EOF'
usage: bootstrap-tfstate.sh --state-account <name> --repo <owner/repo>
                            --location <region> [options]

required:
  --state-account <name>   Storage account for state. 3-24 chars, lowercase
                           alphanumeric, globally unique across Azure.
  --repo <owner/repo>      PRIVATE repo whose deploy branch may assume the
                           identity, e.g. Northrop-Digital/cyrus-deploy.
  --location <region>      Azure region, e.g. australiaeast. No default, to
                           match `var.location` in the stack — nothing here
                           should silently place resources in a region nobody
                           chose. This does NOT have to match the stack's
                           region: it holds only blobs and an identity, neither
                           of which carries the ACA sandbox-group region
                           restriction.

options:
  --branch <name>          Branch trusted by the federated credential.
                           (default: deploy)
  --state-rg <name>        Resource group for state + identity.
                           (default: rg-cyrus-tfstate)
  --container <name>       Blob container name. (default: tfstate)
  --identity-name <name>   (default: id-cyrus-deploy)
  --subscription <id>      (default: the current az CLI subscription)
EOF
  exit 2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-account) STATE_ACCOUNT="${2:-}"; shift 2 ;;
    --repo)          REPO="${2:-}"; shift 2 ;;
    --branch)        BRANCH="${2:-}"; shift 2 ;;
    --state-rg)      STATE_RG="${2:-}"; shift 2 ;;
    --container)     CONTAINER="${2:-}"; shift 2 ;;
    --location)      LOCATION="${2:-}"; shift 2 ;;
    --identity-name) IDENTITY_NAME="${2:-}"; shift 2 ;;
    --subscription)  SUBSCRIPTION="${2:-}"; shift 2 ;;
    -h|--help)       usage ;;
    *) echo "error: unknown argument: $1" >&2; usage ;;
  esac
done

[[ -n "$STATE_ACCOUNT" ]] || { echo "error: --state-account is required" >&2; usage; }
[[ -n "$REPO" ]] || { echo "error: --repo is required" >&2; usage; }
[[ -n "$LOCATION" ]] || { echo "error: --location is required" >&2; usage; }

# Azure rejects a bad storage account name several seconds into `create`, after
# the resource group already exists. Fail here instead, where nothing has been
# created yet and the message names the actual rule.
[[ "$STATE_ACCOUNT" =~ ^[a-z0-9]{3,24}$ ]] || {
  echo "error: --state-account must be 3-24 lowercase alphanumeric chars (got '${STATE_ACCOUNT}')" >&2
  exit 1
}
[[ "$REPO" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]] || {
  echo "error: --repo must be <owner>/<repo> (got '${REPO}')" >&2
  exit 1
}

if [[ -n "$SUBSCRIPTION" ]]; then
  az account set --subscription "$SUBSCRIPTION"
fi
SUB_ID="$(az account show --query id -o tsv)"
TENANT_ID="$(az account show --query tenantId -o tsv)"

echo "==> subscription ${SUB_ID} (tenant ${TENANT_ID})"

################################################################################
# 1. State storage
################################################################################

echo "==> resource group ${STATE_RG}"
az group create -n "$STATE_RG" -l "$LOCATION" -o none

echo "==> storage account ${STATE_ACCOUNT}"
az storage account create \
  -n "$STATE_ACCOUNT" -g "$STATE_RG" -l "$LOCATION" \
  --sku Standard_LRS \
  --min-tls-version TLS1_2 \
  --allow-blob-public-access false \
  --allow-shared-key-access false \
  -o none

# State loss is the one failure in this stack with no recovery path — the file
# is the only record of which live resources Terraform believes it owns. Blob
# versioning turns a corrupt write, a bad `state rm`, or an overlapping apply
# into a restore instead of a rebuild-by-hand. It is billed per version and the
# file is tens of KB, so the cost is noise.
echo "==> blob versioning + 30-day soft delete"
az storage account blob-service-properties update \
  --account-name "$STATE_ACCOUNT" -g "$STATE_RG" \
  --enable-versioning true \
  --enable-delete-retention true --delete-retention-days 30 \
  --enable-container-delete-retention true --container-delete-retention-days 30 \
  -o none

# --auth-mode login because --allow-shared-key-access false above means there is
# no account key to fall back on. The CLI would otherwise try to fetch one and
# fail with a confusing authorization error rather than a missing-role one.
echo "==> container ${CONTAINER}"
az storage container create \
  -n "$CONTAINER" --account-name "$STATE_ACCOUNT" --auth-mode login -o none

################################################################################
# 2. Deploy identity + GitHub OIDC trust
################################################################################

echo "==> user-assigned identity ${IDENTITY_NAME}"
az identity create -n "$IDENTITY_NAME" -g "$STATE_RG" -l "$LOCATION" -o none

IDENTITY_CLIENT_ID="$(az identity show -n "$IDENTITY_NAME" -g "$STATE_RG" --query clientId -o tsv)"
IDENTITY_PRINCIPAL_ID="$(az identity show -n "$IDENTITY_NAME" -g "$STATE_RG" --query principalId -o tsv)"

# The subject is scoped to ONE branch of ONE repo. Scope it no wider: a subject
# like `repo:<owner>/<repo>:ref:refs/heads/*` or a pull_request subject would
# let any branch — including one pushed by a fork PR — mint a token for this
# identity. The deploy branch is the only ref that should ever hold Azure
# rights, which is the entire reason the workflow lives on it rather than on
# main. See SYNC-UPSTREAM.md and README → "Deploying from the private mirror".
SUBJECT="repo:${REPO}:ref:refs/heads/${BRANCH}"
FED_NAME="github-${BRANCH}"

if az identity federated-credential show \
     --identity-name "$IDENTITY_NAME" -g "$STATE_RG" -n "$FED_NAME" -o none 2>/dev/null; then
  # Re-point rather than skip: re-running with a different --repo/--branch is
  # how the trust is corrected, and a silent skip would leave the old subject
  # trusted while reporting success.
  echo "==> federated credential ${FED_NAME} (updating subject)"
  az identity federated-credential update \
    --identity-name "$IDENTITY_NAME" -g "$STATE_RG" -n "$FED_NAME" \
    --issuer "https://token.actions.githubusercontent.com" \
    --subject "$SUBJECT" \
    --audiences "api://AzureADTokenExchange" -o none
else
  echo "==> federated credential ${FED_NAME}"
  az identity federated-credential create \
    --identity-name "$IDENTITY_NAME" -g "$STATE_RG" -n "$FED_NAME" \
    --issuer "https://token.actions.githubusercontent.com" \
    --subject "$SUBJECT" \
    --audiences "api://AzureADTokenExchange" -o none
fi

################################################################################
# 3. Role assignments
################################################################################

# --assignee-object-id + --assignee-principal-type ServicePrincipal, never bare
# --assignee: a freshly created identity has not propagated through Graph yet,
# and the name lookup behind --assignee fails intermittently for the first
# minute. Passing the object id skips the lookup entirely.
assign_role() {
  local role="$1" scope="$2"
  if [[ -n "$(az role assignment list \
        --assignee "$IDENTITY_PRINCIPAL_ID" --role "$role" --scope "$scope" \
        --query '[0].id' -o tsv 2>/dev/null)" ]]; then
    echo "    = ${role}"
    return 0
  fi
  echo "    + ${role}"
  az role assignment create \
    --assignee-object-id "$IDENTITY_PRINCIPAL_ID" \
    --assignee-principal-type ServicePrincipal \
    --role "$role" --scope "$scope" -o none
}

echo "==> roles on the state container"
CONTAINER_SCOPE="/subscriptions/${SUB_ID}/resourceGroups/${STATE_RG}/providers/Microsoft.Storage/storageAccounts/${STATE_ACCOUNT}/blobServices/default/containers/${CONTAINER}"
# Container scope, not account scope: this identity has no business reading the
# router's backup blobs, which live in a different account entirely but would be
# reachable if the habit were to grant data roles at account level.
assign_role "Storage Blob Data Contributor" "$CONTAINER_SCOPE"

# SUBSCRIPTION SCOPE — a deliberate ceiling, not an oversight.
#
# The natural scope is the stack's own resource group, but the stack CREATES
# that group (main.tf:28), so it does not exist to be scoped against until the
# first apply has already succeeded. Granting at subscription level is what
# makes a from-nothing deploy possible.
#
# To narrow this later: after the first successful apply, re-run these three
# assignments with --scope pointed at the stack resource group and delete the
# subscription-scoped ones. Doing so permanently gives up the ability to
# `terraform destroy` and re-create the stack from empty, which is a real
# capability to trade away — decide, do not drift into it.
echo "==> roles on the subscription"
SUB_SCOPE="/subscriptions/${SUB_ID}"

# Creates the resource group and every resource in it.
assign_role "Contributor" "$SUB_SCOPE"

# The stack declares nine role assignments (main.tf:148/154/164/176,
# sandbox.tf:58/84/93, setup_ui.tf:441/452). Contributor explicitly CANNOT
# create those. This role can, and unlike User Access Administrator it cannot
# escalate by granting Owner.
assign_role "Role Based Access Control Administrator" "$SUB_SCOPE"

# The vault is RBAC-authorized (main.tf:57 `rbac_authorization_enabled = true`),
# so control-plane Contributor grants NO data-plane access. Writing the five
# Linear secrets (main.tf:187-223) and the two setup-UI secrets
# (setup_ui.tf:94/166) needs this.
assign_role "Key Vault Secrets Officer" "$SUB_SCOPE"

# Same reasoning for the envelope-encryption KEK (setup_ui.tf:417), which is a
# key rather than a secret and so needs a separate data-plane role.
assign_role "Key Vault Crypto Officer" "$SUB_SCOPE"

################################################################################
# 4. What to do with the output
################################################################################

cat <<EOF

Done.

  1. Write infra/azure/terraform/env/backend.dev.hcl (gitignored):

     resource_group_name  = "${STATE_RG}"
     storage_account_name = "${STATE_ACCOUNT}"
     container_name       = "${CONTAINER}"
     key                  = "dev.tfstate"
     use_azuread_auth     = true

  2. Migrate local state up (answer "yes" to the copy prompt):

     cd infra/azure/terraform
     terraform init -migrate-state -backend-config=env/backend.dev.hcl

  3. Set these as repository variables on ${REPO} (NOT secrets — they are
     identifiers, and there is no client secret to store):

     AZURE_CLIENT_ID       ${IDENTITY_CLIENT_ID}
     AZURE_TENANT_ID       ${TENANT_ID}
     AZURE_SUBSCRIPTION_ID ${SUB_ID}

  Only refs/heads/${BRANCH} on ${REPO} can assume this identity.
EOF
