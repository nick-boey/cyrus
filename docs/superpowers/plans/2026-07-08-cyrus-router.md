# Cyrus Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the per-user device routing architecture from `docs/superpowers/specs/2026-07-08-cyrus-router-design.md`, first reverting the single-host multi-user env-var credential injection feature (keeping only the `SessionCreator` threading and F1 creator payloads the router needs).

**Architecture:** A `cyrus router` server process owns the Linear app token, receives all webhooks, and routes each agent session to the enrolled device of the session creator over device-dialed WebSockets. Devices run EdgeWorker in a new `"router"` platform mode behind two adapters (`RouterEventTransport` implements `IAgentEventTransport`; `RouterIssueTrackerService` implements `IIssueTrackerService` by RPC-forwarding to the router). Durable per-device SQLite FIFO queues give at-least-once, in-order delivery with offline TTL.

**Tech Stack:** TypeScript ESM, pnpm workspaces, vitest, zod 4.3.6, fastify ^5.8.5, `ws` ^8 (new dep), `better-sqlite3` ^12 (new dep).

## Global Constraints

- Package manager: pnpm 10.11.0. Run package tests with `pnpm --filter <pkg> test:run`, typecheck with `pnpm --filter <pkg> typecheck`; full sweeps `pnpm test:packages:run` and `pnpm typecheck` from root.
- All new packages: TypeScript strict, ESM (`"type": "module"`), zero `any` types, vitest for tests. Follow the structure of `packages/linear-event-transport` (src/, test/, tsconfig.json, vitest.config.ts).
- New native dep `better-sqlite3` must be added to `pnpm.onlyBuiltDependencies` in the root `package.json` (alongside the existing `"sqlite3"` entry).
- Commit after every task with a conventional-commit message ending in the trailer `Claude-Session: https://claude.ai/code/session_019vb5x4gfKQH5Z7MY5BzZvM`.
- **Boundary invariant (from spec):** router/client code interacts with core Cyrus only through `IAgentEventTransport` and `IIssueTrackerService`. Permitted exceptions, each deliberate and scoped: (1) the `platform: "router"` construction branch in `EdgeWorker.ts` mirroring the existing `"cli"` branch, (2) the `GitService` worktree-continuity change, (3) config schema additions in `cyrus-core`.
- **ConfigManager gotcha (CLAUDE.md §9):** any new top-level `EdgeWorkerConfig` field MUST be added to the hardcoded merge list in `ConfigManager.loadConfigSafely()` AND the `globalKeys` array in `detectGlobalConfigChanges()` in `packages/edge-worker/src/ConfigManager.ts`.
- **KEEP list for Phase 0 (do NOT remove):** `SessionCreator` type and `creator` field in `packages/core/src/CyrusAgentSession.ts`; creator threading at `EdgeWorker.ts:4494` and `EdgeWorker.ts:4914` (`creator: webhook.agentSession.creator` when creating sessions); `CLIIssueTrackerService.buildCreatorPayload()` and its attachment sites (`CLIIssueTrackerService.ts:821-834`, `:952`, `:1303-1305`); `UserIdentifierSchema` and `userMatchesIdentifier` (also used by user access control, reused by the router); `DEFAULT_UNREGISTERED_USER_MESSAGE` constant (reused by the router in Task 8).
- Changelog rules: user-facing entries in `CHANGELOG.md` under `## [Unreleased]`; internal/refactor notes in `CHANGELOG.internal.md`.

## File Structure

```
packages/router-protocol/          NEW — wire frames + RPC method allowlist (zod)
  src/frames.ts                    frame schemas, parse helpers, PROTOCOL_VERSION
  src/rpc-methods.ts               RPC_METHODS allowlist, session-scoped subset
  src/index.ts
packages/router/                   NEW — server
  src/RouterStore.ts               SQLite: users/devices/codes/queue/affinity/locks
  src/DeviceGateway.ts             ws server, auth, delivery, acks, rpc ingress
  src/EventRouter.ts               creator routing, policies, offline notices
  src/LinearExecutor.ts            RPC dispatch + authorization + activity posting
  src/RouterServer.ts              composition root: fastify + webhook + sweep
  src/enrollment.ts                POST /enroll handler
packages/router-client/            NEW — device side
  src/RouterConnection.ts          dial, hello, reconnect, rpc(), acks, buffer
  src/RouterIssueTrackerService.ts implements IIssueTrackerService via rpc()
  src/RouterEventTransport.ts      implements IAgentEventTransport
packages/edge-worker/src/EdgeWorker.ts        MODIFY — "router" platform branch; Phase 0 removals
packages/edge-worker/src/RunnerConfigBuilder.ts MODIFY — Phase 0 removals
packages/edge-worker/src/GitService.ts        MODIFY — remote-branch preference, WIP push
packages/edge-worker/src/ConfigManager.ts     MODIFY — router field in merge/globalKeys
packages/core/src/config-schemas.ts           MODIFY — remove users/gitCommitAuthor; add router
packages/claude-runner/src/session-env.ts     MODIFY — Phase 0 removals
apps/cli/src/app.ts + commands/               MODIFY — remove users cmd; add router/connect cmds
apps/f1/server.ts                             MODIFY — remove env-gated users config
```

---

# Phase 0 — Revert multi-user credential injection

Reverts commits `4a223b19`, `8891281d`, `c0722c09` (partially — keep creator threading), `2af7366f`, `70ec7d09`, `3c59179b`, `4a9cb450`, `0a112f29`, and the schema halves of `13dd242e`. Work top-down (consumers before core) so typecheck stays green at every commit. After each removal step, run typecheck and let remaining compile errors point at stragglers — but the sites listed are believed complete.

### Task 1: Remove the `cyrus users` CLI command and F1/CLI config plumbing

**Files:**
- Delete: `apps/cli/src/commands/UsersCommand.ts`, `apps/cli/src/commands/UsersCommand.test.ts`
- Modify: `apps/cli/src/app.ts:168-202` (users command registration)
- Modify: `apps/cli/src/services/WorkerService.ts:249-251` (users/gitCommitAuthor passthrough)
- Delete: `apps/cli/src/services/WorkerService.users-passthrough.test.ts` (or the equivalent test file guarding the passthrough — find with `grep -rl "users-passthrough\|gitCommitAuthor" apps/cli/src`)
- Modify: `apps/f1/server.ts:177-187` (env-gated users config)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: a CLI/F1 surface with no multi-user credential references; `EdgeWorkerConfig.users` / `.gitCommitAuthor` become unreferenced in apps (removed from core in Task 4).

- [ ] **Step 1: Delete the command files**

```bash
git rm apps/cli/src/commands/UsersCommand.ts apps/cli/src/commands/UsersCommand.test.ts
```

- [ ] **Step 2: Remove the command registration from `apps/cli/src/app.ts`**

Delete the entire block from the comment `// Users command - manage per-user credential profiles (multi-user mode)` (line 168) through the `usersCommand.command("remove <email>")...action(makeUsersAction("remove"));` statement (line 202), including the `makeUsersAction` helper. Also remove the now-unused `UsersCommand` import at the top of the file.

- [ ] **Step 3: Remove the passthrough in `apps/cli/src/services/WorkerService.ts`**

Delete these lines (currently 249-251) from the EdgeWorkerConfig construction:

```ts
				// Multi-user credential profiles
				users: edgeConfig.users,
				gitCommitAuthor: edgeConfig.gitCommitAuthor,
```

Delete the passthrough test file found in Step 1's grep.

- [ ] **Step 4: Remove the env gate in `apps/f1/server.ts`**

Delete lines 177-187 (the comment starting `// Multi-user credential profiles for F1 validation.` and both spread expressions for `CYRUS_F1_USERS_JSON` and `CYRUS_F1_GIT_COMMIT_AUTHOR_JSON`).

- [ ] **Step 5: Typecheck the touched apps and run their tests**

Run: `pnpm --filter cyrus-ai typecheck && pnpm --filter cyrus-ai test:run && pnpm --filter f1 typecheck`
Expected: PASS (no references to `UsersCommand` remain; `users`/`gitCommitAuthor` still exist on the core schema until Task 4, so the config reads that remain in core compile fine).

- [ ] **Step 6: Commit**

```bash
git add -A apps/cli apps/f1
git commit -m "revert(cli,f1): remove cyrus users command and multi-user config plumbing"
```

### Task 2: Remove credential injection, gates, and resolver from EdgeWorker

**Files:**
- Delete: `packages/edge-worker/src/UserCredentialResolver.ts` and its test file (`grep -rl "UserCredentialResolver" packages/edge-worker/test packages/edge-worker/src --include="*.test.ts"`)
- Modify: `packages/edge-worker/src/EdgeWorker.ts` — sites listed below

**Interfaces:**
- Consumes: nothing.
- Produces: `buildAgentRunnerConfig` no longer resolves/injects user profiles; `checkUserCredentialsOrBlock` and `UnregisteredUserError` are gone. **KEEP** creator threading (`creator: webhook.agentSession.creator` at lines 4494 and 4914) and the `DEFAULT_UNREGISTERED_USER_MESSAGE` constant (router reuses it in Task 8) — locate it with `grep -rn "DEFAULT_UNREGISTERED_USER_MESSAGE" packages`; if it is defined in edge-worker rather than core, move it to `packages/core/src/constants.ts` and export it from the core index in this task.

- [ ] **Step 1: Remove the resolver field, construction, and hot-reload wiring**

