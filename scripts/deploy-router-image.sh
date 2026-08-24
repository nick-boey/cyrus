#!/usr/bin/env bash
# scripts/deploy-router-image.sh — build the router image into ACR, repin the
# Bicep parameter file to its digest, and show the what-if.
#
# Replaces the manual sequence in infra/azure/README.md step 4 (build, read the
# digest, paste it into the parameter file, preview), whose copy step is how
# routerImage went stale on 2026-07-31 — a deployment was nearly run against a
# build from four days earlier containing none of the code being deployed.
#
# The pin stays a digest on purpose. See infra/azure/README.md → "Router image
# tag policy": a mutable tag lets an unrelated deployment roll the router
# backwards with nothing in the change list to warn you.
#
# Stops at the what-if. It never deploys.
set -euo pipefail

TMP_PARAMS=""
cleanup_tmp_params() {
  [[ -n "$TMP_PARAMS" && -e "$TMP_PARAMS" ]] && rm -f "$TMP_PARAMS"
  return 0
}

# rewrite_router_image <params_path> <new_image_ref> <provenance_comment>
#
# Rewrites the `param routerImage` assignment to <new_image_ref> and replaces the
# "This digest is tagged … in …" comment with <provenance_comment>, leaving every
# other line byte-identical.
#
# The target is gitignored, mode 600, and holds the Linear client secret and both
# OAuth tokens — there is no git copy to restore from. So the new content is
# built in a mode-600 temp file beside it, verified, and only then moved into
# place. Any failure leaves the original untouched.
rewrite_router_image() {
  local params="$1" new_ref="$2" comment="$3"
  local count

  count="$(grep -cE '^[[:space:]]*param[[:space:]]+routerImage[[:space:]]*=' "$params" || true)"
  if [[ "$count" != "1" ]]; then
    echo "error: expected exactly one 'param routerImage' assignment in ${params}, found ${count}" >&2
    return 1
  fi

  # The name is dot-prefixed and matches .gitignore's `*.bicepparam.tmp.*` so a
  # SIGKILL mid-rewrite cannot leave a mode-600 copy of the secrets one
  # `git add -A` away from a commit. It cannot simply end in `.bicepparam`: BSD
  # mktemp only substitutes a TRAILING run of X's, so `.tmp.XXXXXX.bicepparam`
  # silently yields that literal, non-unique name on macOS.
  if ! TMP_PARAMS="$(mktemp "$(dirname "$params")/.$(basename "$params").tmp.XXXXXX")" \
     || [[ -z "$TMP_PARAMS" ]] || ! chmod 600 "$TMP_PARAMS"; then
    cleanup_tmp_params
    TMP_PARAMS=""
    echo "error: could not create a temp file beside ${params}; left unchanged" >&2
    return 1
  fi

  # The assignment match is anchored so it cannot hit workerImage or a mention
  # inside prose. The provenance comment needs more than an anchor: the same
  # comment sits above workerImage, and rewriting that one would make it assert a
  # tag the worker image does not have — worse than the stale comment this
  # replaces, because it would mislead exactly the manual cross-check that caught
  # the original incident. So comments are buffered and only the run belonging to
  # routerImage — the lines since the previous assignment — is rewritten.
  #
  # `set -e` is disabled for this whole function body when it is called as
  # `rewrite_router_image … || die`, so awk's status is checked by hand. Without
  # that check an awk killed partway through (disk full, OOM) would leave a
  # truncated file that still satisfies the greps below, and the mv would destroy
  # the only copy of the secrets.
  if ! REWRITE_REF="$new_ref" REWRITE_COMMENT="$comment" awk '
    function flush_pending(   i) {
      for (i = 1; i <= pending_n; i++) print pending[i]
      pending_n = 0
    }
    /^[[:space:]]*param[[:space:]]+[[:alpha:]_][[:alnum:]_]*[[:space:]]*=/ {
      if ($0 ~ /^[[:space:]]*param[[:space:]]+routerImage[[:space:]]*=/) {
        for (i = 1; i <= pending_n; i++) {
          if (pending[i] ~ /^[[:space:]]*\/\/[[:space:]]*This digest is tagged .* in .*/)
            pending[i] = ENVIRON["REWRITE_COMMENT"]
          print pending[i]
        }
        pending_n = 0
        print "param routerImage = \x27" ENVIRON["REWRITE_REF"] "\x27"
        next
      }
      flush_pending()
      print
      next
    }
    { pending[++pending_n] = $0 }
    END { flush_pending() }
  ' "$params" >"$TMP_PARAMS"; then
    cleanup_tmp_params
    TMP_PARAMS=""
    echo "error: rewrite failed; ${params} left unchanged" >&2
    return 1
  fi

  # Catches a truncation that awk did not report — the rewrite is strictly
  # line-for-line, so any change in line count means content was lost. This is
  # also the only check of the "leaves every other line byte-identical" rule.
  # It also fires if the original lacks a trailing newline, since awk adds one.
  # That is a refusal rather than a corruption, which is the right way to be
  # wrong about a file with no backup: end the last line with a newline.
  if [[ "$(wc -l <"$TMP_PARAMS")" != "$(wc -l <"$params")" ]]; then
    cleanup_tmp_params
    TMP_PARAMS=""
    echo "error: rewrite changed the line count; ${params} left unchanged" >&2
    return 1
  fi

  count="$(grep -cE '^[[:space:]]*param[[:space:]]+routerImage[[:space:]]*=' "$TMP_PARAMS" || true)"
  if [[ "$count" != "1" ]] || ! grep -qF "$new_ref" "$TMP_PARAMS"; then
    cleanup_tmp_params
    TMP_PARAMS=""
    echo "error: rewrite verification failed; ${params} left unchanged" >&2
    return 1
  fi

  mv "$TMP_PARAMS" "$params"
  TMP_PARAMS=""
}

