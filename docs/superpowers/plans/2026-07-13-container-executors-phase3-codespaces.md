# Container Executors Phase 3: GitHub Codespaces Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users with `executor: codespaces` get a codespace per issue — devcontainers, prebuilds, and dotfiles come from the platform; the phase 1 floor covers the 30-day retention expiry.

**Architecture:** `CodespacesProvider implements ContainerExecutor`, driving the `gh codespace` CLI (authenticated as a machine user via `GH_TOKEN`) through an injectable exec, mirroring `LocalDockerProvider`'s test seam. A codespace is identified by display name `cyrus:<issueKey>`. Bootstrap pushes an env file over `gh codespace ssh`, installs the pinned `cyrus-ai` npm package if missing, and launches the same `cyrus container-boot` restore ladder as Docker/Fly — clones and worktrees live under `/workspaces` (user-writable in codespaces), so the canonical cwd `/workspaces/<ISSUE-KEY>` is identical across all three providers and Claude-session resume survives provider switches.

**Tech Stack:** TypeScript strict, Vitest, `gh` CLI (`codespace create/list/ssh/stop/delete`), phase 1's `ContainerExecutor` + `cyrus container-boot`.

**Prerequisites:** Phase 1 landed; phase 2 landed (reuses its GitHub App token endpoint if configured, else per-user PATs). Operator setup (documented, not automated): a GitHub machine user with repo access + `codespace` scope token; org Codespaces policy allowing it.

## Global Constraints

- Same repo conventions as phases 1–2.
- Display name scheme `cyrus:<issueKey>` is the source of truth for `listManaged`; never parse Codespaces' generated names.
- The bootstrap must be idempotent — `ensureRunning` on an already-bootstrapped codespace must not duplicate processes (guard: `pgrep -f "cyrus.*start"` check in the boot script).
- Pin the installed CLI version: `npm install -g cyrus-ai@<version>` where `<version>` is read from the monorepo root `package.json` at build time of the provider config (config field `cliVersion`, required).

---

### Task 1: GhCodespacesClient — CLI wrapper

**Files:**
- Create: `packages/router-executors/src/codespaces/GhCodespacesClient.ts`
- Test: `packages/router-executors/test/GhCodespacesClient.test.ts`

**Interfaces:**
- Produces (consumed by Task 2):

```typescript
export interface CodespaceInfo { name: string; displayName: string; state: string; repository: string }

export class GhCodespacesClient {
	constructor(opts: { ghToken: string; exec?: ExecFn }); // ExecFn re-exported from LocalDockerProvider's module
	list(): Promise<CodespaceInfo[]>;               // gh codespace list --json name,displayName,state,repository
	create(opts: { repo: string; branch?: string; machine?: string; displayName: string; idleTimeoutMinutes: number; retentionDays?: number }): Promise<string>; // returns codespace name
	stop(name: string): Promise<void>;              // gh codespace stop -c <name>
	delete(name: string): Promise<void>;            // gh codespace delete -c <name> --force
	sshExec(name: string, script: string): Promise<void>;   // gh codespace ssh -c <name> -- bash -lc <script>
	sshWriteFile(name: string, path: string, content: string): Promise<void>; // pipe content via stdin: gh codespace ssh -c <name> -- "cat > <path> && chmod 600 <path>"
}
```

All invocations pass `GH_TOKEN` via the child env (extend `ExecFn` usage with an env option: `type ExecFn = (cmd, args, opts?: { env?: Record<string,string>; stdin?: string }) => Promise<{stdout, exitCode}>` — update the phase 1 `ExecFn` signature in `packages/router-executors/src/LocalDockerProvider.ts` accordingly; its default impl gains optional `env`/`stdin` handling, existing call sites unaffected). Non-zero exit throws with stdout in the message, except `delete` on "not found" output which is treated as success.

- [ ] **Step 1: Write failing tests** — fake exec asserting exact argv for each method, env containing `GH_TOKEN`, stdin plumbing for `sshWriteFile`, create parsing the codespace name from stdout, error propagation.
- [ ] **Step 2: Verify failure** — `pnpm --filter cyrus-router-executors test:run`.
- [ ] **Step 3: Implement** (including the `ExecFn` extension and default-impl stdin support via `child.stdin.end(content)`).
- [ ] **Step 4: Verify pass**, then verify flags against `gh codespace create --help` / `list --help` locally and fix drift.
- [ ] **Step 5: Commit** — `git commit -m "feat(router-executors): gh codespace CLI client"`

---

### Task 2: CodespacesProvider

