import type { ILogger } from "cyrus-core";
import type { OperatorRoleV1 } from "cyrus-operator-protocol";
import { OPERATOR_TOKEN_PREFIX, type RouterStore } from "../RouterStore.js";
import type { OperatorAccessConfig, OperatorPrincipal } from "./types.js";

/**
 * Verifies an Entra ACCESS token's signature, issuer, and audience and returns
 * its claims. A third verifier alongside enrollment's and `/setup`'s, and for
 * the same reason those two are separate from each other (D2′): each pins a
 * different audience and needs a different projection of the payload. This one
 * needs the WHOLE payload, because authorization keys on `oid` and `groups`.
 *
 * The claims it returns are re-checked by {@link OperatorAuthorizer} rather
 * than trusted. That is not redundancy: `jose` accepts an ARRAY `aud`
 * containing the expected value, which would admit a token minted for several
 * APIs in the tenant, and a verifier swapped in by a test or a future
 * deployment must not be able to weaken the tenant/audience gate by omission.
 */
export type EntraOperatorTokenVerifier = (
	token: string,
) => Promise<Record<string, unknown>>;

/**
 * Tolerance applied to `exp` and `nbf`, so a router and an identity provider a
 * few seconds apart do not reject valid tokens.
 */
const CLOCK_SKEW_MS = 60_000;

/**
 * Lazily loads jose and caches the tenant's remote JWKS verifier, mirroring
 * `createEntraTokenVerifier` in `enrollment.ts`.
 *
 * It returns the raw payload and asserts nothing about `tid`, `aud`, `oid`, or
 * grants — {@link OperatorAuthorizer} owns all of that. Both issuer forms are
 * accepted because which one Entra mints depends on the app registration's
 * `accessTokenAcceptedVersion` and is not ours to assume.
 */
export function createEntraOperatorTokenVerifier(
	config: { tenantId: string; audience: string },
	jwksUrl = `https://login.microsoftonline.com/${encodeURIComponent(config.tenantId)}/discovery/v2.0/keys`,
	jwksOptions?: { cooldownDuration?: number },
): EntraOperatorTokenVerifier {
	let verifierPromise: Promise<EntraOperatorTokenVerifier> | undefined;

	return async (token: string): Promise<Record<string, unknown>> => {
		verifierPromise ??= import("jose").then(
			({ createRemoteJWKSet, jwtVerify }) => {
				const jwks = createRemoteJWKSet(new URL(jwksUrl), jwksOptions);
				return async (jwt: string) => {
					const { payload } = await jwtVerify(jwt, jwks, {
						audience: config.audience,
						issuer: [
							`https://sts.windows.net/${config.tenantId}/`,
							`https://login.microsoftonline.com/${config.tenantId}/v2.0`,
						],
					});
					return payload as Record<string, unknown>;
				};
			},
		);
		return (await verifierPromise)(token);
	};
}

/**
 * Why a caller was refused. `status` is the HTTP status the route sends; the
 * message is for the router's own logs and never reaches the response body,
 * which says only "unauthorized"/"forbidden" — a 403 that explained itself
 * would tell an anonymous prober which workspaces exist and which principals
 * hold grants over them.
 */
export class OperatorAuthError extends Error {
	constructor(
		readonly status: 401 | 403,
		message: string,
	) {
		super(message);
		this.name = "OperatorAuthError";
	}
}

export interface OperatorAuthorizerOptions {
	store: RouterStore;
	/** Workspace ids this router actually serves. Every grant is narrowed to it. */
	workspaceIds: string[];
	access?: OperatorAccessConfig;
	/**
	 * Required for Entra callers. Injected rather than constructed here so tests
	 * can drive real claim-shape decisions without a remote JWKS, mirroring
	 * `RouterServerConfig.entraTokenVerifier`.
	 */
	verifyEntraToken?: EntraOperatorTokenVerifier;
	now?: () => number;
	logger?: ILogger;
}

