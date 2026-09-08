import type { EdgeConfig } from "cyrus-core";
import type {
	OperatorContextV1,
	RecoveryEvidenceV1,
	RecoveryOperationV1,
	RecoveryPhaseTransitionV1,
	RecoveryPhaseV1,
	RunLifecycleStateV1,
	RunObservationPageV1,
	RunObservationV1,
} from "cyrus-operator-protocol";
import { recoveryOperationV1Schema } from "cyrus-operator-protocol";
import { describe, expect, it, vi } from "vitest";
import type { Application } from "../Application.js";
import { ExitCode } from "../remote/exitCodes.js";
import { createRecordingOutput } from "../remote/output.js";
import { RecoverCommand } from "./RecoverCommand.js";

const BASE_URL = "https://router.example.com";
const CONTEXT_PATH = "/api/v1/operator/context";
const RUNS_PATH = "/api/v1/runs";
const RECOVERIES_PATH = "/api/v1/recoveries";
const OPERATOR_TOKEN = "cyop_deadbeefdeadbeef";

/* ------------------------------------------------------------- fixtures */

function context(
	overrides: Partial<OperatorContextV1> = {},
): OperatorContextV1 {
	return {
		schemaVersion: 1,
		principalId: "principal-1",
		authMethod: "local-operator-token",
		displayName: "Fleet operations",
		roles: ["fleet.read", "fleet.recover"],
		capabilities: ["runs.list", "runs.changes", "recoveries.request"],
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
		issueId: "11111111-2222-3333-4444-555555555555",
		issueKey: "NOR-402",
		routing: {
			workspaceId: "ws-1",
			workspaceName: "Northrop Digital",
			ownerUserId: "user-1",
			ownerName: "Ada",
			routedAt: "2026-09-02T00:00:00.000Z",
		},
		runner: "claude",
		executorKind: "container",
		lifecycle,
		// A waiting run must carry the wait its worker reported — the schema
		// refuses one without it, so a fixture that omitted it would be rejected
		// by the real client as a malformed page rather than exercising the path.
		...(lifecycle === "waiting"
			? {
					wait: {
						reason: "elicitation" as const,
						since: "2026-09-02T00:00:08.000Z",
					},
				}
			: {}),
		inputs: [],
		worker: { online: false },
		executorState: "stopped",
		executorStateObservedAt: "2026-09-02T00:00:05.000Z",
		startedAt: "2026-09-02T00:00:00.000Z",
		...(terminal ? { endedAt: "2026-09-02T00:00:10.000Z" } : {}),
		observedAt: "2026-09-02T00:00:10.000Z",
		revision: 7,
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

const EVIDENCE: RecoveryEvidenceV1 = {
	observedAt: "2026-09-02T00:00:10.000Z",
	revision: 7,
	lifecycle: "active",
	workerOnline: false,
	executorState: "stopped",
	sessionAffinityHeld: true,
	issueLocked: true,
};

function operation(input: {
	phases: RecoveryPhaseV1[];
	operationId?: string;
	runId?: string;
	idempotencyKey?: string;
	refusalReason?: RecoveryOperationV1["refusalReason"];
	failure?: { message: string };
}): RecoveryOperationV1 {
	const phase = input.phases[input.phases.length - 1] as RecoveryPhaseV1;
	const terminal = ["recovered", "needs_input", "refused", "failed"].includes(
		phase,
	);
	const phases: RecoveryPhaseTransitionV1[] = input.phases.map(
		(entered, index) => ({
			phase: entered,
			enteredAt: `2026-09-02T00:0${index}:00.000Z`,
		}),
	);
	return recoveryOperationV1Schema.parse({
		schemaVersion: 1,
		operationId: input.operationId ?? "op-1",
		runId: input.runId ?? "run-1",
		idempotencyKey: input.idempotencyKey ?? "cyrec_0123456789abcdef",
		actor: { principalId: "principal-1", authMethod: "local-operator-token" },
		expectedRevision: 7,
		phase,
		phases,
		requestedAt: "2026-09-02T00:00:00.000Z",
		updatedAt: "2026-09-02T00:05:00.000Z",
		...(terminal ? { completedAt: "2026-09-02T00:05:00.000Z" } : {}),
		evidenceBefore: EVIDENCE,
		...(terminal ? { evidenceAfter: { ...EVIDENCE, revision: 8 } } : {}),
		...(input.refusalReason ? { refusalReason: input.refusalReason } : {}),
		...(input.failure ? { failure: input.failure } : {}),
	});
}

/* --------------------------------------------------------------- harness */

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
			getConfigPath: () => "/nonexistent/cyrus-recover-command/config.json",
		},
		logger: { raw: () => {}, error: () => {}, success: () => {} },
	} as unknown as Application;
}

