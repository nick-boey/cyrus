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
`terraform apply` was about to be run against `<resource-group>` with
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
| `REGISTRY` | `<acr-name>` |
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

4. **Resolve the digest — from the build run, not from the tag.**
   The build is run as
   `az acr build … --no-logs --query 'outputImages[0].digest' -o tsv .`, so the
   digest is the one the build produced.

   > **Corrected 2026-07-31 (final review, IMPORTANT 4).** This step originally
   > specified a follow-up
   > `az acr manifest show-metadata "$REGISTRY.azurecr.io/$REPO:$TAG" --query digest -o tsv`,
   > matching `infra/azure/README.md`. That asks what the tag points at *now*:
   > two operators deploying the same clean commit produce the same tag, so the
   > second push re-points the first's tag and the first pins the second's image.
   > A mutable indirection is the exact property this script exists to eliminate,
   > so the digest must come from the run itself. `--no-logs` is what makes the
   > run object rather than the log stream the command's result; the cost is that
   > build output is no longer streamed live.

   An empty or malformed result is a hard failure — a wrong digest here is
   precisely the class of bug this script exists to prevent, so it must never be
   guessed or defaulted.

5. **Rewrite `$TFVARS`.** Replace the assignment line with
   `"$REGISTRY.azurecr.io/$REPO@$DIGEST"`, **and** refresh the provenance comment
   above it, which currently reads
   `# This digest is tagged sha-0dc73a1 in <acr-name>.` Leaving that comment
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
- A `trap` removes the temp file on every exit path. The temp file is also named
  so that any residue a SIGKILL leaves behind is gitignored and excluded from the
  build context — it is a mode-600 copy of the secrets.
- The script never prints the file's contents — only the old and new
  `router_image` values.

### Handling the build context safely

> **Added 2026-07-31 (final review, CRITICAL 2).** Not in the original design,
> and the omission would have leaked the file this section is about.

`az acr build … .` is not a local build: it tars the working directory and
**uploads** it to the registry, honouring `.dockerignore`. The manual
`docker buildx build` path it replaces kept the context on the local daemon, so
nothing left the machine — switching to `az acr build` changed that, and the
secrecy implications were never assessed at plan time.

`.dockerignore` must therefore exclude `dev.tfvars`, `terraform.tfstate`
(Terraform writes `sensitive` values to state in **plaintext**; `sensitive = true`
only redacts CLI output), its `.backup`, the `.terraform/` provider cache, and any
temp residue. None of it is needed by `docker/router/Dockerfile`, which builds only
the pnpm workspace — `pnpm-workspace.yaml` is `packages/*` + `apps/*`, so `infra/`
is not a member.

The patterns are not the obvious ones. ACR compiles its own subset of Docker
ignore syntax (`command_modules/acr/_archive_utils.py`, `IgnoreRule`): `**/x`
becomes `^.*/x$`, which needs at least one separator and so misses a root-level
file; `*.x` becomes `^[^/]*\.x$`, which misses a nested one; and a trailing `/`
becomes a pattern ending in `/$`, which no archive entry can ever match — making
`**/.terraform/` a silent no-op. Both forms of each rule are required, and
`.terraform` must carry no trailing slash. Verify against the installed
`IgnoreRule`/`_pack_source_code`, not by eye.

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
- leaves `worker_image`'s identically-worded provenance comment alone
- fails without writing when the fixture has no `router_image` line
- fails without writing when the fixture has two `router_image` lines
- leaves the original intact when the rewrite fails — `awk` is shadowed on `PATH`
  with a failing stub, and the function is called the way `main` calls it
  (`… || true`, mirroring `… || die`), because that form disables `set -e` for
  the whole function body; a bare call exercises a safety the script does not
  have at the point of use
- leaves the original intact when the rewrite truncates but exits 0 — the
  truncated output still satisfies the content checks, so only a line-count
  comparison catches it
- the temp file name is gitignored

Fixtures are built in a temp directory; no real tfvars is touched. The `az` and
`terraform` invocations are single shell-outs with no branching and are not
mocked — asserting that a mock was called would test nothing.

The script must also pass `shellcheck` cleanly, and CI must actually run the
suite: `pnpm test` is workspace-only, so `scripts/*.test.sh` needs its own step
(it rides along in the `aca-parity` job) or the suite rots silently.

## Rollout

First use is the pending deploy of `9f49d67b`: run the script, review the plan
(expect the router image digest to change and
`CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL` to be added), then apply by hand.
