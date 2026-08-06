# Router Image Build-and-Repin Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual "build image → copy the digest → paste into tfvars → plan" sequence with one script, so the Terraform image pin can never go stale by hand.

**Architecture:** A single bash script, `scripts/deploy-router-image.sh`. The risky part — rewriting a gitignored, mode-600 secrets file — is isolated in one sourceable function with its own test file; everything around it is a linear sequence of shell-outs to `git`, `az`, and `terraform`. The script stops at `terraform plan` and prints the apply command rather than running it.

**Tech Stack:** bash, `az` CLI (ACR build + manifest), Terraform 1.15.x, `shellcheck`.

## Global Constraints

- `#!/usr/bin/env bash` and `set -euo pipefail`, matching `scripts/symlink-skills.sh` and `scripts/check-aca-arm-parity.sh`.
- The image pin stays **immutable** — a digest. Never emit a mutable tag into `router_image`; `infra/azure/terraform/variables.tf:61-69` rejects them and `infra/azure/README.md` → "Router image tag policy" explains why.
- `infra/azure/terraform/env/dev.tfvars` is **gitignored** (`.gitignore:57`), **mode 600**, and holds the Linear client secret and both OAuth tokens. It has no git copy to recover from. Never print its contents; never leave it partially written.
- The script must never run `terraform apply`.
- `shellcheck` must pass clean on both new files (`shellcheck` is installed at `/opt/homebrew/bin/shellcheck`).
- Build for `linux/amd64` explicitly. The dev machine is `darwin_arm64` and Azure Container Apps runs amd64; an arch mismatch produces an image that fails to start.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `scripts/deploy-router-image.sh` | **Create.** Preconditions, tag resolution, ACR build, digest resolution, tfvars rewrite, `terraform plan`. Sourceable without executing. |
| `scripts/deploy-router-image.test.sh` | **Create.** Tests `rewrite_router_image` against temp fixtures. First shell test file in the repo, so it carries its own assert helpers. |
| `infra/azure/README.md:205-237` | **Modify.** Point step 4 at the script for the router image. |
| `docs/superpowers/specs/2026-07-31-router-image-deploy-script-design.md` | **Modify.** Correct the digest-resolution command to the one the repo already uses. |

**Two deviations from the spec, both adopting existing repo practice.** The spec named `az acr repository show --image … --query digest`; `infra/azure/README.md:230-232` already uses `az acr manifest show-metadata … --query digest -o tsv`, so use that and correct the spec (Task 2). The spec left the build command implicit; this plan uses `az acr build` rather than the README's `docker buildx build --push` because it needs no local Docker daemon and no emulated amd64 build on an arm64 laptop.

---

### Task 1: `rewrite_router_image` and its tests

The only branching logic, and the only code that can destroy a secrets file.

**Files:**
- Create: `scripts/deploy-router-image.sh` (function + sourcing guard only)
- Create: `scripts/deploy-router-image.test.sh`

**Interfaces:**
- Produces: `rewrite_router_image <tfvars_path> <new_image_ref> <provenance_comment>` — rewrites in place, returns 0 on success, non-zero on failure with the original untouched. Task 2 calls it.
- Produces: global `TMP_TFVARS` and `cleanup_tmp_tfvars`, used by Task 2's `trap`.
- The function takes the **full comment line** rather than a tag and registry, so it needs no knowledge of registries.

- [ ] **Step 1: Write the failing test**

Create `scripts/deploy-router-image.test.sh`:

```bash
#!/usr/bin/env bash
# scripts/deploy-router-image.test.sh — covers rewrite_router_image.
#
# The rewrite is the only part of deploy-router-image.sh with branching logic,
# and the only part that can corrupt env/dev.tfvars — a gitignored, mode-600
# file holding the Linear client secret and both OAuth tokens, with no git copy
# to restore from. Everything else in that script is a single shell-out.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./deploy-router-image.sh
source "${SCRIPT_DIR}/deploy-router-image.sh"

FAILURES=0
ok()   { echo "ok   — $*"; }
fail() { echo "FAIL — $*" >&2; FAILURES=$((FAILURES + 1)); }

OLD_REF="<acr-name>.azurecr.io/cyrus-router@sha256:$(printf '3%.0s' {1..64})"
NEW_REF="<acr-name>.azurecr.io/cyrus-router@sha256:$(printf 'a%.0s' {1..64})"
NEW_COMMENT="# This digest is tagged sha-9f49d67 in <acr-name>."

make_fixture() {
  cat >"$1" <<EOF
location = "australiaeast"

# ---- Container images -------------------------------------------------------
# Deployed by DIGEST (that is what the live Container App template holds).
# This digest is tagged sha-0dc73a1 in <acr-name>.
router_image = "${OLD_REF}"

worker_image  = "<acr-name>.azurecr.io/cyrus-worker:sha-a5a9ffc"
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
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bash scripts/deploy-router-image.test.sh`
Expected: FAIL — `no such file or directory: .../deploy-router-image.sh`

