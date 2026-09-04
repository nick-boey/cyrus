import type { ILogger } from "cyrus-core";
import {
	type AuthorizedWorkspaceV1,
	logSourceDescriptorV1Schema,
	type OperatorAuthMethodV1,
	type OperatorCapabilityV1,
	type OperatorContextV1,
	type OperatorRoleV1,
	operatorContextV1Schema,
	operatorSkillCompatibilityV1Schema,
	type PublicRouterMetadataV1,
	publicRouterMetadataV1Schema,
	type RunChangePageV1,
	type RunObservationPageV1,
	type RunObservationV1,
	runChangePageV1Schema,
	runObservationPageV1Schema,
	runObservationV1Schema,
} from "cyrus-operator-protocol";
import {
	type AgentRunChange,
	type FleetRunDimension,
	type FleetRunQuery,
	OPERATOR_ROLES,
	type RouterStore,
} from "../RouterStore.js";
import { observeRun, toRunObservationV1 } from "../runs.js";
import { RunCursorCodec, RunCursorError } from "./RunChangeCursor.js";
import {
	AUTH_METHOD_BY_KIND,
	DEFAULT_ROUTER_ID,
	type FleetOperationsConfig,
	type OperatorPrincipal,
} from "./types.js";

/** How many runs a page carries when the caller does not say. */
const DEFAULT_RUN_PAGE_SIZE = 50;
const MAX_RUN_PAGE_SIZE = 200;
/**
 * How many stored entries one change request scans.
 *
 * A SCAN limit rather than a result limit: entries outside the caller's
 * authorization are filtered after they are read, so a page can legitimately
 * come back shorter than this. The cursor still advances past everything
 * scanned, so a caller polling through a stretch of other people's activity
 * makes progress rather than looping.
 */
const CHANGE_SCAN_LIMIT = 200;

/**
 * The dimensions a query may name by canonical id OR by the name captured
 * beside it. Order is the order candidates are resolved in, and it is stable so
 * that an ambiguous name always reports the same dimension first.
 */
const NAMEABLE_DIMENSIONS = [
	["workspace", "workspaceId"],
	["owner", "ownerUserId"],
	["team", "linearTeamId"],
	["project", "linearProjectId"],
] as const satisfies ReadonlyArray<
	readonly [FleetRunDimension, keyof FleetRunQuery]
>;

/**
 * A refusal a fleet route renders directly.
 *
 * `candidates` exists for exactly one case — an exact captured name matching
 * more than one canonical id — and is safe to disclose because it is computed
 * from the AUTHORIZED set: `RouterStore.listFleetRunDimensionValues` applies
 * the caller's workspace scope before it distinct-counts anything, so the list
 * can only ever name things the caller may already read.
 */
export class FleetQueryError extends Error {
	constructor(
		readonly status: 400 | 403 | 410,
		readonly code: string,
		message: string,
		readonly candidates?: Array<{ id: string; name?: string }>,
	) {
		super(message);
		this.name = "FleetQueryError";
	}
}

/**
 * The raw, unresolved query behind `GET /api/v1/runs`.
 *
 * Every field is a string straight off the query string. `workspace`, `owner`,
 * `team`, and `project` each accept a canonical id or an exact captured name;
 * the rest are matched literally.
 */
export interface FleetRunsQueryInput {
	runId?: string;
	agentSessionId?: string;
	issueId?: string;
	issueKey?: string;
	workspace?: string;
	owner?: string;
	team?: string;
	project?: string;
	lifecycle?: string;
	runner?: string;
	model?: string;
	limit?: number;
	cursor?: string;
}

/** Operator interface versions this router speaks. */
const OPERATOR_API_VERSIONS = ["v1"] as const;

/**
 * Which role each capability requires. `recoveries.request` needing
 * `fleet.recover` is the contract's own rule; the read capabilities needing
 * `fleet.read` is this router's, and it is what stops a recovery-only grant
 * from implying read access by omission.
 */
const ROLE_BY_CAPABILITY: Record<OperatorCapabilityV1, OperatorRoleV1> = {
	"runs.list": "fleet.read",
	"runs.changes": "fleet.read",
	"logs.query": "fleet.read",
	"recoveries.request": "fleet.recover",
};

/**
 * Which capabilities the ROUTER itself serves, and can therefore narrow to an
 * owner-scoped principal's own work.
 *
 * `logs.query` is deliberately absent, and that absence is the whole mechanism
 * behind {@link OperatorPrincipal.ownerUserId}. Under that capability the router
 * hands over a log-source descriptor and the client queries the backend
 * DIRECTLY — no router-side filter exists or can exist — so granting it to a
 * device token would convert "read your own runs" into "read every log line in
 * every workspace this router serves", and would disclose the Log Analytics
 * workspace GUID and ARM resource id on the way. A `ownerUserId` recorded on the
 * principal and consulted nowhere is not a scope; this is where it binds.
 */
