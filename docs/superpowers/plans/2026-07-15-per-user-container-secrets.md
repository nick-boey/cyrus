# Per-User Container Secrets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each router user supply an arbitrary set of env vars that flow into their issue containers, gate container boot on a configurable "fully authenticated" set of required credentials, and wire the full hosted Linear MCP inside the container's Claude session from a per-user `LINEAR_API_TOKEN`.

**Architecture:** The router's `SecretStore` becomes a generic per-user `Record<string,string>` env map (with transparent migration of the 5 legacy named keys to their env-var names). `ContainerTargets.buildEnv` spreads that map into the container env minus a reserved set, and blocks boot when any required key (always including the Claude token, plus any operator-configured extras) is missing. Inside the container, `ContainerBootCommand.writeConfig` reads `LINEAR_API_TOKEN` and populates `linearWorkspaces[<wsId>].linearToken`, which the existing device-mode MCP wiring (`getLinearTokenForWorkspace` → `McpConfigService`) turns into the hosted Linear MCP server — no new MCP code.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, Zod, Node.js `node:fs`, Commander (F1 CLI), Docker (worker image).

> **This plan incorporates an independent Codex (gpt-5.6-sol) review of the spec + first-draft plan.** Design decisions taken from that review (confirmed by the maintainer):
> 1. **Additive required set** — `CLAUDE_CODE_OAUTH_TOKEN` is ALWAYS required; `requiredSecretKeys` only adds more. (The container hard-requires the Claude token; a config that omitted it would pass the router gate then die inside the container.)
> 2. **Secret rotation is a documented limitation** — changing/adding a secret only takes effect on the next *fresh* boot; to apply immediately, destroy the container (`cyrus router containers destroy <issueKey>`). No provider auto-recreation in this plan.
> 3. **Expanded reserved set + env-name validation** — reserve container bootstrap/process-control vars too, and validate every stored key is a real, non-reserved env-var name.

## Global Constraints

- **Language/tooling:** TypeScript, strict mode, zero `any`. Package manager is pnpm (`pnpm@10.33.1`). Tests are Vitest.
- **Reserved env keys (never user-overridable):** `CYRUS_ROUTER_URL`, `CYRUS_DEVICE_TOKEN`, `CYRUS_ISSUE_KEY`, `CYRUS_REPOS_JSON`, `CYRUS_WORKSPACES_DIR`, `CYRUS_REPO_CACHE_DIR`, `PATH`, `HOME`, `NODE_OPTIONS`. Defined once in `packages/router/src/SecretStore.ts` as `RESERVED_ENV_KEYS`; imported by every call site. (CYRUS_* routing/identity + the two container bootstrap dirs redirect state; `PATH`/`HOME`/`NODE_OPTIONS` break or hijack the runtime.)
- **Valid stored key:** matches `VALID_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/` and is not reserved. Enforced by `isStorableSecretKey`, used at `SecretStore.set`, the CLI schema, and (transitively) the F1 seed path.
- **Effective required set (additive):** always `["CLAUDE_CODE_OAUTH_TOKEN", ...requiredSecretKeys]`, de-duplicated. `DEFAULT_REQUIRED_SECRET_KEYS = ["CLAUDE_CODE_OAUTH_TOKEN"]`.
- **Legacy → env-var name map** (migration of on-disk files only): `claudeOauthToken → CLAUDE_CODE_OAUTH_TOKEN`, `githubPat → GIT_TOKEN`, `gitUserName → GIT_USER_NAME`, `gitUserEmail → GIT_USER_EMAIL`, `dotfilesRepo → DOTFILES_REPO`.
- **Linear env-var name is standardized as `LINEAR_API_TOKEN`** (matches the claude-runner test-script convention). One user has one Linear token; `writeConfig` applies it to every configured workspace ID (documented single-credential assumption).
- **SecretStore safety invariant (must not regress or weaken):** a missing file reads as `{}`; any read/parse failure OR a structurally-invalid-but-valid-JSON file (non-object root, non-object bundle, non-string value) **throws** (never silently resets); writes stay atomic (tmp + rename) at mode `0600`.
- **Secrets must never be echoed** to stdout/logs — only key names are printed; error messages never include a secret value (including the F1 `--env` parse error).
- **Router config threading:** `RouterConfigFileSchema` in `apps/cli/src/commands/RouterCommand.ts` uses Zod `.object()` which **strips unknown keys**, and the CLI then spreads `...parsed.data` into `RouterServerConfig`. Any new `containers.*` field MUST be added to that Zod schema or it is silently dropped at load. (There is no ConfigManager-style hardcoded whitelist for the router — the Zod schema *is* the whitelist.)

---

## File Structure

**Modified:**
- `packages/router/src/SecretStore.ts` — generic env map, migration + key normalization, shape validation, reserved/valid-name enforcement, `isFullyAuthenticated`, exported constants + helpers.
- `packages/router/src/index.ts` — export surface.
- `packages/router/src/ContainerTargets.ts` — `buildEnv` generic spread-minus-reserved + additive required-set gate; `ContainerRoutingDeps.containersConfig.requiredSecretKeys`.
- `packages/router/src/RouterServer.ts` — `RouterContainersConfig.requiredSecretKeys`; pass through `buildContainerTargets`.
- `apps/cli/src/commands/RouterCommand.ts` — `RouterConfigFileSchema.containers.requiredSecretKeys` (validated); `secrets set/unset` raw env keys + reserved/invalid rejection; new `secrets list`.
- `apps/cli/src/commands/ContainerBootCommand.ts` — `writeConfig` reads `LINEAR_API_TOKEN` → `linearWorkspaces`.
- `packages/edge-worker/src/McpConfigService.ts`, `packages/edge-worker/src/EdgeWorker.ts` — correct the now-outdated "router devices never hold a Linear token" comments.
- `apps/f1/src/router/RouterRig.ts`, `apps/f1/src/router/ControlServer.ts`, `apps/f1/src/commands/router/seedUser.ts` — store `CLAUDE_CODE_OAUTH_TOKEN` + repeatable `--env`.
- `docker/worker/README.md` — fix existing legacy secret names + add "Adding tools to the worker container" and per-user credentials/rotation/reserved-keys guidance.
- `CHANGELOG.md` — Unreleased entries.

**Test files touched:** `packages/router/test/SecretStore.test.ts`, `packages/router/test/ContainerTargets.test.ts`, `packages/router/test/RouterServer.test.ts`, `apps/cli/src/commands/RouterCommand.test.ts`, `apps/cli/src/commands/ContainerBootCommand.test.ts`, `packages/edge-worker/test/McpConfigService.router-mode.test.ts`, `apps/f1/test/router/*`.

---

### Task 1: Generic SecretStore + container env gate (router core)

Delivers the coupled unit — the generic secret model AND the `buildEnv` rewrite that consumes it — so `cyrus-router`'s own suite stays fully green. `USER_SECRET_KEYS` is intentionally **kept exported** here (still imported by `apps/cli`) and removed in Task 3, so the monorepo typecheck stays green in between.

**Files:**
- Modify: `packages/router/src/SecretStore.ts`
- Modify: `packages/router/src/index.ts`
- Modify: `packages/router/src/ContainerTargets.ts`
- Test: `packages/router/test/SecretStore.test.ts`
- Test: `packages/router/test/ContainerTargets.test.ts`

**Interfaces:**
- Produces (SecretStore.ts): `type UserSecretBundle = Record<string,string>`; consts `LEGACY_SECRET_KEY_MAP`, `RESERVED_ENV_KEYS`, `DEFAULT_REQUIRED_SECRET_KEYS`, `VALID_ENV_NAME_RE`; fns `isReservedEnvKey(key: string): boolean`, `isStorableSecretKey(key: string): boolean`; `SecretStore.get(email): UserSecretBundle` (migrated), `SecretStore.set(email, key: string, value: string | undefined): void` (normalizes legacy key, rejects reserved/invalid), `SecretStore.isFullyAuthenticated(email, requiredKeys: readonly string[]): { ok: boolean; missing: string[] }`.
- Produces (ContainerTargets.ts): `ContainerRoutingDeps.containersConfig.requiredSecretKeys?: string[]`; `buildEnv` unchanged signature, additive gate + spread-minus-reserved behavior.

