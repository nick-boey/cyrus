import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "cyrus-core";
import { CLIIssueTrackerService } from "cyrus-core";
import type { LinearOAuthConfig } from "cyrus-linear-event-transport";
import type {
	ContainerExecutor,
	ExecutorRegistry,
	IssueExecutionContext,
} from "cyrus-router-executors";
import { PROTOCOL_VERSION } from "cyrus-router-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
	type RouterContainersConfig,
	RouterServer,
	type RouterServerConfig,
} from "../src/RouterServer.js";
import { SecretStore } from "../src/SecretStore.js";
import { testLogger } from "./helpers/logger.js";

/**
 * Minimal fake ContainerExecutor whose ensureRunning is an inspectable mock
 * that never shells out. Injected via `executorRegistryFactory` — the
 * composition-root seam — so the container tests below can never reach a
 * real Docker daemon, regardless of whether the developer's machine has
 * Docker installed. See ContainerTargets.test.ts's `fakeExecutor` for the
 * same pattern used one layer down.
 */
function fakeExecutor(provider: string): ContainerExecutor & {
	ensureRunning: ReturnType<typeof vi.fn>;
} {
	return {
		provider,
		ensureRunning: vi.fn<(ctx: IssueExecutionContext) => Promise<void>>(
			async () => {},
		),
		stop: vi.fn(async () => {}),
		destroy: vi.fn(async () => {}),
		status: vi.fn(async () => "running" as const),
		listManaged: vi.fn(async () => []),
	};
}

function makeServer(): RouterServer {
	return new RouterServer({
		port: 0,
		dbPath: ":memory:",
		workspaces: { "ws-1": { linearToken: "test-token" } },
		webhook: { verificationMode: "direct", secret: "test-secret" },
		trackerFactory: () => new CLIIssueTrackerService(),
	});
}

describe("RouterServer /enroll", () => {
	let server: RouterServer | undefined;

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = undefined;
		}
	});

	it("redeems a minted enrollment code and returns a device token", async () => {
		server = makeServer();
		await server.start();
		server.store.addUser({ email: "alice@example.com" });
		const code = server.store.mintEnrollmentCode(
			"alice@example.com",
			Date.now(),
		);

		const res = await fetch(`http://127.0.0.1:${server.port}/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { deviceToken: string };
		expect(typeof body.deviceToken).toBe("string");
		expect(body.deviceToken.length).toBeGreaterThan(0);
	});

	it("rejects an invalid enrollment code with 401", async () => {
		server = makeServer();
		await server.start();

		const res = await fetch(`http://127.0.0.1:${server.port}/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code: "not-a-real-code" }),
		});

		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("invalid or expired code");
	});
});

