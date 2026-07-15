# Container-Executor Validation Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a router-mode F1 test harness and an opt-in real-Docker e2e suite, then use them to validate the container lifecycle, the persistence-floor upload round-trip, and the `/workspaces/<ISSUE-KEY>` real-directory invariant.

**Architecture:** A new `apps/f1/router-server.ts` stands up a real `RouterServer` (from `packages/router`) in-process, backed by a `CLIIssueTrackerService` via the `trackerFactory` seam so Linear is never touched. Webhooks are fed directly into `server.eventRouter.route()`; a separate loopback Fastify, guarded by a bearer token, exposes the F1 control surface (and mounts a `CLIRPCServer` so existing `./f1` commands keep working). Container boot uses the real `LocalDockerProvider` (default) or an injected `FakeBootExecutor` (no-Docker smoke). Real-Docker validations live in an opt-in Vitest suite that `skipIf(no daemon)` and runs against a dedicated daemon with run-scoped resource names.

**Tech Stack:** TypeScript, Bun (F1 server/CLI runtime), Node `node:net`/`node:child_process`, Fastify v5, Vitest, Commander.js, Docker CLI, `cyrus-router` / `cyrus-router-executors` / `cyrus-router-client` / `cyrus-core` / `cyrus-workspace-sync` workspace packages.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-15-container-executor-validation-design.md` — this plan implements **Track A**; Track B (the anomaly investigation) is the appendix at the end and is executed via systematic-debugging, not as TDD tasks.
- **Zero `any` types** throughout F1 code (F1 house rule, `apps/f1/CLAUDE.md`).
- **Prompt-assembly and existing unit suites must stay green.** CLI-mode `apps/f1/server.ts` is an untouched regression surface — do not modify it.
- **`RouterServer` production code must not change** for the default (in-process rig) approach: its Fastify is private and Fastify v5 forbids adding routes after `listen()`. Drive it via `server.eventRouter`, `server.store`, and the artifacts dir only.
- **Real-Docker safety:** the ENTIRE real-Docker suite MUST run against a dedicated/disposable daemon (separate Docker context or explicit `DOCKER_HOST`), gated behind `CYRUS_E2E_DEDICATED_DOCKER=1` — not just the orphan-GC test. Reason: `ContainerLifecycle.sweep()` **always** runs orphan GC over the live daemon (`packages/router/src/ContainerLifecycle.ts:114-141`), so idle-stop and stale-destroy tests (which call `sweep()`) would also destroy a developer's real containers. Non-orphan tests additionally wrap the provider in a scoped adapter (`listManaged()` → only this run's keys). Use run-scoped collision-proof issue keys; scope teardown to the exact resources created — never a `cyrus-issue-*` wildcard.
- **Router bind interface:** the container-facing `RouterServer` MUST bind `0.0.0.0` (a container reaching `host.docker.internal` cannot reach a loopback-bound service on Linux). Only the F1 control plane binds `127.0.0.1`.
- **`RouterContainersConfig` shape** (verbatim, `packages/router/src/RouterServer.ts:53-78`): `{ image: string; routerUrlForContainers: string; repositories: Array<{ name; githubSlug; linearWorkspaceId; baseBranch? }>; artifactsDir?; secretsPath?; idleStopMs?; staleDestroyMs?; docker?: { memoryLimit?; network? } }`.
- **Container required env** (`apps/cli/src/commands/ContainerBootCommand.ts:34-40`): `CYRUS_ROUTER_URL, CYRUS_DEVICE_TOKEN, CYRUS_ISSUE_KEY, CYRUS_REPOS_JSON, CLAUDE_CODE_OAUTH_TOKEN`.
- **Artifact endpoint URL shape:** `PUT|GET /artifacts/issues/:issueKey/bundle` (`packages/router/src/artifacts.ts`).
- **Commit style:** frequent, one per task minimum. Run `pnpm --filter cyrus-f1 typecheck` (or the app's package name) before each commit touching F1 code.

---

## File Structure

New files (all under `apps/f1/` unless noted):

- `src/router/allocatePort.ts` — pick a free TCP port up front (fixed-port fix for the late-bound router URL).
- `src/router/fixtures.ts` — `createdFixture`, `promptedFixture`, `seedSession` (lifted from `packages/router/test/containers-e2e.test.ts`, exported for reuse by the rig and its tests).
- `src/router/RouterRig.ts` — `createRouterRig(opts)`: constructs the in-process `RouterServer` + shared `CLIIssueTrackerService`, wires the executor registry (real or fake), returns a handle.
- `src/router/ControlServer.ts` — the loopback, token-guarded Fastify control plane: mounts `CLIRPCServer` + adds `/router/*` routes.
- `router-server.ts` — the executable entrypoint (sibling to `server.ts`) that assembles the rig + control server and prints connection info.
- `src/commands/router/enroll.ts`, `inject.ts`, `seedUser.ts`, `artifact.ts` — `./f1 router:*` subcommands.
- `test/router/router-rig.test.ts` — Phase 1 in-process tests (fake executor, no Docker).
- `test/router/control-server.test.ts` — Phase 1 control-plane auth + routing tests.
- `packages/router/test/containers-real-docker.e2e.test.ts` — Phases 2–4 opt-in real-Docker suite.
- `packages/router/test/helpers/dockerDaemon.ts` — daemon-availability probe, dedicated-daemon guard, run-scoped naming, scoped teardown.

Modified:

- `apps/f1/src/cli.ts` — register the four `router:*` subcommands.
- `apps/f1/package.json` — add a `router-server` script.

---

## Phase 1 — Router-mode F1 rig (spec A1)

### Task 1: Free-port allocation helper

**Files:**
- Create: `apps/f1/src/router/allocatePort.ts`
- Test: `apps/f1/test/router/allocatePort.test.ts`

**Interfaces:**
- Produces: `allocatePort(): Promise<number>` — an ephemeral TCP port that was free at call time, bound to `127.0.0.1`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/f1/test/router/allocatePort.test.ts
import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { allocatePort } from "../../src/router/allocatePort.js";

describe("allocatePort", () => {
  it("returns a port that can then be bound", async () => {
    const port = await allocatePort();
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
    // The port was released before returning, so we can bind it now.
    await new Promise<void>((resolve, reject) => {
      const srv = createServer();
      srv.once("error", reject);
      srv.listen(port, "127.0.0.1", () => srv.close(() => resolve()));
    });
  });

  it("returns distinct ports across successive calls", async () => {
    const a = await allocatePort();
    const b = await allocatePort();
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/f1 && pnpm vitest run test/router/allocatePort.test.ts`
Expected: FAIL — `Cannot find module '../../src/router/allocatePort.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/f1/src/router/allocatePort.ts
import { createServer } from "node:net";

/**
 * Bind an ephemeral port, read it back, then release it. The router must know
 * its port BEFORE construction (RouterContainersConfig.routerUrlForContainers
 * is consumed in the RouterServer constructor, but server.port is only known
 * after listen()), so `port: 0` is unusable here. There is a small TOCTOU
 * window between release and re-bind; acceptable for a local test rig.
 */
export function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      if (address && typeof address === "object") {
        const { port } = address;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("allocatePort: no port assigned")));
      }
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/f1 && pnpm vitest run test/router/allocatePort.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/f1/src/router/allocatePort.ts apps/f1/test/router/allocatePort.test.ts
git commit -m "test(f1): free-port allocation helper for router rig"
```

---

### Task 2: Webhook fixtures + session seeder module

**Files:**
- Create: `apps/f1/src/router/fixtures.ts`
- Test: `apps/f1/test/router/fixtures.test.ts`

**Interfaces:**
- Consumes: `AgentEvent`, `CLIIssueTrackerService`, `AgentSessionStatus`, `AgentSessionType` from `cyrus-core`.
- Produces:
  - `createdFixture(opts: { sessionId: string; issue: { id: string; identifier: string; title: string }; creator: Creator }): AgentEvent`
  - `promptedFixture(opts: { sessionId: string; actorUserId: string; creator: Creator; issue: {...}; body: string }): AgentEvent`
  - `seedSession(tracker: CLIIssueTrackerService, sessionId: string, issueId: string): void`
  - `interface Creator { id: string; email: string; name: string }`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/f1/test/router/fixtures.test.ts
import { CLIIssueTrackerService } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { createdFixture, promptedFixture, seedSession } from "../../src/router/fixtures.js";

const CREATOR = { id: "lin-1", email: "a@example.com", name: "A" };

describe("router fixtures", () => {
  it("createdFixture is a valid agentSessionCreated event", () => {
    const ev = createdFixture({
      sessionId: "s1",
      issue: { id: "i1", identifier: "CYPACK-1", title: "T" },
      creator: CREATOR,
    });
    expect(ev.type).toBe("AgentSessionEvent");
    expect(ev.action).toBe("created");
    expect((ev as any).agentSession.issue.identifier).toBe("CYPACK-1");
  });

  it("promptedFixture carries the prompt body", () => {
    const ev = promptedFixture({
      sessionId: "s1",
      actorUserId: "lin-1",
      creator: CREATOR,
      issue: { id: "i1", identifier: "CYPACK-1", title: "T" },
      body: "go",
    });
    expect(ev.action).toBe("prompted");
    expect((ev as any).agentActivity.content.body).toBe("go");
  });

  it("seedSession makes activities recordable for the session", () => {
    const tracker = new CLIIssueTrackerService();
    tracker.seedDefaultData();
    seedSession(tracker, "s1", "i1");
    expect(tracker.getState().agentSessions.get("s1")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/f1 && pnpm vitest run test/router/fixtures.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Copy the three helpers verbatim from `packages/router/test/containers-e2e.test.ts:54-141` into the new module and export them. Concretely:

```typescript
// apps/f1/src/router/fixtures.ts
import {
  type AgentEvent,
  AgentSessionStatus,
  AgentSessionType,
  type CLIIssueTrackerService,
} from "cyrus-core";

