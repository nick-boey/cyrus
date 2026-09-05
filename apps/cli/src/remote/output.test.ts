import type { RunObservationV1 } from "cyrus-operator-protocol";
import { describe, expect, it, vi } from "vitest";
import {
	createOutputStreams,
	createRecordingOutput,
	renderRunsTable,
	renderWaitOutcome,
	renderWatchEvent,
	runsListDocument,
	waitDocument,
} from "./output.js";

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
		inputs: [{ commentId: "comment-1", routedAt: "2026-09-02T00:00:00.000Z" }],
		worker: { online: true },
		executorState: "running",
		executorStateObservedAt: "2026-09-02T00:00:05.000Z",
		startedAt: "2026-09-02T00:00:00.000Z",
		observedAt: "2026-09-02T00:00:10.000Z",
		revision: 3,
		...overrides,
	} as RunObservationV1;
}

describe("createOutputStreams", () => {
	it("writes data to stdout and diagnostics to stderr", () => {
		// The whole machine contract rests on this split: an orchestrator pipes
		// stdout into a JSON parser, and one deprecation line on the wrong stream
		// makes every document unparseable.
		const stdout = vi
			.spyOn(process.stdout, "write")
			.mockImplementation(() => true);
		const stderr = vi
			.spyOn(process.stderr, "write")
			.mockImplementation(() => true);
		try {
			const out = createOutputStreams();
			out.data("payload");
			out.diagnostic("careful");

			expect(stdout).toHaveBeenCalledWith("payload\n");
			expect(stderr).toHaveBeenCalledWith("careful\n");
		} finally {
			stdout.mockRestore();
			stderr.mockRestore();
		}
	});
});

describe("createRecordingOutput", () => {
	it("keeps the two streams separate for assertions", () => {
		const out = createRecordingOutput();
		out.data("a");
		out.diagnostic("b");
		out.data("c");

		expect(out.data_).toEqual(["a", "c"]);
		expect(out.diagnostics).toEqual(["b"]);
	});
});

describe("runsListDocument", () => {
	it("is one versioned document carrying the resolved workspace", () => {
		const document = runsListDocument({
			observedAt: "2026-09-02T00:00:10.000Z",
			workspace: { workspaceId: "ws-1", name: "Northrop Digital" },
			filters: { issue: "NOR-402" },
			runs: [observation()],
		});

		expect(document.schemaVersion).toBe(1);
		expect(document.observedAt).toBe("2026-09-02T00:00:10.000Z");
		expect(document.workspace).toEqual({
			workspaceId: "ws-1",
			name: "Northrop Digital",
		});
		expect(document.filters).toEqual({ issue: "NOR-402" });
		expect(document.runs).toHaveLength(1);
		expect(JSON.parse(JSON.stringify(document)).runs[0].runId).toBe("run-1");
	});
});

describe("renderRunsTable", () => {
	it("reports canonical ids beside their captured names", () => {
		const lines = renderRunsTable([observation()]);

		expect(lines[0]).toMatch(/^RUN\s+ISSUE\s+STATE\s/);
		const row = lines[1] as string;
		expect(row).toContain("run-1");
		expect(row).toContain("NOR-402");
		expect(row).toContain("active");
		// Name AND id — a name alone is captured display text two workspaces can
		// share, and an id alone is unreadable in an incident.
		expect(row).toContain("Northrop Digital (ws-1)");
		expect(row).toContain("Ada (user-1)");
		expect(row).toContain("Platform (team-1)");
		expect(row).toContain("Fleet (project-1)");
	});

	it("falls back to the canonical id when no name was captured", () => {
		const row = renderRunsTable([
			observation({
				routing: {
					workspaceId: "ws-1",
					ownerUserId: "user-1",
					routedAt: "2026-09-02T00:00:00.000Z",
				},
			}),
		])[1] as string;

		expect(row).toContain("ws-1");
		expect(row).not.toContain("(ws-1)");
	});

	it("shows the worker-reported wait reason beside a waiting state", () => {
		const row = renderRunsTable([
			observation({
				lifecycle: "waiting",
				wait: { reason: "elicitation", since: "2026-09-02T00:00:05.000Z" },
			}),
		])[1] as string;

		expect(row).toContain("waiting(elicitation)");
	});

	it("says an empty fleet is empty rather than printing a bare header", () => {
		expect(renderRunsTable([])).toEqual(["No matching runs."]);
	});
});

describe("renderWatchEvent", () => {
	it("renders each event kind as one human line", () => {
		expect(
			renderWatchEvent({
				schemaVersion: 1,
				event: "change",
				observedAt: "2026-09-02T00:00:11.000Z",
				changeId: "12",
				cursor: "v1.changes.ZQ.MTI",
				runId: "run-1",
				kind: "lifecycle",
				observation: observation({
					lifecycle: "complete",
					endedAt: "2026-09-02T00:00:11.000Z",
				}),
			}),
		).toBe("2026-09-02T00:00:11.000Z  lifecycle  NOR-402  complete  run-1");

		expect(
			renderWatchEvent({
				schemaVersion: 1,
				event: "resync",
				observedAt: "2026-09-02T00:00:12.000Z",
				reason: "stream_epoch_changed",
				streamEpoch: "epoch-2",
			}),
		).toBe(
			"2026-09-02T00:00:12.000Z  resync  the router restarted (stream epoch epoch-2); resumed from a fresh snapshot",
		);

		expect(
			renderWatchEvent({
				schemaVersion: 1,
				event: "stopped",
				observedAt: "2026-09-02T00:10:00.000Z",
				reason: "timeout",
			}),
		).toBe("2026-09-02T00:10:00.000Z  stopped  timeout");
	});
});

describe("waitDocument / renderWaitOutcome", () => {
	it("separates the run's own outcome from whether the wait was satisfied", () => {
		// A worker-reported `waiting` is a real outcome the wait observed; a
		// `timeout` is the command's own condition going unmet. Collapsing the two
		// is exactly what makes an orchestrator retry a run that is asking it a
		// question.
		const waiting = waitDocument({
			observedAt: "2026-09-02T00:00:20.000Z",
			runId: "run-1",
			outcome: "waiting",
			run: observation({
				lifecycle: "waiting",
				wait: { reason: "elicitation", since: "2026-09-02T00:00:15.000Z" },
			}),
		});
		expect(waiting).toMatchObject({
			schemaVersion: 1,
			runId: "run-1",
			outcome: "waiting",
			observed: true,
		});
		expect(renderWaitOutcome(waiting).join("\n")).toContain(
			"waiting (elicitation)",
		);

		const timedOut = waitDocument({
			observedAt: "2026-09-02T00:10:00.000Z",
			runId: "run-1",
			outcome: "timeout",
			run: observation(),
		});
		expect(timedOut).toMatchObject({ outcome: "timeout", observed: false });
		expect(renderWaitOutcome(timedOut).join("\n")).toContain("timed out");
	});
});