const OWNER_SCOPE_ENFORCEABLE: readonly OperatorCapabilityV1[] = [
	"runs.list",
	"runs.changes",
	"recoveries.request",
];

export interface FleetOperationsOptions {
	config: FleetOperationsConfig;
	/** Workspace ids this router serves, in the order they should be reported. */
	workspaceIds: string[];
	/** Display names, keyed by workspace id. Omitted ids simply carry no name. */
	workspaceNames?: Record<string, string>;
	/**
	 * Required to serve the run routes. Optional so a router that only publishes
	 * discovery and context — and every test of those two documents — keeps
	 * constructing this class with nothing else.
	 */
	store?: RouterStore;
	/**
	 * Defaults to a codec bound to the store's own stream epoch. Injectable so a
	 * test can pin the epoch and assert the `410` a restart produces.
	 */
	cursors?: RunCursorCodec;
	logger?: ILogger;
	now?: () => number;
}

/**
 * Builds the two Fleet Operations documents.
 *
 * Both are validated against their v1 schema before they leave this class, and
 * that is a control rather than a formality: `publicRouterMetadataV1Schema` is
 * STRICT precisely so an additive change that slipped a workspace list or a
 * log-source hint onto the anonymous document becomes a thrown error here
 * instead of a quiet disclosure to anyone who can reach the router.
 */
export class FleetOperations {
	private readonly config: FleetOperationsConfig;
	private readonly workspaceIds: string[];
	private readonly workspaceNames: Record<string, string>;
	private readonly store: RouterStore | undefined;
	private readonly cursors: RunCursorCodec | undefined;
	private readonly logger: ILogger | undefined;
	private readonly now: () => number;

	constructor(options: FleetOperationsOptions) {
		this.config = options.config;
		this.workspaceIds = [...options.workspaceIds];
		this.workspaceNames = options.workspaceNames ?? {};
		this.store = options.store;
		this.cursors =
			options.cursors ??
			(options.store
				? new RunCursorCodec(options.store.changeStreamEpoch)
				: undefined);
		this.logger = options.logger;
		this.now = options.now ?? (() => Date.now());
		this.validateConfig();
	}

	/** The epoch every cursor this router mints belongs to. */
	get streamEpoch(): string {
		return this.requireCursors().streamEpoch;
	}

	/**
	 * One page of current run observations for a principal that holds
	 * `runs.list`.
	 *
	 * The order of operations is the security property: capability, then
	 * authorization scope, then name resolution, then filtering, then
	 * pagination. Resolving a name before scoping would let an unauthorized
	 * caller learn which teams and projects exist by watching which names come
	 * back ambiguous; paginating before filtering would leak counts the same way.
	 */
	listRuns(
		principal: OperatorPrincipal,
		query: FleetRunsQueryInput = {},
	): RunObservationPageV1 {
		this.requireCapability(principal, "runs.list");
		const store = this.requireStore();
		const cursors = this.requireCursors();

		const scope = this.scopeFor(principal);
		const resolved = this.resolveQuery(store, scope, query);
		const fingerprint = cursors.fingerprint({
			...resolved,
			principalId: principal.id,
		});
		const after = query.cursor
			? cursors.decodePageCursor(query.cursor, fingerprint)
			: undefined;

		const limit = clampPageSize(
			query.limit,
			DEFAULT_RUN_PAGE_SIZE,
			MAX_RUN_PAGE_SIZE,
		);
		// One extra row decides whether there is a next page, without a second
		// COUNT query that could disagree with this one under concurrent writes.
		const rows = store.listFleetAgentRuns({
			...resolved,
			...(after ? { after } : {}),
			limit: limit + 1,
		});
		const pageRows = rows.slice(0, limit);
		const observedAt = new Date(this.now()).toISOString();
		const runs = pageRows.flatMap((run) =>
			this.renderObservation(run, observedAt),
		);
		const last = pageRows.at(-1);

		return runObservationPageV1Schema.parse({
			schemaVersion: 1,
			observedAt,
			runs,
			...(rows.length > limit && last
				? {
						nextCursor: cursors.encodePageCursor(
							{ startedMs: last.startedMs, runId: last.runId },
							fingerprint,
						),
					}
				: {}),
		} satisfies RunObservationPageV1);
	}

