import type { LinearClient } from "@linear/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LinearIssueTrackerService,
	type LinearOAuthConfig,
	LinearRefreshTokenRejectedError,
} from "../src/LinearIssueTrackerService.js";

const WS = "ws-1";

function silentLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

/**
 * The constructor patches `linearClient.client.request` in place, so holding a
 * reference to the raw object gives the test a handle on the patched wrapper.
 */
function makeClient() {
	const unauthorized = vi.fn(async () => {
		const err = new Error("unauthorized") as Error & { status: number };
		err.status = 401;
		throw err;
	});
	const raw = { request: unauthorized, setHeader: vi.fn() };
	return {
		raw,
		linearClient: { client: raw } as unknown as LinearClient,
	};
}

function oauth(refreshToken: string): LinearOAuthConfig {
	return {
		clientId: "cid",
		clientSecret: "csec",
		refreshToken,
		workspaceId: WS,
	};
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	LinearIssueTrackerService.resetWorkspaceAuthState();
	fetchMock = vi.fn();
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	LinearIssueTrackerService.resetWorkspaceAuthState();
});

describe("terminal refresh failures", () => {
	it("marks the workspace rejected, logs once, and throws a typed error", async () => {
		fetchMock.mockResolvedValue(new Response("invalid_grant", { status: 400 }));
		const logger = silentLogger();
		const { raw, linearClient } = makeClient();
		new LinearIssueTrackerService(linearClient, oauth("rt-dead"), logger);

		await expect(raw.request("query")).rejects.toThrow();

		expect(LinearIssueTrackerService.getRejectedWorkspace(WS)).toMatchObject({
			status: 400,
		});
		expect(logger.error).toHaveBeenCalledTimes(1);
		expect(String(logger.error.mock.calls[0][0])).toContain("self-auth-linear");
	});

	it("makes no further token requests once rejected", async () => {
		fetchMock.mockResolvedValue(new Response("invalid_grant", { status: 400 }));
		const { raw, linearClient } = makeClient();
		new LinearIssueTrackerService(
			linearClient,
			oauth("rt-dead"),
			silentLogger(),
		);

		await expect(raw.request("query")).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await expect(raw.request("query")).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(1); // suppressed, not retried
	});

	// Reaches into the private refresh path deliberately: the patched
	// `client.request` rethrows the ORIGINAL 401 on refresh failure (see its
	// `catch (_refreshError) { throw error; }`), so the typed error is not
	// observable through any public call. It is exported API — Task 2 Step 6
	// branches on `instanceof` — so it needs direct coverage.
	it("throws LinearRefreshTokenRejectedError from the suppressed path", async () => {
		fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));
		const { raw, linearClient } = makeClient();
		const service = new LinearIssueTrackerService(
			linearClient,
			oauth("rt-dead"),
			silentLogger(),
		);
		await expect(raw.request("query")).rejects.toThrow();

		await expect(
			// @ts-expect-error -- exercising the private refresh path directly
			service.doTokenRefresh(),
		).rejects.toBeInstanceOf(LinearRefreshTokenRejectedError);
	});
});

describe("transient refresh failures", () => {
	it("does not mark the workspace rejected on 5xx and retries next time", async () => {
		fetchMock.mockResolvedValue(new Response("upstream", { status: 503 }));
		const { raw, linearClient } = makeClient();
		new LinearIssueTrackerService(
			linearClient,
			oauth("rt-live"),
			silentLogger(),
		);

		await expect(raw.request("query")).rejects.toThrow();
		expect(LinearIssueTrackerService.getRejectedWorkspace(WS)).toBeUndefined();

		await expect(raw.request("query")).rejects.toThrow();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("recovery", () => {
	it("clears the rejection when a different refresh token is registered", async () => {
		fetchMock.mockResolvedValue(new Response("invalid_grant", { status: 400 }));
		const first = makeClient();
		new LinearIssueTrackerService(
			first.linearClient,
			oauth("rt-dead"),
			silentLogger(),
		);
		await expect(first.raw.request("query")).rejects.toThrow();
		expect(LinearIssueTrackerService.getRejectedWorkspace(WS)).toBeDefined();

		const second = makeClient();
		new LinearIssueTrackerService(
			second.linearClient,
			oauth("rt-fresh"),
			silentLogger(),
		);
		expect(LinearIssueTrackerService.getRejectedWorkspace(WS)).toBeUndefined();
	});

	/**
	 * The self-host config watcher re-authorizes a LIVE tracker — it calls
	 * `setAccessToken()` on the existing instance rather than constructing a new
	 * one (EdgeWorker.updateLinearWorkspaceTokens). Before this, registration
	 * happened only in the constructor, so `cyrus refresh-token` on a rejected
	 * workspace left the suppression standing until the process restarted and the
	 * brand-new credential never got a single attempt.
	 */
	it("clears the rejection when a live tracker is handed a new refresh token", async () => {
		fetchMock.mockResolvedValue(new Response("invalid_grant", { status: 400 }));
		const { raw, linearClient } = makeClient();
		const service = new LinearIssueTrackerService(
			linearClient,
			oauth("rt-dead"),
			silentLogger(),
		);
		await expect(raw.request("query")).rejects.toThrow();
		expect(LinearIssueTrackerService.getRejectedWorkspace(WS)).toBeDefined();

		service.setAccessToken("at-fresh", "rt-fresh");

		expect(LinearIssueTrackerService.getRejectedWorkspace(WS)).toBeUndefined();

		// And the next refresh actually uses the new token rather than replaying
		// the dead one.
		fetchMock.mockResolvedValue(
			new Response(
				JSON.stringify({
					access_token: "at-2",
					refresh_token: "rt-2",
					expires_in: 3600,
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		// @ts-expect-error -- exercising the private refresh path directly
		await expect(service.doTokenRefresh()).resolves.toBe("at-2");
		const body = String(fetchMock.mock.calls.at(-1)?.[1]?.body);
		expect(body).toContain("refresh_token=rt-fresh");
	});

	it("keeps the rejection when only the access token is replaced", async () => {
		fetchMock.mockResolvedValue(new Response("invalid_grant", { status: 400 }));
		const { raw, linearClient } = makeClient();
		const service = new LinearIssueTrackerService(
			linearClient,
			oauth("rt-dead"),
			silentLogger(),
		);
		await expect(raw.request("query")).rejects.toThrow();

		// A bare access-token rotation is not a re-authorization: the refresh
		// chain Linear refused is unchanged, so the suppression must stand.
		service.setAccessToken("at-fresh");

		expect(LinearIssueTrackerService.getRejectedWorkspace(WS)).toBeDefined();
	});
});
