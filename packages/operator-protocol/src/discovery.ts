import { z } from "zod";
import { identifierV1Schema, schemaVersionV1Schema } from "./primitives.js";

/**
 * Unauthenticated router discovery — the document served at
 * `GET /.well-known/cyrus`.
 */

/** Operator interface versions this package can speak. */
export const operatorApiVersionV1Schema = z.enum(["v1"]);
export type OperatorApiVersionV1 = z.infer<typeof operatorApiVersionV1Schema>;

/**
 * How a caller may authenticate to the operator API.
 *
 * `device-token` is the bearer already issued by `cyrus connect` and keeps its
 * existing user- or container-scoped authority; it is never broadened into an
 * operator credential. `local-operator-token` is the separately minted
 * equivalent for non-Entra deployments.
 */
export const operatorAuthMethodV1Schema = z.enum([
	"entra",
	"device-token",
	"local-operator-token",
]);
export type OperatorAuthMethodV1 = z.infer<typeof operatorAuthMethodV1Schema>;

/** Enough for a client to acquire a token — never a secret. */
export const entraAuthMetadataV1Schema = z.strictObject({
	tenantId: identifierV1Schema,
	audience: identifierV1Schema,
});
export type EntraAuthMetadataV1 = z.infer<typeof entraAuthMetadataV1Schema>;

/**
 * Router identity, supported operator-interface versions, and authentication
 * metadata — and deliberately nothing else.
 *
 * This is the only unauthenticated surface, so the document is STRICT. A
 * workspace list or log-source hint that leaked in through an additive change
 * would be disclosed to anyone who can reach the router; making the schema
 * refuse unknown keys turns that into a test failure rather than a quiet
 * disclosure. Authorized detail belongs in {@link OperatorContextV1}.
 */
export const publicRouterMetadataV1Schema = z
	.strictObject({
		schemaVersion: schemaVersionV1Schema,
		routerId: identifierV1Schema,
		routerName: z.string().min(1).optional(),
		operatorApiVersions: z.array(operatorApiVersionV1Schema).min(1),
		authentication: z.strictObject({
			methods: z.array(operatorAuthMethodV1Schema).min(1),
			entra: entraAuthMetadataV1Schema.optional(),
		}),
	})
	.superRefine((metadata, ctx) => {
		// Entra metadata and the Entra method imply each other. Offering the
		// method without a tenant and audience gives a client nothing to
		// authenticate against; publishing them without offering the method
		// advertises a tenant the router will not accept.
		const offersEntra = metadata.authentication.methods.includes("entra");
		const hasEntra = metadata.authentication.entra !== undefined;
		if (offersEntra && !hasEntra) {
			ctx.addIssue({
				code: "custom",
				path: ["authentication", "entra"],
				message:
					"Entra authentication requires the tenant and audience metadata",
			});
		}
		if (!offersEntra && hasEntra) {
			ctx.addIssue({
				code: "custom",
				path: ["authentication", "entra"],
				message:
					"Entra metadata must not be published unless Entra authentication is offered",
			});
		}
	});
export type PublicRouterMetadataV1 = z.infer<
	typeof publicRouterMetadataV1Schema
>;
