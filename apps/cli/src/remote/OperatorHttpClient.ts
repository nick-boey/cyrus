import {
	type AuthorizedWorkspaceV1,
	type OperatorApiVersionV1,
	type OperatorAuthMethodV1,
	type OperatorCapabilityV1,
	type OperatorContextV1,
	operatorContextV1Schema,
	type PublicRouterMetadataV1,
	publicRouterMetadataV1Schema,
	type RecoveryOperationV1,
	type RecoveryRequestV1,
	type RunChangePageV1,
	type RunObservationPageV1,
	recoveryOperationV1Schema,
	runChangePageV1Schema,
	runObservationPageV1Schema,
} from "cyrus-operator-protocol";
import type { OperatorCredentialProvider } from "./credentials.js";
import {
	AuthorizationError,
	OutcomeError,
	StreamEpochChangedError,
	summarizeBody,
	TransientError,
	UsageError,
} from "./errors.js";

/** Where a client discovers a Cyrus router's operator interface. */
export const DISCOVERY_PATH = "/.well-known/cyrus";
/** The authenticated operator's own view of its authority. */
export const OPERATOR_CONTEXT_PATH = "/api/v1/operator/context";
/** Workspace-authorized, paginated run snapshots. */
export const RUNS_PATH = "/api/v1/runs";
/** The durable, ordered feed of material run changes. */
export const RUN_CHANGES_PATH = "/api/v1/run-changes";
/** The one guarded mutation: ask the router to reconcile a run. */
export const RECOVERIES_PATH = "/api/v1/recoveries";

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
 * What accepting a recovery request produced.
 *
 * `joined` distinguishes the router's `200` — this key was already bound to an
 * operation, and you are watching that one — from its `202`. The two are not
 * cosmetic: a joined operation may already be finished, so a caller that read
 * them as the same thing would report a refusal it is holding as a fresh
 * acceptance.
 */
export interface RecoveryAcceptance {
	operation: RecoveryOperationV1;
	joined: boolean;
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
		const { response, source } = await this.authorizedRequest(
			OPERATOR_CONTEXT_PATH,
		);

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

	/**
	 * One page of run observations for the given query.
	 *
	 * The query is passed through verbatim rather than assembled here: which
	 * parameters exist is a FILTER-vocabulary decision (`runFilters.ts`), and the
	 * route refuses an unknown one with a 400 rather than silently dropping it —
	 * so a parameter this client invented would fail loudly at the router instead
	 * of quietly returning a superset.
	 */
	async listRuns(
		query: Record<string, string> = {},
	): Promise<RunObservationPageV1> {
		const body = await this.readAuthorizedJson(RUNS_PATH, query);
		const parsed = runObservationPageV1Schema.safeParse(body);
		if (!parsed.success) {
			throw new UsageError(
				`${this.baseUrl}${RUNS_PATH} returned an invalid run page: ${describeIssues(parsed.error)}`,
			);
		}
		return parsed.data;
	}

	/**
	 * The material changes recorded after a cursor.
	 *
	 * `from: "latest"` starts at the present instead of replaying the retained
	 * history, which is what makes the snapshot→watch handoff expressible: take a
	 * cursor from HERE, then list runs, then resume from that cursor — in that
	 * order, so nothing can happen in the gap without landing in the feed.
	 *
	 * @throws {StreamEpochChangedError} when the cursor predates a router
	 * restart. The caller must re-snapshot rather than pretend it observed the
	 * restart interval (ADR 0016).
	 */
	async listChanges(
		input: { cursor?: string; from?: "start" | "latest" } = {},
	): Promise<RunChangePageV1> {
		const body = await this.readAuthorizedJson(RUN_CHANGES_PATH, {
			...(input.cursor ? { cursor: input.cursor } : {}),
			...(input.from ? { from: input.from } : {}),
		});
		const parsed = runChangePageV1Schema.safeParse(body);
		if (!parsed.success) {
			throw new UsageError(
				`${this.baseUrl}${RUN_CHANGES_PATH} returned an invalid change page: ${describeIssues(parsed.error)}`,
			);
		}
		return parsed.data;
	}

