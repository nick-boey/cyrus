// apps/f1/test/router/observability-commands.test.ts
/**
 * CYR-78's automated F1 matrix: the remote-operator surface driven END TO END,
 * with the SHIPPED CLI commands talking over a real socket to a real
 * `RouterServer` backed by a real `RouterStore`.
 *
 * ── WHY THIS EXISTS ALONGSIDE THE UNIT SUITES ──
 * `packages/router/test/fleet-operations/*` pins each router-side decision
 * against a hand-built store, and `apps/cli/src/**\/*.test.ts` pins each command
 * against a hand-written fake router. Both are stronger than this file at what
 * they cover — and neither can catch the one failure they share a blind spot
 * for: the two halves disagreeing. A command that asks for `?state=` where the
 * router reads `?lifecycle=`, a capability advertised in one vocabulary and
 * gated in another, a cursor the router mints and the client cannot parse — each
 * passes both suites and fails in production. So nothing here fakes a router
 * document or a router response: every run row is produced by routing a real
 * webhook through `EventRouter`, and every command reads it back over HTTP.
 *
 * The one thing deliberately NOT exercised here is the log BACKEND. Log records
 * never travel through the router (CYR-73), so an F1 rig has nothing to say
 * about Azure; what F1 can prove — and does below — is that the CLI asks the
 * router only for the descriptor, and that no router route serves log records at
 * all.
 */
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import {
	buildProgram,
	REMOTE_PROFILE_REGISTERED,
} from "cyrus-ai/dist/src/buildProgram.js";
import { LogsCommand } from "cyrus-ai/dist/src/commands/LogsCommand.js";
import { RecoverCommand } from "cyrus-ai/dist/src/commands/RecoverCommand.js";
import { RunsCommand } from "cyrus-ai/dist/src/commands/RunsCommand.js";
import { SkillsCommand } from "cyrus-ai/dist/src/commands/SkillsCommand.js";
import { ExitCode } from "cyrus-ai/dist/src/remote/exitCodes.js";
import { FakeLogSourceAdapter } from "cyrus-ai/dist/src/remote/logs/FakeLogSourceAdapter.js";
import { LogAdapterRegistry } from "cyrus-ai/dist/src/remote/logs/LogAdapterRegistry.js";
import { createRecordingOutput } from "cyrus-ai/dist/src/remote/output.js";
import { RouterConnection } from "cyrus-router-client";
import type {
	ContainerExecutor,
	ContainerStatus,
	IssueExecutionContext,
} from "cyrus-router-executors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createdFixture,
	seedSession,
	WORKSPACE,
} from "../../src/router/fixtures.js";
import { createRouterRig, type RouterRig } from "../../src/router/RouterRig.js";

/* ------------------------------------------------------------------ scaffolding */

/** `apps/f1/test/router` → the monorepo root. */
const REPO_ROOT = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
);

const WS_A = WORKSPACE;
const WS_B = "ws-2";
const TENANT = "11111111-1111-1111-1111-111111111111";
const AUDIENCE = "api://cyrus-router-f1";
const OID_READER = "oid-reader-0001";
const GROUP_RESPONDERS = "group-responders-0001";

const CREATOR = {
	id: "lin-fleet",
	email: "fleet@example.com",
	name: "Fleet Operator",
};

/** A log source the SHIPPED `LogAdapterRegistry` can resolve without Azure. */
const FAKE_LOG_SOURCE = {
	schemaVersion: 1 as const,
	kind: "fake" as const,
	displayName: "F1 fake log source",
	budgets: {
		defaultLookbackSeconds: 900,
		maxRangeSeconds: 3600,
		maxRecords: 50,
		minFollowIntervalSeconds: 5,
	},
};

const ADVERTISED_SKILL = {
	name: "cyrus-fleet-operator",
	version: "9.9.9",
	releaseUrl: "https://github.com/cyrusagents/cyrus/releases/tag/v9.9.9",
	checksum: `sha256:${"0".repeat(64)}`,
};

/**
 * A container executor that records boots and, on request, brings a REAL
 * device-side WebSocket up against the rig.
 *
 * The socket is the point: `RouterRunReconciler` decides on
 * `DeviceGateway.isOnline` and on the worker's own `sessions_report`, neither of
 * which a stubbed executor can produce. `claims` is what the fake worker will
 * answer the router's `sessions_query` with — an empty list is the disowned case
 * the release path exists for, and a list containing the session is the
 * "ownership was never stale" case that must NOT release anything.
 */
class FakeContainerExecutor implements ContainerExecutor {
	readonly provider = "docker";
	readonly boots: string[] = [];
	/** Sessions the fake worker will claim, keyed by issue key. */
	readonly claims = new Map<string, string[]>();
	/** Set false to model a container that never comes back. */
	connectOnBoot = false;

	private readonly tokens = new Map<string, string>();
	private readonly statuses = new Map<string, ContainerStatus>();
	private readonly connections = new Map<string, RouterConnection>();

	constructor(
		private readonly getPort: () => number,
		private readonly stateRoot: string,
	) {}

	async ensureRunning(ctx: IssueExecutionContext): Promise<void> {
		this.boots.push(ctx.issueKey);
		if (!this.tokens.has(ctx.issueKey)) {
			this.tokens.set(ctx.issueKey, ctx.mintDeviceToken());
		}
		this.statuses.set(ctx.issueKey, "running");
		if (this.connectOnBoot) await this.connect(ctx.issueKey);
	}

	async stop(issueKey: string): Promise<void> {
		this.disconnect(issueKey);
		this.statuses.set(issueKey, "stopped");
	}

	async destroy(issueKey: string): Promise<void> {
		this.disconnect(issueKey);
		this.statuses.delete(issueKey);
	}

	async status(issueKey: string): Promise<ContainerStatus> {
		return this.statuses.get(issueKey) ?? "absent";
	}

	async listManaged(): Promise<string[]> {
		return [...this.statuses.keys()];
	}

	/** The container device token minted for an issue, for the principal matrix. */
	tokenFor(issueKey: string): string {
		const token = this.tokens.get(issueKey);
		if (!token) throw new Error(`no container token for ${issueKey}`);
		return token;
	}

	/** Brings the fake worker up out of band (used to model an ALREADY-live run). */
	async connect(issueKey: string): Promise<void> {
		if (this.connections.has(issueKey)) return;
		const token = this.tokenFor(issueKey);
		const connection = new RouterConnection({
			url: `ws://127.0.0.1:${this.getPort()}`,
			deviceToken: token,
			stateDir: join(this.stateRoot, issueKey),
			reconnectBaseMs: 20,
			rpcTimeoutMs: 2_000,
			getActiveSessions: () => this.claims.get(issueKey) ?? [],
		});
		connection.on("error", () => {});
		// A consumer is what makes the router's queued event ACKED. Without one
		// `RouterConnection` keeps the entry on disk for replay, `hasPendingEvents`
		// stays true, and every recovery refuses to judge the worker's silence —
		// correctly, which is why the fake has to behave like a real worker here.
		connection.on("event", () => {});
		this.connections.set(issueKey, connection);
		const connected = once(connection, "connected");
		connection.connect();
		await connected;
	}