/**
 * The ONLY code that turns a credential into an {@link OperatorPrincipal}.
 *
 * Three credential kinds reach the operator API and each carries a different
 * authority; centralising the translation is what makes "a container token
 * gains no recovery authority" a property of the system rather than a rule each
 * route has to remember. Nothing downstream may re-derive authority from a
 * token, a header, or a device row.
 *
 * The kinds are told apart by SHAPE, not by trying each store in turn: an
 * operator token carries {@link OPERATOR_TOKEN_PREFIX}, an Entra token is a
 * three-segment JWT, and anything else is a device token. Probing in sequence
 * would make a revoked operator token fall through to the device lookup and be
 * reported as an unknown device — the same 401, arrived at for the wrong
 * reason, and one that would quietly start succeeding if the two token formats
 * ever converged.
 */
export class OperatorAuthorizer {
	private readonly store: RouterStore;
	private readonly access: OperatorAccessConfig | undefined;
	private readonly servedWorkspaceIds: Set<string>;
	private readonly orderedWorkspaceIds: string[];
	private readonly verifyEntraToken: EntraOperatorTokenVerifier | undefined;
	private readonly now: () => number;
	private readonly logger: ILogger | undefined;

	constructor(options: OperatorAuthorizerOptions) {
		this.store = options.store;
		this.access = options.access;
		this.orderedWorkspaceIds = [...options.workspaceIds];
		this.servedWorkspaceIds = new Set(options.workspaceIds);
		this.verifyEntraToken = options.verifyEntraToken;
		this.now = options.now ?? (() => Date.now());
		this.logger = options.logger;
	}

	/**
	 * Authenticates and authorizes one request, or throws
	 * {@link OperatorAuthError}.
	 *
	 * Runs on EVERY operator request rather than at a session boundary: an Entra
	 * grant can be withdrawn, a group membership can change, and an operator
	 * token can be revoked, and none of those produce a signal the router could
	 * act on later.
	 */
	async authenticate(
		authorizationHeader: string | undefined,
	): Promise<OperatorPrincipal> {
		const token = parseBearerToken(authorizationHeader);
		if (!token) {
			throw new OperatorAuthError(401, "missing or malformed bearer token");
		}
		if (token.startsWith(OPERATOR_TOKEN_PREFIX)) {
			return this.authenticateLocalToken(token);
		}
		if (looksLikeJwt(token)) {
			return this.authenticateEntra(token);
		}
		return this.authenticateDevice(token);
	}

