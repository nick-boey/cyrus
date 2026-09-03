import type {
	LogSourceDescriptorV1,
	OperatorAuthMethodV1,
	OperatorCapabilityV1,
	OperatorRoleV1,
	OperatorSkillCompatibilityV1,
} from "cyrus-operator-protocol";

/**
 * Router-side configuration and internal types for the Fleet Operations
 * authentication boundary.
 *
 * The WIRE shapes live in `cyrus-operator-protocol` and are imported, never
 * redeclared: a second definition of a response document is how a router and a
 * CLI drift apart without either side failing to compile.
 */

/**
 * One authorization rule: a set of Entra principals, the roles they hold, and
 * the workspaces those roles apply to.
 *
 * `principalIds` are IMMUTABLE Entra identifiers — a user's object id (`oid`)
 * or a group's object id — never an email or a UPN. Both are mutable in Entra
 * and reassignable, so keying a grant on one means a renamed or recycled
 * account silently inherits somebody else's fleet authority.
 *
 * Grants are ADDITIVE. A caller matching several grants (typically their own
 * `oid` plus one or more group ids) holds the union of their roles and the
 * union of their workspaces.
 */
export interface OperatorGrant {
	principalIds: string[];
	roles: OperatorRoleV1[];
	workspaceIds: string[];
}

/**
 * How a router decides what an authenticated operator may do.
 *
 * Absent entirely (the default), Entra operator access is off: a JWT is
 * refused, and the only credentials that authenticate are the device tokens and
 * locally minted operator tokens the router always accepts. Nothing about
 * `/enroll`, `/workspaces`, or `/runs` changes either way.
 */
export interface OperatorAccessConfig {
	entra?: {
		/** Directory tenant. Re-checked as the `tid` claim on every request. */
		tenantId: string;
		/**
		 * The `api://` Application ID URI operator ACCESS tokens are minted for.
		 * Not the bare client-id GUID, which is an ID token's audience — see
		 * `createSetupIdTokenVerifier` on why the two verifiers stay separate.
		 */
		audience: string;
		grants: OperatorGrant[];
	};
}

/**
 * Everything the two Fleet Operations documents are built from.
 *
 * `logSource` and `skill` live here rather than on {@link OperatorAccessConfig}
 * because they are not authorization inputs — they are payload the context
 * route discloses to a caller who has already been authorized, and neither may
 * ever appear on the anonymous discovery document.
 */
export interface FleetOperationsConfig {
	/**
	 * Stable identity a client records so it can tell two routers apart.
	 * Defaults to {@link DEFAULT_ROUTER_ID}; set it explicitly on any deployment
	 * running more than one router.
	 */
	routerId?: string;
	routerName?: string;
	access?: OperatorAccessConfig;
	/**
	 * Where an authorized operator's client queries logs. Disclosed ONLY on the
	 * authenticated context route, and only to a principal whose capabilities
	 * include `logs.query` — the descriptor names a real Log Analytics
	 * workspace, which is an identifier worth withholding from an anonymous
	 * caller even though it is not a credential.
	 */
	logSource?: LogSourceDescriptorV1;
	/**
	 * Which operator skill this router expects to work with. Advertising is not
	 * trust: the CLI verifies the release against its own trusted source and the
	 * published checksum, and never installs instructions merely because a
	 * router named a URL.
	 */
	skill?: OperatorSkillCompatibilityV1;
	/**
	 * What this router ACTUALLY serves, at route granularity.
	 *
	 * Supplied by the composition root from the routes it registered, rather
	 * than derived from roles, so the context document cannot advertise a
	 * capability that has no route behind it. A client gates an optional command
	 * on this, so a lie here presents to an orchestrating agent as a fleet
	 * problem rather than as a router that is simply older than its CLI.
	 */
	capabilities?: OperatorCapabilityV1[];
}

/** Fallback {@link FleetOperationsConfig.routerId}. */
export const DEFAULT_ROUTER_ID = "cyrus-router";

/**
 * Which credential a principal presented. Maps 1:1 onto the wire's
 * {@link OperatorAuthMethodV1} via {@link AUTH_METHOD_BY_KIND}.
 *
 * `"device"` is here — rather than the `"entra" | "local"` pair operator
 * credentials come in — because a device token is a THIRD, pre-existing
 * credential that the operator API accepts without broadening: the wire enum
 * has always had three members, `authMethod` is a required field on the context
 * document, and the authorizer is the only code allowed to decide which one a
 * caller is. A principal that could not say which credential produced it would
 * force that decision somewhere else.
 */
export type OperatorAuthKind = "entra" | "local" | "device";

export const AUTH_METHOD_BY_KIND: Record<
	OperatorAuthKind,
	OperatorAuthMethodV1
> = {
	entra: "entra",
	local: "local-operator-token",
	device: "device-token",
};

/**
 * An authenticated caller and the authority it holds — the ONLY thing
 * downstream fleet-operations code is allowed to make an authorization decision
 * from. It is produced exclusively by `OperatorAuthorizer`.
 */
export interface OperatorPrincipal {
	/**
	 * Immutable identity authorization was keyed on: an Entra `oid`, or a
	 * synthetic `local-token:<id>` / `device:<id>` for the router's own
	 * credentials. Never an email — see {@link OperatorGrant.principalIds}.
	 */
	id: string;
	authKind: OperatorAuthKind;
	roles: Set<OperatorRoleV1>;
	/** Already narrowed to workspaces this router actually serves. */
	workspaceIds: Set<string>;
	displayName?: string;
	/**
	 * Set ONLY for a `"device"` principal, and it is what keeps that credential
	 * from being broadened: a device token's authority has always been its
	 * owner's own work, so the principal it produces carries the owner id that
	 * every downstream read must additionally filter by. An Entra or local
	 * operator principal is scoped by workspace and leaves this undefined —
	 * which is why downstream code must treat "absent" as "not owner-scoped"
	 * rather than as "no owner".
	 */
	ownerUserId?: number;
}
