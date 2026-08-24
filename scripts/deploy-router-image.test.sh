#!/usr/bin/env bash
# scripts/deploy-router-image.test.sh — covers rewrite_router_image, plus the
# image-pin allowlist and parameter reader in deploy-azure.sh.
#
# The rewrite is the only part of deploy-router-image.sh with branching logic, and
# the only part that can corrupt infra/azure/bicep/main.bicepparam — a gitignored,
# mode-600 file that may temporarily hold bootstrap/rotation secrets, with no git
# copy to restore from. Everything else in that script is a single shell-out.
#
# is_immutable_ref is the full-fidelity half of the image tag policy: main.bicep
# can only check ref SHAPES, so this function is what actually rejects a hex-ish
# tag of the wrong length or a non-decimal semver component.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy-router-image.sh
source "${SCRIPT_DIR}/deploy-router-image.sh"
# shellcheck source=scripts/deploy-azure.sh
source "${SCRIPT_DIR}/deploy-azure.sh"

FAILURES=0
ok()   { echo "ok   — $*"; }
fail() { echo "FAIL — $*" >&2; FAILURES=$((FAILURES + 1)); }

OLD_REF="acrexample.azurecr.io/cyrus-router@sha256:$(printf '3%.0s' {1..64})"
NEW_REF="acrexample.azurecr.io/cyrus-router@sha256:$(printf 'a%.0s' {1..64})"
NEW_COMMENT="// This digest is tagged sha-9f49d67 in acrexample."

make_fixture() {
  cat >"$1" <<EOF
using 'main.bicep'

param location = 'australiaeast'

// ---- Container images -------------------------------------------------------
// Deployed by DIGEST (that is what the live Container App template holds).
// This digest is tagged sha-0dc73a1 in acrexample.
param routerImage = '${OLD_REF}'

param workerImage = 'acrexample.azurecr.io/cyrus-worker:sha-a5a9ffc'
param linearClientSecret = 'SECRET_MUST_SURVIVE'
EOF
  chmod 600 "$1"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. rewrites the assignment to the new ref
f="$WORK/a.bicepparam"; make_fixture "$f"
rewrite_router_image "$f" "$NEW_REF" "$NEW_COMMENT"
if grep -qF "param routerImage = '${NEW_REF}'" "$f"; then
  ok "rewrites routerImage to the new digest"
else
  fail "routerImage was not rewritten"
fi

# 2. refreshes the provenance comment
if grep -qF "$NEW_COMMENT" "$f" && ! grep -q "sha-0dc73a1" "$f"; then
  ok "refreshes the provenance comment"
else
  fail "provenance comment still names the old tag"
fi

# 3. leaves every other line byte-identical, including the secret
g="$WORK/b.bicepparam"; make_fixture "$g"
if diff <(grep -vE '^(param routerImage|// This digest is tagged)' "$f") \
        <(grep -vE '^(param routerImage|// This digest is tagged)' "$g") >/dev/null; then
  ok "leaves all other lines untouched"
else
  fail "unrelated lines changed"
fi
if grep -qF 'SECRET_MUST_SURVIVE' "$f"; then
  ok "preserves secret-bearing lines"
else
  fail "a secret line was lost"
fi

# 4. preserves mode 600
#
# GNU first, BSD second — and NOT the other way round. GNU stat's -f means
# --file-system, so `stat -f '%Lp'` SUCCEEDS on Linux and prints a block-device
# report; the `||` fallback never fires and the mode check compares garbage.
# BSD stat rejects -c outright, so this order degrades correctly on both.
mode="$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f")"
if [[ "$mode" == "600" ]]; then
  ok "preserves mode 600"
else
  fail "mode became $mode, expected 600"
fi

# 5. fails without writing when there is no routerImage assignment
h="$WORK/c.bicepparam"
printf "param location = 'australiaeast'\n" >"$h"
before="$(cat "$h")"
if rewrite_router_image "$h" "$NEW_REF" "$NEW_COMMENT" 2>/dev/null; then
  fail "should have refused a parameter file with no routerImage"
elif [[ "$(cat "$h")" == "$before" ]]; then
  ok "refuses a parameter file with no routerImage, leaving it unchanged"
else
  fail "refused but still modified the file"
fi

# 6. fails without writing when there are two routerImage assignments
i="$WORK/d.bicepparam"; make_fixture "$i"
printf "param routerImage = '%s'\n" "$OLD_REF" >>"$i"
before="$(cat "$i")"
if rewrite_router_image "$i" "$NEW_REF" "$NEW_COMMENT" 2>/dev/null; then
  fail "should have refused two routerImage assignments"
