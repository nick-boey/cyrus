/**
 * Multi-turn container test for TODO item 5 — "Stabilize MCP connections in
 * long-lived and restored workers".
 *
 * The live ACA drive reported that the Linear and `cyrus-tools` MCP servers
 * disconnected and reconnected mid-session. In router mode both of those servers
 * are ultimately backed by the SAME transport: `cyrus-tools` runs in-process
 * against an `IIssueTrackerService`, and in a container that tracker is a
 * `RouterIssueTrackerService` whose every call is a WebSocket RPC to the router.
 * So "does Linear MCP still work after a reconnect?" is, concretely, "does a
 * tracker RPC still work after the device socket has been torn down and
 * re-established?".
 *
 * This suite drives exactly that, end to end, against a real
 * {@link RouterServer} over a real localhost WebSocket:
 *
 *   turn 1  → boot, deliver `created`, invoke Linear MCP (`createComment`)
 *   idle    → release affinity, real `ContainerLifecycle.sweep()` idle-stops the
 *             container, executor closes the socket
 *   gap     → an MCP call attempted while disconnected fails fast (retryable)
 *             rather than hanging
 *   turn 2  → deliver `prompted`, container boots again on the SAME device row,
 *             receives the queued prompt, invokes Linear MCP again
 *
 * Uses the `executorRegistryFactory` seam and a fake executor (the same pattern
 * as `containers-e2e.test.ts`), so it needs no Docker daemon and no network, and
 * runs as part of the default suite. The real-Docker variant of this flow stays
 * in `containers-real-docker.e2e.test.ts` behind its opt-in gate.
 */

import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentEvent,
	CLIIssueTrackerService,
	type CLIIssueTrackerService as CLIIssueTrackerServiceType,
} from "cyrus-core";
import {
	RouterConnection,
	RouterEventTransport,
	RouterIssueTrackerService,
} from "cyrus-router-client";
import type {
	ContainerExecutor,
	ContainerStatus,
	IssueExecutionContext,
} from "cyrus-router-executors";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ContainerLifecycle } from "../src/ContainerLifecycle.js";
import {
	type RouterContainersConfig,
	RouterServer,
} from "../src/RouterServer.js";
import { SecretStore } from "../src/SecretStore.js";
import {
	createdFixture,
	seedIssue,
	seedSession,
	WORKSPACE,
} from "./helpers/fixtures.js";

const IDLE_STOP_MS = 60_000;
const STALE_DESTROY_MS = 14 * 24 * 60 * 60_000;

const ISSUE = {
	id: "issue-mcp-1",
	identifier: "CYMCP-1",
	title: "MCP survives a reconnect",
};
const CREATOR = {
	id: "lin-mcp",
	email: "mcp@example.com",
	name: "Mcp",
};

/** A minimal but type-guard-valid agentSessionPrompted webhook fixture. */
function promptedFixture(opts: {
	sessionId: string;
	body: string;
}): AgentEvent {
	return {
		type: "AgentSessionEvent",
		action: "prompted",
		organizationId: WORKSPACE,
		createdAt: new Date().toISOString(),
		agentActivity: {
			id: `act-${opts.sessionId}-${CREATOR.id}`,
			userId: CREATOR.id,
			content: { type: "prompt", body: opts.body },
		},
		agentSession: {
			id: opts.sessionId,
			organizationId: WORKSPACE,
			status: "active",
			type: "issue",
			creator: CREATOR,
			issueId: ISSUE.id,
			issue: {
				id: ISSUE.id,
				identifier: ISSUE.identifier,
				title: ISSUE.title,
				url: `linear://issue/${ISSUE.identifier}`,
				team: { id: "team-1", key: "DEF", name: "Default" },
			},
		},
	} as unknown as AgentEvent;
}

/**
 * The device-side half of a worker container: a real `RouterConnection` plus the
 * two things a container builds on top of it — a `RouterEventTransport` (how
 * webhooks arrive) and a `RouterIssueTrackerService` (what `cyrus-tools` /
 * Linear MCP calls go through in router mode).
 */