describe("RouterServer session_state", () => {
	let server: RouterServer | undefined;

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = undefined;
		}
	});

	/** Enrolls a device and returns an authenticated socket + a frame reader. */
	async function connectDevice(srv: RouterServer, activeSessions?: string[]) {
		srv.store.addUser({ email: "alice@example.com" });
		const code = srv.store.mintEnrollmentCode("alice@example.com", Date.now());
		const res = await fetch(`http://127.0.0.1:${srv.port}/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code }),
		});
		const { deviceToken } = (await res.json()) as { deviceToken: string };

		const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/device`);
		const queue: string[] = [];
		const waiters: Array<(m: string) => void> = [];
		ws.on("message", (d) => {
			const msg = d.toString();
			const w = waiters.shift();
			if (w) w(msg);
			else queue.push(msg);
		});
		const next = () =>
			new Promise<string>((resolve) => {
				const q = queue.shift();
				if (q !== undefined) resolve(q);
				else waiters.push(resolve);
			});

		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken,
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
				...(activeSessions ? { activeSessions } : {}),
			}),
		);
		expect(JSON.parse(await next()).type).toBe("hello_ack");
		return { ws, next };
	}

	it("acks a session_state frame and releases the issue lock before acking", async () => {
		server = makeServer();
		await server.start();
		const { ws, next } = await connectDevice(server);

		// Hold a lock the terminal frame is expected to release.
		const deviceId = 1;
		expect(server.store.acquireIssueLock("ISS-1", "sess-1", deviceId)).toBe(
			true,
		);

		ws.send(
			JSON.stringify({
				type: "session_state",
				id: "ss-42",
				sessionId: "sess-1",
				state: "complete",
			}),
		);

		const ack = JSON.parse(await next());
		expect(ack).toEqual({ type: "session_state_ack", id: "ss-42" });

		// The ack is only sent after the release is applied, so by the time the
		// device sees it the issue must be re-acquirable by another session.
		expect(server.store.acquireIssueLock("ISS-1", "sess-2", deviceId)).toBe(
			true,
		);
		ws.terminate();
	});

	it("re-acks a replayed session_state (at-least-once delivery is idempotent)", async () => {
		server = makeServer();
		await server.start();
		const { ws, next } = await connectDevice(server);

		const frame = JSON.stringify({
			type: "session_state",
			id: "ss-dup",
			sessionId: "sess-1",
			state: "stopped",
		});
		ws.send(frame);
		expect(JSON.parse(await next())).toEqual({
			type: "session_state_ack",
			id: "ss-dup",
		});

		// A device whose first ack was lost replays the same frame. The router
		// must ack again rather than ignore it, or the device buffers forever.
		ws.send(frame);
		expect(JSON.parse(await next())).toEqual({
			type: "session_state_ack",
			id: "ss-dup",
		});
		ws.terminate();
	});

	it("reconciles affinity when a device connects, alongside lock reconciliation", async () => {
		// Both reconcilers must run: locks and affinity leak independently, and
		// routePrompted produces affinity with NO lock, which the lock reconciler
		// cannot see.
		server = makeServer();
		await server.start();
		const spy = vi.spyOn(server.eventRouter, "reconcileDeviceAffinity");

		const { ws } = await connectDevice(server, ["sess-live"]);

		await vi.waitFor(() => expect(spy).toHaveBeenCalled());
		expect(spy).toHaveBeenCalledWith(1, ["sess-live"], expect.any(Number));
		ws.terminate();
	});
});

describe("RouterServer /healthz", () => {
	let server: RouterServer | undefined;

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = undefined;
		}
	});

	it("returns 200 ok for liveness probes", async () => {
		server = makeServer();
		await server.start();

		const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});
});