elif [[ "$(cat "$i")" == "$before" ]]; then
  ok "refuses two routerImage assignments, leaving the file unchanged"
else
  fail "refused but still modified the file"
fi

# 7. leaves workerImage's provenance comment alone
#
# The same "This digest is tagged … in …" line sits above workerImage. A rewrite
# anchored only to line-start replaces that one too, making it assert a tag the
# worker image does not have — a confidently wrong comment, which is worse than
# the stale one this script exists to refresh, and would mislead exactly the
# manual cross-check that caught the 2026-07-31 incident.
j="$WORK/e.bicepparam"
cat >"$j" <<EOF
// This digest is tagged sha-0dc73a1 in acrexample.
param routerImage = '${OLD_REF}'

// This digest is tagged sha-a5a9ffc in acrexample.
param workerImage = 'acrexample.azurecr.io/cyrus-worker:sha-a5a9ffc'
EOF
chmod 600 "$j"
rewrite_router_image "$j" "$NEW_REF" "$NEW_COMMENT"
if grep -qF '// This digest is tagged sha-a5a9ffc in acrexample.' "$j" \
   && [[ "$(grep -cF "$NEW_COMMENT" "$j")" == "1" ]]; then
  ok "rewrites only routerImage's provenance comment"
else
  fail "workerImage's provenance comment was falsified"
fi

# 8. leaves the original intact when the rewrite itself fails
#
# This is the branch whose entire job is protecting the secrets file. `awk` is
# shadowed on PATH with a stub that emits a truncated file and exits non-zero — a
# stand-in for a disk-full or OOM-killed awk, whose output would still satisfy the
# "exactly one routerImage line, and it carries the new ref" verification.
#
# Called the way main() calls it — `… || true`, mirroring `… || die`. That form
# disables `set -e` for the whole function body, so a bare call would exercise a
# safety this script never actually has at the point of use.
k="$WORK/f.bicepparam"; make_fixture "$k"
before="$(cat "$k")"
stub_dir="$WORK/stub-bin"; mkdir -p "$stub_dir"
cat >"$stub_dir/awk" <<STUB
#!/usr/bin/env bash
printf '// This digest is tagged sha-9f49d67 in acrexample.\nparam routerImage = %s\n' "'\$REWRITE_REF'"
exit 2
STUB
chmod +x "$stub_dir/awk"

rewrite_rc=0
PATH="$stub_dir:$PATH" rewrite_router_image "$k" "$NEW_REF" "$NEW_COMMENT" 2>/dev/null || rewrite_rc=$?

if [[ "$rewrite_rc" -ne 0 ]]; then
  ok "reports failure when the rewrite fails"
else
  fail "returned 0 despite a failed rewrite"
fi
if [[ "$(cat "$k")" == "$before" ]]; then
  ok "leaves the original byte-identical when the rewrite fails"
else
  fail "the original was modified — a failed rewrite destroyed the secrets file"
fi
if grep -qF 'SECRET_MUST_SURVIVE' "$k"; then
  ok "secret survives a failed rewrite"
else
  fail "the secret was lost by a failed rewrite"
fi
residue="$(find "$WORK" -maxdepth 1 -name '.f.bicepparam.tmp.*' | wc -l | tr -d ' ')"
if [[ "$residue" == "0" ]]; then
  ok "leaves no temp residue after a failed rewrite"
else
  fail "left ${residue} temp file(s) beside the parameter file"
fi

# 9. leaves the original intact when the rewrite truncates but exits 0
#
# The other half of the same hazard: a truncation that awk does not report. The
# stub emits a file that satisfies both content checks — exactly one routerImage
# line, and it carries the new ref — so only the line-count guard stands between
# this and an mv that destroys the secrets.
m="$WORK/g.bicepparam"; make_fixture "$m"
before="$(cat "$m")"
cat >"$stub_dir/awk" <<STUB
#!/usr/bin/env bash
printf 'param routerImage = %s\n' "'\$REWRITE_REF'"
exit 0
STUB
chmod +x "$stub_dir/awk"

rewrite_rc=0
PATH="$stub_dir:$PATH" rewrite_router_image "$m" "$NEW_REF" "$NEW_COMMENT" 2>/dev/null || rewrite_rc=$?

if [[ "$rewrite_rc" -ne 0 ]]; then
  ok "reports failure when a silent truncation passes the content checks"
else
  fail "accepted a truncated rewrite that exited 0"
fi
if [[ "$(cat "$m")" == "$before" ]] && grep -qF 'SECRET_MUST_SURVIVE' "$m"; then
  ok "secret survives a silent truncation"
else
  fail "a silently truncated rewrite destroyed the secrets file"
fi

