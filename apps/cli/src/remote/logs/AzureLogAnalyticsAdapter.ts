import type {
	LogQueryV1,
	LogSourceDescriptorV1,
	LogSourceKindV1,
} from "cyrus-operator-protocol";
import {
	type AccessTokenSource,
	createDefaultEntraChain,
	type EntraCredentialCandidate,
} from "../credentials.js";
import {
	AuthorizationError,
	summarizeBody,
	TransientError,
	UsageError,
} from "../errors.js";
import { compileAzureKql } from "./compileAzureKql.js";
import {
	assertQueryRange,
	enforceLogBudgets,
	type LogQueryResultV1,
	type LogSourceAdapter,
	resolveQueryLimit,
} from "./LogSourceAdapter.js";
import {
	type AzureLogRow,
	type NormalizedAzureRows,
	normalizeAzureRows,
} from "./normalizeAzureRows.js";

/**
 * Reads Cyrus logs from Azure Log Analytics, directly.
 *
 * ── DIRECT, AND THAT IS THE POINT ──
 * The request goes from this process to Azure. It does not pass through the
 * router, and there is no router endpoint that would let it: the router
 * describes the source (CYR-71) and the client reads it. That keeps the router
 * out of the path of a query that can return gigabytes, keeps log data off a
 * hop that would have to buffer it, and means the operator's own Azure grant —
 * not the router's — decides what they can read.
 *
 * ── CREDENTIALS ARE LOCAL AND NON-INTERACTIVE ──
 * The same four-link chain the router connection uses (CYR-67), in the same
 * order, against the Log Analytics audience instead of the router's. No browser
 * and no device code: a fleet command runs unattended inside an orchestrating
 * agent, and a credential that can block on a human turns a failed
 * authentication into a hung session with no output.
 *
 * ── PARTIAL IS A FAILURE ──
 * Log Analytics answers an over-large or timed-out query with a PARTIAL result:
 * real rows, plus an error saying there were more. Rendering those rows would
 * hand the operator a subset that looks exactly like a complete answer, which is
 * the same defect as truncating — so a partial result fails the command.
 */
export class AzureLogAnalyticsAdapter implements LogSourceAdapter {
	readonly kind: LogSourceKindV1 = "azure-log-analytics";

	/** The KQL of the most recent query, for `--show-query`. */
	lastQuery?: string;

	private readonly createClient: (
		descriptor: AzureLogAnalyticsTarget,
	) => Promise<LogsQueryClientLike>;
	private readonly env?: NodeJS.ProcessEnv;
	private readonly entraChain?: EntraCredentialCandidate[];
	private client?: LogsQueryClientLike;

	constructor(
		options: {
			/** Injected by tests; production builds the real SDK client lazily. */
			createClient?: (
				descriptor: AzureLogAnalyticsTarget,
			) => Promise<LogsQueryClientLike>;
			env?: NodeJS.ProcessEnv;
			entraChain?: EntraCredentialCandidate[];
		} = {},
	) {
		this.env = options.env;
		this.entraChain = options.entraChain;
		this.createClient =
			options.createClient ??
			((target) =>
				createLogsQueryClient(target, {
					env: this.env,
					chain: this.entraChain,
				}));
	}

	async query(
		descriptor: LogSourceDescriptorV1,
		query: LogQueryV1,
		signal?: AbortSignal,
	): Promise<LogQueryResultV1> {
		const azure = descriptor.azure;
		if (descriptor.kind !== "azure-log-analytics" || !azure) {
			throw new UsageError(
				`This adapter reads Azure Log Analytics, but the router described a \`${descriptor.kind}\` log source.`,
			);
		}

		// Budgets that can be decided from the REQUEST are decided before the
		// request is made. Discovering after a billed query that its range was
		// never allowed wastes the query and the operator's time equally.
		const limit = resolveQueryLimit(descriptor, query);
		assertQueryRange(descriptor, query);

		const compiled = compileAzureKql(azure, query, limit);
		this.lastQuery = compiled.query;

		this.client ??= await this.createClient(azure);
		const startedAt = Date.now();
		const result = await this.execute(
			this.client,
			azure.workspaceId,
			compiled.query,
			query,
			signal,
		);
		const backendLatencyMs = Date.now() - startedAt;

		const normalized = this.normalize(result);
		enforceLogBudgets(normalized.records, limit);

		return {
			records: normalized.records,
			backendLatencyMs,
			...(normalized.skipped > 0 ? { skipped: normalized.skipped } : {}),
			...(normalized.maxIngestionLagMs !== undefined
				? { maxIngestionLagMs: normalized.maxIngestionLagMs }
				: {}),
		};
	}