describe("RouterServer fleet-operations routes", () => {
	let server: RouterServer | undefined;

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = undefined;
		}
	});

	// Driven over real HTTP rather than a Fastify inject seam, because the claim
	// under test is that these routes are registered BEFORE listen() — Fastify
	// v5 refuses new routes on a listening server, so a registration moved into
	// start() would 404 here while every unit test still passed.
	it("serves discovery anonymously on a router with no operator config", async () => {
		server = makeServer();
		await server.start();

		const res = await fetch(
			`http://127.0.0.1:${server.port}/.well-known/cyrus`,
		);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({
			schemaVersion: 1,
			routerId: "cyrus-router",
			operatorApiVersions: ["v1"],
			authentication: {
				methods: ["device-token", "local-operator-token"],
			},
		});
	});

	it("publishes the configured Entra tenant and audience, and nothing else", async () => {
		server = new RouterServer({
			port: 0,
			dbPath: ":memory:",
			workspaces: { "ws-1": { linearToken: "test-token" } },
			webhook: { verificationMode: "direct", secret: "test-secret" },
			trackerFactory: () => new CLIIssueTrackerService(),
			fleetOperations: {
				routerId: "prod-router",
				access: {
					entra: {
						tenantId: "tenant-1",
						audience: "api://cyrus-router",
						grants: [
							{
								principalIds: ["oid-1"],
								roles: ["fleet.read"],
								workspaceIds: ["ws-1"],
							},
						],
					},
				},
			},
			// A verifier is supplied so construction does not reach for a remote
			// JWKS; discovery itself verifies nothing.
			operatorTokenVerifier: async () => ({}),
		});
		await server.start();

		const res = await fetch(
			`http://127.0.0.1:${server.port}/.well-known/cyrus`,
		);
		const body = await res.json();

		expect(body.authentication.entra).toEqual({
			tenantId: "tenant-1",
			audience: "api://cyrus-router",
		});
		const serialized = JSON.stringify(body);
		for (const secret of ["ws-1", "oid-1", "grants", "test-token"]) {
			expect(serialized).not.toContain(secret);
		}
	});

	it("requires authentication for the operator context route", async () => {
		server = makeServer();
		await server.start();

		const res = await fetch(
			`http://127.0.0.1:${server.port}/api/v1/operator/context`,
		);

		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "unauthorized" });
	});

	it("authenticates a locally minted operator token end to end", async () => {
		server = makeServer();
		await server.start();
		const created = server.store.createOperatorToken({
			label: "oncall",
			roles: ["fleet.read"],
			workspaceIds: ["ws-1"],
		});

		const res = await fetch(
			`http://127.0.0.1:${server.port}/api/v1/operator/context`,
			{ headers: { authorization: `Bearer ${created.token}` } },
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.authMethod).toBe("local-operator-token");
		expect(body.roles).toEqual(["fleet.read"]);
		expect(body.authorizedWorkspaces).toEqual([{ workspaceId: "ws-1" }]);
		// The run routes are registered unconditionally and read the store this
		// server always has, so they are always served. No log source is
		// configured and no recovery route exists, so neither is advertised —
		// this router still advertises nothing it cannot do.
		expect(body.capabilities).toEqual(["runs.list", "runs.changes"]);
		expect(body.logSource).toBeUndefined();
	});

	/** The v1 descriptor a deployment renders into router-config.json. */
	const LOG_SOURCE = {
		schemaVersion: 1,
		kind: "azure-log-analytics",
		displayName: "cyrus-prod",
		azure: {
			workspaceId: "99999999-9999-9999-9999-999999999999",
			table: "ContainerAppConsoleLogs_CL",
			resourceId:
				"/subscriptions/99999999-9999-9999-9999-999999999999/resourceGroups/cyrus/providers/Microsoft.OperationalInsights/workspaces/cyrus-logs",
		},
		budgets: {
			defaultLookbackSeconds: 900,
			maxRangeSeconds: 86_400,
			maxRecords: 5000,
			minFollowIntervalSeconds: 15,
		},
	} as const;

	function makeLogSourceServer(): RouterServer {
		return new RouterServer({
			port: 0,
			dbPath: ":memory:",
			workspaces: { "ws-1": { linearToken: "test-token" } },
			webhook: { verificationMode: "direct", secret: "test-secret" },
			trackerFactory: () => new CLIIssueTrackerService(),
			fleetOperations: { logSource: LOG_SOURCE },
		});
	}

	it("advertises logs.query and hands the descriptor to an authorized operator", async () => {
		server = makeLogSourceServer();
		await server.start();
		const created = server.store.createOperatorToken({
			label: "oncall",
			roles: ["fleet.read"],
			workspaceIds: ["ws-1"],
		});

		const res = await fetch(
			`http://127.0.0.1:${server.port}/api/v1/operator/context`,
			{ headers: { authorization: `Bearer ${created.token}` } },
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.capabilities).toEqual([
			"runs.list",
			"runs.changes",
			"logs.query",
		]);
		expect(body.logSource).toEqual(LOG_SOURCE);
	});

	it("withholds the descriptor from an anonymous caller on every route it serves", async () => {
		server = makeLogSourceServer();
		await server.start();

		for (const route of [
			"/.well-known/cyrus",
			"/api/v1/operator/context",
			"/api/v1/runs",
			"/api/v1/run-changes",
			"/healthz",
		]) {
			const res = await fetch(`http://127.0.0.1:${server.port}${route}`);
			const text = await res.text();
			expect(text).not.toContain(LOG_SOURCE.azure.workspaceId);
			expect(text).not.toContain(LOG_SOURCE.azure.resourceId);
		}
	});

	it("serves no route that accepts a query or returns log records", async () => {
		// The descriptor is the ENTIRE log surface: the operator's own client
		// authenticates to the backend and queries it directly. A router-side query
		// route would need an Azure credential in this process, which is exactly
		// what makes the descriptor safe to hand over.
		server = makeLogSourceServer();
		await server.start();
		const created = server.store.createOperatorToken({
			label: "oncall",
			roles: ["fleet.read"],
			workspaceIds: ["ws-1"],
		});
		const headers = { authorization: `Bearer ${created.token}` };

		for (const route of [
			"/api/v1/logs",
			"/api/v1/log-records",
			"/api/v1/operator/logs",
			"/api/v1/logs/query",
		]) {
			const url = `http://127.0.0.1:${server.port}${route}`;
			expect((await fetch(url, { headers })).status).toBe(404);
			const posted = await fetch(url, {
				method: "POST",
				headers: { ...headers, "content-type": "application/json" },
				body: JSON.stringify({
					query: "ContainerAppConsoleLogs_CL | take 1",
				}),
			});
			expect(posted.status).toBe(404);
		}
	});

	it("has no `query` parameter on the routes it does serve, KQL-shaped or not", async () => {
		// This is the allowlist in `rejectUnknownParameters` doing its ordinary
		// job, not a KQL-specific defence — there is no KQL detection anywhere and
		// there should not be. What it pins is that `query` is not a parameter any
		// route understands, so a later route cannot quietly acquire one.
		server = makeLogSourceServer();
		await server.start();
		const created = server.store.createOperatorToken({
			label: "oncall",
			roles: ["fleet.read"],
			workspaceIds: ["ws-1"],
		});

		const res = await fetch(
			`http://127.0.0.1:${server.port}/api/v1/runs?query=${encodeURIComponent(
				"ContainerAppConsoleLogs_CL | take 1",
			)}`,
			{ headers: { authorization: `Bearer ${created.token}` } },
		);

		// Refused rather than ignored: a silently dropped parameter answers 200
		// with a superset of what was asked for.
		expect(res.status).toBe(400);
		expect((await res.json()).error).toBe("invalid_query");
	});

	it.each([
		[
			"reports a configured log source at startup",
			{ logSource: LOG_SOURCE },
			`kind ${LOG_SOURCE.kind}, workspace ${LOG_SOURCE.azure.workspaceId}`,
		],
		["reports an absent one just as plainly", {}, "not configured"],
	])("%s", async (_label, fleetOperations, expected) => {
		// Omitting `observability.logSource` and MISSPELLING its key are otherwise
		// indistinguishable from outside — both start clean, advertise no
		// `logs.query`, and disclose nothing — and the config schema strips an
		// unknown top-level key in silence. Without a line either way, an operator
		// debugging "my descriptor never arrives" has no evidence to go on.
		const logger = testLogger();
		server = new RouterServer({
			port: 0,
			dbPath: ":memory:",
			workspaces: { "ws-1": { linearToken: "test-token" } },
			webhook: { verificationMode: "direct", secret: "test-secret" },
			trackerFactory: () => new CLIIssueTrackerService(),
			fleetOperations,
			logger,
		});

		expect(
			logger.info.mock.calls.some(
				(call: unknown[]) =>
					typeof call[0] === "string" &&
					call[0].includes("log source") &&
					call[0].includes(expected),
			),
		).toBe(true);
	});
});

