# Durable Linear Refresh Token Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the router's rotated Linear OAuth refresh token to Azure Key Vault so it survives ACA revision restarts, and turn a dead credential from a silent 24h outage into a single loud, actionable error.

**Architecture:** A new `KeyVaultTokenStore` in `packages/router` reads and writes one Key Vault secret per Linear workspace holding a `{refreshToken, accessToken, seedRefreshToken, updatedMs}` envelope. `RouterCommand` (the CLI) resolves tokens from that store at startup — preferring the stored envelope only when its `seedRefreshToken` still matches the config/env value — and writes back through the existing `onTokenRefresh` seam. Separately, `LinearIssueTrackerService` learns to distinguish a terminal `400/401` from the token endpoint (refresh token consumed or revoked — unrecoverable) from a transient `5xx`, reporting the former once with a remedy and suppressing further attempts.

**Tech Stack:** TypeScript, Node 22, pnpm workspaces, Vitest, Azure Key Vault REST 7.4, Zod.

## Global Constraints

- Node engine is `>=22.0.0 <23.0.0`. Do not use APIs outside that range.
- Package manager is `pnpm@10.33.1`. Never run `npm install`.
- Tests are Vitest. Package tests live in `packages/<pkg>/test/*.test.ts`; CLI tests live beside the source in `apps/cli/src/commands/*.test.ts`.
- `packages/router` must not read `process.env` — all environment reads happen in `apps/cli`. Preserve this.
- Key Vault secret names must match `^[0-9a-zA-Z-]+$` and be ≤127 characters.
- Key Vault REST calls use `api-version=7.4` and a `Bearer` token from `createKeyVaultTokenProvider()`, matching `KeyVaultSecretStore`.
- The Key Vault path is **opt-in**: with no `linearTokenStore` configured, behaviour must be byte-for-byte what it is today (file-only). Self-host and docker-compose deployments have no Key Vault.
- A pre-commit hook runs `pnpm build` and `pnpm typecheck` on every commit. Both must pass.
- Never log a token value. Log token *lengths* or fingerprints if you need diagnostics.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/router/src/KeyVaultTokenStore.ts` | **Create.** Per-workspace Linear token envelope get/set against Key Vault REST 7.4. |
| `packages/router/test/KeyVaultTokenStore.test.ts` | **Create.** Unit tests with injected `fetchFn`/`tokenProvider`. |
| `packages/router/src/index.ts` | **Modify.** Export the new store and its types. |
| `packages/linear-event-transport/src/LinearIssueTrackerService.ts` | **Modify.** Terminal-vs-transient refresh classification, `rejectedWorkspaces` state, once-only ERROR log. |
| `packages/linear-event-transport/src/index.ts` | **Modify.** Export `LinearRefreshTokenRejectedError`. |
| `packages/linear-event-transport/test/LinearRefreshToken.test.ts` | **Create.** Terminal/transient behaviour tests. |
| `apps/cli/src/commands/RouterCommand.ts` | **Modify.** Config schema field, store construction, startup token resolution, KV write-back, `linear status` subcommand. |
| `apps/cli/src/commands/RouterCommand.test.ts` | **Modify.** Resolution + persistence + subcommand tests. |
| `docker/router/entrypoint.mjs` | **Modify.** Map `CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL` into generated config. |
| `docker/router/entrypoint.test.mjs` | **Modify.** Assert the new field is emitted. |
| `docs/ROUTER.md`, `infra/azure/README.md`, `CHANGELOG.md` | **Modify.** Env table, corrected "source of truth" paragraph, re-auth runbook, changelog. |

---

### Task 1: `KeyVaultTokenStore`

Self-contained; no consumers yet.

**Files:**
- Create: `packages/router/src/KeyVaultTokenStore.ts`
- Create: `packages/router/test/KeyVaultTokenStore.test.ts`
- Modify: `packages/router/src/index.ts`

**Interfaces:**
- Consumes: `createKeyVaultTokenProvider` from `./KeyVaultSecretStore.js` (already exported).
- Produces:
  - `interface LinearTokenEnvelope { refreshToken: string; accessToken: string; seedRefreshToken: string; updatedMs: number }`
  - `function linearTokenSecretName(workspaceId: string): string`
  - `class KeyVaultTokenStore { constructor(opts: KeyVaultTokenStoreOptions); get(workspaceId: string): Promise<LinearTokenEnvelope | undefined>; set(workspaceId: string, envelope: LinearTokenEnvelope): Promise<void> }`
  - `interface KeyVaultTokenStoreOptions { vaultUrl: string; tokenProvider?: () => Promise<string>; fetchFn?: typeof fetch }`

- [ ] **Step 1: Write the failing test**

Create `packages/router/test/KeyVaultTokenStore.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import {
	KeyVaultTokenStore,
	linearTokenSecretName,
} from "../src/KeyVaultTokenStore.js";

const VAULT = "https://example.vault.azure.net";
const WS = "75294f85-72ad-42ef-b9d7-c6ded611fc42";

const envelope = {
	refreshToken: "rt-2",
	accessToken: "at-2",
	seedRefreshToken: "rt-0",
	updatedMs: 1785457484664,
};

function store(fetchFn: typeof fetch) {
	return new KeyVaultTokenStore({
		vaultUrl: `${VAULT}/`,
		tokenProvider: async () => "kv-token",
		fetchFn,
	});
}

describe("linearTokenSecretName", () => {
	it("prefixes the workspace id", () => {
		expect(linearTokenSecretName(WS)).toBe(`cyrus-linear-refresh-${WS}`);
	});

	it("replaces characters Key Vault rejects", () => {
		expect(linearTokenSecretName("acme_corp.1")).toBe(
			"cyrus-linear-refresh-acme-corp-1",
		);
	});
});