interface Call {
	url: URL;
	method: string;
	body?: unknown;
}

type Handler = (call: Call) => Response | Promise<Response>;

/**
 * Routes by path so a test states which documents the router serves, and
 * records every request so a test can prove where the CLI did and did not go.
 */
function router(handlers: Record<string, Handler>) {
	const calls: Call[] = [];
	const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = new URL(String(input));
		const call: Call = {
			url,
			method: init?.method ?? "GET",
			...(typeof init?.body === "string"
				? { body: JSON.parse(init.body) }
				: {}),
		};
		calls.push(call);
		const handler =
			handlers[url.pathname] ??
			// A recovery operation is addressed by id, so match its prefix too.
			(url.pathname.startsWith(`${RECOVERIES_PATH}/`)
				? handlers[`${RECOVERIES_PATH}/:id`]
				: undefined);
		if (!handler) return new Response("", { status: 404 });
		return handler(call);
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
	const cmd = new RecoverCommand(fakeApp(), {
		fetchFn,
		env: { CYRUS_OPERATOR_TOKEN: OPERATOR_TOKEN },
		output: out,
		sleep: async () => {},
		now: () => Date.parse("2026-09-02T00:05:00.000Z"),
		newIdempotencyKey: () => "cyrec_generated0123456789",
		pollIntervalMs: 1,
		...overrides,
	});
	return { cmd, out };
}

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