	disconnect(issueKey: string): void {
		this.connections.get(issueKey)?.close();
		this.connections.delete(issueKey);
	}

	closeAll(): void {
		for (const key of [...this.connections.keys()]) this.disconnect(key);
	}
}

/** A JWT-SHAPED Entra access token. Only the payload is ever read. */
function entraToken(claims: Record<string, unknown>): string {
	const b64 = (value: unknown) =>
		Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
	return `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.signature`;
}

function entraClaims(overrides: Record<string, unknown> = {}) {
	return {
		tid: TENANT,
		iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
		aud: AUDIENCE,
		oid: OID_READER,
		name: "Ada Reader",
		exp: Math.floor(Date.now() / 1000) + 3600,
		...overrides,
	};
}

interface Harness {
	rig: RouterRig;
	exec: FakeContainerExecutor;
	dir: string;
	events: Array<{ name: string; attributes?: Record<string, unknown> }>;
	url: string;
	stop(): Promise<void>;
}

async function startHarness(
	options: {
		workspaces?: string[];
		recovery?: boolean;
		logSource?: boolean;
		dbPath?: string;
		dir?: string;
		/** Overrides the advertised skill's checksum. */
		skillChecksum?: string;
		/** Replaces the real coordinator. Only the restart case needs one. */
		runReconciler?: any;
	} = {},
): Promise<Harness> {
	const dir = options.dir ?? mkdtempSync(join(tmpdir(), "f1-obs-"));
	const events: Harness["events"] = [];
	const workspaces = options.workspaces ?? [WS_A];
	let port = 0;
	const exec = new FakeContainerExecutor(() => port, join(dir, "devices"));
	const rig = await createRouterRig({
		dbPath: options.dbPath ?? ":memory:",
		secretsPath: join(dir, "secrets.json"),
		artifactsDir: join(dir, "artifacts"),
		// Loopback: nothing in this file reaches the rig from inside a container,
		// and binding every interface prompts the Windows firewall on each run.
		host: "127.0.0.1",
		executors: new Map([["docker", exec]]),
		workspaces,
		// The release path is only reachable once a session is older than the
		// grace a freshly routed one gets; the replay window is a pure sleep.
		affinityGraceMs: 0,
		recoveryReplayMs: 0,
		recoveryReconnectTimeoutMs: 5_000,
		repositories: workspaces.map((workspaceId, index) => ({
			name: `repo-${index}`,
			githubSlug: `octocat/repo-${index}`,
			linearWorkspaceId: workspaceId,
			baseBranch: "master",
		})),
		fleetOperations: {
			routerId: "f1-router",
			routerName: "F1 router",
			access: {
				entra: {
					tenantId: TENANT,
					audience: AUDIENCE,
					grants: [
						{
							principalIds: [OID_READER],
							roles: ["fleet.read"],
							workspaceIds: [WS_A],
						},
						{
							principalIds: [GROUP_RESPONDERS],
							roles: ["fleet.read", "fleet.recover"],
							workspaceIds: workspaces,
						},
					],
				},
			},
			...(options.logSource === false ? {} : { logSource: FAKE_LOG_SOURCE }),
			skill: {
				...ADVERTISED_SKILL,
				...(options.skillChecksum ? { checksum: options.skillChecksum } : {}),
			},
			...(options.recovery ? { recovery: { enabled: true } } : {}),
		},
		// Returns the token's own claims; `OperatorAuthorizer` re-checks tenant,
		// issuer, audience, expiry, `oid`, and `idtyp` itself, so the authorization
		// decision under test is the real one.
		...(options.runReconciler ? { runReconciler: options.runReconciler } : {}),
		operatorTokenVerifier: async (token: string) =>
			JSON.parse(
				Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"),
			) as Record<string, unknown>,
		logger: {
			event: (name, attributes) => {
				events.push({ name, ...(attributes ? { attributes } : {}) });
			},
		},
	});
	port = rig.port;
	await rig.seedUser({
		email: CREATOR.email,
		linearId: CREATOR.id,
		provider: "docker",
		claudeOauthToken: "tok",
	});
	return {
		rig,
		exec,
		dir,
		events,
		url: `http://127.0.0.1:${rig.port}`,
		async stop() {
			exec.closeAll();
			await rig.stop();
		},
	};
}

/** Routes a `created` webhook and returns the run row it produced. */
async function routeRun(
	h: Harness,
	opts: {
		sessionId: string;
		issueId: string;
		identifier: string;
		workspace?: string;
	},
) {
	seedSession(h.rig.tracker, opts.sessionId, opts.issueId);
	await h.rig.server.eventRouter.route(
		createdFixture({
			sessionId: opts.sessionId,
			issue: {
				id: opts.issueId,
				identifier: opts.identifier,
				title: `F1 ${opts.identifier}`,
			},
			creator: CREATOR,
			...(opts.workspace ? { workspace: opts.workspace } : {}),
		}),
	);
	const run = h.rig.server.store.getAgentRunForSession(opts.sessionId);
	if (!run) throw new Error(`session ${opts.sessionId} was not routed`);
	return run;
}

/**
 * Produces a REAL strand: the container booted, its worker ran the session and
 * drained the router's queue, and then the worker died while the affinity and
 * the issue lock stayed behind.
 *
 * Doing it in that order matters. A run whose event was never delivered is not
 * stranded — it is un-started, and the reconciler refuses to judge a worker's
 * silence about work it may not have received yet. Skipping the first connect
 * would test that refusal while claiming to test recovery.
 */
async function strandRun(
	h: Harness,
	opts: { sessionId: string; issueId: string; identifier: string },
) {
	const run = await routeRun(h, opts);
	await vi.waitFor(() => expect(h.exec.boots).toContain(opts.identifier));
	// The worker claims the session on this first connect, so the router's own
	// reconnect reconciliation leaves the pin alone.
	h.exec.claims.set(opts.identifier, [opts.sessionId]);
	await h.exec.connect(opts.identifier);
	await vi.waitFor(() =>
		expect(h.rig.server.store.hasPendingEvents(run.deviceId, Date.now())).toBe(
			false,
		),
	);
	h.exec.disconnect(opts.identifier);
	h.rig.server.store.setRunExecutorState(run.deviceId, "stopped", Date.now());
	const store = h.rig.server.store;
	expect(store.getSessionAffinity(opts.sessionId)).toBe(run.deviceId);
	expect(store.getIssueLock(opts.issueId)?.sessionId).toBe(opts.sessionId);
	return store.getAgentRunById(run.runId) ?? run;
}

