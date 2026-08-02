import { describe, expect, it } from "vitest";
import {
	parseEasyAuthPrincipal,
	requireSetupPrincipal,
	SETUP_ID_TOKEN_HEADER,
	SetupAuthError,
	type SetupAuthMode,
	type SetupPrincipal,
	type SetupUiConfig,
	validateSetupAuthConfig,
} from "../src/setup/principal.js";

/** The bare client-id GUID an EasyAuth ID token carries as `aud`. See D2′. */
const CLIENT_ID = "11111111-2222-3333-4444-555555555555";

const easyAuthMode: SetupAuthMode = {
	mode: "easyauth-headers",
	verifiedHeaderStrip: true,
};
const devMode: SetupAuthMode = { mode: "dev-insecure-headers" };
const entraMode: SetupAuthMode = {
	mode: "entra-token",
	idTokenAudience: CLIENT_ID,
};

/** Both header modes must behave identically; only their trust basis differs. */
const HEADER_MODES: Array<[string, SetupAuthMode]> = [
	["easyauth-headers", easyAuthMode],
	["dev-insecure-headers", devMode],
];

function encodeBlob(payload: unknown): string {
	return Buffer.from(JSON.stringify(payload)).toString("base64");
}

function principalHeader(claims: Array<[string, string]>): string {
	return encodeBlob({
		auth_typ: "aad",
		name_typ: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
		role_typ: "roles",
		claims: claims.map(([typ, val]) => ({ typ, val })),
	});
}

/**
 * Hand-rolled verifier fake. Records every token it is handed so a test can
 * assert the verifier was *not* reached, which is how the "headers are
 * unreachable in entra-token mode" invariant is proved.
 */
function recordingVerifier(outcome: SetupPrincipal | Error): {
	calls: string[];
	verifyIdToken: (token: string) => Promise<SetupPrincipal>;
} {
	const calls: string[] = [];
	return {
		calls,
		verifyIdToken: async (token: string): Promise<SetupPrincipal> => {
			calls.push(token);
			if (outcome instanceof Error) throw outcome;
			return outcome;
		},
	};
}

async function expectAuthError(
	promise: Promise<SetupPrincipal>,
	status: 401 | 403,
): Promise<SetupAuthError> {
	const caught = await promise.then(
		(value) => {
			throw new Error(
				`expected a SetupAuthError but resolved with ${JSON.stringify(value)}`,
			);
		},
		(error: unknown) => error,
	);
	expect(caught).toBeInstanceOf(SetupAuthError);
	expect((caught as SetupAuthError).status).toBe(status);
	return caught as SetupAuthError;
}

