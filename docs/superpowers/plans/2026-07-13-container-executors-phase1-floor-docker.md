# Container Executors Phase 1: Persistence Floor + Local Docker Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The router can serve a user's sessions from ephemeral Docker containers instead of a physical device, with git + a router-side artifact store as the persistence floor so work and Claude-session resume survive container death and executor switches.

**Architecture:** Containers are modelled as ephemeral rows in the existing `devices` table (`kind = 'container'`, one per issue). The existing durable event queue absorbs cold-start latency. A new `cyrus-workspace-sync` package builds/restores state bundles (Claude transcripts + session metadata); the edge worker uploads a bundle on session end, and a new `cyrus container-boot` CLI command restores it at container boot. A new `cyrus-router-executors` package defines the `ContainerExecutor` interface and a `LocalDockerProvider`.

**Tech Stack:** TypeScript strict, Vitest, Zod 4, better-sqlite3, Fastify v5, node-tar, docker CLI (spawned via `execFile`), pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-07-13-ephemeral-container-executors-design.md`

## Global Constraints

- `PROTOCOL_VERSION` in `packages/router-protocol/src/frames.ts` stays at `2`. Phase 1 adds NO new WebSocket frames — session metadata travels inside the artifact bundle over HTTP.
- Canonical workspace base inside every container is `/workspaces`; a single-repo issue's worktree cwd is `/workspaces/<ISSUE-KEY>` (this is what keys the Claude SDK transcript dir, `~/.claude/projects/<sanitized-cwd>/`).
- Existing behavior for `platform: "linear"`, `"cli"`, and router+physical-device deployments must not change. All new columns/config are optional with defaults preserving today's semantics.
- Package manager pnpm@10.33.1; new packages follow `packages/router-protocol/package.json` shape (`"type": "module"`, `main: dist/index.js`, scripts `build`/`test`/`test:run`/`typecheck`). New deps go in the owning package's `package.json`, never the root.
- Style: tabs, Biome via `pnpm lint`; tests in `packages/<pkg>/test/*.test.ts`; run with `pnpm --filter <pkg-name> test:run`.
- Secrets files are written with mode `0o600` and atomic tmp+rename (mirror `RouterCommand.persistRefreshedTokens`).
- One container per issue. Issue keys used in file paths, container names, and URLs must pass `/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/`.

---

### Task 1: RouterStore schema v2 — container devices + user executors

**Files:**
- Modify: `packages/router/src/RouterStore.ts`
- Test: `packages/router/test/RouterStore.test.ts` (append new describe blocks)

**Interfaces:**
- Consumes: existing `RouterStore` (schema in the `SCHEMA` constant, `sha256Hex`, `generateTokenHex`, `purgeDeviceScopedRows`).
- Produces (used by Tasks 6, 7, 8, 9):
  - `createContainerDevice(userId: number, issueKey: string, provider: string): { deviceId: number; deviceToken: string }`
  - `getContainerDeviceForIssue(issueKey: string): ContainerDeviceInfo | undefined`
  - `getDeviceInfo(deviceId: number): { kind: "device" | "container"; userId: number; issueKey?: string; provider?: string } | undefined`
  - `rotateContainerDeviceToken(deviceId: number): string`
  - `deleteContainerDevice(deviceId: number): void`
  - `listContainerDevices(): ContainerDeviceInfo[]`
  - `countSessionAffinityForDevice(deviceId: number): number`
  - `setUserExecutor(email: string, executorJson: string | null): boolean`
  - `getUserExecutor(userId: number): string | undefined`
  - `type ContainerDeviceInfo = { deviceId: number; userId: number; issueKey: string; provider: string; lastSeenMs?: number; lastRoutedMs?: number; createdMs: number }`

**Schema changes:**
- `devices` gains `kind TEXT NOT NULL DEFAULT 'device'`, `issue_key TEXT`, `provider TEXT`, `last_routed_ms INTEGER`; the inline `user_id ... UNIQUE` constraint is replaced by partial unique indexes:
  - `CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_physical_user ON devices(user_id) WHERE kind = 'device';`
  - `CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_container_issue ON devices(issue_key) WHERE kind = 'container';`
- `users` gains `executor_json TEXT` (nullable; NULL means physical device — today's behavior).
- `getDeviceForUser` must now filter `AND kind = 'device'` (a user may have many container rows).
- `devicesOfflineSince` needs no kind filter — for containers it only ever fires when a *crashed* container stranded affinity/locks past the TTL, which is exactly the reclaim we want (idle-stopped containers have no affinity rows). Add a test proving this.
- `enqueueEvent` additionally runs `UPDATE devices SET last_routed_ms = ? WHERE device_id = ?` (all kinds; harmless for physical devices, drives the container idle-stop policy).

- [ ] **Step 1: Write failing tests**

Append to `packages/router/test/RouterStore.test.ts`:

```typescript
describe("container devices (schema v2)", () => {
	it("creates a container device and finds it by issue key and token", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		const { deviceId, deviceToken } = store.createContainerDevice(
			userId,
			"CYPACK-1",
			"docker",
		);
		expect(store.getDeviceByToken(deviceToken)).toEqual({ deviceId, userId });
		expect(store.getContainerDeviceForIssue("CYPACK-1")).toMatchObject({
			deviceId,
			userId,
			issueKey: "CYPACK-1",
			provider: "docker",
		});
		expect(store.getDeviceInfo(deviceId)).toMatchObject({
			kind: "container",
			issueKey: "CYPACK-1",
		});
	});

	it("allows a physical device AND container devices for the same user", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		store.createContainerDevice(userId, "CYPACK-1", "docker");
		store.createContainerDevice(userId, "CYPACK-2", "docker");
		const code = store.mintEnrollmentCode("a@example.com", Date.now());
		const enrolled = store.redeemEnrollmentCode(code, Date.now());
		expect(enrolled).toBeDefined();
		// getDeviceForUser returns ONLY the physical device
		expect(store.getDeviceForUser(userId)?.deviceId).toBe(enrolled?.deviceId);
	});

	it("enforces one container per issue", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		store.createContainerDevice(userId, "CYPACK-1", "docker");
		expect(() =>
			store.createContainerDevice(userId, "CYPACK-1", "docker"),
		).toThrow();
	});

	it("rotates a container token, invalidating the old one", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		const { deviceId, deviceToken } = store.createContainerDevice(
			userId,
			"CYPACK-1",
			"docker",
		);
		const fresh = store.rotateContainerDeviceToken(deviceId);
		expect(store.getDeviceByToken(deviceToken)).toBeUndefined();
		expect(store.getDeviceByToken(fresh)?.deviceId).toBe(deviceId);
	});

	it("deletes a container device and purges its scoped rows", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		const { deviceId } = store.createContainerDevice(userId, "CYPACK-1", "docker");
		store.setSessionAffinity("sess-1", deviceId);
		store.deleteContainerDevice(deviceId);
		expect(store.getContainerDeviceForIssue("CYPACK-1")).toBeUndefined();
		expect(store.getSessionAffinity("sess-1")).toBeUndefined();
	});

	it("stores and reads a user executor config", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		expect(store.getUserExecutor(userId)).toBeUndefined();
		expect(store.setUserExecutor("a@example.com", '{"type":"docker"}')).toBe(true);
		expect(store.getUserExecutor(userId)).toBe('{"type":"docker"}');
		expect(store.setUserExecutor("a@example.com", null)).toBe(true);
		expect(store.getUserExecutor(userId)).toBeUndefined();
	});

	it("counts session affinity rows per device and tracks last_routed_ms", () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		const { deviceId } = store.createContainerDevice(userId, "CYPACK-1", "docker");
		expect(store.countSessionAffinityForDevice(deviceId)).toBe(0);
		store.setSessionAffinity("sess-1", deviceId);
		expect(store.countSessionAffinityForDevice(deviceId)).toBe(1);
		store.enqueueEvent(deviceId, "{}", 1000, 60_000);
		expect(store.listContainerDevices()[0]?.lastRoutedMs).toBe(1000);
	});

	it("includes crashed containers in devicesOfflineSince so stranded locks are reclaimed", () => {
		// A container that died mid-session holds affinity/locks; the existing
		// offline sweep must reclaim them exactly as for physical devices.
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		const { deviceId } = store.createContainerDevice(userId, "CYPACK-1", "docker");
		store.touchDevice(deviceId, 1000);
		expect(
			store.devicesOfflineSince(2000).map((d) => d.deviceId),
		).toContain(deviceId);
	});

	it("migrates a v1 database in place, preserving device ids and events", () => {
		// Build a v1 db by hand, then open it with RouterStore and assert the
		// old device still authenticates and its queued events survive.
		const dir = mkdtempSync(join(tmpdir(), "router-store-"));
		const dbPath = join(dir, "router.db");
		const raw = new Database(dbPath);
		raw.exec(V1_SCHEMA); // copy of the pre-migration SCHEMA constant, inline in the test
		raw.prepare("INSERT INTO users (email) VALUES ('a@example.com')").run();
		raw
			.prepare(
				"INSERT INTO devices (user_id, token_hash, created_ms, next_seq) VALUES (1, ?, 1, 2)",
			)
			.run(createHash("sha256").update("tok").digest("hex"));
		raw
			.prepare(
				"INSERT INTO events (device_id, seq, payload_json, enqueued_ms, expires_ms) VALUES (1, 1, '{}', 1, 99999999999999)",
			)
			.run();
		raw.close();

		const store = new RouterStore(dbPath);
		expect(store.getDeviceByToken("tok")).toEqual({ deviceId: 1, userId: 1 });
		expect(store.pendingEvents(1, 0, 2)).toHaveLength(1);
		// New columns usable post-migration:
		const { deviceId } = store.createContainerDevice(1, "CYPACK-1", "docker");
		expect(deviceId).toBeGreaterThan(1); // AUTOINCREMENT sequence preserved
		store.close();
	});
});
```

Add imports the test file needs: `mkdtempSync` from `node:fs`, `tmpdir` from `node:os`, `join` from `node:path`, `createHash` from `node:crypto`, `Database` from `better-sqlite3`, and define `V1_SCHEMA` as a string constant copied from the current `SCHEMA` in `RouterStore.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter cyrus-router test:run`
Expected: FAIL — `createContainerDevice is not a function` (and the migration test fails on missing columns).

- [ ] **Step 3: Implement**

In `packages/router/src/RouterStore.ts`:

1. Update the `devices` block of `SCHEMA` (fresh databases get the v2 shape directly):

```sql
CREATE TABLE IF NOT EXISTS devices (
  device_id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'device',
  issue_key TEXT,
  provider TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  created_ms INTEGER NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 1,
  last_seen_ms INTEGER,
  last_routed_ms INTEGER
);
```

and add `executor_json TEXT` to the `users` block. Add an `INDEXES` constant with the two partial unique indexes shown in the header, executed after migration.

2. Add a `migrate()` private method called from the constructor **after** `this.db.exec(SCHEMA)` and **before** `this.db.exec(INDEXES)`:

```typescript
private migrate(): void {
	const deviceCols = this.db
		.prepare("PRAGMA table_info(devices)")
		.all() as Array<{ name: string }>;
	if (deviceCols.length > 0 && !deviceCols.some((c) => c.name === "kind")) {
		// v1 -> v2 rebuild. FK enforcement must be OFF for the duration:
		// with it ON, DROP TABLE devices performs an implicit DELETE that
		// would cascade away every queued event.
		this.db.pragma("foreign_keys = OFF");
		const txn = this.db.transaction(() => {
			this.db.exec(`
				CREATE TABLE devices_v2 (
					device_id INTEGER PRIMARY KEY AUTOINCREMENT,
					user_id INTEGER NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
					kind TEXT NOT NULL DEFAULT 'device',
					issue_key TEXT,
					provider TEXT,
					token_hash TEXT NOT NULL UNIQUE,
					created_ms INTEGER NOT NULL,
					next_seq INTEGER NOT NULL DEFAULT 1,
					last_seen_ms INTEGER,
					last_routed_ms INTEGER
				);
				INSERT INTO devices_v2 (device_id, user_id, kind, token_hash, created_ms, next_seq, last_seen_ms)
					SELECT device_id, user_id, 'device', token_hash, created_ms, next_seq, last_seen_ms FROM devices;
				DROP TABLE devices;
				ALTER TABLE devices_v2 RENAME TO devices;
				INSERT OR REPLACE INTO sqlite_sequence (name, seq)
					SELECT 'devices', COALESCE(MAX(device_id), 0) FROM devices;
			`);
		});
		txn();
		this.db.pragma("foreign_keys = ON");
	}

	const userCols = this.db
		.prepare("PRAGMA table_info(users)")
		.all() as Array<{ name: string }>;
	if (userCols.length > 0 && !userCols.some((c) => c.name === "executor_json")) {
		this.db.exec("ALTER TABLE users ADD COLUMN executor_json TEXT");
	}
}
```

3. New methods (all following the existing prepared-statement style):

```typescript
export interface ContainerDeviceInfo {
	deviceId: number;
	userId: number;
	issueKey: string;
	provider: string;
	createdMs: number;
	lastSeenMs?: number;
	lastRoutedMs?: number;
}

createContainerDevice(
	userId: number,
	issueKey: string,
	provider: string,
): { deviceId: number; deviceToken: string } {
	const token = generateTokenHex();
	const result = this.db
		.prepare(
			`INSERT INTO devices (user_id, kind, issue_key, provider, token_hash, created_ms, next_seq)
			 VALUES (?, 'container', ?, ?, ?, ?, 1)`,
		)
		.run(userId, issueKey, provider, sha256Hex(token), Date.now());
	return { deviceId: Number(result.lastInsertRowid), deviceToken: token };
}

getContainerDeviceForIssue(issueKey: string): ContainerDeviceInfo | undefined {
	const row = this.db
		.prepare(
			`SELECT device_id, user_id, issue_key, provider, created_ms, last_seen_ms, last_routed_ms
			 FROM devices WHERE kind = 'container' AND issue_key = ?`,
		)
		.get(issueKey) as ContainerDeviceRow | undefined;
	return row ? toContainerDeviceInfo(row) : undefined;
}

getDeviceInfo(deviceId: number):
	| { kind: "device" | "container"; userId: number; issueKey?: string; provider?: string }
	| undefined {
	const row = this.db
		.prepare("SELECT kind, user_id, issue_key, provider FROM devices WHERE device_id = ?")
		.get(deviceId) as
		| { kind: string; user_id: number; issue_key: string | null; provider: string | null }
		| undefined;
	if (!row) return undefined;
	return {
		kind: row.kind as "device" | "container",
		userId: row.user_id,
		issueKey: row.issue_key ?? undefined,
		provider: row.provider ?? undefined,
	};
}

rotateContainerDeviceToken(deviceId: number): string {
	const token = generateTokenHex();
	const result = this.db
		.prepare("UPDATE devices SET token_hash = ? WHERE device_id = ? AND kind = 'container'")
		.run(sha256Hex(token), deviceId);
	if (result.changes === 0) throw new Error(`Unknown container device: ${deviceId}`);
	return token;
}

deleteContainerDevice(deviceId: number): void {
	const txn = this.db.transaction(() => {
		this.purgeDeviceScopedRows(deviceId);
		this.db
			.prepare("DELETE FROM devices WHERE device_id = ? AND kind = 'container'")
			.run(deviceId);
	});
	txn();
}

listContainerDevices(): ContainerDeviceInfo[] {
	const rows = this.db
		.prepare(
			`SELECT device_id, user_id, issue_key, provider, created_ms, last_seen_ms, last_routed_ms
			 FROM devices WHERE kind = 'container'`,
		)
		.all() as ContainerDeviceRow[];
	return rows.map(toContainerDeviceInfo);
}

countSessionAffinityForDevice(deviceId: number): number {
	const row = this.db
		.prepare("SELECT COUNT(*) AS n FROM session_affinity WHERE device_id = ?")
		.get(deviceId) as { n: number };
	return row.n;
}

setUserExecutor(email: string, executorJson: string | null): boolean {
	const result = this.db
		.prepare("UPDATE users SET executor_json = ? WHERE email = ? COLLATE NOCASE")
		.run(executorJson, email);
	return result.changes > 0;
}

getUserExecutor(userId: number): string | undefined {
	const row = this.db
		.prepare("SELECT executor_json FROM users WHERE user_id = ?")
		.get(userId) as { executor_json: string | null } | undefined;
	return row?.executor_json ?? undefined;
}
```

with the private row helpers:

```typescript
interface ContainerDeviceRow {
	device_id: number;
	user_id: number;
	issue_key: string;
	provider: string;
	created_ms: number;
	last_seen_ms: number | null;
	last_routed_ms: number | null;
}

function toContainerDeviceInfo(row: ContainerDeviceRow): ContainerDeviceInfo {
	return {
		deviceId: row.device_id,
		userId: row.user_id,
		issueKey: row.issue_key,
		provider: row.provider,
		createdMs: row.created_ms,
		lastSeenMs: row.last_seen_ms ?? undefined,
		lastRoutedMs: row.last_routed_ms ?? undefined,
	};
}
```

4. Edit `getDeviceForUser` SQL to `... WHERE user_id = ? AND kind = 'device'`; add the `last_routed_ms` UPDATE inside `enqueueEvent`'s transaction. Export `ContainerDeviceInfo` from `packages/router/src/index.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter cyrus-router test:run`
Expected: PASS (all pre-existing RouterStore/EventRouter/e2e tests must also still pass — they exercise the physical-device paths against the new schema).

- [ ] **Step 5: Commit**

```bash
git add packages/router/src/RouterStore.ts packages/router/src/index.ts packages/router/test/RouterStore.test.ts
git commit -m "feat(router): schema v2 — container device rows and per-user executor config"
```

---

### Task 2: SecretStore — per-user secret bundles

**Files:**
- Create: `packages/router/src/SecretStore.ts`
- Test: `packages/router/test/SecretStore.test.ts`

**Interfaces:**
- Produces (used by Tasks 6, 8, 9):
  - `type UserSecretBundle = { claudeOauthToken?: string; githubPat?: string; gitUserName?: string; gitUserEmail?: string; dotfilesRepo?: string }`
  - `class SecretStore { constructor(filePath: string); get(email: string): UserSecretBundle; set(email: string, key: keyof UserSecretBundle, value: string | undefined): void; }`

File format is a single JSON object keyed by lowercased email: `{ "a@example.com": { "claudeOauthToken": "..." } }`. Reads return `{}` for a missing file/user. Writes are atomic (tmp+rename) with mode `0o600`; `set(email, key, undefined)` deletes the key (and the user entry when empty).

- [ ] **Step 1: Write failing tests**

```typescript
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretStore } from "../src/SecretStore.js";

describe("SecretStore", () => {
	const freshPath = () =>
		join(mkdtempSync(join(tmpdir(), "secrets-")), "user-secrets.json");

	it("returns empty bundle for unknown user / missing file", () => {
		expect(new SecretStore(freshPath()).get("a@example.com")).toEqual({});
	});

	it("sets, persists, and case-insensitively reads values with 0600 perms", () => {
		const path = freshPath();
		const store = new SecretStore(path);
		store.set("A@Example.com", "claudeOauthToken", "tok-1");
		expect(new SecretStore(path).get("a@example.com").claudeOauthToken).toBe("tok-1");
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("deletes a key when set to undefined", () => {
		const path = freshPath();
		const store = new SecretStore(path);
		store.set("a@example.com", "githubPat", "pat");
		store.set("a@example.com", "githubPat", undefined);
		expect(store.get("a@example.com")).toEqual({});
	});
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter cyrus-router test:run` → FAIL (module not found).

- [ ] **Step 3: Implement `SecretStore.ts`**

```typescript
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface UserSecretBundle {
	claudeOauthToken?: string;
	githubPat?: string;
	gitUserName?: string;
	gitUserEmail?: string;
	dotfilesRepo?: string;
}

export const USER_SECRET_KEYS = [
	"claudeOauthToken",
	"githubPat",
	"gitUserName",
	"gitUserEmail",
	"dotfilesRepo",
] as const;

/**
 * Per-user secret bundles for container launches, stored as a single JSON
 * file (keyed by lowercased email) next to router-config.json. Single-org
 * threat model: file perms (0600) are the protection boundary.
 */
