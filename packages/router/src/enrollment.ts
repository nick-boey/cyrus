import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouterStore } from "./RouterStore.js";

const enrollBodySchema = z.object({ code: z.string().min(1) });

export interface EntraEnrollmentConfig {
	tenantId: string;
	audience: string;
	allowedDomain?: string;
}

export type EntraTokenVerifier = (token: string) => Promise<string>;

/** Lazily loads jose and caches the tenant's remote JWKS verifier. */
export function createEntraTokenVerifier(
	config: EntraEnrollmentConfig,
	jwksUrl = `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/discovery/v2.0/keys`,
	jwksOptions?: { cooldownDuration?: number },
): EntraTokenVerifier {
	let verifierPromise:
		| Promise<(token: string) => Promise<Record<string, unknown>>>
		| undefined;

	return async (token: string): Promise<string> => {
		verifierPromise ??= import("jose").then(
			({ createRemoteJWKSet, jwtVerify }) => {
				const jwks = createRemoteJWKSet(new URL(jwksUrl), jwksOptions);
				return async (jwt: string) => {
					const { payload } = await jwtVerify(jwt, jwks, {
						audience: config.audience,
						issuer: [
							`https://sts.windows.net/${config.tenantId}/`,
							`https://login.microsoftonline.com/${config.tenantId}/v2.0`,
						],
					});
					if (payload.aud !== config.audience) {
						throw new Error(
							"token audience does not exactly match router audience",
						);
					}
					return payload;
				};
			},
		);

		const payload = await (await verifierPromise)(token);
		for (const claim of ["preferred_username", "upn", "email"] as const) {
			const value = payload[claim];
			if (typeof value === "string" && value.length > 0) return value;
		}
		throw new MissingEmailClaimsError();
	};
}

class MissingEmailClaimsError extends Error {
	constructor() {
		super("token is missing preferred_username, upn, and email claims");
	}
}

/**
 * Registers `POST /enroll`: a device redeems a one-time enrollment code minted
 * by an admin (`cyrus router users add`) for a long-lived device token. Returns
 * 200 `{ deviceToken }` on success, 401 for an unknown/expired code, or 400 for
 * a malformed body.
 */
export function registerEnrollmentRoute(
	fastify: FastifyInstance,
	store: RouterStore,
	entra?: EntraEnrollmentConfig,
	verifyEntraToken = entra ? createEntraTokenVerifier(entra) : undefined,
): void {
	fastify.post("/enroll", async (request, reply) => {
		const parsed = enrollBodySchema.safeParse(request.body);
		if (!parsed.success) {
			return reply.status(400).send({ error: "invalid request body" });
		}
		let tokenEmail: string | undefined;
		if (entra && verifyEntraToken) {
			const match = request.headers.authorization?.match(/^Bearer ([^\s]+)$/);
			if (!match?.[1]) {
				return reply.status(401).send({ error: "Entra bearer token required" });
			}
			try {
				tokenEmail = await verifyEntraToken(match[1]);
			} catch (error) {
				if (error instanceof MissingEmailClaimsError) {
					return reply.status(400).send({ error: error.message });
				}
				return reply.status(401).send({ error: "invalid Entra bearer token" });
			}

			if (entra.allowedDomain) {
				const domain = tokenEmail.split("@")[1]?.toLowerCase();
				if (domain !== entra.allowedDomain.toLowerCase()) {
					return reply
						.status(403)
						.send({ error: "Entra account domain is not allowed" });
				}
			}
		}

		const result = store.redeemEnrollmentCode(
			parsed.data.code,
			Date.now(),
			tokenEmail,
		);
		if (!result) {
			return reply.status(401).send({ error: "invalid or expired code" });
		}
		return reply.status(200).send({ deviceToken: result.deviceToken });
	});
}
