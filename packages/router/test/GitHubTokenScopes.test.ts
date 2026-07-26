import { describe, expect, it, vi } from "vitest";
import {
	buildGitHubTokenScopeReport,
	diagnoseGitHubTokenScopes,
	type GitHubTokenScopeProbe,
	parseOAuthScopeHeader,
	probeGitHubTokenScopes,
	REDACTED,
	redactToken,
} from "../src/GitHubTokenScopes.js";

/** A stand-in secret value that must never appear in any output. */
const TOKEN = "ghp_SUPERSECRETTOKENVALUE1234567890";

/** Minimal `fetch` double returning the given headers/status. */
const fakeFetch = (
	headers: Record<string, string>,
	status = 200,
): typeof fetch =>
	vi.fn(
		async () =>
			({
				ok: status >= 200 && status < 300,
				status,
				headers: new Headers(headers),
			}) as unknown as Response,
	) as unknown as typeof fetch;

/** Every string a caller could print for a report. */
const allLines = (report: { info: string[]; warnings: string[] }): string =>
	[...report.info, ...report.warnings].join("\n");

describe("parseOAuthScopeHeader", () => {
	it("splits, trims, and dedupes a scope list", () => {
		expect(parseOAuthScopeHeader("repo, read:org ,  repo,gist")).toEqual([
			"repo",
			"read:org",
			"gist",
		]);
	});

	it("returns [] for empty, null, and undefined headers", () => {
		expect(parseOAuthScopeHeader("")).toEqual([]);
		expect(parseOAuthScopeHeader("   ")).toEqual([]);
		expect(parseOAuthScopeHeader(", ,")).toEqual([]);
		expect(parseOAuthScopeHeader(null)).toEqual([]);
		expect(parseOAuthScopeHeader(undefined)).toEqual([]);
	});
});

describe("diagnoseGitHubTokenScopes", () => {
	it("treats `repo` as sufficient for private-repository work", () => {
		const d = diagnoseGitHubTokenScopes("repo, read:org");
		expect(d.kind).toBe("classic");
		expect(d.hasPrivateRepoAccess).toBe(true);
		expect(d.hasOrgAccess).toBe(true);
		expect(d.missing).toEqual([]);
	});

	it("reports only `read:org` missing when that is the sole gap", () => {
		const d = diagnoseGitHubTokenScopes("repo, workflow");
		expect(d.hasPrivateRepoAccess).toBe(true);
		expect(d.hasOrgAccess).toBe(false);
		expect(d.missing).toEqual(["read:org"]);
	});

	it("accepts write:org and admin:org as implying read:org", () => {
		expect(diagnoseGitHubTokenScopes("repo, admin:org").missing).toEqual([]);
		expect(diagnoseGitHubTokenScopes("repo, write:org").missing).toEqual([]);
	});

	it("flags a classic token with NO scopes as missing both, still classic", () => {
		const d = diagnoseGitHubTokenScopes("");
		expect(d.kind).toBe("classic");
		expect(d.scopes).toEqual([]);
		expect(d.hasPrivateRepoAccess).toBe(false);
		expect(d.missing).toEqual(["repo", "read:org"]);
	});

	it("classifies an absent header as unscoped and asserts no missing scopes", () => {
		// Fine-grained PAT / GitHub App installation token / Actions token:
		// permissions are per-resource, so "missing scopes" is meaningless.
		for (const header of [null, undefined]) {
			const d = diagnoseGitHubTokenScopes(header);
			expect(d.kind).toBe("unscoped");
			expect(d.hasPrivateRepoAccess).toBe(false);
			expect(d.hasOrgAccess).toBe(false);
			expect(d.missing).toEqual([]);
		}
	});

	it("does not treat public_repo as private-repository access", () => {
		const d = diagnoseGitHubTokenScopes("public_repo");
		expect(d.hasPrivateRepoAccess).toBe(false);
		expect(d.missing).toContain("repo");
	});
});

describe("redactToken", () => {
	it("replaces every occurrence of the token", () => {
		expect(redactToken(`a ${TOKEN} b ${TOKEN}`, TOKEN)).toBe(
			`a ${REDACTED} b ${REDACTED}`,
		);
	});

	it("is a no-op for an empty token", () => {
		expect(redactToken("nothing to do", "")).toBe("nothing to do");
	});
});

