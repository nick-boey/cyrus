import { describe, expect, it, vi } from "vitest";
import {
	classifyMcpFailure,
	computeMcpRetryDelayMs,
	DEFAULT_MCP_RETRY_POLICY,
	type McpRetryAttempt,
	resolveMcpRetryPolicy,
	retryMcpConnection,
} from "../src/mcp/retry.js";

/**
 * Collects `onAttempt` callbacks and a fake sleep so every assertion about the
 * delay sequence is exact and the suite never actually waits.
 */
function harness() {
	const attempts: McpRetryAttempt[] = [];
	const slept: number[] = [];
	return {
		attempts,
		slept,
		onAttempt: (attempt: McpRetryAttempt) => {
			attempts.push(attempt);
		},
		sleep: async (ms: number) => {
			slept.push(ms);
		},
	};
}

describe("computeMcpRetryDelayMs", () => {
	it("grows exponentially from initialDelayMs", () => {
		const policy = {
			maxAttempts: 10,
			initialDelayMs: 500,
			maxDelayMs: 60_000,
			backoffMultiplier: 2,
		};
		expect(
			[1, 2, 3, 4, 5].map((n) => computeMcpRetryDelayMs(n, policy)),
		).toEqual([500, 1000, 2000, 4000, 8000]);
	});

	it("clamps every delay to maxDelayMs — the bound in bounded backoff", () => {
		const policy = {
			maxAttempts: 20,
			initialDelayMs: 1000,
			maxDelayMs: 5000,
			backoffMultiplier: 3,
		};
		expect(
			[1, 2, 3, 4, 10, 50].map((n) => computeMcpRetryDelayMs(n, policy)),
		).toEqual([1000, 3000, 5000, 5000, 5000, 5000]);
	});

	it("treats attempt numbers below 1 as the first attempt", () => {
		expect(computeMcpRetryDelayMs(0, { initialDelayMs: 250 })).toBe(250);
		expect(computeMcpRetryDelayMs(-5, { initialDelayMs: 250 })).toBe(250);
	});

	it("never exceeds maxDelayMs under the shipped default policy", () => {
		for (let attempt = 1; attempt <= 100; attempt++) {
			expect(computeMcpRetryDelayMs(attempt)).toBeLessThanOrEqual(
				DEFAULT_MCP_RETRY_POLICY.maxDelayMs,
			);
		}
	});
});

describe("resolveMcpRetryPolicy", () => {
	it("fills gaps from the default policy", () => {
		expect(resolveMcpRetryPolicy({ maxAttempts: 2 })).toEqual({
			...DEFAULT_MCP_RETRY_POLICY,
			maxAttempts: 2,
		});
	});

	it("sanitizes nonsense values instead of producing an unbounded loop", () => {
		expect(
			resolveMcpRetryPolicy({
				maxAttempts: 0,
				initialDelayMs: -1,
				maxDelayMs: -1,
				backoffMultiplier: 0,
			}),
		).toEqual({
			maxAttempts: 1,
			initialDelayMs: 0,
			maxDelayMs: 0,
			backoffMultiplier: 1,
		});
	});
});

