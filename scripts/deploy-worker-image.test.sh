#!/usr/bin/env bash
# scripts/deploy-worker-image.test.sh — covers rewrite_worker_pin and the
# response/ref parsing helpers in deploy-worker-image.sh.
#
# The rewrite is the part that can corrupt infra/azure/bicep/main.bicepparam — a
# gitignored, mode-600 file that may temporarily hold bootstrap/rotation secrets,
# with no git copy to restore from — and it is also the part carrying the
# pair-atomicity guarantee: workerImage and acaDiskName describe one build, and a
# rewrite that lands one without the other points the router at an image the
# group is not booting.
#
# The parsers are covered because they read a PREVIEW data plane whose responses
# have two shapes each (bare array vs paging envelope; string vs object status),
# and because the Ready gate is the only thing standing between a 2xx that merely
# accepted the request and a parameter file repinned to an image that never
# imported.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy-worker-image.sh
source "${SCRIPT_DIR}/deploy-worker-image.sh"

FAILURES=0
ok()   { echo "ok   — $*"; }
fail() { echo "FAIL — $*" >&2; FAILURES=$((FAILURES + 1)); }

OLD_ROUTER_REF="acrexample.azurecr.io/cyrus-router@sha256:$(printf '3%.0s' {1..64})"
OLD_WORKER_REF="acrexample.azurecr.io/cyrus-worker@sha256:$(printf '7%.0s' {1..64})"
NEW_WORKER_REF="acrexample.azurecr.io/cyrus-worker@sha256:$(printf 'a%.0s' {1..64})"
OLD_DISK="cyrus-worker-sha-a5a9ffc"
NEW_DISK="cyrus-worker-sha-9f49d67"
NEW_COMMENT="// This digest is tagged sha-9f49d67 in acrexample."

