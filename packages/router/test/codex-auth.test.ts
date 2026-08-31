import { describe, expect, it, vi } from "vitest";
import {
	CODEX_REFRESH_BUFFER_MS,
	CodexAuthValidationError,
	type CodexCredential,
	CodexRefreshError,
	codexAccountStatus,
	needsRefresh,
	parseCodexAuthPaste,
	readJwtExpiryMs,
	refreshCodexCredential,
	renderCodexAuthFile,
} from "../src/setup/codexAuth.js";

const NOW = 1_800_000_000_000;

/** An unsigned JWT whose only interesting claim is `exp`. */
function jwtExpiringAt(ms: number): string {
	const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
		"base64url",
	);
	const payload = Buffer.from(
		JSON.stringify({ exp: Math.floor(ms / 1000) }),
	).toString("base64url");
	return `${header}.${payload}.`;
}

function authFile(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		OPENAI_API_KEY: null,
		tokens: {
			id_token: "id-token",
			access_token: jwtExpiringAt(NOW + 3_600_000),
			refresh_token: "refresh-1",
			account_id: "acct-1",
		},
		last_refresh: "2026-08-30T00:00:00.000Z",
		...overrides,
	});
}

describe("parseCodexAuthPaste", () => {
	it("accepts a subscription auth.json and keeps every token", () => {
		const credential = parseCodexAuthPaste(authFile(), NOW);
		expect(credential).toMatchObject({
			refreshToken: "refresh-1",
			idToken: "id-token",
			accountId: "acct-1",
			updatedMs: NOW,
		});
		expect(credential.accessTokenExpiresMs).toBe(NOW + 3_600_000);
	});

	// Not every Codex CLI version writes `auth_mode`, so requiring it outright
	// would reject valid logins. What must be rejected is an API-key file.
	it("accepts a file with no auth_mode field", () => {
		expect(() => parseCodexAuthPaste(authFile(), NOW)).not.toThrow();
	});

	it("accepts an explicit chatgpt auth_mode", () => {
		expect(() =>
			parseCodexAuthPaste(authFile({ auth_mode: "chatgpt" }), NOW),
		).not.toThrow();
	});

	it.each([
		["", /codex login --device-auth/],
		["not json", /not valid JSON/],
		["[1,2,3]", /not an object/],
		['{"tokens":{}}', /refresh_token/],
		[JSON.stringify({ tokens: { refresh_token: "r" } }), /access_token/],
		[
			JSON.stringify({ auth_mode: "apikey", tokens: { refresh_token: "r" } }),
			/"apikey" mode/,
		],
		[JSON.stringify({ OPENAI_API_KEY: "sk-x" }), /no "tokens" object/],
	])("rejects %j with a specific message", (raw, pattern) => {
		// A malformed paste accepted silently surfaces as a dead Codex session
		// hours later, with nothing connecting the two events. Every rejection
		// has to say what is actually wrong.
		expect(() => parseCodexAuthPaste(raw, NOW)).toThrow(
			CodexAuthValidationError,
		);
		expect(() => parseCodexAuthPaste(raw, NOW)).toThrow(pattern);
	});

	it("refuses something far too large to be an auth.json", () => {
		expect(() => parseCodexAuthPaste("x".repeat(20_000), NOW)).toThrow(
			/larger than/,
		);
	});
});

describe("readJwtExpiryMs", () => {
	it("reads exp without verifying the signature", () => {
		expect(readJwtExpiryMs(jwtExpiringAt(NOW))).toBe(NOW);
	});

	it.each(["", "not-a-jwt", "a.b", "a.!!!.c"])(
		"returns undefined for %j",
		(token) => {
			expect(readJwtExpiryMs(token)).toBeUndefined();
		},
	);
});

describe("needsRefresh", () => {
	const base: CodexCredential = {
		refreshToken: "r",
		accessToken: "a",
		updatedMs: NOW,
	};

	it("refreshes when the expiry cannot be read at all", () => {
		// We cannot prove the token is live, and a refresh is cheap next to
		// handing a sandbox a dead credential.
		expect(needsRefresh(base, NOW)).toBe(true);
	});

	it("does not refresh a token well outside the buffer", () => {
		expect(
			needsRefresh({ ...base, accessTokenExpiresMs: NOW + 3_600_000 }, NOW),
		).toBe(false);
	});

	it("refreshes inside the five-minute buffer", () => {
		const expires = NOW + CODEX_REFRESH_BUFFER_MS - 1;
		expect(needsRefresh({ ...base, accessTokenExpiresMs: expires }, NOW)).toBe(
			true,
		);
	});

	it("refreshes an already-expired token", () => {
		expect(needsRefresh({ ...base, accessTokenExpiresMs: NOW - 1 }, NOW)).toBe(
			true,
		);
	});
});

