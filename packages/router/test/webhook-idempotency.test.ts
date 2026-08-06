/**
 * Webhook idempotency: a single Linear delivery must produce a single execution
 * even when two router processes are alive at once.
 *
 * The 2026-07-26 emergency router rollout briefly ran the outgoing and incoming
 * Container App revisions together. Both accepted the same durable work, which
 * doubled Linear activity and posted two `linear-mcp-ok` comments for the one
 * worker sandbox that survived. ACA's `revision_mode = "Single"` does not remove
 * that rolling-overlap window, so the router itself has to be idempotent.
 *
 * Every scenario below therefore drives TWO independent `RouterStore` +
 * `EventRouter` pairs over ONE database file — the shape a rollout overlap (or a
 * restart replay) takes — and asserts the observable side effects happen once:
 * one queue row, one delivery to the worker, one activity post, one MCP
 * mutation.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, IIssueTrackerService } from "cyrus-core";
import type { RpcRequestFrame } from "cyrus-router-protocol";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type Mock,
	vi,
} from "vitest";
import {
	DEFAULT_WEBHOOK_CLAIM_RETENTION_MS,
	EventRouter,
} from "../src/EventRouter.js";
import { webhookIdempotencyKey } from "../src/idempotency.js";
import { LinearExecutor } from "../src/LinearExecutor.js";
import { offlineWaitingMessage } from "../src/messages.js";
import { RouterStore } from "../src/RouterStore.js";
import { silentLogger } from "./helpers/logger.js";

const WS = "ws-1";
const ROUTE_NOW = 1_000_000;
const TTL_MS = 60_000;
const CREATED_AT = new Date(ROUTE_NOW).toISOString();

const ALICE = {
	id: "lin-alice",
	email: "alice@example.com",
	name: "Alice",
};

/**
 * A `created` webhook shaped like Linear's `AgentSessionEventWebhookPayload`.
 * `createdAt` defaults to a FIXED value on purpose: re-calling this with the
 * same arguments models the identical delivery arriving twice, which is exactly
 * what the dedupe gate has to catch.
 */
function createdEvent(opts?: {
	sessionId?: string;
	issueId?: string;
	createdAt?: string;
}): AgentEvent {
	return {
		type: "AgentSessionEvent",
		action: "created",
		organizationId: WS,
		createdAt: opts?.createdAt ?? CREATED_AT,
		agentSession: {
			id: opts?.sessionId ?? "sess-1",
			organizationId: WS,
			issueId: opts?.issueId ?? "issue-1",
			issue: {
				id: opts?.issueId ?? "issue-1",
				identifier: "TEST-1",
				title: "Ship it",
			},
			creator: ALICE,
		},
	} as unknown as AgentEvent;
}

/** A `prompted` webhook carrying the AgentActivity entity Linear created for it. */
function promptedEvent(opts?: {
	sessionId?: string;
	activityId?: string;
	createdAt?: string;
}): AgentEvent {
	return {
		type: "AgentSessionEvent",
		action: "prompted",
		organizationId: WS,
		createdAt: opts?.createdAt ?? CREATED_AT,
		agentActivity: {
			id: opts?.activityId ?? "activity-1",
			userId: ALICE.id,
			content: { type: "prompt", body: "keep going" },
		},
		agentSession: {
			id: opts?.sessionId ?? "sess-1",
			organizationId: WS,
			issueId: "issue-1",
			issue: { id: "issue-1", identifier: "TEST-1" },
			creator: ALICE,
		},
	} as unknown as AgentEvent;
}

function enroll(store: RouterStore, email: string, linearId: string): number {
	store.addUser({ email, linearId });
	const code = store.mintEnrollmentCode(email, 1);
	const device = store.redeemEnrollmentCode(code, 1);
	if (!device) throw new Error("enroll failed");
	return device.deviceId;
}

interface Replica {
	store: RouterStore;
	router: EventRouter;
	deliverPending: Mock<(deviceId: number) => void>;
}