	/**
	 * Runs the query, mapping every backend answer onto the failure vocabulary an
	 * orchestrator branches on.
	 */
	private async execute(
		client: LogsQueryClientLike,
		workspaceId: string,
		kql: string,
		query: LogQueryV1,
		signal?: AbortSignal,
	): Promise<LogsQueryResultLike> {
		let result: LogsQueryResultLike;
		try {
			result = await client.queryWorkspace(
				workspaceId,
				kql,
				{
					startTime: new Date(query.range.from),
					endTime: new Date(query.range.to),
				},
				{ abortSignal: signal },
			);
		} catch (error) {
			throw describeAzureFailure(error);
		}

		if (result.status === "PartialFailure") {
			throw new TransientError(
				"Azure Log Analytics returned a PARTIAL result, so no records were emitted rather than a subset that reads as complete" +
					`${result.partialError?.message ? `: ${summarizeBody(result.partialError.message)}` : ""}. ` +
					"Narrow the time range or add a filter.",
			);
		}
		if (result.status !== "Success") {
			throw new TransientError(
				`Azure Log Analytics reported \`${result.status}\` for this query.`,
			);
		}
		return result;
	}

	/**
	 * Maps the one table our own `project` produces into normalized records.
	 *
	 * Columns are located BY NAME rather than by position. The query names them
	 * (`project TimeGenerated, record = p`), but a positional read would break
	 * silently — as records with no timestamp — the first time that projection
	 * gains a column, and this is exactly the kind of change nobody expects to be
	 * load-bearing.
	 */
	private normalize(result: LogsQueryResultLike): NormalizedAzureRows {
		const table = result.tables?.[0];
		if (!table) return { records: [], skipped: 0 };

		const columns = table.columnDescriptors ?? [];
		const timeIndex = columns.findIndex(
			(column) => column.name === "TimeGenerated",
		);
		const recordIndex = columns.findIndex((column) => column.name === "record");
		if (recordIndex < 0) {
			throw new TransientError(
				"Azure Log Analytics returned a table without the `record` column this query projects.",
			);
		}

		const rows: AzureLogRow[] = table.rows.map((row) => ({
			timeGenerated: timeIndex < 0 ? undefined : asInstant(row[timeIndex]),
			record: row[recordIndex],
		}));
		return normalizeAzureRows(rows, { env: this.env });
	}
}

/** The descriptor fields this adapter addresses a query to. */
export type AzureLogAnalyticsTarget = NonNullable<
	LogSourceDescriptorV1["azure"]
>;

/* --------------------------------------------------------------- SDK shapes */

/**
 * The slice of `LogsQueryClient` this adapter uses.
 *
 * Declared structurally rather than imported so that a test can supply a client
 * without the Azure SDK being loaded, and so `--help` on a machine that never
 * queries Azure does not pay to import it. The names match the real client
 * exactly; `createLogsQueryClient` is where the two are proven to line up.
 */
export interface LogsQueryClientLike {
	queryWorkspace(
		workspaceId: string,
		query: string,
		timespan: { startTime: Date; endTime: Date },
		options?: { abortSignal?: AbortSignal },
	): Promise<LogsQueryResultLike>;
}

export interface LogsQueryResultLike {
	status: string;
	tables?: Array<{
		name?: string;
		columnDescriptors?: Array<{ name?: string }>;
		rows: unknown[][];
	}>;
	partialError?: { message?: string };
}

/* ------------------------------------------------------------- credentials */

/**
 * The Entra audience for each Azure cloud's Log Analytics query endpoint.
 *
 * Pinned to the descriptor's `cloud` rather than left to the SDK's default: a
 * sovereign-cloud workspace queried with the public-cloud audience fails with a
 * `401` that names nothing about clouds, and the operator has no way to guess.
 */
const LOG_ANALYTICS_AUDIENCE = {
	AzurePublicCloud: "https://api.loganalytics.io",
	AzureUSGovernment: "https://api.loganalytics.us",
	AzureChinaCloud: "https://api.loganalytics.azure.cn",
} as const;

export function logAnalyticsAudience(
	cloud: AzureLogAnalyticsTarget["cloud"],
): string {
	return LOG_ANALYTICS_AUDIENCE[cloud ?? "AzurePublicCloud"];
}

/**
 * Builds the real SDK client, with a credential that walks the CYR-67 chain.
 *
 * The import is dynamic for the same reason `credentials.ts` defers
 * `@azure/identity`: `cyrus connection list`, `cyrus runs list`, and every
 * non-Azure command in the same binary should not pay to load the Azure SDK.
 */
