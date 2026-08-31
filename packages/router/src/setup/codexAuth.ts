/**
 * Codex ChatGPT-subscription credentials: the shape of the `auth.json` a user
 * pastes into `/setup`, the validation that rejects a bad paste *there* rather
 * than hours later inside a dead session, and the refresh call the router makes
 * as the sole holder of that credential.
 *
 * See `docs/adr/0005-codex-authenticates-by-router-held-subscription-tokens.md`
 * for why the router refreshes rather than the container. In short: Codex
 * refreshes when its access token is within five minutes of `exp`, and every
 * refresh rotates the refresh token held by every other copy of the file — so
 * one user with three live issues is three copies of one credential racing each
 * other. Making the router the only refresher dissolves the race instead of
 * mitigating it.
 *
 * Pure module: no I/O beyond the injected `fetch`. Storage lives in
 * {@link ../CodexTokenStore}, delivery in `ContainerTargets.buildEnv`.
 */

/**
 * The env var the router injects a freshly-minted credential as.
 * `ContainerBootCommand` writes it to `$CODEX_HOME/auth.json` at 0600 before
 * `launch()`. Reserved (see `RESERVED_ENV_KEYS`).
 */
export const CODEX_AUTH_JSON_ENV = "CODEX_AUTH_JSON";

/**
 * The Codex CLI's public OAuth client, which is what a `codex login
 * --device-auth` refresh token is bound to — a refresh token can only be
 * redeemed by the client it was issued to, so the router has to present the
 * same one.
 *
 * Using it from a process that is not the Codex CLI is unofficial, and ADR 0005
 * records that as an accepted risk: OpenAI already gates device-code auth per
 * workspace and could gate this too. It is overridable through
 * `containers.codex.clientId` so a deployment can react to a change without
 * waiting for a release, and `OPENAI_API_KEY` stays supported as the fallback.
 */
export const DEFAULT_CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

/** Where a refresh is redeemed. `auth.openai.com` carries refresh and revocation. */
export const CODEX_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";

/**
 * How long before `exp` a stored access token is treated as spent.
 *
 * Five minutes, matching `GitHubAppTokenProvider`, the ACA `tokenProvider`, and
 * the Linear OAuth refresh — and matching Codex's own window, so a container
 * handed a token at boot never reaches its refresh point during a normal
 * session and therefore never refreshes on its own.
 */
export const CODEX_REFRESH_BUFFER_MS = 5 * 60_000;

/** Ceiling on a pasted `auth.json`. Real ones are a few KiB of JWTs. */
export const MAX_CODEX_AUTH_BYTES = 16 * 1024;

/** The subset of Codex's `auth.json` the router reads and reproduces. */
export interface CodexAuthTokens {
	access_token: string;
	refresh_token: string;
	id_token?: string;
	account_id?: string;
}

export interface CodexAuthFile {
	/** Present and null on a subscription login; a string in API-key mode. */
	OPENAI_API_KEY?: string | null;
	tokens: CodexAuthTokens;
	last_refresh?: string;
}

/** What the router keeps between boots. Sealed at rest — see CodexTokenStore. */
export interface CodexCredential {
	refreshToken: string;
	accessToken: string;
	idToken?: string;
	accountId?: string;
	/** `exp` of {@link accessToken}, in ms, when it carried a readable one. */
	accessTokenExpiresMs?: number;
	/** When the router last successfully minted or refreshed this credential. */
	updatedMs: number;
	/**
	 * Why the last refresh failed, if it did. Kept so `/setup` can show "needs
	 * attention" with the real reason instead of a bare "connected" that is
	 * about to fail a boot.
	 */
	lastError?: string;
}

export type CodexAccountStatus =
	| "absent"
	| "connected"
	| "expiring"
	| "needs-attention";

export class CodexAuthValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexAuthValidationError";
	}
}

/**
 * Raised when a stored credential cannot be turned into a usable token — a
 * lapsed subscription, a `codex logout` on the user's own machine (which
 * revokes every copy), or OpenAI gating our client.
 *
 * Deliberately distinct from a generic boot error so the caller can name the
 * remedy. It must never be resolved by silently running Claude instead:
 * running a different runner than the user chose erodes trust in the whole
 * picker.
 */
export class CodexRefreshError extends Error {
	constructor(
		message: string,
		readonly remedy: string,
	) {
		super(message);
		this.name = "CodexRefreshError";
	}
}

/**
 * Reads a JWT's `exp` claim without verifying it.
 *
 * Verification would need OpenAI's signing keys and buy nothing: this value is
 * used only to decide *when to refresh our own token*, and the worst a forged
 * `exp` can do is make the router refresh too eagerly or hand out a token the
 * upstream then rejects. Anything unreadable returns `undefined`, which the
 * caller treats as "refresh now".
 */
