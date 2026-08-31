import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentEvent,
	type InternalMessage,
	isIssueStateChangeMessage,
} from "cyrus-core";
import { RouterConnection, RouterEventTransport } from "cyrus-router-client";
import type {
	ContainerExecutor,
	ContainerStatus,
	IssueExecutionContext,
} from "cyrus-router-executors";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createdFixture,
	promptedFixture,
	seedSession,
} from "../../src/router/fixtures.js";
import { createRouterRig, type RouterRig } from "../../src/router/RouterRig.js";

const CREATOR = {
	id: "lin-aca",
	email: "aca@example.com",
	name: "ACA User",
};

function issueStatusChangedFixture(
	issueId: string,
	identifier: string,
): AgentEvent {
	return {
		type: "AppUserNotification",
		action: "issueStatusChanged",
		organizationId: "ws-1",
		createdAt: new Date().toISOString(),
		notification: { issue: { id: issueId, identifier } },
	} as unknown as AgentEvent;
}

function issueRemovedFixture(issueId: string, identifier: string): AgentEvent {
	return {
		type: "Issue",
		action: "remove",
		organizationId: "ws-1",
		createdAt: new Date().toISOString(),
		data: { id: issueId, identifier },
	} as unknown as AgentEvent;
}

interface TerminalCleanup {
	issueKey: string;
	rawEvents: AgentEvent[];
	messages: InternalMessage[];
	order: string[];
	ready: Promise<void>;
	releaseCallback(): void;
	completed: Promise<void>;
}

interface DeviceStack {
	connection: RouterConnection;
	transport: RouterEventTransport;
	rawEvents: AgentEvent[];
	messages: InternalMessage[];
	/**
	 * Resolved by `stop()`/`destroy()` when this stack's connection is closed.
	 *
	 * `RouterConnection.close()` detaches its own socket listeners, so a
	 * connection closed while it is still CONNECTING emits nothing at all —
	 * not `connected`, not `disconnected`, not `error`. Anything awaiting
	 * `once(connection, "connected")` would therefore wait forever. This gate
	 * is how `connectDevice` learns the attempt is over.
	 */
	closed: { promise: Promise<void>; resolve(): void };
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

/**
 * Fake ACA control plane with the real device-side WebSocket stack. Its
 * scripted terminal consumer is the smallest credential-free analogue of the
 * EdgeWorker handler: force-upload a floor, clean local state, then callback.
 */
class RecordingAcaExecutor implements ContainerExecutor {
	readonly provider = "aca";
	readonly ensureRunningCalls: string[] = [];
	readonly createCalls: string[] = [];
	readonly resumeCalls: string[] = [];
	readonly stopCalls: string[] = [];
	readonly destroyCalls: string[] = [];
	readonly tokens = new Map<string, string>();
	readonly stacks = new Map<string, DeviceStack>();
	readonly cleanups = new Map<string, TerminalCleanup>();
	private readonly statuses = new Map<string, ContainerStatus>();

	constructor(
		private readonly getPort: () => number,
		private readonly stateRoot: string,
	) {}

	async ensureRunning(ctx: IssueExecutionContext): Promise<void> {
		this.ensureRunningCalls.push(ctx.issueKey);
		const status = this.statuses.get(ctx.issueKey) ?? "absent";
		if (status === "absent") {
			this.tokens.set(ctx.issueKey, ctx.mintDeviceToken());
			this.createCalls.push(ctx.issueKey);
		} else if (status === "stopped") {
			this.resumeCalls.push(ctx.issueKey);
		} else {
			return;
		}
		this.statuses.set(ctx.issueKey, "running");
		await this.connectDevice(ctx.issueKey);
	}

	async stop(issueKey: string): Promise<void> {
		this.stopCalls.push(issueKey);
		this.closeStack(issueKey);
		this.statuses.set(issueKey, "stopped");
	}

	async destroy(issueKey: string): Promise<void> {
		this.destroyCalls.push(issueKey);
		this.closeStack(issueKey);
		this.stacks.delete(issueKey);
		this.statuses.delete(issueKey);
	}

	/**
	 * Close a stack's connection and release anyone waiting on it. Resolving
	 * the gate BEFORE `close()` keeps the ordering obvious: by the time the
	 * connection is torn down, the waiter is already unblocked.
	 */
	private closeStack(issueKey: string): void {
		const stack = this.stacks.get(issueKey);
		if (!stack) return;
		stack.closed.resolve();
		stack.connection.close();
	}