make_fixture() {
  cat >"$1" <<EOF
using 'main.bicep'

param location = 'australiaeast'

// ---- Container images -------------------------------------------------------
// This digest is tagged sha-0dc73a1 in acrexample.
param routerImage = '${OLD_ROUTER_REF}'

// This digest is tagged sha-a5a9ffc in acrexample.
param workerImage = '${OLD_WORKER_REF}'

param acaDiskName = '${OLD_DISK}'
param linearClientSecret = 'SECRET_MUST_SURVIVE'
EOF
  chmod 600 "$1"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

################################################################################
# rewrite_worker_pin
################################################################################

# 1. rewrites BOTH halves of the pair
f="$WORK/a.bicepparam"; make_fixture "$f"
rewrite_worker_pin "$f" "$NEW_WORKER_REF" "$NEW_DISK" "$NEW_COMMENT"
if grep -qF "param workerImage = '${NEW_WORKER_REF}'" "$f"; then
  ok "rewrites workerImage to the new digest"
else
  fail "workerImage was not rewritten"
fi
if grep -qF "param acaDiskName = '${NEW_DISK}'" "$f"; then
  ok "rewrites acaDiskName in the same pass"
else
  fail "acaDiskName was not rewritten"
fi

# 2. refreshes workerImage's provenance comment
if grep -qF "$NEW_COMMENT" "$f" && ! grep -q "sha-a5a9ffc" "$f"; then
  ok "refreshes workerImage's provenance comment"
else
  fail "workerImage's provenance comment still names the old tag"
fi

# 3. leaves routerImage's provenance comment alone
#
# The exact mirror of deploy-router-image.test.sh case 7. The identical
# "This digest is tagged … in …" line sits above routerImage; rewriting it would
# make it assert a tag the ROUTER image does not have — a confidently wrong
# comment, worse than the stale one, and it would mislead the manual cross-check
# that caught the 2026-07-31 incident.
if grep -qF '// This digest is tagged sha-0dc73a1 in acrexample.' "$f" \
   && [[ "$(grep -cF "$NEW_COMMENT" "$f")" == "1" ]]; then
  ok "rewrites only workerImage's provenance comment"
else
  fail "routerImage's provenance comment was falsified"
fi

# 4. leaves every other line byte-identical, including routerImage and the secret
#
# The filter drops the three lines the rewrite is ALLOWED to touch: both halves
# of the pair, and workerImage's provenance comment in either its old (…a5a9ffc)
# or rewritten (…9f49d67) form. routerImage's comment (…0dc73a1) is deliberately
# NOT filtered — it has to survive the diff to prove it was left alone.
g="$WORK/b.bicepparam"; make_fixture "$g"
worker_lines="^(param workerImage|param acaDiskName|// This digest is tagged (sha-a5a9ffc|sha-9f49d67))"
if diff <(grep -vE "$worker_lines" "$f") \
        <(grep -vE "$worker_lines" "$g") >/dev/null; then
  ok "leaves all other lines untouched"
else
  fail "unrelated lines changed"
fi
if grep -qF "param routerImage = '${OLD_ROUTER_REF}'" "$f"; then
  ok "leaves routerImage untouched"
else
  fail "routerImage was modified"
fi
if grep -qF 'SECRET_MUST_SURVIVE' "$f"; then
  ok "preserves secret-bearing lines"
else
  fail "a secret line was lost"
fi

# 5. preserves mode 600
#
# GNU first, BSD second — and NOT the other way round. GNU stat's -f means
# --file-system, so `stat -f '%Lp'` SUCCEEDS on Linux and prints a block-device
# report; the `||` fallback never fires and the mode check compares garbage.
mode="$(stat -c '%a' "$f" 2>/dev/null || stat -f '%Lp' "$f")"
if [[ "$mode" == "600" ]]; then
  ok "preserves mode 600"
else
  fail "mode became $mode, expected 600"
fi

# 6. refuses, without writing, when there is no workerImage assignment
h="$WORK/c.bicepparam"
printf "param location = 'australiaeast'\nparam acaDiskName = '%s'\n" "$OLD_DISK" >"$h"
before="$(cat "$h")"
if rewrite_worker_pin "$h" "$NEW_WORKER_REF" "$NEW_DISK" "$NEW_COMMENT" 2>/dev/null; then
  fail "should have refused a parameter file with no workerImage"
elif [[ "$(cat "$h")" == "$before" ]]; then
  ok "refuses a parameter file with no workerImage, leaving it unchanged"
else
  fail "refused but still modified the file"
fi

# 7. refuses, without writing, when there is no acaDiskName assignment
#
# The pair guarantee in its simplest form: rewriting workerImage alone would
# leave the parameter file advertising a build the group cannot boot, because
# acaDiskName still names the previous disk.
i="$WORK/d.bicepparam"
printf "param workerImage = '%s'\n" "$OLD_WORKER_REF" >"$i"
chmod 600 "$i"
before="$(cat "$i")"
if rewrite_worker_pin "$i" "$NEW_WORKER_REF" "$NEW_DISK" "$NEW_COMMENT" 2>/dev/null; then
  fail "should have refused a parameter file with no acaDiskName"
elif [[ "$(cat "$i")" == "$before" ]]; then
  ok "refuses a parameter file with no acaDiskName, leaving it unchanged"
else
  fail "refused but still modified the file"
fi

# 8. refuses two workerImage assignments
j="$WORK/e.bicepparam"; make_fixture "$j"
printf "param workerImage = '%s'\n" "$OLD_WORKER_REF" >>"$j"
before="$(cat "$j")"
if rewrite_worker_pin "$j" "$NEW_WORKER_REF" "$NEW_DISK" "$NEW_COMMENT" 2>/dev/null; then
  fail "should have refused two workerImage assignments"
elif [[ "$(cat "$j")" == "$before" ]]; then
  ok "refuses two workerImage assignments, leaving the file unchanged"
else
  fail "refused but still modified the file"
fi

stub_dir="$WORK/stub-bin"; mkdir -p "$stub_dir"

# 9. leaves the original intact when the rewrite itself fails
#
# The branch whose entire job is protecting the secrets file. `awk` is shadowed
# with a stub that emits a truncated file and exits non-zero — a stand-in for a
# disk-full or OOM-killed awk, whose output would still satisfy the "carries the
# new ref" half of the verification.
#
# Called as `… || true`, mirroring main()'s `… || die`. That form disables
# `set -e` for the whole function body, so a bare call would exercise a safety
# the script does not actually have at the point of use.
k="$WORK/f.bicepparam"; make_fixture "$k"
before="$(cat "$k")"
cat >"$stub_dir/awk" <<'STUB'
#!/usr/bin/env bash
printf "param workerImage = '%s'\nparam acaDiskName = '%s'\n" "$REWRITE_REF" "$REWRITE_DISK"
exit 2
STUB
chmod +x "$stub_dir/awk"

rewrite_rc=0
PATH="$stub_dir:$PATH" rewrite_worker_pin "$k" "$NEW_WORKER_REF" "$NEW_DISK" "$NEW_COMMENT" 2>/dev/null || rewrite_rc=$?
if [[ "$rewrite_rc" -ne 0 ]]; then
  ok "reports failure when the rewrite fails"
else
  fail "returned 0 despite a failed rewrite"
fi
if [[ "$(cat "$k")" == "$before" ]] && grep -qF 'SECRET_MUST_SURVIVE' "$k"; then
  ok "leaves the original byte-identical when the rewrite fails"
else
  fail "a failed rewrite destroyed the secrets file"
fi
residue="$(find "$WORK" -maxdepth 1 -name '.f.bicepparam.tmp.*' | wc -l | tr -d ' ')"
if [[ "$residue" == "0" ]]; then
  ok "leaves no temp residue after a failed rewrite"
else
  fail "left ${residue} temp file(s) beside the parameter file"
fi

# 10. leaves the original intact when the rewrite truncates but exits 0
#
# The other half of the same hazard: a truncation awk does not report. The stub
# emits a file satisfying both content checks, so only the line-count guard
# stands between this and an mv that destroys the secrets.
m="$WORK/g.bicepparam"; make_fixture "$m"
before="$(cat "$m")"
cat >"$stub_dir/awk" <<'STUB'
#!/usr/bin/env bash
printf "param workerImage = '%s'\nparam acaDiskName = '%s'\n" "$REWRITE_REF" "$REWRITE_DISK"
exit 0
STUB
chmod +x "$stub_dir/awk"

rewrite_rc=0
PATH="$stub_dir:$PATH" rewrite_worker_pin "$m" "$NEW_WORKER_REF" "$NEW_DISK" "$NEW_COMMENT" 2>/dev/null || rewrite_rc=$?
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

# 11. refuses a HALF-DONE rewrite — the pair guarantee's real test
#
# This is the failure the line-count guard cannot catch and the "new ref is
# present" check waves through: the stub rewrites workerImage correctly, leaves
# acaDiskName at its old value, and emits exactly the original number of lines.
# Only the explicit acaDiskName verification refuses it.
#
# Left unguarded this is the worst outcome the script can produce — not a
# corrupt file, but a plausible one that pins the router to a new image while
# the group keeps booting the old disk, with nothing downstream able to detect
# the disagreement.
n="$WORK/h.bicepparam"; make_fixture "$n"
before="$(cat "$n")"
cat >"$stub_dir/awk" <<'STUB'
#!/usr/bin/env bash
# Passthrough except for workerImage: same line count, new ref, OLD disk name.
while IFS= read -r line; do
  case "$line" in
    "param workerImage = "*) printf "param workerImage = '%s'\n" "$REWRITE_REF" ;;
    *) printf '%s\n' "$line" ;;
  esac
