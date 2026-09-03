/**
 * NOR-405 — session-scoped RPC authorization across the park and terminal
 * windows.
 *
 * These tests wire a real {@link EventRouter} and a real {@link LinearExecutor}
 * over ONE {@link RouterStore}, because the bug lived precisely in the seam
 * between them: the router released the ownership record, the executor read it,
 * and neither half was wrong on its own. A unit test of either side alone would
 * have passed throughout.
 *
 * The failure being regressed: a worker that parks, or that posts its closing
 * summary as it goes terminal, had every activity rejected with "session not
 * owned by this device" and silently dropped — 161 lost posts in one day, with
 * nothing in the router's own logs to show for it.
 */
import {
	type AgentEvent,
	createLogger,
	type IIssueTrackerService,
	type ILogger,
	installRecordingLogSink,
	LogLevel,
} from "cyrus-core";
import type { RpcRequestFrame } from "cyrus-router-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	EventRouter,
	PARK_OWNERSHIP_GRACE_MS,
	TERMINAL_OWNERSHIP_GRACE_MS,
} from "../src/EventRouter.js";
import { LinearExecutor } from "../src/LinearExecutor.js";
import { RouterStore } from "../src/RouterStore.js";
import { silentLogger } from "./helpers/logger.js";

const WS = "ws-1";
const ISSUE_ID = "ISS-1";
const SESSION = "sess-1";

const ALICE = {
	id: "lin-alice",
	email: "alice@example.com",
	name: "Alice",
};

function createdEvent(): AgentEvent {
	return {
		type: "AgentSessionEvent",
		action: "created",
		organizationId: WS,
		agentSession: {
			id: SESSION,
			organizationId: WS,
			issueId: ISSUE_ID,
			issue: { id: ISSUE_ID, identifier: "PAR-275" },
			creator: ALICE,
		},
	} as unknown as AgentEvent;
}

/** The frame a worker sends to post an activity onto its Linear session. */
function activityFrame(sessionId = SESSION): RpcRequestFrame {
	return {
		type: "rpc_request",
		id: "req-1",
		method: "createAgentActivity",
		params: [
			WS,
			{
				agentSessionId: sessionId,
				content: { type: "thought", body: "still here" },
			},
		],
	};
}

interface Harness {
	store: RouterStore;
	router: EventRouter;
	executor: LinearExecutor;
	createAgentActivity: ReturnType<typeof vi.fn>;
	deviceId: number;
	clock: { value: number };
}

function makeHarness(opts?: {
	executorLogger?: ILogger;
	routerLogger?: ILogger;
	/** Deployments can turn issue locking off; the park window must survive it. */
	issueLock?: boolean;
}): Harness {
	const store = new RouterStore(":memory:");
	store.addUser({ email: ALICE.email, linearId: ALICE.id });
	const code = store.mintEnrollmentCode(ALICE.email, 1);
	const device = store.redeemEnrollmentCode(code, 1);
	if (!device) throw new Error("enroll failed");

	// Wall-clock-based, not an arbitrary small number: the grace expiry is
	// stamped from the router's injected clock but READ against `Date.now()` in
	// the store, exactly as in production where the two are the same clock. A
	// synthetic epoch here would make every granted grace look already-expired
	// and quietly turn the terminal-window test green for the wrong reason.
	const clock = { value: Date.now() };
	const router = new EventRouter({
		store,
		gateway: { isOnline: () => true, deliverPending: vi.fn() },
		postActivity: vi.fn(async () => {}),
		moveIssueToStartedState: vi.fn(async () => "In Progress"),
		config: {
			eventTtlMs: 60_000,
			issueLock: opts?.issueLock ?? true,
			creatorOnlyPrompting: false,
			affinityGraceMs: 600_000,
		},
		logger: opts?.routerLogger ?? silentLogger(),
		now: () => clock.value,
	});

	const createAgentActivity = vi.fn(async () => ({ success: true }));
	const executor = new LinearExecutor({
		trackers: new Map<string, IIssueTrackerService>([
			[WS, { createAgentActivity } as unknown as IIssueTrackerService],
		]),
		store,
		...(opts?.executorLogger ? { logger: opts.executorLogger } : {}),
	});

	return {
		store,
		router,
		executor,
		createAgentActivity,
		deviceId: device.deviceId,
		clock,
	};
}