interface DeviceStack {
	connection: RouterConnection;
	transport: RouterEventTransport;
	tracker: RouterIssueTrackerService;
	events: AgentEvent[];
	/** Incremented every time this stack completes a hello handshake. */
	connects: number;
	/**
	 * Sessions this worker is running, as a real worker's session map would
	 * report them. Backs both the hello `activeSessions` list and the
	 * `sessions_report` reply the router's affinity reconciliation reads.
	 */
	sessions: Set<string>;
}

async function connectDevice(
	port: number,
	deviceToken: string,
	stateDir: string,
	/** Shared across boots for an issue, like a worker's persistent session map. */
	sessions?: Set<string>,
): Promise<DeviceStack> {
	mkdirSync(stateDir, { recursive: true });
	const liveSessions = sessions ?? new Set<string>();
	const connection = new RouterConnection({
		url: `ws://127.0.0.1:${port}`,
		deviceToken,
		stateDir,
		reconnectBaseMs: 20,
		rpcTimeoutMs: 2000,
		// Only wired when the caller opts in: declaring sessions also enables
		// hello-time lock reconciliation, which the older scenarios in this file
		// deliberately do not exercise.
		...(sessions ? { getActiveSessions: () => [...liveSessions] } : {}),
	});
	connection.on("error", () => {});
	const stack: DeviceStack = {
		connection,
		transport: new RouterEventTransport(connection),
		tracker: new RouterIssueTrackerService(connection, WORKSPACE),
		events: [],
		connects: 0,
		sessions: liveSessions,
	};
	connection.on("connected", () => {
		stack.connects += 1;
	});
	stack.transport.on("event", (event) => {
		stack.events.push(event);
	});
	const connected = once(connection, "connected");
	connection.connect();
	await connected;
	return stack;
}

/**
 * A `ContainerExecutor` that models the suspend/resume shape this test needs:
 * `stop()` tears the device socket down (an idle-stopped container has no
 * process, so its WebSocket is gone), and a subsequent `ensureRunning()` boots a
 * NEW connection with a freshly minted device token against the SAME persistent
 * state dir — exactly what a restarted container does off its warm volume.
 */
class ReconnectingExecutor implements ContainerExecutor {
	readonly provider = "docker";
	readonly ensureRunningCalls: string[] = [];
	readonly stopCalls: string[] = [];
	/** Every stack ever connected for an issue key, oldest first. */
	readonly stacksByIssue = new Map<string, DeviceStack[]>();
	private readonly statuses = new Map<string, ContainerStatus>();

	/** Per-issue session sets, surviving reboots like a worker's warm volume. */
	private readonly sessionsByIssue = new Map<string, Set<string>>();

	constructor(
		private readonly getPort: () => number,
		private readonly stateDirRoot: string,
		/** Opt-in: boot workers that declare their sessions to the router. */
		private readonly declareSessions = false,
	) {}

	async ensureRunning(ctx: IssueExecutionContext): Promise<void> {
		this.ensureRunningCalls.push(ctx.issueKey);
		if (this.statuses.get(ctx.issueKey) === "running") return;
		let sessions = this.sessionsByIssue.get(ctx.issueKey);
		if (this.declareSessions && !sessions) {
			sessions = new Set<string>();
			this.sessionsByIssue.set(ctx.issueKey, sessions);
		}
		const stack = await connectDevice(
			this.getPort(),
			ctx.mintDeviceToken(),
			// Same state dir across boots — the warm-volume fast path.
			join(this.stateDirRoot, ctx.issueKey),
			sessions,
		);
		const stacks = this.stacksByIssue.get(ctx.issueKey) ?? [];
		stacks.push(stack);
		this.stacksByIssue.set(ctx.issueKey, stacks);
		this.statuses.set(ctx.issueKey, "running");
	}

	async stop(issueKey: string): Promise<void> {
		this.stopCalls.push(issueKey);
		this.statuses.set(issueKey, "stopped");
		// A stopped container's socket is gone. `close()` (not `terminate`) so the
		// client does not auto-reconnect behind the executor's back — the next boot
		// is what brings it back, as in production.
		this.current(issueKey)?.connection.close();
	}

