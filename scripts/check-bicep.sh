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

exit "$status"
