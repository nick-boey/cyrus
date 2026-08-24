#!/usr/bin/env bash
# scripts/deploy-azure.sh — deploy (or preview) the Cyrus Azure stack from Bicep.
#
# This is the documented entry point for infra/azure/bicep/main.bicep. It exists
# because three of the stack's guarantees cannot live in the template alone:
#
#   1. THE IMAGE TAG POLICY, at full fidelity. main.bicep enforces a positive
#      allowlist of ref SHAPES, which is all ARM can express without a regex
#      engine. The character-level check — that a digest is 64 hex, that a
#      sha- tag's remainder is 7-40 hex, that a semver tag's components are
#      decimal — is applied here.
#
#   2. THE /setup STAGE ORDERING. The Terraform stack proved at plan time, via a
#      data source that read the deployed authConfigs child out of Azure, that
#      stage 1 had already been applied before stage 2 could be planned. Bicep
#      has no plan phase and no equivalent read. The same question is asked here
#      instead, with `az containerapp auth show` — still an answer from ARM about
#      real remote state rather than a boolean an operator typed, but now
#      bypassable by invoking `az deployment` directly. Don't.
#
#   3. SECRET WRITES REQUIRE TWO KEYS. The Bicep parameters that write bootstrap
#      or rotated Key Vault values default false, and this script separately
#      requires --allow-secret-writes. A scheduled deployment therefore cannot
#      overwrite an operator/runtime rotation merely because a parameter file was
#      changed or copied from an old bootstrap.
#
# Default action is a WHAT-IF preview. Nothing is changed without --apply.
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="${TEMPLATE:-${REPO_ROOT}/infra/azure/bicep/main.bicep}"
PARAMS="${PARAMS:-${REPO_ROOT}/infra/azure/bicep/main.bicepparam}"

die() { echo "error: $*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-azure.sh [options]

Previews (what-if) or applies infra/azure/bicep/main.bicep at subscription
scope. Preview is the default; --apply is the only thing that changes Azure.

  --apply                   Run the deployment instead of a what-if preview.
  --name <name>             Deployment name. Defaults to cyrus-<project>-<environment>.
  --params <path>           Bicep parameter file. Defaults to main.bicepparam.
  --router-image <ref>      Override routerImage without rewriting the parameter
                            file. Intended for a private CD pipeline pinned to a
                            public source commit.
  --allow-secret-writes     Required when writeLinearSecrets or
                            writeSetupAuthSecrets is true. Bootstrap/manual
                            rotation only; never set this in routine CD.

Environment overrides: TEMPLATE, PARAMS.

Never run this template with `--mode Complete`. Subscription-scope deployments
are Incremental and this script does not offer the alternative: the per-user
secret store's Table and KEK are deliberately allowed to outlive their feature
flag, and Complete mode would delete the key that unwraps every stored secret.
USAGE
}

# param_value <name> — read a scalar `param <name> = '<value>'` / `= <value>`
# assignment out of the .bicepparam file. Deliberately simple: it only needs to
# reach the handful of flags the gates below key on, and it is never used to
# rewrite the file.
param_value() {
  sed -nE "s/^[[:space:]]*param[[:space:]]+$1[[:space:]]*=[[:space:]]*'?([^'#]*)'?.*$/\1/p" "$PARAMS" \
    | head -1 | sed -E 's/[[:space:]]+$//'
}

# True when a parameter is absent (and therefore uses main.bicep's empty
# default) or is assigned the literal empty string. This checks the whole line
# instead of extracting a value, so even unusual secret characters cannot make
# a populated bootstrap field look empty.
param_is_empty_or_absent() {
  local name="$1" assignment empty_pattern
  assignment="$(sed -nE "/^[[:space:]]*param[[:space:]]+${name}[[:space:]]*=/p" "$PARAMS" | head -1)"
  [[ -z "$assignment" ]] && return 0
  empty_pattern="^[[:space:]]*param[[:space:]]+${name}[[:space:]]*=[[:space:]]*''[[:space:]]*(//.*)?$"
  [[ "$assignment" =~ $empty_pattern ]]
}

