#!/usr/bin/env bash
# scripts/deploy-router-image.test.sh — covers rewrite_router_image.
#
# The rewrite is the only part of deploy-router-image.sh with branching logic,
# and the only part that can corrupt env/dev.tfvars — a gitignored, mode-600
# file holding the Linear client secret and both OAuth tokens, with no git copy
# to restore from. Everything else in that script is a single shell-out.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy-router-image.sh
source "${SCRIPT_DIR}/deploy-router-image.sh"

FAILURES=0
ok()   { echo "ok   — $*"; }
fail() { echo "FAIL — $*" >&2; FAILURES=$((FAILURES + 1)); }

OLD_REF="acrcyrusdev.azurecr.io/cyrus-router@sha256:$(printf '3%.0s' {1..64})"
NEW_REF="acrcyrusdev.azurecr.io/cyrus-router@sha256:$(printf 'a%.0s' {1..64})"
NEW_COMMENT="# This digest is tagged sha-9f49d67 in acrcyrusdev."

make_fixture() {
  cat >"$1" <<EOF
location = "australiaeast"

# ---- Container images -------------------------------------------------------
# Deployed by DIGEST (that is what the live Container App template holds).
# This digest is tagged sha-0dc73a1 in acrcyrusdev.
router_image = "${OLD_REF}"

worker_image  = "acrcyrusdev.azurecr.io/cyrus-worker:sha-a5a9ffc"
linear_client_secret = "SECRET_MUST_SURVIVE"
EOF
  chmod 600 "$1"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. rewrites the assignment to the new ref
f="$WORK/a.tfvars"; make_fixture "$f"
rewrite_router_image "$f" "$NEW_REF" "$NEW_COMMENT"
if grep -qF "router_image = \"${NEW_REF}\"" "$f"; then
  ok "rewrites router_image to the new digest"
else
  fail "router_image was not rewritten"
fi

# 2. refreshes the provenance comment
if grep -qF "$NEW_COMMENT" "$f" && ! grep -q "sha-0dc73a1" "$f"; then
  ok "refreshes the provenance comment"
else
  fail "provenance comment still names the old tag"
fi

# 3. leaves every other line byte-identical, including the secret
g="$WORK/b.tfvars"; make_fixture "$g"
if diff <(grep -vE '^(router_image|# This digest is tagged)' "$f") \
        <(grep -vE '^(router_image|# This digest is tagged)' "$g") >/dev/null; then
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
mode="$(stat -f '%Lp' "$f" 2>/dev/null || stat -c '%a' "$f")"
if [[ "$mode" == "600" ]]; then
  ok "preserves mode 600"
else
  fail "mode became $mode, expected 600"
fi

# 5. fails without writing when there is no router_image assignment
h="$WORK/c.tfvars"
printf 'location = "australiaeast"\n' >"$h"
before="$(cat "$h")"
if rewrite_router_image "$h" "$NEW_REF" "$NEW_COMMENT" 2>/dev/null; then
  fail "should have refused a tfvars with no router_image"
elif [[ "$(cat "$h")" == "$before" ]]; then
  ok "refuses a tfvars with no router_image, leaving it unchanged"
else
  fail "refused but still modified the file"
fi

# 6. fails without writing when there are two router_image assignments
i="$WORK/d.tfvars"; make_fixture "$i"
printf 'router_image = "%s"\n' "$OLD_REF" >>"$i"
before="$(cat "$i")"
if rewrite_router_image "$i" "$NEW_REF" "$NEW_COMMENT" 2>/dev/null; then
  fail "should have refused a tfvars with two router_image assignments"
elif [[ "$(cat "$i")" == "$before" ]]; then
  ok "refuses two router_image assignments, leaving the file unchanged"
else
  fail "refused but still modified the file"
fi

if [[ "$FAILURES" -gt 0 ]]; then
  echo "${FAILURES} test(s) failed" >&2
  exit 1
fi
echo "all tests passed"