In `EdgeWorker.ts` delete:
- the `private userCredentialResolver: UserCredentialResolver` field declaration and the `UserCredentialResolver` / `UnregisteredUserError` imports,
- the construction block at lines 570-576 (comment `// Per-user credential profiles (multi-user mode). ...` through the closing `);`),
- the `configChanged` hot-reload call at lines 672-676 (`// this.config has the ~-normalized credentialsDir paths` through `);`).

- [ ] **Step 2: Remove the webhook gates**

Delete the whole `checkUserCredentialsOrBlock` method (lines ~6746-6797, including its doc comment) and its two call sites — one near the top of `handleAgentSessionCreatedWebhook` (~line 4266) and one near the top of `handleUserPromptedAgentActivity` (~line 5098). Each call site looks like:

```ts
		if (!(await this.checkUserCredentialsOrBlock(webhook))) {
			return;
		}
```

- [ ] **Step 3: Remove the runner-config backstop and env plumbing**

In `buildAgentRunnerConfig`, delete lines 6513-6541 (the comment `// Multi-user mode fail-closed backstop: ...` through the closing `}` of the `if (userProfile) { log.info(...) }` block) and the two lines inside the `buildIssueConfig` call (6555-6556):

```ts
				// Per-user credential env bundle (multi-user mode)
				userEnv: userProfile?.env,
```

Apply the same removal to any sibling `build*Config` call sites that pass `userEnv` (`grep -n "userEnv" packages/edge-worker/src/EdgeWorker.ts`).

- [ ] **Step 4: Restore the warm-session check**

In `isWarmSessionsEnabled()` (lines 6824-6835), delete the multi-user guard so the method reads:

```ts
	private isWarmSessionsEnabled(): boolean {
		const raw = process.env.CYRUS_ENABLE_WARM_SESSIONS;
		if (!raw) return false;
		const v = raw.toLowerCase().trim();
		return v === "1" || v === "true";
	}
```

- [ ] **Step 5: Delete the resolver files, typecheck, fix stragglers, run tests**

```bash
git rm packages/edge-worker/src/UserCredentialResolver.ts
git rm $(grep -rl "UserCredentialResolver" packages/edge-worker --include="*.test.ts")
```

Run: `pnpm --filter cyrus-edge-worker typecheck`
Expected: errors only at any site still referencing removed symbols — delete those references (they are all dead code from this feature). Then `pnpm --filter cyrus-edge-worker test:run` — expected PASS after also deleting multi-user-specific test cases that assert gate/injection behavior (find with `grep -rl "checkUserCredentialsOrBlock\|userEnv\|UnregisteredUserError" packages/edge-worker/test`). Do NOT delete tests asserting `session.creator` threading.

- [ ] **Step 6: Commit**

```bash
git add -A packages/edge-worker
git commit -m "revert(edge-worker): remove per-user credential injection, gates, and resolver"
```

### Task 3: Remove credential isolation from runners and RunnerConfigBuilder

**Files:**
- Modify: `packages/edge-worker/src/RunnerConfigBuilder.ts:486-501` and the `userEnv` input field on its input type
- Modify: `packages/claude-runner/src/session-env.ts:89-105` and the `credentialIsolation` config field in `packages/claude-runner/src/config.ts` / `ClaudeRunner.ts`
- Modify: `packages/codex-runner` — per-user env merge + isolation (sites via `grep -rn "credentialIsolation\|scrubCredentialEnv\|userEnv" packages/codex-runner/src`)
- Delete: `packages/core/src/credential-env.ts` and its test

**Interfaces:**
- Consumes: Task 2 (no EdgeWorker callers pass `userEnv` anymore).
- Produces: `composeSessionEnv(options: { repositoryEnv?: Record<string,string>; additionalEnv?: Record<string,string> })` — no `credentialIsolation` option anywhere.

- [ ] **Step 1: Remove the injection block from `RunnerConfigBuilder.ts`**

Delete lines 486-501 (comment `// Per-user credential env (multi-user mode). ...` through the closing `}`), plus the `userEnv?: Record<string, string>` field on the builder input interface and any test fixtures that set it (`grep -rn "userEnv" packages/edge-worker/src packages/edge-worker/test`).

- [ ] **Step 2: Remove isolation from claude-runner**

In `session-env.ts`, change `composeSessionEnv` to:

```ts
export function composeSessionEnv(options: {
	repositoryEnv?: Record<string, string>;
	additionalEnv?: Record<string, string>;
}): Record<string, string> {
	return {
		...buildBaseSessionEnv(),
		...(options.repositoryEnv ?? {}),
		...(options.additionalEnv ?? {}),
	};
}
```

Update the doc comment above it to drop the isolation/scrub paragraph. Remove the `credentialIsolation` field wherever it appears in claude-runner config types and `ClaudeRunner.ts` call sites, and any debug-log redaction added by commit `3c59179b` that exists solely to redact injected credentials (`git show 3c59179b --stat` lists the touched files; revert those hunks unless a non-multi-user caller uses them — typecheck decides).

- [ ] **Step 3: Remove isolation from codex-runner**

Revert the `70ec7d09` behavior: remove per-user env merge, `credentialIsolation` scrubbing, and userEnv-derived `codexHome` override (`config.codexHome` sourced from config stays; only the `userEnv.CODEX_HOME` sourcing is gone — that was removed with the RunnerConfigBuilder block in Step 1). Update codex-runner tests accordingly.

- [ ] **Step 4: Delete the core scrub module**

```bash
git rm packages/core/src/credential-env.ts
git rm $(grep -rl "scrubCredentialEnv\|CREDENTIAL_ENV_GROUPS" packages/core --include="*.test.ts")
```

Remove its export from `packages/core/src/index.ts`.

- [ ] **Step 5: Typecheck + test the three packages**

Run: `pnpm --filter cyrus-core --filter cyrus-claude-runner --filter cyrus-codex-runner --filter cyrus-edge-worker typecheck && pnpm --filter cyrus-claude-runner --filter cyrus-codex-runner --filter cyrus-edge-worker test:run`
Expected: PASS after removing isolation-specific test cases.

- [ ] **Step 6: Commit**

```bash
git add -A packages
git commit -m "revert(runners,core): remove credential isolation env composition and scrub module"
```

### Task 4: Remove multi-user config schemas and hot-reload whitelist entries

**Files:**
- Modify: `packages/core/src/config-schemas.ts:63-94` and `:524-532`
- Modify: `packages/edge-worker/src/ConfigManager.ts` (merge list + `globalKeys`)
- Modify: `CHANGELOG.md`, `CHANGELOG.internal.md`

**Interfaces:**
- Consumes: Tasks 1-3 (no remaining readers of `users` / `gitCommitAuthor`).
- Produces: `EdgeWorkerConfig` without `users`/`gitCommitAuthor`. **KEEP** `UserIdentifierSchema` and `userMatchesIdentifier` (used by user access control; reused by the router in Task 6).

- [ ] **Step 1: Remove the schemas**

In `config-schemas.ts` delete `UserCredentialConfigSchema` (lines 63-77 including doc comment), `GitCommitAuthorConfigSchema` (79-90), the `UserCredentialConfig`/`GitCommitAuthorConfig` type exports (93-94), and the two config fields at 524-532 (`users:` and `gitCommitAuthor:` with their comments). Keep `GitAuthorSchema`/`GitAuthor` only if `grep -rn "GitAuthorSchema\|GitAuthor\b" packages apps --include="*.ts" | grep -v config-schemas` still shows consumers; otherwise delete them too.

- [ ] **Step 2: Remove the ConfigManager whitelist entries**

In `packages/edge-worker/src/ConfigManager.ts`, remove the `users: parsedConfig.users || this.config.users` and `gitCommitAuthor: ...` lines from the `loadConfigSafely()` merge (~line 200) and remove `"users"` / `"gitCommitAuthor"` from the `globalKeys` array in `detectGlobalConfigChanges()`.

- [ ] **Step 3: Update changelogs**

In `CHANGELOG.md` under `## [Unreleased]`, delete the multi-user credential profiles entry added by commit `58b8a95c` (the feature never shipped in a release — verify by checking it sits under Unreleased; if it moved under a version heading, instead add a `### Removed` entry: "Removed per-user credential profiles (`cyrus users`); superseded by router mode"). In `CHANGELOG.internal.md` add under `## [Unreleased]` / `### Removed`: "Reverted multi-user env-var credential injection (UserCredentialResolver, credential-env scrub, cyrus users CLI); SessionCreator threading and F1 creator payloads retained for the router architecture."

- [ ] **Step 4: Full-repo verification**

Run: `pnpm typecheck && pnpm test:packages:run && grep -rn "UserCredentialConfig\|gitCommitAuthor\|credentialsDir\|UserCredentialResolver\|credentialIsolation" packages apps --include="*.ts" | grep -v node_modules`
Expected: typecheck + tests PASS; grep returns no hits.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "revert(core): remove multi-user credential config schemas and hot-reload plumbing"
```

# Phase 1 — Wire protocol

### Task 5: `cyrus-router-protocol` package — frames and RPC allowlist

**Files:**
- Create: `packages/router-protocol/package.json`, `tsconfig.json`, `vitest.config.ts` (copy shape from `packages/linear-event-transport`, name `cyrus-router-protocol`, deps: `zod@4.3.6` only)
- Create: `packages/router-protocol/src/frames.ts`, `src/rpc-methods.ts`, `src/index.ts`
- Test: `packages/router-protocol/test/frames.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (used by Tasks 6-13): `PROTOCOL_VERSION = 1`; types `HelloFrame`, `HelloAckFrame`, `HelloErrorFrame`, `EventFrame`, `EventAckFrame`, `RpcRequestFrame`, `RpcResponseFrame`, `SessionStateFrame`; unions `DeviceFrame` (device→router: hello | event_ack | rpc_request | session_state) and `ServerFrame` (router→device: hello_ack | hello_error | event | rpc_response); `parseDeviceFrame(raw: string): DeviceFrame` and `parseServerFrame(raw: string): ServerFrame` (throw `ZodError`/`SyntaxError` on invalid input); `RPC_METHODS: readonly string[]`; `SESSION_SCOPED_RPC_METHODS: readonly string[]`; `RpcMethod` type.