	async status(issueKey: string): Promise<ContainerStatus> {
		return this.statuses.get(issueKey) ?? "absent";
	}

	async listManaged(): Promise<string[]> {
		return [...this.statuses.keys()];
	}

	private async connectDevice(issueKey: string): Promise<void> {
		const token = this.tokens.get(issueKey);
		if (!token) throw new Error(`missing fake ACA token for ${issueKey}`);
		const connection = new RouterConnection({
			url: `ws://127.0.0.1:${this.getPort()}`,
			deviceToken: token,
			stateDir: join(this.stateRoot, issueKey),
			reconnectBaseMs: 20,
			rpcTimeoutMs: 2_000,
		});
		connection.on("error", () => {});
		const transport = new RouterEventTransport(connection);
		const previous = this.stacks.get(issueKey);
		const stack: DeviceStack = {
			connection,
			transport,
			rawEvents: previous?.rawEvents ?? [],
			messages: previous?.messages ?? [],
			closed: deferred(),
		};
		transport.on("event", (event) => stack.rawEvents.push(event));
		transport.on("message", (message) => {
			stack.messages.push(message);
			if (isIssueStateChangeMessage(message)) {
				this.startTerminalCleanup(issueKey, token, stack);
			}
		});
		this.stacks.set(issueKey, stack);
		// Settle on EITHER outcome. A real executor's `ensureRunning` is always
		// bounded — LocalDockerProvider's `execFile` has a timeout, and
		// AcaSandboxesProvider polls router connectivity against a deadline — so
		// modelling this as an unbounded `await once(connection, "connected")`
		// would be harness infidelity: the idle sweep can legitimately park a
		// container while it is still starting (`stop()` closes this very
		// connection mid-handshake), and that must END the boot attempt, not hang
		// it. Hanging here would leave the router's in-flight boot slot occupied
		// and silently skip every later boot for the device.
		const connected = once(connection, "connected");
		connection.connect();
		await Promise.race([connected, stack.closed.promise]);
	}

	private startTerminalCleanup(
		issueKey: string,
		token: string,
		stack: DeviceStack,
	): void {
		if (this.cleanups.has(issueKey)) return;
		const callbackGate = deferred();
		const readyGate = deferred();
		const order: string[] = [];
		const cleanup: TerminalCleanup = {
			issueKey,
			rawEvents: stack.rawEvents,
			messages: stack.messages,
			order,
			ready: readyGate.promise,
			releaseCallback: callbackGate.resolve,
			completed: Promise.resolve(),
		};
		cleanup.completed = (async () => {
			const localBundle = join(this.stateRoot, `${issueKey}-floor.tar.gz`);
			writeFileSync(localBundle, `forced floor for ${issueKey}`);
			const upload = await fetch(
				`http://127.0.0.1:${this.getPort()}/artifacts/issues/${issueKey}/bundle`,
				{
					method: "PUT",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/gzip",
					},
					body: Buffer.from(`forced floor for ${issueKey}`),
				},
			);
			if (!upload.ok) throw new Error(`floor upload failed: ${upload.status}`);
			order.push("force-floor-upload");
			order.push("stop-sessions");
			order.push("run-teardown");
			order.push("delete-worktree");
			readyGate.resolve();
			await callbackGate.promise;
			order.push("callback");
			const callback = await fetch(
				`http://127.0.0.1:${this.getPort()}/containers/issues/${issueKey}/teardown-complete`,
				{
					method: "POST",
					headers: { authorization: `Bearer ${token}` },
				},
			);
			if (!callback.ok) {
				throw new Error(`teardown callback failed: ${callback.status}`);
			}
		})();
		this.cleanups.set(issueKey, cleanup);
	}
}