async function exitCodeOf(
	cmd: RecoverCommand,
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

/** The happy path most tests start from: one accepted operation that recovers. */
function recoveringRouter(
	options: {
		runs?: RunObservationPageV1;
		accepted?: RecoveryOperationV1;
		polled?: RecoveryOperationV1[];
		acceptStatus?: number;
	} = {},
) {
	const polled = options.polled ?? [
		operation({ phases: ["accepted", "starting_executor"] }),
		operation({
			phases: [
				"accepted",
				"starting_executor",
				"reconciling",
				"replaying",
				"releasing_stale_ownership",
				"recovered",
			],
		}),
	];
	let poll = 0;
	// The router stores the key it was sent and echoes it back on EVERY view of
	// the operation, so the fixture does too — the document reports the key bound
	// to the operation, which is the one a retry has to reuse.
	let boundKey: string | undefined;
	return router({
		[CONTEXT_PATH]: () => json(context()),
		[RUNS_PATH]: () => json(options.runs ?? page([observation()])),
		[RECOVERIES_PATH]: (call) => {
			boundKey = (call.body as { idempotencyKey?: string }).idempotencyKey;
			return json(
				bind(options.accepted ?? operation({ phases: ["accepted"] })),
				options.acceptStatus ?? 202,
			);
		},
		[`${RECOVERIES_PATH}/:id`]: () =>
			json(
				bind(
					polled[Math.min(poll++, polled.length - 1)] as RecoveryOperationV1,
				),
			),
	});

	function bind(record: RecoveryOperationV1): RecoveryOperationV1 {
		return boundKey ? { ...record, idempotencyKey: boundKey } : record;
	}
}

/* ------------------------------------------------------------ happy path */

describe("cyrus recover <runId>", () => {
	it("reads a fresh observation, quotes its revision, and exits 0 when recovered", async () => {
		const { fetchFn, calls } = recoveringRouter();
		const { cmd, out } = command(fetchFn);

		expect(await exitCodeOf(cmd, ["run-1"])).toBe(ExitCode.success);

		const post = calls.find((call) => call.method === "POST");
		expect(post?.url.pathname).toBe(RECOVERIES_PATH);
		expect(post?.body).toEqual({
			schemaVersion: 1,
			runId: "run-1",
			expectedRevision: 7,
			idempotencyKey: "cyrec_generated0123456789",
		});
		// The observation is read IMMEDIATELY BEFORE the request, so the revision
		// quoted is the freshest one this process could have seen.
		const order = calls.map((call) => `${call.method} ${call.url.pathname}`);
		expect(order.indexOf(`GET ${RUNS_PATH}`)).toBeLessThan(
			order.indexOf(`POST ${RECOVERIES_PATH}`),
		);
		expect(out.data_.join("\n")).toContain("recovered");
	});

	it("emits every phase the operation passed through", async () => {
		const { fetchFn } = recoveringRouter();
		const { cmd, out } = command(fetchFn);
		await exitCodeOf(cmd, ["run-1"]);
		const printed = out.data_.join("\n");
		for (const phase of [
			"accepted",
			"starting_executor",
			"reconciling",
			"replaying",
			"releasing_stale_ownership",
			"recovered",
		]) {
			expect(printed).toContain(phase);
		}
	});

	it("does not read an observation when a revision was quoted", async () => {
		const { fetchFn, calls } = recoveringRouter();
		const { cmd } = command(fetchFn);
		await exitCodeOf(cmd, ["run-1", "--expected-revision", "4"]);
		expect(calls.some((call) => call.url.pathname === RUNS_PATH)).toBe(false);
		expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
			expectedRevision: 4,
		});
	});

	it("refuses a revision that is not a number", async () => {
		const { fetchFn } = recoveringRouter();
		const { cmd } = command(fetchFn);
		expect(
			await exitCodeOf(cmd, ["run-1", "--expected-revision", "soon"]),
		).toBe(ExitCode.usage);
	});

	it("sends an explicit idempotency key unchanged", async () => {
		const { fetchFn, calls } = recoveringRouter();
		const { cmd } = command(fetchFn);
		await exitCodeOf(cmd, [
			"run-1",
			"--idempotency-key",
			"orchestrator-attempt-3",
		]);
		expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
			idempotencyKey: "orchestrator-attempt-3",
		});
	});

	it("reports the generated key so a retry can reuse it", async () => {
		const { fetchFn } = recoveringRouter();
		const { cmd, out } = command(fetchFn);
		await exitCodeOf(cmd, ["run-1", "--json"]);
		const document = JSON.parse(out.data_.join("\n"));
		expect(document.idempotencyKey).toBe("cyrec_generated0123456789");
	});

	it("joins an existing operation when the same key is retried", async () => {
		// The router answers 200 rather than 202 for a join, and the document is
		// the operation that already existed.
		const { fetchFn } = recoveringRouter({
			acceptStatus: 200,
			accepted: operation({
				phases: ["accepted", "starting_executor"],
				operationId: "op-existing",
			}),
			polled: [
				operation({
					phases: ["accepted", "starting_executor", "recovered"],
					operationId: "op-existing",
				}),
			],
		});
		const { cmd, out } = command(fetchFn);
		expect(
			await exitCodeOf(cmd, [
				"run-1",
				"--idempotency-key",
				"orchestrator-attempt-3",
				"--json",
			]),
		).toBe(ExitCode.success);
		const document = JSON.parse(out.data_.join("\n"));
		expect(document.joined).toBe(true);
		expect(document.operationId).toBe("op-existing");
	});
});

/* ------------------------------------------------------------ --issue */

describe("cyrus recover --issue", () => {
	it("acts when exactly one non-terminal run matches", async () => {
		const { fetchFn, calls } = recoveringRouter({
			runs: page([
				observation({ runId: "run-old", lifecycle: "complete" }),
				observation({ runId: "run-live", revision: 11 }),
			]),
		});
		const { cmd } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["--issue", "NOR-402"])).toBe(
			ExitCode.success,
		);
		expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
			runId: "run-live",
			expectedRevision: 11,
		});
	});

	it("exits 2 with the candidates and mutates nothing when more than one matches", async () => {
		const { fetchFn, calls } = recoveringRouter({
			runs: page([
				observation({ runId: "run-a", revision: 3 }),
				observation({ runId: "run-b", lifecycle: "waiting", revision: 5 }),
			]),
		});
		const { cmd, out } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["--issue", "NOR-402"])).toBe(ExitCode.usage);
		expect(calls.some((call) => call.method === "POST")).toBe(false);
		const diagnostics = out.diagnostics.join("\n");
		expect(diagnostics).toContain("run-a");
		expect(diagnostics).toContain("run-b");
		// Nothing goes to stdout on this path: a caller piping stdout into a parser
		// must not receive a candidate list where a document belongs.
		expect(out.data_).toEqual([]);
	});

	it("exits 2 and mutates nothing when no non-terminal run matches", async () => {
		const { fetchFn, calls } = recoveringRouter({
			runs: page([observation({ lifecycle: "complete" })]),
		});
		const { cmd } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["--issue", "NOR-402"])).toBe(ExitCode.usage);
		expect(calls.some((call) => call.method === "POST")).toBe(false);
	});

	it("refuses a run id and --issue together", async () => {
		const { fetchFn } = recoveringRouter();
		const { cmd } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["run-1", "--issue", "NOR-402"])).toBe(
			ExitCode.usage,
		);
	});

	it("refuses an invocation that names no target at all", async () => {
		const { fetchFn } = recoveringRouter();
		const { cmd } = command(fetchFn);
		expect(await exitCodeOf(cmd, [])).toBe(ExitCode.usage);
	});
});

