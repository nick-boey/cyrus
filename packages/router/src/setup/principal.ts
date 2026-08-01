/**
 * Authentication for the `/setup*` management UI.
 *
 * Per D1′ on NOR-265, how identity is established is an **explicit operator
 * choice**, never inferred from ingress topology and never from the presence of
 * `RouterServerConfig.entra` (which configures enrollment bearer-token
 * validation for `/enroll` and says nothing about what sits in front of us).
 * The router binds `0.0.0.0` under Docker, so a deployment that enabled the UI
 * without an auth sidecar would otherwise accept an arbitrary
 * `X-MS-CLIENT-PRINCIPAL-NAME` from anyone on the network.
 *
 * Three strategies, each with a stated trust basis:
 *
 * - `easyauth-headers` — trust the ACA built-in auth (EasyAuth) sidecar's
 *   injected identity headers. Only sound behind an ACA ingress with
 *   `authConfigs` installed *and* the header-strip property verified live.
 * - `entra-token` — cryptographically verify the ID token the sidecar forwards
 *   in `X-MS-TOKEN-AAD-ID-TOKEN`. Independent of ingress topology, so this is
 *   the preferred production mode.
 * - `dev-insecure-headers` — local development only; reads headers with no
 *   verification and refuses to start off loopback.
 *
 * In `entra-token` mode {@link parseEasyAuthPrincipal} is unreachable: a forged
 * `X-MS-CLIENT-PRINCIPAL-NAME` has no effect whatsoever on the outcome.
 */

/** Claim types that carry an email, most-preferred first. */
const EMAIL_CLAIMS = [
	"preferred_username",
	"upn",
	"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
	"email",
	"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
] as const;

const NAME_CLAIMS = [
	"name",
	"http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
] as const;

/**
 * The Entra object id. Persisted (not merely logged) so the eventual re-key
 * from email to `(tenantId, oid)` — NOR-274 — has the data it needs.
 */
const OBJECT_ID_CLAIMS = [
	"oid",
	"http://schemas.microsoft.com/identity/claims/objectidentifier",
] as const;

/** Header the ACA token store populates with the raw Entra ID token. */
export const SETUP_ID_TOKEN_HEADER = "x-ms-token-aad-id-token";

/**
 * Bind hosts on which `dev-insecure-headers` is tolerable. Deliberately an
 * exact allowlist: `0.0.0.0` and `::` are wildcard binds, not loopback.
 */
const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export interface SetupPrincipal {
	/** Always lowercased. */
	email: string;
	name?: string;
	/** Entra `oid`. */
	objectId?: string;
}

export type SetupAuthMode =
	| {
			/**
			 * Trust the EasyAuth sidecar's injected identity headers. Refuses to
			 * start unless `verifiedHeaderStrip: true`, which an operator sets by
			 * hand only after verifying live that the ingress strips
			 * client-supplied copies of those headers.
			 */
			mode: "easyauth-headers";
			verifiedHeaderStrip: true;
	  }
	| {
			/**
			 * Verify the forwarded ID token. Requires the ACA token store.
			 *
			 * NOTE: this audience differs from `entra.audience` used for
			 * enrollment. `createEntraTokenVerifier` compares `aud` by exact
			 * equality against the Application ID URI (`api://<client-id>`) that
			 * **access** tokens carry; an EasyAuth **ID** token carries the bare
			 * client-id GUID. A second verifier instance must therefore be
			 * constructed with `idTokenAudience` — see D2′ on NOR-265. Issuer
			 * handling (v1 `sts.windows.net/{tid}/` and v2
			 * `login.microsoftonline.com/{tid}/v2.0`) is reused unchanged.
			 */
			mode: "entra-token";
			/** Bare client-id GUID. NOT the `api://` audience. */
			idTokenAudience: string;
	  }
	| {
			/** Local development only. Startup throws off loopback. */
			mode: "dev-insecure-headers";
	  };

export interface SetupAuthConfig {
	auth: SetupAuthMode;
	/** Email domain allowlist, applied in every mode. */
	allowedDomain?: string;
}

/** The `setupUi` block of the router config, as an operator writes it. */
export interface SetupUiConfig {
	/** Default false. Omitting the block registers no `/setup` routes. */
	enabled: boolean;
	/** REQUIRED when enabled. No default — the operator must state a strategy. */
	auth?: SetupAuthMode;
	/**
	 * Email domain allowlist. The practical membership control for most
	 * deployments, and cheaper than an Entra assignment policy: it keeps guest
	 * and cross-tenant accounts out even when {@link autoProvisionUsers} is on.
	 */
	allowedDomain?: string;
	/**
	 * Whether a successful first sign-in creates the router user. Default
	 * **true**, the intended posture for a single-organisation deployment.
	 *
	 * What it actually grants is narrow: a user row and an EMPTY secret record.
	 * No credentials — the user supplies their own Claude token — and nothing
	 * routes to them until they appear as the creator or assignee of a Linear
	 * issue, so Linear membership is the effective gate on doing anything.
	 *
	 * Set it false where the Entra tenant is materially larger than the set of
	 * people who should hold Cyrus credentials, and pair it with an Entra group
	 * assignment or an `allowedPrincipals` policy — the flag alone restricts
	 * nothing that sign-in has already permitted.
	 */
	autoProvisionUsers?: boolean;
}

