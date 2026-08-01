import type { SetupIdTokenVerifier, SetupPrincipal } from "./principal.js";

/**
 * Verifies the Entra **ID token** the ACA token store forwards in
 * `X-MS-TOKEN-AAD-ID-TOKEN`, for `setupUi.auth.mode === "entra-token"`.
 *
 * This is a second verifier alongside `createEntraTokenVerifier` in
 * `enrollment.ts`, not a reuse of it, for two concrete reasons (D2′):
 *
 * 1. **The audience differs.** Enrollment validates *access* tokens, whose
 *    `aud` is the Application ID URI (`api://<client-id>`). An ID token's
 *    `aud` is the **bare client-id GUID**. Passing one where the other is
 *    expected fails every token.
 * 2. **The return type differs.** Enrollment returns just an email string;
 *    the setup UI needs the `oid` as well, so it can be persisted for the
 *    eventual re-key from mutable email to `(tenantId, oid)` — NOR-274.
 *
 * Issuer handling is deliberately identical to enrollment's: both the v1
 * (`sts.windows.net/{tid}/`) and v2 (`login.microsoftonline.com/{tid}/v2.0`)
 * forms are accepted, because which one Entra mints depends on the app
 * registration's `accessTokenAcceptedVersion` and is not ours to assume.
 */
export interface SetupIdTokenConfig {
	tenantId: string;
	/** The bare client-id GUID. NOT the `api://` Application ID URI. */
	idTokenAudience: string;
}

export class SetupIdTokenError extends Error {}

export function createSetupIdTokenVerifier(
	config: SetupIdTokenConfig,
	jwksUrl = `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/discovery/v2.0/keys`,
	jwksOptions?: { cooldownDuration?: number },
): SetupIdTokenVerifier {
	if (!config.idTokenAudience?.trim()) {
		throw new Error("setup ID token verifier requires idTokenAudience");
	}
	if (config.idTokenAudience.toLowerCase().startsWith("api://")) {
		throw new Error(
			`idTokenAudience must be the bare client-id GUID, not the "api://" Application ID URI (${config.idTokenAudience}). That URI is the audience of enrollment access tokens; an ID token carries the bare client id.`,
		);
	}

	let verifierPromise:
		| Promise<(token: string) => Promise<Record<string, unknown>>>
		| undefined;

	return async (token: string): Promise<SetupPrincipal> => {
		verifierPromise ??= import("jose").then(
			({ createRemoteJWKSet, jwtVerify }) => {
				const jwks = createRemoteJWKSet(new URL(jwksUrl), jwksOptions);
				return async (jwt: string) => {
					const { payload } = await jwtVerify(jwt, jwks, {
						audience: config.idTokenAudience,
						issuer: [
							`https://sts.windows.net/${config.tenantId}/`,
							`https://login.microsoftonline.com/${config.tenantId}/v2.0`,
						],
					});
					// Re-checked explicitly: jose accepts an ARRAY `aud` containing
					// the expected value, which would let a token minted for several
					// audiences in this tenant through. Enrollment does the same.
					if (payload.aud !== config.idTokenAudience) {
						throw new SetupIdTokenError(
							"ID token audience does not exactly match the configured setup audience",
						);
					}
					return payload;
				};
			},
		);

		const payload = await (await verifierPromise)(token);

		let email: string | undefined;
		for (const claim of ["preferred_username", "upn", "email"] as const) {
			const value = payload[claim];
			if (typeof value === "string" && value.length > 0) {
				email = value;
				break;
			}
		}
		if (!email) {
			throw new SetupIdTokenError(
				"ID token is missing preferred_username, upn, and email claims",
			);
		}

		const name = typeof payload.name === "string" ? payload.name : undefined;
		const objectId = typeof payload.oid === "string" ? payload.oid : undefined;
		return {
			email: email.toLowerCase(),
			...(name ? { name } : {}),
			...(objectId ? { objectId } : {}),
		};
	};
}