/** A local operator token together with the env a command reads it from. */
function localToken(
	h: Harness,
	label: string,
	roles: Array<"fleet.read" | "fleet.recover">,
	workspaceIds: string[],
): string {
	return h.rig.server.store.createOperatorToken({ label, roles, workspaceIds })
		.token;
}

/** An `Application` exposing only what the remote commands touch. */
function fakeApp(url: string, connectionName = "f1", version = "9.9.9") {
	const config = {
		repositories: [],
		operatorConnections: {
			[connectionName]: {
				url,
				auth: { kind: "local", tokenEnv: "CYRUS_OPERATOR_TOKEN" },
			},
		},
	};
	return {
		config: {
			load: () => structuredClone(config),
			save: () => {},
			getConfigPath: () => join(tmpdir(), "f1-observability-config.json"),
		},
		logger: { raw: () => {}, error: () => {}, success: () => {} },
		// `SkillsCommand` measures the router's advertised skill against this,
		// which is the lockstep rule CYR-77 ships.
		version,
	} as any;
}

class ExitSignal extends Error {
	constructor(readonly code: number) {
		super(`exit ${code}`);
	}
}

/** Runs a command through `execute`, capturing the exit code it chose. */
async function exitCodeOf(
	cmd: any,
	argv: string[],
	selection: { connection?: string; workspace?: string } = {},
): Promise<number> {
	const exit = vi.spyOn(process, "exit").mockImplementation(((
		code?: number,
	) => {
		throw new ExitSignal(code ?? 0);
	}) as never);
	try {
		await cmd.execute(argv, selection);
		return ExitCode.success;
	} catch (error) {
		if (error instanceof ExitSignal) return error.code;
		throw error;
	} finally {
		exit.mockRestore();
	}
}

/* -------------------------------------------------- public discovery surface */

describe("public discovery leaks no scoped data", () => {
	let h: Harness;
	beforeEach(async () => {
		h = await startHarness({ workspaces: [WS_A, WS_B], recovery: true });
	});
	afterEach(async () => {
		await h.stop();
		rmSync(h.dir, { recursive: true, force: true });
	});

	it("answers anonymously with identity and auth methods, and nothing scoped", async () => {
		await routeRun(h, {
			sessionId: "sess-disc",
			issueId: "issue-disc",
			identifier: "CYOBS-1",
		});
		const response = await fetch(`${h.url}/.well-known/cyrus`);
		expect(response.status).toBe(200);
		const body = await response.text();
		const document = JSON.parse(body);

		expect(document).toEqual({
			schemaVersion: 1,
			routerId: "f1-router",
			routerName: "F1 router",
			operatorApiVersions: expect.arrayContaining(["v1"]),
			authentication: {
				methods: ["entra", "device-token", "local-operator-token"],
				entra: { tenantId: TENANT, audience: AUDIENCE },
			},
		});
		// Serialized-body scan rather than key assertions: the disclosure this
		// route exists to prevent is a VALUE appearing anywhere in it, at any
		// nesting a future field might introduce.
		for (const secretish of [
			WS_A,
			WS_B,
			"CYOBS-1",
			"sess-disc",
			OID_READER,
			GROUP_RESPONDERS,
			"logSource",
			"budgets",
			"capabilities",
		]) {
			expect(body).not.toContain(secretish);
		}
	});

	it("serves no route that returns log records", async () => {
		for (const path of ["/api/v1/logs", "/api/v1/log-records", "/logs"]) {
			const response = await fetch(`${h.url}${path}`);
			expect(response.status).toBe(404);
		}
	});
});

/* ---------------------------------------------------------- principal matrix */

describe("each principal receives exactly its roles and workspaces", () => {
	let h: Harness;
	beforeEach(async () => {
		h = await startHarness({ workspaces: [WS_A, WS_B], recovery: true });
	});
	afterEach(async () => {
		await h.stop();
		rmSync(h.dir, { recursive: true, force: true });
	});

	const context = async (authorization: string) => {
		const response = await fetch(`${h.url}/api/v1/operator/context`, {
			headers: { authorization },
		});
		return { status: response.status, body: await response.json() };
	};

	it("gives a read-only local token read capabilities over its own workspace only", async () => {
		const token = localToken(h, "reader", ["fleet.read"], [WS_A]);
		const { status, body } = await context(`Bearer ${token}`);
		expect(status).toBe(200);
		expect(body.authMethod).toBe("local-operator-token");
		expect(body.roles).toEqual(["fleet.read"]);
		expect(body.capabilities).toEqual([
			"runs.list",
			"runs.changes",
			"logs.query",
		]);
		expect(body.authorizedWorkspaces).toEqual([{ workspaceId: WS_A }]);
		expect(body.logSource).toEqual(FAKE_LOG_SOURCE);
		expect(body.skill).toEqual(ADVERTISED_SKILL);
	});

	it("gives a recover-capable local token the mutation capability too", async () => {
		const token = localToken(
			h,
			"responder",
			["fleet.read", "fleet.recover"],
			[WS_A, WS_B],
		);
		const { body } = await context(`Bearer ${token}`);
		expect(body.roles).toEqual(["fleet.read", "fleet.recover"]);
		expect(body.capabilities).toContain("recoveries.request");
		expect(
			body.authorizedWorkspaces.map(
				(w: { workspaceId: string }) => w.workspaceId,
			),
		).toEqual([WS_A, WS_B]);
	});

	it("narrows an Entra principal to the grant its object id matches", async () => {
		const { status, body } = await context(
			`Bearer ${entraToken(entraClaims())}`,
		);
		expect(status).toBe(200);
		expect(body.authMethod).toBe("entra");
		expect(body.principalId).toBe(OID_READER);
		expect(body.displayName).toBe("Ada Reader");
		expect(body.roles).toEqual(["fleet.read"]);
		expect(body.capabilities).not.toContain("recoveries.request");
		expect(body.authorizedWorkspaces).toEqual([{ workspaceId: WS_A }]);
	});

	it("adds a group-keyed grant's roles and workspaces to the same principal", async () => {
		const { body } = await context(
			`Bearer ${entraToken(entraClaims({ groups: [GROUP_RESPONDERS] }))}`,
		);
		expect(body.roles).toEqual(["fleet.read", "fleet.recover"]);
		expect(
			body.authorizedWorkspaces.map(
				(w: { workspaceId: string }) => w.workspaceId,
			),
		).toEqual([WS_A, WS_B]);
	});

	it("refuses an app-only Entra token, a foreign tenant, and a foreign audience", async () => {
		expect(
			(await context(`Bearer ${entraToken(entraClaims({ idtyp: "app" }))}`))
				.status,
		).toBe(403);
		expect(
			(await context(`Bearer ${entraToken(entraClaims({ tid: "other" }))}`))
				.status,
		).toBe(401);
		expect(
			(
				await context(
					`Bearer ${entraToken(entraClaims({ aud: "api://something-else" }))}`,
				)
			).status,
		).toBe(401);
	});

	it("keeps a physical device token at read-only, owner-scoped authority", async () => {
		const store = h.rig.server.store;
		const code = store.mintEnrollmentCode(CREATOR.email, Date.now());
		const redeemed = store.redeemEnrollmentCode(code, Date.now());
		const { status, body } = await context(`Bearer ${redeemed?.deviceToken}`);
		expect(status).toBe(200);
		expect(body.authMethod).toBe("device-token");
		expect(body.roles).toEqual(["fleet.read"]);
		// `logs.query` is withheld because the router cannot narrow a log query to
		// one owner; `recoveries.request` because the role is absent.
		expect(body.capabilities).toEqual(["runs.list", "runs.changes"]);
	});

	it("refuses a container device token outright", async () => {
		await routeRun(h, {
			sessionId: "sess-container",
			issueId: "issue-container",
			identifier: "CYOBS-CT",
		});
		await vi.waitFor(() => expect(h.exec.boots).toContain("CYOBS-CT"));
		const { status, body } = await context(
			`Bearer ${h.exec.tokenFor("CYOBS-CT")}`,
		);
		expect(status).toBe(403);
		expect(body).toEqual({ error: "forbidden" });
	});

	it("refuses a missing and an unknown credential without explaining itself", async () => {
		const response = await fetch(`${h.url}/api/v1/operator/context`);
		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: "unauthorized" });
		expect((await context("Bearer cyop_not_a_real_token")).status).toBe(401);
	});
});

