# Container Executors Phase 2: Fly Machines Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Users with `executor: fly` get a Fly Machine + persistent volume per issue — near-instant resume from stopped state, storage-only cost while parked — plus router-minted GitHub App installation tokens so containers need no long-lived GitHub PAT.

**Architecture:** `FlyMachinesProvider implements ContainerExecutor` (the phase 1 interface) against the Fly Machines REST API (`api.machines.dev`), with a typed `FlyClient` wrapper and injectable `fetch` for tests. A volume named per issue is mounted at `/workspaces`, so the phase 1 boot path (`cyrus container-boot`) works unchanged. GitHub auth upgrades from PAT-in-secrets to short-lived installation tokens served by a new router HTTP endpoint backed by the existing `GitHubAppTokenProvider`.

**Tech Stack:** TypeScript strict, Vitest, Fly Machines REST API v1, `cyrus-github-event-transport` (existing `GitHubAppTokenProvider`).

**Prerequisite:** Phase 1 plan fully landed (`docs/superpowers/plans/2026-07-13-container-executors-phase1-floor-docker.md`).

## Global Constraints

- Same repo conventions as phase 1 (tabs, Vitest in `test/`, package filters, changelog rules).
- Fly volume names only allow `[a-zA-Z0-9_]` — issue keys are sanitized with `_`, and the true issue key always travels in machine `config.metadata.cyrus_issue` (that metadata value, not the name, is the source of truth for `listManaged`).
- The worker image must be pullable by Fly (push the phase 1 image to a registry Fly can reach; document `fly auth docker` + GHCR or `registry.fly.io` in the README step).
- One-time operator setup documented, not automated: `fly apps create <app>`; the API token comes from `fly tokens create deploy -a <app>`.
- No new WebSocket protocol frames; the GitHub token endpoint is HTTP with device-token auth, mirroring the artifact endpoints.

---

### Task 1: FlyClient — typed Machines API wrapper

**Files:**
- Create: `packages/router-executors/src/fly/FlyClient.ts`
- Test: `packages/router-executors/test/FlyClient.test.ts`

**Interfaces:**
- Produces (consumed by Task 2):

```typescript
export interface FlyMachine {
	id: string;
	name: string;
	state: string; // created|starting|started|stopping|stopped|destroying|destroyed
	config: { image?: string; metadata?: Record<string, string> };
}
export interface FlyVolume { id: string; name: string }

export class FlyClient {
	constructor(opts: { apiToken: string; app: string; fetchFn?: typeof fetch; baseUrl?: string });
	listMachines(): Promise<FlyMachine[]>;
	createMachine(body: {
		name: string;
		region: string;
		config: {
			image: string;
			env: Record<string, string>;
			guest: { cpu_kind: string; cpus: number; memory_mb: number };
			mounts: Array<{ volume: string; path: string }>;
			metadata: Record<string, string>;
			restart: { policy: "on-failure" };
			auto_destroy: false;
		};
	}): Promise<FlyMachine>;
	startMachine(id: string): Promise<void>;
	stopMachine(id: string): Promise<void>;
	deleteMachine(id: string): Promise<void>; // ?force=true
	listVolumes(): Promise<FlyVolume[]>;
	createVolume(body: { name: string; region: string; size_gb: number }): Promise<FlyVolume>;
	deleteVolume(id: string): Promise<void>;
}
```

Every method: `fetch(`${baseUrl}/apps/${app}/…`)` with `authorization: Bearer <apiToken>`, `content-type: application/json`; non-2xx (except DELETE on 404, which is treated as success) throws `Error` including status + response body text. `baseUrl` defaults to `https://api.machines.dev/v1`.

