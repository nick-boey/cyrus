import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";

const ENROLLMENT_CODE_TTL_MS = 15 * 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  linear_id TEXT,
  executor_json TEXT
);
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
CREATE TABLE IF NOT EXISTS rpc_mutations (
  device_id INTEGER NOT NULL,
  mutation_id TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (device_id, mutation_id)
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

// A user may have at most one physical device row, and an issue may have at
// most one container device row — but a container row and a physical row can
// coexist for the same user, and multiple container rows can coexist for the
// same user across different issues. Inline UNIQUE constraints can't express
// "unique among rows matching a condition", hence these partial indexes.
const INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_physical_user ON devices(user_id) WHERE kind = 'device';
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_container_issue ON devices(issue_key) WHERE kind = 'container';
`;

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function generateTokenHex(): string {
	return randomBytes(32).toString("hex");
}

interface UserRow {
	user_id: number;
	email: string;
	name: string | null;
	linear_id: string | null;
	executor_json: string | null;
}

interface DeviceRow {
	device_id: number;
	user_id: number;
	kind: string;
	issue_key: string | null;
	provider: string | null;
	token_hash: string;
	created_ms: number;
	next_seq: number;
	last_seen_ms: number | null;
	last_routed_ms: number | null;
}

interface ContainerDeviceRow {
	device_id: number;
	user_id: number;
	issue_key: string;
	provider: string;
	created_ms: number;
	last_seen_ms: number | null;
	last_routed_ms: number | null;
}

export interface ContainerDeviceInfo {
	deviceId: number;
	userId: number;
	issueKey: string;
	provider: string;
	createdMs: number;
	lastSeenMs?: number;
	lastRoutedMs?: number;
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

interface EnrollmentCodeRow {
	code_hash: string;
	user_id: number;
	expires_ms: number;
}

interface EventRow {
	device_id: number;
	seq: number;
	payload_json: string;
	enqueued_ms: number;
	expires_ms: number;
}

interface SessionAffinityRow {
	session_id: string;
	device_id: number;
	creator_json: string | null;
}

interface IssueAffinityRow {
	issue_id: string;
	device_id: number;
}

interface IssueLockRow {
	issue_id: string;
	session_id: string;
	device_id: number;
}

export class RouterStore {
	private readonly db: Database.Database;

	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		// Enforce the ON DELETE CASCADE clauses declared in SCHEMA (off by
		// default in SQLite) so removing a user/device cleans up dependent rows.
		this.db.pragma("foreign_keys = ON");
		this.db.exec(SCHEMA);
		this.migrate();
		this.db.exec(INDEXES);
	}

	/**
	 * Upgrades a v1 database (pre schema-v2, no `kind`/`executor_json`
	 * columns) in place. SCHEMA above already creates the v2 shape for fresh
	 * databases via CREATE TABLE IF NOT EXISTS, so this only does work when
	 * opening a pre-existing v1 router.db.
	 */
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
			try {
				txn();
			} finally {
				this.db.pragma("foreign_keys = ON");
			}
		}

		const userCols = this.db
			.prepare("PRAGMA table_info(users)")
			.all() as Array<{ name: string }>;
		if (
			userCols.length > 0 &&
			!userCols.some((c) => c.name === "executor_json")
		) {
			this.db.exec("ALTER TABLE users ADD COLUMN executor_json TEXT");
		}
	}

	addUser(input: { email: string; name?: string; linearId?: string }): {
		userId: number;
	} {
		const result = this.db
			.prepare("INSERT INTO users (email, name, linear_id) VALUES (?, ?, ?)")
			.run(input.email, input.name ?? null, input.linearId ?? null);
		return { userId: Number(result.lastInsertRowid) };
	}

	listUsers(): Array<{
		userId: number;
		email: string;
		name?: string;
		linearId?: string;
		deviceEnrolled: boolean;
	}> {
		const rows = this.db
			.prepare(
				`SELECT u.user_id, u.email, u.name, u.linear_id,
					(SELECT 1 FROM devices d WHERE d.user_id = u.user_id) AS has_device
				 FROM users u`,
			)
			.all() as Array<UserRow & { has_device: number | null }>;
		return rows.map((row) => ({
			userId: row.user_id,
			email: row.email,
			name: row.name ?? undefined,
			linearId: row.linear_id ?? undefined,
			deviceEnrolled: row.has_device === 1,
		}));
	}

	/**
	 * Removes a user entirely — a deliberate, total operation, unlike
	 * {@link revokeDevice} (which only detaches a physical device, e.g. a
	 * laptop swap, and must never touch that user's containers — see its own
	 * doc comment). A user can own MULTIPLE device rows at once: at most one
	 * physical `kind = 'device'` row, plus any number of per-issue `kind =
	 * 'container'` rows. All of them cascade away via `devices.user_id ON
	 * DELETE CASCADE` when the `users` row below is deleted — that part was
	 * already correct. What was NOT correct: only the FIRST device row
	 * (`.get()`, not `.all()`) had its scoped rows purged, so a second/third
	 * device (typically a container) would cascade its `devices` row away
	 * while stranding its `issue_locks`/`session_affinity`/`issue_affinity`/
	 * `rpc_mutations` rows pointed at a now-nonexistent device_id — those
	 * tables have no FK back to `devices`. Loop over every device row so none
	 * of them strand anything, matching the single-device guarantee
	 * {@link redeemEnrollmentCode} already gives.
	 *
	 * Note this does NOT call into any {@link ExecutorRegistry} to
	 * `destroy()` a removed user's live containers — `RouterStore` is a pure
	 * DB layer with no executor wiring. Their container/volume are reaped the
	 * same deliberate way `cyrus router containers destroy <issueKey>`
	 * already reaps one: `ContainerLifecycle`'s orphan-GC sweep destroys any
	 * provider-managed container whose device row is gone, on its next tick.
	 * That is an accepted, documented latency (see `ContainerLifecycle`'s
	 * class doc comment), not an oversight — removing a user is exactly the
	 * case where reaping their containers IS the intended outcome, unlike the
	 * `revokeDevice` bug this fix-pass also closes.
	 */
	removeUser(email: string): boolean {
		const txn = this.db.transaction(() => {
			const user = this.db
				.prepare("SELECT user_id FROM users WHERE email = ? COLLATE NOCASE")
				.get(email) as Pick<UserRow, "user_id"> | undefined;
			if (!user) return false;
			const deviceRows = this.db
				.prepare("SELECT device_id FROM devices WHERE user_id = ?")
				.all(user.user_id) as Array<Pick<DeviceRow, "device_id">>;
			// The devices/events rows cascade away via ON DELETE CASCADE, but
			// session_affinity/issue_affinity/issue_locks/rpc_mutations have no
			// FK — purge them explicitly, for EVERY device row, so none of them
			// strand a dead device_id.
			for (const deviceRow of deviceRows) {
				this.purgeDeviceScopedRows(deviceRow.device_id);
			}
			const result = this.db
				.prepare("DELETE FROM users WHERE user_id = ?")
				.run(user.user_id);
			return result.changes > 0;
		});
		return txn();
	}

	/**
	 * Deletes all rows keyed by device_id in the tables that have no foreign
	 * key back to `devices` (session_affinity, issue_affinity, issue_locks,
	 * rpc_mutations). Callers that delete or replace a device row (directly
	 * or via cascading a user delete) MUST call this first/atomically so
	 * those rows don't strand pointing at a device_id that no longer exists.
	 */
	private purgeDeviceScopedRows(deviceId: number): void {
		this.db
			.prepare("DELETE FROM issue_locks WHERE device_id = ?")
			.run(deviceId);
		this.db
			.prepare("DELETE FROM issue_affinity WHERE device_id = ?")
			.run(deviceId);
		this.db
			.prepare("DELETE FROM session_affinity WHERE device_id = ?")
			.run(deviceId);
		this.db
			.prepare("DELETE FROM rpc_mutations WHERE device_id = ?")
			.run(deviceId);
	}

	findUserForCreator(creator: {
		id?: string;
		email?: string;
	}): { userId: number; email: string } | undefined {
		if (creator.id !== undefined) {
			const row = this.db
				.prepare("SELECT user_id, email FROM users WHERE linear_id = ?")
				.get(creator.id) as Pick<UserRow, "user_id" | "email"> | undefined;
			if (row) return { userId: row.user_id, email: row.email };
		}
		if (creator.email !== undefined) {
			const row = this.db
				.prepare(
					"SELECT user_id, email FROM users WHERE email = ? COLLATE NOCASE",
				)
				.get(creator.email) as Pick<UserRow, "user_id" | "email"> | undefined;
			if (row) return { userId: row.user_id, email: row.email };
		}
		return undefined;
	}

	mintEnrollmentCode(email: string, nowMs: number): string {
		const user = this.db
			.prepare("SELECT user_id FROM users WHERE email = ? COLLATE NOCASE")
			.get(email) as Pick<UserRow, "user_id"> | undefined;
		if (!user) {
			throw new Error(`Unknown user: ${email}`);
		}
		const code = generateTokenHex();
		const codeHash = sha256Hex(code);
		this.db
			.prepare(
				"INSERT INTO enrollment_codes (code_hash, user_id, expires_ms) VALUES (?, ?, ?)",
			)
			.run(codeHash, user.user_id, nowMs + ENROLLMENT_CODE_TTL_MS);
		return code;
	}

	redeemEnrollmentCode(
		code: string,
		nowMs: number,
	): { deviceId: number; deviceToken: string } | undefined {
		const codeHash = sha256Hex(code);
		const txn = this.db.transaction(() => {
			const codeRow = this.db
				.prepare(
					"SELECT code_hash, user_id, expires_ms FROM enrollment_codes WHERE code_hash = ?",
				)
				.get(codeHash) as EnrollmentCodeRow | undefined;
			if (!codeRow) return undefined;

			// Burn the code regardless of expiry (one-time use).
			this.db
				.prepare("DELETE FROM enrollment_codes WHERE code_hash = ?")
				.run(codeHash);

			if (codeRow.expires_ms < nowMs) {
				return undefined;
			}

			const token = generateTokenHex();
			const tokenHash = sha256Hex(token);
			// The old device row (if any) is about to be deleted by INSERT OR
			// REPLACE below. foreign_keys=ON only cascades that delete into
			// `events` — session_affinity/issue_affinity/issue_locks/
			// rpc_mutations have no FK and would otherwise strand rows keyed
			// by the dead device_id (e.g. an issue lock the new device could
			// never acquire). Purge them first, atomically, in this txn.
			const oldDeviceRow = this.db
				.prepare("SELECT device_id FROM devices WHERE user_id = ?")
				.get(codeRow.user_id) as Pick<DeviceRow, "device_id"> | undefined;
			if (oldDeviceRow) {
				this.purgeDeviceScopedRows(oldDeviceRow.device_id);
			}
			// INSERT OR REPLACE: UNIQUE(user_id) means any existing device row
			// for this user is deleted and a fresh row is inserted (getting a
			// new AUTOINCREMENT device_id, never reused, and — with
			// foreign_keys=ON — cascading away any leftover queued events tied
			// to the old device_id). This is what "replaces any existing
			// device for that user" means: a clean device identity, not an
			// in-place field update.
			const result = this.db
				.prepare(
					`INSERT OR REPLACE INTO devices (user_id, token_hash, created_ms, next_seq, last_seen_ms)
					 VALUES (?, ?, ?, 1, NULL)`,
				)
				.run(codeRow.user_id, tokenHash, nowMs);

			return { deviceId: Number(result.lastInsertRowid), deviceToken: token };
		});
		return txn();
	}

	getDeviceByToken(
		token: string,
	): { deviceId: number; userId: number } | undefined {
		const tokenHash = sha256Hex(token);
		const row = this.db
			.prepare("SELECT device_id, user_id FROM devices WHERE token_hash = ?")
			.get(tokenHash) as Pick<DeviceRow, "device_id" | "user_id"> | undefined;
		if (!row) return undefined;
		return { deviceId: row.device_id, userId: row.user_id };
	}

	getDeviceForUser(userId: number): { deviceId: number } | undefined {
		const row = this.db
			.prepare(
				"SELECT device_id FROM devices WHERE user_id = ? AND kind = 'device'",
			)
			.get(userId) as Pick<DeviceRow, "device_id"> | undefined;
		if (!row) return undefined;
		return { deviceId: row.device_id };
	}

	/**
	 * Revokes a user's PHYSICAL device only (e.g. they got a new laptop) —
	 * scoped to `kind = 'device'`, matching {@link getDeviceForUser}. Must
	 * NEVER delete a user's `kind = 'container'` rows: those back live,
	 * possibly mid-session ephemeral containers, and this call has no
	 * `active session affinity` guard the way {@link ContainerLifecycle}'s
	 * idle/stale sweep does. Before this scoping, revoking a teammate's
	 * laptop deleted every device row for that user_id — physical AND
	 * container — and `ContainerLifecycle`'s orphan-GC pass would then
	 * `destroy()` (container AND volume) every one of their running
	 * containers within one sweep tick, unconditionally killing in-flight
	 * sessions. Removing a user ENTIRELY (rather than just their physical
	 * device) is a separate, deliberate operation — see {@link removeUser}.
	 */
	revokeDevice(email: string): boolean {
		const user = this.db
			.prepare("SELECT user_id FROM users WHERE email = ? COLLATE NOCASE")
			.get(email) as Pick<UserRow, "user_id"> | undefined;
		if (!user) return false;
		const result = this.db
			.prepare("DELETE FROM devices WHERE user_id = ? AND kind = 'device'")
			.run(user.user_id);
		return result.changes > 0;
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

	getContainerDeviceForIssue(
		issueKey: string,
	): ContainerDeviceInfo | undefined {
		const row = this.db
			.prepare(
				`SELECT device_id, user_id, issue_key, provider, created_ms, last_seen_ms, last_routed_ms
				 FROM devices WHERE kind = 'container' AND issue_key = ?`,
			)
			.get(issueKey) as ContainerDeviceRow | undefined;
		return row ? toContainerDeviceInfo(row) : undefined;
	}

	getDeviceInfo(deviceId: number):
		| {
				kind: "device" | "container";
				userId: number;
				issueKey?: string;
				provider?: string;
		  }
		| undefined {
		const row = this.db
			.prepare(
				"SELECT kind, user_id, issue_key, provider FROM devices WHERE device_id = ?",
			)
			.get(deviceId) as
			| {
					kind: string;
					user_id: number;
					issue_key: string | null;
					provider: string | null;
			  }
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
			.prepare(
				"UPDATE devices SET token_hash = ? WHERE device_id = ? AND kind = 'container'",
			)
			.run(sha256Hex(token), deviceId);
		if (result.changes === 0)
			throw new Error(`Unknown container device: ${deviceId}`);
		return token;
	}

	deleteContainerDevice(deviceId: number): void {
		const txn = this.db.transaction(() => {
			this.purgeDeviceScopedRows(deviceId);
			this.db
				.prepare(
					"DELETE FROM devices WHERE device_id = ? AND kind = 'container'",
				)
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
			.prepare(
				"UPDATE users SET executor_json = ? WHERE email = ? COLLATE NOCASE",
			)
			.run(executorJson, email);
		return result.changes > 0;
	}

	getUserExecutor(userId: number): string | undefined {
		const row = this.db
			.prepare("SELECT executor_json FROM users WHERE user_id = ?")
			.get(userId) as { executor_json: string | null } | undefined;
		return row?.executor_json ?? undefined;
	}

	getUserEmail(userId: number): string | undefined {
		const row = this.db
			.prepare("SELECT email FROM users WHERE user_id = ?")
			.get(userId) as { email: string } | undefined;
		return row?.email;
	}

	enqueueEvent(
		deviceId: number,
		payloadJson: string,
		nowMs: number,
		ttlMs: number,
	): number {
		const txn = this.db.transaction(() => {
			const deviceRow = this.db
				.prepare("SELECT next_seq FROM devices WHERE device_id = ?")
				.get(deviceId) as Pick<DeviceRow, "next_seq"> | undefined;
			if (!deviceRow) {
				throw new Error(`Unknown device: ${deviceId}`);
			}
			const seq = deviceRow.next_seq;
			this.db
				.prepare("UPDATE devices SET next_seq = ? WHERE device_id = ?")
				.run(seq + 1, deviceId);
			this.db
				.prepare(
					`INSERT INTO events (device_id, seq, payload_json, enqueued_ms, expires_ms)
					 VALUES (?, ?, ?, ?, ?)`,
				)
				.run(deviceId, seq, payloadJson, nowMs, nowMs + ttlMs);
			// Drives the container idle-stop policy (Task 8); harmless for
			// physical devices, which ignore last_routed_ms.
			this.db
				.prepare("UPDATE devices SET last_routed_ms = ? WHERE device_id = ?")
				.run(nowMs, deviceId);
			return seq;
		});
		return txn();
	}

	recordMutation(
		deviceId: number,
		mutationId: string,
		responseJson: string,
		nowMs: number,
	): void {
		this.db
			.prepare(
				`INSERT OR REPLACE INTO rpc_mutations (device_id, mutation_id, response_json, created_ms)
				 VALUES (?, ?, ?, ?)`,
			)
			.run(deviceId, mutationId, responseJson, nowMs);
	}

	getMutation(deviceId: number, mutationId: string): string | undefined {
		const row = this.db
			.prepare(
				"SELECT response_json FROM rpc_mutations WHERE device_id = ? AND mutation_id = ?",
			)
			.get(deviceId, mutationId) as
			| Pick<{ response_json: string }, "response_json">
			| undefined;
		return row?.response_json;
	}

	touchDevice(deviceId: number, nowMs: number): void {
		this.db
			.prepare("UPDATE devices SET last_seen_ms = ? WHERE device_id = ?")
			.run(nowMs, deviceId);
	}

	devicesOfflineSince(
		cutoffMs: number,
	): Array<{ deviceId: number; userId: number; email: string }> {
		const rows = this.db
			.prepare(
				`SELECT d.device_id, d.user_id, u.email
				 FROM devices d
				 JOIN users u ON u.user_id = d.user_id
				 WHERE d.last_seen_ms IS NOT NULL AND d.last_seen_ms < ?`,
			)
			.all(cutoffMs) as Array<{
			device_id: number;
			user_id: number;
			email: string;
		}>;
		return rows.map((row) => ({
			deviceId: row.device_id,
			userId: row.user_id,
			email: row.email,
		}));
	}

	pendingEvents(
		deviceId: number,
		afterSeq: number,
		nowMs: number,
	): Array<{ seq: number; payloadJson: string }> {
		const rows = this.db
			.prepare(
				`SELECT seq, payload_json FROM events
				 WHERE device_id = ? AND seq > ? AND expires_ms > ?
				 ORDER BY seq ASC`,
			)
			.all(deviceId, afterSeq, nowMs) as Array<
			Pick<EventRow, "seq" | "payload_json">
		>;
		return rows.map((row) => ({
			seq: row.seq,
			payloadJson: row.payload_json,
		}));
	}

	ackEvent(deviceId: number, seq: number): void {
		// Cumulative ack: deletes every queued event with seq <= the given
		// seq (not just the exact seq), since a client acking N implicitly
		// confirms receipt of everything before N too.
		this.db
			.prepare("DELETE FROM events WHERE device_id = ? AND seq <= ?")
			.run(deviceId, seq);
	}

	expireEvents(
		nowMs: number,
	): Array<{ deviceId: number; seq: number; payloadJson: string }> {
		const txn = this.db.transaction(() => {
			const rows = this.db
				.prepare(
					"SELECT device_id, seq, payload_json FROM events WHERE expires_ms <= ?",
				)
				.all(nowMs) as Array<
				Pick<EventRow, "device_id" | "seq" | "payload_json">
			>;
			this.db.prepare("DELETE FROM events WHERE expires_ms <= ?").run(nowMs);
			return rows.map((row) => ({
				deviceId: row.device_id,
				seq: row.seq,
				payloadJson: row.payload_json,
			}));
		});
		return txn();
	}

	setSessionAffinity(
		sessionId: string,
		deviceId: number,
		creatorJson?: string,
	): void {
		this.db
			.prepare(
				`INSERT INTO session_affinity (session_id, device_id, creator_json)
				 VALUES (?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
					device_id = excluded.device_id,
					creator_json = excluded.creator_json`,
			)
			.run(sessionId, deviceId, creatorJson ?? null);
	}

	getSessionAffinity(sessionId: string): number | undefined {
		const row = this.db
			.prepare("SELECT device_id FROM session_affinity WHERE session_id = ?")
			.get(sessionId) as Pick<SessionAffinityRow, "device_id"> | undefined;
		return row?.device_id;
	}

	getSessionCreator(sessionId: string): string | undefined {
		const row = this.db
			.prepare("SELECT creator_json FROM session_affinity WHERE session_id = ?")
			.get(sessionId) as Pick<SessionAffinityRow, "creator_json"> | undefined;
		return row?.creator_json ?? undefined;
	}

	clearSessionAffinity(sessionId: string): void {
		this.db
			.prepare("DELETE FROM session_affinity WHERE session_id = ?")
			.run(sessionId);
	}

	setIssueAffinity(issueId: string, deviceId: number): void {
		this.db
			.prepare(
				`INSERT INTO issue_affinity (issue_id, device_id)
				 VALUES (?, ?)
				 ON CONFLICT(issue_id) DO UPDATE SET device_id = excluded.device_id`,
			)
			.run(issueId, deviceId);
	}

	getIssueAffinity(issueId: string): number | undefined {
		const row = this.db
			.prepare("SELECT device_id FROM issue_affinity WHERE issue_id = ?")
			.get(issueId) as Pick<IssueAffinityRow, "device_id"> | undefined;
		return row?.device_id;
	}

	/**
	 * Deletes a single issue's affinity row. Used by {@link EventRouter} to
	 * heal a dangling row that points at a device that no longer exists (e.g.
	 * `revokeDevice` deletes the `devices` row without purging
	 * `issue_affinity`, and `issue_affinity.device_id` has no FK cascade) —
	 * without this, a live row can keep pointing at nothing forever.
	 */
	clearIssueAffinity(issueId: string): void {
		this.db
			.prepare("DELETE FROM issue_affinity WHERE issue_id = ?")
			.run(issueId);
	}

	acquireIssueLock(
		issueId: string,
		sessionId: string,
		deviceId: number,
	): boolean {
		const txn = this.db.transaction(() => {
			const existing = this.db
				.prepare(
					"SELECT session_id, device_id FROM issue_locks WHERE issue_id = ?",
				)
				.get(issueId) as
				| Pick<IssueLockRow, "session_id" | "device_id">
				| undefined;
			if (!existing) {
				this.db
					.prepare(
						"INSERT INTO issue_locks (issue_id, session_id, device_id) VALUES (?, ?, ?)",
					)
					.run(issueId, sessionId, deviceId);
				return true;
			}
			return existing.session_id === sessionId;
		});
		return txn();
	}

	getIssueLock(
		issueId: string,
	): { sessionId: string; deviceId: number } | undefined {
		const row = this.db
			.prepare(
				"SELECT session_id, device_id FROM issue_locks WHERE issue_id = ?",
			)
			.get(issueId) as
			| Pick<IssueLockRow, "session_id" | "device_id">
			| undefined;
		if (!row) return undefined;
		return { sessionId: row.session_id, deviceId: row.device_id };
	}

	releaseIssueLockForSession(sessionId: string): void {
		this.db
			.prepare("DELETE FROM issue_locks WHERE session_id = ?")
			.run(sessionId);
	}

	releaseLocksAndAffinityForDevice(
		deviceId: number,
	): Array<{ issueId: string; sessionId: string }> {
		const txn = this.db.transaction(() => {
			const rows = this.db
				.prepare(
					"SELECT issue_id, session_id FROM issue_locks WHERE device_id = ?",
				)
				.all(deviceId) as Array<Pick<IssueLockRow, "issue_id" | "session_id">>;
			this.purgeDeviceScopedRows(deviceId);
			return rows.map((row) => ({
				issueId: row.issue_id,
				sessionId: row.session_id,
			}));
		});
		return txn();
	}

	close(): void {
		this.db.close();
	}
}
