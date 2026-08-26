#!/usr/bin/env bash
# scripts/deploy-worker-image.sh — build the worker image into ACR, register it
# as an ACA group disk image, repin the Bicep parameter file, and show the
# what-if.
#
# The sibling of scripts/deploy-router-image.sh, for the other half of the
# stack. It exists for two reasons the router script does not have:
#
#   1. `aca sandboxgroup disk create` CANNOT REGISTER THE WORKER IMAGE ANY MORE.
#      The `PUT …/diskimages` import is synchronous and its duration scales with
#      image size, while the preview CLI abandons each attempt at ~60 s (two
#      attempts, ~120 s total) and reports the result as
#      `Error: Network issue — retry policy expired`. Measured on this image:
#      1.02 GB compressed imported in ~18 s, 1.71 GB took 99 s. Everything past
#      roughly 1 GB is now over the ceiling. So registration here is a raw PUT
#      with a deadline we choose (RAW_PUT_TIMEOUT, default 900 s — the same
#      SLOW_OPERATION_TIMEOUT_MS the router's own ACA client uses for
#      whole-image operations), and it is issued ONCE. It is deliberately not
#      retried: an aborted client does not abort the server-side import, so a
#      retry races a running import rather than replacing it.
#
#   2. THE IMAGE AND ITS DISK NAME MUST MOVE AS A PAIR. `workerImage` is what
#      the router advertises to containers; `acaDiskName` is the name the group
#      actually boots. They are two separate parameters describing one build, so
#      a rewrite that lands one without the other points the fleet at an image
#      it is not running. Both are written in a single verified rewrite, or
#      neither is.
#
# Read NOR-295 for the incident: `sha-d7fb6a3` was built on 2026-08-06 and
# silently never deployed, because the CLI's error reads as a network blip and
# the runbook advised retrying later. The worker sat on a build from four days
# earlier while the router moved ahead.
#
# Stops at the what-if. It never deploys.
set -euo pipefail

# The audience is NOT https://management.azure.com/. The ACA sandboxes data
# plane kept the `dynamicsessions.io` resource URI from its dynamic-sessions
# lineage; the management audience yields a token the endpoint answers with 401.
# Mirrors ACA_TOKEN_AUDIENCE in packages/router-executors/src/aca/tokenProvider.ts.
ACA_TOKEN_RESOURCE="https://dynamicsessions.io"

# Matches AcaSandboxClient's default. Per spike finding S2 the service does not
# actually enforce it (`?api-version=1999-01-01` returns 200), so this is a
# label rather than a safety mechanism — but send the one the client sends.
API_VERSION="${API_VERSION:-2026-02-01-preview}"

# ACR's token endpoint issues a refresh token against this well-known null GUID
# rather than a real username.
ACR_TOKEN_USERNAME="00000000-0000-0000-0000-000000000000"

# Every worker disk that has ever imported successfully is a plain Docker v2
# manifest. An OCI image index — what recent `docker buildx --push` produces by
# default, because it attaches provenance/SBOM attestations — cannot be consumed
# by the importer.
EXPECTED_MEDIA_TYPE="application/vnd.docker.distribution.manifest.v2+json"

RAW_PUT_TIMEOUT="${RAW_PUT_TIMEOUT:-900}"
READY_TIMEOUT="${READY_TIMEOUT:-900}"
READY_POLL_INTERVAL="${READY_POLL_INTERVAL:-10}"

REPO="${REPO:-cyrus-worker}"
PARAMS="${PARAMS:-infra/azure/bicep/main.bicepparam}"
DISK_PREFIX="${DISK_PREFIX:-cyrus-worker}"

die() { echo "error: $*" >&2; exit 1; }

# Scratch lives outside the repository: the disk-image request body carries an
# ACR refresh token, and a mode-600 copy of it must not be one `git add -A` from
# a commit even if a SIGKILL outruns the EXIT trap.
SCRATCH=""
TMP_PARAMS=""
cleanup() {
  [[ -n "$SCRATCH" && -d "$SCRATCH" ]] && rm -rf "$SCRATCH"
  [[ -n "$TMP_PARAMS" && -e "$TMP_PARAMS" ]] && rm -f "$TMP_PARAMS"
  return 0
}