export interface Creator {
  id: string;
  email: string;
  name: string;
}

const WORKSPACE = "ws-1";

export function createdFixture(opts: {
  sessionId: string;
  issue: { id: string; identifier: string; title: string };
  creator: Creator;
}): AgentEvent {
  return {
    type: "AgentSessionEvent",
    action: "created",
    organizationId: WORKSPACE,
    createdAt: new Date().toISOString(),
    agentSession: {
      id: opts.sessionId,
      organizationId: WORKSPACE,
      status: "active",
      type: "issue",
      creator: opts.creator,
      issueId: opts.issue.id,
      issue: {
        id: opts.issue.id,
        identifier: opts.issue.identifier,
        title: opts.issue.title,
        url: `linear://issue/${opts.issue.identifier}`,
        team: { id: "team-1", key: "DEF", name: "Default" },
      },
    },
    guidance: [],
  } as unknown as AgentEvent;
}

export function promptedFixture(opts: {
  sessionId: string;
  actorUserId: string;
  creator: Creator;
  issue: { id: string; identifier: string; title: string };
  body: string;
}): AgentEvent {
  return {
    type: "AgentSessionEvent",
    action: "prompted",
    organizationId: WORKSPACE,
    createdAt: new Date().toISOString(),
    agentActivity: {
      id: `act-${opts.sessionId}-${opts.actorUserId}`,
      userId: opts.actorUserId,
      content: { type: "prompt", body: opts.body },
    },
    agentSession: {
      id: opts.sessionId,
      organizationId: WORKSPACE,
      status: "active",
      type: "issue",
      creator: opts.creator,
      issueId: opts.issue.id,
      issue: {
        id: opts.issue.id,
        identifier: opts.issue.identifier,
        title: opts.issue.title,
        url: `linear://issue/${opts.issue.identifier}`,
        team: { id: "team-1", key: "DEF", name: "Default" },
      },
    },
  } as unknown as AgentEvent;
}

export function seedSession(
  tracker: CLIIssueTrackerService,
  sessionId: string,
  issueId: string,
): void {
  tracker.getState().agentSessions.set(sessionId, {
    id: sessionId,
    status: AgentSessionStatus.Active,
    type: AgentSessionType.CommentThread,
    createdAt: new Date(),
    updatedAt: new Date(),
    issueId,
  });
}

export { WORKSPACE };
```

> Note: `WORKSPACE = "ws-1"` is the single workspace id the rig serves; keep it consistent across the rig, its config, and fixtures.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/f1 && pnpm vitest run test/router/fixtures.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/f1/src/router/fixtures.ts apps/f1/test/router/fixtures.test.ts
git commit -m "test(f1): shared router webhook fixtures + session seeder"
```

---

### Task 3: `createRouterRig` — in-process RouterServer + CLI tracker

**Files:**
- Create: `apps/f1/src/router/RouterRig.ts`
- Test: `apps/f1/test/router/router-rig.test.ts`

**Interfaces:**
- Consumes: `allocatePort` (Task 1), `createdFixture`/`promptedFixture`/`seedSession`/`WORKSPACE` (Task 2). `RouterServer`, `RouterContainersConfig` from `cyrus-router`; `ContainerExecutor` from `cyrus-router-executors`; `CLIIssueTrackerService` from `cyrus-core`.
- Produces:
  ```typescript
  interface RouterRig {
    server: RouterServer;
    tracker: CLIIssueTrackerService;
    port: number;              // the fixed router port
    seedUser(opts: { email: string; linearId: string; provider: string; claudeOauthToken: string }): void;
    stop(): Promise<void>;
  }
  interface RouterRigOptions {
    dbPath: string;            // ":memory:" for tests, a temp path for the server
    secretsPath: string;
    artifactsDir: string;
    host?: string;             // default "0.0.0.0" so a container can reach it via host.docker.internal; fake-executor unit tests may pass "127.0.0.1"
    image?: string;            // default "cyrus-worker:test"
    executors?: Map<string, ContainerExecutor>;  // omit → real LocalDockerProvider registry (default)
    idleStopMs?: number;
    staleDestroyMs?: number;
    logger?: { info(m: string): void; warn(m: string): void };
  }
  createRouterRig(opts: RouterRigOptions): Promise<RouterRig>
  ```

- [ ] **Step 1: Write the failing test**

```typescript
// apps/f1/test/router/router-rig.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerExecutor, ContainerStatus, IssueExecutionContext } from "cyrus-router-executors";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRouterRig, type RouterRig } from "../../src/router/RouterRig.js";
import { createdFixture } from "../../src/router/fixtures.js";
import { seedSession } from "../../src/router/fixtures.js";

/** Minimal fake executor: records ensureRunning, never touches Docker. */
class RecordingExecutor implements ContainerExecutor {
  readonly provider = "docker";
  readonly calls: string[] = [];
  async ensureRunning(ctx: IssueExecutionContext): Promise<void> {
    ctx.mintDeviceToken();
    this.calls.push(ctx.issueKey);
  }
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
  async status(): Promise<ContainerStatus> { return "absent"; }
  async listManaged(): Promise<string[]> { return []; }
}

describe("createRouterRig (fake executor, no Docker)", () => {
  let rig: RouterRig;
  let dir: string;
  const exec = new RecordingExecutor();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "f1-router-rig-"));
    rig = await createRouterRig({
      dbPath: ":memory:",
      secretsPath: join(dir, "secrets.json"),
      artifactsDir: join(dir, "artifacts"),
      executors: new Map([["docker", exec]]),
      logger: { info: () => {}, warn: () => {} },
    });
    rig.seedUser({
      email: "cold@example.com",
      linearId: "lin-cold",
      provider: "docker",
      claudeOauthToken: "tok",
    });
  });

  afterAll(async () => {
    await rig.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("routes a created webhook to the container executor", async () => {
    seedSession(rig.tracker, "sess-1", "issue-1");
    await rig.server.eventRouter.route(
      createdFixture({
        sessionId: "sess-1",
        issue: { id: "issue-1", identifier: "CYPACK-1", title: "Cold" },
        creator: { id: "lin-cold", email: "cold@example.com", name: "Cold" },
      }),
    );
    await vi.waitFor(() => expect(exec.calls).toContain("CYPACK-1"));
    expect(rig.port).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/f1 && pnpm vitest run test/router/router-rig.test.ts`
