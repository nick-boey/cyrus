import {
	type AuthorizedWorkspaceV1,
	type OperatorApiVersionV1,
	type OperatorAuthMethodV1,
	type OperatorCapabilityV1,
	type OperatorContextV1,
	operatorContextV1Schema,
	type PublicRouterMetadataV1,
	publicRouterMetadataV1Schema,
} from "cyrus-operator-protocol";
import type { OperatorCredentialProvider } from "./credentials.js";
import {
	AuthorizationError,
	summarizeBody,
	TransientError,
	UsageError,
} from "./errors.js";

/** Where a client discovers a Cyrus router's operator interface. */
export const DISCOVERY_PATH = "/.well-known/cyrus";
/** The authenticated operator's own view of its authority. */
export const OPERATOR_CONTEXT_PATH = "/api/v1/operator/context";

/**
 * Operator interface versions this CLI can speak.
 *
 * Compared against the router's advertised list rather than against a Cyrus
 * package version, so a CLI and a router upgrade independently (ADR 0010).
 */
export const SUPPORTED_OPERATOR_API_VERSIONS: readonly OperatorApiVersionV1[] =
	["v1"];

/** Requests are bounded; Node's `fetch` has no default timeout. */
const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export interface OperatorHttpClientOptions {
	/** The router's HTTP(S) origin. */
	baseUrl: string;
	/** Omitted for a client that only performs unauthenticated discovery. */
	credentials?: OperatorCredentialProvider;
	fetchFn?: typeof fetch;
	timeoutMs?: number;
}

/** The context document plus which credential in the chain produced it. */
export interface OperatorContextResult {
	context: OperatorContextV1;
	authSource: string;
}

/**
 * The ONLY way the remote commands reach a router.
 *
 * Transport, authentication, document validation, and capability negotiation
 * live here together because they fail as one thing: a 403 from an expired
 * Azure CLI login, a 404 from a router too old to serve the route, and a body
 * that parses but omits `capabilities` are three different remedies, and a
 * command that assembled its own `fetch` would have to re-derive all three.
 *
 * Commands receive `OperatorContextV1` and never a `Response`.
 */
export class OperatorHttpClient {
	private readonly baseUrl: string;
	private readonly credentials?: OperatorCredentialProvider;
	private readonly fetchFn: typeof fetch;
	private readonly timeoutMs: number;

