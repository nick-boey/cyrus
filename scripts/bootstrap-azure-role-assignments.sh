#!/usr/bin/env bash
# Bootstrap/reconcile the runtime RBAC of an EXISTING Cyrus Azure stack.
#
# This is the privileged half of the split deployment model. Run it manually as
# an operator allowed to assign the stack's non-administrator runtime roles,
# then set manageRoleAssignments=false for routine Contributor-only CD.
#
# Default action is a WHAT-IF preview. Nothing changes without --apply.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Reuse the deployment parameter reader; its main is source-guarded.
# shellcheck source=scripts/deploy-azure.sh
source "${SCRIPT_DIR}/deploy-azure.sh"

RBAC_TEMPLATE="${SCRIPT_DIR}/../infra/azure/bicep/bootstrap-role-assignments.bicep"

usage() {
  cat <<'USAGE'
Usage: scripts/bootstrap-azure-role-assignments.sh [options]

Previews or applies only the runtime role assignments for an existing Cyrus
stack. Preview is the default.

  --apply          Create/reconcile the role assignments.
  --params <path>  Steady-state main.bicepparam to read non-secret stack shape
                   from. Defaults to infra/azure/bicep/main.bicepparam.
  --name <name>    Resource-group deployment name. Defaults to
                   cyrus-<project>-<environment>-rbac-bootstrap.

The script deliberately reads and forwards only these non-secret parameters:
project, environment, resourceGroupName, enableAcr, enableSetupSecretStore,
operatorPrincipalId, fleetOperatorLogReaderPrincipalIds, and
sandboxGroupDataOwnerRoleId. Linear and setup secret values are never passed to
this deployment.
USAGE
}

value_or_default() {
  local name="$1" default_value="$2" value
  value="$(param_value "$name")"
  printf '%s\n' "${value:-$default_value}"
}

# param_array <name> — read a `param <name> = [ ... ]` assignment out of the
# .bicepparam file and emit it as a compact JSON array, which is the form
# `az deployment ... --parameters name=<json>` accepts for an array parameter.
#
# Deliberately as simple as param_value: it only has to reach lists of quoted
# identifiers (Entra object ids), so it takes every single-quoted string between
# the opening bracket and the closing one. An absent or empty parameter yields
# `[]`.
#
# Comments are stripped INSIDE awk, before the closing bracket is looked for.
# Stripping them in a later pipe stage instead means a `]` in a trailing comment
# (`'<oid>' // on-call [primary]`) ends the scan early and silently drops every
# principal after it — a shorter grant list, no error, and a green what-if.
param_array() {
  local name="$1" item json=""
  while IFS= read -r item; do
    [[ -n "$item" ]] || continue
    json+="${json:+,}\"${item}\""
  done < <(
    awk -v name="$name" '
      { line = $0; sub(/\/\/.*/, "", line) }
      line ~ "^[[:space:]]*param[[:space:]]+" name "[[:space:]]*=[[:space:]]*\\[" { inside = 1 }
      inside { print line }
      inside && line ~ /\]/ { exit }
    ' "$PARAMS" | grep -oE "'[^']*'" | tr -d "'"
  )
  printf '[%s]\n' "$json"
}

require_bool() {
  local name="$1" value="$2"
  [[ "$value" == "true" || "$value" == "false" ]] \
    || die "${name} must be true or false in ${PARAMS}; got '${value}'"
}

bootstrap_rbac_main() {
  local apply=0 name=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --apply) apply=1; shift ;;
      --params)
        [[ $# -ge 2 && -n "$2" ]] || die "--params requires a path"
        PARAMS="$2"; shift 2
        ;;
      --name)
        [[ $# -ge 2 && -n "$2" ]] || die "--name requires a deployment name"
        name="$2"; shift 2
        ;;
      -h|--help) usage; return 0 ;;
      *) usage >&2; die "unknown argument: $1" ;;
    esac
  done

  command -v az >/dev/null 2>&1 || die "az not found on PATH"
  az account show >/dev/null 2>&1 || die "not logged in to Azure — run 'az login'"
  [[ -f "$PARAMS" ]] || die "parameter file not found: ${PARAMS}"
  [[ -f "$RBAC_TEMPLATE" ]] || die "RBAC template not found: ${RBAC_TEMPLATE}"

  local project environment resource_group enable_acr enable_setup_secret_store
  local operator_principal_id sandbox_data_owner_role_id log_reader_principal_ids
  project="$(param_value project)"
  [[ -n "$project" ]] || die "could not read project from ${PARAMS}"
  environment="$(value_or_default environment dev)"
  resource_group="$(param_value resourceGroupName)"
  [[ -n "$resource_group" ]] || resource_group="rg-${project}-${environment}"
  enable_acr="$(value_or_default enableAcr false)"
  enable_setup_secret_store="$(value_or_default enableSetupSecretStore false)"
  operator_principal_id="$(param_value operatorPrincipalId)"
  # main.bicep's parameter name; the RBAC module names it for the Azure role it
  # assigns rather than for the operator persona it serves.
  log_reader_principal_ids="$(param_array fleetOperatorLogReaderPrincipalIds)"
  sandbox_data_owner_role_id="$(value_or_default sandboxGroupDataOwnerRoleId c24cf47c-5077-412d-a19c-45202126392c)"

  require_bool enableAcr "$enable_acr"
  require_bool enableSetupSecretStore "$enable_setup_secret_store"
  az group show --name "$resource_group" >/dev/null 2>&1 \
    || die "resource group ${resource_group} does not exist; deploy the stack before bootstrapping RBAC"

  [[ -n "$name" ]] || name="cyrus-${project}-${environment}-rbac-bootstrap"
  local -a parameters=(
    "project=${project}"
    "environment=${environment}"
    "enableAcr=${enable_acr}"
    "enableSetupSecretStore=${enable_setup_secret_store}"
    "operatorPrincipalId=${operator_principal_id}"
    "logAnalyticsReaderPrincipalIds=${log_reader_principal_ids}"
    "sandboxGroupDataOwnerRoleId=${sandbox_data_owner_role_id}"
  )

  if [[ "$apply" -eq 0 ]]; then
    echo "==> RBAC what-if for ${resource_group} (no changes will be made)"
    az deployment group what-if \
      --name "$name" \
      --resource-group "$resource_group" \
      --template-file "$RBAC_TEMPLATE" \
      --parameters "${parameters[@]}"
    echo
    echo "Review the role assignments above, then re-run with --apply."
    return 0
  fi

  echo "==> bootstrapping Cyrus runtime RBAC in ${resource_group}"
  az deployment group create \
    --name "$name" \
    --resource-group "$resource_group" \
    --template-file "$RBAC_TEMPLATE" \
    --parameters "${parameters[@]}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  bootstrap_rbac_main "$@"
fi