/* --------------------------------------------------------------- outcomes */

describe("cyrus recover — exit categories", () => {
	it("exits 3 when the router refuses a stale revision, without retrying", async () => {
		const { fetchFn, calls } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([observation()])),
			[RECOVERIES_PATH]: () =>
				json(
					{
						error: "stale_revision",
						message:
							"This run has changed since the observation the request quotes; re-read it and retry",
						currentRevision: 9,
					},
					409,
				),
		});
		const { cmd, out } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["run-1"])).toBe(ExitCode.outcome);
		// The current revision is the one fact that makes the retry possible.
		expect(out.diagnostics.join("\n")).toContain("9");
		expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
	});

	it("exits 3 when the router refuses a run that already ended", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([observation()])),
			[RECOVERIES_PATH]: () =>
				json(
					{
						error: "run_already_terminal",
						message: "This run has already ended (complete)",
						lifecycle: "complete",
					},
					409,
				),
		});
		const { cmd } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["run-1"])).toBe(ExitCode.outcome);
	});

	it("exits 2 when an idempotency key is bound to a different run", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([observation()])),
			[RECOVERIES_PATH]: () =>
				json(
					{
						error: "idempotency_key_conflict",
						message:
							"This idempotency key is already bound to a different run or revision",
					},
					409,
				),
		});
		const { cmd } = command(fetchFn);
		expect(
			await exitCodeOf(cmd, ["run-1", "--idempotency-key", "reused-key"]),
		).toBe(ExitCode.usage);
	});

	it.each([
		["needs_input", { refusalReason: undefined }],
		["refused", { refusalReason: "worker_owns_active_work" as const }],
		["failed", { failure: { message: "the executor never came back" } }],
	])("exits 3 when the operation ends %s", async (phase, extra) => {
		const { fetchFn } = recoveringRouter({
			polled: [
				operation({
					phases: ["accepted", phase as RecoveryPhaseV1],
					...(extra as Record<string, unknown>),
				}),
			],
		});
		const { cmd, out } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["run-1"])).toBe(ExitCode.outcome);
		expect(out.data_.join("\n")).toContain(phase);
	});

	it("names the refusal reason so an operator knows what to do next", async () => {
		const { fetchFn } = recoveringRouter({
			polled: [
				operation({
					phases: ["accepted", "refused"],
					refusalReason: "worker_owns_active_work",
				}),
			],
		});
		const { cmd, out } = command(fetchFn);
		await exitCodeOf(cmd, ["run-1"]);
		expect(`${out.data_.join("\n")}${out.diagnostics.join("\n")}`).toContain(
			"worker_owns_active_work",
		);
	});

	it("exits 4 when the operation has not finished in time", async () => {
		const { fetchFn } = recoveringRouter({
			polled: [operation({ phases: ["accepted", "reconciling"] })],
		});
		let clock = Date.parse("2026-09-02T00:05:00.000Z");
		const { cmd, out } = command(fetchFn, createRecordingOutput(), {
			now: () => {
				clock += 60_000;
				return clock;
			},
		});
		expect(await exitCodeOf(cmd, ["run-1", "--timeout", "1"])).toBe(
			ExitCode.timeout,
		);
		// A timeout still leaves the operation id, because the recovery is still
		// running on the router and `recover status` is how it is picked back up.
		expect(out.data_.join("\n")).toContain("op-1");
	});

	it("exits 5 when the router rejects the credential", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json({ error: "forbidden" }, 403),
		});
		const { cmd } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["run-1"])).toBe(ExitCode.auth);
	});

	it("exits 6 when the router fails transiently", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json({ error: "internal error" }, 503),
		});
		const { cmd } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["run-1"])).toBe(ExitCode.transient);
	});

	it("reports a router that advertises recovery but does not serve it as a misconfiguration", async () => {
		// Fastify's own 404 body is `{"error":"Not Found",…}`. Read as a refusal it
		// would reach the operator as `refused the recovery (Not Found)` — a
		// routing failure rendered as a decision the router made about their run —
		// and would retire the message that names the real problem.
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([observation()])),
			[RECOVERIES_PATH]: () =>
				json(
					{
						message: "Route POST:/api/v1/recoveries not found",
						error: "Not Found",
						statusCode: 404,
					},
					404,
				),
		});
		const { cmd, out } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["run-1"])).toBe(ExitCode.usage);
		const diagnostics = out.diagnostics.join("\n");
		expect(diagnostics).toContain("does not serve");
		expect(diagnostics).not.toContain("refused the recovery");
	});

	it("still reports a run the connection cannot see as a refusal", async () => {
		// The other 404 on the same route, and the reason the check is a closed set
		// of codes rather than a blanket "any 404 is a routing failure".
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([observation()])),
			[RECOVERIES_PATH]: () =>
				json(
					{
						error: "run_not_found",
						message: "No such run, or it is not one this principal may read",
					},
					404,
				),
		});
		const { cmd, out } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["run-1"])).toBe(ExitCode.usage);
		expect(out.diagnostics.join("\n")).toContain("No such run");
	});

	it("exits 2 when the router does not serve guarded recovery, before any request", async () => {
		const { fetchFn, calls } = router({
			[CONTEXT_PATH]: () =>
				json(context({ capabilities: ["runs.list"], roles: ["fleet.read"] })),
			[RUNS_PATH]: () => json(page([observation()])),
			[RECOVERIES_PATH]: () => json(operation({ phases: ["accepted"] }), 202),
		});
		const { cmd, out } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["run-1"])).toBe(ExitCode.usage);
		expect(calls.some((call) => call.method === "POST")).toBe(false);
		expect(out.diagnostics.join("\n")).toContain("recoveries.request");
	});
});