describe("classifyMcpFailure", () => {
	const permanent: Array<[string, string]> = [
		["needs-auth", "needs-auth"],
		["Server requires OAuth authorization", "needs-auth"],
		["authentication required", "needs-auth"],
		["HTTP 401 Unauthorized", "unauthorized"],
		["403 Forbidden", "forbidden"],
		["invalid api key provided", "invalid-credentials"],
		["invalid token", "invalid-credentials"],
		["authentication failed", "authentication-failed"],
		["spawn npx ENOENT", "missing-binary"],
		["/bin/sh: slack-mcp-server: command not found", "missing-binary"],
		["EACCES: permission denied", "permission-denied"],
		["404 Not Found", "endpoint-not-found"],
		["400 Bad Request", "bad-request"],
		["invalid url", "invalid-config"],
		["unsupported transport", "invalid-config"],
		["protocol version mismatch", "protocol-mismatch"],
	];

	it.each(permanent)("classifies %j as permanent (%s)", (input, reason) => {
		const result = classifyMcpFailure(input);
		expect(result.class).toBe("permanent");
		expect(result.reason).toBe(reason);
	});

	const transient: Array<[string, string]> = [
		["429 Too Many Requests", "rate-limited"],
		["503 Service Unavailable", "server-error"],
		["502 Bad Gateway", "server-error"],
		["read ECONNRESET", "connection-reset"],
		["connect ECONNREFUSED 127.0.0.1:3456", "connection-refused"],
		["Connection timed out", "timeout"],
		["write EPIPE", "broken-pipe"],
		["getaddrinfo EAI_AGAIN mcp.linear.app", "dns-failure"],
		["network is unreachable", "network-unreachable"],
		["fetch failed", "network-error"],
		["transport closed", "disconnected"],
		["pending", "pending"],
		["failed", "connect-failed"],
	];

	it.each(transient)("classifies %j as transient (%s)", (input, reason) => {
		const result = classifyMcpFailure(input);
		expect(result.class).toBe("transient");
		expect(result.reason).toBe(reason);
	});

	it("defaults an unrecognised failure to transient/unknown", () => {
		expect(classifyMcpFailure("something nobody has seen before")).toEqual({
			class: "transient",
			reason: "unknown",
			detail: "something nobody has seen before",
		});
	});

	it("reads Node's error `code` even when the message omits it", () => {
		const error = Object.assign(new Error("read failed"), {
			code: "ECONNRESET",
		});
		expect(classifyMcpFailure(error)).toMatchObject({
			class: "transient",
			reason: "connection-reset",
		});
	});

	it("unwraps a fetch failure's `cause`", () => {
		const error = new Error("fetch failed", {
			cause: Object.assign(new Error("connect ECONNREFUSED"), {
				code: "ECONNREFUSED",
			}),
		});
		expect(classifyMcpFailure(error).class).toBe("transient");
	});

	it("classifies an HTTP-ish object by its status", () => {
		expect(
			classifyMcpFailure({ status: 401, statusText: "Unauthorized" }),
		).toMatchObject({ class: "permanent", reason: "unauthorized" });
	});

	it("truncates a very long detail so diagnostics stay readable", () => {
		const long = `weird failure ${"x".repeat(1000)}`;
		const result = classifyMcpFailure(long);
		expect(result.detail.length).toBeLessThanOrEqual(301);
		expect(result.detail.endsWith("…")).toBe(true);
	});

	it("handles null/undefined without throwing", () => {
		expect(classifyMcpFailure(undefined).reason).toBe("unknown");
		expect(classifyMcpFailure(null).detail).toBe("");
	});
});