export function readJwtExpiryMs(token: string): number | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	const payload = parts[1];
	if (!payload) return undefined;
	try {
		const json = Buffer.from(payload, "base64url").toString("utf-8");
		const parsed: unknown = JSON.parse(json);
		if (typeof parsed !== "object" || parsed === null) return undefined;
		const exp = (parsed as { exp?: unknown }).exp;
		if (typeof exp !== "number" || !Number.isFinite(exp)) return undefined;
		return exp * 1000;
	} catch {
		return undefined;
	}
}

/**
 * Validates a pasted `auth.json` and reduces it to a {@link CodexCredential}.
 *
 * Every rejection names what is wrong. That specificity is the whole point of
 * validating at paste time: a malformed paste accepted silently surfaces as a
 * dead Codex session hours later, which is precisely the failure mode the typed
 * picker exists to eliminate.
 *
 * `auth_mode` is checked when the file carries it and derived otherwise. Not
 * every Codex CLI version writes the field, so requiring it outright would
 * reject valid subscription logins; what must be rejected is an *API-key* file,
 * which is what an explicit non-`chatgpt` mode or a missing refresh token
 * indicates.
 */
export function parseCodexAuthPaste(
	raw: string,
	nowMs: number,
): CodexCredential {
	const trimmed = raw.trim();
	if (trimmed === "") {
		throw new CodexAuthValidationError(
			"Paste the contents of your Codex auth.json. Run `codex login --device-auth` on your own machine, then copy `~/.codex/auth.json`.",
		);
	}
	if (Buffer.byteLength(trimmed, "utf-8") > MAX_CODEX_AUTH_BYTES) {
		throw new CodexAuthValidationError(
			`That is larger than ${MAX_CODEX_AUTH_BYTES} bytes, which no real auth.json is. Paste the file's contents, not an archive or a log.`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch (error) {
		throw new CodexAuthValidationError(
			`That is not valid JSON (${(error as Error).message}). Paste the whole file, including the outermost braces.`,
		);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new CodexAuthValidationError(
			"That JSON is not an object. Paste the contents of ~/.codex/auth.json, which is a single JSON object.",
		);
	}

	const file = parsed as Record<string, unknown>;
	const authMode = file.auth_mode;
	if (typeof authMode === "string" && authMode !== "chatgpt") {
		throw new CodexAuthValidationError(
			`That file is in "${authMode}" mode, not "chatgpt" mode. Cyrus runs Codex on your ChatGPT subscription — run \`codex login --device-auth\` and paste the file it writes. To use a metered API key instead, add OPENAI_API_KEY as a variable below.`,
		);
	}

	const tokens = file.tokens;
	if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) {
		throw new CodexAuthValidationError(
			'That file has no "tokens" object. It is probably an API-key auth.json — Cyrus needs a ChatGPT subscription login from `codex login --device-auth`.',
		);
	}
	const { access_token, refresh_token, id_token, account_id } =
		tokens as Record<string, unknown>;

	if (typeof refresh_token !== "string" || refresh_token.trim() === "") {
		throw new CodexAuthValidationError(
			'That file has no "tokens.refresh_token". Without it the router cannot keep your Codex sessions signed in — re-run `codex login --device-auth` and paste the fresh file.',
		);
	}
	if (typeof access_token !== "string" || access_token.trim() === "") {
		throw new CodexAuthValidationError(
			'That file has no "tokens.access_token". Re-run `codex login --device-auth` and paste the fresh file.',
		);
	}

	return {
		refreshToken: refresh_token.trim(),
		accessToken: access_token.trim(),
		...(typeof id_token === "string" && id_token.trim() !== ""
			? { idToken: id_token.trim() }
			: {}),
		...(typeof account_id === "string" && account_id.trim() !== ""
			? { accountId: account_id.trim() }
			: {}),
		...(() => {
			const exp = readJwtExpiryMs(access_token);
			return exp === undefined ? {} : { accessTokenExpiresMs: exp };
		})(),
		updatedMs: nowMs,
	};
}

/** Whether {@link CodexCredential.accessToken} is spent or about to be. */
export function needsRefresh(
	credential: CodexCredential,
	nowMs: number,
	bufferMs = CODEX_REFRESH_BUFFER_MS,
): boolean {
	// An unreadable `exp` means we cannot prove the token is live, and a refresh
	// is cheap next to handing a sandbox a dead credential.
	if (credential.accessTokenExpiresMs === undefined) return true;
	return credential.accessTokenExpiresMs - bufferMs <= nowMs;
}

/**
 * The status row `/setup` renders. Never a password input: this is a
 * connected/expiring/needs-attention indicator, because there is nothing here a
 * user can usefully re-type.
 */
export function codexAccountStatus(
	credential: CodexCredential | undefined,
	nowMs: number,
): CodexAccountStatus {
	if (!credential) return "absent";
	if (credential.lastError) return "needs-attention";
	if (needsRefresh(credential, nowMs)) return "expiring";
	return "connected";
}

/** The file `ContainerBootCommand` writes to `$CODEX_HOME/auth.json`. */
export function renderCodexAuthFile(credential: CodexCredential): string {
	const file: CodexAuthFile & { auth_mode: string } = {
		OPENAI_API_KEY: null,
		auth_mode: "chatgpt",
		tokens: {
			access_token: credential.accessToken,
			refresh_token: credential.refreshToken,
			...(credential.idToken ? { id_token: credential.idToken } : {}),
			...(credential.accountId ? { account_id: credential.accountId } : {}),
		},
		last_refresh: new Date(credential.updatedMs).toISOString(),
	};
	return `${JSON.stringify(file, null, 2)}\n`;
}

export interface CodexRefreshOptions {
	clientId?: string;
	fetchFn?: typeof fetch;
	tokenEndpoint?: string;
	now?: () => number;
}

/**
 * Redeems a refresh token for a fresh access token, returning the rotated
 * credential.
 *
 * The response's `refresh_token` REPLACES the stored one when present: OpenAI
 * rotates on every redemption, so persisting the old one would make the next
 * refresh fail with an error that reads like a revocation.
 */
export async function refreshCodexCredential(
	credential: CodexCredential,
	options: CodexRefreshOptions = {},
): Promise<CodexCredential> {
	const fetchFn = options.fetchFn ?? fetch;
	const now = options.now ?? Date.now;
	const clientId = options.clientId ?? DEFAULT_CODEX_OAUTH_CLIENT_ID;

	let response: Response;
	try {
		response = await fetchFn(options.tokenEndpoint ?? CODEX_TOKEN_ENDPOINT, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_id: clientId,
				grant_type: "refresh_token",
				refresh_token: credential.refreshToken,
				scope: "openid profile email",
			}),
		});
	} catch (error) {
		throw new CodexRefreshError(
			`Could not reach ${CODEX_TOKEN_ENDPOINT}: ${(error as Error).message}`,
			"This is usually transient or an egress-allowlist gap. auth.openai.com must be on the sandbox allowlist; retry the issue.",
		);
	}

	if (!response.ok) {
		const body = (await response.text().catch(() => "")).slice(0, 512);
		// 400/401 from an OAuth token endpoint means the grant is dead, which for
		// a rotating refresh token is nearly always `codex logout` on the user's
		// own machine (it revokes every copy) or a lapsed subscription.
		const dead = response.status === 400 || response.status === 401;
		throw new CodexRefreshError(
			`${CODEX_TOKEN_ENDPOINT} refused the refresh with HTTP ${response.status}${body ? `: ${body}` : ""}`,
			dead
				? "Your Codex credential is no longer valid — a `codex logout` anywhere revokes every copy, and a lapsed ChatGPT subscription has the same effect. Run `codex login --device-auth` again and paste the new auth.json into /setup, or set OPENAI_API_KEY to use metered billing instead."
				: "Retry the issue. If it keeps failing, re-run `codex login --device-auth` and paste the new auth.json into /setup.",
		);
	}

	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new CodexRefreshError(
			`${CODEX_TOKEN_ENDPOINT} returned a body that is not JSON: ${(error as Error).message}`,
			"Retry the issue; if it persists this is an upstream problem.",
		);
	}
	const body = payload as Record<string, unknown>;
	const accessToken = body.access_token;
	if (typeof accessToken !== "string" || accessToken.trim() === "") {
		throw new CodexRefreshError(
			`${CODEX_TOKEN_ENDPOINT} returned no access_token`,
			"Retry the issue; if it persists, re-run `codex login --device-auth` and paste the new auth.json into /setup.",
		);
	}
	const rotated = body.refresh_token;
	const idToken = body.id_token;

	return {
		refreshToken:
			typeof rotated === "string" && rotated.trim() !== ""
				? rotated.trim()
				: credential.refreshToken,
		accessToken: accessToken.trim(),
		...(typeof idToken === "string" && idToken.trim() !== ""
			? { idToken: idToken.trim() }
			: credential.idToken
				? { idToken: credential.idToken }
				: {}),
		...(credential.accountId ? { accountId: credential.accountId } : {}),
		...(() => {
			const exp = readJwtExpiryMs(accessToken);
			if (exp !== undefined) return { accessTokenExpiresMs: exp };
			// Fall back to the endpoint's own `expires_in` when the token is not a
			// readable JWT, so we do not refresh on every single boot.
			const expiresIn = body.expires_in;
			return typeof expiresIn === "number" && Number.isFinite(expiresIn)
				? { accessTokenExpiresMs: now() + expiresIn * 1000 }
				: {};
		})(),
		updatedMs: now(),
	};
}