/* ---------------------------------------------------------------- no-wait */

describe("cyrus recover --no-wait", () => {
	it("returns after the acceptance with an operation id and never polls", async () => {
		const { fetchFn, calls } = recoveringRouter();
		const { cmd, out } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["run-1", "--no-wait", "--json"])).toBe(
			ExitCode.success,
		);
		expect(
			calls.some((call) => call.url.pathname.startsWith(`${RECOVERIES_PATH}/`)),
		).toBe(false);
		const document = JSON.parse(out.data_.join("\n"));
		expect(document.operationId).toBe("op-1");
		expect(document.complete).toBe(false);
		expect(document.outcome).toBe("pending");
	});

	it("still reports a terminal answer the router already gave", async () => {
		// A joined key can return an operation that has already finished. Reporting
		// success for a refusal we are holding in our hand would be a lie.
		const { fetchFn } = recoveringRouter({
			acceptStatus: 200,
			accepted: operation({
				phases: ["accepted", "refused"],
				refusalReason: "worker_owns_active_work",
			}),
		});
		const { cmd } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["run-1", "--no-wait"])).toBe(
			ExitCode.outcome,
		);
	});
});

/* ----------------------------------------------------------------- status */

describe("cyrus recover status <operationId>", () => {
	it("reads one operation and exits 0 while it is still in flight", async () => {
		const { fetchFn, calls } = router({
			[CONTEXT_PATH]: () => json(context()),
			[`${RECOVERIES_PATH}/:id`]: () =>
				json(operation({ phases: ["accepted", "reconciling"] })),
		});
		const { cmd, out } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["status", "op-1", "--json"])).toBe(
			ExitCode.success,
		);
		expect(calls.some((call) => call.method === "POST")).toBe(false);
		const document = JSON.parse(out.data_.join("\n"));
		expect(document.complete).toBe(false);
		expect(document.operation.phase).toBe("reconciling");
	});

	it("reports the terminal outcome of a finished operation", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[`${RECOVERIES_PATH}/:id`]: () =>
				json(operation({ phases: ["accepted", "recovered"] })),
		});
		const { cmd } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["status", "op-1"])).toBe(ExitCode.success);
	});

	it("resumes following an operation with --wait", async () => {
		const answers = [
			operation({ phases: ["accepted", "reconciling"] }),
			operation({ phases: ["accepted", "reconciling", "recovered"] }),
		];
		let poll = 0;
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[`${RECOVERIES_PATH}/:id`]: () =>
				json(answers[Math.min(poll++, answers.length - 1)]),
		});
		const { cmd, out } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["status", "op-1", "--wait"])).toBe(
			ExitCode.success,
		);
		expect(out.data_.join("\n")).toContain("recovered");
	});

	it("exits 3 for an operation that was refused", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[`${RECOVERIES_PATH}/:id`]: () =>
				json(
					operation({
						phases: ["accepted", "refused"],
						refusalReason: "executor_not_startable",
					}),
				),
		});
		const { cmd } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["status", "op-1"])).toBe(ExitCode.outcome);
	});

	it("exits 2 for an operation id this connection cannot see", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[`${RECOVERIES_PATH}/:id`]: () =>
				json({ error: "operation_not_found" }, 404),
		});
		const { cmd } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["status", "op-missing"])).toBe(
			ExitCode.usage,
		);
	});

	it("requires an operation id", async () => {
		const { fetchFn } = recoveringRouter();
		const { cmd } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["status"])).toBe(ExitCode.usage);
	});

	it("emits no `accepted` event under --ndjson, because it accepted nothing", async () => {
		// A read is not a request. An `accepted` line here would make a stored
		// stream of a status read indistinguishable from one of a mutation.
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[`${RECOVERIES_PATH}/:id`]: () =>
				json(operation({ phases: ["accepted", "recovered"] })),
		});
		const { cmd, out } = command(fetchFn);
		await exitCodeOf(cmd, ["status", "op-1", "--ndjson"]);
		const events = out.data_.map((line) => JSON.parse(line));
		expect(events.map((event) => event.event)).toEqual([
			"phase",
			"phase",
			"result",
		]);
		// `result` still carries every field `accepted` would have, so nothing a
		// reader needs is lost by its absence.
		expect(events[events.length - 1]).toMatchObject({
			operationId: "op-1",
			runId: "run-1",
			idempotencyKey: expect.any(String),
			expectedRevision: expect.any(Number),
		});
	});

	it("does not demand --workspace on a connection authorizing several", async () => {
		// The route takes no workspace and an operation id is globally unique, so
		// requiring one would block an orchestrator resuming the id `--no-wait`
		// handed it — to narrow a request with nothing to narrow.
		const { fetchFn } = router({
			[CONTEXT_PATH]: () =>
				json(
					context({
						authorizedWorkspaces: [
							{ workspaceId: "ws-1", name: "One" },
							{ workspaceId: "ws-2", name: "Two" },
						],
					}),
				),
			[`${RECOVERIES_PATH}/:id`]: () =>
				json(operation({ phases: ["accepted", "recovered"] })),
		});
		const { cmd } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["status", "op-1"])).toBe(ExitCode.success);
	});

	it("still refuses a --workspace that is not authorized", async () => {
		// Skipping the requirement must not mean skipping the validation: a
		// misspelled workspace silently ignored is its own trap.
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[`${RECOVERIES_PATH}/:id`]: () =>
				json(operation({ phases: ["accepted", "recovered"] })),
		});
		const { cmd } = command(fetchFn);
		expect(
			await exitCodeOf(cmd, ["status", "op-1"], { workspace: "ws-typo" }),
		).toBe(ExitCode.usage);
	});
});