	/**
	 * Asks the router to reconcile ONE run, and returns the operation it
	 * persisted.
	 *
	 * The request carries exactly the four fields the contract defines, and the
	 * route parses it STRICTLY — so there is no field this client could add that
	 * would select a restart, a redelivery, an unlock, or an executor teardown.
	 * That property belongs to the wire contract rather than to this method, which
	 * is why the request is passed through rather than assembled here.
	 *
	 * Retrying across the credential chain is safe on this POST specifically
	 * because a 401/403 means the router refused before accepting anything, and
	 * because the idempotency key makes a second acceptance a JOIN rather than a
	 * second recovery.
	 */
	async requestRecovery(
		request: RecoveryRequestV1,
	): Promise<RecoveryAcceptance> {
		const { response } = await this.authorizedRequest(
			RECOVERIES_PATH,
			{},
			{ method: "POST", body: JSON.stringify(request) },
		);
		const body = await this.readRecoveryJson(response, RECOVERIES_PATH);
		return {
			operation: this.parseOperation(body, RECOVERIES_PATH),
			// The route answers `200` for a joined operation and `202` for a new
			// one, and this is the only place that distinction is observable.
			joined: response.status === 200,
		};
	}

	/** One persisted recovery operation, if this connection may read it. */
	async getRecovery(operationId: string): Promise<RecoveryOperationV1> {
		const path = `${RECOVERIES_PATH}/${encodeURIComponent(operationId)}`;
		const { response } = await this.authorizedRequest(path);
		const body = await this.readRecoveryJson(response, path);
		return this.parseOperation(body, path);
	}

	private parseOperation(body: unknown, path: string): RecoveryOperationV1 {
		const parsed = recoveryOperationV1Schema.safeParse(body);
		if (!parsed.success) {
			throw new UsageError(
				`${this.baseUrl}${path} returned an invalid recovery operation: ${describeIssues(parsed.error)}`,
			);
		}
		return parsed.data;
	}

	/**
	 * Reads a recovery response, mapping the resource's own refusals onto the
	 * category an orchestrator should act on.
	 *
	 * The distinction {@link readJson} cannot make on its own is the important
	 * one. A `409 stale_revision` and a `409 run_already_terminal` are the router
	 * DECIDING something — the run moved, the run ended — and each is a valid
	 * non-success answer to "recover this run", so they are `outcome` (exit 3),
	 * not `usage`. A `409 idempotency_key_conflict` is the opposite: the caller
	 * reused a key it had already bound to something else, and no retry of the
	 * same invocation will ever succeed, so it is `usage` (exit 2).
	 *
	 * Both `details` fields the router attaches are folded into the message,
	 * because each is the one fact that makes the next attempt possible: the
	 * current revision to re-quote, or the lifecycle that ended the run.
	 */
	private async readRecoveryJson(
		response: Response,
		path: string,
	): Promise<unknown> {
		if (response.ok) return this.readJson(response, path);

		// Read ONCE. The body has to be inspected before we know whether the
		// generic mapping applies, and a `Response` body cannot be read twice.
		const text = await this.bodyText(response);
		const refusal = parseRefusal(text);
		if (refusal && (response.status === 409 || response.status === 404)) {
			const detail = describeRefusalDetail(refusal);
			const message = `${this.baseUrl}${path} refused the recovery (${refusal.error}): ${summarizeBody(refusal.message ?? refusal.error)}${detail}`;
			throw RECOVERY_OUTCOME_CODES.has(refusal.error)
				? new OutcomeError(message)
				: new UsageError(message);
		}
		if (response.status === 404) {
			// No RECOGNIZED refusal on a 404 means the route is missing, not the
			// run — reachable when a router advertises `recoveries.request` and does
			// not serve the resource. Distinguishing the two is why `parseRefusal`
			// matches a closed set of codes instead of any body with an `error`
			// string: Fastify's own 404 is `{"error":"Not Found",…}`, which would
			// otherwise be rendered to an operator as
			// `refused the recovery (Not Found)` — a router misconfiguration
			// reported as a decision about their run.
			throw new UsageError(
				`${this.baseUrl} does not serve ${path}, although it advertises the "recoveries.request" capability. The router is misconfigured or too old.`,
			);
		}
		this.throwForStatus(response.status, text, path);
		// Unreachable: `throwForStatus` always throws on a non-2xx status, and
		// `response.ok` was checked above.
		return undefined;
	}

	private async readAuthorizedJson(
		path: string,
		query: Record<string, string>,
	): Promise<unknown> {
		const { response } = await this.authorizedRequest(path, query);
		if (response.status === 404) {
			throw new UsageError(
				`${this.baseUrl} does not serve ${path}. The router is too old for fleet run operations.`,
			);
		}
		return this.readJson(response, path);
	}

