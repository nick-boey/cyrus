import type { RunObservationV1 } from "cyrus-operator-protocol";
import { describe, expect, it } from "vitest";
import { UsageError } from "./errors.js";
import {
	describeRunFilters,
	matchesLocalRunFilters,
	parseRunFilters,
	RUN_FILTER_FLAGS,
	toRunsQuery,
} from "./runFilters.js";

function observation(
	overrides: Partial<RunObservationV1> = {},
): RunObservationV1 {
	return {
		schemaVersion: 1,
		runId: "run-1",
		agentSessionId: "session-1",
		issueId: "issue-uuid-1",
		issueKey: "NOR-402",
		routing: {
			workspaceId: "ws-1",
			workspaceName: "Northrop Digital",
			ownerUserId: "user-1",
			ownerName: "Ada",
			linearTeamId: "team-1",
			linearTeamName: "Platform",
			linearProjectId: "project-1",
			linearProjectName: "Fleet",
			routedAt: "2026-09-02T00:00:00.000Z",
		},
		runner: "claude",
		model: "claude-opus-5",
		executorKind: "container",
		provider: "aca",
		lifecycle: "active",
		inputs: [
			{
				activityId: "activity-1",
				commentId: "comment-1",
				routedAt: "2026-09-02T00:00:00.000Z",
			},
		],
		worker: { online: true },
		executorState: "running",
		executorStateObservedAt: "2026-09-02T00:00:05.000Z",
		startedAt: "2026-09-02T00:00:00.000Z",
		observedAt: "2026-09-02T00:00:10.000Z",
		revision: 3,
		...overrides,
	} as RunObservationV1;
}

describe("parseRunFilters", () => {
	it("names every filter the fleet vocabulary defines", () => {
		expect([...RUN_FILTER_FLAGS].sort()).toEqual([
			"--comment",
			"--issue",
			"--model",
			"--owner",
			"--project",
			"--routed-after",
			"--run",
			"--runner",
			"--session",
			"--state",
			"--team",
			"--workspace",
		]);
	});

	it("parses each filter and returns everything else untouched", () => {
		const { filters, rest } = parseRunFilters([
			"--workspace",
			"ws-1",
			"--owner",
			"Ada",
			"--team",
			"Platform",
			"--project",
			"Fleet",
			"--run",
			"run-1",
			"--session",
			"session-1",
			"--issue",
			"NOR-402",
			"--state",
			"active",
			"--runner",
			"claude",
			"--model",
			"claude-opus-5",
			"--comment",
			"comment-1",
			"--routed-after",
			"2026-09-02T00:00:00.000Z",
			"--json",
			"positional",
		]);

		expect(filters).toEqual({
			workspace: "ws-1",
			owner: "Ada",
			team: "Platform",
			project: "Fleet",
			run: "run-1",
			session: "session-1",
			issue: "NOR-402",
			state: "active",
			runner: "claude",
			model: "claude-opus-5",
			comment: "comment-1",
			routedAfter: "2026-09-02T00:00:00.000Z",
		});
		expect(rest).toEqual(["--json", "positional"]);
	});

	it("rejects a state outside the closed run lifecycle vocabulary", () => {
		// `parked` is the LEGACY word, replaced by a worker-reported `waiting`.
		// Accepting it silently would return every run rather than none.
		expect(() => parseRunFilters(["--state", "parked"])).toThrow(UsageError);
		expect(() => parseRunFilters(["--state", "parked"])).toThrow(/waiting/);
	});

	it("rejects a --routed-after that is not an instant", () => {
		expect(() => parseRunFilters(["--routed-after", "yesterday"])).toThrow(
			UsageError,
		);
	});

	it("rejects a filter flag with no value", () => {
		expect(() => parseRunFilters(["--issue"])).toThrow(UsageError);
	});
});