Expected: FAIL — `Cannot find module '../../src/router/RouterRig.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/f1/src/router/RouterRig.ts
import { CLIIssueTrackerService } from "cyrus-core";
import { RouterServer } from "cyrus-router";
import { SecretStore } from "cyrus-router";
import type { ContainerExecutor } from "cyrus-router-executors";
import { allocatePort } from "./allocatePort.js";
import { WORKSPACE } from "./fixtures.js";

export interface RouterRig {
  server: RouterServer;
  tracker: CLIIssueTrackerService;
  port: number;
  seedUser(opts: {
    email: string;
    linearId: string;
    provider: string;
    claudeOauthToken: string;
  }): void;
  stop(): Promise<void>;
}

export interface RouterRigOptions {
  dbPath: string;
  secretsPath: string;
  artifactsDir: string;
  host?: string;
  image?: string;
  executors?: Map<string, ContainerExecutor>;
  idleStopMs?: number;
  staleDestroyMs?: number;
  logger?: { info(m: string): void; warn(m: string): void };
}

export async function createRouterRig(
  opts: RouterRigOptions,
): Promise<RouterRig> {
  const port = await allocatePort();
  const logger = opts.logger ?? { info: () => {}, warn: () => {} };
  const tracker = new CLIIssueTrackerService();
  tracker.seedDefaultData();
  const secrets = new SecretStore(opts.secretsPath);

  const server = new RouterServer({
    port,
    // Container-facing: must bind all interfaces so a container reaching
    // host.docker.internal:<port> can connect (loopback is unreachable from
    // the container on Linux). Only the F1 control plane binds 127.0.0.1.
    host: opts.host ?? "0.0.0.0",
    dbPath: opts.dbPath,
    workspaces: { [WORKSPACE]: { linearToken: "unused" } },
    webhook: { verificationMode: "direct", secret: "f1-router-secret" },
    trackerFactory: () => tracker,
    logger,
    containers: {
      image: opts.image ?? "cyrus-worker:test",
      // Reachable from inside a Docker container on Docker Desktop / colima.
      routerUrlForContainers: `ws://host.docker.internal:${port}`,
      repositories: [
        {
          name: "cyrus",
          githubSlug: "octocat/Hello-World",
          linearWorkspaceId: WORKSPACE,
          baseBranch: "master",
        },
      ],
      secretsPath: opts.secretsPath,
      artifactsDir: opts.artifactsDir,
      idleStopMs: opts.idleStopMs,
      staleDestroyMs: opts.staleDestroyMs,
    },
    ...(opts.executors ? { executorRegistryFactory: () => opts.executors! } : {}),
  });
  await server.start();

  return {
    server,
    tracker,
    port,
    seedUser({ email, linearId, provider, claudeOauthToken }) {
      server.store.addUser({ email, linearId });
      server.store.setUserExecutor(email, JSON.stringify({ type: provider }));
      secrets.set(email, "claudeOauthToken", claudeOauthToken);
    },
    async stop() {
      await server.stop();
    },
  };
}
```

> Verify against source while implementing: `SecretStore` is exported from `cyrus-router` (`packages/router/src/index.ts`); `server.store.addUser` accepts `{ email, linearId }` and `setUserExecutor(email, json)` per `containers-e2e.test.ts:377-417`. If `addUser`'s field is named differently, match the store's actual signature in `RouterStore.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/f1 && pnpm vitest run test/router/router-rig.test.ts`
Expected: PASS (1 test). If `route()` never calls the executor, confirm the user's `linearId` matches the fixture creator's `id` — `EventRouter.resolveTarget` maps the creator to a user via `findUserForCreator`.

- [ ] **Step 5: Commit**

```bash
git add apps/f1/src/router/RouterRig.ts apps/f1/test/router/router-rig.test.ts
git commit -m "feat(f1): in-process router rig (RouterServer + CLI tracker)"
```

---

### Task 4: Loopback control server (token-guarded) + CLIRPCServer reuse

**Files:**
- Create: `apps/f1/src/router/ControlServer.ts`
- Test: `apps/f1/test/router/control-server.test.ts`

**Interfaces:**
- Consumes: `RouterRig` (Task 3), `createdFixture`/`promptedFixture`/`seedSession` (Task 2). `CLIRPCServer` from `cyrus-core`. `Fastify` from `fastify`.
- Produces:
  ```typescript
  interface ControlServer { url: string; token: string; stop(): Promise<void>; }
  startControlServer(opts: { rig: RouterRig; token: string; port?: number }): Promise<ControlServer>
  ```
  Routes (all under `/router/*`, all requiring `Authorization: Bearer <token>`):
  - `POST /router/seed-user` `{ email, linearId, provider, claudeOauthToken }` → `{ ok: true }`
  - `POST /router/inject` `{ kind: "created" | "prompted", sessionId, actorUserId?, issueId, identifier, title, body?, creator }` → `{ ok: true }` (seeds the session, routes the fixture)
  - `GET /router/artifact/:issueKey` → `{ present: boolean; bytes?: number }` (stats the artifacts dir)
  - Plus `/cli/rpc` (mounted via `CLIRPCServer`) so existing `./f1` commands work unchanged.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/f1/test/router/control-server.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerExecutor, ContainerStatus, IssueExecutionContext } from "cyrus-router-executors";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRouterRig, type RouterRig } from "../../src/router/RouterRig.js";
import { startControlServer, type ControlServer } from "../../src/router/ControlServer.js";

class RecordingExecutor implements ContainerExecutor {
  readonly provider = "docker";
  readonly calls: string[] = [];
  async ensureRunning(ctx: IssueExecutionContext): Promise<void> {
    ctx.mintDeviceToken();
    this.calls.push(ctx.issueKey);
  }
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
  async status(): Promise<ContainerStatus> { return "absent"; }
  async listManaged(): Promise<string[]> { return []; }
}

describe("control server", () => {
  let rig: RouterRig;
  let control: ControlServer;
  let dir: string;
  const exec = new RecordingExecutor();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "f1-control-"));
    rig = await createRouterRig({
      dbPath: ":memory:",
      secretsPath: join(dir, "secrets.json"),
      artifactsDir: join(dir, "artifacts"),
      executors: new Map([["docker", exec]]),
      logger: { info: () => {}, warn: () => {} },
    });
    control = await startControlServer({ rig, token: "secret-token" });
  });

  afterAll(async () => {
    await control.stop();
    await rig.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects control routes without the bearer token", async () => {
    const res = await fetch(`${control.url}/router/artifact/CYPACK-1`);
    expect(res.status).toBe(401);
  });

  it("binds to loopback only", () => {
    expect(control.url).toMatch(/^http:\/\/127\.0\.0\.1:/);
  });

  it("seeds a user and routes an injected created webhook to the executor", async () => {
    const seed = await fetch(`${control.url}/router/seed-user`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
      body: JSON.stringify({ email: "cold@example.com", linearId: "lin-cold", provider: "docker", claudeOauthToken: "tok" }),
    });
    expect(seed.status).toBe(200);

    const inject = await fetch(`${control.url}/router/inject`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer secret-token" },
      body: JSON.stringify({
        kind: "created",
        sessionId: "sess-1",
        issueId: "issue-1",
        identifier: "CYPACK-1",
        title: "Cold",
        creator: { id: "lin-cold", email: "cold@example.com", name: "Cold" },
      }),
    });
    expect(inject.status).toBe(200);
    await vi.waitFor(() => expect(exec.calls).toContain("CYPACK-1"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/f1 && pnpm vitest run test/router/control-server.test.ts`
Expected: FAIL — `Cannot find module '../../src/router/ControlServer.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/f1/src/router/ControlServer.ts
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLIRPCServer } from "cyrus-core";
import Fastify from "fastify";
import { allocatePort } from "./allocatePort.js";
import { createdFixture, promptedFixture, seedSession, type Creator } from "./fixtures.js";
import type { RouterRig } from "./RouterRig.js";

export interface ControlServer {
  url: string;
  token: string;
  stop(): Promise<void>;
}

interface InjectBody {
  kind: "created" | "prompted";
  sessionId: string;
  actorUserId?: string;
  issueId: string;
  identifier: string;
  title: string;
  body?: string;
  creator: Creator;
}

export async function startControlServer(opts: {
  rig: RouterRig;
  token: string;
  port?: number;
  artifactsDir?: string;
}): Promise<ControlServer> {
  const port = opts.port ?? (await allocatePort());
  const fastify = Fastify();

  // Reuse EdgeWorker's pattern so existing ./f1 issue/session commands work.
  const rpc = new CLIRPCServer({
    fastifyServer: fastify,
    issueTracker: opts.rig.tracker,
    version: "1.0.0",
  });
  rpc.register();

  // Token gate for the /router/* control plane only.
  fastify.addHook("onRequest", async (request, reply) => {
    if (!request.url.startsWith("/router/")) return;
    if (request.headers.authorization !== `Bearer ${opts.token}`) {
      reply.code(401).send({ ok: false, error: "unauthorized" });
    }
  });

  fastify.post("/router/seed-user", async (request, reply) => {
    const b = request.body as {
      email: string;
      linearId: string;
      provider: string;
      claudeOauthToken: string;
    };
    opts.rig.seedUser(b);
    reply.send({ ok: true });
  });

  fastify.post("/router/inject", async (request, reply) => {
    const b = request.body as InjectBody;
    seedSession(opts.rig.tracker, b.sessionId, b.issueId);
    const issue = { id: b.issueId, identifier: b.identifier, title: b.title };
    const event =
      b.kind === "created"
        ? createdFixture({ sessionId: b.sessionId, issue, creator: b.creator })
        : promptedFixture({
            sessionId: b.sessionId,
            actorUserId: b.actorUserId ?? b.creator.id,
            creator: b.creator,
            issue,
            body: b.body ?? "",
          });
    await opts.rig.server.eventRouter.route(event);
    reply.send({ ok: true });
  });

  fastify.get("/router/artifact/:issueKey", async (request, reply) => {
    const { issueKey } = request.params as { issueKey: string };
    const dir = opts.artifactsDir;
    if (!dir) {
      reply.send({ present: false });
      return;
    }
    const bundle = join(dir, issueKey, "bundle.tar.gz");
    if (existsSync(bundle)) {
      reply.send({ present: true, bytes: statSync(bundle).size });
    } else {
      reply.send({ present: false });
    }
  });

  await fastify.listen({ port, host: "127.0.0.1" });
  return {
    url: `http://127.0.0.1:${port}`,
    token: opts.token,
    async stop() {
      await fastify.close();
    },
  };
}
```

> Verify against source while implementing: `CLIRPCServer` constructor accepts `{ fastifyServer, issueTracker, version }` (`EdgeWorker.ts:880-884`). The artifacts dir passed here must be the SAME one given to `createRouterRig` — thread it through `router-server.ts` (Task 6). The bundle path `join(dir, issueKey, "bundle.tar.gz")` matches `artifacts.ts` `bundlePath`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/f1 && pnpm vitest run test/router/control-server.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/f1/src/router/ControlServer.ts apps/f1/test/router/control-server.test.ts
git commit -m "feat(f1): loopback token-guarded control server for router rig"
```

---

### Task 5: `./f1 router:*` CLI subcommands

**Files:**
- Create: `apps/f1/src/commands/router/enroll.ts`, `inject.ts`, `seedUser.ts`, `artifact.ts`
- Modify: `apps/f1/src/cli.ts`
- Test: `apps/f1/test/router/router-commands.test.ts`

**Interfaces:**
- Consumes: the control server routes (Task 4). A small control-RPC client that reads `F1_ROUTER_CONTROL_URL` + `F1_ROUTER_CONTROL_TOKEN` from env.
- Produces: `createRouterInjectCommand()`, `createRouterSeedUserCommand()`, `createRouterArtifactCommand()`, `createRouterEnrollCommand()` — each returns a Commander `Command`.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/f1/test/router/router-commands.test.ts
import { describe, expect, it } from "vitest";
import { createRouterInjectCommand } from "../../src/commands/router/inject.js";
import { createRouterSeedUserCommand } from "../../src/commands/router/seedUser.js";
import { createRouterArtifactCommand } from "../../src/commands/router/artifact.js";

describe("router:* commands", () => {
  it("expose the expected command names and required options", () => {
    expect(createRouterInjectCommand().name()).toBe("router:inject");
    expect(createRouterSeedUserCommand().name()).toBe("router:seed-user");
    expect(createRouterArtifactCommand().name()).toBe("router:artifact");
    const inject = createRouterInjectCommand();
    const names = inject.options.map((o) => o.long);
    expect(names).toContain("--session-id");
    expect(names).toContain("--identifier");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/f1 && pnpm vitest run test/router/router-commands.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

Add a control-RPC helper, then the commands. Follow the existing `createViewSessionCommand` shape (`apps/f1/src/commands/viewSession.ts`).

```typescript
// apps/f1/src/commands/router/controlClient.ts
export function controlBase(): string {
  return process.env.F1_ROUTER_CONTROL_URL ?? "http://127.0.0.1:3601";
}
export async function controlPost(path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${controlBase()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.F1_ROUTER_CONTROL_TOKEN ?? ""}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`control ${path} → HTTP ${res.status}`);
  return res.json();
}
export async function controlGet(path: string): Promise<unknown> {
  const res = await fetch(`${controlBase()}${path}`, {
    headers: { authorization: `Bearer ${process.env.F1_ROUTER_CONTROL_TOKEN ?? ""}` },
  });
  if (!res.ok) throw new Error(`control ${path} → HTTP ${res.status}`);
  return res.json();
}
```

```typescript
// apps/f1/src/commands/router/inject.ts
import { Command } from "commander";
import { success } from "../../utils/colors.js";
import { controlPost } from "./controlClient.js";

export function createRouterInjectCommand(): Command {
  const cmd = new Command("router:inject");
  cmd
    .description("Inject an agentSessionCreated/prompted webhook into the router")
    .requiredOption("-s, --session-id <id>", "Session id")
    .requiredOption("-i, --issue-id <id>", "Issue id")
    .requiredOption("--identifier <key>", "Issue identifier, e.g. CYPACK-1")
    .option("-t, --title <title>", "Issue title", "F1 router issue")
    .option("-k, --kind <kind>", "created | prompted", "created")
    .option("-b, --body <text>", "Prompt body (for kind=prompted)")
    .requiredOption("--creator-id <id>", "Creator linear id (matches a seeded user)")
    .requiredOption("--creator-email <email>", "Creator email")
    .option("--creator-name <name>", "Creator name", "F1 User")
    .action(async (o) => {
      await controlPost("/router/inject", {
        kind: o.kind,
        sessionId: o.sessionId,
        issueId: o.issueId,
        identifier: o.identifier,
        title: o.title,
        body: o.body,
        creator: { id: o.creatorId, email: o.creatorEmail, name: o.creatorName },
      });
      console.log(success(`Injected ${o.kind} for ${o.identifier}`));
    });
  return cmd;
}
```

```typescript
// apps/f1/src/commands/router/seedUser.ts
import { Command } from "commander";
import { success } from "../../utils/colors.js";
import { controlPost } from "./controlClient.js";

export function createRouterSeedUserCommand(): Command {
  const cmd = new Command("router:seed-user");
  cmd
    .description("Seed a router user with a container executor + Claude secret")
    .requiredOption("-e, --email <email>", "User email")
    .requiredOption("-l, --linear-id <id>", "User linear id")
    .option("-p, --provider <provider>", "Executor provider", "docker")
    .requiredOption("--claude-token <token>", "CLAUDE_CODE_OAUTH_TOKEN for the container")
    .action(async (o) => {
      await controlPost("/router/seed-user", {
        email: o.email,
        linearId: o.linearId,
        provider: o.provider,
        claudeOauthToken: o.claudeToken,
      });
      console.log(success(`Seeded user ${o.email} (${o.provider})`));
    });
  return cmd;
}
```

```typescript
// apps/f1/src/commands/router/artifact.ts
import { Command } from "commander";
import { controlGet } from "./controlClient.js";

export function createRouterArtifactCommand(): Command {
  const cmd = new Command("router:artifact");
  cmd
    .description("Check whether a floor bundle has landed for an issue")
    .requiredOption("--identifier <key>", "Issue identifier, e.g. CYPACK-1")
    .action(async (o) => {
      const res = (await controlGet(`/router/artifact/${o.identifier}`)) as {
        present: boolean;
        bytes?: number;
      };
      console.log(JSON.stringify(res));
    });
  return cmd;
}
```

```typescript
// apps/f1/src/commands/router/enroll.ts
import { Command } from "commander";
import { success } from "../../utils/colors.js";
import { controlPost } from "./controlClient.js";

export function createRouterEnrollCommand(): Command {
  const cmd = new Command("router:enroll");
  cmd
    .description("Mint + redeem a physical-device enrollment code, print the token")
    .requiredOption("-e, --email <email>", "User email to enroll")
    .action(async (o) => {
      const res = (await controlPost("/router/enroll", { email: o.email })) as {
        deviceToken: string;
      };
      console.log(success(`Device token: ${res.deviceToken}`));
    });
  return cmd;
}
```

Then register them in `apps/f1/src/cli.ts` (add imports at the top with the other command imports, and `program.addCommand(...)` calls with the others):

```typescript
import { createRouterEnrollCommand } from "./commands/router/enroll.js";
import { createRouterInjectCommand } from "./commands/router/inject.js";
import { createRouterSeedUserCommand } from "./commands/router/seedUser.js";
import { createRouterArtifactCommand } from "./commands/router/artifact.js";
// ...
program.addCommand(createRouterEnrollCommand());
program.addCommand(createRouterInjectCommand());
program.addCommand(createRouterSeedUserCommand());
program.addCommand(createRouterArtifactCommand());
```

> The `/router/enroll` route is not yet implemented in Task 4's ControlServer. Add it there now: mint via `rig.server.store.mintEnrollmentCode(email, Date.now())` then redeem via `rig.server.store.redeemEnrollmentCode(code, Date.now())`, returning `{ deviceToken }`. (`Date.now()` is fine in F1 runtime code — the no-`Date.now` rule applies only to Workflow scripts, not app code.) Verify the exact store method names/signatures in `RouterStore.ts` while wiring.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/f1 && pnpm vitest run test/router/router-commands.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add apps/f1/src/commands/router apps/f1/src/cli.ts apps/f1/src/router/ControlServer.ts
git commit -m "feat(f1): ./f1 router:* subcommands (inject/seed-user/artifact/enroll)"
```

---

### Task 6: `router-server.ts` entrypoint + `router-server` script

**Files:**
- Create: `apps/f1/router-server.ts`
- Modify: `apps/f1/package.json`
- Test: `apps/f1/test/router/router-server.smoke.test.ts`

**Interfaces:**
- Consumes: `createRouterRig` (Task 3), `startControlServer` (Task 4). Env: `CYRUS_ROUTER_FAKE_EXECUTOR=1` selects the fake path; `F1_ROUTER_CONTROL_PORT`, `F1_ROUTER_CONTROL_TOKEN`.
- Produces: an executable that boots the rig + control server and prints connection info. Exported `startRouterServer(opts): Promise<{ rig; control; stop() }>` so the smoke test can drive it in-process.

- [ ] **Step 1: Write the failing test**

```typescript
// apps/f1/test/router/router-server.smoke.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startRouterServer } from "../../router-server.js";

describe("router-server smoke (fake executor)", () => {
  let handle: Awaited<ReturnType<typeof startRouterServer>>;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "f1-router-server-"));
    handle = await startRouterServer({
      home: dir,
      controlToken: "t",
      fakeExecutor: true,
    });
  });

  afterAll(async () => {
    await handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("boots the control server on loopback and answers an authed artifact check", async () => {
    const res = await fetch(`${handle.control.url}/router/artifact/CYPACK-1`, {
      headers: { authorization: "Bearer t" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ present: false });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/f1 && pnpm vitest run test/router/router-server.smoke.test.ts`
Expected: FAIL — `Cannot find module '../../router-server.js'`.

- [ ] **Step 3: Write minimal implementation**

```typescript
// apps/f1/router-server.ts
#!/usr/bin/env bun
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerExecutor, ContainerStatus, IssueExecutionContext } from "cyrus-router-executors";
import { startControlServer, type ControlServer } from "./src/router/ControlServer.js";
import { createRouterRig, type RouterRig } from "./src/router/RouterRig.js";
import { bold, cyan, green, success } from "./src/utils/colors.js";

class NoopFakeExecutor implements ContainerExecutor {
  readonly provider = "docker";
  async ensureRunning(ctx: IssueExecutionContext): Promise<void> { ctx.mintDeviceToken(); }
  async stop(): Promise<void> {}
  async destroy(): Promise<void> {}
  async status(): Promise<ContainerStatus> { return "absent"; }
  async listManaged(): Promise<string[]> { return []; }
}

export async function startRouterServer(opts: {
  home?: string;
  controlToken?: string;
  controlPort?: number;
  fakeExecutor?: boolean;
}): Promise<{ rig: RouterRig; control: ControlServer; stop(): Promise<void> }> {
  const home = opts.home ?? join(tmpdir(), `cyrus-f1-router-${Date.now()}`);
  for (const d of [home, join(home, "artifacts"), join(home, "state")]) {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }
  const artifactsDir = join(home, "artifacts");
  const rig = await createRouterRig({
    dbPath: join(home, "router.db"),
    secretsPath: join(home, "secrets.json"),
    artifactsDir,
    ...(opts.fakeExecutor
      ? { executors: new Map<string, ContainerExecutor>([["docker", new NoopFakeExecutor()]]) }
      : {}),
  });
  const control = await startControlServer({
    rig,
    token: opts.controlToken ?? "f1-router",
    port: opts.controlPort,
    artifactsDir,
  });
  return {
    rig,
    control,
    async stop() {
      await control.stop();
      await rig.stop();
    },
  };
}

// CLI entrypoint (only when run directly).
if (import.meta.main) {
  const controlToken = process.env.F1_ROUTER_CONTROL_TOKEN ?? "f1-router";
  const handle = await startRouterServer({
    controlToken,
    controlPort: process.env.F1_ROUTER_CONTROL_PORT
      ? Number(process.env.F1_ROUTER_CONTROL_PORT)
      : undefined,
    fakeExecutor: process.env.CYRUS_ROUTER_FAKE_EXECUTOR === "1",
  });
  console.log(bold(green("  🚦 F1 Router-Mode Server")));
  console.log(`  ${cyan("Router WS:")}   ws://127.0.0.1:${handle.rig.port}`);
  console.log(`  ${cyan("Control:")}     ${handle.control.url}  ${success(`(token: ${controlToken})`)}`);
  const shutdown = async () => { await handle.stop(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
```

Add to `apps/f1/package.json` scripts:

```json
"router-server": "bun run router-server.ts"
```

> `import.meta.main` is Bun-specific; the smoke test imports `startRouterServer` directly, so the guard keeps the CLI block from running under Vitest.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/f1 && pnpm vitest run test/router/router-server.smoke.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Typecheck + commit**

```bash
cd apps/f1 && pnpm typecheck
git add apps/f1/router-server.ts apps/f1/package.json apps/f1/test/router/router-server.smoke.test.ts
git commit -m "feat(f1): router-server entrypoint + router-server script"
```

---

## Phase 2 — Real-Docker lifecycle e2e (spec A2)

> All Phase 2–4 tests live in `packages/router/test/containers-real-docker.e2e.test.ts` and are **opt-in**. Because `ContainerLifecycle.sweep()` always runs orphan GC over the live daemon, the **entire** suite is gated behind `dockerAvailable() && dedicatedDaemonOptIn()` (`CYRUS_E2E_DEDICATED_DOCKER=1`) — not just the orphan-GC test. Non-orphan tests additionally wrap the provider with `scopedProvider(...)` so their `sweep()` can only touch this run's containers.

### Task 7: Docker daemon guard + run-scoped naming helper

**Files:**
- Create: `packages/router/test/helpers/dockerDaemon.ts`
- Test: `packages/router/test/helpers/dockerDaemon.test.ts`

**Interfaces:**
- Produces:
  - `dockerAvailable(): boolean` — true iff `docker info` exits 0.
  - `dedicatedDaemonOptIn(): boolean` — true iff `CYRUS_E2E_DEDICATED_DOCKER=1`. **Gates the whole real-Docker suite** (every `sweep()` runs orphan GC over the live daemon — see the safety constraint), not just the orphan-GC test.
  - `runScopedIssueKey(base: string): string` — `${base}-${short-random}` unique per process.
  - `removeContainerAndVolume(name: string): void` — `docker rm -f <name>`/`docker volume rm <name>`, tolerating absence.
  - `containerState(name: string): "running" | "stopped" | "absent"`.
  - `scopedProvider(inner: ContainerExecutor, allowedKeys: Set<string>): ContainerExecutor` — delegates every method to `inner` except `listManaged()`, which is intersected with `allowedKeys`. Used to build the `ContainerLifecycle` in the idle-stop / stale-destroy tests so their `sweep()`'s orphan-GC can only ever see this run's own containers. The orphan-GC test deliberately uses the raw `inner` (it must see the planted orphan).

- [ ] **Step 1: Write the failing test**

```typescript
// packages/router/test/helpers/dockerDaemon.test.ts
import { describe, expect, it } from "vitest";
import { dockerAvailable, runScopedIssueKey } from "./dockerDaemon.js";

describe("dockerDaemon helpers", () => {
  it("dockerAvailable returns a boolean without throwing", () => {
    expect(typeof dockerAvailable()).toBe("boolean");
  });
  it("runScopedIssueKey appends a unique suffix", () => {
    const a = runScopedIssueKey("CYPACK");
    const b = runScopedIssueKey("CYPACK");
    expect(a.startsWith("CYPACK-")).toBe(true);
    expect(a).not.toBe(b);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router vitest run test/helpers/dockerDaemon.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/router/test/helpers/dockerDaemon.ts
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ContainerExecutor } from "cyrus-router-executors";

export function dockerAvailable(): boolean {
  const r = spawnSync("docker", ["info"], { stdio: "ignore" });
  return r.status === 0;
}

export function dedicatedDaemonOptIn(): boolean {
  return process.env.CYRUS_E2E_DEDICATED_DOCKER === "1";
}

export function runScopedIssueKey(base: string): string {
  return `${base}-${randomBytes(4).toString("hex")}`;
}

export function removeContainerAndVolume(issueKeyOrName: string): void {
  // The provider names resources `cyrus-issue-<sanitized>`; callers pass the
  // exact container/volume name they created. Tolerate absence.
  for (const args of [
    ["rm", "-f", issueKeyOrName],
    ["volume", "rm", issueKeyOrName],
  ]) {
    spawnSync("docker", args, { stdio: "ignore" });
  }
}

export function containerState(name: string): "running" | "stopped" | "absent" {
  const r = spawnSync(
    "docker",
    ["inspect", "-f", "{{.State.Running}}", name],
    { encoding: "utf-8" },
  );
  if (r.status !== 0) return "absent";
  return r.stdout.trim() === "true" ? "running" : "stopped";
}

/**
 * Wrap a real ContainerExecutor so its listManaged() (the input to orphan GC in
 * ContainerLifecycle.sweep) can only ever surface `allowedKeys`. This bounds the
 * blast radius of a sweep() in the idle-stop / stale-destroy tests to this run's
 * own containers, even on a shared daemon. The orphan-GC test uses the raw inner.
 */
