import type {
	RecoveryPhaseV1,
	RecoveryRequestV1,
} from "cyrus-operator-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECOVERY_EVENTS } from "../../src/fleet-operations/RecoveryAudit.js";
import {
	RecoveryRequestError,
	RecoveryService,
	type RunReconciler,
} from "../../src/fleet-operations/RecoveryService.js";
import type { OperatorPrincipal } from "../../src/fleet-operations/types.js";
import { RouterStore } from "../../src/RouterStore.js";
import { eventsNamed, type TestLogger, testLogger } from "../helpers/logger.js";

const NOW = 1_700_000_000_000;
const WS_A = "workspace-a";
const WS_B = "workspace-b";

function principal(overrides: Partial<OperatorPrincipal> = {}) {
	return {
		id: "oid-recoverer",
		authKind: "entra",
		roles: new Set(["fleet.read", "fleet.recover"] as const),
		workspaceIds: new Set([WS_A]),
		...overrides,
	} as OperatorPrincipal;
}

function request(
	overrides: Partial<RecoveryRequestV1> = {},
): RecoveryRequestV1 {
	return {
		schemaVersion: 1,
		runId: "unset",
		expectedRevision: 1,
		idempotencyKey: "idem-key-0001",
		...overrides,
	};
}

/** A reconciler that reports the phases it is given and then settles. */
function scriptedReconciler(script: {
	phases?: Array<[RecoveryPhaseV1, unknown?]>;
	settle?: Awaited<ReturnType<RunReconciler["reconcile"]>>;
	throws?: Error;
}): RunReconciler & { calls: RecoveryRequestV1[] } {
	const calls: RecoveryRequestV1[] = [];
	return {
		calls,
		async reconcile(recoveryRequest, _caller, report) {
			calls.push(recoveryRequest);
			for (const [phase, evidence] of script.phases ?? []) {
				report(phase, evidence);
			}
			if (script.throws) throw script.throws;
			return script.settle ?? { phase: "recovered" };
		},
	};
}