export class SecretStore {
	constructor(private readonly filePath: string) {}

	get(email: string): UserSecretBundle {
		return this.readAll()[email.toLowerCase()] ?? {};
	}

	set(
		email: string,
		key: keyof UserSecretBundle,
		value: string | undefined,
	): void {
		const all = this.readAll();
		const id = email.toLowerCase();
		const bundle = { ...(all[id] ?? {}) };
		if (value === undefined) {
			delete bundle[key];
		} else {
			bundle[key] = value;
		}
		if (Object.keys(bundle).length === 0) {
			delete all[id];
		} else {
			all[id] = bundle;
		}
		mkdirSync(dirname(this.filePath), { recursive: true });
		const tmp = `${this.filePath}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
		renameSync(tmp, this.filePath);
	}

	private readAll(): Record<string, UserSecretBundle> {
		if (!existsSync(this.filePath)) return {};
		try {
			return JSON.parse(readFileSync(this.filePath, "utf-8")) as Record<
				string,
				UserSecretBundle
			>;
		} catch {
			return {};
		}
	}
}
```

Export from `packages/router/src/index.ts`.

- [ ] **Step 4: Run to verify pass** — `pnpm --filter cyrus-router test:run` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/router/src/SecretStore.ts packages/router/src/index.ts packages/router/test/SecretStore.test.ts
git commit -m "feat(router): per-user secret bundles for container launches"
```

---

### Task 3: `cyrus-workspace-sync` package — bundle build/restore + HTTP client

**Files:**
- Create: `packages/workspace-sync/package.json`, `tsconfig.json`, `vitest.config.ts` (copy shapes from `packages/router-protocol/`, name `cyrus-workspace-sync`, add deps: `tar@^7`, `cyrus-core: workspace:*`)
- Create: `packages/workspace-sync/src/index.ts`, `src/paths.ts`, `src/bundle.ts`, `src/transport.ts`
- Test: `packages/workspace-sync/test/bundle.test.ts`, `test/paths.test.ts`

**Interfaces:**
- Consumes: `SerializableEdgeWorkerState`, `SerializedCyrusAgentSession` from `cyrus-core` (`packages/core/src/PersistenceManager.ts`).
- Produces (used by Tasks 4, 10, 11):
  - `toHttpBase(routerUrl: string): string` — `ws://`→`http://`, `wss://`→`https://`, passes through `http(s)://`, strips trailing `/`.
  - `sanitizeCwdForClaudeProjects(cwd: string): string` — `cwd.replace(/[^a-zA-Z0-9]/g, "-")`. **Verification step below confirms this matches the real SDK.**
  - `buildBundle(opts: { issueKey: string; state: SerializableEdgeWorkerState; claudeProjectsDir: string; outFile: string }): Promise<boolean>` — filters `state.agentSessions` to those whose `issue.identifier === issueKey`, writes a tar.gz containing `manifest.json`, `state/sessions.json`, and `claude-projects/<sanitized>/…` for each session workspace path that has a transcript dir. Returns false (writes nothing) when no sessions match.
  - `restoreBundle(opts: { bundleFile: string; claudeProjectsDir: string; stateFile: string }): Promise<{ restoredSessions: number }>` — unpacks transcripts into `claudeProjectsDir`, merges sessions into the edge-worker state file **without overwriting existing entries**, and **strips `claudeSessionId` (and `geminiSessionId`/`codexSessionId`/`cursorSessionId`) from any restored session whose transcript file is absent after unpack** — this is the graceful-degradation floor: the EdgeWorker then treats it as `needsNewSession` and re-primes.
  - `uploadBundle(httpBase: string, deviceToken: string, issueKey: string, bundleFile: string): Promise<void>` — `PUT {httpBase}/artifacts/issues/{issueKey}/bundle`, header `Authorization: Bearer <token>`, content-type `application/gzip`; throws on non-2xx.
  - `downloadBundle(httpBase: string, deviceToken: string, issueKey: string, destFile: string): Promise<boolean>` — GET same URL; false on 404, throws on other non-2xx.

Bundle layout (`manifest.json` = `{ "version": 1, "issueKey": string, "createdAt": ISO string, "workspacePaths": string[] }`; `state/sessions.json` = `{ agentSessions, agentSessionEntries }` filtered to the issue).

Transcript existence rule used by both build and restore: for a session with `workspace.path = P` and `claudeSessionId = S`, the transcript file is `join(claudeProjectsDir, sanitizeCwdForClaudeProjects(P), `${S}.jsonl`)`.

- [ ] **Step 1: Write failing tests**

`test/paths.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { sanitizeCwdForClaudeProjects, toHttpBase } from "../src/paths.js";

describe("toHttpBase", () => {
	it.each([
		["ws://localhost:3456", "http://localhost:3456"],
		["wss://router.example.com/", "https://router.example.com"],
		["https://router.example.com", "https://router.example.com"],
	])("%s -> %s", (input, expected) => {
		expect(toHttpBase(input)).toBe(expected);
	});
});

describe("sanitizeCwdForClaudeProjects", () => {
	it("matches the Claude SDK project-dir munging", () => {
		expect(sanitizeCwdForClaudeProjects("/workspaces/CYPACK-123")).toBe(
			"-workspaces-CYPACK-123",
		);
	});
});
```

`test/bundle.test.ts` (uses `mkdtempSync` temp dirs throughout):

```typescript
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildBundle, restoreBundle } from "../src/bundle.js";
import { sanitizeCwdForClaudeProjects } from "../src/paths.js";

function makeState(issueKey: string, workspacePath: string, claudeSessionId: string) {
	return {
		agentSessions: {
			"linear-sess-1": {
				issue: { identifier: issueKey, id: "uuid-1", title: "t" },
				workspace: { path: workspacePath, isGitWorktree: true },
				claudeSessionId,
			},
		},
		agentSessionEntries: { "linear-sess-1": [] },
	} as never;
}

describe("buildBundle/restoreBundle round trip", () => {
	it("restores transcripts and merges session state on a fresh host", async () => {
		const src = mkdtempSync(join(tmpdir(), "sync-src-"));
		const dst = mkdtempSync(join(tmpdir(), "sync-dst-"));
		const wsPath = "/workspaces/CYPACK-9";
		const projDir = join(src, "projects", sanitizeCwdForClaudeProjects(wsPath));
		mkdirSync(projDir, { recursive: true });
		writeFileSync(join(projDir, "claude-abc.jsonl"), '{"type":"noop"}\n');

		const bundleFile = join(src, "bundle.tar.gz");
		const wrote = await buildBundle({
			issueKey: "CYPACK-9",
			state: makeState("CYPACK-9", wsPath, "claude-abc"),
			claudeProjectsDir: join(src, "projects"),
			outFile: bundleFile,
		});
		expect(wrote).toBe(true);

		const stateFile = join(dst, "state", "edge-worker-state.json");
		const result = await restoreBundle({
			bundleFile,
			claudeProjectsDir: join(dst, "projects"),
			stateFile,
		});
		expect(result.restoredSessions).toBe(1);
		expect(
			existsSync(
				join(dst, "projects", sanitizeCwdForClaudeProjects(wsPath), "claude-abc.jsonl"),
			),
		).toBe(true);
		const state = JSON.parse(readFileSync(stateFile, "utf-8"));
		expect(state.state.agentSessions["linear-sess-1"].claudeSessionId).toBe("claude-abc");
	});

	it("strips runner session ids when the transcript is missing (re-prime fallback)", async () => {
		const src = mkdtempSync(join(tmpdir(), "sync-src-"));
		const dst = mkdtempSync(join(tmpdir(), "sync-dst-"));
		const bundleFile = join(src, "bundle.tar.gz");
		// No transcript dir on disk -> bundle carries state only.
		await buildBundle({
			issueKey: "CYPACK-9",
			state: makeState("CYPACK-9", "/workspaces/CYPACK-9", "claude-gone"),
			claudeProjectsDir: join(src, "projects"),
			outFile: bundleFile,
		});
		const stateFile = join(dst, "state", "edge-worker-state.json");
		await restoreBundle({ bundleFile, claudeProjectsDir: join(dst, "projects"), stateFile });
		const state = JSON.parse(readFileSync(stateFile, "utf-8"));
		expect(state.state.agentSessions["linear-sess-1"].claudeSessionId).toBeUndefined();
	});

	it("returns false and writes nothing when no sessions match the issue", async () => {
		const src = mkdtempSync(join(tmpdir(), "sync-src-"));
		const outFile = join(src, "bundle.tar.gz");
		const wrote = await buildBundle({
			issueKey: "OTHER-1",
			state: makeState("CYPACK-9", "/workspaces/CYPACK-9", "x"),
			claudeProjectsDir: join(src, "projects"),
			outFile,
		});
		expect(wrote).toBe(false);
		expect(existsSync(outFile)).toBe(false);
	});

	it("does not overwrite sessions already present in the destination state file", async () => {
		const src = mkdtempSync(join(tmpdir(), "sync-src-"));
		const dst = mkdtempSync(join(tmpdir(), "sync-dst-"));
		const bundleFile = join(src, "bundle.tar.gz");
		await buildBundle({
			issueKey: "CYPACK-9",
			state: makeState("CYPACK-9", "/workspaces/CYPACK-9", "from-bundle"),
			claudeProjectsDir: join(src, "projects"),
			outFile: bundleFile,
		});
		const stateFile = join(dst, "state", "edge-worker-state.json");
		mkdirSync(join(dst, "state"), { recursive: true });
		writeFileSync(
			stateFile,
			JSON.stringify({
				version: "4.0",
				savedAt: "2026-01-01T00:00:00Z",
				state: makeState("CYPACK-9", "/workspaces/CYPACK-9", "local-live"),
			}),
		);
		await restoreBundle({ bundleFile, claudeProjectsDir: join(dst, "projects"), stateFile });
		const state = JSON.parse(readFileSync(stateFile, "utf-8"));
		expect(state.state.agentSessions["linear-sess-1"].claudeSessionId).toBe("local-live");
	});
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm install && pnpm --filter cyrus-workspace-sync test:run` → FAIL.

- [ ] **Step 3: Implement**

`src/paths.ts`:

```typescript
export function toHttpBase(routerUrl: string): string {
	return routerUrl
		.replace(/^ws:\/\//, "http://")
		.replace(/^wss:\/\//, "https://")
		.replace(/\/+$/, "");
}

/**
 * The Claude Agent SDK keys transcript directories by the session cwd with
 * every non-alphanumeric character replaced by '-'. Keep in lockstep with the
 * SDK (verified manually — see plan Task 3 verification step).
 */
export function sanitizeCwdForClaudeProjects(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}
```

`src/bundle.ts` — implement with `tar` (node-tar v7: `create`/`extract`). Outline (complete logic, adapt imports to taste):

```typescript
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as tar from "tar";
import type { SerializableEdgeWorkerState } from "cyrus-core";
import { sanitizeCwdForClaudeProjects } from "./paths.js";

export interface BundleManifest {
	version: 1;
	issueKey: string;
	createdAt: string;
	workspacePaths: string[];
}

function sessionsForIssue(state: SerializableEdgeWorkerState, issueKey: string) {
	const sessions = Object.entries(state.agentSessions ?? {}).filter(
		([, s]) => (s as { issue?: { identifier?: string } }).issue?.identifier === issueKey,
	);
	return Object.fromEntries(sessions);
}

export async function buildBundle(opts: {
	issueKey: string;
	state: SerializableEdgeWorkerState;
	claudeProjectsDir: string;
	outFile: string;
}): Promise<boolean> {
	const sessions = sessionsForIssue(opts.state, opts.issueKey);
	const ids = Object.keys(sessions);
	if (ids.length === 0) return false;

	const staging = await mkdtemp(join(tmpdir(), "cyrus-bundle-"));
	try {
		const workspacePaths = [
			...new Set(
				Object.values(sessions)
					.map((s) => (s as { workspace?: { path?: string } }).workspace?.path)
					.filter((p): p is string => Boolean(p)),
			),
		];
		for (const p of workspacePaths) {
			const src = join(opts.claudeProjectsDir, sanitizeCwdForClaudeProjects(p));
			if (existsSync(src)) {
				await cp(src, join(staging, "claude-projects", sanitizeCwdForClaudeProjects(p)), {
					recursive: true,
				});
			}
		}
		const manifest: BundleManifest = {
			version: 1,
			issueKey: opts.issueKey,
			createdAt: new Date().toISOString(),
			workspacePaths,
		};
		await writeFile(join(staging, "manifest.json"), JSON.stringify(manifest, null, 2));
		mkdirSync(join(staging, "state"), { recursive: true });
		const entries = Object.fromEntries(
			ids.map((id) => [id, opts.state.agentSessionEntries?.[id] ?? []]),
		);
		await writeFile(
			join(staging, "state", "sessions.json"),
			JSON.stringify({ agentSessions: sessions, agentSessionEntries: entries }, null, 2),
		);
		mkdirSync(dirname(opts.outFile), { recursive: true });
		const tmpOut = `${opts.outFile}.tmp`;
		await tar.create({ gzip: true, cwd: staging, file: tmpOut }, ["."]);
		renameSync(tmpOut, opts.outFile);
		return true;
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}

const RUNNER_ID_KEYS = [
	"claudeSessionId",
	"geminiSessionId",
	"codexSessionId",
	"cursorSessionId",
] as const;

export async function restoreBundle(opts: {
	bundleFile: string;
	claudeProjectsDir: string;
	stateFile: string;
}): Promise<{ restoredSessions: number }> {
	const staging = await mkdtemp(join(tmpdir(), "cyrus-restore-"));
	try {
		await tar.extract({ cwd: staging, file: opts.bundleFile });
		const projectsSrc = join(staging, "claude-projects");
		if (existsSync(projectsSrc)) {
			mkdirSync(opts.claudeProjectsDir, { recursive: true });
			await cp(projectsSrc, opts.claudeProjectsDir, { recursive: true, force: false });
		}
		const bundled = JSON.parse(
			await readFile(join(staging, "state", "sessions.json"), "utf-8"),
		) as {
			agentSessions: Record<string, Record<string, unknown>>;
			agentSessionEntries: Record<string, unknown[]>;
		};

		let existing: { version: string; savedAt: string; state: SerializableEdgeWorkerState };
		if (existsSync(opts.stateFile)) {
			existing = JSON.parse(await readFile(opts.stateFile, "utf-8"));
		} else {
			existing = { version: "4.0", savedAt: new Date().toISOString(), state: {} };
		}
		existing.state.agentSessions ??= {};
		existing.state.agentSessionEntries ??= {};

		let restored = 0;
		for (const [id, session] of Object.entries(bundled.agentSessions)) {
			if (existing.state.agentSessions[id]) continue; // local state wins
			const workspacePath = (session as { workspace?: { path?: string } }).workspace?.path;
			for (const key of RUNNER_ID_KEYS) {
				const runnerId = session[key];
				if (typeof runnerId !== "string" || !workspacePath) continue;
				const transcript = join(
					opts.claudeProjectsDir,
					sanitizeCwdForClaudeProjects(workspacePath),
					`${runnerId}.jsonl`,
				);
				if (!existsSync(transcript)) delete session[key]; // re-prime fallback
			}
			existing.state.agentSessions[id] = session as never;
			existing.state.agentSessionEntries[id] = (bundled.agentSessionEntries[id] ??
				[]) as never;
			restored++;
		}
		existing.savedAt = new Date().toISOString();
		mkdirSync(dirname(opts.stateFile), { recursive: true });
		const tmp = `${opts.stateFile}.tmp`;
		await writeFile(tmp, JSON.stringify(existing, null, 2));
		renameSync(tmp, opts.stateFile);
		return { restoredSessions: restored };
	} finally {
		await rm(staging, { recursive: true, force: true });
	}
}
```

`src/transport.ts`:

```typescript
import { createReadStream, createWriteStream, mkdirSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function uploadBundle(
	httpBase: string,
	deviceToken: string,
	issueKey: string,
	bundleFile: string,
): Promise<void> {
	const body = await readFile(bundleFile);
	const res = await fetch(`${httpBase}/artifacts/issues/${issueKey}/bundle`, {
		method: "PUT",
		headers: {
			authorization: `Bearer ${deviceToken}`,
			"content-type": "application/gzip",
		},
		body,
	});
	if (!res.ok) throw new Error(`bundle upload failed: HTTP ${res.status}`);
}

export async function downloadBundle(
	httpBase: string,
	deviceToken: string,
	issueKey: string,
	destFile: string,
): Promise<boolean> {
	const res = await fetch(`${httpBase}/artifacts/issues/${issueKey}/bundle`, {
		headers: { authorization: `Bearer ${deviceToken}` },
	});
	if (res.status === 404) return false;
	if (!res.ok) throw new Error(`bundle download failed: HTTP ${res.status}`);
	mkdirSync(dirname(destFile), { recursive: true });
	await writeFile(destFile, Buffer.from(await res.arrayBuffer()));
	return true;
}
```

`src/index.ts` re-exports everything. Also export `SerializableEdgeWorkerState` type usage requires it to be exported from `cyrus-core` — check `packages/core/src/index.ts` and add the export if missing.

- [ ] **Step 4: Run to verify pass** — `pnpm --filter cyrus-workspace-sync test:run` → PASS. Also `pnpm --filter cyrus-workspace-sync typecheck`.

- [ ] **Step 5: Verify the sanitization rule against the real SDK**

Run: `cd $(mktemp -d) && mkdir -p /tmp/verify-cwd/sub.dir && cd /tmp/verify-cwd/sub.dir && claude -p "say hi" --output-format json > /dev/null 2>&1; ls ~/.claude/projects/ | grep verify`
Expected: a directory named `-tmp-verify-cwd-sub-dir` (dots and slashes both become `-`). If the real munging differs, fix `sanitizeCwdForClaudeProjects` and its test to match, and note the actual rule in the function's doc comment.

- [ ] **Step 6: Commit**

```bash
git add packages/workspace-sync packages/core/src/index.ts pnpm-lock.yaml
git commit -m "feat(workspace-sync): issue state bundles — build/restore/upload/download"
```

---

### Task 4: Router artifact endpoints

**Files:**
- Create: `packages/router/src/artifacts.ts`
- Modify: `packages/router/src/RouterServer.ts` (register route in constructor, next to `registerEnrollmentRoute`)
- Test: `packages/router/test/artifacts.test.ts`

**Interfaces:**
- Consumes: `RouterStore.getDeviceByToken` (Task 1 unchanged surface), Fastify instance.
- Produces: `registerArtifactsRoute(fastify: FastifyInstance, store: Pick<RouterStore, "getDeviceByToken">, artifactsDir: string): void` exposing:
  - `PUT /artifacts/issues/:issueKey/bundle` (auth `Bearer <deviceToken>`, content-type `application/gzip`, body up to 256 MiB) → 200 `{ ok: true }`; 401 bad token; 400 bad issue key.
  - `GET /artifacts/issues/:issueKey/bundle` → gzip stream or 404.
- RouterServer stores bundles at `<artifactsDir>/<issueKey>/bundle.tar.gz`; `artifactsDir` comes from `RouterServerConfig.containers.artifactsDir` (wired fully in Task 8 — for this task add a temporary constructor default of `join(dirname(config.dbPath), "artifacts")`).

- [ ] **Step 1: Write failing tests** — `packages/router/test/artifacts.test.ts`:

```typescript
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerArtifactsRoute } from "../src/artifacts.js";
import { RouterStore } from "../src/RouterStore.js";

describe("artifact endpoints", () => {
	let fastify: ReturnType<typeof Fastify>;
	let store: RouterStore;
	let token: string;

	beforeEach(async () => {
		store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		({ deviceToken: token } = store.createContainerDevice(userId, "CYPACK-1", "docker"));
		fastify = Fastify();
		registerArtifactsRoute(fastify, store, mkdtempSync(join(tmpdir(), "artifacts-")));
		await fastify.ready();
	});
	afterEach(async () => {
		await fastify.close();
		store.close();
	});

	const put = (issueKey: string, auth?: string) =>
		fastify.inject({
			method: "PUT",
			url: `/artifacts/issues/${issueKey}/bundle`,
			headers: {
				"content-type": "application/gzip",
				...(auth ? { authorization: auth } : {}),
			},
			payload: Buffer.from("fake-gzip-bytes"),
		});

	it("round-trips a bundle with a valid device token", async () => {
		expect((await put("CYPACK-1", `Bearer ${token}`)).statusCode).toBe(200);
		const res = await fastify.inject({
			method: "GET",
			url: "/artifacts/issues/CYPACK-1/bundle",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.statusCode).toBe(200);
		expect(res.rawPayload.toString()).toBe("fake-gzip-bytes");
	});

	it("rejects missing/invalid tokens with 401", async () => {
		expect((await put("CYPACK-1")).statusCode).toBe(401);
		expect((await put("CYPACK-1", "Bearer nope")).statusCode).toBe(401);
	});

	it("rejects path-traversal issue keys with 400", async () => {
		expect((await put("..%2F..%2Fetc", `Bearer ${token}`)).statusCode).toBe(400);
	});

	it("404s for a bundle that was never uploaded", async () => {
		const res = await fastify.inject({
			method: "GET",
			url: "/artifacts/issues/CYPACK-2/bundle",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.statusCode).toBe(404);
	});
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter cyrus-router test:run` → FAIL.

- [ ] **Step 3: Implement `artifacts.ts`**

```typescript
import { createReadStream, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";

const ISSUE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BODY_LIMIT = 256 * 1024 * 1024;

/**
 * Device-token-authenticated store for per-issue state bundles (the
 * persistence floor). Bundles live at <artifactsDir>/<issueKey>/bundle.tar.gz.
 */
export function registerArtifactsRoute(
	fastify: FastifyInstance,
	store: { getDeviceByToken(token: string): unknown },
	artifactsDir: string,
): void {
	fastify.addContentTypeParser(
		"application/gzip",
		{ parseAs: "buffer", bodyLimit: BODY_LIMIT },
		(_req, body, done) => done(null, body),
	);

	const authed = (request: FastifyRequest): boolean => {
		const header = request.headers.authorization;
		if (!header?.startsWith("Bearer ")) return false;
		return Boolean(store.getDeviceByToken(header.slice("Bearer ".length)));
	};
	const bundlePath = (issueKey: string) => join(artifactsDir, issueKey, "bundle.tar.gz");

	fastify.put<{ Params: { issueKey: string } }>(
		"/artifacts/issues/:issueKey/bundle",
		{ bodyLimit: BODY_LIMIT },
		async (request, reply) => {
			if (!authed(request)) return reply.status(401).send({ error: "unauthorized" });
			const { issueKey } = request.params;
			if (!ISSUE_KEY_RE.test(issueKey)) {
				return reply.status(400).send({ error: "invalid issue key" });
			}
			const dest = bundlePath(issueKey);
			mkdirSync(dirname(dest), { recursive: true });
			const tmp = `${dest}.tmp`;
			writeFileSync(tmp, request.body as Buffer);
			renameSync(tmp, dest);
			return { ok: true };
		},
	);

	fastify.get<{ Params: { issueKey: string } }>(
		"/artifacts/issues/:issueKey/bundle",
		async (request, reply) => {
			if (!authed(request)) return reply.status(401).send({ error: "unauthorized" });
			const { issueKey } = request.params;
			if (!ISSUE_KEY_RE.test(issueKey)) {
				return reply.status(400).send({ error: "invalid issue key" });
			}
			const path = bundlePath(issueKey);
			if (!existsSync(path)) return reply.status(404).send({ error: "not found" });
			return reply.type("application/gzip").send(createReadStream(path));
		},
	);
}
```

In `RouterServer.ts` constructor, after `registerWorkspacesRoute(...)`:

```typescript
registerArtifactsRoute(
	this.fastify,
	this.store,
	config.containers?.artifactsDir ??
		join(dirname(config.dbPath), "artifacts"),
);
```

(add `import { dirname, join } from "node:path";` and — until Task 8 defines it — extend `RouterServerConfig` with `containers?: { artifactsDir?: string }`).

- [ ] **Step 4: Run to verify pass** — `pnpm --filter cyrus-router test:run` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/router/src/artifacts.ts packages/router/src/RouterServer.ts packages/router/test/artifacts.test.ts
git commit -m "feat(router): device-token-authenticated per-issue artifact bundle endpoints"
```

---

### Task 5: `cyrus-router-executors` package — interface + LocalDockerProvider

**Files:**
- Create: `packages/router-executors/package.json`, `tsconfig.json`, `vitest.config.ts` (copy `packages/router-protocol/` shapes; name `cyrus-router-executors`; no runtime deps)
- Create: `packages/router-executors/src/index.ts`, `src/types.ts`, `src/LocalDockerProvider.ts`
- Test: `packages/router-executors/test/LocalDockerProvider.test.ts`

**Interfaces:**
- Produces (used by Tasks 6, 7, 8; implemented again by Fly/Codespaces in phases 2–3):

```typescript
// src/types.ts
export interface IssueExecutionContext {
	issueKey: string;
	/** Full env for the container, EXCEPT CYRUS_DEVICE_TOKEN. */
	env: Record<string, string>;
	/**
	 * Rotates and returns the issue's device token. Providers call this ONLY
	 * when they must (re)create the container — an existing stopped container
	 * keeps the env (and token) it was created with.
	 */
	mintDeviceToken: () => string;
}

export type ContainerStatus = "running" | "stopped" | "absent";

export interface ContainerExecutor {
	readonly provider: string;
	/** Idempotent: boot or resume the issue's container. */
	ensureRunning(ctx: IssueExecutionContext): Promise<void>;
	stop(issueKey: string): Promise<void>;
	/** Removes container AND its persistent volume/disk. */
	destroy(issueKey: string): Promise<void>;
	status(issueKey: string): Promise<ContainerStatus>;
	/** Issue keys of every container this provider currently manages (for orphan GC). */
	listManaged(): Promise<string[]>;
}

export type ExecutorRegistry = ReadonlyMap<string, ContainerExecutor>;
```

- `LocalDockerProvider` (provider name `"docker"`): constructor `new LocalDockerProvider(opts: { image: string; memoryLimit?: string; network?: string; exec?: ExecFn })` where `type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>` (default wraps `node:child_process` `execFile`; injectable for tests). Naming: container `cyrus-issue-<key>`, volume `cyrus-issue-<key>`, label `cyrus.issue=<key>` (key sanitized with `key.replace(/[^A-Za-z0-9_.-]/g, "-")`).

**Provider semantics (encode as tests):**
- `status`: `docker inspect -f '{{.State.Running}}\t{{.Config.Image}}' <name>` → exit≠0 ⇒ `absent`; `true\t…` ⇒ `running`; else `stopped`.
- `ensureRunning`:
  - `running` + image matches → no-op.
  - `stopped` + image matches → `docker start <name>`.
  - exists but image differs → `docker rm -f <name>` then create (volume survives).
  - `absent` → `docker volume create <name>` then `docker run -d --name <name> --label cyrus.issue=<key> [--memory <limit>] [--network <net>] -v <name>:/workspaces -e KEY=VALUE… -e CYRUS_DEVICE_TOKEN=<mintDeviceToken()> <image>`.
- `stop` → `docker stop <name>` (ignore exit≠0: already stopped/absent).
- `destroy` → `docker rm -f <name>` then `docker volume rm <name>` (both best-effort).
- `listManaged` → `docker ps -a --filter label=cyrus.issue --format '{{.Label "cyrus.issue"}}'` split lines.

- [ ] **Step 1: Write failing tests** — build a `FakeExec` that records `[cmd, ...args]` invocations and returns scripted results; cover each semantic above. Representative cases (write all six):

```typescript
import { describe, expect, it } from "vitest";
import { LocalDockerProvider } from "../src/LocalDockerProvider.js";

function fakeExec(script: Record<string, { stdout?: string; exitCode?: number }>) {
	const calls: string[][] = [];
	const exec = async (cmd: string, args: string[]) => {
		calls.push([cmd, ...args]);
		const key = args.slice(0, 2).join(" "); // e.g. "inspect -f", "run -d"
		const hit = script[key] ?? {};
		return { stdout: hit.stdout ?? "", exitCode: hit.exitCode ?? 0 };
	};
	return { exec, calls };
}

const ctx = (issueKey = "CYPACK-1") => ({
	issueKey,
	env: { CYRUS_ROUTER_URL: "ws://host:1", CYRUS_ISSUE_KEY: issueKey },
	mintDeviceToken: () => "tok-123",
});

describe("LocalDockerProvider", () => {
	it("creates volume + container with env and token when absent", async () => {
		const { exec, calls } = fakeExec({ "inspect -f": { exitCode: 1 } });
		const p = new LocalDockerProvider({ image: "img:1", exec });
		await p.ensureRunning(ctx());
		const run = calls.find((c) => c[1] === "run");
		expect(calls.some((c) => c[1] === "volume" && c[2] === "create")).toBe(true);
		expect(run).toContain("-e");
		expect(run?.join(" ")).toContain("CYRUS_DEVICE_TOKEN=tok-123");
		expect(run?.join(" ")).toContain("cyrus-issue-CYPACK-1:/workspaces");
	});

	it("starts a stopped container with a matching image without re-minting", async () => {
		const { exec, calls } = fakeExec({
			"inspect -f": { stdout: "false\timg:1\n" },
		});
		const p = new LocalDockerProvider({ image: "img:1", exec });
		let minted = 0;
		await p.ensureRunning({ ...ctx(), mintDeviceToken: () => (minted++, "t") });
		expect(minted).toBe(0);
		expect(calls.some((c) => c[1] === "start")).toBe(true);
	});

	it("recreates (rm -f, then run) when the image is stale", async () => {
		const { exec, calls } = fakeExec({
			"inspect -f": { stdout: "false\timg:0\n" },
		});
		const p = new LocalDockerProvider({ image: "img:1", exec });
		await p.ensureRunning(ctx());
		expect(calls.some((c) => c[1] === "rm" && c.includes("-f"))).toBe(true);
		expect(calls.some((c) => c[1] === "run")).toBe(true);
	});

	it("is a no-op when running with the right image", async () => {
		const { exec, calls } = fakeExec({
			"inspect -f": { stdout: "true\timg:1\n" },
		});
		await new LocalDockerProvider({ image: "img:1", exec }).ensureRunning(ctx());
		expect(calls).toHaveLength(1); // just the inspect
	});

	it("maps status and lists managed issue keys", async () => {
		const { exec } = fakeExec({
			"inspect -f": { stdout: "true\timg:1\n" },
			"ps -a": { stdout: "CYPACK-1\nCYPACK-2\n" },
		});
		const p = new LocalDockerProvider({ image: "img:1", exec });
		expect(await p.status("CYPACK-1")).toBe("running");
		expect(await p.listManaged()).toEqual(["CYPACK-1", "CYPACK-2"]);
	});

	it("destroy removes container then volume, tolerating absence", async () => {
		const { exec, calls } = fakeExec({
			"rm -f": { exitCode: 1 },
			"volume rm": { exitCode: 1 },
		});
		await new LocalDockerProvider({ image: "img:1", exec }).destroy("CYPACK-1");
		expect(calls.map((c) => c[1])).toEqual(["rm", "volume"]);
	});
});
```

- [ ] **Step 2: Run to verify failure** — `pnpm install && pnpm --filter cyrus-router-executors test:run` → FAIL.

- [ ] **Step 3: Implement `LocalDockerProvider.ts`**

```typescript
import { execFile } from "node:child_process";
import type { ContainerExecutor, ContainerStatus, IssueExecutionContext } from "./types.js";

export type ExecFn = (
	cmd: string,
	args: string[],
) => Promise<{ stdout: string; exitCode: number }>;

const defaultExec: ExecFn = (cmd, args) =>
	new Promise((resolve) => {
		execFile(cmd, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
			resolve({
				stdout: stdout?.toString() ?? "",
				exitCode: err ? ((err as { code?: number }).code ?? 1) : 0,
			});
		});
	});

function sanitizeKey(issueKey: string): string {
	return issueKey.replace(/[^A-Za-z0-9_.-]/g, "-");
}

export class LocalDockerProvider implements ContainerExecutor {
	readonly provider = "docker";
	private readonly image: string;
	private readonly memoryLimit: string | undefined;
	private readonly network: string | undefined;
	private readonly exec: ExecFn;