	constructor(options: OperatorHttpClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.credentials = options.credentials;
		this.fetchFn = options.fetchFn ?? fetch;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	/**
	 * Reads the router's unauthenticated discovery document.
	 *
	 * Sends no `Authorization` header and never consults the credential
	 * provider — this is what an operator runs BEFORE they have a working
	 * credential, and making it depend on one would mean an `az login` problem
	 * and a wrong URL produced the same error.
	 */
	async discover(): Promise<PublicRouterMetadataV1> {
		const response = await this.request(DISCOVERY_PATH, {});
		if (response.status === 404) {
			throw new UsageError(
				`${this.baseUrl} does not serve ${DISCOVERY_PATH}. Check the URL, or upgrade the router: the operator interface was added in Cyrus 0.2.71.`,
			);
		}
		const body = await this.readJson(response, DISCOVERY_PATH);
		// Version negotiation happens BEFORE schema validation, and the order is
		// the point. `operatorApiVersionV1Schema` is a closed enum, so a router
		// serving only `v2` fails the strict parse and reads as a MALFORMED
		// document — the one failure mode where "this router is newer than your
		// CLI" is exactly what the operator needs to be told, and the message
		// would instead send them hunting a router bug.
		assertNegotiableApiVersions(body, this.baseUrl);
		const parsed = publicRouterMetadataV1Schema.safeParse(body);
		if (!parsed.success) {
			throw new UsageError(
				`${this.baseUrl}${DISCOVERY_PATH} is not a valid Cyrus discovery document: ${describeIssues(parsed.error)}`,
			);
		}
		return parsed.data;
	}

	/**
	 * Reads the authenticated operator's own view of its authority.
	 *
	 * Returns the credential `source` alongside, so `connection show` can report
	 * which link in the chain answered without the caller re-invoking the
	 * provider and possibly getting a different one.
	 */
	async context(): Promise<OperatorContextResult> {
		if (!this.credentials) {
			throw new UsageError(
				"This client was created without credentials, so it cannot read the operator context.",
			);
		}
		const { header, source } = await this.credentials.getAuthorization();
		const response = await this.request(OPERATOR_CONTEXT_PATH, {
			authorization: header,
		});
		if (response.status === 401 || response.status === 403) {
			// The router deliberately withholds the reason (it would enumerate
			// workspaces and grants to an unauthorized caller), so the remedy has
			// to come from our side: name the credential that was presented.
			throw new AuthorizationError(
				response.status === 401
					? `The router rejected the credential from ${source} (401). It may be expired, or minted for a different audience.`
					: `The credential from ${source} is authenticated but not authorized for fleet operations (403). Ask a router administrator for a fleet.read grant.`,
			);
		}
		if (response.status === 404) {
			throw new UsageError(
				`${this.baseUrl} does not serve ${OPERATOR_CONTEXT_PATH}. The router is too old for fleet operations.`,
			);
		}
		const body = await this.readJson(response, OPERATOR_CONTEXT_PATH);
		const parsed = operatorContextV1Schema.safeParse(body);
		if (!parsed.success) {
			throw new UsageError(
				`${this.baseUrl}${OPERATOR_CONTEXT_PATH} returned an invalid operator context: ${describeIssues(parsed.error)}`,
			);
		}
		return { context: parsed.data, authSource: source };
	}

	private async request(
		path: string,
		headers: Record<string, string>,
	): Promise<Response> {
		const url = `${this.baseUrl}${path}`;
		try {
			return await this.fetchFn(url, {
				headers: { accept: "application/json", ...headers },
				signal: AbortSignal.timeout(this.timeoutMs),
			});
		} catch (error) {
			// A DNS failure, a refused connection, and our own timeout are all
			// "the router did not answer" — worth a retry, unlike a 403.
			throw new TransientError(
				`Could not reach ${url}: ${summarizeBody(
					error instanceof Error ? error.message : String(error),
				)}`,
				{ cause: error },
			);
		}
	}

	/**
	 * Turns a response into parsed JSON, mapping every non-2xx status onto the
	 * category an orchestrator should act on.
	 */
	private async readJson(response: Response, path: string): Promise<unknown> {
		if (!response.ok) {
			const body = summarizeBody(await response.text().catch(() => ""));
			const detail = body ? `: ${body}` : "";
			if (response.status === 401 || response.status === 403) {
				throw new AuthorizationError(
					`${this.baseUrl}${path} refused the request (${response.status})${detail}`,
				);
			}
			if (response.status === 429 || response.status >= 500) {
				throw new TransientError(
					`${this.baseUrl}${path} failed (${response.status})${detail}`,
				);
			}
			throw new UsageError(
				`${this.baseUrl}${path} rejected the request (${response.status})${detail}`,
			);
		}
		try {
			return await response.json();
		} catch (error) {
			throw new UsageError(`${this.baseUrl}${path} did not return JSON.`, {
				cause: error,
			});
		}
	}
}

/**
 * Reads `operatorApiVersions` out of an UNVALIDATED discovery body and refuses
 * a router with which no version is shared.
 *
 * Deliberately permissive about everything else: at this point the document has
 * not been validated, and the only question being asked is whether continuing
 * to validate it against the v1 schema is even meaningful. A body that does not
 * carry a usable version list is left alone for the strict parse to report.
 */
function assertNegotiableApiVersions(body: unknown, baseUrl: string): void {
	const advertised = (body as { operatorApiVersions?: unknown })
		?.operatorApiVersions;
	if (!Array.isArray(advertised) || advertised.length === 0) return;
	const versions = advertised.filter(
		(version): version is string => typeof version === "string",
	);
	if (versions.length === 0) return;
	if (
		versions.some((version) =>
			(SUPPORTED_OPERATOR_API_VERSIONS as readonly string[]).includes(version),
		)
	) {
		return;
	}
	throw new UsageError(
		`${baseUrl} serves operator API version(s) ${versions.join(", ")}, ` +
			`but this CLI speaks ${SUPPORTED_OPERATOR_API_VERSIONS.join(", ")}. Upgrade whichever is older.`,
	);
}

/**
 * Picks the operator API version both sides speak.
 *
 * Fails as INVALID CONFIGURATION rather than as a transient error: no amount of
 * retrying makes a router that speaks only `v2` reachable by this CLI, and the
 * remedy is a version change on one side or the other.
 */
export function negotiateApiVersion(
	metadata: PublicRouterMetadataV1,
): OperatorApiVersionV1 {
	const match = SUPPORTED_OPERATOR_API_VERSIONS.find((version) =>
		metadata.operatorApiVersions.includes(version),
	);
	if (!match) {
		throw new UsageError(
			`Router ${metadata.routerId} serves operator API version(s) ${metadata.operatorApiVersions.join(", ")}, ` +
				`but this CLI speaks ${SUPPORTED_OPERATOR_API_VERSIONS.join(", ")}. Upgrade whichever is older.`,
		);
	}
	return match;
}

/** Confirms the router offers the authentication method the operator chose. */
export function requireAuthMethod(
	metadata: PublicRouterMetadataV1,
	method: OperatorAuthMethodV1,
): void {
	if (!metadata.authentication.methods.includes(method)) {
		throw new UsageError(
			`Router ${metadata.routerId} does not accept ${method} authentication. It offers: ${metadata.authentication.methods.join(", ")}.`,
		);
	}
}

/**
 * Confirms the router will actually serve a route before a command uses it.
 *
 * Gating on the capability rather than attempting the call and interpreting the
 * failure matters because a router that does not serve a route answers 404 —
 * indistinguishable, from the caller's side, from a route that exists and found
 * nothing.
 */
export function requireCapability(
	context: OperatorContextV1,
	capability: OperatorCapabilityV1,
): void {
	if (!context.capabilities.includes(capability)) {
		throw new UsageError(
			`This router connection does not provide the "${capability}" capability. ` +
				`Available: ${context.capabilities.join(", ") || "none"}.`,
		);
	}
}

/**
 * Resolves the workspace a fleet command should act on.
 *
 * One authorized workspace is implicit; more than one requires `--workspace`.
 * IDs are canonical and a name is accepted only when it matches exactly and
 * uniquely — a name is captured display text that two Linear workspaces may
 * share, and resolving a tie by position would silently point a recovery at the
 * wrong fleet (ADR 0010).
 */
export function selectWorkspace(
	context: OperatorContextV1,
	requested?: string,
): AuthorizedWorkspaceV1 {
	const workspaces = context.authorizedWorkspaces;
	if (requested === undefined) {
		if (workspaces.length > 1) {
			throw new UsageError(
				`This connection is authorized over ${workspaces.length} workspaces (${workspaces
					.map(describeWorkspace)
					.join(", ")}). Select one with \`--workspace <id>\`.`,
			);
		}
		return workspaces[0] as AuthorizedWorkspaceV1;
	}

	const byId = workspaces.find(
		(workspace) => workspace.workspaceId === requested,
	);
	if (byId) return byId;

	const byName = workspaces.filter((workspace) => workspace.name === requested);
	if (byName.length === 1) return byName[0] as AuthorizedWorkspaceV1;
	if (byName.length > 1) {
		throw new UsageError(
			`"${requested}" matches ${byName.length} authorized workspaces (${byName
				.map((workspace) => workspace.workspaceId)
				.join(", ")}). Use the workspace id.`,
		);
	}
	throw new UsageError(
		`"${requested}" is not an authorized workspace for this connection. Authorized: ${workspaces
			.map(describeWorkspace)
			.join(", ")}.`,
	);
}

function describeWorkspace(workspace: AuthorizedWorkspaceV1): string {
	return workspace.name
		? `${workspace.name} (${workspace.workspaceId})`
		: workspace.workspaceId;
}

/** A compact, one-line rendering of a Zod failure for an operator to read. */
function describeIssues(error: {
	issues: { path: PropertyKey[]; message: string }[];
}): string {
	return error.issues
		.slice(0, 5)
		.map((issue) => {
			const path = issue.path.map(String).join(".");
			return path ? `${path}: ${issue.message}` : issue.message;
		})
		.join("; ");
}