describe("toRunsQuery", () => {
	it("sends the router only the parameters it implements", () => {
		// `GET /api/v1/runs` refuses an unknown parameter with 400 rather than
		// dropping it, so `comment` and `routed-after` must never be sent.
		const { filters } = parseRunFilters([
			"--owner",
			"Ada",
			"--team",
			"Platform",
			"--project",
			"Fleet",
			"--run",
			"run-1",
			"--session",
			"session-1",
			"--issue",
			"NOR-402",
			"--state",
			"active",
			"--runner",
			"claude",
			"--model",
			"claude-opus-5",
			"--comment",
			"comment-1",
			"--routed-after",
			"2026-09-02T00:00:00.000Z",
		]);

		expect(toRunsQuery(filters, "ws-1")).toEqual({
			workspace: "ws-1",
			owner: "Ada",
			team: "Platform",
			project: "Fleet",
			runId: "run-1",
			agentSessionId: "session-1",
			issueKey: "NOR-402",
			state: "active",
			runner: "claude",
			model: "claude-opus-5",
		});
	});

	it("always scopes to the resolved workspace, never to the raw flag", () => {
		// `--workspace` may name a workspace by its captured name; the router is
		// asked for the canonical id the selection already resolved.
		const { filters } = parseRunFilters(["--workspace", "Northrop Digital"]);

		expect(toRunsQuery(filters, "ws-1")).toEqual({ workspace: "ws-1" });
	});

	it("sends a non-identifier --issue as an issue id", () => {
		const key = parseRunFilters(["--issue", "NOR-402"]).filters;
		const uuid = parseRunFilters([
			"--issue",
			"3c9f2a10-5b6c-4d7e-8f90-a1b2c3d4e5f6",
		]).filters;

		expect(toRunsQuery(key, "ws-1")).toMatchObject({ issueKey: "NOR-402" });
		expect(toRunsQuery(uuid, "ws-1")).toMatchObject({
			issueId: "3c9f2a10-5b6c-4d7e-8f90-a1b2c3d4e5f6",
		});
	});
});

describe("matchesLocalRunFilters", () => {
	it("matches a run by the comment that started or joined it", () => {
		const { filters } = parseRunFilters(["--comment", "comment-1"]);

		expect(matchesLocalRunFilters(observation(), filters)).toBe(true);
		expect(
			matchesLocalRunFilters(
				observation({
					inputs: [
						{ commentId: "comment-9", routedAt: "2026-09-02T00:00:00.000Z" },
					],
				}),
				filters,
			),
		).toBe(false);
	});

	it("matches a run routed at or after the given instant", () => {
		const { filters } = parseRunFilters([
			"--routed-after",
			"2026-09-02T00:00:00.000Z",
		]);

		expect(matchesLocalRunFilters(observation(), filters)).toBe(true);
		expect(
			matchesLocalRunFilters(
				observation({
					routing: {
						...observation().routing,
						routedAt: "2026-09-01T23:59:59.000Z",
					},
					inputs: [{ routedAt: "2026-09-01T23:59:59.000Z" }],
				}),
				filters,
			),
		).toBe(false);
	});

	it("takes the LATEST routed input, so a long-running run still matches", () => {
		// A run started yesterday that received input a minute ago is exactly the
		// run an operator asking "what moved recently" needs to see.
		const { filters } = parseRunFilters([
			"--routed-after",
			"2026-09-02T00:00:00.000Z",
		]);

		expect(
			matchesLocalRunFilters(
				observation({
					routing: {
						...observation().routing,
						routedAt: "2026-09-01T00:00:00.000Z",
					},
					inputs: [
						{ routedAt: "2026-09-01T00:00:00.000Z" },
						{ routedAt: "2026-09-02T00:00:30.000Z" },
					],
				}),
				filters,
			),
		).toBe(true);
	});

	it("ignores filters the router already applied", () => {
		const { filters } = parseRunFilters(["--state", "complete"]);

		// `state` went to the router; re-applying it here would double-filter a
		// value the router may have resolved differently (e.g. a captured name).
		expect(matchesLocalRunFilters(observation(), filters)).toBe(true);
	});
});

describe("describeRunFilters", () => {
	it("renders the applied filters for a diagnostic line", () => {
		const { filters } = parseRunFilters([
			"--issue",
			"NOR-402",
			"--state",
			"active",
		]);

		expect(describeRunFilters(filters)).toBe("issue=NOR-402 state=active");
	});

	it("says so when nothing was filtered", () => {
		expect(describeRunFilters({})).toBe("none");
	});
});