- [ ] **Step 1: Write the failing test**

```ts
// packages/router-protocol/test/frames.test.ts
import { describe, expect, it } from "vitest";
import {
	parseDeviceFrame,
	parseServerFrame,
	PROTOCOL_VERSION,
	RPC_METHODS,
	SESSION_SCOPED_RPC_METHODS,
} from "../src/index.js";

describe("frames", () => {
	it("round-trips a hello frame", () => {
		const frame = parseDeviceFrame(
			JSON.stringify({
				type: "hello",
				deviceToken: "tok",
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);
		expect(frame.type).toBe("hello");
	});

	it("rejects an unknown frame type", () => {
		expect(() => parseDeviceFrame(JSON.stringify({ type: "nope" }))).toThrow();
	});

	it("parses an rpc_request with positional params", () => {
		const frame = parseDeviceFrame(
			JSON.stringify({
				type: "rpc_request",
				id: "r1",
				method: "fetchIssue",
				params: ["ABC-1"],
			}),
		);
		if (frame.type !== "rpc_request") throw new Error("wrong type");
		expect(frame.method).toBe("fetchIssue");
	});

	it("parses a server event frame with opaque payload", () => {
		const frame = parseServerFrame(
			JSON.stringify({ type: "event", seq: 7, event: { action: "created" } }),
		);
		if (frame.type !== "event") throw new Error("wrong type");
		expect(frame.seq).toBe(7);
	});

	it("session-scoped methods are a subset of the allowlist", () => {
		for (const m of SESSION_SCOPED_RPC_METHODS) {
			expect(RPC_METHODS).toContain(m);
		}
	});
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter cyrus-router-protocol test:run`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the frames**

```ts
// packages/router-protocol/src/frames.ts
import { z } from "zod";

export const PROTOCOL_VERSION = 1;

const helloFrame = z.object({
	type: z.literal("hello"),
	deviceToken: z.string().min(1),
	protocolVersion: z.number().int(),
	lastAckedSeq: z.number().int().nonnegative(),
});
const eventAckFrame = z.object({
	type: z.literal("event_ack"),
	seq: z.number().int().positive(),
});
const rpcRequestFrame = z.object({
	type: z.literal("rpc_request"),
	id: z.string().min(1),
	method: z.string().min(1),
	params: z.array(z.unknown()),
});
const sessionStateFrame = z.object({
	type: z.literal("session_state"),
	sessionId: z.string().min(1),
	state: z.enum(["complete", "error", "stopped"]),
});
const helloAckFrame = z.object({
	type: z.literal("hello_ack"),
	user: z.object({
		id: z.string().optional(),
		email: z.string().optional(),
		name: z.string().optional(),
	}),
	serverVersion: z.string(),
});
const helloErrorFrame = z.object({
	type: z.literal("hello_error"),
	reason: z.string(),
});
const eventFrame = z.object({
	type: z.literal("event"),
	seq: z.number().int().positive(),
	event: z.unknown(),
});
const rpcResponseFrame = z.object({
	type: z.literal("rpc_response"),
	id: z.string().min(1),
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z.string().optional(),
});

const deviceFrame = z.discriminatedUnion("type", [
	helloFrame,
	eventAckFrame,
	rpcRequestFrame,
	sessionStateFrame,
]);
const serverFrame = z.discriminatedUnion("type", [
	helloAckFrame,
	helloErrorFrame,
	eventFrame,
	rpcResponseFrame,
]);

export type HelloFrame = z.infer<typeof helloFrame>;
export type EventAckFrame = z.infer<typeof eventAckFrame>;
export type RpcRequestFrame = z.infer<typeof rpcRequestFrame>;
export type SessionStateFrame = z.infer<typeof sessionStateFrame>;
export type HelloAckFrame = z.infer<typeof helloAckFrame>;
export type HelloErrorFrame = z.infer<typeof helloErrorFrame>;
export type EventFrame = z.infer<typeof eventFrame>;
export type RpcResponseFrame = z.infer<typeof rpcResponseFrame>;
export type DeviceFrame = z.infer<typeof deviceFrame>;
export type ServerFrame = z.infer<typeof serverFrame>;

export function parseDeviceFrame(raw: string): DeviceFrame {
	return deviceFrame.parse(JSON.parse(raw));
}
export function parseServerFrame(raw: string): ServerFrame {
	return serverFrame.parse(JSON.parse(raw));
}
```

```ts
// packages/router-protocol/src/rpc-methods.ts
/**
 * IIssueTrackerService methods a device may invoke over RPC. Mirrors
 * packages/core/src/issue-tracker/IIssueTrackerService.ts. downloadAttachment
 * is a router extension (Task 9) for token-authenticated attachment bytes.
 */
export const RPC_METHODS = [
	"fetchIssue",
	"fetchIssueChildren",
	"updateIssue",
	"fetchIssueAttachments",
	"fetchComments",
	"fetchComment",
	"fetchCommentWithAttachments",
	"createComment",
	"fetchTeams",
	"fetchTeam",
	"fetchLabels",
	"fetchLabel",
	"getIssueLabels",
	"fetchWorkflowStates",
	"fetchWorkflowState",
	"fetchUser",
	"fetchCurrentUser",
	"createAgentSessionOnIssue",
	"createAgentSessionOnComment",
	"fetchAgentSession",
	"emitStopSignalEvent",
	"createAgentActivity",
	"requestFileUpload",
	"downloadAttachment",
] as const;

/** Methods whose first-positional or `agentSessionId` param must belong to the calling device. */
export const SESSION_SCOPED_RPC_METHODS = [
	"createAgentActivity",
	"emitStopSignalEvent",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];
```

`src/index.ts` re-exports both modules.

- [ ] **Step 4: Run tests, typecheck**

Run: `pnpm --filter cyrus-router-protocol test:run && pnpm --filter cyrus-router-protocol typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/router-protocol pnpm-lock.yaml
git commit -m "feat(router-protocol): wire frames and RPC allowlist for device routing"
```

# Phase 2 — Router server

### Task 6: `RouterStore` — SQLite registry, queue, affinity, locks

**Files:**
- Create: `packages/router/package.json` (name `cyrus-router`; deps: `better-sqlite3@^12.4.1`, `cyrus-router-protocol@workspace:*`, `cyrus-core@workspace:*`, `cyrus-linear-event-transport@workspace:*` [check exact package name in `packages/linear-event-transport/package.json`], `fastify@^5.8.5`, `ws@^8.18.0`, `zod@4.3.6`; devDeps: `@types/better-sqlite3`, `@types/ws`, `vitest`)
- Create: `packages/router/src/RouterStore.ts`
- Modify: root `package.json` — add `"better-sqlite3"` to `pnpm.onlyBuiltDependencies`
- Test: `packages/router/test/RouterStore.test.ts`

**Interfaces:**
- Consumes: nothing (pure storage).
- Produces (used by Tasks 7-9, 13):

```ts
class RouterStore {
	constructor(dbPath: string); // ":memory:" in tests
	addUser(input: { email: string; name?: string; linearId?: string }): { userId: number };
	listUsers(): Array<{ userId: number; email: string; name?: string; linearId?: string; deviceEnrolled: boolean }>;
	removeUser(email: string): boolean;
	findUserForCreator(creator: { id?: string; email?: string }): { userId: number; email: string } | undefined;
	mintEnrollmentCode(email: string, nowMs: number): string; // throws if user unknown
	redeemEnrollmentCode(code: string, nowMs: number): { deviceId: number; deviceToken: string } | undefined; // burns code, replaces any existing device for that user
	getDeviceByToken(token: string): { deviceId: number; userId: number } | undefined;
	getDeviceForUser(userId: number): { deviceId: number } | undefined;
	revokeDevice(email: string): boolean;
	enqueueEvent(deviceId: number, payloadJson: string, nowMs: number, ttlMs: number): number; // returns seq (per-device monotonic)
	pendingEvents(deviceId: number, afterSeq: number, nowMs: number): Array<{ seq: number; payloadJson: string }>;
	ackEvent(deviceId: number, seq: number): void;
	expireEvents(nowMs: number): Array<{ deviceId: number; seq: number; payloadJson: string }>; // deletes and returns expired unacked
	setSessionAffinity(sessionId: string, deviceId: number, creatorJson?: string): void; // creatorJson: JSON of the SessionCreator, for prompt-policy checks
	getSessionAffinity(sessionId: string): number | undefined;
	getSessionCreator(sessionId: string): string | undefined; // the stored creatorJson
	clearSessionAffinity(sessionId: string): void;
	setIssueAffinity(issueId: string, deviceId: number): void;
	getIssueAffinity(issueId: string): number | undefined;
	acquireIssueLock(issueId: string, sessionId: string, deviceId: number): boolean; // false if held by another session
	getIssueLock(issueId: string): { sessionId: string; deviceId: number } | undefined;
	releaseIssueLockForSession(sessionId: string): void;
	releaseLocksAndAffinityForDevice(deviceId: number): void; // used on revoke
	close(): void;
}
```

