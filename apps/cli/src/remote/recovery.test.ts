import type {
	RecoveryEvidenceV1,
	RecoveryOperationV1,
	RecoveryPhaseTransitionV1,
	RecoveryPhaseV1,
	RecoveryRequestV1,
	RunLifecycleStateV1,
	RunObservationPageV1,
	RunObservationV1,
} from "cyrus-operator-protocol";
import { recoveryOperationV1Schema } from "cyrus-operator-protocol";
import { describe, expect, it, vi } from "vitest";
import {
	AuthorizationError,
	OutcomeError,
	TransientError,
	UsageError,
} from "./errors.js";
import { ExitCode } from "./exitCodes.js";
import {
	emitNewPhases,
	followRecoveryOperation,
	generateIdempotencyKey,
	type RecoveryClient,
	resolveRecoveryTarget,
} from "./recovery.js";

/* ------------------------------------------------------------- fixtures */

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
		// A waiting run must carry the wait its worker reported; the schema
		// refuses one without it.
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

/**
 * A valid operation whose phase history really does end at its current phase —
 * the schema refuses anything else, so a fixture that cut a corner here would
 * fail against the real router rather than in this file.
 */
function operation(input: {
	phases: RecoveryPhaseV1[];
	operationId?: string;
	runId?: string;
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
	const document = {
		schemaVersion: 1,
		operationId: input.operationId ?? "op-1",
		runId: input.runId ?? "run-1",
		idempotencyKey: "cyrec_0123456789abcdef",
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
	};
	// Parsed rather than cast, so a fixture that drifts from the contract fails
	// here instead of teaching the tests a shape the router cannot produce.
	return recoveryOperationV1Schema.parse(document);
}

/** A client that records what the workflow asked the router to do. */
function client(handlers: {
	listRuns?: (query: Record<string, string>) => RunObservationPageV1;
	requestRecovery?: (
		request: RecoveryRequestV1,
	) => { operation: RecoveryOperationV1; joined: boolean } | Promise<never>;
	getRecovery?: (
		operationId: string,
		call: number,
	) => RecoveryOperationV1 | Promise<never>;
}): RecoveryClient & { listCalls: Record<string, string>[]; polls: number } {
	let polls = 0;
	const listCalls: Record<string, string>[] = [];
	const recovery: RecoveryClient = {
		listRuns: async (query = {}) => {
			listCalls.push(query);
			if (!handlers.listRuns) throw new Error("listRuns was not expected");
			return handlers.listRuns(query);
		},
		requestRecovery: async (request) => {
			if (!handlers.requestRecovery) {
				throw new Error("requestRecovery was not expected");
			}
			return handlers.requestRecovery(request);
		},
		getRecovery: async (operationId) => {
			if (!handlers.getRecovery) {
				throw new Error("getRecovery was not expected");
			}
			return handlers.getRecovery(operationId, polls++);
		},
	};
	// `defineProperty` rather than `Object.assign`, which would copy the getter's
	// value at assignment time (always zero) instead of the getter itself.
	Object.defineProperty(recovery, "polls", { get: () => polls });
	return Object.assign(recovery, { listCalls }) as RecoveryClient & {
		listCalls: Record<string, string>[];
		polls: number;
	};
}

/* ------------------------------------------------------- idempotency key */

describe("generateIdempotencyKey", () => {
	it("produces a key the wire contract accepts", () => {
		const key = generateIdempotencyKey(
			() => "0198e2a0-1111-7000-8000-abcdef012345",
		);
		expect(key.length).toBeGreaterThanOrEqual(8);
		expect(key.length).toBeLessThanOrEqual(200);
		expect(key).toContain("0198e2a0-1111-7000-8000-abcdef012345");
	});

	it("is different on every invocation", () => {
		expect(generateIdempotencyKey()).not.toEqual(generateIdempotencyKey());
	});
});

/* ------------------------------------------------------ target resolution */

describe("resolveRecoveryTarget — run id", () => {
	it("quotes an explicit revision without reading anything", async () => {
		const router = client({});
		const target = await resolveRecoveryTarget(router, {
			workspaceId: "ws-1",
			runId: "run-1",
			expectedRevision: 4,
		});
		expect(target).toEqual({ runId: "run-1", expectedRevision: 4 });
		expect(router.listCalls).toEqual([]);
	});

	it("fetches a fresh observation when no revision was quoted", async () => {
		const router = client({
			listRuns: () => page([observation({ revision: 9 })]),
		});
		const target = await resolveRecoveryTarget(router, {
			workspaceId: "ws-1",
			runId: "run-1",
		});
		expect(target.runId).toBe("run-1");
		expect(target.expectedRevision).toBe(9);
		expect(router.listCalls).toEqual([{ workspace: "ws-1", runId: "run-1" }]);
	});

	it("refuses a run id the connection cannot see", async () => {
		const router = client({ listRuns: () => page([]) });
		await expect(
			resolveRecoveryTarget(router, { workspaceId: "ws-1", runId: "run-9" }),
		).rejects.toBeInstanceOf(UsageError);
	});

	it("refuses when neither a run id nor an issue was named", async () => {
		await expect(
			resolveRecoveryTarget(client({}), { workspaceId: "ws-1" }),
		).rejects.toBeInstanceOf(UsageError);
	});

	it("refuses a run id and an issue together", async () => {
		await expect(
			resolveRecoveryTarget(client({}), {
				workspaceId: "ws-1",
				runId: "run-1",
				issue: "NOR-402",
			}),
		).rejects.toBeInstanceOf(UsageError);
	});
});

describe("resolveRecoveryTarget — issue key", () => {
	it("acts only when exactly one non-terminal run matches", async () => {
		const router = client({
			listRuns: () =>
				page([
					observation({ runId: "run-old", lifecycle: "complete" }),
					observation({
						runId: "run-live",
						lifecycle: "waiting",
						revision: 12,
					}),
				]),
		});
		const target = await resolveRecoveryTarget(router, {
			workspaceId: "ws-1",
			issue: "NOR-402",
		});
		expect(target.runId).toBe("run-live");
		expect(target.expectedRevision).toBe(12);
		expect(router.listCalls).toEqual([
			{ workspace: "ws-1", issueKey: "NOR-402" },
		]);
	});

	it("queries by issue id when the value is not a Linear identifier", async () => {
		const uuid = "11111111-2222-3333-4444-555555555555";
		const router = client({ listRuns: () => page([observation()]) });
		await resolveRecoveryTarget(router, { workspaceId: "ws-1", issue: uuid });
		expect(router.listCalls).toEqual([{ workspace: "ws-1", issueId: uuid }]);
	});

	it("refuses with exit 2 when no non-terminal run matches, and mutates nothing", async () => {
		const router = client({
			listRuns: () => page([observation({ lifecycle: "complete" })]),
		});
		const error = await resolveRecoveryTarget(router, {
			workspaceId: "ws-1",
			issue: "NOR-402",
		}).catch((thrown) => thrown);
		expect(error).toBeInstanceOf(UsageError);
		expect((error as UsageError).exitCode).toBe(ExitCode.usage);
	});

	it("refuses with the candidate run ids and revisions when more than one matches", async () => {
		const router = client({
			listRuns: () =>
				page([
					observation({ runId: "run-a", lifecycle: "active", revision: 3 }),
					observation({ runId: "run-b", lifecycle: "waiting", revision: 5 }),
				]),
		});
		const error = await resolveRecoveryTarget(router, {
			workspaceId: "ws-1",
			issue: "NOR-402",
		}).catch((thrown) => thrown);
		expect(error).toBeInstanceOf(UsageError);
		const message = (error as UsageError).message;
		expect(message).toContain("run-a");
		expect(message).toContain("run-b");
		// The revisions matter: they are what a caller quotes on the retry that
		// picks one, so a candidate list without them costs a second round trip.
		expect(message).toContain("3");
		expect(message).toContain("5");
	});

	it("reads every page before deciding the match is unique", async () => {
		const pages = [
			page([observation({ runId: "run-a" })], "v1.runs.cGFnZS0y"),
			page([observation({ runId: "run-b" })]),
		];
		const router = client({
			listRuns: () => pages.shift() as RunObservationPageV1,
		});
		await expect(
			resolveRecoveryTarget(router, { workspaceId: "ws-1", issue: "NOR-402" }),
		).rejects.toBeInstanceOf(UsageError);
		expect(router.listCalls).toHaveLength(2);
	});
});

/* --------------------------------------------------------- phase emission */

describe("emitNewPhases", () => {
	it("emits only the transitions not already reported", () => {
		const seen: RecoveryPhaseV1[] = [];
		const first = operation({ phases: ["accepted", "starting_executor"] });
		const emitted = emitNewPhases(first, 0, (transition) =>
			seen.push(transition.phase),
		);
		expect(emitted).toBe(2);
		expect(seen).toEqual(["accepted", "starting_executor"]);

		const later = operation({
			phases: ["accepted", "starting_executor", "reconciling", "replaying"],
		});
		expect(emitNewPhases(later, emitted, (t) => seen.push(t.phase))).toBe(4);
		expect(seen).toEqual([
			"accepted",
			"starting_executor",
			"reconciling",
			"replaying",
		]);
	});
});

/* ------------------------------------------------------------- following */

describe("followRecoveryOperation", () => {
	const follow = (
		router: RecoveryClient,
		seed: RecoveryOperationV1,
		overrides: Record<string, unknown> = {},
	) => {
		const phases: RecoveryPhaseV1[] = [];
		let clock = 0;
		return {
			phases,
			result: followRecoveryOperation(router, {
				operation: seed,
				onPhase: (transition) => phases.push(transition.phase),
				now: () => {
					clock += 1_000;
					return clock;
				},
				sleep: async () => {},
				intervalMs: 10,
				timeoutMs: 60_000,
				...overrides,
			}),
		};
	};

	it("reports every phase the operation passed through, including ones between polls", async () => {
		const answers = [
			operation({ phases: ["accepted", "starting_executor"] }),
			// Two transitions landed between polls; both must still be reported.
			operation({
				phases: [
					"accepted",
					"starting_executor",
					"reconciling",
					"replaying",
					"releasing_stale_ownership",
				],
			}),
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
		const router = client({
			getRecovery: (_id, call) => answers[call] as RecoveryOperationV1,
		});
		const followed = follow(router, operation({ phases: ["accepted"] }));
		const { operation: final, timedOut } = await followed.result;

		expect(timedOut).toBe(false);
		expect(final.phase).toBe("recovered");
		expect(followed.phases).toEqual([
			"accepted",
			"starting_executor",
			"reconciling",
			"replaying",
			"releasing_stale_ownership",
			"recovered",
		]);
	});

	it.each(["recovered", "needs_input", "refused", "failed"] as const)(
		"stops polling at the terminal phase %s",
		async (phase) => {
			const router = client({
				getRecovery: () =>
					operation({
						phases: ["accepted", phase],
						...(phase === "refused"
							? { refusalReason: "worker_owns_active_work" as const }
							: {}),
						...(phase === "failed"
							? { failure: { message: "the executor never came back" } }
							: {}),
					}),
			});
			const followed = follow(router, operation({ phases: ["accepted"] }));
			const { operation: final, timedOut } = await followed.result;
			expect(final.phase).toBe(phase);
			expect(timedOut).toBe(false);
			expect(router.polls).toBe(1);
		},
	);

	it("does not poll at all when the seeded operation is already terminal", async () => {
		const router = client({});
		const followed = follow(
			router,
			operation({ phases: ["accepted", "recovered"] }),
		);
		const { operation: final } = await followed.result;
		expect(final.phase).toBe("recovered");
		expect(followed.phases).toEqual(["accepted", "recovered"]);
	});

	it("keeps polling through a transient router failure", async () => {
		const router = client({
			getRecovery: (_id, call) => {
				if (call === 0) {
					return Promise.reject(
						new TransientError("router.example.com failed (503)"),
					);
				}
				return operation({ phases: ["accepted", "recovered"] });
			},
		});
		const followed = follow(router, operation({ phases: ["accepted"] }));
		const { operation: final } = await followed.result;
		expect(final.phase).toBe("recovered");
		expect(router.polls).toBe(2);
	});

	it("gives up as transient once the router keeps failing", async () => {
		const router = client({
			getRecovery: () =>
				Promise.reject(new TransientError("router.example.com failed (503)")),
		});
		const followed = follow(router, operation({ phases: ["accepted"] }));
		await expect(followed.result).rejects.toBeInstanceOf(TransientError);
	});

	it("stops at once on an authorization failure rather than retrying", async () => {
		const router = client({
			getRecovery: () =>
				Promise.reject(new AuthorizationError("the router refused (403)")),
		});
		const followed = follow(router, operation({ phases: ["accepted"] }));
		await expect(followed.result).rejects.toBeInstanceOf(AuthorizationError);
		expect(router.polls).toBe(1);
	});

	it("reports a timeout as its own condition rather than as an outcome", async () => {
		const router = client({
			getRecovery: () => operation({ phases: ["accepted", "reconciling"] }),
		});
		const followed = follow(router, operation({ phases: ["accepted"] }), {
			// The injected clock advances 1s per read, so this expires immediately.
			timeoutMs: 1,
		});
		const { operation: final, timedOut } = await followed.result;
		expect(timedOut).toBe(true);
		// The operation is returned regardless: a caller must be able to say WHICH
		// operation it stopped watching, so `recover status` can resume it.
		expect(final.operationId).toBe("op-1");
		// Never converted into an OutcomeError here — that distinction is the whole
		// reason exit 4 exists separately from exit 3.
		expect(final.phase).not.toBe("failed");
	});

	it("sleeps between polls rather than spinning", async () => {
		const sleep = vi.fn(async () => {});
		const answers = [
			operation({ phases: ["accepted"] }),
			operation({ phases: ["accepted", "recovered"] }),
		];
		const router = client({
			getRecovery: (_id, call) => answers[call] as RecoveryOperationV1,
		});
		await follow(router, operation({ phases: ["accepted"] }), { sleep }).result;
		expect(sleep).toHaveBeenCalledWith(10);
	});
});

/* --------------------------------------------------- what it cannot reach */

describe("the recovery workflow's seam", () => {
	it("asks the router for nothing but observations and the recovery resource", async () => {
		// `RecoveryClient` is the whole surface the workflow can reach. A structural
		// assertion rather than a comment: if a later change gives the workflow a
		// way to stop, destroy, unlock, or comment, it has to widen this type first.
		const surface: RecoveryClient = {
			listRuns: async () => page([]),
			requestRecovery: async () => ({
				operation: operation({ phases: ["accepted"] }),
				joined: false,
			}),
			getRecovery: async () => operation({ phases: ["accepted", "recovered"] }),
		};
		expect(Object.keys(surface).sort()).toEqual([
			"getRecovery",
			"listRuns",
			"requestRecovery",
		]);
	});

	it("never converts a refusal into a usage error", async () => {
		// A refused recovery is a valid answer the router gave deliberately, so it
		// belongs to the `outcome` category and not to `usage`.
		const refused = new OutcomeError("refused");
		expect(refused.exitCode).toBe(ExitCode.outcome);
	});
});
