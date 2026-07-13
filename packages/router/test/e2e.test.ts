/**
 * In-process end-to-end integration test for the Cyrus Router.
 *
 * Stands up a real {@link RouterServer} on an ephemeral port (port 0) backed by
 * a single {@link CLIIssueTrackerService} (via `trackerFactory`), then drives it
 * with a real device stack from `cyrus-router-client`
 * ({@link RouterConnection} + {@link RouterEventTransport} +
 * {@link RouterIssueTrackerService}) over a live localhost WebSocket. This is
 * the integration gate: the router package, the protocol package, and the
 * client package are wired together exactly as they are in production, so the
 * seams between them (webhook → routing → queue → WS delivery → translation →
 * RPC → authorization) are exercised for real rather than mocked.
 *
 * The webhook source is bypassed deliberately: fixtures are fed straight into
 * `server.eventRouter.route(...)` (the same entry point the real Linear webhook
 * transport calls) so the suite controls exactly which agent-session events the
 * router sees, without standing up a Linear signature-verifying HTTP endpoint.
 *
 * Determinism: port 0 (no fixed port), unique temp `stateDir` per run, awaited
 * `connected` events, a small injected `reconnectBaseMs`, and `waitUntil`
 * polling of observable store/gateway state instead of fixed sleeps.
 */

import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentActivityContentType,
	type AgentEvent,
	AgentSessionStatus,
	AgentSessionType,
	CLIIssueTrackerService,
	type InternalMessage,
	isSessionStartMessage,
	isUserPromptMessage,
} from "cyrus-core";
import {
	RouterConnection,
	RouterEventTransport,
	RouterIssueTrackerService,
	RouterRpcError,
} from "cyrus-router-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	ISSUE_LOCKED_MESSAGE,
	offlineWaitingMessage,
	PROMPT_REJECTION_MESSAGE,
} from "../src/messages.js";
import { RouterServer } from "../src/RouterServer.js";

const WORKSPACE = "ws-1";

interface Creator {
	id: string;
	email: string;
	name: string;
}

const ALICE: Creator = {
	id: "lin-alice",
	email: "alice@example.com",
	name: "Alice",
};
const BOB: Creator = { id: "lin-bob", email: "bob@example.com", name: "Bob" };

/** A minimal but type-guard-valid agentSessionCreated webhook fixture. */
function createdFixture(opts: {
	sessionId: string;
	issue: { id: string; identifier: string; title: string };
	creator: Creator;
}): AgentEvent {
	return {
		type: "AgentSessionEvent",
		action: "created",
		organizationId: WORKSPACE,
		createdAt: new Date().toISOString(),
		agentSession: {
			id: opts.sessionId,
			organizationId: WORKSPACE,
			status: "active",
			type: "issue",
			creator: opts.creator,
			issueId: opts.issue.id,
			issue: {
				id: opts.issue.id,
				identifier: opts.issue.identifier,
				title: opts.issue.title,
				url: `linear://issue/${opts.issue.identifier}`,
				team: { id: "team-1", key: "DEF", name: "Default" },
			},
		},
		guidance: [],
	} as unknown as AgentEvent;
}

/** A minimal but type-guard-valid agentSessionPrompted webhook fixture. */
function promptedFixture(opts: {
	sessionId: string;
	actorUserId: string;
	creator: Creator;
	issue: { id: string; identifier: string; title: string };
	body: string;
}): AgentEvent {
	return {
		type: "AgentSessionEvent",
		action: "prompted",
		organizationId: WORKSPACE,
		createdAt: new Date().toISOString(),
		agentActivity: {
			id: `act-${opts.sessionId}-${opts.actorUserId}`,
			userId: opts.actorUserId,
			content: { type: "prompt", body: opts.body },
		},
		agentSession: {
			id: opts.sessionId,
			organizationId: WORKSPACE,
			status: "active",
			type: "issue",
			creator: opts.creator,
			issueId: opts.issue.id,
			issue: {
				id: opts.issue.id,
				identifier: opts.issue.identifier,
				title: opts.issue.title,
				url: `linear://issue/${opts.issue.identifier}`,
				team: { id: "team-1", key: "DEF", name: "Default" },
			},
		},
	} as unknown as AgentEvent;
}