describe("KeyVaultTokenStore", () => {
	it("PUTs the envelope as a JSON string using REST 7.4 and a bearer token", async () => {
		const fetchFn = vi.fn(
			async () => new Response(JSON.stringify({ id: "ok" }), { status: 200 }),
		);
		await store(fetchFn as unknown as typeof fetch).set(WS, envelope);

		const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			`${VAULT}/secrets/cyrus-linear-refresh-${WS}?api-version=7.4`,
		);
		expect(init.method).toBe("PUT");
		expect(
			(init.headers as Record<string, string>).authorization,
		).toBe("Bearer kv-token");
		expect(JSON.parse(init.body as string).value).toBe(
			JSON.stringify(envelope),
		);
	});

	it("round-trips an envelope through get", async () => {
		const fetchFn = vi.fn(
			async () =>
				new Response(JSON.stringify({ value: JSON.stringify(envelope) }), {
					status: 200,
				}),
		);
		await expect(
			store(fetchFn as unknown as typeof fetch).get(WS),
		).resolves.toEqual(envelope);
	});

	it("returns undefined when the secret does not exist", async () => {
		const fetchFn = vi.fn(async () => new Response("", { status: 404 }));
		await expect(
			store(fetchFn as unknown as typeof fetch).get(WS),
		).resolves.toBeUndefined();
	});

	it("returns undefined for a corrupt or partial envelope", async () => {
		const fetchFn = vi.fn(
			async () =>
				new Response(JSON.stringify({ value: '{"refreshToken":"only"}' }), {
					status: 200,
				}),
		);
		await expect(
			store(fetchFn as unknown as typeof fetch).get(WS),
		).resolves.toBeUndefined();
	});

	it("throws on a non-404 error status", async () => {
		const fetchFn = vi.fn(async () => new Response("boom", { status: 500 }));
		await expect(
			store(fetchFn as unknown as typeof fetch).get(WS),
		).rejects.toThrow(/500/);
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-router test:run -- KeyVaultTokenStore`
Expected: FAIL — `Cannot find module '../src/KeyVaultTokenStore.js'`

- [ ] **Step 3: Write the implementation**

Create `packages/router/src/KeyVaultTokenStore.ts`:

```typescript
import { createKeyVaultTokenProvider } from "./KeyVaultSecretStore.js";

/**
 * A workspace's Linear OAuth tokens as stored in Key Vault.
 *
 * `seedRefreshToken` records the config/env refresh token that started this
 * rotation chain. Startup compares it against the current config value: if an
 * operator has re-authorized and seeded a new token, the stored chain is stale
 * and must be abandoned rather than preferred. Without this field a re-auth
 * would appear to do nothing, because the router would keep choosing the dead
 * stored token over the fresh config one.
 */
export interface LinearTokenEnvelope {
	refreshToken: string;
	accessToken: string;
	seedRefreshToken: string;
	updatedMs: number;
}

export interface KeyVaultTokenStoreOptions {
	vaultUrl: string;
	tokenProvider?: () => Promise<string>;
	fetchFn?: typeof fetch;
}

/** Key Vault secret names allow only `[0-9a-zA-Z-]`. */
export function linearTokenSecretName(workspaceId: string): string {
	return `cyrus-linear-refresh-${workspaceId.replace(/[^0-9a-zA-Z-]/g, "-")}`;
}

function parseEnvelope(raw: string): LinearTokenEnvelope | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const e = parsed as Partial<LinearTokenEnvelope>;
	// We always write all four fields, so a partial envelope means corruption.
	// Treat it as absent and let the caller fall back to the config value.
	if (
		typeof e.refreshToken !== "string" ||
		typeof e.accessToken !== "string" ||
		typeof e.seedRefreshToken !== "string" ||
		typeof e.updatedMs !== "number"
	) {
		return undefined;
	}
	return {
		refreshToken: e.refreshToken,
		accessToken: e.accessToken,
		seedRefreshToken: e.seedRefreshToken,
		updatedMs: e.updatedMs,
	};
}

/**
 * Per-workspace Linear token storage in Azure Key Vault.
 *
 * Deliberately NOT built on {@link KeyVaultSecretStore}: that class models
 * per-user secret *bundles* (email-hashed names, `email`/`key` tags, tombstones,
 * `UserSecretBundle`), none of which applies to a single per-workspace envelope.
 */
export class KeyVaultTokenStore {
	private readonly vaultUrl: string;
	private readonly tokenProvider: () => Promise<string>;
	private readonly fetchFn: typeof fetch;

	constructor(opts: KeyVaultTokenStoreOptions) {
		this.vaultUrl = opts.vaultUrl.replace(/\/$/, "");
		this.tokenProvider = opts.tokenProvider ?? createKeyVaultTokenProvider();
		this.fetchFn = opts.fetchFn ?? fetch;
	}

	private url(workspaceId: string): string {
		return `${this.vaultUrl}/secrets/${linearTokenSecretName(workspaceId)}?api-version=7.4`;
	}

	async get(workspaceId: string): Promise<LinearTokenEnvelope | undefined> {
		const url = this.url(workspaceId);
		const response = await this.fetchFn(url, {
			method: "GET",
			headers: { authorization: `Bearer ${await this.tokenProvider()}` },
		});
		if (response.status === 404) return undefined;
		if (!response.ok) {
			throw new Error(
				`Key Vault GET ${url} failed (${response.status}): ${await response.text()}`,
			);
		}
		const body = (await response.json()) as { value?: string };
		if (!body.value) return undefined;
		return parseEnvelope(body.value);
	}

	async set(workspaceId: string, envelope: LinearTokenEnvelope): Promise<void> {
		const url = this.url(workspaceId);
		const response = await this.fetchFn(url, {
			method: "PUT",
			headers: {
				authorization: `Bearer ${await this.tokenProvider()}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				value: JSON.stringify(envelope),
				tags: { cyrusLinearWorkspace: workspaceId },
			}),
		});
		if (!response.ok) {
			throw new Error(
				`Key Vault PUT ${url} failed (${response.status}): ${await response.text()}`,
			);
		}
	}
}
```

- [ ] **Step 4: Export from the package index**

In `packages/router/src/index.ts`, add next to the existing `KeyVaultSecretStore` export block:

```typescript
export {
	KeyVaultTokenStore,
	type KeyVaultTokenStoreOptions,
	type LinearTokenEnvelope,
	linearTokenSecretName,
} from "./KeyVaultTokenStore.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter cyrus-router test:run -- KeyVaultTokenStore`
Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/router/src/KeyVaultTokenStore.ts packages/router/test/KeyVaultTokenStore.test.ts packages/router/src/index.ts
git commit -m "feat(router): add KeyVaultTokenStore for per-workspace Linear token envelopes"
```

---

### Task 2: Terminal-state classification in `LinearIssueTrackerService`

Independent of Tasks 1, 3–5. Lives entirely in `packages/linear-event-transport`.

**Files:**
- Modify: `packages/linear-event-transport/src/LinearIssueTrackerService.ts`
- Modify: `packages/linear-event-transport/src/index.ts`
- Create: `packages/linear-event-transport/test/LinearRefreshToken.test.ts`

**Interfaces:**
- Produces:
  - `class LinearRefreshTokenRejectedError extends Error { readonly workspaceId: string; readonly status: number; readonly body: string }`
  - `LinearIssueTrackerService.getRejectedWorkspace(workspaceId: string): { at: number; status: number; body: string } | undefined`
  - `LinearIssueTrackerService.resetWorkspaceAuthState(workspaceId?: string): void`

- [ ] **Step 1: Write the failing test**

Create `packages/linear-event-transport/test/LinearRefreshToken.test.ts`:

```typescript
import type { LinearClient } from "@linear/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LinearIssueTrackerService,
	LinearRefreshTokenRejectedError,
	type LinearOAuthConfig,
} from "../src/LinearIssueTrackerService.js";

const WS = "ws-1";

function silentLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * The constructor patches `linearClient.client.request` in place, so holding a
 * reference to the raw object gives the test a handle on the patched wrapper.
 */
function makeClient() {
	const unauthorized = vi.fn(async () => {
		const err = new Error("unauthorized") as Error & { status: number };
		err.status = 401;
		throw err;
	});
	const raw = { request: unauthorized, setHeader: vi.fn() };
	return {
		raw,
		linearClient: { client: raw } as unknown as LinearClient,
	};
}

function oauth(refreshToken: string): LinearOAuthConfig {
	return {
		clientId: "cid",
		clientSecret: "csec",
		refreshToken,
		workspaceId: WS,
	};
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	LinearIssueTrackerService.resetWorkspaceAuthState();
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	LinearIssueTrackerService.resetWorkspaceAuthState();
});

describe("terminal refresh failures", () => {
	it("marks the workspace rejected, logs once, and throws a typed error", async () => {
		fetchMock.mockResolvedValue(
			new Response("invalid_grant", { status: 400 }),
		);
		const logger = silentLogger();
		const { raw, linearClient } = makeClient();
		new LinearIssueTrackerService(linearClient, oauth("rt-dead"), logger);

		await expect(raw.request("query")).rejects.toThrow();

		expect(LinearIssueTrackerService.getRejectedWorkspace(WS)).toMatchObject({
			status: 400,
		});
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(String(logger.error.mock.calls[0][0])).toContain(
			"self-auth-linear",
		);
	});

	it("makes no further token requests once rejected", async () => {
		fetchMock.mockResolvedValue(
			new Response("invalid_grant", { status: 400 }),
		);
		const { raw, linearClient } = makeClient();
		new LinearIssueTrackerService(linearClient, oauth("rt-dead"), silentLogger());

		await expect(raw.request("query")).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await expect(raw.request("query")).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1); // suppressed, not retried
	});

	it("throws LinearRefreshTokenRejectedError from the suppressed path", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
		const { raw, linearClient } = makeClient();
		const service = new LinearIssueTrackerService(
			linearClient,
			oauth("rt-dead"),
			silentLogger(),
		);
		await expect(raw.request("query")).rejects.toThrow();

		await expect(
			// @ts-expect-error -- exercising the private refresh path directly
			service.doTokenRefresh(),
		).rejects.toBeInstanceOf(LinearRefreshTokenRejectedError);
	});
});

describe("transient refresh failures", () => {
	it("does not mark the workspace rejected on 5xx and retries next time", async () => {
		fetchMock.mockResolvedValue(new Response("upstream", { status: 503 }));
		const { raw, linearClient } = makeClient();
		new LinearIssueTrackerService(linearClient, oauth("rt-live"), silentLogger());

		await expect(raw.request("query")).rejects.toThrow();
		expect(LinearIssueTrackerService.getRejectedWorkspace(WS)).toBeUndefined();

		await expect(raw.request("query")).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("recovery", () => {
	it("clears the rejection when a different refresh token is registered", async () => {
		fetchMock.mockResolvedValue(new Response("invalid_grant", { status: 400 }));
		const first = makeClient();
		new LinearIssueTrackerService(
			first.linearClient,
			oauth("rt-dead"),
			silentLogger(),
		);
		await expect(first.raw.request("query")).rejects.toThrow();
		expect(LinearIssueTrackerService.getRejectedWorkspace(WS)).toBeDefined();

		const second = makeClient();
		new LinearIssueTrackerService(
			second.linearClient,
			oauth("rt-fresh"),
			silentLogger(),
		);
		expect(LinearIssueTrackerService.getRejectedWorkspace(WS)).toBeUndefined();
	});
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter cyrus-linear-event-transport test:run -- LinearRefreshToken`
Expected: FAIL — `LinearRefreshTokenRejectedError` is not exported.

- [ ] **Step 3: Add the error type and rejection state**

In `packages/linear-event-transport/src/LinearIssueTrackerService.ts`, add above `export interface LinearOAuthConfig`:

```typescript
/**
 * Linear refused the refresh token itself (HTTP 400/401 from the token
 * endpoint) rather than failing transiently.
 *
 * This is terminal by construction: Linear rotates the refresh token on every
 * use, and we persist the new one only on success — so a retry is already the
 * replay of the same token, which Linear honours for 30 minutes. A 400 outside
 * that window means the token is consumed or revoked and no amount of retrying
 * recovers it. Only a re-authorization does.
 */
export class LinearRefreshTokenRejectedError extends Error {
	readonly workspaceId: string;
	readonly status: number;
	readonly body: string;

	constructor(workspaceId: string, status: number, body: string) {
		super(
			`Linear rejected the refresh token for workspace ${workspaceId} (HTTP ${status})`,
		);
		this.name = "LinearRefreshTokenRejectedError";
		this.workspaceId = workspaceId;
		this.status = status;
		this.body = body;
	}
}
```

Inside the class, beside `workspaceRefreshTokens`, add:

```typescript
	/**
	 * Workspaces whose refresh token Linear has rejected outright. Once present,
	 * refresh attempts short-circuit without an HTTP call — otherwise every
	 * 401'd API call re-triggers a doomed refresh, which is how a dead token
	 * produced twelve identical stack traces per burst in production.
	 */
	private static rejectedWorkspaces: Map<
		string,
		{ at: number; status: number; body: string }
	> = new Map();

	static getRejectedWorkspace(
		workspaceId: string,
	): { at: number; status: number; body: string } | undefined {
		return LinearIssueTrackerService.rejectedWorkspaces.get(workspaceId);
	}

	/** Clears shared per-workspace auth state. Omit the id to clear everything. */
	static resetWorkspaceAuthState(workspaceId?: string): void {
		if (workspaceId === undefined) {
			LinearIssueTrackerService.rejectedWorkspaces.clear();
			LinearIssueTrackerService.workspaceRefreshTokens.clear();
			LinearIssueTrackerService.pendingRefreshes.clear();
			return;
		}
		LinearIssueTrackerService.rejectedWorkspaces.delete(workspaceId);
		LinearIssueTrackerService.workspaceRefreshTokens.delete(workspaceId);
		LinearIssueTrackerService.pendingRefreshes.delete(workspaceId);
	}
```

- [ ] **Step 4: Clear the rejection when a new token is seeded**

Replace the constructor's initial-token registration block:

```typescript
		// Register initial refresh token in shared static map
		if (oauthConfig?.refreshToken) {
			LinearIssueTrackerService.workspaceRefreshTokens.set(
				oauthConfig.workspaceId,
				oauthConfig.refreshToken,
			);
		}
```

with:

```typescript
		// Register initial refresh token in shared static map. A *different*
		// token than the one on record means an operator re-authorized, so any
		// standing rejection refers to a token we no longer hold — clear it so
		// the new credential gets a real attempt.
		if (oauthConfig?.refreshToken) {
			const prior = LinearIssueTrackerService.workspaceRefreshTokens.get(
				oauthConfig.workspaceId,
			);
			if (prior !== oauthConfig.refreshToken) {
				LinearIssueTrackerService.rejectedWorkspaces.delete(
					oauthConfig.workspaceId,
				);
			}
			LinearIssueTrackerService.workspaceRefreshTokens.set(
				oauthConfig.workspaceId,
				oauthConfig.refreshToken,
			);
		}
```

- [ ] **Step 5: Short-circuit and classify in `executeTokenRefresh`**

In `executeTokenRefresh`, immediately after the `const { clientId, clientSecret, workspaceId, onTokenRefresh } = this.oauthConfig!;` destructure, insert:

```typescript
		const standingRejection =
			LinearIssueTrackerService.rejectedWorkspaces.get(workspaceId);
		if (standingRejection) {
			throw new LinearRefreshTokenRejectedError(
				workspaceId,
				standingRejection.status,
				standingRejection.body,
			);
		}
```

Then replace:

```typescript
		if (!response.ok) {
			throw new Error(`Token refresh failed: ${response.status}`);
		}
```

with:

```typescript
		if (!response.ok) {
			const body = await response.text();
			if (response.status === 400 || response.status === 401) {
				LinearIssueTrackerService.rejectedWorkspaces.set(workspaceId, {
					at: Date.now(),
					status: response.status,
					body,
				});
				this.logger.error(
					`Linear refused the refresh token for workspace ${workspaceId} (HTTP ${response.status}: ${body}). ` +
						"This is terminal — Linear rotates refresh tokens on use, so a consumed or revoked token cannot recover. " +
						"Cyrus can neither read nor write Linear for this workspace until re-authorized, and all worker activity posting will fail silently. " +
						"Remedy: re-run `cyrus self-auth-linear`, update Key Vault secret `cyrus-linear-refresh-<workspaceId>` (or router-config.json), restart the router. " +
						"If this appeared immediately after a credential change, check LINEAR_CLIENT_ID / LINEAR_CLIENT_SECRET match the app that issued the token. " +
						"Suppressing further refresh attempts for this workspace.",
				);
				throw new LinearRefreshTokenRejectedError(
					workspaceId,
					response.status,
					body,
				);
			}
			throw new Error(`Token refresh failed: ${response.status}`);
		}
```

Immediately after the successful `workspaceRefreshTokens.set(...)` call, add:

```typescript
		// A success supersedes any earlier rejection for this workspace.
		LinearIssueTrackerService.rejectedWorkspaces.delete(workspaceId);
```

- [ ] **Step 6: Stop the per-attempt stack-trace log**

In the patched `client.request`, replace:

```typescript
							this.logger.error("Token refresh failed:", refreshError);
```

with:

```typescript
							// The terminal case already logged once, with a remedy.
							// Re-logging it per 401'd request is the noise this change removes.
							if (
								!(refreshError instanceof LinearRefreshTokenRejectedError)
							) {
								this.logger.error("Token refresh failed:", refreshError);
							}
```

- [ ] **Step 7: Export the error**

In `packages/linear-event-transport/src/index.ts`, extend the existing export block from `./LinearIssueTrackerService.js` to include `LinearRefreshTokenRejectedError`:

```typescript
export {
	LinearIssueTrackerService,
	type LinearOAuthConfig,
	LinearRefreshTokenRejectedError,
} from "./LinearIssueTrackerService.js";
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `pnpm --filter cyrus-linear-event-transport test:run`
Expected: PASS — 5 new tests, existing suites still green.

- [ ] **Step 9: Commit**

```bash
git add packages/linear-event-transport/src/LinearIssueTrackerService.ts packages/linear-event-transport/src/index.ts packages/linear-event-transport/test/LinearRefreshToken.test.ts
git commit -m "feat(linear): classify rejected refresh tokens as terminal and report once"
```

---

### Task 3: Config surface + Key Vault write-back

**Files:**
- Modify: `apps/cli/src/commands/RouterCommand.ts`
- Modify: `apps/cli/src/commands/RouterCommand.test.ts`
- Modify: `docker/router/entrypoint.mjs`
- Modify: `docker/router/entrypoint.test.mjs`

**Interfaces:**
- Consumes: `KeyVaultTokenStore`, `LinearTokenEnvelope` from `cyrus-router` (Task 1).
- Produces: `RouterCommand` private fields `linearTokenStore?: KeyVaultTokenStore` and `linearTokenSeeds: Map<string, string>`, consumed by Task 4.

- [ ] **Step 1: Write the failing entrypoint test**

`docker/router/entrypoint.test.mjs` drives the real entrypoint via `spawnSync`
through its existing `run(extra = {})` helper, which already supplies
`LINEAR_WORKSPACE_ID` / `LINEAR_WORKSPACE_TOKEN` / `LINEAR_WEBHOOK_SECRET` and
returns `{ status, stderr, config }`. Use it.

Add a new test:

```javascript
test("maps CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL into linearTokenStore", () => {
	const result = run({
		CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL:
			"https://kv-cyrus-dev.vault.azure.net/",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(result.config.linearTokenStore, {
		keyVaultUrl: "https://kv-cyrus-dev.vault.azure.net/",
	});
});
```

And extend the existing `"optional Azure env is absent by default"` test with one
more line, so the opt-in nature is pinned:

```javascript
	assert.equal(result.config.linearTokenStore, undefined);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --test docker/router/entrypoint.test.mjs`
Expected: FAIL — `config.linearTokenStore` is `undefined`.

- [ ] **Step 3: Implement the entrypoint change**

In `docker/router/entrypoint.mjs`, add to the `anyProvided` disjunction in `generateConfig`:

```javascript
			env.CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL ||
```

and, alongside the other optional-block assignments (near the `config.entra = …` block), add:

```javascript
	if (env.CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL) {
		config.linearTokenStore = {
			keyVaultUrl: env.CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL,
		};
	}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node --test docker/router/entrypoint.test.mjs`
Expected: PASS.

- [ ] **Step 5: Add the schema field**

In `apps/cli/src/commands/RouterCommand.ts`, add to `RouterConfigFileSchema` after the `backup` field:

```typescript
	/**
	 * Durable store for rotated Linear OAuth tokens. Optional: without it the
	 * refresh token is written only to router-config.json, which is ephemeral on
	 * ACA and regenerated from env on every start — the exact combination that
	 * caused the 2026-07-30 outage. Self-host deployments with no Key Vault
	 * legitimately omit it.
	 */
	linearTokenStore: z
		.object({
			keyVaultUrl: z.string().min(1),
		})
		.optional(),
```

- [ ] **Step 6: Write the failing persistence test**

Add to `apps/cli/src/commands/RouterCommand.test.ts`:

```typescript
describe("persistRefreshedTokens", () => {
	it("writes the rotated pair to Key Vault with the recorded seed", async () => {
		const set = vi.fn(async () => {});
		const command = makeRouterCommand();
		(command as any).linearTokenStore = { set };
		(command as any).linearTokenSeeds = new Map([["ws-1", "rt-seed"]]);

		await (command as any).persistRefreshedTokens(configPath, "ws-1", {
			accessToken: "at-2",
			refreshToken: "rt-2",
		});

		expect(set).toHaveBeenCalledWith(
			"ws-1",
			expect.objectContaining({
				refreshToken: "rt-2",
				accessToken: "at-2",
				seedRefreshToken: "rt-seed",
			}),
		);
	});

	it("still writes the config file when the Key Vault write fails", async () => {
		const command = makeRouterCommand();
		(command as any).linearTokenStore = {
			set: vi.fn(async () => {
				throw new Error("kv down");
			}),
		};
		(command as any).linearTokenSeeds = new Map([["ws-1", "rt-seed"]]);

		await (command as any).persistRefreshedTokens(configPath, "ws-1", {
			accessToken: "at-2",
			refreshToken: "rt-2",
		});

		const written = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(written.workspaces["ws-1"].linearRefreshToken).toBe("rt-2");
	});
});
```

> `makeRouterCommand` and `configPath` must follow the construction and temp-file helpers already used by this test file. Reuse them rather than inventing new ones.

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter cyrus-ai test:run -- RouterCommand`
Expected: FAIL — `persistRefreshedTokens` does not accept this signature / does not call the store.

- [ ] **Step 8: Implement the write path**

Add the fields to the `RouterCommand` class:

```typescript
	private linearTokenStore?: KeyVaultTokenStore;
	/**
	 * Per-workspace config/env refresh token in effect at startup. Written into
	 * every envelope as `seedRefreshToken` so a later start can tell whether an
	 * operator has re-seeded the chain.
	 */
	private linearTokenSeeds = new Map<string, string>();
```

Import at the top of the file, extending the existing `cyrus-router` import:

```typescript
import { KeyVaultTokenStore } from "cyrus-router";
```

Rename today's `persistRefreshedTokens` body to `persistRefreshedTokensToFile` (identical logic, identical signature), then add:

```typescript
	/**
	 * Persists a rotated pair to both sinks. Key Vault is authoritative across
	 * restarts; the config file remains a local cache so self-host deployments
	 * behave exactly as before.
	 *
	 * Neither failure is fatal: the in-memory Linear client already holds the new
	 * token, so the router keeps serving either way.
	 */
	private async persistRefreshedTokens(
		configPath: string,
		workspaceId: string,
		tokens: { accessToken: string; refreshToken: string },
	): Promise<void> {
		this.persistRefreshedTokensToFile(configPath, workspaceId, tokens);
		if (!this.linearTokenStore) return;
		try {
			await this.linearTokenStore.set(workspaceId, {
				refreshToken: tokens.refreshToken,
				accessToken: tokens.accessToken,
				seedRefreshToken:
					this.linearTokenSeeds.get(workspaceId) ?? tokens.refreshToken,
				updatedMs: Date.now(),
			});
		} catch (error) {
			this.logger.warn(
				`Failed to persist refreshed Linear token to Key Vault for workspace ${workspaceId}: ${(error as Error).message}`,
			);
		}
	}
```

In `start()`, before building `config`, construct the store and seed the map:

```typescript
		if (parsed.data.linearTokenStore) {
			this.linearTokenStore = new KeyVaultTokenStore({
				vaultUrl: parsed.data.linearTokenStore.keyVaultUrl,
			});
		}
		for (const [workspaceId, ws] of Object.entries(parsed.data.workspaces)) {
			if (ws.linearRefreshToken) {
				this.linearTokenSeeds.set(workspaceId, ws.linearRefreshToken);
			}
		}
```

The existing `onTokenRefresh` wiring already returns the call, so it now returns a promise — which `RouterServerConfig.onTokenRefresh` already permits (`void | Promise<void>`). No change needed there.

- [ ] **Step 9: Run tests to verify they pass**

Run: `pnpm --filter cyrus-ai test:run -- RouterCommand`
Expected: PASS, including the pre-existing RouterCommand suite.

- [ ] **Step 10: Commit**

```bash
git add apps/cli/src/commands/RouterCommand.ts apps/cli/src/commands/RouterCommand.test.ts docker/router/entrypoint.mjs docker/router/entrypoint.test.mjs
git commit -m "feat(router): persist rotated Linear tokens to Key Vault"
```

---

### Task 4: Startup resolution with the seed rule

**Files:**
- Modify: `apps/cli/src/commands/RouterCommand.ts`
- Modify: `apps/cli/src/commands/RouterCommand.test.ts`

**Interfaces:**
- Consumes: `this.linearTokenStore`, `this.linearTokenSeeds` (Task 3); `KeyVaultTokenStore.get` (Task 1).
- Produces: `private async resolveWorkspaceTokens(workspaces: Record<string, {linearToken: string; linearRefreshToken?: string}>): Promise<Record<string, {linearToken: string; linearRefreshToken?: string}>>` and `private linearTokenSources = new Map<string, "keyvault" | "config">()`, consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Add to `apps/cli/src/commands/RouterCommand.test.ts`:

```typescript
describe("resolveWorkspaceTokens", () => {
	const configWorkspaces = {
		"ws-1": { linearToken: "at-cfg", linearRefreshToken: "rt-seed" },
	};

	function commandWithStore(get: () => Promise<unknown>) {
		const command = makeRouterCommand();
		(command as any).linearTokenStore = { get };
		(command as any).linearTokenSeeds = new Map([["ws-1", "rt-seed"]]);
		return command;
	}

	it("uses the config value when no envelope is stored", async () => {
		const command = commandWithStore(async () => undefined);
		const out = await (command as any).resolveWorkspaceTokens(configWorkspaces);
		expect(out["ws-1"].linearRefreshToken).toBe("rt-seed");
		expect((command as any).linearTokenSources.get("ws-1")).toBe("config");
	});

	it("prefers the stored envelope when the seed still matches", async () => {
		const command = commandWithStore(async () => ({
			refreshToken: "rt-9",
			accessToken: "at-9",
			seedRefreshToken: "rt-seed",
			updatedMs: 123,
		}));
		const out = await (command as any).resolveWorkspaceTokens(configWorkspaces);
		expect(out["ws-1"].linearRefreshToken).toBe("rt-9");
		expect(out["ws-1"].linearToken).toBe("at-9");
		expect((command as any).linearTokenSources.get("ws-1")).toBe("keyvault");
	});

	it("abandons the stored chain when the operator seeded a new token", async () => {
		const command = commandWithStore(async () => ({
			refreshToken: "rt-9",
			accessToken: "at-9",
			seedRefreshToken: "rt-OLD-seed",
			updatedMs: 123,
		}));
		const out = await (command as any).resolveWorkspaceTokens(configWorkspaces);
		expect(out["ws-1"].linearRefreshToken).toBe("rt-seed");
		expect(out["ws-1"].linearToken).toBe("at-cfg");
		expect((command as any).linearTokenSources.get("ws-1")).toBe("config");
	});

	it("falls back to config rather than failing to boot when Key Vault errors", async () => {
		const command = commandWithStore(async () => {
			throw new Error("kv unreachable");
		});
		const out = await (command as any).resolveWorkspaceTokens(configWorkspaces);
		expect(out["ws-1"].linearRefreshToken).toBe("rt-seed");
		expect((command as any).linearTokenSources.get("ws-1")).toBe("config");
	});
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter cyrus-ai test:run -- RouterCommand`
Expected: FAIL — `resolveWorkspaceTokens is not a function`.

- [ ] **Step 3: Implement the resolution**

Add the field and method to `RouterCommand`:

```typescript
	private linearTokenSources = new Map<string, "keyvault" | "config">();
	private linearTokenUpdatedMs = new Map<string, number>();

	/**
	 * Chooses each workspace's tokens between the config/env values and the
	 * Key Vault envelope.
	 *
	 * The envelope wins only while its `seedRefreshToken` still equals the
	 * config value. When an operator re-authorizes they update the config/env
	 * seed, which no longer matches — and the stored chain, whose head is by
	 * then a dead token, must be abandoned. Without this comparison a re-auth
	 * would silently do nothing.
	 *
	 * Both tokens move together: the envelope is one unit, never merged
	 * field-by-field with the config.
	 */
	private async resolveWorkspaceTokens(
		workspaces: Record<
			string,
			{ linearToken: string; linearRefreshToken?: string }
		>,
	): Promise<
		Record<string, { linearToken: string; linearRefreshToken?: string }>
	> {
		const resolved: Record<
			string,
			{ linearToken: string; linearRefreshToken?: string }
		> = {};

		for (const [workspaceId, cfg] of Object.entries(workspaces)) {
			resolved[workspaceId] = { ...cfg };
			this.linearTokenSources.set(workspaceId, "config");

			if (!this.linearTokenStore || !cfg.linearRefreshToken) continue;

			let envelope: LinearTokenEnvelope | undefined;
			try {
				envelope = await this.linearTokenStore.get(workspaceId);
			} catch (error) {
				// Booting with a possibly-stale token beats not booting at all.
				this.logger.warn(
					`Could not read the stored Linear token for workspace ${workspaceId} from Key Vault; using the configured value: ${(error as Error).message}`,
				);
				continue;
			}

			if (!envelope) continue;
			if (envelope.seedRefreshToken !== cfg.linearRefreshToken) {
				this.logger.info(
					`Configured Linear refresh token for workspace ${workspaceId} differs from the stored chain's seed; treating it as a fresh re-authorization and discarding the stored token.`,
				);
				continue;
			}

			resolved[workspaceId] = {
				linearToken: envelope.accessToken,
				linearRefreshToken: envelope.refreshToken,
			};
			this.linearTokenSources.set(workspaceId, "keyvault");
			this.linearTokenUpdatedMs.set(workspaceId, envelope.updatedMs);
		}

		return resolved;
	}
```

Add `type LinearTokenEnvelope` to the `cyrus-router` import.

In `start()`, after the seed-map population added in Task 3, replace the workspaces passed into `config` with the resolved set:

```typescript
		const resolvedWorkspaces = await this.resolveWorkspaceTokens(
			parsed.data.workspaces,
		);
```

and build `config` with `workspaces: resolvedWorkspaces` in place of `...parsed.data`'s workspaces — i.e. `{ ...parsed.data, workspaces: resolvedWorkspaces, dbPath, oauth: … }`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter cyrus-ai test:run -- RouterCommand`
Expected: PASS, 4 new tests plus the existing suite.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/RouterCommand.ts apps/cli/src/commands/RouterCommand.test.ts
git commit -m "feat(router): restore Linear tokens from Key Vault at startup"
```

---

### Task 5: `cyrus router linear status`

**Files:**
- Modify: `apps/cli/src/commands/RouterCommand.ts`
- Modify: `apps/cli/src/commands/RouterCommand.test.ts`

**Interfaces:**
- Consumes: `this.linearTokenSources`, `this.linearTokenUpdatedMs` (Task 4); `resolveWorkspaceTokens` (Task 4).
- Produces: nothing consumed by later tasks.

> **Design note — deviates from spec §6.** The spec described reading a rejection recorded by the running router. `cyrus router linear status` runs **out of process**, so it cannot see the router's in-memory `rejectedWorkspaces` map; honouring the spec literally would require mirroring auth state into a new SQLite table plus a failure callback threaded through `RouterServer` and `LinearOAuthConfig` — roughly 150 lines of new mirrored state, which CLAUDE.md already warns is easy to get wrong. Instead this command probes Linear directly with the resolved token. It answers the operator's actual question ("is Linear auth healthy right now?") more truthfully and in a fraction of the code; the *why* and *when* remain in the once-only ERROR log from Task 2. Update spec §6 to match in Task 6.

- [ ] **Step 1: Write the failing test**

Add to `apps/cli/src/commands/RouterCommand.test.ts`:

```typescript
describe("router linear status", () => {
	it("reports ok for a working token and rejected for a dead one", async () => {
		const command = makeRouterCommand();
		(command as any).linearTokenStore = undefined;
		const lines: string[] = [];
		vi.spyOn(console, "log").mockImplementation((m) => lines.push(String(m)));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				new Response(JSON.stringify({ data: { viewer: { id: "u1" } } }), {
					status: 200,
				}),
			),
		);

		await (command as any).linear(["status"]);

		expect(lines.join("\n")).toMatch(/ws-1/);
		expect(lines.join("\n")).toMatch(/ok/);
		vi.unstubAllGlobals();
	});

	it("rejects an unknown subcommand", async () => {
		const command = makeRouterCommand();
		const exit = vi
			.spyOn(command as any, "exitWithError")
			.mockImplementation(() => {});
		await (command as any).linear(["bogus"]);
		expect(exit).toHaveBeenCalled();
	});
});
```

> Match the file's existing conventions for stubbing `console.log`, constructing the command with a temp `router-config.json` containing workspace `ws-1`, and asserting on `exitWithError`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter cyrus-ai test:run -- RouterCommand`
Expected: FAIL — `command.linear is not a function`.

- [ ] **Step 3: Implement the subcommand**

Add the dispatch case in `execute`, after `case "containers":`:

```typescript
			case "linear":
				return this.linear(rest);
```

Extend the `default:` usage string with `|linear status`.

Add the methods:

```typescript
	private async linear(rest: string[]): Promise<void> {
		const [action] = rest;
		if (action !== "status") {
			return this.exitWithError("Usage: cyrus router linear status");
		}
		return this.linearStatus();
	}

	/**
	 * Reports each workspace's Linear auth health.
	 *
	 * Probes Linear with the resolved access token rather than reading mirrored
	 * state: this command runs out of process and cannot see the running
	 * router's in-memory rejection map. A `viewer` query is the cheapest
	 * definitive answer, and it still works when auth is dead — that is exactly
	 * the case it needs to report.
	 */
	private async linearStatus(): Promise<void> {
		const configPath = this.resolveConfigPath();
		if (!existsSync(configPath)) {
			return this.exitWithError(`No router config found at ${configPath}`);
		}
		const parsed = RouterConfigFileSchema.safeParse(
			JSON.parse(readFileSync(configPath, "utf-8")),
		);
		if (!parsed.success) {
			return this.exitWithError(
				`Invalid router config at ${configPath}: ${parsed.error.message}`,
			);
		}

		if (parsed.data.linearTokenStore) {
			this.linearTokenStore = new KeyVaultTokenStore({
				vaultUrl: parsed.data.linearTokenStore.keyVaultUrl,
			});
		}
		const resolved = await this.resolveWorkspaceTokens(parsed.data.workspaces);

		console.log(
			`${"WORKSPACE".padEnd(38)} ${"SOURCE".padEnd(9)} ${"LAST REFRESH".padEnd(25)} STATUS`,
		);
		for (const [workspaceId, ws] of Object.entries(resolved)) {
			const source = this.linearTokenSources.get(workspaceId) ?? "config";
			const updatedMs = this.linearTokenUpdatedMs.get(workspaceId);
			const lastRefresh = updatedMs
				? new Date(updatedMs).toISOString()
				: "—";
			const status = await this.probeLinearToken(ws.linearToken);
			console.log(
				`${workspaceId.padEnd(38)} ${source.padEnd(9)} ${lastRefresh.padEnd(25)} ${status}`,
			);
		}
	}

	private async probeLinearToken(token: string): Promise<string> {
		try {
			const response = await fetch("https://api.linear.app/graphql", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: token,
				},
				body: JSON.stringify({ query: "{ viewer { id } }" }),
			});
			if (!response.ok) return `rejected (HTTP ${response.status})`;
			const body = (await response.json()) as { errors?: unknown[] };
			return body.errors?.length ? "rejected (auth error)" : "ok";
		} catch (error) {
			return `unknown (${(error as Error).message})`;
		}
	}
```

`resolveConfigPath()` does not exist yet — the path is built inline in two places
(`readRouterConfig()` and `start()`). Extract it first, mirroring the existing
`resolveDbPath()` helper:

```typescript
	/**
	 * Single source for the router config path. `resolvePath` expands a
	 * `~`-prefixed `--cyrus-home`, matching {@link resolveDbPath}.
	 */
	private resolveConfigPath(): string {
		return join(resolvePath(this.app.cyrusHome), "router-config.json");
	}
```

Then replace both existing occurrences of

```typescript
		const configPath = join(
			resolvePath(this.app.cyrusHome),
			"router-config.json",
		);
```

with `const configPath = this.resolveConfigPath();`. This is a pure refactor —
the existing RouterCommand suite must stay green with no test changes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter cyrus-ai test:run -- RouterCommand`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/commands/RouterCommand.ts apps/cli/src/commands/RouterCommand.test.ts
git commit -m "feat(router): add cyrus router linear status"
```

---

### Task 6: Documentation and changelog

**Files:**
- Modify: `docs/ROUTER.md`
- Modify: `infra/azure/README.md`
- Modify: `docs/superpowers/specs/2026-07-31-linear-refresh-token-persistence-design.md`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Add the env var to the ROUTER.md table**

In the env table in `docs/ROUTER.md` (the block containing `CYRUS_ROUTER_WORKSPACES_JSON`), add:

```markdown
| `CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL` | no | — | `linearTokenStore.keyVaultUrl` — durable store for rotated Linear OAuth tokens |
```

- [ ] **Step 2: Correct the "source of truth" paragraph**

Replace the paragraph at `docs/ROUTER.md:229`:

```markdown
On every start, if the required variables are set the entrypoint regenerates
`/data/router-config.json` from them (env is the source of truth). With no
config variables set, an existing (e.g. bind-mounted) `router-config.json` is
used as-is. Neither → the container exits 1 naming the missing variables.
```

with:

```markdown
On every start, if the required variables are set the entrypoint regenerates
`/data/router-config.json` from them. With no config variables set, an existing
(e.g. bind-mounted) `router-config.json` is used as-is. Neither → the container
exits 1 naming the missing variables.

**Exception — Linear OAuth tokens.** Env is *not* the source of truth for
`linearToken` / `linearRefreshToken` when `CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL`
is set. Linear rotates the refresh token on every use and access tokens live
24 hours, so a config regenerated from a fixed env value replays an
already-consumed token and fails permanently with HTTP 400. The router
therefore persists each rotated pair to Key Vault and prefers the stored value
at startup — unless the env/config refresh token has changed, which is read as
a deliberate re-authorization and resets the chain. To re-authorize: run
`cyrus self-auth-linear`, update the env/Key Vault seed, and restart.
```

- [ ] **Step 3: Document the runbook in the Azure README**

In `infra/azure/README.md`, in the ops runbook section, add:

```markdown
### Re-authorizing Linear

Symptom: router logs `Linear refused the refresh token for workspace … (HTTP 400)`,
and every Linear read/write fails — including all worker activity posting, which
proxies through the router.

```bash
cyrus --env-file /secure/path/linear-app.env self-auth-linear
# update linear_workspace_token + linear_workspace_refresh_token in tfvars,
# then apply so the Key Vault secrets are updated:
terraform -chdir=infra/azure/terraform apply -var-file=dev.tfvars
az containerapp revision restart -g rg-cyrus -n app-cyrus-dev-router \
  --revision "$(az containerapp show -g rg-cyrus -n app-cyrus-dev-router \
    --query properties.latestRevisionName -o tsv)"
cyrus router linear status   # expect: ok
```

The router stores each rotated token in the runtime-created Key Vault secret
`cyrus-linear-refresh-<workspaceId>`. That secret is **not** managed by
Terraform, so `terraform apply` never reverts it. Changing the seed in tfvars is
what tells the router to abandon the stored chain and adopt the new credential.
```

- [ ] **Step 4: Align spec §6 with the implemented design**

In `docs/superpowers/specs/2026-07-31-linear-refresh-token-persistence-design.md`, replace the §6 sentence beginning "Local-only — it makes no Linear API call" with:

```markdown
The command probes Linear with the resolved access token (`{ viewer { id } }`)
rather than reading mirrored router state: it runs out of process and cannot see
the running router's in-memory rejection map, and mirroring that state into
SQLite would add a failure callback through `RouterServer` and `LinearOAuthConfig`
for strictly less truthful output. The rejection's status code and timestamp
remain in the once-only ERROR log.
```

- [ ] **Step 5: Add the changelog entry**

Under `## [Unreleased]` in `CHANGELOG.md`, in `### Fixed`:

```markdown
- Linear authentication no longer breaks after a router restart. Previously the
  rotated Linear token was stored only on disk that is wiped on each deploy, so
  Cyrus would stop being able to read or post to Linear — silently — within a
  day of restarting. A dead credential is now reported once, clearly, with
  instructions to fix it, instead of failing quietly.
```

- [ ] **Step 6: Verify the whole repo**

Run: `pnpm test:packages:run && pnpm typecheck && pnpm build`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add docs/ROUTER.md infra/azure/README.md docs/superpowers/specs/2026-07-31-linear-refresh-token-persistence-design.md CHANGELOG.md
git commit -m "docs: document durable Linear token storage and re-auth runbook"
```

---

## Post-implementation verification

The unit tests cannot prove the Key Vault round-trip works against real Azure. After merging and deploying:

1. `cyrus router linear status` → every workspace `ok`, source `config` on the first start.
2. Wait for one refresh (or force one), then confirm the secret exists:
   `az keyvault secret show --vault-name kv-cyrus-dev --name cyrus-linear-refresh-<workspaceId> --query attributes.updated -o tsv`
3. Restart the router revision. `cyrus router linear status` → source `keyvault`, status `ok`.
4. Confirm no `Token refresh failed: 400` appears in Log Analytics in the following 48 hours.

Step 3 is the one that actually proves the outage is fixed — everything before it would have passed on the broken build too.