	constructor(opts: {
		image: string;
		memoryLimit?: string;
		network?: string;
		exec?: ExecFn;
	}) {
		this.image = opts.image;
		this.memoryLimit = opts.memoryLimit;
		this.network = opts.network;
		this.exec = opts.exec ?? defaultExec;
	}

	private name(issueKey: string): string {
		return `cyrus-issue-${sanitizeKey(issueKey)}`;
	}

	private async inspect(
		issueKey: string,
	): Promise<{ status: ContainerStatus; image?: string }> {
		const { stdout, exitCode } = await this.exec("docker", [
			"inspect",
			"-f",
			"{{.State.Running}}\t{{.Config.Image}}",
			this.name(issueKey),
		]);
		if (exitCode !== 0) return { status: "absent" };
		const [running, image] = stdout.trim().split("\t");
		return { status: running === "true" ? "running" : "stopped", image };
	}

	async status(issueKey: string): Promise<ContainerStatus> {
		return (await this.inspect(issueKey)).status;
	}

	async ensureRunning(ctx: IssueExecutionContext): Promise<void> {
		const name = this.name(ctx.issueKey);
		const found = await this.inspect(ctx.issueKey);
		if (found.status !== "absent" && found.image === this.image) {
			if (found.status === "stopped") {
				await this.mustSucceed("docker", ["start", name]);
			}
			return;
		}
		if (found.status !== "absent") {
			await this.exec("docker", ["rm", "-f", name]); // volume survives
		}
		await this.mustSucceed("docker", ["volume", "create", name]);
		const args = ["run", "-d", "--name", name, "--label", `cyrus.issue=${ctx.issueKey}`];
		if (this.memoryLimit) args.push("--memory", this.memoryLimit);
		if (this.network) args.push("--network", this.network);
		args.push("-v", `${name}:/workspaces`);
		for (const [key, value] of Object.entries(ctx.env)) {
			args.push("-e", `${key}=${value}`);
		}
		args.push("-e", `CYRUS_DEVICE_TOKEN=${ctx.mintDeviceToken()}`);
		args.push(this.image);
		await this.mustSucceed("docker", args);
	}

