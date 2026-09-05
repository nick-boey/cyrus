import type { EdgeConfig } from "cyrus-core";
import type {
	OperatorContextV1,
	RunChangePageV1,
	RunLifecycleStateV1,
	RunObservationPageV1,
	RunObservationV1,
} from "cyrus-operator-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Application } from "../Application.js";
import { ExitCode } from "../remote/exitCodes.js";
import { createRecordingOutput } from "../remote/output.js";
import { RunsCommand } from "./RunsCommand.js";

const BASE_URL = "https://router.example.com";
const RUNS_PATH = "/api/v1/runs";
const CHANGES_PATH = "/api/v1/run-changes";
const CONTEXT_PATH = "/api/v1/operator/context";

function context(
	overrides: Partial<OperatorContextV1> = {},
): OperatorContextV1 {
	return {
		schemaVersion: 1,
		principalId: "principal-1",
		authMethod: "local-operator-token",
		displayName: "Fleet operations",
		roles: ["fleet.read"],
		capabilities: ["runs.list", "runs.changes"],
		authorizedWorkspaces: [{ workspaceId: "ws-1", name: "Northrop Digital" }],
		observedAt: "2026-09-02T00:00:00.000Z",
		...overrides,
	};
}

function observation(
	overrides: Partial<RunObservationV1> = {},
): RunObservationV1 {
	const lifecycle = (overrides.lifecycle ?? "active") as RunLifecycleStateV1;
	const terminal = ["complete", "error", "stopped", "unknown"].includes(
		lifecycle,
	);
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
		lifecycle,
		inputs: [{ commentId: "comment-1", routedAt: "2026-09-02T00:00:00.000Z" }],
		worker: { online: true },
		executorState: "running",
		executorStateObservedAt: "2026-09-02T00:00:05.000Z",
		startedAt: "2026-09-02T00:00:00.000Z",
		...(terminal ? { endedAt: "2026-09-02T00:00:10.000Z" } : {}),
		observedAt: "2026-09-02T00:00:10.000Z",
		revision: 3,
		...overrides,
	} as RunObservationV1;
}

function page(
	runs: RunObservationV1[],
	nextCursor?: string,
): RunObservationPageV1 {
	return {
		schemaVersion: 1,
		observedAt: "2026-09-02T00:00:10.000Z",
		runs,
		...(nextCursor ? { nextCursor } : {}),
	};
}

function changePage(
	changes: Array<{ changeId: string; observation: RunObservationV1 }>,
	nextCursor: string,
	streamEpoch = "epoch-1",
): RunChangePageV1 {
	return {
		schemaVersion: 1,
		observedAt: "2026-09-02T00:00:11.000Z",
		streamEpoch,
		changes: changes.map((change) => ({
			schemaVersion: 1,
			changeId: change.changeId,
			cursor: `v1.changes.${b64(streamEpoch)}.${b64(change.changeId)}`,
			runId: change.observation.runId,
			kind: "lifecycle",
			observedAt: "2026-09-02T00:00:11.000Z",
			observation: change.observation,
		})),
		nextCursor,
	};
}