export function scopedProvider(
  inner: ContainerExecutor,
  allowedKeys: Set<string>,
): ContainerExecutor {
  return {
    provider: inner.provider,
    ensureRunning: (ctx) => inner.ensureRunning(ctx),
    stop: (k) => inner.stop(k),
    destroy: (k) => inner.destroy(k),
    status: (k) => inner.status(k),
    async listManaged() {
      const all = await inner.listManaged();
      return all.filter((k) => allowedKeys.has(k));
    },
  };
}

export { execFileSync };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter cyrus-router vitest run test/helpers/dockerDaemon.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/router/test/helpers/dockerDaemon.ts packages/router/test/helpers/dockerDaemon.test.ts
git commit -m "test(router): docker daemon guard + run-scoped naming helpers"
```

---

### Task 8: Real-Docker boot + idle-stop lifecycle test

**Files:**
- Create: `packages/router/test/containers-real-docker.e2e.test.ts`
- Test: same file.

**Interfaces:**
- Consumes: `RouterServer`, `RouterContainersConfig` (`cyrus-router`); `LocalDockerProvider` (`cyrus-router-executors`); `ContainerLifecycle` (`../src/ContainerLifecycle.js`); `SecretStore` (`../src/SecretStore.js`); daemon helpers (Task 7); `CLIIssueTrackerService` + fixtures (reuse `apps/f1/src/router/fixtures.ts` shape — copy `createdFixture`/`seedSession` locally to keep the router package test self-contained, or import from a shared test-fixtures module).
- Produces: a `describe.skipIf(!dockerAvailable())` suite.

**Prerequisite:** the `cyrus-worker:test` image must exist. The suite's `beforeAll` builds it: `docker build -f docker/worker/Dockerfile -t cyrus-worker:test .` (run from repo root). Skip the whole suite if the build fails and log why.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/router/test/containers-real-docker.e2e.test.ts
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLIIssueTrackerService } from "cyrus-core";
import { LocalDockerProvider } from "cyrus-router-executors";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ContainerLifecycle } from "../src/ContainerLifecycle.js";
import { RouterServer } from "../src/RouterServer.js";
import { SecretStore } from "../src/SecretStore.js";
import {
  containerState,
  dedicatedDaemonOptIn,
  dockerAvailable,
  removeContainerAndVolume,
  runScopedIssueKey,
  scopedProvider,
} from "./helpers/dockerDaemon.js";
// Local fixtures — same shape as apps/f1/src/router/fixtures.ts.
import { createdFixture, seedSession, WORKSPACE } from "./helpers/fixtures.js";

const IMAGE = "cyrus-worker:test";
const IDLE_STOP_MS = 60_000;
const STALE_DESTROY_MS = 14 * 24 * 60 * 60_000;

// Whole-suite gate: sweep() runs orphan GC host-wide, so ALL of these tests
// require the dedicated-daemon opt-in, not just the orphan-GC scenario.
describe.skipIf(!dockerAvailable() || !dedicatedDaemonOptIn())("real-Docker container lifecycle", () => {
  let server: RouterServer;
  let tracker: CLIIssueTrackerService;
  let dir: string;
  let port: number;
  const issueKey = runScopedIssueKey("CYE2E");
  const containerName = `cyrus-issue-${issueKey}`;

  beforeAll(async () => {
    // Build the worker image (skip suite on failure).
    execFileSync("docker", ["build", "-f", "docker/worker/Dockerfile", "-t", IMAGE, "."], {
      cwd: join(__dirname, "..", "..", ".."),
      stdio: "inherit",
    });

    tracker = new CLIIssueTrackerService();
    tracker.seedDefaultData();
    dir = mkdtempSync(join(tmpdir(), "router-real-docker-"));
    const secrets = new SecretStore(join(dir, "secrets.json"));
    port = 3456; // fixed so host.docker.internal:3456 resolves from the container

    const containers = {
      image: IMAGE,
      routerUrlForContainers: `ws://host.docker.internal:${port}`,
      repositories: [{ name: "hello", githubSlug: "octocat/Hello-World", linearWorkspaceId: WORKSPACE, baseBranch: "master" }],
      secretsPath: join(dir, "secrets.json"),
      artifactsDir: join(dir, "artifacts"),
      idleStopMs: IDLE_STOP_MS,
      staleDestroyMs: STALE_DESTROY_MS,
    };
    server = new RouterServer({
      port,
      host: "0.0.0.0", // container-facing: reachable from host.docker.internal
      dbPath: ":memory:",
      workspaces: { [WORKSPACE]: { linearToken: "unused" } },
      webhook: { verificationMode: "direct", secret: "s" },
      trackerFactory: () => tracker,
      logger: { info: () => {}, warn: () => {} },
      containers,
      executorRegistryFactory: () => new Map([["docker", new LocalDockerProvider({ image: IMAGE })]]),
    });
    await server.start();
    server.store.addUser({ email: "e2e@example.com", linearId: "lin-e2e" });
    server.store.setUserExecutor("e2e@example.com", JSON.stringify({ type: "docker" }));
    secrets.set("e2e@example.com", "claudeOauthToken", "fake-oauth-not-used-for-boot");
  }, 300_000);

  afterAll(async () => {
    removeContainerAndVolume(containerName);
    await server?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("cold boot creates a real container, then idle-stop stops it (volume retained)", async () => {
    seedSession(tracker, "sess-e2e", "issue-e2e");
    await server.eventRouter.route(
      createdFixture({
        sessionId: "sess-e2e",
        issue: { id: "issue-e2e", identifier: issueKey, title: "e2e" },
        creator: { id: "lin-e2e", email: "e2e@example.com", name: "E2E" },
      }),
    );
    await vi.waitFor(() => expect(containerState(containerName)).toBe("running"), { timeout: 60_000 });

    // Idle-stop via a second lifecycle sharing the store, with an injected clock.
    // Scope the provider so this sweep()'s orphan GC can only see OUR container.
    const allowed = new Set([issueKey]);
    const lifecycle = new ContainerLifecycle({
      store: server.store,
      executors: new Map([
        ["docker", scopedProvider(new LocalDockerProvider({ image: IMAGE }), allowed)],
      ]),
      idleStopMs: IDLE_STOP_MS,
      staleDestroyMs: STALE_DESTROY_MS,
      logger: { info: () => {}, warn: () => {} },
      now: () => Date.now() + IDLE_STOP_MS + 5_000,
    });
    await lifecycle.sweep();
    await vi.waitFor(() => expect(containerState(containerName)).toBe("stopped"), { timeout: 40_000 });
    // Volume must still exist (warm restart path depends on it).
    const vols = execFileSync("docker", ["volume", "ls", "-q", "-f", `name=${containerName}`], { encoding: "utf-8" });
    expect(vols).toContain(containerName);
  }, 120_000);
});
```

Create the local fixtures helper `packages/router/test/helpers/fixtures.ts` by copying `createdFixture`, `seedSession`, and `WORKSPACE` from `apps/f1/src/router/fixtures.ts` (they are already lifted from this package's own `containers-e2e.test.ts`, so this is repackaging, not new logic).

- [ ] **Step 2: Run test to verify it fails**

Run (dedicated daemon): `CYRUS_E2E_DEDICATED_DOCKER=1 pnpm --filter cyrus-router vitest run test/containers-real-docker.e2e.test.ts`
Expected WITH a daemon + the opt-in: FAIL — `helpers/fixtures.js` missing (then, once added, real assertions run). WITHOUT the opt-in or without Docker: the suite is skipped (0 tests run) — that is the acceptance for the whole-suite gate. Verify the default `pnpm --filter cyrus-router test` (no env var) skips it.

- [ ] **Step 3: Write minimal implementation**

Add `packages/router/test/helpers/fixtures.ts` (copied helpers). No production code changes — this task's deliverable IS the test. If the boot flow needs a longer wait or the image tag differs, adjust constants only.

- [ ] **Step 4: Run to verify it passes (dedicated daemon only)**

Run: `CYRUS_E2E_DEDICATED_DOCKER=1 pnpm --filter cyrus-router vitest run test/containers-real-docker.e2e.test.ts`
Expected: PASS — container reaches `running`, then `stopped` after the injected-clock sweep, volume retained. Manually confirm no stray container remains: `docker ps -a --filter name=cyrus-issue-CYE2E`.

- [ ] **Step 5: Commit**

```bash
git add packages/router/test/containers-real-docker.e2e.test.ts packages/router/test/helpers/fixtures.ts
git commit -m "test(router): real-Docker cold-boot + idle-stop lifecycle e2e"
```

---

### Task 9: Real-Docker stale-destroy + orphan-GC (dedicated-daemon gated)

**Files:**
- Modify: `packages/router/test/containers-real-docker.e2e.test.ts` (add two `it`s)

**Interfaces:**
- Consumes: `dedicatedDaemonOptIn()` (Task 7). The orphan-GC scenario is wrapped in `it.skipIf(!dedicatedDaemonOptIn())` because orphan GC enumerates every `cyrus.issue`-labelled container on the daemon.

- [ ] **Step 1: Write the failing tests**

```typescript
  it("stale-destroy removes the container AND its volume", async () => {
    // Reuses the container booted in the previous test (or re-boots one).
    // Scoped provider — this sweep()'s orphan GC must not reach beyond our key.
    const lifecycle = new ContainerLifecycle({
      store: server.store,
      executors: new Map([
        ["docker", scopedProvider(new LocalDockerProvider({ image: IMAGE }), new Set([issueKey]))],
      ]),
      idleStopMs: IDLE_STOP_MS,
      staleDestroyMs: STALE_DESTROY_MS,
      logger: { info: () => {}, warn: () => {} },
      now: () => Date.now() + STALE_DESTROY_MS + 5_000,
    });
    await lifecycle.sweep();
    await vi.waitFor(() => expect(containerState(containerName)).toBe("absent"), { timeout: 40_000 });
    const vols = execFileSync("docker", ["volume", "ls", "-q", "-f", `name=${containerName}`], { encoding: "utf-8" });
    expect(vols.trim()).toBe("");
  }, 120_000);

  it.skipIf(!dedicatedDaemonOptIn())(
    "orphan GC destroys a labelled container with no device row (DEDICATED DAEMON ONLY)",
    async () => {
      // Create a container carrying the cyrus.issue label but NO store device row.
      const orphanKey = runScopedIssueKey("CYORPH");
      const orphanName = `cyrus-issue-${orphanKey}`;
      execFileSync("docker", [
        "run", "-d", "--name", orphanName,
        "--label", `cyrus.issue=${orphanKey}`,
        IMAGE, "sleep", "600",
      ]);
      try {
        const lifecycle = new ContainerLifecycle({
          store: server.store,
          executors: new Map([["docker", new LocalDockerProvider({ image: IMAGE })]]),
          idleStopMs: IDLE_STOP_MS,
          staleDestroyMs: STALE_DESTROY_MS,
          logger: { info: () => {}, warn: () => {} },
          now: () => Date.now(),
        });
        await lifecycle.sweep();
        await vi.waitFor(() => expect(containerState(orphanName)).toBe("absent"), { timeout: 40_000 });
      } finally {
        removeContainerAndVolume(orphanName);
      }
    },
    120_000,
  );
