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
		this.validateConfig();
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