	async stop(issueKey: string): Promise<void> {
		await this.exec("docker", ["stop", this.name(issueKey)]);
	}

	async destroy(issueKey: string): Promise<void> {
		await this.exec("docker", ["rm", "-f", this.name(issueKey)]);
		await this.exec("docker", ["volume", "rm", this.name(issueKey)]);
	}

	async listManaged(): Promise<string[]> {
		const { stdout } = await this.exec("docker", [
			"ps",
			"-a",
			"--filter",
			"label=cyrus.issue",
			"--format",
			'{{.Label "cyrus.issue"}}',
		]);
		return stdout.split("\n").map((l) => l.trim()).filter(Boolean);
	}

	private async mustSucceed(cmd: string, args: string[]): Promise<void> {
		const { exitCode, stdout } = await this.exec(cmd, args);
		if (exitCode !== 0) {
			throw new Error(`${cmd} ${args[0]} ${args[1] ?? ""} failed (${exitCode}): ${stdout}`.trim());
		}
	}
}
```

`src/index.ts` exports `types.ts` + `LocalDockerProvider`.

- [ ] **Step 4: Run to verify pass** — `pnpm --filter cyrus-router-executors test:run` → PASS; `pnpm --filter cyrus-router-executors typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/router-executors pnpm-lock.yaml
git commit -m "feat(router-executors): ContainerExecutor interface and LocalDockerProvider"
```

---

### Task 6: ContainerTargetService + EventRouter container routing

**Files:**
- Create: `packages/router/src/ContainerTargets.ts`
- Modify: `packages/router/src/EventRouter.ts`, `packages/router/src/messages.ts`
- Test: `packages/router/test/ContainerTargets.test.ts`, extend `packages/router/test/EventRouter.test.ts`

**Interfaces:**
- Consumes: Task 1 store methods, Task 2 `SecretStore`, Task 5 `ExecutorRegistry`/`ContainerExecutor`.
- Produces (consumed by EventRouter and Task 8 wiring):

```typescript
// ContainerTargets.ts
export interface ContainerRoutingDeps {
	store: RouterStore;
	secrets: SecretStore;
	executors: ExecutorRegistry; // Map<providerName, ContainerExecutor>
	containersConfig: {
		routerUrlForContainers: string;
		repositories: Array<{
			name: string;
			githubSlug: string; // "owner/repo"
			linearWorkspaceId: string;
			baseBranch?: string;
		}>;
	};
	postActivity: (workspaceId: string, agentSessionId: string, body: string) => Promise<void>;
	logger: { info(msg: string): void; warn(msg: string): void };
}

export class ContainerTargetService {
	constructor(deps: ContainerRoutingDeps);
	/** Provider name from users.executor_json, or undefined for physical-device users. */
	executorFor(userId: number): string | undefined;
	/**
	 * Get-or-create the issue's container device row. Destroys + replaces the
	 * row when the stored provider no longer matches the user's executor.
	 */
	ensureDevice(user: { userId: number; email: string }, issueKey: string): { deviceId: number };
	/**
	 * Fire-and-forget boot. On ensureRunning rejection, posts a
	 * container-boot-failed activity (once per issue until a boot succeeds).
	 */
	boot(deviceId: number, notify: { workspaceId: string; sessionId: string }): void;
	isContainerDevice(deviceId: number): boolean;
}
```

- `messages.ts` gains:

```typescript
export const CONTAINER_BOOT_FAILED_MESSAGE =
	"I couldn't start the workspace container for this issue ({issueKey}): {detail}. An operator should check the router logs; I'll retry on the next prompt.";
export function containerBootFailedMessage(issueKey: string, detail: string): string {
	return fillTemplate(CONTAINER_BOOT_FAILED_MESSAGE, { issueKey, detail });
}
```

**EventRouter changes (all covered by tests):**
1. `EventRouterOptions` gains `containerTargets?: ContainerTargetService`.
2. `ResolvedTarget` gains `kind: "device" | "container"` and optional `issueKey?: string`.
3. `resolveTarget(...)`:
   - The session-affinity fast path now validates the device still exists (`store.getDeviceInfo`); a dangling id clears the affinity row and falls through the chain. The returned target carries the device's `kind`.
   - In the creator branch, when `containerTargets?.executorFor(user.userId)` is defined, resolve via `containerTargets.ensureDevice(user, issueKey)` where `issueKey = webhook.agentSession.issue?.identifier ?? issueId ?? sessionId` (add a small `extractIssueKey(webhook)` helper reading `identifier` defensively like `extractParentIssueId` does). Physical-device users keep today's path.
   - Issue-affinity and parent-affinity branches also stamp `kind` via `getDeviceInfo` (defaulting to `"device"` when the lookup is somehow empty).
4. `deliverOrNotify(...)`: after `enqueueEvent`, when the target is offline:
   - `kind === "container"` → call `containerTargets.boot(target.deviceId, { workspaceId, sessionId })` and do **not** post `offlineWaitingMessage` (a cold boot is expected, not an outage).
   - `kind === "device"` → unchanged notice behavior.

- [ ] **Step 1: Write failing tests**

`ContainerTargets.test.ts` — with an in-memory `RouterStore`, a temp-file `SecretStore`, and a `FakeExecutor` (`{ provider: "docker", calls: [], ensureRunning: vi.fn(), destroy: vi.fn(), stop, status, listManaged }`):

```typescript
it("creates a device row on first ensure and reuses it after", ...)
	// ensureDevice twice -> same deviceId; store row provider === "docker"
it("replaces the device when the user's executor provider changed", ...)
	// seed row with provider "docker", set executor to '{"type":"fake2"}' with
	// a second fake executor registered under "fake2"; ensureDevice ->
	// old executor.destroy called with issueKey, old row deleted, new row provider "fake2"
it("boot passes env built from secrets and repo config, minus the device token", ...)
	// secrets.set claudeOauthToken/githubPat/gitUserName; boot(deviceId, ...);
	// await vi.waitFor -> fakeExecutor.ensureRunning called once; its ctx.env
	// contains CYRUS_ROUTER_URL, CYRUS_ISSUE_KEY, CYRUS_REPOS_JSON,
	// CLAUDE_CODE_OAUTH_TOKEN, GIT_TOKEN; ctx.env.CYRUS_DEVICE_TOKEN undefined;
	// ctx.mintDeviceToken() returns a token accepted by store.getDeviceByToken
it("posts a boot-failure activity once when ensureRunning rejects, and no Claude token means immediate failure", ...)
	// (a) ensureRunning rejects -> postActivity called with containerBootFailedMessage
	// (b) no claudeOauthToken in secrets -> boot posts failure without calling executor
```

`EventRouter.test.ts` additions (follow the existing test file's fake store/gateway patterns):

```typescript
it("routes a created event for a container-executor user to the issue's container device and skips the offline notice", ...)
	// user has executor_json '{"type":"docker"}'; gateway offline; expect
	// enqueueEvent on the container device, boot() called, postActivity NOT
	// called with offlineWaitingMessage
it("falls through and heals when session affinity points at a deleted container device", ...)
	// setSessionAffinity to a bogus deviceId; route prompted; expect affinity
	// cleared and target re-resolved via creator chain
it("keeps physical-device routing byte-identical when containerTargets is not configured", ...)
	// existing behavior tests must pass unchanged
```

- [ ] **Step 2: Run to verify failure** — `pnpm --filter cyrus-router test:run` → FAIL.

- [ ] **Step 3: Implement**

`ContainerTargets.ts` core logic:

```typescript
export class ContainerTargetService {
	private readonly bootFailedNotified = new Set<string>();