```

Add `dedicatedDaemonOptIn` and `runScopedIssueKey` to the import from `./helpers/dockerDaemon.js`.

- [ ] **Step 2: Run to verify (dedicated daemon)**

Run: `CYRUS_E2E_DEDICATED_DOCKER=1 pnpm --filter cyrus-router vitest run test/containers-real-docker.e2e.test.ts`
Expected: stale-destroy PASS; orphan-GC PASS. Without the env var, orphan-GC is skipped.

- [ ] **Step 3: Verify orphan-GC is safe by default**

Run (default daemon, NO opt-in): confirm the orphan-GC test is skipped and no unexpected containers were removed: `docker ps -a --filter label=cyrus.issue`.
Expected: the orphan-GC `it` reports "skipped".

- [ ] **Step 4: Commit**

```bash
git add packages/router/test/containers-real-docker.e2e.test.ts
git commit -m "test(router): real-Docker stale-destroy + gated orphan-GC"
```

---

## Phase 3 — Floor upload round-trip (spec A3)

### Task 10: Scripted upload → artifact endpoint → fresh-container restore

**Files:**
- Modify: `packages/router/test/containers-real-docker.e2e.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `buildBundle` (`cyrus-workspace-sync`, `{ issueKey, state, claudeProjectsDir, outFile } → Promise<boolean>`), `uploadBundle` (`cyrus-workspace-sync`, `(httpBase, deviceToken, issueKey, bundleFile, timeoutMs?)`). A device token minted for the issue via `server.store` (container device). The running `RouterServer`'s artifact endpoint (`http://127.0.0.1:<port>` — the HTTP form of the WS port).