/* ------------------------------------------------- remote profile boundaries */

describe("the remote command profile exposes only the approved surface", () => {
	const reporter = { captureException: () => {} };

	it("registers exactly the approved vocabulary and nothing else", () => {
		const program = buildProgram({ version: "9.9.9" }, reporter as any, {
			argv: ["node", "cyrus", "--profile", "remote"],
			env: {},
		});
		expect(
			program.commands.map((c: { name(): string }) => c.name()).sort(),
		).toEqual([...REMOTE_PROFILE_REGISTERED].sort());
	});

	it("keeps the same vocabulary present in the full profile", () => {
		const program = buildProgram({ version: "9.9.9" }, reporter as any, {
			argv: ["node", "cyrus"],
			env: {},
		});
		const names = program.commands.map((c: { name(): string }) => c.name());
		for (const command of REMOTE_PROFILE_REGISTERED) {
			expect(names).toContain(command);
		}
		// The worker surface the remote profile withholds.
		expect(names).toContain("router");
		expect(names).toContain("start");
	});
});

/* --------------------------------------------------- run observation matrix */

describe("runs list, watch, and wait over the real router", () => {
	let h: Harness;
	let token: string;
	beforeEach(async () => {
		h = await startHarness({ workspaces: [WS_A, WS_B] });
		token = localToken(h, "reader", ["fleet.read"], [WS_A, WS_B]);
	});
	afterEach(async () => {
		await h.stop();
		rmSync(h.dir, { recursive: true, force: true });
	});

	const runsCommand = (out = createRecordingOutput()) => ({
		out,
		cmd: new RunsCommand(fakeApp(h.url), {
			env: { CYRUS_OPERATOR_TOKEN: token },
			output: out,
			sleep: async () => {},
			pollIntervalMs: 0,
		}),
	});

	it("requires an explicit workspace when the connection authorizes more than one", async () => {
		const { cmd, out } = runsCommand();
		expect(await exitCodeOf(cmd, ["list"])).toBe(ExitCode.usage);
		expect(out.diagnostics.join("\n")).toMatch(/--workspace/);
	});

	it("scopes a listing to the selected workspace", async () => {
		await routeRun(h, {
			sessionId: "sess-a",
			issueId: "issue-a",
			identifier: "CYOBS-A",
		});
		await routeRun(h, {
			sessionId: "sess-b",
			issueId: "issue-b",
			identifier: "CYOBS-B",
			workspace: WS_B,
		});

		const { cmd, out } = runsCommand();
		expect(await exitCodeOf(cmd, ["list", "--json"], { workspace: WS_B })).toBe(
			ExitCode.success,
		);
		const document = JSON.parse(out.data_.join(""));
		expect(document.workspace.workspaceId).toBe(WS_B);
		expect(document.runs.map((r: { issueKey: string }) => r.issueKey)).toEqual([
			"CYOBS-B",
		]);
	});

	it("reports every lifecycle state the store can hold", async () => {
		const store = h.rig.server.store;
		const seeded: Array<[string, string]> = [];
		for (const identifier of [
			"ACTIVE",
			"WAITING",
			"PENDING",
			"COMPLETE",
			"ERROR",
			"STOPPED",
			"UNKNOWN",
		]) {
			const sessionId = `sess-${identifier}`;
			await routeRun(h, {
				sessionId,
				issueId: `issue-${identifier}`,
				identifier: `CY-${identifier}`,
			});
			seeded.push([identifier, sessionId]);
		}
		const now = Date.now();
		store.setAgentRunState(
			"sess-WAITING",
			"waiting",
			{
				wait: {
					reason: "elicitation",
					sinceMs: now,
					reportedCondition: "which repo?",
				},
				runner: "claude",
			},
			now,
		);
		store.setAgentRunState(
			"sess-PENDING",
			"active",
			{ pendingWorkCount: 2, runner: "claude" },
			now,
		);
		store.finishAgentRun("sess-COMPLETE", "complete", now, {
			runner: "claude",
		});
		store.finishAgentRun("sess-ERROR", "error", now, { runner: "claude" });
		store.finishAgentRun("sess-STOPPED", "stopped", now, { runner: "claude" });
		store.markAgentRunUnknown("sess-UNKNOWN", now);

		const { cmd, out } = runsCommand();
		expect(await exitCodeOf(cmd, ["list", "--json"], { workspace: WS_A })).toBe(
			ExitCode.success,
		);
		const runs = JSON.parse(out.data_.join("")).runs as Array<{
			issueKey: string;
			lifecycle: string;
			wait?: { reason: string };
			pendingWork?: number;
		}>;
		const byKey = new Map(runs.map((run) => [run.issueKey, run]));
		// `routed` is the state a run is born in: the router dispatched it and the
		// worker has not yet reported anything about it.
		expect(byKey.get("CY-ACTIVE")?.lifecycle).toBe("routed");
		expect(byKey.get("CY-WAITING")?.lifecycle).toBe("waiting");
		expect(byKey.get("CY-WAITING")?.wait?.reason).toBe("elicitation");
		expect(byKey.get("CY-PENDING")?.lifecycle).toBe("active");
		expect(byKey.get("CY-COMPLETE")?.lifecycle).toBe("complete");
		expect(byKey.get("CY-ERROR")?.lifecycle).toBe("error");
		expect(byKey.get("CY-STOPPED")?.lifecycle).toBe("stopped");
		expect(byKey.get("CY-UNKNOWN")?.lifecycle).toBe("unknown");
		expect(seeded).toHaveLength(7);
	});

	it("waits until a run completes and exits 0", async () => {
		const run = await routeRun(h, {
			sessionId: "sess-wait-ok",
			issueId: "issue-wait-ok",
			identifier: "CY-WAIT-OK",
		});
		const { cmd, out } = runsCommand();
		const finished = exitCodeOf(cmd, ["wait", run.runId, "--json"], {
			workspace: WS_A,
		});
		// Finished AFTER the command started, so the outcome has to arrive through
		// the change feed rather than the opening snapshot.
		await new Promise((resolve) => setTimeout(resolve, 20));
		h.rig.server.store.finishAgentRun("sess-wait-ok", "complete", Date.now(), {
			runner: "claude",
		});
		expect(await finished).toBe(ExitCode.success);
		expect(JSON.parse(out.data_.join("")).outcome).toBe("complete");
	});

	it("reports an elicitation as an outcome, never as a timeout", async () => {
		const run = await routeRun(h, {
			sessionId: "sess-wait-elicit",
			issueId: "issue-wait-elicit",
			identifier: "CY-WAIT-ELICIT",
		});
		h.rig.server.store.setAgentRunState(
			"sess-wait-elicit",
			"waiting",
			{
				wait: { reason: "elicitation", sinceMs: Date.now() },
				runner: "claude",
			},
			Date.now(),
		);
		const { cmd, out } = runsCommand();
		expect(
			await exitCodeOf(cmd, ["wait", run.runId, "--json"], {
				workspace: WS_A,
			}),
		).toBe(ExitCode.outcome);
		expect(JSON.parse(out.data_.join("")).outcome).toBe("waiting");
	});

	it("reports a non-success terminal state as an outcome", async () => {
		const run = await routeRun(h, {
			sessionId: "sess-wait-err",
			issueId: "issue-wait-err",
			identifier: "CY-WAIT-ERR",
		});
		h.rig.server.store.finishAgentRun("sess-wait-err", "error", Date.now(), {
			runner: "claude",
		});
		const { cmd, out } = runsCommand();
		expect(
			await exitCodeOf(cmd, ["wait", run.runId, "--json"], {
				workspace: WS_A,
			}),
		).toBe(ExitCode.outcome);
		expect(JSON.parse(out.data_.join("")).outcome).toBe("error");
	});

	it("times out on a run that never moves, and says so is not a verdict", async () => {
		const run = await routeRun(h, {
			sessionId: "sess-wait-timeout",
			issueId: "issue-wait-timeout",
			identifier: "CY-WAIT-TO",
		});
		let clock = Date.parse("2026-09-03T00:00:00.000Z");
		const out = createRecordingOutput();
		const cmd = new RunsCommand(fakeApp(h.url), {
			env: { CYRUS_OPERATOR_TOKEN: token },
			output: out,
			sleep: async () => {
				clock += 10_000;
			},
			now: () => clock,
			pollIntervalMs: 0,
		});
		expect(
			await exitCodeOf(cmd, ["wait", run.runId, "--timeout", "5", "--json"], {
				workspace: WS_A,
			}),
		).toBe(ExitCode.timeout);
		const document = JSON.parse(out.data_.join(""));
		expect(document.outcome).toBe("timeout");
		expect(document.run.lifecycle).toBe("routed");
	});

	it("streams material changes to `watch` and stops at its timeout", async () => {
		await routeRun(h, {
			sessionId: "sess-watch",
			issueId: "issue-watch",
			identifier: "CY-WATCH",
		});
		let clock = Date.parse("2026-09-03T00:00:00.000Z");
		const out = createRecordingOutput();
		const cmd = new RunsCommand(fakeApp(h.url), {
			env: { CYRUS_OPERATOR_TOKEN: token },
			output: out,
			sleep: async () => {
				// One poll observes the change; the next crosses the deadline.
				h.rig.server.store.finishAgentRun("sess-watch", "complete", clock, {
					runner: "claude",
				});
				clock += 20_000;
			},
			now: () => clock,
			pollIntervalMs: 0,
		});
		expect(
			await exitCodeOf(cmd, ["watch", "--timeout", "10", "--json"], {
				workspace: WS_A,
			}),
		).toBe(ExitCode.success);
		expect(out.data_.join("\n")).toContain("CY-WATCH");
	});
});