describe("buildGitHubTokenScopeReport", () => {
	const probe = (
		scopeHeader: string | null,
		rest: Partial<GitHubTokenScopeProbe> = {},
	): GitHubTokenScopeProbe => ({ ok: true, status: 200, scopeHeader, ...rest });

	it("reports a fully-scoped token with no warnings", () => {
		const report = buildGitHubTokenScopeReport(
			"GH_TOKEN",
			probe("repo,read:org"),
		);
		expect(report.warnings).toEqual([]);
		expect(allLines(report)).toContain("scopes = repo, read:org");
	});

	it("warns but accepts a token missing only read:org", () => {
		const report = buildGitHubTokenScopeReport("GH_TOKEN", probe("repo"));
		expect(report.warnings).toHaveLength(1);
		expect(report.warnings[0]).toContain("read:org");
		// The warning must state it is non-fatal and that `repo` is enough.
		expect(report.warnings[0]).toContain("ONLY for organization-level queries");
		expect(allLines(report)).toContain(
			'has "repo" — sufficient for private-repository',
		);
	});

	it("warns about a token with no scopes at all without rejecting it", () => {
		const report = buildGitHubTokenScopeReport("GH_TOKEN", probe(""));
		expect(allLines(report)).toContain("scopes = (none)");
		expect(report.warnings.join("\n")).toContain('missing "repo"');
		expect(report.warnings.join("\n")).toContain('missing "read:org"');
	});

	it("explains an unscoped (fine-grained / App) token instead of warning", () => {
		const report = buildGitHubTokenScopeReport("GH_TOKEN", probe(null));
		expect(report.warnings).toEqual([]);
		expect(allLines(report)).toContain("no OAuth scopes reported");
		expect(allLines(report)).toContain("per-resource permissions");
	});

	it("degrades to an informational warning when the probe failed", () => {
		const report = buildGitHubTokenScopeReport("GH_TOKEN", {
			ok: false,
			status: 401,
			scopeHeader: null,
			error: "GitHub returned HTTP 401",
		});
		expect(report.warnings.join("\n")).toContain("could not verify scopes");
		expect(report.warnings.join("\n")).toContain("informational only");
	});

	it("echoes only the env-var name, never a token value", () => {
		for (const header of ["repo,read:org", "repo", "", null]) {
			const report = buildGitHubTokenScopeReport("GH_TOKEN", probe(header));
			expect(allLines(report)).not.toContain(TOKEN);
			expect(allLines(report)).toContain("GH_TOKEN");
		}
	});
});

describe("probeGitHubTokenScopes", () => {
	it("returns the X-OAuth-Scopes header on success", async () => {
		const result = await probeGitHubTokenScopes(TOKEN, {
			fetchImpl: fakeFetch({ "x-oauth-scopes": "repo, read:org" }),
		});
		expect(result).toEqual({
			ok: true,
			status: 200,
			scopeHeader: "repo, read:org",
		});
	});

	it("distinguishes a present-but-empty header from an absent one", async () => {
		const empty = await probeGitHubTokenScopes(TOKEN, {
			fetchImpl: fakeFetch({ "x-oauth-scopes": "" }),
		});
		expect(empty.scopeHeader).toBe("");
		expect(diagnoseGitHubTokenScopes(empty.scopeHeader).kind).toBe("classic");

		const absent = await probeGitHubTokenScopes(TOKEN, {
			fetchImpl: fakeFetch({}),
		});
		expect(absent.scopeHeader).toBeNull();
		expect(diagnoseGitHubTokenScopes(absent.scopeHeader).kind).toBe("unscoped");
	});

	it("sends the token as a bearer header and never in the URL", async () => {
		const spy = vi.fn(
			async () =>
				({
					ok: true,
					status: 200,
					headers: new Headers(),
				}) as unknown as Response,
		);
		await probeGitHubTokenScopes(TOKEN, {
			fetchImpl: spy as unknown as typeof fetch,
			apiBaseUrl: "https://api.github.test",
		});
		const [url, init] = spy.mock.calls[0] as unknown as [
			string,
			{ headers: Record<string, string> },
		];
		expect(url).toBe("https://api.github.test/");
		expect(url).not.toContain(TOKEN);
		expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
	});

	it("reports a non-2xx response as not-ok without throwing", async () => {
		const result = await probeGitHubTokenScopes(TOKEN, {
			fetchImpl: fakeFetch({}, 401),
		});
		expect(result.ok).toBe(false);
		expect(result.status).toBe(401);
		expect(result.error).toBe("GitHub returned HTTP 401");
	});

	it("never throws on a network failure and redacts the token from the error", async () => {
		const result = await probeGitHubTokenScopes(TOKEN, {
			fetchImpl: (() => {
				throw new Error(`connect ECONNREFUSED (token ${TOKEN})`);
			}) as unknown as typeof fetch,
		});
		expect(result.ok).toBe(false);
		expect(result.error).not.toContain(TOKEN);
		expect(result.error).toContain(REDACTED);
	});
});
