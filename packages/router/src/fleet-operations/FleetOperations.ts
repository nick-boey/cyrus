import {
	type AuthorizedWorkspaceV1,
	type OperatorAuthMethodV1,
	type OperatorCapabilityV1,
	type OperatorContextV1,
	type OperatorRoleV1,
	operatorContextV1Schema,
	type PublicRouterMetadataV1,
	publicRouterMetadataV1Schema,
} from "cyrus-operator-protocol";
import { OPERATOR_ROLES } from "../RouterStore.js";
import {
	AUTH_METHOD_BY_KIND,
	DEFAULT_ROUTER_ID,
	type FleetOperationsConfig,
	type OperatorPrincipal,
} from "./types.js";

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

export interface FleetOperationsOptions {
	config: FleetOperationsConfig;
	/** Workspace ids this router serves, in the order they should be reported. */
	workspaceIds: string[];
	/** Display names, keyed by workspace id. Omitted ids simply carry no name. */
	workspaceNames?: Record<string, string>;
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
	private readonly now: () => number;

	constructor(options: FleetOperationsOptions) {
		this.config = options.config;
		this.workspaceIds = [...options.workspaceIds];
		this.workspaceNames = options.workspaceNames ?? {};
		this.now = options.now ?? (() => Date.now());
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
	 * The intersection of what this router serves and what this principal's
	 * roles permit — in the router's declared order, so the document is stable
	 * across requests.
	 */
	private capabilitiesFor(
		principal: OperatorPrincipal,
	): OperatorCapabilityV1[] {
		return (this.config.capabilities ?? []).filter((capability) =>
			principal.roles.has(ROLE_BY_CAPABILITY[capability]),
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