/* ------------------------------------------------------- restart resynchronisation */

describe("a change cursor from a previous router process is refused, not silently restarted", () => {
	it("answers 410 so a client re-lists rather than assuming nothing happened", async () => {
		const dir = mkdtempSync(join(tmpdir(), "f1-obs-restart-"));
		const dbPath = join(dir, "router.db");
		const first = await startHarness({ dbPath, dir });
		const token = localToken(first, "reader", ["fleet.read"], [WS_A]);
		await routeRun(first, {
			sessionId: "sess-restart",
			issueId: "issue-restart",
			identifier: "CY-RESTART",
		});
		const page = await (
			await fetch(`${first.url}/api/v1/run-changes?from=start`, {
				headers: { authorization: `Bearer ${token}` },
			})
		).json();
		const cursor = page.nextCursor as string;
		expect(cursor).toBeTruthy();
		await first.stop();

		// Same database, new process: the cursor's signature still verifies (the
		// key is persisted) and only the stream epoch has rotated, which is exactly
		// the case a `410` has to be reserved for.
		const second = await startHarness({ dbPath, dir });
		const response = await fetch(
			`${second.url}/api/v1/run-changes?cursor=${encodeURIComponent(cursor)}`,
			{ headers: { authorization: `Bearer ${token}` } },
		);
		expect(response.status).toBe(410);
		expect((await response.json()).error).toBe("stream_gone");
		await second.stop();
		rmSync(dir, { recursive: true, force: true });
	});
});

/* --------------------------------------------------------------- log queries */

