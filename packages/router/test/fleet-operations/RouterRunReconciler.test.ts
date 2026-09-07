import type {
	RecoveryPhaseV1,
	RecoveryRequestV1,
} from "cyrus-operator-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecoveryService } from "../../src/fleet-operations/RecoveryService.js";
import { RouterRunReconciler } from "../../src/fleet-operations/RouterRunReconciler.js";
import type { OperatorPrincipal } from "../../src/fleet-operations/types.js";
import { RouterStore } from "../../src/RouterStore.js";
import { eventsNamed, type TestLogger, testLogger } from "../helpers/logger.js";

const NOW = 1_700_000_000_000;
const WS = "workspace-a";
const SESSION = "s-75";
const ISSUE_ID = "issue-75";
const ISSUE_KEY = "CYR-75";

function principal(overrides: Partial<OperatorPrincipal> = {}) {
	return {
		id: "oid-recoverer",
		authKind: "entra",
		roles: new Set(["fleet.read", "fleet.recover"] as const),
		workspaceIds: new Set([WS]),
		...overrides,
	} as OperatorPrincipal;
}

describe("RouterRunReconciler", () => {
	let store: RouterStore;
	let logger: TestLogger;
	let userId: number;
	let deviceId: number;
	let runId: string;

	/** Every phase the coordinator reported, in order. */
	let reported: RecoveryPhaseV1[];
	let details: Array<[RecoveryPhaseV1, unknown]>;

	/**
	 * The container executor seam, plus two operations recovery may NEVER reach
	 * for. `stop`/`destroy` are not on the interface at all — they are here so a
	 * test can prove the coordinator never grew a route to them.
	 */
	let executor: {
		boot: ReturnType<typeof vi.fn>;
		stop: ReturnType<typeof vi.fn>;
		destroy: ReturnType<typeof vi.fn>;
	};
	let worker: {
		isOnline: ReturnType<typeof vi.fn>;
		awaitOnline: ReturnType<typeof vi.fn>;
		querySessions: ReturnType<typeof vi.fn>;
	};
	/** Recovery correctness must never depend on anything reaching Linear. */
	let postActivity: ReturnType<typeof vi.fn>;
	let delays: number[];

	beforeEach(() => {
		store = new RouterStore(":memory:");
		logger = testLogger();
		reported = [];
		details = [];
		delays = [];
		postActivity = vi.fn(async () => {});
		executor = {
			boot: vi.fn(async () => ({ ok: true })),
			stop: vi.fn(async () => {}),
			destroy: vi.fn(async () => {}),
		};
		worker = {
			isOnline: vi.fn(() => false),
			awaitOnline: vi.fn(async () => true),
			querySessions: vi.fn(async () => [] as string[] | undefined),
		};
		userId = store.addUser({ email: "alice@example.com" }).userId;
		deviceId = store.createContainerDevice(userId, ISSUE_KEY, "aca").deviceId;
		routeRun();
	});

	afterEach(() => {
		store.close();
	});

	function routeRun(device = deviceId) {
		store.recordAgentRunRouted({
			deviceId: device,
			issueKey: ISSUE_KEY,
			issueId: ISSUE_ID,
			sessionId: SESSION,
			routedMs: NOW - 600_000,
			routing: { workspaceId: WS, workspaceName: "Acme" },
			workerOnline: false,
		});
		runId =
			store.listFleetAgentRuns({ workspaceIds: [WS], limit: 1 })[0]?.runId ??
			"";
	}

	/** The stranded shape: pinned affinity and a held issue lock. */
	function strand(device = deviceId) {
		store.setSessionAffinity(SESSION, device, undefined, NOW - 590_000);
		store.acquireIssueLock(ISSUE_ID, SESSION, device);
	}

	function reconciler(
		overrides: Partial<
			ConstructorParameters<typeof RouterRunReconciler>[0]
		> = {},
	) {
		return new RouterRunReconciler({
			store,
			worker,
			executor,
			logger,
			now: () => NOW,
			delay: async (ms: number) => {
				delays.push(ms);
			},
			timeouts: {
				reconnectMs: 90_000,
				sessionsQueryMs: 5_000,
				replayMs: 3_000,
			},
			...overrides,
		});
	}

	function request(
		overrides: Partial<RecoveryRequestV1> = {},
	): RecoveryRequestV1 {
		return {
			schemaVersion: 1,
			runId,
			expectedRevision: store.getAgentRunById(runId)?.revision ?? 1,
			idempotencyKey: "idem-key-0001",
			...overrides,
		};
	}

	function report(phase: RecoveryPhaseV1, evidence?: unknown) {
		reported.push(phase);
		details.push([phase, evidence]);
	}

	function run(overrides: Partial<RecoveryRequestV1> = {}) {
		return reconciler().reconcile(request(overrides), principal(), report);
	}

	/** Nothing about the run's ownership moved. */
	function expectOwnershipIntact() {
		expect(store.getSessionAffinity(SESSION)).toBe(deviceId);
		expect(store.getIssueLock(ISSUE_ID)).toMatchObject({ sessionId: SESSION });
		expect(store.getAgentRunById(runId)?.state).not.toBe("unknown");
		expect(store.getAgentRunById(runId)?.endedMs).toBeUndefined();
	}

	/** Recovery never terminates live work, destroys an executor, or posts. */
	function expectNoDestructiveCalls() {
		expect(executor.stop).not.toHaveBeenCalled();
		expect(executor.destroy).not.toHaveBeenCalled();
		expect(postActivity).not.toHaveBeenCalled();
	}

	describe("refusing without acting", () => {
		it("refuses a stale revision and touches nothing", async () => {
			strand();

			const result = await run({ expectedRevision: 99 });

			expect(result).toMatchObject({
				phase: "refused",
				refusalReason: "stale_revision",
			});
			expect(reported).toEqual([]);
			expect(executor.boot).not.toHaveBeenCalled();
			expectOwnershipIntact();
			expectNoDestructiveCalls();
		});

		it("refuses a run that ended between acceptance and reconciliation", async () => {
			strand();
			const stale = request();
			store.finishAgentRun(SESSION, "complete", NOW - 1_000);

			const result = await reconciler().reconcile(stale, principal(), report);

			expect(result).toMatchObject({
				phase: "refused",
				refusalReason: "run_already_terminal",
			});
			expect(executor.boot).not.toHaveBeenCalled();
			expect(store.getAgentRunById(runId)?.state).toBe("complete");
		});

		it("refuses while an online worker still owns the run", async () => {
			strand();
			worker.isOnline.mockReturnValue(true);

			const result = await run();

			expect(result).toMatchObject({
				phase: "refused",
				refusalReason: "worker_owns_active_work",
			});
			expect(executor.boot).not.toHaveBeenCalled();
			expect(worker.querySessions).not.toHaveBeenCalled();
			expectOwnershipIntact();
			expectNoDestructiveCalls();
		});

		it("refuses an offline physical device the router cannot start", async () => {
			// A physical device is a teammate's own machine. The router has no way
			// to power it on, so there is nothing recovery could reconcile against.
			const code = store.mintEnrollmentCode("alice@example.com", NOW);
			const physical = store.redeemEnrollmentCode(code, NOW);
			if (!physical) throw new Error("enrollment failed");
			store.recordAgentRunRouted({
				deviceId: physical.deviceId,
				issueKey: "CYR-77",
				issueId: "issue-77",
				sessionId: "s-77",
				routedMs: NOW - 400_000,
				routing: { workspaceId: WS, workspaceName: "Acme" },
				workerOnline: false,
			});
			const laptopRunId =
				store
					.listFleetAgentRuns({ workspaceIds: [WS], limit: 10 })
					.find((candidate) => candidate.sessionId === "s-77")?.runId ?? "";
			store.setSessionAffinity("s-77", physical.deviceId, undefined, NOW);
			store.acquireIssueLock("issue-77", "s-77", physical.deviceId);

			const result = await run({
				runId: laptopRunId,
				expectedRevision: store.getAgentRunById(laptopRunId)?.revision ?? 1,
			});

			expect(result).toMatchObject({
				phase: "refused",
				refusalReason: "executor_not_startable",
			});
			expect(reported).toEqual([]);
			expect(executor.boot).not.toHaveBeenCalled();
			expect(store.getSessionAffinity("s-77")).toBe(physical.deviceId);
			expect(store.getIssueLock("issue-77")).toBeDefined();
			expect(store.getAgentRunById(laptopRunId)?.state).toBe("routed");
			expectNoDestructiveCalls();
		});

		it("returns needs_input for a run waiting on an elicitation", async () => {
			strand();
			store.setAgentRunState(
				SESSION,
				"waiting",
				{ wait: { reason: "elicitation", sinceMs: NOW - 300_000 } },
				NOW - 300_000,
			);

			const result = await run();

			expect(result.phase).toBe("needs_input");
			expect(result.refusalReason).toBeUndefined();
			expect(reported).toEqual([]);
			expect(executor.boot).not.toHaveBeenCalled();
			expectOwnershipIntact();
			expectNoDestructiveCalls();
		});

		it("never releases ownership on any refusal or needs-input path", async () => {
			const releaseSpy = vi.spyOn(store, "releaseStaleRunOwnership");
			const affinitySpy = vi.spyOn(store, "clearSessionAffinity");
			const lockSpy = vi.spyOn(store, "releaseIssueLockForSession");
			const unknownSpy = vi.spyOn(store, "markAgentRunUnknown");
			strand();

			await run({ expectedRevision: 99 });
			worker.isOnline.mockReturnValue(true);
			await run();

			expect(releaseSpy).not.toHaveBeenCalled();
			expect(affinitySpy).not.toHaveBeenCalled();
			expect(lockSpy).not.toHaveBeenCalled();
			expect(unknownSpy).not.toHaveBeenCalled();
		});
	});

	describe("reconciling a parked container", () => {
		it("boots, awaits reconnect, reconciles, and releases stale ownership", async () => {
			strand();
			worker.querySessions.mockResolvedValue(["some-other-session"]);

			const result = await run();

			expect(executor.boot).toHaveBeenCalledWith(deviceId);
			expect(worker.awaitOnline).toHaveBeenCalledWith(deviceId, 90_000);
			expect(worker.querySessions).toHaveBeenCalledWith(deviceId, 5_000);
			// The replay window is awaited through the injected delay, so the test
			// costs no wall-clock time.
			expect(delays).toEqual([3_000]);
			expect(reported).toEqual([
				"starting_executor",
				"reconciling",
				"replaying",
				"releasing_stale_ownership",
			]);
			expect(result.phase).toBe("recovered");
			// Each phase carries the evidence it acted on, which becomes that
			// transition's detail on the persisted operation.
			expect(Object.fromEntries(details)).toMatchObject({
				starting_executor: { deviceId },
				releasing_stale_ownership: { deviceId, revision: 1 },
			});
			expect(store.getSessionAffinity(SESSION)).toBeUndefined();
			expect(store.getIssueLock(ISSUE_ID)).toBeUndefined();
			expect(store.getAgentRunById(runId)?.state).toBe("unknown");
			expect(store.getAgentRunById(runId)?.endedMs).toBe(NOW);
			expectNoDestructiveCalls();
		});

		it("records the release as a run.unknown event attributed to recovery", async () => {
			strand();
			worker.querySessions.mockResolvedValue([]);

			await run();

			const unknown = eventsNamed(logger, "run.unknown");
			expect(unknown).toHaveLength(1);
			expect(unknown[0]).toMatchObject({
				reason: "recovery_reconciled",
				run_id: runId,
				session_id: SESSION,
			});
		});

		it("preserves ownership when the reconnected worker claims the session", async () => {
			strand();
			worker.querySessions.mockResolvedValue([SESSION]);

			const result = await run();

			expect(result.phase).toBe("recovered");
			expect(reported).toEqual(["starting_executor", "reconciling"]);
			// It reached neither the replay window nor the release.
			expect(delays).toEqual([]);
			expectOwnershipIntact();
			expectNoDestructiveCalls();
		});

		it("releases the issue lock a mid-flight reconcile ended the run without", async () => {
			// `EventRouter.reconcileDeviceAffinity` — which this recovery's own boot
			// triggers, since the reconnect handshake runs it — ends the run and
			// clears affinity while deliberately leaving the ISSUE LOCK, and the
			// pass that would release the lock skips a device with undelivered
			// events. A run reading terminal with the issue still locked is exactly
			// the write-only issue recovery was called about, so "the run ended" is
			// not "the ownership is gone".
			strand();
			worker.querySessions.mockResolvedValue([]);
			const reconciling = reconciler({
				delay: async () => {
					store.markAgentRunUnknown(SESSION, NOW - 100);
					store.clearSessionAffinity(SESSION);
				},
			});

			const result = await reconciling.reconcile(
				request(),
				principal(),
				report,
			);

			expect(result.phase).toBe("recovered");
			expect(reported).toContain("releasing_stale_ownership");
			expect(store.getIssueLock(ISSUE_ID)).toBeUndefined();
			// The outcome the earlier reconcile recorded is left exactly as it was.
			expect(store.getAgentRunById(runId)?.state).toBe("unknown");
			expect(store.getAgentRunById(runId)?.endedMs).toBe(NOW - 100);
		});

		it("releases nothing when a replayed terminal frame lands during the wait", async () => {
			strand();
			worker.querySessions.mockResolvedValue([]);
			const finishing = reconciler({
				delay: async () => {
					// Stands in for the worker's durably buffered `session_state`
					// frame replaying while the coordinator waits for it.
					store.finishAgentRun(SESSION, "complete", NOW - 100);
					store.clearSessionAffinity(SESSION);
					store.releaseIssueLockForSession(SESSION);
				},
			});

			const result = await finishing.reconcile(request(), principal(), report);

			expect(result.phase).toBe("recovered");
			expect(reported).toEqual([
				"starting_executor",
				"reconciling",
				"replaying",
			]);
			// The worker's own outcome survives; `unknown` never overwrites it.
			expect(store.getAgentRunById(runId)?.state).toBe("complete");
		});
	});

	describe("failing without releasing ownership", () => {
		it("fails with the provider's own evidence when the boot fails", async () => {
			strand();
			executor.boot.mockResolvedValue({
				ok: false,
				detail: "sandbox quota exceeded",
			});

			const result = await run();

			expect(result.phase).toBe("failed");
			expect(result.failureMessage).toContain("sandbox quota exceeded");
			expect(reported).toEqual(["starting_executor"]);
			expect(worker.querySessions).not.toHaveBeenCalled();
			expectOwnershipIntact();
			expectNoDestructiveCalls();
		});

		it("fails when the worker never reconnects", async () => {
			strand();
			worker.awaitOnline.mockResolvedValue(false);

			const result = await run();

			expect(result.phase).toBe("failed");
			expect(result.failureMessage).toMatch(/reconnect/i);
			expect(reported).toEqual(["starting_executor"]);
			expect(worker.querySessions).not.toHaveBeenCalled();
			expectOwnershipIntact();
		});

		it("fails rather than releasing when the worker cannot say what it is running", async () => {
			// `undefined` is "can't tell", never "running nothing". Reading the two
			// the same way would let a silent worker license a release.
			strand();
			worker.querySessions.mockResolvedValue(undefined);

			const result = await run();

			expect(result.phase).toBe("failed");
			expect(result.failureMessage).toMatch(/did not report/i);
			expect(reported).toEqual(["starting_executor", "reconciling"]);
			expectOwnershipIntact();
		});

		it("fails when the router has no container executor configured", async () => {
			strand();

			const result = await reconciler({ executor: undefined }).reconcile(
				request(),
				principal(),
				report,
			);

			expect(result.phase).toBe("failed");
			expect(result.failureMessage).toMatch(/no container executor/i);
			expectOwnershipIntact();
		});

		it("fails when the run aged out mid-flight", async () => {
			strand();
			worker.querySessions.mockResolvedValue([]);
			const vanishing = reconciler({
				delay: async () => {
					store.finishAgentRun(SESSION, "complete", NOW - 100);
					store.sweepTerminalAgentRuns(NOW);
				},
			});

			const result = await vanishing.reconcile(request(), principal(), report);

			expect(result.phase).toBe("failed");
			expect(store.getAgentRunById(runId)).toBeUndefined();
		});
	});

	describe("losing to a concurrent change", () => {
		it("refuses when the run's revision moved while the container booted", async () => {
			strand();
			worker.querySessions.mockResolvedValue([]);
			const racing = reconciler({
				delay: async () => {
					// A material change — a worker activity — lands mid-flight.
					store.recordAgentRunActivity(SESSION, NOW - 50);
				},
			});

			const result = await racing.reconcile(request(), principal(), report);

			expect(result).toMatchObject({
				phase: "refused",
				refusalReason: "stale_revision",
			});
			expect(reported).toEqual([
				"starting_executor",
				"reconciling",
				"replaying",
			]);
			expectOwnershipIntact();
		});

		it("refuses when ownership moved to a different device mid-flight", async () => {
			strand();
			worker.querySessions.mockResolvedValue([]);
			const otherDeviceId = store.createContainerDevice(
				userId,
				"CYR-76",
				"aca",
			).deviceId;
			const racing = reconciler({
				delay: async () => {
					store.setSessionAffinity(SESSION, otherDeviceId, undefined, NOW);
				},
			});

			const result = await racing.reconcile(request(), principal(), report);

			expect(result).toMatchObject({
				phase: "refused",
				refusalReason: "worker_owns_active_work",
			});
			expect(store.getSessionAffinity(SESSION)).toBe(otherDeviceId);
			expect(store.getIssueLock(ISSUE_ID)).toBeDefined();
		});

		it("lets only the first of two concurrent operations release ownership", async () => {
			const releaseSpy = vi.spyOn(store, "releaseStaleRunOwnership");
			strand();
			worker.querySessions.mockResolvedValue([]);
			const shared = request();
			const secondPhases: RecoveryPhaseV1[] = [];

			const [first, second] = await Promise.all([
				reconciler().reconcile(shared, principal(), report),
				reconciler().reconcile(shared, principal(), (phase) => {
					secondPhases.push(phase);
				}),
			]);

			// Both are `recovered` — the loser's goal was already met — but only one
			// of them touched anything.
			expect([first.phase, second.phase]).toEqual(["recovered", "recovered"]);
			expect(releaseSpy).toHaveBeenCalledTimes(1);
			const announced = [...reported, ...secondPhases].filter(
				(phase) => phase === "releasing_stale_ownership",
			);
			expect(announced).toHaveLength(1);
			expect(eventsNamed(logger, "run.unknown")).toHaveLength(1);
			// The run ended exactly once, with one release behind it.
			expect(store.getAgentRunById(runId)?.state).toBe("unknown");
			expect(store.getAgentRunById(runId)?.endedMs).toBe(NOW);
			expect(store.getSessionAffinity(SESSION)).toBeUndefined();
			expect(store.getIssueLock(ISSUE_ID)).toBeUndefined();
		});
	});

	describe("wired behind the recovery resource", () => {
		function service(reconcilerInstance = reconciler()) {
			return new RecoveryService({
				store,
				reconciler: reconcilerInstance,
				logger,
				now: () => NOW,
			});
		}

		it("drives a real recovery from accepted through to recovered", async () => {
			strand();
			worker.querySessions.mockResolvedValue([]);
			const recoveries = service();

			const accepted = recoveries.request(
				principal(),
				{ workspaceIds: [WS] },
				request(),
			);
			await recoveries.whenIdle();

			const settled = recoveries.get(
				{ workspaceIds: [WS] },
				accepted.operation.operationId,
			);
			expect(settled?.phase).toBe("recovered");
			expect(settled?.phases.map((entry) => entry.phase)).toEqual([
				"accepted",
				"starting_executor",
				"reconciling",
				"replaying",
				"releasing_stale_ownership",
				"recovered",
			]);
			// The evidence pair is what makes the audit mean something: a released
			// pin and a no-op look identical without it.
			expect(settled?.evidenceBefore).toMatchObject({
				sessionAffinityHeld: true,
				issueLocked: true,
				lifecycle: "routed",
			});
			expect(settled?.evidenceAfter).toMatchObject({
				sessionAffinityHeld: false,
				issueLocked: false,
				lifecycle: "unknown",
			});
		});

		it("fails an operation the previous process left in flight", async () => {
			strand();
			// A coordinator that never settles — the shape a router restart leaves
			// behind, since operations are driven by an in-memory coordinator.
			const recoveries = service({
				reconcile: () => new Promise(() => {}),
			});
			const accepted = recoveries.request(
				principal(),
				{ workspaceIds: [WS] },
				request(),
			);

			recoveries.failInterruptedOperations();

			const settled = recoveries.get(
				{ workspaceIds: [WS] },
				accepted.operation.operationId,
			);
			expect(settled?.phase).toBe("failed");
			expect(settled?.failureMessage).toMatch(/restarted/i);
			// A restart must not be able to release ownership on the way past.
			expectOwnershipIntact();
		});
	});
});
