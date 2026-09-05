import { z } from "zod";
import {
	identifierV1Schema,
	isoTimestampV1Schema,
	schemaVersionV1Schema,
} from "./primitives.js";

/**
 * The credential-free description of a router's log source, the normalized
 * query a client compiles against it, and the normalized record it gets back.
 *
 * The router describes the log source; the client authenticates to it and
 * queries it directly. Log records never pass back through the router.
 */

export const logSourceKindV1Schema = z.enum(["azure-log-analytics", "fake"]);
export type LogSourceKindV1 = z.infer<typeof logSourceKindV1Schema>;

export const logLevelV1Schema = z.enum(["debug", "info", "warn", "error"]);
export type LogLevelV1 = z.infer<typeof logLevelV1Schema>;

/**
 * A Log Analytics workspace customer ID: the GUID a query is addressed to.
 *
 * Pinned to a GUID rather than left an opaque identifier because anything else
 * is a typo that only fails later, against Azure, as a `404` the operator reads
 * as a permissions problem.
 */
export const azureWorkspaceIdV1Schema = z
	.string()
	.regex(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
		"Must be a Log Analytics workspace customer ID (a GUID)",
	);

/**
 * The ARM resource id of a Log Analytics workspace.
 *
 * `resourceId` is the only free-form field on the descriptor, so it is the only
 * place a URL could hide — and a client that took one for an endpoint would then
 * authenticate to whatever it named. Pinned to an Operational Insights workspace
 * path, over ARM's own name charset, so it can only ever denote the workspace
 * beside it. The terminating `(?![\s\S])` rather than `$` is load-bearing: `$`
 * also matches before a trailing newline, which would admit a value carrying a
 * CRLF into whatever header or URL a future client builds from it.
 */
export const azureWorkspaceResourceIdV1Schema = z
	.string()
	.regex(
		/^\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/resourceGroups\/[A-Za-z0-9._()-]{1,90}\/providers\/Microsoft\.OperationalInsights\/workspaces\/[A-Za-z0-9-]{4,63}(?![\s\S])/i,
		"Must be the ARM resource id of a Microsoft.OperationalInsights workspace",
	);

/**
 * Where the Azure Log Analytics data lives. `workspaceId` is the workspace
 * customer ID a query is addressed to — an identifier, not a credential.
 *
 * The table is pinned to `ContainerAppConsoleLogs_CL` because that is the one
 * dataset holding structured router logs and relayed worker logs even when
 * OTLP export is off. Pinning it also keeps the descriptor from becoming a
 * place to name an arbitrary table.
 *
 * The two identifiers are format-checked HERE, in the wire contract, rather than
 * in whichever config schema happens to produce a descriptor. A router accepts
 * this shape from several places — a hand-written `router-config.json`, the
 * whole-block `CYRUS_ROUTER_FLEET_OPERATIONS_JSON` that `main.bicep` and the
 * Docker entrypoint render — and a rule enforced on one of them is a rule the
 * others document but do not have.
 */
export const azureLogAnalyticsDescriptorV1Schema = z.strictObject({
	workspaceId: azureWorkspaceIdV1Schema,
	table: z.literal("ContainerAppConsoleLogs_CL"),
	cloud: z
		.enum(["AzurePublicCloud", "AzureUSGovernment", "AzureChinaCloud"])
		.optional(),
	resourceId: azureWorkspaceResourceIdV1Schema.optional(),
});
export type AzureLogAnalyticsDescriptorV1 = z.infer<
	typeof azureLogAnalyticsDescriptorV1Schema
>;

/**
 * Advertised with the descriptor and enforced by the querying client.
 * Exceeding one fails the command rather than silently truncating a result the
 * operator would read as complete.
 */
export const logQueryBudgetsV1Schema = z.strictObject({
	defaultLookbackSeconds: z.int().positive(),
	maxRangeSeconds: z.int().positive(),
	maxRecords: z.int().positive(),
	minFollowIntervalSeconds: z.int().positive(),
});
export type LogQueryBudgetsV1 = z.infer<typeof logQueryBudgetsV1Schema>;

/**
 * How to locate a log source, with no way to authenticate to it.
 *
 * STRICT, and that strictness is the contract rather than tidiness: the whole
 * reason the router may hand this to an operator is that it cannot carry a
 * credential. An additive change that slipped a `sharedKey` or
 * `connectionString` onto the document would hand a backend credential to
 * every authorized operator, so unknown keys are refused at both levels.
 */