	constructor(private readonly deps: ContainerRoutingDeps) {}

	executorFor(userId: number): string | undefined {
		const json = this.deps.store.getUserExecutor(userId);
		if (!json) return undefined;
		try {
			const parsed = JSON.parse(json) as { type?: string };
			return parsed.type && parsed.type !== "device" ? parsed.type : undefined;
		} catch {
			this.deps.logger.warn(`Corrupt executor_json for user ${userId}; using physical device`);
			return undefined;
		}
	}

	ensureDevice(
		user: { userId: number; email: string },
		issueKey: string,
	): { deviceId: number } {
		const provider = this.executorFor(user.userId);
		if (!provider) throw new Error(`user ${user.userId} has no container executor`);
		let existing = this.deps.store.getContainerDeviceForIssue(issueKey);
		if (existing && existing.provider !== provider) {
			const old = this.deps.executors.get(existing.provider);
			void old?.destroy(issueKey).catch((err: unknown) => {
				this.deps.logger.warn(
					`destroy of ${existing?.provider} container for ${issueKey} failed: ${String(err)}`,
				);
			});
			this.deps.store.deleteContainerDevice(existing.deviceId);
			existing = undefined;
		}
		if (existing) return { deviceId: existing.deviceId };
		const created = this.deps.store.createContainerDevice(user.userId, issueKey, provider);
		return { deviceId: created.deviceId };
	}

