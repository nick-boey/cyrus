import { z } from "zod";
import { operatorAuthMethodV1Schema } from "./discovery.js";
import { logSourceDescriptorV1Schema } from "./logs.js";
import {
	identifierV1Schema,
	isoTimestampV1Schema,
	schemaVersionV1Schema,
} from "./primitives.js";

/**
 * The authenticated operator's own view of what it may do — the document
 * served at `GET /api/v1/operator/context`.
 */

/**
 * Read and recovery authority are separate roles, never a hierarchy: holding
 * `fleet.read` grants no ability to mutate a run.
 */
export const operatorRoleV1Schema = z.enum(["fleet.read", "fleet.recover"]);
export type OperatorRoleV1 = z.infer<typeof operatorRoleV1Schema>;

/**
 * What the router will actually serve this principal, at route granularity.
 *
 * A client gates an optional command on a capability rather than on the
 * router's Cyrus version, so a CLI and a router can be upgraded independently.
 * `runs.changes` is separate from `runs.list` because a watch needs the durable
 * change feed, which a router may not yet serve.
 */
export const operatorCapabilityV1Schema = z.enum([
	"runs.list",
	"runs.changes",
	"logs.query",
	"recoveries.request",
]);
export type OperatorCapabilityV1 = z.infer<typeof operatorCapabilityV1Schema>;

/**
 * A workspace this operator may observe. The ID is canonical; the name is
 * captured for display and for the exact-name filters the CLI accepts.
 */
export const authorizedWorkspaceV1Schema = z.object({
	workspaceId: identifierV1Schema,
	name: z.string().min(1).optional(),
});
export type AuthorizedWorkspaceV1 = z.infer<typeof authorizedWorkspaceV1Schema>;

/**
 * Which operator skill this router expects to work with.
 *
 * Advertising is not trust: the CLI verifies this against its own trusted
 * Cyrus release source and never installs instructions merely because a router
 * supplied a URL. The checksum is required so that verification has something
 * to compare.
 */
export const operatorSkillCompatibilityV1Schema = z.object({
	name: identifierV1Schema,
	version: identifierV1Schema,
	releaseUrl: z.url(),
	checksum: z
		.string()
		.regex(
			/^sha256:[0-9a-f]{64}$/,
			"Checksum must be a `sha256:` prefixed lowercase hex digest",
		),
	minCliVersion: z.string().min(1).optional(),
});
export type OperatorSkillCompatibilityV1 = z.infer<
	typeof operatorSkillCompatibilityV1Schema
>;

/**
 * The authenticated principal, its authority, and the resources it may reach.
 *
 * Tolerant of unknown keys: this is a response a newer router may extend, and
 * an older CLI reading it should keep working rather than fail closed on a
 * field it does not use.
 */
export const operatorContextV1Schema = z
	.object({
		schemaVersion: schemaVersionV1Schema,
		/** The immutable principal ID authorization is keyed on. */
		principalId: identifierV1Schema,
		authMethod: operatorAuthMethodV1Schema,
		displayName: z.string().min(1).optional(),
		roles: z.array(operatorRoleV1Schema).min(1),
		capabilities: z.array(operatorCapabilityV1Schema),
		authorizedWorkspaces: z.array(authorizedWorkspaceV1Schema).min(1),
		logSource: logSourceDescriptorV1Schema.optional(),
		skill: operatorSkillCompatibilityV1Schema.optional(),
		observedAt: isoTimestampV1Schema,
	})
	.superRefine((context, ctx) => {
		// A fleet read role cannot recover. Advertising the capability without
		// the role would tell a client it may attempt a recovery the router is
		// going to reject, and an orchestrating agent would read the rejection
		// as a fleet problem rather than as its own missing grant.
		if (
			context.capabilities.includes("recoveries.request") &&
			!context.roles.includes("fleet.recover")
		) {
			ctx.addIssue({
				code: "custom",
				path: ["capabilities"],
				message:
					"The `recoveries.request` capability requires the `fleet.recover` role",
			});
		}
		// The log-source descriptor is disclosed only to a principal authorized
		// to query it — never as a side effect of authenticating.
		if (
			context.logSource !== undefined &&
			!context.capabilities.includes("logs.query")
		) {
			ctx.addIssue({
				code: "custom",
				path: ["logSource"],
				message: "A log-source descriptor requires the `logs.query` capability",
			});
		}
	});
export type OperatorContextV1 = z.infer<typeof operatorContextV1Schema>;