/* ----------------------------------------------------------------- output */

describe("cyrus recover — output modes", () => {
	it("prints a human summary on stdout with no JSON by default", async () => {
		const { fetchFn } = recoveringRouter();
		const { cmd, out } = command(fetchFn);
		await exitCodeOf(cmd, ["run-1"]);
		expect(out.data_.length).toBeGreaterThan(0);
		for (const line of out.data_) {
			expect(() => JSON.parse(line)).toThrow();
		}
	});

	it("emits exactly one JSON document with --json", async () => {
		const { fetchFn } = recoveringRouter();
		const { cmd, out } = command(fetchFn);
		await exitCodeOf(cmd, ["run-1", "--json"]);
		expect(out.data_).toHaveLength(1);
		const document = JSON.parse(out.data_[0] as string);
		expect(document).toMatchObject({
			schemaVersion: 1,
			runId: "run-1",
			operationId: "op-1",
			outcome: "recovered",
			complete: true,
			joined: false,
		});
	});

	it("emits one JSON object per line with --ndjson, ending in a result", async () => {
		const { fetchFn } = recoveringRouter();
		const { cmd, out } = command(fetchFn);
		await exitCodeOf(cmd, ["run-1", "--ndjson"]);
		const events = out.data_.map((line) => JSON.parse(line));
		expect(events[0]).toMatchObject({
			schemaVersion: 1,
			event: "accepted",
			operationId: "op-1",
		});
		expect(
			events.filter((event) => event.event === "phase").map((e) => e.phase),
		).toEqual([
			"accepted",
			"starting_executor",
			"reconciling",
			"replaying",
			"releasing_stale_ownership",
			"recovered",
		]);
		expect(events[events.length - 1]).toMatchObject({
			event: "result",
			outcome: "recovered",
		});
	});

	it("refuses --json and --ndjson together", async () => {
		const { fetchFn } = recoveringRouter();
		const { cmd } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["run-1", "--json", "--ndjson"])).toBe(
			ExitCode.usage,
		);
	});

	it("refuses an unknown option rather than ignoring it", async () => {
		// This drives `execute()` directly, so it covers the command's OWN parser —
		// which is what a caller re-entering by argv reaches, and the layer that
		// still decides combinations Commander cannot see (an empty value, or
		// `--timeout` beside `--no-wait`). Through the shipped binary, Commander
		// rejects `--force` before this code runs; that path is asserted in
		// `buildProgram.test.ts`, which is where the exit code an operator
		// actually receives is pinned.
		const { fetchFn } = recoveringRouter();
		const { cmd } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["run-1", "--force"])).toBe(ExitCode.usage);
	});

	it.each([
		["--expected-revision"],
		["--idempotency-key"],
		["--issue"],
		["--timeout"],
	])("refuses an empty %s rather than treating it as absent", async (flag) => {
		// `--expected-revision "$REV"` with REV unset reaches here as an empty
		// string. Dropping it would substitute the command's own fresh read for
		// the caller's evidence — the exact substitution the flag exists to
		// prevent — and an empty `--idempotency-key` would start a competing
		// operation where the caller meant to join their own.
		const { fetchFn, calls } = recoveringRouter();
		const { cmd } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["run-1", flag, ""])).toBe(ExitCode.usage);
		expect(calls.some((call) => call.method === "POST")).toBe(false);
	});

	it("refuses --timeout with --no-wait, which has no wait to bound", async () => {
		const { fetchFn } = recoveringRouter();
		const { cmd } = command(fetchFn);
		expect(
			await exitCodeOf(cmd, ["run-1", "--no-wait", "--timeout", "30"]),
		).toBe(ExitCode.usage);
	});

	it("refuses --timeout on a status read that is not following", async () => {
		const { fetchFn } = recoveringRouter();
		const { cmd } = command(fetchFn);
		expect(await exitCodeOf(cmd, ["status", "op-1", "--timeout", "30"])).toBe(
			ExitCode.usage,
		);
	});

	it("keeps every diagnostic off stdout", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () => json(page([])),
		});
		const { cmd, out } = command(fetchFn);
		await exitCodeOf(cmd, ["run-1", "--json"]);
		expect(out.data_).toEqual([]);
		expect(out.diagnostics.length).toBeGreaterThan(0);
	});
});