describe("RouterServer /workspaces", () => {
	let server: RouterServer | undefined;

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = undefined;
		}
	});

	/** Enrolls a device and returns its long-lived token. */
	async function enrollDevice(s: RouterServer): Promise<string> {
		s.store.addUser({ email: "alice@example.com" });
		const code = s.store.mintEnrollmentCode("alice@example.com", Date.now());
		const res = await fetch(`http://127.0.0.1:${s.port}/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code }),
		});
		return ((await res.json()) as { deviceToken: string }).deviceToken;
	}

	it("returns the configured workspace ids for a valid device token", async () => {
		server = new RouterServer({
			port: 0,
			dbPath: ":memory:",
			workspaces: {
				"ws-1": { linearToken: "token-1" },
				"ws-2": { linearToken: "token-2" },
			},
			webhook: { verificationMode: "direct", secret: "test-secret" },
			trackerFactory: () => new CLIIssueTrackerService(),
		});
		await server.start();
		const deviceToken = await enrollDevice(server);

		const res = await fetch(`http://127.0.0.1:${server.port}/workspaces`, {
			headers: { authorization: `Bearer ${deviceToken}` },
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ workspaceIds: ["ws-1", "ws-2"] });
	});

	it("never leaks the workspace's Linear token", async () => {
		server = makeServer();
		await server.start();
		const deviceToken = await enrollDevice(server);

		const res = await fetch(`http://127.0.0.1:${server.port}/workspaces`, {
			headers: { authorization: `Bearer ${deviceToken}` },
		});

		expect(await res.text()).not.toContain("test-token");
	});

	it("rejects a request with no Authorization header", async () => {
		server = makeServer();
		await server.start();

		const res = await fetch(`http://127.0.0.1:${server.port}/workspaces`);

		expect(res.status).toBe(401);
	});

	it("rejects a malformed Authorization header", async () => {
		server = makeServer();
		await server.start();
		const deviceToken = await enrollDevice(server);

		// Correct token, but missing the `Bearer ` scheme prefix.
		const res = await fetch(`http://127.0.0.1:${server.port}/workspaces`, {
			headers: { authorization: deviceToken },
		});

		expect(res.status).toBe(401);
	});

	it("rejects an unknown device token", async () => {
		server = makeServer();
		await server.start();

		const res = await fetch(`http://127.0.0.1:${server.port}/workspaces`, {
			headers: { authorization: "Bearer not-a-real-token" },
		});

		expect(res.status).toBe(401);
	});

	it("rejects a revoked device's token", async () => {
		server = makeServer();
		await server.start();
		const deviceToken = await enrollDevice(server);
		server.store.revokeDevice("alice@example.com");

		const res = await fetch(`http://127.0.0.1:${server.port}/workspaces`, {
			headers: { authorization: `Bearer ${deviceToken}` },
		});

		expect(res.status).toBe(401);
	});
});