describe("codexAccountStatus", () => {
	const live: CodexCredential = {
		refreshToken: "r",
		accessToken: "a",
		accessTokenExpiresMs: NOW + 3_600_000,
		updatedMs: NOW,
	};

	it("reports absent with no credential", () => {
		expect(codexAccountStatus(undefined, NOW)).toBe("absent");
	});

	it("reports connected for a live credential", () => {
		expect(codexAccountStatus(live, NOW)).toBe("connected");
	});

	it("reports expiring inside the buffer", () => {
		expect(
			codexAccountStatus({ ...live, accessTokenExpiresMs: NOW + 1000 }, NOW),
		).toBe("expiring");
	});

	it("reports needs-attention after a refresh failure, even while live", () => {
		// A bare "connected" above a credential that is about to fail a boot is
		// the one thing this row must not say.
		expect(codexAccountStatus({ ...live, lastError: "revoked" }, NOW)).toBe(
			"needs-attention",
		);
	});
});

describe("renderCodexAuthFile", () => {
	it("produces a chatgpt-mode file the Codex CLI can read", () => {
		const parsed = JSON.parse(
			renderCodexAuthFile({
				refreshToken: "r",
				accessToken: "a",
				idToken: "i",
				accountId: "acct",
				updatedMs: NOW,
			}),
		);
		expect(parsed).toMatchObject({
			OPENAI_API_KEY: null,
			auth_mode: "chatgpt",
			tokens: {
				access_token: "a",
				refresh_token: "r",
				id_token: "i",
				account_id: "acct",
			},
		});
	});

	it("round-trips through the paste validator", () => {
		const credential = parseCodexAuthPaste(authFile(), NOW);
		expect(() =>
			parseCodexAuthPaste(renderCodexAuthFile(credential), NOW),
		).not.toThrow();
	});
});

describe("refreshCodexCredential", () => {
	const stored: CodexCredential = {
		refreshToken: "refresh-1",
		accessToken: "old",
		idToken: "old-id",
		accountId: "acct-1",
		updatedMs: NOW - 10_000,
	};

	function jsonResponse(status: number, body: unknown): Response {
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	}

	it("stores the ROTATED refresh token, not the old one", async () => {
		// OpenAI rotates on every redemption. Persisting the old token makes the
		// next refresh fail with an error that reads like a revocation.
		const fetchFn = vi.fn(async () =>
			jsonResponse(200, {
				access_token: jwtExpiringAt(NOW + 3_600_000),
				refresh_token: "refresh-2",
			}),
		) as unknown as typeof fetch;

		const refreshed = await refreshCodexCredential(stored, {
			fetchFn,
			now: () => NOW,
		});

		expect(refreshed.refreshToken).toBe("refresh-2");
		expect(refreshed.accessTokenExpiresMs).toBe(NOW + 3_600_000);
		expect(refreshed.accountId).toBe("acct-1");
	});

	it("keeps the existing refresh token when the response omits one", async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse(200, { access_token: jwtExpiringAt(NOW + 60_000) }),
		) as unknown as typeof fetch;

		const refreshed = await refreshCodexCredential(stored, {
			fetchFn,
			now: () => NOW,
		});
		expect(refreshed.refreshToken).toBe("refresh-1");
	});

	it("falls back to expires_in when the access token is not a readable JWT", async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse(200, { access_token: "opaque", expires_in: 900 }),
		) as unknown as typeof fetch;

		const refreshed = await refreshCodexCredential(stored, {
			fetchFn,
			now: () => NOW,
		});
		expect(refreshed.accessTokenExpiresMs).toBe(NOW + 900_000);
	});

	it("presents the configured client id", async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse(200, { access_token: "opaque" }),
		) as unknown as typeof fetch;

		await refreshCodexCredential(stored, {
			fetchFn,
			clientId: "app_custom",
			now: () => NOW,
		});

		const [, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock
			.calls[0] as [string, RequestInit];
		expect(JSON.parse(String(init.body))).toMatchObject({
			client_id: "app_custom",
			grant_type: "refresh_token",
			refresh_token: "refresh-1",
		});
	});

	it.each([400, 401])(
		"names the revocation remedy on HTTP %i",
		async (status) => {
			const fetchFn = vi.fn(async () =>
				jsonResponse(status, { error: "invalid_grant" }),
			) as unknown as typeof fetch;

			await expect(
				refreshCodexCredential(stored, { fetchFn, now: () => NOW }),
			).rejects.toMatchObject({
				name: "CodexRefreshError",
				remedy: expect.stringContaining("codex login --device-auth"),
			});
		},
	);

	it("treats a 5xx as retryable rather than as a revocation", async () => {
		const fetchFn = vi.fn(async () =>
			jsonResponse(503, { error: "unavailable" }),
		) as unknown as typeof fetch;

		await expect(
			refreshCodexCredential(stored, { fetchFn, now: () => NOW }),
		).rejects.toMatchObject({ remedy: expect.stringContaining("Retry") });
	});

	it("reports a network failure as an egress/transient problem", async () => {
		const fetchFn = vi.fn(async () => {
			throw new Error("getaddrinfo ENOTFOUND");
		}) as unknown as typeof fetch;

		await expect(
			refreshCodexCredential(stored, { fetchFn, now: () => NOW }),
		).rejects.toBeInstanceOf(CodexRefreshError);
	});
});