# 10. temp residue would be gitignored
#
# The temp file may be a mode-600 copy of bootstrap/rotation secrets. If a
# SIGKILL outruns the EXIT trap, the residue must not be one `git add -A` from
# being committed.
probe="$(cd "$SCRIPT_DIR/.." && git check-ignore -q "infra/azure/bicep/.main.bicepparam.tmp.aB12cD" && echo ignored || echo NOT_IGNORED)"
if [[ "$probe" == "ignored" ]]; then
  ok "temp file name is gitignored"
else
  fail "temp file name is NOT gitignored"
fi

# 11. the parameter file itself is gitignored, and the example is not
probe="$(cd "$SCRIPT_DIR/.." && git check-ignore -q "infra/azure/bicep/main.bicepparam" && echo ignored || echo NOT_IGNORED)"
if [[ "$probe" == "ignored" ]]; then
  ok "main.bicepparam is gitignored"
else
  fail "main.bicepparam is NOT gitignored — a populated parameter file is committable"
fi
probe="$(cd "$SCRIPT_DIR/.." && git check-ignore -q "infra/azure/bicep/main.bicepparam.example" && echo ignored || echo NOT_IGNORED)"
if [[ "$probe" == "NOT_IGNORED" ]]; then
  ok "main.bicepparam.example is tracked"
else
  fail "main.bicepparam.example is gitignored — the checklist would never be committed"
fi

################################################################################
# deploy-azure.sh — the image pin allowlist
################################################################################

# 12. accepts every immutable form
hex64="$(printf 'a%.0s' {1..64})"
for ref in \
  "acrexample.azurecr.io/cyrus-router@sha256:${hex64}" \
  "ghcr.io/ceedaragents/cyrus-router:v1.2.3" \
  "ghcr.io/ceedaragents/cyrus-router:v1.2.3-rc.1" \
  "ghcr.io/ceedaragents/cyrus-router:1.2.3" \
  "ghcr.io/ceedaragents/cyrus-router:sha-a1b2c3d" \
  "localhost:5000/cyrus-router:sha-0dc73a1"
do
  if is_immutable_ref "$ref"; then
    ok "accepts immutable ref ${ref}"
  else
    fail "rejected immutable ref ${ref}"
  fi
done

# 13. rejects every mutable form, including the one that caused the incident
for ref in \
  "ghcr.io/ceedaragents/cyrus-router:latest" \
  "ghcr.io/ceedaragents/cyrus-router:deploy" \
  "ghcr.io/ceedaragents/cyrus-router:deploy-aca-disk-fix" \
  "ghcr.io/ceedaragents/cyrus-router:main" \
  "ghcr.io/ceedaragents/cyrus-router:1.2" \
  "ghcr.io/ceedaragents/cyrus-router:sha-zzzzzzz" \
  "ghcr.io/ceedaragents/cyrus-router:sha-abc" \
  "acrexample.azurecr.io/cyrus-router@sha256:abc123" \
  "ghcr.io/ceedaragents/cyrus-router"
do
  if is_immutable_ref "$ref"; then
    fail "accepted mutable/ambiguous ref ${ref}"
  else
    ok "rejects ${ref}"
  fi
done

# 14. param_value reads scalars out of a .bicepparam, quoted and bare
PARAMS="$WORK/h.bicepparam"
cat >"$PARAMS" <<EOF
using 'main.bicep'
param project = 'cyrus'
param environment = 'dev'
param resourceGroupName = ''
param enableSetupUi = false
param allowMutableImageTags = true
param routerImage = 'acrexample.azurecr.io/cyrus-router@sha256:${hex64}'
EOF

check() {
  local name="$1" expected="$2" actual
  actual="$(param_value "$name")"
  if [[ "$actual" == "$expected" ]]; then
    ok "param_value ${name} => '${actual}'"
  else
    fail "param_value ${name} => '${actual}', expected '${expected}'"
  fi
}
check project cyrus
check environment dev
check resourceGroupName ''
check enableSetupUi false
check allowMutableImageTags true
check routerImage "acrexample.azurecr.io/cyrus-router@sha256:${hex64}"

# 15. check_image_pins skips the check — loudly — when the escape hatch is set
if check_image_pins 2>/dev/null; then
  ok "check_image_pins honours allowMutableImageTags"
else
  fail "check_image_pins failed despite allowMutableImageTags=true"
fi

# 16. …and refuses a mutable ref when it is not
sed -i.bak "s/allowMutableImageTags = true/allowMutableImageTags = false/" "$PARAMS"
printf "param workerImage = 'ghcr.io/ceedaragents/cyrus-worker:deploy'\n" >>"$PARAMS"
if ( check_image_pins >/dev/null 2>&1 ); then
  fail "check_image_pins accepted a mutable workerImage"