function b64(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function cursor(sequence: string, streamEpoch = "epoch-1"): string {
	return `v1.changes.${b64(streamEpoch)}.${b64(sequence)}`;
}

/** A fake `Application` exposing only what RunsCommand touches. */
function fakeApp(connectionUrl = BASE_URL) {
	const config = {
		repositories: [],
		operatorConnections: {
			prod: {
				url: connectionUrl,
				auth: { kind: "local", tokenEnv: "CYRUS_OPERATOR_TOKEN" },
			},
		},
	} as unknown as EdgeConfig;
	return {
		config: {
			load: () => structuredClone(config),
			save: () => {},
			getConfigPath: () => "/nonexistent/cyrus-runs-command/config.json",
		},
		logger: { raw: () => {}, error: () => {}, success: () => {} },
	} as unknown as Application;
}

type Handler = (url: URL) => Response | Promise<Response>;

/** Routes by path so a test states which documents the router serves. */
function router(handlers: Partial<Record<string, Handler>>) {
	const calls: URL[] = [];
	const fetchFn = vi.fn(async (input: string | URL) => {
		const url = new URL(String(input));
		calls.push(url);
		const handler = handlers[url.pathname];
		if (!handler) return new Response("", { status: 404 });
		return handler(url);
	}) as unknown as typeof fetch;
	return { fetchFn, calls };
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function command(
	fetchFn: typeof fetch,
	out = createRecordingOutput(),
	overrides: Record<string, unknown> = {},
) {
	const cmd = new RunsCommand(fakeApp(), {
		fetchFn,
		env: { CYRUS_OPERATOR_TOKEN: "cyop_deadbeefdeadbeef" },
		output: out,
		sleep: async () => {},
		now: () => Date.parse("2026-09-02T00:00:10.000Z"),
		...overrides,
	});
	return { cmd, out };
}

/** Runs the command through `execute`, capturing the exit code it chose. */
async function exitCodeOf(
	cmd: RunsCommand,
	argv: string[],
	selection: { connection?: string; workspace?: string } = {},
): Promise<number> {
	const exit = vi.spyOn(process, "exit").mockImplementation(((
		code?: number,
	) => {
		throw new ExitSignal(code ?? 0);
	}) as never);
	try {
		await cmd.execute(argv, selection);
		return ExitCode.success;
	} catch (error) {
		if (error instanceof ExitSignal) return error.code;
		throw error;
	} finally {
		exit.mockRestore();
	}
}

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

describe("cyrus runs list", () => {
	beforeEach(() => {
		process.exitCode = undefined;
	});

	it("fetches every page and exits 0 whatever the runs report", async () => {
		const pages = [
			page([observation({ runId: "run-1" })], "v1.runs.cGFnZS0y"),
			page([
				observation({ runId: "run-2", lifecycle: "error" }),
				observation({ runId: "run-3", lifecycle: "unknown" }),
			]),
		];
		const { fetchFn, calls } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(pages.shift()),
		});
		const { cmd, out } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["list", "--json"])).toBe(ExitCode.success);

		const runCalls = calls.filter((url) => url.pathname === RUNS_PATH);
		expect(runCalls).toHaveLength(2);
		expect(runCalls[0]?.searchParams.get("cursor")).toBe(null);
		expect(runCalls[1]?.searchParams.get("cursor")).toBe("v1.runs.cGFnZS0y");

		const document = JSON.parse(out.data_.join("\n"));
		expect(document.schemaVersion).toBe(1);
		expect(document.runs.map((run: RunObservationV1) => run.runId)).toEqual([
			"run-1",
			"run-2",
			"run-3",
		]);
		// An unhealthy fleet is a successful read, never a command failure.
		expect(process.exitCode).toBeUndefined();
	});

	it("sends every router-side filter and applies the rest locally", async () => {
		const { fetchFn, calls } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () =>
				json(
					page([
						observation({ runId: "run-1" }),
						observation({
							runId: "run-2",
							inputs: [
								{
									commentId: "comment-9",
									routedAt: "2026-09-02T00:00:00.000Z",
								},
							],
						}),
					]),
				),
		});
		const { cmd, out } = command(fetchFn);

		expect(
			await exitCodeOf(cmd, [
				"list",
				"--json",
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
				"2026-09-01T00:00:00.000Z",
			]),
		).toBe(ExitCode.success);

		const query = calls.find((url) => url.pathname === RUNS_PATH)
			?.searchParams as URLSearchParams;
		expect(Object.fromEntries(query.entries())).toEqual({
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

		// `comment` has no router-side parameter, so the CLI applies it.
		const document = JSON.parse(out.data_.join("\n"));
		expect(document.runs.map((run: RunObservationV1) => run.runId)).toEqual([
			"run-1",
		]);
	});

	it("reports an ambiguous captured name with the candidates the router named", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () =>
				json(
					{
						error: "ambiguous_name",
						message:
							'`team` name "Platform" matches 2 ids; use one of them instead',
						candidates: [
							{ id: "team-1", name: "Platform" },
							{ id: "team-2", name: "Platform" },
						],
					},
					400,
				),
		});
		const { cmd, out } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["list", "--team", "Platform"])).toBe(
			ExitCode.usage,
		);
		const diagnostics = out.diagnostics.join("\n");
		expect(diagnostics).toContain("team-1");
		expect(diagnostics).toContain("team-2");
		// Nothing on stdout: a caller parsing the document must not see a partial
		// one when the query was refused.
		expect(out.data_).toEqual([]);
	});

	it("refuses to guess which workspace a multi-workspace connection meant", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () =>
				json(
					context({
						authorizedWorkspaces: [
							{ workspaceId: "ws-1", name: "Northrop Digital" },
							{ workspaceId: "ws-2", name: "Acme" },
						],
					}),
				),
		});
		const { cmd, out } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["list"])).toBe(ExitCode.usage);
		expect(out.diagnostics.join("\n")).toContain("--workspace");
	});

	it("scopes to the named workspace of a multi-workspace connection", async () => {
		const { fetchFn, calls } = router({
			[CONTEXT_PATH]: () =>
				json(
					context({
						authorizedWorkspaces: [
							{ workspaceId: "ws-1", name: "Northrop Digital" },
							{ workspaceId: "ws-2", name: "Acme" },
						],
					}),
				),
			[RUNS_PATH]: () => json(page([])),
		});
		const { cmd } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["list", "--workspace", "Acme"])).toBe(
			ExitCode.success,
		);
		expect(
			calls
				.find((url) => url.pathname === RUNS_PATH)
				?.searchParams.get("workspace"),
		).toBe("ws-2");
	});

	it("prints a human table by default and JSON only on --json", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([observation()])),
		});
		const { cmd, out } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["list"])).toBe(ExitCode.success);

		expect(out.data_[0]).toMatch(/^RUN\s+ISSUE\s+STATE\s/);
		expect(out.data_.join("\n")).toContain("Northrop Digital (ws-1)");
		expect(() => JSON.parse(out.data_.join("\n"))).toThrow();
		// Diagnostics never contaminate the data stream.
		expect(out.diagnostics).toEqual([]);
	});

	it("says an empty fleet is empty, and emits an empty JSON document", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([])),
		});
		const { cmd, out } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["list"])).toBe(ExitCode.success);
		expect(out.data_).toEqual(["No matching runs."]);

		const jsonOut = createRecordingOutput();
		const { cmd: jsonCmd } = command(fetchFn, jsonOut);
		expect(await exitCodeOf(jsonCmd, ["list", "--json"])).toBe(
			ExitCode.success,
		);
		expect(JSON.parse(jsonOut.data_.join("\n")).runs).toEqual([]);
	});

	it("reports a rejected credential as an auth failure, not a transient one", async () => {
		// Retrying an unauthorized request is pure noise against the router.
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json({ error: "unauthorized" }, 401),
		});
		const { cmd } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["list"])).toBe(ExitCode.auth);
	});

	it("reports a router 500 as transient", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json({ error: "internal error" }, 500),
		});
		const { cmd } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["list"])).toBe(ExitCode.transient);
	});

	it("refuses a connection whose router does not serve runs.list", async () => {
		// Gating on the advertised capability, rather than attempting the call,
		// is what stops "this router is too old" reading as "found nothing".
		const { fetchFn, calls } = router({
			[CONTEXT_PATH]: () => json(context({ capabilities: [] })),
		});
		const { cmd, out } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["list"])).toBe(ExitCode.usage);
		expect(out.diagnostics.join("\n")).toContain("runs.list");
		expect(calls.some((url) => url.pathname === RUNS_PATH)).toBe(false);
	});

	it("rejects an unknown option rather than ignoring it", async () => {
		const { fetchFn } = router({ [CONTEXT_PATH]: () => json(context()) });
		const { cmd } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["list", "--stalled"])).toBe(ExitCode.usage);
	});
});

