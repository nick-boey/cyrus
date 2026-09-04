import type { EdgeConfig } from "cyrus-core";
import type {
	OperatorContextV1,
	PublicRouterMetadataV1,
} from "cyrus-operator-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Application } from "../Application.js";
import type { EntraCredentialCandidate } from "../remote/credentials.js";
import {
	AuthorizationError,
	EXIT_AUTH,
	EXIT_USAGE,
	TransientError,
	UsageError,
} from "../remote/errors.js";
import {
	DISCOVERY_PATH,
	OPERATOR_CONTEXT_PATH,
} from "../remote/OperatorHttpClient.js";
import { ConnectionCommand } from "./ConnectionCommand.js";

const BASE_URL = "https://router.example.com";

const discoveryDocument: PublicRouterMetadataV1 = {
	schemaVersion: 1,
	routerId: "router-cyrus-dev",
	routerName: "Cyrus dev router",
	operatorApiVersions: ["v1"],
	authentication: {
		methods: ["entra", "local-operator-token"],
		entra: {
			tenantId: "8f4c1b2e-2c1a-4a3b-9d5e-6f7a8b9c0d1e",
			audience: "api://cyrus-router-dev",
		},
	},
};

const contextDocument: OperatorContextV1 = {
	schemaVersion: 1,
	principalId: "7d2e5f81-9a0b-4c3d-8e5f-6a7b8c9d0e1f",
	authMethod: "entra",
	displayName: "Fleet operations",
	roles: ["fleet.read", "fleet.recover"],
	capabilities: [
		"runs.list",
		"runs.changes",
		"logs.query",
		"recoveries.request",
	],
	authorizedWorkspaces: [{ workspaceId: "ws-1", name: "Northrop Digital" }],
	logSource: {
		schemaVersion: 1,
		kind: "azure-log-analytics",
		displayName: "rg-cyrus-dev workspace",
		azure: {
			workspaceId: "3c9f2a10-5b6c-4d7e-8f90-a1b2c3d4e5f6",
			table: "ContainerAppConsoleLogs_CL",
		},
		budgets: {
			defaultLookbackSeconds: 900,
			maxRangeSeconds: 86_400,
			maxRecords: 5_000,
			minFollowIntervalSeconds: 15,
		},
	},
	skill: {
		name: "cyrus-fleet-operator",
		version: "0.2.71",
		releaseUrl:
			"https://github.com/ceedaragents/cyrus/releases/download/v0.2.71/skill.tar.gz",
		checksum: `sha256:${"a".repeat(64)}`,
	},
	observedAt: "2026-09-04T00:00:00.000Z",
};

const entraChain: EntraCredentialCandidate[] = [
	{
		source: "azure-cli",
		create: () => ({ getToken: async () => ({ token: "entra-token" }) }),
	},
];

/** A fake `Application` exposing only what ConnectionCommand touches. */
function fakeApp(initial: Partial<EdgeConfig> = {}) {
	let config = { repositories: [], ...initial } as EdgeConfig;
	const raw: string[] = [];
	const errors: string[] = [];
	const app = {
		config: {
			load: () => structuredClone(config),
			save: (next: EdgeConfig) => {
				config = structuredClone(next);
			},
			// A path that does not exist: ConnectionStore's chmod is best-effort,
			// and this proves a chmod failure never loses the connection.
			getConfigPath: () => "/nonexistent/cyrus-connection-command/config.json",
		},
		logger: {
			raw: (message: string) => raw.push(message),
			error: (message: string) => errors.push(message),
			success: (message: string) => raw.push(message),
		},
	} as unknown as Application;
	return { app, raw, errors, current: () => config };
}

