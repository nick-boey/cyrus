import type {
	OperatorContextV1,
	PublicRouterMetadataV1,
} from "cyrus-operator-protocol";
import { describe, expect, it, vi } from "vitest";
import type { OperatorCredentialProvider } from "./credentials.js";
import {
	AuthorizationError,
	EXIT_AUTH,
	EXIT_TRANSIENT,
	EXIT_USAGE,
	TransientError,
	UsageError,
} from "./errors.js";
import {
	DISCOVERY_PATH,
	negotiateApiVersion,
	OPERATOR_CONTEXT_PATH,
	OperatorHttpClient,
	requireAuthMethod,
	requireCapability,
	SUPPORTED_OPERATOR_API_VERSIONS,
	selectWorkspace,
} from "./OperatorHttpClient.js";

const BASE_URL = "https://router.example.com";

const discoveryDocument: PublicRouterMetadataV1 = {
	schemaVersion: 1,
	routerId: "router-cyrus-dev",
	routerName: "Cyrus dev router",
	operatorApiVersions: ["v1"],
	authentication: {
		methods: ["entra", "device-token", "local-operator-token"],
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
	roles: ["fleet.read"],
	capabilities: ["runs.list"],
	authorizedWorkspaces: [{ workspaceId: "ws-1", name: "Northrop Digital" }],
	observedAt: "2026-09-04T00:00:00.000Z",
};

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const credentials: OperatorCredentialProvider = {
	getAuthorization: async () => ({
		header: "Bearer cyop_deadbeefdeadbeefdeadbeefdeadbeef",
		source: "azure-cli",
	}),
};

function clientWith(
	fetchFn: typeof fetch,
	options: { credentials?: OperatorCredentialProvider; baseUrl?: string } = {},
) {
	return new OperatorHttpClient({
		baseUrl: options.baseUrl ?? BASE_URL,
		fetchFn,
		credentials: options.credentials,
	});
}

async function catchAsync(promise: Promise<unknown>): Promise<any> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("Expected the call to reject, but it resolved.");
}

describe("OperatorHttpClient.discover", () => {
	it("reads the discovery document from the router's origin", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(discoveryDocument));

		const metadata = await clientWith(fetchFn as never).discover();

		expect(fetchFn.mock.calls[0]?.[0]).toBe(`${BASE_URL}${DISCOVERY_PATH}`);
		expect(metadata.routerId).toBe("router-cyrus-dev");
	});

	it("tolerates a base URL with a trailing slash", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(discoveryDocument));

		await clientWith(fetchFn as never, {
			baseUrl: `${BASE_URL}/`,
		}).discover();

		expect(fetchFn.mock.calls[0]?.[0]).toBe(`${BASE_URL}${DISCOVERY_PATH}`);
	});

	it("sends no Authorization header and never consults the credential", async () => {
		// This is what an operator runs BEFORE they have a working credential.
		// Requiring one would make a wrong URL and an expired `az login` produce
		// the same error.
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(discoveryDocument));
		const getAuthorization = vi.fn();

		await clientWith(fetchFn as never, {
			credentials: { getAuthorization } as never,
		}).discover();

		expect(getAuthorization).not.toHaveBeenCalled();
		const headers = fetchFn.mock.calls[0]?.[1]?.headers ?? {};
		expect(headers.authorization).toBeUndefined();
	});

	it("reports a 404 as a wrong URL or too-old router, not a transient failure", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(new Response("", { status: 404 }));

		const error = await catchAsync(clientWith(fetchFn as never).discover());

		expect(error).toBeInstanceOf(UsageError);
		expect(error.exitCode).toBe(EXIT_USAGE);
		expect(error.message).toContain(DISCOVERY_PATH);
	});

	it("rejects a malformed discovery document as invalid configuration", async () => {
		const { routerId: _dropped, ...missingRouterId } = discoveryDocument;
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(missingRouterId));

		const error = await catchAsync(clientWith(fetchFn as never).discover());

		expect(error).toBeInstanceOf(UsageError);
		expect(error.message).toContain("routerId");
	});

	it("rejects a discovery document carrying an unexpected key", async () => {
		// The document is STRICT because it is the router's only unauthenticated
		// surface: an additive field that leaked workspace or log-source detail
		// would be disclosed to anyone who can reach the router.
		const fetchFn = vi
			.fn()
			.mockResolvedValue(
				jsonResponse({ ...discoveryDocument, authorizedWorkspaces: ["ws-1"] }),
			);

		await expect(
			clientWith(fetchFn as never).discover(),
		).rejects.toBeInstanceOf(UsageError);
	});

	it("reports a non-JSON body as invalid rather than crashing", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValue(new Response("<html>gateway</html>", { status: 200 }));

		const error = await catchAsync(clientWith(fetchFn as never).discover());

		expect(error).toBeInstanceOf(UsageError);
	});

	it("maps a network failure to a transient error", async () => {
		const fetchFn = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

		const error = await catchAsync(clientWith(fetchFn as never).discover());

		expect(error).toBeInstanceOf(TransientError);
		expect(error.exitCode).toBe(EXIT_TRANSIENT);
	});

	it("maps 5xx and 429 to transient errors", async () => {
		for (const status of [500, 502, 429]) {
			const fetchFn = vi
				.fn()
				.mockResolvedValue(new Response("busy", { status }));

			const error = await catchAsync(clientWith(fetchFn as never).discover());

			expect(error, `status ${status}`).toBeInstanceOf(TransientError);
		}
	});

	it("bounds the request with an abort signal", async () => {
		// Node's fetch has no default timeout; without this a hung router hangs
		// the orchestrator with no output rather than failing.
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(discoveryDocument));

		await clientWith(fetchFn as never).discover();

		expect(fetchFn.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
	});
});

