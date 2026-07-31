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

# Everything below main() is Task 2. Sourcing this file (as the test does) must
# not execute it.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "error: main not implemented yet" >&2
  exit 1
fi
