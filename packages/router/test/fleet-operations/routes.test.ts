import {
	operatorContextV1Schema,
	publicRouterMetadataV1Schema,
} from "cyrus-operator-protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FleetOperations } from "../../src/fleet-operations/FleetOperations.js";
import { OperatorAuthorizer } from "../../src/fleet-operations/OperatorAuthorizer.js";
import { registerFleetOperationsRoutes } from "../../src/fleet-operations/routes.js";
import type {
	FleetOperationsConfig,
	OperatorAccessConfig,
} from "../../src/fleet-operations/types.js";
import { RouterStore } from "../../src/RouterStore.js";

const NOW = 1_700_000_000_000;
const TENANT = "11111111-1111-1111-1111-111111111111";
const AUDIENCE = "api://cyrus-router";
const WS_A = "workspace-a";
const WS_B = "workspace-b";
const READER_OID = "aaaaaaaa-0000-0000-0000-000000000001";
const RECOVERER_OID = "bbbbbbbb-0000-0000-0000-000000000002";

const LOG_SOURCE = {
	schemaVersion: 1,
	kind: "azure-log-analytics",
	displayName: "cyrus-prod",
	azure: {
		workspaceId: "99999999-9999-9999-9999-999999999999",
		table: "ContainerAppConsoleLogs_CL",
	},
	budgets: {
		defaultLookbackSeconds: 3600,
		maxRangeSeconds: 86_400,
		maxRecords: 1000,
		minFollowIntervalSeconds: 10,
	},
} as const;

const SKILL = {
	name: "cyrus-fleet-operations",
	version: "1.0.0",
	releaseUrl: "https://example.test/skills/fleet-operations-1.0.0.tar.gz",
	checksum: `sha256:${"a".repeat(64)}`,
} as const;

const ACCESS: OperatorAccessConfig = {
	entra: {
		tenantId: TENANT,
		audience: AUDIENCE,
		grants: [
			{
				principalIds: [READER_OID],
				roles: ["fleet.read"],
				workspaceIds: [WS_A],
			},
			{
				principalIds: [RECOVERER_OID],
				roles: ["fleet.read", "fleet.recover"],
				workspaceIds: [WS_A, WS_B],
			},
		],
	},
};

const PAYLOADS: Record<string, Record<string, unknown>> = {
	"hdr.reader.sig": {
		tid: TENANT,
		aud: AUDIENCE,
		oid: READER_OID,
		name: "Reader",
	},
	"hdr.recoverer.sig": {
		tid: TENANT,
		aud: AUDIENCE,
		oid: RECOVERER_OID,
		name: "Recoverer",
	},
};

/** Every string anywhere in a JSON document, for leak assertions. */
function flatten(value: unknown, out: string[] = []): string[] {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) flatten(item, out);
	else if (value && typeof value === "object")
		for (const [key, item] of Object.entries(value)) {
			out.push(key);
			flatten(item, out);
		}
	return out;
}