# is_immutable_ref <image-ref> — the full-fidelity form of main.bicep's shape
# allowlist. A POSITIVE allowlist, not a blocklist: a blocklist of known-bad tags
# would have missed `deploy-aca-disk-fix`, which is the tag that caused the
# 2026-07-31 incident.
is_immutable_ref() {
  local ref="$1"
  [[ "$ref" =~ @sha256:[0-9a-f]{64}$ ]] && return 0
  [[ "$ref" =~ :v?[0-9]+\.[0-9]+\.[0-9]+([-+.][0-9A-Za-z.-]+)?$ ]] && return 0
  [[ "$ref" =~ :sha-[0-9a-f]{7,40}$ ]] && return 0
  return 1
}

check_image_pins() {
  local router_image_override="${1:-}"
  local allow_mutable router_image worker_image
  allow_mutable="$(param_value allowMutableImageTags)"
  router_image="${router_image_override:-$(param_value routerImage)}"
  worker_image="$(param_value workerImage)"

  if [[ "$allow_mutable" == "true" ]]; then
    echo "==> allowMutableImageTags=true — skipping the image pin check." >&2
    echo "    A floating tag means this deployment ships whatever the registry" >&2
    echo "    points at NOW, not the build you tested. Throwaway stacks only." >&2
    return 0
  fi

  local ref
  for ref in "$router_image" "$worker_image"; do
    [[ -n "$ref" ]] || die "could not read routerImage/workerImage from ${PARAMS}"
    is_immutable_ref "$ref" || die "image ref '${ref}' is not pinned to an immutable reference.
Accepted forms: repo@sha256:<64 hex>, repo:v1.2.3, repo:sha-<7-40 hex>.
Build and push an immutable tag first (scripts/deploy-router-image.sh for the
router), or set allowMutableImageTags=true for a throwaway stack."
  done
  echo "==> image pins OK"
}

# The Bicep write flags are necessary but not sufficient. Requiring a separate
# CLI opt-in prevents a stale bootstrap parameter file from turning a routine
# scheduled deploy into a credential rollback.
check_secret_write_mode() {
  local allow_secret_writes="${1:-0}" write_linear write_setup value_name
  write_linear="$(param_value writeLinearSecrets)"
  write_setup="$(param_value writeSetupAuthSecrets)"

  if [[ "$write_linear" != "true" ]]; then
    for value_name in linearWorkspaceToken linearWorkspaceRefreshToken linearWebhookSecret linearClientId linearClientSecret; do
      param_is_empty_or_absent "$value_name" || die "${value_name} is populated while writeLinearSecrets is not true.
Clear all five Linear values before a steady-state deployment. Routine CD must
not receive or transmit stale bootstrap secrets, even when writes are disabled."
    done
  fi

  if [[ "$write_setup" != "true" ]]; then
    for value_name in setupUiClientSecret setupUiTokenStoreSasStart setupUiTokenStoreSasExpiry; do
      param_is_empty_or_absent "$value_name" || die "${value_name} is populated while writeSetupAuthSecrets is not true.
Clear all three setup-auth values before a steady-state deployment. Routine CD
must not receive or transmit stale bootstrap secrets, even when writes are disabled."
    done
  fi

  if [[ "$write_linear" != "true" && "$write_setup" != "true" ]]; then
    [[ "$allow_secret_writes" -eq 0 ]] || die "--allow-secret-writes was provided, but neither writeLinearSecrets nor writeSetupAuthSecrets is true.
Do not bake this switch into routine CD; add it only to the reviewed bootstrap
or rotation invocation that also enables the corresponding Bicep write flag."
    return 0
  fi

  [[ "$allow_secret_writes" -eq 1 ]] || die "secret writes are enabled in ${PARAMS}, but --allow-secret-writes was not provided.
Routine deployments must keep writeLinearSecrets=false and
writeSetupAuthSecrets=false. For an intentional bootstrap or coordinated
rotation, review every supplied secret and re-run with --allow-secret-writes."

  echo "==> WARNING: explicit Key Vault secret writes enabled" >&2
  [[ "$write_linear" == "true" ]] && echo "    writeLinearSecrets=true" >&2
  [[ "$write_setup" == "true" ]] && echo "    writeSetupAuthSecrets=true" >&2
  return 0
}