describe("log commands read the router's descriptor and nothing else", () => {
	let h: Harness;
	let token: string;
	beforeEach(async () => {
		h = await startHarness();
		token = localToken(h, "reader", ["fleet.read"], [WS_A]);
	});
	afterEach(async () => {
		await h.stop();
		rmSync(h.dir, { recursive: true, force: true });
	});

	const logsCommand = (
		registry?: LogAdapterRegistry,
		out = createRecordingOutput(),
	) => ({
		out,
		cmd: new LogsCommand(fakeApp(h.url), {
			env: { CYRUS_OPERATOR_TOKEN: token },
			output: out,
			sleep: async () => {},
			...(registry ? { registry } : {}),
		}),
	});

	it("resolves the advertised `fake` source with the SHIPPED registry and touches only the context route", async () => {
		const real = globalThis.fetch;
		const seen: string[] = [];
		globalThis.fetch = (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			seen.push(new URL(String(input)).pathname);
			return real(input, init);
		}) as typeof fetch;
		try {
			// No injected registry: this is the production selection path, which is
			// the only way to prove a `fake` source is a supported DEPLOYMENT rather
			// than a test-only branch.
			const { cmd, out } = logsCommand();
			expect(await exitCodeOf(cmd, ["query", "--json"])).toBe(ExitCode.success);
			const document = JSON.parse(out.data_.join(""));
			expect(document.records).toEqual([]);
		} finally {
			globalThis.fetch = real;
		}
		// The router was asked WHERE the logs are, and nothing else. A second path
		// here would mean records travelled back through the router.
		expect(seen).toEqual(["/api/v1/operator/context"]);
	});

	it("refuses a range beyond the advertised budget instead of truncating", async () => {
		const { cmd, out } = logsCommand();
		expect(await exitCodeOf(cmd, ["query", "--since", "6h"])).toBe(
			ExitCode.usage,
		);
		expect(out.diagnostics.join("\n")).toMatch(/3600|range/i);
	});

	it("redacts a credential that reached the backend's own records", async () => {
		const adapter = new FakeLogSourceAdapter({
			env: { CYRUS_OPERATOR_TOKEN: token },
			records: [
				{
					schemaVersion: 1 as const,
					recordId: "record-1",
					timestamp: new Date().toISOString(),
					level: "info" as const,
					message: `authorized with ${token}`,
					component: "router",
					workspaceId: WS_A,
				},
			],
		});
		const registry = new LogAdapterRegistry({
			factories: { fake: () => adapter },
		});
		const { cmd, out } = logsCommand(registry);
		expect(await exitCodeOf(cmd, ["query", "--json"])).toBe(ExitCode.success);
		const rendered = out.data_.join("\n");
		expect(rendered).not.toContain(token);
		expect(rendered).toContain("[redacted]");
		// The query the command compiled was normalized, and carried the workspace
		// it was authorized under — no query language crossed the boundary.
		expect(adapter.queries).toHaveLength(1);
		expect(adapter.queries[0]?.workspaceId).toBe(WS_A);
	});
});

/* ----------------------------------------------------------------- recovery */

