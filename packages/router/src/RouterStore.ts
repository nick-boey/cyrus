import { createHash, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { OperatorRoleV1 } from "cyrus-operator-protocol";
import type { SandboxGaugeState } from "./SandboxTelemetry.js";

const ENROLLMENT_CODE_TTL_MS = 15 * 60_000;

/**
 * Prefix every locally minted operator token carries.
 *
 * It is what lets one `Authorization: Bearer` header be resolved to exactly one
 * credential kind without probing: a device token is bare hex, an Entra token
 * is a JWT, and anything starting with this is an operator token. Without a
 * marker, a revoked operator token would fall through to the device lookup and
 * be reported as an unknown device rather than as the revoked credential it is.
 * It also makes a leaked token greppable in a log or a paste.
 */
export const OPERATOR_TOKEN_PREFIX = "cyop_";

/**
 * The closed role set, mirrored from `operatorRoleV1Schema` so a stored row can
 * be validated without pulling Zod into the storage layer (the import above is
 * `import type` and is erased). Read and recovery authority are separate roles,
 * never a hierarchy.
 *
 * The `Record` keyed on `OperatorRoleV1` is what makes this EXHAUSTIVE: a
 * `readonly OperatorRoleV1[]` annotation would happily accept a list missing a
 * role, and a missing role here is silently unmintable, unlistable, and
 * stripped back out of any row that already holds it.
 */
const OPERATOR_ROLE_SET: Record<OperatorRoleV1, true> = {
	"fleet.read": true,
	"fleet.recover": true,
};
export const OPERATOR_ROLES = Object.keys(
	OPERATOR_ROLE_SET,
) as OperatorRoleV1[];

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
  last_active_ms INTEGER,
  last_progress_ms INTEGER
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
CREATE TABLE IF NOT EXISTS session_ownership_grace (
  session_id TEXT PRIMARY KEY, device_id INTEGER NOT NULL, expires_ms INTEGER NOT NULL
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
CREATE TABLE IF NOT EXISTS operator_tokens (
  token_id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  roles_json TEXT NOT NULL,
  workspaces_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL,
  revoked_ms INTEGER
);
CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  device_id INTEGER NOT NULL,
  issue_key TEXT NOT NULL,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL,
  started_ms INTEGER NOT NULL,
  last_routed_ms INTEGER NOT NULL,
  last_agent_activity_ms INTEGER,
  ended_ms INTEGER,
  inputs_json TEXT NOT NULL,
  executor_kind TEXT NOT NULL,
  provider TEXT,
  issue_id TEXT,
  runner TEXT,
  model TEXT,
  wait_reason TEXT,
  wait_since_ms INTEGER,
  wait_condition TEXT,
  pending_work_count INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,
  routed_at_ms INTEGER,
  routing_enriched_ms INTEGER,
  workspace_id TEXT,
  workspace_name TEXT,
  owner_user_id TEXT,
  owner_name TEXT,
  linear_team_id TEXT,
  linear_team_name TEXT,
  linear_project_id TEXT,
  linear_project_name TEXT,
  worker_online INTEGER,
  executor_state TEXT,
  executor_state_observed_ms INTEGER
);
CREATE TABLE IF NOT EXISTS router_secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_run_changes (
  change_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  changed_ms INTEGER NOT NULL,
  observation_json TEXT NOT NULL,
  workspace_id TEXT,
  user_id INTEGER
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
CREATE INDEX IF NOT EXISTS idx_agent_runs_user_routed ON agent_runs(user_id, last_routed_ms DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_session_started ON agent_runs(session_id, started_ms DESC);
CREATE INDEX IF NOT EXISTS idx_agent_runs_ended ON agent_runs(ended_ms);
CREATE INDEX IF NOT EXISTS idx_agent_runs_device ON agent_runs(device_id);
CREATE INDEX IF NOT EXISTS idx_agent_runs_page ON agent_runs(started_ms DESC, run_id);
CREATE INDEX IF NOT EXISTS idx_agent_run_changes_run ON agent_run_changes(run_id);
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

interface OperatorTokenRow {
	token_id: number;
	label: string;
	roles_json: string;
	workspaces_json: string;
	created_ms: number;
	revoked_ms: number | null;
}

/**
 * A locally minted operator credential, WITHOUT its hash and without any way to
 * recover the raw token. Everything an authorizer or an admin listing needs.
 */
export interface OperatorTokenInfo {
	tokenId: number;
	label: string;
	roles: OperatorRoleV1[];
	workspaceIds: string[];
	createdMs: number;
	revokedMs?: number;
}

/**
 * Decodes a stored row. Roles are filtered against {@link OPERATOR_ROLES} on
 * the way out as well as on the way in: a row written by a newer router (or
 * hand-edited) must not be able to introduce a role this process does not
 * understand and would then carry, unchecked, into an authorization decision.
 */
function toOperatorTokenInfo(row: OperatorTokenRow): OperatorTokenInfo {
	return {
		tokenId: row.token_id,
		label: row.label,
		roles: (JSON.parse(row.roles_json) as string[]).filter(
			(role): role is OperatorRoleV1 =>
				(OPERATOR_ROLES as readonly string[]).includes(role),
		),
		workspaceIds: JSON.parse(row.workspaces_json) as string[],
		createdMs: row.created_ms,
		...(row.revoked_ms !== null ? { revokedMs: row.revoked_ms } : {}),
	};
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
	last_progress_ms: number | null;
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
	last_progress_ms: number | null;
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
	/**
	 * When this device last did work the router could OBSERVE — the last device-
	 * originated RPC frame it sent (see {@link RouterStore.markDeviceProgress}).
	 *
	 * Deliberately a fourth clock rather than a reuse of {@link lastActiveMs},
	 * even though both claim to mean "doing work". `lastActiveMs` is stamped by
	 * the lifecycle sweep on every tick a device holds affinity, so it is really
	 * "still pinned at time T" and moves at exactly the same rate for a working
	 * sandbox and for one whose session finished hours ago and never went
	 * terminal. It cannot distinguish them, which is the whole of NOR-402. Only
	 * an agent posting activities moves THIS one.
	 *
	 * Read by `ContainerLifecycle.noteStranded` and by nothing else — in
	 * particular NOT by the idle clock, which must keep its own (deliberately
	 * generous) inputs.
	 */
	lastProgressMs?: number;
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

/**
 * The lifecycle of an agent run — a continuous episode of work within a Linear
 * agent session.
 *
 * This is NOT the state of the machine the run executes on. There is no
 * `parked` here: park is what happens to an idle CONTAINER, and the run-level
 * concept it used to stand for is the explicitly worker-reported `waiting`.
 * `parked` survives only on the wire, as the legacy spelling a pre-run-facts
 * worker still sends.
 */
export type AgentRunState =
	| "routed"
	| "active"
	| "waiting"
	| "complete"
	| "error"
	| "stopped"
	| "unknown";

/**
 * Why a worker reported that a run cannot progress. Never inferred by the
 * router from silence, elapsed time, or executor state.
 */
export type AgentRunWaitReason = "elicitation" | "other";

export interface AgentRunWait {
	reason: AgentRunWaitReason;
	sinceMs: number;
	/** The worker's own description. Required when the reason is `other`. */
	reportedCondition?: string;
}

/**
 * The workspace, owner, and Linear context captured WHEN THE RUN'S FIRST INPUT
 * WAS ROUTED, and never rewritten afterwards.
 *
 * Historical filters read this rather than calling Linear at query time, so an
 * issue that later moves team or project does not rewrite the history of runs
 * that already happened. IDs are canonical; names are captured alongside them
 * for display, which is why a name never appears without its id.
 */
export interface AgentRunRouting {
	workspaceId?: string;
	workspaceName?: string;
	/** The Cyrus user who owns the run — the router's own `users.user_id`. */
	ownerUserId?: string;
	ownerName?: string;
	linearTeamId?: string;
	linearTeamName?: string;
	linearProjectId?: string;
	linearProjectName?: string;
	routedAtMs?: number;
}

export interface AgentRunInput {
	activityId?: string;
	commentId?: string;
	routedMs: number;
}

/** Durable run facts. Device liveness and sandbox state are joined at query time. */
export interface AgentRunInfo {
	runId: string;
	userId: number;
	deviceId: number;
	issueKey: string;
	issueId?: string;
	sessionId: string;
	state: AgentRunState;
	/** Present exactly when `state` is `waiting`. */
	wait?: AgentRunWait;
	/**
	 * Background work the run is still carrying. An active-run fact, not a wait
	 * reason — the two coexist, since a run blocked on an elicitation with a live
	 * background build is precisely what decides whether its container may park.
	 */
	pendingWorkCount?: number;
	runner?: string;
	model?: string;
	routing: AgentRunRouting;
	startedMs: number;
	lastRoutedMs: number;
	lastAgentActivityMs?: number;
	endedMs?: number;
	inputs: AgentRunInput[];
	executorKind: "device" | "container";
	provider?: string;
	lastHeartbeatMs?: number;
	/**
	 * Whether the router held a live socket for this run's worker when it last
	 * observed one. Durable, so a drop-and-reconnect between two polls is still
	 * reported by the change feed. `undefined` means never observed — which is
	 * not the same as offline, and is why the column is nullable.
	 */
	workerOnline?: boolean;
	/** Last sampled infrastructure state of the container, never worker liveness. */
	executorState?: SandboxGaugeState;
	/** Travels with {@link executorState} or not at all. */
	executorStateObservedMs?: number;
	/** Incremented on each material change; quoted by a recovery request. */
	revision: number;
}

/**
 * One durable entry in the append-only material-change feed.
 *
 * `observation` is the run AS IT WAS immediately after the change, captured in
 * the same transaction as the mutation — not a pointer to the current row. A
 * client that reconnects and replays the feed therefore sees the transition
 * itself, rather than the row's state at replay time.
 */
export interface AgentRunChange {
	changeId: number;
	runId: string;
	revision: number;
	kind: AgentRunChangeKind;
	changedMs: number;
	observation: AgentRunInfo;
}

interface AgentRunRow {
	run_id: string;
	user_id: number;
	device_id: number;
	issue_key: string;
	issue_id: string | null;
	session_id: string;
	state: string;
	wait_reason: string | null;
	wait_since_ms: number | null;
	wait_condition: string | null;
	pending_work_count: number | null;
	runner: string | null;
	model: string | null;
	revision: number;
	routed_at_ms: number | null;
	routing_enriched_ms: number | null;
	workspace_id: string | null;
	workspace_name: string | null;
	owner_user_id: string | null;
	owner_name: string | null;
	linear_team_id: string | null;
	linear_team_name: string | null;
	linear_project_id: string | null;
	linear_project_name: string | null;
	started_ms: number;
	last_routed_ms: number;
	last_agent_activity_ms: number | null;
	ended_ms: number | null;
	inputs_json: string;
	executor_kind: string;
	provider: string | null;
	worker_online: number | null;
	executor_state: string | null;
	executor_state_observed_ms: number | null;
	last_seen_ms?: number | null;
}

/**
 * Includes the legacy `parked` so a row written by a router that predates the
 * migration — or by one running concurrently mid-deploy — is still recognised
 * as a run that can resume. Dropping it here would make such a row invisible to
 * `latestNonTerminalRunId`, which would silently start a second run for the
 * same session.
 */
const NON_TERMINAL_RUN_STATES = [
	"routed",
	"active",
	"waiting",
	"parked",
] as const;

/**
 * Columns whose change is worth a new observation revision.
 *
 * Deliberately excludes `last_routed_ms`: on its own it is a freshness stamp,
 * and bumping the revision for it would make a watch a firehose of "still the
 * same". A route that actually delivers input changes `inputs_json` too, which
 * IS material — so a real routing event still increments and a repeated
 * no-change write does not.
 */
const MATERIAL_RUN_COLUMNS = new Set([
	"user_id",
	"device_id",
	"issue_key",
	"issue_id",
	"state",
	"wait_reason",
	"wait_since_ms",
	"wait_condition",
	"pending_work_count",
	"runner",
	"model",
	"routed_at_ms",
	"workspace_id",
	"workspace_name",
	"owner_user_id",
	"owner_name",
	"linear_team_id",
	"linear_team_name",
	"linear_project_id",
	"linear_project_name",
	"last_agent_activity_ms",
	"ended_ms",
	"inputs_json",
	"executor_kind",
	"provider",
	// Durable as of CYR-69. Their OBSERVATION TIMES are deliberately absent:
	// re-sampling an unchanged gauge, or a heartbeat from a worker that was
	// already online, refreshes freshness without producing a feed entry. That
	// is the whole "repeated heartbeat/gauge samples do not grow the feed"
	// property, and it falls out of this set rather than out of a special case.
	"worker_online",
	"executor_state",
]);

/**
 * The material fact a set of changed columns describes.
 *
 * These are the WIRE kinds from `runChangeKindV1Schema`, used verbatim rather
 * than translated: a store-side vocabulary mapped onto the published one at the
 * route is exactly how a router and a CLI come to disagree about what a change
 * means without either failing to compile.
 */
export type AgentRunChangeKind =
	| "routing"
	| "lifecycle"
	| "wait"
	| "worker_connectivity"
	| "executor_state"
	| "published_activity"
	| "recovery";

/**
 * Which kind a mutation reports, most specific first.
 *
 * An update routinely touches several families at once — a worker reporting
 * `waiting` writes the state AND the wait; a first published activity writes
 * the state, clears the wait, and stamps the activity — so one entry is emitted
 * under the most consequential kind rather than several under each. Order is
 * the whole definition of "most consequential", and it is what makes
 * routed→active read as `lifecycle` while a second activity on an
 * already-active run reads as `published_activity`.
 *
 * `pending_work_count` sits under `lifecycle` because it arrives on the same
 * worker frame as the state and describes what the run is still carrying — it
 * is not a wait reason, and `runChangeKindV1Schema` has no kind of its own for
 * it.
 *
 * `recovery` has no columns: nothing in this store performs a recovery yet
 * (CYR-70 owns that route), and the kind is listed so the exhaustiveness of the
 * union is visible here rather than discovered later.
 */
const CHANGE_KIND_COLUMNS: ReadonlyArray<
	readonly [AgentRunChangeKind, readonly string[]]
> = [
	["lifecycle", ["state", "ended_ms", "pending_work_count"]],
	["wait", ["wait_reason", "wait_since_ms", "wait_condition"]],
	["published_activity", ["last_agent_activity_ms"]],
	["executor_state", ["executor_state"]],
	["worker_connectivity", ["worker_online"]],
];

/**
 * Falls back to `routing` rather than throwing: every remaining material column
 * (the routing snapshot itself, the execution identity, the inputs, the issue,
 * the device) describes what the run was routed as, and a future material
 * column with no explicit kind is better reported under a broad one than
 * dropped from the feed.
 */
function changeKindFor(changedColumns: string[]): AgentRunChangeKind {
	for (const [kind, columns] of CHANGE_KIND_COLUMNS) {
		if (changedColumns.some((column) => columns.includes(column))) return kind;
	}
	return "routing";
}

/**
 * The routing dimensions a fleet query can name either by canonical id or by an
 * exact captured name. Each has an id column and the name captured beside it —
 * the pairing `runRoutingSnapshotV1Schema` enforces on the wire.
 */
export type FleetRunDimension = "workspace" | "owner" | "team" | "project";

const FLEET_RUN_DIMENSION_COLUMNS: Record<
	FleetRunDimension,
	{ idColumn: string; nameColumn: string }
> = {
	workspace: { idColumn: "workspace_id", nameColumn: "workspace_name" },
	owner: { idColumn: "owner_user_id", nameColumn: "owner_name" },
	team: { idColumn: "linear_team_id", nameColumn: "linear_team_name" },
	project: { idColumn: "linear_project_id", nameColumn: "linear_project_name" },
};

/**
 * The lifecycle a row reports, expressed in SQL so a state filter and keyset
 * pagination agree.
 *
 * Mirrors {@link readAgentRunState} exactly. Filtering on the raw `state` column
 * instead would make a legacy `parked` row invisible to a `waiting` filter while
 * still appearing in an unfiltered page — the two answers disagreeing about the
 * same row is precisely what a fleet view must not do.
 */
const LIFECYCLE_SQL = `CASE WHEN ar.state != 'parked' THEN ar.state
	 WHEN ar.ended_ms IS NULL THEN 'waiting' ELSE 'unknown' END`;

/**
 * One authorized fleet query. Every field except `workspaceIds` is an optional
 * narrowing; `workspaceIds` is the authorization boundary and is always applied.
 */
export interface FleetRunQuery {
	/** Workspaces this principal may read. Empty authorizes nothing. */
	workspaceIds: string[];
	/**
	 * Set for an owner-scoped principal (a device token), whose authority has
	 * always been its own owner's work. Compared against `agent_runs.user_id` —
	 * the router's own numeric user id — not against the captured `owner_user_id`
	 * string, so it keeps working for a run whose snapshot is incomplete.
	 */
	ownerScopeUserId?: number;
	runId?: string;
	agentSessionId?: string;
	issueId?: string;
	issueKey?: string;
	workspaceId?: string;
	ownerUserId?: string;
	linearTeamId?: string;
	linearProjectId?: string;
	lifecycle?: string;
	runner?: string;
	model?: string;
	after?: { startedMs: number; runId: string };
}

function buildFleetRunFilter(query: FleetRunQuery): {
	clauses: string[];
	params: Array<string | number>;
} {
	const clauses: string[] = [];
	const params: Array<string | number> = [];

	// Authorization first, and unconditionally. `1 = 0` rather than an early
	// return so every caller — listing, candidates — degrades to "no rows" by the
	// same path instead of each remembering to check.
	if (query.workspaceIds.length === 0) {
		clauses.push("1 = 0");
	} else {
		clauses.push(
			`ar.workspace_id IN (${query.workspaceIds.map(() => "?").join(", ")})`,
		);
		params.push(...query.workspaceIds);
	}
	if (query.ownerScopeUserId !== undefined) {
		clauses.push("ar.user_id = ?");
		params.push(query.ownerScopeUserId);
	}

	// The identity a v1 observation cannot be rendered without. `workspace_id` is
	// already implied by the authorization clause above and is not repeated.
	clauses.push("ar.issue_id IS NOT NULL", "ar.routed_at_ms IS NOT NULL");

	const equals: Array<[string | undefined, string]> = [
		[query.runId, "ar.run_id = ?"],
		[query.agentSessionId, "ar.session_id = ?"],
		[query.issueId, "ar.issue_id = ?"],
		[query.issueKey, "ar.issue_key = ? COLLATE NOCASE"],
		[query.workspaceId, "ar.workspace_id = ?"],
		[query.ownerUserId, "ar.owner_user_id = ?"],
		[query.linearTeamId, "ar.linear_team_id = ?"],
		[query.linearProjectId, "ar.linear_project_id = ?"],
		[query.lifecycle, `${LIFECYCLE_SQL} = ?`],
		[query.model, "ar.model = ?"],
	];
	for (const [value, clause] of equals) {
		if (value !== undefined) {
			clauses.push(clause);
			params.push(value);
		}
	}
	// `runner` is the one filter with a rendered placeholder behind it. A run the
	// worker has not reported a runner for is shown as `UNREPORTED_RUNNER`, and
	// `runner = 'unknown'` would match none of them — so the filter that reads
	// back the value a page displayed has to mean "no runner reported".
	if (query.runner !== undefined) {
		if (query.runner === UNREPORTED_RUNNER) {
			clauses.push("ar.runner IS NULL");
		} else {
			clauses.push("ar.runner = ?");
			params.push(query.runner);
		}
	}
	return { clauses, params };
}

function parseRunInputs(value: string): AgentRunInput[] {
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(input): input is AgentRunInput =>
				typeof input === "object" &&
				input !== null &&
				typeof (input as AgentRunInput).routedMs === "number",
		);
	} catch {
		return [];
	}
}

/**
 * The longest worker-reported wait condition this store will retain.
 *
 * It is the ONLY unbounded worker-controlled string on a run — everything else
 * in the observation is a timestamp, an identifier, or a closed enum — and it is
 * now copied into every subsequent change entry for that run and kept for 24
 * hours past terminal. A worker that reports a stack trace, or a shell
 * transcript, as its condition would multiply it across the whole feed. The cap
 * is generous enough to carry a sentence naming a condition v1 does not model,
 * which is all this field is for.
 */
const MAX_REPORTED_CONDITION_CHARS = 512;

/** See {@link RouterStore.trimAgentRunChanges}. */
const MAX_CHANGES_PER_RUN = 500;

function truncateReportedCondition(value: string | undefined): string | null {
	if (value === undefined) return null;
	return value.length <= MAX_REPORTED_CONDITION_CHARS
		? value
		: `${value.slice(0, MAX_REPORTED_CONDITION_CHARS - 1)}…`;
}

/**
 * What a run whose `runner` the worker has not reported yet is rendered as.
 *
 * Lives here rather than beside the projection that emits it because the FILTER
 * has to agree with it: `?runner=unknown` compiles to `runner IS NULL` (see
 * {@link buildFleetRunFilter}), so an operator who reads the placeholder off a
 * page and filters for it gets the runs they just saw. Two answers disagreeing
 * about the same row is the one thing a fleet view must not do.
 */
export const UNREPORTED_RUNNER = "unknown";

/**
 * Reads back an observation snapshot stored on a feed entry.
 *
 * Validates the fields a CONSUMER dereferences without checking, not merely the
 * ones this module writes. The snapshot came from a typed projection, so a deep
 * re-validation would be re-checking our own serializer; what this guards
 * against is a row from a truncated write or a future schema. `routing` is in
 * the set because the change route reaches two levels into it to decide who may
 * read the entry — a row that parsed but lacked it would throw there, and one
 * unreadable row would become a 500 for every watching principal, on a cursor
 * that never advances past it.
 */
function parseStoredObservation(value: string): AgentRunInfo | undefined {
	try {
		const parsed = JSON.parse(value) as AgentRunInfo;
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			typeof parsed.runId !== "string" ||
			typeof parsed.revision !== "number" ||
			typeof parsed.userId !== "number" ||
			typeof parsed.routing !== "object" ||
			parsed.routing === null
		) {
			return undefined;
		}
		return parsed;
	} catch {
		return undefined;
	}
}

/**
 * The wait a row records, or `undefined` when it is not waiting.
 *
 * A `parked` row is read as waiting-on-elicitation: that is what the legacy
 * state always meant, and a router mid-deploy (or a database whose migration
 * has not run yet) can still hold one. The `since` falls back the same way the
 * migration does — to the last instant the router knows something happened —
 * because the legacy frame never carried one.
 */
function readAgentRunWait(row: AgentRunRow): AgentRunWait | undefined {
	if (row.ended_ms !== null) return undefined;
	if (row.state !== "waiting" && row.state !== "parked") return undefined;
	const reason: AgentRunWaitReason =
		row.wait_reason === "other" ? "other" : "elicitation";
	return {
		reason,
		sinceMs: row.wait_since_ms ?? row.last_routed_ms,
		...(row.wait_condition ? { reportedCondition: row.wait_condition } : {}),
	};
}

/**
 * The lifecycle a row reports, with the legacy `parked` corrected on the way
 * out so the vocabulary fix cannot leak past the store.
 *
 * `ended_ms` wins over the state column. A row that ended is terminal whatever
 * its state says, and a legacy `parked` row that also ended is exactly what
 * `unknown` describes: ownership finished without a terminal outcome reaching
 * the router. Reading it as `waiting` instead would produce an ended run
 * carrying live wait evidence — the contradiction the v1 observation refuses.
 */
function readAgentRunState(row: AgentRunRow): AgentRunState {
	if (row.state !== "parked") return row.state as AgentRunState;
	return row.ended_ms === null ? "waiting" : "unknown";
}

function toAgentRunInfo(row: AgentRunRow): AgentRunInfo {
	const wait = readAgentRunWait(row);
	return {
		runId: row.run_id,
		userId: row.user_id,
		deviceId: row.device_id,
		issueKey: row.issue_key,
		issueId: row.issue_id ?? undefined,
		sessionId: row.session_id,
		state: readAgentRunState(row),
		...(wait ? { wait } : {}),
		...(row.pending_work_count !== null
			? { pendingWorkCount: row.pending_work_count }
			: {}),
		runner: row.runner ?? undefined,
		model: row.model ?? undefined,
		routing: {
			workspaceId: row.workspace_id ?? undefined,
			workspaceName: row.workspace_name ?? undefined,
			ownerUserId: row.owner_user_id ?? undefined,
			ownerName: row.owner_name ?? undefined,
			linearTeamId: row.linear_team_id ?? undefined,
			linearTeamName: row.linear_team_name ?? undefined,
			linearProjectId: row.linear_project_id ?? undefined,
			linearProjectName: row.linear_project_name ?? undefined,
			routedAtMs: row.routed_at_ms ?? undefined,
		},
		startedMs: row.started_ms,
		lastRoutedMs: row.last_routed_ms,
		lastAgentActivityMs: row.last_agent_activity_ms ?? undefined,
		endedMs: row.ended_ms ?? undefined,
		inputs: parseRunInputs(row.inputs_json),
		executorKind: row.executor_kind as "device" | "container",
		provider: row.provider ?? undefined,
		lastHeartbeatMs: row.last_seen_ms ?? undefined,
		...(row.worker_online !== null && row.worker_online !== undefined
			? { workerOnline: row.worker_online === 1 }
			: {}),
		// A sample and the instant it was taken travel together or not at all: a
		// sample that cannot be aged has to be read as current, which is exactly
		// how a stale gauge comes to look like a live fact.
		...(row.executor_state !== null && row.executor_state_observed_ms !== null
			? {
					executorState: row.executor_state as SandboxGaugeState,
					executorStateObservedMs: row.executor_state_observed_ms,
				}
			: {}),
		revision: row.revision ?? 1,
	};
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
		lastProgressMs: row.last_progress_ms ?? undefined,
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

interface SessionOwnershipGraceRow {
	session_id: string;
	device_id: number;
	expires_ms: number;
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

	/**
	 * Identifies THIS process's view of the material-change sequence.
	 *
	 * Rotated on every construction, and that is the point: `change_id` is a
	 * local AUTOINCREMENT, and the router's SQLite file lives on ephemeral
	 * storage with a periodic Blob backup, so a restore can roll the sequence
	 * backwards. A client resuming from a pre-restart cursor would then be handed
	 * entries it has already seen, silently, as though nothing had happened. The
	 * epoch turns that into a `410 Gone` the client can act on: re-list, then
	 * resume. Same reason `reconcileDeviceSeq` exists for device event sequences.
	 *
	 * Lives on the store rather than on the route because the store owns the
	 * sequence the epoch qualifies; a second component minting its own would be
	 * asserting continuity it has no way to observe.
	 */
	readonly changeStreamEpoch: string = randomBytes(9).toString("base64url");

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

		// Backfilled to migration time for the same asymmetry as `last_active_ms`
		// above, though the cost of getting it wrong is different: this column only
		// feeds the stranded-session DETECTOR, so a NULL would not stop or destroy
		// anything — it would report every pre-upgrade sandbox that happens to hold
		// affinity as stranded the moment the router restarts. A sev-1 alert that
		// storms on deploy is how a rule gets muted, so start every existing row's
		// progress clock at the upgrade instead.
		if (
			deviceColsNow.length > 0 &&
			!deviceColsNow.some((c) => c.name === "last_progress_ms")
		) {
			this.db.exec("ALTER TABLE devices ADD COLUMN last_progress_ms INTEGER");
			this.db
				.prepare(
					"UPDATE devices SET last_progress_ms = ? WHERE kind = 'container'",
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

		this.migrateAgentRunFacts();
	}

	/**
	 * The explicit run facts (CYR-68): routing snapshots, execution identity, the
	 * worker-reported wait, and the observation revision.
	 *
	 * Every column is added independently, the same way the `events` trace
	 * columns above are. These `ALTER`s run outside a transaction, so a crash
	 * partway through must leave a database that the next start repairs rather
	 * than one a paired check skips forever.
	 *
	 * NONE of the new columns is backfilled with an invented value. A run routed
	 * before this migration was routed by a router that captured no snapshot and
	 * knew no runner; writing one now would be fabricating history into exactly
	 * the columns whose whole purpose is to be a faithful record of routing time.
	 * The consequence is documented on `runObservationV1Schema`: rows written
	 * before this migration cannot be rendered as a v1 observation, so whichever
	 * issue adds `/api/v1/runs` must scope that route to runs routed after it.
	 * Terminal runs age out within 24 hours, so the gap closes on its own for all
	 * but the long-stuck runs — which are, unhelpfully, the ones an operator most
	 * needs to see.
	 */
	private migrateAgentRunFacts(): void {
		const runCols = this.db
			.prepare("PRAGMA table_info(agent_runs)")
			.all() as Array<{ name: string }>;
		if (runCols.length === 0) return;
		const have = new Set(runCols.map((c) => c.name));

		for (const [name, ddl] of [
			["issue_id", "TEXT"],
			["runner", "TEXT"],
			["model", "TEXT"],
			["wait_reason", "TEXT"],
			["wait_since_ms", "INTEGER"],
			["wait_condition", "TEXT"],
			["pending_work_count", "INTEGER"],
			// Defaulted rather than left NULL: `revision` is the value a recovery
			// request quotes to say which observation it acted on, so an absent one
			// would have every consumer handle "no revision yet" forever.
			["revision", "INTEGER NOT NULL DEFAULT 1"],
			["routed_at_ms", "INTEGER"],
			["routing_enriched_ms", "INTEGER"],
			["workspace_id", "TEXT"],
			["workspace_name", "TEXT"],
			["owner_user_id", "TEXT"],
			["owner_name", "TEXT"],
			["linear_team_id", "TEXT"],
			["linear_team_name", "TEXT"],
			["linear_project_id", "TEXT"],
			["linear_project_name", "TEXT"],
			// CYR-69. Worker connectivity and the sampled executor state used to be
			// joined at QUERY time — from a live socket registry and an in-memory
			// gauge map — which meant a worker that dropped and reconnected between
			// two polls left no trace anywhere. Both are now durable facts on the
			// run, so a change feed can report a transition that began and ended
			// between two snapshots. Left NULL rather than backfilled: "we have
			// never observed this run's worker" and "its worker is offline" are
			// different statements, and only one of them is true of a pre-migration
			// row.
			["worker_online", "INTEGER"],
			["executor_state", "TEXT"],
			["executor_state_observed_ms", "INTEGER"],
		] as const) {
			if (!have.has(name)) {
				this.db.exec(`ALTER TABLE agent_runs ADD COLUMN ${name} ${ddl}`);
			}
		}

		// The change feed's own authorization columns. Denormalised onto the entry
		// rather than joined back to the run, so a caller's page can be filtered in
		// SQL — and because an entry is a HISTORICAL fact whose readership must be
		// decided by what it captured, not by a run row that has since moved.
		const changeCols = this.db
			.prepare("PRAGMA table_info(agent_run_changes)")
			.all() as Array<{ name: string }>;
		const haveChangeCols = new Set(changeCols.map((c) => c.name));
		for (const [name, ddl] of [
			["workspace_id", "TEXT"],
			["user_id", "INTEGER"],
		] as const) {
			if (changeCols.length > 0 && !haveChangeCols.has(name)) {
				this.db.exec(`ALTER TABLE agent_run_changes ADD COLUMN ${name} ${ddl}`);
			}
		}

		// NOTE: worker connectivity is deliberately NOT reset here. See
		// {@link resetRunWorkerConnectivity}, which only the serving router calls.

		// `parked` conflated the run being blocked with its container being
		// suspendable. The run half is now `waiting`, and every retained `parked`
		// row got there exactly one way — a worker reporting an elicitation — so
		// the reason is known rather than guessed.
		//
		// Scoped to NON-TERMINAL rows. Terminal history is left exactly as
		// recorded: a run that ended is a fact about what happened, and rewriting
		// its state would be editing the past to match a vocabulary it never used.
		// (No terminal row should carry `parked` today, since `finishAgentRun`
		// overwrites the state — the guard is here so that stays true if it ever
		// stops being.)
		//
		// `wait_since_ms` is the one value with nothing exact to draw on: the
		// worker's `since` was never persisted, because the frame did not carry
		// one. `last_routed_ms` is the most recent instant the router knows
		// something happened to this run, which is the closest honest upper bound
		// on when the wait began — it can only under-state how long the run has
		// been waiting, never over-state it.
		//
		// ── ONE-WAY, AND WHAT THAT COSTS ON A DOWNGRADE ──
		// A router that predates this build has `["routed","active","parked"]` as
		// its non-terminal set, so a `waiting` row is invisible to its
		// `latestNonTerminalRunId`: it is never given an `ended_ms` by
		// `finishAgentRun`, never reclaimed by `purgeDeviceScopedRows`, never swept
		// by the 24h retention pass, and each new input starts a duplicate run
		// beside it. Rolling back therefore strands every waiting run.
		//
		// Not fixable from this side — the old build's SQL is what it is, and no
		// forward migration can teach it a state it does not know. Nor is it a
		// migration-only exposure: a row WRITTEN by this build is `waiting` too, so
		// undoing the conversion here would not avoid it. Two things bound it: the
		// forward direction is handled (this build keeps `parked` in
		// `NON_TERMINAL_RUN_STATES`, so an old router writing during a rolling
		// deploy is understood), and the stranding is bounded to non-terminal runs,
		// which `cyrus router sessions list` still surfaces. A rollback past this
		// build should be followed by
		// `UPDATE agent_runs SET state = 'parked' WHERE state = 'waiting' AND ended_ms IS NULL`.
		this.db.exec(
			`UPDATE agent_runs
			 SET state = 'waiting',
			     wait_reason = 'elicitation',
			     wait_since_ms = COALESCE(wait_since_ms, last_routed_ms)
			 WHERE state = 'parked' AND ended_ms IS NULL`,
		);
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
	 * session_ownership_grace, rpc_mutations). Callers that delete or replace a
	 * device row (directly
	 * or via cascading a user delete) MUST call this first/atomically so
	 * those rows don't strand pointing at a device_id that no longer exists.
	 */
	private purgeDeviceScopedRows(deviceId: number, nowMs = Date.now()): void {
		// Routed through {@link updateAgentRun} row by row rather than done as one
		// bulk `UPDATE … revision = revision + 1`, which is what this used to be.
		//
		// A bulk write bumps the revision and appends NOTHING, which breaks the
		// one invariant the change feed rests on: a revision a client can observe
		// is never without the entry that explains it. And this is not a rare
		// path — `releaseLocksAndAffinityForDevice` reaches it from the 60s sweep
		// for every device dark past its TTL, so a laptop that goes to sleep
		// mid-session takes its run terminal with the feed saying nothing at all.
		// A watcher would render that run `active` forever, and 24 hours later
		// the row and its history would age out beneath it.
		const live = this.db
			.prepare(
				`SELECT run_id FROM agent_runs
				 WHERE device_id = ? AND state IN (${NON_TERMINAL_RUN_STATES.map(() => "?").join(", ")})`,
			)
			.all(deviceId, ...NON_TERMINAL_RUN_STATES) as Array<
			Pick<AgentRunRow, "run_id">
		>;
		for (const row of live) {
			this.updateAgentRun(
				row.run_id,
				{
					state: "unknown",
					ended_ms: nowMs,
					wait_reason: null,
					wait_since_ms: null,
					wait_condition: null,
					pending_work_count: null,
				},
				nowMs,
			);
		}
		this.db
			.prepare("DELETE FROM issue_locks WHERE device_id = ?")
			.run(deviceId);
		this.db
			.prepare("DELETE FROM issue_affinity WHERE device_id = ?")
			.run(deviceId);
		this.db
			.prepare("DELETE FROM session_affinity WHERE device_id = ?")
			.run(deviceId);
		// A revoked/replaced device must lose its post-terminal grace too, or a
		// stale row would keep authorizing RPCs for a device_id that is gone.
		this.db
			.prepare("DELETE FROM session_ownership_grace WHERE device_id = ?")
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

	/**
	 * Mints a local operator credential for a non-Entra deployment.
	 *
	 * The raw token is returned ONCE, to the caller that asked for it, and is
	 * never persisted or logged — only `sha256(token)` reaches the database, the
	 * same way `devices.token_hash` does. `operator_tokens` is a separate table
	 * from `devices` on purpose: a device token's authority is its owner's own
	 * work, and widening that row to also carry fleet roles is exactly the
	 * broadening this feature must not do.
	 *
	 * Roles and workspaces are validated here rather than at the route, because
	 * this is the only way a row gets written: an empty role set would mint a
	 * credential that authenticates and can do nothing, and an empty workspace
	 * set one that is authorized over nothing — both indistinguishable from a
	 * revoked token at the point of use, hours after the mistake was made.
	 */
	createOperatorToken(input: {
		label: string;
		roles: OperatorRoleV1[];
		workspaceIds: string[];
		nowMs?: number;
	}): { tokenId: number; token: string } {
		const label = input.label.trim();
		if (!label) throw new Error("An operator token needs a label");
		const roles = [...new Set(input.roles)];
		if (roles.length === 0) {
			throw new Error("An operator token needs at least one role");
		}
		for (const role of roles) {
			if (!OPERATOR_ROLES.includes(role)) {
				throw new Error(
					`Unknown operator role "${role}" (expected one of: ${OPERATOR_ROLES.join(", ")})`,
				);
			}
		}
		const workspaceIds = [
			...new Set(input.workspaceIds.map((id) => id.trim()).filter(Boolean)),
		];
		if (workspaceIds.length === 0) {
			throw new Error("An operator token needs at least one workspace id");
		}
		const token = `${OPERATOR_TOKEN_PREFIX}${generateTokenHex()}`;
		const result = this.db
			.prepare(
				`INSERT INTO operator_tokens (label, token_hash, roles_json, workspaces_json, created_ms, revoked_ms)
				 VALUES (?, ?, ?, ?, ?, NULL)`,
			)
			.run(
				label,
				sha256Hex(token),
				JSON.stringify(roles),
				JSON.stringify(workspaceIds),
				input.nowMs ?? Date.now(),
			);
		return { tokenId: Number(result.lastInsertRowid), token };
	}

	/**
	 * Resolves a raw operator token to its grant, or `undefined`.
	 *
	 * A revoked row resolves to `undefined` rather than to a row carrying
	 * `revokedMs`. Fail-closed by construction: there is no shape in which a
	 * caller can hold a revoked grant and forget to check it. Revoked rows stay
	 * visible through {@link listOperatorTokens}, which is where an operator
	 * looks to confirm a revocation took.
	 */
	getOperatorTokenByToken(token: string): OperatorTokenInfo | undefined {
		const row = this.db
			.prepare(
				`SELECT token_id, label, roles_json, workspaces_json, created_ms, revoked_ms
				 FROM operator_tokens WHERE token_hash = ? AND revoked_ms IS NULL`,
			)
			.get(sha256Hex(token)) as OperatorTokenRow | undefined;
		return row ? toOperatorTokenInfo(row) : undefined;
	}

	/** Every minted token, revoked ones included. Never exposes a hash. */
	listOperatorTokens(): OperatorTokenInfo[] {
		const rows = this.db
			.prepare(
				`SELECT token_id, label, roles_json, workspaces_json, created_ms, revoked_ms
				 FROM operator_tokens ORDER BY token_id`,
			)
			.all() as OperatorTokenRow[];
		return rows.map(toOperatorTokenInfo);
	}

	/**
	 * Revokes a token. Returns `false` for an unknown id AND for one already
	 * revoked — the `revoked_ms IS NULL` guard makes the write itself the
	 * arbiter, so two concurrent revocations cannot both report success and the
	 * recorded time is the first one's.
	 */
	revokeOperatorToken(tokenId: number, nowMs?: number): boolean {
		const result = this.db
			.prepare(
				"UPDATE operator_tokens SET revoked_ms = ? WHERE token_id = ? AND revoked_ms IS NULL",
			)
			.run(nowMs ?? Date.now(), tokenId);
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

	/**
	 * Re-read ONE container device row by id.
	 *
	 * {@link listContainerDevices} takes the whole fleet in a single query, which
	 * is right for starting a sweep and wrong for deciding anything at the end of
	 * one: a lifecycle tick is sequential and blocks on provider control-plane
	 * calls, so by the time it reaches a given row that row can be many minutes
	 * old. NOR-406 is exactly that — a tick that began at 07:45:22 stopped a
	 * container at 07:51:54 using timestamps from 07:45:22, and so never saw the
	 * session routed to it at 07:51:39. Anything acting on a row rather than
	 * merely counting it re-reads it through here first.
	 *
	 * Keyed by device id rather than issue key on purpose: a row destroyed and
	 * recreated for the same issue is a DIFFERENT container, and a stale sweep
	 * must not act on its successor.
	 */
	getContainerDevice(deviceId: number): ContainerDeviceInfo | undefined {
		const row = this.db
			.prepare(
				`SELECT device_id, user_id, issue_key, provider, created_ms, last_seen_ms, last_routed_ms, parked_at_ms, running_since_ms, last_active_ms, last_progress_ms
				 FROM devices WHERE kind = 'container' AND device_id = ?`,
			)
			.get(deviceId) as ContainerDeviceRow | undefined;
		return row ? toContainerDeviceInfo(row) : undefined;
	}

	getContainerDeviceForIssue(
		issueKey: string,
	): ContainerDeviceInfo | undefined {
		const row = this.db
			.prepare(
				`SELECT device_id, user_id, issue_key, provider, created_ms, last_seen_ms, last_routed_ms, parked_at_ms, running_since_ms, last_active_ms, last_progress_ms
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
			// The container is gone, so its executor state is `absent` — recorded
			// BEFORE the purge, while the runs are still non-terminal and can carry
			// it. Only `ContainerLifecycle`'s stale-destroy path used to sample this
			// on the way out, so a run that outlived its container down any other
			// route (a terminal teardown, `containers destroy`, a user removal) kept
			// reporting `executorState: "running"` for a sandbox destroyed hours
			// earlier — the exact NOR-402 shape, described by the fleet view as
			// healthy.
			this.setRunExecutorState(deviceId, "absent", Date.now());
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
				`SELECT device_id, user_id, issue_key, provider, created_ms, last_seen_ms, last_routed_ms, parked_at_ms, running_since_ms, last_active_ms, last_progress_ms
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

	/**
	 * Stamp the device's PROGRESS clock: it just did work the router could see.
	 *
	 * Called from the one device→router frame that is evidence of an agent
	 * actually working — an `rpc_request`. In container mode a sandbox holds no
	 * Linear token, so every thought, action, and response the agent posts
	 * arrives here as an RPC; a working session stamps this every few seconds,
	 * and a session that has stopped working stamps it never again.
	 *
	 * That is the property the stranded-session detector needs and no existing
	 * column has:
	 *  - `last_seen_ms` is the heartbeat — it moves for a wedged worker.
	 *  - `last_routed_ms` is the router routing TO the device — frozen for the
	 *    whole of a long turn, which is why it cannot be thresholded on its own.
	 *  - `last_active_ms` is stamped by the sweep itself on every pinned tick, so
	 *    it moves identically for a busy sandbox and a stuck one.
	 *
	 * Deliberately NOT an input to the idle clock. Idle-stop errs toward keeping
	 * a container alive and already has `last_active_ms` for that; feeding a
	 * tighter signal into it would resurrect NOR-366's stop-a-busy-sandbox
	 * failure from the other direction.
	 *
	 * Harmless for physical devices — nothing reads it for them.
	 */
	markDeviceProgress(deviceId: number, nowMs: number): void {
		this.db
			.prepare("UPDATE devices SET last_progress_ms = ? WHERE device_id = ?")
			.run(nowMs, deviceId);
	}

	/**
	 * Stamp when the router last handed this device an event.
	 *
	 * Called from {@link enqueueEvent}, inside its transaction. Drives the
	 * container idle-stop policy and (with {@link markDeviceProgress}) the
	 * stranded-session detector's no-progress clock. Harmless for physical
	 * devices, which ignore `last_routed_ms`.
	 */
	markDeviceRouted(deviceId: number, nowMs: number): void {
		this.db
			.prepare("UPDATE devices SET last_routed_ms = ? WHERE device_id = ?")
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

	/**
	 * Records one input delivered into the current run, or starts a new run when
	 * the reusable Linear session's previous run is terminal.
	 */
	recordAgentRunRouted(input: {
		deviceId: number;
		issueKey: string;
		issueId?: string;
		sessionId: string;
		activityId?: string;
		commentId?: string;
		routedMs: number;
		/**
		 * The Linear context this input arrived under. Captured into the run's
		 * routing snapshot when the run is CREATED and never rewritten, so a later
		 * team or project move does not rewrite the history of runs that already
		 * happened. Owner and workspace are filled in from the device's own row
		 * inside the same transaction — see below.
		 */
		routing?: Pick<
			AgentRunRouting,
			| "workspaceId"
			| "workspaceName"
			| "linearTeamId"
			| "linearTeamName"
			| "linearProjectId"
			| "linearProjectName"
		>;
		/**
		 * Whether the router holds a live socket for the target device right now.
		 *
		 * Passed in rather than looked up because the socket registry lives in
		 * `DeviceGateway`, not here. Omitting it leaves the run's connectivity
		 * unobserved until the device next connects or drops — which, for a
		 * physical device that was ALREADY connected when the run was created, is
		 * potentially never.
		 */
		workerOnline?: boolean;
	}): string {
		const txn = this.db.transaction(() => {
			const device = this.db
				.prepare(
					`SELECT d.user_id, d.kind, d.provider, u.email AS owner_email, u.name AS owner_name
					 FROM devices d LEFT JOIN users u ON u.user_id = d.user_id
					 WHERE d.device_id = ?`,
				)
				.get(input.deviceId) as
				| (Pick<DeviceRow, "user_id" | "kind" | "provider"> & {
						owner_email: string | null;
						owner_name: string | null;
				  })
				| undefined;
			if (!device) throw new Error(`Unknown device: ${input.deviceId}`);

			const latest = this.db
				.prepare(
					`SELECT run_id, state, inputs_json FROM agent_runs
					 WHERE session_id = ? ORDER BY started_ms DESC, rowid DESC LIMIT 1`,
				)
				.get(input.sessionId) as
				| Pick<AgentRunRow, "run_id" | "state" | "inputs_json">
				| undefined;
			const runInput: AgentRunInput = {
				...(input.activityId ? { activityId: input.activityId } : {}),
				...(input.commentId ? { commentId: input.commentId } : {}),
				routedMs: input.routedMs,
			};

			if (
				latest &&
				(NON_TERMINAL_RUN_STATES as readonly string[]).includes(latest.state)
			) {
				const inputs = parseRunInputs(latest.inputs_json);
				inputs.push(runInput);
				// Deliberately does NOT touch the routing snapshot columns. They
				// belong to the instant this run began, and a run spans every input
				// delivered into it — so an issue moved between two inputs of the
				// SAME run keeps the team it was routed under. A fresh run (the
				// branch below, reached once the previous one is terminal) captures
				// the new context.
				this.updateAgentRun(
					latest.run_id,
					{
						user_id: device.user_id,
						device_id: input.deviceId,
						issue_key: input.issueKey,
						...(input.issueId !== undefined ? { issue_id: input.issueId } : {}),
						last_routed_ms: input.routedMs,
						inputs_json: JSON.stringify(inputs),
						executor_kind: device.kind,
						provider: device.provider,
						...(input.workerOnline !== undefined
							? { worker_online: input.workerOnline ? 1 : 0 }
							: {}),
					},
					input.routedMs,
				);
				return latest.run_id;
			}

			const runId = randomUUID();
			// Written in the same statement that creates the run, inside the same
			// transaction that read the device — so a run row can never exist
			// without the snapshot of what it was routed under.
			const routing = input.routing ?? {};
			this.db
				.prepare(
					`INSERT INTO agent_runs
					 (run_id, user_id, device_id, issue_key, issue_id, session_id, state,
					  started_ms, last_routed_ms, inputs_json, executor_kind, provider,
					  revision, routed_at_ms, workspace_id, workspace_name,
					  owner_user_id, owner_name, linear_team_id, linear_team_name,
					  linear_project_id, linear_project_name, worker_online)
					 VALUES (?, ?, ?, ?, ?, ?, 'routed', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.run(
					runId,
					device.user_id,
					input.deviceId,
					input.issueKey,
					input.issueId ?? null,
					input.sessionId,
					input.routedMs,
					input.routedMs,
					JSON.stringify([runInput]),
					device.kind,
					device.provider,
					input.routedMs,
					routing.workspaceId ?? null,
					routing.workspaceName ?? null,
					// The router's own user id, not Linear's: this is the Cyrus owner
					// whose device ran the work, which is the identity a fleet operator
					// filters and scopes by.
					String(device.user_id),
					device.owner_name ?? device.owner_email ?? null,
					routing.linearTeamId ?? null,
					routing.linearTeamName ?? null,
					routing.linearProjectId ?? null,
					routing.linearProjectName ?? null,
					input.workerOnline === undefined ? null : input.workerOnline ? 1 : 0,
				);
			// A run appearing is itself a material change, and the feed has to carry
			// it: a client watching only for transitions would otherwise never learn
			// the run exists, and would have to re-snapshot to find out.
			this.appendAgentRunChange(runId, "routing", input.routedMs);
			return runId;
		});
		return txn();
	}

	/**
	 * Whether this run's routing snapshot has yet had its one enriching Linear
	 * read.
	 *
	 * Asked BEFORE that read so it happens at most once per RUN rather than once
	 * per webhook: a run receives many inputs, and re-fetching an issue's project
	 * on every prompt would put a round-trip in the routing path for a value that,
	 * by definition, must never change once captured.
	 *
	 * Keyed on a dedicated "have we asked?" stamp rather than on any snapshot
	 * column, because neither column can answer it. The TEAM is on the webhook, so
	 * gating on it means the read essentially never fires — the exact defect this
	 * gate would otherwise reintroduce. The PROJECT is legitimately absent for an
	 * issue in no project, so gating on it re-fetches forever for the commonest
	 * case. Only "did we ask?" distinguishes not-yet-asked from asked-and-there-
	 * was-nothing.
	 */
	runRoutingNeedsEnrichment(runId: string): boolean {
		const row = this.db
			.prepare("SELECT routing_enriched_ms FROM agent_runs WHERE run_id = ?")
			.get(runId) as { routing_enriched_ms: number | null } | undefined;
		return row !== undefined && row.routing_enriched_ms === null;
	}

	/**
	 * Fills routing-snapshot dimensions that are still absent, and NEVER
	 * overwrites one already captured.
	 *
	 * The snapshot's whole value is that it does not move: a historical filter
	 * reads it precisely so an issue that later changes team or project does not
	 * rewrite the history of runs that already happened. So this is strictly
	 * additive — the first value captured for a dimension is the one that
	 * survives, and a late-arriving Linear read can only fill a blank. That is not
	 * a theoretical ordering: the read is fired off the delivery path, so an issue
	 * moved between the route and the read would otherwise rewrite its own history
	 * seconds after it was recorded.
	 *
	 * A name is written only alongside its canonical id, upholding the invariant
	 * `runRoutingSnapshotV1Schema` enforces on the other side.
	 *
	 * Stamps `routing_enriched_ms` unconditionally, INCLUDING when it fills
	 * nothing — an issue in no project is a complete answer, and without the stamp
	 * it would be re-asked on every subsequent input into the run.
	 */
	enrichRunRouting(
		runId: string,
		routing: Pick<
			AgentRunRouting,
			| "workspaceName"
			| "linearTeamId"
			| "linearTeamName"
			| "linearProjectId"
			| "linearProjectName"
		>,
		nowMs: number,
	): void {
		this.db.transaction(() => {
			const current = this.db
				.prepare(
					`SELECT workspace_name, linear_team_id, linear_team_name,
					        linear_project_id, linear_project_name
					 FROM agent_runs WHERE run_id = ?`,
				)
				.get(runId) as Record<string, string | null> | undefined;
			if (!current) return;

			const patch: Record<string, string | number> = {
				routing_enriched_ms: nowMs,
			};
			const fillIfBlank = (column: string, value: string | undefined) => {
				if (value !== undefined && current[column] === null) {
					patch[column] = value;
				}
			};
			fillIfBlank("workspace_name", routing.workspaceName);
			fillIfBlank("linear_team_id", routing.linearTeamId);
			fillIfBlank("linear_project_id", routing.linearProjectId);
			// Names only alongside a captured id — either one already on the row, or
			// one this same patch is about to write.
			if (patch.linear_team_id ?? current.linear_team_id) {
				fillIfBlank("linear_team_name", routing.linearTeamName);
			}
			if (patch.linear_project_id ?? current.linear_project_id) {
				fillIfBlank("linear_project_name", routing.linearProjectName);
			}
			this.updateAgentRun(runId, patch, nowMs);
		})();
	}

	/** The first successfully posted worker activity proves the routed run is active. */
	recordAgentRunActivity(sessionId: string, nowMs: number): void {
		const runId = this.latestNonTerminalRunId(sessionId);
		if (!runId) return;
		// Clears the wait as well as advancing the state. A run that just published
		// an activity is demonstrably progressing, so leaving the wait behind would
		// keep reporting evidence the run itself has disproved.
		this.updateAgentRun(
			runId,
			{
				state: "active",
				wait_reason: null,
				wait_since_ms: null,
				wait_condition: null,
				last_agent_activity_ms: nowMs,
			},
			nowMs,
		);
	}

	/**
	 * Applies a worker's explicitly reported run state.
	 *
	 * `waiting` requires the wait, for the same reason the frame does: the router
	 * never infers a wait, so the state and its evidence move together or not at
	 * all. Any other state clears the wait.
	 */
	setAgentRunState(
		sessionId: string,
		state: "active" | "waiting",
		facts?: {
			wait?: AgentRunWait;
			runner?: string;
			model?: string;
			pendingWorkCount?: number;
		},
		nowMs?: number,
	): void {
		const runId = this.latestNonTerminalRunId(sessionId);
		if (!runId) return;
		const wait = state === "waiting" ? facts?.wait : undefined;
		this.updateAgentRun(
			runId,
			{
				state,
				wait_reason: wait?.reason ?? null,
				wait_since_ms: wait?.sinceMs ?? null,
				wait_condition: truncateReportedCondition(wait?.reportedCondition),
				...(facts?.runner !== undefined ? { runner: facts.runner } : {}),
				...(facts?.model !== undefined ? { model: facts.model } : {}),
				...(facts?.pendingWorkCount !== undefined
					? { pending_work_count: facts.pendingWorkCount }
					: {}),
			},
			nowMs,
		);
	}

	/**
	 * Writes only the columns that actually changed, and increments `revision`
	 * only when one of the MATERIAL ones did.
	 *
	 * The revision is what a recovery request quotes to say which observation it
	 * acted on, and what a watch uses to tell a real change from a repeat. A
	 * worker re-reporting the same wait on every reconnect, or an idempotent
	 * frame replay, must therefore leave it alone — otherwise the feed becomes a
	 * stream of "still the same" and the number stops meaning anything.
	 *
	 * ── WHAT THIS REVISION DOES NOT COVER ──
	 * It moves for DURABLE run facts only, because those are the only ones stored
	 * on the row. Two of the change kinds `runChangeKindV1Schema` names —
	 * `worker_connectivity` and `executor_state` — are joined at QUERY time from
	 * `devices.last_seen_ms` and the sandbox gauge, and are deliberately not
	 * persisted here (the spec keeps them as evidence, not durable facts). So a
	 * worker going offline and coming back, or a container's gauge changing,
	 * leaves the revision where it was.
	 *
	 * That is a real limitation for whoever builds the change feed and the
	 * `stale_revision` guard on `POST /api/v1/recoveries`: quoting a revision
	 * proves the RUN's facts have not moved, and proves nothing about the worker's
	 * connectivity at the instant of the request. A recovery that cares must
	 * re-read connectivity itself rather than infer it from an unchanged number.
	 *
	 * Read-compare-write, so it runs in a transaction: the compare and the write
	 * must not be separated by another connection's update, and the store's file
	 * is documented as shared by two processes. `revision = revision + 1` is
	 * computed in SQL regardless, so no increment can be lost even if the
	 * comparison races.
	 *
	 * The feed entry is appended INSIDE that same transaction, which is the whole
	 * durability claim: a row can never move without the entry that reports it,
	 * and a reader replaying the feed can never see a revision that no entry
	 * explains.
	 */
	private updateAgentRun(
		runId: string,
		patch: Record<string, string | number | null>,
		changedMs?: number,
	): void {
		this.db.transaction(() => {
			const current = this.db
				.prepare("SELECT * FROM agent_runs WHERE run_id = ?")
				.get(runId) as (AgentRunRow & Record<string, unknown>) | undefined;
			if (!current) return;

			const changed = Object.entries(patch).filter(
				([column, value]) => (current[column] ?? null) !== value,
			);
			if (changed.length === 0) return;
			const materialColumns = changed
				.map(([column]) => column)
				.filter((column) => MATERIAL_RUN_COLUMNS.has(column));

			const assignments = changed.map(([column]) => `${column} = ?`);
			if (materialColumns.length > 0)
				assignments.push("revision = revision + 1");
			this.db
				.prepare(
					`UPDATE agent_runs SET ${assignments.join(", ")} WHERE run_id = ?`,
				)
				.run(...changed.map(([, value]) => value), runId);

			if (materialColumns.length > 0) {
				this.appendAgentRunChange(
					runId,
					changeKindFor(materialColumns),
					changedMs ?? Date.now(),
				);
			}
		})();
	}

	/**
	 * Appends one feed entry for a run that has just changed.
	 *
	 * PRIVATE, and called only from inside an already-open transaction. The
	 * observation is re-read here rather than reconstructed from the patch so it
	 * is the whole run as it now stands — including the columns this mutation did
	 * not touch, which is what lets a client watch the feed without also polling
	 * the snapshot route.
	 */
	private appendAgentRunChange(
		runId: string,
		kind: AgentRunChangeKind,
		changedMs: number,
	): void {
		const row = this.db
			.prepare(
				`SELECT ar.*, d.last_seen_ms FROM agent_runs ar
				 LEFT JOIN devices d ON d.device_id = ar.device_id
				 WHERE ar.run_id = ?`,
			)
			.get(runId) as AgentRunRow | undefined;
		if (!row) return;
		const observation = toAgentRunInfo(row);
		this.db
			.prepare(
				`INSERT INTO agent_run_changes
				 (run_id, revision, kind, changed_ms, observation_json, workspace_id, user_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				runId,
				observation.revision,
				kind,
				changedMs,
				JSON.stringify(observation),
				// Copied from the observation, not re-read from the run: these decide
				// who may READ this entry, and an entry describes an instant. A later
				// re-derivation from a row that has since moved workspace would change
				// the readership of history that was already written.
				observation.routing.workspaceId ?? null,
				observation.userId,
			);
		this.trimAgentRunChanges(runId);
	}

	/**
	 * Keeps one run's history bounded.
	 *
	 * Age-based retention alone does not bound this, because it only fires once a
	 * run is TERMINAL: a run that never ends keeps every entry it ever produced,
	 * and the runs that never end are exactly the ones that generate entries
	 * fastest. A worker stuck in a reconnect loop writes two connectivity entries
	 * per iteration, and a provider flapping writes one per sweep tick.
	 *
	 * The cap is deliberately far above any legitimate run's output — a busy
	 * eight-hour session produces a few hundred entries — so it never truncates
	 * history an operator would have read, and only ever bites the pathological
	 * case it exists for. A client lagging past it loses entries the same way it
	 * loses them to the 24-hour window; the snapshot route remains authoritative
	 * for current state.
	 */
	private trimAgentRunChanges(runId: string): void {
		this.db
			.prepare(
				`DELETE FROM agent_run_changes
				 WHERE run_id = ? AND change_id <= (
				   SELECT change_id FROM agent_run_changes WHERE run_id = ?
				   ORDER BY change_id DESC LIMIT 1 OFFSET ?
				 )`,
			)
			.run(runId, runId, MAX_CHANGES_PER_RUN);
	}

	/**
	 * Forgets every run's recorded worker connectivity, because THIS process
	 * holds no sockets yet.
	 *
	 * Called from `RouterServer.start()` and from nowhere else, and that
	 * restriction is the whole point rather than tidiness. Connectivity is a fact
	 * about a live socket in the SERVING process, but the router's SQLite file is
	 * documented as shared: `cyrus router containers list` — which the
	 * stranded-session runbook tells an operator to run mid-incident — opens the
	 * same database. Doing this in the constructor meant that command silently
	 * blanked the connectivity of every live run in the fleet, and since the
	 * serving router only writes the column on connect and disconnect, and those
	 * devices were already connected, it stayed blank until each one happened to
	 * reconnect. `/api/v1/runs` reported the whole fleet offline while `/runs`,
	 * reading the live socket registry, reported it online — two routes on one
	 * running router disagreeing about the same run.
	 *
	 * Appends no change entries: the stream epoch rotates on every construction,
	 * so every cursor a client holds is already `410 Gone` and it must re-snapshot
	 * regardless. Entries no client can reach are noise attributed to a revision
	 * nobody observed.
	 */
	/**
	 * A long-lived random secret, minted on first use and stable thereafter.
	 *
	 * Deliberately NOT per-process, which is what the cursor codec used before.
	 * A per-process key makes a forged cursor and a pre-restart cursor fail the
	 * SAME check, so the router cannot answer them differently — and it has to,
	 * because one means "fix your request" (`400`) and the other means "the
	 * stream is gone, re-list" (`410`). With a durable key the signature proves
	 * the router issued the cursor, and the epoch — which rotates every process —
	 * is then free to mean only what it says.
	 *
	 * Nothing here is a credential a client ever sees, so a restored backup
	 * carrying the same value is correct rather than a leak: it keeps cursors
	 * verifiable across the restore, and the epoch still rejects them.
	 */
	getOrCreateSecret(name: string, nowMs = Date.now()): Buffer {
		return this.db.transaction(() => {
			const row = this.db
				.prepare("SELECT value FROM router_secrets WHERE name = ?")
				.get(name) as { value: string } | undefined;
			if (row) return Buffer.from(row.value, "base64");
			const value = randomBytes(32);
			this.db
				.prepare(
					"INSERT INTO router_secrets (name, value, created_ms) VALUES (?, ?, ?)",
				)
				.run(name, value.toString("base64"), nowMs);
			return value;
		})();
	}

	resetRunWorkerConnectivity(): void {
		this.db.exec(
			"UPDATE agent_runs SET worker_online = NULL WHERE ended_ms IS NULL AND worker_online IS NOT NULL",
		);
	}

	/**
	 * Records the router's live view of a worker's connectivity onto every run
	 * that device is currently carrying.
	 *
	 * Scoped to NON-TERMINAL runs. A run that has ended is a record of what
	 * happened, and its worker's later reconnection says nothing about it — while
	 * writing to it would produce a feed entry for a run no operator is watching,
	 * for every device that ever reconnects.
	 *
	 * Idempotent by construction: `updateAgentRun` writes nothing when the value
	 * is unchanged, so a heartbeat from a device that was already online costs one
	 * comparison and appends nothing.
	 */
	setRunWorkerConnectivity(
		deviceId: number,
		online: boolean,
		nowMs: number,
	): void {
		this.patchLiveRunsOnDevice(
			deviceId,
			{ worker_online: online ? 1 : 0 },
			nowMs,
		);
	}

	/**
	 * Records the latest provider-sampled executor state onto every non-terminal
	 * run on a container device.
	 *
	 * The observation TIME is refreshed on every sample; the state is what decides
	 * whether the feed grows. So a container reported `running` on sixty
	 * consecutive sweep ticks produces one entry, not sixty, and still reports a
	 * sample a client can age.
	 */
	setRunExecutorState(
		deviceId: number,
		state: SandboxGaugeState,
		observedMs: number,
	): void {
		this.patchLiveRunsOnDevice(
			deviceId,
			{ executor_state: state, executor_state_observed_ms: observedMs },
			observedMs,
		);
	}

	/**
	 * Applies one patch to every NON-TERMINAL run on a device, atomically.
	 *
	 * The read and the writes share a transaction because they are separated by
	 * an arbitrary number of nested write transactions: without it, a run that
	 * goes terminal between the SELECT and its own UPDATE still receives the
	 * patch — and a change entry — after it has ended, which is exactly the
	 * "leaves terminal runs alone" invariant this is scoped to uphold.
	 *
	 * It also collapses a device's whole sample into one commit rather than one
	 * per run, which matters on the 60-second sweep: this database is on the same
	 * event loop as the WebSocket gateway and carries a 5s busy timeout.
	 */
	private patchLiveRunsOnDevice(
		deviceId: number,
		patch: Record<string, string | number | null>,
		nowMs: number,
	): void {
		this.db.transaction(() => {
			const rows = this.db
				.prepare(
					"SELECT run_id FROM agent_runs WHERE device_id = ? AND ended_ms IS NULL",
				)
				.all(deviceId) as Array<Pick<AgentRunRow, "run_id">>;
			for (const row of rows) {
				this.updateAgentRun(row.run_id, patch, nowMs);
			}
		})();
	}

	/**
	 * Moves a run to its terminal state, recording the execution identity the
	 * worker reported on the way out.
	 *
	 * `facts` is not decorative here, and omitting it was a real hole: the
	 * ORDINARY run — no elicitation, no deferred pending work — never passes
	 * through {@link setAgentRunState} at all, so its terminal frame is the ONLY
	 * point at which `runner` and `model` are ever offered. Dropping them there
	 * left every such run with `runner = NULL` permanently, which is not a
	 * gap a later backfill can close and would have made `runObservationV1Schema`
	 * (where `runner` is required) unemittable for exactly the common case.
	 */
	finishAgentRun(
		sessionId: string,
		state: "complete" | "error" | "stopped",
		nowMs: number,
		facts?: { runner?: string; model?: string },
	): void {
		const latest = this.db
			.prepare(
				"SELECT run_id, state FROM agent_runs WHERE session_id = ? ORDER BY started_ms DESC, rowid DESC LIMIT 1",
			)
			.get(sessionId) as Pick<AgentRunRow, "run_id" | "state"> | undefined;
		if (
			!latest ||
			(!NON_TERMINAL_RUN_STATES.includes(
				latest.state as (typeof NON_TERMINAL_RUN_STATES)[number],
			) &&
				latest.state !== "unknown")
		) {
			return;
		}
		// Clears the wait and the pending-work count along with going terminal. A
		// run that has ENDED cannot be carrying live background work, and asserting
		// otherwise is the one contradiction the v1 observation refuses outright.
		this.updateAgentRun(
			latest.run_id,
			{
				state,
				ended_ms: nowMs,
				wait_reason: null,
				wait_since_ms: null,
				wait_condition: null,
				pending_work_count: null,
				...(facts?.runner !== undefined ? { runner: facts.runner } : {}),
				...(facts?.model !== undefined ? { model: facts.model } : {}),
			},
			nowMs,
		);
	}

	/**
	 * The device and state of the most recent run recorded for a session.
	 *
	 * Exists to tell a REPLAY apart from an intrusion on the terminal frame.
	 * `RouterServer` applies a `session_state` frame before acking it, so a
	 * device that dies in between replays a frame the router already applied —
	 * and once the posting grace has lapsed that replay arrives owning nothing,
	 * looking exactly like a device reporting a terminal state for someone
	 * else's session. The run row remembers which device the session actually
	 * belonged to for as long as the row survives retention, which is far longer
	 * than any grace, so it can answer the question the ownership routes no
	 * longer can.
	 *
	 * Ordered the same way {@link finishAgentRun} orders it, so both see the same
	 * row for a session that has been routed more than once.
	 */
	getLatestAgentRunForSession(
		sessionId: string,
	): { deviceId: number; state: string } | undefined {
		const row = this.db
			.prepare(
				"SELECT device_id, state FROM agent_runs WHERE session_id = ? ORDER BY started_ms DESC, rowid DESC LIMIT 1",
			)
			.get(sessionId) as Pick<AgentRunRow, "device_id" | "state"> | undefined;
		return row === undefined
			? undefined
			: { deviceId: row.device_id, state: row.state };
	}

	/**
	 * The most recent moment the router observed anything about an agent run on
	 * this device — a worker activity, or a run ending.
	 *
	 * Read by {@link ContainerLifecycle} as a stop veto, not as an idle clock.
	 * A run that ended seconds ago is the single most dangerous moment to stop a
	 * container: the worker is still flushing (its `session_state` frame is
	 * durably buffered and replayed until acked, and its artifact bundle is still
	 * uploading), and killing it there converts a harmless park into a stranded
	 * sandbox whose issue lock nothing will ever release — NOR-406.
	 *
	 * `ended_ms` covers both ways a run finishes as far as the router is
	 * concerned: `finishAgentRun` on the terminal frame, and `markAgentRunUnknown`
	 * when the affinity reconciler reclaims a row for a session the device no
	 * longer reports. The second is precisely the "the device is done but the
	 * router never got the frame" case, so it earns the same settle window.
	 *
	 * Deliberately ignores `started_ms`/`last_routed_ms`: those are router-side
	 * stamps already mirrored on the device row's `last_routed_ms`, and folding
	 * them in here would only duplicate the idle clock.
	 *
	 * Served by `idx_agent_runs_device`. Without it this is a full scan of every
	 * run in the fleet's 24h retention window, run synchronously on the router's
	 * event loop up to twice per idle candidate per tick — a cost that scales
	 * with total run volume rather than with the number of candidates.
	 */
	getLastAgentRunActivityMs(deviceId: number): number | undefined {
		const row = this.db
			.prepare(
				`SELECT MAX(MAX(COALESCE(last_agent_activity_ms, 0), COALESCE(ended_ms, 0))) AS latest
				 FROM agent_runs WHERE device_id = ?`,
			)
			.get(deviceId) as { latest: number | null } | undefined;
		const latest = row?.latest ?? 0;
		return latest > 0 ? latest : undefined;
	}

	markAgentRunUnknown(sessionId: string, nowMs: number): void {
		const runId = this.latestNonTerminalRunId(sessionId);
		if (!runId) return;
		this.updateAgentRun(
			runId,
			{
				state: "unknown",
				ended_ms: nowMs,
				wait_reason: null,
				wait_since_ms: null,
				wait_condition: null,
				pending_work_count: null,
			},
			nowMs,
		);
	}

	listAgentRuns(input: {
		userId: number;
		issueKey?: string;
		commentId?: string;
		sinceMs?: number;
	}): AgentRunInfo[] {
		const clauses = ["ar.user_id = ?"];
		const params: Array<string | number> = [input.userId];
		if (input.issueKey) {
			clauses.push("ar.issue_key = ? COLLATE NOCASE");
			params.push(input.issueKey);
		}
		if (input.sinceMs !== undefined) {
			clauses.push("ar.last_routed_ms >= ?");
			params.push(input.sinceMs);
		}
		const rows = this.db
			.prepare(
				`SELECT ar.*, d.last_seen_ms FROM agent_runs ar
				 LEFT JOIN devices d ON d.device_id = ar.device_id
				 WHERE ${clauses.join(" AND ")}
				 ORDER BY ar.started_ms DESC, ar.rowid DESC`,
			)
			.all(...params) as AgentRunRow[];
		const runs = rows.map(toAgentRunInfo);
		return input.commentId
			? runs.filter((run) =>
					run.inputs.some((item) => item.commentId === input.commentId),
				)
			: runs;
	}

	/**
	 * The authorized, filtered, keyset-paginated run listing behind
	 * `GET /api/v1/runs`.
	 *
	 * `workspaceIds` is an AUTHORIZATION input, not a filter, and it is applied in
	 * the same WHERE clause as everything else on purpose: every other read here —
	 * including the candidate lists a `400` reports for an ambiguous name — is
	 * built from this same base, so there is no query shape in which one
	 * operator's counts or names can be computed over another's workspaces. An
	 * empty array authorizes nothing and returns nothing, which is the correct
	 * reading of a principal with no workspaces.
	 *
	 * Runs missing the identity the v1 observation REQUIRES are excluded here
	 * rather than dropped after the fact, so a page is exactly as long as it
	 * claims and `nextCursor` cannot skip past runs that were silently discarded.
	 * That is the scoping `runObservationV1Schema`'s own doc comment hands to this
	 * route: a run routed before the CYR-68 migration captured no workspace, no
	 * issue id, and no routing instant, and cannot be rendered. `runner` is NOT in
	 * that set — it arrives from the worker, so a freshly routed run legitimately
	 * has none yet, and excluding those would hide every run during the window an
	 * operator is most likely to be watching.
	 */
	listFleetAgentRuns(input: FleetRunQuery & { limit: number }): AgentRunInfo[] {
		const { clauses, params } = buildFleetRunFilter(input);
		if (input.after) {
			// Keyset, not OFFSET: the feed is live, and an OFFSET page shifts under
			// a client whenever a run is inserted or aged out between two requests —
			// which shows up as duplicated and skipped runs rather than as an error.
			// `started_ms` never changes once written, so the pair is stable.
			clauses.push(
				"(ar.started_ms < ? OR (ar.started_ms = ? AND ar.run_id > ?))",
			);
			params.push(
				input.after.startedMs,
				input.after.startedMs,
				input.after.runId,
			);
		}
		const rows = this.db
			.prepare(
				`SELECT ar.*, d.last_seen_ms FROM agent_runs ar
				 LEFT JOIN devices d ON d.device_id = ar.device_id
				 WHERE ${clauses.join(" AND ")}
				 ORDER BY ar.started_ms DESC, ar.run_id ASC
				 LIMIT ?`,
			)
			.all(...params, input.limit) as AgentRunRow[];
		return rows.map(toAgentRunInfo);
	}

	/**
	 * The distinct `(id, name)` pairs captured for one routing dimension within
	 * the authorized, already-filtered historical set.
	 *
	 * This is what turns an exact captured name into a canonical id, and what a
	 * `400` reports when the name resolves to more than one. Both facts are read
	 * from the SAME base filter the listing uses, so the candidate list can never
	 * name a workspace, team, or project the caller is not authorized to see —
	 * which is the whole reason authorization is applied before filtering rather
	 * than after.
	 */
	listFleetRunDimensionValues(
		input: FleetRunQuery & { dimension: FleetRunDimension },
	): Array<{ id: string; name?: string }> {
		const { idColumn, nameColumn } =
			FLEET_RUN_DIMENSION_COLUMNS[input.dimension];
		const { clauses, params } = buildFleetRunFilter(input);
		clauses.push(`ar.${idColumn} IS NOT NULL`);
		const rows = this.db
			.prepare(
				`SELECT DISTINCT ar.${idColumn} AS id, ar.${nameColumn} AS name
				 FROM agent_runs ar
				 WHERE ${clauses.join(" AND ")}
				 ORDER BY ar.${idColumn} ASC`,
			)
			.all(...params) as Array<{ id: string; name: string | null }>;
		return rows.map((row) => ({
			id: row.id,
			...(row.name ? { name: row.name } : {}),
		}));
	}

	/**
	 * Ages out terminal runs AND the feed entries that describe them, under one
	 * cutoff.
	 *
	 * Deliberately one method rather than two sweeps: a change retained past its
	 * run reports an observation of something no snapshot can corroborate, and a
	 * run retained past its changes silently loses its own history. Giving the
	 * feed its own retention pass would make that divergence a matter of two
	 * schedules agreeing, which is the second independent policy clock this was
	 * built to avoid.
	 *
	 * Non-terminal runs are untouched at any age, so a long-stuck run keeps both
	 * its row and its history for as long as it is stuck — that run is precisely
	 * the one an operator most needs to see.
	 *
	 * The entries are deleted FIRST, by `run_id`, so the delete is served by
	 * `idx_agent_run_changes_run` and touches only the runs actually expiring.
	 * The obvious spelling — deleting the runs and then sweeping entries whose
	 * `run_id` no longer exists — is an unindexable full scan of the whole feed
	 * inside a write transaction, on a 60-second timer, in the process that also
	 * serves the WebSocket gateway.
	 */
	sweepTerminalAgentRuns(cutoffMs: number): number {
		return this.db.transaction(() => {
			const expiring =
				"SELECT run_id FROM agent_runs WHERE ended_ms IS NOT NULL AND ended_ms < ?";
			this.db
				.prepare(`DELETE FROM agent_run_changes WHERE run_id IN (${expiring})`)
				.run(cutoffMs);
			return this.db
				.prepare(
					`DELETE FROM agent_runs WHERE ended_ms IS NOT NULL AND ended_ms < ?`,
				)
				.run(cutoffMs).changes;
		})();
	}

	/**
	 * The material changes a principal may read, recorded after `afterChangeId`,
	 * oldest first.
	 *
	 * Ordered by `change_id` — the AUTOINCREMENT sequence, not a timestamp.
	 * Wall-clock stamps come from several call sites with several clocks and can
	 * tie or move backwards; the sequence is the only total order the feed has,
	 * and it is what the cursor names.
	 *
	 * Authorization is a WHERE clause, not a filter applied to the result. That
	 * distinction is the whole difference between a bounded page and a starving
	 * one: with `LIMIT` applied before scoping, a principal whose runs are 1% of a
	 * busy feed advanced its cursor by `limit` entries per request and received
	 * almost none of its own — and, since entries age out at 24 hours, could fall
	 * behind and lose changes with no `410` to tell it so. Applied here, `limit`
	 * counts rows the caller may actually read.
	 *
	 * `lastChangeId` is the furthest the scan reached, INCLUDING rows that were
	 * filtered out or failed to parse, and is what the caller must build its next
	 * cursor from. Deriving that from the returned entries instead would let a
	 * window of unreadable rows pin a client on a position it can never get past.
	 */
	listAgentRunChanges(input: {
		afterChangeId?: number;
		limit: number;
		/** Workspaces this principal may read. Empty authorizes nothing. */
		workspaceIds: string[];
		/** Set for an owner-scoped principal; compared against the run's user. */
		ownerScopeUserId?: number;
	}): { changes: AgentRunChange[]; lastChangeId: number } {
		const afterChangeId = input.afterChangeId ?? 0;
		// Read BEFORE the scan, so it can be used as the resume point on a short
		// page. Read after, it would include a row inserted mid-query, and
		// resuming past that row would skip it silently — the one thing a change
		// feed may never do.
		const maxBeforeScan = this.latestAgentRunChangeId();
		const clauses = ["change_id > ?"];
		const params: Array<string | number> = [afterChangeId];
		if (input.workspaceIds.length === 0) {
			clauses.push("1 = 0");
		} else {
			clauses.push(
				`workspace_id IN (${input.workspaceIds.map(() => "?").join(", ")})`,
			);
			params.push(...input.workspaceIds);
		}
		if (input.ownerScopeUserId !== undefined) {
			clauses.push("user_id = ?");
			params.push(input.ownerScopeUserId);
		}
		const rows = this.db
			.prepare(
				`SELECT change_id, run_id, revision, kind, changed_ms, observation_json
				 FROM agent_run_changes
				 WHERE ${clauses.join(" AND ")}
				 ORDER BY change_id ASC
				 LIMIT ?`,
			)
			.all(...params, input.limit) as Array<{
			change_id: number;
			run_id: string;
			revision: number;
			kind: string;
			changed_ms: number;
			observation_json: string;
		}>;
		const changes = rows.flatMap((row) => {
			const observation = parseStoredObservation(row.observation_json);
			// A row whose snapshot will not parse is skipped rather than thrown on.
			// The feed is a monitoring surface: one unreadable entry must not make
			// the whole page a 500, which would strand every watching client. The
			// cursor still advances past it — see `lastChangeId`.
			if (!observation) return [];
			return [
				{
					changeId: row.change_id,
					runId: row.run_id,
					revision: row.revision,
					kind: row.kind as AgentRunChangeKind,
					changedMs: row.changed_ms,
					observation,
				},
			];
		});
		// A short page means the scan reached the end of the feed, so the resume
		// point is the whole sequence rather than the last row that matched.
		// Without this, a principal with little traffic on a busy router re-scans
		// every other principal's entries on every poll, forever.
		const lastChangeId =
			rows.length < input.limit
				? Math.max(maxBeforeScan, afterChangeId)
				: (rows.at(-1)?.change_id ?? afterChangeId);
		return { changes, lastChangeId };
	}

	/**
	 * The newest change id, or 0 when the feed is empty.
	 *
	 * A client that asks for changes and is handed a cursor built from this can
	 * start watching from "now" without replaying the whole retained history.
	 */
	latestAgentRunChangeId(): number {
		const row = this.db
			.prepare("SELECT MAX(change_id) AS latest FROM agent_run_changes")
			.get() as { latest: number | null };
		return row.latest ?? 0;
	}

	private latestNonTerminalRunId(sessionId: string): string | undefined {
		const row = this.db
			.prepare(
				`SELECT run_id FROM agent_runs WHERE session_id = ?
				 AND state IN (${NON_TERMINAL_RUN_STATES.map(() => "?").join(", ")})
				 ORDER BY started_ms DESC, rowid DESC LIMIT 1`,
			)
			.get(sessionId, ...NON_TERMINAL_RUN_STATES) as
			| Pick<AgentRunRow, "run_id">
			| undefined;
		return row?.run_id;
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
			this.markDeviceRouted(deviceId, nowMs);
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
	 * The device holding the issue lock taken out on behalf of `sessionId`, if
	 * any. Distinct from {@link getSessionAffinity}: the lock models "this device
	 * owns this issue's work" and deliberately SURVIVES a park, whereas affinity
	 * is released the moment the worker parks. Session-scoped RPC authorization
	 * reads this so a parked session's activities are not rejected (NOR-405).
	 */
	getIssueLockDeviceForSession(sessionId: string): number | undefined {
		const row = this.db
			.prepare("SELECT device_id FROM issue_locks WHERE session_id = ?")
			.get(sessionId) as Pick<IssueLockRow, "device_id"> | undefined;
		return row?.device_id;
	}

	/**
	 * Records that `deviceId` may keep making session-scoped calls for
	 * `sessionId` until `expiresMs`, even though it holds neither affinity nor
	 * the issue lock any more.
	 *
	 * This exists for exactly one window: the terminal frame releases the lock
	 * AND affinity in the same call, but a worker's last activities — typically
	 * the completion summary the user most wants to see — are still in flight
	 * when it lands. Bounded rather than permanent: a session that keeps
	 * emitting long after it completed is the bug in NOR-405's title, not
	 * something to authorize forever.
	 */
	grantSessionOwnershipGrace(
		sessionId: string,
		deviceId: number,
		expiresMs: number,
	): void {
		this.db
			.prepare(
				`INSERT INTO session_ownership_grace (session_id, device_id, expires_ms)
				 VALUES (?, ?, ?)
				 ON CONFLICT(session_id) DO UPDATE SET
					device_id = excluded.device_id,
					expires_ms = excluded.expires_ms`,
			)
			.run(sessionId, deviceId, expiresMs);
	}

	/**
	 * The device still inside its post-terminal grace for `sessionId`, or
	 * `undefined` if there is none or it has lapsed. Expired rows are deleted on
	 * read: the read is the only thing that cares about them, so there is no
	 * separate sweep to fall behind.
	 */
	getSessionOwnershipGrace(
		sessionId: string,
		nowMs: number = Date.now(),
	): number | undefined {
		const row = this.db
			.prepare(
				"SELECT device_id, expires_ms FROM session_ownership_grace WHERE session_id = ?",
			)
			.get(sessionId) as
			| Pick<SessionOwnershipGraceRow, "device_id" | "expires_ms">
			| undefined;
		if (!row) return undefined;
		if (row.expires_ms <= nowMs) {
			this.db
				.prepare("DELETE FROM session_ownership_grace WHERE session_id = ?")
				.run(sessionId);
			return undefined;
		}
		return row.device_id;
	}

	clearSessionOwnershipGrace(sessionId: string): void {
		this.db
			.prepare("DELETE FROM session_ownership_grace WHERE session_id = ?")
			.run(sessionId);
	}

	/**
	 * Bounded retention for lapsed grace rows.
	 *
	 * {@link getSessionOwnershipGrace} already deletes a row it finds expired, so
	 * this is not needed for authorization to be correct — but that read only
	 * happens when the session id comes up again, and the overwhelmingly common
	 * case is a session that completes and is never asked about. Without a sweep
	 * every terminal session leaves a permanent row, and `StateBackup` pays for
	 * all of them on every upload. Same reasoning as `sweepWebhookClaims`.
	 */
	sweepSessionOwnershipGrace(cutoffMs: number): number {
		return this.db
			.prepare("DELETE FROM session_ownership_grace WHERE expires_ms <= ?")
			.run(cutoffMs).changes;
	}

	/**
	 * The device entitled to act on `sessionId`, or `undefined` if no device is.
	 *
	 * THE single definition of session ownership, deliberately in one place: it
	 * is read both by {@link LinearExecutor} to authorize a session-scoped RPC
	 * and by {@link EventRouter} to decide whether a device may be granted a
	 * post-terminal grace. Those two must never disagree — a device that can be
	 * granted ownership it does not have is an escalation, not a lenient check.
	 *
	 * The same rule binds every branch of `handleSessionState`, not only the
	 * grants: `parked` records an in-memory authorization for the later `active`
	 * frame, and `active` writes affinity — the strongest route here — so both
	 * are gated too. Ungating either one re-opens the escalation in two frames
	 * rather than one.
	 *
	 * The three routes, and why one is not enough:
	 *  - **affinity**: the session is actively routed here. Cleared on park.
	 *  - **the issue lock**: survives a park, which is the whole reason the park
	 *    path retains it. Absent entirely when `config.issueLock` is off.
	 *  - **a bounded grace**: covers the windows the other two cannot — a park on
	 *    a deployment without issue locking, and the terminal frame, which drops
	 *    both of the above while the worker's closing summary is in flight.
	 */
	getSessionOwner(
		sessionId: string,
		nowMs: number = Date.now(),
	): number | undefined {
		return (
			this.getSessionAffinity(sessionId) ??
			this.getIssueLockDeviceForSession(sessionId) ??
			this.getSessionOwnershipGrace(sessionId, nowMs)
		);
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
		nowMs = Date.now(),
	): Array<{ issueId: string; sessionId: string }> {
		const txn = this.db.transaction(() => {
			const rows = this.db
				.prepare(
					"SELECT issue_id, session_id FROM issue_locks WHERE device_id = ?",
				)
				.all(deviceId) as Array<Pick<IssueLockRow, "issue_id" | "session_id">>;
			this.purgeDeviceScopedRows(deviceId, nowMs);
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