describe("F1 router-mode fake ACA lifecycle drive", () => {
	let rig: RouterRig;
	let dir: string;
	let artifactsDir: string;
	let executor: RecordingAcaExecutor;

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "f1-router-aca-"));
		artifactsDir = join(dir, "artifacts");
		executor = new RecordingAcaExecutor(() => rig.port, join(dir, "devices"));
		rig = await createRouterRig({
			dbPath: ":memory:",
			secretsPath: join(dir, "secrets.json"),
			artifactsDir,
			executors: new Map([["aca", executor]]),
			idleStopMs: 0,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			logger: { info: () => {}, warn: () => {} },
		});
		await rig.seedUser({
			email: CREATOR.email,
			linearId: CREATOR.id,
			provider: "aca",
			claudeOauthToken: "fake-aca-token",
		});
	});

	afterAll(async () => {
		await rig.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("drives delegate, prompt, idle-stop, resume, and both terminal webhook teardown paths", async () => {
		const closed = {
			sessionId: "sess-aca-closed",
			issue: { id: "issue-aca-closed", identifier: "ACA-1", title: "Close" },
		};
		seedSession(rig.tracker, closed.sessionId, closed.issue.id);

		await rig.server.eventRouter.route(
			createdFixture({ ...closed, creator: CREATOR }),
		);
		await vi.waitFor(() => expect(executor.createCalls).toContain("ACA-1"));
		expect(rig.server.store.getContainerDeviceForIssue("ACA-1")).toBeDefined();

		await rig.server.eventRouter.route(
			promptedFixture({
				...closed,
				creator: CREATOR,
				actorUserId: CREATOR.id,
				body: "continue before parking",
			}),
		);
		await vi.waitFor(() =>
			expect(executor.stacks.get("ACA-1")?.rawEvents).toHaveLength(2),
		);
		expect(
			executor.ensureRunningCalls.filter((key) => key === "ACA-1"),
		).toHaveLength(1);
		const closedDevice = rig.server.store.getContainerDeviceForIssue("ACA-1");
		expect(closedDevice).toBeDefined();
		rig.server.eventRouter.handleSessionState(closedDevice!.deviceId, {
			type: "session_state",
			id: "ss-aca-closed-1",
			sessionId: closed.sessionId,
			state: "complete",
		});

		await new Promise((resolve) => setTimeout(resolve, 2));
		await rig.server.containerLifecycle?.sweep();
		expect(executor.stopCalls).toContain("ACA-1");
		await vi.waitFor(() =>
			expect(rig.server.isDeviceOnline(closedDevice!.deviceId)).toBe(false),
		);

		await rig.server.eventRouter.route(
			promptedFixture({
				...closed,
				creator: CREATOR,
				actorUserId: CREATOR.id,
				body: "resume after idle stop",
			}),
		);
		await vi.waitFor(() => expect(executor.resumeCalls).toContain("ACA-1"));
		// `resumeCalls` is pushed the moment the executor decides to resume —
		// before the device has reconnected, let alone drained its queue. Gating
		// only on it would park the container again mid-handshake, so this prompt
		// would never be delivered and the "resume after idle stop" leg would be
		// asserting nothing. Wait for the resume to actually complete: the device
		// back on the router, with the queued prompt delivered.
		await vi.waitFor(() => {
			expect(rig.server.isDeviceOnline(closedDevice!.deviceId)).toBe(true);
			expect(executor.stacks.get("ACA-1")?.rawEvents).toHaveLength(3);
		});

		// Park it again so the terminal notification must wake it before teardown.
		rig.server.eventRouter.handleSessionState(closedDevice!.deviceId, {
			type: "session_state",
			id: "ss-aca-closed-2",
			sessionId: closed.sessionId,
			state: "complete",
		});
		await new Promise((resolve) => setTimeout(resolve, 2));
		await rig.server.containerLifecycle?.sweep();
		const resumesBeforeTerminal = executor.resumeCalls.length;
		await vi.waitFor(() =>
			expect(rig.server.isDeviceOnline(closedDevice!.deviceId)).toBe(false),
		);
		const closedStackBeforeTerminal = executor.stacks.get("ACA-1");
		const closedRawBefore = closedStackBeforeTerminal?.rawEvents.length ?? 0;
		const closedMessagesBefore =
			closedStackBeforeTerminal?.messages.length ?? 0;
		await rig.server.eventRouter.route(
			issueStatusChangedFixture(closed.issue.id, closed.issue.identifier),
		);
		await vi.waitFor(() =>
			expect(executor.resumeCalls.length).toBeGreaterThan(
				resumesBeforeTerminal,
			),
		);
		const closedCleanup = await vi.waitFor(() => {
			const cleanup = executor.cleanups.get("ACA-1");
			expect(cleanup).toBeDefined();
			return cleanup!;
		});
		await closedCleanup.ready;
		const closedBundle = join(artifactsDir, "ACA-1", "bundle.tar.gz");
		expect(closedCleanup.rawEvents).toHaveLength(closedRawBefore + 1);
		expect(closedCleanup.rawEvents.at(-1)).toMatchObject({
			type: "AppUserNotification",
			action: "issueStatusChanged",
		});
		expect(closedCleanup.messages).toHaveLength(closedMessagesBefore + 1);
		expect(closedCleanup.messages.at(-1)).toMatchObject({
			action: "issue_state_change",
			workItemId: closed.issue.id,
			workItemIdentifier: closed.issue.identifier,
			isTerminal: true,
		});
		expect(
			rig.server.store.pendingEvents(closedDevice!.deviceId, 0, Date.now()),
		).toHaveLength(0);
		expect(closedCleanup.order).toEqual([
			"force-floor-upload",
			"stop-sessions",
			"run-teardown",
			"delete-worktree",
		]);
		expect(existsSync(closedBundle)).toBe(true);
		expect(executor.destroyCalls).not.toContain("ACA-1");
		closedCleanup.releaseCallback();
		await closedCleanup.completed;
		expect(executor.destroyCalls).toContain("ACA-1");
		expect(closedCleanup.order.at(-1)).toBe("callback");
		expect(
			rig.server.store.getContainerDeviceForIssue("ACA-1"),
		).toBeUndefined();
		expect(existsSync(closedBundle)).toBe(true);
		const closedToken = executor.tokens.get("ACA-1");
		expect(closedToken).toBeDefined();
		const staleClosedUpload = await fetch(
			`http://127.0.0.1:${rig.port}/artifacts/issues/ACA-1/bundle`,
			{
				method: "PUT",
				headers: {
					authorization: `Bearer ${closedToken}`,
					"content-type": "application/gzip",
				},
				body: Buffer.from("stale"),
			},
		);
		expect(staleClosedUpload.status).toBe(401);

		const deleted = {
			sessionId: "sess-aca-deleted",
			issue: { id: "issue-aca-deleted", identifier: "ACA-2", title: "Delete" },
		};
		seedSession(rig.tracker, deleted.sessionId, deleted.issue.id);
		await rig.server.eventRouter.route(
			createdFixture({ ...deleted, creator: CREATOR }),
		);
		await vi.waitFor(() => expect(executor.createCalls).toContain("ACA-2"));
		const deletedDevice = rig.server.store.getContainerDeviceForIssue("ACA-2");
		expect(deletedDevice).toBeDefined();
		rig.server.eventRouter.handleSessionState(deletedDevice!.deviceId, {
			type: "session_state",
			id: "ss-aca-deleted",
			sessionId: deleted.sessionId,
			state: "complete",
		});
		await new Promise((resolve) => setTimeout(resolve, 2));
		await rig.server.containerLifecycle?.sweep();
		await vi.waitFor(() =>
			expect(rig.server.isDeviceOnline(deletedDevice!.deviceId)).toBe(false),
		);
		await rig.server.eventRouter.route(
			issueRemovedFixture(deleted.issue.id, deleted.issue.identifier),
		);
		await vi.waitFor(() => expect(executor.resumeCalls).toContain("ACA-2"));
		const deletedCleanup = await vi.waitFor(() => {
			const cleanup = executor.cleanups.get("ACA-2");
			expect(cleanup).toBeDefined();
			return cleanup!;
		});
		await deletedCleanup.ready;
		const deletedBundle = join(artifactsDir, "ACA-2", "bundle.tar.gz");
		expect(deletedCleanup.rawEvents.at(-1)).toMatchObject({
			type: "Issue",
			action: "remove",
		});
		expect(deletedCleanup.messages.at(-1)).toMatchObject({
			action: "issue_state_change",
			workItemId: deleted.issue.id,
			workItemIdentifier: deleted.issue.identifier,
			isTerminal: true,
		});
		expect(
			rig.server.store.pendingEvents(deletedDevice!.deviceId, 0, Date.now()),
		).toHaveLength(0);
		expect(existsSync(deletedBundle)).toBe(true);
		expect(executor.destroyCalls).not.toContain("ACA-2");
		const deletedToken = executor.tokens.get("ACA-2");
		expect(deletedToken).toBeDefined();
		deletedCleanup.releaseCallback();
		await deletedCleanup.completed;
		expect(deletedCleanup.order).toEqual([
			"force-floor-upload",
			"stop-sessions",
			"run-teardown",
			"delete-worktree",
			"callback",
		]);
		expect(executor.destroyCalls).toContain("ACA-2");
		expect(
			rig.server.store.getContainerDeviceForIssue("ACA-2"),
		).toBeUndefined();
		expect(existsSync(deletedBundle)).toBe(false);
		const staleDeletedCallback = await fetch(
			`http://127.0.0.1:${rig.port}/containers/issues/ACA-2/teardown-complete`,
			{ method: "POST", headers: { authorization: `Bearer ${deletedToken}` } },
		);
		expect(staleDeletedCallback.status).toBe(401);
	});
});