/** Seed a session directly so the CLI tracker's `createAgentActivity` (used by
 * the router to post offline/lock/prompt-rejection notices) finds it. */
function seedSession(
	tracker: CLIIssueTrackerService,
	sessionId: string,
	issueId: string,
): void {
	tracker.getState().agentSessions.set(sessionId, {
		id: sessionId,
		status: AgentSessionStatus.Active,
		type: AgentSessionType.CommentThread,
		createdAt: new Date(),
		updatedAt: new Date(),
		issueId,
	});
}

/** Poll `predicate` until it is true, or throw after `timeoutMs`. */
async function waitUntil(
	predicate: () => boolean,
	label: string,
	timeoutMs = 3000,
): Promise<void> {
	const start = Date.now();
	while (!predicate()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(`waitUntil timed out waiting for: ${label}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/** A device-side stack mirroring what a `cyrus connect`ed machine builds. */
interface DeviceStack {
	connection: RouterConnection;
	transport: RouterEventTransport;
	rpcTracker: RouterIssueTrackerService;
	events: AgentEvent[];
	messages: InternalMessage[];
}

describe("router e2e (in-process server + real client over localhost)", () => {
	let server: RouterServer;
	let tracker: CLIIssueTrackerService;
	let stateDir: string;
	let deviceToken: string;
	let deviceId: number;
	let rpcIssueId: string;
	let stack: DeviceStack;

	function connectDevice(): DeviceStack {
		const connection = new RouterConnection({
			url: `ws://127.0.0.1:${server.port}`,
			deviceToken,
			stateDir,
			reconnectBaseMs: 20,
			rpcTimeoutMs: 2000,
		});
		// Guard against Node throwing on an unhandled "error" emit.
		connection.on("error", () => {});
		const transport = new RouterEventTransport(connection);
		const rpcTracker = new RouterIssueTrackerService(connection, WORKSPACE);
		const events: AgentEvent[] = [];
		const messages: InternalMessage[] = [];
		transport.on("event", (event) => {
			events.push(event);
		});
		transport.on("message", (message) => {
			messages.push(message);
		});
		return { connection, transport, rpcTracker, events, messages };
	}

	async function connectAndWait(): Promise<DeviceStack> {
		const s = connectDevice();
		const connected = once(s.connection, "connected");
		s.connection.connect();
		await connected;
		return s;
	}

	function pending(): number {
		return server.store.pendingEvents(deviceId, 0, Date.now()).length;
	}

	function activityBodies(sessionId: string): string[] {
		return tracker
			.listAgentActivities(sessionId)
			.map((activity) => activity.content);
	}

	beforeAll(async () => {
		tracker = new CLIIssueTrackerService();
		tracker.seedDefaultData();

		// Seed the sessions the router will post notices/rejections to (the CLI
		// tracker validates the session exists before recording an activity).
		seedSession(tracker, "sess-deliver", "issue-deliver");
		seedSession(tracker, "sess-offline", "issue-offline");
		seedSession(tracker, "sess-lock2", "issue-deliver");
		seedSession(tracker, "sess-prompt", "issue-prompt");

		// Seed a real issue for the RPC fetchIssue round-trip.
		const issue = await tracker.createIssue({
			teamId: "team-default",
			title: "RPC round-trip issue",
		});
		rpcIssueId = issue.id;

		stateDir = mkdtempSync(join(tmpdir(), "cyrus-router-e2e-"));

		server = new RouterServer({
			port: 0,
			dbPath: ":memory:",
			workspaces: { [WORKSPACE]: { linearToken: "test-token" } },
			webhook: { verificationMode: "direct", secret: "test-secret" },
			trackerFactory: () => tracker,
			// Large enough that no ping fires mid-test; server.stop() clears it.
			heartbeatMs: 30_000,
			logger: { info: () => {}, warn: () => {} },
		});
		await server.start();
	});

	afterAll(async () => {
		// Disconnect the device and let the server observe it BEFORE tearing the
		// server down, so no live socket's close handler races the store close.
		stack?.connection.close();
		if (stack) {
			await waitUntil(
				() => !server.isDeviceOnline(deviceId),
				"device disconnected before shutdown",
			).catch(() => {});
		}
		await server.stop();
		rmSync(stateDir, { recursive: true, force: true });
	});

	it("1. mints an enrollment code and enrolls a device via POST /enroll", async () => {
		server.store.addUser({
			email: ALICE.email,
			name: ALICE.name,
			linearId: ALICE.id,
		});
		const code = server.store.mintEnrollmentCode(ALICE.email, Date.now());

		const res = await fetch(`http://127.0.0.1:${server.port}/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { deviceToken: string };
		expect(typeof body.deviceToken).toBe("string");
		expect(body.deviceToken.length).toBeGreaterThan(0);

		deviceToken = body.deviceToken;
		const device = server.store.getDeviceByToken(deviceToken);
		expect(device).toBeDefined();
		deviceId = device?.deviceId ?? -1;
		expect(deviceId).toBeGreaterThan(0);
	});

	it("2. routes a created event to the online device and drains the queue, translating to a SessionStart message", async () => {
		stack = await connectAndWait();
		await waitUntil(
			() => server.isDeviceOnline(deviceId),
			"gateway reports device online",
		);

		await server.eventRouter.route(
			createdFixture({
				sessionId: "sess-deliver",
				issue: { id: "issue-deliver", identifier: "DEF-10", title: "Ship it" },
				creator: ALICE,
			}),
		);

		// Legacy "event" path: the raw webhook payload is forwarded verbatim.
		await waitUntil(
			() => stack.events.length >= 1,
			"device received the raw event",
		);
		expect(stack.events[0]?.action).toBe("created");

		// Preferred "message" path: RouterEventTransport translated the raw
		// Linear webhook into a SessionStart internal message (the shape
		// EdgeWorker actually consumes). This is the previously-untested
		// translation seam — assert it round-trips end to end.
		await waitUntil(
			() => stack.messages.length >= 1,
			"device received a translated message",
		);
		const message = stack.messages[0];
		expect(message).toBeDefined();
		if (!message || !isSessionStartMessage(message)) {
			throw new Error(
				`expected a SessionStart message, got ${message?.action}`,
			);
		}
		expect(message.sessionKey).toBe("sess-deliver");
		expect(message.workItemId).toBe("issue-deliver");
		expect(message.workItemIdentifier).toBe("DEF-10");
		expect(message.title).toBe("Ship it");
		expect(message.organizationId).toBe(WORKSPACE);

		// Ack observed: the store drains once the device acks the delivered seq.
		await waitUntil(() => pending() === 0, "server queue drains after ack");
	});

	it("3. queues while offline + posts a one-time waiting notice, then delivers on reconnect", async () => {
		stack.connection.close();
		await waitUntil(
			() => !server.isDeviceOnline(deviceId),
			"gateway observes the disconnect",
		);

		await server.eventRouter.route(
			createdFixture({
				sessionId: "sess-offline",
				issue: {
					id: "issue-offline",
					identifier: "DEF-11",
					title: "Later work",
				},
				creator: ALICE,
			}),
		);

		// Stays queued (device is offline) and the CLI tracker recorded the
		// "Waiting for …" notice exactly once.
		expect(pending()).toBe(1);
		expect(activityBodies("sess-offline")).toContain(
			offlineWaitingMessage(ALICE.email),
		);

		// Reconnect with the same token + stateDir (models a process restart).
		stack = await connectAndWait();

		await waitUntil(
			() => stack.events.length >= 1,
			"reconnected device received the queued event",
		);
		expect(stack.events[0]?.action).toBe("created");
		const message = stack.messages[0];
		if (!message || !isSessionStartMessage(message)) {
			throw new Error(
				`expected a SessionStart message, got ${message?.action}`,
			);
		}
		expect(message.sessionKey).toBe("sess-offline");
		await waitUntil(
			() => pending() === 0,
			"server queue drains after reconnect delivery",
		);
	});

	it("4. rejects a second session on a locked issue and enqueues nothing", async () => {
		// issue-deliver is still locked by sess-deliver (scenario 2, never
		// released). A new session on the same issue must be rejected.
		expect(pending()).toBe(0);
		const eventsBefore = stack.events.length;

		await server.eventRouter.route(
			createdFixture({
				sessionId: "sess-lock2",
				issue: { id: "issue-deliver", identifier: "DEF-10", title: "Ship it" },
				creator: BOB,
			}),
		);

		expect(activityBodies("sess-lock2")).toContain(ISSUE_LOCKED_MESSAGE);
		// Empty queue delta: nothing enqueued, nothing delivered.
		expect(pending()).toBe(0);
		// Give any (erroneous) delivery a chance to arrive before asserting none.
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(stack.events.length).toBe(eventsBefore);
	});

	it("5. enforces creator-only prompting: rejects a non-creator prompt, delivers the creator's prompt as a UserPrompt message", async () => {
		const promptIssue = {
			id: "issue-prompt",
			identifier: "DEF-12",
			title: "Prompt me",
		};

		// Establish the session (and its stored creator) on the online device.
		await server.eventRouter.route(
			createdFixture({
				sessionId: "sess-prompt",
				issue: promptIssue,
				creator: ALICE,
			}),
		);
		await waitUntil(
			() => pending() === 0,
			"created event for sess-prompt delivered + drained",
		);
		const messagesAfterCreate = stack.messages.length;
		const eventsAfterCreate = stack.events.length;

		// Non-creator prompt (actor = Bob) → rejected, nothing delivered.
		await server.eventRouter.route(
			promptedFixture({
				sessionId: "sess-prompt",
				actorUserId: BOB.id,
				creator: ALICE,
				issue: promptIssue,
				body: "let me hijack this",
			}),
		);
		expect(activityBodies("sess-prompt")).toContain(PROMPT_REJECTION_MESSAGE);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(stack.events.length).toBe(eventsAfterCreate);
		expect(pending()).toBe(0);

		// Creator's own prompt (actor = Alice) → delivered + translated into a
		// UserPrompt internal message.
		await server.eventRouter.route(
			promptedFixture({
				sessionId: "sess-prompt",
				actorUserId: ALICE.id,
				creator: ALICE,
				issue: promptIssue,
				body: "please also add tests",
			}),
		);
		await waitUntil(
			() =>
				stack.messages.some(
					(m) => isUserPromptMessage(m) && m.sessionKey === "sess-prompt",
				),
			"creator prompt produced a UserPrompt message on the device",
		);
		expect(stack.messages.length).toBe(messagesAfterCreate + 1);
		const userPrompt = stack.messages.find(
			(m) => isUserPromptMessage(m) && m.sessionKey === "sess-prompt",
		);
		if (!userPrompt || !isUserPromptMessage(userPrompt)) {
			throw new Error("expected a UserPrompt message for sess-prompt");
		}
		expect(userPrompt.content).toBe("please also add tests");
		expect(userPrompt.workItemId).toBe("issue-prompt");
		await waitUntil(
			() => pending() === 0,
			"creator prompt delivered + drained",
		);
	});

	it("6. RPC round-trip + session-scoped authorization", async () => {
		// fetchIssue reaches the router's real CLI tracker and returns the issue.
		const issue = await stack.rpcTracker.fetchIssue(rpcIssueId);
		expect(issue.id).toBe(rpcIssueId);
		expect(issue.identifier).toBe("DEF-1");

		// createAgentActivity against a session THIS device owns (affinity set in
		// scenario 5) succeeds and is recorded on the router-side tracker.
		const beforeCount = tracker.listAgentActivities("sess-prompt").length;
		const ok = (await stack.rpcTracker.createAgentActivity({
			agentSessionId: "sess-prompt",
			content: {
				type: AgentActivityContentType.Thought,
				body: "owned-activity",
			},
		})) as { success?: boolean };
		expect(ok.success).toBe(true);
		expect(tracker.listAgentActivities("sess-prompt").length).toBe(
			beforeCount + 1,
		);

		// createAgentActivity against a session this device does NOT own is
		// rejected by the router's session-scoped authorization check.
		await expect(
			stack.rpcTracker.createAgentActivity({
				agentSessionId: "sess-not-owned",
				content: {
					type: AgentActivityContentType.Thought,
					body: "should be rejected",
				},
			}),
		).rejects.toThrow(/not owned/);
		await expect(
			stack.rpcTracker.createAgentActivity({
				agentSessionId: "sess-not-owned",
				content: {
					type: AgentActivityContentType.Thought,
					body: "should be rejected",
				},
			}),
		).rejects.toBeInstanceOf(RouterRpcError);
	});
});