describe("session-scoped RPC authorization (NOR-405)", () => {
	let h: Harness;

	beforeEach(async () => {
		h = makeHarness();
		await h.router.route(createdEvent());
	});

	it("accepts an activity posted while the session is parked", async () => {
		h.router.handleSessionState(h.deviceId, {
			type: "session_state",
			id: "ss-1",
			sessionId: SESSION,
			state: "parked",
		});
		// The park deliberately drops affinity — this is the state the old
		// affinity-only check rejected on.
		expect(h.store.getSessionAffinity(SESSION)).toBeUndefined();

		const response = await h.executor.dispatch(h.deviceId, activityFrame());

		expect(response.ok).toBe(true);
		expect(h.createAgentActivity).toHaveBeenCalledTimes(1);
		// A park waits on a human, so the window is a working day, not minutes.
		expect(
			h.store.getSessionOwnershipGrace(
				SESSION,
				h.clock.value + PARK_OWNERSHIP_GRACE_MS - 1,
			),
		).toBe(h.deviceId);
	});

	it("keeps accepting after an unpark restores affinity", async () => {
		for (const state of ["parked", "active"] as const) {
			h.router.handleSessionState(h.deviceId, {
				type: "session_state",
				id: `ss-${state}`,
				sessionId: SESSION,
				state,
			});
		}

		const response = await h.executor.dispatch(h.deviceId, activityFrame());

		expect(response.ok).toBe(true);
	});

	it("accepts the final summary posted as the session goes terminal", async () => {
		h.router.handleSessionState(h.deviceId, {
			type: "session_state",
			id: "ss-1",
			sessionId: SESSION,
			state: "complete",
		});
		// The terminal frame drops BOTH durable claims; only the grace remains.
		expect(h.store.getSessionAffinity(SESSION)).toBeUndefined();
		expect(h.store.getIssueLockDeviceForSession(SESSION)).toBeUndefined();

		const response = await h.executor.dispatch(h.deviceId, activityFrame());

		expect(response.ok).toBe(true);
		expect(h.createAgentActivity).toHaveBeenCalledTimes(1);
	});

	it("stops accepting once the post-terminal grace lapses", async () => {
		h.router.handleSessionState(h.deviceId, {
			type: "session_state",
			id: "ss-1",
			sessionId: SESSION,
			state: "complete",
		});

		vi.useFakeTimers();
		try {
			// The store's grace read uses the wall clock, not the router's injected
			// one, so move the wall clock past the granted expiry.
			vi.setSystemTime(h.clock.value + TERMINAL_OWNERSHIP_GRACE_MS + 1);
			const response = await h.executor.dispatch(h.deviceId, activityFrame());

			expect(response.ok).toBe(false);
			expect(response.error).toBe("session not owned by this device");
			expect(h.createAgentActivity).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("does not let one device's grace authorize another device", async () => {
		h.router.handleSessionState(h.deviceId, {
			type: "session_state",
			id: "ss-1",
			sessionId: SESSION,
			state: "complete",
		});

		const other = h.deviceId + 1;
		const response = await h.executor.dispatch(other, activityFrame());

		expect(response.ok).toBe(false);
		expect(response.error).toBe("session not owned by this device");
		expect(h.createAgentActivity).not.toHaveBeenCalled();
	});

	it("still rejects a device that never owned the session", async () => {
		const response = await h.executor.dispatch(
			h.deviceId + 99,
			activityFrame("sess-never-seen"),
		);

		expect(response.ok).toBe(false);
		expect(response.error).toBe("session not owned by this device");
		expect(h.createAgentActivity).not.toHaveBeenCalled();
	});

	/**
	 * `frame.sessionId` is device-supplied and validated only as a non-empty
	 * string, so a grant keyed on the SENDER rather than on the current owner
	 * would let any enrolled device buy itself authorization over any session id
	 * — turning a stray frame from a denial of service into an escalation. Every
	 * branch that creates a claim is gated: `parked` (which records the in-memory
	 * authorization `active` later redeems), `active` (which writes affinity
	 * outright), and the terminal grace.
	 */
	it("does not let a non-owner mint a grace by forging a terminal frame", async () => {
		const mallory = h.deviceId + 1;

		h.router.handleSessionState(mallory, {
			type: "session_state",
			id: "ss-forged",
			sessionId: SESSION,
			state: "complete",
		});

		expect(h.store.getSessionOwnershipGrace(SESSION)).toBeUndefined();
		const response = await h.executor.dispatch(mallory, activityFrame());
		expect(response.ok).toBe(false);
		expect(response.error).toBe("session not owned by this device");
		expect(h.createAgentActivity).not.toHaveBeenCalled();
	});

	it("does not let a non-owner mint a grace by forging a park frame", async () => {
		const mallory = h.deviceId + 1;

		h.router.handleSessionState(mallory, {
			type: "session_state",
			id: "ss-forged",
			sessionId: SESSION,
			state: "parked",
		});

		expect(h.store.getSessionOwnershipGrace(SESSION)).toBeUndefined();
		const response = await h.executor.dispatch(mallory, activityFrame());
		expect(response.ok).toBe(false);
		expect(response.error).toBe("session not owned by this device");
	});

	/**
	 * The escalation the grace gate alone does NOT close, because it takes two
	 * frames. `parked` records an in-memory entry that `active` later redeems for
	 * full session affinity — the strongest ownership route there is, stronger
	 * than the grace the gate refuses. So a forged `parked` that merely seeds
	 * that entry is itself the primitive, and gating only the grant leaves the
	 * door open one frame further along.
	 */
	it("does not let a non-owner take affinity by forging a park then an unpark", async () => {
		const mallory = h.deviceId + 1;

		for (const state of ["parked", "active"] as const) {
			h.router.handleSessionState(mallory, {
				type: "session_state",
				id: `ss-forged-${state}`,
				sessionId: SESSION,
				state,
			});
		}

		// The victim's affinity is untouched — not merely "mallory got no grace".
		expect(h.store.getSessionAffinity(SESSION)).toBe(h.deviceId);
		expect(h.store.getSessionOwnershipGrace(SESSION)).toBeUndefined();
		expect(h.store.getSessionOwner(SESSION, h.clock.value)).toBe(h.deviceId);

		const response = await h.executor.dispatch(mallory, activityFrame());
		expect(response.ok).toBe(false);
		expect(response.error).toBe("session not owned by this device");

		// And the rightful owner is still able to work.
		expect(
			await h.executor.dispatch(h.deviceId, activityFrame()),
		).toMatchObject({ ok: true });
	});

	/**
	 * The park was genuine this time, so the in-memory entry exists — but it is
	 * keyed by session id, and matching on that alone would let any enrolled
	 * device redeem another device's park and walk off with its affinity.
	 */
	it("does not let a non-owner redeem another device's park", async () => {
		const mallory = h.deviceId + 1;

		h.router.handleSessionState(h.deviceId, {
			type: "session_state",
			id: "ss-park",
			sessionId: SESSION,
			state: "parked",
		});
		h.router.handleSessionState(mallory, {
			type: "session_state",
			id: "ss-steal",
			sessionId: SESSION,
			state: "active",
		});

		expect(h.store.getSessionAffinity(SESSION)).toBeUndefined();
		expect(await h.executor.dispatch(mallory, activityFrame())).toMatchObject({
			ok: false,
		});

		// The refusal must not consume the park entry: dropping it would trade the
		// escalation for a denial of service against the owner's own unpark.
		h.router.handleSessionState(h.deviceId, {
			type: "session_state",
			id: "ss-unpark",
			sessionId: SESSION,
			state: "active",
		});
		expect(h.store.getSessionAffinity(SESSION)).toBe(h.deviceId);
	});

	/**
	 * The mirror image of a grant: a non-owner's terminal frame must not be able
	 * to DELETE the window the real owner is posting its closing summary into.
	 * The releases beside it are deliberately ungated — refusing those would
	 * strand the issue lock — but the grace expires on its own, so clearing it
	 * can only ever destroy a legitimate claim.
	 */
	it("does not let a non-owner's terminal frame cancel the owner's grace", async () => {
		const mallory = h.deviceId + 1;

		h.router.handleSessionState(h.deviceId, {
			type: "session_state",
			id: "ss-complete",
			sessionId: SESSION,
			state: "complete",
		});
		expect(h.store.getSessionOwnershipGrace(SESSION)).toBe(h.deviceId);

		h.router.handleSessionState(mallory, {
			type: "session_state",
			id: "ss-forged-complete",
			sessionId: SESSION,
			state: "complete",
		});

		expect(h.store.getSessionOwnershipGrace(SESSION)).toBe(h.deviceId);
		expect(
			await h.executor.dispatch(h.deviceId, activityFrame()),
		).toMatchObject({ ok: true });
	});

	it("drops the park grace once an unpark restores affinity", async () => {
		for (const state of ["parked", "active"] as const) {
			h.router.handleSessionState(h.deviceId, {
				type: "session_state",
				id: `ss-${state}`,
				sessionId: SESSION,
				state,
			});
		}

		// Ownership is back on the narrowest claim that supports it.
		expect(h.store.getSessionAffinity(SESSION)).toBe(h.deviceId);
		expect(h.store.getSessionOwnershipGrace(SESSION)).toBeUndefined();
	});

	it("shortens a park grace to the terminal window when the session completes", async () => {
		h.router.handleSessionState(h.deviceId, {
			type: "session_state",
			id: "ss-1",
			sessionId: SESSION,
			state: "parked",
		});
		h.router.handleSessionState(h.deviceId, {
			type: "session_state",
			id: "ss-2",
			sessionId: SESSION,
			state: "complete",
		});

		// Still authorized for the closing summary...
		expect(
			await h.executor.dispatch(h.deviceId, activityFrame()),
		).toMatchObject({ ok: true });
		// ...but on the 5-minute terminal window, not the 24-hour park one.
		expect(
			h.store.getSessionOwnershipGrace(
				SESSION,
				h.clock.value + TERMINAL_OWNERSHIP_GRACE_MS,
			),
		).toBeUndefined();
	});
});

/**
 * Issue locking is a supported deployment knob (`CYRUS_ROUTER_ISSUE_LOCK`).
 * With it off no `issue_locks` row is ever taken, so the lock cannot be what
 * carries a parked session's ownership — and the PAR-275 burst NOR-405 was
 * filed for would recur unchanged.
 */
describe("park window with issue locking disabled (NOR-405)", () => {
	it("accepts an activity posted while parked", async () => {
		const h = makeHarness({ issueLock: false });
		await h.router.route(createdEvent());
		expect(h.store.getIssueLockDeviceForSession(SESSION)).toBeUndefined();

		h.router.handleSessionState(h.deviceId, {
			type: "session_state",
			id: "ss-1",
			sessionId: SESSION,
			state: "parked",
		});

		const response = await h.executor.dispatch(h.deviceId, activityFrame());

		expect(response.ok).toBe(true);
		expect(h.createAgentActivity).toHaveBeenCalledTimes(1);
	});
});

describe("session-scoped RPC rejection logging (NOR-405)", () => {
	let recorder: ReturnType<typeof installRecordingLogSink>;

	beforeEach(() => {
		recorder = installRecordingLogSink();
	});

	afterEach(() => {
		recorder.restore();
	});

	it("logs a rejection at WARN with the method, device and session", async () => {
		const h = makeHarness({
			executorLogger: createLogger({
				component: "LinearExecutor",
				// SILENT suppresses the console write; the sink still receives the
				// record, which is the thing being asserted.
				level: LogLevel.SILENT,
			}),
		});

		await h.executor.dispatch(4242, activityFrame("sess-not-ours"));

		const record = recorder.sink.find({
			level: LogLevel.WARN,
			message: "Rejected session-scoped RPC",
		});
		expect(record).toBeDefined();
		expect(record?.context.sessionId).toBe("sess-not-ours");
		expect(record?.attributes).toEqual({
			"cyrus.rpc_method": "createAgentActivity",
			"cyrus.device_id": 4242,
			"cyrus.session_id": "sess-not-ours",
		});
	});

	/**
	 * The WARN is what an operator SEES; the event is what a query can GROUP BY.
	 * Both are required and neither substitutes for the other — the WARN alone is
	 * prose, and `event()` alone is below the console threshold. This asserts the
	 * wire format verbatim because `infra/azure/bicep/modules/monitoring.bicep`
	 * keys its saved search and its alert on these literal strings, and a dotted
	 * attribute renamed here silently returns null there rather than erroring.
	 */
	it("emits a queryable session.ownership_refused event beside the WARN", async () => {
		const h = makeHarness({
			executorLogger: createLogger({
				component: "LinearExecutor",
				level: LogLevel.SILENT,
			}),
		});

		await h.executor.dispatch(4242, activityFrame("sess-not-ours"));

		const event = recorder.sink.find({ event: "session.ownership_refused" });
		expect(event).toBeDefined();
		expect(event?.attributes).toEqual({
			"cyrus.reason": "rpc_not_owned",
			"cyrus.agent_session_id": "sess-not-ours",
			"cyrus.device_id": 4242,
			"cyrus.owner_device_id": null,
			"cyrus.rpc_method": "createAgentActivity",
			"cyrus.session_state": null,
		});
	});

	function routerRecordingLogger(): ILogger {
		return createLogger({
			component: "EventRouter",
			level: LogLevel.SILENT,
		});
	}

	it("logs a non-owner's terminal frame at WARN with cyrus.* attributes", async () => {
		const h = makeHarness({ routerLogger: routerRecordingLogger() });
		await h.router.route(createdEvent());
		const mallory = h.deviceId + 1;

		h.router.handleSessionState(mallory, {
			type: "session_state",
			id: "ss-forged",
			sessionId: SESSION,
			state: "complete",
		});

		const record = recorder.sink.find({
			level: LogLevel.WARN,
			message: "reported terminal state",
		});
		expect(record).toBeDefined();
		expect(record?.attributes).toEqual({
			"cyrus.reason": "terminal_not_owned",
			"cyrus.device_id": mallory,
			"cyrus.session_id": SESSION,
			"cyrus.session_state": "complete",
			"cyrus.owner_device_id": h.deviceId,
		});
	});

	/**
	 * `RouterServer` applies a `session_state` frame BEFORE acking it, so a
	 * process death in between leaves the device replaying a frame the router
	 * already applied — a case its comment documents as safe precisely because
	 * `handleSessionState` is idempotent. Once the grace has lapsed that replay
	 * owns nothing and is shape-identical to a forged frame, so warning about it
	 * would seed the ONE detector for genuine forgery with routine noise.
	 */
	it("does not warn when a device replays its own terminal frame after the grace lapses", async () => {
		const h = makeHarness({ routerLogger: routerRecordingLogger() });
		await h.router.route(createdEvent());

		const terminalFrame = {
			type: "session_state",
			id: "ss-complete",
			sessionId: SESSION,
			state: "complete",
		} as const;

		h.router.handleSessionState(h.deviceId, terminalFrame);
		// Past the posting window, so every ownership route is gone and the replay
		// arrives looking exactly like a stray frame.
		h.clock.value += TERMINAL_OWNERSHIP_GRACE_MS + 1;
		expect(h.store.getSessionOwner(SESSION, h.clock.value)).toBeUndefined();

		h.router.handleSessionState(h.deviceId, terminalFrame);

		expect(
			recorder.sink.find({
				level: LogLevel.WARN,
				message: "reported terminal state",
			}),
		).toBeUndefined();
		// Recognised as a replay rather than silently ignored.
		expect(
			recorder.sink.find({
				level: LogLevel.INFO,
				message: "Ignoring replayed terminal state",
			}),
		).toBeDefined();
		// And it does NOT re-open the window: the grace is measured from the
		// terminal instant, not from whenever the ack happened to land.
		expect(h.store.getSessionOwnershipGrace(SESSION, h.clock.value)).toBe(
			undefined,
		);
	});
});
