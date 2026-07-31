#!/usr/bin/env bash
# scripts/deploy-router-image.sh — build the router image into ACR, repin
# Terraform to its digest, and show the plan.
#
# Replaces the manual sequence in infra/azure/README.md step 4 (build, read the
# digest, paste it into dev.tfvars, plan), whose copy step is how router_image
# went stale on 2026-07-31 — an apply was nearly run against a build from four
# days earlier containing none of the code being deployed.
#
# The pin stays a digest on purpose. See infra/azure/README.md → "Router image
# tag policy": a mutable tag lets an unrelated apply roll the router backwards
# with no diff in the plan.
#
# Stops at `terraform plan`. It never applies.
set -euo pipefail

TMP_TFVARS=""
cleanup_tmp_tfvars() {
  [[ -n "$TMP_TFVARS" && -e "$TMP_TFVARS" ]] && rm -f "$TMP_TFVARS"
  return 0
}

# rewrite_router_image <tfvars_path> <new_image_ref> <provenance_comment>
#
# Rewrites the router_image assignment to <new_image_ref> and replaces the
# "This digest is tagged … in …" comment with <provenance_comment>, leaving
# every other line byte-identical.
#
# The target is gitignored, mode 600, and holds the Linear client secret and
# both OAuth tokens — there is no git copy to restore from. So the new content
# is built in a mode-600 temp file beside it, verified, and only then moved into
# place. Any failure leaves the original untouched.
rewrite_router_image() {
  local tfvars="$1" new_ref="$2" comment="$3"
  local count

  count="$(grep -cE '^[[:space:]]*router_image[[:space:]]*=' "$tfvars" || true)"
  if [[ "$count" != "1" ]]; then
    echo "error: expected exactly one router_image assignment in ${tfvars}, found ${count}" >&2
    return 1
  fi

  TMP_TFVARS="$(mktemp "${tfvars}.XXXXXX")"
  chmod 600 "$TMP_TFVARS"

  # Anchored so it cannot match worker_image or a mention inside prose.
  REWRITE_REF="$new_ref" REWRITE_COMMENT="$comment" awk '
    /^[[:space:]]*#[[:space:]]*This digest is tagged .* in .*/ {
      print ENVIRON["REWRITE_COMMENT"]; next
    }
    /^[[:space:]]*router_image[[:space:]]*=/ {
      print "router_image = \"" ENVIRON["REWRITE_REF"] "\""; next
    }
    { print }
  ' "$tfvars" >"$TMP_TFVARS"

  count="$(grep -cE '^[[:space:]]*router_image[[:space:]]*=' "$TMP_TFVARS" || true)"
  if [[ "$count" != "1" ]] || ! grep -qF "$new_ref" "$TMP_TFVARS"; then
    cleanup_tmp_tfvars
    TMP_TFVARS=""
    echo "error: rewrite verification failed; ${tfvars} left unchanged" >&2
    return 1
  fi

  mv "$TMP_TFVARS" "$tfvars"
  TMP_TFVARS=""
}

REGISTRY="${REGISTRY:-acrcyrusdev}"
REPO="${REPO:-cyrus-router}"
TF_DIR="${TF_DIR:-infra/azure/terraform}"
TFVARS="${TFVARS:-infra/azure/terraform/env/dev.tfvars}"

die() { echo "error: $*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-router-image.sh [--allow-dirty]

Builds the router image into ACR from the current commit, repins router_image
in the tfvars to the resulting digest, and runs `terraform plan`. Never applies.

  --allow-dirty   Build despite uncommitted changes. The image is tagged
                  sha-<sha>-dirty-<UTC> so it can never be mistaken for a
                  clean build of that commit.

Environment overrides: REGISTRY, REPO, TF_DIR, TFVARS.
USAGE
}

main() {
  local allow_dirty=0
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --allow-dirty) allow_dirty=1; shift ;;
      -h|--help) usage; exit 0 ;;
      *) usage >&2; die "unknown argument: $1" ;;
    esac
  done

  for tool in az terraform git awk; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
  done
  az account show >/dev/null 2>&1 || die "not logged in to Azure — run 'az login'"
  [[ -f "$TFVARS" ]] || die "tfvars not found: $TFVARS"
  [[ -d "$TF_DIR/.terraform" ]] || die "terraform not initialized in $TF_DIR — run 'terraform -chdir=$TF_DIR init'"

  # -chdir makes a relative -var-file resolve against TF_DIR rather than the
  # caller's cwd, which breaks silently the moment TFVARS is overridden.
  local tfvars_abs
  tfvars_abs="$(cd "$(dirname "$TFVARS")" && pwd)/$(basename "$TFVARS")"

  local sha tag
  sha="$(git rev-parse --short=7 HEAD)"
  tag="sha-${sha}"
  if [[ -n "$(git status --porcelain)" ]]; then
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
  az acr build \
    --registry "$REGISTRY" \
    --image "${REPO}:${tag}" \
    --platform linux/amd64 \
    --file docker/router/Dockerfile \
    . || die "az acr build failed"

  local digest
  digest="$(az acr manifest show-metadata \
    "${REGISTRY}.azurecr.io/${REPO}:${tag}" --query digest -o tsv)"
  # A wrong digest here is precisely the bug this script exists to prevent, so
  # it is never guessed or defaulted.
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "could not resolve a valid digest for ${REPO}:${tag} (got: '${digest}')"
  echo "==> digest ${digest}"

  local new_ref current
  new_ref="${REGISTRY}.azurecr.io/${REPO}@${digest}"
  current="$(grep -E '^[[:space:]]*router_image[[:space:]]*=' "$TFVARS" | head -1 || true)"

  if [[ "$current" == *"$new_ref"* ]]; then
    echo "==> ${TFVARS} already pins this digest; leaving it unchanged"
  else
    trap cleanup_tmp_tfvars EXIT
    rewrite_router_image "$TFVARS" "$new_ref" \
      "# This digest is tagged ${tag} in ${REGISTRY}." || die "failed to update $TFVARS"
    echo "==> ${TFVARS} router_image updated"
  fi

  echo "==> terraform plan"
  terraform -chdir="$TF_DIR" plan -var-file="$tfvars_abs"

  cat <<EOF

Review the plan above, then:
  terraform -chdir=${TF_DIR} apply -var-file=${tfvars_abs}
EOF
}

# The guard is load-bearing, not ceremony: deploy-router-image.test.sh sources
# this file to reach rewrite_router_image, and an unguarded `main "$@"` would
# start an ACR build every time the tests run.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