# The stage-2 gate. Refuses to publish a revision that serves /setup unless the
# EasyAuth child already exists on the LIVE app and is actually live — an
# authConfigs resource with platform.enabled false, or with the Entra identity
# provider disabled, injects no identity at all, so /setup would be reachable
# with no principal behind it.
check_setup_ui_stage() {
  local enable_ui enable_auth project environment rg app auth
  enable_ui="$(param_value enableSetupUi)"
  [[ "$enable_ui" == "true" ]] || return 0

  enable_auth="$(param_value enableSetupAuth)"
  [[ "$enable_auth" == "true" ]] || die "enableSetupUi=true requires enableSetupAuth=true."

  project="$(param_value project)"
  environment="$(param_value environment)"
  rg="$(param_value resourceGroupName)"
  [[ -n "$rg" ]] || rg="rg-${project}-${environment}"
  app="app-${project}-${environment}-router"

  echo "==> stage-2 gate: reading the deployed authConfigs child of ${app}"
  auth="$(az containerapp auth show --name "$app" --resource-group "$rg" -o json 2>/dev/null || true)"

  [[ -n "$auth" && "$auth" != "null" ]] || die "enableSetupUi=true, but no authConfigs child exists on ${app} in Azure.
Stage 1 (enableSetupAuth=true) must be deployed ON ITS OWN and complete BEFORE
stage 2. Setting both flags in one edit is the ordering hazard this gate exists
to refuse: this app's revision would start serving /setup before the auth
sidecar attached. Deploy stage 1, run the infra/azure/README.md section 11
step 5 verification, then deploy stage 2."

  local platform_enabled aad_enabled
  platform_enabled="$(echo "$auth" | jq -r '.platform.enabled // false')"
  aad_enabled="$(echo "$auth" | jq -r '.identityProviders.azureActiveDirectory.enabled // false')"

  [[ "$platform_enabled" == "true" && "$aad_enabled" == "true" ]] || die "the authConfigs child on ${app} exists but is not live: platform.enabled and
identityProviders.azureActiveDirectory.enabled must BOTH be true in Azure before
/setup routes are published. Currently platform.enabled=${platform_enabled},
azureActiveDirectory.enabled=${aad_enabled}. Re-deploy stage 1 and confirm with
\`az containerapp auth show\`."

  echo "==> stage-2 gate: auth child is live"
}

main() {
  local apply=0 allow_secret_writes=0 name="" router_image_override=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --apply) apply=1; shift ;;
      --name)
        [[ $# -ge 2 && -n "$2" ]] || die "--name requires a deployment name"
        name="$2"; shift 2
        ;;
      --params)
        [[ $# -ge 2 && -n "$2" ]] || die "--params requires a path"
        PARAMS="$2"; shift 2
        ;;
      --router-image)
        [[ $# -ge 2 && -n "$2" ]] || die "--router-image requires an immutable image reference"
        router_image_override="$2"; shift 2
        ;;
      --allow-secret-writes) allow_secret_writes=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "unknown argument: $1" ;;
    esac
  done

  for tool in az jq; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
  done
  az account show >/dev/null 2>&1 || die "not logged in to Azure — run 'az login'"
  [[ -f "$TEMPLATE" ]] || die "template not found: $TEMPLATE"
  [[ -f "$PARAMS" ]] || die "parameter file not found: ${PARAMS}
Copy infra/azure/bicep/main.bicepparam.example to main.bicepparam and fill in
the non-secret deployment configuration. Bootstrap secret values are opt-in."

  local location
  location="$(param_value location)"
  [[ -n "$location" ]] || die "could not read location from ${PARAMS}"

  if [[ -z "$name" ]]; then
    name="cyrus-$(param_value project)-$(param_value environment)"
  fi

  check_image_pins "$router_image_override"
  check_secret_write_mode "$allow_secret_writes"
  check_setup_ui_stage

  local -a deployment_parameters=("$PARAMS")
  if [[ -n "$router_image_override" ]]; then
    deployment_parameters+=("routerImage=${router_image_override}")
  fi

  if [[ "$apply" -eq 0 ]]; then
    echo "==> what-if (no changes will be made)"
    az deployment sub what-if \
      --name "$name" \
      --location "$location" \
      --template-file "$TEMPLATE" \
      --parameters "${deployment_parameters[@]}"
    cat <<EOF

Review the change list above, then re-run the same command with --apply.
EOF
    return 0
  fi

  echo "==> deploying ${name} to ${location}"
  az deployment sub create \
    --name "$name" \
    --location "$location" \
    --template-file "$TEMPLATE" \
    --parameters "${deployment_parameters[@]}"

  echo
  echo "==> outputs"
  az deployment sub show --name "$name" \
    --query 'properties.outputs' -o json
}

# Guarded so the test suite can source this file for is_immutable_ref and
# param_value without starting a deployment.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