- [ ] **Step 1: Write failing tests covering the contract**

```ts
// packages/router/test/RouterStore.test.ts
import { describe, expect, it } from "vitest";
import { RouterStore } from "../src/RouterStore.js";

const NOW = 1_000_000;

function storeWithDevice() {
	const store = new RouterStore(":memory:");
	store.addUser({ email: "alice@example.com", name: "Alice" });
	const code = store.mintEnrollmentCode("alice@example.com", NOW);
	const device = store.redeemEnrollmentCode(code, NOW + 1000);
	if (!device) throw new Error("redeem failed");
	return { store, device };
}

describe("RouterStore", () => {
	it("enrolls a device via one-time code and burns the code", () => {
		const { store, device } = storeWithDevice();
		expect(store.getDeviceByToken(device.deviceToken)?.deviceId).toBe(device.deviceId);
		// burned: second redeem fails
		expect(store.redeemEnrollmentCode("nonsense", NOW)).toBeUndefined();
	});

	it("expires enrollment codes after 15 minutes", () => {
		const store = new RouterStore(":memory:");
		store.addUser({ email: "a@x.com" });
		const code = store.mintEnrollmentCode("a@x.com", NOW);
		expect(store.redeemEnrollmentCode(code, NOW + 16 * 60_000)).toBeUndefined();
	});

	it("re-enrollment replaces the device and invalidates the old token", () => {
		const { store, device } = storeWithDevice();
		const code2 = store.mintEnrollmentCode("alice@example.com", NOW);
		const device2 = store.redeemEnrollmentCode(code2, NOW);
		expect(device2).toBeDefined();
		expect(store.getDeviceByToken(device.deviceToken)).toBeUndefined();
	});

	it("matches creators by email case-insensitively and by linearId", () => {
		const store = new RouterStore(":memory:");
		store.addUser({ email: "Bob@Example.com", linearId: "lin-1" });
		expect(store.findUserForCreator({ email: "bob@example.com" })).toBeDefined();
		expect(store.findUserForCreator({ id: "lin-1" })).toBeDefined();
		expect(store.findUserForCreator({ email: "nobody@x.com" })).toBeUndefined();
	});

	it("queues events FIFO per device with monotonic seq and ack removal", () => {
		const { store, device } = storeWithDevice();
		const s1 = store.enqueueEvent(device.deviceId, '{"n":1}', NOW, 60_000);
		const s2 = store.enqueueEvent(device.deviceId, '{"n":2}', NOW, 60_000);
		expect(s2).toBe(s1 + 1);
		expect(store.pendingEvents(device.deviceId, 0, NOW).map((e) => e.seq)).toEqual([s1, s2]);
		store.ackEvent(device.deviceId, s1);
		expect(store.pendingEvents(device.deviceId, 0, NOW).map((e) => e.seq)).toEqual([s2]);
	});

	it("expireEvents removes and returns events past their TTL", () => {
		const { store, device } = storeWithDevice();
		store.enqueueEvent(device.deviceId, '{"n":1}', NOW, 1000);
		const expired = store.expireEvents(NOW + 2000);
		expect(expired).toHaveLength(1);
		expect(store.pendingEvents(device.deviceId, 0, NOW + 2000)).toHaveLength(0);
	});

	it("issue lock is exclusive per issue and released by session", () => {
		const { store, device } = storeWithDevice();
		expect(store.acquireIssueLock("ISS-1", "sess-1", device.deviceId)).toBe(true);
		// same session re-acquire is fine
		expect(store.acquireIssueLock("ISS-1", "sess-1", device.deviceId)).toBe(true);
		expect(store.acquireIssueLock("ISS-1", "sess-2", device.deviceId)).toBe(false);
		store.releaseIssueLockForSession("sess-1");
		expect(store.acquireIssueLock("ISS-1", "sess-2", device.deviceId)).toBe(true);
	});

	it("stores session and issue affinity", () => {
		const { store, device } = storeWithDevice();
		store.setSessionAffinity("sess-1", device.deviceId);
		store.setIssueAffinity("ISS-1", device.deviceId);
		expect(store.getSessionAffinity("sess-1")).toBe(device.deviceId);
		expect(store.getIssueAffinity("ISS-1")).toBe(device.deviceId);
	});
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm install && pnpm --filter cyrus-router test:run`
Expected: FAIL (RouterStore not implemented).

- [ ] **Step 3: Implement `RouterStore`**

Implementation notes (write the class straightforwardly with `better-sqlite3` prepared statements):

```ts
// packages/router/src/RouterStore.ts — schema executed in the constructor
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  linear_id TEXT
);
CREATE TABLE IF NOT EXISTS devices (
  device_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS enrollment_codes (
  code_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  expires_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  device_id INTEGER NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  enqueued_ms INTEGER NOT NULL,
  expires_ms INTEGER NOT NULL,
  PRIMARY KEY (device_id, seq)
);
CREATE TABLE IF NOT EXISTS session_affinity (
  session_id TEXT PRIMARY KEY, device_id INTEGER NOT NULL, creator_json TEXT
);
CREATE TABLE IF NOT EXISTS issue_affinity (
  issue_id TEXT PRIMARY KEY, device_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS issue_locks (
  issue_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, device_id INTEGER NOT NULL
);
`;
```

Set `PRAGMA journal_mode = WAL` in the constructor so CLI admin commands (Task 13) can operate on the db while the server holds it open.

Key behaviors: tokens and codes are 32 random bytes hex (`crypto.randomBytes(32).toString("hex")`), stored as SHA-256 hashes (`crypto.createHash("sha256")`), plaintext returned once from mint/redeem. Enrollment codes expire 15 minutes after `nowMs` (constant `ENROLLMENT_CODE_TTL_MS = 15 * 60_000`). `redeemEnrollmentCode` runs in a transaction: validate + delete code, `INSERT OR REPLACE` the user's device row (UNIQUE user_id enforces single-device), return new token. `enqueueEvent` computes `seq = 1 + COALESCE(MAX(seq) WHERE device_id = ?, 0)` inside a transaction. `acquireIssueLock` returns true when no row exists or the row's `session_id` matches; inserts otherwise. All timestamps are caller-supplied `nowMs` (no `Date.now()` inside the store — keeps tests deterministic).

- [ ] **Step 4: Run tests + typecheck**

Run: `pnpm --filter cyrus-router test:run && pnpm --filter cyrus-router typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/router package.json pnpm-lock.yaml
git commit -m "feat(router): SQLite store for devices, queues, affinity, and locks"
```

### Task 7: `DeviceGateway` — WebSocket auth, delivery, and ingress

**Files:**
- Create: `packages/router/src/DeviceGateway.ts`
- Test: `packages/router/test/DeviceGateway.test.ts`

**Interfaces:**
- Consumes: `RouterStore` (Task 6), frames (Task 5).
- Produces (used by Tasks 8-9):

```ts
class DeviceGateway extends EventEmitter {
	constructor(store: RouterStore, opts?: { heartbeatMs?: number }); // default 30_000
	attach(httpServer: import("node:http").Server, path: string): void; // path "/device"
	isOnline(deviceId: number): boolean;
	deliverPending(deviceId: number): void; // reads store.pendingEvents, sends event frames
	sendRpcResponse(deviceId: number, frame: RpcResponseFrame): void;
	close(): void;
}
// events:
//  "deviceConnected"   (deviceId: number)
//  "deviceDisconnected"(deviceId: number)
//  "rpc"               (deviceId: number, frame: RpcRequestFrame)
//  "sessionState"      (deviceId: number, frame: SessionStateFrame)
//  "eventAck"          (deviceId: number, seq: number)
```

Behavior contract: on connection, the first frame must be `hello` within 10s or the socket is closed. Token is looked up via `store.getDeviceByToken`; failure sends `hello_error` and closes. Success sends `hello_ack`, acks everything ≤ `lastAckedSeq` (`store.ackEvent` loop over pending ≤ that seq), then calls `deliverPending`. `event_ack` frames call `store.ackEvent`. Heartbeat uses ws-level `ping()`; a socket that misses two heartbeats is terminated. A second connection for the same device terminates the first (single device, newest wins).

- [ ] **Step 1: Write failing tests (real ws over an ephemeral http server)**

```ts
// packages/router/test/DeviceGateway.test.ts
import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { RouterStore } from "../src/RouterStore.js";
import { DeviceGateway } from "../src/DeviceGateway.js";

const NOW = 1_000_000;

async function setup() {
	const store = new RouterStore(":memory:");
	store.addUser({ email: "alice@example.com" });
	const code = store.mintEnrollmentCode("alice@example.com", NOW);
	const device = store.redeemEnrollmentCode(code, NOW);
	if (!device) throw new Error("redeem failed");
	const gateway = new DeviceGateway(store);
	const httpServer = createServer();
	gateway.attach(httpServer, "/device");
	await new Promise<void>((r) => httpServer.listen(0, r));
	const port = (httpServer.address() as AddressInfo).port;
	return { store, gateway, device, port, httpServer };
}

function connect(port: number): WebSocket {
	return new WebSocket(`ws://127.0.0.1:${port}/device`);
}

function nextMessage(ws: WebSocket): Promise<string> {
	return new Promise((r) => ws.once("message", (d) => r(d.toString())));
}

