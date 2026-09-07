/**
 * In-process end-to-end integration test for the router's ephemeral container
 * executor path (Phase 1 of the container-executors design). Follows the same
 * harness pattern as `e2e.test.ts`: a real {@link RouterServer} on an
 * ephemeral port, backed by a single {@link CLIIssueTrackerService} (via
 * `trackerFactory`) so Linear is never touched, driven by webhook fixtures fed
 * straight into `server.eventRouter.route(...)`.
 *
 * The one thing this suite adds beyond `e2e.test.ts`: instead of a physical
 * enrolled device, it exercises the container-executor routing path via the
 * `executorRegistryFactory` seam (added in Task 8 specifically so this suite
 * never has to shell out to a real Docker daemon). `FakeBootExecutor` is a
 * `ContainerExecutor` whose `ensureRunning` mints a device token via
 * `ctx.mintDeviceToken()` (the ONLY way to obtain a valid token — the initial
 * `createContainerDevice` token is private to the store) and connects a real
 * `RouterConnection` device stack over the same localhost WebSocket a real
 * `cyrus-worker` container would use, so the queue-drain / idle-stop /
 * executor-switch / boot-failure paths are all exercised through genuine
 * WebSocket delivery rather than mocked RPC calls.
 */

import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentEvent,
	AgentSessionStatus,
	AgentSessionType,
	CLIIssueTrackerService,
} from "cyrus-core";
import { RouterConnection, RouterEventTransport } from "cyrus-router-client";
import type {
	ContainerExecutor,
	ContainerStatus,
	IssueExecutionContext,
} from "cyrus-router-executors";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ContainerLifecycle } from "../src/ContainerLifecycle.js";
import { containerBootFailedMessage } from "../src/messages.js";
import {
	type RouterContainersConfig,
	RouterServer,
} from "../src/RouterServer.js";
import { SecretStore } from "../src/SecretStore.js";
import { silentLogger } from "./helpers/logger.js";

const WORKSPACE = "ws-1";
/** Small so scenario 2 can assert idle-stop without a real 15-minute wait —
 * the assertion uses an injected clock (see scenario 2), not a real sleep, so
 * the value only needs to be smaller than staleDestroyMs by a wide margin. */
const IDLE_STOP_MS = 60_000;
const STALE_DESTROY_MS = 14 * 24 * 60 * 60_000;

interface Creator {
	id: string;
	email: string;
	name: string;
}

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
 * the router to post offline/lock/boot-failure notices) finds it. */
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

/** A device-side stack mirroring what a real `cyrus-worker` container builds:
 * a `RouterConnection` + `RouterEventTransport` over a real localhost
 * WebSocket, exactly like `e2e.test.ts`'s physical-device stack. */
interface DeviceStack {
	connection: RouterConnection;
	transport: RouterEventTransport;
	events: AgentEvent[];
}

function connectFakeDevice(
	port: number,
	deviceToken: string,
	stateDir: string,
	/**
	 * Supplying this is what makes the fake worker ADVERTISE
	 * `sessions_query` and answer it — `RouterConnection` gates the capability
	 * on having a provider, since advertising with nothing to answer from would
	 * make the router wait out its timeout every time. Omitted by the scenarios
	 * that predate it, so their behaviour is unchanged.
	 */
	getActiveSessions?: () => string[],
): DeviceStack {
	mkdirSync(stateDir, { recursive: true });
	const connection = new RouterConnection({
		url: `ws://127.0.0.1:${port}`,
		deviceToken,
		stateDir,
		reconnectBaseMs: 20,
		rpcTimeoutMs: 2000,
		...(getActiveSessions ? { getActiveSessions } : {}),
	});
	// Guard against Node throwing on an unhandled "error" emit.
	connection.on("error", () => {});
	const transport = new RouterEventTransport(connection);
	const events: AgentEvent[] = [];
	transport.on("event", (event) => {
		events.push(event);
	});
	return { connection, transport, events };
}