describe("webhookIdempotencyKey", () => {
	it("prefers the AgentActivity entity id a prompted event carries", () => {
		const key = webhookIdempotencyKey(
			promptedEvent({ activityId: "act-42" }) as never,
		);
		expect(key).toBe(
			`AgentSessionEvent/prompted:${WS}:activity:act-42:${CREATED_AT}`,
		);
	});

	it("falls back to the agent session id for a created event", () => {
		const key = webhookIdempotencyKey(
			createdEvent({ sessionId: "sess-9" }) as never,
		);
		expect(key).toBe(
			`AgentSessionEvent/created:${WS}:session:sess-9:${CREATED_AT}`,
		);
	});

	it("uses the notification entity id for an AppUserNotification", () => {
		const key = webhookIdempotencyKey({
			type: "AppUserNotification",
			action: "issueStatusChanged",
			organizationId: WS,
			createdAt: CREATED_AT,
			notification: { id: "notif-7", issue: { id: "issue-1" } },
		} as never);
		expect(key).toBe(
			`AppUserNotification/issueStatusChanged:${WS}:notification:notif-7:${CREATED_AT}`,
		);
	});

	it("uses the changed entity id for an EntityWebhookPayload", () => {
		const key = webhookIdempotencyKey({
			type: "Issue",
			action: "remove",
			organizationId: WS,
			createdAt: CREATED_AT,
			data: { id: "issue-1", identifier: "TEST-1" },
		} as never);
		expect(key).toBe(`Issue/remove:${WS}:entity:issue-1:${CREATED_AT}`);
	});

	it("is identical for the same delivery and different for distinct events", () => {
		expect(webhookIdempotencyKey(createdEvent() as never)).toBe(
			webhookIdempotencyKey(createdEvent() as never),
		);
		// Different action, different session, and different payload timestamp are
		// each enough to keep two real events apart.
		expect(webhookIdempotencyKey(promptedEvent() as never)).not.toBe(
			webhookIdempotencyKey(createdEvent() as never),
		);
		expect(
			webhookIdempotencyKey(createdEvent({ sessionId: "sess-2" }) as never),
		).not.toBe(webhookIdempotencyKey(createdEvent() as never));
		expect(
			webhookIdempotencyKey(
				createdEvent({
					createdAt: new Date(ROUTE_NOW + 1).toISOString(),
				}) as never,
			),
		).not.toBe(webhookIdempotencyKey(createdEvent() as never));
	});

	it("returns undefined when the payload carries no createdAt at all", () => {
		// No real Linear webhook does this — `createdAt` is non-optional on all
		// three payload types — so the router treats it as "no key material" and
		// routes unprotected rather than collapsing distinct events onto one key.
		expect(
			webhookIdempotencyKey({
				type: "AgentSessionEvent",
				action: "created",
				organizationId: WS,
				agentSession: { id: "sess-1" },
			} as never),
		).toBeUndefined();
	});
});

describe("RouterStore webhook claims", () => {
	let dir: string;
	let dbPath: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "router-idempotency-store-"));
		dbPath = join(dir, "router.db");
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("claims a key once and refuses every later claim of it", () => {
		const store = new RouterStore(dbPath);
		expect(store.claimWebhookEvent("k1", ROUTE_NOW)).toBe(true);
		expect(store.hasWebhookClaim("k1")).toBe(true);
		expect(store.claimWebhookEvent("k1", ROUTE_NOW + 1)).toBe(false);
		expect(store.claimWebhookEvent("k2", ROUTE_NOW)).toBe(true);
		store.close();
	});

	it("resolves concurrent claims of one key to exactly one winner", () => {
		// Five INDEPENDENT connections to the same database file — the shape two
		// overlapping router revisions take. The winner is decided by
		// `webhook_claims.idempotency_key`'s UNIQUE (PRIMARY KEY) constraint
		// inside a write transaction, i.e. by SQLite itself, not by any
		// per-connection in-memory bookkeeping: nothing here shares state.
		const stores = Array.from({ length: 5 }, () => new RouterStore(dbPath));
		const results = stores.map((store) =>
			store.claimWebhookEvent("contended-key", ROUTE_NOW),
		);
		expect(results.filter(Boolean)).toHaveLength(1);
		for (const store of stores) store.close();
	});

	it("survives a reopen: a claim made before a crash is still claimed after", () => {
		const before = new RouterStore(dbPath);
		expect(before.claimWebhookEvent("k1", ROUTE_NOW)).toBe(true);
		before.close();

		const after = new RouterStore(dbPath);
		expect(after.claimWebhookEvent("k1", ROUTE_NOW)).toBe(false);
		after.close();
	});

	it("sweeps only claims older than the retention bound", () => {
		const store = new RouterStore(dbPath);
		store.claimWebhookEvent("old", ROUTE_NOW - 10_000);
		store.claimWebhookEvent("on-the-bound", ROUTE_NOW - 5_000);
		store.claimWebhookEvent("fresh", ROUTE_NOW - 1_000);

		expect(store.sweepWebhookClaims(ROUTE_NOW - 5_000)).toBe(1);
		expect(store.hasWebhookClaim("old")).toBe(false);
		// The bound is exclusive: a row exactly AT the cutoff is retained, so a
		// claim is never dropped a moment early.
		expect(store.hasWebhookClaim("on-the-bound")).toBe(true);
		expect(store.hasWebhookClaim("fresh")).toBe(true);

		// Swept keys are claimable again — which is safe precisely because the
		// retention bound outlives every window a redelivery can arrive in.
		expect(store.claimWebhookEvent("old", ROUTE_NOW)).toBe(true);
		store.close();
	});
});