done < "${@: -1}"
exit 0
STUB
chmod +x "$stub_dir/awk"

rewrite_rc=0
PATH="$stub_dir:$PATH" rewrite_worker_pin "$n" "$NEW_WORKER_REF" "$NEW_DISK" "$NEW_COMMENT" 2>/dev/null || rewrite_rc=$?
if [[ "$rewrite_rc" -ne 0 ]]; then
  ok "refuses a rewrite that moved workerImage without acaDiskName"
else
  fail "accepted a half-done rewrite — the pair can be split"
fi
if [[ "$(cat "$n")" == "$before" ]]; then
  ok "leaves the file unchanged after a half-done rewrite"
else
  fail "a half-done rewrite was written to disk"
fi
rm -f "$stub_dir/awk"

# 12. temp residue would be gitignored
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

################################################################################
# disk_status / disk_base_image — the Ready gate's parsers
################################################################################

# 13. both list envelopes, both status shapes, and labels.name resolution
#
# The bare array and the {"value": […]} envelope are both real (spike S2: small
# lists come back bare, but the SDK's paging helper declares itemName "value", so
# the envelope appears at scale). Matching on labels.name is not a convenience:
# the server assigns its own GUID as `name` and preserves the requested name as a
# label, which is also how the router resolves the operator-configured disk name.
bare_array='[{"name":"other","status":"Ready"},{"name":"cyrus-worker-sha-9f49d67","status":"Ready","image":{"base":"acr.azurecr.io/cyrus-worker@sha256:aa"}}]'
envelope='{"value":[{"name":"srv-guid-1","labels":{"name":"cyrus-worker-sha-9f49d67"},"status":{"state":"Creating"},"image":"acr.azurecr.io/cyrus-worker:sha-9f49d67"}]}'
empty_array='[]'