REPO="${REPO:-cyrus-router}"
PARAMS="${PARAMS:-infra/azure/bicep/main.bicepparam}"

# The registry is deliberately NOT hard-coded: it names a specific deployment's
# infrastructure, and this file is committed. It is read from the ACR host
# already present in the parameter file's routerImage (which is gitignored), so
# the common zero-argument invocation still works, and can be overridden with
# REGISTRY= for a different registry or a first-ever deploy whose parameter file
# has no usable ref yet.
if [[ -z "${REGISTRY:-}" && -f "$PARAMS" ]]; then
  REGISTRY="$(sed -nE "s/^[[:space:]]*param[[:space:]]+routerImage[[:space:]]*=[[:space:]]*'([^.']+)\.azurecr\.io\/.*/\1/p" "$PARAMS" | head -1)"
fi

die() { echo "error: $*" >&2; exit 1; }

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-router-image.sh [--allow-dirty]

Builds the router image into ACR from the current commit, repins routerImage in
the Bicep parameter file to the resulting digest, and runs a what-if preview via
scripts/deploy-azure.sh. Never deploys.

  --allow-dirty   Build despite uncommitted changes. The image is tagged
                  sha-<sha>-dirty-<UTC> so it can never be mistaken for a
                  clean build of that commit.

Environment overrides: REGISTRY, REPO, PARAMS.
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

  for tool in az git awk; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool not found on PATH"
  done
  az account show >/dev/null 2>&1 || die "not logged in to Azure — run 'az login'"
  [[ -f "$PARAMS" ]] || die "parameter file not found: $PARAMS"
  [[ -n "${REGISTRY:-}" ]] || die "could not determine the ACR name from routerImage in ${PARAMS}; set REGISTRY=<acr-name>"

  local sha tag status
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
  # The digest comes from the build run itself, never from a later
  # `az acr manifest show-metadata …:${tag}` lookup. A tag is a mutable pointer:
  # anything re-pushing sha-<sha> between the build and the lookup re-points it,
  # so two operators deploying the same clean commit would produce the same tag
  # and different digests, and the first would pin the second's image. That
  # mutable indirection is the exact class of bug this script exists to remove.
  #
  # --no-logs is what makes the run object, rather than the log stream, the
  # command's result (azure-cli command_modules/acr/build.py: with no_logs it
  # returns the polled Run, otherwise it returns stream_logs(), which returns
  # None). The Run serialises outputImages[].digest. The cost is that build
  # output is no longer streamed; on failure the CLI names the run id and the
  # `az acr task logs` command that shows what went wrong.
  local digest
  digest="$(az acr build \
    --registry "$REGISTRY" \
    --image "${REPO}:${tag}" \
    --platform linux/amd64 \
    --file docker/router/Dockerfile \
    --no-logs \
    --query 'outputImages[0].digest' \
    -o tsv \
    .)" || die "az acr build failed — run 'az acr task logs --registry ${REGISTRY} --run-id <id>' with the run id printed above"

  # A wrong digest here is precisely the bug this script exists to prevent, so it
  # is never guessed or defaulted. This also catches the case where the build
  # succeeded but reported no output image.
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || die "build did not report a valid digest for ${REPO}:${tag} (got: '${digest}')"
  echo "==> digest ${digest}"

  local new_ref current
  new_ref="${REGISTRY}.azurecr.io/${REPO}@${digest}"
  current="$(grep -E '^[[:space:]]*param[[:space:]]+routerImage[[:space:]]*=' "$PARAMS" | head -1 || true)"

  if [[ "$current" == *"$new_ref"* ]]; then
    echo "==> ${PARAMS} already pins this digest; leaving it unchanged"
  else
    trap cleanup_tmp_params EXIT
    rewrite_router_image "$PARAMS" "$new_ref" \
      "// This digest is tagged ${tag} in ${REGISTRY}." || die "failed to update $PARAMS"
    echo "==> ${PARAMS} routerImage updated"
  fi

  # Absolutised before the handoff: deploy-azure.sh resolves a relative PARAMS
  # against ITS caller's cwd, which is the same cwd here today and silently
  # different the moment either script is invoked from elsewhere.
  local params_abs
  params_abs="$(cd "$(dirname "$PARAMS")" && pwd)/$(basename "$PARAMS")"

  echo "==> what-if"
  PARAMS="$params_abs" "$(dirname "${BASH_SOURCE[0]}")/deploy-azure.sh"
}

# The guard is load-bearing, not ceremony: deploy-router-image.test.sh sources
# this file to reach rewrite_router_image, and an unguarded `main "$@"` would
# start an ACR build every time the tests run.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