describe("RouterServer Linear token refresh wiring", () => {
	const OAUTH = { clientId: "client-id", clientSecret: "client-secret" };

	/**
	 * Builds a server with a capturing trackerFactory, returning the oauthConfig
	 * that the default (Linear-backed) tracker would have been constructed with.
	 */
	function captureOAuthConfig(overrides: Partial<RouterServerConfig> = {}): {
		server: RouterServer;
		oauthConfigs: Map<string, LinearOAuthConfig | undefined>;
		warnings: string[];
	} {
		const oauthConfigs = new Map<string, LinearOAuthConfig | undefined>();
		const warnings: string[] = [];
		const server = new RouterServer({
			port: 0,
			dbPath: ":memory:",
			workspaces: {
				"ws-1": { linearToken: "token-1", linearRefreshToken: "refresh-1" },
			},
			webhook: { verificationMode: "direct", secret: "test-secret" },
			oauth: OAUTH,
			logger: { info: () => {}, warn: (msg) => warnings.push(msg) },
			trackerFactory: (id, _cfg, oauthConfig) => {
				oauthConfigs.set(id, oauthConfig);
				return new CLIIssueTrackerService();
			},
			...overrides,
		});
		return { server, oauthConfigs, warnings };
	}

	it("passes an oauthConfig built from the workspace refresh token", () => {
		const { oauthConfigs } = captureOAuthConfig();
		const cfg = oauthConfigs.get("ws-1");

		expect(cfg).toBeDefined();
		expect(cfg?.clientId).toBe("client-id");
		expect(cfg?.clientSecret).toBe("client-secret");
		expect(cfg?.refreshToken).toBe("refresh-1");
		expect(cfg?.workspaceId).toBe("ws-1");
	});

	it("disables refresh and warns when the workspace has no refresh token", () => {
		const { oauthConfigs, warnings } = captureOAuthConfig({
			workspaces: { "ws-1": { linearToken: "token-1" } },
		});

		expect(oauthConfigs.get("ws-1")).toBeUndefined();
		expect(warnings.join("\n")).toContain("No linearRefreshToken");
	});

	it("disables refresh and warns when OAuth client credentials are absent", () => {
		const { oauthConfigs, warnings } = captureOAuthConfig({ oauth: undefined });

		expect(oauthConfigs.get("ws-1")).toBeUndefined();
		expect(warnings.join("\n")).toContain("token refresh disabled");
	});

	it("forwards a rotated token pair to onTokenRefresh for persistence", async () => {
		const persisted: Array<
			[string, { accessToken: string; refreshToken: string }]
		> = [];
		const { oauthConfigs } = captureOAuthConfig({
			onTokenRefresh: (workspaceId, tokens) => {
				persisted.push([workspaceId, tokens]);
			},
		});

		await oauthConfigs.get("ws-1")?.onTokenRefresh?.({
			accessToken: "token-2",
			refreshToken: "refresh-2",
		});

		expect(persisted).toEqual([
			["ws-1", { accessToken: "token-2", refreshToken: "refresh-2" }],
		]);
	});
});