describe("cyrus runs watch", () => {
	beforeEach(() => {
		process.exitCode = undefined;
	});

	it("emits a snapshot then the material changes, and exits 0 on timeout", async () => {
		const changes = [
			changePage(
				[{ changeId: "12", observation: observation({ lifecycle: "active" }) }],
				cursor("12"),
			),
			changePage(
				[
					{
						changeId: "13",
						observation: observation({
							lifecycle: "complete",
							endedAt: "2026-09-02T00:00:11.000Z",
						}),
					},
				],
				cursor("13"),
			),
		];
		let clock = Date.parse("2026-09-02T00:00:10.000Z");
		const { fetchFn, calls } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([observation()])),
			[CHANGES_PATH]: (url) =>
				// `from=latest` starts at the present, so a real router answers it
				// with an empty page and a resume point — never with history.
				json(
					url.searchParams.get("from") === "latest"
						? changePage([], cursor("11"))
						: (changes.shift() ?? changePage([], cursor("13"))),
				),
		});
		const { cmd, out } = command(fetchFn, createRecordingOutput(), {
			now: () => clock,
			sleep: async () => {
				clock += 2_000;
			},
		});

		expect(await exitCodeOf(cmd, ["watch", "--json", "--timeout", "5"])).toBe(
			ExitCode.success,
		);

		const events = out.data_.map((line) => JSON.parse(line));
		expect(events[0]).toMatchObject({ schemaVersion: 1, event: "snapshot" });
		expect(events[0].runs).toHaveLength(1);
		// The snapshot cursor is taken BEFORE the listing, so nothing can happen
		// in the gap without landing in the feed.
		const changeCalls = calls.filter((url) => url.pathname === CHANGES_PATH);
		expect(changeCalls[0]?.searchParams.get("from")).toBe("latest");
		expect(events.slice(1, 3)).toMatchObject([
			{ event: "change", changeId: "12", kind: "lifecycle" },
			{ event: "change", changeId: "13" },
		]);
		expect(events.at(1).observation.lifecycle).toBe("active");
		expect(events.at(2).observation.lifecycle).toBe("complete");
		expect(events.at(-1)).toMatchObject({
			event: "stopped",
			reason: "timeout",
		});
		// A terminal run outcome does not fail a watch.
		expect(process.exitCode).toBeUndefined();
	});

	it("emits a versioned resync and re-snapshots when the router restarts", async () => {
		const responses: Array<() => Response> = [
			() =>
				json(
					{
						error: "stream_epoch_changed",
						message: "cursor is from an older stream epoch",
					},
					410,
				),
			() => json(changePage([], cursor("1", "epoch-2"), "epoch-2")),
		];
		let clock = Date.parse("2026-09-02T00:00:10.000Z");
		let changeRequests = 0;
		const { fetchFn, calls } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([observation()])),
			[CHANGES_PATH]: (url) => {
				changeRequests += 1;
				// The first request establishes the pre-restart cursor.
				if (url.searchParams.get("from") === "latest" && changeRequests === 1) {
					return json(changePage([], cursor("7")));
				}
				return (
					responses.shift() ??
					(() => json(changePage([], cursor("1", "epoch-2"), "epoch-2")))
				)();
			},
		});
		const { cmd, out } = command(fetchFn, createRecordingOutput(), {
			now: () => clock,
			sleep: async () => {
				clock += 2_000;
			},
		});

		expect(await exitCodeOf(cmd, ["watch", "--json", "--timeout", "5"])).toBe(
			ExitCode.success,
		);

		const events = out.data_.map((line) => JSON.parse(line));
		const resync = events.find((event) => event.event === "resync");
		expect(resync).toMatchObject({
			schemaVersion: 1,
			event: "resync",
			reason: "stream_epoch_changed",
		});
		// It re-snapshots rather than claiming continuity across the restart.
		expect(events.filter((event) => event.event === "snapshot")).toHaveLength(
			2,
		);
		expect(
			calls.filter(
				(url) =>
					url.pathname === CHANGES_PATH &&
					url.searchParams.get("from") === "latest",
			).length,
		).toBeGreaterThanOrEqual(2);
	});

	it("prints human lines rather than NDJSON without --json", async () => {
		let clock = Date.parse("2026-09-02T00:00:10.000Z");
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([observation()])),
			[CHANGES_PATH]: () => json(changePage([], cursor("1"))),
		});
		const { cmd, out } = command(fetchFn, createRecordingOutput(), {
			now: () => clock,
			sleep: async () => {
				clock += 2_000;
			},
		});

		expect(await exitCodeOf(cmd, ["watch", "--timeout", "3"])).toBe(
			ExitCode.success,
		);
		expect(out.data_.some((line) => line.startsWith("{"))).toBe(false);
		expect(out.data_.join("\n")).toContain("NOR-402");
	});

	it("ends the stream cleanly on Ctrl-C, and lets a second one kill", async () => {
		// Registering ANY SIGINT listener disables Node's own, so between the
		// first Ctrl-C and the next loop check the process is uninterruptible —
		// up to a full request timeout if the router stopped answering. The
		// second one has to restore the default, or an operator reaches for
		// `kill`.
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		const listenersBefore = process.listenerCount("SIGINT");
		let clock = Date.parse("2026-09-02T00:00:10.000Z");
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([observation()])),
			[CHANGES_PATH]: () => json(changePage([], cursor("1"))),
		});
		const { cmd, out } = command(fetchFn, createRecordingOutput(), {
			now: () => clock,
			sleep: async () => {
				clock += 2_000;
				process.emit("SIGINT");
			},
		});

		try {
			expect(await exitCodeOf(cmd, ["watch", "--json"])).toBe(ExitCode.success);
			const events = out.data_.map((line) => JSON.parse(line));
			expect(events.at(-1)).toMatchObject({
				event: "stopped",
				reason: "interrupted",
			});
			// The handler is removed however the watch ends, so a later command in
			// the same process is not left with a stale listener.
			expect(process.listenerCount("SIGINT")).toBe(listenersBefore);
			expect(kill).not.toHaveBeenCalled();
		} finally {
			kill.mockRestore();
		}
	});

	it("re-raises SIGINT on a second Ctrl-C rather than swallowing it", async () => {
		const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
		let clock = Date.parse("2026-09-02T00:00:10.000Z");
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([observation()])),
			[CHANGES_PATH]: () => json(changePage([], cursor("1"))),
		});
		const { cmd } = command(fetchFn, createRecordingOutput(), {
			now: () => clock,
			sleep: async () => {
				clock += 2_000;
				process.emit("SIGINT");
				process.emit("SIGINT");
			},
		});

		try {
			await exitCodeOf(cmd, ["watch", "--json"]);
			expect(kill).toHaveBeenCalledWith(process.pid, "SIGINT");
		} finally {
			kill.mockRestore();
		}
	});

	it("applies EVERY filter to a change, not only the two `list` applies locally", async () => {
		// `GET /api/v1/run-changes` takes only `cursor` and `from`, so nothing
		// upstream applied `--state`/`--issue`/`--run`. Without a client-side
		// check the stream contradicts its own snapshot: a correctly-filtered
		// empty snapshot, then change events for runs matching none of them.
		let clock = Date.parse("2026-09-02T00:00:10.000Z");
		let delivered = false;
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			// The router honours `?state=waiting` here and returns nothing.
			[RUNS_PATH]: () => json(page([])),
			[CHANGES_PATH]: (url) => {
				if (url.searchParams.get("from") === "latest" || delivered) {
					return json(changePage([], cursor("0")));
				}
				delivered = true;
				return json(
					changePage(
						[
							{
								changeId: "1",
								observation: observation({
									runId: "unrelated",
									issueKey: "NOR-999",
									lifecycle: "complete",
									endedAt: "2026-09-02T00:00:11.000Z",
								}),
							},
							{
								changeId: "2",
								observation: observation({
									runId: "wanted",
									lifecycle: "waiting",
									wait: {
										reason: "elicitation",
										since: "2026-09-02T00:00:11.000Z",
									},
								}),
							},
						],
						cursor("2"),
					),
				);
			},
		});
		const { cmd, out } = command(fetchFn, createRecordingOutput(), {
			now: () => clock,
			sleep: async () => {
				clock += 2_000;
			},
		});

		expect(
			await exitCodeOf(cmd, [
				"watch",
				"--json",
				"--state",
				"waiting",
				"--timeout",
				"3",
			]),
		).toBe(ExitCode.success);

		const changes = out.data_
			.map((line) => JSON.parse(line))
			.filter((event) => event.event === "change");
		expect(changes.map((event) => event.runId)).toEqual(["wanted"]);
	});

	it("backs off before re-snapshotting after a 410", async () => {
		// A `410` means the router process started, so a crash-looping router
		// mints a new epoch every time. Without the sleep this branch would
		// re-snapshot the whole fleet back-to-back against a failing router.
		let clock = Date.parse("2026-09-02T00:00:10.000Z");
		const sleeps: number[] = [];
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([observation()])),
			[CHANGES_PATH]: (url) =>
				url.searchParams.get("from") === "latest"
					? json(changePage([], cursor("1")))
					: json({ error: "stream_epoch_changed" }, 410),
		});
		const { cmd, out } = command(fetchFn, createRecordingOutput(), {
			now: () => clock,
			sleep: async (ms: number) => {
				sleeps.push(ms);
				clock += 2_000;
			},
		});

		expect(await exitCodeOf(cmd, ["watch", "--json", "--timeout", "5"])).toBe(
			ExitCode.success,
		);

		const resyncs = out.data_
			.map((line) => JSON.parse(line))
			.filter((event) => event.event === "resync");
		expect(resyncs.length).toBeGreaterThan(0);
		// One pause per resync: the branch never spins.
		expect(sleeps.length).toBeGreaterThanOrEqual(resyncs.length);
	});

	it("drains a backlog without waiting a whole interval per page", async () => {
		// A watch that falls behind gets no signal — the router skips aged-out
		// entries silently rather than answering 410 — so it must not be capped
		// at one page per poll.
		let clock = Date.parse("2026-09-02T00:00:10.000Z");
		let sleepCount = 0;
		let backlog = 3;
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([])),
			[CHANGES_PATH]: (url) => {
				if (url.searchParams.get("from") === "latest") {
					return json(changePage([], cursor("0")));
				}
				if (backlog > 0) {
					const id = String(backlog--);
					return json(
						changePage(
							[
								{
									changeId: id,
									observation: observation({ runId: `run-${id}` }),
								},
							],
							cursor(id),
						),
					);
				}
				return json(changePage([], cursor("done")));
			},
		});
		const { cmd, out } = command(fetchFn, createRecordingOutput(), {
			now: () => clock,
			sleep: async () => {
				sleepCount++;
				clock += 2_000;
			},
		});

		expect(await exitCodeOf(cmd, ["watch", "--json", "--timeout", "3"])).toBe(
			ExitCode.success,
		);

		const changes = out.data_
			.map((line) => JSON.parse(line))
			.filter((event) => event.event === "change");
		// All three drained without a pause between them: capped at one page per
		// interval, three backlog pages would have cost three sleeps on their own
		// and the 3s deadline would have cut the backlog short.
		expect(changes.map((event) => event.runId)).toEqual([
			"run-3",
			"run-2",
			"run-1",
		]);
		expect(sleepCount).toBeLessThan(3);
	});

	it("refuses a stray positional rather than ignoring it", async () => {
		// `run()` is a public entry point the deprecation shim re-enters by argv,
		// so Commander's own arity check is not the only way in.
		const { fetchFn } = router({ [CONTEXT_PATH]: () => json(context()) });
		const { cmd } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["watch", "NOR-402"])).toBe(ExitCode.usage);
		expect(await exitCodeOf(cmd, ["list", "NOR-402"])).toBe(ExitCode.usage);
	});

	it("drops a change from a workspace this invocation is not scoped to", async () => {
		let clock = Date.parse("2026-09-02T00:00:10.000Z");
		const { fetchFn } = router({
			[CONTEXT_PATH]: () =>
				json(
					context({
						authorizedWorkspaces: [
							{ workspaceId: "ws-1", name: "Northrop Digital" },
							{ workspaceId: "ws-2", name: "Acme" },
						],
					}),
				),
			[RUNS_PATH]: () => json(page([])),
			[CHANGES_PATH]: (url) =>
				json(
					url.searchParams.get("from") === "latest"
						? changePage([], cursor("1"))
						: changePage(
								[
									{
										changeId: "20",
										observation: observation({
											runId: "other",
											routing: {
												workspaceId: "ws-2",
												ownerUserId: "user-9",
												routedAt: "2026-09-02T00:00:00.000Z",
											},
										}),
									},
								],
								cursor("20"),
							),
				),
		});
		const { cmd, out } = command(fetchFn, createRecordingOutput(), {
			now: () => clock,
			sleep: async () => {
				clock += 2_000;
			},
		});

		expect(
			await exitCodeOf(cmd, [
				"watch",
				"--json",
				"--workspace",
				"ws-1",
				"--timeout",
				"3",
			]),
		).toBe(ExitCode.success);

		const events = out.data_.map((line) => JSON.parse(line));
		expect(events.some((event) => event.event === "change")).toBe(false);
	});
});