	/**
	 * A direct Entra token: tenant, audience, and role are all checked before
	 * any workspace mapping happens, so a token from the wrong tenant is never
	 * measured against this router's grant table at all.
	 */
	private async authenticateEntra(token: string): Promise<OperatorPrincipal> {
		const entra = this.access?.entra;
		if (!entra || !this.verifyEntraToken) {
			throw new OperatorAuthError(
				401,
				"Entra operator access is not configured on this router",
			);
		}

		let claims: Record<string, unknown>;
		try {
			claims = await this.verifyEntraToken(token);
		} catch (error) {
			this.logger?.debug(
				`Operator Entra token failed verification: ${String(error)}`,
			);
			throw new OperatorAuthError(401, "invalid Entra token");
		}

		if (claims.tid !== entra.tenantId) {
			throw new OperatorAuthError(
				401,
				"token tenant does not match the router's configured tenant",
			);
		}
		// Both issuer forms, matching `enrollment.ts` and `idTokenVerifier.ts`:
		// which one Entra mints depends on the app registration's
		// `accessTokenAcceptedVersion` and is not ours to assume.
		if (!issuersFor(entra.tenantId).includes(String(claims.iss))) {
			throw new OperatorAuthError(
				401,
				"token issuer is not this router's tenant",
			);
		}
		// Exact string equality, deliberately refusing an array: `jose` treats an
		// `aud` array containing the expected value as a match, which would admit
		// a token the caller obtained for a different API in the same tenant.
		if (claims.aud !== entra.audience) {
			throw new OperatorAuthError(
				401,
				"token audience does not exactly match the router audience",
			);
		}
		// Temporal validity is re-checked for the same reason tenant and audience
		// are: the stated threat model is that a verifier swapped in by a test or
		// a future deployment must not be able to weaken the gate by OMISSION,
		// and "the default verifier happens to call `jose.jwtVerify`" is exactly
		// the trust this class declines to extend. `exp` is REQUIRED — a bearer
		// credential with no expiry is not one this router will hold.
		this.requireTemporalValidity(claims);
		const objectId = typeof claims.oid === "string" ? claims.oid : undefined;
		if (!objectId) {
			throw new OperatorAuthError(401, "token carries no `oid` claim");
		}
		// An app-only token proves no human is behind the request. It matters
		// because group membership is administered by a different role than fleet
		// authority, so a service principal dropped into a group holding a
		// `fleet.recover` grant would silently inherit it. This covers the claim
		// Entra documents for the case; it is not a complete app-only detector,
		// so a group granted `fleet.recover` should still contain only users.
		if (claims.idtyp === "app") {
			throw new OperatorAuthError(
				403,
				"app-only tokens hold no fleet-operations authority",
			);
		}

		// The caller's own object id plus every group it is a member of. Emails
		// and UPNs are deliberately not candidates: both are mutable in Entra, so
		// a grant keyed on one would follow a renamed or recycled account.
		const candidates = new Set<string>([objectId]);
		for (const group of stringArray(claims.groups)) candidates.add(group);
		this.warnOnGroupsOverage(claims, objectId);

		const roles = new Set<OperatorRoleV1>();
		const workspaceIds = new Set<string>();
		for (const grant of entra.grants) {
			if (!grant.principalIds.some((id) => candidates.has(id))) continue;
			for (const role of grant.roles) roles.add(role);
			for (const workspaceId of grant.workspaceIds) {
				if (this.servedWorkspaceIds.has(workspaceId)) {
					workspaceIds.add(workspaceId);
				}
			}
		}
		this.requireGrant(roles, workspaceIds, objectId);

		const displayName =
			typeof claims.name === "string" && claims.name.length > 0
				? claims.name
				: undefined;
		return {
			id: objectId,
			authKind: "entra",
			roles,
			workspaceIds,
			...(displayName ? { displayName } : {}),
		};
	}

	/** A locally minted, hash-stored operator credential. */
	private authenticateLocalToken(token: string): OperatorPrincipal {
		// Resolves to `undefined` for a revoked row as well as an unknown one,
		// and both are the same 401: telling them apart would confirm to a holder
		// of a stolen token that it was once valid.
		const grant = this.store.getOperatorTokenByToken(token);
		if (!grant) {
			throw new OperatorAuthError(401, "unknown or revoked operator token");
		}
		const roles = new Set(grant.roles);
		const workspaceIds = new Set(
			grant.workspaceIds.filter((id) => this.servedWorkspaceIds.has(id)),
		);
		this.requireGrant(roles, workspaceIds, `local-token:${grant.tokenId}`);
		return {
			id: `local-token:${grant.tokenId}`,
			authKind: "local",
			roles,
			workspaceIds,
			displayName: grant.label,
		};
	}

	/**
	 * An existing device token, at exactly the authority it already had.
	 *
	 * Read only, never recovery, and carrying `ownerUserId` so every downstream
	 * read stays scoped to that user's own work — which is enforced by
	 * `FleetOperations` withholding every capability whose scope the router
	 * cannot narrow, not merely recorded here.
	 *
	 * An ALLOW-LIST on `kind`, not a deny-list on `"container"`. `devices.kind`
	 * is a bare `TEXT` column with no `CHECK`, read back through an unchecked
	 * `as "device" | "container"` cast, so a third value — a future device kind,
	 * a hand-edited row — would slip past `kind === "container"` and be granted
	 * a physical device's authority by default. The default has to be denial.
	 */
	private authenticateDevice(token: string): OperatorPrincipal {
		const device = this.store.getDeviceByToken(token);
		if (!device) {
			throw new OperatorAuthError(401, "unknown device token");
		}
		const info = this.store.getDeviceInfo(device.deviceId);
		if (!info) {
			throw new OperatorAuthError(401, "unknown device token");
		}
		if (info.kind !== "device") {
			throw new OperatorAuthError(
				403,
				`"${info.kind}" device tokens hold no fleet-operations authority`,
			);
		}
		const workspaceIds = new Set(this.orderedWorkspaceIds);
		if (workspaceIds.size === 0) {
			throw new OperatorAuthError(403, "this router serves no workspaces");
		}
		const email = this.store.getUserEmail(device.userId);
		return {
			id: `device:${device.deviceId}`,
			authKind: "device",
			roles: new Set<OperatorRoleV1>(["fleet.read"]),
			workspaceIds,
			ownerUserId: device.userId,
			...(email ? { displayName: email } : {}),
		};
	}