describe("OperatorHttpClient.context", () => {
	it("presents the credential and returns the document with its source", async () => {
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(contextDocument));

		const result = await clientWith(fetchFn as never, {
			credentials,
		}).context();

		expect(fetchFn.mock.calls[0]?.[0]).toBe(
			`${BASE_URL}${OPERATOR_CONTEXT_PATH}`,
		);
		expect(fetchFn.mock.calls[0]?.[1]?.headers?.authorization).toBe(
			"Bearer cyop_deadbeefdeadbeefdeadbeefdeadbeef",
		);
		expect(result.authSource).toBe("azure-cli");
		expect(result.context.principalId).toBe(contextDocument.principalId);
	});

	it("maps 401 and 403 to authorization failures naming the credential source", async () => {
		for (const status of [401, 403]) {
			const fetchFn = vi.fn().mockResolvedValue(new Response("", { status }));

			const error = await catchAsync(
				clientWith(fetchFn as never, { credentials }).context(),
			);

			expect(error, `status ${status}`).toBeInstanceOf(AuthorizationError);
			expect(error.exitCode).toBe(EXIT_AUTH);
			// The router deliberately withholds the reason (it would enumerate
			// grants to an unauthorized caller), so naming which credential was
			// presented is the only remedy we can offer.
			expect(error.message).toContain("azure-cli");
		}
	});

	it("falls through to the next credential when the router refuses one", async () => {
		// A credential that MINTS successfully can still be refused: three of the
		// four Entra links produce app-only tokens the router rejects outright.
		// Without this the first credential the environment produces is final.
		const offered: string[] = [];
		let remaining = ["managed-identity", "azure-cli"];
		const chaining = {
			getAuthorization: async () => {
				const source = remaining[0] as string;
				offered.push(source);
				return { header: `Bearer token-${source}`, source };
			},
			rejectAndAdvance: (source: string) => {
				remaining = remaining.filter((s) => s !== source);
				return remaining.length > 0;
			},
		};
		const fetchFn = vi.fn(async (_url, init) =>
			(init as RequestInit).headers &&
			(init as { headers: Record<string, string> }).headers.authorization ===
				"Bearer token-azure-cli"
				? jsonResponse(contextDocument)
				: new Response("", { status: 403 }),
		);

		const result = await clientWith(fetchFn as never, {
			credentials: chaining,
		}).context();

		expect(offered).toEqual(["managed-identity", "azure-cli"]);
		expect(result.authSource).toBe("azure-cli");
	});

	it("stops once the chain is exhausted and names every credential tried", async () => {
		const exhausting = {
			getAuthorization: async () => ({
				header: "Bearer t",
				source: "managed-identity",
			}),
			rejectAndAdvance: () => false,
		};
		const fetchFn = vi
			.fn()
			.mockResolvedValue(new Response("", { status: 403 }));

		const error = await catchAsync(
			clientWith(fetchFn as never, { credentials: exhausting }).context(),
		);

		expect(error).toBeInstanceOf(AuthorizationError);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		// The remedy names the app-only case, because for a workload/managed/
		// service-principal token no grant can help.
		expect(error.message).toContain("app-only");
		expect(error.message).toContain("az login");
	});

	it("does not offer the app-only remedy to a credential it cannot apply to", async () => {
		// A local operator token is not an Entra principal, so `az login` has no
		// bearing on its refusal. Saying less beats sending the operator
		// somewhere irrelevant.
		const fetchFn = vi
			.fn()
			.mockResolvedValue(new Response("", { status: 403 }));

		const error = await catchAsync(
			clientWith(fetchFn as never, {
				credentials: {
					getAuthorization: async () => ({
						header: "Bearer cyop_x",
						source: "env:CYRUS_OPERATOR_TOKEN",
					}),
				},
			}).context(),
		);

		expect(error).toBeInstanceOf(AuthorizationError);
		expect(error.message).toContain("fleet.read grant");
		expect(error.message).not.toContain("az login");
		expect(error.message).not.toContain("app-only");
	});

	it("offers the app-only remedy for the three Entra sources that produce one", async () => {
		for (const source of [
			"workload-identity",
			"managed-identity",
			"service-principal-env",
		]) {
			const fetchFn = vi
				.fn()
				.mockResolvedValue(new Response("", { status: 403 }));

			const error = await catchAsync(
				clientWith(fetchFn as never, {
					credentials: {
						getAuthorization: async () => ({ header: "Bearer t", source }),
					},
				}).context(),
			);

			expect(error.message, source).toContain("app-only");
		}

		// `azure-cli` yields a USER token, so the hint would be wrong there.
		const fetchFn = vi
			.fn()
			.mockResolvedValue(new Response("", { status: 403 }));
		const error = await catchAsync(
			clientWith(fetchFn as never, {
				credentials: {
					getAuthorization: async () => ({
						header: "Bearer t",
						source: "azure-cli",
					}),
				},
			}).context(),
		);
		expect(error.message).not.toContain("app-only");
	});

	it("treats a provider without a chain as final on the first refusal", async () => {
		// A local operator token has exactly one credential; retrying it would be
		// a loop, so `rejectAndAdvance` is absent and the refusal stands.
		const fetchFn = vi
			.fn()
			.mockResolvedValue(new Response("", { status: 401 }));

		const error = await catchAsync(
			clientWith(fetchFn as never, { credentials }).context(),
		);

		expect(error).toBeInstanceOf(AuthorizationError);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("never echoes the bearer token into a diagnostic, even when the router does", async () => {
		const fetchFn = vi.fn().mockResolvedValue(
			new Response(
				JSON.stringify({
					error: "rejected token Bearer cyop_deadbeefdeadbeefdeadbeefdeadbeef",
				}),
				{ status: 400 },
			),
		);

		const error = await catchAsync(
			clientWith(fetchFn as never, { credentials }).context(),
		);

		expect(error.message).not.toContain("cyop_deadbeef");
		expect(error.message).toContain("[redacted]");
	});

	it("rejects a context document that omits capabilities", async () => {
		const { capabilities: _dropped, ...malformed } = contextDocument;
		const fetchFn = vi.fn().mockResolvedValue(jsonResponse(malformed));

		const error = await catchAsync(
			clientWith(fetchFn as never, { credentials }).context(),
		);

		expect(error).toBeInstanceOf(UsageError);
		expect(error.message).toContain("capabilities");
	});

	it("refuses to run without credentials rather than sending an anonymous request", async () => {
		const fetchFn = vi.fn();

		const error = await catchAsync(clientWith(fetchFn as never).context());

		expect(error).toBeInstanceOf(UsageError);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe("negotiateApiVersion", () => {
	it("selects a version both sides speak", () => {
		expect(negotiateApiVersion(discoveryDocument)).toBe("v1");
		expect(SUPPORTED_OPERATOR_API_VERSIONS).toContain("v1");
	});

	it("fails as invalid configuration when the router speaks none of ours", () => {
		// No amount of retrying makes a router this CLI cannot speak to
		// reachable; the remedy is a version change on one side or the other.
		const error = catchSync(() =>
			negotiateApiVersion({
				...discoveryDocument,
				operatorApiVersions: ["v2" as never],
			}),
		);

		expect(error).toBeInstanceOf(UsageError);
		expect(error.exitCode).toBe(EXIT_USAGE);
		expect(error.message).toContain("v2");
		expect(error.message).toContain("v1");
	});
});

describe("requireAuthMethod", () => {
	it("accepts a method the router offers and refuses one it does not", () => {
		expect(() => requireAuthMethod(discoveryDocument, "entra")).not.toThrow();

		const error = catchSync(() =>
			requireAuthMethod(
				{
					...discoveryDocument,
					authentication: { methods: ["device-token"] },
				},
				"local-operator-token",
			),
		);

		expect(error).toBeInstanceOf(UsageError);
		expect(error.message).toContain("device-token");
	});
});

describe("requireCapability", () => {
	it("passes when the router serves the route and refuses when it does not", () => {
		expect(() => requireCapability(contextDocument, "runs.list")).not.toThrow();

		// Gating here rather than attempting the call: a router that does not
		// serve a route answers 404, which is indistinguishable from a route that
		// exists and found nothing.
		const error = catchSync(() =>
			requireCapability(contextDocument, "logs.query"),
		);

		expect(error).toBeInstanceOf(UsageError);
		expect(error.message).toContain("logs.query");
		expect(error.message).toContain("runs.list");
	});
});

describe("selectWorkspace", () => {
	const multi: OperatorContextV1 = {
		...contextDocument,
		authorizedWorkspaces: [
			{ workspaceId: "ws-1", name: "Northrop Digital" },
			{ workspaceId: "ws-2", name: "Ceedar" },
		],
	};

	it("uses the single authorized workspace implicitly", () => {
		expect(selectWorkspace(contextDocument)).toEqual({
			workspaceId: "ws-1",
			name: "Northrop Digital",
		});
	});

	it("requires --workspace when the context authorizes more than one", () => {
		const error = catchSync(() => selectWorkspace(multi));

		expect(error).toBeInstanceOf(UsageError);
		expect(error.exitCode).toBe(EXIT_USAGE);
		expect(error.message).toContain("--workspace");
		expect(error.message).toContain("ws-1");
		expect(error.message).toContain("ws-2");
	});

	it("resolves by id, which is canonical", () => {
		expect(selectWorkspace(multi, "ws-2")).toEqual({
			workspaceId: "ws-2",
			name: "Ceedar",
		});
	});

	it("resolves by an exact, unique name", () => {
		expect(selectWorkspace(multi, "Ceedar")).toEqual({
			workspaceId: "ws-2",
			name: "Ceedar",
		});
	});

	it("fails on an ambiguous name rather than picking one", () => {
		// A name is captured display text two workspaces may share; resolving a
		// tie by position would silently point a recovery at the wrong fleet.
		const ambiguous: OperatorContextV1 = {
			...contextDocument,
			authorizedWorkspaces: [
				{ workspaceId: "ws-1", name: "Platform" },
				{ workspaceId: "ws-2", name: "Platform" },
			],
		};

		const error = catchSync(() => selectWorkspace(ambiguous, "Platform"));

		expect(error).toBeInstanceOf(UsageError);
		expect(error.message).toContain("ws-1");
		expect(error.message).toContain("ws-2");
		expect(error.message).toContain("workspace id");
	});

	it("prefers an id match over a name that collides with a different id", () => {
		const colliding: OperatorContextV1 = {
			...contextDocument,
			authorizedWorkspaces: [
				{ workspaceId: "ws-1", name: "ws-2" },
				{ workspaceId: "ws-2", name: "Ceedar" },
			],
		};

		expect(selectWorkspace(colliding, "ws-2").workspaceId).toBe("ws-2");
	});

	it("refuses a workspace the connection is not authorized over", () => {
		const error = catchSync(() => selectWorkspace(multi, "ws-999"));

		expect(error).toBeInstanceOf(UsageError);
		expect(error.message).toContain("ws-999");
		expect(error.message).toContain("ws-1");
	});
});

function catchSync(fn: () => unknown): any {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error("Expected the call to throw, but it returned.");
}