describe("RouterServer containers wiring", () => {
	let server: RouterServer | undefined;

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = undefined;
		}
	});

	const CONTAINERS_CONFIG: RouterContainersConfig = {
		image: "ghcr.io/example/cyrus-worker:0.0.0-test",
		routerUrlForContainers: "ws://host.docker.internal:3456",
		repositories: [
			{
				name: "cyrus",
				githubSlug: "ceedaragents/cyrus",
				linearWorkspaceId: "ws-1",
			},
		],
		// `dbPath` below is ":memory:", whose `dirname` is ".". Without this
		// override, seeding the registry (which runs unconditionally at
		// construction whenever `repositories` is non-empty) would write
		// `repositories.json` into the package directory instead of a temp one.
		repositoriesPath: join(
			mkdtempSync(join(tmpdir(), "rs-repositories-")),
			"repositories.json",
		),
	};

	/** Minimal object that satisfies isAgentSessionCreatedWebhook + the fields EventRouter reads. */
	function createdEvent(opts: {
		sessionId: string;
		issueId: string;
		identifier: string;
		creatorEmail: string;
	}): AgentEvent {
		return {
			type: "AgentSessionEvent",
			action: "created",
			organizationId: "ws-1",
			agentSession: {
				id: opts.sessionId,
				organizationId: "ws-1",
				issueId: opts.issueId,
				issue: { id: opts.issueId, identifier: opts.identifier },
				creator: { email: opts.creatorEmail },
			},
		} as unknown as AgentEvent;
	}

	it("leaves containerLifecycle unset when `containers` is absent from config (today's behavior, unchanged)", () => {
		server = makeServer();

		expect(server.containerLifecycle).toBeUndefined();
	});

	it("constructs containerLifecycle and routes a docker-executor user's session to a per-issue container device when `containers` is configured", async () => {
		const executors: ExecutorRegistry = new Map([
			["docker", fakeExecutor("docker")],
		]);
		server = new RouterServer({
			port: 0,
			dbPath: ":memory:",
			workspaces: { "ws-1": { linearToken: "test-token" } },
			webhook: { verificationMode: "direct", secret: "test-secret" },
			trackerFactory: () => new CLIIssueTrackerService(),
			containers: CONTAINERS_CONFIG,
			executorRegistryFactory: () => executors,
		});
		expect(server.containerLifecycle).toBeDefined();

		server.store.addUser({ email: "docker-user@example.com" });
		server.store.setUserExecutor(
			"docker-user@example.com",
			'{"type":"docker"}',
		);

		// `seedRepositoryRegistry` runs fire-and-forget from the constructor (by
		// design — see RouterServer's containers wiring), so a `route()` fired
		// immediately after construction (this test never calls `start()`, which
		// is what gives seeding a chance to complete in a real boot) can race
		// ahead of it and see an empty registry. Wait for the seed to land
		// before routing, mirroring the gap `start()` naturally papers over.
		await vi.waitFor(async () => {
			const { repositories } = (await server.repositoryRegistry?.list()) ?? {
				repositories: [],
			};
			expect(repositories.length).toBeGreaterThan(0);
		});

		await server.eventRouter.route(
			createdEvent({
				sessionId: "sess-container-1",
				issueId: "issue-1",
				identifier: "CYPACK-1",
				creatorEmail: "docker-user@example.com",
			}),
		);

		expect(server.store.getContainerDeviceForIssue("CYPACK-1")).toMatchObject({
			provider: "docker",
		});
	});

	it("forwards containers.requiredSecretKeys to the boot gate", async () => {
		const docker = fakeExecutor("docker");
		const executors: ExecutorRegistry = new Map([["docker", docker]]);
		const secretsPath = join(
			mkdtempSync(join(tmpdir(), "rs-secrets-")),
			"s.json",
		);
		const logger = testLogger();
		server = new RouterServer({
			port: 0,
			dbPath: ":memory:",
			workspaces: { "ws-1": { linearToken: "t" } },
			webhook: { verificationMode: "direct", secret: "s" },
			trackerFactory: () => new CLIIssueTrackerService(),
			containers: {
				...CONTAINERS_CONFIG,
				secretsPath,
				requiredSecretKeys: ["GIT_TOKEN"],
			},
			executorRegistryFactory: () => executors,
			logger,
		});
		server.store.addUser({ email: "docker-user@example.com" });
		server.store.setUserExecutor(
			"docker-user@example.com",
			'{"type":"docker"}',
		);
		// Only the Claude token — passes the default gate, fails the GIT_TOKEN gate.
		new SecretStore(secretsPath).set(
			"docker-user@example.com",
			"CLAUDE_CODE_OAUTH_TOKEN",
			"claude-tok",
		);

		await server.eventRouter.route(
			createdEvent({
				sessionId: "sess-1",
				issueId: "issue-1",
				identifier: "CYPACK-1",
				creatorEmail: "docker-user@example.com",
			}),
		);

		await vi.waitFor(() =>
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining("Container boot failed"),
				expect.objectContaining({
					message: expect.stringContaining("is not fully authenticated"),
				}),
			),
		);
		expect(docker.ensureRunning).not.toHaveBeenCalled();
	});
});