- [ ] **Step 3: Write the function and the sourcing guard**

Create `scripts/deploy-router-image.sh`:

```bash
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bash scripts/deploy-router-image.test.sh`
Expected: PASS — seven `ok —` lines, then `all tests passed`.

- [ ] **Step 5: Lint**

Run: `shellcheck scripts/deploy-router-image.sh scripts/deploy-router-image.test.sh`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
chmod +x scripts/deploy-router-image.sh scripts/deploy-router-image.test.sh
git add scripts/deploy-router-image.sh scripts/deploy-router-image.test.sh
git commit -m "feat(scripts): add rewrite_router_image with tests"
```

---

### Task 2: The build-and-plan pipeline

**Files:**
- Modify: `scripts/deploy-router-image.sh` (replace the placeholder guard block)
- Modify: `infra/azure/README.md:205-237`
- Modify: `docs/superpowers/specs/2026-07-31-router-image-deploy-script-design.md`

**Interfaces:**
- Consumes: `rewrite_router_image`, `TMP_TFVARS`, `cleanup_tmp_tfvars` from Task 1.

- [ ] **Step 1: Replace the placeholder block with the pipeline**

In `scripts/deploy-router-image.sh`, replace:

```bash
# Everything below main() is Task 2. Sourcing this file (as the test does) must
# not execute it.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  echo "error: main not implemented yet" >&2
  exit 1
fi
```

with:

```bash
REGISTRY="${REGISTRY:-<acr-name>}"
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
```

- [ ] **Step 2: Verify the guard still holds — sourcing must not execute**

Run: `bash scripts/deploy-router-image.test.sh`
Expected: PASS, unchanged from Task 1. If the suite now tries to build an image, `main "$@"` is running on source and the guard is wrong.

- [ ] **Step 3: Verify the argument surface without touching Azure**

Run: `bash scripts/deploy-router-image.sh --help`
Expected: the usage text, exit 0.

Run: `bash scripts/deploy-router-image.sh --nonsense`
Expected: usage on stderr, `error: unknown argument: --nonsense`, non-zero exit.

Run: `TFVARS=/nonexistent bash scripts/deploy-router-image.sh`
Expected: `error: tfvars not found: /nonexistent`, non-zero exit, and **no image built** — the precondition checks must all run before `az acr build`.

- [ ] **Step 4: Lint**

Run: `shellcheck scripts/deploy-router-image.sh scripts/deploy-router-image.test.sh`
Expected: no output, exit 0.

- [ ] **Step 5: Point README step 4 at the script**

In `infra/azure/README.md`, immediately after the `### 4. Build and push immutable images` heading paragraph (the one ending "see [Router image tag policy](#router-image-tag-policy)."), insert:

The inserted text contains a nested fenced block, so it is shown here inside a
four-backtick fence. Insert only the inner content — starting at `For the` and
ending at `must move with it.` — with its three-backtick fences intact.

````markdown
For the **router** image, `scripts/deploy-router-image.sh` does all of this —
build, digest resolution, repinning `router_image`, and `terraform plan` — in
one step, and refuses to build from a dirty tree so the tag cannot misname the
commit. Prefer it over the manual sequence below:

```bash
./scripts/deploy-router-image.sh          # then review the plan and apply
```

The manual steps below remain the reference for the **worker** image, which the
script does not handle: the worker is registered out of band as an ACA disk
(`aca sandboxgroup disk create`) and `aca_disk_name` must move with it.
````

- [ ] **Step 6: Correct the digest command in the spec**

In `docs/superpowers/specs/2026-07-31-router-image-deploy-script-design.md`, replace:

```markdown
   `az acr repository show -n "$REGISTRY" --image "$REPO:$TAG" --query digest -o tsv`.
```

with:

```markdown
   `az acr manifest show-metadata "$REGISTRY.azurecr.io/$REPO:$TAG" --query digest -o tsv`,
   matching the command `infra/azure/README.md` already documents.
```

- [ ] **Step 7: Commit**

```bash
git add scripts/deploy-router-image.sh infra/azure/README.md \
  docs/superpowers/specs/2026-07-31-router-image-deploy-script-design.md
git commit -m "feat(scripts): build router image to ACR and repin Terraform by digest"
```

---

## Post-implementation verification

The tests cover the rewrite; nothing covers the `az`/`terraform` path. The first real run is the pending `9f49d67b` deploy and doubles as that verification:

1. `./scripts/deploy-router-image.sh` on a clean tree.
2. The plan should show **two** changes: `router_image` moving from `…@sha256:32fcea…` to the new digest, and `CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL` being added to the container env. If the env var is absent, the Terraform change from the previous plan never landed and the deploy is pointless — stop.
3. Confirm `dev.tfvars` is still mode 600 and still contains `linear_client_secret` and both token values.
4. Re-run the script with no code change: it should report the digest is already pinned, skip the rewrite, and still plan.
