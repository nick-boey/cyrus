/**
 * Canonical wire fixtures for the v1 operator contracts.
 *
 * Each fixture is a COMPLETE document — every optional field populated — so a
 * round-trip test proves the schema accepts the richest shape the router may
 * emit, not just the minimum. Tests derive their negative cases by deleting or
 * corrupting one field of a fixture, which keeps the failure attributable to
 * that field alone.
 */

const EPOCH = "01JBQK7ZC4RTR4V4Q0N1M2P3Q4";

/** `v1.changes.<b64url(epoch)>.<b64url(sequence)>` — see `encodeRunChangeCursor`. */
export const CHANGE_CURSOR =
	"v1.changes.MDFKQlFLN1pDNFJUUjRWNFEwTjFNMlAzUTQ.NDI";
/** `v1.runs.<b64url(position)>` — see `encodeRunPageCursor`. */
export const RUN_PAGE_CURSOR = "v1.runs.cnVuLTAwMg";

export const STREAM_EPOCH = EPOCH;

export const publicRouterMetadata = {
	schemaVersion: 1,
	routerId: "router-cyrus-dev",
	routerName: "Cyrus dev router",
	operatorApiVersions: ["v1"],
	authentication: {
		methods: ["entra", "device-token"],
		entra: {
			tenantId: "8f4c1b2e-2c1a-4a3b-9d5e-6f7a8b9c0d1e",
			audience: "api://cyrus-router-dev",
		},
	},
} as const;

export const azureLogSourceDescriptor = {
	schemaVersion: 1,
	kind: "azure-log-analytics",
	displayName: "rg-cyrus-dev workspace",
	azure: {
		workspaceId: "3c9f2a10-5b6c-4d7e-8f90-a1b2c3d4e5f6",
		table: "ContainerAppConsoleLogs_CL",
		cloud: "AzurePublicCloud",
		resourceId:
			"/subscriptions/11111111-2222-3333-4444-555555555555/resourceGroups/rg-cyrus-dev/providers/Microsoft.OperationalInsights/workspaces/log-cyrus-dev",
	},
	budgets: {
		defaultLookbackSeconds: 900,
		maxRangeSeconds: 86_400,
		maxRecords: 5_000,
		minFollowIntervalSeconds: 15,
	},
} as const;

/**
 * A fleet operator authorized across more than one workspace — the case that
 * makes `--workspace` mandatory in the CLI, so the contract must be able to
 * express it.
 */
export const multiWorkspaceOperatorContext = {
	schemaVersion: 1,
	principalId: "7d2e5f81-9a0b-4c3d-8e5f-6a7b8c9d0e1f",
	authMethod: "entra",
	displayName: "Fleet operations",
	roles: ["fleet.read", "fleet.recover"],
	capabilities: [
		"runs.list",
		"runs.changes",
		"logs.query",
		"recoveries.request",
	],
	authorizedWorkspaces: [
		{ workspaceId: "ws-northrop-digital", name: "Northrop Digital" },
		{ workspaceId: "ws-ceedar", name: "Ceedar" },
	],
	logSource: azureLogSourceDescriptor,
	skill: {
		name: "cyrus-fleet-operator",
		version: "0.2.66",
		releaseUrl:
			"https://github.com/ceedaragents/cyrus/releases/download/v0.2.66/cyrus-fleet-operator-0.2.66.tar.gz",
		checksum:
			"sha256:9f2c4a6b8d0e1f3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7d9f1a",
		minCliVersion: "0.2.66",
	},
	observedAt: "2026-09-03T10:00:00.000Z",
} as const;

const routing = {
	workspaceId: "ws-northrop-digital",
	workspaceName: "Northrop Digital",
	ownerUserId: "user-42",
	ownerName: "Nick Boey",
	linearTeamId: "team-cyr",
	linearTeamName: "Cyrus",
	linearProjectId: "project-observability",
	linearProjectName: "Observability commands",
	routedAt: "2026-09-03T09:58:00.000Z",
} as const;

const worker = {
	online: true,
	lastHeartbeatAt: "2026-09-03T09:59:55.000Z",
} as const;

/**
 * An active container run carrying background work. `pendingWorkCount` is an
 * active-run fact, NOT a wait reason — ADR-0012 — so this run is `active`,
 * never `waiting`.
 */
export const activeRunWithPendingWork = {
	schemaVersion: 1,
	runId: "run-01JBQK7ZC4RTR4V4Q0N1M2P3Q4",
	agentSessionId: "session-9c8b7a6d",
	issueId: "9dfbba28-b837-404d-94c9-46de780703db",
	issueKey: "CYR-64",
	routing,
	runner: "claude",
	model: "claude-opus-5",
	executorKind: "container",
	provider: "aca",
	lifecycle: "active",
	pendingWorkCount: 2,
	inputs: [
		{ commentId: "comment-1", routedAt: "2026-09-03T09:58:00.000Z" },
		{ activityId: "activity-7", routedAt: "2026-09-03T09:59:00.000Z" },
	],
	lastPublishedActivityAt: "2026-09-03T09:59:30.000Z",
	worker,
	executorState: "running",
	executorStateObservedAt: "2026-09-03T09:59:50.000Z",
	startedAt: "2026-09-03T09:58:00.000Z",
	observedAt: "2026-09-03T10:00:00.000Z",
	revision: 7,
} as const;