# worker_param_value <name> — read a scalar `param <name> = '<value>'` out of the
# .bicepparam.
#
# Deliberately a local copy of deploy-azure.sh's param_value rather than a
# `source` of that script: sourcing it would also import its `die` and `usage`,
# silently replacing this script's own. Both readers are the same three-line sed
# and neither is ever used to WRITE the file.
worker_param_value() {
  sed -nE "s/^[[:space:]]*param[[:space:]]+$1[[:space:]]*=[[:space:]]*'?([^'#]*)'?.*$/\1/p" "$PARAMS" \
    | head -1 | sed -E 's/[[:space:]]+$//'
}

# rewrite_worker_pin <params_path> <new_image_ref> <new_disk_name> <provenance_comment>
#
# Rewrites `param workerImage` and `param acaDiskName` together, and replaces the
# "This digest is tagged … in …" comment belonging to workerImage with
# <provenance_comment>, leaving every other line byte-identical.
#
# Same protocol as deploy-router-image.sh's rewrite_router_image, and for the
# same reason: the target is gitignored, mode 600, and may temporarily hold
# bootstrap/rotation secrets, with no git copy to restore from. New content is
# built in a mode-600 temp file beside it, verified, and only then moved into
# place. Any failure leaves the original untouched.
#
# The atomicity is the point. A partial rewrite here — new image, old disk name —
# is worse than no rewrite at all: it deploys a router that advertises one build
# while the group boots another, and nothing downstream can detect the
# disagreement.
rewrite_worker_pin() {
  local params="$1" new_ref="$2" new_disk="$3" comment="$4"
  local count

  count="$(grep -cE '^[[:space:]]*param[[:space:]]+workerImage[[:space:]]*=' "$params" || true)"
  if [[ "$count" != "1" ]]; then
    echo "error: expected exactly one 'param workerImage' assignment in ${params}, found ${count}" >&2
    return 1
  fi
  count="$(grep -cE '^[[:space:]]*param[[:space:]]+acaDiskName[[:space:]]*=' "$params" || true)"
  if [[ "$count" != "1" ]]; then
    echo "error: expected exactly one 'param acaDiskName' assignment in ${params}, found ${count}" >&2
    return 1
  fi

  # Dot-prefixed and matching .gitignore's `*.bicepparam.tmp.*`. It cannot simply
  # end in `.bicepparam`: BSD mktemp only substitutes a TRAILING run of X's, so
  # `.tmp.XXXXXX.bicepparam` silently yields that literal, non-unique name on
  # macOS.
  if ! TMP_PARAMS="$(mktemp "$(dirname "$params")/.$(basename "$params").tmp.XXXXXX")" \
     || [[ -z "$TMP_PARAMS" ]] || ! chmod 600 "$TMP_PARAMS"; then
    cleanup
    TMP_PARAMS=""
    echo "error: could not create a temp file beside ${params}; left unchanged" >&2
    return 1
  fi

  # The provenance comment needs more than a line-start anchor: the identical
  # "This digest is tagged … in …" line sits above routerImage, and rewriting
  # THAT one would make it assert a tag the router image does not have. This is
  # the exact mirror of the hazard deploy-router-image.sh guards in the other
  # direction. So comments are buffered and only the run belonging to
  # workerImage — the lines since the previous assignment — is rewritten.
  #
  # awk's status is checked by hand because `set -e` is disabled for this whole
  # function body when it is called as `rewrite_worker_pin … || die`. Without
  # that check an awk killed partway through (disk full, OOM) would leave a
  # truncated file, and the mv would destroy the only copy of the secrets.
  if ! REWRITE_REF="$new_ref" REWRITE_DISK="$new_disk" REWRITE_COMMENT="$comment" awk '
    function flush_pending(   i) {
      for (i = 1; i <= pending_n; i++) print pending[i]
      pending_n = 0
    }
    /^[[:space:]]*param[[:space:]]+[[:alpha:]_][[:alnum:]_]*[[:space:]]*=/ {
      if ($0 ~ /^[[:space:]]*param[[:space:]]+workerImage[[:space:]]*=/) {
        for (i = 1; i <= pending_n; i++) {
          if (pending[i] ~ /^[[:space:]]*\/\/[[:space:]]*This digest is tagged .* in .*/)
            pending[i] = ENVIRON["REWRITE_COMMENT"]
          print pending[i]
        }
        pending_n = 0
        print "param workerImage = \x27" ENVIRON["REWRITE_REF"] "\x27"
        seen_image++
        next
      }
      if ($0 ~ /^[[:space:]]*param[[:space:]]+acaDiskName[[:space:]]*=/) {
        flush_pending()
        print "param acaDiskName = \x27" ENVIRON["REWRITE_DISK"] "\x27"
        seen_disk++
        next
      }
      flush_pending()
      print
      next
    }
    { pending[++pending_n] = $0 }
    END {
      flush_pending()
      # Both halves of the pair, or the caller gets a non-zero status and the
      # original file. awk asserts this itself rather than trusting the greps
      # above, because this is the branch that must never half-succeed.
      if (seen_image != 1 || seen_disk != 1) exit 3
    }
  ' "$params" >"$TMP_PARAMS"; then
    cleanup
    TMP_PARAMS=""
    echo "error: rewrite failed; ${params} left unchanged" >&2
    return 1
  fi

  # Catches a truncation awk did not report — the rewrite is strictly
  # line-for-line, so any change in line count means content was lost. It also
  # fires if the original lacks a trailing newline, since awk adds one. That is a
  # refusal rather than a corruption, which is the right way to be wrong about a
  # file with no backup: end the last line with a newline.
  if [[ "$(wc -l <"$TMP_PARAMS")" != "$(wc -l <"$params")" ]]; then
    cleanup
    TMP_PARAMS=""
    echo "error: rewrite changed the line count; ${params} left unchanged" >&2
    return 1
  fi

  local image_count disk_count
  image_count="$(grep -cE '^[[:space:]]*param[[:space:]]+workerImage[[:space:]]*=' "$TMP_PARAMS" || true)"
  disk_count="$(grep -cE '^[[:space:]]*param[[:space:]]+acaDiskName[[:space:]]*=' "$TMP_PARAMS" || true)"
  if [[ "$image_count" != "1" ]] || [[ "$disk_count" != "1" ]] \
     || ! grep -qF "param workerImage = '${new_ref}'" "$TMP_PARAMS" \
     || ! grep -qF "param acaDiskName = '${new_disk}'" "$TMP_PARAMS"; then
    cleanup
    TMP_PARAMS=""
    echo "error: rewrite verification failed; ${params} left unchanged" >&2
    return 1
  fi

  mv "$TMP_PARAMS" "$params"
  TMP_PARAMS=""
}