describe("DeviceGateway", () => {
	it("rejects a bad token with hello_error", async () => {
		const { port, gateway, httpServer } = await setup();
		const ws = connect(port);
		await new Promise((r) => ws.once("open", r));
		ws.send(JSON.stringify({ type: "hello", deviceToken: "bad", protocolVersion: 1, lastAckedSeq: 0 }));
		const msg = JSON.parse(await nextMessage(ws));
		expect(msg.type).toBe("hello_error");
		gateway.close(); httpServer.close();
	});

	it("delivers queued events in order after hello and removes them on ack", async () => {
		const { store, gateway, device, port, httpServer } = await setup();
		store.enqueueEvent(device.deviceId, '{"n":1}', NOW, 60_000);
		store.enqueueEvent(device.deviceId, '{"n":2}', NOW, 60_000);
		const ws = connect(port);
		await new Promise((r) => ws.once("open", r));
		ws.send(JSON.stringify({ type: "hello", deviceToken: device.deviceToken, protocolVersion: 1, lastAckedSeq: 0 }));
		const first = JSON.parse(await nextMessage(ws)); // hello_ack
		expect(first.type).toBe("hello_ack");
		const e1 = JSON.parse(await nextMessage(ws));
		const e2 = JSON.parse(await nextMessage(ws));
		expect([e1.seq, e2.seq]).toEqual([1, 2]);
		ws.send(JSON.stringify({ type: "event_ack", seq: 1 }));
		await new Promise((r) => setTimeout(r, 50));
		expect(store.pendingEvents(device.deviceId, 0, NOW).map((e) => e.seq)).toEqual([2]);
		gateway.close(); httpServer.close();
	});

	it("emits rpc frames and reports online state", async () => {
		const { gateway, device, port, httpServer } = await setup();
		const ws = connect(port);
		await new Promise((r) => ws.once("open", r));
		ws.send(JSON.stringify({ type: "hello", deviceToken: device.deviceToken, protocolVersion: 1, lastAckedSeq: 0 }));
		await nextMessage(ws); // hello_ack
		expect(gateway.isOnline(device.deviceId)).toBe(true);
		const rpcPromise = new Promise<[number, { method: string }]>((r) =>
			gateway.once("rpc", (id, frame) => r([id, frame])),
		);
		ws.send(JSON.stringify({ type: "rpc_request", id: "r1", method: "fetchIssue", params: ["ABC-1"] }));
		const [deviceId, frame] = await rpcPromise;
		expect(deviceId).toBe(device.deviceId);
		expect(frame.method).toBe("fetchIssue");
		gateway.close(); httpServer.close();
	});
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter cyrus-router test:run` → FAIL.

- [ ] **Step 3: Implement `DeviceGateway`**

Use `new WebSocketServer({ server: httpServer, path })` from `ws`. Maintain `private sockets = new Map<number, WebSocket>()`. Parse inbound messages with `parseDeviceFrame`; on parse error, close the socket with code 1002. Route `hello` per the behavior contract above; after auth attach a per-socket listener that dispatches `event_ack` → `store.ackEvent` + emit `"eventAck"`, `rpc_request` → emit `"rpc"`, `session_state` → emit `"sessionState"`. `deliverPending` iterates `store.pendingEvents(deviceId, 0, Date.now())` and writes `EventFrame`s (delivery re-sends unacked events — at-least-once by design; the client dedupes by seq). Heartbeat: `setInterval` pinging all sockets; track `isAlive` per socket flipped by `pong`. `close()` clears the interval and closes all sockets.

- [ ] **Step 4: Run tests + typecheck** — `pnpm --filter cyrus-router test:run && pnpm --filter cyrus-router typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/router
git commit -m "feat(router): device gateway with ws auth, ordered delivery, and acks"
```

### Task 8: `EventRouter` — creator routing, policies, offline notices

**Files:**
- Create: `packages/router/src/EventRouter.ts`
- Test: `packages/router/test/EventRouter.test.ts`

**Interfaces:**
- Consumes: `RouterStore`, `DeviceGateway.isOnline/deliverPending`, an activity-posting callback (implemented by `LinearExecutor` in Task 9), webhook type guards `isAgentSessionCreatedWebhook` / `isAgentSessionPromptedWebhook` from `cyrus-core`, and `DEFAULT_UNREGISTERED_USER_MESSAGE` from `cyrus-core`.
- Produces:

```ts
interface EventRouterOptions {
	store: RouterStore;
	gateway: Pick<DeviceGateway, "isOnline" | "deliverPending">;
	postActivity: (workspaceId: string, agentSessionId: string, body: string) => Promise<void>;
	config: { eventTtlMs: number; issueLock: boolean; creatorOnlyPrompting: boolean };
	logger: { info(msg: string): void; warn(msg: string): void };
	now?: () => number; // injectable clock, default Date.now
}
class EventRouter {
	constructor(opts: EventRouterOptions);
	route(event: AgentEvent): Promise<void>;
	handleSessionState(deviceId: number, frame: SessionStateFrame): void; // releases lock + affinity
	sweepExpired(): Promise<void>; // expire + post TTL failure activities
}
```

Routing algorithm for `route(event)`:
1. `agentSessionPrompted` → device = `store.getSessionAffinity(sessionId)`. If found and `creatorOnlyPrompting` is on: compare the prompt's actor (`event.agentActivity?.sourceCommentUser ?? event.agentSession.creator` — inspect the `AgentSessionPromptedWebhook` type in `cyrus-core` for the actual actor field and use that; the comparison target is `store.getSessionCreator(sessionId)`, persisted when the created event was routed) → if actor ≠ creator, post the polite rejection activity and return without enqueueing.
2. `agentSessionCreated` → resolve device: `store.getSessionAffinity` (re-delivery) → `store.findUserForCreator(event.agentSession.creator)` + `getDeviceForUser` → `store.getIssueAffinity(issueId)` (app-created sub-issues, registered atomically at creation — Task 9) → if the webhook's issue payload carries a parent issue id, `store.getIssueAffinity(parentIssueId)`. Unresolvable → post `DEFAULT_UNREGISTERED_USER_MESSAGE` activity and return.
3. Issue lock (created events only, when `config.issueLock`): `acquireIssueLock(issueId, sessionId, deviceId)`; on failure post "An agent is already working on this issue (session owned by another user). Try again when it finishes." and return.
4. Record `setSessionAffinity(sessionId, deviceId, creatorJson)` and `setIssueAffinity(issueId, deviceId)`.
5. `enqueueEvent(deviceId, JSON.stringify(event), now(), config.eventTtlMs)`; if `gateway.isOnline(deviceId)` → `gateway.deliverPending(deviceId)`; else post (once per session — keep a `Set<string>` of notified sessionIds) "Waiting for <user email>'s machine to come online. This session will start when their Cyrus device reconnects."

`sweepExpired()`: for each expired event, parse the payload, post "This request expired before <email>'s machine came online. Please re-delegate the issue." to its session, and log. When the expired event is an undelivered `agentSessionCreated`, also `releaseIssueLockForSession(sessionId)` and `clearSessionAffinity(sessionId)` so the issue is not locked by a session that never started.
`handleSessionState()`: on any terminal state call `releaseIssueLockForSession(sessionId)` and `clearSessionAffinity(sessionId)`.

- [ ] **Step 1: Write failing tests**

Use an in-memory store, a fake gateway (`{ isOnline: () => false, deliverPending: vi.fn() }`), and a recording `postActivity` spy. Cover: (a) created event routed by creator email → enqueued, offline notice posted exactly once for two events on the same session; (b) unknown creator → unregistered activity, nothing enqueued; (c) second created event on a locked issue from a different session → lock rejection activity, nothing enqueued; (d) prompted event with actor ≠ creator and `creatorOnlyPrompting: true` → rejection activity, nothing enqueued; with `false` → enqueued; (e) `handleSessionState("complete")` releases the lock so a new session can acquire it; (f) `sweepExpired` posts the TTL activity for an expired event. Construct minimal event objects satisfying the `cyrus-core` webhook type guards (copy the fixture shapes from existing `packages/edge-worker/test` webhook fixtures — `grep -rl "isAgentSessionCreatedWebhook" packages/edge-worker/test` shows files with ready-made payloads).

- [ ] **Step 2: Run to verify failure** — `pnpm --filter cyrus-router test:run` → FAIL.

- [ ] **Step 3: Implement `EventRouter` per the algorithm above.**

- [ ] **Step 4: Run tests + typecheck** — PASS expected.

- [ ] **Step 5: Commit**

```bash
git add packages/router
git commit -m "feat(router): creator routing with issue locks, prompt policy, and offline notices"
```

### Task 9: `LinearExecutor`, enrollment endpoint, and `RouterServer` composition

**Files:**
- Create: `packages/router/src/LinearExecutor.ts`, `src/enrollment.ts`, `src/RouterServer.ts`, `src/index.ts`
- Test: `packages/router/test/LinearExecutor.test.ts`, `packages/router/test/RouterServer.test.ts`

**Interfaces:**
- Consumes: `IIssueTrackerService` (from `cyrus-core`), `RPC_METHODS` / `SESSION_SCOPED_RPC_METHODS` (Task 5), `RouterStore`, `DeviceGateway`, `EventRouter`.
- Produces:

```ts
class LinearExecutor {
	constructor(opts: {
		trackers: Map<string, IIssueTrackerService>; // workspaceId → tracker
		store: RouterStore;
		attachmentMaxBytes?: number; // default 20 MiB
	});
	dispatch(deviceId: number, frame: RpcRequestFrame): Promise<RpcResponseFrame>;
	postActivity(workspaceId: string, agentSessionId: string, body: string): Promise<void>;
}

interface RouterServerConfig {
	port: number;
	dbPath: string;
	workspaces: Record<string, { linearToken: string }>;
	webhook: { verificationMode: "direct" | "proxy"; secret: string };
	eventTtlMs?: number;          // default 48h
	issueLock?: boolean;          // default true
	creatorOnlyPrompting?: boolean; // default true
	trackerFactory?: (workspaceId: string, cfg: { linearToken: string }) => IIssueTrackerService; // test seam; default LinearIssueTrackerService
}
class RouterServer {
	constructor(config: RouterServerConfig);
	start(): Promise<void>; // fastify.listen + gateway.attach(fastify.server, "/device") + transport.register() + 60s sweep interval
	stop(): Promise<void>;
	readonly store: RouterStore; // exposed for CLI commands (Task 13)
}
```

`dispatch` rules: method must be in `RPC_METHODS` else `{ok:false, error:"method not allowed"}`. Params arrive positional; call `(tracker as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>)[method](...params)`. The FIRST param of every RPC is the `workspaceId` (the client prepends it — Task 11); pop it to select the tracker. For `SESSION_SCOPED_RPC_METHODS`, the next param is/contains the `agentSessionId` (for `createAgentActivity` it is `params[1].agentSessionId`; for `emitStopSignalEvent` it is `params[1]`): verify `store.getSessionAffinity(agentSessionId) === deviceId` else `{ok:false, error:"session not owned by this device"}`. `downloadAttachment(url)` is implemented in the executor itself: `fetch(url, { headers: { Authorization: \`Bearer ${linearToken}\` } })`, reject > `attachmentMaxBytes`, return `{ base64, contentType }`. Errors from tracker calls become `{ok:false, error: message}` — never a thrown exception across the socket. **Atomic sub-issue affinity (spec):** if the interface exposes an issue-creation method (check `IIssueTrackerService.ts` for a method taking `IssueCreateInput`; if none exists, skip — the parent-affinity fallback in Task 8 covers routing), then after a successful device-invoked issue creation call `store.setIssueAffinity(createdIssueId, deviceId)` before returning the response.

`enrollment.ts`: `registerEnrollmentRoute(fastify, store)` → `POST /enroll` body `{ code: string }` (zod-validated) → `store.redeemEnrollmentCode(code, Date.now())` → 200 `{ deviceToken }` or 401 `{ error: "invalid or expired code" }`.

`RouterServer.start()` wiring: build trackers from `workspaces` via `trackerFactory ?? ((id, c) => new LinearIssueTrackerService(new LinearClient({ accessToken: c.linearToken }), undefined))` — check `LinearIssueTrackerService`'s constructor signature at `packages/linear-event-transport/src/LinearIssueTrackerService.ts:96` and pass the minimal second argument it allows. Create the webhook transport with `trackers.values().next().value.createEventTransport({ platform: "linear", verificationMode, secret, fastifyServer: fastify })`, `transport.on("event", (e) => eventRouter.route(e))`. Wire `gateway.on("rpc", async (deviceId, frame) => gateway.sendRpcResponse(deviceId, await executor.dispatch(deviceId, frame)))` and `gateway.on("sessionState", (d, f) => eventRouter.handleSessionState(d, f))` and `gateway.on("deviceConnected", (d) => gateway.deliverPending(d))`.

- [ ] **Step 1: Write failing tests.** `LinearExecutor.test.ts`: with a stub tracker (`{ fetchIssue: vi.fn(async () => ({ id: "i1" })), createAgentActivity: vi.fn(async () => ({ success: true })) }` cast through `unknown` to `IIssueTrackerService`), assert (a) allowed method dispatches with workspace param popped, (b) disallowed method → `ok:false`, (c) `createAgentActivity` for a session with affinity to another device → `ok:false`, with own affinity → dispatched, (d) tracker throw → `ok:false` with message. `RouterServer.test.ts`: start on port 0 with `trackerFactory` returning a `CLIIssueTrackerService` (import from `cyrus-core`), POST /enroll with a minted code → 200 + token; bad code → 401.

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement the three modules per the contracts above.**

- [ ] **Step 4: Run tests + typecheck** — PASS expected.

- [ ] **Step 5: Commit**

```bash
git add packages/router
git commit -m "feat(router): rpc executor with authorization, enrollment endpoint, server composition"
```

# Phase 3 — Router client

### Task 10: `RouterConnection` — dial, reconnect, RPC, acks, outbound buffer

**Files:**
- Create: `packages/router-client/package.json` (name `cyrus-router-client`; deps: `cyrus-router-protocol@workspace:*`, `cyrus-core@workspace:*`, `ws@^8.18.0`; devDeps `@types/ws`, `vitest`), `tsconfig.json`, `vitest.config.ts`
- Create: `packages/router-client/src/RouterConnection.ts`
- Test: `packages/router-client/test/RouterConnection.test.ts`

**Interfaces:**
- Consumes: frames from Task 5.
- Produces (used by Tasks 11-12):

```ts
class RouterConnection extends EventEmitter {
	constructor(opts: {
		url: string;            // wss://router.example (path /device appended)
		deviceToken: string;
		stateDir: string;       // persists last-acked seq + outbound buffer (JSONL)
		reconnectBaseMs?: number; // default 1_000, exponential backoff capped 60_000
		rpcTimeoutMs?: number;    // default 30_000
	});
	connect(): void;   // begins dial loop; safe to call once
	close(): void;
	rpc(method: string, params: unknown[]): Promise<unknown>; // rejects on {ok:false} or timeout
	bufferedRpc(method: string, params: unknown[]): Promise<void>; // append-to-buffer when offline, else rpc(); replayed FIFO on reconnect
	sendSessionState(sessionId: string, state: "complete" | "error" | "stopped"): void;
	readonly connected: boolean;
}
// events: "connected" (helloAck: HelloAckFrame), "disconnected", "event" (event: unknown, seq: number)
```

Behavior contract: on socket open, send `hello` with `lastAckedSeq` read from `<stateDir>/router-connection.json` (`{ lastAckedSeq: number }`, default 0). On `hello_ack`: mark connected, replay the outbound buffer (`<stateDir>/outbound-buffer.jsonl`, one `{method, params, id}` per line — delete each line's entry only after its rpc resolves), emit `"connected"`. On `hello_error`: emit `"error"` and stop reconnecting (bad token is fatal — surface to the user). On `event` frame: if `seq <= lastAckedSeq` drop (duplicate) and re-ack; else emit `"event"`, then immediately send `event_ack` and persist `lastAckedSeq = seq` (ack-on-dispatch: at-least-once from the router, dedupe here). On close/error: emit `"disconnected"`, schedule reconnect with backoff. RPC: assign `id = randomUUID()`, keep a pending map `id → {resolve, reject, timer}`; `rpc_response` resolves/rejects; disconnect rejects all pending with a retryable error.

- [ ] **Step 1: Write failing tests**

Test against a minimal in-test ws server (raw `WebSocketServer` speaking the protocol — ~40 lines in the test file), covering: (a) hello carries persisted `lastAckedSeq`; (b) event → `"event"` emitted once, `event_ack` sent, duplicate seq dropped; (c) `rpc` resolves on `ok:true`, rejects with the error string on `ok:false`; (d) `bufferedRpc` while disconnected writes to the JSONL and replays after reconnect (start server after the call); (e) reconnect after server-side socket close (second `hello` observed).

- [ ] **Step 2: Run to verify failure** — `pnpm --filter cyrus-router-client test:run` → FAIL.

- [ ] **Step 3: Implement per the behavior contract.**

- [ ] **Step 4: Run tests + typecheck** — PASS expected.

- [ ] **Step 5: Commit**

```bash
git add packages/router-client pnpm-lock.yaml
git commit -m "feat(router-client): resilient device connection with rpc, acks, and offline buffer"
```

### Task 11: `RouterIssueTrackerService` + `RouterEventTransport`

**Files:**
- Create: `packages/router-client/src/RouterIssueTrackerService.ts`, `src/RouterEventTransport.ts`, `src/index.ts`
- Test: `packages/router-client/test/RouterIssueTrackerService.test.ts`

**Interfaces:**
- Consumes: `RouterConnection` (Task 10), `IIssueTrackerService` / `IAgentEventTransport` / `AgentEventTransportConfig` from `cyrus-core`.
- Produces (used by Task 12):

```ts
class RouterIssueTrackerService implements IIssueTrackerService {
	constructor(connection: RouterConnection, workspaceId: string);
	// every interface method forwards as connection.rpc(name, [workspaceId, ...args])
	// EXCEPT createAgentActivity, which uses connection.bufferedRpc (survives router outages)
	downloadAttachment(url: string): Promise<{ base64: string; contentType: string }>; // extra method, not on the interface
	getPlatformType(): string; // "linear" — downstream trackerId checks must behave as Linear
	getPlatformMetadata(): Record<string, unknown>; // { transport: "router", workspaceId }
	createEventTransport(config: AgentEventTransportConfig): IAgentEventTransport; // returns RouterEventTransport(connection)
}

class RouterEventTransport implements IAgentEventTransport {
	constructor(connection: RouterConnection);
	register(): void; // no-op — no inbound HTTP on devices
	// re-emits connection "event" payloads as both "event" (AgentEvent) and, where the
	// payload translates, "message" — mirror how LinearEventTransport translates in its
	// webhook handler (reuse its translation helper if exported; otherwise emit "event" only
	// and note that router mode relies on the legacy event path like CLI mode does)
}
```

- [ ] **Step 1: Write failing tests**

With a stubbed connection (`{ rpc: vi.fn(async () => ({ id: "i1" })), bufferedRpc: vi.fn(async () => undefined) }` cast via `unknown`): (a) `fetchIssue("ABC-1")` calls `rpc("fetchIssue", ["ws-1", "ABC-1"])`; (b) `createAgentActivity(input)` calls `bufferedRpc` with the workspace prepended; (c) `getPlatformType()` returns `"linear"`; (d) `createEventTransport` returns an object whose `register()` does not throw and which re-emits a connection `"event"` as transport `"event"`. Type-level test: the file compiles with `const svc: IIssueTrackerService = new RouterIssueTrackerService(conn, "ws-1")` — this is the conformance gate; every interface method must exist with the right signature (write them all explicitly; ~27 one-line methods).

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement.** Every method body is one line: `return this.connection.rpc("<name>", [this.workspaceId, ...args]) as Promise<T>;`. Look at `IIssueTrackerService.ts` for the exact list (lines 167-815; the method list is enumerated in Task 5's `RPC_METHODS` minus `downloadAttachment`, plus `getPlatformType`/`getPlatformMetadata`/`createEventTransport` which are local).

- [ ] **Step 4: Run tests + typecheck** — PASS expected. Typecheck IS the conformance test for the interface.

- [ ] **Step 5: Commit**

```bash
git add packages/router-client
git commit -m "feat(router-client): issue tracker and event transport adapters over router rpc"
```

# Phase 4 — Integration

### Task 12: EdgeWorker `"router"` platform mode + config schema

**Files:**
- Modify: `packages/core/src/config-schemas.ts` — extend the `platform` enum with `"router"`; add top-level `router: z.object({ url: z.string(), deviceToken: z.string() }).optional()`
- Modify: `packages/edge-worker/src/ConfigManager.ts` — add `router` to the `loadConfigSafely()` merge and `globalKeys`
- Modify: `packages/edge-worker/src/EdgeWorker.ts` — construction branch (~line 526) and `initializeComponents()` (~line 741)
- Modify: `packages/edge-worker/src/AttachmentService.ts` — optional download delegate
- Modify: `packages/edge-worker/package.json` — add `cyrus-router-client@workspace:*`
- Test: `packages/edge-worker/test/router-platform.test.ts`

**Interfaces:**
- Consumes: `RouterConnection`, `RouterIssueTrackerService`, `RouterEventTransport` (Tasks 10-11).
- Produces: `EdgeWorkerConfig` accepts `platform: "router"` + `router: { url, deviceToken }`; EdgeWorker in router mode builds one shared `RouterConnection`, one `RouterIssueTrackerService` per repo workspace id, and wires the transport into `handleWebhook` exactly like the CLI branch.

- [ ] **Step 1: Write the failing test**

```ts
// packages/edge-worker/test/router-platform.test.ts — assert construction wiring only
import { describe, expect, it } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

describe("router platform", () => {
	it("constructs router-backed issue trackers for repo workspaces", () => {
		const worker = new EdgeWorker({
			platform: "router",
			router: { url: "ws://127.0.0.1:9", deviceToken: "tok" },
			cyrusHome: "/tmp/cyrus-router-test",
			repositories: [
				{
					id: "repo-1",
					name: "repo-1",
					repositoryPath: "/tmp/repo-1",
					workspaceBaseDir: "/tmp/ws",
					linearWorkspaceId: "ws-1",
					// ...copy the remaining required RepositoryConfig fields from an existing
					// EdgeWorker construction test fixture in packages/edge-worker/test
				},
			],
		} as never);
		expect(worker.getIssueTracker("ws-1")?.getPlatformType()).toBe("linear");
		expect(worker.getIssueTracker("ws-1")?.getPlatformMetadata().transport).toBe("router");
	});
});
```

(If `getIssueTracker` is private, use the existing test-access pattern in edge-worker tests — `grep -rn "issueTrackers" packages/edge-worker/test` for the established approach.)

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

Schema + ConfigManager first (both lists — see Global Constraints). Then in `EdgeWorker.ts`:

- Constructor: create the shared connection when `config.platform === "router"`:

```ts
		if (config.platform === "router") {
			if (!config.router) throw new Error("platform 'router' requires config.router { url, deviceToken }");
			this.routerConnection = new RouterConnection({
				url: config.router.url,
				deviceToken: config.router.deviceToken,
				stateDir: join(this.cyrusHome, "router-client"),
			});
		}
```

- Extend the tracker construction at line ~530 to a three-way branch: `"cli"` → existing; `"router"` → `new RouterIssueTrackerService(this.routerConnection, linearWorkspaceId)`; else Linear. Mirror the same in the per-repo fallback loop in `initializeComponents()` (line ~745).
- In `initializeComponents()`, add a router branch alongside the CLI one: create the transport from the first router tracker, subscribe `"event"` → `handleWebhook` and `"error"` → `handleError` (same shape as lines 775-798), call `this.routerConnection.connect()`, and log the connection URL. Report session terminal states: at the same place(s) the CLI/Linear paths mark a session finished (`grep -n "sessionEnded\|handleSessionCompleted\|terminal" packages/edge-worker/src/AgentSessionManager.ts` — the AgentSessionManager completion path), call `this.routerConnection?.sendSessionState(sessionId, state)` guarded by platform.
- `AttachmentService`: add constructor option `downloadDelegate?: (url: string) => Promise<{ base64: string; contentType: string }>`; in its download function (`grep -n "fetch\|download" packages/edge-worker/src/AttachmentService.ts`), use the delegate when set instead of the token-authenticated fetch. In router mode pass `(url) => routerTracker.downloadAttachment(url)`.
- Router mode must NOT start tunnels or register Linear webhook routes: the existing code paths gate these on config (`CLOUDFLARE_TOKEN`, linear transport setup at line 807+) — add `&& this.config.platform !== "router"` to the Linear transport setup condition.
- Router mode must NOT emit the token-authenticated official Linear MCP server into session MCP configs (devices have no app token; users install the Linear MCP locally with their own OAuth — spec "two planes"). In `McpConfigService` (constructed at `EdgeWorker.ts:589` with `getLinearTokenForWorkspace`), have router mode's `getLinearTokenForWorkspace` return `undefined` and verify `McpConfigService.buildMcpConfig` skips the Linear server entry when the token is absent (`grep -n "linear" packages/edge-worker/src/McpConfigService.ts`); add that guard if missing. cyrus-tools stays enabled — it is backed by the issue tracker interface, which router mode forwards over RPC.

- [ ] **Step 4: Run tests + typecheck** — `pnpm --filter cyrus-edge-worker test:run && pnpm typecheck` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core packages/edge-worker
git commit -m "feat(edge-worker): router platform mode behind existing adapter seams"
```

### Task 13: CLI — `cyrus router …` and `cyrus connect`

**Files:**
- Create: `apps/cli/src/commands/RouterCommand.ts`, `apps/cli/src/commands/ConnectCommand.ts` + colocated `.test.ts` files
- Modify: `apps/cli/src/app.ts` (register commands), `apps/cli/package.json` (dep `cyrus-router@workspace:*`)

**Interfaces:**
- Consumes: `RouterServer`, `RouterStore` (Task 9), config schema (Task 12).
- Produces: CLI surface —
  - `cyrus router start` — reads `~/.cyrus/router-config.json` (a JSON `RouterServerConfig` minus `dbPath`, which defaults to `~/.cyrus/router/router.db`), starts `RouterServer`.
  - `cyrus router users add <email> [--name <name>]` — `store.addUser` + `mintEnrollmentCode`, prints the code and expiry.
  - `cyrus router users list` / `users remove <email>` / `devices revoke <email>` / `unlock <issueId>`. `devices revoke` looks up the device id first and calls `store.releaseLocksAndAffinityForDevice(deviceId)` then `store.revokeDevice(email)` (spec: revocation releases the device's locks). `unlock` calls `store.getIssueLock(issueId)` and `releaseIssueLockForSession(lock.sessionId)`.
  - `cyrus connect <url> --code <code>` — POSTs `{code}` to `<httpUrl>/enroll`, then writes `platform: "router"` and `router: { url, deviceToken }` into `~/.cyrus/config.json` (0600) and prints next steps (`cyrus start`). `<url>` may be `https://…`; derive `wss://…` for the config and keep https for the enroll POST.
- Admin subcommands open `RouterStore` directly on the db path; Task 6's WAL pragma makes this safe while the server holds the db open.

- [ ] **Step 1: Write failing tests** — for `ConnectCommand`: stub `fetch` (vitest `vi.stubGlobal`) returning `{ deviceToken: "tok" }`, run against a temp cyrus-home, assert the config file gains `platform: "router"` and the token with mode 0600. For `RouterCommand users add`: temp db path, assert a code is printed (capture stdout) and `store.listUsers()` shows the user.
- [ ] **Step 2: Run to verify failure** — FAIL.
- [ ] **Step 3: Implement.** Follow the command registration pattern that `apps/cli/src/app.ts` uses for existing commands (see the `billing`/`add-repository` registrations near line 140-166); reuse `Application` for cyrus-home/env resolution like the removed users command did.
- [ ] **Step 4: Run tests + typecheck** — `pnpm --filter cyrus-ai test:run && pnpm --filter cyrus-ai typecheck` → PASS.
- [ ] **Step 5: Commit**

```bash
git add apps/cli
git commit -m "feat(cli): cyrus router server commands and cyrus connect device enrollment"
```

### Task 14: GitService worktree continuity

**Files:**
- Modify: `packages/edge-worker/src/GitService.ts` (`createSingleRepoWorktree` start-point resolution; new helpers)
- Modify: `packages/edge-worker/src/EdgeWorker.ts:3398-3435` (terminal-state cleanup — push WIP before teardown/removal)
- Test: `packages/edge-worker/test/GitService.continuity.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `GitService.remoteBranchExists(repoPath: string, branchName: string): boolean`; `GitService.pushWipIfDirty(worktreePath: string, branchName: string): Promise<boolean>` (returns true when a WIP commit was pushed).

- [ ] **Step 1: Write failing tests using real temp git repos**

```ts
// packages/edge-worker/test/GitService.continuity.test.ts
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitService } from "../src/GitService.js";

function makeOriginAndClone() {
	const dir = mkdtempSync(join(tmpdir(), "cyrus-git-"));
	const origin = join(dir, "origin.git");
	const clone = join(dir, "clone");
	execSync(`git init --bare ${origin} -b main`);
	execSync(`git clone ${origin} ${clone}`);
	execSync(`git -C ${clone} -c user.email=t@t -c user.name=t commit --allow-empty -m init`);
	execSync(`git -C ${clone} push origin main`);
	return { origin, clone };
}

describe("worktree continuity", () => {
	it("remoteBranchExists is true only for pushed branches", () => {
		const { clone } = makeOriginAndClone();
		const svc = new GitService(console as never); // match the ctor used in existing GitService tests
		expect(svc.remoteBranchExists(clone, "main")).toBe(true);
		expect(svc.remoteBranchExists(clone, "nope-branch")).toBe(false);
	});

	it("pushWipIfDirty commits and pushes dirty state to the branch", async () => {
		const { origin, clone } = makeOriginAndClone();
		execSync(`git -C ${clone} checkout -b ISS-1`);
		execSync(`echo wip > ${join(clone, "file.txt")}`);
		const svc = new GitService(console as never);
		expect(await svc.pushWipIfDirty(clone, "ISS-1")).toBe(true);
		const remoteBranches = execSync(`git -C ${origin} branch`).toString();
		expect(remoteBranches).toContain("ISS-1");
	});

	it("pushWipIfDirty is a no-op on a clean tree", async () => {
		const { clone } = makeOriginAndClone();
		const svc = new GitService(console as never);
		expect(await svc.pushWipIfDirty(clone, "main")).toBe(false);
	});
});
```

- [ ] **Step 2: Run to verify failure** — FAIL.

- [ ] **Step 3: Implement**

```ts
	/** True when origin has a branch of this name (worktree continuity across devices). */
	remoteBranchExists(repoPath: string, branchName: string): boolean {
		try {
			const out = execSync(
				`git ls-remote --heads origin ${JSON.stringify(branchName)}`,
				{ cwd: repoPath, encoding: "utf-8", timeout: 30_000 },
			);
			return out.trim().length > 0;
		} catch {
			return false;
		}
	}

	/** Commit-and-push dirty worktree state so another device can resume this issue. */
	async pushWipIfDirty(worktreePath: string, branchName: string): Promise<boolean> {
		const status = execSync("git status --porcelain", {
			cwd: worktreePath, encoding: "utf-8",
		});
		if (status.trim().length === 0) return false;
		execSync("git add -A", { cwd: worktreePath });
		execSync(
			'git -c user.email=cyrus@localhost -c user.name="Cyrus WIP" commit -m "wip: auto-saved by cyrus before session end"',
			{ cwd: worktreePath },
		);
		execSync(`git push origin HEAD:${JSON.stringify(branchName)}`, {
			cwd: worktreePath, timeout: 60_000,
		});
		return true;
	}
```

Then in `createSingleRepoWorktree` (body follows line 689): find where the start point is chosen (the code that resolves the base branch and runs `git worktree add`; `grep -n "worktree add" packages/edge-worker/src/GitService.ts`). Immediately before that resolution, insert: if no explicit `baseBranchOverride` was provided AND `remoteBranchExists(repoPath, branchName)` (the sanitized issue branch name computed earlier in the same function), use `origin/<branchName>` as the start point and log `Resuming issue branch origin/<branchName> from remote (worktree continuity)`. An explicit override always wins.

Then in `EdgeWorker.ts` terminal-state cleanup (the path at 3398-3435 that runs `cyrus-teardown` before worktree removal): before teardown/removal, for each repo worktree of the issue call `await this.gitService.pushWipIfDirty(worktreePath, branchName)` in a try/catch that logs a warning on failure (push failure must not block cleanup). Derive `worktreePath`/`branchName` from the same variables that cleanup path already uses for removal.

- [ ] **Step 4: Run tests + typecheck** — `pnpm --filter cyrus-edge-worker test:run && pnpm --filter cyrus-edge-worker typecheck` → PASS (existing worktree tests must stay green — the new preference only activates when the remote branch exists, which existing fixtures don't create).

- [ ] **Step 5: Commit**

```bash
git add packages/edge-worker
git commit -m "feat(edge-worker): base worktrees on pushed issue branches and push WIP on teardown"
```

### Task 15: End-to-end test, F1 validation, docs, changelog

**Files:**
- Create: `packages/router/test/e2e.test.ts`
- Create: `docs/ROUTER.md`
- Modify: `CHANGELOG.md`, `CHANGELOG.internal.md`
- Modify: `packages/router/src/RouterServer.ts` — expose `readonly eventRouter` for the test hook if not already public

**Interfaces:**
- Consumes: everything.
- Produces: proof the spec's flows work in-process, plus user-facing docs.

- [ ] **Step 1: Write the e2e test (in-process router + real client over localhost)**

Scenario, all in one vitest file with `RouterServer` on port 0 and `trackerFactory: () => new CLIIssueTrackerService()`:
1. **Enrollment**: mint code via `server.store`, POST `/enroll`, get token.
2. **Routed delivery**: build a `RouterConnection` + `RouterEventTransport` with the token; feed an `agentSessionCreated` fixture (creator = enrolled email) to `server.eventRouter.route(...)`; assert the transport emits it and the queue drains (ack observed via `store.pendingEvents` → empty).
3. **Offline queue + notice**: `connection.close()`; route a second created event (different session/issue); assert it stays queued and the CLI tracker recorded a "Waiting for" activity (`CLIIssueTrackerService` exposes stored activities — find the accessor used by F1 assertions, `grep -n "activities" packages/core/src/issue-tracker/adapters/CLIIssueTrackerService.ts`). Reconnect; assert delivery + drain.
4. **Issue lock**: route a created event for the same issue as an active session but a new session id → assert a rejection activity and empty queue delta.
5. **Creator-only prompting**: route a prompted fixture with a different actor → rejection activity, no delivery.
6. **RPC round-trip + authorization**: through `RouterIssueTrackerService`, `fetchIssue` on a seeded CLI issue succeeds; `createAgentActivity` against a session owned by the device succeeds; against an unowned session id rejects.

- [ ] **Step 2: Run it, implement fixes until green** — `pnpm --filter cyrus-router test:run`. This is the integration gate; expect to shake out wiring bugs here.

- [ ] **Step 3: Write `docs/ROUTER.md`** — sibling to `docs/SELF_HOSTING.md`: what router mode is, admin setup (`router-config.json`, `cyrus router start`, `users add`), device setup (`cyrus connect`, Linear MCP note: install the official Linear MCP locally for user-attributed agent tool use), offline/queue semantics, issue lock + creator-only prompting defaults, worktree continuity rules.

- [ ] **Step 4: Changelogs** — `CHANGELOG.md` `### Added`: "Router mode: run `cyrus router start` on an always-on host and `cyrus connect` on each team member's machine — sessions run on the creator's own device with its native credentials (az, gh, SSH, Claude subscription). Includes offline queueing, per-issue locks, and creator-only prompting."; "Worktrees now resume from the issue's pushed branch when one exists, and uncommitted work is auto-pushed as WIP before a worktree is removed." `CHANGELOG.internal.md`: new packages + boundary invariant note.

- [ ] **Step 5: Full verification + commit**

Run: `pnpm typecheck && pnpm test:packages:run && pnpm build`
Expected: all PASS.

```bash
git add -A
git commit -m "feat(router): e2e coverage, self-host docs, and changelog for router mode"
```

- [ ] **Step 6: F1 test drive (manual validation gate, per repo CLAUDE.md mandate)**

Using the f1-test-drive protocol: start an F1 server (`platform: "cli"` per `apps/f1/CLAUDE.md`) for baseline regression of single-user mode, then a router-mode smoke: `cyrus router start` with a CLI-tracker `trackerFactory` build or a scratch Linear workspace, one enrolled device, one delegated issue end-to-end (session runs on the device, activities appear, lock blocks a second session, disconnect mid-run queues a prompt and delivers on reconnect). Record findings in `apps/f1/test-drives/`.

---

## Deferred (explicitly out of this plan, per spec)

- Hybrid fallback executor for offline users; multi-workspace-per-router beyond the `workspaces` map; router HA; live worktree sync; `session_state` reporting from parked (non-terminal) states.


