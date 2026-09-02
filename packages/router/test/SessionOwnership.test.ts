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

function makeHarness(opts?: { executorLogger?: ILogger }): Harness {
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
			issueLock: true,
			creatorOnlyPrompting: false,
			affinityGraceMs: 600_000,
		},
		logger: silentLogger(),
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
});