describe("cyrus runs wait", () => {
	beforeEach(() => {
		process.exitCode = undefined;
	});

	async function waitFor(
		lifecycleSequence: RunObservationV1[],
		argv: string[] = [],
	) {
		let clock = Date.parse("2026-09-02T00:00:10.000Z");
		const first = lifecycleSequence[0] as RunObservationV1;
		const rest = lifecycleSequence.slice(1);
		let sequence = 0;
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([first])),
			[CHANGES_PATH]: (url) => {
				if (url.searchParams.get("from") === "latest") {
					return json(changePage([], cursor("0")));
				}
				const next = rest.shift();
				sequence += 1;
				return json(
					next
						? changePage(
								[{ changeId: String(sequence), observation: next }],
								cursor(String(sequence)),
							)
						: changePage([], cursor(String(sequence))),
				);
			},
		});
		const { cmd, out } = command(fetchFn, createRecordingOutput(), {
			now: () => clock,
			sleep: async () => {
				clock += 2_000;
			},
		});
		const code = await exitCodeOf(cmd, ["wait", "run-1", "--json", ...argv]);
		return { code, out };
	}

	it("succeeds on a run that completes", async () => {
		const { code, out } = await waitFor([
			observation({ lifecycle: "active" }),
			observation({
				lifecycle: "complete",
				endedAt: "2026-09-02T00:00:11.000Z",
			}),
		]);

		expect(code).toBe(ExitCode.success);
		const document = JSON.parse(out.data_.join("\n"));
		expect(document).toMatchObject({
			schemaVersion: 1,
			runId: "run-1",
			outcome: "complete",
			observed: true,
		});
	});

	it("returns immediately when the run is already terminal", async () => {
		const { code, out } = await waitFor([
			observation({ lifecycle: "error", endedAt: "2026-09-02T00:00:10.000Z" }),
		]);

		expect(code).toBe(ExitCode.outcome);
		expect(JSON.parse(out.data_.join("\n")).outcome).toBe("error");
	});

	it.each([
		["stopped", ExitCode.outcome],
		["unknown", ExitCode.outcome],
	] as const)(
		"reports a %s outcome as a non-success",
		async (state, expected) => {
			const { code, out } = await waitFor([
				observation({
					lifecycle: state,
					endedAt: "2026-09-02T00:00:10.000Z",
				}),
			]);

			expect(code).toBe(expected);
			expect(JSON.parse(out.data_.join("\n")).outcome).toBe(state);
		},
	);

	it("distinguishes a worker-reported wait from its own unmet condition", async () => {
		// The run IS waiting — the worker said so. That is an observed outcome
		// (exit 3), not the wait command running out of time (exit 4).
		const { code, out } = await waitFor([
			observation({ lifecycle: "active" }),
			observation({
				lifecycle: "waiting",
				wait: { reason: "elicitation", since: "2026-09-02T00:00:11.000Z" },
			}),
		]);

		expect(code).toBe(ExitCode.outcome);
		const document = JSON.parse(out.data_.join("\n"));
		expect(document).toMatchObject({
			outcome: "waiting",
			observed: true,
		});
		expect(document.run.wait.reason).toBe("elicitation");
	});

	it("times out with its own category and still emits a document", async () => {
		const { code, out } = await waitFor(
			[observation({ lifecycle: "active" })],
			["--timeout", "4"],
		);

		expect(code).toBe(ExitCode.timeout);
		const document = JSON.parse(out.data_.join("\n"));
		expect(document).toMatchObject({ outcome: "timeout", observed: false });
		// It reports the last state it saw, never a guess about why.
		expect(document.run.lifecycle).toBe("active");
	});

	it("refuses a run id the router cannot see", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([])),
			[CHANGES_PATH]: () => json(changePage([], cursor("0"))),
		});
		const { cmd, out } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["wait", "run-404"])).toBe(ExitCode.usage);
		expect(out.diagnostics.join("\n")).toContain("run-404");
	});

	it("requires a run id, and exactly one", async () => {
		const { fetchFn } = router({ [CONTEXT_PATH]: () => json(context()) });
		const { cmd } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["wait"])).toBe(ExitCode.usage);
		expect(await exitCodeOf(cmd, ["wait", "run-1", "run-2"])).toBe(
			ExitCode.usage,
		);
	});

	it("refuses narrowing filters, which can only make the run vanish", async () => {
		// A run id is already the narrowest selector, and a filter over a MOVING
		// fact is worse than useless: `--state active` makes the run invisible the
		// instant it completes, turning the outcome this command exists to report
		// into "no such run".
		const { fetchFn } = router({ [CONTEXT_PATH]: () => json(context()) });
		const { cmd, out } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["wait", "run-1", "--state", "active"])).toBe(
			ExitCode.usage,
		);
		expect(out.diagnostics.join("\n")).toContain("cyrus runs list");
	});

	it("still accepts --workspace, which selects authority rather than narrowing", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () =>
				json(
					context({
						authorizedWorkspaces: [
							{ workspaceId: "ws-1", name: "Northrop Digital" },
							{ workspaceId: "ws-2", name: "Acme" },
						],
					}),
				),
			[RUNS_PATH]: () => json(page([observation({ lifecycle: "complete" })])),
			[CHANGES_PATH]: () => json(changePage([], cursor("0"))),
		});
		const { cmd } = command(fetchFn);

		expect(
			await exitCodeOf(cmd, ["wait", "run-1", "--workspace", "ws-1"]),
		).toBe(ExitCode.success);
	});

	it("flushes stdout before exiting non-zero", async () => {
		// `process.exit` does not drain pending writes, and stdout is async when
		// it is a pipe on macOS — so without an explicit flush the document is
		// truncated on exactly the paths (`error`, `waiting`, `timeout`) the
		// `--json` contract exists to serve.
		let flushed = 0;
		const out = createRecordingOutput();
		const recordingFlush = out.flush;
		out.flush = async () => {
			flushed++;
			await recordingFlush();
		};
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([observation({ lifecycle: "error" })])),
			[CHANGES_PATH]: () => json(changePage([], cursor("0"))),
		});
		const { cmd } = command(fetchFn, out);

		expect(await exitCodeOf(cmd, ["wait", "run-1", "--json"])).toBe(
			ExitCode.outcome,
		);
		expect(flushed).toBe(1);
	});
});