	isContainerDevice(deviceId: number): boolean {
		return this.deps.store.getDeviceInfo(deviceId)?.kind === "container";
	}

	boot(deviceId: number, notify: { workspaceId: string; sessionId: string }): void {
		void this.bootInner(deviceId, notify);
	}

	private async bootInner(
		deviceId: number,
		notify: { workspaceId: string; sessionId: string },
	): Promise<void> {
		const device = this.deps.store.getDeviceInfo(deviceId);
		if (!device || device.kind !== "container" || !device.issueKey || !device.provider) return;
		const executor = this.deps.executors.get(device.provider);
		const issueKey = device.issueKey;
		try {
			if (!executor) throw new Error(`no executor configured for provider '${device.provider}'`);
			const env = this.buildEnv(device.userId, issueKey);
			await executor.ensureRunning({
				issueKey,
				env,
				mintDeviceToken: () => this.deps.store.rotateContainerDeviceToken(deviceId),
			});
			this.bootFailedNotified.delete(issueKey);
		} catch (err) {
			this.deps.logger.warn(`container boot failed for ${issueKey}: ${String(err)}`);
			if (!this.bootFailedNotified.has(issueKey)) {
				this.bootFailedNotified.add(issueKey);
				await this.deps.postActivity(
					notify.workspaceId,
					notify.sessionId,
					containerBootFailedMessage(issueKey, err instanceof Error ? err.message : String(err)),
				);
			}
		}
	}

