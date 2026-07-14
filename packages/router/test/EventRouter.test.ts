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
	PROMPT_UNROUTABLE_MESSAGE,
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

/**
 * Minimal object that satisfies isIssueStateChangeWebhook. Linear sends this
 * (as an AppUserNotification) when an issue reaches a terminal state; the node
 * turns it into the IssueStateChangeMessage that drives worktree cleanup.
 */
function issueStatusChangedEvent(opts: {
	issueId: string;
	identifier?: string;
	organizationId?: string;
}): AgentEvent {
	return {
		type: "AppUserNotification",
		action: "issueStatusChanged",
		organizationId: opts.organizationId ?? "ws-1",
		createdAt: new Date(ROUTE_NOW).toISOString(),
		notification: {
			issue: {
				id: opts.issueId,
				identifier: opts.identifier ?? "TEST-1",
			},
		},
	} as unknown as AgentEvent;
}

/** Minimal object that satisfies isIssueDeletedWebhook (a deleted issue is terminal too). */
function issueDeletedEvent(opts: {
	issueId: string;
	identifier?: string;
	organizationId?: string;
}): AgentEvent {
	return {
		type: "Issue",
		action: "remove",
		organizationId: opts.organizationId ?? "ws-1",
		createdAt: new Date(ROUTE_NOW).toISOString(),
		data: {
			id: opts.issueId,
			identifier: opts.identifier ?? "TEST-1",
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
	const moveIssueToStartedState = vi.fn<
		(workspaceId: string, issueId: string) => Promise<string | undefined>
	>(async () => "In Progress");
	const clock = { value: ROUTE_NOW };
	const gateway: Gateway = overrides?.gateway ?? {
		isOnline: () => false,
		deliverPending: vi.fn<(deviceId: number) => void>(),
	};
	const router = new EventRouter({
		store,
		gateway,
		postActivity,
		moveIssueToStartedState,
		config: {
			eventTtlMs: TTL_MS,
			issueLock: true,
			creatorOnlyPrompting: false,
			...overrides?.config,
		},
		logger: { info: () => {}, warn: () => {} },
		now: () => clock.value,
	});
	return { router, postActivity, moveIssueToStartedState, gateway, clock };
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

	it("(d2) rejects a prompt whose actor cannot be identified (fails closed, not open)", async () => {
		// Regression test: a real non-creator webhook may omit `agentActivity.userId`.
		// `agentSession.creator` is ALWAYS the session's original creator (Alice)
		// regardless of who is actually prompting, so falling back to it would
		// make the actor look identical to the creator and let a stranger's
		// prompt through. The gate must fail CLOSED when the actor is unknown.
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
				// No actorUserId → agentActivity is omitted entirely, so
				// agentActivity?.userId is undefined. agentSession.creator still
				// reports Alice (the true session creator), as it always does.
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
	});

	it("(d3) routes a prompt whose session affinity was released by a terminal state", async () => {
		// Regression: a Linear agent session outlives its turns — the user can
		// prompt it again after it completes. The terminal state releases session
		// affinity, and routePrompted used to resolve on affinity ALONE, so every
		// follow-up prompt was dropped silently and the session sat in "Waiting
		// for Cyrus" forever. A new session was the only way out.
		const aliceDevice = enroll(store, "alice@example.com", {
			linearId: "lin-alice",
		});
		const { router, postActivity } = makeRouter(store);
		await router.route(
			createdEvent({ sessionId: "sess-1", issueId: "ISS-1", creator: ALICE }),
		);

		// The session finishes: the router releases its lock AND its affinity.
		router.handleSessionState(aliceDevice, {
			sessionId: "sess-1",
			state: "complete",
		} as any);
		expect(store.getSessionAffinity("sess-1")).toBeUndefined();

		postActivity.mockClear();
		const queuedBefore = store.pendingEvents(aliceDevice, 0, ROUTE_NOW).length;

		await router.route(
			promptedEvent({
				sessionId: "sess-1",
				issueId: "ISS-1",
				actorUserId: "lin-alice",
				creator: ALICE,
			}),
		);

		// Falls back to the creator's enrolled device rather than dropping.
		expect(store.pendingEvents(aliceDevice, 0, ROUTE_NOW).length).toBe(
			queuedBefore + 1,
		);
		expect(postActivity).not.toHaveBeenCalledWith(
			"ws-1",
			"sess-1",
			PROMPT_UNROUTABLE_MESSAGE,
		);
		// ...and affinity is re-established, so the next prompt takes the fast path
		// and the creator-only gate has a stored creator to compare against again.
		expect(store.getSessionAffinity("sess-1")).toBe(aliceDevice);
	});

	it("(d3b) still enforces creator-only prompting on a session rescued by the fallback", async () => {
		// The fallback in (d3) must not become a way around the creator gate. A
		// rescued session has no STORED creator (the terminal state deleted the
		// affinity row), so the gate has to fall back to the session creator the
		// webhook carries — otherwise Bob could prompt Alice's finished session
		// onto Alice's machine.
		const aliceDevice = enroll(store, "alice@example.com", {
			linearId: "lin-alice",
		});
		const { router, postActivity } = makeRouter(store, {
			config: { creatorOnlyPrompting: true },
		});
		await router.route(
			createdEvent({ sessionId: "sess-1", issueId: "ISS-1", creator: ALICE }),
		);
		router.handleSessionState(aliceDevice, {
			sessionId: "sess-1",
			state: "complete",
		} as any);
		expect(store.getSessionAffinity("sess-1")).toBeUndefined();

		postActivity.mockClear();
		const queuedBefore = store.pendingEvents(aliceDevice, 0, ROUTE_NOW).length;

		await router.route(
			promptedEvent({
				sessionId: "sess-1",
				issueId: "ISS-1",
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
		// Rejected prompts must not resurrect affinity either.
		expect(store.getSessionAffinity("sess-1")).toBeUndefined();
	});

	it("(d4) tells the user when a prompt cannot be routed instead of dropping it silently", async () => {
		// Nothing resolves: no session affinity, no enrolled device for the
		// creator, no issue affinity. The session must not be left waiting.
		const { router, postActivity } = makeRouter(store);

		await router.route(
			promptedEvent({
				sessionId: "sess-unknown",
				issueId: "ISS-unknown",
				actorUserId: "lin-bob",
				creator: BOB,
			}),
		);

		expect(postActivity).toHaveBeenCalledWith(
			"ws-1",
			"sess-unknown",
			PROMPT_UNROUTABLE_MESSAGE,
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
			id: "ss-1",
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

describe("EventRouter issue promotion to a started state", () => {
	let store: RouterStore;

	beforeEach(() => {
		store = new RouterStore(":memory:");
	});

	it("promotes the issue once a created event is accepted", async () => {
		enroll(store, "alice@example.com", { linearId: "lin-alice" });
		const { router, moveIssueToStartedState } = makeRouter(store);

		await router.route(
			createdEvent({ sessionId: "sess-1", issueId: "ISS-1", creator: ALICE }),
		);

		expect(moveIssueToStartedState).toHaveBeenCalledTimes(1);
		expect(moveIssueToStartedState).toHaveBeenCalledWith("ws-1", "ISS-1");
	});

	it("promotes even when the target device is offline (the event is queued, not dropped)", async () => {
		const aliceDevice = enroll(store, "alice@example.com", {
			linearId: "lin-alice",
		});
		const { router, moveIssueToStartedState } = makeRouter(store, {
			gateway: { isOnline: () => false, deliverPending: vi.fn() },
		});

		await router.route(
			createdEvent({ sessionId: "sess-1", issueId: "ISS-1", creator: ALICE }),
		);

		expect(store.pendingEvents(aliceDevice, 0, ROUTE_NOW)).toHaveLength(1);
		expect(moveIssueToStartedState).toHaveBeenCalledWith("ws-1", "ISS-1");
	});

	it("does not promote an issue whose creator has no enrolled device", async () => {
		const { router, moveIssueToStartedState } = makeRouter(store);

		await router.route(
			createdEvent({
				sessionId: "sess-1",
				issueId: "ISS-1",
				creator: { id: "lin-charlie", email: "c@example.com", name: "Charlie" },
			}),
		);

		expect(moveIssueToStartedState).not.toHaveBeenCalled();
	});

	it("does not promote an issue whose lock is held by another session", async () => {
		enroll(store, "alice@example.com", { linearId: "lin-alice" });
		enroll(store, "bob@example.com", { linearId: "lin-bob" });
		const { router, moveIssueToStartedState } = makeRouter(store);

		await router.route(
			createdEvent({ sessionId: "sess-a", issueId: "ISS-1", creator: ALICE }),
		);
		moveIssueToStartedState.mockClear();

		await router.route(
			createdEvent({ sessionId: "sess-b", issueId: "ISS-1", creator: BOB }),
		);

		expect(moveIssueToStartedState).not.toHaveBeenCalled();
	});

	it("does not promote on a prompted event (the issue is already started)", async () => {
		enroll(store, "alice@example.com", { linearId: "lin-alice" });
		const { router, moveIssueToStartedState } = makeRouter(store);

		await router.route(
			createdEvent({ sessionId: "sess-1", issueId: "ISS-1", creator: ALICE }),
		);
		moveIssueToStartedState.mockClear();

		await router.route(
			promptedEvent({
				sessionId: "sess-1",
				issueId: "ISS-1",
				actorUserId: "lin-alice",
				creator: ALICE,
			}),
		);

		expect(moveIssueToStartedState).not.toHaveBeenCalled();
	});

	it("still delivers the event when promotion fails", async () => {
		const aliceDevice = enroll(store, "alice@example.com", {
			linearId: "lin-alice",
		});
		const { router, moveIssueToStartedState } = makeRouter(store);
		moveIssueToStartedState.mockRejectedValueOnce(new Error("Linear is down"));

		await expect(
			router.route(
				createdEvent({ sessionId: "sess-1", issueId: "ISS-1", creator: ALICE }),
			),
		).resolves.toBeUndefined();

		expect(store.pendingEvents(aliceDevice, 0, ROUTE_NOW)).toHaveLength(1);
		expect(store.getSessionAffinity("sess-1")).toBe(aliceDevice);
	});

	it("skips promotion for a session with no issue", async () => {
		enroll(store, "alice@example.com", { linearId: "lin-alice" });
		const { router, moveIssueToStartedState } = makeRouter(store);

		await router.route(createdEvent({ sessionId: "sess-1", creator: ALICE }));

		expect(moveIssueToStartedState).not.toHaveBeenCalled();
	});

	describe("terminal-state webhooks (worktree cleanup)", () => {
		it("forwards an issueStatusChanged webhook to the device holding the issue", async () => {
			const deviceId = enroll(store, "alice@example.com", {
				linearId: ALICE.id,
			});
			const { router, gateway } = makeRouter(store, {
				gateway: {
					isOnline: () => true,
					deliverPending: vi.fn<(deviceId: number) => void>(),
				},
			});

			// Establish issue affinity the same way real traffic does.
			await router.route(
				createdEvent({
					sessionId: "sess-1",
					issueId: "issue-1",
					creator: ALICE,
				}),
			);
			const queuedBefore = store.pendingEvents(deviceId, 0, ROUTE_NOW).length;

			await router.route(issueStatusChangedEvent({ issueId: "issue-1" }));

			const pending = store.pendingEvents(deviceId, 0, ROUTE_NOW);
			expect(pending).toHaveLength(queuedBefore + 1);
			const forwarded = JSON.parse(
				pending[pending.length - 1].payloadJson,
			) as Record<string, unknown>;
			expect(forwarded.type).toBe("AppUserNotification");
			expect(forwarded.action).toBe("issueStatusChanged");
			expect(gateway.deliverPending).toHaveBeenCalledWith(deviceId);
		});

		it("forwards an Issue/remove webhook to the device holding the issue", async () => {
			const deviceId = enroll(store, "alice@example.com", {
				linearId: ALICE.id,
			});
			const { router } = makeRouter(store);

			await router.route(
				createdEvent({
					sessionId: "sess-1",
					issueId: "issue-1",
					creator: ALICE,
				}),
			);
			const queuedBefore = store.pendingEvents(deviceId, 0, ROUTE_NOW).length;

			await router.route(issueDeletedEvent({ issueId: "issue-1" }));

			const pending = store.pendingEvents(deviceId, 0, ROUTE_NOW);
			expect(pending).toHaveLength(queuedBefore + 1);
			const forwarded = JSON.parse(
				pending[pending.length - 1].payloadJson,
			) as Record<string, unknown>;
			expect(forwarded.type).toBe("Issue");
			expect(forwarded.action).toBe("remove");
		});

		it("still forwards after the session ended, when only issue affinity remains", async () => {
			// The real-world case: a session completes (releasing its lock and
			// session affinity) hours before a human moves the issue to Done.
			// Only issue_affinity survives that gap — cleanup must route on it.
			const deviceId = enroll(store, "alice@example.com", {
				linearId: ALICE.id,
			});
			const { router } = makeRouter(store);

			await router.route(
				createdEvent({
					sessionId: "sess-1",
					issueId: "issue-1",
					creator: ALICE,
				}),
			);
			router.handleSessionState(deviceId, {
				type: "session_state",
				sessionId: "sess-1",
				state: "complete",
			} as never);
			expect(store.getSessionAffinity("sess-1")).toBeUndefined();
			const queuedBefore = store.pendingEvents(deviceId, 0, ROUTE_NOW).length;

			await router.route(issueStatusChangedEvent({ issueId: "issue-1" }));

			expect(store.pendingEvents(deviceId, 0, ROUTE_NOW)).toHaveLength(
				queuedBefore + 1,
			);
		});

		it("queues the cleanup for an offline device instead of dropping it", async () => {
			const deviceId = enroll(store, "alice@example.com", {
				linearId: ALICE.id,
			});
			const { router, gateway } = makeRouter(store); // isOnline: () => false

			await router.route(
				createdEvent({
					sessionId: "sess-1",
					issueId: "issue-1",
					creator: ALICE,
				}),
			);
			const queuedBefore = store.pendingEvents(deviceId, 0, ROUTE_NOW).length;

			await router.route(issueStatusChangedEvent({ issueId: "issue-1" }));

			// Queued for replay on reconnect; no delivery attempted while offline.
			expect(store.pendingEvents(deviceId, 0, ROUTE_NOW)).toHaveLength(
				queuedBefore + 1,
			);
			expect(gateway.deliverPending).not.toHaveBeenCalled();
		});

		it("does not post a Linear activity for terminal webhooks (no session thread to post to)", async () => {
			enroll(store, "alice@example.com", { linearId: ALICE.id });
			const { router, postActivity } = makeRouter(store);

			await router.route(
				createdEvent({
					sessionId: "sess-1",
					issueId: "issue-1",
					creator: ALICE,
				}),
			);
			postActivity.mockClear();

			await router.route(issueStatusChangedEvent({ issueId: "issue-1" }));

			expect(postActivity).not.toHaveBeenCalled();
		});

		it("drops a terminal webhook for an issue no device ever worked", async () => {
			const deviceId = enroll(store, "alice@example.com", {
				linearId: ALICE.id,
			});
			const { router } = makeRouter(store);

			await router.route(issueStatusChangedEvent({ issueId: "issue-unknown" }));

			expect(store.pendingEvents(deviceId, 0, ROUTE_NOW)).toHaveLength(0);
		});

		it("drops a terminal webhook carrying no issue id", async () => {
			const deviceId = enroll(store, "alice@example.com", {
				linearId: ALICE.id,
			});
			const { router } = makeRouter(store);

			await router.route(
				createdEvent({
					sessionId: "sess-1",
					issueId: "issue-1",
					creator: ALICE,
				}),
			);
			const queuedBefore = store.pendingEvents(deviceId, 0, ROUTE_NOW).length;

			await router.route({
				type: "AppUserNotification",
				action: "issueStatusChanged",
				organizationId: "ws-1",
				notification: {},
			} as unknown as AgentEvent);

			expect(store.pendingEvents(deviceId, 0, ROUTE_NOW)).toHaveLength(
				queuedBefore,
			);
		});
	});
});
