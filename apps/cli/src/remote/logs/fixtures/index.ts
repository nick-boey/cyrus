import type {
	AzureLogAnalyticsDescriptorV1,
	LogQueryV1,
	LogRecordV1,
	LogSourceDescriptorV1,
} from "cyrus-operator-protocol";

/**
 * Shared fixtures for the log-adapter tests.
 *
 * Built as FUNCTIONS with overrides rather than exported constants, so no test
 * can mutate a shared object and change what a later one asserts against — the
 * failure mode where a suite passes in isolation and fails in a run, which is
 * expensive to diagnose for exactly the reason that it is not about the code
 * under test.
 */

/** A Log Analytics workspace customer ID; the schema pins it to a GUID. */
export const WORKSPACE_GUID = "11111111-2222-3333-4444-555555555555";

export function azureTarget(
	overrides: Partial<AzureLogAnalyticsDescriptorV1> = {},
): AzureLogAnalyticsDescriptorV1 {
	return {
		workspaceId: WORKSPACE_GUID,
		table: "ContainerAppConsoleLogs_CL",
		...overrides,
	};
}

export function descriptor(
	overrides: Partial<LogSourceDescriptorV1> = {},
): LogSourceDescriptorV1 {
	return {
		schemaVersion: 1,
		kind: "azure-log-analytics",
		displayName: "cyrus-router logs",
		azure: azureTarget(),
		budgets: {
			defaultLookbackSeconds: 15 * 60,
			maxRangeSeconds: 24 * 60 * 60,
			maxRecords: 5_000,
			minFollowIntervalSeconds: 15,
		},
		...overrides,
	} as LogSourceDescriptorV1;
}

export function fakeDescriptor(
	overrides: Partial<LogSourceDescriptorV1> = {},
): LogSourceDescriptorV1 {
	const { azure: _azure, ...base } = descriptor() as LogSourceDescriptorV1 & {
		azure?: unknown;
	};
	return { ...base, kind: "fake", ...overrides } as LogSourceDescriptorV1;
}

export function query(overrides: Partial<LogQueryV1> = {}): LogQueryV1 {
	return {
		schemaVersion: 1,
		range: {
			from: "2026-09-07T00:00:00.000Z",
			to: "2026-09-07T00:15:00.000Z",
		},
		...overrides,
	} as LogQueryV1;
}

export function record(overrides: Partial<LogRecordV1> = {}): LogRecordV1 {
	return {
		schemaVersion: 1,
		recordId: "record-1",
		timestamp: "2026-09-07T00:05:00.000Z",
		level: "info",
		message: "routed NOR-402 to device 7",
		component: "EventRouter",
		workspaceId: "ws-1",
		ownerUserId: "user-1",
		issueKey: "NOR-402",
		runId: "run-1",
		sessionId: "session-1",
		attributes: {
			"cyrus.team_id": "team-1",
			"cyrus.project_id": "project-1",
			"cyrus.source": "router",
		},
		...overrides,
	} as LogRecordV1;
}

/**
 * One raw `ContainerAppConsoleLogs_CL` row, as the console JSON renderer writes
 * it and `parse_json(Log_s)` hands it back.
 *
 * Deliberately spelled out rather than derived from {@link record}: it is the
 * INPUT contract, and generating it from the expected output would make a
 * normalization test that passes whatever the mapping does.
 */
export function consoleRow(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		timestamp: "2026-09-07T00:05:00.000Z",
		level: "info",
		component: "EventRouter",
		message: "routed NOR-402 to device 7",
		event: "session.routed",
		"cyrus.workspace_id": "ws-1",
		"cyrus.workspace_name": "Northrop Digital",
		"cyrus.owner_id": "user-1",
		"cyrus.owner_name": "Ada",
		"cyrus.team_id": "team-1",
		"cyrus.team_name": "Platform",
		"cyrus.project_id": "project-1",
		"cyrus.project_name": "Fleet",
		"cyrus.issue_key": "NOR-402",
		"cyrus.run_id": "run-1",
		"cyrus.session_id": "session-1",
		"cyrus.device_id": 7,
		"cyrus.runner": "claude",
		"cyrus.model": "claude-opus-5",
		"cyrus.provider": "aca",
		"cyrus.source": "router",
		...overrides,
	};
}