/** A run the worker reports as waiting on a user decision. */
export const elicitationWaitRun = {
	...activeRunWithPendingWork,
	runId: "run-01JBQK8AAAAAAAAAAAAAAAAAAA",
	lifecycle: "waiting",
	pendingWorkCount: undefined,
	wait: {
		reason: "elicitation",
		since: "2026-09-03T09:59:40.000Z",
		reportedCondition: "Awaiting repository selection",
	},
	revision: 8,
} as const;

/**
 * Blocked on a user answer WITH a background build still running — the exact
 * state the worker's "safe to park?" gate exists for. Waiting and pending work
 * are not mutually exclusive; pending work simply is not a wait reason.
 */
export const elicitationWaitWithPendingWork = {
	...elicitationWaitRun,
	runId: "run-01JBQK8DDDDDDDDDDDDDDDDDDD",
	pendingWorkCount: 1,
	revision: 11,
} as const;

/**
 * A worker-reported wait the schema does not model yet. `other` is only
 * meaningful with the condition the worker actually reported, so the contract
 * requires it.
 */
export const otherWaitRun = {
	...activeRunWithPendingWork,
	runId: "run-01JBQK8BBBBBBBBBBBBBBBBBBB",
	lifecycle: "waiting",
	pendingWorkCount: undefined,
	wait: {
		reason: "other",
		since: "2026-09-03T09:59:45.000Z",
		reportedCondition: "worker reported: awaiting upstream CI",
	},
	revision: 9,
} as const;

/** A device run that ended without a terminal outcome reaching the router. */
export const unknownDeviceRun = {
	schemaVersion: 1,
	runId: "run-01JBQK8CCCCCCCCCCCCCCCCCCC",
	agentSessionId: "session-1a2b3c4d",
	issueId: "1c2d3e4f-5a6b-7c8d-9e0f-1a2b3c4d5e6f",
	issueKey: "CYR-63",
	routing,
	runner: "codex",
	executorKind: "device",
	lifecycle: "unknown",
	inputs: [{ commentId: "comment-9", routedAt: "2026-09-03T08:00:00.000Z" }],
	worker: { online: false },
	startedAt: "2026-09-03T08:00:00.000Z",
	endedAt: "2026-09-03T08:45:00.000Z",
	observedAt: "2026-09-03T10:00:00.000Z",
	revision: 3,
} as const;

export const runObservationPage = {
	schemaVersion: 1,
	observedAt: "2026-09-03T10:00:00.000Z",
	runs: [activeRunWithPendingWork, unknownDeviceRun],
	nextCursor: RUN_PAGE_CURSOR,
} as const;

export const runObservationChange = {
	schemaVersion: 1,
	changeId: "change-000042",
	cursor: CHANGE_CURSOR,
	runId: activeRunWithPendingWork.runId,
	kind: "lifecycle",
	observedAt: "2026-09-03T10:00:00.000Z",
	observation: activeRunWithPendingWork,
} as const;

export const runChangePage = {
	schemaVersion: 1,
	observedAt: "2026-09-03T10:00:00.000Z",
	streamEpoch: STREAM_EPOCH,
	changes: [runObservationChange],
	nextCursor: CHANGE_CURSOR,
} as const;

export const recoveryRequest = {
	schemaVersion: 1,
	runId: activeRunWithPendingWork.runId,
	expectedRevision: 7,
	idempotencyKey: "fleet-skill-01JBQK7ZC4RTR4V4Q0N1M2P3Q4",
	reason: "Worker offline for 20 minutes with the issue lock still held",
} as const;

const evidenceBefore = {
	observedAt: "2026-09-03T10:00:00.000Z",
	revision: 7,
	lifecycle: "active",
	workerOnline: false,
	executorState: "stopped",
	sessionAffinityHeld: true,
	issueLocked: true,
} as const;

const evidenceAfter = {
	observedAt: "2026-09-03T10:02:30.000Z",
	revision: 9,
	lifecycle: "unknown",
	workerOnline: false,
	executorState: "running",
	sessionAffinityHeld: false,
	issueLocked: false,
} as const;