	/**
	 * The material changes recorded after a cursor, for a principal that holds
	 * `runs.changes`.
	 *
	 * `nextCursor` is returned even when the page is empty, and even when every
	 * entry scanned belonged to somebody else — a watch that polled and saw
	 * nothing still has to be able to make progress, and a cursor that stood
	 * still would make an unauthorized caller's traffic look, to an authorized
	 * one, like a stalled feed.
	 */
	listChanges(
		principal: OperatorPrincipal,
		input: { cursor?: string } = {},
	): RunChangePageV1 {
		this.requireCapability(principal, "runs.changes");
		const store = this.requireStore();
		const cursors = this.requireCursors();

		const scope = this.scopeFor(principal);
		// The fingerprint covers the authorization scope alone: this route takes no
		// filters, so what a cursor must not survive is being replayed under a
		// DIFFERENT principal — whose authorized workspaces would make the same
		// position mean a different set of entries.
		const fingerprint = cursors.fingerprint({
			...scope,
			principalId: principal.id,
		});
		const afterChangeId = input.cursor
			? cursors.decodeChangeCursor(input.cursor, fingerprint)
			: 0;

		const scanned = store.listAgentRunChanges({
			afterChangeId,
			limit: CHANGE_SCAN_LIMIT,
		});
		const observedAt = new Date(this.now()).toISOString();
		const changes = scanned.flatMap((change) =>
			this.renderChange(change, scope, cursors, fingerprint),
		);
		const lastScannedId = scanned.at(-1)?.changeId ?? afterChangeId;

		return runChangePageV1Schema.parse({
			schemaVersion: 1,
			observedAt,
			streamEpoch: cursors.streamEpoch,
			changes,
			nextCursor: cursors.encodeChangeCursor(lastScannedId, fingerprint),
		} satisfies RunChangePageV1);
	}

	/**
	 * Renders one stored entry, or nothing when the caller may not see it.
	 *
	 * The authorization decision is taken against the observation's OWN captured
	 * workspace and owner rather than against a join to the current run row: an
	 * entry is a historical fact, and re-deriving who may read it from state that
	 * has since moved is how a retroactive disclosure happens.
	 */
	private renderChange(
		change: AgentRunChange,
		scope: { workspaceIds: string[]; ownerScopeUserId?: number },
		cursors: RunCursorCodec,
		fingerprint: string,
	) {
		const { observation } = change;
		if (
			observation.routing.workspaceId === undefined ||
			!scope.workspaceIds.includes(observation.routing.workspaceId)
		) {
			return [];
		}
		if (
			scope.ownerScopeUserId !== undefined &&
			observation.userId !== scope.ownerScopeUserId
		) {
			return [];
		}
		const observedAt = new Date(change.changedMs).toISOString();
		const rendered = this.renderObservation(observation, observedAt);
		if (rendered.length === 0) return [];
		return [
			{
				schemaVersion: 1 as const,
				changeId: String(change.changeId),
				cursor: cursors.encodeChangeCursor(change.changeId, fingerprint),
				runId: change.runId,
				kind: change.kind,
				observedAt,
				observation: rendered[0] as RunObservationV1,
			},
		];
	}

	/**
	 * Projects a stored run into the v1 document, dropping — with a warning —
	 * anything that will not validate.
	 *
	 * Dropping rather than throwing is deliberate. `listFleetAgentRuns` already
	 * excludes the rows that cannot be rendered, so reaching this is a bug; but
	 * the fleet view is what an operator reaches for when something is already
	 * wrong, and one malformed row turning the whole page into a 500 would take
	 * the diagnostic surface down with the incident.
	 */
	private renderObservation(
		run: Parameters<typeof observeRun>[0],
		observedAt: string,
	): RunObservationV1[] {
		const candidate = toRunObservationV1(observeRun(run), observedAt);
		if (candidate === undefined) return [];
		const parsed = runObservationV1Schema.safeParse(candidate);
		if (!parsed.success) {
			this.logger?.warn(
				`Skipping run ${run.runId}: it cannot be rendered as a v1 observation (${parsed.error.issues
					.map((issue) => issue.path.join("."))
					.join(", ")})`,
			);
			return [];
		}
		return [parsed.data];
	}

	/**
	 * The workspaces and owner this principal's reads are confined to.
	 *
	 * Intersected with the workspaces the ROUTER serves, in the router's order,
	 * so a grant naming a workspace this router does not serve cannot widen
	 * anything — and so two principals holding the same authority always produce
	 * the same fingerprint.
	 */
	private scopeFor(principal: OperatorPrincipal): {
		workspaceIds: string[];
		ownerScopeUserId?: number;
	} {
		return {
			workspaceIds: this.workspaceIds.filter((id) =>
				principal.workspaceIds.has(id),
			),
			...(principal.ownerUserId !== undefined
				? { ownerScopeUserId: principal.ownerUserId }
				: {}),
		};
	}

