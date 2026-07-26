/**
 * GitHub token scope diagnostics for `cyrus router secrets list --check-scopes`.
 *
 * Purely ADVISORY. A container's GitHub credential is usable for the core flow
 * (clone / commit / push / query a repository) with the `repo` scope alone;
 * `read:org` is required only for organization-level queries, so `gh auth
 * status` warning about a missing `read:org` is not a failure. Nothing in this
 * module may reject a token — it classifies and reports, and the caller prints.
 *
 * Scopes only exist for **classic** personal access tokens. Fine-grained PATs,
 * GitHub App installation tokens, and Actions `GITHUB_TOKEN`s carry
 * per-resource permissions instead and report no `X-OAuth-Scopes` header at
 * all; that is a "cannot introspect", never a "missing scopes".
 *
 * No function here accepts a token in a value it returns, and
 * {@link redactToken} is applied to any upstream error text, so a token value
 * can never reach stdout/logs through this path.
 */

/**
 * Secret keys that hold a GitHub credential, in the precedence order
 * `ContainerBootCommand` uses: `GH_TOKEN` is canonical (authenticates both the
 * `gh` CLI and git), `GIT_TOKEN` is the legacy git-only fallback.
 */
export const GITHUB_TOKEN_SECRET_KEYS = ["GH_TOKEN", "GIT_TOKEN"] as const;

/** The functional minimum for private-repository work. */
export const GITHUB_REQUIRED_SCOPE = "repo";

/** Required ONLY for organization-level queries. Absence is never fatal. */
export const GITHUB_ORG_SCOPE = "read:org";

/** What `redactToken` substitutes for a token value. */
export const REDACTED = "****";

const GITHUB_API_BASE_URL = "https://api.github.com";

/** Scopes that imply {@link GITHUB_ORG_SCOPE}. */
const ORG_SCOPE_IMPLIED_BY = ["read:org", "write:org", "admin:org"];

/**
 * `classic` — the API reported an `X-OAuth-Scopes` list (possibly empty), so
 * this is a classic PAT and its scopes are known exactly.
 *
 * `unscoped` — no scope header: a fine-grained PAT, a GitHub App installation
 * token, or an Actions token. Permissions are per-resource and cannot be
 * enumerated from the token.
 */
export type GitHubTokenKind = "classic" | "unscoped";

export interface GitHubTokenScopeDiagnostic {
	kind: GitHubTokenKind;
	/** Scopes the token reports, deduped and in header order. */
	scopes: string[];
	/** True only when a classic PAT reports the `repo` scope. */
	hasPrivateRepoAccess: boolean;
	/** True when a classic PAT reports `read:org` or a scope implying it. */
	hasOrgAccess: boolean;
	/** Recommended scopes not reported. ADVISORY — never a rejection reason. */
	missing: string[];
}

/** Outcome of asking GitHub which scopes a token carries. Never throws. */
export interface GitHubTokenScopeProbe {
	/** False when the request failed or GitHub rejected the token. */
	ok: boolean;
	/** HTTP status, when a response was received. */
	status?: number;
	/**
	 * Raw `X-OAuth-Scopes` value, or `null` when the response omitted the
	 * header. `""` (present but empty) means a classic PAT with zero scopes.
	 */
	scopeHeader: string | null;
	/** Redacted failure description, when `ok` is false. */
	error?: string;
}

/** Lines a caller may print verbatim. Neither list can contain a token. */
export interface GitHubTokenScopeReport {
	info: string[];
	/** Advisory only. Must not change the command's exit status. */
	warnings: string[];
}

/**
 * Replaces every occurrence of `token` with {@link REDACTED}. Defensive: upstream
 * error text (a proxy error echoing a header, a misconfigured base URL carrying
 * the token in a query string) must never be printed raw.
 */
export function redactToken(text: string, token: string): string {
	if (!token) return text;
	return text.split(token).join(REDACTED);
}

/**
 * Parses an `X-OAuth-Scopes` header (`"repo, read:org"`). Returns `[]` for a
 * present-but-empty header and for `null`/`undefined`; use the header's
 * presence, not this result, to tell a scopeless classic PAT from a
 * fine-grained/App token.
 */
export function parseOAuthScopeHeader(
	header: string | null | undefined,
): string[] {
	if (!header) return [];
	const seen = new Set<string>();
	for (const raw of header.split(",")) {
		const scope = raw.trim();
		if (scope) seen.add(scope);
	}
	return [...seen];
}