/**
 * `ContainerExecutor` test double injected via `executorRegistryFactory` (the
 * Task 8 seam) so this suite never shells out to a real Docker daemon.
 *
 * `ensureRunning` mints a device token via `ctx.mintDeviceToken()` — the only
 * way a caller can learn a connectable token, since the initial token minted
 * by `RouterStore.createContainerDevice` is never handed back to
 * `ContainerTargetService`'s callers — and connects a scripted WS device
 * stack with it, mirroring what a real `cyrus-worker` container's entrypoint
 * does on boot.
 */
class FakeBootExecutor implements ContainerExecutor {
	readonly ensureRunningCalls: IssueExecutionContext[] = [];
	readonly stopCalls: string[] = [];
	readonly destroyCalls: string[] = [];
	readonly stacks = new Map<string, DeviceStack>();
	private readonly statuses = new Map<string, ContainerStatus>();
	/** Set by scenario 4 to simulate a container that never boots. */
	shouldFail = false;

	constructor(
		readonly provider: string,
		private readonly getPort: () => number,
		private readonly stateDirRoot: string,
		/**
		 * What the booted worker declares it is running. Set only by the recovery
		 * suite, which needs a worker that can be ASKED — a stranded container's
		 * replacement worker reports nothing, and that is what licenses the
		 * release.
		 */
		private readonly getActiveSessions?: () => string[],
	) {}

	async ensureRunning(ctx: IssueExecutionContext): Promise<void> {
		this.ensureRunningCalls.push(ctx);
		if (this.shouldFail) {
			throw new Error("fake docker daemon unreachable");
		}
		const token = ctx.mintDeviceToken();
		const stack = connectFakeDevice(
			this.getPort(),
			token,
			join(this.stateDirRoot, ctx.issueKey),
			this.getActiveSessions,
		);
		const connected = once(stack.connection, "connected");
		stack.connection.connect();
		await connected;
		this.stacks.set(ctx.issueKey, stack);
		this.statuses.set(ctx.issueKey, "running");
	}

	async stop(issueKey: string): Promise<void> {
		this.stopCalls.push(issueKey);
		this.statuses.set(issueKey, "stopped");
	}

	async destroy(issueKey: string): Promise<void> {
		this.destroyCalls.push(issueKey);
		this.statuses.delete(issueKey);
		const stack = this.stacks.get(issueKey);
		stack?.connection.close();
		this.stacks.delete(issueKey);
	}

	async status(issueKey: string): Promise<ContainerStatus> {
		return this.statuses.get(issueKey) ?? "absent";
	}

	async listManaged(): Promise<string[]> {
		return [...this.stacks.keys()];
	}

	/** Closes every connected device stack — test teardown helper. */
	closeAll(): void {
		for (const stack of this.stacks.values()) {
			stack.connection.close();
		}
	}
}

/**
 * A `ContainerExecutor` whose `ensureRunning` parks on a manually-released
 * gate instead of resolving on its own — used by scenario 5 to reliably hold
 * a boot "still cold-booting" (i.e. `ensureRunning` genuinely pending) across
 * two separate webhook deliveries, without racing real timers or a real
 * WebSocket connect. Unlike `FakeBootExecutor`, this double never connects a
 * device stack: scenario 5 only cares about how many times `ensureRunning`
 * is invoked, not about queue drain.
 */
class GatedBootExecutor implements ContainerExecutor {
	readonly ensureRunningCalls: IssueExecutionContext[] = [];
	/** Incremented each time a parked `ensureRunning` call is released. */
	resolvedCount = 0;
	private releaseGate!: () => void;
	private readonly gate = new Promise<void>((resolve) => {
		this.releaseGate = resolve;
	});

	/** Unblocks every `ensureRunning` call currently parked on the gate. */
	release(): void {
		this.releaseGate();
	}

	/** Set once a boot has actually completed; drives {@link status}. */
	private running = false;

	async ensureRunning(ctx: IssueExecutionContext): Promise<void> {
		this.ensureRunningCalls.push(ctx);
		await this.gate;
		this.resolvedCount++;
		this.running = true;
	}

	async stop(): Promise<void> {
		this.running = false;
	}

	async destroy(): Promise<void> {
		this.running = false;
	}