	/**
	 * `exp` must be present and in the future; `nbf`, if present, must have
	 * passed. {@link CLOCK_SKEW_MS} is allowed in both directions so a router and
	 * an identity provider a few seconds apart do not reject valid tokens.
	 */
	private requireTemporalValidity(claims: Record<string, unknown>): void {
		const nowSeconds = this.now() / 1000;
		const skewSeconds = CLOCK_SKEW_MS / 1000;
		const exp = typeof claims.exp === "number" ? claims.exp : undefined;
		if (exp === undefined) {
			throw new OperatorAuthError(401, "token carries no `exp` claim");
		}
		if (nowSeconds - skewSeconds >= exp) {
			throw new OperatorAuthError(401, "token has expired");
		}
		const nbf = typeof claims.nbf === "number" ? claims.nbf : undefined;
		if (nbf !== undefined && nowSeconds + skewSeconds < nbf) {
			throw new OperatorAuthError(401, "token is not yet valid");
		}
	}

	/**
	 * Above roughly 200 groups Entra emits `_claim_names`/`_claim_sources`
	 * pointing at the Graph API INSTEAD of a `groups` array, and the router does
	 * not call Graph. That fails closed — the caller simply matches no
	 * group-keyed grant — but it fails closed for precisely the senior operator a
	 * `fleet.recover` group grant exists for, and presents as an unexplained 403.
	 * Warn rather than debug: this is a misconfiguration an operator has to act
	 * on, and a `debug` line in a sandbox worker never leaves the container.
	 */
	private warnOnGroupsOverage(
		claims: Record<string, unknown>,
		objectId: string,
	): void {
		const claimNames = claims._claim_names;
		if (
			claims.groups === undefined &&
			claimNames !== null &&
			typeof claimNames === "object" &&
			"groups" in (claimNames as Record<string, unknown>)
		) {
			this.logger?.warn(
				`Entra returned a groups OVERAGE for principal ${objectId}: the token names a Graph endpoint instead of listing group ids, so every group-keyed grant will fail to match and the caller will see a 403. Grant this principal directly by object id, or configure the app registration to emit app roles instead of group ids.`,
			);
		}
	}

	/**
	 * A verified identity with no role, or with roles over no workspace this
	 * router serves, is authenticated but authorized over nothing. Both are 403:
	 * the credential was accepted, the authority was not there.
	 */
	private requireGrant(
		roles: Set<OperatorRoleV1>,
		workspaceIds: Set<string>,
		principalId: string,
	): void {
		if (roles.size === 0) {
			this.logger?.debug(
				`Operator principal ${principalId} holds no fleet-operations role`,
			);
			throw new OperatorAuthError(403, "no fleet-operations role granted");
		}
		if (workspaceIds.size === 0) {
			this.logger?.debug(
				`Operator principal ${principalId} holds no grant over a workspace this router serves`,
			);
			throw new OperatorAuthError(
				403,
				"no grant over a workspace this router serves",
			);
		}
	}
}

function parseBearerToken(header: string | undefined): string | undefined {
	const match = header?.match(/^Bearer ([^\s]+)$/);
	return match?.[1];
}

/**
 * Three non-empty dot-separated segments — enough to route a credential to the
 * Entra path, where it is then actually verified. This is a routing decision,
 * never a trust decision.
 */
function looksLikeJwt(token: string): boolean {
	const segments = token.split(".");
	return segments.length === 3 && segments.every((part) => part.length > 0);
}

function stringArray(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string");
}

/** The two issuer forms Entra mints, depending on `accessTokenAcceptedVersion`. */
function issuersFor(tenantId: string): string[] {
	return [
		`https://sts.windows.net/${tenantId}/`,
		`https://login.microsoftonline.com/${tenantId}/v2.0`,
	];
}
