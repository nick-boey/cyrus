# Per-User Session Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a Linear user starts an agent session, the session (and every child process it spawns, including the Codex CLI) runs with that user's Claude, Codex, and GitHub credentials; unregistered users are blocked with instructions.

**Architecture:** A `users[]` registry in `config.json` maps Linear identities to per-user credential directories (`~/.cyrus/users/<slug>/`). A new `UserCredentialResolver` in edge-worker turns the session creator (already parsed from every AgentSession webhook) into an env bundle that `RunnerConfigBuilder` injects into the session via `additionalEnv` / `codexHome`. The creator is stored on `CyrusAgentSession` at creation so resumed sessions keep the creator's credentials without parameter threading. Spec: `docs/superpowers/specs/2026-07-07-multi-user-credentials-design.md`.

**Tech Stack:** TypeScript, Zod (config schemas), Vitest, dotenv, commander + node:readline/promises (CLI).

## Post-review revisions (2026-07-08)

A Codex GPT-5.5 adversarial review (verified against the codebase) amended this plan;
spec §13 records the rationale. Deltas from the tasks as originally written:

- **Task 1** also creates `packages/core/src/credential-env.ts` (credential env-key
  groups + `scrubCredentialEnv`) and adds all new schema/type names to the **explicit**
  export lists in `packages/core/src/index.ts` / `config-types.ts`.
- **Task 2** also adds `users`/`gitCommitAuthor` to the `EdgeWorkerConfig` construction
  in `apps/cli/src/services/WorkerService.ts` (explicit whitelist — fields dropped at
  boot otherwise).
- **Task 3** resolver warns when multiple registry entries match one creator.
- **Task 4** replaces `scrubGlobalAuthKeys` with group-based scrubbing driven by a new
  `ClaudeRunnerConfig.credentialIsolation` flag (scrubs Claude auth + OpenAI + GitHub +
  git-author groups, applied over base+repositoryEnv), and redacts credential keys in
  `serializeQueryOptionsReplacer` (local debug logs previously serialized full env).
- **New Task 5 (codex-runner):** `CodexRunnerConfig` gains `additionalEnv` +
  `credentialIsolation`; `buildEnvOverride` merges/scrubs; `resolveModelWithFallback`
  skips the global-API-key probe under isolation; `hasCodexSubscription` runs
  `codex login status` with the resolved `CODEX_HOME`.
- **Task 6 (was 5)** also propagates `credentialIsolation` to Claude and Codex configs.
- **Task 7 (was 6+7)** threads `creator` through `initializeAgentRunner` (first param
  `agentSession` is available on all four entry paths: created flow, parked auto-wake,
  parked reprompt, selection response); moves the webhook gates to the **top** of both
  handlers (after the stop-signal branch); and adds a **fail-closed backstop** in
  `buildAgentRunnerConfig` — Linear session + multi-user mode + no resolvable profile →
  post registration message + throw. Pre-feature sessions without a stored creator
  therefore block instead of falling back to global credentials.
- **Task 8 (was CLI task)** hardening: `chmod` dirs/files on every run, `0600` on the
  copied Codex `auth.json`, credential files written **before** the config entry,
  duplicate-registration validation.
- **New Task 9 (F1):** synthetic agent-session webhooks in `CLIIssueTrackerService`
  carry a `creator` so F1 can validate creator-based routing.

Not adopted (spec-accepted risks reaffirmed by the product owner): sandbox-off
cross-user reads, Codex `auth.json` refresh races, mandatory per-user GitHub PATs.

## Global Constraints

