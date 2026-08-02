import { createServer, type Server } from "node:http";
import {
	exportJWK,
	generateKeyPair,
	type JWK,
	type KeyLike,
	SignJWT,
} from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSetupIdTokenVerifier } from "../src/setup/idTokenVerifier.js";

const tenantId = "11111111-2222-3333-4444-555555555555";
/** Bare client-id GUID — what an ID token carries. */
const clientId = "99999999-8888-7777-6666-555555555555";
/** Application ID URI — what an enrollment ACCESS token carries. */
const apiAudience = `api://${clientId}`;
const v1Issuer = `https://sts.windows.net/${tenantId}/`;
const v2Issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;

describe("createSetupIdTokenVerifier", () => {
	let jwksServer: Server;
	let jwksUrl: string;
	let privateKey: KeyLike;
	let publicJwk: JWK;

	beforeAll(async () => {
		const pair = await generateKeyPair("RS256");
		privateKey = pair.privateKey;
		publicJwk = { ...(await exportJWK(pair.publicKey)), kid: "key-1" };
		jwksServer = createServer((_request, response) => {
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ keys: [publicJwk] }));
		});
		await new Promise<void>((resolve) =>
			jwksServer.listen(0, "127.0.0.1", resolve),
		);
		const address = jwksServer.address();
		if (!address || typeof address === "string")
			throw new Error("missing JWKS port");
		jwksUrl = `http://127.0.0.1:${address.port}/keys`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve, reject) =>
			jwksServer.close((error) => (error ? reject(error) : resolve())),
		);
	});

	async function token(
		claims: Record<string, unknown> = {
			preferred_username: "Alice@Example.com",
			oid: "oid-1",
			name: "Alice",
		},
		options: {
			audience?: string;
			issuer?: string;
			expiresIn?: string | number;
		} = {},
	): Promise<string> {
		return new SignJWT(claims)
			.setProtectedHeader({ alg: "RS256", kid: "key-1" })
			.setIssuer(options.issuer ?? v2Issuer)
			.setAudience(options.audience ?? clientId)
			.setIssuedAt()
			.setExpirationTime(options.expiresIn ?? "5m")
			.sign(privateKey);
	}

	function verifier(audience = clientId) {
		return createSetupIdTokenVerifier(
			{ tenantId, idTokenAudience: audience },
			jwksUrl,
		);
	}

	it("returns a lowercased principal carrying oid and name", async () => {
		await expect(verifier()(await token())).resolves.toEqual({
			email: "alice@example.com",
			name: "Alice",
			objectId: "oid-1",
		});
	});

	it.each([v1Issuer, v2Issuer])("accepts issuer %s", async (issuer) => {
		await expect(
			verifier()(await token(undefined, { issuer })),
		).resolves.toMatchObject({ email: "alice@example.com" });
	});

	it("rejects a token minted for the api:// access-token audience", async () => {
		// The whole reason this is a separate verifier from enrollment's (D2').
		await expect(
			verifier()(await token(undefined, { audience: apiAudience })),
		).rejects.toThrow();
	});

	it("refuses to be constructed with the api:// audience", () => {
		expect(() => verifier(apiAudience)).toThrow(/bare client-id GUID/);
	});

	it("refuses to be constructed with a blank audience", () => {
		expect(() => verifier("   ")).toThrow(/idTokenAudience/);
	});

	it.each([
		["wrong audience", { audience: "00000000-0000-0000-0000-000000000000" }],
		["wrong issuer", { issuer: "https://issuer.invalid/" }],
		["expired token", { expiresIn: -1 }],
	] as const)("rejects %s", async (_name, options) => {
		await expect(verifier()(await token(undefined, options))).rejects.toThrow();
	});

	it("falls back through upn and email claims", async () => {
		await expect(
			verifier()(await token({ upn: "bob@example.com" })),
		).resolves.toMatchObject({ email: "bob@example.com" });
		await expect(
			verifier()(await token({ email: "carol@example.com" })),
		).resolves.toMatchObject({ email: "carol@example.com" });
	});

	it("rejects a token with no email-bearing claim", async () => {
		await expect(
			verifier()(await token({ sub: "service-principal" })),
		).rejects.toThrow(/missing preferred_username, upn, and email/);
	});

	it("omits name and objectId when the token carries neither", async () => {
		await expect(
			verifier()(await token({ preferred_username: "dan@example.com" })),
		).resolves.toEqual({ email: "dan@example.com" });
	});

	it("rejects a token signed by an unknown key", async () => {
		const other = await generateKeyPair("RS256");
		const forged = await new SignJWT({ preferred_username: "eve@example.com" })
			.setProtectedHeader({ alg: "RS256", kid: "key-1" })
			.setIssuer(v2Issuer)
			.setAudience(clientId)
			.setIssuedAt()
			.setExpirationTime("5m")
			.sign(other.privateKey);
		await expect(verifier()(forged)).rejects.toThrow();
	});
});
