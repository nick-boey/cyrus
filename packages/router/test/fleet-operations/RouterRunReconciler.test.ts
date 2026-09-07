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
/**
 * When the stranded session was routed and claimed. Well outside
 * `ownershipGraceMs` below, because a claim younger than that is deliberately
 * NOT one a reconnected worker may disown — see the "not yet authoritative"
 * tests.
 */
const ROUTED_MS = NOW - 3_600_000;
const OWNERSHIP_GRACE_MS = 600_000;
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
	/** Stands in for `EventRouter.forgetSessionOwnership`. */
	let forgetOwnership: ReturnType<typeof vi.fn>;
	let delays: number[];

	beforeEach(() => {
		store = new RouterStore(":memory:");
		logger = testLogger();
		reported = [];
		details = [];
		delays = [];
		postActivity = vi.fn(async () => {});
		forgetOwnership = vi.fn();
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
			routedMs: ROUTED_MS,
			routing: { workspaceId: WS, workspaceName: "Acme" },
			workerOnline: false,
		});
		runId =
			store.listFleetAgentRuns({ workspaceIds: [WS], limit: 1 })[0]?.runId ??
			"";
	}

	/**
	 * The stranded shape: pinned affinity and a held issue lock, both claimed
	 * long enough ago to be outside the grace a freshly routed session gets.
	 */
	function strand(device = deviceId) {
		store.setSessionAffinity(SESSION, device, undefined, ROUTED_MS);
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
				ownershipGraceMs: OWNERSHIP_GRACE_MS,
			},
			forgetOwnership,
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

		it("does not refuse itself when its own reconnect bumps the revision", async () => {
			// `worker_online` is a MATERIAL column and `DeviceGateway.handleHello`
			// writes connectivity before it emits the event `awaitOnline` resolves
			// on — so the offline→online transition guard 4 REQUIRES is guaranteed
			// to move the revision. A coordinator that compared the raw revision
			// across its own boot would answer `stale_revision` every time, on the
			// one path the whole feature exists for.
			strand();
			worker.querySessions.mockResolvedValue([]);
			worker.awaitOnline.mockImplementation(async () => {
				store.setRunWorkerConnectivity(deviceId, true, NOW);
				return true;
			});
			const before = store.getAgentRunById(runId)?.revision ?? 0;

			const result = await run();

			expect(store.getAgentRunById(runId)?.revision).toBeGreaterThan(before);
			expect(result.phase).toBe("recovered");
			expect(reported).toContain("releasing_stale_ownership");
			expect(store.getSessionAffinity(SESSION)).toBeUndefined();
			expect(store.getIssueLock(ISSUE_ID)).toBeUndefined();
			expect(store.getAgentRunById(runId)?.state).toBe("unknown");
		});

		it("still refuses when a fact the run OWNS moves during the reconnect", async () => {
			// The counterpart to the test above: the evidence columns are excluded,
			// nothing else is. A worker publishing an activity mid-flight is a
			// concurrent actor and must still win.
			strand();
			worker.querySessions.mockResolvedValue([]);
			worker.awaitOnline.mockImplementation(async () => {
				store.setRunWorkerConnectivity(deviceId, true, NOW);
				store.recordAgentRunActivity(SESSION, NOW - 10);
				return true;
			});

			const result = await run();

			expect(result).toMatchObject({
				phase: "refused",
				refusalReason: "stale_revision",
			});
			expectOwnershipIntact();
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

		it("refuses when the session started a new run during the replay window", async () => {
			// The user whose comment was rejected at the lock replies in-thread —
			// the documented recovery for a lock rejection — the moment recovery's
			// own boot frees the issue. `routePrompted` re-establishes affinity and
			// the lock and starts a NEW run, on the SAME device. The ownership
			// tables are keyed by session, so device scoping cannot tell the two
			// runs apart and a release here would strip live work.
			strand();
			worker.querySessions.mockResolvedValue([]);
			const reprompted = reconciler({
				delay: async () => {
					store.markAgentRunUnknown(SESSION, NOW - 200);
					store.recordAgentRunRouted({
						deviceId,
						issueKey: ISSUE_KEY,
						issueId: ISSUE_ID,
						sessionId: SESSION,
						routedMs: NOW - 100,
						routing: { workspaceId: WS },
					});
					store.setSessionAffinity(SESSION, deviceId, undefined, NOW - 100);
				},
			});

			const result = await reprompted.reconcile(request(), principal(), report);

			expect(result).toMatchObject({
				phase: "refused",
				refusalReason: "worker_owns_active_work",
			});
			// The successor keeps everything it needs to run: without affinity the
			// idle sweep parks its container mid-work, and without the lock a
			// second session can claim the issue.
			expect(store.getSessionAffinity(SESSION)).toBe(deviceId);
			expect(store.getIssueLock(ISSUE_ID)).toMatchObject({
				sessionId: SESSION,
			});
			expect(forgetOwnership).not.toHaveBeenCalled();
		});

		it("retires the router's in-memory park record for a released session", async () => {
			// `parkedSessionCreators` is the only thing the `active` branch consults
			// before writing full affinity, so a late frame from the disproved
			// device would re-pin a run that is now `unknown` and can never end
			// again — PAR-146's permanent pin by a new route.
			strand();
			worker.querySessions.mockResolvedValue([]);

			await run();

			expect(forgetOwnership).toHaveBeenCalledWith(SESSION, deviceId);
		});

		it("still reports the release when recording it throws", async () => {
			// Everything after the durable write is bookkeeping. Letting it decide
			// the outcome would settle the operation `failed` over a release that
			// did happen — an audit that is worse than no audit.
			strand();
			worker.querySessions.mockResolvedValue([]);
			forgetOwnership.mockImplementation(() => {
				throw new Error("event router exploded");
			});

			const result = await run();

			expect(result.phase).toBe("recovered");
			expect(store.getSessionAffinity(SESSION)).toBeUndefined();
			expect(store.getIssueLock(ISSUE_ID)).toBeUndefined();
		});

		it("releases the ownership grace a parked session left behind", async () => {
			// A park releases affinity, keeps the issue lock, AND grants a 24h
			// ownership grace. `getSessionOwner` consults all three, so a release
			// that leaves the grace keeps the disproved device owning the session.
			store.acquireIssueLock(ISSUE_ID, SESSION, deviceId);
			store.grantSessionOwnershipGrace(SESSION, deviceId, NOW + 86_400_000);
			worker.querySessions.mockResolvedValue([]);

			const result = await run();

			expect(result.phase).toBe("recovered");
			expect(store.getSessionOwner(SESSION, NOW)).toBeUndefined();
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

		it("fails rather than releasing while the device still has undelivered events", async () => {
			// `deviceConnected` — what `awaitOnline` resolves on — is emitted one
			// line before `deliverPending`, so a cold-booted worker truthfully
			// answers "running nothing" about a session whose event it has not yet
			// been handed. Releasing there is CYR-81: the event still lands, the
			// session runs disowned, and the idle sweep suspends its sandbox
			// mid-work.
			strand();
			worker.querySessions.mockResolvedValue([]);
			store.enqueueEvent(
				deviceId,
				JSON.stringify({ kind: "test" }),
				NOW,
				3_600_000,
			);

			const result = await run();

			expect(result.phase).toBe("failed");
			expect(result.failureMessage).toMatch(/undelivered events/);
			expect(worker.querySessions).not.toHaveBeenCalled();
			expectOwnershipIntact();
		});

		it("fails rather than releasing a session claimed inside the grace", async () => {
			// The same window `reconcileDeviceAffinity` applies to an affinity row:
			// a session claimed moments ago has its runner still starting, so its
			// absence from the worker's list means nothing.
			strand();
			store.setSessionAffinity(SESSION, deviceId, undefined, NOW - 1_000);
			worker.querySessions.mockResolvedValue([]);

			const result = await run({
				expectedRevision: store.getAgentRunById(runId)?.revision ?? 1,
			});

			expect(result.phase).toBe("failed");
			expect(result.failureMessage).toMatch(/claimed 1000ms ago/);
			expect(worker.querySessions).not.toHaveBeenCalled();
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