- [ ] **Step 1: Rewrite `SecretStore.ts`**

Replace the entire body of `packages/router/src/SecretStore.ts` with:

```typescript
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Per-user container secrets: an env-var-name → value map. */
export type UserSecretBundle = Record<string, string>;

/**
 * @deprecated Legacy fixed key names. Retained only so migration and the
 * transitional CLI guard can reference them; removed in Task 3 once the CLI
 * stops importing it. New code uses env-var names.
 */
export const USER_SECRET_KEYS = [
	"claudeOauthToken",
	"githubPat",
	"gitUserName",
	"gitUserEmail",
	"dotfilesRepo",
] as const;

/** Legacy named secret keys → the container env-var names they map to. */
export const LEGACY_SECRET_KEY_MAP: Record<string, string> = {
	claudeOauthToken: "CLAUDE_CODE_OAUTH_TOKEN",
	githubPat: "GIT_TOKEN",
	gitUserName: "GIT_USER_NAME",
	gitUserEmail: "GIT_USER_EMAIL",
	dotfilesRepo: "DOTFILES_REPO",
};

/**
 * Env vars the router controls; a user may never override them. CYRUS_*
 * routing/identity + the two container bootstrap dirs
 * (CYRUS_WORKSPACES_DIR / CYRUS_REPO_CACHE_DIR, which decide where state and
 * credential-bearing config are written) hijack/redirect routing or state;
 * PATH/HOME/NODE_OPTIONS break or inject into the runtime. Shared by
 * `SecretStore.set` (hard reject) and `ContainerTargets.buildEnv`
 * (skip-with-warning).
 */
export const RESERVED_ENV_KEYS = [
	"CYRUS_ROUTER_URL",
	"CYRUS_DEVICE_TOKEN",
	"CYRUS_ISSUE_KEY",
	"CYRUS_REPOS_JSON",
	"CYRUS_WORKSPACES_DIR",
	"CYRUS_REPO_CACHE_DIR",
	"PATH",
	"HOME",
	"NODE_OPTIONS",
] as const;

/** Default "fully authenticated" set. The gate is additive on top of this. */
export const DEFAULT_REQUIRED_SECRET_KEYS = [
	"CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/** POSIX-style environment variable name. */
export const VALID_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isReservedEnvKey(key: string): boolean {
	return (RESERVED_ENV_KEYS as readonly string[]).includes(key);
}

/** A key a user may store: a valid env-var name that is not reserved. */
export function isStorableSecretKey(key: string): boolean {
	return VALID_ENV_NAME_RE.test(key) && !isReservedEnvKey(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Maps any legacy named keys in `raw` to their env-var names. Env-var-named
 * keys already present win over a legacy key mapping to the same name (the
 * legacy key is dropped). Idempotent: a fully-migrated bundle is unchanged.
 */
function migrateBundle(raw: Record<string, string>): UserSecretBundle {
	const out: UserSecretBundle = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!Object.hasOwn(LEGACY_SECRET_KEY_MAP, key)) out[key] = value;
	}
	for (const [key, value] of Object.entries(raw)) {
		const envName = LEGACY_SECRET_KEY_MAP[key];
		if (envName && !Object.hasOwn(out, envName)) out[envName] = value;
	}
	return out;
}

/**
 * Per-user secret bundles for container launches, stored as a single JSON
 * file (keyed by lowercased email) next to router-config.json. Single-org
 * threat model: file perms (0600) are the protection boundary.
 */
export class SecretStore {
	constructor(private readonly filePath: string) {}

	/** Returns the user's bundle with legacy keys migrated to env-var names. */
	get(email: string): UserSecretBundle {
		return this.readAll()[email.toLowerCase()] ?? {};
	}

	/**
	 * Sets or (when `value === undefined`) unsets a single env var. A legacy
	 * key is normalized to its env-var name FIRST, so an update/unset targets
	 * the same key the migrated bundle exposes (otherwise a legacy update
	 * would write a second key that the old value shadows on the next read).
	 * Rejects reserved keys and non-env-var-name keys.
	 */
	set(email: string, key: string, value: string | undefined): void {
		const normalizedKey = Object.hasOwn(LEGACY_SECRET_KEY_MAP, key)
			? LEGACY_SECRET_KEY_MAP[key]
			: key;
		if (isReservedEnvKey(normalizedKey)) {
			throw new Error(
				`"${normalizedKey}" is a reserved env var and cannot be stored as a per-user secret. Reserved: ${RESERVED_ENV_KEYS.join(", ")}`,
			);
		}
		if (!VALID_ENV_NAME_RE.test(normalizedKey)) {
			throw new Error(
				`"${normalizedKey}" is not a valid environment variable name (expected ${VALID_ENV_NAME_RE}).`,
			);
		}

		const all = this.readAll();
		const id = email.toLowerCase();
		const bundle = { ...(all[id] ?? {}) };
		if (value === undefined) {
			delete bundle[normalizedKey];
		} else {
			bundle[normalizedKey] = value;
		}
		if (Object.keys(bundle).length === 0) {
			delete all[id];
		} else {
			all[id] = bundle;
		}
		mkdirSync(dirname(this.filePath), { recursive: true });
		const tmp = `${this.filePath}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
		// `mode` on writeFileSync only applies on creation; force 0600 in case a
		// crash-leftover `.tmp` had looser perms.
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.filePath);
	}

	/**
	 * Reports whether a user has every key in `requiredKeys` set to a
	 * non-empty value. `missing` lists absent keys in the given order.
	 */
	isFullyAuthenticated(
		email: string,
		requiredKeys: readonly string[],
	): { ok: boolean; missing: string[] } {
		const bundle = this.get(email);
		const missing = requiredKeys.filter((key) => !bundle[key]);
		return { ok: missing.length === 0, missing };
	}

	private readAll(): Record<string, UserSecretBundle> {
		// A missing file is the documented "no secrets yet" state.
		if (!existsSync(this.filePath)) return {};
		// Once the file exists, any failure to read/parse — or a structurally
		// invalid shape — is a real error and must throw, never resolve to `{}`
		// (which a later `set()` would overwrite, destroying every user's data).
		let raw: string;
		try {
			raw = readFileSync(this.filePath, "utf-8");
		} catch (err) {
			throw new Error(
				`SecretStore: failed to read ${this.filePath}: ${(err as Error).message}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			throw new Error(
				`SecretStore: failed to parse ${this.filePath} as JSON: ${(err as Error).message}`,
			);
		}
		if (!isPlainObject(parsed)) {
			throw new Error(
				`SecretStore: ${this.filePath} is not a JSON object at the root`,
			);
		}
		const migrated: Record<string, UserSecretBundle> = {};
		for (const [id, bundle] of Object.entries(parsed)) {
			if (!isPlainObject(bundle)) {
				throw new Error(
					`SecretStore: ${this.filePath} entry for "${id}" is not an object`,
				);
			}
			for (const [key, value] of Object.entries(bundle)) {
				if (typeof value !== "string") {
					throw new Error(
						`SecretStore: ${this.filePath} value for "${id}.${key}" is not a string`,
					);
				}
			}
			migrated[id] = migrateBundle(bundle as Record<string, string>);
		}
		return migrated;
	}
}
```

- [ ] **Step 2: Update `packages/router/src/index.ts` exports**

Replace the `./SecretStore.js` export block with:

```typescript
export {
	DEFAULT_REQUIRED_SECRET_KEYS,
	isReservedEnvKey,
	isStorableSecretKey,
	LEGACY_SECRET_KEY_MAP,
	RESERVED_ENV_KEYS,
	SecretStore,
	USER_SECRET_KEYS,
	type UserSecretBundle,
	VALID_ENV_NAME_RE,
} from "./SecretStore.js";
```

- [ ] **Step 3: Write failing SecretStore tests**

Append inside `describe("SecretStore", …)` in `packages/router/test/SecretStore.test.ts`:

```typescript
it("migrates legacy named keys to env-var names on read", () => {
	const path = freshPath();
	writeFileSync(
		path,
		`${JSON.stringify({
			"a@example.com": {
				claudeOauthToken: "tok",
				githubPat: "pat",
				gitUserName: "Ann",
				gitUserEmail: "ann@x.com",
				dotfilesRepo: "https://example/dotfiles",
			},
		})}\n`,
		{ mode: 0o600 },
	);
	expect(new SecretStore(path).get("a@example.com")).toEqual({
		CLAUDE_CODE_OAUTH_TOKEN: "tok",
		GIT_TOKEN: "pat",
		GIT_USER_NAME: "Ann",
		GIT_USER_EMAIL: "ann@x.com",
		DOTFILES_REPO: "https://example/dotfiles",
	});
});

it("prefers a new env-var key over its legacy equivalent", () => {
	const path = freshPath();
	writeFileSync(
		path,
		`${JSON.stringify({
			"a@example.com": { claudeOauthToken: "legacy", CLAUDE_CODE_OAUTH_TOKEN: "new" },
		})}\n`,
		{ mode: 0o600 },
	);
	expect(new SecretStore(path).get("a@example.com")).toEqual({
		CLAUDE_CODE_OAUTH_TOKEN: "new",
	});
});

it("normalizes a legacy key on set so an update overwrites, not duplicates", () => {
	const path = freshPath();
	const store = new SecretStore(path);
	store.set("a@example.com", "githubPat", "pat-1"); // stored as GIT_TOKEN
	store.set("a@example.com", "githubPat", "pat-2"); // must overwrite GIT_TOKEN
	expect(store.get("a@example.com")).toEqual({ GIT_TOKEN: "pat-2" });
	// No legacy key ever persists on disk.
	const onDisk = JSON.parse(readFileSync(path, "utf-8"));
	expect(onDisk["a@example.com"]).toEqual({ GIT_TOKEN: "pat-2" });
});

it("normalizes a legacy key on unset", () => {
	const path = freshPath();
	const store = new SecretStore(path);
	store.set("a@example.com", "githubPat", "pat"); // GIT_TOKEN
	store.set("a@example.com", "githubPat", undefined); // must delete GIT_TOKEN
	expect(store.get("a@example.com")).toEqual({});
});

it("stores and reads back arbitrary env-var-named keys", () => {
	const path = freshPath();
	new SecretStore(path).set("a@example.com", "LINEAR_API_TOKEN", "lin_api_123");
	expect(new SecretStore(path).get("a@example.com").LINEAR_API_TOKEN).toBe(
		"lin_api_123",
	);
});

it("rejects reserved keys (including the container bootstrap dirs)", () => {
	const store = new SecretStore(freshPath());
	for (const key of ["CYRUS_ROUTER_URL", "PATH", "CYRUS_WORKSPACES_DIR", "NODE_OPTIONS"]) {
		expect(() => store.set("a@example.com", key, "x")).toThrow(/reserved env var/);
	}
});

it("rejects a key that is not a valid env-var name", () => {
	const store = new SecretStore(freshPath());
	expect(() => store.set("a@example.com", "not a name", "x")).toThrow(
		/not a valid environment variable name/,
	);
	expect(() => store.set("a@example.com", "1BAD", "x")).toThrow(
		/not a valid environment variable name/,
	);
});

it("reports fully-authenticated status against a required set", () => {
	const store = new SecretStore(freshPath());
	store.set("a@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "tok");
	expect(
		store.isFullyAuthenticated("a@example.com", [
			"CLAUDE_CODE_OAUTH_TOKEN",
			"GIT_TOKEN",
			"LINEAR_API_TOKEN",
		]),
	).toEqual({ ok: false, missing: ["GIT_TOKEN", "LINEAR_API_TOKEN"] });
});

it.each([
	["a JSON array", "[]"],
	["a non-object user entry", `${JSON.stringify({ "a@x.com": 42 })}`],
	["a non-string value", `${JSON.stringify({ "a@x.com": { GIT_TOKEN: 1 } })}`],
])("throws (never resets) on structurally-corrupt-but-valid JSON: %s", (_label, contents) => {
	const path = freshPath();
	writeFileSync(path, contents, { mode: 0o600 });
	const store = new SecretStore(path);
	expect(() => store.set("b@x.com", "GIT_TOKEN", "y")).toThrow();
	// Bytes untouched.
	expect(readFileSync(path, "utf-8")).toBe(contents);
});
```

Confirm the file's `node:fs` import includes `readFileSync` and `writeFileSync` (it already does — both are used by existing tests).

- [ ] **Step 4: Run SecretStore tests; update pre-existing assertions to env-var names**

Run: `pnpm --filter cyrus-router test:run test/SecretStore.test.ts`
The pre-existing tests that assert legacy field names now migrate; update them:
  - `"sets, persists, and case-insensitively reads values…"` (line ~15): `.get("a@example.com").claudeOauthToken` → `.CLAUDE_CODE_OAUTH_TOKEN` (the `set(..., "claudeOauthToken", ...)` call may stay — it's normalized).
  - `"deletes a key when set to undefined"` (line ~25): now passes unchanged (normalization makes set/unset of `githubPat` target `GIT_TOKEN`, ending at `{}`). Leave as-is.
  - `"preserves other users' secrets…"` (line ~47): `.githubPat` → `.GIT_TOKEN`, `.claudeOauthToken` → `.CLAUDE_CODE_OAUTH_TOKEN`.
  - `"forces 0600…"` (line ~58): unchanged (asserts file mode only).
Re-run until PASS.

- [ ] **Step 5: Rewrite `buildEnv` in `ContainerTargets.ts` (additive gate + spread-minus-reserved)**

At the top of `packages/router/src/ContainerTargets.ts`, replace the `import type { SecretStore }` line with:

```typescript
import {
	DEFAULT_REQUIRED_SECRET_KEYS,
	isReservedEnvKey,
	type SecretStore,
} from "./SecretStore.js";
```

Add `requiredSecretKeys` to `ContainerRoutingDeps.containersConfig` (after `repositories`):

```typescript
		/**
		 * Extra env-var names a user MUST have stored before any container
		 * boots for them. The Claude token is always required on top of these
		 * (see buildEnv). Defaults to none when omitted.
		 */
		requiredSecretKeys?: string[];
```

Replace the entire `buildEnv` method with:

```typescript
	private buildEnv(userId: number, issueKey: string): Record<string, string> {
		const email = this.emailFor(userId);
		// Additive: the container hard-requires the Claude token, so it is
		// always required regardless of config; requiredSecretKeys adds to it.
		const requiredKeys = [
			...new Set([
				...DEFAULT_REQUIRED_SECRET_KEYS,
				...(this.deps.containersConfig.requiredSecretKeys ?? []),
			]),
		];
		const { ok, missing } = this.deps.secrets.isFullyAuthenticated(
			email,
			requiredKeys,
		);
		if (!ok) {
			throw new Error(
				`${email} is not fully authenticated for containers: missing ${missing.join(", ")}. Set them with: cyrus router secrets set ${email} <KEY> <value>`,
			);
		}

		const env: Record<string, string> = {
			CYRUS_ROUTER_URL: this.deps.containersConfig.routerUrlForContainers,
			CYRUS_ISSUE_KEY: issueKey,
			CYRUS_REPOS_JSON: JSON.stringify(this.deps.containersConfig.repositories),
		};
		// Spread the user's map, skipping reserved keys. `set` already rejects
		// them; this is belt-and-braces against a hand-edited secrets file.
		for (const [key, value] of Object.entries(this.deps.secrets.get(email))) {
			if (isReservedEnvKey(key)) {
				this.deps.logger.warn(
					`skipping reserved env key "${key}" found in ${email}'s stored secrets`,
				);
				continue;
			}
			env[key] = value;
		}
		return env;
	}