async function createLogsQueryClient(
	target: AzureLogAnalyticsTarget,
	options: { env?: NodeJS.ProcessEnv; chain?: EntraCredentialCandidate[] },
): Promise<LogsQueryClientLike> {
	const audience = logAnalyticsAudience(target.cloud);
	const credential = createChainedTokenCredential(
		options.chain ?? createDefaultEntraChain(),
		`${audience}/.default`,
	);
	const { LogsQueryClient } = await import("@azure/monitor-query-logs");
	return new LogsQueryClient(credential, {
		audience,
	}) as unknown as LogsQueryClientLike;
}

/** The slice of `@azure/core-auth`'s `TokenCredential` the SDK calls. */
interface TokenCredentialLike {
	getToken(
		scopes: string | string[],
	): Promise<{ token: string; expiresOnTimestamp: number } | null>;
}

/**
 * Presents the non-interactive chain to the Azure SDK as one credential.
 *
 * ── WHY NOT `DefaultAzureCredential` ──
 * It includes interactive links, and its order is whatever the SDK ships this
 * release. Both matter: the order decides which identity Azure sees on a host
 * that holds several, and an interactive link can block forever inside an
 * unattended command. Reusing the chain `credentials.ts` pins keeps the identity
 * that reads the logs the same one that read the router — which is what makes a
 * `403` from one and a success from the other worth reporting as a grant
 * problem rather than a mystery.
 *
 * ── WHY THE FULL TOKEN IS PASSED THROUGH ──
 * `expiresOnTimestamp` is returned unchanged rather than synthesised. The SDK's
 * bearer policy caches on it, and a fabricated expiry either re-mints a token on
 * every request or keeps presenting an expired one until a `401` that reads as a
 * permissions failure.
 */
export function createChainedTokenCredential(
	chain: readonly EntraCredentialCandidate[],
	scope: string,
): TokenCredentialLike {
	let preferred: EntraCredentialCandidate | undefined;
	return {
		async getToken(scopes) {
			const requested = Array.isArray(scopes) ? scopes : [scopes];
			const order =
				preferred && chain.includes(preferred)
					? [preferred, ...chain.filter((link) => link !== preferred)]
					: [...chain];

			const failures: string[] = [];
			for (const candidate of order) {
				try {
					const token = (await (
						candidate.create() as AccessTokenSource
					).getToken(requested.length === 1 ? scope : requested)) as {
						token?: string;
						expiresOnTimestamp?: number;
					} | null;
					if (!token?.token) {
						failures.push(`${candidate.source}: no token returned`);
						continue;
					}
					preferred = candidate;
					return {
						token: token.token,
						// A credential that omits an expiry is treated as expiring
						// immediately rather than as never expiring: re-minting costs a
						// cached call, while presenting a stale token costs a `401` the
						// operator reads as a missing grant.
						expiresOnTimestamp: token.expiresOnTimestamp ?? 0,
					};
				} catch (error) {
					failures.push(
						`${candidate.source}: ${summarizeBody(
							error instanceof Error ? error.message : String(error),
						)}`,
					);
				}
			}
			preferred = undefined;
			throw new AuthorizationError(
				`Could not acquire an Azure token for ${scope}. Tried, in order: ` +
					`${failures.join("; ") || "no credential sources were available"}.`,
			);
		},
	};
}

/* ----------------------------------------------------------------- helpers */

/**
 * Maps an SDK throw onto the category an orchestrator should act on.
 *
 * `auth` is kept apart from `transient` because retrying an unauthorized query
 * is pure noise against a billed endpoint, and an orchestrator that cannot tell
 * them apart will do exactly that.
 */
function describeAzureFailure(error: unknown): Error {
	const status = (error as { statusCode?: number; status?: number } | null)
		?.statusCode;
	const message = summarizeBody(
		error instanceof Error ? error.message : String(error),
	);
	if (isAbort(error)) {
		return new UsageError("The log query was cancelled before it completed.");
	}
	if (status === 401 || status === 403) {
		return new AuthorizationError(
			`Azure Log Analytics refused the query (${status}): ${message}. ` +
				"The local Azure credential may lack a `Log Analytics Reader` grant on this workspace.",
		);
	}
	if (status === 404) {
		return new UsageError(
			`Azure Log Analytics does not recognise this workspace (404): ${message}. ` +
				"The router advertised its id; check that the credential can see that workspace's subscription.",
		);
	}
	return new TransientError(`Azure Log Analytics query failed: ${message}`, {
		cause: error,
	});
}

function isAbort(error: unknown): boolean {
	return (
		(error as { name?: string } | null)?.name === "AbortError" ||
		(error as { code?: string } | null)?.code === "ABORT_ERR"
	);
}

function asInstant(value: unknown): string | Date | undefined {
	if (value instanceof Date || typeof value === "string") return value;
	return undefined;
}