describe("EventRouter webhook dedupe across two router replicas", () => {
	let dir: string;
	let dbPath: string;
	/** Shared by both replicas: one Linear workspace, one activity stream. */
	let postActivity: Mock<
		(workspaceId: string, agentSessionId: string, body: string) => Promise<void>
	>;
	let replicas: Replica[];

	/**
	 * Builds a router over its OWN connection to the shared database file, the
	 * way a second Container App revision comes up alongside the first. `online`
	 * false keeps the device queued-and-notified, which is the path that exposed
	 * the original bug: the once-per-session offline notice is latched IN MEMORY
	 * per router, so two replicas each post it unless the delivery itself is
	 * deduped.
	 */
	function makeReplica(opts?: { online?: boolean }): Replica {
		const store = new RouterStore(dbPath);
		const deliverPending = vi.fn<(deviceId: number) => void>();
		const router = new EventRouter({
			store,
			gateway: { isOnline: () => opts?.online ?? false, deliverPending },
			postActivity,
			config: {
				eventTtlMs: TTL_MS,
				issueLock: true,
				creatorOnlyPrompting: false,
			},
			logger: silentLogger(),
			now: () => ROUTE_NOW,
		});
		const replica = { store, router, deliverPending };
		replicas.push(replica);
		return replica;
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "router-idempotency-"));
		dbPath = join(dir, "router.db");
		postActivity = vi.fn(async () => {});
		replicas = [];
	});

	afterEach(() => {
		for (const replica of replicas) replica.store.close();
		rmSync(dir, { recursive: true, force: true });
	});

	it("submits one webhook to two live routers and executes it exactly once", async () => {
		const a = makeReplica();
		const deviceId = enroll(a.store, ALICE.email, ALICE.id);
		const b = makeReplica();

		const webhook = createdEvent();
		await a.router.route(webhook);
		await b.router.route(webhook);

		// One queue row → the worker starts one agent session, not two.
		expect(a.store.pendingEvents(deviceId, 0, ROUTE_NOW)).toHaveLength(1);
		expect(b.store.pendingEvents(deviceId, 0, ROUTE_NOW)).toHaveLength(1);
		// One activity stream: exactly one notice, from the replica that won.
		expect(postActivity.mock.calls).toEqual([
			[WS, "sess-1", offlineWaitingMessage(ALICE.email)],
		]);
		// One issue lock, held by the one session that was routed.
		expect(b.store.getIssueLock("issue-1")).toEqual({
			sessionId: "sess-1",
			deviceId,
		});
		// The loser did nothing at all.
		expect(
			b.store.hasWebhookClaim(webhookIdempotencyKey(webhook as never) ?? ""),
		).toBe(true);
	});

	it("delivers one webhook to the worker once when both replicas see it online", async () => {
		const a = makeReplica({ online: true });
		const deviceId = enroll(a.store, ALICE.email, ALICE.id);
		const b = makeReplica({ online: true });

		const webhook = promptedEvent();
		await a.router.route(webhook);
		await b.router.route(webhook);

		expect(a.deliverPending.mock.calls).toEqual([[deviceId]]);
		expect(b.deliverPending).not.toHaveBeenCalled();
		expect(a.store.pendingEvents(deviceId, 0, ROUTE_NOW)).toHaveLength(1);
	});

	it("records one MCP mutation when the surviving worker replays it to both replicas", async () => {
		// The worker buffers its Linear mutations and replays anything unacked
		// after a reconnect — which, mid-rollout, may land on the OTHER revision.
		// `rpc_mutations` lives in the same shared store, so the replay is served
		// from cache instead of hitting Linear a second time. This is the
		// "two linear-mcp-ok comments" half of the original incident.
		const a = makeReplica({ online: true });
		const deviceId = enroll(a.store, ALICE.email, ALICE.id);
		const b = makeReplica({ online: true });
		await a.router.route(createdEvent());

		const tracker = {
			createAgentActivity: vi.fn(async () => ({ success: true })),
		};
		const trackers = new Map<string, IIssueTrackerService>([
			[WS, tracker as unknown as IIssueTrackerService],
		]);
		const frame: RpcRequestFrame = {
			type: "rpc_request",
			id: "req-1",
			method: "createAgentActivity",
			params: [
				WS,
				{ agentSessionId: "sess-1", content: { type: "thought", body: "hi" } },
			],
			mutationId: "mut-1",
		};

		const first = await new LinearExecutor({
			trackers,
			store: a.store,
		}).dispatch(deviceId, frame);
		const replay = await new LinearExecutor({
			trackers,
			store: b.store,
		}).dispatch(deviceId, frame);

		expect(first.ok).toBe(true);
		expect(replay).toEqual(first);
		expect(tracker.createAgentActivity).toHaveBeenCalledTimes(1);
	});

	it("still routes two genuinely distinct events on the same session", async () => {
		const a = makeReplica();
		const deviceId = enroll(a.store, ALICE.email, ALICE.id);

		await a.router.route(createdEvent());
		await a.router.route(promptedEvent({ activityId: "activity-2" }));

		expect(a.store.pendingEvents(deviceId, 0, ROUTE_NOW)).toHaveLength(2);
	});

	it("routes unprotected instead of crashing when the claim itself fails", async () => {
		// A store error is not evidence of a duplicate, and `route()` is invoked
		// as `void route(event)` by RouterServer — letting the throw escape would
		// be an unhandled rejection that takes down routing for every teammate.
		const a = makeReplica();
		const deviceId = enroll(a.store, ALICE.email, ALICE.id);
		vi.spyOn(a.store, "claimWebhookEvent").mockImplementation(() => {
			throw new Error("SQLITE_BUSY: database is locked");
		});

		await expect(a.router.route(createdEvent())).resolves.toBeUndefined();

		expect(a.store.pendingEvents(deviceId, 0, ROUTE_NOW)).toHaveLength(1);
	});

	it("keeps at-least-once delivery from becoming at-least-twice execution across a restart", async () => {
		// Crash inside the enqueue/ack window: the event is queued and the device
		// has NOT acked it, so it is still pending — at-least-once delivery is
		// intact. What must not survive the restart is a second execution when the
		// same webhook is presented again (a Linear retry, or the replacement
		// revision replaying the delivery it inherited).
		const crashed = makeReplica();
		const deviceId = enroll(crashed.store, ALICE.email, ALICE.id);
		const webhook = createdEvent();
		await crashed.router.route(webhook);
		expect(crashed.store.pendingEvents(deviceId, 0, ROUTE_NOW)).toHaveLength(1);
		crashed.store.close();
		replicas = replicas.filter((replica) => replica !== crashed);

		const restarted = makeReplica();
		await restarted.router.route(webhook);

		// Still exactly one queue row (delivered once when the device reconnects)
		// and still exactly one activity post from before the crash.
		expect(restarted.store.pendingEvents(deviceId, 0, ROUTE_NOW)).toHaveLength(
			1,
		);
		expect(postActivity).toHaveBeenCalledTimes(1);
		expect(restarted.store.getIssueLock("issue-1")).toEqual({
			sessionId: "sess-1",
			deviceId,
		});
	});

	it("sweeps claims past the retention bound and leaves recent ones claimed", async () => {
		const a = makeReplica();
		enroll(a.store, ALICE.email, ALICE.id);
		const retentionMs = 10_000;
		const clock = { value: ROUTE_NOW };
		const router = new EventRouter({
			store: a.store,
			gateway: { isOnline: () => false, deliverPending: vi.fn() },
			postActivity,
			config: {
				eventTtlMs: TTL_MS,
				issueLock: true,
				creatorOnlyPrompting: false,
				webhookClaimRetentionMs: retentionMs,
			},
			logger: silentLogger(),
			now: () => clock.value,
		});

		const old = createdEvent();
		const recent = createdEvent({
			sessionId: "sess-2",
			issueId: "issue-2",
			createdAt: new Date(ROUTE_NOW + retentionMs).toISOString(),
		});
		await router.route(old);
		clock.value = ROUTE_NOW + retentionMs;
		await router.route(recent);

		// Sweep from a clock far enough past the first claim to expire it only.
		clock.value = ROUTE_NOW + retentionMs + 1;
		await router.sweepExpired();

		expect(
			a.store.hasWebhookClaim(webhookIdempotencyKey(old as never) ?? ""),
		).toBe(false);
		expect(
			a.store.hasWebhookClaim(webhookIdempotencyKey(recent as never) ?? ""),
		).toBe(true);
	});

	it("defaults the retention bound to a week", () => {
		expect(DEFAULT_WEBHOOK_CLAIM_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
	});
});