```

`CYRUS_DEVICE_TOKEN` is still appended by `LocalDockerProvider.ensureRunning` via `mintDeviceToken()` — `buildEnv` must not set it.

- [ ] **Step 6: Update `ContainerTargets.test.ts`**

In `packages/router/test/ContainerTargets.test.ts`:

1. Capture the secrets file path so a test can hand-edit it. In `beforeEach`, change the `secrets` setup to:

```typescript
		secretsFile = freshSecretsPath();
		secrets = new SecretStore(secretsFile);
```

and declare `let secretsFile: string;` alongside the other `let`s. Add `readFileSync, writeFileSync` to the `node:fs` import at the top (currently only `mkdtempSync`).

2. In `"boot passes env built from secrets and repo config, minus the device token"` (line ~136), switch to env-var-named keys and add a passthrough:

```typescript
		secrets.set("a@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "claude-tok");
		secrets.set("a@example.com", "GIT_TOKEN", "gh-pat");
		secrets.set("a@example.com", "GIT_USER_NAME", "A Example");
		secrets.set("a@example.com", "LINEAR_API_TOKEN", "lin_api_1");
```

and add `LINEAR_API_TOKEN: "lin_api_1"` to the `toMatchObject` env assertion.

3. In the other tests calling `secrets.set(..., "claudeOauthToken", ...)` (lines ~173, ~260, ~304), change the key to `"CLAUDE_CODE_OAUTH_TOKEN"`.

4. Rewrite the assertion in `"no Claude token means immediate failure…"` (line ~198):

```typescript
		expect(postActivity.mock.calls[0]?.[2]).toContain(
			"is not fully authenticated for containers: missing CLAUDE_CODE_OAUTH_TOKEN",
		);
```

5. Add a reserved-key-skip test (write the reserved key directly, bypassing `set`):

```typescript
	it("skips reserved env keys found in stored secrets, with a warning", async () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		secrets.set("a@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "claude-tok");
		const raw = JSON.parse(readFileSync(secretsFile, "utf-8"));
		raw["a@example.com"].CYRUS_ROUTER_URL = "http://evil";
		writeFileSync(secretsFile, JSON.stringify(raw));

		const docker = fakeExecutor("docker");
		const service = makeService(new Map([["docker", docker]]));
		const { deviceId } = service.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);
		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
		await vi.waitFor(() =>
			expect(docker.ensureRunning).toHaveBeenCalledTimes(1),
		);
		const ctx = docker.ensureRunning.mock.calls[0]?.[0] as IssueExecutionContext;
		expect(ctx.env.CYRUS_ROUTER_URL).toBe("wss://router.example.com");
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('skipping reserved env key "CYRUS_ROUTER_URL"'),
		);
	});
