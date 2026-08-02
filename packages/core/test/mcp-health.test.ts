import { describe, expect, it } from "vitest";
import {
	formatMcpHealthDiagnostics,
	formatMcpServerHealth,
	McpHealthRegistry,
	recordMcpInitStatuses,
} from "../src/mcp/health.js";
import { classifyMcpFailure, retryMcpConnection } from "../src/mcp/retry.js";

function registry(): McpHealthRegistry {
	// Frozen clock so `observedAt` is assertable.
	return new McpHealthRegistry({ now: () => 1_700_000_000_000 });
}

describe("McpHealthRegistry", () => {
	it("declares configured servers as not-yet-observed", () => {
		const r = registry();
		r.declare("cyrus-tools");
		r.declare("linear");

		expect(r.snapshot()).toEqual([
			{
				name: "cyrus-tools",
				state: "declared",
				attempts: 0,
				source: "config",
				observedAt: 1_700_000_000_000,
			},
			{
				name: "linear",
				state: "declared",
				attempts: 0,
				source: "config",
				observedAt: 1_700_000_000_000,
			},
		]);
	});

	it("does not let a re-declare clobber an observed state", () => {
		const r = registry();
		r.recordConnected("linear");
		r.declare("linear");
		expect(r.get("linear")?.state).toBe("connected");
	});

	it("lets a re-declare revive a previously skipped server", () => {
		const r = registry();
		r.recordSkipped("cyrus-docs", "needs-interactive-oauth");
		r.declare("cyrus-docs");
		expect(r.get("cyrus-docs")?.state).toBe("declared");
	});

	it("records a skip with its reason", () => {
		const r = registry();
		r.recordSkipped("cyrus-docs", "needs-interactive-oauth", "no browser here");
		expect(r.get("cyrus-docs")).toMatchObject({
			state: "skipped",
			reason: "needs-interactive-oauth",
			detail: "no browser here",
			attempts: 0,
		});
	});

	it("clears failure detail when a server recovers", () => {
		const r = registry();
		r.recordFailure("linear", classifyMcpFailure("read ECONNRESET"));
		expect(r.get("linear")?.state).toBe("degraded");
		r.recordConnected("linear");
		const entry = r.get("linear");
		expect(entry?.state).toBe("connected");
		expect(entry?.reason).toBeUndefined();
		expect(entry?.failureClass).toBeUndefined();
	});

	it("maps retry attempts onto retrying / degraded / failed", () => {
		const r = registry();

		r.recordAttempt({
			server: "linear",
			attempt: 1,
			maxAttempts: 3,
			classification: classifyMcpFailure("read ECONNRESET"),
			willRetry: true,
			nextDelayMs: 500,
		});
		expect(r.get("linear")).toMatchObject({
			state: "retrying",
			attempts: 1,
			failureClass: "transient",
			reason: "connection-reset",
			nextRetryDelayMs: 500,
		});

		r.recordAttempt({
			server: "linear",
			attempt: 3,
			maxAttempts: 3,
			classification: classifyMcpFailure("read ECONNRESET"),
			willRetry: false,
		});
		expect(r.get("linear")).toMatchObject({ state: "degraded", attempts: 3 });

		r.recordAttempt({
			server: "cyrus-docs",
			attempt: 1,
			maxAttempts: 3,
			classification: classifyMcpFailure("needs-auth"),
			willRetry: false,
		});
		expect(r.get("cyrus-docs")).toMatchObject({
			state: "failed",
			failureClass: "permanent",
			reason: "needs-auth",
		});
	});

	it("summarizes counts and reports healthy only when nothing is broken", () => {
		const r = registry();
		r.recordConnected("cyrus-tools");
		r.recordSkipped("cyrus-docs", "needs-interactive-oauth");
		expect(r.summary()).toEqual({
			total: 2,
			connected: 1,
			connecting: 0,
			retrying: 0,
			degraded: 0,
			failed: 0,
			skipped: 1,
			healthy: true,
		});

		r.recordAttempt({
			server: "linear",
			attempt: 1,
			maxAttempts: 3,
			classification: classifyMcpFailure("timeout"),
			willRetry: true,
			nextDelayMs: 500,
		});
		expect(r.summary()).toMatchObject({
			total: 3,
			retrying: 1,
			healthy: false,
		});
	});

	it("counts declared servers as connecting", () => {
		const r = registry();
		r.declare("slack");
		expect(r.summary()).toMatchObject({ connecting: 1, healthy: false });
	});

	it("resets", () => {
		const r = registry();
		r.recordConnected("linear");
		r.reset();
		expect(r.snapshot()).toEqual([]);
	});

	it("records every bounded-retry attempt when wired to retryMcpConnection", async () => {
		const r = registry();
		const result = await retryMcpConnection(
			async () => {
				throw new Error("read ECONNRESET");
			},
			{
				server: "cyrus-tools",
				policy: { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 20 },
				sleep: async () => {},
				onAttempt: (attempt) => r.recordAttempt(attempt),
			},
		);

		expect(result.ok).toBe(false);
		// The registry ends on the terminal observation, and its attempt count
		// matches the number of attempts actually made.
		expect(r.get("cyrus-tools")).toMatchObject({
			state: "degraded",
			attempts: 3,
			failureClass: "transient",
		});
	});
});