- [ ] **Step 1: Write the failing test**

```typescript
// appended to containers-real-docker.e2e.test.ts
import { buildBundle, uploadBundle } from "cyrus-workspace-sync";
import { mkdirSync, writeFileSync } from "node:fs";

describe.skipIf(!dockerAvailable() || !dedicatedDaemonOptIn())("floor upload round-trip", () => {
  it("a bundle PUT to /artifacts lands, and a fresh container restores it (rung 2)", async () => {
    const issueKey = runScopedIssueKey("CYFLOOR");
    const containerName = `cyrus-issue-${issueKey}`;
    // 1. Build a minimal but valid bundle from a synthetic state + transcript.
    const workDir = mkdtempSync(join(tmpdir(), "floor-src-"));
    const claudeProjects = join(workDir, "claude-projects");
    const wsPath = `/workspaces/${issueKey}`;
    // A transcript dir keyed to the sanitized workspace cwd.
    mkdirSync(join(claudeProjects, `-workspaces-${issueKey}`), { recursive: true });
    writeFileSync(join(claudeProjects, `-workspaces-${issueKey}`, "session.jsonl"), "{}\n");
    const state = {
      agentSessions: {
        "sess-floor": { issue: { identifier: issueKey }, workspace: { path: wsPath }, claudeSessionId: "abc" },
      },
      agentSessionEntries: {},
    };
    const outFile = join(workDir, "bundle.tar.gz");
    const built = await buildBundle({ issueKey, state: state as any, claudeProjectsDir: claudeProjects, outFile });
    expect(built).toBe(true);

    // 2. Mint a container device token for this issue and PUT the bundle.
    // (Match the store API used by ContainerTargetService — a container device
    // minted for issueKey; see RouterStore.createContainerDevice / rotate.)
    const { deviceToken } = server.store.createContainerDevice({ userEmail: "e2e@example.com", issueKey, provider: "docker" });
    await uploadBundle(`http://127.0.0.1:${port}`, deviceToken, issueKey, outFile);

    // 3. Assert it landed on the artifact store.
    const stored = execFileSync("docker", ["run", "--rm", "-v", `${join(dir, "artifacts")}:/a`, "busybox", "ls", `/a/${issueKey}`], { encoding: "utf-8" }).catch(() => "");
    // (Simpler: stat the artifactsDir on the host directly.)
    expect(require("node:fs").existsSync(join(dir, "artifacts", issueKey, "bundle.tar.gz"))).toBe(true);

    // 4. Boot a FRESH container (fresh volume) and assert rung-2 restore.
    //    Drive ContainerBootCommand.restoreState via the real image with the
    //    minted token; assert the log line "Restored N session(s) from the
    //    floor bundle." appears.
    const logs = execFileSync("docker", [
      "run", "--rm", "--name", containerName,
      "-e", `CYRUS_ROUTER_URL=http://host.docker.internal:${port}`,
      "-e", `CYRUS_DEVICE_TOKEN=${deviceToken}`,
      "-e", `CYRUS_ISSUE_KEY=${issueKey}`,
      "-e", `CYRUS_REPOS_JSON=[]`,
      "-e", `CLAUDE_CODE_OAUTH_TOKEN=unused`,
      "--entrypoint", "node",
      IMAGE, "/app/dist/src/app.js", "container-boot-restore-only",
    ], { encoding: "utf-8" });
    expect(logs).toContain("Restored");
  }, 180_000);
});
```

> **Design decision to resolve during execution:** the restore step above needs a way to run *only* the restore ladder without launching a full `cyrus start` session. Two options: (a) add a `--restore-only` flag / `container-boot-restore-only` subcommand to `ContainerBootCommand` that runs `restoreState()` and exits (small, testable production change); or (b) assert restore indirectly by booting normally and grepping the boot log for `Restored N session(s) from the floor bundle.` before killing the container. Prefer (a) — it makes the assertion deterministic and matches the spec's "assert it hits rung 2". Add the flag as its own sub-step with a unit test in `apps/cli` before wiring it here.

- [ ] **Step 2: Run to verify it fails**

Run (dedicated daemon): `CYRUS_E2E_DEDICATED_DOCKER=1 pnpm --filter cyrus-router vitest run test/containers-real-docker.e2e.test.ts -t "floor upload"`
Expected: FAIL until the restore-only path exists and the store's container-device API is matched.

- [ ] **Step 3: Implement the restore-only path + match store API**

- Verify `server.store.createContainerDevice(...)` signature in `RouterStore.ts` and adjust the call. If the initial token isn't returned to callers (per `containers-e2e.test.ts` note that it's private), mint via the same seam the executor uses: `ctx.mintDeviceToken()` → `store.rotateContainerDeviceToken(deviceId)`. Use whichever the store actually exposes; the token must authorize `PUT /artifacts/issues/:issueKey/bundle` for that issue.
- Add the restore-only subcommand to `ContainerBootCommand` (guarded, runs `restoreState()` then exits 0, logging the rung).

- [ ] **Step 4: Run to verify it passes (Docker host)**

Run: `CYRUS_E2E_DEDICATED_DOCKER=1 pnpm --filter cyrus-router vitest run test/containers-real-docker.e2e.test.ts -t "floor upload"`
Expected: PASS — bundle present on the artifact store; fresh container logs `Restored 1 session(s) from the floor bundle.`

- [ ] **Step 5: Commit**

```bash
git add packages/router/test/containers-real-docker.e2e.test.ts apps/cli/src/commands/ContainerBootCommand.ts
git commit -m "test(router): floor upload → artifact → fresh-container restore round-trip"
```

---

## Phase 4 — `/workspaces/<ISSUE-KEY>` real-directory invariant (spec A4)

### Task 11: BLOCKING verification — is in-container worktree creation reachable in CI router mode?

> Codex's plan review flagged that the A4 CI assertion may be **unreachable**: a router-mode
> session might never create the worktree without valid Linear/Claude context. This task
> resolves that empirically and gates Task 12. It is read-only investigation + one real boot.

**Files:**
- Read-only investigation; then a throwaway real-container boot. Record the finding as a comment at the top of Task 12's `describe` block.

- [ ] **Step 1: Trace worktree-vs-runner ordering**

Run: `nl -ba packages/edge-worker/src/EdgeWorker.ts | sed -n '4400,4960p'`
Confirm `createGitWorktree` (~`:4419`) executes and returns before the first `runner.start(...)`/`startStreaming(...)` (~`:4918`) in the same handler. Record X (worktree line) and Y (runner line) and whether X < Y.

- [ ] **Step 2: Trace what the router-mode session needs BEFORE worktree creation**

Run: `rg -n "fetchFullIssueDetails|createGitWorktree|RouterIssueTrackerService|repositorySelection|pendingSelection" packages/edge-worker/src/EdgeWorker.ts packages/router-client/src/RouterIssueTrackerService.ts`
Determine whether reaching `createGitWorktree` requires: (a) a successful issue-detail fetch over the device→router RPC (which, with a CLI-tracker-backed router, returns CLI-seeded data — confirm it returns enough for GitService), and (b) that repository routing resolves without a `pendingSelection` elicitation stalling the session. Record what is required.

- [ ] **Step 3: Empirical boot check**

Boot one real container for a throwaway issue via the rig with an INVALID Claude token, wait 60s, then `docker exec <container> ls -la /workspaces/`. Record whether `/workspaces/<KEY>` was created.

- [ ] **Step 4: Decide Task 12's form (record the decision)**

- If X < Y **and** Step 2/3 show the worktree IS created without valid creds → Task 12 runs its CI `docker exec` assertion as written.
- Otherwise → Task 12's CI `it` is `it.skip`'d with a comment pointing to the manual real-Claude drive (Task 13) as the sole validation for item 4, and the spec's A4 "hard fork" note records the outcome. **This is an expected, acceptable outcome — not a failure.**

Commit the recorded finding (no code beyond the comment):

```bash
git commit --allow-empty -m "chore(router): record A4 worktree-reachability finding (Task 11)"
```

---

### Task 12: docker-exec assertion of the directory invariant

**Files:**
- Modify: `packages/router/test/containers-real-docker.e2e.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: a booted real container for an issue whose session has created its worktree.

