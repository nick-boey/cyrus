import { createServer, type Server } from "node:http";
import { CLIIssueTrackerService } from "cyrus-core";
import {
	exportJWK,
	generateKeyPair,
	type JWK,
	type KeyLike,
	SignJWT,
} from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	createEntraTokenVerifier,
	type EntraTokenVerifier,
} from "../src/enrollment.js";
import { RouterServer } from "../src/RouterServer.js";

const tenantId = "11111111-2222-3333-4444-555555555555";
const audience = "api://cyrus-router-test";
const v1Issuer = `https://sts.windows.net/${tenantId}/`;
const v2Issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;

describe("Entra-gated enrollment", () => {
	let jwksServer: Server;
	let jwksUrl: string;
	let privateKey1: KeyLike;
	let privateKey2: KeyLike;
	let publicJwk1: JWK;
	let publicJwk2: JWK;
	let servedKeys: JWK[];
	let jwksRequests = 0;

	beforeAll(async () => {
		const pair1 = await generateKeyPair("RS256");
		const pair2 = await generateKeyPair("RS256");
		privateKey1 = pair1.privateKey;
		privateKey2 = pair2.privateKey;
		publicJwk1 = { ...(await exportJWK(pair1.publicKey)), kid: "key-1" };
		publicJwk2 = { ...(await exportJWK(pair2.publicKey)), kid: "key-2" };
		servedKeys = [publicJwk1];
		jwksServer = createServer((_request, response) => {
			jwksRequests++;
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ keys: servedKeys }));
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
		options: {
			issuer?: string;
			audience?: string;
			expiresIn?: string | number;
			claims?: Record<string, unknown>;
			key?: KeyLike;
			kid?: string;
		} = {},
	): Promise<string> {
		return new SignJWT(
			options.claims ?? { preferred_username: "alice@example.com" },
		)
			.setProtectedHeader({ alg: "RS256", kid: options.kid ?? "key-1" })
			.setIssuer(options.issuer ?? v2Issuer)
			.setAudience(options.audience ?? audience)
			.setIssuedAt()
			.setExpirationTime(options.expiresIn ?? "5m")
			.sign(options.key ?? privateKey1);
	}

	async function enroll(
		jwt: string | undefined,
		options: {
			codeEmail?: string;
			allowedDomain?: string;
			verifier?: EntraTokenVerifier;
		} = {},
	) {
		const server = new RouterServer({
			port: 0,
			dbPath: ":memory:",
			workspaces: { "ws-1": { linearToken: "test-token" } },
			webhook: { verificationMode: "direct", secret: "test-secret" },
			trackerFactory: () => new CLIIssueTrackerService(),
			entra: { tenantId, audience, allowedDomain: options.allowedDomain },
			entraTokenVerifier:
				options.verifier ??
				createEntraTokenVerifier({ tenantId, audience }, jwksUrl),
		});
		await server.start();
		const email = options.codeEmail ?? "alice@example.com";
		server.store.addUser({ email });
		const code = server.store.mintEnrollmentCode(email, Date.now());
		try {
			return await fetch(`http://127.0.0.1:${server.port}/enroll`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					...(jwt ? { authorization: `Bearer ${jwt}` } : {}),
				},
				body: JSON.stringify({ code }),
			});
		} finally {
			await server.stop();
		}
	}

	it("requires a bearer token when Entra config is set", async () => {
		expect((await enroll(undefined)).status).toBe(401);
	});

	it.each([
		v1Issuer,
		v2Issuer,
	])("accepts issuer %s and binds the token email", async (issuer) => {
		expect((await enroll(await token({ issuer }))).status).toBe(200);
		expect(
			(await enroll(await token(), { codeEmail: "bob@example.com" })).status,
		).toBe(401);
	});

	it.each([
		["wrong audience", { audience: "api://other" }],
		["wrong issuer", { issuer: "https://issuer.invalid/" }],
		["expired token", { expiresIn: -1 }],
	] as const)("rejects %s with 401", async (_name, options) => {
		expect((await enroll(await token(options))).status).toBe(401);
	});

	it("uses preferred_username, then upn, then email", async () => {
		const claims = {
			preferred_username: "alice@example.com",
			upn: "wrong@example.com",
			email: "also-wrong@example.com",
		};
		expect((await enroll(await token({ claims }))).status).toBe(200);
		expect(
			(await enroll(await token({ claims: { upn: "alice@example.com" } })))
				.status,
		).toBe(200);
		expect(
			(await enroll(await token({ claims: { email: "alice@example.com" } })))
				.status,
		).toBe(200);
	});

	it("returns 400 naming all missing email claims", async () => {
		const response = await enroll(
			await token({ claims: { sub: "service-principal" } }),
		);
		expect(response.status).toBe(400);
		expect(await response.json()).toEqual({
			error: "token is missing preferred_username, upn, and email claims",
		});
	});

	it("compares the exact lowercased domain part and rejects suffix tricks", async () => {
		expect(
			(await enroll(await token(), { allowedDomain: "EXAMPLE.COM" })).status,
		).toBe(200);
		expect(
			(
				await enroll(
					await token({
						claims: { preferred_username: "alice@evil-example.com" },
					}),
					{ allowedDomain: "example.com", codeEmail: "alice@evil-example.com" },
				)
			).status,
		).toBe(403);
	});

	it("refetches JWKS when a new kid appears", async () => {
		servedKeys = [publicJwk1];
		jwksRequests = 0;
		const verifier = createEntraTokenVerifier({ tenantId, audience }, jwksUrl, {
			cooldownDuration: 0,
		});
		await expect(verifier(await token())).resolves.toBe("alice@example.com");
		servedKeys = [publicJwk2];
		await expect(
			verifier(await token({ key: privateKey2, kid: "key-2" })),
		).resolves.toBe("alice@example.com");
		expect(jwksRequests).toBeGreaterThanOrEqual(2);
	});
});
