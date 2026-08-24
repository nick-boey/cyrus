#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${SCRIPT_DIR}/bootstrap-azure-role-assignments.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

FAILURES=0
ok()   { echo "ok   — $*"; }
fail() { echo "FAIL — $*" >&2; FAILURES=$((FAILURES + 1)); }

mkdir -p "$WORK/bin"
cat >"$WORK/bin/az" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$AZ_CALLS"
case "$1 $2" in
  "account show"|"group show") exit 0 ;;
  "deployment group") exit 0 ;;
  *) echo "unexpected az call: $*" >&2; exit 70 ;;
esac
STUB
chmod +x "$WORK/bin/az"

make_fixture() {
  cat >"$1" <<'EOF'
using 'main.bicep'
param project = 'cyrus'
param environment = 'dev'
param resourceGroupName = 'rg-cyrus'
param enableAcr = true
param enableSetupSecretStore = true
param operatorPrincipalId = '11111111-1111-1111-1111-111111111111'
param sandboxGroupDataOwnerRoleId = 'c24cf47c-5077-412d-a19c-45202126392c'
param linearClientSecret = 'SECRET_MUST_NOT_REACH_AZURE'
param setupUiClientSecret = 'ALSO_MUST_NOT_REACH_AZURE'
EOF
}

params="$WORK/main.bicepparam"
calls="$WORK/az.calls"
make_fixture "$params"

# 1. Preview is the default and forwards only the non-secret stack shape.
: >"$calls"
if AZ_CALLS="$calls" PATH="$WORK/bin:$PATH" "$SCRIPT" --params "$params" >/dev/null; then
  if grep -q '^deployment group what-if ' "$calls" \
    && grep -q -- '--resource-group rg-cyrus' "$calls" \
    && grep -q 'enableAcr=true' "$calls" \
    && grep -q 'enableSetupSecretStore=true' "$calls" \
    && ! grep -q 'SECRET_MUST_NOT_REACH_AZURE\|ALSO_MUST_NOT_REACH_AZURE' "$calls"; then
    ok "defaults to RBAC what-if and never forwards secret parameters"
  else
    fail "what-if invocation was incomplete or transmitted a secret"
  fi
else
  fail "default what-if failed"
fi

# 2. --apply selects create and retains the deterministic deployment name.
: >"$calls"
if AZ_CALLS="$calls" PATH="$WORK/bin:$PATH" "$SCRIPT" --params "$params" --apply >/dev/null \
  && grep -q '^deployment group create ' "$calls" \
  && grep -q -- '--name cyrus-cyrus-dev-rbac-bootstrap' "$calls"; then
  ok "--apply selects the deterministic RBAC deployment"
else
  fail "--apply did not invoke the RBAC deployment"
fi

# 3. Missing optional values use the main template's defaults and naming rule.
minimal="$WORK/minimal.bicepparam"
printf "param project = 'demo'\n" >"$minimal"
: >"$calls"
if AZ_CALLS="$calls" PATH="$WORK/bin:$PATH" "$SCRIPT" --params "$minimal" >/dev/null \
  && grep -q -- '--resource-group rg-demo-dev' "$calls" \
  && grep -q 'enableAcr=false' "$calls" \
  && grep -q 'enableSetupSecretStore=false' "$calls"; then
  ok "uses safe defaults for an omitted environment and optional features"
else
  fail "did not apply main-template defaults"
fi

# 4. Invalid booleans fail before any deployment call.
invalid="$WORK/invalid.bicepparam"
printf "param project = 'demo'\nparam enableAcr = 'yes'\n" >"$invalid"
: >"$calls"
if AZ_CALLS="$calls" PATH="$WORK/bin:$PATH" "$SCRIPT" --params "$invalid" >/dev/null 2>&1; then
  fail "accepted a non-boolean enableAcr"
elif grep -q '^deployment group ' "$calls"; then
  fail "attempted a deployment after invalid input"
else
  ok "rejects invalid feature flags before deployment"
fi

# 5. A missing project fails rather than targeting an accidental resource group.
missing="$WORK/missing.bicepparam"
printf "param environment = 'dev'\n" >"$missing"
: >"$calls"
if AZ_CALLS="$calls" PATH="$WORK/bin:$PATH" "$SCRIPT" --params "$missing" >/dev/null 2>&1; then
  fail "accepted a parameter file with no project"
elif grep -q '^deployment group ' "$calls"; then
  fail "attempted a deployment with no project"
else
  ok "requires an explicit project before resolving the resource group"
fi

exit "$FAILURES"
