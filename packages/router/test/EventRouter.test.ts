import type { AgentEvent } from "cyrus-core";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { EventRouter } from "../src/EventRouter.js";
import {
	expiredMessage,
	fillTemplate,
	ISSUE_LOCKED_MESSAGE,
	offlineReleaseMessage,
	offlineWaitingMessage,
	PROMPT_REJECTION_MESSAGE,
	UNENROLLED_CREATOR_MESSAGE,
} from "../src/messages.js";
import { RouterStore } from "../src/RouterStore.js";

const ROUTE_NOW = 1_000_000;
const TTL_MS = 60_000;

interface Creator {
	id: string;
	email: string;
	name: string;
}

/** Minimal object that satisfies isAgentSessionCreatedWebhook + fields we read. */
function createdEvent(opts: {
	sessionId: string;
	issueId?: string;
	creator?: Creator;
	organizationId?: string;
	parentIssueId?: string;
}): AgentEvent {
	const org = opts.organizationId ?? "ws-1";
	return {
		type: "AgentSessionEvent",
		action: "created",
		organizationId: org,
		agentSession: {
			id: opts.sessionId,
			organizationId: org,
			issueId: opts.issueId,
			issue: opts.issueId
				? { id: opts.issueId, parentId: opts.parentIssueId }
				: undefined,
			creator: opts.creator,
		},
	} as unknown as AgentEvent;
}

/** Minimal object that satisfies isAgentSessionPromptedWebhook + fields we read. */
function promptedEvent(opts: {
	sessionId: string;
	actorUserId?: string;
	creator?: Creator;
	issueId?: string;
	organizationId?: string;
}): AgentEvent {
	const org = opts.organizationId ?? "ws-1";
	return {
		type: "AgentSessionEvent",
		action: "prompted",
		organizationId: org,
		agentActivity: opts.actorUserId
			? { id: "act-1", userId: opts.actorUserId, content: {} }
			: undefined,
		agentSession: {
			id: opts.sessionId,
			organizationId: org,
			issueId: opts.issueId,
			creator: opts.creator,
		},
	} as unknown as AgentEvent;
}

function enroll(
	store: RouterStore,
	email: string,
	opts?: { name?: string; linearId?: string },
): number {
	store.addUser({ email, name: opts?.name, linearId: opts?.linearId });
	const code = store.mintEnrollmentCode(email, 1);
	const device = store.redeemEnrollmentCode(code, 1);
	if (!device) throw new Error("enroll failed");
	return device.deviceId;
}

interface Gateway {
	isOnline: () => boolean;
	deliverPending: Mock<(deviceId: number) => void>;
}

function makeRouter(
	store: RouterStore,
	overrides?: {
		gateway?: Gateway;
		config?: Partial<{
			eventTtlMs: number;
			issueLock: boolean;
			creatorOnlyPrompting: boolean;
		}>;
	},
) {
	const postActivity = vi.fn<
		(workspaceId: string, agentSessionId: string, body: string) => Promise<void>
	>(async () => {});
	const clock = { value: ROUTE_NOW };
	const gateway: Gateway = overrides?.gateway ?? {
		isOnline: () => false,
		deliverPending: vi.fn<(deviceId: number) => void>(),
	};
	const router = new EventRouter({
		store,
		gateway,
		postActivity,
		config: {
			eventTtlMs: TTL_MS,
			issueLock: true,
			creatorOnlyPrompting: false,
			...overrides?.config,
		},
		logger: { info: () => {}, warn: () => {} },
		now: () => clock.value,
	});
	return { router, postActivity, gateway, clock };
}

const ALICE: Creator = {
	id: "lin-alice",
	email: "alice@example.com",
	name: "Alice",
};
const BOB: Creator = { id: "lin-bob", email: "bob@example.com", name: "Bob" };