/** Routes by path so a test states which documents the router serves. */
function router(
	handlers: Partial<Record<string, () => Response>>,
): ReturnType<typeof vi.fn> {
	return vi.fn(async (url: string | URL) => {
		const path = new URL(String(url)).pathname;
		const handler = handlers[path];
		if (!handler) return new Response("", { status: 404 });
		return handler();
	});
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const healthyRouter = () =>
	router({
		[DISCOVERY_PATH]: () => json(discoveryDocument),
		[OPERATOR_CONTEXT_PATH]: () => json(contextDocument),
	});

async function catchAsync(promise: Promise<unknown>): Promise<any> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("Expected the call to reject, but it resolved.");
}

describe("ConnectionCommand add", () => {
	it("derives the Entra tenant and audience from discovery rather than from flags", async () => {
		// ADR 0010: connection setup must not require manually copying Entra
		// configuration — a value never typed cannot be typed wrong.
		const { app, current } = fakeApp();
		const fetchFn = healthyRouter();

		await new ConnectionCommand(app, {
			fetchFn: fetchFn as never,
			entraChain,
		}).run(["add", "prod", BASE_URL, "--auth", "entra"]);

		expect(current().operatorConnections).toEqual({
			prod: {
				url: BASE_URL,
				auth: {
					kind: "entra",
					tenantId: discoveryDocument.authentication.entra?.tenantId,
					audience: discoveryDocument.authentication.entra?.audience,
				},
			},
		});
	});

	it("verifies the credential against the router before saving", async () => {
		const { app, current } = fakeApp();
		const fetchFn = healthyRouter();

		await new ConnectionCommand(app, {
			fetchFn: fetchFn as never,
			entraChain,
		}).run(["add", "prod", BASE_URL, "--auth", "entra"]);

		const paths = fetchFn.mock.calls.map(
			(call) => new URL(String(call[0])).pathname,
		);
		expect(paths).toEqual([DISCOVERY_PATH, OPERATOR_CONTEXT_PATH]);
		expect(current().operatorConnections?.prod).toBeDefined();
	});

	it("saves nothing when the router refuses the credential", async () => {
		// A connection that stores cleanly and fails on first use is
		// indistinguishable, to the operator, from a fleet that is down.
		const { app, current } = fakeApp();
		const fetchFn = router({
			[DISCOVERY_PATH]: () => json(discoveryDocument),
			[OPERATOR_CONTEXT_PATH]: () => new Response("", { status: 403 }),
		});

		const error = await catchAsync(
			new ConnectionCommand(app, {
				fetchFn: fetchFn as never,
				entraChain,
			}).run(["add", "prod", BASE_URL, "--auth", "entra"]),
		);

		expect(error).toBeInstanceOf(AuthorizationError);
		expect(current().operatorConnections).toBeUndefined();
	});

	it("saves nothing when the router is unreachable", async () => {
		const { app, current } = fakeApp();
		const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

		const error = await catchAsync(
			new ConnectionCommand(app, { fetchFn: fetchFn as never }).run([
				"add",
				"prod",
				BASE_URL,
				"--auth",
				"entra",
			]),
		);

		expect(error).toBeInstanceOf(TransientError);
		expect(current().operatorConnections).toBeUndefined();
	});

	it("saves nothing when the router serves a malformed discovery document", async () => {
		const { app, current } = fakeApp();
		const fetchFn = router({
			[DISCOVERY_PATH]: () => json({ schemaVersion: 1 }),
		});

		const error = await catchAsync(
			new ConnectionCommand(app, { fetchFn: fetchFn as never }).run([
				"add",
				"prod",
				BASE_URL,
				"--auth",
				"entra",
			]),
		);

		expect(error).toBeInstanceOf(UsageError);
		expect(current().operatorConnections).toBeUndefined();
	});

	it("saves nothing when the router speaks an unsupported operator API version", async () => {
		const { app, current } = fakeApp();
		const fetchFn = router({
			[DISCOVERY_PATH]: () =>
				json({ ...discoveryDocument, operatorApiVersions: ["v2"] }),
		});

		const error = await catchAsync(
			new ConnectionCommand(app, { fetchFn: fetchFn as never }).run([
				"add",
				"prod",
				BASE_URL,
				"--auth",
				"entra",
			]),
		);

		expect(error).toBeInstanceOf(UsageError);
		expect(error.message).toContain("v2");
		expect(current().operatorConnections).toBeUndefined();
	});

	it("refuses a duplicate name without touching the network", async () => {
		const { app } = fakeApp({
			operatorConnections: {
				prod: { url: BASE_URL, auth: { kind: "local", tokenEnv: "TOKEN" } },
			},
		});
		const fetchFn = healthyRouter();

		const error = await catchAsync(
			new ConnectionCommand(app, { fetchFn: fetchFn as never }).run([
				"add",
				"prod",
				BASE_URL,
				"--auth",
				"entra",
			]),
		);

		expect(error).toBeInstanceOf(UsageError);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("refuses an invalid URL without touching the network", async () => {
		const { app } = fakeApp();
		const fetchFn = healthyRouter();

		const error = await catchAsync(
			new ConnectionCommand(app, { fetchFn: fetchFn as never }).run([
				"add",
				"prod",
				"wss://router.example.com",
				"--auth",
				"entra",
			]),
		);

		expect(error).toBeInstanceOf(UsageError);
		expect(error.message).toContain("HTTP origin");
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("refuses an invalid connection name without touching the network", async () => {
		// A purely local, statically-checkable condition must not cost two HTTP
		// round trips and a real token acquisition before it is reported.
		const { app } = fakeApp();
		const fetchFn = healthyRouter();

		const error = await catchAsync(
			new ConnectionCommand(app, { fetchFn: fetchFn as never }).run([
				"add",
				"my prod",
				BASE_URL,
				"--auth",
				"entra",
			]),
		);

		expect(error).toBeInstanceOf(UsageError);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("stores a local connection as an environment variable NAME, never a token", async () => {
		const { app, current } = fakeApp();
		const fetchFn = healthyRouter();

		await new ConnectionCommand(app, {
			fetchFn: fetchFn as never,
			env: { CYRUS_OPERATOR_TOKEN: "cyop_abc" },
		}).run([
			"add",
			"dev",
			BASE_URL,
			"--auth",
			"local",
			"--token-env",
			"CYRUS_OPERATOR_TOKEN",
		]);

		const stored = current().operatorConnections?.dev;
		expect(stored?.auth).toEqual({
			kind: "local",
			tokenEnv: "CYRUS_OPERATOR_TOKEN",
		});
		expect(JSON.stringify(current())).not.toContain("cyop_abc");
	});

	it("reads the local token at request time and presents it to the router", async () => {
		const { app } = fakeApp();
		const fetchFn = healthyRouter();

		await new ConnectionCommand(app, {
			fetchFn: fetchFn as never,
			env: { CYRUS_OPERATOR_TOKEN: "cyop_abc" },
		}).run([
			"add",
			"dev",
			BASE_URL,
			"--auth",
			"local",
			"--token-env",
			"CYRUS_OPERATOR_TOKEN",
		]);

		const contextCall = fetchFn.mock.calls.find(
			(call) => new URL(String(call[0])).pathname === OPERATOR_CONTEXT_PATH,
		);
		expect(contextCall?.[1]?.headers?.authorization).toBe("Bearer cyop_abc");
	});

	it("fails as an authorization error when the named variable is unset", async () => {
		const { app, current } = fakeApp();

		const error = await catchAsync(
			new ConnectionCommand(app, {
				fetchFn: healthyRouter() as never,
				env: {},
			}).run([
				"add",
				"dev",
				BASE_URL,
				"--auth",
				"local",
				"--token-env",
				"MISSING",
			]),
		);

		expect(error).toBeInstanceOf(AuthorizationError);
		expect(error.message).toContain("MISSING");
		expect(current().operatorConnections).toBeUndefined();
	});

	it("refuses `--auth local` when the router does not offer local operator tokens", async () => {
		const { app } = fakeApp();
		const fetchFn = router({
			[DISCOVERY_PATH]: () =>
				json({
					...discoveryDocument,
					authentication: { methods: ["device-token"] },
				}),
		});

		const error = await catchAsync(
			new ConnectionCommand(app, { fetchFn: fetchFn as never }).run([
				"add",
				"dev",
				BASE_URL,
				"--auth",
				"local",
				"--token-env",
				"TOKEN",
			]),
		);

		expect(error).toBeInstanceOf(UsageError);
		expect(error.message).toContain("local-operator-token");
	});

	it("refuses `--auth entra` when the router does not offer Entra", async () => {
		const { app } = fakeApp();
		const fetchFn = router({
			[DISCOVERY_PATH]: () =>
				json({
					...discoveryDocument,
					authentication: { methods: ["local-operator-token"] },
				}),
		});

		const error = await catchAsync(
			new ConnectionCommand(app, { fetchFn: fetchFn as never }).run([
				"add",
				"prod",
				BASE_URL,
				"--auth",
				"entra",
			]),
		);

		expect(error).toBeInstanceOf(UsageError);
		expect(error.message).toContain("entra");
	});

	it("requires --token-env for local auth and rejects it for Entra auth", async () => {
		const { app } = fakeApp();
		const command = new ConnectionCommand(app, {
			fetchFn: healthyRouter() as never,
		});

		await expect(
			command.run(["add", "dev", BASE_URL, "--auth", "local"]),
		).rejects.toThrow(/--token-env/);
		// Refused rather than ignored: an operator who believes a token variable
		// is in play would otherwise only find out via an unexplained 401.
		await expect(
			command.run([
				"add",
				"prod",
				BASE_URL,
				"--auth",
				"entra",
				"--token-env",
				"TOKEN",
			]),
		).rejects.toThrow(/--token-env/);
	});

	it("rejects a missing or unknown --auth value", async () => {
		const { app } = fakeApp();
		const command = new ConnectionCommand(app, {
			fetchFn: healthyRouter() as never,
		});

		await expect(command.run(["add", "prod", BASE_URL])).rejects.toThrow(
			UsageError,
		);
		await expect(
			command.run(["add", "prod", BASE_URL, "--auth", "oauth"]),
		).rejects.toThrow(/entra/);
	});
});

describe("ConnectionCommand list", () => {
	it("lists stored connections without any network access", async () => {
		// This is what an operator runs to find out what --connection accepts; it
		// must work when every router is unreachable.
		const { app, raw } = fakeApp({
			operatorConnections: {
				prod: {
					url: BASE_URL,
					auth: {
						kind: "entra",
						tenantId: "tenant-1",
						audience: "api://cyrus-router",
					},
				},
				dev: {
					url: "http://localhost:8787",
					auth: { kind: "local", tokenEnv: "DEV_TOKEN" },
				},
			},
		});
		const fetchFn = vi.fn();

		await new ConnectionCommand(app, { fetchFn: fetchFn as never }).run([
			"list",
		]);

		expect(fetchFn).not.toHaveBeenCalled();
		const output = raw.join("\n");
		expect(output).toContain("prod");
		expect(output).toContain("dev");
		expect(output).toContain("DEV_TOKEN");
		expect(output).toContain("--connection <name>");
	});

	it("points at `connection add` when nothing is stored", async () => {
		const { app, raw } = fakeApp();

		await new ConnectionCommand(app).run(["list"]);

		expect(raw.join("\n")).toContain("cyrus connection add");
	});
});

describe("ConnectionCommand show", () => {
	function storedEntra() {
		return fakeApp({
			operatorConnections: {
				prod: {
					url: BASE_URL,
					auth: {
						kind: "entra",
						tenantId: "tenant-1",
						audience: "api://cyrus-router-dev",
					},
				},
			},
		});
	}

	it("reports identity, authority, log source, and skill from the live router", async () => {
		const { app, raw } = storedEntra();

		await new ConnectionCommand(app, {
			fetchFn: healthyRouter() as never,
			entraChain,
		}).run(["show", "prod"]);

		const output = raw.join("\n");
		expect(output).toContain("router-cyrus-dev");
		expect(output).toContain("Cyrus dev router");
		expect(output).toContain("v1");
		expect(output).toContain("entra");
		expect(output).toContain("source: azure-cli");
		expect(output).toContain(contextDocument.principalId);
		expect(output).toContain("fleet.read, fleet.recover");
		expect(output).toContain("runs.list");
		expect(output).toContain("recoveries.request");
		expect(output).toContain("Northrop Digital (ws-1)");
		expect(output).toContain("azure-log-analytics");
		expect(output).toContain("cyrus-fleet-operator 0.2.71");
		expect(output).toContain(`sha256:${"a".repeat(64)}`);
	});

	it("prints no credential material", async () => {
		const { app, raw } = fakeApp({
			operatorConnections: {
				dev: {
					url: BASE_URL,
					auth: { kind: "local", tokenEnv: "CYRUS_OPERATOR_TOKEN" },
				},
			},
		});

		await new ConnectionCommand(app, {
			fetchFn: healthyRouter() as never,
			env: { CYRUS_OPERATOR_TOKEN: "cyop_supersecret" },
		}).run(["show", "dev"]);

		const output = raw.join("\n");
		// The variable NAME is printed because that is the configuration; its
		// value never is.
		expect(output).toContain("CYRUS_OPERATOR_TOKEN");
		expect(output).not.toContain("cyop_supersecret");
	});

	it("uses the single stored connection when no name is given", async () => {
		const { app, raw } = storedEntra();

		await new ConnectionCommand(app, {
			fetchFn: healthyRouter() as never,
			entraChain,
		}).run(["show"]);

		expect(raw.join("\n")).toContain("router-cyrus-dev");
	});

	it("requires a selection when more than one connection is stored", async () => {
		const { app } = fakeApp({
			operatorConnections: {
				prod: {
					url: BASE_URL,
					auth: {
						kind: "entra",
						tenantId: "t",
						audience: "api://cyrus-router",
					},
				},
				dev: {
					url: "http://localhost:8787",
					auth: { kind: "local", tokenEnv: "TOKEN" },
				},
			},
		});

		const error = await catchAsync(
			new ConnectionCommand(app, { fetchFn: healthyRouter() as never }).run([
				"show",
			]),
		);

		expect(error).toBeInstanceOf(UsageError);
		expect(error.message).toContain("--connection");
	});

	it("accepts the connection through the global --connection option", async () => {
		const { app, raw } = storedEntra();

		await new ConnectionCommand(app, {
			fetchFn: healthyRouter() as never,
			entraChain,
		}).run(["show"], { connection: "prod" });

		expect(raw.join("\n")).toContain("router-cyrus-dev");
	});

	it("resolves --workspace through the same rule the fleet commands use", async () => {
		const { app, raw } = storedEntra();

		await new ConnectionCommand(app, {
			fetchFn: healthyRouter() as never,
			entraChain,
		}).run(["show"], { connection: "prod", workspace: "ws-1" });

		expect(raw.join("\n")).toContain("Selected:");
	});

	it("reports an unauthorized --workspace here rather than inside a later command", async () => {
		const { app } = storedEntra();

		const error = await catchAsync(
			new ConnectionCommand(app, {
				fetchFn: healthyRouter() as never,
				entraChain,
			}).run(["show"], { connection: "prod", workspace: "ws-999" }),
		);

		expect(error).toBeInstanceOf(UsageError);
		expect(error.message).toContain("ws-999");
	});

	it("reports a connection whose grant has since been revoked", async () => {
		// Everything shown comes from the live context document: what was
		// authorized at `connection add` is not what is authorized now.
		const { app } = storedEntra();
		const fetchFn = router({
			[DISCOVERY_PATH]: () => json(discoveryDocument),
			[OPERATOR_CONTEXT_PATH]: () => new Response("", { status: 403 }),
		});

		const error = await catchAsync(
			new ConnectionCommand(app, {
				fetchFn: fetchFn as never,
				entraChain,
			}).run(["show", "prod"]),
		);

		expect(error).toBeInstanceOf(AuthorizationError);
	});

	it("says so plainly when a connection cannot query logs", async () => {
		const { app, raw } = storedEntra();
		const { logSource: _dropped, ...noLogSource } = contextDocument;
		const fetchFn = router({
			[DISCOVERY_PATH]: () => json(discoveryDocument),
			[OPERATOR_CONTEXT_PATH]: () =>
				json({
					...noLogSource,
					capabilities: ["runs.list"],
					roles: ["fleet.read"],
				}),
		});

		await new ConnectionCommand(app, {
			fetchFn: fetchFn as never,
			entraChain,
		}).run(["show", "prod"]);

		expect(raw.join("\n")).toContain("cannot query logs");
	});
});

describe("ConnectionCommand remove", () => {
	it("forgets a stored connection", async () => {
		const { app, current } = fakeApp({
			operatorConnections: {
				prod: { url: BASE_URL, auth: { kind: "local", tokenEnv: "TOKEN" } },
			},
		});

		await new ConnectionCommand(app).run(["remove", "prod"]);

		expect(current().operatorConnections).toEqual({});
	});

	it("reports an unknown name", async () => {
		const { app } = fakeApp();

		await expect(
			new ConnectionCommand(app).run(["remove", "prod"]),
		).rejects.toBeInstanceOf(UsageError);
	});
});

describe("ConnectionCommand exit codes", () => {
	let exitSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		exitSpy = vi
			.spyOn(process, "exit")
			.mockImplementation((() => undefined) as never);
	});

	it("maps each failure onto the exit category an orchestrator branches on", async () => {
		// ADR 0011 fixes these codes; an agent reads the code, not the prose.
		const usage = fakeApp();
		await new ConnectionCommand(usage.app).execute(["nonsense"]);
		expect(exitSpy).toHaveBeenCalledWith(EXIT_USAGE);

		exitSpy.mockClear();
		const auth = fakeApp({
			operatorConnections: {
				dev: { url: BASE_URL, auth: { kind: "local", tokenEnv: "MISSING" } },
			},
		});
		await new ConnectionCommand(auth.app, {
			fetchFn: healthyRouter() as never,
			env: {},
		}).execute(["show", "dev"]);
		expect(exitSpy).toHaveBeenCalledWith(EXIT_AUTH);

		exitSpy.mockRestore();
	});

	it("redacts the message it logs on the way out", async () => {
		const { app, errors } = fakeApp({
			operatorConnections: {
				dev: { url: BASE_URL, auth: { kind: "local", tokenEnv: "TOKEN" } },
			},
		});
		const fetchFn = router({
			[DISCOVERY_PATH]: () => json(discoveryDocument),
			[OPERATOR_CONTEXT_PATH]: () =>
				new Response("rejected cyop_deadbeefdeadbeefdeadbeef", { status: 400 }),
		});

		await new ConnectionCommand(app, {
			fetchFn: fetchFn as never,
			env: { TOKEN: "cyop_deadbeefdeadbeefdeadbeef" },
		}).execute(["show", "dev"]);

		expect(errors.join("\n")).not.toContain("cyop_deadbeef");
		exitSpy.mockRestore();
	});

	it("lets an unexpected defect propagate instead of flattening it into a category", async () => {
		// A bug reported as `6` would tell an operator to retry a command that
		// will never succeed.
		const { app } = fakeApp();
		app.config.load = () => {
			throw new Error("disk on fire");
		};

		await expect(new ConnectionCommand(app).execute(["list"])).rejects.toThrow(
			"disk on fire",
		);
		exitSpy.mockRestore();
	});
});
