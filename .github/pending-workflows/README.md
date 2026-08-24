# Pending workflow changes — apply these, then delete this directory

These two files are the intended contents of `.github/workflows/ci.yml` and
`.github/workflows/docker-router.yml` for PR #29 (Bicep replaces Terraform).

They live here rather than in `.github/workflows/` because the token available
to the agent that wrote the PR carried only the `repo` scope, and GitHub refuses
any push that creates or updates a file under `.github/workflows/` without the
`workflow` scope. `.github/pending-workflows/` is a different path, so it pushes
normally — and GitHub Actions only reads `.github/workflows/`, so nothing here
runs or interferes in the meantime.

## Why this matters before merge

**`.github/workflows/ci.yml` on this branch is still the old version, and it
calls `./scripts/check-aca-arm-parity.sh`, which PR #29 deletes.** The `infra`
job will fail on every run until the swap below is done. That failure is
expected and is not a defect in the Bicep templates — verify them locally with
`./scripts/check-bicep.sh`, which is what the new job runs.

## Apply

From the repo root, on a machine whose credential has the `workflow` scope:

```bash
git mv -f .github/pending-workflows/ci.yml            .github/workflows/ci.yml
git mv -f .github/pending-workflows/docker-router.yml .github/workflows/docker-router.yml
git rm    .github/pending-workflows/README.md
git commit -m "ci: replace the ACA ARM parity gate with the Bicep template check"
git push
```

`git mv -f` overwrites the tracked originals in one step, so there is no window
in which `.github/workflows/` is missing a workflow. Removing this README is what
deletes the directory — git does not track empty directories.

## What changes

### `ci.yml` — REQUIRED

The `aca-parity` job becomes `infra`:

- `./scripts/check-aca-arm-parity.sh` -> `./scripts/check-bicep.sh`. The parity
  gate compared a Bicep reference file against an AzAPI body in Terraform using a
  hand-rolled Python HCL parser; with Terraform gone there is one copy of the
  sandbox-group shape and nothing to compare. The replacement compiles every
  template, type-checks `main.bicepparam.example` against `main.bicep`, and
  treats warnings as failures.
- The "Test router image deploy script" step is renamed to "Test deploy scripts",
  because `scripts/deploy-router-image.test.sh` now also covers the image-pin
  allowlist in `scripts/deploy-azure.sh`.
- The `Install Bicep` step is unchanged; only its comment is updated to name
  `check-bicep.sh`.

### `docker-router.yml` — cosmetic

Comment wording only. Three references to Terraform become references to Bicep
(`router_image`/`worker_image` -> `routerImage`/`workerImage`, `dev.tfvars` ->
`main.bicepparam`). No step, trigger, or tag behaviour changes.

## Verify after applying

```bash
actionlint .github/workflows/ci.yml .github/workflows/docker-router.yml
./scripts/check-bicep.sh                     # needs `bicep` on PATH
bash scripts/deploy-router-image.test.sh
```

All three pass as of the commit that added this directory.
