# Router Image Build-and-Repin Script

**Date:** 2026-07-31
**Status:** Design (approved in brainstorming; pending spec review)

## Goal

Remove the manual step between "code is committed" and "Terraform knows which
image to deploy". Today an operator builds the router image by hand, reads the
digest out of the build output, pastes it into `dev.tfvars`, and runs
`terraform plan` — four steps, one of them a 71-character hex copy.

## Background — why this exists

On 2026-07-31, immediately after landing the Key Vault token-persistence work,
`terraform apply` was about to be run against `rg-cyrus` with
`router_image` still pinned to `sha-0dc73a1` — a 27 July build containing none
of the new code. The apply would have succeeded, restored Linear via the fresh
credential, and then re-broken within 24h, burning the newly minted refresh
token. It was caught only by manually cross-checking the pinned digest against
ACR.

The pin itself is not the problem and must not be removed.
`infra/azure/README.md` → "Router image tag policy" is explicit: a mutable tag
means Terraform records an unchanging string while the registry re-points it,
so an unrelated `terraform apply` can roll the router **backwards** with no diff
in the plan. `variables.tf:61-69` enforces this, with `allow_mutable_image_tags`
reserved for throwaway stacks.

Both failure modes — a stale pin and a silently drifting tag — come from a human
maintaining the digest by hand. This automates that, keeping the pin immutable.

## Non-goals

- Automating `worker_image`. It is registered out of band as an ACA disk
  (`aca sandboxgroup disk create`) and `aca_disk_name` must move with it, which
  is a larger piece of work. The worker image is current.
- Running `terraform apply`. The script stops at `plan`.
- CI-driven deploys. That needs Azure federated credentials, a service
  principal scoped to the resource group, and remote state access — none of
  which exist today, and whether CI should hold Azure credentials is a security
  decision deserving its own discussion. This script is a prerequisite for that
  work either way, since CI would run the same build-and-resolve steps.

## Design

### Location and shape

`scripts/deploy-router-image.sh`, following the conventions of the existing
`scripts/*.sh`: `#!/usr/bin/env bash`, `set -euo pipefail`, and a header comment
stating the purpose and the pipeline.

Configuration comes from environment variables with defaults, so the script is
not hardcoded to the dev stack:

| Variable | Default |
| --- | --- |
| `REGISTRY` | `acrcyrusdev` |
| `REPO` | `cyrus-router` |
| `TFVARS` | `infra/azure/terraform/env/dev.tfvars` |
| `TF_DIR` | `infra/azure/terraform` |

Flags are limited to `--allow-dirty` and `-h`/`--help`.

### Pipeline

1. **Preconditions.** `az`, `terraform`, `git` on `PATH`; `az account show`
   succeeds; `$TFVARS` exists; `$TF_DIR/.terraform` exists. Each check fails
   with its own message — a generic "prerequisites not met" wastes the operator's
   time at exactly the wrong moment.

2. **Resolve the tag.** `git rev-parse --short=7 HEAD`. If
   `git status --porcelain` is non-empty, print it and exit non-zero, naming the
   tag that would have been written and how to override. With `--allow-dirty`,
   the tag becomes `sha-<sha>-dirty-<UTC ISO8601 basic>`.

3. **Build.**
   `az acr build -r "$REGISTRY" -t "$REPO:$TAG" -f docker/router/Dockerfile .`

4. **Resolve the digest.**
   `az acr manifest show-metadata "$REGISTRY.azurecr.io/$REPO:$TAG" --query digest -o tsv`,
   matching the command `infra/azure/README.md` already documents.
   An empty or malformed result is a hard failure — a wrong digest here is
   precisely the class of bug this script exists to prevent, so it must never be
   guessed or defaulted.

5. **Rewrite `$TFVARS`.** Replace the assignment line with
   `"$REGISTRY.azurecr.io/$REPO@$DIGEST"`, **and** refresh the provenance comment
   above it, which currently reads
   `# This digest is tagged sha-0dc73a1 in acrcyrusdev.` Leaving that comment
   stale would relocate the confusion rather than remove it.

   Matching is anchored to avoid collateral edits: the assignment is the line
   matching `^[[:space:]]*router_image[[:space:]]*=`, which cannot match
   `worker_image` or a mention of `router_image` inside a comment. The provenance
   comment is the line matching `^#[[:space:]]*This digest is tagged .* in .*`
   appearing anywhere above the assignment and after the previous assignment; if
   no such comment exists the script proceeds without adding one, since a tfvars
   lacking it is still valid.

6. **Plan.** `terraform -chdir="$TF_DIR" plan -var-file="$TFVARS_ABS"`, then
   print the same command with `apply` and exit 0.

   `-chdir` makes a relative `-var-file` resolve against `$TF_DIR`, not the
   caller's cwd, which would silently break the moment `TFVARS` is overridden.
   The script therefore resolves `$TFVARS` to an absolute path once, up front,
   and passes that — and prints the absolute form in the suggested apply command
   so a copy-paste works from any directory.

### Why the tag differs on a dirty build

`az acr build` uploads the working tree, not the commit. Tagging a dirty build
`sha-9f49d67` would produce an image whose name asserts a provenance it does not
have — the exact traceability the pin policy protects. The `-dirty-<timestamp>`
suffix keeps that visible on the label. It is more annoying in an emergency,
which is when `--allow-dirty` would be used; that friction is the point. Because
Terraform is pinned by digest rather than by tag, the unusual tag still satisfies
the `variables.tf` validation.

### Handling a secrets file safely

`dev.tfvars` is gitignored (`.gitignore:57`), mode 600, and holds the Linear
client secret and both OAuth tokens. A mangled rewrite has no git copy to
recover from. Therefore:

- Write to a temp file in the same directory, created mode 600.
- Verify the result contains exactly one `router_image` line and that it carries
  the new digest.
- Only then `mv` it into place, atomically.
- On verification failure, discard the temp file, leave the original untouched,
  and exit non-zero.
- A `trap` removes the temp file on every exit path.
- The script never prints the file's contents — only the old and new
  `router_image` values.

### Idempotence

If the pinned digest already equals the resolved digest, the script says so,
skips the rewrite, and still runs the plan. Re-running after a partial failure is
therefore safe.

## Error handling summary

| Failure | Behaviour |
| --- | --- |
| Missing tool, not logged in, missing tfvars, uninitialized `TF_DIR` | Specific message, exit non-zero, nothing built |
| Dirty tree without `--allow-dirty` | Print `git status --short`, name the tag that would be written, exit non-zero |
| `az acr build` fails | Propagate the failure; tfvars untouched |
| Digest empty or malformed | Hard failure; tfvars untouched |
| `router_image` line absent from tfvars | Fail before writing |
| Rewrite verification fails | Original preserved, temp discarded, exit non-zero |
| Digest already current | Report, skip rewrite, still plan |

## Testing

The rewrite is the only part with branching logic and the only part that can
destroy a secrets file, so it is extracted into a function and covered by
`scripts/deploy-router-image.test.sh`:

- rewrites the `router_image` line to the new digest
- refreshes the provenance comment to name the new tag
- leaves every other line byte-identical
- fails without writing when the fixture has no `router_image` line
- leaves the original intact when verification fails

Fixtures are built in a temp directory; no real tfvars is touched. The `az` and
`terraform` invocations are single shell-outs with no branching and are not
mocked — asserting that a mock was called would test nothing.

The script must also pass `shellcheck` cleanly.

## Rollout

First use is the pending deploy of `9f49d67b`: run the script, review the plan
(expect the router image digest to change and
`CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL` to be added), then apply by hand.