	/**
	 * Presents credentials until one is not refused, or the chain is exhausted.
	 *
	 * Walks the chain against the ROUTER, not only against the token endpoint.
	 * Minting a token and being allowed to use it are different questions, and
	 * only the router answers the second: an unattended host can hold an
	 * ungranted managed identity alongside a granted service principal, and three
	 * of the four Entra links produce APP-ONLY tokens which `OperatorAuthorizer`
	 * refuses regardless of grant. Without this the first credential the
	 * environment happens to produce is final.
	 *
	 * Bounded by the chain length — `rejectAndAdvance` records each refused
	 * source and never offers it again, so the loop cannot re-present one.
	 */
	private async authorizedRequest(
		path: string,
		query: Record<string, string> = {},
		send?: RequestPayload,
	): Promise<{ response: Response; source: string }> {
		if (!this.credentials) {
			throw new UsageError(
				"This client was created without credentials, so it cannot read authenticated operator routes.",
			);
		}
		const refusals: string[] = [];
		while (true) {
			const authorization = await this.credentials.getAuthorization();
			const source = authorization.source;
			const response = await this.request(
				path,
				{ authorization: authorization.header },
				query,
				send,
			);
			if (response.status !== 401 && response.status !== 403) {
				return { response, source };
			}

			refusals.push(`${source} (${response.status})`);
			if (this.credentials.rejectAndAdvance?.(source)) continue;

			// The router deliberately withholds the reason (it would enumerate
			// workspaces and grants to an unauthorized caller), so the remedy has
			// to come from our side: name every credential that was presented.
			const tried =
				refusals.length > 1 ? ` Tried, in order: ${refusals.join(", ")}.` : "";
			// The app-only remedy is offered only for the Entra sources it can
			// apply to. A local operator token is not an Entra principal at all,
			// so telling its holder to run `az login` sends them somewhere with no
			// bearing on their problem — which is worse than saying less.
			const appOnlyHint = isAppOnlyEntraSource(source)
				? " This is an app-only credential, and a router refuses app-only tokens whatever grant they hold — sign in as a user with `az login` instead."
				: "";
			throw new AuthorizationError(
				response.status === 401
					? `The router rejected the credential from ${source} (401). It may be expired, or minted for a different audience.${tried}`
					: `The credential from ${source} is authenticated but not authorized for fleet operations (403). ` +
							`Ask a router administrator for a fleet.read grant.${appOnlyHint}${tried}`,
			);
		}
	}