describe("retryMcpConnection", () => {
	it("returns immediately on a first-attempt success and never sleeps", async () => {
		const h = harness();
		const result = await retryMcpConnection(async () => "ok", {
			server: "cyrus-tools",
			onAttempt: h.onAttempt,
			sleep: h.sleep,
		});

		expect(result).toEqual({
			ok: true,
			value: "ok",
			attempts: 1,
			delaysMs: [],
		});
		expect(h.attempts).toEqual([]);
		expect(h.slept).toEqual([]);
	});

	it("retries a transient failure with bounded exponential delays and records each attempt", async () => {
		const h = harness();
		const operation = vi
			.fn<(attempt: number) => Promise<string>>()
			.mockRejectedValueOnce(new Error("read ECONNRESET"))
			.mockRejectedValueOnce(new Error("read ECONNRESET"))
			.mockResolvedValueOnce("connected");

		const result = await retryMcpConnection(operation, {
			server: "linear",
			policy: { maxAttempts: 5, initialDelayMs: 100, maxDelayMs: 150 },
			onAttempt: h.onAttempt,
			sleep: h.sleep,
		});

		expect(result.ok).toBe(true);
		expect(result.value).toBe("connected");
		expect(result.attempts).toBe(3);
		// 100 then min(200, 150) = 150 — the cap bites on the second delay.
		expect(result.delaysMs).toEqual([100, 150]);
		expect(h.slept).toEqual([100, 150]);

		// Each failed attempt is recorded exactly once, in order.
		expect(h.attempts).toHaveLength(2);
		expect(h.attempts.map((a) => a.attempt)).toEqual([1, 2]);
		expect(h.attempts.every((a) => a.server === "linear")).toBe(true);
		expect(h.attempts.every((a) => a.maxAttempts === 5)).toBe(true);
		expect(h.attempts.every((a) => a.willRetry)).toBe(true);
		expect(h.attempts.map((a) => a.nextDelayMs)).toEqual([100, 150]);
		expect(h.attempts.map((a) => a.classification.reason)).toEqual([
			"connection-reset",
			"connection-reset",
		]);
	});

	it("stops at the attempt cap rather than retrying indefinitely", async () => {
		const h = harness();
		const operation = vi.fn(async () => {
			throw new Error("503 Service Unavailable");
		});

		const result = await retryMcpConnection(operation, {
			server: "cyrus-tools",
			policy: { maxAttempts: 4, initialDelayMs: 10, maxDelayMs: 40 },
			onAttempt: h.onAttempt,
			sleep: h.sleep,
		});

		expect(operation).toHaveBeenCalledTimes(4);
		expect(result.ok).toBe(false);
		expect(result.attempts).toBe(4);
		expect(result.failure).toMatchObject({
			class: "transient",
			reason: "server-error",
		});
		expect(result.delaysMs).toEqual([10, 20, 40]);

		// Every attempt logged; only the last one says "giving up".
		expect(h.attempts).toHaveLength(4);
		expect(h.attempts.map((a) => a.willRetry)).toEqual([
			true,
			true,
			true,
			false,
		]);
		expect(h.attempts.at(-1)?.nextDelayMs).toBeUndefined();
	});

	it("does not retry a permanent failure — one attempt, no sleep", async () => {
		const h = harness();
		const operation = vi.fn(async () => {
			throw new Error("needs-auth");
		});

		const result = await retryMcpConnection(operation, {
			server: "cyrus-docs",
			policy: { maxAttempts: 5, initialDelayMs: 10 },
			onAttempt: h.onAttempt,
			sleep: h.sleep,
		});

		expect(operation).toHaveBeenCalledTimes(1);
		expect(h.slept).toEqual([]);
		expect(result).toMatchObject({
			ok: false,
			attempts: 1,
			failure: { class: "permanent", reason: "needs-auth" },
		});
		expect(h.attempts).toEqual([
			{
				server: "cyrus-docs",
				attempt: 1,
				maxAttempts: 5,
				classification: {
					class: "permanent",
					reason: "needs-auth",
					detail: "needs-auth",
				},
				willRetry: false,
			},
		]);
	});

	it("stops mid-sequence when a transient failure turns permanent", async () => {
		const h = harness();
		const operation = vi
			.fn<(attempt: number) => Promise<never>>()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("HTTP 401 Unauthorized"));

		const result = await retryMcpConnection(operation, {
			server: "linear",
			policy: { maxAttempts: 5, initialDelayMs: 10 },
			onAttempt: h.onAttempt,
			sleep: h.sleep,
		});

		expect(operation).toHaveBeenCalledTimes(2);
		expect(result.failure?.class).toBe("permanent");
		expect(h.attempts.map((a) => a.willRetry)).toEqual([true, false]);
		expect(h.slept).toEqual([10]);
	});

	it("honours maxAttempts: 1 by making exactly one attempt", async () => {
		const h = harness();
		const operation = vi.fn(async () => {
			throw new Error("read ECONNRESET");
		});

		const result = await retryMcpConnection(operation, {
			server: "cyrus-tools",
			policy: { maxAttempts: 1 },
			onAttempt: h.onAttempt,
			sleep: h.sleep,
		});

		expect(operation).toHaveBeenCalledTimes(1);
		expect(result.ok).toBe(false);
		expect(h.slept).toEqual([]);
		expect(h.attempts[0]?.willRetry).toBe(false);
	});

	it("passes the 1-based attempt number into the operation", async () => {
		const seen: number[] = [];
		await retryMcpConnection(
			async (attempt) => {
				seen.push(attempt);
				if (attempt < 3) throw new Error("read ECONNRESET");
				return attempt;
			},
			{
				server: "cyrus-tools",
				policy: { maxAttempts: 5, initialDelayMs: 0 },
				sleep: async () => {},
			},
		);
		expect(seen).toEqual([1, 2, 3]);
	});

	it("uses an injected classifier when supplied", async () => {
		const h = harness();
		const result = await retryMcpConnection(
			async () => {
				throw new Error("anything");
			},
			{
				server: "custom",
				policy: { maxAttempts: 5 },
				classify: () => ({
					class: "permanent" as const,
					reason: "policy-denied",
					detail: "anything",
				}),
				onAttempt: h.onAttempt,
				sleep: h.sleep,
			},
		);
		expect(result.attempts).toBe(1);
		expect(h.attempts[0]?.classification.reason).toBe("policy-denied");
	});
});