check_status() {
  local label="$1" json="$2" name="$3" expected="$4" actual
  actual="$(disk_status "$json" "$name")"
  if [[ "$actual" == "$expected" ]]; then
    ok "disk_status ${label} => '${actual}'"
  else
    fail "disk_status ${label} => '${actual}', expected '${expected}'"
  fi
}
check_status "bare array, string status" "$bare_array" "cyrus-worker-sha-9f49d67" "Ready"
check_status "envelope, object status, labels.name" "$envelope" "cyrus-worker-sha-9f49d67" "Creating"
check_status "absent from a bare array" "$bare_array" "cyrus-worker-nope" ""
check_status "absent from an envelope" "$envelope" "cyrus-worker-nope" ""
check_status "empty list" "$empty_array" "cyrus-worker-sha-9f49d67" ""

check_base() {
  local label="$1" json="$2" name="$3" expected="$4" actual
  actual="$(disk_base_image "$json" "$name")"
  if [[ "$actual" == "$expected" ]]; then
    ok "disk_base_image ${label} => '${actual}'"
  else
    fail "disk_base_image ${label} => '${actual}', expected '${expected}'"
  fi
}
check_base "object image" "$bare_array" "cyrus-worker-sha-9f49d67" "acr.azurecr.io/cyrus-worker@sha256:aa"
check_base "string image" "$envelope" "cyrus-worker-sha-9f49d67" "acr.azurecr.io/cyrus-worker:sha-9f49d67"
check_base "absent" "$bare_array" "cyrus-worker-nope" ""

# 14. a disk with no readable image field yields empty rather than erroring
#
# main() treats empty as "unknown, warn and continue" but a NON-empty mismatch as
# fatal. If this returned garbage instead of empty, a name collision with a
# different image would be reported as a mismatch against nonsense — or worse,
# compare equal.
no_image='[{"name":"cyrus-worker-sha-9f49d67","status":"Ready"}]'
check_base "missing image field" "$no_image" "cyrus-worker-sha-9f49d67" ""

################################################################################
# derive_disk_suffix
################################################################################

# 15. names the disk after the build it holds
check_suffix() {
  local ref="$1" expected="$2" actual rc=0
  actual="$(derive_disk_suffix "$ref")" || rc=$?
  if [[ "$rc" -eq 0 && "$actual" == "$expected" ]]; then
    ok "derive_disk_suffix ${ref} => '${actual}'"
  else
    fail "derive_disk_suffix ${ref} => '${actual}' (rc ${rc}), expected '${expected}'"
  fi
}
check_suffix "acrexample.azurecr.io/cyrus-worker:sha-6de8aff" "sha-6de8aff"
check_suffix "acrexample.azurecr.io/cyrus-worker:sha-6de8aff-dirty-20260806T101500Z" "sha-6de8aff-dirty-20260806T101500Z"
check_suffix "acrexample.azurecr.io/cyrus-worker@sha256:$(printf 'a%.0s' {1..64})" "daaaaaaaaaaaa"

# A registry host may carry a port, which is a colon that is NOT a tag
# separator. Splitting on the last path segment first is what keeps
# `localhost:5000/cyrus-worker` from being read as tag `5000/cyrus-worker`.
if derive_disk_suffix "localhost:5000/cyrus-worker" >/dev/null 2>&1; then
  fail "derive_disk_suffix read a registry port as a tag"
else
  ok "derive_disk_suffix refuses an untagged ref with a port in the host"
fi
check_suffix "localhost:5000/cyrus-worker:sha-6de8aff" "sha-6de8aff"

################################################################################
# main() — the registration flow, with the Azure calls stubbed
################################################################################

# 16. end-to-end over --image: the raw PUT, the Ready gate, and the pair rewrite
#
# main() is where the orchestration lives, and none of it is reachable from the
# unit tests above. The --image path is used because it skips the build and the
# git checks while still exercising everything that matters: the registry guard,
# the media-type check, the disk-name derivation, the deployment-output read, the
# PUT, the Ready poll, the pair rewrite, and the handoff.
#
# Both credentials are asserted to travel OFF argv. A bearer token or an ACR
# refresh token in argv is readable by any process that can run `ps` for the
# whole life of the call — and the import is a call that can run for minutes.
E2E="$WORK/e2e"; mkdir -p "$E2E/bin"
cp "${SCRIPT_DIR}/deploy-worker-image.sh" "$E2E/bin/"
cat >"$E2E/bin/deploy-azure.sh" <<'STUB'
#!/usr/bin/env bash
echo "what-if stub invoked with PARAMS=${PARAMS}"
STUB
chmod +x "$E2E/bin/deploy-azure.sh"