else
  ok "check_image_pins refuses a mutable workerImage"
fi

# 17. an immutable CLI override replaces routerImage for validation without
# rewriting the environment's tracked/sanitized parameter file.
PARAMS="$WORK/i.bicepparam"
cat >"$PARAMS" <<EOF
param allowMutableImageTags = false
param routerImage = 'ghcr.io/ceedaragents/cyrus-router:deploy'
param workerImage = 'ghcr.io/ceedaragents/cyrus-worker:sha-a1b2c3d'
param writeLinearSecrets = false
param writeSetupAuthSecrets = false
EOF
if check_image_pins "ghcr.io/ceedaragents/cyrus-router:sha-deadbee" >/dev/null 2>&1; then
  ok "check_image_pins validates the immutable router-image override"
else
  fail "check_image_pins ignored or rejected the immutable router-image override"
fi

# 18. steady-state parameter files need no secret-write consent.
if check_secret_write_mode 0 >/dev/null 2>&1; then
  ok "steady-state deployment needs no secret-write consent"
else
  fail "steady-state deployment was incorrectly treated as a secret write"
fi

# 19. stale bootstrap values are refused even with writes disabled. Avoiding the
# Key Vault resource is insufficient if routine CD still transmits the value.
printf '%s\n' "param linearClientSecret = 'stale-bootstrap-value'" >>"$PARAMS"
if ( check_secret_write_mode 0 >/dev/null 2>&1 ); then
  fail "steady-state deployment accepted a populated secret parameter"
else
  ok "steady-state deployment refuses stale secret values"
fi
sed -i.bak "/linearClientSecret/d" "$PARAMS"

# 20. routine CD cannot pre-wire the exceptional consent switch. This keeps the
# second key independent from a later parameter-file change.
if ( check_secret_write_mode 1 >/dev/null 2>&1 ); then
  fail "unused --allow-secret-writes consent was accepted"
else
  ok "secret-write consent is refused outside an active write operation"
fi

# 21. one Bicep write flag is not enough: the script refuses without the
# separate CLI consent, so a stale bootstrap file cannot poison scheduled CD.
sed -i.bak 's/writeLinearSecrets = false/writeLinearSecrets = true/' "$PARAMS"
if ( check_secret_write_mode 0 >/dev/null 2>&1 ); then
  fail "secret write was accepted without --allow-secret-writes consent"
else
  ok "secret write requires separate CLI consent"
fi

# 22. intentional bootstrap/rotation passes once both keys are present.
if check_secret_write_mode 1 >/dev/null 2>&1; then
  ok "secret write proceeds with explicit CLI consent"
else
  fail "explicitly consented secret write was refused"
fi

# 23. the CLI accepts an external environment file and forwards the immutable
# router pin as a later Azure parameter override. This is the private-CD seam:
# source/template and image share one pinned commit without rewriting the
# environment repository's tracked parameter file.
PARAMS="$WORK/j.bicepparam"
cat >"$PARAMS" <<EOF
param project = 'cyrus'
param environment = 'dev'
param resourceGroupName = 'rg-cyrus'
param location = 'australiaeast'
param allowMutableImageTags = false
param routerImage = 'ghcr.io/ceedaragents/cyrus-router:deploy'
param workerImage = 'ghcr.io/ceedaragents/cyrus-worker:sha-a1b2c3d'
param writeLinearSecrets = false
param writeSetupAuthSecrets = false
param enableSetupUi = false
EOF

az_stub_dir="$WORK/az-stub-bin"
mkdir -p "$az_stub_dir"
az_calls="$WORK/az-calls"
cat >"$az_stub_dir/az" <<'STUB'
#!/usr/bin/env bash
{
  printf '%s\n' '--- call ---'
  printf '%s\n' "$@"
} >>"$AZ_CALLS"
exit 0
STUB
chmod +x "$az_stub_dir/az"

override='ghcr.io/ceedaragents/cyrus-router:sha-deadbee'
if PATH="$az_stub_dir:$PATH" AZ_CALLS="$az_calls" \
   "$SCRIPT_DIR/deploy-azure.sh" --params "$PARAMS" \
     --router-image "$override" --name cyrus-ci-test >/dev/null 2>&1 \
   && grep -qFx "$PARAMS" "$az_calls" \
   && grep -qFx "routerImage=$override" "$az_calls"; then
  ok "deploy CLI forwards external params and the router-image override"
else
  fail "deploy CLI did not forward external params and router-image override"
fi

if [[ "$FAILURES" -gt 0 ]]; then
  echo "${FAILURES} test(s) failed" >&2
  exit 1
fi
echo "all tests passed"