```

6. Add an additive-gate test proving the Claude token is required even when `requiredSecretKeys` omits it:

```typescript
	it("always requires the Claude token even when requiredSecretKeys omits it", async () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		secrets.set("a@example.com", "GIT_TOKEN", "gh"); // no Claude token
		const docker = fakeExecutor("docker");
		const service = new ContainerTargetService({
			store,
			secrets,
			executors: new Map([["docker", docker]]),
			containersConfig: { ...CONTAINERS_CONFIG, requiredSecretKeys: ["GIT_TOKEN"] },
			postActivity,
			logger,
		});
		const { deviceId } = service.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);
		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
		await vi.waitFor(() => expect(postActivity).toHaveBeenCalledTimes(1));
		expect(docker.ensureRunning).not.toHaveBeenCalled();
		expect(postActivity.mock.calls[0]?.[2]).toContain(
			"missing CLAUDE_CODE_OAUTH_TOKEN",
		);
	});
```

7. Add a multi-missing-key gate test with a custom required set (Claude present, extras missing):

```typescript
	it("blocks boot naming every missing required key", async () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		secrets.set("a@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "claude-tok");
		const docker = fakeExecutor("docker");
		const service = new ContainerTargetService({
			store,
			secrets,
			executors: new Map([["docker", docker]]),
			containersConfig: {
				...CONTAINERS_CONFIG,
				requiredSecretKeys: ["GIT_TOKEN", "LINEAR_API_TOKEN"],
			},
			postActivity,
			logger,
		});
		const { deviceId } = service.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);
		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
		await vi.waitFor(() => expect(postActivity).toHaveBeenCalledTimes(1));
		expect(docker.ensureRunning).not.toHaveBeenCalled();
		expect(postActivity.mock.calls[0]?.[2]).toContain(
			"missing GIT_TOKEN, LINEAR_API_TOKEN",
		);
	});
```

Ensure `ContainerTargetService` is imported in the test (it already is).

- [ ] **Step 7: Run router suite + typecheck**

Run: `pnpm --filter cyrus-router test:run && pnpm --filter cyrus-router typecheck`
Expected: PASS.

- [ ] **Step 8: Monorepo typecheck (compat exports intact)**

Run: `pnpm typecheck`
Expected: PASS (`apps/cli` still imports `USER_SECRET_KEYS`, retained until Task 3).

- [ ] **Step 9: Commit**

```bash
git add packages/router/src/SecretStore.ts packages/router/src/index.ts packages/router/src/ContainerTargets.ts packages/router/test/SecretStore.test.ts packages/router/test/ContainerTargets.test.ts
git commit -m "feat(router): generic per-user container secrets + additive boot auth gate"
```

---

### Task 2: Thread `requiredSecretKeys` through router config

Makes the operator-configurable extras reach `buildEnv` from `router-config.json`, validated at load. Without the Zod change the field is silently stripped (see Global Constraints).

**Files:**
- Modify: `packages/router/src/RouterServer.ts`
- Modify: `apps/cli/src/commands/RouterCommand.ts` (imports + the `containers` object in `RouterConfigFileSchema`)
- Test: `packages/router/test/RouterServer.test.ts`

**Interfaces:**
- Consumes: `ContainerRoutingDeps.containersConfig.requiredSecretKeys` (Task 1), `isStorableSecretKey` (Task 1).
- Produces: `RouterContainersConfig.requiredSecretKeys?: string[]`, forwarded into `ContainerTargetService`.

- [ ] **Step 1: Add `requiredSecretKeys` to `RouterContainersConfig`**

In `packages/router/src/RouterServer.ts`, inside `interface RouterContainersConfig` (after `staleDestroyMs`):

```typescript
	/**
	 * Extra env-var names a user must have stored before any container boots
	 * for them, on top of the always-required Claude token. Each entry must be
	 * a valid, non-reserved env-var name (validated at config load). e.g.
	 * ["GIT_TOKEN", "LINEAR_API_TOKEN"].
	 */
	requiredSecretKeys?: string[];
```

- [ ] **Step 2: Forward it in `buildContainerTargets`**

In the same file, extend the `containersConfig` passed to `new ContainerTargetService({...})`:

```typescript
			containersConfig: {
				routerUrlForContainers: containers.routerUrlForContainers,
				repositories: containers.repositories,
				requiredSecretKeys: containers.requiredSecretKeys,
			},
```

- [ ] **Step 3: Add the validated field to `RouterConfigFileSchema`**

In `apps/cli/src/commands/RouterCommand.ts`, add `isStorableSecretKey` to the `cyrus-router` import. Inside the `containers` `.object({ … })` (after `staleDestroyMs`), add:

```typescript
				requiredSecretKeys: z
					.array(
						z
							.string()
							.refine(isStorableSecretKey, (key) => ({
								message: `"${key}" is not a valid, non-reserved env-var name`,
							})),
					)
					.optional(),