	/**
	 * Turns the raw query into canonical ids, resolving any exact captured name
	 * against the AUTHORIZED historical set.
	 *
	 * A value is taken as an id whenever one matches, so a name that happens to
	 * equal some other dimension's id can never shadow it. Name resolution runs
	 * against the authorization scope plus the non-nameable filters — not against
	 * the other resolved dimensions — so the answer does not depend on the order
	 * the four are resolved in, which would otherwise make `?team=Platform` mean
	 * different things depending on whether `project` was also supplied.
	 */
	private resolveQuery(
		store: RouterStore,
		scope: { workspaceIds: string[]; ownerScopeUserId?: number },
		query: FleetRunsQueryInput,
	): FleetRunQuery {
		const base: FleetRunQuery = {
			...scope,
			...pickDefined({
				runId: query.runId,
				agentSessionId: query.agentSessionId,
				issueId: query.issueId,
				issueKey: query.issueKey,
				lifecycle: query.lifecycle,
				runner: query.runner,
				model: query.model,
			}),
		};
		const resolved: FleetRunQuery = { ...base };
		for (const [dimension, field] of NAMEABLE_DIMENSIONS) {
			const value = query[dimension];
			if (value === undefined) continue;
			resolved[field] = this.resolveDimension(store, base, dimension, value);
		}
		return resolved;
	}

	private resolveDimension(
		store: RouterStore,
		base: FleetRunQuery,
		dimension: FleetRunDimension,
		value: string,
	): string {
		const candidates = store.listFleetRunDimensionValues({
			...base,
			dimension,
		});
		if (candidates.some((candidate) => candidate.id === value)) return value;

		const matches = candidates.filter((candidate) => candidate.name === value);
		const ids = [...new Set(matches.map((match) => match.id))];
		if (ids.length > 1) {
			throw new FleetQueryError(
				400,
				"ambiguous_name",
				`\`${dimension}\` name "${value}" matches ${ids.length} ids; use one of them instead`,
				matches,
			);
		}
		// Zero matches is NOT an error. The value may be a perfectly valid id that
		// simply has no runs in the retained window, and answering "no runs" is
		// both true and stable, whereas a 400 would make an empty result look like
		// a malformed request.
		return ids[0] ?? value;
	}

	private requireCapability(
		principal: OperatorPrincipal,
		capability: OperatorCapabilityV1,
	): void {
		if (!this.capabilitiesFor(principal).includes(capability)) {
			throw new FleetQueryError(
				403,
				"forbidden",
				`Principal ${principal.id} does not hold ${capability}`,
			);
		}
	}

	private requireStore(): RouterStore {
		if (!this.store) {
			throw new Error(
				"FleetOperations was constructed without a store, so it cannot serve run observations",
			);
		}
		return this.store;
	}

	private requireCursors(): RunCursorCodec {
		if (!this.cursors) {
			throw new Error(
				"FleetOperations was constructed without a store, so it can mint no cursors",
			);
		}
		return this.cursors;
	}