E2E_REF="acrexample.azurecr.io/cyrus-worker@sha256:$(printf 'b%.0s' {1..64})"
E2E_DISK="cyrus-worker-dbbbbbbbbbbbb"

cat >"$E2E/bin/az" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$@" >>"\$AZ_ARGV_LOG"
case "\$1 \$2" in
  "account show")
    [[ "\$*" == *"--query id"* ]] && { echo "sub-1234"; exit 0; }
    exit 0 ;;
  "account get-access-token")
    [[ "\$*" == *"https://dynamicsessions.io"* ]] || { echo "wrong audience" >&2; exit 1; }
    echo "ACA-BEARER-TOKEN"; exit 0 ;;
  "acr login")   echo "ACR-REFRESH-TOKEN"; exit 0 ;;
  "acr manifest") echo "application/vnd.docker.distribution.manifest.v2+json"; exit 0 ;;
  "deployment sub")
    echo '{"resourceGroupName":{"value":"rg-cyrus"},"sandboxGroupName":{"value":"sg-cyrus"},"managementEndpoint":{"value":"https://management.australiaeast.azuredevcompute.io"}}'
    exit 0 ;;
esac
exit 0
STUB
chmod +x "$E2E/bin/az"

cat >"$E2E/bin/curl" <<STUB
#!/usr/bin/env bash
cat >>"\$CURL_CONFIG_LOG"
printf '%s\n' "\$@" >>"\$CURL_ARGV_LOG"
method=GET; outfile=""; body=""
args=("\$@")
for ((i=0; i<\${#args[@]}; i++)); do
  case "\${args[i]}" in
    --request)     method="\${args[i+1]}" ;;
    --output)      outfile="\${args[i+1]}" ;;
    --data-binary) body="\${args[i+1]}" ;;
    http*)         printf '%s\n' "\${args[i]}" >>"\$CURL_URL_LOG" ;;
  esac
done
if [[ "\$method" == "PUT" ]]; then
  cp "\${body#@}" "\$CURL_BODY_COPY"
  : >"\$CURL_STATE"
  [[ -n "\$outfile" ]] && printf '{}' >"\$outfile"
  printf '201'
  exit 0
fi
if [[ -e "\$CURL_STATE" ]]; then
  printf '[{"name":"srv-guid","labels":{"name":"%s"},"status":{"state":"%s"},"image":{"base":"%s"}}]' \\
    "\$E2E_DISK" "\${CURL_STUCK_STATE:-Ready}" "\$E2E_REF"
else
  printf '[]'
fi
exit 0
STUB
chmod +x "$E2E/bin/curl"

e2e_params="$E2E/main.bicepparam"
make_fixture "$e2e_params"
printf "param project = 'cyrus'\nparam environment = 'dev'\n" >>"$e2e_params"

e2e_out="$E2E/stdout"; e2e_rc=0
env PATH="$E2E/bin:$PATH" \
    AZ_ARGV_LOG="$E2E/az-argv" CURL_ARGV_LOG="$E2E/curl-argv" \
    CURL_CONFIG_LOG="$E2E/curl-config" CURL_URL_LOG="$E2E/curl-urls" \
    CURL_BODY_COPY="$E2E/put-body.json" CURL_STATE="$E2E/registered" \
    E2E_DISK="$E2E_DISK" E2E_REF="$E2E_REF" \
    PARAMS="$e2e_params" READY_POLL_INTERVAL=1 \
    bash "$E2E/bin/deploy-worker-image.sh" --image "$E2E_REF" >"$e2e_out" 2>&1 || e2e_rc=$?

if [[ "$e2e_rc" -eq 0 ]]; then
  ok "end-to-end registration succeeds"
else
  fail "end-to-end registration exited ${e2e_rc}"
  sed 's/^/       /' "$e2e_out" >&2
fi

if grep -qF "param workerImage = '${E2E_REF}'" "$e2e_params" \
   && grep -qF "param acaDiskName = '${E2E_DISK}'" "$e2e_params"; then
  ok "repins workerImage and acaDiskName after Ready"
else
  fail "the parameter file was not repinned"
fi
if grep -qF 'SECRET_MUST_SURVIVE' "$e2e_params"; then
  ok "the secret survives the end-to-end run"
else
  fail "the secret was lost by the end-to-end run"
fi