describe("parseEasyAuthPrincipal", () => {
	it("returns undefined when no identity headers are present", () => {
		expect(parseEasyAuthPrincipal({})).toBeUndefined();
	});

	it("reads the email from X-MS-CLIENT-PRINCIPAL-NAME and lowercases it", () => {
		expect(
			parseEasyAuthPrincipal({
				"x-ms-client-principal-name": "Alice@Example.COM",
				"x-ms-client-principal-id": "oid-1",
			}),
		).toEqual({ email: "alice@example.com", objectId: "oid-1" });
	});

	it("falls back through the decoded claims when the name header is absent", () => {
		expect(
			parseEasyAuthPrincipal({
				"x-ms-client-principal": principalHeader([
					["upn", "bob@example.com"],
					["name", "Bob Example"],
				]),
			}),
		).toEqual({ email: "bob@example.com", name: "Bob Example" });
	});

	it("prefers preferred_username over upn over email", () => {
		expect(
			parseEasyAuthPrincipal({
				"x-ms-client-principal": principalHeader([
					["email", "third@example.com"],
					["upn", "second@example.com"],
					["preferred_username", "first@example.com"],
				]),
			})?.email,
		).toBe("first@example.com");
	});

	it("reads the WS-Federation claim URIs the sidecar emits for v1 tokens", () => {
		expect(
			parseEasyAuthPrincipal({
				"x-ms-client-principal": principalHeader([
					[
						"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
						"carol@example.com",
					],
					[
						"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
						"Carol Example",
					],
					[
						"http://schemas.microsoft.com/identity/claims/objectidentifier",
						"oid-carol",
					],
				]),
			}),
		).toEqual({
			email: "carol@example.com",
			name: "Carol Example",
			objectId: "oid-carol",
		});
	});

	/** NOR-274 needs the oid persisted, so capture it from wherever it appears. */
	it("captures oid from the claims blob when the id header is absent", () => {
		expect(
			parseEasyAuthPrincipal({
				"x-ms-client-principal": principalHeader([
					["preferred_username", "dave@example.com"],
					["oid", "oid-dave"],
				]),
			}),
		).toEqual({ email: "dave@example.com", objectId: "oid-dave" });
	});

	it("prefers the id header over the oid claim", () => {
		expect(
			parseEasyAuthPrincipal({
				"x-ms-client-principal-id": "oid-header",
				"x-ms-client-principal": principalHeader([
					["preferred_username", "dave@example.com"],
					["oid", "oid-claim"],
				]),
			})?.objectId,
		).toBe("oid-header");
	});

	it("returns undefined when the principal blob has no email-bearing claim", () => {
		expect(
			parseEasyAuthPrincipal({
				"x-ms-client-principal": principalHeader([["roles", "admin"]]),
			}),
		).toBeUndefined();
	});

	it.each([
		["malformed base64", "not-base64-json"],
		["valid base64 that is not JSON", Buffer.from("<html>").toString("base64")],
		["JSON null", encodeBlob(null)],
		["JSON that is not an object", encodeBlob(42)],
		["an object with no claims array", encodeBlob({ auth_typ: "aad" })],
		["a claims property that is not an array", encodeBlob({ claims: "nope" })],
		["a claims array of non-objects", encodeBlob({ claims: [null, "x", 7] })],
		[
			"claim entries with non-string typ/val",
			encodeBlob({ claims: [{ typ: 1, val: {} }] }),
		],
		["an empty string", ""],
	])("returns undefined for %s rather than throwing", (_name, blob) => {
		expect(() =>
			parseEasyAuthPrincipal({ "x-ms-client-principal": blob }),
		).not.toThrow();
		expect(
			parseEasyAuthPrincipal({ "x-ms-client-principal": blob }),
		).toBeUndefined();
	});

	it("ignores array-valued headers (duplicate header injection)", () => {
		expect(
			parseEasyAuthPrincipal({
				"x-ms-client-principal-name": ["a@example.com", "b@example.com"],
			}),
		).toBeUndefined();
		expect(
			parseEasyAuthPrincipal({
				"x-ms-client-principal": [principalHeader([["upn", "a@example.com"]])],
			}),
		).toBeUndefined();
	});

	it("ignores an empty or whitespace-only name header", () => {
		expect(
			parseEasyAuthPrincipal({ "x-ms-client-principal-name": "" }),
		).toBeUndefined();
		expect(
			parseEasyAuthPrincipal({ "x-ms-client-principal-name": "   " }),
		).toBeUndefined();
	});

	it("does not emit name/objectId keys when the claims carry neither", () => {
		expect(
			Object.keys(
				parseEasyAuthPrincipal({
					"x-ms-client-principal-name": "alice@example.com",
				}) ?? {},
			),
		).toEqual(["email"]);
	});
});

describe("requireSetupPrincipal — header modes", () => {
	it.each(HEADER_MODES)(
		"returns the principal in %s mode",
		async (_n, auth) => {
			await expect(
				requireSetupPrincipal(
					{ "x-ms-client-principal-name": "Alice@Example.com" },
					{ auth },
				),
			).resolves.toEqual({ email: "alice@example.com" });
		},
	);

	it.each(HEADER_MODES)(
		"throws 401 when unauthenticated in %s mode",
		async (_n, auth) => {
			await expectAuthError(requireSetupPrincipal({}, { auth }), 401);
		},
	);

	it.each(HEADER_MODES)(
		"throws 403 when the domain is not allowed in %s mode",
		async (_n, auth) => {
			await expectAuthError(
				requireSetupPrincipal(
					{ "x-ms-client-principal-name": "eve@evil.test" },
					{ auth, allowedDomain: "example.com" },
				),
				403,
			);
		},
	);

	it("compares the domain case-insensitively", async () => {
		await expect(
			requireSetupPrincipal(
				{ "x-ms-client-principal-name": "alice@EXAMPLE.com" },
				{ auth: easyAuthMode, allowedDomain: "Example.COM" },
			),
		).resolves.toEqual({ email: "alice@example.com" });
	});

	it("rejects a suffix trick on the allowed domain", async () => {
		await expectAuthError(
			requireSetupPrincipal(
				{ "x-ms-client-principal-name": "alice@evil-example.com" },
				{ auth: easyAuthMode, allowedDomain: "example.com" },
			),
			403,
		);
	});

	it("rejects an email whose local part smuggles the allowed domain", async () => {
		await expectAuthError(
			requireSetupPrincipal(
				{ "x-ms-client-principal-name": "alice@example.com@evil.test" },
				{ auth: easyAuthMode, allowedDomain: "example.com" },
			),
			403,
		);
	});

	it("is a SetupAuthError so routes can map status directly", async () => {
		const error = await expectAuthError(
			requireSetupPrincipal({}, { auth: easyAuthMode }),
			401,
		);
		expect(error.name).toBe("SetupAuthError");
		expect(error).toBeInstanceOf(Error);
	});

	it("never calls an injected verifier in header modes", async () => {
		const verifier = recordingVerifier(new Error("must not be called"));
		await expect(
			requireSetupPrincipal(
				{
					"x-ms-client-principal-name": "alice@example.com",
					[SETUP_ID_TOKEN_HEADER]: "a-token",
				},
				{ auth: easyAuthMode },
				verifier,
			),
		).resolves.toEqual({ email: "alice@example.com" });
		expect(verifier.calls).toEqual([]);
	});
});

