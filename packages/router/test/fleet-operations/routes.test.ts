import {
	operatorContextV1Schema,
	publicRouterMetadataV1Schema,
	runChangePageV1Schema,
	runObservationPageV1Schema,
} from "cyrus-operator-protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FleetOperations } from "../../src/fleet-operations/FleetOperations.js";
import { OperatorAuthorizer } from "../../src/fleet-operations/OperatorAuthorizer.js";
import { RunCursorCodec } from "../../src/fleet-operations/RunChangeCursor.js";
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

const ISSUER = `https://login.microsoftonline.com/${TENANT}/v2.0`;

const PAYLOADS: Record<string, Record<string, unknown>> = {
	"hdr.reader.sig": {
		tid: TENANT,
		iss: ISSUER,
		aud: AUDIENCE,
		oid: READER_OID,
		exp: NOW / 1000 + 3600,
		name: "Reader",
	},
	"hdr.recoverer.sig": {
		tid: TENANT,
		iss: ISSUER,
		aud: AUDIENCE,
		oid: RECOVERER_OID,
		exp: NOW / 1000 + 3600,
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
	let fastify: FastifyInstance | undefined;
	let physicalToken: string;
	let containerToken: string;
	let aliceUserId: number;
	let aliceDeviceId: number;

	beforeEach(() => {
		// Reset per test: `afterEach` closes the instance, and a closed Fastify
		// cannot be reopened.
		fastify = undefined;
		store = new RouterStore(":memory:");
		const userId = store.addUser({
			email: "alice@example.com",
			name: "Alice",
		}).userId;
		aliceUserId = userId;
		const code = store.mintEnrollmentCode("alice@example.com", NOW);
		const physical = store.redeemEnrollmentCode(code, NOW);
		if (!physical) throw new Error("enrollment failed");
		physicalToken = physical.deviceToken;
		aliceDeviceId = physical.deviceId;
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

	/**
	 * The server for this test, built once and reused.
	 *
	 * The stream epoch is minted per `FleetOperations` instance, so a helper that
	 * mounted a fresh server per request would answer every cursor `410` and the
	 * pagination tests would pass for entirely the wrong reason.
	 */
	function server(overrides?: Partial<FleetOperationsConfig>): FastifyInstance {
		if (!fastify) fastify = mount(overrides);
		return fastify;
	}

	function mount(overrides?: Partial<FleetOperationsConfig>): FastifyInstance {
		const config: FleetOperationsConfig = {
			routerId: "router-under-test",
			routerName: "Router Under Test",
			access: ACCESS,
			logSource: LOG_SOURCE,
			skill: SKILL,
			capabilities: [
				"runs.list",
				"runs.changes",
				"logs.query",
				"recoveries.request",
			],
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
			fleet: new FleetOperations({
				config,
				workspaceIds,
				store,
				now: () => NOW,
			}),
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
			expect(body.capabilities).toEqual([
				"runs.list",
				"runs.changes",
				"logs.query",
			]);
			expect(body.logSource).toEqual(LOG_SOURCE);
			expect(body.skill).toEqual(SKILL);
			expect(body.observedAt).toBe(new Date(NOW).toISOString());
		});

		it("hands over locating metadata and no way to authenticate to the backend", async () => {
			// The router never holds an Azure credential, so none can be serialized
			// into a response. This pins the other half: the descriptor itself must
			// carry no field a credential could be written into, which is what the
			// wire schema's strictness enforces and what this asserts is still true.
			const response = await mount().inject({
				method: "GET",
				url: "/api/v1/operator/context",
				headers: { authorization: "Bearer hdr.reader.sig" },
			});

			const keys = flatten(response.json().logSource);
			for (const credentialish of [
				"sharedKey",
				"connectionString",
				"token",
				"accessToken",
				"apiKey",
				"clientSecret",
				"authorization",
				"endpoint",
				"authorityHost",
			]) {
				expect(keys).not.toContain(credentialish);
			}
			// Every leaf is a locator or a budget, and nothing else.
			expect(Object.keys(response.json().logSource).sort()).toEqual([
				"azure",
				"budgets",
				"displayName",
				"kind",
				"schemaVersion",
			]);
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
			// `runs.list` is router-mediated, so the router can narrow it to this
			// device's owner. `logs.query` is NOT: the client would query the log
			// backend directly, with no router-side filter, so granting it would
			// convert "read your own runs" into "read every log line in every
			// workspace" — and would hand over the Log Analytics workspace GUID
			// and ARM resource id on the way. The descriptor goes with it.
			expect(body.capabilities).toEqual(["runs.list", "runs.changes"]);
			expect(body.capabilities).not.toContain("recoveries.request");
			expect(body.logSource).toBeUndefined();
			expect(flatten(body)).not.toContain(LOG_SOURCE.azure.workspaceId);
		});

		it("re-authorizes every request, so a revocation takes effect mid-flight", async () => {
			// Pins "checked on EVERY operator request": without it, memoising the
			// authorizer would leave every other test in this file passing.
			const created = store.createOperatorToken({
				label: "oncall",
				roles: ["fleet.read"],
				workspaceIds: [WS_B],
				nowMs: NOW,
			});
			const server = mount();
			const headers = { authorization: `Bearer ${created.token}` };
			const url = "/api/v1/operator/context";

			expect(
				(await server.inject({ method: "GET", url, headers })).statusCode,
			).toBe(200);
			store.revokeOperatorToken(created.tokenId, NOW + 1);
			expect(
				(await server.inject({ method: "GET", url, headers })).statusCode,
			).toBe(401);
		});

		it("never caches a per-principal document in a shared cache", async () => {
			const response = await mount().inject({
				method: "GET",
				url: "/api/v1/operator/context",
				headers: { authorization: "Bearer hdr.reader.sig" },
			});

			expect(response.headers["cache-control"]).toBe("no-store");
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

	describe("configuration validation", () => {
		// The config file's schema cannot express the wire schema's cross-field
		// rules, so without a construction-time check a router with any of these
		// starts cleanly, serves every other route, and 500s the one
		// authenticated operator route for as long as it runs.
		it.each([
			[
				"an Azure source that names no workspace",
				{ ...LOG_SOURCE, azure: undefined },
			],
			[
				"Azure details on a non-Azure source",
				{ ...LOG_SOURCE, kind: "fake" as const },
			],
			[
				"a default lookback beyond the maximum range",
				{
					...LOG_SOURCE,
					budgets: { ...LOG_SOURCE.budgets, defaultLookbackSeconds: 999_999 },
				},
			],
		])("refuses to construct with %s", (_label, logSource) => {
			expect(
				() =>
					new FleetOperations({
						config: {
							routerId: "router-under-test",
							logSource: logSource as never,
							capabilities: ["logs.query"],
						},
						workspaceIds: [WS_A],
						now: () => NOW,
					}),
			).toThrow(/Invalid fleetOperations configuration/);
		});
	});

	describe("GET /api/v1/runs", () => {
		/**
		 * Two runs in two workspaces, owned by two different users, sharing a
		 * captured team name — the smallest fleet that exercises workspace
		 * authorization, owner scoping, and name ambiguity at once.
		 */
		function seedRuns(): { bobUserId: number } {
			const bobUserId = store.addUser({
				email: "bob@example.com",
				name: "Bob",
			}).userId;
			const bobDevice = store.createContainerDevice(
				bobUserId,
				"CYR-69-B",
				"aca",
			).deviceId;
			store.recordAgentRunRouted({
				deviceId: aliceDeviceId,
				issueKey: "CYR-69-A",
				issueId: "issue-a",
				sessionId: "session-a",
				routedMs: NOW - 20_000,
				routing: {
					workspaceId: WS_A,
					workspaceName: "Acme",
					linearTeamId: "team-1",
					linearTeamName: "Platform",
				},
			});
			store.recordAgentRunRouted({
				deviceId: bobDevice,
				issueKey: "CYR-69-B",
				issueId: "issue-b",
				sessionId: "session-b",
				routedMs: NOW - 10_000,
				routing: {
					workspaceId: WS_B,
					workspaceName: "Beta",
					linearTeamId: "team-2",
					linearTeamName: "Platform",
				},
			});
			return { bobUserId };
		}

		const get = (url: string, token: string) =>
			server().inject({
				method: "GET",
				url,
				headers: { authorization: `Bearer ${token}` },
			});

		it("rejects an anonymous caller", async () => {
			const response = await mount().inject({
				method: "GET",
				url: "/api/v1/runs",
			});
			expect(response.statusCode).toBe(401);
			expect(response.json()).toEqual({ error: "unauthorized" });
		});

		it("rejects a container device token, which holds no fleet authority", async () => {
			seedRuns();
			const response = await get("/api/v1/runs", containerToken);
			expect(response.statusCode).toBe(403);
			expect(response.json()).toEqual({ error: "forbidden" });
		});

		it("rejects a principal whose router does not serve the capability", async () => {
			seedRuns();
			const response = await mount({ capabilities: ["logs.query"] }).inject({
				method: "GET",
				url: "/api/v1/runs",
				headers: { authorization: "Bearer hdr.reader.sig" },
			});
			expect(response.statusCode).toBe(403);
		});

		it("serves only the workspaces the reader's grant covers", async () => {
			seedRuns();
			const response = await get("/api/v1/runs", "hdr.reader.sig");

			expect(response.statusCode).toBe(200);
			expect(response.headers["cache-control"]).toBe("no-store");
			const body = response.json();
			expect(runObservationPageV1Schema.parse(body)).toEqual(body);
			expect(
				body.runs.map((run: { agentSessionId: string }) => run.agentSessionId),
			).toEqual(["session-a"]);
			// Nothing about the workspace this reader cannot see.
			expect(flatten(body)).not.toContain("Beta");
		});

		it("narrows a physical device token to its own owner's runs", async () => {
			seedRuns();
			const response = await get("/api/v1/runs", physicalToken);

			expect(response.statusCode).toBe(200);
			expect(
				response
					.json()
					.runs.map((run: { agentSessionId: string }) => run.agentSessionId),
			).toEqual(["session-a"]);
		});

		it("applies each filter the route accepts", async () => {
			seedRuns();
			const sessions = async (query: string) =>
				(await get(`/api/v1/runs?${query}`, "hdr.recoverer.sig"))
					.json()
					.runs.map((run: { agentSessionId: string }) => run.agentSessionId);

			expect(await sessions("")).toEqual(["session-b", "session-a"]);
			expect(await sessions("agentSessionId=session-b")).toEqual(["session-b"]);
			expect(await sessions("issueId=issue-a")).toEqual(["session-a"]);
			expect(await sessions("issueKey=CYR-69-B")).toEqual(["session-b"]);
			expect(await sessions(`workspace=${WS_A}`)).toEqual(["session-a"]);
			expect(await sessions(`owner=${aliceUserId}`)).toEqual(["session-a"]);
			expect(await sessions("team=team-2")).toEqual(["session-b"]);
			expect(await sessions("lifecycle=complete")).toEqual([]);
			expect(await sessions("runner=claude")).toEqual([]);
		});

		it("refuses an ambiguous captured name with its candidates", async () => {
			seedRuns();
			const response = await get(
				"/api/v1/runs?team=Platform",
				"hdr.recoverer.sig",
			);

			expect(response.statusCode).toBe(400);
			expect(response.json()).toMatchObject({
				error: "ambiguous_name",
				candidates: [
					{ id: "team-1", name: "Platform" },
					{ id: "team-2", name: "Platform" },
				],
			});
		});

		it("does not leak candidates from an unauthorized workspace", async () => {
			seedRuns();
			// The reader holds only WS_A, so the same name is unambiguous for them
			// and `team-2` never appears in the answer at all.
			const response = await get(
				"/api/v1/runs?team=Platform",
				"hdr.reader.sig",
			);

			expect(response.statusCode).toBe(200);
			expect(flatten(response.json())).not.toContain("team-2");
		});

		it("paginates without duplicates and refuses a cursor from another query", async () => {
			seedRuns();
			const first = await get("/api/v1/runs?limit=1", "hdr.recoverer.sig");
			const { nextCursor } = first.json();
			expect(nextCursor).toBeDefined();

			const second = await get(
				`/api/v1/runs?limit=1&cursor=${encodeURIComponent(nextCursor)}`,
				"hdr.recoverer.sig",
			);
			expect(
				second
					.json()
					.runs.map((run: { agentSessionId: string }) => run.agentSessionId),
			).toEqual(["session-a"]);
			expect(second.json().nextCursor).toBeUndefined();

			const mismatched = await get(
				`/api/v1/runs?limit=1&lifecycle=active&cursor=${encodeURIComponent(nextCursor)}`,
				"hdr.recoverer.sig",
			);
			expect(mismatched.statusCode).toBe(400);
			expect(mismatched.json().error).toBe("cursor_query_mismatch");
		});

		it("rejects a non-numeric limit", async () => {
			const response = await get("/api/v1/runs?limit=lots", "hdr.reader.sig");
			expect(response.statusCode).toBe(400);
		});
	});

	describe("GET /api/v1/run-changes", () => {
		function seedRun(): void {
			store.recordAgentRunRouted({
				deviceId: aliceDeviceId,
				issueKey: "CYR-69-A",
				issueId: "issue-a",
				sessionId: "session-a",
				routedMs: NOW - 20_000,
				routing: { workspaceId: WS_A, workspaceName: "Acme" },
			});
		}

		const get = (url: string, token: string) =>
			server().inject({
				method: "GET",
				url,
				headers: { authorization: `Bearer ${token}` },
			});

		it("rejects an anonymous caller", async () => {
			const response = await mount().inject({
				method: "GET",
				url: "/api/v1/run-changes",
			});
			expect(response.statusCode).toBe(401);
		});

		it("rejects a principal whose router does not serve the capability", async () => {
			const response = await mount({ capabilities: ["runs.list"] }).inject({
				method: "GET",
				url: "/api/v1/run-changes",
				headers: { authorization: "Bearer hdr.reader.sig" },
			});
			expect(response.statusCode).toBe(403);
		});

		it("serves an ordered feed a client can resume from", async () => {
			seedRun();
			const first = await get("/api/v1/run-changes", "hdr.reader.sig");

			expect(first.statusCode).toBe(200);
			const body = first.json();
			expect(runChangePageV1Schema.parse(body)).toEqual(body);
			expect(
				body.changes.map((change: { kind: string }) => change.kind),
			).toEqual(["routing"]);

			// A transition that begins and ends between two snapshots is still
			// observed by a client that only polls the feed.
			store.setAgentRunState("session-a", "waiting", {
				wait: { reason: "elicitation", sinceMs: NOW },
			});
			store.recordAgentRunActivity("session-a", NOW + 1);

			const next = await get(
				`/api/v1/run-changes?cursor=${encodeURIComponent(body.nextCursor)}`,
				"hdr.reader.sig",
			);
			expect(
				next.json().changes.map((change: { kind: string }) => change.kind),
			).toEqual(["lifecycle", "lifecycle"]);
		});

		it("carries no prompt text or agent-activity content", async () => {
			seedRun();
			store.recordAgentRunActivity("session-a", NOW + 1);
			const response = await get("/api/v1/run-changes", "hdr.reader.sig");

			const strings = flatten(response.json()).join(" ");
			expect(strings).not.toContain("prompt");
			expect(strings).not.toContain("comment body");
		});

		it("answers 410 to a cursor from a previous router process", async () => {
			seedRun();
			// Signed with the router's durable key under a previous epoch: the
			// shape a genuine restart leaves behind.
			const stale = new RunCursorCodec(
				"epoch-from-a-previous-process",
				store.getOrCreateSecret("fleet-run-cursor"),
			);
			const cursor = stale.encodeChangeCursor(
				0,
				stale.fingerprint({ nothing: true }),
			);

			const response = await get(
				`/api/v1/run-changes?cursor=${encodeURIComponent(cursor)}`,
				"hdr.reader.sig",
			);

			// Not an empty 200: the client has to know it missed an interval.
			expect(response.statusCode).toBe(410);
			expect(response.json().error).toBe("stream_gone");

			// And it can re-list and resume immediately.
			const fresh = await get("/api/v1/run-changes", "hdr.reader.sig");
			expect(fresh.statusCode).toBe(200);
			expect(fresh.json().nextCursor).toBeDefined();
		});

		it("accepts `state` as the spelling for `lifecycle`", async () => {
			seedRun();
			// The fleet vocabulary says `state`; the wire document calls the same
			// field `lifecycle`. Ignoring the alias answered 200 with a SUPERSET of
			// what was asked for.
			const filtered = await get(
				"/api/v1/runs?state=complete",
				"hdr.reader.sig",
			);
			expect(filtered.statusCode).toBe(200);
			expect(filtered.json().runs).toEqual([]);
		});

		it("refuses an unknown or empty query parameter rather than ignoring it", async () => {
			seedRun();
			const unknown = await get(
				"/api/v1/runs?workspaceId=workspace-a",
				"hdr.reader.sig",
			);
			expect(unknown.statusCode).toBe(400);
			expect(unknown.json().error).toBe("invalid_query");
			expect(unknown.json().message).toContain("workspaceId");

			const empty = await get("/api/v1/runs?cursor=", "hdr.reader.sig");
			expect(empty.statusCode).toBe(400);
			expect(empty.json().error).toBe("invalid_query");
		});

		it("starts a watch at the present with `from=latest`", async () => {
			seedRun();
			// The snapshot-then-watch handoff: take a position now, then list, then
			// resume — without dragging the whole retained window through first.
			const now = await get(
				"/api/v1/run-changes?from=latest",
				"hdr.reader.sig",
			);
			expect(now.statusCode).toBe(200);
			expect(now.json().changes).toEqual([]);

			store.recordAgentRunActivity("session-a", NOW + 5);
			const followed = await get(
				`/api/v1/run-changes?cursor=${encodeURIComponent(now.json().nextCursor)}`,
				"hdr.reader.sig",
			);
			expect(
				followed.json().changes.map((change: { kind: string }) => change.kind),
			).toEqual(["lifecycle"]);
		});

		it("refuses an unknown `from` value", async () => {
			const response = await get(
				"/api/v1/run-changes?from=yesterday",
				"hdr.reader.sig",
			);
			expect(response.statusCode).toBe(400);
		});

		it("refuses a cursor minted for a different principal's authority", async () => {
			seedRun();
			const readerCursor = (
				await get("/api/v1/run-changes", "hdr.reader.sig")
			).json().nextCursor;

			const response = await get(
				`/api/v1/run-changes?cursor=${encodeURIComponent(readerCursor)}`,
				"hdr.recoverer.sig",
			);

			expect(response.statusCode).toBe(400);
			expect(response.json().error).toBe("cursor_query_mismatch");
		});
	});
});