# The PUT goes to the lowercase /diskimages route on the ARM-emitted data-plane
# host — not a string-templated management.{region} host, and not /diskImages.
if grep -qF 'https://management.australiaeast.azuredevcompute.io/subscriptions/sub-1234/resourceGroups/rg-cyrus/sandboxGroups/sg-cyrus/diskimages' "$E2E/curl-urls"; then
  ok "PUTs to the ARM-emitted endpoint's /diskimages route"
else
  fail "the disk-image URL is wrong"
  sed 's/^/       /' "$E2E/curl-urls" >&2
fi

# The body's SHAPE, asserted whole rather than field by field.
#
# This is the assertion NOR-337 needed and did not have. The previous version
# checked that the credential field was named `token` rather than `password`, and
# that the name, base and credentials were all present somewhere — every one of
# which was true of the body that shipped, which nested `registryCredentials`
# inside `image` and put the name at the top level, and which failed 100% of the
# time with `401 RegistryAuthFailed`. A misplaced key is invisible to a lookup
# that already knows where to look, so the whole object is compared against the
# one `aca sandboxgroup disk create` sends.
expected_body="$(jq -Sn --arg n "$E2E_DISK" --arg b "$E2E_REF" \
  '{labels:{name:$n},
    image:{base:$b},
    registryCredentials:{username:"00000000-0000-0000-0000-000000000000",
                         token:"ACR-REFRESH-TOKEN"}}')"
if [[ "$(jq -S . "$E2E/put-body.json")" == "$expected_body" ]]; then
  ok "PUT body matches the CLI's request shape exactly"
else
  fail "the PUT body does not match the CLI's request shape"
  # `|| true` because of `set -o pipefail`: diff exits 1 on a difference, which
  # here is the expected case, and an unguarded pipeline would abort the run at
  # the first shape failure — hiding the two named checks below, which are the
  # ones that say WHY.
  { diff <(printf '%s\n' "$expected_body") <(jq -S . "$E2E/put-body.json") \
    | sed 's/^/       /' >&2; } || true
fi

# The two placements the whole-object diff would report only as noise, named
# individually so a regression says what is actually wrong.
#
# Nested inside `image`, the credentials are never read: the service attempts an
# anonymous pull against a private ACR and returns a 401 asking for the field
# that was sent, within seconds and identically for every credential value.
if [[ "$(jq -r 'has("registryCredentials")' "$E2E/put-body.json")" == "true" ]] \
   && [[ "$(jq -r '.image | has("registryCredentials")' "$E2E/put-body.json")" == "false" ]]; then
  ok "registryCredentials is a sibling of image, not nested inside it"
else
  fail "registryCredentials is nested inside image — the service never reads it"
  sed 's/^/       /' "$E2E/put-body.json" >&2
fi
# `labels.name` is what the server preserves; `name` it assigns itself. This is
# the same field disk_status() reads back, and the reader has always matched it.
if [[ "$(jq -r '.labels.name' "$E2E/put-body.json")" == "$E2E_DISK" ]] \
   && [[ "$(jq -r 'has("name")' "$E2E/put-body.json")" == "false" ]]; then
  ok "the requested disk name travels in labels.name"
else
  fail "the requested disk name is not in labels.name"
  sed 's/^/       /' "$E2E/put-body.json" >&2
fi

if grep -q 'ACA-BEARER-TOKEN' "$E2E/curl-argv" || grep -q 'ACR-REFRESH-TOKEN' "$E2E/curl-argv"; then
  fail "a credential was passed on curl's argv — readable via ps"
else
  ok "no credential reaches curl's argv"
fi
if grep -q 'ACA-BEARER-TOKEN' "$E2E/curl-config"; then
  ok "the bearer token travels via --config on stdin"
else
  fail "the bearer token never reached curl"
fi

# 17. a second run over the same image re-registers nothing and rewrites nothing
#
# Idempotency matters here because the expensive step is a multi-minute import
# that cannot be cancelled: a re-run after an interrupted deploy must not start
# a second one.
: >"$E2E/curl-argv"; : >"$E2E/put-body.json"
e2e_rc=0
env PATH="$E2E/bin:$PATH" \
    AZ_ARGV_LOG="$E2E/az-argv" CURL_ARGV_LOG="$E2E/curl-argv" \
    CURL_CONFIG_LOG="$E2E/curl-config" CURL_URL_LOG="$E2E/curl-urls" \
    CURL_BODY_COPY="$E2E/put-body.json" CURL_STATE="$E2E/registered" \
    E2E_DISK="$E2E_DISK" E2E_REF="$E2E_REF" \
    PARAMS="$e2e_params" READY_POLL_INTERVAL=1 \
    bash "$E2E/bin/deploy-worker-image.sh" --image "$E2E_REF" >"$e2e_out" 2>&1 || e2e_rc=$?