describe("EventRouter", () => {
	let store: RouterStore;

	beforeEach(() => {
		store = new RouterStore(":memory:");
	});

	it("(a) routes a created event by creator email, queues it, and posts the offline notice once per session", async () => {
		// No linearId → creator.id won't match, forcing email-based routing.
		const deviceId = enroll(store, "alice@example.com", { name: "Alice" });
		const { router, postActivity } = makeRouter(store);
		const creator: Creator = {
			id: "lin-unmatched",
			email: "alice@example.com",
			name: "Alice",
		};

		await router.route(
			createdEvent({ sessionId: "sess-1", issueId: "ISS-1", creator }),
		);
		expect(store.pendingEvents(deviceId, 0, ROUTE_NOW)).toHaveLength(1);

		// A second event on the same session while still offline: queued again,
		// but the offline notice must NOT be posted a second time.
		await router.route(
			createdEvent({ sessionId: "sess-1", issueId: "ISS-1", creator }),
		);
		expect(store.pendingEvents(deviceId, 0, ROUTE_NOW)).toHaveLength(2);

		const waiting = postActivity.mock.calls.filter(
			(c) => c[2] === offlineWaitingMessage("alice@example.com"),
		);
		expect(waiting).toHaveLength(1);
		expect(waiting[0]).toEqual([
			"ws-1",
			"sess-1",
			offlineWaitingMessage("alice@example.com"),
		]);
	});

	it("(b) posts the unenrolled-creator message and queues nothing for an unknown creator", async () => {
		const { router, postActivity } = makeRouter(store);
		const creator: Creator = {
			id: "lin-charlie",
			email: "charlie@example.com",
			name: "Charlie",
		};

		await router.route(
			createdEvent({ sessionId: "sess-x", issueId: "ISS-9", creator }),
		);

		expect(postActivity).toHaveBeenCalledTimes(1);
		expect(postActivity).toHaveBeenCalledWith(
			"ws-1",
			"sess-x",
			fillTemplate(UNENROLLED_CREATOR_MESSAGE, { userName: "Charlie" }),
		);
		// Nothing recorded for a creator we can't route.
		expect(store.getSessionAffinity("sess-x")).toBeUndefined();
		expect(store.getIssueLock("ISS-9")).toBeUndefined();
	});

	it("(c) rejects a second created event on a locked issue from a different session", async () => {
		const aliceDevice = enroll(store, "alice@example.com", {
			linearId: "lin-alice",
		});
		const bobDevice = enroll(store, "bob@example.com", { linearId: "lin-bob" });
		const { router, postActivity } = makeRouter(store);

		await router.route(
			createdEvent({ sessionId: "sess-a", issueId: "ISS-1", creator: ALICE }),
		);
		postActivity.mockClear();

		await router.route(
			createdEvent({ sessionId: "sess-b", issueId: "ISS-1", creator: BOB }),
		);

		expect(postActivity).toHaveBeenCalledWith(
			"ws-1",
			"sess-b",
			ISSUE_LOCKED_MESSAGE,
		);
		// Bob's device must not have received the event.
		expect(store.pendingEvents(bobDevice, 0, ROUTE_NOW)).toHaveLength(0);
		// The lock still belongs to Alice's session.
		expect(store.getIssueLock("ISS-1")).toEqual({
			sessionId: "sess-a",
			deviceId: aliceDevice,
		});
	});

	it("(d) enforces creator-only prompting using the activity actor field", async () => {
		// creatorOnlyPrompting: true → a prompt from a non-creator actor is rejected.
		const aliceDevice = enroll(store, "alice@example.com", {
			linearId: "lin-alice",
		});
		const { router, postActivity } = makeRouter(store, {
			config: { creatorOnlyPrompting: true },
		});
		await router.route(
			createdEvent({ sessionId: "sess-1", issueId: "ISS-1", creator: ALICE }),
		);
		postActivity.mockClear();
		const queuedBefore = store.pendingEvents(aliceDevice, 0, ROUTE_NOW).length;

		await router.route(
			promptedEvent({
				sessionId: "sess-1",
				actorUserId: "lin-bob",
				creator: ALICE,
			}),
		);

		expect(postActivity).toHaveBeenCalledWith(
			"ws-1",
			"sess-1",
			PROMPT_REJECTION_MESSAGE,
		);
		expect(store.pendingEvents(aliceDevice, 0, ROUTE_NOW)).toHaveLength(
			queuedBefore,
		);

		// creatorOnlyPrompting: false → the same non-creator prompt IS routed.
		const store2 = new RouterStore(":memory:");
		const aliceDevice2 = enroll(store2, "alice@example.com", {
			linearId: "lin-alice",
		});
		const { router: router2 } = makeRouter(store2, {
			config: { creatorOnlyPrompting: false },
		});
		await router2.route(
			createdEvent({ sessionId: "sess-1", issueId: "ISS-1", creator: ALICE }),
		);
		const before2 = store2.pendingEvents(aliceDevice2, 0, ROUTE_NOW).length;
		await router2.route(
			promptedEvent({
				sessionId: "sess-1",
				actorUserId: "lin-bob",
				creator: ALICE,
			}),
		);
		expect(store2.pendingEvents(aliceDevice2, 0, ROUTE_NOW).length).toBe(
			before2 + 1,
		);
	});

	it("(e) handleSessionState(complete) releases the lock so a new session can acquire it", async () => {
		const aliceDevice = enroll(store, "alice@example.com", {
			linearId: "lin-alice",
		});
		const { router } = makeRouter(store);
		await router.route(
			createdEvent({ sessionId: "sess-1", issueId: "ISS-1", creator: ALICE }),
		);
		// Issue is locked by sess-1: a different session cannot acquire it.
		expect(store.acquireIssueLock("ISS-1", "sess-2", aliceDevice)).toBe(false);

		router.handleSessionState(aliceDevice, {
			type: "session_state",
			sessionId: "sess-1",
			state: "complete",
		});

		expect(store.getSessionAffinity("sess-1")).toBeUndefined();
		expect(store.acquireIssueLock("ISS-1", "sess-2", aliceDevice)).toBe(true);
	});

	it("(f) sweepExpired posts the TTL expiry activity and frees an undelivered created event's lock", async () => {
		const aliceDevice = enroll(store, "alice@example.com", {
			linearId: "lin-alice",
		});
		const { router, postActivity, clock } = makeRouter(store);
		await router.route(
			createdEvent({ sessionId: "sess-1", issueId: "ISS-1", creator: ALICE }),
		);
		postActivity.mockClear();

		clock.value = ROUTE_NOW + TTL_MS + 1;
		await router.sweepExpired();

		expect(postActivity).toHaveBeenCalledWith(
			"ws-1",
			"sess-1",
			expiredMessage("alice@example.com"),
		);
		// Undelivered created event → lock + affinity released.
		expect(store.getSessionAffinity("sess-1")).toBeUndefined();
		expect(store.acquireIssueLock("ISS-1", "sess-2", aliceDevice)).toBe(true);
	});

	it("(g) sweepExpired releases a delivered session's lock when the device is dark past the TTL", async () => {
		const aliceDevice = enroll(store, "alice@example.com", {
			linearId: "lin-alice",
		});
		const onlineGateway: Gateway = {
			isOnline: () => true,
			deliverPending: vi.fn<(deviceId: number) => void>(),
		};
		const { router, postActivity, clock } = makeRouter(store, {
			gateway: onlineGateway,
		});
		await router.route(
			createdEvent({ sessionId: "sess-1", issueId: "ISS-1", creator: ALICE }),
		);
		// Delivered while the device was online.
		expect(onlineGateway.deliverPending).toHaveBeenCalledWith(aliceDevice);

		// Device goes dark: last_seen well before the TTL cutoff, but the queued
		// event itself has NOT expired yet (so this exercises the stale-lock path).
		store.touchDevice(aliceDevice, 900_000);
		postActivity.mockClear();
		clock.value = 1_030_000; // cutoff = 970_000 > 900_000; event expires 1_060_000 > now

		await router.sweepExpired();

		expect(postActivity).toHaveBeenCalledWith(
			"ws-1",
			"sess-1",
			offlineReleaseMessage("alice@example.com"),
		);
		expect(store.getIssueLock("ISS-1")).toBeUndefined();
		expect(store.acquireIssueLock("ISS-1", "sess-2", aliceDevice)).toBe(true);
	});
});