describe("RouterServer secret backend selection", () => {
	const containers = {
		image: "example/worker:test",
		routerUrlForContainers: "ws://127.0.0.1:9/",
		repositories: [],
	};

	function build(extra: Record<string, unknown> = {}) {
		return new RouterServer({
			port: 0,
			dbPath: join(mkdtempSync(join(tmpdir(), "router-backend-")), "router.db"),
			workspaces: { "ws-1": { linearToken: "test-token" } },
			webhook: { verificationMode: "direct", secret: "test-secret" },
			trackerFactory: () => new CLIIssueTrackerService(),
			...extra,
		});
	}

	it("reports no backend when containers is absent", () => {
		const server = build();
		expect(server.secretBackendKind).toBe("none");
		server.stop();
	});

	it("falls back to the 0600 file store", () => {
		const server = build({ containers });
		expect(server.secretBackendKind).toBe("file");
		server.stop();
	});

	it("selects Key Vault when keyVaultUrl is set", () => {
		const server = build({
			containers: { ...containers, keyVaultUrl: "https://kv.vault.azure.net" },
		});
		expect(server.secretBackendKind).toBe("keyvault");
		server.stop();
	});

	it("gives tableStore precedence over keyVaultUrl", () => {
		const server = build({
			containers: {
				...containers,
				keyVaultUrl: "https://kv.vault.azure.net",
				tableStore: {
					endpoint: "https://stexample.table.core.windows.net",
					keyId: `https://kv.vault.azure.net/keys/kek/${"a".repeat(32)}`,
				},
			},
		});
		expect(server.secretBackendKind).toBe("table");
		server.stop();
	});
});

describe("RouterServer setupUi auth strategy", () => {
	// The setup page edits the per-user secret bundle, so it needs a secret
	// backend — which only exists when `containers` is configured.
	const containers = {
		image: "example/worker:test",
		routerUrlForContainers: "ws://127.0.0.1:9/",
		repositories: [],
	};

	function build(setupUi: unknown, host?: string, withContainers = true) {
		return () =>
			new RouterServer({
				port: 0,
				host,
				dbPath: join(mkdtempSync(join(tmpdir(), "router-setupui-")), "r.db"),
				workspaces: { "ws-1": { linearToken: "test-token" } },
				webhook: { verificationMode: "direct", secret: "test-secret" },
				trackerFactory: () => new CLIIssueTrackerService(),
				...(withContainers ? { containers } : {}),
				// biome-ignore lint/suspicious/noExplicitAny: exercising invalid config
				setupUi: setupUi as any,
			});
	}

	it("refuses to start when the UI is enabled with no strategy", () => {
		expect(build({ enabled: true })).toThrow(/setupUi\.auth is not set/);
	});

	it("refuses easyauth-headers until the header strip is verified", () => {
		expect(
			build({ enabled: true, auth: { mode: "easyauth-headers" } }),
		).toThrow(/verifiedHeaderStrip/);
	});

	it("refuses dev-insecure-headers off loopback", () => {
		expect(
			build(
				{ enabled: true, auth: { mode: "dev-insecure-headers" } },
				"0.0.0.0",
			),
		).toThrow(/loopback/);
	});

	it("accepts dev-insecure-headers on loopback", () => {
		const server = build(
			{ enabled: true, auth: { mode: "dev-insecure-headers" } },
			"127.0.0.1",
		)();
		expect(server).toBeInstanceOf(RouterServer);
		server.stop();
	});

	it("refuses to enable the UI without a containers block", () => {
		// F21: the plan shipped two incompatible local recipes — one enabling
		// setupUi with no containers, which cannot work because no secret
		// backend is built. Fail at construction rather than at first request.
		expect(
			build(
				{ enabled: true, auth: { mode: "dev-insecure-headers" } },
				"127.0.0.1",
				false,
			),
		).toThrow(/requires a `containers` block/);
	});

	it("does not police a disabled setup UI", () => {
		const server = build({ enabled: false })();
		expect(server).toBeInstanceOf(RouterServer);
		server.stop();
	});
});