# disk_status <diskimages-json> <name> — print the state of the named disk, or
# nothing if it is absent.
#
# Two wire shapes have to be tolerated, both observed in spike S2:
#   - the list is a bare JSON array at small sizes, but the SDK's paging helper
#     declares `itemName: "value"`, so the envelope form appears at scale;
#   - `status` is either a bare string or `{state, errorMessage}`.
# The name is matched against `labels.name` as well as `name`, because the server
# assigns its own GUID as `name` and preserves the requested name as a label —
# which is also how the router resolves the operator-configured disk name.
disk_status() {
  jq -r --arg n "$2" '
    (if type == "array" then . else (.value // []) end)
    | map(select(.name == $n or (.labels.name? // "") == $n))
    | .[0] // empty
    | .status
    | if type == "object" then (.state // "") else (. // "") end
  ' <<<"$1"
}

# disk_base_image <diskimages-json> <name> — print the image ref the named disk
# was registered from, or nothing if absent/unreadable.
disk_base_image() {
  jq -r --arg n "$2" '
    (if type == "array" then . else (.value // []) end)
    | map(select(.name == $n or (.labels.name? // "") == $n))
    | .[0] // empty
    | .image
    | if type == "object" then (.base // "") else (. // "") end
  ' <<<"$1"
}

# derive_disk_suffix <image-ref> — the tag-shaped part of a ref, for naming the
# disk after the build it holds.
#
# A digest ref has no tag, so it is named `d<first 12 hex>`. Truncation is safe
# here in a way it would not be for a pin: this string only has to be unique
# among disk names, never to identify the image to a registry.
derive_disk_suffix() {
  local ref="$1" last
  if [[ "$ref" =~ @sha256:([0-9a-f]{64})$ ]]; then
    echo "d${BASH_REMATCH[1]:0:12}"
    return 0
  fi
  last="${ref##*/}"
  if [[ "$last" == *:* ]]; then
    echo "${last##*:}"
    return 0
  fi
  return 1
}

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-worker-image.sh [options]

Builds the worker image into ACR from the current commit, registers it as an ACA
group disk image, repins workerImage and acaDiskName in the Bicep parameter file
together, and runs a what-if preview via scripts/deploy-azure.sh. Never deploys.

  --allow-dirty       Build despite uncommitted changes. The image is tagged
                      sha-<sha>-dirty-<UTC> so it can never be mistaken for a
                      clean build of that commit.
  --image <ref>       Skip the build and register an image already in the
                      registry. This is the recovery path for a build that was
                      pushed but never registered because the CLI timed out.
  --disk-name <name>  Override the derived disk name.

Environment overrides: REGISTRY, REPO, PARAMS, DISK_PREFIX, API_VERSION,
RAW_PUT_TIMEOUT (default 900s), READY_TIMEOUT (default 900s),
READY_POLL_INTERVAL, DEPLOYMENT_NAME, RESOURCE_GROUP, SANDBOX_GROUP,
MANAGEMENT_ENDPOINT.
USAGE
}

main() {
  local allow_dirty=0 prebuilt_ref="" disk_name_override=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --allow-dirty) allow_dirty=1; shift ;;
      --image)
        [[ $# -ge 2 && -n "$2" ]] || die "--image requires an image reference"
        prebuilt_ref="$2"; shift 2
        ;;
      --disk-name)
        [[ $# -ge 2 && -n "$2" ]] || die "--disk-name requires a name"
        disk_name_override="$2"; shift 2
        ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "unknown argument: $1" ;;
    esac
  done

  for tool in az git awk jq curl; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
  done
  az account show >/dev/null 2>&1 || die "not logged in to Azure — run 'az login'"
  [[ -f "$PARAMS" ]] || die "parameter file not found: $PARAMS"

  # The registry is deliberately NOT hard-coded: it names a specific deployment's
  # infrastructure, and this file is committed. It is read from the ACR host
  # already in the parameter file's workerImage (which is gitignored), so the
  # common zero-argument invocation works, and REGISTRY= overrides it for a
  # different registry or a first-ever deploy with no usable ref yet.
  if [[ -z "${REGISTRY:-}" ]]; then
    REGISTRY="$(sed -nE "s/^[[:space:]]*param[[:space:]]+workerImage[[:space:]]*=[[:space:]]*'([^.']+)\.azurecr\.io\/.*/\1/p" "$PARAMS" | head -1)"
  fi
  [[ -n "${REGISTRY:-}" ]] || die "could not determine the ACR name from workerImage in ${PARAMS}; set REGISTRY=<acr-name>"

  trap cleanup EXIT
  SCRATCH="$(mktemp -d)" || die "could not create a scratch directory"
  chmod 700 "$SCRATCH"

  local tag ref digest
  if [[ -n "$prebuilt_ref" ]]; then
    echo "==> skipping build; registering ${prebuilt_ref}"
    ref="$prebuilt_ref"
  else
    local sha status
    sha="$(git rev-parse --short=7 HEAD)"
    tag="sha-${sha}"
    # Assigned separately so `set -e` sees the failure. Inside `[[ -n "$(…)" ]]`
    # the exit status is discarded, so a `git status` that fails — a held
    # index.lock from a concurrent git process is the realistic case — would read
    # as a clean tree and produce a dirty build tagged sha-<sha>, asserting a
    # provenance it does not have.
    status="$(git status --porcelain)"
    if [[ -n "$status" ]]; then
      if [[ "$allow_dirty" -eq 0 ]]; then
        git status --short >&2
        echo >&2
        die "working tree is dirty; an image tagged ${tag} would not match commit ${sha}.
Commit or stash, or re-run with --allow-dirty."
      fi
      tag="${tag}-dirty-$(date -u +%Y%m%dT%H%M%SZ)"
      echo "==> working tree is dirty; tagging ${tag}"
    fi

    echo "==> building ${REGISTRY}.azurecr.io/${REPO}:${tag}"
    # Server-side build, for the same two reasons the README gives: it produces a
    # plain Docker v2 manifest rather than buildx's attestation-bearing OCI
    # index, and it runs natively on amd64 instead of under emulation on an arm64
    # workstation — minutes rather than tens of minutes for an image this size.
    #
    # The digest comes from the build run itself, never from a later
    # `az acr manifest show-metadata …:${tag}` lookup: a tag is a mutable
    # pointer, so two operators building the same clean commit would produce the
    # same tag and different digests, and the first would pin the second's image.
    digest="$(az acr build \
      --registry "$REGISTRY" \
      --image "${REPO}:${tag}" \
      --platform linux/amd64 \
      --file docker/worker/Dockerfile \
      --no-logs \
      --query 'outputImages[0].digest' \
      -o tsv \
      .)" || die "az acr build failed — run 'az acr task logs --registry ${REGISTRY} --run-id <id>' with the run id printed above"

    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "build did not report a valid digest for ${REPO}:${tag} (got: '${digest}')"
    echo "==> digest ${digest}"
    ref="${REGISTRY}.azurecr.io/${REPO}@${digest}"
  fi

  # The ACR refresh token minted below is scoped to REGISTRY, and an image in a
  # different registry would be pulled with credentials that do not name it. The
  # import fails on the SERVER side with an auth error that reads like a
  # permissions problem rather than a mismatched argument, so refuse it here.
  if [[ "$ref" != "${REGISTRY}.azurecr.io/"* ]]; then
    die "image '${ref}' is not in registry '${REGISTRY}.azurecr.io'.
The ACR token used to import it is scoped to that registry. Set
REGISTRY=<acr-name> to match the image."
  fi

  # Checked by digest where we have one, so this cannot be answered by a
  # different image that took the tag between the build and this lookup.
  echo "==> verifying manifest media type"
  local media_type
  media_type="$(az acr manifest show "$ref" --query mediaType -o tsv 2>/dev/null || true)"
  [[ -n "$media_type" ]] || die "could not read the manifest media type for ${ref}"
  [[ "$media_type" == "$EXPECTED_MEDIA_TYPE" ]] || die "manifest media type is '${media_type}', expected '${EXPECTED_MEDIA_TYPE}'.
The ACA disk importer cannot consume an OCI image index. Recent 'docker buildx
--push' produces one by default because it attaches provenance/SBOM
attestations; rebuild with 'az acr build', or with
'--provenance=false --sbom=false'."

  # Computed even when --disk-name overrides it, because it is also what keeps
  # the provenance comment in its refreshable shape (see below).
  local suffix=""
  suffix="$(derive_disk_suffix "$ref")" || suffix=""

  local disk_name
  if [[ -n "$disk_name_override" ]]; then
    disk_name="$disk_name_override"
  else
    [[ -n "$suffix" ]] || die "could not derive a disk name from '${ref}' — pass --disk-name"
    disk_name="${DISK_PREFIX}-${suffix}"
  fi
  # The name embeds the build, so acaDiskName necessarily changes whenever
  # workerImage does. That is what makes the pair-rewrite below observable: a
  # deployment whose disk name did not move did not get a new image either.
  echo "==> disk name ${disk_name}"

  local subscription resource_group sandbox_group endpoint deployment outputs
  subscription="$(az account show --query id -o tsv)"
  resource_group="${RESOURCE_GROUP:-}"
  sandbox_group="${SANDBOX_GROUP:-}"
  endpoint="${MANAGEMENT_ENDPOINT:-}"
  if [[ -z "$resource_group" || -z "$sandbox_group" || -z "$endpoint" ]]; then
    deployment="${DEPLOYMENT_NAME:-cyrus-$(worker_param_value project)-$(worker_param_value environment)}"
    echo "==> reading deployment outputs from ${deployment}"
    outputs="$(az deployment sub show --name "$deployment" --query 'properties.outputs' -o json 2>/dev/null || true)"
    [[ -n "$outputs" && "$outputs" != "null" ]] || die "could not read outputs of deployment '${deployment}'.
Deploy the stack first (scripts/deploy-azure.sh --apply), or set RESOURCE_GROUP,
SANDBOX_GROUP and MANAGEMENT_ENDPOINT explicitly."
    [[ -n "$resource_group" ]] || resource_group="$(jq -r '.resourceGroupName.value // empty' <<<"$outputs")"
    [[ -n "$sandbox_group" ]] || sandbox_group="$(jq -r '.sandboxGroupName.value // empty' <<<"$outputs")"
    # The ARM-emitted data-plane host, not a string-templated
    # https://management.{region}.azuredevcompute.io — the same value the router
    # config prefers.
    [[ -n "$endpoint" ]] || endpoint="$(jq -r '.managementEndpoint.value // empty' <<<"$outputs")"
  fi
  [[ -n "$resource_group" ]] || die "could not determine the resource group"
  [[ -n "$sandbox_group" ]] || die "could not determine the sandbox group"
  [[ -n "$endpoint" ]] || die "could not determine the sandbox group's management endpoint"
  endpoint="${endpoint%/}"

  local root url aca_token
  root="/subscriptions/${subscription}/resourceGroups/${resource_group}/sandboxGroups/${sandbox_group}"
  url="${endpoint}${root}/diskimages?api-version=${API_VERSION}"

  aca_token="$(az account get-access-token --resource "$ACA_TOKEN_RESOURCE" --query accessToken -o tsv)" \
    || die "could not acquire an ACA data-plane token"
  [[ -n "$aca_token" ]] || die "acquired an empty ACA data-plane token"

  # Headers go through `curl --config -` on a pipe rather than argv: a bearer
  # token in argv is readable by any process that can run `ps`.
  local -a curl_common=(--silent --show-error --config - --connect-timeout 30)

  echo "==> checking whether ${disk_name} is already registered"
  local list_json existing_state existing_base
  list_json="$(printf 'header = "Authorization: Bearer %s"\n' "$aca_token" \
    | curl "${curl_common[@]}" --max-time 120 "${endpoint}${root}/diskimages?api-version=${API_VERSION}")" \
    || die "could not list disk images at ${endpoint}"
  existing_state="$(disk_status "$list_json" "$disk_name")"

  if [[ -n "$existing_state" ]]; then
    existing_base="$(disk_base_image "$list_json" "$disk_name")"
    # A name collision with a DIFFERENT image is the one case that must never be
    # waved through: the name is what the group boots, so silently reusing it
    # would pin the parameter file to one build and boot another.
    if [[ -n "$existing_base" && "$existing_base" != "$ref" ]]; then
      die "disk '${disk_name}' already exists and was registered from a different image:
  registered: ${existing_base}
  requested:  ${ref}
Delete it, or pass --disk-name with a name that is not taken."
    fi
    [[ -n "$existing_base" ]] || echo "==> WARNING: could not read the registered image ref for ${disk_name}; assuming it matches" >&2
    echo "==> ${disk_name} already registered (state ${existing_state}); skipping the import"
  else
    local acr_token body_file response_file http_code
    acr_token="$(az acr login --name "$REGISTRY" --expose-token --query accessToken -o tsv)" \
      || die "could not acquire an ACR refresh token for ${REGISTRY}"
    [[ -n "$acr_token" ]] || die "acquired an empty ACR refresh token"

    # The credential field is `token`, NOT `password`. A wrong guess returns a
    # fast 400 naming the required property, which is easy to mistake for a
    # malformed body.
    #
    # The body is written to a mode-600 file under SCRATCH (outside the repo)
    # because it carries that refresh token: putting it in argv would expose it
    # to `ps`, and a heredoc would leave it in the shell's temp file.
    body_file="${SCRATCH}/diskimage.json"
    (umask 077; jq -n \
      --arg name "$disk_name" \
      --arg base "$ref" \
      --arg username "$ACR_TOKEN_USERNAME" \
      --arg token "$acr_token" \
      '{name: $name, image: {base: $base, registryCredentials: {username: $username, token: $token}}}' \
      >"$body_file") || die "could not build the disk-image request body"

    response_file="${SCRATCH}/response.json"
    echo "==> registering disk image (deadline ${RAW_PUT_TIMEOUT}s, no retry)"
    echo "    the import is synchronous and scales with image size; 1.7 GB took 99s"
    # ONE attempt. `--retry` is deliberately absent: aborting the client does not
    # abort the server-side import, so a retry races an import that is still
    # running rather than replacing it — which is precisely how the preview CLI
    # turns a slow success into a reported failure.
    http_code="$(printf 'header = "Authorization: Bearer %s"\nheader = "Content-Type: application/json"\n' "$aca_token" \
      | curl "${curl_common[@]}" \
          --max-time "$RAW_PUT_TIMEOUT" \
          --request PUT \
          --data-binary "@${body_file}" \
          --output "$response_file" \
          --write-out '%{http_code}' \
          "$url")" || die "the disk-image PUT failed in transport after ${RAW_PUT_TIMEOUT}s.
Unlike the CLI's '~60s' ceiling this is a deadline you can raise: re-run with
RAW_PUT_TIMEOUT=<seconds>. The import may still be running server-side — check
with 'aca sandboxgroup disk list' before retrying."
    rm -f "$body_file"

    if [[ ! "$http_code" =~ ^2[0-9][0-9]$ ]]; then
      # Errors here are RFC 9110 ProblemDetails, not ARM's
      # {"error":{"code","message"}} envelope — surface title + errors/detail.
      echo "error: disk-image PUT returned HTTP ${http_code}" >&2
      jq -r '.title // empty, (.errors // {} | to_entries[] | "  \(.key): \(.value | join("; "))"), .detail // empty' \
        <"$response_file" 2>/dev/null >&2 || cat "$response_file" >&2
      exit 1
    fi
    echo "==> PUT accepted (HTTP ${http_code})"
  fi

  # GATE ON `Ready`, NOT ON THE EXIT CODE. `aca sandboxgroup disk create` piped
  # into another command reports the PIPELINE's status, so a failed import reads
  # as exit 0 — the raw PUT above has the same weakness in a different form,
  # since a 2xx says the request was accepted, not that the image imported. The
  # authoritative signal is the disk appearing in the list with state Ready.
  echo "==> waiting for ${disk_name} to reach Ready (deadline ${READY_TIMEOUT}s)"
  local waited=0 state=""
  while (( waited < READY_TIMEOUT )); do
    list_json="$(printf 'header = "Authorization: Bearer %s"\n' "$aca_token" \
      | curl "${curl_common[@]}" --max-time 120 "${endpoint}${root}/diskimages?api-version=${API_VERSION}")" \
      || die "could not list disk images while waiting for Ready"
    state="$(disk_status "$list_json" "$disk_name")"
    case "$state" in
      Ready) break ;;
      Failed|Error)
        die "disk '${disk_name}' reached state '${state}'. Inspect it with
'aca sandboxgroup disk list --group ${sandbox_group}'."
        ;;
      "") echo "    not listed yet (${waited}s)" ;;
      *)  echo "    state ${state} (${waited}s)" ;;
    esac
    sleep "$READY_POLL_INTERVAL"
    waited=$(( waited + READY_POLL_INTERVAL ))
  done
  [[ "$state" == "Ready" ]] || die "disk '${disk_name}' did not reach Ready within ${READY_TIMEOUT}s (last state: '${state:-absent}').
The import may still be running — re-run with READY_TIMEOUT=<seconds>, or check
'aca sandboxgroup disk list --group ${sandbox_group}'. The parameter file has
NOT been repinned, so nothing points at this disk yet."
  echo "==> ${disk_name} is Ready"

  local current_image current_disk
  current_image="$(grep -E '^[[:space:]]*param[[:space:]]+workerImage[[:space:]]*=' "$PARAMS" | head -1 || true)"
  current_disk="$(grep -E '^[[:space:]]*param[[:space:]]+acaDiskName[[:space:]]*=' "$PARAMS" | head -1 || true)"

  if [[ "$current_image" == *"$ref"* && "$current_disk" == *"'${disk_name}'"* ]]; then
    echo "==> ${PARAMS} already pins this image and disk; leaving it unchanged"
  else
    # The comment's SHAPE has to stay "This digest is tagged … in …" whichever
    # path produced the ref, because that is the pattern the next run matches to
    # refresh it. Emit a differently-worded line here and it is never updated
    # again — a stale comment that outlives every future deploy.
    rewrite_worker_pin "$PARAMS" "$ref" "$disk_name" \
      "// This digest is tagged ${tag:-${suffix:-an unknown tag}} in ${REGISTRY}." \
      || die "failed to update $PARAMS"
    echo "==> ${PARAMS} workerImage and acaDiskName updated"
  fi

  # Absolutised before the handoff: deploy-azure.sh resolves a relative PARAMS
  # against ITS caller's cwd, which is the same cwd here today and silently
  # different the moment either script is invoked from elsewhere.
  local params_abs
  params_abs="$(cd "$(dirname "$PARAMS")" && pwd)/$(basename "$PARAMS")"

  echo "==> what-if"
  PARAMS="$params_abs" "$(dirname "${BASH_SOURCE[0]}")/deploy-azure.sh"
}

# The guard is load-bearing, not ceremony: deploy-worker-image.test.sh sources
# this file to reach rewrite_worker_pin and the jq helpers, and an unguarded
# `main "$@"` would start an ACR build every time the tests run.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