```

- [ ] **Step 4: Write a deterministic forwarding test in `RouterServer.test.ts`**

The `describe("RouterServer containers wiring", …)` block builds a server with `containers` + an injected `executorRegistryFactory` (fake executor whose `ensureRunning` is a mock). Add a test that proves the configured extra key is forwarded: seed ONLY the Claude token, require `GIT_TOKEN`, route, and wait for the boot-failure warning — if forwarding were broken, the default (Claude-only) gate would pass and `ensureRunning` WOULD be called.

Add `SecretStore` to the `cyrus-router` import, and `mkdtempSync` + `tmpdir` + `join` to the node imports. Then:

```typescript
it("forwards containers.requiredSecretKeys to the boot gate", async () => {
	const docker = fakeExecutor("docker");
	const executors: ExecutorRegistry = new Map([["docker", docker]]);
	const secretsPath = join(mkdtempSync(join(tmpdir(), "rs-secrets-")), "s.json");
	const logger = { info: vi.fn(), warn: vi.fn() };
	server = new RouterServer({
		port: 0,
		dbPath: ":memory:",
		workspaces: { "ws-1": { linearToken: "t" } },
		webhook: { verificationMode: "direct", secret: "s" },
		trackerFactory: () => new CLIIssueTrackerService(),
		containers: {
			...CONTAINERS_CONFIG,
			secretsPath,
			requiredSecretKeys: ["GIT_TOKEN"],
		},
		executorRegistryFactory: () => executors,
		logger,
	});
	server.store.addUser({ email: "docker-user@example.com" });
	server.store.setUserExecutor("docker-user@example.com", '{"type":"docker"}');
	// Only the Claude token — passes the default gate, fails the GIT_TOKEN gate.
	new SecretStore(secretsPath).set(
		"docker-user@example.com",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"claude-tok",
	);

	await server.eventRouter.route(
		createdEvent({
			sessionId: "sess-1",
			issueId: "issue-1",
			identifier: "CYPACK-1",
			creatorEmail: "docker-user@example.com",
		}),
	);

	await vi.waitFor(() =>
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("is not fully authenticated"),
		),
	);
	expect(docker.ensureRunning).not.toHaveBeenCalled();
});
```

Confirm the `CONTAINERS_CONFIG` in this describe block does NOT already set `secretsPath`; the spread + override above supplies it. (`vi` is already imported in this test file.)

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter cyrus-router test:run && pnpm --filter cyrus-router typecheck && pnpm --filter cyrus-ai typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/router/src/RouterServer.ts apps/cli/src/commands/RouterCommand.ts packages/router/test/RouterServer.test.ts
git commit -m "feat(router): operator-configurable extra required secrets, validated + forwarded"
```

---

### Task 3: CLI `secrets` command — raw env keys, reserved/invalid rejection, `list`

Switches `secrets set/unset` to arbitrary env-var names (rejecting reserved/invalid), adds `secrets list` (masked values + additive missing-required view), and drops `USER_SECRET_KEYS`.

**Files:**
- Modify: `apps/cli/src/commands/RouterCommand.ts`
- Modify: `packages/router/src/SecretStore.ts` (remove `USER_SECRET_KEYS`)
- Modify: `packages/router/src/index.ts` (remove `USER_SECRET_KEYS`)
- Test: `apps/cli/src/commands/RouterCommand.test.ts`

**Interfaces:**
- Consumes: `RESERVED_ENV_KEYS`, `DEFAULT_REQUIRED_SECRET_KEYS`, `isReservedEnvKey`, `SecretStore.isFullyAuthenticated` (Task 1); `RouterConfigFileSchema.containers.requiredSecretKeys` (Task 2).

- [ ] **Step 1: Update imports + drop `isSecretKey`**

Replace the `cyrus-router` import block in `RouterCommand.ts` with:

```typescript
import {
	type ContainerDeviceInfo,
	DEFAULT_REQUIRED_SECRET_KEYS,
	isReservedEnvKey,
	isStorableSecretKey,
	RESERVED_ENV_KEYS,
	RouterServer,
	type RouterServerConfig,
	RouterStore,
	SecretStore,
} from "cyrus-router";
```

Delete the `isSecretKey` helper (lines ~30-32) and the now-unused `UserSecretBundle`/`USER_SECRET_KEYS` references.

- [ ] **Step 2: Rewrite `secretsSet` / `secretsUnset`**

```typescript
	private secretsSet(
		email: string | undefined,
		key: string | undefined,
		value: string | undefined,
	): void {
		if (!email || !key || value === undefined) {
			this.exitWithError(
				"Usage: cyrus router secrets set <email> <ENV_VAR_NAME> <value>",
			);
		}
		if (isReservedEnvKey(key)) {
			this.exitWithError(
				`"${key}" is a reserved env var and cannot be set. Reserved: ${RESERVED_ENV_KEYS.join(", ")}`,
			);
		}
		if (!isStorableSecretKey(key)) {
			// Reserved was handled above, so this is specifically an invalid name.
			this.exitWithError(
				`"${key}" is not a valid environment variable name.`,
			);
		}
		this.openSecretStore().set(email, key, value);
		this.logSuccess(`Set ${key} for ${email}.`);
	}

	private secretsUnset(email: string | undefined, key: string | undefined): void {
		if (!email || !key) {
			this.exitWithError(
				"Usage: cyrus router secrets unset <email> <ENV_VAR_NAME>",
			);
		}
		if (isReservedEnvKey(key)) {
			this.exitWithError(
				`"${key}" is a reserved env var. Reserved: ${RESERVED_ENV_KEYS.join(", ")}`,
			);
		}
		this.openSecretStore().set(email, key, undefined);
		this.logSuccess(`Unset ${key} for ${email}.`);
	}
```

The `isStorableSecretKey` guard gives a clean CLI error for an invalid name before `SecretStore.set` would throw a raw error. (`isStorableSecretKey` is also used by the Task 2 schema refine, so the import is never unused.)

- [ ] **Step 3: Add `resolveRequiredSecretKeys` (additive/effective set)**

Next to `resolveSecretsPath`, add:

```typescript
	/**
	 * The EFFECTIVE required set the running router enforces: the always-on
	 * Claude token plus `containers.requiredSecretKeys` from router-config.json.
	 * Read the same way `resolveSecretsPath` reads the config so `secrets list`
	 * matches what actually blocks boot.
	 */
	private resolveRequiredSecretKeys(): string[] {
		const configPath = join(
			resolvePath(this.app.cyrusHome),
			"router-config.json",
		);
		let configured: string[] = [];
		if (existsSync(configPath)) {
			try {
				const raw = JSON.parse(readFileSync(configPath, "utf-8"));
				const parsed = RouterConfigFileSchema.safeParse(raw);
				if (parsed.success && parsed.data.containers?.requiredSecretKeys) {
					configured = parsed.data.containers.requiredSecretKeys;
				}
			} catch {
				// fall through to default-only
			}
		}
		return [...new Set([...DEFAULT_REQUIRED_SECRET_KEYS, ...configured])];
	}
```

- [ ] **Step 4: Add `secretsList` + register it**

Update the `secrets` dispatcher:

```typescript
	private async secrets(rest: string[]): Promise<void> {
		const [action, ...secretRest] = rest;
		switch (action) {
			case "set":
				return this.secretsSet(secretRest[0], secretRest[1], secretRest[2]);
			case "unset":
				return this.secretsUnset(secretRest[0], secretRest[1]);
			case "list":
				return this.secretsList(secretRest[0]);
			default:
				this.exitWithError(
					"Usage: cyrus router secrets <set <email> <ENV_VAR_NAME> <value>|unset <email> <ENV_VAR_NAME>|list <email>>",
				);
		}
	}

	private secretsList(email: string | undefined): void {
		if (!email) {
			this.exitWithError("Usage: cyrus router secrets list <email>");
		}
		const store = this.openSecretStore();
		const bundle = store.get(email);
		const keys = Object.keys(bundle).sort();
		if (keys.length === 0) {
			this.logger.info(`No secrets stored for ${email}.`);
		} else {
			this.logger.raw(`Stored secrets for ${email}:`);
			for (const key of keys) this.logger.raw(`  ${key} = ****`);
		}
		const requiredKeys = this.resolveRequiredSecretKeys();
		const { ok, missing } = store.isFullyAuthenticated(email, requiredKeys);
		if (ok) {
			this.logSuccess(`${email} is fully authenticated for containers.`);
		} else {
			this.logger.warn(
				`${email} is NOT fully authenticated: missing ${missing.join(", ")}. Set them with: cyrus router secrets set ${email} <KEY> <value>`,
			);
		}
	}
```

Update the class doc-comment usage list and the top-level `execute` default usage string to include `secrets list <email>` and `<ENV_VAR_NAME>`.

- [ ] **Step 5: Remove `USER_SECRET_KEYS`**

Delete the `USER_SECRET_KEYS` const + doc-comment from `packages/router/src/SecretStore.ts`, and remove it from the `packages/router/src/index.ts` export list.

- [ ] **Step 6: Update + extend `RouterCommand.test.ts`**

The harness mocks `process.exit` to throw `Error("process.exit called with <code>")`; assert rejections with `.rejects.toThrow(/process\.exit called with 1/)` and inspect `app.logger.error`.