describe("RouterServer without setupUi", () => {
	// The load-bearing "additive and non-breaking" guarantee: a deployment that
	// does not opt in must behave exactly as it did before this feature existed.
	// Driven over real HTTP rather than a Fastify inject seam, so this also
	// covers route registration actually not happening.
	async function withServer(
		fn: (base: string) => Promise<void>,
		extra: Record<string, unknown> = {},
	) {
		const server = new RouterServer({
			port: 0,
			dbPath: join(mkdtempSync(join(tmpdir(), "router-nosetup-")), "r.db"),
			workspaces: { "ws-1": { linearToken: "test-token" } },
			webhook: { verificationMode: "direct", secret: "test-secret" },
			trackerFactory: () => new CLIIssueTrackerService(),
			...extra,
		});
		await server.start();
		try {
			await fn(`http://127.0.0.1:${server.port}`);
		} finally {
			await server.stop();
		}
	}

	it.each([
		["GET", "/setup"],
		["POST", "/setup/provision"],
		["POST", "/setup/save"],
		["POST", "/setup/variables"],
		["GET", "/setup/assets/pico.css"],
		["GET", "/setup/assets/htmx.js"],
	])("404s %s %s when setupUi is absent", async (method, path) => {
		await withServer(async (base) => {
			const response = await fetch(`${base}${path}`, { method });
			expect(response.status).toBe(404);
		});
	});

	it("still answers /healthz", async () => {
		await withServer(async (base) => {
			expect((await fetch(`${base}/healthz`)).status).toBe(200);
		});
	});
});

describe("RouterServer autoProvisionUsers default", () => {
	// Pins the SHIPPED default by exercising it end to end: an unknown
	// principal provisioning successfully is the only observable difference
	// between true and false, so anything less than a real request would pass
	// regardless of the value.
	it("lets an unknown principal register when setupUi omits the field", async () => {
		const server = new RouterServer({
			port: 0,
			host: "127.0.0.1",
			dbPath: join(mkdtempSync(join(tmpdir(), "router-autoprov-")), "r.db"),
			workspaces: { "ws-1": { linearToken: "test-token" } },
			webhook: { verificationMode: "direct", secret: "test-secret" },
			trackerFactory: () => new CLIIssueTrackerService(),
			containers: {
				image: "example/worker:test",
				routerUrlForContainers: "ws://127.0.0.1:9/",
				repositories: [],
			},
			setupUi: { enabled: true, auth: { mode: "dev-insecure-headers" } },
		});
		await server.start();
		try {
			const base = `http://127.0.0.1:${server.port}`;
			const identity = { "x-ms-client-principal-name": "stranger@example.com" };

			const page = await fetch(`${base}/setup`, { headers: identity });
			expect(page.status).toBe(200);
			const csrf = /name="csrf" value="([^"]+)"/.exec(await page.text())?.[1];
			expect(csrf).toBeTruthy();

			const provision = await fetch(`${base}/setup/provision`, {
				method: "POST",
				headers: {
					...identity,
					"content-type": "application/x-www-form-urlencoded",
				},
				body: `csrf=${encodeURIComponent(String(csrf))}`,
			});

			// The whole point: with the default flipped to false this is a 403.
			expect(provision.status).not.toBe(403);
			expect(server.store.listUsers().map((u) => u.email)).toContain(
				"stranger@example.com",
			);
		} finally {
			await server.stop();
		}
	});
});