- Spec decisions: block unregistered users with a Linear message; env injection only (no containers); registry covers Claude + Codex + GitHub; commit authorship configurable via `gitCommitAuthor.mode` (`"user"` default, `"shared"` = global Cyrus identity); credentials follow the **session creator**, not the prompter.
- New top-level `EdgeWorkerConfig` fields MUST be added to BOTH `ConfigManager.loadConfigSafely()`'s merge and `detectGlobalConfigChanges()`'s `globalKeys` (CLAUDE.md gotcha #9).
- `credentialsDir` is path-bearing (`~/` prefix) and MUST go through `resolvePath` in `EdgeWorker.normalizeConfigPaths()` (CLAUDE.md gotcha #11).
- A per-user Claude credential must **replace**, not join, the global auth keys — `ANTHROPIC_API_KEY` in the base env would shadow an injected `CLAUDE_CODE_OAUTH_TOKEN` inside Claude Code.
- Secrets never go in `config.json`; they live in `<credentialsDir>/.env` (mode 600).
- Biome is the linter/formatter — run `pnpm lint` before each commit; tabs for indentation (match existing files).
- Repo convention: run `pnpm test:packages:run` and `pnpm typecheck` from the root before the final commit; F1 test-drive validation is mandatory for the final task.

---

### Task 1: Core config schemas + session creator type

**Files:**
- Modify: `packages/core/src/config-schemas.ts` (add schemas after `UserAccessControlConfigSchema`, add fields to `EdgeConfigSchema` at the end of the object, near `userAccessControl`)
- Modify: `packages/core/src/CyrusAgentSession.ts` (add `SessionCreator` + `creator` field)
- Test: `packages/core/test/config-schemas.users.test.ts`

**Interfaces:**
- Consumes: existing `UserIdentifierSchema` (`config-schemas.ts:16-20`).
- Produces (later tasks rely on these exact names):
  - `UserCredentialConfigSchema` / `type UserCredentialConfig = { linearUser: UserIdentifier; credentialsDir: string; gitAuthor?: { name: string; email: string } }`
  - `GitCommitAuthorConfigSchema` / `type GitCommitAuthorConfig = { mode: "user" | "shared"; shared?: { name: string; email: string } }`
  - `EdgeConfig.users?: UserCredentialConfig[]` and `EdgeConfig.gitCommitAuthor?: GitCommitAuthorConfig`
  - `interface SessionCreator { id?: string; email?: string; name?: string }` and `CyrusAgentSession.creator?: SessionCreator` (exported from `cyrus-core`)

- [ ] **Step 1: Write the failing test**

```typescript
// packages/core/test/config-schemas.users.test.ts
import { describe, expect, it } from "vitest";
import {
	EdgeConfigSchema,
	GitCommitAuthorConfigSchema,
	UserCredentialConfigSchema,
} from "../src/config-schemas.js";

describe("UserCredentialConfigSchema", () => {
	it("accepts an email-keyed user with a credentials dir", () => {
		const parsed = UserCredentialConfigSchema.parse({
			linearUser: { email: "alice@org.com" },
			credentialsDir: "~/.cyrus/users/alice",
			gitAuthor: { name: "Alice Example", email: "alice@org.com" },
		});
		expect(parsed.credentialsDir).toBe("~/.cyrus/users/alice");
	});

	it("accepts an id-keyed user without gitAuthor", () => {
		const parsed = UserCredentialConfigSchema.parse({
			linearUser: { id: "usr_abc123" },
			credentialsDir: "/home/x/.cyrus/users/bob",
		});
		expect(parsed.gitAuthor).toBeUndefined();
	});

	it("rejects a user without credentialsDir", () => {
		expect(() =>
			UserCredentialConfigSchema.parse({ linearUser: { email: "a@b.c" } }),
		).toThrow();
	});
});

describe("GitCommitAuthorConfigSchema", () => {
	it("accepts user mode without a shared author", () => {
		expect(GitCommitAuthorConfigSchema.parse({ mode: "user" }).mode).toBe(
			"user",
		);
	});

	it("accepts shared mode with a shared author", () => {
		const parsed = GitCommitAuthorConfigSchema.parse({
			mode: "shared",
			shared: { name: "Cyrus Agent", email: "cyrus@org.com" },
		});
		expect(parsed.shared?.name).toBe("Cyrus Agent");
	});

	it("rejects unknown modes", () => {
		expect(() => GitCommitAuthorConfigSchema.parse({ mode: "bot" })).toThrow();
	});
});

describe("EdgeConfigSchema users fields", () => {
	it("round-trips users and gitCommitAuthor", () => {
		const parsed = EdgeConfigSchema.parse({
			repositories: [],
			users: [
				{
					linearUser: { email: "alice@org.com" },
					credentialsDir: "~/.cyrus/users/alice",
				},
			],
			gitCommitAuthor: { mode: "user" },
		});
		expect(parsed.users).toHaveLength(1);
		expect(parsed.gitCommitAuthor?.mode).toBe("user");
	});

	it("keeps both fields optional", () => {
		const parsed = EdgeConfigSchema.parse({ repositories: [] });
		expect(parsed.users).toBeUndefined();
		expect(parsed.gitCommitAuthor).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/core && pnpm vitest run test/config-schemas.users.test.ts`
Expected: FAIL — `UserCredentialConfigSchema` is not exported.

- [ ] **Step 3: Add the schemas**

In `packages/core/src/config-schemas.ts`, directly after `UserAccessControlConfigSchema` (ends line ~53):

```typescript
/**
 * Git author identity (name + email) used for commit attribution.
 */
export const GitAuthorSchema = z.object({
	name: z.string(),
	email: z.string(),
});

/**
 * A registered user's credential profile for multi-user deployments.
 * Secrets are NOT stored here — they live in `<credentialsDir>/.env`
 * (CLAUDE_CODE_OAUTH_TOKEN, GH_TOKEN, ...) plus `<credentialsDir>/codex/`
 * (Codex CODEX_HOME with auth.json) and optionally `<credentialsDir>/claude/`
 * (per-user CLAUDE_CONFIG_DIR).
 */
export const UserCredentialConfigSchema = z.object({
	/** Linear identity this profile belongs to (id or email match). */
	linearUser: UserIdentifierSchema,
	/** Directory holding this user's credentials (supports `~/` prefix). */
	credentialsDir: z.string(),
	/** Commit author identity used when gitCommitAuthor.mode is "user". */
	gitAuthor: GitAuthorSchema.optional(),
});

/**
 * Controls commit AUTHORSHIP for multi-user sessions. Push/PR auth is
 * always the session user's PAT regardless of this setting.
 * - "user" (default): commits are authored as the registered user's gitAuthor.
 * - "shared": commits are authored as `shared` (a global "Cyrus agent"
 *   identity); when `shared` is omitted, no author env is injected and the
 *   host's global git config applies.
 */
export const GitCommitAuthorConfigSchema = z.object({
	mode: z.enum(["user", "shared"]),
	shared: GitAuthorSchema.optional(),
});
```

Then add the type exports next to the file's existing `z.infer` type exports (search for `export type` entries near the schemas — follow the same placement pattern as `UserAccessControlConfig`):

```typescript
export type GitAuthor = z.infer<typeof GitAuthorSchema>;
export type UserCredentialConfig = z.infer<typeof UserCredentialConfigSchema>;
export type GitCommitAuthorConfig = z.infer<typeof GitCommitAuthorConfigSchema>;
```

Then add the two fields to `EdgeConfigSchema`, right after the `userAccessControl` field (line ~481):

```typescript
	/**
	 * Multi-user credential profiles. When non-empty, Linear sessions run
	 * with the triggering user's credentials, and users without a profile
	 * are blocked with registration instructions.
	 */
	users: z.array(UserCredentialConfigSchema).optional(),

	/** Commit authorship policy for multi-user sessions (see schema docs). */
	gitCommitAuthor: GitCommitAuthorConfigSchema.optional(),
```

If the schema types are not re-exported automatically, add the three new type names to whichever barrel exports the existing `UserAccessControlConfig` (check `packages/core/src/index.ts`).

- [ ] **Step 4: Add SessionCreator to the session type**

In `packages/core/src/CyrusAgentSession.ts`, before `export interface CyrusAgentSession` (line ~70):

```typescript
/**
 * The tracker-side user who created the session (from
 * `webhook.agentSession.creator`). Used to resolve per-user credentials —
 * credentials follow the session creator, not later prompters.
 */
export interface SessionCreator {
	id?: string;
	email?: string;
	name?: string;
}
```

And inside `CyrusAgentSession`, after `workspace: Workspace;` (line ~91):

```typescript
	/** Linear user who created the session (set for Linear sessions only). */
	creator?: SessionCreator;
```

Export `SessionCreator` from the core barrel if `CyrusAgentSession` types are re-exported by name (check `packages/core/src/index.ts` for how `CyrusAgentSession` is exported; `export *` covers it automatically).

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/core && pnpm vitest run test/config-schemas.users.test.ts`
Expected: PASS (all 8 tests).

- [ ] **Step 6: Typecheck and commit**

```bash
cd packages/core && pnpm typecheck
git add packages/core/src/config-schemas.ts packages/core/src/CyrusAgentSession.ts packages/core/test/config-schemas.users.test.ts
git commit -m "feat(core): add users/gitCommitAuthor config schemas and session creator type"
```

---

### Task 2: ConfigManager hot-reload plumbing

**Files:**
- Modify: `packages/edge-worker/src/ConfigManager.ts:200-263` (merge) and `:339-363` (globalKeys)
- Test: `packages/edge-worker/test/ConfigManager.users-hot-reload.test.ts`

**Interfaces:**
- Consumes: `EdgeConfig.users` / `EdgeConfig.gitCommitAuthor` from Task 1 (they reach `EdgeWorkerConfig` via `EdgeWorkerConfig = EdgeConfig & EdgeWorkerRuntimeConfig`).
- Produces: `users` and `gitCommitAuthor` survive `loadConfigSafely()` and changes to either fire `configChanged`.

- [ ] **Step 1: Write the failing test**

Model on `packages/edge-worker/test/ConfigManager.pr-review-trigger.test.ts` (same mock setup — copy its imports, `baseConfig`, `makeManager`, and `beforeEach` verbatim), then:

```typescript
// packages/edge-worker/test/ConfigManager.users-hot-reload.test.ts
import { readFile } from "node:fs/promises";
import type { EdgeWorkerConfig, ILogger } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "../src/ConfigManager.js";

vi.mock("node:fs/promises");

/**
 * Ensure the multi-user fields participate in config hot-reload — both the
 * merge in loadConfigSafely() and detectGlobalConfigChanges(). Without these,
 * `users` written to config.json while Cyrus runs would be silently dropped
 * (see CLAUDE.md note #9).
 */
describe("ConfigManager - users/gitCommitAuthor hot-reload", () => {
	let logger: ILogger;

	const users = [
		{
			linearUser: { email: "alice@org.com" },
			credentialsDir: "/home/x/.cyrus/users/alice",
		},
	];

	const baseConfig: EdgeWorkerConfig = {
		proxyUrl: "http://localhost:3000",
		cyrusHome: "/tmp/cyrus-home",
		repositories: [
			{
				id: "repo-1",
				name: "Repo 1",
				repositoryPath: "/test/repo",
				baseBranch: "main",
				workspaceBaseDir: "/test/workspaces",
			},
		],
	} as unknown as EdgeWorkerConfig;

	function makeManager(config: EdgeWorkerConfig): ConfigManager {
		return new ConfigManager(
			config,
			logger,
			"/tmp/cyrus-home/config.json",
			new Map(config.repositories.map((r) => [r.id, r])),
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		} as unknown as ILogger;
	});

	it("merges users and gitCommitAuthor from the reloaded config file", async () => {
		const manager = makeManager(baseConfig);
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				repositories: baseConfig.repositories,
				users,
				gitCommitAuthor: { mode: "shared", shared: { name: "Cyrus", email: "c@o.com" } },
			}) as any,
		);

		const newConfig = await (manager as any).loadConfigSafely();
		expect(newConfig.users).toEqual(users);
		expect(newConfig.gitCommitAuthor?.mode).toBe("shared");
	});

	it("keeps in-memory users when the file omits them", async () => {
		const manager = makeManager({
			...baseConfig,
			users,
		} as unknown as EdgeWorkerConfig);
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({ repositories: baseConfig.repositories }) as any,
		);

		const newConfig = await (manager as any).loadConfigSafely();
		expect(newConfig.users).toEqual(users);
	});

	it("detects users changes as global config changes", () => {
		const manager = makeManager(baseConfig);
		const changed = (manager as any).detectGlobalConfigChanges({
			...baseConfig,
			users,
		});
		expect(changed).toBe(true);
	});

	it("detects gitCommitAuthor changes as global config changes", () => {
		const manager = makeManager(baseConfig);
		const changed = (manager as any).detectGlobalConfigChanges({
			...baseConfig,
			gitCommitAuthor: { mode: "shared" },
		});
		expect(changed).toBe(true);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/edge-worker && pnpm vitest run test/ConfigManager.users-hot-reload.test.ts`
Expected: FAIL — `newConfig.users` is `undefined`; `detectGlobalConfigChanges` returns `false`.

- [ ] **Step 3: Implement the merge and change detection**

In `loadConfigSafely()` (`ConfigManager.ts`), inside the `newConfig` object literal after the `sandbox:` line (~262):

```typescript
				// Multi-user credential profiles
				users: parsedConfig.users || this.config.users,
				gitCommitAuthor:
					parsedConfig.gitCommitAuthor || this.config.gitCommitAuthor,
```

In `detectGlobalConfigChanges()` (`ConfigManager.ts:339`), append to `globalKeys`:

```typescript
			"users",
			"gitCommitAuthor",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/edge-worker && pnpm vitest run test/ConfigManager.users-hot-reload.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/edge-worker/src/ConfigManager.ts packages/edge-worker/test/ConfigManager.users-hot-reload.test.ts
git commit -m "feat(edge-worker): plumb users/gitCommitAuthor through config hot-reload"
```

---

### Task 3: UserCredentialResolver

**Files:**
- Create: `packages/edge-worker/src/UserCredentialResolver.ts`
- Modify: `packages/edge-worker/src/UserAccessControl.ts:26` (export the private matcher)
- Modify: `packages/edge-worker/package.json` (add `"dotenv": "^16.5.0"` to `dependencies`)
- Test: `packages/edge-worker/test/UserCredentialResolver.test.ts`

**Interfaces:**
- Consumes: `UserCredentialConfig`, `GitCommitAuthorConfig`, `SessionCreator`, `ILogger` from `cyrus-core`; `userMatchesIdentifier` from `./UserAccessControl.js`.
- Produces (Tasks 6-7 rely on these exact signatures):
  - `class UserCredentialResolver { constructor(users: UserCredentialConfig[] | undefined, gitCommitAuthor: GitCommitAuthorConfig | undefined, logger: ILogger); setConfig(users, gitCommitAuthor): void; isEnabled(): boolean; resolve(creator: SessionCreator | undefined): UserCredentialProfile | null }`
  - `interface UserCredentialProfile { credentialsDir: string; env: Record<string, string> }`
  - `const DEFAULT_UNREGISTERED_USER_MESSAGE: string` (contains `{{userName}}`)

- [ ] **Step 1: Export the identifier matcher**

In `packages/edge-worker/src/UserAccessControl.ts:26`, change `function userMatchesIdentifier(` to `export function userMatchesIdentifier(`.

- [ ] **Step 2: Add dotenv to edge-worker**

In `packages/edge-worker/package.json` `dependencies`, add `"dotenv": "^16.5.0"` (same version as `apps/cli`), then run `pnpm install` from the repo root.

- [ ] **Step 3: Write the failing test**

```typescript
// packages/edge-worker/test/UserCredentialResolver.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UserCredentialResolver } from "../src/UserCredentialResolver.js";

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as unknown as ILogger;

describe("UserCredentialResolver", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cyrus-user-creds-"));
		writeFileSync(
			join(dir, ".env"),
			[
				"CLAUDE_CODE_OAUTH_TOKEN=claude-token-alice",
				"GH_TOKEN=gh-token-alice",
				"GITHUB_TOKEN=gh-token-alice",
				"UNRELATED_VAR=should-not-leak",
			].join("\n"),
		);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const aliceEntry = (overrides: Record<string, unknown> = {}) => ({
		linearUser: { email: "Alice@Org.com" },
		credentialsDir: dir,
		gitAuthor: { name: "Alice Example", email: "alice@org.com" },
		...overrides,
	});

	it("is disabled when no users are configured", () => {
		const r = new UserCredentialResolver(undefined, undefined, logger);
		expect(r.isEnabled()).toBe(false);
		expect(r.resolve({ email: "alice@org.com" })).toBeNull();
	});

	it("matches by email case-insensitively and builds the env bundle", () => {
		const r = new UserCredentialResolver([aliceEntry()], undefined, logger);
		const profile = r.resolve({ id: "usr_1", email: "alice@ORG.com" });
		expect(profile).not.toBeNull();
		expect(profile!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-token-alice");
		expect(profile!.env.GH_TOKEN).toBe("gh-token-alice");
		expect(profile!.env.GITHUB_TOKEN).toBe("gh-token-alice");
		expect(profile!.env.UNRELATED_VAR).toBeUndefined();
	});

	it("matches by explicit id", () => {
		const r = new UserCredentialResolver(
			[aliceEntry({ linearUser: { id: "usr_1" } })],
			undefined,
			logger,
		);
		expect(r.resolve({ id: "usr_1" })).not.toBeNull();
		expect(r.resolve({ id: "usr_2" })).toBeNull();
	});

	it("returns null for an unregistered creator or missing creator", () => {
		const r = new UserCredentialResolver([aliceEntry()], undefined, logger);
		expect(r.resolve({ email: "bob@org.com" })).toBeNull();
		expect(r.resolve(undefined)).toBeNull();
	});

	it("returns null (treat as unregistered) when the .env file is missing", () => {
		const emptyDir = mkdtempSync(join(tmpdir(), "cyrus-user-empty-"));
		const r = new UserCredentialResolver(
			[aliceEntry({ credentialsDir: emptyDir })],
			undefined,
			logger,
		);
		expect(r.resolve({ email: "alice@org.com" })).toBeNull();
		rmSync(emptyDir, { recursive: true, force: true });
	});

	it("sets CODEX_HOME and CLAUDE_CONFIG_DIR only when the dirs exist", () => {
		const r = new UserCredentialResolver([aliceEntry()], undefined, logger);
		expect(r.resolve({ email: "alice@org.com" })!.env.CODEX_HOME).toBeUndefined();

		mkdirSync(join(dir, "codex"));
		mkdirSync(join(dir, "claude"));
		const profile = r.resolve({ email: "alice@org.com" })!;
		expect(profile.env.CODEX_HOME).toBe(join(dir, "codex"));
		expect(profile.env.CLAUDE_CONFIG_DIR).toBe(join(dir, "claude"));
	});

	it("injects the user's git author identity in user mode (default)", () => {
		const r = new UserCredentialResolver([aliceEntry()], undefined, logger);
		const env = r.resolve({ email: "alice@org.com" })!.env;
		expect(env.GIT_AUTHOR_NAME).toBe("Alice Example");
		expect(env.GIT_AUTHOR_EMAIL).toBe("alice@org.com");
		expect(env.GIT_COMMITTER_NAME).toBe("Alice Example");
		expect(env.GIT_COMMITTER_EMAIL).toBe("alice@org.com");
	});

	it("omits git author env in user mode when the entry has no gitAuthor", () => {
		const r = new UserCredentialResolver(
			[aliceEntry({ gitAuthor: undefined })],
			undefined,
			logger,
		);
		expect(
			r.resolve({ email: "alice@org.com" })!.env.GIT_AUTHOR_NAME,
		).toBeUndefined();
	});

	it("injects the shared identity in shared mode", () => {
		const r = new UserCredentialResolver(
			[aliceEntry()],
			{ mode: "shared", shared: { name: "Cyrus Agent", email: "cyrus@org.com" } },
			logger,
		);
		const env = r.resolve({ email: "alice@org.com" })!.env;
		expect(env.GIT_AUTHOR_NAME).toBe("Cyrus Agent");
		expect(env.GIT_COMMITTER_EMAIL).toBe("cyrus@org.com");
	});

	it("omits git author env in shared mode without a shared author", () => {
		const r = new UserCredentialResolver(
			[aliceEntry()],
			{ mode: "shared" },
			logger,
		);
		expect(
			r.resolve({ email: "alice@org.com" })!.env.GIT_AUTHOR_NAME,
		).toBeUndefined();
	});

	it("setConfig replaces the registry", () => {
		const r = new UserCredentialResolver(undefined, undefined, logger);
		expect(r.isEnabled()).toBe(false);
		r.setConfig([aliceEntry()], undefined);
		expect(r.isEnabled()).toBe(true);
	});
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd packages/edge-worker && pnpm vitest run test/UserCredentialResolver.test.ts`
Expected: FAIL — module `../src/UserCredentialResolver.js` not found.

- [ ] **Step 5: Implement the resolver**

```typescript
// packages/edge-worker/src/UserCredentialResolver.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	GitCommitAuthorConfig,
	ILogger,
	SessionCreator,
	UserCredentialConfig,
} from "cyrus-core";
import dotenv from "dotenv";
import { userMatchesIdentifier } from "./UserAccessControl.js";

/**
 * Credential env keys read from a user's `<credentialsDir>/.env`.
 * Anything else in that file is intentionally ignored so a stray var
 * can't silently alter session behavior.
 */
const CREDENTIAL_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"ANTHROPIC_AUTH_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
] as const;

/** Message posted when an unregistered user starts/prompts a session. */
export const DEFAULT_UNREGISTERED_USER_MESSAGE =
	"{{userName}}, you don't have credentials registered with this Cyrus deployment, so I can't run this session as you. Ask your Cyrus admin to run `cyrus users add` on the host to register your Claude, Codex, and GitHub credentials.";

export interface UserCredentialProfile {
	credentialsDir: string;
	/** Env vars to inject into the session subprocess (and its children). */
	env: Record<string, string>;
}

/**
 * Resolves the Linear session creator to a per-user credential env bundle.
 *
 * When `users` is non-empty ("multi-user mode"), Linear sessions run with
 * the creator's credentials; a creator with no profile (or a profile whose
 * `.env` is missing) is treated as unregistered and must be blocked by the
 * caller. Credentials follow the session creator, not later prompters.
 */
export class UserCredentialResolver {
	private users: UserCredentialConfig[] | undefined;
	private gitCommitAuthor: GitCommitAuthorConfig | undefined;
	private logger: ILogger;

	constructor(
		users: UserCredentialConfig[] | undefined,
		gitCommitAuthor: GitCommitAuthorConfig | undefined,
		logger: ILogger,
	) {
		this.users = users;
		this.gitCommitAuthor = gitCommitAuthor;
		this.logger = logger;
	}

	/** Replace the registry on config hot-reload. */
	setConfig(
		users: UserCredentialConfig[] | undefined,
		gitCommitAuthor: GitCommitAuthorConfig | undefined,
	): void {
		this.users = users;
		this.gitCommitAuthor = gitCommitAuthor;
	}

	/** Multi-user mode is on whenever at least one user is registered. */
	isEnabled(): boolean {
		return (this.users?.length ?? 0) > 0;
	}

	/**
	 * Resolve a session creator to their credential profile.
	 * Returns null when multi-user mode is off, the creator is unknown,
	 * or the profile's `.env` file is unreadable (treated as unregistered).
	 */
	resolve(creator: SessionCreator | undefined): UserCredentialProfile | null {
		if (!this.isEnabled() || !creator) {
			return null;
		}

		const entry = this.users!.find((u) =>
			userMatchesIdentifier(creator.id, creator.email, u.linearUser),
		);
		if (!entry) {
			return null;
		}

		const envPath = join(entry.credentialsDir, ".env");
		if (!existsSync(envPath)) {
			this.logger.warn(
				`User credential profile matched for ${creator.email ?? creator.id} but ${envPath} is missing — treating as unregistered`,
			);
			return null;
		}

		let parsed: Record<string, string>;
		try {
			parsed = dotenv.parse(readFileSync(envPath, "utf8"));
		} catch (error) {
			this.logger.warn(`Failed to read ${envPath}:`, error);
			return null;
		}

		const env: Record<string, string> = {};
		for (const key of CREDENTIAL_ENV_KEYS) {
			if (parsed[key]) {
				env[key] = parsed[key];
			}
		}

		const codexHome = join(entry.credentialsDir, "codex");
		if (existsSync(codexHome)) {
			env.CODEX_HOME = codexHome;
		}
		const claudeConfigDir = join(entry.credentialsDir, "claude");
		if (existsSync(claudeConfigDir)) {
			env.CLAUDE_CONFIG_DIR = claudeConfigDir;
		}

		const mode = this.gitCommitAuthor?.mode ?? "user";
		const author =
			mode === "user" ? entry.gitAuthor : this.gitCommitAuthor?.shared;
		if (author) {
			env.GIT_AUTHOR_NAME = author.name;
			env.GIT_AUTHOR_EMAIL = author.email;
			env.GIT_COMMITTER_NAME = author.name;
			env.GIT_COMMITTER_EMAIL = author.email;
		}

		return { credentialsDir: entry.credentialsDir, env };
	}
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd packages/edge-worker && pnpm vitest run test/UserCredentialResolver.test.ts`
Expected: PASS (11 tests). Also run `pnpm vitest run test/UserAccessControl.test.ts` — the export change must not break it.

- [ ] **Step 7: Commit**

```bash
git add packages/edge-worker/src/UserCredentialResolver.ts packages/edge-worker/src/UserAccessControl.ts packages/edge-worker/package.json pnpm-lock.yaml packages/edge-worker/test/UserCredentialResolver.test.ts
git commit -m "feat(edge-worker): add UserCredentialResolver for per-user credential profiles"
```

---

### Task 4: Global auth-key override in claude-runner

**Files:**
- Modify: `packages/claude-runner/src/session-env.ts` (export keys + new helper)
- Modify: `packages/claude-runner/src/ClaudeRunner.ts:670-683` (env merge)
- Test: `packages/claude-runner/test/session-env.auth-override.test.ts`

**Interfaces:**
- Produces: `export const AUTH_ENV_KEYS`, `export function scrubGlobalAuthKeys(base: Record<string, string>, override: Record<string, string> | undefined): Record<string, string>` — removes ALL auth keys from `base` iff `override` defines at least one auth key. Task 6's injected `additionalEnv` relies on this so a global `ANTHROPIC_API_KEY` cannot shadow a per-user `CLAUDE_CODE_OAUTH_TOKEN`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/claude-runner/test/session-env.auth-override.test.ts
import { describe, expect, it } from "vitest";
import { scrubGlobalAuthKeys } from "../src/session-env.js";

describe("scrubGlobalAuthKeys", () => {
	const base = {
		ANTHROPIC_API_KEY: "global-api-key",
		CLAUDE_CODE_OAUTH_TOKEN: "global-oauth",
		PATH: "/usr/bin",
		HOME: "/home/host",
	};

	it("removes all global auth keys when the override provides one", () => {
		const result = scrubGlobalAuthKeys(base, {
			CLAUDE_CODE_OAUTH_TOKEN: "user-oauth",
		});
		expect(result.ANTHROPIC_API_KEY).toBeUndefined();
		expect(result.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(result.PATH).toBe("/usr/bin");
		expect(result.HOME).toBe("/home/host");
	});

	it("returns base untouched when the override has no auth keys", () => {
		const result = scrubGlobalAuthKeys(base, { GH_TOKEN: "user-pat" });
		expect(result.ANTHROPIC_API_KEY).toBe("global-api-key");
	});

	it("returns base untouched when there is no override", () => {
		expect(scrubGlobalAuthKeys(base, undefined)).toEqual(base);
	});

	it("does not mutate the input object", () => {
		scrubGlobalAuthKeys(base, { ANTHROPIC_API_KEY: "user-key" });
		expect(base.ANTHROPIC_API_KEY).toBe("global-api-key");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/claude-runner && pnpm vitest run test/session-env.auth-override.test.ts`
Expected: FAIL — `scrubGlobalAuthKeys` is not exported.

- [ ] **Step 3: Implement**

In `packages/claude-runner/src/session-env.ts`, change `const AUTH_ENV_KEYS` (line 12) to `export const AUTH_ENV_KEYS`, and append at the end of the file:

```typescript
/**
 * When a per-user credential override supplies its own Claude auth key,
 * remove ALL globally-inherited auth keys from the base env before the
 * override is merged. Without this, a global ANTHROPIC_API_KEY inherited
 * from process.env would take precedence inside Claude Code and silently
 * shadow the injected per-user CLAUDE_CODE_OAUTH_TOKEN (object-spread
 * merges can add keys but never delete them).
 */
export function scrubGlobalAuthKeys(
	base: Record<string, string>,
	override: Record<string, string> | undefined,
): Record<string, string> {
	if (!override || !AUTH_ENV_KEYS.some((key) => override[key])) {
		return base;
	}
	const scrubbed = { ...base };
	for (const key of AUTH_ENV_KEYS) {
		delete scrubbed[key];
	}
	return scrubbed;
}
```

In `packages/claude-runner/src/ClaudeRunner.ts` (env merge at ~670): import `scrubGlobalAuthKeys` from `./session-env.js` alongside the existing `buildBaseSessionEnv` import, and change

```typescript
				env: {
					...buildBaseSessionEnv(),
```

to

```typescript
				env: {
					// Per-user auth (additionalEnv) must fully replace global auth —
					// see scrubGlobalAuthKeys docs.
					...scrubGlobalAuthKeys(buildBaseSessionEnv(), this.config.additionalEnv),
```

(leave the `...this.repositoryEnv, ...this.config.additionalEnv` lines that follow unchanged).

- [ ] **Step 4: Run tests to verify**

Run: `cd packages/claude-runner && pnpm vitest run test/session-env.auth-override.test.ts test/env-isolation.test.ts test/ClaudeRunner.test.ts`
Expected: new test PASSES; existing env tests still PASS (no override in their configs → behavior unchanged).

- [ ] **Step 5: Commit**

```bash
git add packages/claude-runner/src/session-env.ts packages/claude-runner/src/ClaudeRunner.ts packages/claude-runner/test/session-env.auth-override.test.ts
git commit -m "feat(claude-runner): scrub global auth keys when per-user auth is injected"
```

---

### Task 5: RunnerConfigBuilder userEnv injection

**Files:**
- Modify: `packages/edge-worker/src/RunnerConfigBuilder.ts` (`IssueRunnerConfigInput` interface ~line 161; `buildIssueConfig` after the codex-sandbox block ~line 476)
- Test: `packages/edge-worker/test/RunnerConfigBuilder.user-env.test.ts`

**Interfaces:**
- Consumes: `UserCredentialProfile.env` shape from Task 3 (passed in as plain `Record<string, string>`).
- Produces: `IssueRunnerConfigInput.userEnv?: Record<string, string>`. When set: merged into `config.additionalEnv` (user keys win over CA-cert keys), and `config.codexHome` set from `userEnv.CODEX_HOME` for codex-primary sessions. Task 6 passes this field.

- [ ] **Step 1: Write the failing test**

Fixtures copied from `RunnerConfigBuilder.codex-sandbox.test.ts` (same mock trio), parameterized by runner type:

```typescript
// packages/edge-worker/test/RunnerConfigBuilder.user-env.test.ts
import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeBuilder(runnerType: "claude" | "codex"): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType }),
		getDefaultModelForRunner: () => "model-x",
		getDefaultFallbackModelForRunner: () => "model-y",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function buildConfig(
	runnerType: "claude" | "codex",
	extras: Record<string, unknown> = {},
) {
	const { config } = makeBuilder(runnerType).buildIssueConfig({
		session: {
			issueId: "issue-1",
			issue: { identifier: "ABC-1" },
			workspace: { path: "/ws/root", isGitWorktree: true },
		} as unknown as CyrusAgentSession,
		repository: {
			id: "repo-a",
			name: "Repo A",
			repositoryPath: "/repos/repo-a",
			allowedTools: [],
		} as unknown as RepositoryConfig,
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/ws/root"],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
		...extras,
	});
	return config as {
		additionalEnv?: Record<string, string>;
		codexHome?: string;
	};
}

const userEnv = {
	CLAUDE_CODE_OAUTH_TOKEN: "user-oauth",
	GH_TOKEN: "user-pat",
	CODEX_HOME: "/home/x/.cyrus/users/alice/codex",
	GIT_AUTHOR_NAME: "Alice",
};

describe("RunnerConfigBuilder per-user env injection", () => {
	it("merges userEnv into additionalEnv for Claude sessions", () => {
		const config = buildConfig("claude", { userEnv });
		expect(config.additionalEnv).toMatchObject(userEnv);
	});

	it("preserves CA-cert env vars when both sandbox and userEnv are set", () => {
		const config = buildConfig("claude", {
			userEnv,
			sandboxSettings: { enabled: true },
			egressCaCertPath: "/certs/ca.pem",
		});
		expect(config.additionalEnv?.NODE_EXTRA_CA_CERTS).toBe("/certs/ca.pem");
		expect(config.additionalEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe("user-oauth");
	});

	it("sets codexHome for codex-primary sessions", () => {
		const config = buildConfig("codex", { userEnv });
		expect(config.codexHome).toBe("/home/x/.cyrus/users/alice/codex");
	});

	it("leaves configs untouched when userEnv is absent", () => {
		const config = buildConfig("claude", {});
		expect(config.additionalEnv).toBeUndefined();
		expect(config.codexHome).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/edge-worker && pnpm vitest run test/RunnerConfigBuilder.user-env.test.ts`
Expected: FAIL — `additionalEnv` undefined / `codexHome` undefined.

- [ ] **Step 3: Implement**

In `IssueRunnerConfigInput` (after `egressCaCertPath?: string;`, line ~160):

```typescript
	/**
	 * Per-user credential env bundle (multi-user mode) resolved from the
	 * session creator. Injected into the session subprocess env so child
	 * processes (gh, git, the Codex CLI) inherit the user's identity.
	 */
	userEnv?: Record<string, string>;
```

In `buildIssueConfig`, after the codex-sandbox block (ends line ~476) and before `if (input.resumeSessionId)`:

```typescript
		// Per-user credential env (multi-user mode). Merged AFTER
		// buildSandboxConfig's CA-cert additionalEnv so both survive; user
		// keys win on conflict. ClaudeRunner scrubs globally-inherited auth
		// keys when this bundle carries its own (see scrubGlobalAuthKeys).
		if (input.userEnv && Object.keys(input.userEnv).length > 0) {
			config.additionalEnv = {
				...(config.additionalEnv as Record<string, string> | undefined),
				...input.userEnv,
			};
			// Codex-as-primary reads auth from CODEX_HOME, not env injection.
			if (runnerType === "codex" && input.userEnv.CODEX_HOME) {
				config.codexHome = input.userEnv.CODEX_HOME;
			}
		}
```

- [ ] **Step 4: Run tests to verify**

Run: `cd packages/edge-worker && pnpm vitest run test/RunnerConfigBuilder.user-env.test.ts test/RunnerConfigBuilder.codex-sandbox.test.ts test/RunnerConfigBuilder.additional-directories.test.ts`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/edge-worker/src/RunnerConfigBuilder.ts packages/edge-worker/test/RunnerConfigBuilder.user-env.test.ts
git commit -m "feat(edge-worker): inject per-user credential env into issue runner configs"
```

---

### Task 6: EdgeWorker wiring — creator on sessions, resolver, path normalization

**Files:**
- Modify: `packages/edge-worker/src/EdgeWorker.ts` (multiple small edits, exact locations below)
- Modify: `packages/edge-worker/src/AgentSessionManager.ts:153-193` (`createCyrusAgentSession` signature)

No new unit test — this task is pure threading; behavior is covered by Task 3/5 units, the full existing edge-worker suite (must stay green), and Task 9's F1 drive.

**Interfaces:**
- Consumes: `UserCredentialResolver` (Task 3), `SessionCreator` (Task 1), `userEnv` input (Task 5).
- Produces: `CyrusAgentSession.creator` populated for Linear sessions; `EdgeWorker.userCredentialResolver` field (Task 7 uses it for blocking).

- [ ] **Step 1: Normalize `credentialsDir` paths**

In `EdgeWorker.normalizeConfigPaths()` (`EdgeWorker.ts:307-318`), add to the returned object after `githubMcpConfigs`:

```typescript
			users: config.users?.map((u) => ({
				...u,
				credentialsDir: resolvePath(u.credentialsDir),
			})),
```

(`resolvePath` is already imported — it's used on line 311.)

- [ ] **Step 2: Construct the resolver**

Import at the top of `EdgeWorker.ts`: `import { DEFAULT_UNREGISTERED_USER_MESSAGE, UserCredentialResolver } from "./UserCredentialResolver.js";`

Add the field next to `private userAccessControl: UserAccessControl;` (line ~237):

```typescript
	private userCredentialResolver: UserCredentialResolver;
```

In the constructor, immediately after `this.userAccessControl = new UserAccessControl(...)` (lines 554-557):

```typescript
		// Per-user credential profiles (multi-user mode). Uses this.config so
		// credentialsDir paths are already ~-normalized.
		this.userCredentialResolver = new UserCredentialResolver(
			this.config.users,
			this.config.gitCommitAuthor,
			this.logger,
		);
```

- [ ] **Step 3: Hot-reload wiring**

In the `configChanged` handler, after `this.toolPermissionResolver.setConfig(changes.newConfig);` (line ~652):

```typescript
			this.userCredentialResolver.setConfig(
				this.config.users,
				this.config.gitCommitAuthor,
			);
```

(Use `this.config`, not `changes.newConfig` — line 649 has already assigned the normalized config to `this.config`.)

- [ ] **Step 4: Store the creator on Linear sessions**

a. `packages/edge-worker/src/AgentSessionManager.ts` — add a trailing optional param to `createCyrusAgentSession` (line 153):

```typescript
	createCyrusAgentSession(
		sessionId: string,
		issueId: string,
		issueMinimal: IssueMinimal,
		workspace: Workspace,
		platform: "linear" | "github" | "gitlab" | "slack" = "linear",
		repositories: RepositoryContext[] = [],
		creator?: SessionCreator,
	): CyrusAgentSession {
```

Import `SessionCreator` from `cyrus-core` (add to the existing type-import list). In the `agentSession` object literal (after `workspace: workspace,`, line 185), add:

```typescript
			creator,
```

b. `EdgeWorker.ts` — the private `createCyrusAgentSession` (line 4048) gains a trailing param `creator?: SessionCreator` (import `SessionCreator` from `cyrus-core`), and forwards it as the seventh argument of the `agentSessionManager.createCyrusAgentSession(...)` call at line 4116:

```typescript
		agentSessionManager.createCyrusAgentSession(
			sessionId,
			issue.id,
			issueMinimal,
			workspace,
			"linear",
			repositoryContexts,
			creator,
		);
```

c. Update the two Linear call sites of the private method:
- `EdgeWorker.ts:4451` (created-webhook flow): append `webhook.agentSession.creator` as the final argument.
- `EdgeWorker.ts:4870` (parked-session resume): this block resumes from a stored `parkedSessions` entry whose `agentSession` field is the original webhook's agent session — append `agentSession.creator` (use the local variable holding the parked `agentSession`).

The GitHub/GitLab call sites of the *manager's* method (`EdgeWorker.ts:1458, 2133`) are untouched — trailing optional param defaults to `undefined`.

Note: persisted pre-feature sessions have no `creator`; they resolve to no profile and keep today's global-env behavior. New sessions always carry it.

- [ ] **Step 5: Resolve and pass userEnv in buildAgentRunnerConfig**

In `buildAgentRunnerConfig` (`EdgeWorker.ts:6426`), before the `this.runnerConfigBuilder.buildIssueConfig({...})` call (line 6466):

```typescript
		// Multi-user mode: resolve the session creator's credential profile.
		// Credentials follow the session creator (stored at creation), not
		// whoever sent the latest prompt.
		const userProfile = this.userCredentialResolver.resolve(session.creator);
		if (userProfile) {
			log.info(
				`Injecting per-user credentials for session creator (${session.creator?.email ?? session.creator?.id})`,
			);
		}
```

And inside the `buildIssueConfig({ ... })` input object, after `disallowedTools: input.disallowedTools`-adjacent fields (e.g. right after `maxTurns,`):

```typescript
			userEnv: userProfile?.env,
```

- [ ] **Step 6: Verify nothing regressed**

Run: `cd packages/edge-worker && pnpm vitest run && pnpm typecheck`
Expected: full edge-worker suite PASSES (threading is additive; no existing test constructs sessions with creators).

Also run: `cd packages/core && pnpm typecheck && cd ../../apps/cli && pnpm typecheck`

- [ ] **Step 7: Commit**

```bash
git add packages/edge-worker/src/EdgeWorker.ts packages/edge-worker/src/AgentSessionManager.ts
git commit -m "feat(edge-worker): thread session creator and resolve per-user credentials"
```

---

### Task 7: Block unregistered users + disable warm sessions

**Files:**
- Modify: `packages/edge-worker/src/EdgeWorker.ts` (new method near `handleBlockedUser` ~line 6631; two insertion points at 4314-4321 and 5170-5177; `isWarmSessionsEnabled` at 6698)

**Interfaces:**
- Consumes: `userCredentialResolver` field (Task 6), `DEFAULT_UNREGISTERED_USER_MESSAGE` (Task 3), existing `postActivityDirect` (same call shape as `handleBlockedUser`, line 6660).
- Produces: `private async checkUserCredentialsOrBlock(webhook): Promise<boolean>` — `true` = proceed.

- [ ] **Step 1: Add the check-or-block method**

After `handleBlockedUser` (ends line ~6671):

```typescript
	/**
	 * Multi-user mode gate: when user credential profiles are configured,
	 * the webhook creator must resolve to a registered profile. Unregistered
	 * users get a response activity with registration instructions and the
	 * session does not start. Fails closed when the webhook carries no
	 * creator. Returns true when the session may proceed.
	 */
	private async checkUserCredentialsOrBlock(
		webhook: AgentSessionCreatedWebhook | AgentSessionPromptedWebhook,
	): Promise<boolean> {
		if (!this.userCredentialResolver.isEnabled()) {
			return true;
		}
		const creator = webhook.agentSession.creator;
		if (this.userCredentialResolver.resolve(creator ?? undefined)) {
			return true;
		}

		const userName = creator?.name || "Hi there";
		this.logger.info(
			`Blocking session for unregistered user ${creator?.email ?? creator?.id ?? "(unknown)"}`,
		);
		const issueTracker = this.issueTrackers.get(webhook.organizationId);
		if (issueTracker) {
			await this.postActivityDirect(
				issueTracker,
				{
					agentSessionId: webhook.agentSession.id,
					content: {
						type: "response",
						body: DEFAULT_UNREGISTERED_USER_MESSAGE.replace(
							/\{\{userName\}\}/g,
							userName,
						),
					},
				},
				"unregistered user message",
			);
		}
		return false;
	}
```

- [ ] **Step 2: Gate both Linear webhook handlers**

Immediately after the existing access-control block in the created handler (after line 4321's `return;` closes, i.e. following that `if` block):

```typescript
		// Multi-user mode: creator must have registered credentials
		if (!(await this.checkUserCredentialsOrBlock(webhook))) {
			return;
		}
```

Add the identical block after the prompted handler's access-control block (after line 5177), before `await this.handleNormalPromptedActivity(webhook, repositories);`.

- [ ] **Step 3: Disable warm sessions in multi-user mode**

In `isWarmSessionsEnabled()` (line 6698), at the top of the method body:

```typescript
		// Warm sessions pre-spawn Claude subprocesses with GLOBAL env before
		// the session creator is known — incompatible with per-user
		// credentials. Force-disabled in multi-user mode.
		if (this.userCredentialResolver?.isEnabled()) {
			return false;
		}
```

(The `?.` guards the one constructor call path where the field may not be assigned yet.)

- [ ] **Step 4: Verify**

Run: `cd packages/edge-worker && pnpm vitest run && pnpm typecheck`
Expected: full suite PASSES (no existing test configures `users`, so all gates are no-ops for them).

- [ ] **Step 5: Commit**

```bash
git add packages/edge-worker/src/EdgeWorker.ts
git commit -m "feat(edge-worker): block unregistered users and disable warm sessions in multi-user mode"
```

---

### Task 8: `cyrus users` CLI command

**Files:**
- Create: `apps/cli/src/commands/UsersCommand.ts`
- Modify: `apps/cli/src/app.ts` (register subcommands after `self-add-repo`, line ~165)
- Test: `apps/cli/src/commands/UsersCommand.test.ts`

**Interfaces:**
- Consumes: `this.app.config` (`ConfigService` with `load(): EdgeConfig` / `save(config): void`), `this.app.cyrusHome`, `BaseCommand` from `./ICommand.js`, `UserCredentialConfig` from Task 1.
- Produces: `cyrus users add | list | remove <email>`; exported pure helpers `slugForEmail(email: string, taken: Set<string>): string` and `buildUserEnvFile(input: { claudeToken?: string; githubPat?: string }): string` (unit-tested).

- [ ] **Step 1: Write the failing test (pure helpers)**

```typescript
// apps/cli/src/commands/UsersCommand.test.ts
import { describe, expect, it } from "vitest";
import { buildUserEnvFile, slugForEmail } from "./UsersCommand.js";

describe("slugForEmail", () => {
	it("uses the sanitized email local part", () => {
		expect(slugForEmail("Alice.Smith+x@org.com", new Set())).toBe(
			"alice-smith-x",
		);
	});

	it("de-duplicates against taken slugs", () => {
		expect(slugForEmail("alice@org.com", new Set(["alice"]))).toBe("alice-2");
		expect(slugForEmail("alice@org.com", new Set(["alice", "alice-2"]))).toBe(
			"alice-3",
		);
	});
});

describe("buildUserEnvFile", () => {
	it("writes provided credentials under both GitHub names", () => {
		const content = buildUserEnvFile({
			claudeToken: "sk-ant-oat01-xyz",
			githubPat: "github_pat_abc",
		});
		expect(content).toBe(
			[
				"CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xyz",
				"GH_TOKEN=github_pat_abc",
				"GITHUB_TOKEN=github_pat_abc",
				"",
			].join("\n"),
		);
	});

	it("omits absent credentials", () => {
		expect(buildUserEnvFile({ githubPat: "p" })).toBe(
			"GH_TOKEN=p\nGITHUB_TOKEN=p\n",
		);
		expect(buildUserEnvFile({})).toBe("");
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && pnpm vitest run src/commands/UsersCommand.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the command**

```typescript
// apps/cli/src/commands/UsersCommand.ts
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";
import type { UserCredentialConfig } from "cyrus-core";
import { BaseCommand } from "./ICommand.js";

/** Slug for the per-user credentials directory, derived from the email local part. */
export function slugForEmail(email: string, taken: Set<string>): string {
	const base =
		email
			.split("@")[0]!
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "user";
	if (!taken.has(base)) return base;
	let n = 2;
	while (taken.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

/** Render the per-user .env file content from the collected secrets. */
export function buildUserEnvFile(input: {
	claudeToken?: string;
	githubPat?: string;
}): string {
	const lines: string[] = [];
	if (input.claudeToken) {
		lines.push(`CLAUDE_CODE_OAUTH_TOKEN=${input.claudeToken}`);
	}
	if (input.githubPat) {
		lines.push(`GH_TOKEN=${input.githubPat}`);
		lines.push(`GITHUB_TOKEN=${input.githubPat}`);
	}
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Manage per-user credential profiles for multi-user deployments.
 *
 *   cyrus users add             # interactive registration
 *   cyrus users list            # registered users (no secrets)
 *   cyrus users remove <email>  # remove from config (files kept)
 */
export class UsersCommand extends BaseCommand {
	async execute(args: string[]): Promise<void> {
		const [subcommand, ...rest] = args;
		switch (subcommand) {
			case "add":
				return this.add();
			case "list":
				return this.list();
			case "remove":
				return this.remove(rest[0]);
			default:
				this.exitWithError(
					"Usage: cyrus users <add|list|remove <email>>",
				);
		}
	}

	private async add(): Promise<void> {
		const rl = readline.createInterface({
			input: process.stdin,
			output: process.stdout,
		});
		try {
			const email = (await rl.question("Linear account email: ")).trim();
			if (!email.includes("@")) {
				this.exitWithError("A valid email is required.");
			}

			const config = this.app.config.load();
			const users: UserCredentialConfig[] = config.users ?? [];
			const existing = users.find(
				(u) =>
					typeof u.linearUser === "object" &&
					"email" in u.linearUser &&
					u.linearUser.email.toLowerCase() === email.toLowerCase(),
			);

			const gitName =
				(await rl.question(
					`Git author name [${email.split("@")[0]}]: `,
				)).trim() || email.split("@")[0]!;
			const gitEmail =
				(await rl.question(`Git author email [${email}]: `)).trim() || email;

			const claudeToken = (
				await promptSecret(
					rl,
					"Claude Code OAuth token (from `claude setup-token`, blank to skip): ",
				)
			).trim();
			const githubPat = (
				await promptSecret(rl, "GitHub PAT (blank to skip): ")
			).trim();
			const codexAuthPath = (
				await rl.question(
					"Path to Codex auth.json (from `codex login`, blank to skip): ",
				)
			).trim();

			// Reuse the existing profile dir on re-registration (idempotent update)
			const usersRoot = join(this.app.cyrusHome, "users");
			mkdirSync(usersRoot, { recursive: true });
			const taken = new Set(
				existsSync(usersRoot) ? readdirSync(usersRoot) : [],
			);
			const credentialsDir =
				existing?.credentialsDir ??
				join(usersRoot, slugForEmail(email, taken));
			mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });

			const envContent = buildUserEnvFile({
				claudeToken: claudeToken || undefined,
				githubPat: githubPat || undefined,
			});
			if (envContent) {
				writeFileSync(join(credentialsDir, ".env"), envContent, {
					mode: 0o600,
				});
			}

			if (codexAuthPath) {
				if (!existsSync(codexAuthPath)) {
					this.exitWithError(`No file at ${codexAuthPath}`);
				}
				const codexDir = join(credentialsDir, "codex");
				mkdirSync(codexDir, { recursive: true, mode: 0o700 });
				copyFileSync(codexAuthPath, join(codexDir, "auth.json"));
			}

			const entry: UserCredentialConfig = {
				linearUser: { email },
				credentialsDir,
				gitAuthor: { name: gitName, email: gitEmail },
			};
			const updated = existing
				? users.map((u) => (u === existing ? entry : u))
				: [...users, entry];
			this.app.config.save({ ...config, users: updated });

			this.logSuccess(
				`${existing ? "Updated" : "Registered"} ${email} → ${credentialsDir}`,
			);
			this.logger.info(
				"Restart cyrus (or wait for config hot-reload) for the change to take effect.",
			);
		} finally {
			rl.close();
		}
	}

	private list(): void {
		const config = this.app.config.load();
		const users = config.users ?? [];
		if (users.length === 0) {
			this.logger.info(
				"No users registered. Multi-user mode is OFF (sessions use the global ~/.cyrus/.env credentials).",
			);
			return;
		}
		for (const u of users) {
			const who =
				typeof u.linearUser === "string"
					? u.linearUser
					: "email" in u.linearUser
						? u.linearUser.email
						: u.linearUser.id;
			const has = (p: string) => (existsSync(join(u.credentialsDir, p)) ? "✓" : "✗");
			this.logger.info(
				`${who}  dir=${u.credentialsDir}  .env=${has(".env")} codex=${has("codex/auth.json")} claude-dir=${has("claude")}`,
			);
		}
	}

	private remove(email: string | undefined): void {
		if (!email) {
			this.exitWithError("Usage: cyrus users remove <email>");
		}
		const config = this.app.config.load();
		const users = config.users ?? [];
		const remaining = users.filter(
			(u) =>
				!(
					typeof u.linearUser === "object" &&
					"email" in u.linearUser &&
					u.linearUser.email.toLowerCase() === email.toLowerCase()
				),
		);
		if (remaining.length === users.length) {
			this.exitWithError(`No registered user with email ${email}`);
		}
		this.app.config.save({ ...config, users: remaining });
		this.logSuccess(
			`Removed ${email} from config. Credential files were NOT deleted — remove the directory manually if desired.`,
		);
	}
}

/** Prompt without echoing the typed value (secrets). */
async function promptSecret(
	rl: readline.Interface,
	question: string,
): Promise<string> {
	process.stdout.write(question);
	const muted = new Writable({
		write(_chunk, _enc, cb) {
			cb();
		},
	});
	const secretRl = readline.createInterface({
		input: process.stdin,
		output: muted,
		terminal: true,
	});
	try {
		const answer = await secretRl.question("");
		process.stdout.write("\n");
		return answer;
	} finally {
		secretRl.close();
	}
}
```

Note for the implementer: `config.users` requires the CLI's `EdgeConfig` (re-exported from `cyrus-core` in `apps/cli/src/config/types.ts`) to carry Task 1's fields — it does automatically. If `ConfigService.save()`'s signature differs from `save(config: EdgeConfig)`, check `apps/cli/src/services/ConfigService.ts:130` and match it.

- [ ] **Step 4: Register the commands in app.ts**

In `apps/cli/src/app.ts`, import `UsersCommand`, then after the `self-add-repo` registration (line ~165):

```typescript
// Users command - manage per-user credential profiles
const usersCommand = program
	.command("users")
	.description("Manage per-user credential profiles (multi-user mode)");
for (const sub of [
	["add", "Register a user's Claude/Codex/GitHub credentials interactively"],
	["list", "List registered users (no secrets shown)"],
	["remove <email>", "Remove a user from the registry (files are kept)"],
] as const) {
	usersCommand
		.command(sub[0])
		.description(sub[1])
		.action(async (...actionArgs: string[]) => {
			const opts = program.opts();
			const app = new Application(
				opts.cyrusHome,
				opts.envFile,
				packageJson.version,
				errorReporter,
			);
			const name = sub[0].split(" ")[0]!;
			const positional = actionArgs.filter((a) => typeof a === "string");
			await new UsersCommand(app).execute([name, ...positional]);
		});
}
```

- [ ] **Step 5: Run tests and smoke-test the CLI**

Run: `cd apps/cli && pnpm vitest run src/commands/UsersCommand.test.ts && pnpm typecheck`
Expected: PASS.

Smoke test against a scratch home (never your real `~/.cyrus`):

```bash
cd apps/cli && pnpm build
node dist/src/app.js --cyrus-home /tmp/cyrus-users-smoke users list
# Expected: "No users registered. Multi-user mode is OFF ..."
printf 'alice@org.com\nAlice\n\nsk-test-token\nghp_test\n\n' | node dist/src/app.js --cyrus-home /tmp/cyrus-users-smoke users add
node dist/src/app.js --cyrus-home /tmp/cyrus-users-smoke users list
# Expected: alice@org.com line with .env=✓ codex=✗
cat /tmp/cyrus-users-smoke/config.json   # users[] entry present
stat -f "%Lp" /tmp/cyrus-users-smoke/users/alice/.env   # Expected: 600
node dist/src/app.js --cyrus-home /tmp/cyrus-users-smoke users remove alice@org.com
```

(If the piped-stdin secret prompts misbehave because `terminal: true` needs a TTY, run the add flow manually in a terminal instead and note the result.)

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/commands/UsersCommand.ts apps/cli/src/commands/UsersCommand.test.ts apps/cli/src/app.ts
git commit -m "feat(cli): add cyrus users add/list/remove for per-user credential profiles"
```

---

### Task 9: Changelog, full verification, F1 test drive

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)

- [ ] **Step 1: Changelog entry**

Under `## [Unreleased]` / `### Added`:

```markdown
- Multi-user credential profiles: register each teammate's Claude Code token, Codex auth, and GitHub PAT with `cyrus users add`; sessions started by a registered Linear user run with that user's credentials (including nested CLIs like Codex invoked from within a session), and unregistered users are blocked with registration instructions. Commit authorship is configurable between the requesting user and a shared "Cyrus agent" identity via the new `gitCommitAuthor` config field.
```

- [ ] **Step 2: Full verification**

```bash
pnpm typecheck && pnpm lint && pnpm test:packages:run && pnpm build
```
Expected: all pass. Fix anything that fails before proceeding.

- [ ] **Step 3: F1 test drive (mandatory validation)**

Use the `f1-test-drive` skill/agent to validate end-to-end (see `apps/f1/test-drives/` for prior examples). Scenarios to drive:

1. **Registered user** — configure `users[]` with a profile for the F1 test user (create a scratch credentials dir with a dummy `.env` + `codex/` dir); start a session; verify from the session transcript that the runner env contains the profile's `CLAUDE_CODE_OAUTH_TOKEN`/`CODEX_HOME` (e.g. have the agent run `env | grep -E 'CODEX_HOME|GIT_AUTHOR'` via Bash) and that `GIT_AUTHOR_NAME` matches the profile in `mode: "user"`.
2. **Shared authorship** — set `gitCommitAuthor: { mode: "shared", shared: {...} }`; verify `GIT_AUTHOR_NAME` in the session env is the shared identity.
3. **Unregistered user** — with `users[]` non-empty, trigger a session as a creator not in the registry; verify no runner starts and the session timeline shows the registration-instructions response activity.
4. **Multi-user off** — with `users[]` absent, verify sessions behave exactly as before (no injected env, no blocking).

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for multi-user credential profiles"
```

---

## Post-plan notes (do NOT implement — documented decisions)

- **Host prerequisite (ops, not code):** run `gh auth setup-git` once on the Cyrus host so git uses `gh` as its credential helper — thereafter the per-session `GH_TOKEN` drives push/PR identity with no further git config (spec §6.7).
- **Auto-runner detection** (`RunnerSelectionService.getDefaultRunner`) still reads global env. Multi-user deployments should set `defaultRunner` explicitly in config; noted in the spec (§7.5), revisit if it bites.
- **Slack/GitHub/GitLab-triggered sessions** intentionally keep global credentials (spec Non-Goals).
- **Codex `auth.json` refresh races** between concurrent same-user sessions: accepted risk (spec §7.4).
- Upstream PR #1307 (org-keyed GitHub token store) may land; if it does, migrate the per-user PAT flow onto its token store (spec §5.3).