- [ ] **Step 1: Write failing tests** — a `fakeFetch` capturing `(url, init)` and returning scripted `Response` objects (`new Response(JSON.stringify(...), { status })`). Cover: URL/method/auth-header construction for each endpoint; error thrown on 500 with body text included; DELETE tolerating 404; `?force=true` on machine delete.
- [ ] **Step 2: Verify failure** — `pnpm --filter cyrus-router-executors test:run` → FAIL.
- [ ] **Step 3: Implement** — thin private `request<T>(method, path, body?, okOn404?)` helper; each public method one call.
- [ ] **Step 4: Verify pass.**
- [ ] **Step 5: Verify the API shapes against the live docs** — WebFetch/read `https://docs.machines.dev` (Machines API reference) and confirm: create-machine body fields (`config.guest`, `config.mounts[].volume` takes the **volume id**, mount `path`), volume create fields, wait/start/stop paths. Fix client + tests for any drift found; note confirmed-against date in a doc comment.
- [ ] **Step 6: Commit** — `git commit -m "feat(router-executors): typed Fly Machines API client"`

---

### Task 2: FlyMachinesProvider + config wiring

**Files:**
- Create: `packages/router-executors/src/fly/FlyMachinesProvider.ts`
- Modify: `packages/router-executors/src/index.ts`, `packages/router/src/RouterServer.ts` (registry gains `"fly"` when configured), `apps/cli/src/commands/RouterCommand.ts` (Zod: `containers.fly` block)
- Test: `packages/router-executors/test/FlyMachinesProvider.test.ts`

**Interfaces:**
- Consumes: `FlyClient` (Task 1), `ContainerExecutor`/`IssueExecutionContext` (phase 1 Task 5).
- Produces: `new FlyMachinesProvider(opts: { client: FlyClient; image: string; region: string; guest?: { cpuKind?: string; cpus?: number; memoryMb?: number }; volumeGb?: number })` with `provider = "fly"`. Defaults: `guest = { cpuKind: "shared", cpus: 4, memoryMb: 8192 }`, `volumeGb = 10`.
- Config addition (`RouterContainersConfig`): `fly?: { apiToken: string; app: string; region: string; guest?: { cpuKind?: string; cpus?: number; memoryMb?: number }; volumeGb?: number }` + matching Zod in `RouterConfigFileSchema`. RouterServer: `if (config.containers?.fly) executors.set("fly", new FlyMachinesProvider({ client: new FlyClient(config.containers.fly), image: config.containers.image, ...config.containers.fly }))`.

**Provider semantics (encode as tests, FlyClient mocked):**
- Naming: machine name + volume name `cyrus_issue_<key.replace(/[^a-zA-Z0-9_]/g, "_")>`; `metadata.cyrus_issue = <exact issue key>`.
- `findMachine(issueKey)`: `listMachines()` → match on `config.metadata.cyrus_issue`.
- `ensureRunning(ctx)`:
  - machine `started` + image matches → no-op.
  - machine `stopped` + image matches → `startMachine(id)` (no token re-mint — env persists on the machine).
  - machine exists, image stale → `deleteMachine(id)` then fall through to create (volume outlives the machine).
  - absent → volume: `listVolumes()` match by name, else `createVolume({ name, region, size_gb: volumeGb })`; then `createMachine` with `mounts: [{ volume: <volume id>, path: "/workspaces" }]`, `env: { ...ctx.env, CYRUS_DEVICE_TOKEN: ctx.mintDeviceToken() }`, guest mapped to `{ cpu_kind, cpus, memory_mb }`.
  - machine in a transitional state (`starting`/`stopping`) → no-op (next sweep/route retries).
- `stop` → `stopMachine` when state is `started` (else no-op).
- `destroy` → `deleteMachine` (force) if present, then `deleteVolume` if present.
- `status` → absent / `started`→`running` / anything else present → `stopped`.
- `listManaged` → metadata values from `listMachines()`.

- [ ] **Step 1: Write failing tests** — one per semantic bullet (eight tests), FlyClient stubbed with `vi.fn()` returning scripted machines/volumes.
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Verify pass** (`pnpm --filter cyrus-router-executors test:run && pnpm --filter cyrus-router test:run`).
- [ ] **Step 5: Extend `docker/worker/README.md`** with the Fly runbook: create app, push image, mint deploy token, `containers.fly` config example with the shared-cpu-4x/8GB default and `routerUrlForContainers` set to the router's public `wss://` URL (Fly machines reach the router over the internet — the router must be tunnel/host-exposed exactly as physical devices already require).
- [ ] **Step 6: Commit** — `git commit -m "feat(router-executors): Fly Machines provider — volume-per-issue ephemeral workers"`