describe("requireSetupPrincipal — entra-token mode", () => {
	/**
	 * THE load-bearing test of this file. In entra-token mode the identity
	 * headers are not a credential — a client that can reach the app directly
	 * can set them freely, so they must not influence the outcome at all.
	 */
	it("ignores forged identity headers when no ID token is present", async () => {
		const verifier = recordingVerifier(new Error("must not be called"));
		await expectAuthError(
			requireSetupPrincipal(
				{
					"x-ms-client-principal-name": "eve@example.com",
					"x-ms-client-principal-id": "forged-oid",
					"x-ms-client-principal": principalHeader([
						["preferred_username", "eve@example.com"],
						["name", "Eve Attacker"],
					]),
				},
				{ auth: entraMode },
				verifier,
			),
			401,
		);
		expect(verifier.calls).toEqual([]);
	});

	it("uses the verified token identity, never the forged headers", async () => {
		const verifier = recordingVerifier({
			email: "alice@example.com",
			name: "Alice Example",
			objectId: "oid-alice",
		});
		await expect(
			requireSetupPrincipal(
				{
					"x-ms-client-principal-name": "eve@example.com",
					"x-ms-client-principal-id": "forged-oid",
					[SETUP_ID_TOKEN_HEADER]: "jwt-value",
				},
				{ auth: entraMode },
				verifier,
			),
		).resolves.toEqual({
			email: "alice@example.com",
			name: "Alice Example",
			objectId: "oid-alice",
		});
		expect(verifier.calls).toEqual(["jwt-value"]);
	});

	it("throws 401 when the ID token header is absent", async () => {
		const verifier = recordingVerifier(new Error("must not be called"));
		await expectAuthError(
			requireSetupPrincipal({}, { auth: entraMode }, verifier),
			401,
		);
		expect(verifier.calls).toEqual([]);
	});

	it.each([
		["an array-valued token header", ["a", "b"]],
		["an empty token header", ""],
		["a whitespace-only token header", "   "],
	])("throws 401 for %s without calling the verifier", async (_n, value) => {
		const verifier = recordingVerifier(new Error("must not be called"));
		await expectAuthError(
			requireSetupPrincipal(
				{ [SETUP_ID_TOKEN_HEADER]: value },
				{ auth: entraMode },
				verifier,
			),
			401,
		);
		expect(verifier.calls).toEqual([]);
	});

	it("throws 401 when the verifier rejects the token", async () => {
		const verifier = recordingVerifier(new Error("bad signature"));
		await expectAuthError(
			requireSetupPrincipal(
				{ [SETUP_ID_TOKEN_HEADER]: "jwt-value" },
				{ auth: entraMode },
				verifier,
			),
			401,
		);
		expect(verifier.calls).toEqual(["jwt-value"]);
	});

	it("throws 401 when the verified token carries no usable email", async () => {
		await expectAuthError(
			requireSetupPrincipal(
				{ [SETUP_ID_TOKEN_HEADER]: "jwt-value" },
				{ auth: entraMode },
				recordingVerifier({ email: "  " }),
			),
			401,
		);
	});

	it("lowercases the email the verifier returns", async () => {
		await expect(
			requireSetupPrincipal(
				{ [SETUP_ID_TOKEN_HEADER]: "jwt-value" },
				{ auth: entraMode },
				recordingVerifier({ email: "Alice@Example.COM" }),
			),
		).resolves.toEqual({ email: "alice@example.com" });
	});

	it("applies the domain gate to the token identity", async () => {
		await expectAuthError(
			requireSetupPrincipal(
				{ [SETUP_ID_TOKEN_HEADER]: "jwt-value" },
				{ auth: entraMode, allowedDomain: "example.com" },
				recordingVerifier({ email: "eve@evil.test" }),
			),
			403,
		);
	});

	/**
	 * A missing verifier is a wiring bug, not a signed-out user. It must not
	 * degrade to a 401 (which reads as "sign in again") — fail closed as a 500.
	 */
	it("throws a non-SetupAuthError when no verifier is injected", async () => {
		const error = await requireSetupPrincipal(
			{ [SETUP_ID_TOKEN_HEADER]: "jwt-value" },
			{ auth: entraMode },
		).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(SetupAuthError);
		expect((error as Error).message).toMatch(/verifyIdToken/);
	});

	it("throws a non-SetupAuthError for an unrecognised auth mode", async () => {
		const error = await requireSetupPrincipal(
			{ "x-ms-client-principal-name": "alice@example.com" },
			{ auth: { mode: "totally-bogus" } as unknown as SetupAuthMode },
		).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(SetupAuthError);
	});
});