describe("cyrus runs — the deprecated pre-CYR-70 syntax", () => {
	beforeEach(() => {
		process.exitCode = undefined;
	});

	it("maps a bare `cyrus runs <issue>` onto list, warning on stderr", async () => {
		const { fetchFn, calls } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([observation()])),
		});
		const { cmd, out } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["NOR-402", "--json"])).toBe(ExitCode.success);

		expect(out.diagnostics.join("\n")).toMatch(/deprecated/i);
		expect(out.diagnostics.join("\n")).toContain("cyrus runs list");
		// The deprecation must not land in the data stream.
		expect(() => JSON.parse(out.data_.join("\n"))).not.toThrow();
		expect(
			calls
				.find((url) => url.pathname === RUNS_PATH)
				?.searchParams.get("issueKey"),
		).toBe("NOR-402");
	});

	it("translates the legacy --after into --routed-after", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () =>
				json(
					page([
						observation({
							runId: "old",
							routing: {
								workspaceId: "ws-1",
								ownerUserId: "user-1",
								routedAt: "2026-09-01T00:00:00.000Z",
							},
							inputs: [{ routedAt: "2026-09-01T00:00:00.000Z" }],
						}),
						observation({ runId: "new" }),
					]),
				),
		});
		const { cmd, out } = command(fetchFn);

		expect(
			await exitCodeOf(cmd, ["--json", "--after", "2026-09-02T00:00:00.000Z"]),
		).toBe(ExitCode.success);
		expect(
			JSON.parse(out.data_.join("\n")).runs.map(
				(run: RunObservationV1) => run.runId,
			),
		).toEqual(["new"]);
	});

	it("still refuses `--timeout` without `--watch`, as the old command did", async () => {
		// Accepting it would silently drop a flag the caller believed was bounding
		// something.
		const { fetchFn } = router({ [CONTEXT_PATH]: () => json(context()) });
		const { cmd, out } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["NOR-402", "--timeout", "600"])).toBe(
			ExitCode.usage,
		);
		expect(out.diagnostics.join("\n")).toContain("cyrus runs wait");
	});

	it("resolves `--watch` to the single non-terminal run and waits on it", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () =>
				json(
					page([
						observation({
							runId: "done",
							lifecycle: "complete",
							endedAt: "2026-09-02T00:00:05.000Z",
						}),
						observation({ runId: "live", lifecycle: "active" }),
					]),
				),
			[CHANGES_PATH]: (url) =>
				json(
					url.searchParams.get("from") === "latest"
						? changePage([], cursor("0"))
						: changePage(
								[
									{
										changeId: "5",
										observation: observation({
											runId: "live",
											lifecycle: "complete",
											endedAt: "2026-09-02T00:00:11.000Z",
										}),
									},
								],
								cursor("5"),
							),
				),
		});
		let clock = Date.parse("2026-09-02T00:00:10.000Z");
		const { cmd, out } = command(fetchFn, createRecordingOutput(), {
			now: () => clock,
			sleep: async () => {
				clock += 2_000;
			},
		});

		expect(await exitCodeOf(cmd, ["NOR-402", "--watch", "--json"])).toBe(
			ExitCode.success,
		);
		const document = JSON.parse(out.data_.join("\n"));
		expect(document).toMatchObject({ runId: "live", outcome: "complete" });
		expect(out.diagnostics.join("\n")).toContain("cyrus runs wait");
	});

	it("refuses an ambiguous `--watch` with the candidate runs, not a guess", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () =>
				json(
					page([
						observation({ runId: "run-a", lifecycle: "active" }),
						observation({ runId: "run-b", lifecycle: "routed" }),
					]),
				),
		});
		const { cmd, out } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["NOR-402", "--watch"])).toBe(ExitCode.usage);
		const diagnostics = out.diagnostics.join("\n");
		expect(diagnostics).toContain("run-a");
		expect(diagnostics).toContain("run-b");
		expect(diagnostics).toContain("cyrus runs wait");
	});

	it("refuses `--watch` when nothing is running", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () =>
				json(
					page([
						observation({
							runId: "done",
							lifecycle: "complete",
							endedAt: "2026-09-02T00:00:05.000Z",
						}),
					]),
				),
		});
		const { cmd, out } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["NOR-402", "--watch"])).toBe(ExitCode.usage);
		expect(out.diagnostics.join("\n")).toMatch(/no non-terminal run/i);
	});
});