---

### Task 3: Router-minted GitHub App installation tokens

Replaces the PAT-in-secrets requirement for container git access (PAT stays as fallback). Severable: phases 1–2 work without it.

**Files:**
- Create: `packages/router/src/github-token.ts`
- Modify: `packages/router/src/RouterServer.ts` (register route; config gains `githubApp`), `apps/cli/src/commands/RouterCommand.ts` (Zod + config docs), `apps/cli/src/commands/ContainerBootCommand.ts` (credential helper wiring), new CLI subcommand `cyrus github-credential` (same command file or sibling)
- Test: `packages/router/test/github-token.test.ts`, extend `apps/cli/test/ContainerBootCommand.test.ts`

**Interfaces:**
- Consumes: `GitHubAppTokenProvider` from `packages/github-event-transport/src/GitHubAppTokenProvider.ts` (existing: signs an App JWT, exchanges for a cached installation token, refreshes 5 min before expiry — check its constructor signature before wiring and match it exactly).
- Produces:
  - Router config: `githubApp?: { appId: string; privateKeyPath: string; installationId: string }` (top level of `RouterServerConfig` + Zod mirror).
  - `registerGithubTokenRoute(fastify, store, provider)`: `GET /github/installation-token` with `Authorization: Bearer <deviceToken>` → 200 `{ token: string, expiresAt: string }`; 401 bad device token; 404 when `githubApp` is not configured (route not registered).
  - Container side: `cyrus github-credential get` — a [git credential helper](https://git-scm.com/docs/gitcredentials) subcommand that reads `router.url` + `router.deviceToken` from `<cyrusHome>/config.json`, fetches the endpoint, and prints `username=x-access-token\npassword=<token>\n` to stdout. Exits 1 (so git falls through to other helpers) on any failure.
  - `container-boot` change: when `GIT_TOKEN` is absent, set `git config --global credential.helper "!cyrus github-credential get --cyrus-home <cyrusHome>"` instead of writing `~/.git-credentials`, and perform the initial clones by fetching one token from the endpoint up front. When `GIT_TOKEN` is present, behavior is unchanged (PAT wins — simplest and already tested).

- [ ] **Step 1: Write failing tests** — route: token round-trip with a stubbed provider, 401 on bad token; credential helper: prints the git-credential format from a stubbed fetch, exit-1 on HTTP failure; container-boot: helper configured when `GIT_TOKEN` absent, `.git-credentials` when present.
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Verify pass** (router + cli filters).
- [ ] **Step 5: Commit** — `git commit -m "feat(router): serve short-lived GitHub App installation tokens to containers"`

---

### Task 4: Validation + changelog

- [ ] **Step 1: Full gates** — `pnpm test:packages:run && pnpm typecheck && pnpm build && pnpm lint` → all pass.
- [ ] **Step 2: Live Fly smoke** (operator-run; document results): create a throwaway Fly app, point `containers.fly` at it, `set-executor <you> fly`, delegate a test issue → machine + volume appear in `fly machines list`; prompt after idle-stop → machine restarts and the session resumes with the same worktree; `cyrus router containers destroy` + sweep → machine and volume deleted. Then switch the same user `fly → docker` and re-prompt the issue: work continues from the WIP branch + bundle (executor-switch floor proof).
- [ ] **Step 3: Changelog** — `CHANGELOG.md` Added: "Fly Machines executor: per-issue cloud workers that stop when idle (storage-only cost) and resume in seconds" + "Containers can now authenticate to GitHub with short-lived tokens minted from your GitHub App — no PAT required". Internal changelog: FlyClient/provider, github-token endpoint.
- [ ] **Step 4: Commit** — `git commit -m "docs: phase 2 changelog + Fly validation notes"`