1. Remove `USER_SECRET_KEYS` from the `cyrus-router` import (line ~4).
2. Update legacy-key usages to env-var names, in args AND read-back assertions:
   - `"githubPat"` → `"GIT_TOKEN"`, `.get(...).githubPat` → `.GIT_TOKEN` (lines ~307, ~368, ~395-402).
   - `"gitUserName"` → `"GIT_USER_NAME"` (line ~346).
   - `"dotfilesRepo"` → `"DOTFILES_REPO"`, `.get(...).dotfilesRepo` → `.DOTFILES_REPO` (the unset "removes a previously set secret" test, lines ~430-451).
3. Repurpose the two now-invalid "unknown key" tests (arbitrary keys are now accepted):
   - Replace `"rejects an unknown secret key and lists the valid ones"` (lines ~406-426) with a reserved-rejection test:

```typescript
it("rejects a reserved env key on set", async () => {
	const app = createMockApp(cyrusHome);
	await expect(
		new RouterCommand(app as any).execute([
			"secrets", "set", "henry@example.com", "CYRUS_ROUTER_URL", "http://evil",
		]),
	).rejects.toThrow(/process\.exit called with 1/);
	const msg = String(
		(app.logger.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
	);
	expect(msg).toContain("reserved env var");
	expect(msg).toContain("CYRUS_ROUTER_URL");
});
```

   - Replace `"rejects an unknown secret key"` (unset, lines ~454-461) with:

```typescript
it("rejects a reserved env key on unset", async () => {
	const app = createMockApp(cyrusHome);
	await expect(
		new RouterCommand(app as any).execute([
			"secrets", "unset", "ivy@example.com", "NODE_OPTIONS",
		]),
	).rejects.toThrow(/process\.exit called with 1/);
});
```

4. Add a `secrets list` masking test (default set → fully authed):

```typescript
describe("secrets list", () => {
	it("lists stored keys masked and reports fully authenticated (default set)", async () => {
		const app = createMockApp(cyrusHome);
		await new RouterCommand(app as any).execute([
			"secrets", "set", "ivy@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "claude-secret-value",
		]);
		const app2 = createMockApp(cyrusHome);
		await new RouterCommand(app2 as any).execute(["secrets", "list", "ivy@example.com"]);
		const raw = (app2.logger.raw as ReturnType<typeof vi.fn>).mock.calls
			.map((c) => String(c[0]))
			.join("\n");
		expect(raw).toContain("CLAUDE_CODE_OAUTH_TOKEN = ****");
		expect(raw).not.toContain("claude-secret-value");
		expect(app2.logger.success).toHaveBeenCalledWith(
			expect.stringContaining("fully authenticated"),
		);
	});

	it("flags a required key missing per containers.requiredSecretKeys", async () => {
		writeFileSync(
			join(cyrusHome, "router-config.json"),
			JSON.stringify({
				port: 8787,
				workspaces: {},
				webhook: { verificationMode: "direct", secret: "shh" },
				containers: {
					image: "ghcr.io/example/cyrus-worker:latest",
					routerUrlForContainers: "ws://host.docker.internal:8787",
					repositories: [],
					requiredSecretKeys: ["GIT_TOKEN"],
				},
			}),
		);
		const app = createMockApp(cyrusHome);
		await new RouterCommand(app as any).execute([
			"secrets", "set", "kai@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "claude-tok",
		]);
		const app2 = createMockApp(cyrusHome);
		await new RouterCommand(app2 as any).execute(["secrets", "list", "kai@example.com"]);
		expect(app2.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("missing GIT_TOKEN"),
		);
	});
});
```

The second test is the deterministic guard for the whole Task 2 chain: it proves `containers.requiredSecretKeys` survives `RouterConfigFileSchema.parse` (the Zod "strips unknown keys" gotcha) AND is read into the effective set. (`writeFileSync`/`join` are already imported in this file.)

- [ ] **Step 7: Run cli + router tests + typecheck**

Run: `pnpm --filter cyrus-ai test:run src/commands/RouterCommand.test.ts && pnpm --filter cyrus-ai typecheck && pnpm --filter cyrus-router typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/cli/src/commands/RouterCommand.ts apps/cli/src/commands/RouterCommand.test.ts packages/router/src/SecretStore.ts packages/router/src/index.ts
git commit -m "feat(cli): raw env-var secret keys, reserved/invalid rejection, secrets list"
```

---

### Task 4: Container Linear MCP via `LINEAR_API_TOKEN` (writeConfig)

Inside the container, `writeConfig` populates `linearWorkspaces[<repo.linearWorkspaceId>] = { linearToken: <LINEAR_API_TOKEN> }`, so the existing `getLinearTokenForWorkspace` → `McpConfigService` path wires the hosted Linear MCP. No MCP code changes here (Task 5 covers the comment/test).

**Files:**
- Modify: `apps/cli/src/commands/ContainerBootCommand.ts` (`writeConfig`)
- Test: `apps/cli/src/commands/ContainerBootCommand.test.ts`

**Interfaces:**
- Consumes: `EdgeConfigSchema` / `LinearWorkspaceConfigSchema` — `linearWorkspaces` is `z.record(z.string(), { linearToken: z.string(), … }).optional()`, keyed by workspace ID.

- [ ] **Step 1: Write failing tests**

Inside `describe("writeConfig (step 5)", …)`:

```typescript
it("populates linearWorkspaces from LINEAR_API_TOKEN and validates against EdgeConfigSchema", () => {
	const cmd = newCommand({ env: { ...baseEnv(), LINEAR_API_TOKEN: "lin_api_tok" } });
	cmd.writeConfig({
		workspacesDir,
		routerUrl: "https://router.example.com",
		deviceToken: "device-tok",
		repos,
	});
	const written = JSON.parse(
		readFileSync(join(workspacesDir, ".cyrus", "config.json"), "utf-8"),
	);
	expect(EdgeConfigSchema.safeParse(written).success).toBe(true);
	expect(written.linearWorkspaces).toEqual({
		"ws-1": { linearToken: "lin_api_tok" },
		"ws-2": { linearToken: "lin_api_tok" },
	});
});

it("omits linearWorkspaces when LINEAR_API_TOKEN is absent", () => {
	const cmd = newCommand();
	cmd.writeConfig({
		workspacesDir,
		routerUrl: "https://router.example.com",
		deviceToken: "device-tok",
		repos,
	});
	const written = JSON.parse(
		readFileSync(join(workspacesDir, ".cyrus", "config.json"), "utf-8"),
	);
	expect(written.linearWorkspaces).toBeUndefined();
});
```

(`repos` is the two-repo `const` already declared at the top of this describe block — `ws-1`/`ws-2`.)

- [ ] **Step 2: Run to verify FAIL**

Run: `pnpm --filter cyrus-ai test:run src/commands/ContainerBootCommand.test.ts -t "linearWorkspaces"`
Expected: FAIL (`written.linearWorkspaces` is `undefined`).

- [ ] **Step 3: Implement in `writeConfig`**

Replace the `const config = EdgeConfigSchema.parse({...})` block with:

```typescript
		// LINEAR_API_TOKEN is an ordinary passthrough env. Its only special
		// handling: when present, populate linearWorkspaces so the existing
		// device-mode Linear MCP wiring (getLinearTokenForWorkspace →
		// McpConfigService) authenticates the hosted Linear MCP with it. A
		// container cannot do interactive OAuth. One user holds one Linear
		// token, so it is applied to every configured workspace id.
		const linearApiToken = this.env.LINEAR_API_TOKEN;
		const linearWorkspaces = linearApiToken
			? opts.repos.reduce<Record<string, { linearToken: string }>>(
					(acc, repo) => {
						acc[repo.linearWorkspaceId] = { linearToken: linearApiToken };
						return acc;
					},
					{},
				)
			: undefined;

		const config = EdgeConfigSchema.parse({
			platform: "router" as const,
			router: {
				url: opts.routerUrl,
				deviceToken: opts.deviceToken,
				floorSync: true,
			},
			repositories,
			...(linearWorkspaces ? { linearWorkspaces } : {}),
		});
```

