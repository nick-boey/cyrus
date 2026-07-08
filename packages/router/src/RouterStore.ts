import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";

const ENROLLMENT_CODE_TTL_MS = 15 * 60_000;

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
  created_ms INTEGER NOT NULL,
  next_seq INTEGER NOT NULL DEFAULT 1,
  last_seen_ms INTEGER
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
}

interface DeviceRow {
	device_id: number;
	user_id: number;
	token_hash: string;
	created_ms: number;
	next_seq: number;
	last_seen_ms: number | null;
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

	removeUser(email: string): boolean {
		const result = this.db
			.prepare("DELETE FROM users WHERE email = ? COLLATE NOCASE")
			.run(email);
		return result.changes > 0;
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
			.prepare("SELECT device_id FROM devices WHERE user_id = ?")
			.get(userId) as Pick<DeviceRow, "device_id"> | undefined;
		if (!row) return undefined;
		return { deviceId: row.device_id };
	}

	revokeDevice(email: string): boolean {
		const user = this.db
			.prepare("SELECT user_id FROM users WHERE email = ? COLLATE NOCASE")
			.get(email) as Pick<UserRow, "user_id"> | undefined;
		if (!user) return false;
		const result = this.db
			.prepare("DELETE FROM devices WHERE user_id = ?")
			.run(user.user_id);
		return result.changes > 0;
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
			this.db
				.prepare("DELETE FROM issue_locks WHERE device_id = ?")
				.run(deviceId);
			this.db
				.prepare("DELETE FROM issue_affinity WHERE device_id = ?")
				.run(deviceId);
			this.db
				.prepare("DELETE FROM session_affinity WHERE device_id = ?")
				.run(deviceId);
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