- [ ] **Step 1: Write the failing test**

> Precede this block with the finding recorded in Task 11. If Task 11 decided the worktree is
> NOT reachable in CI router mode, write this `it` as `it.skip(...)` with that comment and rely
> on Task 13 (manual drive) for item 4 — do not force the assertion.

```typescript
describe.skipIf(!dockerAvailable() || !dedicatedDaemonOptIn())("/workspaces/<ISSUE-KEY> invariant", () => {
  it("is a real directory, not a symlink, and realpath-stable", async () => {
    const issueKey = runScopedIssueKey("CYDIR");
    const containerName = `cyrus-issue-${issueKey}`;
    seedSession(tracker, "sess-dir", "issue-dir");
    await server.eventRouter.route(
      createdFixture({
        sessionId: "sess-dir",
        issue: { id: "issue-dir", identifier: issueKey, title: "dir" },
        creator: { id: "lin-e2e", email: "e2e@example.com", name: "E2E" },
      }),
    );
    // Wait until the worktree exists inside the container.
    await vi.waitFor(() => {
      const r = execFileSync("docker", ["exec", containerName, "test", "-d", `/workspaces/${issueKey}`], { stdio: "ignore" });
      return r;
    }, { timeout: 90_000 });
    // Assert: directory, NOT a symlink, realpath resolves to itself.
    execFileSync("docker", ["exec", containerName, "test", "!", "-L", `/workspaces/${issueKey}`]);
    const real = execFileSync("docker", ["exec", containerName, "realpath", `/workspaces/${issueKey}`], { encoding: "utf-8" }).trim();
    expect(real).toBe(`/workspaces/${issueKey}`);
    removeContainerAndVolume(containerName);
  }, 180_000);
});
```