- [ ] **Step 4: Run to verify PASS (incl. pre-existing writeConfig tests)**

Run: `pnpm --filter cyrus-ai test:run src/commands/ContainerBootCommand.test.ts`
Expected: PASS. The idempotency test uses `baseEnv()` (no `LINEAR_API_TOKEN`), so it is unaffected.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/ContainerBootCommand.ts apps/cli/src/commands/ContainerBootCommand.test.ts
git commit -m "feat(container): populate linearWorkspaces from per-user LINEAR_API_TOKEN"
```

---

### Task 5: Router-mode Linear MCP — correct comments + positive wiring test

Task 4 makes a router-mode device able to hold a Linear token (via `linearWorkspaces`), which contradicts two "router devices never hold a Linear token" comments and is unproven by tests. Fix the comments and add a positive `McpConfigService` test asserting the hosted `linear` server IS emitted (with the Bearer header) when a static token is present.

**Files:**
- Modify: `packages/edge-worker/src/McpConfigService.ts` (comment at lines ~127-131)
- Modify: `packages/edge-worker/src/EdgeWorker.ts` (comment at lines ~570-572)
- Test: `packages/edge-worker/test/McpConfigService.router-mode.test.ts`

**Interfaces:**
- Consumes: existing `McpConfigService.buildMcpConfig` + `getLinearTokenForWorkspace` dep (unchanged behavior; this task only adds a test + fixes comments).

- [ ] **Step 1: Add the positive router-mode test**

Append to `describe("McpConfigService router mode", …)` in the test file:

```typescript
	it("emits the token-authenticated Linear MCP in router mode when a static per-user token is provisioned", () => {
		const tracker = makeTracker({ transport: "router", workspaceId: "ws-1" });
		const service = new McpConfigService({
			getLinearTokenForWorkspace: () => "lin_api_static",
			getIssueTracker: () => tracker,
			getCyrusToolsMcpUrl: () => "http://127.0.0.1:3456/mcp/cyrus-tools",
			createCyrusToolsOptions: () => ({}),
		});

		const config = service.buildMcpConfig("repo-1", "ws-1", "parent-1");

		expect(config["cyrus-tools"]).toBeDefined();
		expect(config.linear).toEqual({
			type: "http",
			url: "https://mcp.linear.app/mcp",
			headers: { Authorization: "Bearer lin_api_static" },
		});
	});
```

- [ ] **Step 2: Run to verify it passes against the CURRENT code**

Run: `pnpm --filter cyrus-edge-worker test:run test/McpConfigService.router-mode.test.ts`
Expected: PASS — the wiring already supports this; the test documents/guards it. (If the edge-worker package filter name differs, confirm via `node -e "console.log(require('./packages/edge-worker/package.json').name)"`.)

- [ ] **Step 3: Correct the `McpConfigService.ts` comment**

Replace the comment above the `mcpConfig` object (currently "…router-mode devices have none (users install the Linear MCP locally with their own OAuth), so it is omitted there.") with:

```typescript
			// Workspace-level MCP servers — configured once regardless of repo count.
			// The token-authenticated official Linear MCP server (https://linear.app/docs/mcp)
			// is emitted only when we actually hold a Linear token. Router-mode
			// devices usually have none (users install the Linear MCP locally with
			// their own OAuth), so it is omitted — UNLESS an operator provisions a
			// static per-user Linear token (LINEAR_API_TOKEN → linearWorkspaces) for
			// a container, in which case getLinearTokenForWorkspace returns it and
			// the server IS emitted here.
```

- [ ] **Step 4: Correct the `EdgeWorker.ts` router-mode comment**

Update the comment at lines ~570-572 to:

```typescript
		// Router mode: create ONE shared device-side connection to the router.
		// The device holds no Linear tokens for issue-tracker operations — those
		// are forwarded to the router over this connection. (An operator MAY
		// still provision a static per-user Linear token via config.linearWorkspaces
		// — from LINEAR_API_TOKEN — purely to authenticate the hosted Linear MCP
		// inside the container's Claude session; that path does not go through the
		// router connection.)
```

- [ ] **Step 5: Run edge-worker suite + typecheck**

Run: `pnpm --filter cyrus-edge-worker test:run && pnpm --filter cyrus-edge-worker typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/edge-worker/src/McpConfigService.ts packages/edge-worker/src/EdgeWorker.ts packages/edge-worker/test/McpConfigService.router-mode.test.ts
git commit -m "docs+test(edge-worker): router mode may hold a static Linear MCP token"
```

---

### Task 6: F1 `router:seed-user` — env-var token + repeatable `--env`

Keeps `--claude-token` (stored under `CLAUDE_CODE_OAUTH_TOKEN`) and adds repeatable `--env KEY=VALUE`, so F1 drives can seed e.g. `LINEAR_API_TOKEN`. The `--env` parser never echoes a value.

**Files:**
- Modify: `apps/f1/src/router/RouterRig.ts`
- Modify: `apps/f1/src/router/ControlServer.ts`
- Modify: `apps/f1/src/commands/router/seedUser.ts`
- Test: `apps/f1/test/router/router-rig.test.ts` (or `router-commands.test.ts` — whichever exercises `seedUser`)

**Interfaces:**
- Consumes: `SecretStore.set(email, key, value)` (Task 1).
- Produces: `RouterRig.seedUser({ email, linearId, provider, claudeOauthToken, env? })`; `parseEnvPairs(pairs: string[]): Record<string, string>`.

- [ ] **Step 1: Extend `RouterRig.seedUser`**

In `apps/f1/src/router/RouterRig.ts`, update the interface method and the implementation:

```typescript
	seedUser(opts: {
		email: string;
		linearId: string;
		provider: string;
		claudeOauthToken: string;
		env?: Record<string, string>;
	}): void;
```

```typescript
		seedUser({ email, linearId, provider, claudeOauthToken, env }) {
			server.store.addUser({ email, linearId });
			server.store.setUserExecutor(email, JSON.stringify({ type: provider }));
			secrets.set(email, "CLAUDE_CODE_OAUTH_TOKEN", claudeOauthToken);
			for (const [key, value] of Object.entries(env ?? {})) {
				secrets.set(email, key, value);
			}
		},
```

- [ ] **Step 2: Accept `env` in the control route**

In `apps/f1/src/router/ControlServer.ts`, extend the `/router/seed-user` body type to include `env?: Record<string, string>` and pass the whole body to `opts.rig.seedUser(b)` (already the shape).

- [ ] **Step 3: Add leak-safe repeatable `--env`**

In `apps/f1/src/commands/router/seedUser.ts`:

```typescript
interface RouterSeedUserOptions {
	email: string;
	linearId: string;
	provider: string;
	claudeToken: string;
	env: string[];
}

function collect(value: string, previous: string[]): string[] {
	return previous.concat([value]);
}

/** Parses KEY=VALUE pairs. Never includes a VALUE in an error (it may be a secret). */
export function parseEnvPairs(pairs: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of pairs) {
		const eq = pair.indexOf("=");
		if (eq <= 0) {
			throw new Error(
				"--env expects KEY=VALUE with a non-empty key (value omitted from this error)",
			);
		}
		out[pair.slice(0, eq)] = pair.slice(eq + 1);
	}
	return out;
}
```

Add the option + wire it in `.action`:

```typescript
		.option("--env <KEY=VALUE>", "Extra container env var (repeatable)", collect, [])
		.action(async (o: RouterSeedUserOptions) => {
			await controlPost("/router/seed-user", {
				email: o.email,
				linearId: o.linearId,
				provider: o.provider,
				claudeOauthToken: o.claudeToken,
				env: parseEnvPairs(o.env),
			});
			console.log(success(`Seeded user ${o.email} (${o.provider})`));
		});