describe("validateSetupAuthConfig", () => {
	const anyHost = { bindHost: "0.0.0.0" };

	function validate(config: SetupUiConfig, bindHost = "0.0.0.0"): void {
		validateSetupAuthConfig(config, { bindHost });
	}

	it("accepts a disabled setup UI with no auth strategy", () => {
		expect(() => validate({ enabled: false })).not.toThrow();
	});

	it("does not police the strategy while the UI is disabled", () => {
		expect(() => validate({ enabled: false, auth: devMode })).not.toThrow();
	});

	it("throws when enabled with no auth strategy", () => {
		expect(() => validate({ enabled: true })).toThrowError(/auth/);
	});

	it("accepts easyauth-headers once the header strip is verified", () => {
		expect(() => validate({ enabled: true, auth: easyAuthMode })).not.toThrow();
	});

	it.each([
		["omitted", {}],
		["false", { verifiedHeaderStrip: false }],
		["a truthy non-true value", { verifiedHeaderStrip: "yes" }],
	])(
		"throws when easyauth-headers has verifiedHeaderStrip %s",
		(_name, extra) => {
			expect(() =>
				validate({
					enabled: true,
					auth: {
						mode: "easyauth-headers",
						...extra,
					} as unknown as SetupAuthMode,
				}),
			).toThrowError(/verifiedHeaderStrip/);
		},
	);

	it.each(["127.0.0.1", "::1", "[::1]", "localhost", "LOCALHOST"])(
		"accepts dev-insecure-headers bound to loopback %s",
		(bindHost) => {
			expect(() =>
				validate({ enabled: true, auth: devMode }, bindHost),
			).not.toThrow();
		},
	);

	it.each(["0.0.0.0", "::", "", "10.0.0.5", "example.com", "127.0.0.1:3456"])(
		"throws for dev-insecure-headers bound to %s",
		(bindHost) => {
			expect(() =>
				validate({ enabled: true, auth: devMode }, bindHost),
			).toThrowError(/loopback/);
		},
	);

	it("accepts entra-token with a bare client-id audience on any bind host", () => {
		expect(() => validate({ enabled: true, auth: entraMode })).not.toThrow();
	});

	it.each(["", "   "])(
		"throws when entra-token has a blank audience (%j)",
		(idTokenAudience) => {
			expect(() =>
				validate({
					enabled: true,
					auth: { mode: "entra-token", idTokenAudience },
				}),
			).toThrowError(/idTokenAudience/);
		},
	);

	/** D2′: an ID token's `aud` is the bare GUID, not the api:// URI. */
	it("throws when entra-token is given the api:// enrollment audience", () => {
		expect(() =>
			validate({
				enabled: true,
				auth: { mode: "entra-token", idTokenAudience: `api://${CLIENT_ID}` },
			}),
		).toThrowError(/api:\/\//);
	});

	it("throws for an unrecognised auth mode", () => {
		expect(() =>
			validate({
				enabled: true,
				auth: { mode: "trust-me" } as unknown as SetupAuthMode,
			}),
		).toThrowError(/trust-me/);
	});

	/** D1′ rule 5: enrollment's Entra config must not influence setup auth. */
	it("ignores unrelated setupUi fields such as autoProvisionUsers", () => {
		expect(() =>
			validateSetupAuthConfig(
				{
					enabled: true,
					auth: easyAuthMode,
					allowedDomain: "example.com",
					autoProvisionUsers: true,
				},
				anyHost,
			),
		).not.toThrow();
	});
});