**Files:**
- Create: `packages/router-executors/src/codespaces/CodespacesProvider.ts`
- Modify: `packages/router-executors/src/index.ts`, `packages/router/src/RouterServer.ts`, `apps/cli/src/commands/RouterCommand.ts` (Zod)
- Test: `packages/router-executors/test/CodespacesProvider.test.ts`

**Interfaces:**
- Consumes: `GhCodespacesClient` (Task 1), `ContainerExecutor` (phase 1).
- Produces: `new CodespacesProvider(opts: { client: GhCodespacesClient; repo: string; machine?: string; idleTimeoutMinutes?: number; retentionDays?: number; cliVersion: string })`, `provider = "codespaces"`. Config: `containers.codespaces?: { ghToken: string; repo: string; machine?: string; idleTimeoutMinutes?: number; retentionDays?: number; cliVersion: string }` (`repo` = the codespace host repo slug, typically the primary repo from `containers.repositories`). Defaults: `machine = "standardLinux32gb"` (4-core), `idleTimeoutMinutes = 30`.

**Provider semantics (encode as tests, client mocked):**
- `find(issueKey)`: `list()` → `displayName === `cyrus:${issueKey}``.
- `ensureRunning(ctx)`:
  - absent → `create({ repo, displayName, machine, idleTimeoutMinutes, retentionDays })` → bootstrap (below). Codespaces that expired from retention hit this path; the restore ladder recovers state — that is the designed behavior, add an explicit test asserting create+bootstrap when `list` returns nothing.
  - state `Shutdown` (stopped) → bootstrap (ssh auto-starts the codespace; the boot script's pgrep guard makes re-entry safe).
  - state `Available` → sshExec a liveness probe (`pgrep -f 'cyrus.*start' || exit 3`); exit 3 → bootstrap; else no-op.
  - **Bootstrap** = `sshWriteFile(name, "~/.cyrus-boot.env", envFile)` where `envFile` is `KEY='value'` lines for `ctx.env` **plus** `CYRUS_DEVICE_TOKEN='<ctx.mintDeviceToken()>'` and `CYRUS_WORKSPACES_DIR='/workspaces'`; then `sshExec(name, BOOT_SCRIPT)` with:

```bash
set -e
command -v cyrus >/dev/null 2>&1 || npm install -g cyrus-ai@<cliVersion>
pgrep -f "cyrus.*container-boot\|cyrus.*start" >/dev/null && exit 0
set -a; . ~/.cyrus-boot.env; set +a
nohup cyrus container-boot >> ~/cyrus-boot.log 2>&1 &
```

  (Token note: every bootstrap re-mints the device token — unlike Docker/Fly there is no create-time env, so the env file is refreshed on each bootstrap and rotation is always safe.)
- `stop` → `stop(name)` when found.
- `destroy` → `delete(name)` when found.
- `status` → absent; `Available` → `running`; else `stopped`.
- `listManaged` → display names with the `cyrus:` prefix, prefix stripped.

- [ ] **Step 1: Write failing tests** — one per bullet (absent→create+bootstrap; stopped→bootstrap only; available+alive→no-op; available+dead→bootstrap; stop/destroy/status/listManaged mappings; env file contains minted token + workspaces dir).
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Verify pass** (`pnpm --filter cyrus-router-executors test:run && pnpm --filter cyrus-router test:run`).
- [ ] **Step 5: Commit** — `git commit -m "feat(router-executors): Codespaces provider — codespace-per-issue with restore-ladder bootstrap"`

---

### Task 3: Validation + changelog

- [ ] **Step 1: Full gates** — `pnpm test:packages:run && pnpm typecheck && pnpm build && pnpm lint`.
- [ ] **Step 2: Live smoke** (operator-run, documented): `set-executor <you> codespaces`; delegate an issue → codespace appears (`gh codespace list`), session runs, activities flow; wait for idle-stop, re-prompt → same codespace restarts, session resumes; `gh codespace delete` the codespace manually, re-prompt → new codespace, work restored from floor (retention-expiry drill); switch the user `codespaces → fly` and confirm the Claude session resumes across providers (canonical-cwd proof: same `/workspaces/<KEY>` on both).
- [ ] **Step 3: Changelog** — Added: "GitHub Codespaces executor: run each issue in a codespace with your repo's devcontainer, prebuilds, and your dotfiles — Cyrus recreates expired codespaces from its persistence floor automatically." Internal: GhCodespacesClient, provider, ExecFn env/stdin extension.
- [ ] **Step 4: Update the spec** status to "Implemented (phases 1–3)" and note ACA remains unimplemented-by-design (stateless path exists whenever wanted).
- [ ] **Step 5: Commit** — `git commit -m "docs: phase 3 changelog + codespaces validation notes"`