	async destroy(issueKey: string): Promise<void> {
		this.statuses.delete(issueKey);
		for (const stack of this.stacksByIssue.get(issueKey) ?? []) {
			stack.connection.close();
		}
		this.stacksByIssue.delete(issueKey);
	}

	async status(issueKey: string): Promise<ContainerStatus> {
		return this.statuses.get(issueKey) ?? "absent";
	}

	async listManaged(): Promise<string[]> {
		return [...this.stacksByIssue.keys()];
	}

	/** The most recently connected stack for an issue. */
	current(issueKey: string): DeviceStack | undefined {
		return this.stacksByIssue.get(issueKey)?.at(-1);
	}

	closeAll(): void {
		for (const stacks of this.stacksByIssue.values()) {
			for (const stack of stacks) stack.connection.close();
		}
	}
}

describe("container MCP calls survive an idle/reconnect cycle (real RouterServer + real WebSocket)", () => {
	let server: RouterServer;
	let tracker: CLIIssueTrackerServiceType;
	let executor: ReconnectingExecutor;
	let stateDir: string;
	let secretsDir: string;

	beforeAll(async () => {
		tracker = new CLIIssueTrackerService();
		tracker.seedDefaultData();
		// The device fetches the issue over RPC before commenting on it, and the
		// router posts notices onto the sessions — seed both.
		seedIssue(tracker, ISSUE);
		seedSession(tracker, "sess-mcp-1", ISSUE.id);
		seedSession(tracker, "sess-mcp-2", ISSUE.id);

		stateDir = mkdtempSync(join(tmpdir(), "cyrus-router-mcp-reconnect-"));
		secretsDir = mkdtempSync(join(tmpdir(), "cyrus-router-mcp-secrets-"));
		const secretsPath = join(secretsDir, "user-secrets.json");
		const secrets = new SecretStore(secretsPath);

		executor = new ReconnectingExecutor(
			() => server.port,
			join(stateDir, "devices"),
		);

		const containers: RouterContainersConfig = {
			image: "cyrus-worker:test",
			routerUrlForContainers: "ws://host.docker.internal:3456",
			repositories: [
				{
					name: "cyrus",
					githubSlug: "ceedaragents/cyrus",
					linearWorkspaceId: WORKSPACE,
					baseBranch: "main",
				},
			],
			secretsPath,
			// dbPath below is ":memory:" (dirname "."); without this override,
			// seeding the registry at construction would write into the package
			// directory instead of `stateDir`.
			repositoriesPath: join(stateDir, "repositories.json"),
			idleStopMs: IDLE_STOP_MS,
			staleDestroyMs: STALE_DESTROY_MS,
			offlineAgeOutMs: 3_600_000,
		};

		server = new RouterServer({
			port: 0,
			dbPath: ":memory:",
			workspaces: { [WORKSPACE]: { linearToken: "test-token" } },
			webhook: { verificationMode: "direct", secret: "test-secret" },
			trackerFactory: () => tracker,
			heartbeatMs: 30_000,
			logger: { info: () => {}, warn: () => {} },
			containers,
			executorRegistryFactory: () =>
				new Map<string, ContainerExecutor>([["docker", executor]]),
		});
		await server.start();

		server.store.addUser({ email: CREATOR.email, linearId: CREATOR.id });
		server.store.setUserExecutor(
			CREATOR.email,
			JSON.stringify({ type: "docker" }),
		);
		secrets.set(CREATOR.email, "claudeOauthToken", "fake-claude-token");
	});

	afterAll(async () => {
		executor?.closeAll();
		await server?.stop();
		rmSync(stateDir, { recursive: true, force: true });
		rmSync(secretsDir, { recursive: true, force: true });
	});

	it("turn 1: the booted container receives the created event and Linear MCP completes over the router", async () => {
		await server.eventRouter.route(
			createdFixture({
				sessionId: "sess-mcp-1",
				issue: ISSUE,
				creator: CREATOR,
			}),
		);

		await vi.waitFor(() =>
			expect(
				server.store.getContainerDeviceForIssue(ISSUE.identifier),
			).toMatchObject({ provider: "docker" }),
		);
		await vi.waitFor(
			() => expect(executor.current(ISSUE.identifier)).toBeDefined(),
			{ timeout: 3000 },
		);

		const stack = executor.current(ISSUE.identifier);
		if (!stack) throw new Error("expected a connected device stack");
		await vi.waitFor(() => expect(stack.events).toHaveLength(1));
		expect(stack.events[0]?.action).toBe("created");

		// The Linear MCP call. In router mode `mcp__cyrus-tools__*` /
		// `mcp__linear__*` reach Linear through exactly this tracker RPC.
		const issue = await stack.tracker.fetchIssue(ISSUE.id);
		expect(issue.identifier).toBe(ISSUE.identifier);
		const comment = await stack.tracker.createComment(ISSUE.id, {
			body: "linear-mcp-ok turn 1",
		});
		expect(comment.body).toBe("linear-mcp-ok turn 1");

		// …and it really landed on the tracker the router owns.
		expect(
			[...tracker.getState().comments.values()].map((c) => c.body),
		).toEqual(["linear-mcp-ok turn 1"]);
	});

	it("idle cycle: releasing affinity lets the real lifecycle sweep idle-stop the container, taking its socket with it", async () => {
		const device = server.store.getContainerDeviceForIssue(ISSUE.identifier);
		if (!device) throw new Error("expected turn 1's device row");
		const stack = executor.current(ISSUE.identifier);
		if (!stack) throw new Error("expected turn 1's device stack");

		expect(
			server.store.countSessionAffinityForDevice(device.deviceId),
		).toBeGreaterThan(0);

		// Turn 1 finishes: the terminal frame is the only thing that releases the
		// router's affinity, and idle-stop refuses to touch a device that holds any.
		stack.connection.sendSessionState("sess-mcp-1", "complete");
		await vi.waitFor(() =>
			expect(server.store.countSessionAffinityForDevice(device.deviceId)).toBe(
				0,
			),
		);

		// RouterServer's own lifecycle runs on the real clock, so build a second
		// one over the SAME store/executor with an injected clock — the technique
		// containers-e2e.test.ts uses.
		const lifecycle = new ContainerLifecycle({
			store: server.store,
			executors: new Map<string, ContainerExecutor>([["docker", executor]]),
			idleStopMs: IDLE_STOP_MS,
			staleDestroyMs: STALE_DESTROY_MS,
			offlineAgeOutMs: 3_600_000,
			logger: { info: () => {}, warn: () => {} },
			now: () => Date.now() + IDLE_STOP_MS + 5_000,
		});
		await lifecycle.sweep();

		expect(executor.stopCalls).toContain(ISSUE.identifier);
		await vi.waitFor(() =>
			expect(server.isDeviceOnline(device.deviceId)).toBe(false),
		);
	});

	it("gap: an MCP call attempted while the container is stopped fails fast instead of hanging", async () => {
		const stack = executor.current(ISSUE.identifier);
		if (!stack) throw new Error("expected the stopped device stack");

		// Predictable failure, not a 2s timeout and not a silent hang: this is the
		// behaviour the retry/backoff policy in `cyrus-core` is built to classify
		// (`not connected` → transient → bounded retry).
		await expect(stack.tracker.fetchIssue(ISSUE.id)).rejects.toThrow(
			/not connected/i,
		);
	});

	it("turn 2: the same issue boots again, drains the queued prompt, and Linear MCP completes on the new connection", async () => {
		const deviceBefore = server.store.getContainerDeviceForIssue(
			ISSUE.identifier,
		);
		if (!deviceBefore) throw new Error("expected the pre-reconnect device row");
		const stacksBefore =
			executor.stacksByIssue.get(ISSUE.identifier)?.length ?? 0;

		await server.eventRouter.route(
			promptedFixture({
				sessionId: "sess-mcp-2",
				body: "still there after the idle stop?",
			}),
		);

		// A second, distinct device stack — the reconnect.
		await vi.waitFor(
			() =>
				expect(executor.stacksByIssue.get(ISSUE.identifier)?.length ?? 0).toBe(
					stacksBefore + 1,
				),
			{ timeout: 3000 },
		);
		const stack = executor.current(ISSUE.identifier);
		if (!stack) throw new Error("expected the reconnected device stack");
		expect(stack.connects).toBe(1);

		// Same container identity across the cycle: the device row is reused, so
		// this is a resume of one worker rather than a second worker for one issue.
		expect(
			server.store.getContainerDeviceForIssue(ISSUE.identifier)?.deviceId,
		).toBe(deviceBefore.deviceId);

		// The prompt queued while the container was stopped is delivered on hello.
		await vi.waitFor(() => expect(stack.events.length).toBeGreaterThan(0));
		expect(stack.events.map((e) => e.action)).toContain("prompted");

		// The MCP call that failed during the gap now succeeds on the new socket.
		const issue = await stack.tracker.fetchIssue(ISSUE.id);
		expect(issue.identifier).toBe(ISSUE.identifier);
		const comment = await stack.tracker.createComment(ISSUE.id, {
			body: "linear-mcp-ok turn 2",
		});
		expect(comment.body).toBe("linear-mcp-ok turn 2");

		// Both turns' mutations are present, in order, exactly once each — no
		// duplication from the queued-event replay and no loss from the reconnect.
		expect(
			[...tracker.getState().comments.values()].map((c) => c.body),
		).toEqual(["linear-mcp-ok turn 1", "linear-mcp-ok turn 2"]);
	});

	// ── the PAR-146 cycle ──────────────────────────────────────────────────
	// Turn 2 is still open: the agent asked the user a question, so the SDK
	// query never returned and no terminal frame will ever be sent. Before
	// `parked` existed the router held this device's affinity forever and the
	// container ran indefinitely — 41 minutes at 4 vCPU / 8 GiB, in the real
	// incident. The park releases affinity WITHOUT ending the session.

	it("park cycle: a parked session releases affinity but keeps its issue lock", async () => {
		const device = server.store.getContainerDeviceForIssue(ISSUE.identifier);
		if (!device) throw new Error("expected turn 2's device row");
		const stack = executor.current(ISSUE.identifier);
		if (!stack) throw new Error("expected turn 2's device stack");

		expect(
			server.store.countSessionAffinityForDevice(device.deviceId),
		).toBeGreaterThan(0);
		server.store.acquireIssueLock(ISSUE.id, "sess-mcp-2", device.deviceId);

		stack.connection.sendSessionState("sess-mcp-2", "parked");

		await vi.waitFor(() =>
			expect(server.store.countSessionAffinityForDevice(device.deviceId)).toBe(
				0,
			),
		);
		// Not finished — a different session must not be able to claim the issue.
		expect(
			server.store.acquireIssueLock(ISSUE.id, "sess-other", device.deviceId),
		).toBe(false);
		// And the park time is recorded for the idle clock.
		expect(
			server.store.getContainerDeviceForIssue(ISSUE.identifier)?.parkedAtMs,
		).toBeGreaterThan(0);
	});

	it("park cycle: the real sweep idle-stops the parked container once past idleStopMs", async () => {
		const device = server.store.getContainerDeviceForIssue(ISSUE.identifier);
		if (!device) throw new Error("expected the parked device row");
		const parkedAtMs = device.parkedAtMs;
		if (parkedAtMs === undefined) throw new Error("expected a park stamp");

		const stopsBefore = executor.stopCalls.filter(
			(k) => k === ISSUE.identifier,
		).length;

		// Just before the threshold, measured from the PARK — not from the last
		// route, which is what would otherwise have expired long ago.
		const early = new ContainerLifecycle({
			store: server.store,
			executors: new Map<string, ContainerExecutor>([["docker", executor]]),
			idleStopMs: IDLE_STOP_MS,
			staleDestroyMs: STALE_DESTROY_MS,
			offlineAgeOutMs: 3_600_000,
			logger: { info: () => {}, warn: () => {} },
			now: () => parkedAtMs + IDLE_STOP_MS - 1,
		});
		await early.sweep();
		expect(
			executor.stopCalls.filter((k) => k === ISSUE.identifier).length,
		).toBe(stopsBefore);

		// Past it, the container is suspended.
		const late = new ContainerLifecycle({
			store: server.store,
			executors: new Map<string, ContainerExecutor>([["docker", executor]]),
			idleStopMs: IDLE_STOP_MS,
			staleDestroyMs: STALE_DESTROY_MS,
			offlineAgeOutMs: 3_600_000,
			logger: { info: () => {}, warn: () => {} },
			now: () => parkedAtMs + IDLE_STOP_MS + 1,
		});
		await late.sweep();
		expect(
			executor.stopCalls.filter((k) => k === ISSUE.identifier).length,
		).toBe(stopsBefore + 1);
		await vi.waitFor(() =>
			expect(server.isDeviceOnline(device.deviceId)).toBe(false),
		);
	});

	it("park cycle: the user's answer resumes the same container and clears the park stamp", async () => {
		const deviceBefore = server.store.getContainerDeviceForIssue(
			ISSUE.identifier,
		);
		if (!deviceBefore) throw new Error("expected the parked device row");
		const stacksBefore =
			executor.stacksByIssue.get(ISSUE.identifier)?.length ?? 0;

		await server.eventRouter.route(
			promptedFixture({ sessionId: "sess-mcp-2", body: "CSV only" }),
		);

		await vi.waitFor(
			() =>
				expect(executor.stacksByIssue.get(ISSUE.identifier)?.length ?? 0).toBe(
					stacksBefore + 1,
				),
			{ timeout: 3000 },
		);

		// Same device row: a resume of one worker, not a replacement.
		const deviceAfter = server.store.getContainerDeviceForIssue(
			ISSUE.identifier,
		);
		expect(deviceAfter?.deviceId).toBe(deviceBefore.deviceId);
		// Affinity is back and the stamp is cleared, so the sweep will not
		// immediately re-stop the container it just woke.
		expect(
			server.store.countSessionAffinityForDevice(deviceBefore.deviceId),
		).toBeGreaterThan(0);
		expect(deviceAfter?.parkedAtMs).toBeUndefined();
	});
});

