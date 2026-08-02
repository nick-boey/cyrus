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

# 7. leaves worker_image's provenance comment alone
#
# The same "# This digest is tagged … in …" line sits above worker_image. A
# rewrite anchored only to line-start replaces that one too, making it assert a
# tag the worker image does not have — a confidently wrong comment, which is
# worse than the stale one this script exists to refresh, and would mislead the
# manual cross-check that caught the 2026-07-31 incident.
j="$WORK/e.tfvars"
cat >"$j" <<EOF
# This digest is tagged sha-0dc73a1 in acrcyrusdev.
router_image = "${OLD_REF}"

# This digest is tagged sha-a5a9ffc in acrcyrusdev.
worker_image = "acrcyrusdev.azurecr.io/cyrus-worker:sha-a5a9ffc"
EOF
chmod 600 "$j"
rewrite_router_image "$j" "$NEW_REF" "$NEW_COMMENT"
if grep -qF '# This digest is tagged sha-a5a9ffc in acrcyrusdev.' "$j" \
   && [[ "$(grep -cF "$NEW_COMMENT" "$j")" == "1" ]]; then
  ok "rewrites only router_image's provenance comment"
else
  fail "worker_image's provenance comment was falsified"
fi

# 8. leaves the original intact when the rewrite itself fails
#
# This is the branch whose entire job is protecting the secrets file, and it was
# the one branch with no coverage. `awk` is shadowed on PATH with a stub that
# emits a truncated file and exits non-zero — a stand-in for a disk-full or
# OOM-killed awk, whose output would still satisfy the "exactly one
# router_image line, and it carries the new ref" verification.
#
# Called the way main() calls it — `… || true`, mirroring `… || die`. That form
# disables `set -e` for the whole function body, so a bare call would exercise a
# safety this script never actually has at the point of use.
k="$WORK/f.tfvars"; make_fixture "$k"
before="$(cat "$k")"
stub_dir="$WORK/stub-bin"; mkdir -p "$stub_dir"
cat >"$stub_dir/awk" <<STUB
#!/usr/bin/env bash
printf '# This digest is tagged sha-9f49d67 in acrcyrusdev.\nrouter_image = "%s"\n' "\$REWRITE_REF"
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
residue="$(find "$WORK" -maxdepth 1 -name '.f.tfvars.tmp.*' | wc -l | tr -d ' ')"
if [[ "$residue" == "0" ]]; then
  ok "leaves no temp residue after a failed rewrite"
else
  fail "left ${residue} temp file(s) beside the tfvars"
fi

# 9. leaves the original intact when the rewrite truncates but exits 0
#
# The other half of the same hazard: a truncation that awk does not report. The
# stub emits a file that satisfies both existing checks — exactly one
# router_image line, and it carries the new ref — so only the line-count guard
# stands between this and an mv that destroys the secrets.
m="$WORK/g.tfvars"; make_fixture "$m"
before="$(cat "$m")"
cat >"$stub_dir/awk" <<STUB
#!/usr/bin/env bash
printf 'router_image = "%s"\n' "\$REWRITE_REF"
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
# The temp file is a mode-600 copy of the secrets. If a SIGKILL outruns the EXIT
# trap, the residue must not be one `git add -A` from being committed.
probe="$(cd "$SCRIPT_DIR/.." && git check-ignore -q "infra/azure/terraform/env/.dev.tfvars.tmp.aB12cD" && echo ignored || echo NOT_IGNORED)"
if [[ "$probe" == "ignored" ]]; then
  ok "temp file name is gitignored"
else
  fail "temp file name is NOT gitignored"
fi

if [[ "$FAILURES" -gt 0 ]]; then
  echo "${FAILURES} test(s) failed" >&2
  exit 1
fi
echo "all tests passed"