export const logSourceDescriptorV1Schema = z
	.strictObject({
		schemaVersion: schemaVersionV1Schema,
		kind: logSourceKindV1Schema,
		displayName: z.string().min(1).optional(),
		azure: azureLogAnalyticsDescriptorV1Schema.optional(),
		budgets: logQueryBudgetsV1Schema,
	})
	.superRefine((descriptor, ctx) => {
		const isAzure = descriptor.kind === "azure-log-analytics";
		if (isAzure && descriptor.azure === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["azure"],
				message: "An Azure Log Analytics source must describe its workspace",
			});
		}
		if (!isAzure && descriptor.azure !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["azure"],
				message: `Azure details do not apply to a \`${descriptor.kind}\` source`,
			});
		}
		if (
			descriptor.budgets.defaultLookbackSeconds >
			descriptor.budgets.maxRangeSeconds
		) {
			ctx.addIssue({
				code: "custom",
				path: ["budgets", "defaultLookbackSeconds"],
				message:
					"The default lookback cannot exceed the maximum queryable range",
			});
		}
	});
export type LogSourceDescriptorV1 = z.infer<typeof logSourceDescriptorV1Schema>;

/**
 * A normalized log query: stable Cyrus filters that an adapter compiles into
 * its backend's native query language.
 *
 * STRICT, because this is a request. A misspelled `issuekey` that Zod silently
 * stripped would widen a query the operator believed they had narrowed, and
 * they would read the extra records as a real result. Strictness is also what
 * makes "KQL does not escape the adapter" checkable: there is simply no field
 * a native query could arrive in.
 *
 * `limit` is bounded only as a positive integer here; the concrete ceiling
 * comes from the descriptor's {@link LogQueryBudgetsV1} so the policy lives in
 * one place.
 */
export const logQueryV1Schema = z
	.strictObject({
		schemaVersion: schemaVersionV1Schema,
		range: z.strictObject({
			from: isoTimestampV1Schema,
			to: isoTimestampV1Schema,
		}),
		workspaceId: identifierV1Schema.optional(),
		ownerUserId: identifierV1Schema.optional(),
		issueKey: identifierV1Schema.optional(),
		runId: identifierV1Schema.optional(),
		sessionId: identifierV1Schema.optional(),
		component: z.string().min(1).optional(),
		levels: z.array(logLevelV1Schema).min(1).optional(),
		text: z.string().min(1).optional(),
		traceId: z
			.string()
			.regex(/^[0-9a-f]{32}$/, "Trace ID must be 32 lowercase hex characters")
			.optional(),
		limit: z.int().positive().optional(),
	})
	.superRefine((query, ctx) => {
		if (Date.parse(query.range.from) >= Date.parse(query.range.to)) {
			ctx.addIssue({
				code: "custom",
				path: ["range"],
				message: "The query range must move forward in time",
			});
		}
	});
export type LogQueryV1 = z.infer<typeof logQueryV1Schema>;

/**
 * One log record, normalized away from its backend's column names.
 *
 * Deliberately NOT strict. This is a response built by an adapter from a
 * backend row, and dropping an unmapped column is both the forward-compatible
 * choice and the safer one: an Azure column we never mapped cannot reach the
 * operator's terminal by accident.
 */
export const logRecordV1Schema = z.object({
	schemaVersion: schemaVersionV1Schema,
	recordId: identifierV1Schema,
	timestamp: isoTimestampV1Schema,
	level: logLevelV1Schema,
	message: z.string(),
	component: z.string().min(1).optional(),
	workspaceId: identifierV1Schema.optional(),
	ownerUserId: identifierV1Schema.optional(),
	issueKey: identifierV1Schema.optional(),
	runId: identifierV1Schema.optional(),
	sessionId: identifierV1Schema.optional(),
	// W3C-shaped, so a trace ID preserved from a log attribute joins the trace
	// tables rather than being whatever string the column happened to hold.
	traceId: z
		.string()
		.regex(/^[0-9a-f]{32}$/, "Trace ID must be 32 lowercase hex characters")
		.optional(),
	spanId: z
		.string()
		.regex(/^[0-9a-f]{16}$/, "Span ID must be 16 lowercase hex characters")
		.optional(),
	attributes: z.record(z.string(), z.string()).optional(),
	/** Whether known-secret redaction altered this record. */
	redacted: z.boolean().optional(),
});
export type LogRecordV1 = z.infer<typeof logRecordV1Schema>;