describe("formatMcpServerHealth", () => {
	it("renders a healthy server plainly", () => {
		const r = registry();
		r.recordConnected("cyrus-tools");
		expect(formatMcpServerHealth(r.get("cyrus-tools")!)).toBe(
			"cyrus-tools — connected",
		);
	});

	it("renders a retry with attempt number and next delay", () => {
		const r = registry();
		r.recordAttempt({
			server: "linear",
			attempt: 2,
			maxAttempts: 5,
			classification: classifyMcpFailure("read ECONNRESET"),
			willRetry: true,
			nextDelayMs: 1000,
		});
		expect(formatMcpServerHealth(r.get("linear")!)).toBe(
			"linear — retrying, attempt 2, next retry in 1000ms, connection-reset: read ECONNRESET",
		);
	});

	it("renders a permanent failure without a retry hint", () => {
		const r = registry();
		r.recordFailure("cyrus-docs", classifyMcpFailure("needs-auth"));
		expect(formatMcpServerHealth(r.get("cyrus-docs")!)).toBe(
			"cyrus-docs — failed, after 1 attempt, needs-auth: needs-auth",
		);
	});

	it("renders a skip with its reason", () => {
		const r = registry();
		r.recordSkipped("cyrus-docs", "needs-interactive-oauth", "headless mode");
		expect(formatMcpServerHealth(r.get("cyrus-docs")!)).toBe(
			"cyrus-docs — skipped, needs-interactive-oauth: headless mode",
		);
	});
});

describe("formatMcpHealthDiagnostics", () => {
	it("returns nothing when no servers are tracked", () => {
		expect(formatMcpHealthDiagnostics(registry())).toEqual([]);
	});

	it("renders a summary line plus one line per server", () => {
		const r = registry();
		r.recordConnected("cyrus-tools");
		r.recordSkipped("cyrus-docs", "needs-interactive-oauth", "headless mode");
		r.recordAttempt({
			server: "linear",
			attempt: 2,
			maxAttempts: 5,
			classification: classifyMcpFailure("503 Service Unavailable"),
			willRetry: true,
			nextDelayMs: 1000,
		});

		expect(formatMcpHealthDiagnostics(r)).toEqual([
			"🔌 MCP servers: 1 connected, 1 retrying, 1 skipped",
			"   • cyrus-docs — skipped, needs-interactive-oauth: headless mode",
			"   • cyrus-tools — connected",
			"   • linear — retrying, attempt 2, next retry in 1000ms, server-error: 503 Service Unavailable",
		]);
	});

	it("accepts a custom label for per-session diagnostics", () => {
		const r = registry();
		r.recordConnected("cyrus-tools");
		expect(
			formatMcpHealthDiagnostics(r, { label: "MCP (session abc)" })[0],
		).toBe("🔌 MCP (session abc): 1 connected");
	});
});

describe("recordMcpInitStatuses", () => {
	it("maps the SDK's per-session statuses and returns only the unhealthy ones", () => {
		const r = registry();
		const unhealthy = recordMcpInitStatuses(
			r,
			[
				{ name: "cyrus-tools", status: "connected" },
				{ name: "slack", status: "pending" },
				{ name: "linear", status: "failed" },
				{ name: "cyrus-docs", status: "needs-auth" },
			],
			"session-1",
		);

		expect(r.get("cyrus-tools")).toMatchObject({
			state: "connected",
			source: "session-init",
			sessionId: "session-1",
		});
		expect(r.get("slack")?.state).toBe("connecting");
		expect(r.get("linear")).toMatchObject({
			state: "degraded",
			failureClass: "transient",
			reason: "connect-failed",
		});
		expect(r.get("cyrus-docs")).toMatchObject({
			state: "failed",
			failureClass: "permanent",
			reason: "needs-auth",
		});

		expect(unhealthy).toEqual([
			{
				name: "linear",
				classification: {
					class: "transient",
					reason: "connect-failed",
					detail: "failed",
				},
			},
			{
				name: "cyrus-docs",
				classification: {
					class: "permanent",
					reason: "needs-auth",
					detail: "needs-auth",
				},
			},
		]);
	});

	it("is case-insensitive about the SDK's status casing", () => {
		const r = registry();
		recordMcpInitStatuses(r, [{ name: "linear", status: "Connected" }]);
		expect(r.get("linear")?.state).toBe("connected");
	});

	it("tolerates an empty status string", () => {
		const r = registry();
		const unhealthy = recordMcpInitStatuses(r, [
			{ name: "linear", status: "" },
		]);
		expect(r.get("linear")?.state).toBe("degraded");
		expect(unhealthy[0]?.classification.reason).toBe("unknown");
	});
});
