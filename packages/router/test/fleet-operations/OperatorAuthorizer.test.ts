import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	OperatorAuthError,
	OperatorAuthorizer,
} from "../../src/fleet-operations/OperatorAuthorizer.js";
import type { OperatorAccessConfig } from "../../src/fleet-operations/types.js";
import { RouterStore } from "../../src/RouterStore.js";

const NOW = 1_700_000_000_000;
const TENANT = "11111111-1111-1111-1111-111111111111";
const AUDIENCE = "api://cyrus-router";
const WS_A = "workspace-a";
const WS_B = "workspace-b";
const ALICE_OID = "aaaaaaaa-0000-0000-0000-000000000001";
const GROUP_SRE = "gggggggg-0000-0000-0000-00000000000f";

/**
 * A stand-in for the jose-backed verifier. It returns the payload VERBATIM and
 * validates nothing, which is the point: every tenant/audience assertion below
 * is therefore proving that {@link OperatorAuthorizer} re-checks those claims
 * itself, rather than proving that a fake rejected what it was told to reject.
 */
function fakeVerifier(payloads: Record<string, Record<string, unknown>>) {
	return async (token: string): Promise<Record<string, unknown>> => {
		const payload = payloads[token];
		if (!payload) throw new Error("signature verification failed");
		return payload;
	};
}

function accessConfig(): OperatorAccessConfig {
	return {
		entra: {
			tenantId: TENANT,
			audience: AUDIENCE,
			grants: [
				{
					principalIds: [ALICE_OID],
					roles: ["fleet.read"],
					workspaceIds: [WS_A],
				},
				{
					principalIds: [GROUP_SRE],
					roles: ["fleet.read", "fleet.recover"],
					workspaceIds: [WS_A, WS_B],
				},
				{
					principalIds: ["cccccccc-0000-0000-0000-00000000000c"],
					roles: ["fleet.read"],
					workspaceIds: ["workspace-this-router-does-not-serve"],
				},
			],
		},
	};
}

/** A well-formed Entra payload; individual tests override single claims. */
function entraPayload(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		tid: TENANT,
		aud: AUDIENCE,
		oid: ALICE_OID,
		name: "Alice Example",
		...overrides,
	};
}