/* -------------------------------------------------------------- disclosure */

describe("cyrus recover — what it must never print", () => {
	it("prints no bearer token, operator token, or Authorization header", async () => {
		const { fetchFn } = recoveringRouter();
		const { cmd, out } = command(fetchFn);
		await exitCodeOf(cmd, ["run-1", "--json"]);
		const printed = [...out.data_, ...out.diagnostics].join("\n");
		expect(printed).not.toContain(OPERATOR_TOKEN);
		expect(printed.toLowerCase()).not.toContain("bearer ");
		expect(printed.toLowerCase()).not.toContain("authorization");
	});

	it("redacts a credential the router echoed back in an error", async () => {
		const { fetchFn } = router({
			[CONTEXT_PATH]: () => json(context()),
			[RUNS_PATH]: () =>
				json(
					{ error: "invalid_query", message: `rejected ${OPERATOR_TOKEN}` },
					400,
				),
		});
		const { cmd, out } = command(fetchFn);
		await exitCodeOf(cmd, ["run-1"]);
		expect([...out.data_, ...out.diagnostics].join("\n")).not.toContain(
			OPERATOR_TOKEN,
		);
	});

	// The two fields on an operation whose text the ROUTER composes, and so the
	// only places a credential from a failing call can ride back to us. Everything
	// else on the document is a closed enum, an id, a boolean, or a number.
	const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlaGVyZQ";
	const LEAKY_OPERATION = () =>
		operation({
			phases: ["accepted", "starting_executor", "failed"],
			failure: { message: `azure call failed: Bearer ${JWT}` },
		});

	it.each(["--json", "--ndjson", "--human"])(
		"redacts a credential the router put in a failure message (%s)",
		async (mode) => {
			const leaky = LEAKY_OPERATION();
			// The phase detail is the same class of field, so it carries a second
			// credential shape — an operator token — to prove both are covered.
			const withDetail = {
				...leaky,
				phases: leaky.phases.map((phase, index) =>
					index === 1
						? { ...phase, detail: `booting with ${OPERATOR_TOKEN}` }
						: phase,
				),
			};
			const { fetchFn } = recoveringRouter({ polled: [withDetail] });
			const { cmd, out } = command(fetchFn);
			await exitCodeOf(cmd, mode === "--human" ? ["run-1"] : ["run-1", mode]);

			const printed = [...out.data_, ...out.diagnostics].join("\n");
			// stdout is the half that was leaking: `--json` and `--ndjson` serialize
			// the operation whole, and those are the modes an orchestrator pipes.
			expect(printed).not.toContain(JWT);
			expect(printed).not.toContain(OPERATOR_TOKEN);
			// Redacted, not dropped — the operator still has to see that the call
			// failed and that something was removed.
			expect(printed).toContain("azure call failed");
			expect(printed).toContain("[redacted]");
		},
	);

	it("prints no prompt text or comment body", async () => {
		// A run observation carries no prompt text by contract; this asserts the
		// command does not go looking for any either. Weak on its own — nothing
		// here could emit those literals — so it is paired with the redaction
		// tests above, which put real credential shapes in the fields that CAN
		// carry them.
		const { fetchFn } = recoveringRouter();
		const { cmd, out } = command(fetchFn);
		await exitCodeOf(cmd, ["run-1", "--json"]);
		const printed = [...out.data_, ...out.diagnostics].join("\n");
		expect(printed).not.toContain("prompt");
		expect(printed).not.toContain("commentBody");
	});

	it("never asks for confirmation on the safe path", async () => {
		const { fetchFn } = recoveringRouter();
		const { cmd, out } = command(fetchFn);
		await exitCodeOf(cmd, ["run-1"]);
		const printed = [...out.data_, ...out.diagnostics].join("\n").toLowerCase();
		expect(printed).not.toContain("are you sure");
		expect(printed).not.toContain("[y/n]");
		expect(printed).not.toContain("continue?");
	});
});