	private buildEnv(userId: number, issueKey: string): Record<string, string> {
		const email = this.emailFor(userId); // small store lookup: SELECT email FROM users — add store.getUserEmail(userId) in this task
		const secrets = this.deps.secrets.get(email);
		if (!secrets.claudeOauthToken) {
			throw new Error(`no Claude OAuth token stored for ${email} (cyrus router secrets set ${email} claudeOauthToken <token>)`);
		}
		const env: Record<string, string> = {
			CYRUS_ROUTER_URL: this.deps.containersConfig.routerUrlForContainers,
			CYRUS_ISSUE_KEY: issueKey,
			CYRUS_REPOS_JSON: JSON.stringify(this.deps.containersConfig.repositories),
			CLAUDE_CODE_OAUTH_TOKEN: secrets.claudeOauthToken,
		};
		if (secrets.githubPat) env.GIT_TOKEN = secrets.githubPat;
		if (secrets.gitUserName) env.GIT_USER_NAME = secrets.gitUserName;
		if (secrets.gitUserEmail) env.GIT_USER_EMAIL = secrets.gitUserEmail;
		if (secrets.dotfilesRepo) env.DOTFILES_REPO = secrets.dotfilesRepo;
		return env;
	}
}
```

(Add `getUserEmail(userId: number): string | undefined` to `RouterStore` with a one-line SELECT — include a test in this task's store additions.)

`EventRouter.ts` edits per the interface notes above. The `resolveTarget` creator branch becomes:

```typescript
if (creator) {
	const user = this.store.findUserForCreator({ id: creator.id, email: creator.email });
	if (user) {
		if (this.containerTargets?.executorFor(user.userId)) {
			const issueKey = extractIssueKey(webhook) ?? issueId ?? sessionId;
			const { deviceId } = this.containerTargets.ensureDevice(user, issueKey);
			return { deviceId, email: user.email, kind: "container", issueKey };
		}
		const device = this.store.getDeviceForUser(user.userId);
		if (device) {
			return { deviceId: device.deviceId, email: user.email, kind: "device" };
		}
	}
}
```

and `deliverOrNotify`'s offline branch:

```typescript
if (this.gateway.isOnline(target.deviceId)) {
	this.gateway.deliverPending(target.deviceId);
	return;
}
if (target.kind === "container") {
	this.containerTargets?.boot(target.deviceId, { workspaceId, sessionId });
	return; // cold boot expected; queue drains when the container connects
}
// existing offlineWaitingMessage path for physical devices
```

- [ ] **Step 4: Run to verify pass** — `pnpm --filter cyrus-router test:run` → PASS (including all pre-existing EventRouter tests).

- [ ] **Step 5: Commit**

```bash
git add packages/router/src packages/router/test packages/router/package.json pnpm-lock.yaml
git commit -m "feat(router): route container-executor users to per-issue ephemeral devices"
```

---

### Task 7: ContainerLifecycle — idle-stop, stale-destroy, orphan GC

**Files:**
- Create: `packages/router/src/ContainerLifecycle.ts`
- Modify: `packages/router/src/RouterServer.ts` (call from the existing sweep interval)
- Test: `packages/router/test/ContainerLifecycle.test.ts`

**Interfaces:**
- Consumes: Task 1 store methods, Task 5 `ExecutorRegistry`.
- Produces: `class ContainerLifecycle { constructor(opts: { store: RouterStore; executors: ExecutorRegistry; idleStopMs: number; staleDestroyMs: number; logger; now?: () => number }); sweep(): Promise<void>; }`

**Policy (encode as tests):**
- *Idle-stop:* container device with `countSessionAffinityForDevice === 0` AND `now - (lastRoutedMs ?? createdMs) > idleStopMs` AND `status === "running"` → `executor.stop(issueKey)`.
- *Stale-destroy:* container device with `now - max(lastRoutedMs ?? 0, lastSeenMs ?? 0, createdMs) > staleDestroyMs` → `executor.destroy(issueKey)` + `store.deleteContainerDevice(deviceId)`. (Safe: the artifact bundle + git branch survive; a later prompt recreates from the restore ladder.)
- *Orphan GC:* for each provider, `listManaged()` keys with no device row → `executor.destroy(key)`.
- A device with active session affinity is never stopped or destroyed, regardless of timestamps.
- Executor errors are logged and skipped, never thrown (one bad Docker daemon must not kill the sweep).

Defaults (used in Task 8): `idleStopMs = 15 * 60_000`, `staleDestroyMs = 14 * 24 * 60 * 60_000`.

- [ ] **Step 1: Write failing tests** — in-memory store + `FakeExecutor` with `vi.fn()` methods and a scripted `status`; fixed `now`. One `it(...)` per policy bullet above (five tests).

- [ ] **Step 2: Run to verify failure** — `pnpm --filter cyrus-router test:run` → FAIL.

- [ ] **Step 3: Implement**

```typescript
export class ContainerLifecycle {
	// fields + constructor storing opts; now = opts.now ?? Date.now
	async sweep(): Promise<void> {
		const now = this.now();
		const rows = this.store.listContainerDevices();
		const knownKeys = new Set(rows.map((r) => r.issueKey));

		for (const row of rows) {
			const executor = this.executors.get(row.provider);
			if (!executor) continue;
			try {
				const active = this.store.countSessionAffinityForDevice(row.deviceId) > 0;
				if (active) continue;
				const lastTouch = Math.max(row.lastRoutedMs ?? 0, row.lastSeenMs ?? 0, row.createdMs);
				if (now - lastTouch > this.staleDestroyMs) {
					await executor.destroy(row.issueKey);
					this.store.deleteContainerDevice(row.deviceId);
					this.logger.info(`Destroyed stale container for ${row.issueKey}`);
					continue;
				}
				const idleSince = row.lastRoutedMs ?? row.createdMs;
				if (now - idleSince > this.idleStopMs && (await executor.status(row.issueKey)) === "running") {
					await executor.stop(row.issueKey);
					this.logger.info(`Idle-stopped container for ${row.issueKey}`);
				}
			} catch (err) {
				this.logger.warn(`lifecycle sweep failed for ${row.issueKey}: ${String(err)}`);
			}
		}

		for (const [provider, executor] of this.executors) {
			try {
				for (const key of await executor.listManaged()) {
					if (!knownKeys.has(key)) {
						await executor.destroy(key);
						this.logger.info(`Destroyed orphan ${provider} container for ${key}`);
					}
				}
			} catch (err) {
				this.logger.warn(`orphan GC failed for provider ${provider}: ${String(err)}`);
			}
		}
	}
}
```

In `RouterServer.start()`, extend the existing sweep interval body to `void this.eventRouter.sweepExpired(); void this.containerLifecycle?.sweep();` (field created in Task 8; keep it optional so this compiles now).

- [ ] **Step 4: Run to verify pass**, **Step 5: Commit**

```bash
git add packages/router/src/ContainerLifecycle.ts packages/router/src/RouterServer.ts packages/router/test/ContainerLifecycle.test.ts
git commit -m "feat(router): container idle-stop, stale-destroy, and orphan GC sweeps"
```

---### Task 8: Config schema + RouterServer wiring

**Files:**
- Modify: `packages/router/src/RouterServer.ts`, `apps/cli/src/commands/RouterCommand.ts` (the `RouterConfigFileSchema`)
- Test: extend `packages/router/test/RouterServer.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–7.
- Produces: `RouterServerConfig.containers?: RouterContainersConfig`:

```typescript
export interface RouterContainersConfig {
	/** Worker image, e.g. "ghcr.io/org/cyrus-worker:0.2.66". */
	image: string;
	/** Router URL reachable FROM containers, e.g. "ws://host.docker.internal:3456". */
	routerUrlForContainers: string;
	repositories: Array<{
		name: string;
		githubSlug: string;
		linearWorkspaceId: string;
		baseBranch?: string;
	}>;
	artifactsDir?: string;   // default <dirname(dbPath)>/artifacts
	secretsPath?: string;    // default <dirname(dbPath)>/user-secrets.json
	idleStopMs?: number;     // default 900_000
	staleDestroyMs?: number; // default 1_209_600_000
	docker?: { memoryLimit?: string; network?: string };
}
```

Zod mirror added to `RouterConfigFileSchema` in `RouterCommand.ts` (all-optional `containers` object with required `image`, `routerUrlForContainers`, `repositories` when present).

**Wiring in the RouterServer constructor** (only when `config.containers` is set): build `SecretStore`, `ExecutorRegistry` (`new Map([["docker", new LocalDockerProvider({ image, ...config.containers.docker })]])`), `ContainerTargetService` (with `postActivity` bound to the executor as EventRouter's is), `ContainerLifecycle`; pass `containerTargets` into `EventRouter`. Without `containers`, all fields stay undefined and behavior is identical to today.

- [ ] **Step 1: Write failing tests** — extend `RouterServer.test.ts`: (a) constructing with a `containers` config exposes container routing (route a webhook for a docker-executor user via the `eventRouter` seam; assert a container device row was created — use `trackerFactory` seam to avoid Linear); (b) constructing WITHOUT `containers` leaves behavior unchanged (existing tests).
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** the config type, Zod schema, and constructor wiring; add `cyrus-router-executors` and `cyrus-workspace-sync` to `packages/router/package.json` dependencies (`workspace:*`).
- [ ] **Step 4: Run to verify pass** — `pnpm --filter cyrus-router test:run && pnpm --filter cyrus-agent typecheck` (CLI package name — confirm with `grep '"name"' apps/cli/package.json` and use that filter).
- [ ] **Step 5: Commit** — `git commit -m "feat(router): wire container executors, lifecycle, and secrets into RouterServer"`

---

### Task 9: Router CLI — set-executor, secrets, containers

**Files:**
- Modify: `apps/cli/src/commands/RouterCommand.ts`
- Test: follow the existing test location for CLI commands (`ls apps/cli/test/` — if RouterCommand has no test file, add `apps/cli/test/RouterCommand.containers.test.ts` exercising the store/secret effects directly through a temp cyrus-home).

**New subcommands** (extend the `execute` switch and usage strings):

```
cyrus router users set-executor <email> <device|docker|fly|codespaces>
cyrus router secrets set <email> <claudeOauthToken|githubPat|gitUserName|gitUserEmail|dotfilesRepo> <value>
cyrus router secrets unset <email> <key>
cyrus router containers list
cyrus router containers destroy <issueKey>
```

Behaviors:
- `set-executor`: `store.setUserExecutor(email, type === "device" ? null : JSON.stringify({ type }))`; error message when user unknown. Print a reminder: `"Existing containers for this user will be replaced on their next routed event; idle ones are stopped by the lifecycle sweep."`
- `secrets set/unset`: `new SecretStore(join(cyrusHome, "router", "user-secrets.json"))` (same default as Task 8), key validated against `USER_SECRET_KEYS`.
- `containers list`: table of `ISSUE KEY / PROVIDER / USER / LAST ROUTED / LAST SEEN` from `store.listContainerDevices()` + `store.getUserEmail`.
- `containers destroy <issueKey>`: delete the device row (`getContainerDeviceForIssue` → `deleteContainerDevice`); print `"Provider resources will be garbage-collected as orphans on the router's next sweep."` (the running router's orphan GC from Task 7 does the actual `docker rm`).

- [ ] **Step 1: Write failing tests** for each subcommand's store/file effect (construct `RouterCommand` the way existing CLI tests construct commands; if none exist, test the underlying calls through a thin exported helper).
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Verify pass** (`pnpm --filter <cli-pkg-name> test:run`).
- [ ] **Step 5: Commit** — `git commit -m "feat(cli): router subcommands for executors, secrets, and containers"`

---

### Task 10: Edge-worker floor sync — WorkspaceSyncService

**Files:**
- Create: `packages/edge-worker/src/WorkspaceSyncService.ts`
- Modify: `packages/edge-worker/src/EdgeWorker.ts` (instantiate + hook `sessionTerminal` + flush in `stop()`), `packages/edge-worker/package.json` (dep `cyrus-workspace-sync: workspace:*`), `packages/core/src/config-schemas.ts` (router object gains `floorSync: z.boolean().optional()`)
- Test: `packages/edge-worker/test/WorkspaceSyncService.test.ts`

**Interfaces:**
- Consumes: `buildBundle`/`uploadBundle`/`toHttpBase` (Task 3), `GitService.pushWipIfDirty` + `deriveWorktreeBranchName` (existing), edge-worker state file at `<cyrusHome>/state/edge-worker-state.json`.
- Produces:

```typescript
export class WorkspaceSyncService {
	constructor(opts: {
		cyrusHome: string;
		routerUrl: string;
		deviceToken: string;
		gitService: Pick<GitService, "pushWipIfDirty" | "deriveWorktreeBranchName">;
		logger: { info(msg: string): void; warn(msg: string): void };
		intervalMs?: number;          // default 5 * 60_000
		claudeProjectsDir?: string;   // default join(homedir(), ".claude", "projects"); test seam
	});
	/** Marks an issue as having activity; it will be flushed on the next interval tick. */
	touch(issueKey: string): void;
	/** WIP-push + bundle + upload for one issue. Serialized per issue; never throws. */
	syncIssue(issueKey: string): Promise<void>;
	start(): void;
	/** Stops the timer and flushes every touched issue (used on shutdown/SIGTERM). */
	stop(): Promise<void>;
}
```

**`syncIssue` behavior (encode as tests, with fetch and gitService mocked):**
1. Read + parse the state file; collect sessions whose `issue.identifier === issueKey`.
2. For each unique `workspace.path`: determine the WIP branch via `deriveWorktreeBranchName(session.issue)` and call `pushWipIfDirty(workspacePath, branch)`. If `workspacePath` itself isn't a git repo (multi-repo layout root), instead call `pushWipIfDirty` on each immediate subdirectory containing a `.git` entry. Errors are logged per-workspace and do not abort the bundle upload.
3. `buildBundle` to `<cyrusHome>/sync/<issueKey>.tar.gz`; when it returns true, `uploadBundle(toHttpBase(routerUrl), deviceToken, issueKey, file)`.
4. Concurrent `syncIssue` calls for the same issue coalesce (a simple per-issue in-flight promise map).

**EdgeWorker wiring** (guarded so non-router platforms are untouched):
- In the constructor where the router platform is configured (near the `sessionTerminal` subscription at `packages/edge-worker/src/EdgeWorker.ts:506`), when `config.platform === "router" && config.router && config.router.floorSync !== false`, create the service and `start()` it.
- Inside the existing `sessionTerminal` listener (after `sendSessionState`): look up the session (`this.agentSessionManager.getSession(sessionId)` — confirm exact getter name in `AgentSessionManager.ts` and use it), and when it has `issue?.identifier`, call `this.workspaceSync?.touch(identifier)` and `void this.workspaceSync?.syncIssue(identifier)`.
- In `EdgeWorker.stop()` (find the method that tears down `routerConnection`): `await this.workspaceSync?.stop()`.

- [ ] **Step 1: Write failing tests** — cover: session-end sync produces WIP push + upload; multi-repo root fans out to subdirs; upload skipped when no sessions match; concurrent calls coalesce; `stop()` flushes touched issues. Mock `fetch` via `vi.stubGlobal`, gitService via object literal, state file via temp dir fixture (reuse the `makeState` fixture shape from Task 3's tests).
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Verify pass** — `pnpm --filter cyrus-edge-worker test:run` (confirm package name via its package.json) and `pnpm typecheck`.
- [ ] **Step 5: Commit** — `git commit -m "feat(edge-worker): persistence-floor sync of WIP branches and state bundles to the router"`

---

### Task 11: `cyrus container-boot` command + worker image

**Files:**
- Create: `apps/cli/src/commands/ContainerBootCommand.ts` (register in the CLI's command dispatch — find the dispatch table by `grep -rn "RouterCommand" apps/cli/src/` and mirror how `router` is registered as `container-boot`)
- Create: `docker/worker/Dockerfile`, `docker/worker/entrypoint.sh` (2 lines: `#!/bin/sh` + `exec node /app/apps/cli/dist/index.js container-boot`), `docker/worker/README.md` (build/run instructions)
- Test: `apps/cli/test/ContainerBootCommand.test.ts`

**Interfaces:**
- Consumes: `downloadBundle`/`restoreBundle`/`toHttpBase` (Task 3).
- Produces: `cyrus container-boot` — the restore ladder + client launch, driven entirely by env vars:
  - Required: `CYRUS_ROUTER_URL`, `CYRUS_DEVICE_TOKEN`, `CYRUS_ISSUE_KEY`, `CYRUS_REPOS_JSON`, `CLAUDE_CODE_OAUTH_TOKEN` (validated up front; exit 1 naming any missing one, mirroring `docker/router/entrypoint.mjs`).
  - Optional: `GIT_TOKEN`, `GIT_USER_NAME`, `GIT_USER_EMAIL`, `DOTFILES_REPO`, `CYRUS_WORKSPACES_DIR` (default `/workspaces`; test seam), `CYRUS_REPO_CACHE_DIR` (default `/var/cache/repos`; test seam).

**Boot sequence (each step a tested method):**
1. `linkClaudeProjects()` — `mkdir -p $WORKSPACES/.claude-projects` and symlink `~/.claude/projects` → it (`ln -sfn` semantics via `fs.symlinkSync` after removing an existing non-link dir by renaming it aside). Claude transcripts thus live on the persistent volume.
2. `restoreState()` — cyrusHome = `$WORKSPACES/.cyrus`. If `<cyrusHome>/state/edge-worker-state.json` already exists → skip (warm volume fast path). Else `downloadBundle(toHttpBase(CYRUS_ROUTER_URL), token, issueKey, tmp)`; on true → `restoreBundle({ bundleFile: tmp, claudeProjectsDir: $WORKSPACES/.claude-projects, stateFile })`; on false → fresh start.
3. `cloneRepos()` — for each entry of `CYRUS_REPOS_JSON` (`{name, githubSlug, linearWorkspaceId, baseBranch?}`): skip if `$WORKSPACES/repos/<name>/.git` exists; else `git clone https://x-access-token:${GIT_TOKEN}@github.com/<githubSlug>.git $WORKSPACES/repos/<name>` adding `--reference-if-able $CYRUS_REPO_CACHE_DIR/<name>.git`. Without `GIT_TOKEN`, clone anonymously (public repos).
4. `writeConfig()` — write `<cyrusHome>/config.json`:

```json
{
	"platform": "router",
	"router": { "url": "<CYRUS_ROUTER_URL>", "deviceToken": "<CYRUS_DEVICE_TOKEN>", "floorSync": true },
	"repositories": [
		{
			"id": "<name>",
			"name": "<name>",
			"repositoryPath": "<WORKSPACES>/repos/<name>",
			"workspaceBaseDir": "<WORKSPACES>",
			"baseBranch": "<baseBranch ?? 'main'>",
			"linearWorkspaceId": "<linearWorkspaceId>",
			"isActive": true
		}
	]
}
```

(`workspaceBaseDir: /workspaces` is what makes worktrees land at the canonical `/workspaces/<ISSUE-KEY>` — verify the exact required `RepositoryConfigSchema` fields against `packages/core/src/config-schemas.ts` and include every required one.)
5. `configureGit()` — `git config --global user.name/email` (defaults `"Cyrus"` / `cyrus@localhost`), and when `GIT_TOKEN` set, a credential helper: write `~/.git-credentials` with `https://x-access-token:${GIT_TOKEN}@github.com` + `git config --global credential.helper store`.
6. `applyDotfiles()` — when `DOTFILES_REPO` set: clone to `~/dotfiles`, run `install.sh` if present; failures log a warning and continue.
7. `launch()` — spawn the normal start path (`cyrus start --cyrus-home $WORKSPACES/.cyrus` — reuse however `docker/router/entrypoint.mjs` spawns app.js, forwarding SIGTERM/SIGINT).

**Dockerfile** (mirror `docker/router/Dockerfile`'s multi-stage build of the monorepo; deltas): final stage installs `git`, `curl`, `jq`, and `gh` (apt), creates `/workspaces` and `/var/cache/repos`, sets `ENTRYPOINT ["/entrypoint.sh"]`. Build: `docker build -f docker/worker/Dockerfile -t cyrus-worker:dev .`

- [ ] **Step 1: Write failing tests** for steps 1–6 (pure fs/env logic with temp dirs; git calls behind an injectable exec like Task 5's). Cover: missing-env exit; warm-volume skip; 404→fresh-start; config.json shape (snapshot against `RepositoryConfigSchema.parse`); credential file written 0600.
- [ ] **Step 2: Verify failure.** **Step 3: Implement.** **Step 4: Verify pass** + build the image once locally to prove the Dockerfile: `docker build -f docker/worker/Dockerfile -t cyrus-worker:dev .` → exits 0.
- [ ] **Step 5: Commit** — `git commit -m "feat(cli): cyrus container-boot restore ladder + worker image"`

---

### Task 12: End-to-end validation, changelog, docs

**Files:**
- Create: `packages/router/test/containers-e2e.test.ts`
- Modify: `CHANGELOG.md`, `CHANGELOG.internal.md`, `docs/superpowers/specs/2026-07-13-ephemeral-container-executors-design.md` (status → Implemented (phase 1))

**e2e test** (follow the harness patterns in `packages/router/test/e2e.test.ts` — real `RouterServer` with `trackerFactory` seam, real WebSocket clients):
- `FakeBootExecutor implements ContainerExecutor`: `ensureRunning` connects a scripted WS device client using a token captured from `mintDeviceToken()` (only when recreating) or the initial `createContainerDevice` token (exposed via the store — in the test, read the token by calling `rotateContainerDeviceToken` inside `ensureRunning`).
- Scenarios:
  1. **Cold boot drains the queue**: route a created webhook for a docker-executor user → device row exists, no offline-notice activity posted, `ensureRunning` called; fake device connects → receives the queued event frame.
  2. **Terminal → idle-stop**: fake device sends `session_state` complete → affinity cleared; advance the injected clock past `idleStopMs`, run `containerLifecycle.sweep()` → `stop` called.
  3. **Executor switch**: change `executor_json` to a second fake provider; route a prompted webhook → old provider's `destroy` called, new device row created.
  4. **Boot failure notice**: `ensureRunning` rejects → exactly one `containerBootFailedMessage` activity via the tracker fake.

- [ ] **Step 1: Write the e2e test, run, fix integration bugs until green** — `pnpm --filter cyrus-router test:run`.
- [ ] **Step 2: Full gates** — `pnpm test:packages:run && pnpm typecheck && pnpm build && pnpm lint`. Expected: all pass.
- [ ] **Step 3: Manual smoke (requires local Docker + a running router)** — follow `docker/worker/README.md`: build image, `cyrus router users set-executor <you> docker`, `cyrus router secrets set <you> claudeOauthToken <token from claude setup-token>`, delegate a test issue, watch `docker ps` for `cyrus-issue-<KEY>`, confirm activities in Linear, stop container mid-session and re-prompt to watch the restore ladder. Record the transcript/notes in `docs/superpowers/specs/` as a validation appendix. (An f1 test drive covering this flow is the acceptance gate before merge — see `skills/f1-test-drive`.)
- [ ] **Step 4: Changelog** — `CHANGELOG.md` under `## [Unreleased]` / `### Added`: "Sessions can now run in ephemeral Docker containers managed by the router: assign a user to the `docker` executor and their issues each get an isolated, auto-stopping container with work persisted across restarts." `CHANGELOG.internal.md`: note new packages `cyrus-workspace-sync`, `cyrus-router-executors`, router schema v2 migration, and the artifact endpoints.
- [ ] **Step 5: Commit** — `git commit -m "test(router): container executor e2e + phase 1 changelog"`

---

## Self-review checklist (run after all tasks)

1. Every spec §"Components" item maps to a task: ExecutorRegistry/interface (5), router changes (1,4,6,7,8), secret bundle (2,9), image+entrypoint (11), floor (3,10), lifecycle (7), CLI (9), e2e (12).
2. `grep -n "TBD\|TODO\|implement later"` over this plan returns nothing.
3. Names consistent across tasks: `ContainerExecutor.ensureRunning/stop/destroy/status/listManaged`; env vars `CYRUS_ROUTER_URL/CYRUS_DEVICE_TOKEN/CYRUS_ISSUE_KEY/CYRUS_REPOS_JSON/CLAUDE_CODE_OAUTH_TOKEN/GIT_TOKEN`; store methods as declared in Task 1.