	private async request(
		path: string,
		headers: Record<string, string>,
		query: Record<string, string> = {},
		send?: RequestPayload,
	): Promise<Response> {
		const search = new URLSearchParams(query).toString();
		const url = `${this.baseUrl}${path}${search ? `?${search}` : ""}`;
		try {
			return await this.fetchFn(url, {
				method: send?.method ?? "GET",
				headers: {
					accept: "application/json",
					...(send ? { "content-type": "application/json" } : {}),
					...headers,
				},
				...(send ? { body: send.body } : {}),
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
			this.throwForStatus(response.status, await this.bodyText(response), path);
		}
		try {
			return await response.json();
		} catch (error) {
			throw new UsageError(`${this.baseUrl}${path} did not return JSON.`, {
				cause: error,
			});
		}
	}

	/** The response body as text, or `""` if it could not be read. */
	private async bodyText(response: Response): Promise<string> {
		return response.text().catch(() => "");
	}

	/**
	 * Maps a non-2xx status onto the category an orchestrator should act on.
	 *
	 * Takes the body as TEXT rather than a `Response` so a caller that has
	 * already inspected the body can reuse it. A body can only be read once, and
	 * the recovery path has to look inside it before deciding whether this
	 * generic mapping applies at all.
	 *
	 * @returns never — declared `void` only so callers read as statements.
	 */
	private throwForStatus(status: number, text: string, path: string): void {
		const body = summarizeBody(text);
		const detail = body ? `: ${body}` : "";
		if (status === 401 || status === 403) {
			throw new AuthorizationError(
				`${this.baseUrl}${path} refused the request (${status})${detail}`,
			);
		}
		if (status === 429 || status >= 500) {
			throw new TransientError(
				`${this.baseUrl}${path} failed (${status})${detail}`,
			);
		}
		// A cursor from a previous router process. Its own category, because a
		// watch RECOVERS from it — re-snapshot and resume — while every other
		// 4xx here is the operator's to fix.
		if (status === 410) {
			throw new StreamEpochChangedError(
				`${this.baseUrl}${path} no longer serves that cursor (410); the router restarted${detail}`,
			);
		}
		throw new UsageError(
			describeAmbiguousName(text) ??
				`${this.baseUrl}${path} rejected the request (${status})${detail}`,
		);
	}
}

/** A request that carries a body. Only the recovery resource has one. */
interface RequestPayload {
	method: "POST";
	body: string;
}

/**
 * The refusal codes that are a router DECISION about the run rather than a
 * defect in the invocation.
 *
 * Both are re-readable: the caller takes a fresh observation and quotes the new
 * revision, or accepts that the run has ended. Neither is a reason to change the
 * command line, which is what separates them from
 * `idempotency_key_conflict` — a key already bound to a different run, where
 * repeating the same invocation can only fail identically forever.
 */
const RECOVERY_OUTCOME_CODES: ReadonlySet<string> = new Set([
	"stale_revision",
	"run_already_terminal",
]);

/**
 * Every refusal code the recovery resource emits, and nothing else.
 *
 * A CLOSED set rather than "any body carrying an `error` string", because the
 * things that answer a 404 on this path are not all the router's recovery
 * resource. Fastify's own not-found body is
 * `{"message":"Route GET:… not found","error":"Not Found","statusCode":404}` —
 * which parses as a refusal under the permissive rule and reaches the operator
 * as `refused the recovery (Not Found)`. That reads as a decision the router
 * made about their run, when it is a router that does not serve the route at
 * all, and it silently retires the message that says so.
 */
const RECOVERY_REFUSAL_CODES: ReadonlySet<string> = new Set([
	"stale_revision",
	"run_already_terminal",
	"idempotency_key_conflict",
	"run_not_found",
	"operation_not_found",
]);

interface RecoveryRefusalBody {
	error: string;
	message?: string;
	currentRevision?: number;
	lifecycle?: string;
}

/** The router's structured refusal, or `undefined` for anything else. */
function parseRefusal(body: string): RecoveryRefusalBody | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	const refusal = parsed as Partial<RecoveryRefusalBody> | null;
	return typeof refusal?.error === "string" &&
		RECOVERY_REFUSAL_CODES.has(refusal.error)
		? (refusal as RecoveryRefusalBody)
		: undefined;
}

/**
 * The one fact from a refusal's `details` that makes the retry possible.
 *
 * Folded into the message rather than left on a structure nobody reads: the
 * refusal surfaces as an exit code and a line on stderr, and an operator told
 * only "this run has changed" has to make another request to learn what to
 * quote next.
 */
function describeRefusalDetail(refusal: RecoveryRefusalBody): string {
	if (typeof refusal.currentRevision === "number") {
		return ` The run is now at revision ${refusal.currentRevision}.`;
	}
	if (typeof refusal.lifecycle === "string") {
		return ` The run is \`${refusal.lifecycle}\`.`;
	}
	return "";
}

/**
 * The Entra chain links that yield an APP-ONLY token.
 *
 * `OperatorAuthorizer.authenticateEntra` refuses `idtyp === "app"` with a 403
 * before any grant is consulted, so for these three no grant is the remedy —
 * which is exactly the wrong thing to tell someone unless it applies.
 * `azure-cli` is excluded because it yields a user token.
 */
const APP_ONLY_ENTRA_SOURCES: ReadonlySet<string> = new Set([
	"workload-identity",
	"managed-identity",
	"service-principal-env",
]);

function isAppOnlyEntraSource(source: string): boolean {
	return APP_ONLY_ENTRA_SOURCES.has(source);
}

/**
 * Renders the router's `ambiguous_name` refusal as the answer it actually is.
 *
 * The router refuses a captured name matching more than one canonical id rather
 * than picking, and returns the candidates — computed from the caller's OWN
 * authorized set, so naming them discloses nothing new. Surfacing them beats the
 * generic "rejected the request (400)" by the whole distance between a dead end
 * and a next command to run.
 *
 * Returns `undefined` for anything else, including a body that is not JSON, so
 * the generic message stays the fallback.
 */
function describeAmbiguousName(body: string): string | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return undefined;
	}
	const refusal = parsed as {
		error?: unknown;
		message?: unknown;
		candidates?: unknown;
	} | null;
	if (refusal?.error !== "ambiguous_name") return undefined;
	const candidates = Array.isArray(refusal.candidates)
		? (refusal.candidates as Array<{ id?: string; name?: string }>)
		: [];
	const listed = candidates
		.map((candidate) =>
			candidate.name
				? `${candidate.name} (${candidate.id})`
				: String(candidate.id),
		)
		.join(", ");
	const message =
		typeof refusal.message === "string"
			? refusal.message
			: "That name matches more than one id.";
	return listed ? `${message}. Candidates: ${listed}.` : `${message}.`;
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