- [ ] **Step 2: Run to verify it fails / passes (Docker host)**

Run: `CYRUS_E2E_DEDICATED_DOCKER=1 pnpm --filter cyrus-router vitest run test/containers-real-docker.e2e.test.ts -t "invariant"`
Expected: PASS if Task 11 found worktree creation reachable. If not, this `it` is `it.skip`'d (per Task 11's decision) and item 4 is covered by the Task 13 manual drive — a skipped test here is the expected outcome, not a failure.

- [ ] **Step 3: Commit**

```bash
git add packages/router/test/containers-real-docker.e2e.test.ts
git commit -m "test(router): assert /workspaces/<KEY> is a real directory in-container"
```

---

## Phase 5 — Manual real-Claude drive (documentation deliverable)

### Task 13: Router-mode test-drive runbook + drive report

**Files:**
- Create: `apps/f1/test-drives/README-router-mode.md` (runbook)
- Create (at drive time): `apps/f1/test-drives/YYYY-MM-DD-router-mode-container-drive.md` (report)

- [ ] **Step 1: Write the runbook**

Document the end-to-end manual drive using real credentials:
1. `docker build -f docker/worker/Dockerfile -t cyrus-worker:test .`
2. `F1_ROUTER_CONTROL_TOKEN=<tok> bun run router-server.ts` (real executor).
3. `./f1 router:seed-user --email you@example.com --linear-id lin-you --claude-token <CLAUDE_CODE_OAUTH_TOKEN>`
4. `./f1 create-issue ...` (via `/cli/rpc`), then `./f1 router:inject --kind created ...`.
5. Observe the container boot (`docker ps`), the in-container real Claude session, and `./f1 view-session` activities streaming back via RPC.
6. Let the session end; `./f1 router:artifact --identifier <KEY>` shows a bundle landed (floor upload, item 3, real path).
7. `docker exec <container> test ! -L /workspaces/<KEY>` (item 4, live session).
8. Stop the container; boot a fresh one; confirm rung-2 restore from the log.

- [ ] **Step 2: Run the drive with real credentials** and capture the report following the `apps/f1/test-drives/` convention. This is the credential-bearing counterpart to the CI-scripted A3/A4.

- [ ] **Step 3: Commit**

```bash
git add apps/f1/test-drives/README-router-mode.md
git commit -m "docs(f1): router-mode container test-drive runbook"
```

---

## Appendix — Track B: "no final response" anomaly (investigation, not TDD)

This is a **systematic-debugging** investigation; its fix is unknown, so it is not decomposed into pre-baked TDD tasks. Execute it with `superpowers:systematic-debugging`. The protocol (from the spec, reframed after the Codex review):

1. **The evidence contradiction:** the report's `Result message emitted to Linear (activity activity-89)` log fires only inside `if (result.activityId)` for a `type:"result"` entry (`AgentSessionManager.ts:1458-1463`) — so a response *was* emitted with an id. The original suspects (empty-content guard `:896`, sink skips `:1432`/`:1444`) are inconsistent with that and are demoted.
2. **Fix the oracle:** not issue `status: active` (CLI-tracker semantics ≠ Linear). Use three signals: (a) result-emit log with an id, (b) a `response` activity actually present in the tracker's activity list, (c) the terminal/status transition. The bug is where (a) disagrees with (b)/(c).
3. **Reproduce** on `cyrus-containers` via a CLI-mode F1 drive capturing all three signals.
4. **A/B against `origin/deploy`** with the same drive + oracle to confirm whether it predates the branch.
5. **Root-cause** starting from the contradiction: tracker-side persistence of the emitted response, then `emitTerminalOnce` / move-to-complete, only then the `addResultEntry` guards.
6. **Deliver** a minimal fix + failing-first regression test, or a standalone issue with the reproduction + attribution.

---

## Self-Review

**Plan-review corrections (Codex GPT-5.6-Sol, verified against source):**
- **Router bind interface** — the container-facing `RouterServer` binds `0.0.0.0` (Task 3, Task 8); only the F1 control plane binds `127.0.0.1` (Task 4). A loopback-bound router is unreachable from a container via `host.docker.internal` on Linux.
- **Suite-wide sweep isolation** — `ContainerLifecycle.sweep()` always runs orphan GC host-wide (`ContainerLifecycle.ts:114-141`), so the WHOLE real-Docker suite is gated behind `dedicatedDaemonOptIn()` (Tasks 8–12), and non-orphan tests wrap the provider in `scopedProvider(...)` (Task 7) so their sweeps can't reach foreign containers.
- **A4 reachability** — Task 11 is now a blocking gate that empirically decides whether the A4 CI assertion is achievable; if not, Task 12 is `it.skip` and item 4 is validated via the Task 13 manual drive.

**Spec coverage:**
- A1 (router-mode rig) → Tasks 1–6. ✓
- A2 (real-Docker lifecycle: boot serialization, idle-stop, stale-destroy, orphan GC) → Tasks 7–9. ✓ (boot-serialization/dedup is exercised by the cold-boot test in Task 8; add an explicit created+prompted-coalesce assertion there if desired.)
- A2 host-daemon isolation → Task 7 (`dedicatedDaemonOptIn` whole-suite gate + `scopedProvider`) + Task 9. ✓
- A3 (floor upload round-trip, scripted) → Task 10. ✓ Real-Claude path → Task 13. ✓
- A4 (dir invariant) → Task 11 (reachability gate) → Task 12 (CI, contingent) + Task 13 (live, guaranteed). ✓
- Track B → Appendix. ✓

**Placeholder scan:** the two "design decision to resolve during execution" notes (Task 10 restore-only path; Task 12 skip fallback) are genuine, spec-tracked open questions (#3, and the A3 stub-runner decision), not lazy placeholders — each names the exact decision and the recommended resolution. The `require("node:fs")` inline in Task 10 Step 1 is illustrative; replace with the top-level `existsSync` import when implementing.

**Type consistency:** `RouterRig`, `ControlServer`, `createRouterRig`, `startControlServer`, `startRouterServer`, `createdFixture`/`promptedFixture`/`seedSession`, and the daemon helpers are used with consistent signatures across tasks. `WORKSPACE` is the single shared workspace id. Executor test doubles implement the full `ContainerExecutor` interface in every task that defines one.

**Known verify-at-execution points (each flagged inline):** `server.store.addUser`/`setUserExecutor`/`createContainerDevice`/`rotateContainerDeviceToken` exact signatures (`RouterStore.ts`); `CLIRPCServer` constructor field names (`EdgeWorker.ts:880`); `ContainerLifecycle` `now` option name (`containers-e2e.test.ts:500-514` uses `now`); worktree-before-runner ordering (Task 11). These are named, not assumed.