describe("OperatorAuthorizer", () => {
	let store: RouterStore;
	let physicalToken: string;
	let containerToken: string;
	let aliceUserId: number;

	beforeEach(() => {
		store = new RouterStore(":memory:");
		aliceUserId = store.addUser({
			email: "alice@example.com",
			name: "Alice Example",
		}).userId;
		const code = store.mintEnrollmentCode("alice@example.com", NOW);
		const physical = store.redeemEnrollmentCode(code, NOW);
		if (!physical) throw new Error("enrollment failed");
		physicalToken = physical.deviceToken;
		containerToken = store.createContainerDevice(
			aliceUserId,
			"CYR-65",
			"aca",
		).deviceToken;
	});

	afterEach(() => {
		store.close();
	});

	function build(options?: {
		access?: OperatorAccessConfig;
		payloads?: Record<string, Record<string, unknown>>;
		workspaceIds?: string[];
	}): OperatorAuthorizer {
		return new OperatorAuthorizer({
			store,
			workspaceIds: options?.workspaceIds ?? [WS_A, WS_B],
			...(options?.access ? { access: options.access } : {}),
			verifyEntraToken: fakeVerifier(options?.payloads ?? {}),
			now: () => NOW,
		});
	}

	async function expectDenied(
		promise: Promise<unknown>,
		status: 401 | 403,
	): Promise<OperatorAuthError> {
		const error = await promise.then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(error).toBeInstanceOf(OperatorAuthError);
		expect((error as OperatorAuthError).status).toBe(status);
		return error as OperatorAuthError;
	}

	describe("Entra bearer tokens", () => {
		it("maps a direct object-id grant to its roles and workspaces", async () => {
			const authorizer = build({
				access: accessConfig(),
				payloads: { "hdr.alice.sig": entraPayload() },
			});

			const principal = await authorizer.authenticate("Bearer hdr.alice.sig");

			expect(principal.id).toBe(ALICE_OID);
			expect(principal.authKind).toBe("entra");
			expect([...principal.roles]).toEqual(["fleet.read"]);
			expect([...principal.workspaceIds]).toEqual([WS_A]);
			expect(principal.displayName).toBe("Alice Example");
			// A read grant is not a recovery grant, and never becomes one by
			// virtue of being the only grant the caller holds.
			expect(principal.roles.has("fleet.recover")).toBe(false);
			// A device token's owner scope must never be inherited by an operator
			// principal: this caller is scoped by workspace, not by user.
			expect(principal.ownerUserId).toBeUndefined();
		});

		it("maps a group-id grant, unioning it with the caller's own grants", async () => {
			const authorizer = build({
				access: accessConfig(),
				payloads: {
					"hdr.alice-sre.sig": entraPayload({ groups: [GROUP_SRE] }),
				},
			});

			const principal = await authorizer.authenticate(
				"Bearer hdr.alice-sre.sig",
			);

			expect(principal.id).toBe(ALICE_OID);
			expect([...principal.roles].sort()).toEqual([
				"fleet.read",
				"fleet.recover",
			]);
			expect([...principal.workspaceIds].sort()).toEqual([WS_A, WS_B]);
		});

		it("rejects a token minted for a different tenant", async () => {
			const authorizer = build({
				access: accessConfig(),
				payloads: {
					"hdr.other-tenant.sig": entraPayload({
						tid: "22222222-2222-2222-2222-222222222222",
					}),
				},
			});

			await expectDenied(
				authorizer.authenticate("Bearer hdr.other-tenant.sig"),
				401,
			);
		});

		it("rejects a token minted for a different audience", async () => {
			const authorizer = build({
				access: accessConfig(),
				payloads: {
					"hdr.other-aud.sig": entraPayload({ aud: "api://some-other-api" }),
				},
			});

			await expectDenied(
				authorizer.authenticate("Bearer hdr.other-aud.sig"),
				401,
			);
		});

		it("rejects an audience presented as an array containing the expected value", async () => {
			// jose accepts an array `aud` that merely CONTAINS the expected value,
			// which would let a token minted for several APIs in the tenant through.
			const authorizer = build({
				access: accessConfig(),
				payloads: {
					"hdr.multi-aud.sig": entraPayload({ aud: [AUDIENCE, "api://other"] }),
				},
			});

			await expectDenied(
				authorizer.authenticate("Bearer hdr.multi-aud.sig"),
				401,
			);
		});

		it("denies a verified caller who holds no grant", async () => {
			const authorizer = build({
				access: accessConfig(),
				payloads: {
					"hdr.stranger.sig": entraPayload({
						oid: "dddddddd-0000-0000-0000-00000000000d",
					}),
				},
			});

			await expectDenied(
				authorizer.authenticate("Bearer hdr.stranger.sig"),
				403,
			);
		});

		it("denies a grant whose workspaces this router does not serve", async () => {
			const authorizer = build({
				access: accessConfig(),
				payloads: {
					"hdr.elsewhere.sig": entraPayload({
						oid: "cccccccc-0000-0000-0000-00000000000c",
					}),
				},
			});

			await expectDenied(
				authorizer.authenticate("Bearer hdr.elsewhere.sig"),
				403,
			);
		});

		it("narrows a grant to the intersection of its workspaces and the router's", async () => {
			const authorizer = build({
				access: accessConfig(),
				payloads: {
					"hdr.alice-sre.sig": entraPayload({ groups: [GROUP_SRE] }),
				},
				workspaceIds: [WS_A],
			});

			const principal = await authorizer.authenticate(
				"Bearer hdr.alice-sre.sig",
			);

			expect([...principal.workspaceIds]).toEqual([WS_A]);
		});

		it("rejects a JWT when no Entra access is configured", async () => {
			const authorizer = build({
				payloads: { "hdr.alice.sig": entraPayload() },
			});

			await expectDenied(authorizer.authenticate("Bearer hdr.alice.sig"), 401);
		});

		it("rejects a token whose signature does not verify", async () => {
			const authorizer = build({ access: accessConfig(), payloads: {} });

			await expectDenied(authorizer.authenticate("Bearer hdr.forged.sig"), 401);
		});

		it("rejects a verified token carrying no immutable object id", async () => {
			const authorizer = build({
				access: accessConfig(),
				payloads: { "hdr.no-oid.sig": entraPayload({ oid: undefined }) },
			});

			await expectDenied(authorizer.authenticate("Bearer hdr.no-oid.sig"), 401);
		});
	});

	describe("local operator tokens", () => {
		it("resolves a minted token by hash to its stored roles and workspaces", async () => {
			const created = store.createOperatorToken({
				label: "oncall-laptop",
				roles: ["fleet.read", "fleet.recover"],
				workspaceIds: [WS_A],
				nowMs: NOW,
			});
			const authorizer = build();

			const principal = await authorizer.authenticate(
				`Bearer ${created.token}`,
			);

			expect(principal.authKind).toBe("local");
			expect(principal.id).toBe(`local-token:${created.tokenId}`);
			expect([...principal.roles].sort()).toEqual([
				"fleet.read",
				"fleet.recover",
			]);
			expect([...principal.workspaceIds]).toEqual([WS_A]);
			expect(principal.displayName).toBe("oncall-laptop");
			expect(principal.ownerUserId).toBeUndefined();
		});

		it("stores only a hash, never the raw token", () => {
			const created = store.createOperatorToken({
				label: "oncall-laptop",
				roles: ["fleet.read"],
				workspaceIds: [WS_A],
				nowMs: NOW,
			});

			const listed = store.listOperatorTokens();

			expect(listed).toHaveLength(1);
			expect(JSON.stringify(listed)).not.toContain(created.token);
		});

		it("rejects a revoked token", async () => {
			const created = store.createOperatorToken({
				label: "stolen",
				roles: ["fleet.read"],
				workspaceIds: [WS_A],
				nowMs: NOW,
			});
			expect(store.revokeOperatorToken(created.tokenId, NOW + 1)).toBe(true);
			const authorizer = build();

			await expectDenied(
				authorizer.authenticate(`Bearer ${created.token}`),
				401,
			);
			// Fail-closed by construction: the lookup itself stops returning the
			// row, so no caller can forget to check `revokedMs`.
			expect(store.getOperatorTokenByToken(created.token)).toBeUndefined();
		});

		it("rejects an unknown token bearing the operator prefix", async () => {
			const authorizer = build();

			await expectDenied(authorizer.authenticate("Bearer cyop_deadbeef"), 401);
		});

		it("denies a token whose workspaces this router no longer serves", async () => {
			const created = store.createOperatorToken({
				label: "retired-workspace",
				roles: ["fleet.read"],
				workspaceIds: ["workspace-gone"],
				nowMs: NOW,
			});
			const authorizer = build();

			await expectDenied(
				authorizer.authenticate(`Bearer ${created.token}`),
				403,
			);
		});
	});

	describe("device tokens", () => {
		it("gives a user's own device read authority scoped to that user", async () => {
			const authorizer = build();

			const principal = await authorizer.authenticate(
				`Bearer ${physicalToken}`,
			);

			expect(principal.authKind).toBe("device");
			expect([...principal.roles]).toEqual(["fleet.read"]);
			// The scope a device token already had — its owner's own work — is
			// carried forward rather than widened into fleet-wide read.
			expect(principal.ownerUserId).toBe(aliceUserId);
			expect([...principal.workspaceIds].sort()).toEqual([WS_A, WS_B]);
			expect(principal.roles.has("fleet.recover")).toBe(false);
		});

		it("denies a container device token outright", async () => {
			const authorizer = build();

			await expectDenied(
				authorizer.authenticate(`Bearer ${containerToken}`),
				403,
			);
		});

		it("rejects an unknown device token", async () => {
			const authorizer = build();

			await expectDenied(
				authorizer.authenticate("Bearer 0123456789abcdef"),
				401,
			);
		});
	});

	describe("malformed credentials", () => {
		it.each([
			["a missing header", undefined],
			["a non-bearer scheme", "Basic abc"],
			["an empty bearer value", "Bearer "],
		])("rejects %s", async (_label, header) => {
			const authorizer = build({ access: accessConfig() });

			await expectDenied(authorizer.authenticate(header), 401);
		});
	});
});
