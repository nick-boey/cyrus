#!/usr/bin/env bash
# scripts/check-bicep.sh — compile every Bicep template and the example
# parameter file, and fail on any error or warning.
#
# This replaces scripts/check-aca-arm-parity.sh, whose job was to keep the ACA
# sandbox-group ARM shape in step between a Bicep reference file and an AzAPI
# body in Terraform. There is now exactly one copy of that shape
# (infra/azure/bicep/modules/sandbox-group.bicep), so there is nothing to drift.
#
# WARNINGS ARE FAILURES here. A Bicep warning is almost always a real defect in
# this stack's idiom — BCP318 means a conditional resource is being dereferenced
# without a matching guard, BCP329/BCP334 mean a value can be out of a target's
# declared range, no-hardcoded-env-urls means the template will not work in a
# sovereign cloud. The only deliberate exceptions carry an inline
# `#disable-next-line` with a comment saying why.
#
# Dependencies: bicep (or the Azure CLI's bundled copy — `az bicep install` puts
# it on ~/.azure/bin).
set -euo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BICEP_DIR="${REPO_ROOT}/infra/azure/bicep"

command -v bicep >/dev/null 2>&1 || {
  echo "error: 'bicep' not found on PATH. Install it with 'az bicep install' and" >&2
  echo "       add ~/.azure/bin to PATH, or download the standalone CLI." >&2
  exit 2
}

[[ -d "$BICEP_DIR" ]] || { echo "error: $BICEP_DIR not found" >&2; exit 2; }

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

status=0

run() {
  local label="$1"; shift
  local out
  if ! out="$("$@" 2>&1 >/dev/null)"; then
    echo "FAIL — ${label}"
    printf '%s\n' "$out"
    status=1
    return
  fi
  if [[ -n "$out" ]]; then
    echo "FAIL — ${label} (warnings are failures; see scripts/check-bicep.sh)"
    printf '%s\n' "$out"
    status=1
    return
  fi
  echo "ok   — ${label}"
}

# Templates. Every .bicep under infra/azure/bicep, including the modules that
# main.bicep does not call (sandbox-group-vnet.bicep is a deferred reference and
# must still compile).
while IFS= read -r -d '' template; do
  run "bicep build ${template#"$REPO_ROOT/"}" bicep build "$template" --stdout
done < <(find "$BICEP_DIR" -name '*.bicep' -print0 | sort -z)

# The example parameter file. `build-params` type-checks it against the template
# named in its `using` statement, so this is what catches a parameter that was
# renamed in main.bicep and not in the operator checklist — the failure mode that
# leaves someone with a deployment that will not start and no idea why.
#
# It has to be copied to a real `.bicepparam` name: the compiler dispatches on
# the extension, and `.bicepparam.example` is not one.
cp "$BICEP_DIR/main.bicepparam.example" "$BICEP_DIR/.check.bicepparam"
trap 'rm -rf "$tmp"; rm -f "$BICEP_DIR/.check.bicepparam"' EXIT
run "bicep build-params main.bicepparam.example" bicep build-params "$BICEP_DIR/.check.bicepparam" --stdout

# Scenario parameter fixtures. The same type-check as the example file, applied
# to the fleet-operator shapes an operator actually writes: every parameter
# OMITTED (the "existing deployments stay valid" acceptance criterion — a
# different test from assigning `[]`, which would still type-check if the
# default were lost), and every parameter populated with a read-only principal,
# a read+recover principal, two different workspace grants, and the Log
# Analytics Reader list.
#
# The directory is checked explicitly. `find` failing inside a process
# substitution does not trip `set -e`, so a missing or empty testdata/ — exactly
# the state the `.gitignore` negation exists to prevent — would run the loop zero
# times, leave `status` at 0, and report success having checked nothing.
fixture_count=0
if [[ ! -d "$BICEP_DIR/testdata" ]]; then
  echo "FAIL — infra/azure/bicep/testdata is missing (is it gitignored again?)"
  status=1
else
  while IFS= read -r -d '' fixture; do
    fixture_count=$((fixture_count + 1))
    run "bicep build-params ${fixture#"$REPO_ROOT/"}" bicep build-params "$fixture" --stdout
  done < <(find "$BICEP_DIR/testdata" -name '*.bicepparam' -print0 | sort -z)
  if [[ "$fixture_count" -eq 0 ]]; then
    echo "FAIL — infra/azure/bicep/testdata contains no .bicepparam fixtures"
    status=1
  fi
fi

# assert_arm <template> <needle> <label> — assert a compiled ARM expression is
# present.
#
# These check the COMPILED template rather than the Bicep source because that is
# what a deployment acts on, and because each needle is an ARM expression whose
# disappearance is a whole acceptance criterion silently reverting. What they
# CANNOT do is evaluate: ARM lambdas run at deployment time, so no local tool
# sees what a grant table renders to. `az deployment sub what-if` is the gate for
# the rendered value; these are the gate for the wiring around it.
assert_arm() {
  local template="$1" needle="$2" label="$3" out
  if ! out="$(bicep build "$BICEP_DIR/$template" --stdout 2>/dev/null)"; then
    echo "FAIL — ${label} (${template} did not compile)"
    status=1
    return
  fi
  if [[ "$out" == *"$needle"* ]]; then
    echo "ok   — ${label}"
  else
    echo "FAIL — ${label}"
    echo "       compiled ${template} no longer contains: ${needle}"
    status=1
  fi
}

# Recovery is a DEPLOYMENT-side kill switch: with the flag off, `fleet.recover`
# is stripped from every grant and a recovery-only grant drops out entirely, so a
# recovery principal authenticates as a reader without any directory change.
assert_arm main.bicep   "if(parameters('enableFleetRecovery'), lambdaVariables('grant').roles, filter(lambdaVariables('grant').roles"   "enableFleetRecovery=false strips roles rather than failing the deployment"
assert_arm main.bicep   "not(equals(lambdaVariables('role'), 'fleet.recover'))"   "the stripped role is fleet.recover, leaving fleet.read intact"

# No operators configured means no workspace metadata is published at all —
# there is nobody the router could disclose the log source to.
assert_arm main.bicep   "string(if(empty(parameters('fleetOperatorGrants')), createObject()"   "an unconfigured deployment renders no fleetOperations block"
assert_arm main.bicep   "if(empty(parameters('fleetOperationsJson')), createArray(), createArray(createObject('name', 'CYRUS_ROUTER_FLEET_OPERATIONS_JSON'"   "the env var is omitted, not set empty, when no operators are configured"

# Workspace scope, not subscription or resource-group scope: an operator gets to
# read this stack's logs, not everything in the subscription.
assert_arm modules/role-assignments.bicep   "\"scope\": \"[resourceId('Microsoft.OperationalInsights/workspaces', format('log-{0}', parameters('namePrefix')))]\""   "Log Analytics Reader is assigned at the workspace scope"

exit "$status"