```

- [ ] **Step 4: Tests**

In the F1 router test dir, add:
- A rig test asserting a seeded `env` entry lands in the store under its raw key AND the Claude token is under `CLAUDE_CODE_OAUTH_TOKEN`:

```typescript
rig.seedUser({
	email: "drive@example.com",
	linearId: "lin-1",
	provider: "docker",
	claudeOauthToken: "claude-tok",
	env: { LINEAR_API_TOKEN: "lin_api_1" },
});
const stored = new SecretStore(secretsPath).get("drive@example.com");
expect(stored.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-tok");
expect(stored.LINEAR_API_TOKEN).toBe("lin_api_1");
```

- A `parseEnvPairs` unit test proving repeatable parsing and that a malformed pair error does NOT include the value:

```typescript
expect(parseEnvPairs(["A=1", "B=x=y"])).toEqual({ A: "1", B: "x=y" });
expect(() => parseEnvPairs(["SECRETVALUE_NO_EQ"])).toThrow(/value omitted/);
```

- A ControlServer `env` round-trip test if the existing suite already exercises `/router/seed-user` over HTTP; otherwise the rig test above is sufficient. (Import `SecretStore` from `cyrus-router`; use the rig's `secretsPath` fixture.)

- [ ] **Step 5: Run F1 tests + typecheck**

Run: `pnpm --filter cyrus-f1 test:run && pnpm --filter cyrus-f1 typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/f1/src/router/RouterRig.ts apps/f1/src/router/ControlServer.ts apps/f1/src/commands/router/seedUser.ts apps/f1/test/router/
git commit -m "feat(f1): seed CLAUDE_CODE_OAUTH_TOKEN + leak-safe repeatable --env"
```

---

### Task 7: Docs + CHANGELOG

Documents adding tools + per-user credentials, corrects the existing legacy secret names in the worker runbook, and records user-facing changes.

**Files:**
- Modify: `docker/worker/README.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Fix existing legacy names in `docker/worker/README.md`**

Search the README for `claudeOauthToken`, `githubPat`, `gitUserName`, `gitUserEmail`, `dotfilesRepo` (setup section ~line 189, troubleshooting ~line 386, the environment/optional-fields table ~line 461). Replace each with its env-var name (`CLAUDE_CODE_OAUTH_TOKEN`, `GIT_TOKEN`, `GIT_USER_NAME`, `GIT_USER_EMAIL`, `DOTFILES_REPO`) and update any `cyrus router secrets set <email> claudeOauthToken …` examples to `… CLAUDE_CODE_OAUTH_TOKEN …`. Add a `requiredSecretKeys` row/example to the config section.

- [ ] **Step 2: Add "Adding tools to the worker container"**

New section, in order of preference:

1. **Overlay image (recommended):**

```dockerfile
FROM ghcr.io/ceedaragents/cyrus-worker:0.2.66
USER root
RUN npm install -g @openai/codex   # example: add the Codex CLI
USER cyrus
```

Build + push it, point `containers.image` in `router-config.json` at the new tag, restart the router. No app rebuild.

2. **`cyrus-setup.sh`** (repo-local, non-privileged, per-worktree at boot) and **`dotfilesRepo`** (per-user `install.sh` at boot) — note they re-run every boot and cannot `sudo`.

3. **Per-user tool credentials:**

```bash
cyrus router secrets set alice@example.com LINEAR_API_TOKEN lin_api_xxx
cyrus router secrets list alice@example.com   # keys masked; shows missing required
```

Document:
- The value appears verbatim in the container env; **interactive OAuth is NOT possible in a container** — use a Linear Personal API Key or a pre-obtained OAuth access token. `LINEAR_API_TOKEN` additionally enables the hosted Linear MCP inside the Claude session.
- **Required set:** operators define extra required credentials via `containers.requiredSecretKeys` in `router-config.json`; the Claude token is always required on top. A user missing any required key is blocked from booting with a Linear boot-failure activity naming the missing keys.
- **Reserved keys** (rejected): `CYRUS_ROUTER_URL`, `CYRUS_DEVICE_TOKEN`, `CYRUS_ISSUE_KEY`, `CYRUS_REPOS_JSON`, `CYRUS_WORKSPACES_DIR`, `CYRUS_REPO_CACHE_DIR`, `PATH`, `HOME`, `NODE_OPTIONS`. Stored keys must be valid env-var names.
- **Rotation limitation:** changing or adding a secret takes effect on the issue's next *fresh* container boot. To apply immediately to an in-flight issue, destroy the container first: `cyrus router containers destroy <issueKey>` (it is recreated on the next routed event with the new env).

- [ ] **Step 3: Update `CHANGELOG.md`**

Under `## [Unreleased]`:

```markdown
### Added
- Router operators can store arbitrary per-user environment variables for containers with `cyrus router secrets set <email> <ENV_VAR> <value>`, so any tool that authenticates via env vars works without code changes.
- `cyrus router secrets list <email>` shows a user's stored secret keys (values masked) and which required credentials are still missing.
- Containers run the full hosted Linear MCP in their Claude session when a `LINEAR_API_TOKEN` secret is set for the user.
- Operators can require extra credentials before a user's containers boot via `containers.requiredSecretKeys` in the router config (the Claude OAuth token is always required).

### Changed
- Per-user container secrets are now keyed by the real environment-variable name (e.g. `CLAUDE_CODE_OAUTH_TOKEN`, `GIT_TOKEN`). Existing stored secrets are migrated automatically.
```

- [ ] **Step 4: Commit**

```bash
git add docker/worker/README.md CHANGELOG.md
git commit -m "docs: per-user container secrets, worker tool-adding guide, changelog"
```

---

### Task 8: Full verification (incl. mandatory F1 drive)

Per the repo mandate (`AGENTS.md` / root `CLAUDE.md`): the F1 test-drive protocol is a REQUIRED validation stage for this work, not optional.

**Files:** none (verification only).

- [ ] **Step 1: Monorepo typecheck**

Run: `pnpm typecheck` — Expected: PASS.

- [ ] **Step 2: Package suites**

Run: `pnpm test:packages:run` — Expected: PASS.

- [ ] **Step 3: CLI + F1 suites**

Run: `pnpm --filter cyrus-ai test:run && pnpm --filter cyrus-f1 test:run` — Expected: PASS.

- [ ] **Step 4: Lint + build**

Run: `pnpm lint && pnpm build` — Expected: PASS.

- [ ] **Step 5: F1 container test drive (required)**

Follow the F1 router-mode container drive (see `apps/f1/test-drives/` and the F1 skill). Seed a user with a real Claude token AND `LINEAR_API_TOKEN` via `f1 router:seed-user … --env LINEAR_API_TOKEN=<token>`, route an issue to a docker container, and verify:
  - the boot succeeds (a user missing `LINEAR_API_TOKEN` when it is in `requiredSecretKeys` is blocked with a boot-failure activity naming it);
  - the container session's `mcpServerNames` includes `linear`;
  - an authenticated Linear MCP operation succeeds inside the session.
Requires a Docker daemon + a real Linear API key. Record the drive under `apps/f1/test-drives/`.

- [ ] **Step 6: Final commit (only if verification required fixes — stage explicit files)**

```bash
git status                      # review exactly what changed
git add <the specific files you changed>   # NOT `git add -A`
git commit -m "chore: verification fixes for per-user container secrets"
```

---

## Notes for the implementer

- **Migration is read-time only**, and `set` normalizes a legacy key to its env-var name before mutating — so updating/unsetting `githubPat` correctly targets `GIT_TOKEN`. Never add a separate one-shot migration pass; the "corrupt/invalid file throws, never resets" invariant (now including shape validation) must stay intact.
- **The gate is additive:** `CLAUDE_CODE_OAUTH_TOKEN` is always required (the container hard-requires it); `requiredSecretKeys` only adds. Don't let a config drop it.
- **`CYRUS_DEVICE_TOKEN` is minted by the provider** (appended after `ctx.env` in `LocalDockerProvider.ensureRunning`); `buildEnv` never sets it — it's reserved only so a user can't try.
- **Zod strips unknown keys.** The likeliest silent failure is omitting `requiredSecretKeys` from `RouterConfigFileSchema.containers` (Task 2 Step 3). Task 3's second `secrets list` test is the guard.
- **Secret rotation is a documented limitation**, not a feature here: a running/stopped container keeps its original env; `cyrus router containers destroy <issueKey>` forces a fresh boot with new secrets.
- **Never print secret values** — `secrets list` masks with `****`; F1's `--env` parse error omits the value; CLI set/unset echo only key names.