describe("guarded recovery over the real router", () => {
	let h: Harness;
	let recoverToken: string;
	let readToken: string;
	beforeEach(async () => {
		h = await startHarness({ recovery: true });
		recoverToken = localToken(
			h,
			"responder",
			["fleet.read", "fleet.recover"],
			[WS_A],
		);
		readToken = localToken(h, "reader", ["fleet.read"], [WS_A]);
	});
	afterEach(async () => {
		await h.stop();
		rmSync(h.dir, { recursive: true, force: true });
	});

	const post = (body: unknown, token = recoverToken) =>
		fetch(`${h.url}/api/v1/recoveries`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		});

	/** Polls the operation resource until it reaches a terminal phase. */
	const settle = async (operationId: string) => {
		let last: Record<string, unknown> = {};
		await vi.waitFor(
			async () => {
				last = await (
					await fetch(`${h.url}/api/v1/recoveries/${operationId}`, {
						headers: { authorization: `Bearer ${recoverToken}` },
					})
				).json();
				expect(["recovered", "needs_input", "refused", "failed"]).toContain(
					last.phase,
				);
			},
			{ timeout: 10_000, interval: 25 },
		);
		return last;
	};

	it("refuses a read-only principal before any operation exists", async () => {
		const run = await routeRun(h, {
			sessionId: "sess-ro",
			issueId: "issue-ro",
			identifier: "CY-RO",
		});
		const response = await post(
			{
				schemaVersion: 1,
				runId: run.runId,
				expectedRevision: run.revision,
				idempotencyKey: "f1-readonly-1",
			},
			readToken,
		);
		expect(response.status).toBe(403);
		expect(h.events.map((e) => e.name)).toContain("recovery.refused");
		expect(h.events.map((e) => e.name)).not.toContain("recovery.accepted");
	});

	it("refuses a stale observation rather than acting on it", async () => {
		const run = await routeRun(h, {
			sessionId: "sess-stale",
			issueId: "issue-stale",
			identifier: "CY-STALE",
		});
		const response = await post({
			schemaVersion: 1,
			runId: run.runId,
			expectedRevision: run.revision + 5,
			idempotencyKey: "f1-stale-1",
		});
		expect(response.status).toBe(409);
		expect((await response.json()).error).toBe("stale_revision");
	});

	it("answers needs_input for a run waiting on an elicitation", async () => {
		const run = await routeRun(h, {
			sessionId: "sess-elicit",
			issueId: "issue-elicit",
			identifier: "CY-ELICIT",
		});
		h.rig.server.store.setAgentRunState(
			"sess-elicit",
			"waiting",
			{ wait: { reason: "elicitation", sinceMs: Date.now() } },
			Date.now(),
		);
		const current = h.rig.server.store.getAgentRunById(run.runId);
		const response = await post({
			schemaVersion: 1,
			runId: run.runId,
			expectedRevision: current?.revision,
			idempotencyKey: "f1-elicitation-1",
		});
		expect(response.status).toBe(202);
		const operation = await response.json();
		expect((await settle(operation.operationId)).phase).toBe("needs_input");
	});

	it("refuses a run whose worker is connected and still owns it", async () => {
		await routeRun(h, {
			sessionId: "sess-live",
			issueId: "issue-live",
			identifier: "CY-LIVE",
		});
		await vi.waitFor(() => expect(h.exec.boots).toContain("CY-LIVE"));
		h.exec.claims.set("CY-LIVE", ["sess-live"]);
		await h.exec.connect("CY-LIVE");
		const current = h.rig.server.store.getAgentRunForSession("sess-live");
		const response = await post({
			schemaVersion: 1,
			runId: current?.runId,
			expectedRevision: current?.revision,
			idempotencyKey: "f1-live-owner-1",
		});
		expect(response.status).toBe(202);
		const settled = await settle((await response.json()).operationId);
		expect(settled.phase).toBe("refused");
		expect(settled.refusalReason).toBe("worker_owns_active_work");
	});

	it("joins a retry carrying the same idempotency key instead of starting a second operation", async () => {
		const run = await routeRun(h, {
			sessionId: "sess-idem",
			issueId: "issue-idem",
			identifier: "CY-IDEM",
		});
		const body = {
			schemaVersion: 1,
			runId: run.runId,
			expectedRevision: run.revision,
			idempotencyKey: "f1-idempotent-1",
		};
		const first = await post(body);
		expect(first.status).toBe(202);
		const second = await post(body);
		expect(second.status).toBe(200);
		expect((await second.json()).operationId).toBe(
			(await first.json()).operationId,
		);
		expect(h.events.map((e) => e.name)).toContain("recovery.joined");
	});

	it("boots a stopped container, disproves its ownership, and releases the strand", async () => {
		const run = await strandRun(h, {
			sessionId: "sess-strand",
			issueId: "issue-strand",
			identifier: "CY-STRAND",
		});
		const store = h.rig.server.store;
		// The recovered container comes back claiming nothing, which is what makes
		// the pin disprovable.
		h.exec.claims.set("CY-STRAND", []);
		h.exec.connectOnBoot = true;

		const response = await post({
			schemaVersion: 1,
			runId: run.runId,
			expectedRevision: run.revision,
			idempotencyKey: "f1-stranded-1",
		});
		expect(response.status).toBe(202);
		const settled = await settle((await response.json()).operationId);
		expect(settled).toMatchObject({ phase: "recovered" });
		expect(
			(settled.phases as Array<{ phase: string }>).map((entry) => entry.phase),
		).toEqual(
			expect.arrayContaining([
				"accepted",
				"starting_executor",
				"reconciling",
				"replaying",
				"recovered",
			]),
		);
		expect(store.getSessionAffinity("sess-strand")).toBeUndefined();
		expect(store.getIssueLock("issue-strand")).toBeUndefined();
		expect(store.getAgentRunById(run.runId)?.state).toBe("unknown");
		expect(h.events.map((e) => e.name)).toEqual(
			expect.arrayContaining([
				"recovery.accepted",
				"recovery.phase_changed",
				"recovery.settled",
			]),
		);
	});

	it("preserves ownership when the reconnected worker still claims the session", async () => {
		const run = await strandRun(h, {
			sessionId: "sess-claimed",
			issueId: "issue-claimed",
			identifier: "CY-CLAIMED",
		});
		const store = h.rig.server.store;
		// This container comes back STILL running the session, which is the case
		// that must release nothing.
		h.exec.connectOnBoot = true;

		const response = await post({
			schemaVersion: 1,
			runId: run.runId,
			expectedRevision: run.revision,
			idempotencyKey: "f1-still-claimed-1",
		});
		const settled = await settle((await response.json()).operationId);
		expect(settled.phase).toBe("recovered");
		const terminal = (
			settled.phases as Array<{ phase: string; detail?: string }>
		).at(-1);
		expect(terminal?.detail ?? "").toMatch(/nothing was released/i);
		// Nothing was released, so no release phase was ever announced.
		expect(
			(settled.phases as Array<{ phase: string }>).map((entry) => entry.phase),
		).not.toContain("releasing_stale_ownership");
		expect(store.getSessionAffinity("sess-claimed")).toBe(run.deviceId);
		// Untouched: still the state the route left it in, not `unknown`.
		expect(store.getAgentRunById(run.runId)?.state).toBe("routed");
	});

	it("does not advertise recovery at all when the deployment leaves it off", {
		timeout: 30_000,
	}, async () => {
		const off = await startHarness();
		try {
			const token = localToken(
				off,
				"responder",
				["fleet.read", "fleet.recover"],
				[WS_A],
			);
			const body = await (
				await fetch(`${off.url}/api/v1/operator/context`, {
					headers: { authorization: `Bearer ${token}` },
				})
			).json();
			expect(body.capabilities).not.toContain("recoveries.request");
			// The route still exists — a client must be able to tell "refused" from
			// "too old to have one" — and refuses at the capability check.
			const run = await routeRun(off, {
				sessionId: "sess-off",
				issueId: "issue-off",
				identifier: "CY-OFF",
			});
			const response = await fetch(`${off.url}/api/v1/recoveries`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					schemaVersion: 1,
					runId: run.runId,
					expectedRevision: run.revision,
					idempotencyKey: "f1-recovery-off-1",
				}),
			});
			expect(response.status).toBe(403);
		} finally {
			await off.stop();
			rmSync(off.dir, { recursive: true, force: true });
		}
	});

	it("fails an operation interrupted by a router restart rather than leaving it in flight", {
		timeout: 30_000,
	}, async () => {
		// A coordinator held mid-reconciliation is the only way to keep an
		// operation `accepted` long enough to interrupt it — and it is honest:
		// what a restart interrupts IS a reconciliation that had not finished.
		// It is RELEASED before the rig stops, because `RouterServer.stop` waits
		// for in-flight recoveries on purpose, and a coordinator that could never
		// finish would hang the shutdown rather than test it.
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const stuck = await startHarness({
			recovery: true,
			runReconciler: {
				reconcile: async () => {
					await held;
					return { phase: "failed", failureMessage: "released by the test" };
				},
			},
		});
		try {
			const token = localToken(
				stuck,
				"responder",
				["fleet.read", "fleet.recover"],
				[WS_A],
			);
			const run = await routeRun(stuck, {
				sessionId: "sess-interrupted",
				issueId: "issue-interrupted",
				identifier: "CY-INT",
			});
			const accepted = await (
				await fetch(`${stuck.url}/api/v1/recoveries`, {
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						schemaVersion: 1,
						runId: run.runId,
						expectedRevision: run.revision,
						idempotencyKey: "f1-interrupted-1",
					}),
				})
			).json();
			expect(accepted.phase).toBe("accepted");

			// What the next router process does on start-up.
			const failed = stuck.rig.server.store.failInterruptedRecoveryOperations(
				Date.now(),
				"the router restarted while this recovery was running",
			);
			expect(failed.map((operation) => operation.operationId)).toContain(
				accepted.operationId,
			);

			const settled = await (
				await fetch(`${stuck.url}/api/v1/recoveries/${accepted.operationId}`, {
					headers: { authorization: `Bearer ${token}` },
				})
			).json();
			expect(settled.phase).toBe("failed");
		} finally {
			release();
			await stuck.stop();
			rmSync(stuck.dir, { recursive: true, force: true });
		}
	});

	it("drives the whole thing through `cyrus recover`", async () => {
		const run = await strandRun(h, {
			sessionId: "sess-cli",
			issueId: "issue-cli",
			identifier: "CY-CLI",
		});
		h.exec.claims.set("CY-CLI", []);
		h.exec.connectOnBoot = true;

		const out = createRecordingOutput();
		const cmd = new RecoverCommand(fakeApp(h.url), {
			env: { CYRUS_OPERATOR_TOKEN: recoverToken },
			output: out,
			sleep: async () => {},
			pollIntervalMs: 0,
		});
		expect(await exitCodeOf(cmd, [run.runId, "--json"])).toBe(ExitCode.success);
		const document = JSON.parse(out.data_.join(""));
		expect(document.operation.phase).toBe("recovered");
		// The command posts no Linear comment, and has no client that could.
		expect(out.data_.join("\n")).not.toMatch(/linear\.app/i);
	});
});

/* ------------------------------------------------------------------- skills */