/**
 * End-to-end PAR-146: a session that already finished leaves an affinity row
 * behind (routePrompted re-establishes affinity for every prompt, takes no
 * issue lock, and logs nothing), and the sweep's `affinity > 0` gate then skips
 * the device forever. The container ran 28+ minutes at 4 vCPU / 8 GiB.
 *
 * The full stack is real here: a real RouterServer, a real WebSocket, and a
 * real worker that answers `sessions_query` from its own session set. Only the
 * clock is injected.
 */
describe("a leaked affinity row no longer pins a parked container (real RouterServer + real WebSocket)", () => {
	const LEAK_ISSUE = {
		id: "issue-leak-1",
		identifier: "CYLEAK-1",
		title: "A leaked affinity row must not pin the container",
	};

	let server: RouterServer;
	let tracker: CLIIssueTrackerServiceType;
	let executor: ReconnectingExecutor;
	let stateDir: string;
	let secretsDir: string;

	beforeAll(async () => {
		tracker = new CLIIssueTrackerService();
		tracker.seedDefaultData();
		seedIssue(tracker, LEAK_ISSUE);
		seedSession(tracker, "sess-leak-live", LEAK_ISSUE.id);

		stateDir = mkdtempSync(join(tmpdir(), "cyrus-router-leak-"));
		secretsDir = mkdtempSync(join(tmpdir(), "cyrus-router-leak-secrets-"));
		const secretsPath = join(secretsDir, "user-secrets.json");
		const secrets = new SecretStore(secretsPath);

		// `declareSessions` boots workers that report their live session set —
		// exactly what a real worker does, and what reconciliation reads.
		executor = new ReconnectingExecutor(
			() => server.port,
			join(stateDir, "devices"),
			true,
		);

		const containers: RouterContainersConfig = {
			image: "cyrus-worker:test",
			routerUrlForContainers: "ws://host.docker.internal:3456",
			repositories: [
				{
					name: "cyrus",
					githubSlug: "ceedaragents/cyrus",
					linearWorkspaceId: WORKSPACE,
					baseBranch: "main",
				},
			],
			secretsPath,
			// dbPath below is ":memory:" (dirname "."); without this override,
			// seeding the registry at construction would write into the package
			// directory instead of `stateDir`.
			repositoriesPath: join(stateDir, "repositories.json"),
			idleStopMs: IDLE_STOP_MS,
			staleDestroyMs: STALE_DESTROY_MS,
			offlineAgeOutMs: 3_600_000,
		};

		server = new RouterServer({
			port: 0,
			dbPath: ":memory:",
			workspaces: { [WORKSPACE]: { linearToken: "test-token" } },
			webhook: { verificationMode: "direct", secret: "test-secret" },
			trackerFactory: () => tracker,
			heartbeatMs: 30_000,
			logger: { info: () => {}, warn: () => {} },
			containers,
			executorRegistryFactory: () =>
				new Map<string, ContainerExecutor>([["docker", executor]]),
		});
		await server.start();

		server.store.addUser({ email: CREATOR.email, linearId: CREATOR.id });
		server.store.setUserExecutor(
			CREATOR.email,
			JSON.stringify({ type: "docker" }),
		);
		secrets.set(CREATOR.email, "claudeOauthToken", "fake-claude-token");
	});

	afterAll(async () => {
		executor?.closeAll();
		await server?.stop();
		rmSync(stateDir, { recursive: true, force: true });
		rmSync(secretsDir, { recursive: true, force: true });
	});

	it("idle-stops a parked container that a leaked affinity row is pinning", async () => {
		await server.eventRouter.route(
			createdFixture({
				sessionId: "sess-leak-live",
				issue: LEAK_ISSUE,
				creator: CREATOR,
			}),
		);

		await vi.waitFor(
			() => expect(executor.current(LEAK_ISSUE.identifier)).toBeDefined(),
			{ timeout: 3000 },
		);
		const device = server.store.getContainerDeviceForIssue(
			LEAK_ISSUE.identifier,
		);
		if (!device) throw new Error("expected a container device row");
		const stack = executor.current(LEAK_ISSUE.identifier);
		if (!stack) throw new Error("expected a device stack");

		// The worker picks the routed session up and starts tracking it.
		stack.sessions.add("sess-leak-live");

		// …and a session that finished long ago leaves its row behind. Nothing
		// will ever clear it: no terminal frame is coming, and it holds no lock.
		const leakedEstablishedMs = Date.now() - 60 * 60_000;
		server.store.setSessionAffinity(
			"sess-leak-orphan",
			device.deviceId,
			undefined,
			leakedEstablishedMs,
		);

		// The live session parks on a question. Affinity for it is released, the
		// park stamp is set — and the leaked row is all that is left.
		stack.sessions.delete("sess-leak-live");
		stack.connection.sendSessionState("sess-leak-live", "parked");

		await vi.waitFor(() =>
			expect(server.store.countSessionAffinityForDevice(device.deviceId)).toBe(
				1,
			),
		);
		const parkedAtMs = server.store.getContainerDeviceForIssue(
			LEAK_ISSUE.identifier,
		)?.parkedAtMs;
		if (parkedAtMs === undefined) throw new Error("expected a park stamp");

		// The real sweep, wired exactly as RouterServer wires it — the reconciler
		// asks the live worker over the real socket — with only the clock injected.
		const sweep = new ContainerLifecycle({
			store: server.store,
			executors: new Map<string, ContainerExecutor>([["docker", executor]]),
			idleStopMs: IDLE_STOP_MS,
			staleDestroyMs: STALE_DESTROY_MS,
			offlineAgeOutMs: 3_600_000,
			logger: { info: () => {}, warn: () => {} },
			now: () => parkedAtMs + IDLE_STOP_MS + 1,
			sessionReconciler: {
				isOnline: (deviceId) => server.isDeviceOnline(deviceId),
				reconcile: async (deviceId) =>
					server.eventRouter.reconcileDeviceAffinity(
						deviceId,
						await server.queryDeviceSessions(deviceId, 2_000),
						Date.now(),
					),
			},
		});

		await sweep.sweep();

		expect(await executor.status(LEAK_ISSUE.identifier)).toBe("stopped");
		expect(server.store.countSessionAffinityForDevice(device.deviceId)).toBe(0);
	});
});
