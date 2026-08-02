# Syncing with upstream

This repository is a **soft fork** of [`ceedaragents/cyrus`](https://github.com/ceedaragents/cyrus). It
carries substantial work upstream does not have — the `router`, `router-client`,
`router-protocol` and `router-executors` packages, the Azure hosting stack, and the
router image pipeline — and periodically absorbs upstream's changes.

`main` is this fork's **trunk**, not a mirror of upstream. It is the default branch, it
is what `ci.yml` and `docker-router.yml` build from, and it carries our work. Upstream
lives only on the `upstream` remote; there is no local branch mirroring it.

```
upstream/main ──┐
                ├──> sync/upstream-<date> ──PR──> main
      main ─────┘
```

## Remotes

```bash
git remote -v
# origin    https://github.com/nick-boey/cyrus      (our fork — trunk)
# upstream  https://github.com/ceedaragents/cyrus   (read-only source)
```

If `upstream` is missing:

```bash
git remote add upstream https://github.com/ceedaragents/cyrus.git
```

`gh` resolves a fork's parent by default, so `gh pr create` will silently target
`ceedaragents/cyrus` and fail with *"No commits between main and …"*. Set the default
once per clone:

```bash
gh repo set-default nick-boey/cyrus
```

## Cadence

**Sync per upstream release, or weekly — whichever comes first.**

This is the whole ballgame. Cadence matters far more than technique: four weeks of drift
produced nine conflicts and a day of work; one week is usually a lockfile and a version
bump. The conflicts are not proportional to upstream's commit count, they are
proportional to how long both sides moved independently.

## The recipe

```bash
git fetch upstream
git switch main && git pull
git switch -c sync/upstream-$(date +%Y-%m-%d)

git merge upstream/main          # resolve conflicts here — see below

pnpm install                     # regenerate the lockfile; never hand-merge it
pnpm audit                       # must report zero advisories
pnpm build && pnpm typecheck && pnpm test:packages:run

git push -u origin HEAD
gh pr create --base main --fill  # CI runs on the PR; merge when green
```

Merge — never rebase. `main` is published and shared, and its history already carries
roughly 43 duplicated patches from an earlier episode of rebasing branches that had
already been merged. Rebasing a shared branch is what creates that.

## Resolving the conflicts

Conflicts land in the same four places nearly every time.

### 1. Root `package.json` — the `pnpm` block (read this one carefully)

**Upstream keeps `pnpm.overrides` and `pnpm.onlyBuiltDependencies` in `package.json`. We
do not, and must not.** Under the pinned pnpm (`packageManager: pnpm@10.33.1`) that field
is **inert** — pnpm warns and ignores it. Ours live in `pnpm-workspace.yaml`, which is the
only place pnpm actually reads them. See the Dependency Security Policy in `CLAUDE.md`.

So the resolution is *keep ours* (no `pnpm` block) — but **that is not the end of it.**
Upstream ships security-advisory patches as entries in that block. Dropping the block
wholesale silently drops those fixes.

**Always diff upstream's block against `pnpm-workspace.yaml` and migrate anything missing
or weaker:**

```bash
git show upstream/main:package.json | python3 -c "import json,sys; \
  print('\n'.join(f'{k} {v}' for k,v in json.load(sys.stdin)['pnpm']['overrides'].items()))" \
  | while read -r name want; do
      have=$(grep -E "^\s+'?${name}'?:" pnpm-workspace.yaml | head -1 | sed "s/.*: *//;s/'//g")
      [ "$have" = "$want" ] || printf '%-36s upstream=%-12s ours=%s\n' "$name" "$want" "${have:-MISSING}"
    done
```

In the 2026-08-02 sync this caught nine real gaps: `body-parser`, `js-yaml`,
`shell-quote`, `systeminformation`, `picomatch` and `@opentelemetry/propagator-jaeger`
were absent entirely; `brace-expansion`, `simple-git` and `@hono/node-server` were pinned
below upstream's floor.

It compares range *strings*, so read the output rather than acting on it mechanically.
Only a **lower** floor on our side is a gap. A range that is equivalent or stricter is
fine and should be left alone — today `undici` prints as differing (`^7.28.0` vs
upstream's `>=7.28.0`) but ours cannot resolve below `7.28.0` either, so there is nothing
to fix.

### 2. Package manifests — take the newer range per dependency

Resolve dependency-by-dependency, not side-by-side. We usually lead (we track the Claude
Agent SDK and TypeScript closely), but not always — upstream has led on tooling such as
`nodemon`. Keep every dependency that exists only on our side (`cyrus-workspace-sync`,
the router packages).

### 3. `CHANGELOG.md`

Keep our `[Unreleased]` entries **and** insert upstream's new release section beneath
them. Drop upstream's `_No unreleased changes._` placeholder. `CHANGELOG.internal.md` is
ours alone and should not conflict.

### 4. `pnpm-lock.yaml`

Never hand-merge it.

```bash
git checkout --ours pnpm-lock.yaml
pnpm install
```

## Contributing a fix back upstream

Some of our fixes are to code upstream also ships (anything under `packages/edge-worker`,
`packages/core`, the runners). Those are worth sending back. Branch off `upstream/main`
directly — no mirror branch is needed:

```bash
git fetch upstream
git switch -c fix/<name> upstream/main
git cherry-pick <sha>
git push -u origin HEAD
gh pr create --repo ceedaragents/cyrus --base main
```

Fixes to router/Azure code, our workflow files, or lint differences caused by our newer
Biome are ours alone and do not travel.

## Notes

- **CI is the source of truth for lint.** `pnpm lint` / `pnpm biome ci` cannot be run
  locally on macOS — Biome exits with `Linter process terminated abnormally (possibly out
  of memory)` regardless of the change. Individual files can usually be checked with
  `npx biome check <file>`, but a few large files OOM on their own. Trust the PR run.
- **We run a newer Biome than upstream** (`^2.5.5` vs `^2.1.3`), so files upstream
  considers clean can fail our formatter after a sync. That is expected; run
  `npx biome format --write <file>` on what CI names.
- A sync must never be merged on a red PR. CI on this fork was dormant for 316 commits
  and hid five real defects, including a proxy shutdown that could hang forever. Treat a
  red run as a finding, not as noise.
