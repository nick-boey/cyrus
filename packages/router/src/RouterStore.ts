import { createHash, randomBytes } from "node:crypto";
import Database from "better-sqlite3";

const ENROLLMENT_CODE_TTL_MS = 15 * 60_000;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  linear_id TEXT,
  executor_json TEXT,
  entra_object_id TEXT,
  default_runner_json TEXT,
  codex_auth_sealed TEXT
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
  last_routed_ms INTEGER,
  parked_at_ms INTEGER,
  running_since_ms INTEGER,
  last_active_ms INTEGER
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
  traceparent TEXT,
  tracestate TEXT,
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
  session_id TEXT PRIMARY KEY, device_id INTEGER NOT NULL, creator_json TEXT, established_ms INTEGER
);
CREATE TABLE IF NOT EXISTS issue_affinity (
  issue_id TEXT PRIMARY KEY, device_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS issue_locks (
  issue_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, device_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_claims (
  idempotency_key TEXT PRIMARY KEY, claimed_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS container_teardowns (
  issue_key TEXT PRIMARY KEY,
  device_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  registered_ms INTEGER NOT NULL,
  deadline_ms INTEGER NOT NULL,
  callback_id TEXT,
  callback_received_ms INTEGER,
  callback_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS issue_repositories (
  issue_key TEXT PRIMARY KEY,
  repos_json TEXT NOT NULL,
  overrides_json TEXT NOT NULL,
  method TEXT NOT NULL,
  decided_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_repo_selections (
  agent_session_id TEXT PRIMARY KEY,
  issue_key TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  options_json TEXT NOT NULL,
  created_event TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS repo_devcontainer_images (
  cache_key TEXT PRIMARY KEY,
  repository_name TEXT NOT NULL,
  disk_name TEXT NOT NULL,
  image_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  run_id TEXT,
  error TEXT,
  updated_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS issue_disk_images (
  issue_key TEXT PRIMARY KEY,
  repository_name TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  disk_name TEXT NOT NULL,
  image_ref TEXT NOT NULL,
  deployment_disk TEXT NOT NULL,
  decided_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_devcontainer_builds (
  agent_session_id TEXT PRIMARY KEY,
  issue_key TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  created_event TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
`;

// A user may have at most one physical device row, and an issue may have at
// most one container device row — but a container row and a physical row can
// coexist for the same user, and multiple container rows can coexist for the
// same user across different issues. Inline UNIQUE constraints can't express
// "unique among rows matching a condition", hence these partial indexes.
//
// `idx_webhook_claims_claimed_ms` is a plain index, not a constraint: it exists
// so the bounded retention sweep (`sweepWebhookClaims`) deletes by age without
// scanning the whole table. Uniqueness of the key itself comes from
// `webhook_claims.idempotency_key`'s PRIMARY KEY.
const INDEXES = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_physical_user ON devices(user_id) WHERE kind = 'device';
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_container_issue ON devices(issue_key) WHERE kind = 'container';
CREATE INDEX IF NOT EXISTS idx_webhook_claims_claimed_ms ON webhook_claims(claimed_ms);
CREATE INDEX IF NOT EXISTS idx_pending_devcontainer_builds_cache_key ON pending_devcontainer_builds(cache_key);
CREATE INDEX IF NOT EXISTS idx_issue_disk_images_cache_key ON issue_disk_images(cache_key);
`;

function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function generateTokenHex(): string {
	return randomBytes(32).toString("hex");
}

/**
 * Best-effort read of the `creator_json` stored on a `session_affinity` row
 * (the Linear webhook's `agentSession.creator`). Only `email`/`name` are pulled
 * out, for display in `sessions list`; a null or unparseable blob yields an
 * empty object rather than throwing, since this is diagnostic output.
 */
function parseCreator(creatorJson: string | null): {
	email?: string;
	name?: string;
} {
	if (!creatorJson) return {};
	try {
		const parsed = JSON.parse(creatorJson) as {
			email?: string;
			name?: string;
		};
		return { email: parsed.email, name: parsed.name };
	} catch {
		return {};
	}
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
	parked_at_ms: number | null;
	running_since_ms: number | null;
	last_active_ms: number | null;
}

interface ContainerDeviceRow {
	device_id: number;
	user_id: number;
	issue_key: string;
	provider: string;
	created_ms: number;
	last_seen_ms: number | null;
	last_routed_ms: number | null;
	parked_at_ms: number | null;
	running_since_ms: number | null;
	last_active_ms: number | null;
}

export interface ContainerDeviceInfo {
	deviceId: number;
	userId: number;
	issueKey: string;
	provider: string;
	createdMs: number;
	lastSeenMs?: number;
	lastRoutedMs?: number;
	/**
	 * When a session on this device last parked (blocked on a user answer with
	 * no work in flight). Read by ContainerLifecycle as part of the idle clock;
	 * absent when no session is parked.
	 */
	parkedAtMs?: number;
	/**
	 * When the container most recently transitioned to running, and therefore
	 * the base for CONTINUOUS uptime. Absent while it is stopped/parked.
	 *
	 * Distinct from {@link createdMs}, which is the device ROW's age: the row
	 * survives every stop/resume cycle, so `createdMs` answers "how long has
	 * this issue had a sandbox", never "how long has this sandbox been burning
	 * 4 vCPU". Only this field can answer the latter, which is what the
	 * long-running-sandbox alert is built on.
	 *
	 * Set-if-absent on boot (see {@link markDeviceRunning}) so a routed event
	 * against an already-running container does not restart the clock, and
	 * cleared on every transition out of running.
	 */
	runningSinceMs?: number;
	/**
	 * When this device was last observed DOING WORK — a session claiming it, or
	 * a lifecycle sweep finding it still held by live session affinity.
	 *
	 * This is the idle clock's reset. Every other input to that clock
	 * (`createdMs`, `lastRoutedMs`, `parkedAtMs`) is stamped by something the
	 * ROUTER does, and the router does nothing at all while an agent works: a
	 * session that runs for forty minutes without a new prompt leaves every one
	 * of them frozen at its start, so the container is permanently past
	 * `idleStopMs` and survives only because affinity pins it. The instant
	 * affinity lapses between two sessions on the same issue, an already-expired
	 * clock stops it mid-handoff (NOR-366).
	 *
	 * Absent for a row created before the column existed and never active since;
	 * the clock then falls back to the older inputs exactly as before.
	 */
	lastActiveMs?: number;
}

interface ContainerTeardownRow {
	issue_key: string;
	device_id: number;
	action: string;
	registered_ms: number;
	deadline_ms: number;
	callback_id: string | null;
	callback_received_ms: number | null;
	callback_attempts: number;
}

/**
 * A terminal teardown the router has registered for a container issue but not
 * yet completed. Written so `cyrus router containers list` — a SEPARATE process
 * from the running router, which therefore cannot read `TerminalTeardown`'s
 * in-memory map — can show an operator which containers are waiting on their
 * worker's authenticated teardown callback versus which have already reported in
 * and are stuck retrying the provider destroy.
 *
 * `callbackReceivedMs === undefined` is the "callback pending" state: the worker
 * has been asked to clean up and has not (yet) called back, so the grace
 * deadline in `deadlineMs` is what will eventually force destruction.
 */
export interface PendingTeardownInfo {
	issueKey: string;
	deviceId: number;
	action: "closed" | "deleted";
	registeredMs: number;
	deadlineMs: number;
	/** Idempotency key of the first callback received for this teardown. */
	callbackId?: string;
	callbackReceivedMs?: number;
	/** How many callbacks (including retries) have arrived for this teardown. */
	callbackAttempts: number;
}

function toPendingTeardownInfo(row: ContainerTeardownRow): PendingTeardownInfo {
	return {
		issueKey: row.issue_key,
		deviceId: row.device_id,
		action: row.action === "deleted" ? "deleted" : "closed",
		registeredMs: row.registered_ms,
		deadlineMs: row.deadline_ms,
		callbackId: row.callback_id ?? undefined,
		callbackReceivedMs: row.callback_received_ms ?? undefined,
		callbackAttempts: row.callback_attempts,
	};
}

/**
 * A device row (physical or container) joined to its owning user's email, for
 * `cyrus router devices list`. `email` can be undefined only in the pathological
 * case of a device row whose user was deleted without cascading — normal
 * deletes purge devices, so this is a diagnostic, not an expected state.
 */
export interface DeviceInfo {
	deviceId: number;
	userId: number;
	email?: string;
	kind: "device" | "container";
	issueKey?: string;
	provider?: string;
	createdMs: number;
	lastSeenMs?: number;
	lastRoutedMs?: number;
}

/**
 * A router-tracked session for `cyrus router sessions list`, joining
 * `session_affinity` (running sessions) with `issue_locks` (locked issues) by
 * `sessionId`. `locked` sessions carry the `issueId` — the Linear issue GUID
 * that `cyrus router unlock <issueId>` takes. A session with `locked: false`
 * and no `issueId` is running but holds no issue lock. A row can also originate
 * purely from `issue_locks` with no matching affinity (`hasAffinity: false`) —
 * a leaked/stranded lock, exactly the case an operator hunts for when unlocking.
 */
export interface SessionInfo {
	sessionId: string;
	issueId?: string;
	locked: boolean;
	hasAffinity: boolean;
	deviceId: number;
	email?: string;
	kind?: "device" | "container";
	issueKey?: string;
	creatorEmail?: string;
	creatorName?: string;
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
		parkedAtMs: row.parked_at_ms ?? undefined,
		runningSinceMs: row.running_since_ms ?? undefined,
		lastActiveMs: row.last_active_ms ?? undefined,
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
	/**
	 * W3C Trace Context captured when the event was ENQUEUED, not when it is
	 * delivered. The gap between the two is routinely minutes — an offline
	 * device, a cold sandbox boot — and it is precisely the interval a trace
	 * exists to make visible, so the context has to be persisted with the row
	 * rather than re-derived at send time (by which point the router is in some
	 * unrelated timer callback, or a different process entirely).
	 *
	 * NULL for every row enqueued with tracing off, and for every row that
	 * predates the migration.
	 */
	traceparent: string | null;
	tracestate: string | null;
}

interface SessionAffinityRow {
	session_id: string;
	device_id: number;
	creator_json: string | null;
	/** NULL only in a hand-edited database; the migration backfills existing rows. */
	established_ms: number | null;
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

/**
 * Which repositories an issue routes to, decided once by the router and reused
 * for every later event on that issue.
 *
 * Persisted rather than recomputed so a container destroyed and recreated
 * clones the SAME repository, and so a second agent session on the issue never
 * re-asks — the sandbox is per-issue and cloned at boot, so its repository
 * cannot change mid-issue.
 */
export interface StoredRepositoryDecision {
	repoNames: string[];
	/** Repository name -> base branch, from `#branch` in a description tag. */
	baseBranchOverrides: Record<string, string>;
	/** A `RoutingMethod`, kept as a string so the store stays schema-free. */
	method: string;
	decidedMs: number;
}

/**
 * One cached devcontainer build, keyed by the content hash of everything the
 * image is a function of (NOR-309 Task 4).
 *
 * `building` rows are what make the build lazy AND single-flight: the first
 * issue to need an image inserts one, and every later issue for the same key
 * joins it instead of scheduling a second ACR run.
 */
export interface DevcontainerImageRow {
	cacheKey: string;
	repositoryName: string;
	/** Derived digest name, inside the 63-character `cyrus.disk` label budget. */
	diskName: string;
	imageRef: string;
	state: "building" | "ready" | "failed";
	/** ACR run id — the load-bearing half of a failure report (ADR 0007). */
	runId?: string;
	error?: string;
	updatedMs: number;
}

/**
 * The disk an issue is pinned to, decided ONCE and never revised in place.
 *
 * This pin is what stops a repository author's devcontainer edit from
 * cold-restarting every in-flight issue on that repository: the `cyrus.disk`
 * label is compared against this row, not against whatever the repository's
 * current devcontainer would hash to, so a new devcontainer applies to
 * containers created after it and to nothing else.
 *
 * `deploymentDisk` is the other half of that split. A move of the DEPLOYMENT's
 * own worker image must still replace every sandbox — the worker feature has
 * changed underneath them — so the pin records which deployment image it was
 * made under and is treated as stale when that moves. One label, two
 * lifetimes.
 */
export interface IssueDiskImage {
	issueKey: string;
	repositoryName: string;
	cacheKey: string;
	diskName: string;
	imageRef: string;
	deploymentDisk: string;
	decidedMs: number;
}

/** A `created` webhook held while its repository's image is still building. */
export interface PendingDevcontainerBuild {
	agentSessionId: string;
	issueKey: string;
	workspaceId: string;
	cacheKey: string;
	createdEvent: string;
	createdMs: number;
}

/** An elicitation posted, with the `created` webhook held until it is answered. */
export interface PendingRepoSelection {
	agentSessionId: string;
	issueKey: string;
	workspaceId: string;
	/** The option values offered, in the order they were offered. */
	options: string[];
	/** The serialized `created` webhook, replayed once the answer arrives. */
	createdEvent: string;
	createdMs: number;
}

export class RouterStore {
	private readonly db: Database.Database;

	constructor(dbPath: string) {
		this.db = new Database(dbPath);
		this.db.pragma("journal_mode = WAL");
		// Two router processes can briefly share this file — a rolling deployment
		// overlaps the outgoing and incoming revision, and an operator CLI opens
		// the same db as the running server. WAL gives them one writer at a time;
		// without a busy timeout the loser of a write-lock race throws
		// SQLITE_BUSY immediately instead of waiting its turn, which for
		// `claimWebhookEvent` would turn a serialized claim into a thrown webhook.
		this.db.pragma("busy_timeout = 5000");
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
		// `userCols` is snapshotted above, before the executor_json ALTER, so it
		// is still the right basis for this independent check.
		if (
			userCols.length > 0 &&
			!userCols.some((c) => c.name === "entra_object_id")
		) {
			this.db.exec("ALTER TABLE users ADD COLUMN entra_object_id TEXT");
		}
		// The per-user runner/model picker (NOR-364). Deliberately NOT backfilled:
		// NULL means "no preference", which leaves `RunnerSelectionService`'s own
		// fallback chain intact and is exactly the behaviour every pre-upgrade user
		// already had. Writing a value here would be inventing a choice nobody made.
		if (
			userCols.length > 0 &&
			!userCols.some((c) => c.name === "default_runner_json")
		) {
			this.db.exec("ALTER TABLE users ADD COLUMN default_runner_json TEXT");
		}
		// The sealed Codex subscription credential (ADR 0005). Sealing is not
		// optional and this column must never hold plaintext: `users` is plain
		// SQLite and `StateBackup.upload` PUTs the raw `.db` to blob storage, so an
		// unsealed column would be a strict confidentiality downgrade from the
		// envelope-encrypted secret bundle. See {@link CodexTokenStore}.
		if (
			userCols.length > 0 &&
			!userCols.some((c) => c.name === "codex_auth_sealed")
		) {
			this.db.exec("ALTER TABLE users ADD COLUMN codex_auth_sealed TEXT");
		}

		// Re-read rather than reusing `deviceCols`: that snapshot predates the
		// v1->v2 rebuild above, which recreates the table without this column.
		const deviceColsNow = this.db
			.prepare("PRAGMA table_info(devices)")
			.all() as Array<{ name: string }>;
		if (
			deviceColsNow.length > 0 &&
			!deviceColsNow.some((c) => c.name === "parked_at_ms")
		) {
			this.db.exec("ALTER TABLE devices ADD COLUMN parked_at_ms INTEGER");
		}

		// Deliberately NOT backfilled. NULL means "not currently running", which
		// is the honest answer for every pre-upgrade row: the router has no idea
		// whether their containers are up, and inventing a start time would put
		// fabricated uptimes straight into the long-running-sandbox alert.
		// The lifecycle sweep reconciles each row against its provider's real
		// state within one 60s tick, so the gap is bounded and self-healing.
		if (
			deviceColsNow.length > 0 &&
			!deviceColsNow.some((c) => c.name === "running_since_ms")
		) {
			this.db.exec("ALTER TABLE devices ADD COLUMN running_since_ms INTEGER");
		}

		// Backfilled to migration time, unlike `running_since_ms` above, and for
		// the opposite reason. This column only ever DELAYS an idle-stop, so the
		// two directions of error are not symmetric: leaving it NULL makes every
		// pre-upgrade container instantly eligible for the stop this column exists
		// to prevent, while backfilling costs at most one extra `idleStopMs` before
		// a genuinely idle container is parked. Erring toward the survivable side
		// is the whole point of the fix (NOR-366).
		if (
			deviceColsNow.length > 0 &&
			!deviceColsNow.some((c) => c.name === "last_active_ms")
		) {
			this.db.exec("ALTER TABLE devices ADD COLUMN last_active_ms INTEGER");
			this.db
				.prepare(
					"UPDATE devices SET last_active_ms = ? WHERE kind = 'container'",
				)
				.run(Date.now());
		}

		// Deliberately NOT backfilled, and there is nothing sensible to backfill
		// with: a row enqueued before this column existed was produced by a
		// router that had no trace to record. NULL is the honest answer and the
		// delivery path already treats it as "no trace context", so a
		// pre-upgrade event is simply delivered without one and the device starts
		// its own trace.
		//
		// The two columns are checked independently rather than as a pair: these
		// `ALTER`s run outside a transaction, so a crash between them would leave
		// a database with one column and not the other, and a paired check would
		// then skip the repair forever.
		const eventCols = this.db
			.prepare("PRAGMA table_info(events)")
			.all() as Array<{ name: string }>;
		if (eventCols.length > 0) {
			if (!eventCols.some((c) => c.name === "traceparent")) {
				this.db.exec("ALTER TABLE events ADD COLUMN traceparent TEXT");
			}
			if (!eventCols.some((c) => c.name === "tracestate")) {
				this.db.exec("ALTER TABLE events ADD COLUMN tracestate TEXT");
			}
		}

		// Existing rows predate the column. Backfill them to migration time rather
		// than leaving NULL: the offline age-out path reads this as a clock, and
		// treating every pre-upgrade row as infinitely old would lift the affinity
		// gate on devices we have not actually verified.
		const affinityCols = this.db
			.prepare("PRAGMA table_info(session_affinity)")
			.all() as Array<{ name: string }>;
		if (
			affinityCols.length > 0 &&
			!affinityCols.some((c) => c.name === "established_ms")
		) {
			this.db.exec(
				"ALTER TABLE session_affinity ADD COLUMN established_ms INTEGER",
			);
			this.db
				.prepare(
					"UPDATE session_affinity SET established_ms = ? WHERE established_ms IS NULL",
				)
				.run(Date.now());
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
		expectedEmail?: string,
	): { deviceId: number; deviceToken: string } | undefined {
		const codeHash = sha256Hex(code);
		const txn = this.db.transaction(() => {
			const codeRow = this.db
				.prepare(
					`SELECT ec.code_hash, ec.user_id, ec.expires_ms, u.email
					 FROM enrollment_codes ec
					 JOIN users u ON u.user_id = ec.user_id
					 WHERE ec.code_hash = ?`,
				)
				.get(codeHash) as (EnrollmentCodeRow & { email: string }) | undefined;
			if (!codeRow) return undefined;
			if (
				expectedEmail !== undefined &&
				codeRow.email.toLowerCase() !== expectedEmail.toLowerCase()
			) {
				return undefined;
			}

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
				.prepare(
					"SELECT device_id FROM devices WHERE user_id = ? AND kind = 'device'",
				)
				.get(codeRow.user_id) as Pick<DeviceRow, "device_id"> | undefined;
			if (oldDeviceRow) {
				this.purgeDeviceScopedRows(oldDeviceRow.device_id);
			}
			// INSERT OR REPLACE: the partial unique physical-device index means an
			// existing physical row for this user is deleted and a fresh row is
			// inserted (getting a new AUTOINCREMENT device_id, never reused, and — with
			// foreign_keys=ON — cascading away any leftover queued events tied
			// to the old device_id). This is what "replaces any existing
			// device for that user" means: a clean device identity, not an
			// in-place field update.
			const result = this.db
				.prepare(
					`INSERT OR REPLACE INTO devices (user_id, kind, token_hash, created_ms, next_seq, last_seen_ms)
					 VALUES (?, 'device', ?, ?, 1, NULL)`,
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
				`SELECT device_id, user_id, issue_key, provider, created_ms, last_seen_ms, last_routed_ms, parked_at_ms, running_since_ms, last_active_ms
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
			// The teardown row is keyed by issue, not device, so it has no FK to
			// cascade from — drop it explicitly. Once the container row is gone
			// there is nothing left to tear down, whether we got here from a
			// completed teardown, `containers destroy`, or a user removal.
			this.db
				.prepare("DELETE FROM container_teardowns WHERE device_id = ?")
				.run(deviceId);
			// The workspace-image PIN is keyed by issue too, and dropping it here
			// is what makes the disk it names collectable: the GC counts a pin as
			// a live reference, so a pin outliving its container would keep that
			// disk forever. Read the issue key off the row before it goes.
			const device = this.db
				.prepare(
					"SELECT issue_key FROM devices WHERE device_id = ? AND kind = 'container'",
				)
				.get(deviceId) as { issue_key: string | null } | undefined;
			if (device?.issue_key) {
				this.db
					.prepare("DELETE FROM issue_disk_images WHERE issue_key = ?")
					.run(device.issue_key);
			}
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
				`SELECT device_id, user_id, issue_key, provider, created_ms, last_seen_ms, last_routed_ms, parked_at_ms, running_since_ms, last_active_ms
				 FROM devices WHERE kind = 'container'`,
			)
			.all() as ContainerDeviceRow[];
		return rows.map(toContainerDeviceInfo);
	}

	/**
	 * Stamp when a session on this device parked — blocked on a user answer with
	 * no work in flight.
	 *
	 * ContainerLifecycle folds this into its idle clock. Without it the clock is
	 * `last_routed_ms`, so an agent that worked for twenty minutes and only then
	 * asked a question would be suspended on the very next sweep, the clock
	 * having expired while it was legitimately busy.
	 */
	setDeviceParkedAt(deviceId: number, parkedAtMs: number): void {
		this.db
			.prepare("UPDATE devices SET parked_at_ms = ? WHERE device_id = ?")
			.run(parkedAtMs, deviceId);
	}

	clearDeviceParkedAt(deviceId: number): void {
		this.db
			.prepare("UPDATE devices SET parked_at_ms = NULL WHERE device_id = ?")
			.run(deviceId);
	}

	/**
	 * Start this device's continuous-uptime clock, if it isn't already running.
	 *
	 * SET-IF-NULL is the whole point of the method. `boot()` runs on every
	 * routed event, and `ensureRunning` is idempotent — for an already-running
	 * container it returns immediately. An unconditional stamp would therefore
	 * reset the clock every time a user sent a comment, and a sandbox that had
	 * genuinely been pinned for eight hours would report an uptime of seconds,
	 * which is precisely the case the 6-hour alert exists to catch.
	 *
	 * Returns true when this call actually started the clock, so callers can
	 * emit the `running` transition event exactly once per running period
	 * rather than once per routed webhook.
	 */
	markDeviceRunning(deviceId: number, nowMs: number): boolean {
		const result = this.db
			.prepare(
				"UPDATE devices SET running_since_ms = ? WHERE device_id = ? AND running_since_ms IS NULL",
			)
			.run(nowMs, deviceId);
		return result.changes > 0;
	}

	/**
	 * Stop the continuous-uptime clock — the container is parked, stopped, or
	 * gone. Idempotent; returns true only when a clock was actually running, so
	 * the caller can emit a stop transition exactly once.
	 */
	/**
	 * Reset this device's idle clock: it is doing work right now.
	 *
	 * UNCONDITIONAL, which is the exact opposite of {@link markDeviceRunning}'s
	 * set-if-null contract, and deliberately so. `running_since_ms` answers "how
	 * long has this sandbox been up", so it must survive re-stamping; this column
	 * answers "when did it last do anything", so re-stamping IS the semantics.
	 * Conflating the two is what NOR-366 was: with only the uptime clock and the
	 * router-side stamps, a continuously busy sandbox looked idle from the moment
	 * it was five minutes old.
	 *
	 * Harmless for physical devices — nothing reads `last_active_ms` for them —
	 * exactly as `last_routed_ms` already is.
	 */
	markDeviceActive(deviceId: number, nowMs: number): void {
		this.db
			.prepare("UPDATE devices SET last_active_ms = ? WHERE device_id = ?")
			.run(nowMs, deviceId);
	}

	clearDeviceRunningSince(deviceId: number): boolean {
		const result = this.db
			.prepare(
				"UPDATE devices SET running_since_ms = NULL WHERE device_id = ? AND running_since_ms IS NOT NULL",
			)
			.run(deviceId);
		return result.changes > 0;
	}

	// ── Terminal teardown bookkeeping ──────────────────────────────────────
	// Owned by TerminalTeardown; persisted (rather than kept purely in that
	// object's map) so the out-of-process `containers list` CLI can report
	// callback-pending state, and so a repeated callback can be recognised as a
	// retry of the same logical delivery.

	/**
	 * Record a registered terminal teardown. An existing row for the issue is
	 * overwritten, which is what upgrades a `closed` teardown to `deleted`
	 * without losing any callback already received for it.
	 */
	upsertPendingTeardown(input: {
		issueKey: string;
		deviceId: number;
		action: "closed" | "deleted";
		registeredMs: number;
		deadlineMs: number;
	}): void {
		this.db
			.prepare(
				`INSERT INTO container_teardowns
					(issue_key, device_id, action, registered_ms, deadline_ms)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(issue_key) DO UPDATE SET
					device_id = excluded.device_id,
					action = excluded.action,
					deadline_ms = excluded.deadline_ms`,
			)
			.run(
				input.issueKey,
				input.deviceId,
				input.action,
				input.registeredMs,
				input.deadlineMs,
			);
	}

	/**
	 * Note that a worker's teardown callback arrived. Returns the row as it
	 * stands AFTER the update, plus whether this was a retry — i.e. a callback
	 * carrying an id we had already recorded, which the caller logs distinctly
	 * from a first delivery and from grace expiry.
	 */
	recordTeardownCallback(
		issueKey: string,
		callbackId: string | undefined,
		nowMs: number,
	): { info: PendingTeardownInfo; retry: boolean } | undefined {
		const existing = this.getPendingTeardown(issueKey);
		if (!existing) return undefined;
		const retry =
			existing.callbackReceivedMs !== undefined &&
			(callbackId === undefined || existing.callbackId === callbackId);
		this.db
			.prepare(
				`UPDATE container_teardowns
				 SET callback_id = COALESCE(callback_id, ?),
					callback_received_ms = COALESCE(callback_received_ms, ?),
					callback_attempts = callback_attempts + 1
				 WHERE issue_key = ?`,
			)
			.run(callbackId ?? null, nowMs, issueKey);
		const info = this.getPendingTeardown(issueKey);
		return info ? { info, retry } : undefined;
	}

	getPendingTeardown(issueKey: string): PendingTeardownInfo | undefined {
		const row = this.db
			.prepare(
				`SELECT issue_key, device_id, action, registered_ms, deadline_ms,
					callback_id, callback_received_ms, callback_attempts
				 FROM container_teardowns WHERE issue_key = ?`,
			)
			.get(issueKey) as ContainerTeardownRow | undefined;
		return row ? toPendingTeardownInfo(row) : undefined;
	}

	listPendingTeardowns(): PendingTeardownInfo[] {
		const rows = this.db
			.prepare(
				`SELECT issue_key, device_id, action, registered_ms, deadline_ms,
					callback_id, callback_received_ms, callback_attempts
				 FROM container_teardowns ORDER BY issue_key`,
			)
			.all() as ContainerTeardownRow[];
		return rows.map(toPendingTeardownInfo);
	}

	deletePendingTeardown(issueKey: string): void {
		this.db
			.prepare("DELETE FROM container_teardowns WHERE issue_key = ?")
			.run(issueKey);
	}

	/**
	 * Drop every teardown row. Called once when the router builds its
	 * `TerminalTeardown`: that coordinator starts with an empty in-memory map
	 * and no re-armed grace timers, so any surviving row is a ghost from the
	 * previous process that would otherwise make `containers list` claim a
	 * callback is pending forever. Destruction of those containers falls to the
	 * lifecycle sweep's stale-destroy backstop, exactly as it did before this
	 * table existed.
	 */
	clearPendingTeardowns(): number {
		return this.db.prepare("DELETE FROM container_teardowns").run().changes;
	}

	/**
	 * Every device row (physical and container) joined to its owning user's
	 * email, for `cyrus router devices list`. Ordered by user then kind so a
	 * user's physical device sorts ahead of their container devices.
	 */
	listDevices(): DeviceInfo[] {
		const rows = this.db
			.prepare(
				`SELECT d.device_id, d.user_id, d.kind, d.issue_key, d.provider,
					d.created_ms, d.last_seen_ms, d.last_routed_ms, u.email
				 FROM devices d
				 LEFT JOIN users u ON u.user_id = d.user_id
				 ORDER BY d.user_id, d.kind, d.issue_key`,
			)
			.all() as Array<DeviceRow & { email: string | null }>;
		return rows.map((row) => ({
			deviceId: row.device_id,
			userId: row.user_id,
			email: row.email ?? undefined,
			kind: row.kind as "device" | "container",
			issueKey: row.issue_key ?? undefined,
			provider: row.provider ?? undefined,
			createdMs: row.created_ms,
			lastSeenMs: row.last_seen_ms ?? undefined,
			lastRoutedMs: row.last_routed_ms ?? undefined,
		}));
	}

	/**
	 * Every router-tracked session — running (from `session_affinity`) and any
	 * stranded issue lock with no matching affinity (from `issue_locks`) — joined
	 * to the owning device/user and, when locked, the Linear issue GUID. Powers
	 * `cyrus router sessions list`, whose primary job is letting an operator find
	 * the `issueId` a stuck session holds so they can `cyrus router unlock` it.
	 */
	listSessions(): SessionInfo[] {
		const affinityRows = this.db
			.prepare(
				`SELECT sa.session_id, sa.device_id, sa.creator_json,
					il.issue_id AS locked_issue_id,
					d.kind, d.issue_key, u.email
				 FROM session_affinity sa
				 LEFT JOIN issue_locks il ON il.session_id = sa.session_id
				 LEFT JOIN devices d ON d.device_id = sa.device_id
				 LEFT JOIN users u ON u.user_id = d.user_id`,
			)
			.all() as Array<{
			session_id: string;
			device_id: number;
			creator_json: string | null;
			locked_issue_id: string | null;
			kind: string | null;
			issue_key: string | null;
			email: string | null;
		}>;

		// Locks whose session has NO affinity row — leaked/stranded. These are the
		// most important rows for an operator hunting a stuck issue to unlock, so
		// surface them even though there is no running session behind them.
		const orphanLockRows = this.db
			.prepare(
				`SELECT il.session_id, il.issue_id, il.device_id,
					d.kind, d.issue_key, u.email
				 FROM issue_locks il
				 LEFT JOIN devices d ON d.device_id = il.device_id
				 LEFT JOIN users u ON u.user_id = d.user_id
				 WHERE il.session_id NOT IN (SELECT session_id FROM session_affinity)`,
			)
			.all() as Array<{
			session_id: string;
			issue_id: string;
			device_id: number;
			kind: string | null;
			issue_key: string | null;
			email: string | null;
		}>;

		const sessions: SessionInfo[] = affinityRows.map((row) => {
			const creator = parseCreator(row.creator_json);
			return {
				sessionId: row.session_id,
				issueId: row.locked_issue_id ?? undefined,
				locked: row.locked_issue_id !== null,
				hasAffinity: true,
				deviceId: row.device_id,
				email: row.email ?? undefined,
				kind: (row.kind as "device" | "container" | null) ?? undefined,
				issueKey: row.issue_key ?? undefined,
				creatorEmail: creator.email,
				creatorName: creator.name,
			};
		});

		for (const row of orphanLockRows) {
			sessions.push({
				sessionId: row.session_id,
				issueId: row.issue_id,
				locked: true,
				hasAffinity: false,
				deviceId: row.device_id,
				email: row.email ?? undefined,
				kind: (row.kind as "device" | "container" | null) ?? undefined,
				issueKey: row.issue_key ?? undefined,
			});
		}

		return sessions;
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

	/**
	 * The Entra `oid` this user row was first bound to.
	 *
	 * Interim mitigation for NOR-274 (re-keying identity from mutable email to
	 * `(tenantId, oid)`): recording it now is what gives that migration the data
	 * it needs, and lets {@link SetupBootstrap} warn when a known email presents
	 * a different Entra object — the UPN-rename / email-reuse signal.
	 */
	getUserEntraObjectId(userId: number): string | undefined {
		const row = this.db
			.prepare("SELECT entra_object_id FROM users WHERE user_id = ?")
			.get(userId) as { entra_object_id: string | null } | undefined;
		return row?.entra_object_id ?? undefined;
	}

	setUserEntraObjectId(userId: number, objectId: string): boolean {
		const result = this.db
			.prepare("UPDATE users SET entra_object_id = ? WHERE user_id = ?")
			.run(objectId, userId);
		return result.changes > 0;
	}

	/**
	 * The user's stored runner/model preference, as the raw
	 * `default_runner_json` literal. Parsed by `resolveDefaultRunner`, which
	 * owns every degradation rule; this is deliberately a dumb accessor so the
	 * store never has an opinion about which runners exist.
	 */
	getUserDefaultRunner(userId: number): string | undefined {
		const row = this.db
			.prepare("SELECT default_runner_json FROM users WHERE user_id = ?")
			.get(userId) as { default_runner_json: string | null } | undefined;
		return row?.default_runner_json ?? undefined;
	}

	/** Writes (or, with `null`, clears) the runner/model preference. */
	setUserDefaultRunner(
		userId: number,
		defaultRunnerJson: string | null,
	): boolean {
		const result = this.db
			.prepare("UPDATE users SET default_runner_json = ? WHERE user_id = ?")
			.run(defaultRunnerJson, userId);
		return result.changes > 0;
	}

	/**
	 * The user's sealed Codex credential envelope, as stored JSON.
	 *
	 * Opaque to the store on purpose: sealing and opening happen in
	 * {@link CodexTokenStore}, which holds the `KeyWrapper`. Nothing here can
	 * read the credential, which is what keeps the plaintext out of the SQLite
	 * file that `StateBackup` uploads.
	 */
	getUserCodexAuth(userId: number): string | undefined {
		const row = this.db
			.prepare("SELECT codex_auth_sealed FROM users WHERE user_id = ?")
			.get(userId) as { codex_auth_sealed: string | null } | undefined;
		return row?.codex_auth_sealed ?? undefined;
	}

	/** Writes (or, with `null`, clears) the sealed Codex credential. */
	setUserCodexAuth(userId: number, sealed: string | null): boolean {
		const result = this.db
			.prepare("UPDATE users SET codex_auth_sealed = ? WHERE user_id = ?")
			.run(sealed, userId);
		return result.changes > 0;
	}

	/**
	 * Case-insensitive lookup by email, matching `users.email`'s
	 * `UNIQUE COLLATE NOCASE`. `SetupBootstrap` already feature-detects this
	 * method; the `/setup` routes need it to resolve a signed-in principal's
	 * stored preferences without scanning every user.
	 */
	getUserByEmail(
		email: string,
	): { userId: number; email: string; name?: string } | undefined {
		const row = this.db
			.prepare(
				"SELECT user_id, email, name FROM users WHERE email = ? COLLATE NOCASE",
			)
			.get(email) as
			| { user_id: number; email: string; name: string | null }
			| undefined;
		if (!row) return undefined;
		return {
			userId: row.user_id,
			email: row.email,
			...(row.name ? { name: row.name } : {}),
		};
	}

	getUserEmail(userId: number): string | undefined {
		const row = this.db
			.prepare("SELECT email FROM users WHERE user_id = ?")
			.get(userId) as { email: string } | undefined;
		return row?.email;
	}

	/**
	 * Claims a webhook delivery's idempotency key, returning `true` only for the
	 * caller that won the claim. Every later caller presenting the same key gets
	 * `false` and must drop the delivery instead of routing it.
	 *
	 * This is the router's exactly-once-execution gate, so the claim MUST be a
	 * write that the database itself arbitrates — never a read-then-write
	 * ("does this key exist? no → insert"), which is racy the moment two router
	 * processes share this file. Instead the single `INSERT OR IGNORE` leans on
	 * `webhook_claims.idempotency_key`'s PRIMARY KEY: SQLite serializes the two
	 * writers (WAL + the `busy_timeout` set in the constructor), the second one's
	 * insert conflicts, and `changes === 0` reports the loss. `.immediate()` takes
	 * the write lock when the transaction opens rather than upgrading a read lock
	 * mid-transaction, so concurrent claimers queue instead of deadlocking.
	 *
	 * Callers claim BEFORE doing any routing work, which makes this at-most-once
	 * execution: a crash between the claim and the routing loses that event
	 * rather than duplicating it. That is the intended trade — a redelivery is
	 * already the only reason this table exists, and the router replies 200 to
	 * Linear before routing anyway, so a rejected claim is never retried.
	 */
	claimWebhookEvent(key: string, nowMs: number): boolean {
		const txn = this.db.transaction(() => {
			const result = this.db
				.prepare(
					"INSERT OR IGNORE INTO webhook_claims (idempotency_key, claimed_ms) VALUES (?, ?)",
				)
				.run(key, nowMs);
			return result.changes === 1;
		});
		return txn.immediate();
	}

	/** Whether a key has already been claimed (diagnostics; the claim itself is {@link claimWebhookEvent}). */
	hasWebhookClaim(key: string): boolean {
		const row = this.db
			.prepare("SELECT 1 FROM webhook_claims WHERE idempotency_key = ?")
			.get(key);
		return row !== undefined;
	}

	/**
	 * Deletes webhook claims older than `cutoffMs`, returning how many went. The
	 * table is append-only otherwise, so this bound is the only thing keeping it
	 * from growing for the life of the deployment. Driven by
	 * {@link EventRouter.sweepExpired}, alongside the event-TTL and stale-lock
	 * passes.
	 */
	sweepWebhookClaims(cutoffMs: number): number {
		const result = this.db
			.prepare("DELETE FROM webhook_claims WHERE claimed_ms < ?")
			.run(cutoffMs);
		return result.changes;
	}

	/**
	 * @param traceContext W3C Trace Context for the span this event is being
	 * enqueued under, persisted with the row so a delivery minutes later still
	 * joins the trace that produced it. Omit it entirely when tracing is off.
	 */
	enqueueEvent(
		deviceId: number,
		payloadJson: string,
		nowMs: number,
		ttlMs: number,
		traceContext?: { traceparent?: string; tracestate?: string },
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
					`INSERT INTO events (device_id, seq, payload_json, enqueued_ms, expires_ms, traceparent, tracestate)
					 VALUES (?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					deviceId,
					seq,
					payloadJson,
					nowMs,
					nowMs + ttlMs,
					traceContext?.traceparent ?? null,
					traceContext?.tracestate ?? null,
				);
			// Drives the container idle-stop policy (Task 8); harmless for
			// physical devices, which ignore last_routed_ms.
			this.db
				.prepare("UPDATE devices SET last_routed_ms = ? WHERE device_id = ?")
				.run(nowMs, deviceId);
			return seq;
		});
		return txn();
	}

	/**
	 * Repair a regressed event-sequence counter against the high-water mark the
	 * device reports at `hello`.
	 *
	 * `next_seq` lives in SQLite on ephemeral per-revision disk and is restored
	 * from a ≤5-minute-stale blob on every revision rollover, while the device's
	 * `lastAckedSeq` survives in its floor bundle. When the restore rolls
	 * `next_seq` back to at or below the device's `lastAckedSeq`, every event we
	 * subsequently issue carries a seq the device discards as a duplicate
	 * (`RouterConnection.onEvent`) — permanently, and with no signal on either
	 * side. See NOR-263.
	 *
	 * Fast-forwarding past the device's mark is the only safe reconciliation:
	 * the events the lost seqs belonged to are already gone from our side, and
	 * refusing the device instead would leave it deaf until an operator noticed.
	 *
	 * Queued events with `seq <= lastAckedSeq` are **resequenced above the mark
	 * rather than treated as duplicates**. Under detected skew such a row is
	 * far more likely to be a victim — an event enqueued at a rolled-back seq
	 * between the restore and this `hello` — than a genuine replay, and the
	 * caller's normal already-acked purge would otherwise delete it undelivered.
	 * Re-delivering a true duplicate is recoverable; dropping a user's prompt
	 * silently is the bug being fixed.
	 *
	 * A no-op (`repaired: false`) on the overwhelmingly common healthy path.
	 */
	reconcileDeviceSeq(
		deviceId: number,
		lastAckedSeq: number,
		nowMs: number,
	): {
		repaired: boolean;
		previousNextSeq: number;
		nextSeq: number;
		resequenced: number;
	} {
		const txn = this.db.transaction(() => {
			const deviceRow = this.db
				.prepare("SELECT next_seq FROM devices WHERE device_id = ?")
				.get(deviceId) as Pick<DeviceRow, "next_seq"> | undefined;
			if (!deviceRow) {
				throw new Error(`Unknown device: ${deviceId}`);
			}
			const previousNextSeq = deviceRow.next_seq;
			if (previousNextSeq > lastAckedSeq) {
				return {
					repaired: false,
					previousNextSeq,
					nextSeq: previousNextSeq,
					resequenced: 0,
				};
			}

			// Only live rows are worth moving; an expired one is left in place
			// for the periodic expireEvents sweep. Every issued seq is < next_seq
			// <= lastAckedSeq here, so this is in practice the whole queue.
			const victims = this.db
				.prepare(
					`SELECT seq, payload_json, enqueued_ms, expires_ms, traceparent, tracestate FROM events
					 WHERE device_id = ? AND seq <= ? AND expires_ms > ?
					 ORDER BY seq ASC`,
				)
				.all(deviceId, lastAckedSeq, nowMs) as Array<
				Pick<
					EventRow,
					| "seq"
					| "payload_json"
					| "enqueued_ms"
					| "expires_ms"
					| "traceparent"
					| "tracestate"
				>
			>;

			let nextSeq = lastAckedSeq + 1;
			for (const victim of victims) {
				// Delete-then-insert, not UPDATE: the new seq is always above
				// lastAckedSeq and therefore above every old seq, so the rewrite
				// cannot collide with a row still waiting its turn.
				this.db
					.prepare("DELETE FROM events WHERE device_id = ? AND seq = ?")
					.run(deviceId, victim.seq);
				this.db
					.prepare(
						`INSERT INTO events (device_id, seq, payload_json, enqueued_ms, expires_ms, traceparent, tracestate)
						 VALUES (?, ?, ?, ?, ?, ?, ?)`,
					)
					.run(
						deviceId,
						nextSeq,
						victim.payload_json,
						victim.enqueued_ms,
						// TTL is preserved deliberately: resequencing must not
						// resurrect a prompt that has already aged out.
						victim.expires_ms,
						// Likewise carried across: a resequenced event is the SAME
						// event under a new seq, and dropping its trace context would
						// silently detach exactly the deliveries that a seq regression
						// makes interesting to trace (NOR-263).
						victim.traceparent,
						victim.tracestate,
					);
				nextSeq += 1;
			}

			this.db
				.prepare("UPDATE devices SET next_seq = ? WHERE device_id = ?")
				.run(nextSeq, deviceId);

			return {
				repaired: true,
				previousNextSeq,
				nextSeq,
				resequenced: victims.length,
			};
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
	): Array<{
		seq: number;
		payloadJson: string;
		traceparent?: string;
		tracestate?: string;
	}> {
		const rows = this.db
			.prepare(
				`SELECT seq, payload_json, traceparent, tracestate FROM events
				 WHERE device_id = ? AND seq > ? AND expires_ms > ?
				 ORDER BY seq ASC`,
			)
			.all(deviceId, afterSeq, nowMs) as Array<
			Pick<EventRow, "seq" | "payload_json" | "traceparent" | "tracestate">
		>;
		// NULL becomes an ABSENT property rather than an explicit `undefined`,
		// because the caller spreads the result into a frame the protocol schema
		// validates: `{ traceparent: undefined }` survives `JSON.stringify` as
		// nothing at all, but an explicitly-undefined key is a trap for any
		// future code that checks `"traceparent" in frame`.
		return rows.map((row) => ({
			seq: row.seq,
			payloadJson: row.payload_json,
			...(row.traceparent ? { traceparent: row.traceparent } : {}),
			...(row.tracestate ? { tracestate: row.tracestate } : {}),
		}));
	}

	/**
	 * Whether the device has any queued event it hasn't acked yet (acked events
	 * are deleted, so an undelivered event is simply a surviving, non-expired
	 * row). Used to gate lock reconciliation: while a `created` event the device
	 * hasn't processed is still queued, the device can't yet declare the session
	 * it's about to start — so its active-session list isn't authoritative.
	 */
	hasPendingEvents(deviceId: number, nowMs: number): boolean {
		const row = this.db
			.prepare(
				"SELECT 1 FROM events WHERE device_id = ? AND expires_ms > ? LIMIT 1",
			)
			.get(deviceId, nowMs);
		return row !== undefined;
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
		establishedMs: number = Date.now(),
	): void {
		this.db
			.prepare(
				`INSERT INTO session_affinity (session_id, device_id, creator_json, established_ms)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
					device_id = excluded.device_id,
					creator_json = excluded.creator_json,
					established_ms = excluded.established_ms`,
			)
			.run(sessionId, deviceId, creatorJson ?? null, establishedMs);
		// A device with a live session is by definition not parked. Leaving the
		// stamp would let the idle clock read from a park that has since ended.
		this.clearDeviceParkedAt(deviceId);
		// Claiming the device IS activity, and stamping it here — synchronously,
		// in the same call that creates the pin — is what closes the handoff race
		// in NOR-366. The sweep only ever learns about a pin on its next tick, so
		// between one session ending and the next one being observed there is a
		// window of up to the sweep interval in which the container looks both
		// unpinned and (without this) long past its idle deadline.
		this.markDeviceActive(deviceId, establishedMs);
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

	/**
	 * Affinity rows held for a device, with the time each claim was established.
	 * `established_ms` is NOT NULL in practice — the schema stamps it on insert and
	 * the migration backfills existing rows — so a NULL can only come from a
	 * hand-edited database. Reading that as 0 (ancient) is the safe default:
	 * reclamation additionally requires the device to not declare the session, so
	 * an ancient-looking row for a live session is still never reclaimed.
	 */
	listSessionAffinityForDevice(
		deviceId: number,
	): Array<{ sessionId: string; establishedMs: number }> {
		const rows = this.db
			.prepare(
				"SELECT session_id, established_ms FROM session_affinity WHERE device_id = ? ORDER BY established_ms ASC",
			)
			.all(deviceId) as Array<{
			session_id: string;
			established_ms: number | null;
		}>;
		return rows.map((r) => ({
			sessionId: r.session_id,
			establishedMs: r.established_ms ?? 0,
		}));
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

	/**
	 * Every issue lock currently held on behalf of a device. Used by hello-time
	 * reconciliation to find locks whose session the device no longer tracks.
	 */
	getIssueLocksForDevice(
		deviceId: number,
	): Array<{ issueId: string; sessionId: string }> {
		const rows = this.db
			.prepare(
				"SELECT issue_id, session_id FROM issue_locks WHERE device_id = ?",
			)
			.all(deviceId) as Array<Pick<IssueLockRow, "issue_id" | "session_id">>;
		return rows.map((row) => ({
			issueId: row.issue_id,
			sessionId: row.session_id,
		}));
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

	// ── Repository decisions ───────────────────────────────────────────────
	// Owned by the resolver (Task 9); read by EventRouter for repeat events on
	// an issue and by the sandbox boot path (Task 11) to build CYRUS_REPOS_JSON.

	getIssueRepositories(issueKey: string): StoredRepositoryDecision | undefined {
		const row = this.db
			.prepare(
				"SELECT repos_json, overrides_json, method, decided_ms FROM issue_repositories WHERE issue_key = ?",
			)
			.get(issueKey) as
			| {
					repos_json: string;
					overrides_json: string;
					method: string;
					decided_ms: number;
			  }
			| undefined;
		if (!row) return undefined;
		try {
			const repoNames = JSON.parse(row.repos_json) as unknown;
			const overrides = JSON.parse(row.overrides_json) as unknown;
			if (
				!Array.isArray(repoNames) ||
				!repoNames.every((name) => typeof name === "string")
			) {
				return undefined;
			}
			if (
				typeof overrides !== "object" ||
				overrides === null ||
				Array.isArray(overrides)
			) {
				return undefined;
			}
			return {
				repoNames,
				baseBranchOverrides: overrides as Record<string, string>,
				method: row.method,
				decidedMs: row.decided_ms,
			};
		} catch {
			// A corrupt row reads as absent. The resolver then re-derives the
			// decision from the registry, which is deterministic for every
			// non-ambiguous case — strictly better than throwing on a boot path.
			return undefined;
		}
	}

	setIssueRepositories(
		issueKey: string,
		decision: Omit<StoredRepositoryDecision, "decidedMs">,
		nowMs: number,
	): void {
		this.db
			.prepare(
				`INSERT INTO issue_repositories (issue_key, repos_json, overrides_json, method, decided_ms)
				 VALUES (?, ?, ?, ?, ?)
				 ON CONFLICT(issue_key) DO UPDATE SET
				   repos_json = excluded.repos_json,
				   overrides_json = excluded.overrides_json,
				   method = excluded.method,
				   decided_ms = excluded.decided_ms`,
			)
			.run(
				issueKey,
				JSON.stringify(decision.repoNames),
				JSON.stringify(decision.baseBranchOverrides),
				decision.method,
				nowMs,
			);
	}

	deleteIssueRepositories(issueKey: string): void {
		this.db
			.prepare("DELETE FROM issue_repositories WHERE issue_key = ?")
			.run(issueKey);
	}

	// ── Pending repository selections ──────────────────────────────────────
	// Owned by EventRouter (Task 10): a `created` webhook whose repository was
	// ambiguous is held here, keyed by agentSessionId, until the user answers
	// the elicitation posted for it.

	createPendingRepoSelection(row: PendingRepoSelection): void {
		this.db
			.prepare(
				`INSERT INTO pending_repo_selections
				   (agent_session_id, issue_key, workspace_id, options_json, created_event, created_ms)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(agent_session_id) DO UPDATE SET
				   issue_key = excluded.issue_key,
				   workspace_id = excluded.workspace_id,
				   options_json = excluded.options_json,
				   created_event = excluded.created_event,
				   created_ms = excluded.created_ms`,
			)
			.run(
				row.agentSessionId,
				row.issueKey,
				row.workspaceId,
				JSON.stringify(row.options),
				row.createdEvent,
				row.createdMs,
			);
	}

	getPendingRepoSelection(
		agentSessionId: string,
	): PendingRepoSelection | undefined {
		const row = this.db
			.prepare(
				"SELECT issue_key, workspace_id, options_json, created_event, created_ms FROM pending_repo_selections WHERE agent_session_id = ?",
			)
			.get(agentSessionId) as
			| {
					issue_key: string;
					workspace_id: string;
					options_json: string;
					created_event: string;
					created_ms: number;
			  }
			| undefined;
		if (!row) return undefined;
		let options: string[];
		try {
			const parsed = JSON.parse(row.options_json) as unknown;
			options = Array.isArray(parsed) ? (parsed as string[]) : [];
		} catch {
			options = [];
		}
		return {
			agentSessionId,
			issueKey: row.issue_key,
			workspaceId: row.workspace_id,
			options,
			createdEvent: row.created_event,
			createdMs: row.created_ms,
		};
	}

	deletePendingRepoSelection(agentSessionId: string): void {
		this.db
			.prepare("DELETE FROM pending_repo_selections WHERE agent_session_id = ?")
			.run(agentSessionId);
	}

	/**
	 * Drops selections created before `cutoffMs`, returning the identity of each
	 * one removed (not just a count): `EventRouter.sweepExpired` needs
	 * `workspaceId`/`agentSessionId` to post an expiry notice per swept row,
	 * mirroring how its queued-event expiry pass already does for pass 1. Select
	 * then delete in one transaction so nothing can be enqueued against a row
	 * between the two halves.
	 */
	sweepPendingRepoSelections(
		cutoffMs: number,
	): Array<{ agentSessionId: string; workspaceId: string; issueKey: string }> {
		const txn = this.db.transaction(() => {
			const rows = this.db
				.prepare(
					"SELECT agent_session_id, workspace_id, issue_key FROM pending_repo_selections WHERE created_ms < ?",
				)
				.all(cutoffMs) as Array<{
				agent_session_id: string;
				workspace_id: string;
				issue_key: string;
			}>;
			this.db
				.prepare("DELETE FROM pending_repo_selections WHERE created_ms < ?")
				.run(cutoffMs);
			return rows.map((row) => ({
				agentSessionId: row.agent_session_id,
				workspaceId: row.workspace_id,
				issueKey: row.issue_key,
			}));
		});
		return txn();
	}

	// ── Devcontainer images (NOR-309) ──────────────────────────────────────
	// Three concerns, deliberately three tables: the build CACHE keyed by
	// content hash, the per-issue PIN that decides what a boot uses, and the
	// `created` webhooks HELD while a build runs.

	getDevcontainerImage(cacheKey: string): DevcontainerImageRow | undefined {
		const row = this.db
			.prepare(
				"SELECT cache_key, repository_name, disk_name, image_ref, state, run_id, error, updated_ms FROM repo_devcontainer_images WHERE cache_key = ?",
			)
			.get(cacheKey) as
			| {
					cache_key: string;
					repository_name: string;
					disk_name: string;
					image_ref: string;
					state: string;
					run_id: string | null;
					error: string | null;
					updated_ms: number;
			  }
			| undefined;
		if (!row) return undefined;
		return {
			cacheKey: row.cache_key,
			repositoryName: row.repository_name,
			diskName: row.disk_name,
			imageRef: row.image_ref,
			state: row.state as DevcontainerImageRow["state"],
			runId: row.run_id ?? undefined,
			error: row.error ?? undefined,
			updatedMs: row.updated_ms,
		};
	}

	listDevcontainerImages(): DevcontainerImageRow[] {
		const rows = this.db
			.prepare(
				"SELECT cache_key FROM repo_devcontainer_images ORDER BY updated_ms DESC",
			)
			.all() as Array<{ cache_key: string }>;
		return rows
			.map((row) => this.getDevcontainerImage(row.cache_key))
			.filter((row): row is DevcontainerImageRow => row !== undefined);
	}

	/**
	 * Claims the right to run a build for `cacheKey`.
	 *
	 * Returns `true` only for the caller that actually inserted the `building`
	 * row. Two issues arriving on the same repository seconds apart must
	 * schedule ONE ACR run, not two — a build is minutes of agent compute, and a
	 * second one would push the same tag from a second checkout of the same ref.
	 * `INSERT … ON CONFLICT DO NOTHING` inside SQLite's single writer is the
	 * whole mutex.
	 *
	 * A `failed` row is re-claimable: a build that failed on a transient ACR or
	 * network fault must not poison the key until someone edits the repository.
	 */
	claimDevcontainerBuild(
		row: Omit<DevcontainerImageRow, "state" | "updatedMs" | "runId" | "error">,
		nowMs: number,
	): boolean {
		const result = this.db
			.prepare(
				`INSERT INTO repo_devcontainer_images
				   (cache_key, repository_name, disk_name, image_ref, state, updated_ms)
				 VALUES (?, ?, ?, ?, 'building', ?)
				 ON CONFLICT(cache_key) DO UPDATE SET
				   state = 'building',
				   run_id = NULL,
				   error = NULL,
				   updated_ms = excluded.updated_ms
				 WHERE repo_devcontainer_images.state = 'failed'`,
			)
			.run(row.cacheKey, row.repositoryName, row.diskName, row.imageRef, nowMs);
		return result.changes > 0;
	}

	finishDevcontainerBuild(
		cacheKey: string,
		outcome: { state: "ready" | "failed"; runId?: string; error?: string },
		nowMs: number,
	): void {
		this.db
			.prepare(
				`UPDATE repo_devcontainer_images
				 SET state = ?, run_id = ?, error = ?, updated_ms = ?
				 WHERE cache_key = ?`,
			)
			.run(
				outcome.state,
				outcome.runId ?? null,
				outcome.error ?? null,
				nowMs,
				cacheKey,
			);
	}

	deleteDevcontainerImage(cacheKey: string): void {
		this.db
			.prepare("DELETE FROM repo_devcontainer_images WHERE cache_key = ?")
			.run(cacheKey);
	}

	getIssueDiskImage(issueKey: string): IssueDiskImage | undefined {
		const row = this.db
			.prepare(
				"SELECT issue_key, repository_name, cache_key, disk_name, image_ref, deployment_disk, decided_ms FROM issue_disk_images WHERE issue_key = ?",
			)
			.get(issueKey) as
			| {
					issue_key: string;
					repository_name: string;
					cache_key: string;
					disk_name: string;
					image_ref: string;
					deployment_disk: string;
					decided_ms: number;
			  }
			| undefined;
		if (!row) return undefined;
		return {
			issueKey: row.issue_key,
			repositoryName: row.repository_name,
			cacheKey: row.cache_key,
			diskName: row.disk_name,
			imageRef: row.image_ref,
			deploymentDisk: row.deployment_disk,
			decidedMs: row.decided_ms,
		};
	}

	setIssueDiskImage(
		pin: Omit<IssueDiskImage, "decidedMs">,
		nowMs: number,
	): void {
		this.db
			.prepare(
				`INSERT INTO issue_disk_images
				   (issue_key, repository_name, cache_key, disk_name, image_ref, deployment_disk, decided_ms)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT(issue_key) DO UPDATE SET
				   repository_name = excluded.repository_name,
				   cache_key = excluded.cache_key,
				   disk_name = excluded.disk_name,
				   image_ref = excluded.image_ref,
				   deployment_disk = excluded.deployment_disk,
				   decided_ms = excluded.decided_ms`,
			)
			.run(
				pin.issueKey,
				pin.repositoryName,
				pin.cacheKey,
				pin.diskName,
				pin.imageRef,
				pin.deploymentDisk,
				nowMs,
			);
	}

	deleteIssueDiskImage(issueKey: string): void {
		this.db
			.prepare("DELETE FROM issue_disk_images WHERE issue_key = ?")
			.run(issueKey);
	}

	/** Cache keys still referenced by a live issue pin — the GC's floor. */
	referencedDevcontainerCacheKeys(): string[] {
		const rows = this.db
			.prepare("SELECT DISTINCT cache_key FROM issue_disk_images")
			.all() as Array<{ cache_key: string }>;
		return rows.map((row) => row.cache_key);
	}

	createPendingDevcontainerBuild(row: PendingDevcontainerBuild): void {
		this.db
			.prepare(
				`INSERT INTO pending_devcontainer_builds
				   (agent_session_id, issue_key, workspace_id, cache_key, created_event, created_ms)
				 VALUES (?, ?, ?, ?, ?, ?)
				 ON CONFLICT(agent_session_id) DO UPDATE SET
				   issue_key = excluded.issue_key,
				   workspace_id = excluded.workspace_id,
				   cache_key = excluded.cache_key,
				   created_event = excluded.created_event,
				   created_ms = excluded.created_ms`,
			)
			.run(
				row.agentSessionId,
				row.issueKey,
				row.workspaceId,
				row.cacheKey,
				row.createdEvent,
				row.createdMs,
			);
	}

	getPendingDevcontainerBuild(
		agentSessionId: string,
	): PendingDevcontainerBuild | undefined {
		const row = this.db
			.prepare(
				"SELECT issue_key, workspace_id, cache_key, created_event, created_ms FROM pending_devcontainer_builds WHERE agent_session_id = ?",
			)
			.get(agentSessionId) as
			| {
					issue_key: string;
					workspace_id: string;
					cache_key: string;
					created_event: string;
					created_ms: number;
			  }
			| undefined;
		if (!row) return undefined;
		return {
			agentSessionId,
			issueKey: row.issue_key,
			workspaceId: row.workspace_id,
			cacheKey: row.cache_key,
			createdEvent: row.created_event,
			createdMs: row.created_ms,
		};
	}

	deletePendingDevcontainerBuild(agentSessionId: string): void {
		this.db
			.prepare(
				"DELETE FROM pending_devcontainer_builds WHERE agent_session_id = ?",
			)
			.run(agentSessionId);
	}

	/**
	 * Takes every webhook held on `cacheKey` and removes the rows in one
	 * transaction, so a build finishing can never replay the same event twice.
	 */
	takePendingDevcontainerBuilds(cacheKey: string): PendingDevcontainerBuild[] {
		const txn = this.db.transaction(() => {
			const rows = this.db
				.prepare(
					"SELECT agent_session_id, issue_key, workspace_id, cache_key, created_event, created_ms FROM pending_devcontainer_builds WHERE cache_key = ?",
				)
				.all(cacheKey) as Array<{
				agent_session_id: string;
				issue_key: string;
				workspace_id: string;
				cache_key: string;
				created_event: string;
				created_ms: number;
			}>;
			this.db
				.prepare("DELETE FROM pending_devcontainer_builds WHERE cache_key = ?")
				.run(cacheKey);
			return rows.map((row) => ({
				agentSessionId: row.agent_session_id,
				issueKey: row.issue_key,
				workspaceId: row.workspace_id,
				cacheKey: row.cache_key,
				createdEvent: row.created_event,
				createdMs: row.created_ms,
			}));
		});
		return txn();
	}

	/** Test-only escape hatch for simulating hand-edited rows. */
	rawDbForTests(): Database.Database {
		return this.db;
	}

	close(): void {
		this.db.close();
	}
}