if [[ "$e2e_rc" -eq 0 ]] && ! grep -q -- '--request' "$E2E/curl-argv"; then
  ok "a re-run skips the import when the disk is already registered"
else
  fail "a re-run issued a second import"
  sed 's/^/       /' "$e2e_out" >&2
fi
if grep -qF 'already pins this image and disk' "$e2e_out"; then
  ok "a re-run leaves the parameter file alone"
else
  fail "a re-run rewrote an already-current parameter file"
fi

# 18. a disk name already taken by a DIFFERENT image is refused
#
# The name is what the group boots. Reusing it for another build would pin the
# parameter file to one image and boot another, with nothing downstream able to
# detect the disagreement.
other_params="$E2E/other.bicepparam"; make_fixture "$other_params"
printf "param project = 'cyrus'\nparam environment = 'dev'\n" >>"$other_params"
other_ref="acrexample.azurecr.io/cyrus-worker@sha256:$(printf 'c%.0s' {1..64})"
e2e_rc=0
env PATH="$E2E/bin:$PATH" \
    AZ_ARGV_LOG="$E2E/az-argv" CURL_ARGV_LOG="$E2E/curl-argv" \
    CURL_CONFIG_LOG="$E2E/curl-config" CURL_URL_LOG="$E2E/curl-urls" \
    CURL_BODY_COPY="$E2E/put-body.json" CURL_STATE="$E2E/registered" \
    E2E_DISK="$E2E_DISK" E2E_REF="$E2E_REF" \
    PARAMS="$other_params" READY_POLL_INTERVAL=1 \
    bash "$E2E/bin/deploy-worker-image.sh" --image "$other_ref" --disk-name "$E2E_DISK" \
    >"$e2e_out" 2>&1 || e2e_rc=$?
if [[ "$e2e_rc" -ne 0 ]] && grep -qF 'registered from a different image' "$e2e_out"; then
  ok "refuses a disk name already holding a different image"
else
  fail "reused a disk name across two different images"
  sed 's/^/       /' "$e2e_out" >&2
fi

# 19. an image outside the target registry is refused before any token is minted
#
# The ACR token is scoped to REGISTRY; an image elsewhere fails server-side with
# an auth error that reads like a permissions problem rather than a wrong
# argument.
e2e_rc=0
env PATH="$E2E/bin:$PATH" \
    AZ_ARGV_LOG="$E2E/az-argv" CURL_ARGV_LOG="$E2E/curl-argv" \
    CURL_CONFIG_LOG="$E2E/curl-config" CURL_URL_LOG="$E2E/curl-urls" \
    CURL_BODY_COPY="$E2E/put-body.json" CURL_STATE="$E2E/registered" \
    E2E_DISK="$E2E_DISK" E2E_REF="$E2E_REF" \
    PARAMS="$other_params" READY_POLL_INTERVAL=1 \
    bash "$E2E/bin/deploy-worker-image.sh" --image "ghcr.io/ceedaragents/cyrus-worker:sha-6de8aff" \
    >"$e2e_out" 2>&1 || e2e_rc=$?
if [[ "$e2e_rc" -ne 0 ]] && grep -qF 'is not in registry' "$e2e_out"; then
  ok "refuses an image outside the target registry"
else
  fail "accepted an image from another registry"
  sed 's/^/       /' "$e2e_out" >&2
fi

# 20. an import that never reaches Ready fails, and repins NOTHING
#
# The requirement the issue states outright: gate on `Ready`, not on the exit
# code. A 2xx from the PUT says the request was accepted, not that the image
# imported — the same weakness that makes `aca sandboxgroup disk create | tail`
# report the pipeline's status and read a failed import as success.
#
# The second assertion is the one that matters. Failing loudly is not enough: if
# the parameter file were repinned before Ready, the next deployment would
# advertise an image whose disk does not exist, and the fleet would fail to boot
# with an error pointing at the sandbox group rather than at this script.
stuck_params="$E2E/stuck.bicepparam"; make_fixture "$stuck_params"
printf "param project = 'cyrus'\nparam environment = 'dev'\n" >>"$stuck_params"
stuck_before="$(cat "$stuck_params")"
stuck_ref="acrexample.azurecr.io/cyrus-worker@sha256:$(printf 'e%.0s' {1..64})"
e2e_rc=0
env PATH="$E2E/bin:$PATH" \
    AZ_ARGV_LOG="$E2E/az-argv" CURL_ARGV_LOG="$E2E/curl-argv" \
    CURL_CONFIG_LOG="$E2E/curl-config" CURL_URL_LOG="$E2E/curl-urls" \
    CURL_BODY_COPY="$E2E/put-body.json" CURL_STATE="$E2E/stuck-state" \
    CURL_STUCK_STATE="Creating" \
    E2E_DISK="cyrus-worker-deeeeeeeeeeee" E2E_REF="$stuck_ref" \
    PARAMS="$stuck_params" READY_TIMEOUT=2 READY_POLL_INTERVAL=1 \
    bash "$E2E/bin/deploy-worker-image.sh" --image "$stuck_ref" >"$e2e_out" 2>&1 || e2e_rc=$?