	/**
	 * Must reflect what `ensureRunning` actually achieved. A caller that joined
	 * an in-flight boot re-checks this before trusting it (see
	 * `ContainerTargets.bootStart`), because a joined attempt can legitimately
	 * finish with the container still stopped — that is the bug which silently
	 * swallowed terminal-teardown wakes. A fake reporting a constant `"absent"`
	 * would make every completed boot look like a failure.
	 */
	async status(): Promise<ContainerStatus> {
		return this.running ? "running" : "absent";
	}

	async listManaged(): Promise<string[]> {
		return [];
	}
}

describe("router container-executor e2e (real RouterServer + fake ContainerExecutor over real WebSocket)", () => {
	let server: RouterServer;
	let tracker: CLIIssueTrackerService;
	let stateDir: string;
	let secretsDir: string;

	let dockerExec: FakeBootExecutor;
	let flyExec: FakeBootExecutor;
	let brokenExec: FakeBootExecutor;
	let gatedExec: GatedBootExecutor;

	beforeAll(async () => {
		tracker = new CLIIssueTrackerService();
		tracker.seedDefaultData();

		// Seed the sessions the router will post notices/rejections/boot-failures
		// to (the CLI tracker validates the session exists before recording an
		// activity).
		seedSession(tracker, "sess-cold-1", "issue-cold-1");
		seedSession(tracker, "sess-switch-1", "issue-switch-1");
		seedSession(tracker, "sess-switch-2", "issue-switch-1");
		seedSession(tracker, "sess-boot-fail", "issue-boot-fail");
		seedSession(tracker, "sess-gated-1", "issue-gated-1");

		stateDir = mkdtempSync(join(tmpdir(), "cyrus-router-containers-e2e-"));
		secretsDir = mkdtempSync(
			join(tmpdir(), "cyrus-router-containers-e2e-secrets-"),
		);
		const secretsPath = join(secretsDir, "user-secrets.json");
		const secrets = new SecretStore(secretsPath);

		dockerExec = new FakeBootExecutor(
			"docker",
			() => server.port,
			join(stateDir, "docker"),
		);
		flyExec = new FakeBootExecutor(
			"fly",
			() => server.port,
			join(stateDir, "fly"),
		);
		brokenExec = new FakeBootExecutor(
			"brokendocker",
			() => server.port,
			join(stateDir, "brokendocker"),
		);
		brokenExec.shouldFail = true;
		gatedExec = new GatedBootExecutor();

		const containers: RouterContainersConfig = {
			image: "cyrus-worker:test",
			// Unused directly by the fakes (they connect via the captured server
			// port instead), but required by the schema — mirrors what an
			// operator would set for Docker Desktop.
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
			logger: silentLogger(),
			containers,
			executorRegistryFactory: () =>
				new Map<string, ContainerExecutor>([
					["docker", dockerExec],
					["fly", flyExec],
					["brokendocker", brokenExec],
					["gateddocker", gatedExec],
				]),
		});
		await server.start();

		server.store.addUser({ email: "cold@example.com", linearId: "lin-cold" });
		server.store.setUserExecutor(
			"cold@example.com",
			JSON.stringify({ type: "docker" }),
		);
		secrets.set("cold@example.com", "claudeOauthToken", "fake-claude-token-1");

		server.store.addUser({
			email: "switcher@example.com",
			linearId: "lin-switcher",
		});
		server.store.setUserExecutor(
			"switcher@example.com",
			JSON.stringify({ type: "docker" }),
		);
		secrets.set(
			"switcher@example.com",
			"claudeOauthToken",
			"fake-claude-token-2",
		);

		server.store.addUser({
			email: "unlucky@example.com",
			linearId: "lin-unlucky",
		});
		server.store.setUserExecutor(
			"unlucky@example.com",
			JSON.stringify({ type: "brokendocker" }),
		);
		secrets.set(
			"unlucky@example.com",
			"claudeOauthToken",
			"fake-claude-token-3",
		);

		server.store.addUser({ email: "gated@example.com", linearId: "lin-gated" });
		server.store.setUserExecutor(
			"gated@example.com",
			JSON.stringify({ type: "gateddocker" }),
		);
		secrets.set("gated@example.com", "claudeOauthToken", "fake-claude-token-4");
	});

	afterAll(async () => {
		dockerExec?.closeAll();
		flyExec?.closeAll();
		brokenExec?.closeAll();
		gatedExec?.release();
		await server.stop();
		rmSync(stateDir, { recursive: true, force: true });
		rmSync(secretsDir, { recursive: true, force: true });
	});

	it("1. cold boot drains the queue: device row created, ensureRunning called, no offline-outage notice, fake device receives the queued event", async () => {
		const COLD: Creator = {
			id: "lin-cold",
			email: "cold@example.com",
			name: "Cold",
		};

		await server.eventRouter.route(
			createdFixture({
				sessionId: "sess-cold-1",
				issue: {
					id: "issue-cold-1",
					identifier: "CYPACK-100",
					title: "Cold start",
				},
				creator: COLD,
			}),
		);

		await vi.waitFor(() => {
			expect(
				server.store.getContainerDeviceForIssue("CYPACK-100"),
			).toMatchObject({ provider: "docker" });
		});
		expect(
			dockerExec.ensureRunningCalls.some((c) => c.issueKey === "CYPACK-100"),
		).toBe(true);

		// A cold-booting container is NOT an outage: no activity of any kind —
		// not just no offline-waiting notice specifically — should ever be
		// posted for it. Asserting on the exact wording of one message would
		// let a differently-worded (or repurposed) outage notice slip through;
		// the actual property under test is that a cold boot stays silent.
		expect(tracker.listAgentActivities("sess-cold-1")).toHaveLength(0);

		// The fake device connects with its minted token and receives the
		// queued "created" event frame over the real WebSocket.
		await vi.waitFor(
			() => expect(dockerExec.stacks.has("CYPACK-100")).toBe(true),
			{ timeout: 3000 },
		);
		const stack = dockerExec.stacks.get("CYPACK-100");
		if (!stack) throw new Error("expected a connected device stack");
		await vi.waitFor(() => expect(stack.events.length).toBeGreaterThan(0));
		expect(stack.events[0]?.action).toBe("created");
	});

	it("2. terminal session_state clears affinity; idle-stop fires once the injected clock passes idleStopMs", async () => {
		const stack = dockerExec.stacks.get("CYPACK-100");
		if (!stack) throw new Error("expected scenario 1's device stack");
		const device = server.store.getContainerDeviceForIssue("CYPACK-100");
		if (!device) throw new Error("expected scenario 1's device row");
		expect(
			server.store.countSessionAffinityForDevice(device.deviceId),
		).toBeGreaterThan(0);

		stack.connection.sendSessionState("sess-cold-1", "complete");

		await vi.waitFor(() => {
			expect(server.store.countSessionAffinityForDevice(device.deviceId)).toBe(
				0,
			);
		});

		// RouterServer's own `containerLifecycle` always runs on the real
		// `Date.now` (no config seam exposes a clock into it), so this builds a
		// second `ContainerLifecycle` sharing the SAME store + executor registry
		// with an injected clock — the same technique `ContainerLifecycle.test.ts`
		// uses at the unit level, now exercised against state the real router
		// wrote.
		const future = Date.now() + IDLE_STOP_MS + 5_000;
		const lifecycle = new ContainerLifecycle({
			store: server.store,
			executors: new Map<string, ContainerExecutor>([
				["docker", dockerExec],
				["fly", flyExec],
				["brokendocker", brokenExec],
			]),
			idleStopMs: IDLE_STOP_MS,
			staleDestroyMs: STALE_DESTROY_MS,
			offlineAgeOutMs: 3_600_000,
			logger: silentLogger(),
			now: () => future,
		});

		await lifecycle.sweep();

		expect(dockerExec.stopCalls).toContain("CYPACK-100");
	});

	it("3. switching the user's executor destroys the old provider's container and creates a new device row for the new provider", async () => {
		const SWITCHER: Creator = {
			id: "lin-switcher",
			email: "switcher@example.com",
			name: "Switcher",
		};
		const issue = {
			id: "issue-switch-1",
			identifier: "CYPACK-200",
			title: "Switch me",
		};

		await server.eventRouter.route(
			createdFixture({ sessionId: "sess-switch-1", issue, creator: SWITCHER }),
		);

		await vi.waitFor(() => {
			expect(
				server.store.getContainerDeviceForIssue("CYPACK-200"),
			).toMatchObject({ provider: "docker" });
		});
		await vi.waitFor(() =>
			expect(
				dockerExec.ensureRunningCalls.some((c) => c.issueKey === "CYPACK-200"),
			).toBe(true),
		);
		const original = server.store.getContainerDeviceForIssue("CYPACK-200");
		if (!original) throw new Error("expected the original device row");

		// Operator switches this user to a different provider mid-flight.
		server.store.setUserExecutor(
			"switcher@example.com",
			JSON.stringify({ type: "fly" }),
		);

		// A prompted event for a FRESH session on the same issue: unlike a
		// follow-up prompt on sess-switch-1 (which would resolve via that
		// session's stored affinity straight back to the old device, never
		// re-consulting the user's executor), a new session re-resolves through
		// `ContainerTargetService.ensureDevice`, which is where the provider
		// mismatch is detected and the old container is torn down.
		await server.eventRouter.route(
			promptedFixture({
				sessionId: "sess-switch-2",
				actorUserId: SWITCHER.id,
				creator: SWITCHER,
				issue,
				body: "keep going",
			}),
		);

		await vi.waitFor(() => {
			expect(dockerExec.destroyCalls).toContain("CYPACK-200");
		});
		await vi.waitFor(() => {
			expect(
				server.store.getContainerDeviceForIssue("CYPACK-200"),
			).toMatchObject({ provider: "fly" });
		});
		const replaced = server.store.getContainerDeviceForIssue("CYPACK-200");
		expect(replaced?.deviceId).not.toBe(original.deviceId);
		await vi.waitFor(
			() => {
				expect(
					flyExec.ensureRunningCalls.some((c) => c.issueKey === "CYPACK-200"),
				).toBe(true);
			},
			{ timeout: 3000 },
		);
	});

	it("4. a boot failure posts exactly one containerBootFailedMessage per issue, not repeated while still failing", async () => {
		const UNLUCKY: Creator = {
			id: "lin-unlucky",
			email: "unlucky@example.com",
			name: "Unlucky",
		};
		const issue = {
			id: "issue-boot-fail",
			identifier: "CYPACK-300",
			title: "Doomed",
		};
		const expectedNotice = containerBootFailedMessage(
			"CYPACK-300",
			"fake docker daemon unreachable",
		);

		await server.eventRouter.route(
			createdFixture({ sessionId: "sess-boot-fail", issue, creator: UNLUCKY }),
		);

		await vi.waitFor(() => {
			expect(
				tracker.listAgentActivities("sess-boot-fail").map((a) => a.content),
			).toContain(expectedNotice);
		});
		expect(
			brokenExec.ensureRunningCalls.filter((c) => c.issueKey === "CYPACK-300"),
		).toHaveLength(1);
		// Secret backends are async; let bootInner's in-flight cleanup settle after
		// the activity post that satisfied the wait above.
		await new Promise((resolve) => setTimeout(resolve, 0));

		// A second event for the SAME still-failing issue must not post a second
		// notice — the once-per-issue-until-success latch in
		// `ContainerTargetService`.
		await server.eventRouter.route(
			promptedFixture({
				sessionId: "sess-boot-fail",
				actorUserId: UNLUCKY.id,
				creator: UNLUCKY,
				issue,
				body: "still there?",
			}),
		);

		await vi.waitFor(() =>
			expect(
				brokenExec.ensureRunningCalls.filter(
					(c) => c.issueKey === "CYPACK-300",
				),
			).toHaveLength(2),
		);
		const notices = tracker
			.listAgentActivities("sess-boot-fail")
			.map((a) => a.content)
			.filter((content) => content === expectedNotice);
		expect(notices).toHaveLength(1);
	});

	it("5. created then prompted for the same still-cold-booting issue coalesce into exactly one ensureRunning call (inFlightBoots dedup, keyed by device id)", async () => {
		const GATED: Creator = {
			id: "lin-gated",
			email: "gated@example.com",
			name: "Gated",
		};
		const issue = {
			id: "issue-gated-1",
			identifier: "CYPACK-400",
			title: "Still cold-booting",
		};

		await server.eventRouter.route(
			createdFixture({ sessionId: "sess-gated-1", issue, creator: GATED }),
		);

		// `ContainerTargetService.boot` is fire-and-forget (it never awaits
		// `ensureRunning`), but its synchronous prefix — resolving the device,
		// checking `inFlightBoots`, and calling `ensureRunning`, all the way
		// down to `gatedExec` recording the call and parking on its gate — runs
		// to completion inside the same call stack as `deliverOrNotify`, before
		// `route()`'s own promise settles. So this is already deterministic
		// with no real wait needed: the container is now "still cold-booting"
		// (ensureRunning genuinely pending), exactly the window
		// `inFlightBoots` exists to dedupe across.
		expect(gatedExec.ensureRunningCalls).toHaveLength(1);

		// A follow-up prompt on the SAME session, seconds later per Linear's
		// created-then-prompted webhook pattern, while the container is still
		// cold-booting. This resolves via the session affinity set by the
		// created webhook above — NOT via ensureDevice/executorFor — but still
		// reaches the shared deliverOrNotify choke point and calls boot()
		// again for the SAME device id. This is exactly the race
		// `inFlightBoots` exists to dedupe (see its doc comment in
		// ContainerTargets.ts): `inFlightBoots` was just rekeyed from issue key
		// to device id, and unit tests only cover the dedup by calling
		// `boot(deviceId)` twice directly — they can't catch a future change
		// that makes two separate *webhooks* resolve to different device ids.
		// If the dedup were broken, this second boot() would mint a second
		// device token and start a second ensureRunning, orphaning the
		// container that actually started.
		await server.eventRouter.route(
			promptedFixture({
				sessionId: "sess-gated-1",
				actorUserId: GATED.id,
				creator: GATED,
				issue,
				body: "already going?",
			}),
		);

		expect(gatedExec.ensureRunningCalls).toHaveLength(1);

		// Release the parked call and confirm it settles cleanly — proof that
		// exactly one ensureRunning call was ever in flight for this device.
		gatedExec.release();
		await vi.waitFor(() => {
			expect(gatedExec.resolvedCount).toBe(1);
		});
	});
});