describe("the trusted operator skill installs only against its published checksum", () => {
	let h: Harness;
	let token: string;
	let home: string;

	/**
	 * A real, minimal `.tar.gz`: one 512-byte ustar header, the file body padded
	 * to a block, and the two-block end marker. Built here rather than committed
	 * so the bytes under test are the bytes the checksum is taken over.
	 */
	function skillArchive(body: string): Uint8Array {
		const header = Buffer.alloc(512);
		header.write("cyrus-fleet-operator/SKILL.md", 0, "utf8");
		header.write("0000644\0", 100);
		header.write(
			`${Buffer.byteLength(body).toString(8).padStart(11, "0")}\0`,
			124,
		);
		header.write("0", 156);
		header.write("ustar\0", 257);
		header.write("00", 263);
		const content = Buffer.alloc(
			Math.ceil(Buffer.byteLength(body) / 512) * 512,
		);
		content.write(body, 0, "utf8");
		return new Uint8Array(
			gzipSync(Buffer.concat([header, content, Buffer.alloc(1024)])),
		);
	}

	const sha256 = (bytes: Uint8Array) =>
		`sha256:${createHash("sha256").update(bytes).digest("hex")}`;

	beforeEach(async () => {
		home = mkdtempSync(join(tmpdir(), "f1-obs-home-"));
		h = await startHarness();
	});
	afterEach(async () => {
		await h.stop();
		rmSync(h.dir, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	/**
	 * Runs `cyrus skills install` against the rig, with the RELEASE MIRROR faked
	 * and the router real. `served` is what the mirror hands back; `published` is
	 * the digest its `.sha256` sidecar states.
	 */
	async function install(options: {
		published: string;
		served: Uint8Array;
		cliVersion?: string;
	}) {
		const real = globalThis.fetch;
		const reached: string[] = [];
		const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			reached.push(url.href);
			if (url.hostname === "127.0.0.1") return real(input, init);
			if (url.pathname.endsWith(".sha256")) {
				return new Response(options.published.replace("sha256:", ""));
			}
			return new Response(options.served);
		}) as typeof fetch;
		const cmd = new SkillsCommand(
			fakeApp(h.url, "f1", options.cliVersion ?? ADVERTISED_SKILL.version),
			{ env: { CYRUS_OPERATOR_TOKEN: token }, homeDir: home, fetchFn },
		);
		return {
			code: await exitCodeOf(cmd, [
				"install",
				"cyrus-fleet-operator",
				"--target",
				"claude",
			]),
			reached,
		};
	}

	it("installs a release whose bytes match the advertised checksum", async () => {
		const archive = skillArchive("# Fleet operator\n");
		const digest = sha256(archive);
		await restartWithSkillChecksum(digest);
		token = localToken(h, "reader", ["fleet.read"], [WS_A]);
		const { code, reached } = await install({
			published: digest,
			served: archive,
		});
		expect(code).toBe(ExitCode.success);
		// The archive came from the official release origin, never from the router.
		expect(
			reached
				.filter((url) => !url.includes("127.0.0.1"))
				.every((url) =>
					url.startsWith("https://github.com/cyrusagents/cyrus/releases/"),
				),
		).toBe(true);
	});

	it("refuses a release whose bytes were altered after publication", async () => {
		const archive = skillArchive("# Fleet operator\n");
		const digest = sha256(archive);
		const tampered = new Uint8Array(archive);
		tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;
		await restartWithSkillChecksum(digest);
		token = localToken(h, "reader", ["fleet.read"], [WS_A]);
		const { code } = await install({ published: digest, served: tampered });
		expect(code).toBe(ExitCode.usage);
	});

	it("refuses a router whose advertised checksum disagrees with the published one", async () => {
		const archive = skillArchive("# Fleet operator\n");
		const digest = sha256(archive);
		await restartWithSkillChecksum(`sha256:${"a".repeat(64)}`);
		token = localToken(h, "reader", ["fleet.read"], [WS_A]);
		const { code } = await install({ published: digest, served: archive });
		expect(code).toBe(ExitCode.usage);
	});

	it("refuses a skill version this CLI is not in lockstep with", async () => {
		const archive = skillArchive("# Fleet operator\n");
		const digest = sha256(archive);
		await restartWithSkillChecksum(digest);
		token = localToken(h, "reader", ["fleet.read"], [WS_A]);
		const { code, reached } = await install({
			published: digest,
			served: archive,
			cliVersion: "0.1.0",
		});
		expect(code).toBe(ExitCode.usage);
		// Refused before anything was downloaded.
		expect(reached.filter((url) => !url.includes("127.0.0.1"))).toEqual([]);
	});

	/** Restarts the rig advertising a specific skill checksum. */
	async function restartWithSkillChecksum(checksum: string): Promise<void> {
		await h.stop();
		rmSync(h.dir, { recursive: true, force: true });
		h = await startHarness({ skillChecksum: checksum });
	}
});

/* ---------------------------------------------- the skill's scripted decisions */

describe("the shipped fleet-operator skill scripts every branch the drive walks", () => {
	/** SKILL.md plus every reference it delegates to — the instructions as a whole. */
	function skillCorpus(): string {
		const root = join(REPO_ROOT, "skills", "cyrus-fleet-operator");
		const files = [
			join(root, "SKILL.md"),
			...readdirSync(join(root, "references")).map((name) =>
				join(root, "references", name),
			),
		];
		return files.map((file) => readFileSync(file, "utf8")).join("\n");
	}

	it("scripts an observe path, a narrow-log path, a recover path, and a stop path", () => {
		const skill = skillCorpus();
		// OBSERVE and NARROW-LOG: the commands the skill is allowed to reach for.
		for (const phrase of [
			"cyrus runs list",
			"cyrus runs watch",
			"cyrus logs query",
			"cyrus recover",
		]) {
			expect(skill).toContain(phrase);
		}
		// RECOVER: the two facts that make an unattended recovery safe.
		expect(skill).toMatch(/idempotency/i);
		expect(skill).toMatch(/revision/i);
		// STOP: the states the skill must hand back to a human rather than act on.
		expect(skill).toMatch(/needs[_ ]input/i);
		expect(skill).toMatch(/refus/i);
		expect(skill).toMatch(/stale/i);
	});

	it("names no command outside the remote profile", () => {
		// Every `cyrus <verb>` the instructions mention, whether prescribed or
		// merely discussed. A skill that names `router unlock` at all is one an
		// orchestrator can talk itself into running.
		const verbs = new Set(
			[...skillCorpus().matchAll(/\bcyrus\s+([a-z][a-z-]*)/g)].map(
				(match) => match[1] as string,
			),
		);
		// The observe-and-recover core has to be there; `skills` is how the skill
		// is installed, not something it invokes.
		for (const required of ["connection", "runs", "logs", "recover"]) {
			expect([...verbs]).toContain(required);
		}
		for (const verb of verbs) {
			expect(REMOTE_PROFILE_REGISTERED).toContain(verb);
		}
	});
});