/** An authentication/authorization failure with the status a route should send. */
export class SetupAuthError extends Error {
	constructor(
		readonly status: 401 | 403,
		message: string,
	) {
		super(message);
		this.name = "SetupAuthError";
	}
}

/**
 * Verifies a forwarded Entra ID token and returns the identity it asserts.
 * Injected rather than constructed here so this module stays free of `jose`,
 * network access, and Azure specifics — and so tests need none of them.
 */
export type SetupIdTokenVerifier = (token: string) => Promise<SetupPrincipal>;

export interface SetupPrincipalDeps {
	verifyIdToken?: SetupIdTokenVerifier;
}

/**
 * Incoming request headers. Node lowercases every received header name, so
 * lookups here are lowercase-only.
 */
type HeaderBag = Record<string, string | string[] | undefined>;

interface Claim {
	typ: string;
	val: string;
}

/**
 * A duplicated header arrives as an array. That is never something the sidecar
 * produces, so treat it as hostile input and read nothing rather than guessing
 * which copy is authentic.
 */
function single(headers: HeaderBag, name: string): string | undefined {
	const value = headers[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Decodes the base64 `X-MS-CLIENT-PRINCIPAL` blob. Every malformed shape —
 * bad base64, bad JSON, a non-object, a missing or non-array `claims`, and
 * non-object entries within it — degrades to "no claims" rather than throwing.
 */
function decodeClaims(blob: string): Claim[] {
	let parsed: unknown;
	try {
		parsed = JSON.parse(Buffer.from(blob, "base64").toString("utf-8"));
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null) return [];
	const raw = (parsed as { claims?: unknown }).claims;
	if (!Array.isArray(raw)) return [];
	const claims: Claim[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const { typ, val } = entry as { typ?: unknown; val?: unknown };
		if (typeof typ === "string" && typeof val === "string" && val.length > 0) {
			claims.push({ typ, val });
		}
	}
	return claims;
}

function firstClaim(
	claims: readonly Claim[],
	types: readonly string[],
): string | undefined {
	for (const type of types) {
		const hit = claims.find((claim) => claim.typ === type);
		if (hit) return hit.val;
	}
	return undefined;
}

/**
 * Reads the identity the ACA built-in auth sidecar injected as request headers.
 *
 * These headers are trustworthy **only** because the sidecar strips any
 * client-supplied copy before forwarding. Never call this on a deployment where
 * requests can reach the app without passing through it — which is exactly what
 * {@link validateSetupAuthConfig} and the mode switch in
 * {@link requireSetupPrincipal} exist to enforce.
 */
export function parseEasyAuthPrincipal(
	headers: HeaderBag,
): SetupPrincipal | undefined {
	const blob = single(headers, "x-ms-client-principal");
	const claims = blob ? decodeClaims(blob) : [];

	const email =
		single(headers, "x-ms-client-principal-name") ??
		firstClaim(claims, EMAIL_CLAIMS);
	if (!email) return undefined;

	const name = firstClaim(claims, NAME_CLAIMS);
	const objectId =
		single(headers, "x-ms-client-principal-id") ??
		firstClaim(claims, OBJECT_ID_CLAIMS);
	return {
		email: email.toLowerCase(),
		...(name ? { name } : {}),
		...(objectId ? { objectId } : {}),
	};
}

async function principalFromIdToken(
	headers: HeaderBag,
	auth: Extract<SetupAuthMode, { mode: "entra-token" }>,
	deps: SetupPrincipalDeps,
): Promise<SetupPrincipal | undefined> {
	const verify = deps.verifyIdToken;
	if (!verify) {
		// A wiring bug, not a signed-out user. Throwing a plain Error keeps it
		// out of the 401/403 mapping so it surfaces as a 500 instead of reading
		// to the user as "sign in again".
		throw new Error(
			`setupUi.auth.mode "entra-token" (audience ${auth.idTokenAudience}) requires an injected verifyIdToken`,
		);
	}
	const token = single(headers, SETUP_ID_TOKEN_HEADER);
	if (!token) return undefined;
	try {
		return await verify(token);
	} catch {
		throw new SetupAuthError(401, "invalid Entra ID token");
	}
}

/**
 * Resolves the signed-in principal for a `/setup*` request under the configured
 * strategy, or throws a {@link SetupAuthError} carrying the status to send.
 *
 * Never returns a principal that fails the domain gate, and never returns one
 * derived from identity headers unless the configured mode is a header mode.
 */
export async function requireSetupPrincipal(
	headers: HeaderBag,
	config: SetupAuthConfig,
	deps: SetupPrincipalDeps = {},
): Promise<SetupPrincipal> {
	const auth = config.auth as SetupAuthMode | undefined;
	// Captured before the switch narrows `auth` away, purely for the message.
	const declaredMode: unknown = (auth as { mode?: unknown } | undefined)?.mode;
	let principal: SetupPrincipal | undefined;
	switch (auth?.mode) {
		case "entra-token":
			principal = await principalFromIdToken(headers, auth, deps);
			break;
		case "easyauth-headers":
		case "dev-insecure-headers":
			principal = parseEasyAuthPrincipal(headers);
			break;
		default:
			// Fail closed: an unset or unrecognised mode is a configuration error,
			// never an invitation to fall back to reading headers.
			throw new Error(
				`setupUi.auth.mode ${JSON.stringify(declaredMode)} is not a supported setup authentication strategy`,
			);
	}

	if (!principal) throw new SetupAuthError(401, "not signed in");

	const email =
		typeof principal.email === "string"
			? principal.email.trim().toLowerCase()
			: "";
	if (!email) {
		throw new SetupAuthError(401, "signed-in identity carries no email");
	}

	const allowedDomain = config.allowedDomain?.trim().toLowerCase();
	if (allowedDomain) {
		// Compare the last @-segment exactly: a suffix match would accept
		// `alice@evil-example.com` for `example.com`, and taking the first
		// segment would accept `alice@example.com@evil.test`.
		const domain = email.split("@").pop();
		if (domain !== allowedDomain) {
			throw new SetupAuthError(403, "account domain is not allowed");
		}
	}

	return { ...principal, email };
}

function isLoopbackBindHost(bindHost: string): boolean {
	const host = String(bindHost ?? "")
		.trim()
		.toLowerCase()
		.replace(/^\[/, "")
		.replace(/\]$/, "");
	return LOOPBACK_BIND_HOSTS.has(host);
}

/**
 * Validates the setup authentication strategy at construction time, so an
 * ambiguous or unsafe configuration refuses to start rather than serving
 * `/setup` with no enforceable trust boundary.
 *
 * A disabled setup UI is not policed: no routes are registered, so no strategy
 * is in force.
 */
export function validateSetupAuthConfig(
	config: SetupUiConfig,
	env: { bindHost: string },
): void {
	if (!config.enabled) return;

	const auth = config.auth;
	if (!auth) {
		throw new Error(
			'setupUi.enabled is true but setupUi.auth is not set. Choose an explicit strategy: { "mode": "entra-token", "idTokenAudience": "<client-id GUID>" } (recommended), { "mode": "easyauth-headers", "verifiedHeaderStrip": true }, or { "mode": "dev-insecure-headers" } for local development.',
		);
	}

	switch (auth.mode) {
		case "easyauth-headers":
			if (auth.verifiedHeaderStrip !== true) {
				throw new Error(
					'setupUi.auth.mode "easyauth-headers" trusts identity headers injected by the ACA auth sidecar, so it requires verifiedHeaderStrip: true. Set it by hand only after verifying live that the ingress strips client-supplied X-MS-CLIENT-PRINCIPAL* headers.',
				);
			}
			return;
		case "entra-token": {
			const audience = auth.idTokenAudience?.trim();
			if (!audience) {
				throw new Error(
					'setupUi.auth.mode "entra-token" requires idTokenAudience: the bare client-id GUID of the router app registration.',
				);
			}
			if (audience.toLowerCase().startsWith("api://")) {
				throw new Error(
					`setupUi.auth.idTokenAudience must be the bare client-id GUID, not the "api://" Application ID URI (${audience}). That URI is the audience of enrollment *access* tokens; an EasyAuth *ID* token carries the bare client id.`,
				);
			}
			return;
		}
		case "dev-insecure-headers":
			if (!isLoopbackBindHost(env.bindHost)) {
				throw new Error(
					`setupUi.auth.mode "dev-insecure-headers" reads identity headers with no verification and is only permitted on a loopback bind host (127.0.0.1, ::1, localhost). The router is bound to ${JSON.stringify(env.bindHost)}.`,
				);
			}
			return;
		default: {
			const mode = (auth as { mode?: unknown }).mode;
			throw new Error(
				`setupUi.auth.mode ${JSON.stringify(mode)} is not a supported setup authentication strategy. Expected "easyauth-headers", "entra-token", or "dev-insecure-headers".`,
			);
		}
	}
}