/** A recovery that ran the full coordinator sequence and released stale ownership. */
export const recoveredOperation = {
	schemaVersion: 1,
	operationId: "recovery-01JBQK9ZZZZZZZZZZZZZZZZZZZ",
	runId: activeRunWithPendingWork.runId,
	idempotencyKey: recoveryRequest.idempotencyKey,
	actor: {
		principalId: multiWorkspaceOperatorContext.principalId,
		authMethod: "entra",
		roles: ["fleet.recover"],
	},
	expectedRevision: 7,
	phase: "recovered",
	phases: [
		{ phase: "accepted", enteredAt: "2026-09-03T10:00:01.000Z" },
		{ phase: "starting_executor", enteredAt: "2026-09-03T10:00:05.000Z" },
		{ phase: "reconciling", enteredAt: "2026-09-03T10:01:10.000Z" },
		{ phase: "replaying", enteredAt: "2026-09-03T10:01:40.000Z" },
		{
			phase: "releasing_stale_ownership",
			enteredAt: "2026-09-03T10:02:10.000Z",
			detail: "Reconnected worker did not claim the run",
		},
		{ phase: "recovered", enteredAt: "2026-09-03T10:02:30.000Z" },
	],
	requestedAt: "2026-09-03T10:00:01.000Z",
	updatedAt: "2026-09-03T10:02:30.000Z",
	completedAt: "2026-09-03T10:02:30.000Z",
	evidenceBefore,
	evidenceAfter,
} as const;

/** Recovery cannot manufacture an elicitation answer — ADR-0013. */
export const needsInputOperation = {
	...recoveredOperation,
	operationId: "recovery-01JBQK9AAAAAAAAAAAAAAAAAAA",
	phase: "needs_input",
	phases: [
		{ phase: "accepted", enteredAt: "2026-09-03T10:00:01.000Z" },
		{ phase: "reconciling", enteredAt: "2026-09-03T10:00:20.000Z" },
		{
			phase: "needs_input",
			enteredAt: "2026-09-03T10:00:40.000Z",
			detail: "Run is waiting on an elicitation",
		},
	],
	updatedAt: "2026-09-03T10:00:40.000Z",
	completedAt: "2026-09-03T10:00:40.000Z",
	evidenceAfter: { ...evidenceAfter, lifecycle: "waiting" },
} as const;

/** The router refuses while a connected worker still owns active work. */
export const refusedOperation = {
	...recoveredOperation,
	operationId: "recovery-01JBQK9BBBBBBBBBBBBBBBBBBB",
	phase: "refused",
	phases: [
		{ phase: "accepted", enteredAt: "2026-09-03T10:00:01.000Z" },
		{ phase: "refused", enteredAt: "2026-09-03T10:00:03.000Z" },
	],
	updatedAt: "2026-09-03T10:00:03.000Z",
	completedAt: "2026-09-03T10:00:03.000Z",
	refusalReason: "worker_owns_active_work",
	evidenceBefore: { ...evidenceBefore, workerOnline: true },
	evidenceAfter: undefined,
} as const;

export const failedOperation = {
	...recoveredOperation,
	operationId: "recovery-01JBQK9CCCCCCCCCCCCCCCCCCC",
	phase: "failed",
	phases: [
		{ phase: "accepted", enteredAt: "2026-09-03T10:00:01.000Z" },
		{ phase: "starting_executor", enteredAt: "2026-09-03T10:00:05.000Z" },
		{ phase: "failed", enteredAt: "2026-09-03T10:03:05.000Z" },
	],
	updatedAt: "2026-09-03T10:03:05.000Z",
	completedAt: "2026-09-03T10:03:05.000Z",
	failure: { message: "Executor start timed out after 180s" },
	evidenceAfter: undefined,
} as const;

export const logQuery = {
	schemaVersion: 1,
	range: {
		from: "2026-09-03T09:45:00.000Z",
		to: "2026-09-03T10:00:00.000Z",
	},
	workspaceId: "ws-northrop-digital",
	ownerUserId: "user-42",
	issueKey: "CYR-64",
	runId: activeRunWithPendingWork.runId,
	sessionId: "session-9c8b7a6d",
	component: "ContainerLifecycle",
	levels: ["warn", "error"],
	text: "idle_stop_skipped",
	traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
	limit: 500,
} as const;

export const logRecord = {
	schemaVersion: 1,
	recordId: "record-0001",
	timestamp: "2026-09-03T09:59:12.000Z",
	level: "warn",
	message: "sandbox.idle_stop_skipped",
	component: "ContainerLifecycle",
	workspaceId: "ws-northrop-digital",
	ownerUserId: "user-42",
	issueKey: "CYR-64",
	runId: activeRunWithPendingWork.runId,
	sessionId: "session-9c8b7a6d",
	traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
	spanId: "00f067aa0ba902b7",
	attributes: { "cyrus.reason": "claimed_mid_sweep" },
	redacted: false,
} as const;

/** Strips `undefined` keys so spread-built fixtures parse as absent, not present. */
export function compact<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}