if [[ "$e2e_rc" -ne 0 ]] && grep -qF 'did not reach Ready' "$e2e_out"; then
  ok "fails when the import never reaches Ready"
else
  fail "treated a non-Ready disk as a successful import"
  sed 's/^/       /' "$e2e_out" >&2
fi
if [[ "$(cat "$stuck_params")" == "$stuck_before" ]]; then
  ok "repins nothing when the import never reaches Ready"
else
  fail "repinned the parameter file to an image that never imported"
fi

# 21. a disk that reports Failed is refused immediately, not waited out
#
# READY_TIMEOUT is deliberately long here: the assertion is that a Failed import
# is surfaced by the state machine rather than by the deadline expiring. The
# `timeout` wrapper is what turns "waited it out" into a test FAILURE instead of
# a ten-minute hang — which is exactly what an earlier draft of this case did
# when its stub disk name did not match the one derived from the ref.
e2e_rc=0
env PATH="$E2E/bin:$PATH" \
    AZ_ARGV_LOG="$E2E/az-argv" CURL_ARGV_LOG="$E2E/curl-argv" \
    CURL_CONFIG_LOG="$E2E/curl-config" CURL_URL_LOG="$E2E/curl-urls" \
    CURL_BODY_COPY="$E2E/put-body.json" CURL_STATE="$E2E/failed-state" \
    CURL_STUCK_STATE="Failed" \
    E2E_DISK="cyrus-worker-deeeeeeeeeeee" E2E_REF="$stuck_ref" \
    PARAMS="$stuck_params" READY_TIMEOUT=600 READY_POLL_INTERVAL=1 \
    timeout 30 bash "$E2E/bin/deploy-worker-image.sh" --image "$stuck_ref" >"$e2e_out" 2>&1 || e2e_rc=$?
if [[ "$e2e_rc" -eq 124 ]]; then
  fail "waited out the deadline instead of failing fast on a Failed disk"
elif [[ "$e2e_rc" -ne 0 ]] && grep -qF "reached state 'Failed'" "$e2e_out"; then
  ok "fails fast on a Failed disk rather than waiting out the deadline"
else
  fail "did not surface a Failed import"
  sed 's/^/       /' "$e2e_out" >&2
fi

# 22. an OCI image index is refused
#
# Recent `docker buildx --push` attaches provenance/SBOM attestations by default,
# which makes the push an index carrying an `unknown/unknown` attestation child.
# The importer cannot consume one, and the failure it produces downstream is the
# same opaque timeout-shaped error this whole script exists to disambiguate.
cat >"$E2E/bin/az" <<'STUB'
#!/usr/bin/env bash
case "$1 $2" in
  "account show")
    [[ "$*" == *"--query id"* ]] && { echo "sub-1234"; exit 0; }
    exit 0 ;;
  "acr manifest") echo "application/vnd.oci.image.index.v1+json"; exit 0 ;;
esac
exit 0
STUB
chmod +x "$E2E/bin/az"
e2e_rc=0
env PATH="$E2E/bin:$PATH" PARAMS="$other_params" \
    bash "$E2E/bin/deploy-worker-image.sh" --image "$other_ref" >"$e2e_out" 2>&1 || e2e_rc=$?
if [[ "$e2e_rc" -ne 0 ]] && grep -qF 'cannot consume an OCI image index' "$e2e_out"; then
  ok "refuses an OCI image index"
else
  fail "accepted an OCI image index"
  sed 's/^/       /' "$e2e_out" >&2
fi

if [[ "$FAILURES" -gt 0 ]]; then
  echo "${FAILURES} test(s) failed" >&2
  exit 1
fi
echo "all tests passed"