	/**
	 * Rejects a configuration that would compile every request into a 500.
	 *
	 * The config file's schema is necessarily looser than the wire's: it cannot
	 * express `logSourceDescriptorV1Schema`'s cross-field rules (an Azure source
	 * must describe its workspace, a non-Azure one must not, a default lookback
	 * cannot exceed the maximum range). Validating only at response time meant a
	 * router with such a config started cleanly, served `/healthz`, `/enroll`,
	 * `/workspaces`, `/runs`, and discovery normally, and then failed the ONE
	 * authenticated operator route — for as long as it ran, with the only signal
	 * a 500 per request.
	 *
	 * Called from the constructor, so `RouterServer` construction throws and the
	 * router refuses to start — the same posture as `validateSetupAuthConfig`
	 * and the `defaultExecutor` registration check.
	 */
	private validateConfig(): void {
		try {
			if (this.config.logSource) {
				logSourceDescriptorV1Schema.parse(this.config.logSource);
			}
			if (this.config.skill) {
				operatorSkillCompatibilityV1Schema.parse(this.config.skill);
			}
			// Derived entirely from config, so if it can ever be built it can be
			// built now — and a strict-schema violation here is a disclosure bug,
			// which must not wait for the first anonymous request to surface.
			this.describe();
		} catch (error) {
			throw new Error(
				`Invalid fleetOperations configuration: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	/**
	 * The anonymous discovery document: router identity, the operator API
	 * versions it speaks, and how to authenticate — and deliberately nothing
	 * else.
	 *
	 * `device-token` and `local-operator-token` are always offered because the
	 * router always accepts them; there is no configuration that turns either
	 * off, so advertising them conditionally would be inventing a distinction.
	 * `entra` is offered only when it is configured, since offering it without a
	 * tenant and audience gives a client nothing to authenticate against.
	 */
	describe(): PublicRouterMetadataV1 {
		const entra = this.config.access?.entra;
		const metadata: PublicRouterMetadataV1 = {
			schemaVersion: 1,
			routerId: this.config.routerId ?? DEFAULT_ROUTER_ID,
			...(this.config.routerName ? { routerName: this.config.routerName } : {}),
			operatorApiVersions: [...OPERATOR_API_VERSIONS],
			authentication: {
				methods: [
					...(entra ? (["entra"] as const) : []),
					"device-token",
					"local-operator-token",
				],
				...(entra
					? {
							entra: {
								tenantId: entra.tenantId,
								audience: entra.audience,
							},
						}
					: {}),
			},
		};
		return publicRouterMetadataV1Schema.parse(metadata);
	}

	/**
	 * What THIS principal may do — never what the router could do for someone
	 * else. Every field is derived from the principal's own grant, so there is
	 * no branch in which one operator's workspaces or capabilities can appear in
	 * another's context.
	 */
	context(principal: OperatorPrincipal): OperatorContextV1 {
		const capabilities = this.capabilitiesFor(principal);
		const roles = OPERATOR_ROLES.filter((role) => principal.roles.has(role));
		const context: OperatorContextV1 = {
			schemaVersion: 1,
			principalId: principal.id,
			authMethod: this.authMethodFor(principal),
			...(principal.displayName ? { displayName: principal.displayName } : {}),
			roles,
			capabilities,
			authorizedWorkspaces: this.authorizedWorkspaces(principal),
			// Gated on the CAPABILITY, not on the config: a descriptor handed to a
			// principal who may not query it is a disclosure with no purpose, and
			// the contract refuses the document outright if the two disagree.
			...(this.config.logSource && capabilities.includes("logs.query")
				? { logSource: this.config.logSource }
				: {}),
			...(this.config.skill ? { skill: this.config.skill } : {}),
			observedAt: new Date(this.now()).toISOString(),
		};
		return operatorContextV1Schema.parse(context);
	}

	private authMethodFor(principal: OperatorPrincipal): OperatorAuthMethodV1 {
		return AUTH_METHOD_BY_KIND[principal.authKind];
	}

	/**
	 * The intersection of what this router serves, what this principal's roles
	 * permit, and — for an owner-scoped principal — what the router is able to
	 * narrow to that owner. In the router's declared order, so the document is
	 * stable across requests.
	 *
	 * The third term is what keeps a device token at the authority it already
	 * had. See {@link OWNER_SCOPE_ENFORCEABLE}.
	 */
	private capabilitiesFor(
		principal: OperatorPrincipal,
	): OperatorCapabilityV1[] {
		const ownerScoped = principal.ownerUserId !== undefined;
		return (this.config.capabilities ?? []).filter(
			(capability) =>
				principal.roles.has(ROLE_BY_CAPABILITY[capability]) &&
				(!ownerScoped || OWNER_SCOPE_ENFORCEABLE.includes(capability)),
		);
	}

	/**
	 * Reported in the ROUTER's workspace order rather than the grant's, so two
	 * principals holding the same workspaces always see the same list and a
	 * diff between two contexts is about authority, not iteration order.
	 */
	private authorizedWorkspaces(
		principal: OperatorPrincipal,
	): AuthorizedWorkspaceV1[] {
		return this.workspaceIds
			.filter((workspaceId) => principal.workspaceIds.has(workspaceId))
			.map((workspaceId) => ({
				workspaceId,
				...(this.workspaceNames[workspaceId]
					? { name: this.workspaceNames[workspaceId] }
					: {}),
			}));
	}
}

/**
 * Clamps rather than rejects an out-of-range page size. A caller asking for
 * more than the router will serve gets the maximum and a `nextCursor`, which is
 * the same shape as any other page — turning it into a 400 would make a
 * perfectly answerable request fail on a limit it has no way to discover.
 */
function clampPageSize(
	requested: number | undefined,
	fallback: number,
	max: number,
): number {
	if (requested === undefined || !Number.isFinite(requested)) return fallback;
	return Math.min(Math.max(Math.trunc(requested), 1), max);
}

function pickDefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	return Object.fromEntries(
		Object.entries(value).filter(([, item]) => item !== undefined),
	) as Partial<T>;
}

export { RunCursorError };