/* --------------------------------------------------- what it cannot reach */

describe("cyrus recover — the controls it does not have", () => {
	it("talks only to the operator API's read and recovery routes", async () => {
		const { fetchFn, calls } = recoveringRouter();
		const { cmd } = command(fetchFn);
		await exitCodeOf(cmd, ["run-1"]);
		for (const call of calls) {
			expect(call.url.origin).toBe(BASE_URL);
			expect(
				call.url.pathname === CONTEXT_PATH ||
					call.url.pathname === RUNS_PATH ||
					call.url.pathname === RECOVERIES_PATH ||
					call.url.pathname.startsWith(`${RECOVERIES_PATH}/`),
			).toBe(true);
		}
		// Nothing reaches Linear, and no break-glass control is invoked.
		expect(
			calls.some((call) =>
				/linear\.app|\/unlock|destroy|restart|redeliver/i.test(call.url.href),
			),
		).toBe(false);
	});

	it("asks the router for one semantic intent and cannot name a step", async () => {
		const { fetchFn, calls } = recoveringRouter();
		const { cmd } = command(fetchFn);
		await exitCodeOf(cmd, ["run-1"]);
		const post = calls.find((call) => call.method === "POST");
		// The request body is exactly the contract's four fields — there is no
		// `force`, no `unlock`, no `destroyExecutor`, and no way to select a phase.
		expect(Object.keys(post?.body as object).sort()).toEqual([
			"expectedRevision",
			"idempotencyKey",
			"runId",
			"schemaVersion",
		]);
	});

	it("performs no mutation at all when the target cannot be resolved", async () => {
		const { fetchFn, calls } = recoveringRouter({ runs: page([]) });
		const { cmd } = command(fetchFn);
		await exitCodeOf(cmd, ["run-1"]);
		expect(calls.every((call) => call.method === "GET")).toBe(true);
	});
});