describe("fleet-operations routes", () => {
	let store: RouterStore;
	let fastify: FastifyInstance;
	let physicalToken: string;
	let containerToken: string;

	beforeEach(() => {
		store = new RouterStore(":memory:");
		const userId = store.addUser({
			email: "alice@example.com",
			name: "Alice",
		}).userId;
		const code = store.mintEnrollmentCode("alice@example.com", NOW);
		const physical = store.redeemEnrollmentCode(code, NOW);
		if (!physical) throw new Error("enrollment failed");
		physicalToken = physical.deviceToken;
		containerToken = store.createContainerDevice(
			userId,
			"CYR-65",
			"aca",
		).deviceToken;
	});

	afterEach(async () => {
		await fastify?.close();
		store.close();
	});

	function mount(overrides?: Partial<FleetOperationsConfig>): FastifyInstance {
		const config: FleetOperationsConfig = {
			routerId: "router-under-test",
			routerName: "Router Under Test",
			access: ACCESS,
			logSource: LOG_SOURCE,
			skill: SKILL,
			capabilities: ["runs.list", "logs.query", "recoveries.request"],
			...overrides,
		};
		const workspaceIds = [WS_A, WS_B];
		const authorizer = new OperatorAuthorizer({
			store,
			workspaceIds,
			...(config.access ? { access: config.access } : {}),
			verifyEntraToken: async (token) => {
				const payload = PAYLOADS[token];
				if (!payload) throw new Error("signature verification failed");
				return payload;
			},
			now: () => NOW,
		});
		fastify = Fastify();
		registerFleetOperationsRoutes(fastify, {
			fleet: new FleetOperations({ config, workspaceIds, now: () => NOW }),
			authorizer,
		});
		return fastify;
	}

	describe("GET /.well-known/cyrus", () => {
		it("serves router identity, API versions, and auth metadata anonymously", async () => {
			const response = await mount().inject({
				method: "GET",
				url: "/.well-known/cyrus",
			});

			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(publicRouterMetadataV1Schema.parse(body)).toEqual(body);
			expect(body).toEqual({
				schemaVersion: 1,
				routerId: "router-under-test",
				routerName: "Router Under Test",
				operatorApiVersions: ["v1"],
				authentication: {
					methods: ["entra", "device-token", "local-operator-token"],
					entra: { tenantId: TENANT, audience: AUDIENCE },
				},
			});
		});

		it("discloses no workspace, log-source, run, user, or skill detail", async () => {
			const response = await mount().inject({
				method: "GET",
				url: "/.well-known/cyrus",
			});

			const strings = flatten(response.json());
			for (const secret of [
				WS_A,
				WS_B,
				LOG_SOURCE.azure.workspaceId,
				LOG_SOURCE.displayName,
				SKILL.releaseUrl,
				SKILL.name,
				READER_OID,
				"alice@example.com",
				"CYR-65",
			]) {
				expect(strings).not.toContain(secret);
			}
			// The grant table is the whole authorization policy — it must not be
			// reachable through any nesting of the anonymous document.
			expect(JSON.stringify(response.json())).not.toContain("grants");
		});

		it("omits Entra metadata when no Entra access is configured", async () => {
			const response = await mount({ access: undefined }).inject({
				method: "GET",
				url: "/.well-known/cyrus",
			});

			expect(response.statusCode).toBe(200);
			expect(response.json().authentication).toEqual({
				methods: ["device-token", "local-operator-token"],
			});
		});
	});

	describe("GET /api/v1/operator/context", () => {
		it("refuses an anonymous caller without disclosing anything", async () => {
			const response = await mount().inject({
				method: "GET",
				url: "/api/v1/operator/context",
			});

			expect(response.statusCode).toBe(401);
			const strings = flatten(response.json());
			for (const secret of [
				WS_A,
				WS_B,
				LOG_SOURCE.azure.workspaceId,
				SKILL.releaseUrl,
			]) {
				expect(strings).not.toContain(secret);
			}
		});

		it("returns only the caller's own roles, workspaces, and capabilities", async () => {
			const response = await mount().inject({
				method: "GET",
				url: "/api/v1/operator/context",
				headers: { authorization: "Bearer hdr.reader.sig" },
			});

			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(operatorContextV1Schema.parse(body)).toEqual(body);
			expect(body.principalId).toBe(READER_OID);
			expect(body.authMethod).toBe("entra");
			expect(body.roles).toEqual(["fleet.read"]);
			expect(body.authorizedWorkspaces).toEqual([{ workspaceId: WS_A }]);
			// `fleet.read` does not imply `fleet.recover`, so the recovery
			// capability is withheld even though this router serves it.
			expect(body.capabilities).toEqual(["runs.list", "logs.query"]);
			expect(body.logSource).toEqual(LOG_SOURCE);
			expect(body.skill).toEqual(SKILL);
			expect(body.observedAt).toBe(new Date(NOW).toISOString());
		});

		it("grants the recovery capability only to a fleet.recover principal", async () => {
			const response = await mount().inject({
				method: "GET",
				url: "/api/v1/operator/context",
				headers: { authorization: "Bearer hdr.recoverer.sig" },
			});

			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(body.roles.sort()).toEqual(["fleet.read", "fleet.recover"]);
			expect(body.capabilities).toContain("recoveries.request");
			expect(
				body.authorizedWorkspaces.map(
					(w: { workspaceId: string }) => w.workspaceId,
				),
			).toEqual([WS_A, WS_B]);
		});

		it("withholds the log-source descriptor when this router does not serve log queries", async () => {
			const response = await mount({ capabilities: ["runs.list"] }).inject({
				method: "GET",
				url: "/api/v1/operator/context",
				headers: { authorization: "Bearer hdr.recoverer.sig" },
			});

			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(body.capabilities).toEqual(["runs.list"]);
			expect(body.logSource).toBeUndefined();
			expect(flatten(body)).not.toContain(LOG_SOURCE.azure.workspaceId);
		});

		it("authenticates a locally minted operator token by hash", async () => {
			const created = store.createOperatorToken({
				label: "oncall",
				roles: ["fleet.read"],
				workspaceIds: [WS_B],
				nowMs: NOW,
			});

			const response = await mount().inject({
				method: "GET",
				url: "/api/v1/operator/context",
				headers: { authorization: `Bearer ${created.token}` },
			});

			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(body.authMethod).toBe("local-operator-token");
			expect(body.principalId).toBe(`local-token:${created.tokenId}`);
			expect(body.authorizedWorkspaces).toEqual([{ workspaceId: WS_B }]);
		});

		it("refuses a revoked local operator token", async () => {
			const created = store.createOperatorToken({
				label: "oncall",
				roles: ["fleet.read"],
				workspaceIds: [WS_B],
				nowMs: NOW,
			});
			store.revokeOperatorToken(created.tokenId, NOW + 1);

			const response = await mount().inject({
				method: "GET",
				url: "/api/v1/operator/context",
				headers: { authorization: `Bearer ${created.token}` },
			});

			expect(response.statusCode).toBe(401);
		});

		it("keeps a user device token at read-only, owner-scoped authority", async () => {
			const response = await mount().inject({
				method: "GET",
				url: "/api/v1/operator/context",
				headers: { authorization: `Bearer ${physicalToken}` },
			});

			expect(response.statusCode).toBe(200);
			const body = response.json();
			expect(body.authMethod).toBe("device-token");
			expect(body.roles).toEqual(["fleet.read"]);
			expect(body.capabilities).not.toContain("recoveries.request");
		});

		it("denies a container device token, which gains no recovery authority", async () => {
			const response = await mount().inject({
				method: "GET",
				url: "/api/v1/operator/context",
				headers: { authorization: `Bearer ${containerToken}` },
			});

			expect(response.statusCode).toBe(403);
			expect(flatten(response.json())).not.toContain(WS_A);
		});
	});
});