/**
 * Guarded recovery, end to end (CYR-75).
 *
 * The shape this exercises is the one the dev-fleet findings documented and the
 * router can detect but not fix: a container whose executor is STOPPED, whose
 * worker is OFFLINE, and whose session still holds affinity and the issue lock.
 * Linear keeps rendering a live agent session and every new top-level comment on
 * the issue is rejected at the lock, so the issue is write-only until somebody
 * intervenes.
 *
 * It runs its own {@link RouterServer} because recovery is off by default and
 * turning it on is a deployment-level decision — which is exactly the property
 * worth exercising through the real HTTP route rather than by calling the
 * coordinator directly.
 */
describe("guarded recovery e2e (real RouterServer + real WebSocket worker)", () => {
	let server: RouterServer;
	let tracker: CLIIssueTrackerService;
	let stateDir: string;
	let secretsDir: string;
	let dockerExec: FakeBootExecutor;
	let operatorToken: string;

	const ISSUE_KEY = "CYPACK-300";
	const ISSUE_ID = "issue-recover-1";
	const SESSION_ID = "sess-recover-1";

	beforeAll(async () => {
		tracker = new CLIIssueTrackerService();
		tracker.seedDefaultData();
		seedSession(tracker, SESSION_ID, ISSUE_ID);

		stateDir = mkdtempSync(join(tmpdir(), "cyrus-router-recovery-e2e-"));
		secretsDir = mkdtempSync(join(tmpdir(), "cyrus-router-recovery-e2e-sec-"));
		const secretsPath = join(secretsDir, "user-secrets.json");
		const secrets = new SecretStore(secretsPath);

		dockerExec = new FakeBootExecutor(
			"docker",
			() => server.port,
			join(stateDir, "docker"),
			// A container that was stranded and restarted comes back with no
			// sessions: the worker process that owned the run is gone. That answer
			// — given by an AUTHENTICATED worker, not inferred from silence — is
			// what licenses the release.
			() => [],
		);

		server = new RouterServer({
			port: 0,
			dbPath: ":memory:",
			workspaces: { [WORKSPACE]: { linearToken: "test-token" } },
			webhook: { verificationMode: "direct", secret: "test-secret" },
			trackerFactory: () => tracker,
			heartbeatMs: 30_000,
			logger: silentLogger(),
			// The opt-in, and the ONLY switch: no coordinator is supplied here, so
			// this pins that a real one is built from the server's own seams.
			fleetOperations: { recovery: { enabled: true } },
			containers: {
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
				repositoriesPath: join(stateDir, "repositories.json"),
				idleStopMs: IDLE_STOP_MS,
				staleDestroyMs: STALE_DESTROY_MS,
				offlineAgeOutMs: 3_600_000,
				// The one knob a test rig legitimately turns right down: the replay
				// window is a real wait, and this suite drives a real worker whose
				// frames land immediately over localhost.
				recoveryReplayMs: 50,
			},
			executorRegistryFactory: () =>
				new Map<string, ContainerExecutor>([["docker", dockerExec]]),
		});
		await server.start();

		server.store.addUser({
			email: "stranded@example.com",
			linearId: "lin-str",
		});
		server.store.setUserExecutor(
			"stranded@example.com",
			JSON.stringify({ type: "docker" }),
		);
		secrets.set(
			"stranded@example.com",
			"claudeOauthToken",
			"fake-claude-token",
		);
		operatorToken = server.store.createOperatorToken({
			label: "oncall",
			roles: ["fleet.read", "fleet.recover"],
			workspaceIds: [WORKSPACE],
		}).token;
	});

	afterAll(async () => {
		dockerExec?.closeAll();
		await server.stop();
		rmSync(stateDir, { recursive: true, force: true });
		rmSync(secretsDir, { recursive: true, force: true });
	});

	async function post(body: unknown) {
		const res = await fetch(
			`http://127.0.0.1:${server.port}/api/v1/recoveries`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${operatorToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(body),
			},
		);
		return { status: res.status, body: await res.json() };
	}

	async function operation(operationId: string) {
		const res = await fetch(
			`http://127.0.0.1:${server.port}/api/v1/recoveries/${operationId}`,
			{ headers: { authorization: `Bearer ${operatorToken}` } },
		);
		return res.json();
	}

	it("advertises the capability and unblocks a stopped, offline, still-pinned container", async () => {
		const context = await fetch(
			`http://127.0.0.1:${server.port}/api/v1/operator/context`,
			{ headers: { authorization: `Bearer ${operatorToken}` } },
		).then((res) => res.json());
		expect(context.capabilities).toContain("recoveries.request");

		// ── Build the stranded shape through the real routing path ──
		const creator: Creator = {
			id: "lin-str",
			email: "stranded@example.com",
			name: "Stranded",
		};
		await server.eventRouter.route(
			createdFixture({
				sessionId: SESSION_ID,
				issue: { id: ISSUE_ID, identifier: ISSUE_KEY, title: "Stranded" },
				creator,
			}),
		);
		await vi.waitFor(() => {
			expect(server.store.getContainerDeviceForIssue(ISSUE_KEY)).toBeDefined();
		});
		const device = server.store.getContainerDeviceForIssue(ISSUE_KEY);
		if (!device) throw new Error("no container device");
		await vi.waitFor(() => {
			expect(server.isDeviceOnline(device.deviceId)).toBe(true);
		});

		// The worker goes away and its container is parked, but the affinity and
		// the issue lock the session took out survive. Nothing in the router will
		// ever release them on its own — that is the whole failure.
		dockerExec.stacks.get(ISSUE_KEY)?.connection.close();
		await dockerExec.stop(ISSUE_KEY);
		await vi.waitFor(() => {
			expect(server.isDeviceOnline(device.deviceId)).toBe(false);
		});
		expect(server.store.getSessionAffinity(SESSION_ID)).toBe(device.deviceId);
		expect(server.store.getIssueLock(ISSUE_ID)).toMatchObject({
			sessionId: SESSION_ID,
		});

		// ── The operator reads the run, then asks for it to be reconciled ──
		const run = server.store
			.listFleetAgentRuns({ workspaceIds: [WORKSPACE], limit: 10 })
			.find((candidate) => candidate.sessionId === SESSION_ID);
		if (!run) throw new Error("no run recorded");

		const request = {
			schemaVersion: 1,
			runId: run.runId,
			expectedRevision: run.revision,
			idempotencyKey: "idem-recovery-e2e-1",
			reason: "issue is write-only; container stopped with the lock held",
		};
		const accepted = await post(request);
		expect(accepted.status).toBe(202);

		// A retry of the same key joins the operation it already names rather than
		// starting a competing one — the whole reason the key exists.
		const rejoined = await post(request);
		expect(rejoined.status).toBe(200);
		expect(rejoined.body.operationId).toBe(accepted.body.operationId);
		// The same key bound to different evidence is a conflict, not a join: a
		// client that lost a response must not be able to retry its way into
		// recovering something it never asked about.
		const rebound = await post({
			...request,
			expectedRevision: run.revision + 1,
		});
		expect(rebound.status).toBe(409);
		expect(rebound.body.error).toBe("idempotency_key_conflict");

		await vi.waitFor(
			async () => {
				const current = await operation(accepted.body.operationId);
				expect({
					phase: current.phase,
					failure: current.failure?.message,
				}).toEqual({ phase: "recovered", failure: undefined });
			},
			{ timeout: 10_000 },
		);

		const settled = await operation(accepted.body.operationId);
		// The prefix is fixed; whether a `releasing_stale_ownership` entry appears
		// is not, and pinning it would be pinning a race. Booting the container is
		// itself what brings its worker back, and the reconnect handshake runs the
		// router's own affinity/lock reconciliation — so the run may already be
		// terminal by the time the replay window closes. Either way the issue ends
		// up unlocked, which is what the assertions below hold to.
		expect(
			settled.phases.map((entry: { phase: string }) => entry.phase).slice(0, 4),
		).toEqual(["accepted", "starting_executor", "reconciling", "replaying"]);
		expect(settled.phases.at(-1).phase).toBe("recovered");
		// The before/after pair is what proves the operation released a live pin
		// rather than doing nothing.
		expect(settled.evidenceBefore).toMatchObject({
			sessionAffinityHeld: true,
			issueLocked: true,
		});
		expect(settled.evidenceAfter).toMatchObject({
			sessionAffinityHeld: false,
			issueLocked: false,
			lifecycle: "unknown",
		});
		// It restarted the container rather than reasoning from a stale gauge, and
		// it never stopped or destroyed anything.
		expect(await dockerExec.status(ISSUE_KEY)).toBe("running");
		expect(dockerExec.destroyCalls).not.toContain(ISSUE_KEY);
		expect(server.store.getSessionAffinity(SESSION_ID)).toBeUndefined();
		expect(server.store.getIssueLock(ISSUE_ID)).toBeUndefined();
	}, 20_000);

	it("will not re-open the run it just recovered", async () => {
		// Recovery ended this run as `unknown`. A second request quoting it — even
		// with fresh evidence and a fresh key — is refused rather than acted on:
		// recovery reconciles ownership, it does not restart work.
		const run = server.store
			.listFleetAgentRuns({ workspaceIds: [WORKSPACE], limit: 10 })
			.find((candidate) => candidate.sessionId === SESSION_ID);
		if (!run) throw new Error("no run recorded");
		expect(run.state).toBe("unknown");

		const refused = await post({
			schemaVersion: 1,
			runId: run.runId,
			expectedRevision: run.revision,
			idempotencyKey: "idem-recovery-e2e-2",
		});

		expect(refused.status).toBe(409);
		expect(refused.body.error).toBe("run_already_terminal");
		expect(dockerExec.destroyCalls).not.toContain(ISSUE_KEY);
	});
});