/**
 * Classifies a token's scopes. `repo` is treated as the private-repository
 * minimum; `read:org` is reported as missing only as advice.
 */
export function diagnoseGitHubTokenScopes(
	scopeHeader: string | null | undefined,
): GitHubTokenScopeDiagnostic {
	// A present-but-empty header is a real answer ("no scopes"); an absent one
	// means scopes do not apply to this token type.
	const kind: GitHubTokenKind =
		scopeHeader === null || scopeHeader === undefined ? "unscoped" : "classic";
	const scopes = parseOAuthScopeHeader(scopeHeader);
	const hasPrivateRepoAccess =
		kind === "classic" && scopes.includes(GITHUB_REQUIRED_SCOPE);
	const hasOrgAccess =
		kind === "classic" && scopes.some((s) => ORG_SCOPE_IMPLIED_BY.includes(s));

	const missing: string[] = [];
	if (kind === "classic") {
		if (!hasPrivateRepoAccess) missing.push(GITHUB_REQUIRED_SCOPE);
		if (!hasOrgAccess) missing.push(GITHUB_ORG_SCOPE);
	}
	return { kind, scopes, hasPrivateRepoAccess, hasOrgAccess, missing };
}

/**
 * Asks GitHub which scopes `token` carries by reading the `X-OAuth-Scopes`
 * header off an authenticated `GET /`. Never throws and never returns the
 * token: a network failure or a 401 becomes `ok: false` with redacted text, so
 * `secrets list` still completes.
 */
export async function probeGitHubTokenScopes(
	token: string,
	options: { fetchImpl?: typeof fetch; apiBaseUrl?: string } = {},
): Promise<GitHubTokenScopeProbe> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseUrl = options.apiBaseUrl ?? GITHUB_API_BASE_URL;
	try {
		const response = await fetchImpl(`${baseUrl}/`, {
			method: "GET",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		const scopeHeader = response.headers.get("x-oauth-scopes");
		if (!response.ok) {
			return {
				ok: false,
				status: response.status,
				scopeHeader,
				error: `GitHub returned HTTP ${response.status}`,
			};
		}
		return { ok: true, status: response.status, scopeHeader };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, scopeHeader: null, error: redactToken(message, token) };
	}
}

/**
 * Renders a probe as printable lines. `key` is the secret's env-var name (e.g.
 * `GH_TOKEN`) and is the only token-related value echoed — the value never is.
 *
 * Warnings are advisory: a token missing `read:org`, or one whose scopes cannot
 * be introspected, still works for the core clone/commit/push/query flow.
 */
export function buildGitHubTokenScopeReport(
	key: string,
	probe: GitHubTokenScopeProbe,
): GitHubTokenScopeReport {
	const info: string[] = [];
	const warnings: string[] = [];

	if (!probe.ok) {
		warnings.push(
			`${key}: could not verify scopes (${probe.error ?? "unknown error"}). ` +
				"This is informational only — the token was not changed and may still be valid.",
		);
		return { info, warnings };
	}

	const diagnostic = diagnoseGitHubTokenScopes(probe.scopeHeader);

	if (diagnostic.kind === "unscoped") {
		info.push(
			`${key}: no OAuth scopes reported — fine-grained PAT, GitHub App installation token, or Actions token.`,
		);
		info.push(
			`${key}: such tokens carry per-resource permissions instead of scopes; confirm Contents read/write on the target repositories.`,
		);
		return { info, warnings };
	}

	info.push(
		`${key}: scopes = ${diagnostic.scopes.length > 0 ? diagnostic.scopes.join(", ") : "(none)"}`,
	);

	if (diagnostic.hasPrivateRepoAccess) {
		info.push(
			`${key}: has "${GITHUB_REQUIRED_SCOPE}" — sufficient for private-repository clone, commit, push, and query.`,
		);
	} else {
		warnings.push(
			`${key}: missing "${GITHUB_REQUIRED_SCOPE}", the functional minimum for private-repository work. ` +
				"Public repositories may still work. Re-issue with: gh auth refresh -h github.com -s repo",
		);
	}

	if (!diagnostic.hasOrgAccess) {
		warnings.push(
			`${key}: missing "${GITHUB_ORG_SCOPE}". Required ONLY for organization-level queries — ` +
				"clone, commit, push, and issue/PR access are unaffected, and `gh auth status` warns about this " +
				"even for tokens that work fine. Add it only if you need org queries: gh auth refresh -h github.com -s read:org",
		);
	}

	return { info, warnings };
}