describe("RecoveryService", () => {
	let store: RouterStore;
	let logger: TestLogger;
	let aliceUserId: number;
	let aliceDeviceId: number;
	let runId: string;

	beforeEach(() => {
		store = new RouterStore(":memory:");
		logger = testLogger();
		aliceUserId = store.addUser({ email: "alice@example.com" }).userId;
		aliceDeviceId = store.createContainerDevice(
			aliceUserId,
			"CYR-74",
			"aca",
		).deviceId;
		store.recordAgentRunRouted({
			deviceId: aliceDeviceId,
			issueKey: "CYR-74",
			issueId: "issue-74",
			sessionId: "s-74",
			routedMs: NOW - 60_000,
			routing: { workspaceId: WS_A, workspaceName: "Acme" },
			workerOnline: false,
		});
		runId =
			store.listFleetAgentRuns({ workspaceIds: [WS_A], limit: 1 })[0]?.runId ??
			"";
	});

	afterEach(() => {
		store.close();
	});

	function service(reconciler: RunReconciler, ids = idSequence()) {
		return new RecoveryService({
			store,
			reconciler,
			logger,
			now: () => NOW,
			newOperationId: ids,
		});
	}

	function idSequence() {
		let next = 0;
		return () => {
			next += 1;
			return `op-${next}`;
		};
	}

	const scope = { workspaceIds: [WS_A] };

	describe("accepting a request", () => {
		it("persists an accepted operation with the evidence it acted on", async () => {
			store.setSessionAffinity("s-74", aliceDeviceId, undefined, NOW - 50_000);
			store.acquireIssueLock("issue-74", "s-74", aliceDeviceId);
			const reconciler = scriptedReconciler({});
			const recoveries = service(reconciler);

			const accepted = recoveries.request(
				principal(),
				scope,
				request({ runId }),
			);

			expect(accepted.joined).toBe(false);
			expect(accepted.operation.phase).toBe("accepted");
			expect(accepted.operation.runId).toBe(runId);
			expect(accepted.operation.principalId).toBe("oid-recoverer");
			expect(accepted.operation.authMethod).toBe("entra");
			expect(accepted.operation.workspaceId).toBe(WS_A);
			// The evidence is what makes the audit trail mean something: an
			// operation that released a live pin and one that released nothing look
			// identical without it.
			expect(accepted.operation.evidenceBefore).toEqual({
				observedAt: new Date(NOW).toISOString(),
				revision: 1,
				lifecycle: "routed",
				workerOnline: false,
				sessionAffinityHeld: true,
				issueLocked: true,
			});
			await recoveries.whenIdle();
		});

		it("records no prompt text or activity content anywhere in the operation", async () => {
			const recoveries = service(scriptedReconciler({}));

			const { operation } = recoveries.request(
				principal(),
				scope,
				request({ runId, reason: "issue looks stuck" }),
			);

			// The evidence vocabulary is closed by construction — a revision, a
			// lifecycle, and three booleans — and this pins that it stays closed.
			expect(Object.keys(operation.evidenceBefore).sort()).toEqual([
				"issueLocked",
				"lifecycle",
				"observedAt",
				"revision",
				"sessionAffinityHeld",
				"workerOnline",
			]);
			await recoveries.whenIdle();
		});

		it("carries the sampled executor state of a container run", async () => {
			// The sample is itself a material change, so it moves the revision the
			// caller has to quote — which is the conditional-recovery contract
			// working, not an accident of the fixture.
			store.setRunExecutorState(aliceDeviceId, "stopped", NOW - 1_000);
			const current = store.listFleetAgentRuns({
				workspaceIds: [WS_A],
				limit: 1,
			})[0];
			const recoveries = service(scriptedReconciler({}));

			const { operation } = recoveries.request(
				principal(),
				scope,
				request({ runId, expectedRevision: current?.revision ?? 1 }),
			);

			expect(operation.evidenceBefore.executorState).toBe("stopped");
			expect(operation.evidenceBefore.revision).toBe(2);
			await recoveries.whenIdle();
		});
	});

	describe("refusing a request", () => {
		it("answers a run in another workspace exactly as it answers a run that does not exist", () => {
			const recoveries = service(scriptedReconciler({}));
			const outsider = principal({ workspaceIds: new Set([WS_B]) });

			const unauthorized = attempt(() =>
				recoveries.request(
					outsider,
					{ workspaceIds: [WS_B] },
					request({ runId }),
				),
			);
			const missing = attempt(() =>
				recoveries.request(
					principal(),
					scope,
					request({ runId: "no-such-run", idempotencyKey: "idem-key-0002" }),
				),
			);

			expect(unauthorized?.status).toBe(404);
			expect(unauthorized?.code).toBe("run_not_found");
			expect(missing?.status).toBe(404);
			expect(missing?.code).toBe("run_not_found");
			// Identical bodies: a caller must not be able to probe another
			// workspace's run ids for existence.
			expect(unauthorized?.message).toBe(missing?.message);
		});

		it("narrows an owner-scoped caller to its own runs", () => {
			const recoveries = service(scriptedReconciler({}));

			const refused = attempt(() =>
				recoveries.request(
					principal({ ownerUserId: aliceUserId + 999 }),
					{ workspaceIds: [WS_A], ownerScopeUserId: aliceUserId + 999 },
					request({ runId }),
				),
			);

			expect(refused?.status).toBe(404);
		});

		it("recovers a run the owner-scoped caller does own", async () => {
			const recoveries = service(scriptedReconciler({}));

			const accepted = recoveries.request(
				principal({ ownerUserId: aliceUserId }),
				{ workspaceIds: [WS_A], ownerScopeUserId: aliceUserId },
				request({ runId }),
			);

			expect(accepted.operation.ownerUserId).toBe(aliceUserId);
			await recoveries.whenIdle();
		});

		it("refuses a revision the run has already moved past, and says which", () => {
			store.setAgentRunState("s-74", "active", undefined, NOW - 30_000);
			const recoveries = service(scriptedReconciler({}));

			const refused = attempt(() =>
				recoveries.request(principal(), scope, request({ runId })),
			);

			expect(refused?.status).toBe(409);
			expect(refused?.code).toBe("stale_revision");
			expect(refused?.details).toMatchObject({ currentRevision: 2 });
		});

		it("refuses a run that has already ended", () => {
			store.finishAgentRun("s-74", "complete", NOW - 10_000);
			const current = store.listFleetAgentRuns({
				workspaceIds: [WS_A],
				limit: 1,
			})[0];
			const recoveries = service(scriptedReconciler({}));

			const refused = attempt(() =>
				recoveries.request(
					principal(),
					scope,
					request({ runId, expectedRevision: current?.revision ?? 1 }),
				),
			);

			expect(refused?.status).toBe(409);
			expect(refused?.code).toBe("run_already_terminal");
		});

		it("emits an audit event for a refusal that never became an operation", () => {
			const recoveries = service(scriptedReconciler({}));

			attempt(() =>
				recoveries.request(
					principal(),
					scope,
					request({ runId: "no-such-run" }),
				),
			);

			expect(eventsNamed(logger, RECOVERY_EVENTS.refused)[0]).toMatchObject({
				code: "run_not_found",
				status: 404,
				principal_id: "oid-recoverer",
			});
		});
	});

	describe("idempotency", () => {
		it("joins the operation an identical retry names", async () => {
			const reconciler = scriptedReconciler({});
			const recoveries = service(reconciler);
			const first = recoveries.request(principal(), scope, request({ runId }));
			await recoveries.whenIdle();

			const retry = recoveries.request(principal(), scope, request({ runId }));

			expect(retry.joined).toBe(true);
			expect(retry.operation.operationId).toBe(first.operation.operationId);
			// A join must not start a second reconciliation: two coordinators acting
			// on one run is exactly what the key exists to prevent.
			await recoveries.whenIdle();
			expect(reconciler.calls).toHaveLength(1);
		});

		it("joins a retry even after the run has moved on", async () => {
			const recoveries = service(scriptedReconciler({}));
			const first = recoveries.request(principal(), scope, request({ runId }));
			await recoveries.whenIdle();
			store.setAgentRunState("s-74", "active", undefined, NOW - 1_000);

			const retry = recoveries.request(principal(), scope, request({ runId }));

			// Checking the revision first would answer `stale_revision` to a retry of
			// a request that was accepted at that very revision — which is the one
			// case the key exists to make safe.
			expect(retry.joined).toBe(true);
			expect(retry.operation.operationId).toBe(first.operation.operationId);
		});

		it("refuses a key rebound to a different target", async () => {
			const recoveries = service(scriptedReconciler({}));
			recoveries.request(principal(), scope, request({ runId }));
			await recoveries.whenIdle();

			const conflict = attempt(() =>
				recoveries.request(
					principal(),
					scope,
					request({ runId: "some-other-run" }),
				),
			);

			expect(conflict?.status).toBe(409);
			expect(conflict?.code).toBe("idempotency_key_conflict");
		});
	});

	describe("driving the reconciler", () => {
		it("persists every phase it reports, in order", async () => {
			const recoveries = service(
				scriptedReconciler({
					phases: [
						["starting_executor"],
						["reconciling", "asked the worker to reconcile"],
						["replaying"],
					],
				}),
			);

			const { operation } = recoveries.request(
				principal(),
				scope,
				request({ runId }),
			);
			await recoveries.whenIdle();

			const settled = recoveries.get(scope, operation.operationId);
			expect(settled?.phases.map((phase) => phase.phase)).toEqual([
				"accepted",
				"starting_executor",
				"reconciling",
				"replaying",
				"recovered",
			]);
			expect(settled?.phases[2]?.detail).toBe("asked the worker to reconcile");
			expect(settled?.phase).toBe("recovered");
			expect(settled?.completedMs).toBe(NOW);
		});

		it("appends one recovery change to the run's feed per transition", async () => {
			const recoveries = service(
				scriptedReconciler({
					phases: [["starting_executor"], ["reconciling"]],
				}),
			);

			recoveries.request(principal(), scope, request({ runId }));
			await recoveries.whenIdle();

			const { changes } = store.listAgentRunChanges({
				limit: 50,
				workspaceIds: [WS_A],
			});
			// accepted + starting_executor + reconciling + recovered
			expect(
				changes.filter((change) => change.kind === "recovery"),
			).toHaveLength(4);
		});

		it("records the after-evidence a terminal outcome is judged on", async () => {
			store.setSessionAffinity("s-74", aliceDeviceId, undefined, NOW - 50_000);
			const recoveries = service({
				async reconcile(_request, _caller, report) {
					report("releasing_stale_ownership");
					store.clearSessionAffinity("s-74");
					return { phase: "recovered" };
				},
			});

			const { operation } = recoveries.request(
				principal(),
				scope,
				request({ runId }),
			);
			await recoveries.whenIdle();

			const settled = recoveries.get(scope, operation.operationId);
			expect(settled?.evidenceBefore.sessionAffinityHeld).toBe(true);
			expect(settled?.evidenceAfter).toBeDefined();
			expect(settled?.evidenceAfter?.observedAt).toBe(
				new Date(NOW).toISOString(),
			);
		});

		it("keeps a refusal the reconciler decided, with its reason", async () => {
			const recoveries = service(
				scriptedReconciler({
					settle: {
						phase: "refused",
						refusalReason: "worker_owns_active_work",
						detail: "the worker still owns active work",
					},
				}),
			);

			const { operation } = recoveries.request(
				principal(),
				scope,
				request({ runId }),
			);
			await recoveries.whenIdle();

			const settled = recoveries.get(scope, operation.operationId);
			expect(settled?.phase).toBe("refused");
			expect(settled?.refusalReason).toBe("worker_owns_active_work");
		});

		it("turns a thrown reconciler into a failed operation, not a lost one", async () => {
			const recoveries = service(
				scriptedReconciler({
					throws: new Error(
						"provider rejected Authorization: Bearer abc123secretvalue",
					),
				}),
			);

			const { operation } = recoveries.request(
				principal(),
				scope,
				request({ runId }),
			);
			await recoveries.whenIdle();

			const settled = recoveries.get(scope, operation.operationId);
			expect(settled?.phase).toBe("failed");
			expect(settled?.completedMs).toBe(NOW);
			// The message is a diagnostic that reaches a durable record and a log
			// backend, so credential material is stripped before it is stored.
			expect(settled?.failureMessage).not.toContain("abc123secretvalue");
			expect(settled?.failureMessage).toContain("[redacted]");
		});

		it("refuses a reconciler that reports a terminal phase instead of returning one", async () => {
			const recoveries = service({
				async reconcile(_request, _caller, report) {
					report("recovered");
					return { phase: "recovered" };
				},
			});

			const { operation } = recoveries.request(
				principal(),
				scope,
				request({ runId }),
			);
			await recoveries.whenIdle();

			// The outcome is the RETURN value; a terminal phase pushed through
			// `report` would settle the operation with no after-evidence and leave
			// the coordinator still running.
			expect(recoveries.get(scope, operation.operationId)?.phase).toBe(
				"failed",
			);
		});

		it("emits an audit event for the acceptance, each phase, and the outcome", async () => {
			const recoveries = service(
				scriptedReconciler({ phases: [["starting_executor"]] }),
			);

			recoveries.request(principal(), scope, request({ runId }));
			await recoveries.whenIdle();

			expect(eventsNamed(logger, RECOVERY_EVENTS.accepted)).toHaveLength(1);
			expect(eventsNamed(logger, RECOVERY_EVENTS.phaseChanged)).toHaveLength(1);
			expect(eventsNamed(logger, RECOVERY_EVENTS.settled)[0]).toMatchObject({
				phase: "recovered",
				operation_id: "op-1",
			});
		});
	});

	describe("reading an operation", () => {
		it("withholds an operation from a caller authorized over another workspace", async () => {
			const recoveries = service(scriptedReconciler({}));
			const { operation } = recoveries.request(
				principal(),
				scope,
				request({ runId }),
			);
			await recoveries.whenIdle();

			expect(
				recoveries.get({ workspaceIds: [WS_B] }, operation.operationId),
			).toBeUndefined();
			expect(recoveries.get(scope, "op-nonexistent")).toBeUndefined();
		});
	});

	describe("restart", () => {
		it("fails the operations a restart interrupted and audits each one", async () => {
			// A reconciler that never settles is exactly the shape a restart leaves
			// behind: an operation with nobody advancing it.
			const recoveries = service({
				reconcile: () => new Promise(() => {}),
			});
			const { operation } = recoveries.request(
				principal(),
				scope,
				request({ runId }),
			);

			const next = service(scriptedReconciler({}));
			next.failInterruptedOperations();

			const settled = next.get(scope, operation.operationId);
			expect(settled?.phase).toBe("failed");
			expect(settled?.failureMessage).toMatch(/restart/i);
			expect(eventsNamed(logger, RECOVERY_EVENTS.settled)[0]).toMatchObject({
				phase: "failed",
			});
		});
	});
});

/** Runs a call expected to refuse, and returns the refusal. */
function attempt(call: () => unknown): RecoveryRequestError | undefined {
	try {
		call();
	} catch (error) {
		if (error instanceof RecoveryRequestError) return error;
		throw error;
	}
	return undefined;
}
