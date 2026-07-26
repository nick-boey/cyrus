import type { ILogger, McpServerConfig } from "cyrus-core";
import { McpHealthRegistry } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import {
	McpHealthMonitor,
	type McpProbeFetch,
} from "../src/McpHealthMonitor.js";

interface Logged {
	level: "debug" | "info" | "warn" | "error";
	message: string;
}

function recordingLogger(): { logger: ILogger; lines: Logged[] } {
	const lines: Logged[] = [];
	const push = (level: Logged["level"]) => (message: string) => {
		lines.push({ level, message });
	};
	const logger = {
		debug: push("debug"),
		info: push("info"),
		warn: push("warn"),
		error: push("error"),
	} as unknown as ILogger;
	return { logger, lines };
}

const LINEAR: McpServerConfig = {
	type: "http",
	url: "https://mcp.linear.app/mcp",
	headers: { Authorization: "Bearer lin_api_x" },
};

const SLACK_STDIO: McpServerConfig = {
	command: "npx",
	args: ["-y", "slack-mcp-server@1.2.3"],
	env: { SLACK_MCP_XOXB_TOKEN: "xoxb" },
};

function monitor(options: {
	fetchFn: McpProbeFetch;
	registry?: McpHealthRegistry;
	logger?: ILogger;
	slept?: number[];
}) {
	const registry = options.registry ?? new McpHealthRegistry();
	const slept = options.slept ?? [];
	const instance = new McpHealthMonitor({
		registry,
		fetchFn: options.fetchFn,
		policy: { maxAttempts: 4, initialDelayMs: 100, maxDelayMs: 250 },
		sleep: async (ms) => {
			slept.push(ms);
		},
		...(options.logger ? { logger: options.logger } : {}),
	});
	return { instance, registry, slept };
}

const ok: McpProbeFetch = async () => ({ ok: true, status: 200 });

describe("McpHealthMonitor.probeServer", () => {
	it("records a reachable remote server as connected after one attempt", async () => {
		const fetchFn = vi.fn(ok);
		const { instance, registry } = monitor({ fetchFn });

		await expect(instance.probeServer("linear", LINEAR)).resolves.toBe(true);

		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(registry.get("linear")).toMatchObject({
			state: "connected",
			source: "probe",
		});
	});

	it("sends an MCP initialize handshake with the configured headers", async () => {
		const fetchFn = vi.fn(ok);
		const { instance } = monitor({ fetchFn });
		await instance.probeServer("linear", LINEAR);

		const [url, init] = fetchFn.mock.calls[0]!;
		expect(url).toBe("https://mcp.linear.app/mcp");
		expect(init.method).toBe("POST");
		expect(init.headers.Authorization).toBe("Bearer lin_api_x");
		// Streamable-HTTP servers require both media types.
		expect(init.headers.accept).toBe("application/json, text/event-stream");
		expect(JSON.parse(init.body)).toMatchObject({ method: "initialize" });
	});

	it("never spawns stdio servers — their health comes from session init only", async () => {
		const fetchFn = vi.fn(ok);
		const { instance, registry } = monitor({ fetchFn });

		await expect(instance.probeServer("slack", SLACK_STDIO)).resolves.toBe(
			true,
		);
		expect(fetchFn).not.toHaveBeenCalled();
		expect(registry.get("slack")).toBeUndefined();
	});

	it("retries a transient failure with bounded backoff and logs every attempt", async () => {
		const { logger, lines } = recordingLogger();
		const fetchFn = vi
			.fn<McpProbeFetch>()
			.mockResolvedValueOnce({
				ok: false,
				status: 503,
				statusText: "Unavailable",
			})
			.mockResolvedValueOnce({
				ok: false,
				status: 502,
				statusText: "Bad Gateway",
			})
			.mockResolvedValueOnce({ ok: true, status: 200 });
		const { instance, registry, slept } = monitor({ fetchFn, logger });

		await expect(instance.probeServer("linear", LINEAR)).resolves.toBe(true);

		expect(fetchFn).toHaveBeenCalledTimes(3);
		// 100, then min(200, 250) = 200 — the cap has not bitten yet.
		expect(slept).toEqual([100, 200]);
		expect(registry.get("linear")?.state).toBe("connected");

		const warnings = lines
			.filter((l) => l.level === "warn")
			.map((l) => l.message);
		expect(warnings).toHaveLength(2);
		expect(warnings[0]).toContain(
			'MCP server "linear" probe attempt 1/4 failed',
		);
		expect(warnings[0]).toContain("[transient/server-error]");
		expect(warnings[0]).toContain("retrying in 100ms");
		expect(warnings[1]).toContain("probe attempt 2/4 failed");
		expect(warnings[1]).toContain("retrying in 200ms");
	});

	it("gives up at the attempt cap and records the server as degraded", async () => {
		const { logger, lines } = recordingLogger();
		const fetchFn = vi.fn<McpProbeFetch>().mockResolvedValue({
			ok: false,
			status: 503,
			statusText: "Unavailable",
		});
		const { instance, registry, slept } = monitor({ fetchFn, logger });

		await expect(instance.probeServer("linear", LINEAR)).resolves.toBe(false);

		expect(fetchFn).toHaveBeenCalledTimes(4);
		expect(slept).toEqual([100, 200, 250]);
		expect(registry.get("linear")).toMatchObject({
			state: "degraded",
			attempts: 4,
			failureClass: "transient",
			reason: "server-error",
		});
		expect(lines.filter((l) => l.level === "warn").at(-1)?.message).toContain(
			"giving up (retry budget exhausted)",
		);
		expect(lines.filter((l) => l.level === "error").at(-1)?.message).toContain(
			'MCP server "linear" unreachable after 4 attempt(s)',
		);
	});

	it("does not retry an auth rejection — one attempt, marked failed", async () => {
		const { logger, lines } = recordingLogger();
		const fetchFn = vi.fn<McpProbeFetch>().mockResolvedValue({
			ok: false,
			status: 401,
			statusText: "Unauthorized",
		});
		const { instance, registry, slept } = monitor({ fetchFn, logger });

		await expect(instance.probeServer("linear", LINEAR)).resolves.toBe(false);

		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(slept).toEqual([]);
		expect(registry.get("linear")).toMatchObject({
			state: "failed",
			failureClass: "permanent",
			reason: "unauthorized",
		});
		expect(lines.filter((l) => l.level === "warn").at(0)?.message).toContain(
			"not retrying (permanent failure)",
		);
	});

	it("does not retry a 404 endpoint", async () => {
		const fetchFn = vi
			.fn<McpProbeFetch>()
			.mockResolvedValue({ ok: false, status: 404, statusText: "Not Found" });
		const { instance, registry } = monitor({ fetchFn });

		await instance.probeServer("cyrus-docs", {
			type: "http",
			url: "https://atcyrus.com/docs/mcp",
		});

		expect(fetchFn).toHaveBeenCalledTimes(1);
		expect(registry.get("cyrus-docs")).toMatchObject({
			state: "failed",
			reason: "endpoint-not-found",
		});
	});

	it("classifies a thrown network error as transient", async () => {
		const fetchFn = vi
			.fn<McpProbeFetch>()
			.mockRejectedValueOnce(
				Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }),
			)
			.mockResolvedValueOnce({ ok: true, status: 200 });
		const { instance, registry } = monitor({ fetchFn });

		await expect(instance.probeServer("linear", LINEAR)).resolves.toBe(true);
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(registry.get("linear")?.state).toBe("connected");
	});

	it("never stacks two retry loops for the same server", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchFn = vi.fn<McpProbeFetch>(async () => {
			await gate;
			return { ok: true, status: 200 };
		});
		const { instance } = monitor({ fetchFn });

		const first = instance.probeServer("linear", LINEAR);
		const second = instance.probeServer("linear", LINEAR);
		release?.();

		expect(await second).toBe(false);
		expect(await first).toBe(true);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});
});

describe("McpHealthMonitor.probeAll", () => {
	it("probes every remote server and skips the exempted ones", async () => {
		const fetchFn = vi.fn(ok);
		const { instance } = monitor({ fetchFn });

		await instance.probeAll(
			{
				linear: LINEAR,
				"cyrus-tools": {
					type: "http",
					url: "http://127.0.0.1:3456/mcp/cyrus-tools",
				},
				"cyrus-docs": { type: "http", url: "https://atcyrus.com/docs/mcp" },
				slack: SLACK_STDIO,
			},
			{ skip: ["cyrus-tools"] },
		);

		expect(fetchFn.mock.calls.map(([url]) => url).sort()).toEqual([
			"https://atcyrus.com/docs/mcp",
			"https://mcp.linear.app/mcp",
		]);
	});

	it("never probes a server already recorded as skipped for headless mode", async () => {
		const registry = new McpHealthRegistry();
		registry.recordSkipped("cyrus-docs", "needs-interactive-oauth");
		const fetchFn = vi.fn(ok);
		const { instance } = monitor({ fetchFn, registry });

		await instance.probeAll({
			"cyrus-docs": { type: "http", url: "https://atcyrus.com/docs/mcp" },
			linear: LINEAR,
		});

		expect(fetchFn.mock.calls.map(([url]) => url)).toEqual([
			"https://mcp.linear.app/mcp",
		]);
		expect(registry.get("cyrus-docs")?.state).toBe("skipped");
	});
});

describe("McpHealthMonitor.recordSessionInit", () => {
	it("records the SDK statuses and logs the per-session diagnostic", async () => {
		const { logger, lines } = recordingLogger();
		const fetchFn = vi.fn(ok);
		const { instance, registry } = monitor({ fetchFn, logger });

		const rendered = instance.recordSessionInit({
			sessionId: "sess-1",
			servers: [
				{ name: "cyrus-tools", status: "connected" },
				{ name: "linear", status: "connected" },
			],
		});

		expect(registry.get("cyrus-tools")).toMatchObject({
			state: "connected",
			source: "session-init",
			sessionId: "sess-1",
		});
		expect(rendered[0]).toBe("🔌 MCP servers (session sess-1): 2 connected");
		expect(
			lines.filter((l) => l.level === "info").map((l) => l.message),
		).toEqual(rendered);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("re-probes a transiently failed server with bounded backoff", async () => {
		const fetchFn = vi.fn(ok);
		const { instance, registry } = monitor({ fetchFn });

		instance.recordSessionInit({
			sessionId: "sess-1",
			servers: [{ name: "linear", status: "failed" }],
			configs: { linear: LINEAR },
		});
		// The re-probe is fire-and-forget; let its microtasks drain.
		await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
		await vi.waitFor(() =>
			expect(registry.get("linear")?.state).toBe("connected"),
		);
	});

	it("does NOT re-probe a permanent failure and says so", async () => {
		const { logger, lines } = recordingLogger();
		const fetchFn = vi.fn(ok);
		const { instance, registry } = monitor({ fetchFn, logger });

		instance.recordSessionInit({
			sessionId: "sess-1",
			servers: [{ name: "cyrus-docs", status: "needs-auth" }],
			configs: {
				"cyrus-docs": { type: "http", url: "https://atcyrus.com/docs/mcp" },
			},
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fetchFn).not.toHaveBeenCalled();
		expect(registry.get("cyrus-docs")).toMatchObject({
			state: "failed",
			failureClass: "permanent",
			reason: "needs-auth",
		});
		expect(lines.filter((l) => l.level === "error").at(0)?.message).toContain(
			"not retrying",
		);
	});

	it("records a status with no config to re-probe without throwing", async () => {
		const fetchFn = vi.fn(ok);
		const { instance, registry } = monitor({ fetchFn });

		instance.recordSessionInit({
			sessionId: "sess-1",
			servers: [{ name: "mystery", status: "failed" }],
		});

		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(fetchFn).not.toHaveBeenCalled();
		expect(registry.get("mystery")?.state).toBe("degraded");
	});

	it("returns nothing for an empty server list", () => {
		const { instance } = monitor({ fetchFn: vi.fn(ok) });
		expect(
			instance.recordSessionInit({ sessionId: "sess-1", servers: [] }),
		).toEqual([]);
	});
});

describe("McpHealthMonitor.diagnosticLines", () => {
	it("renders connected, retrying and skipped servers in one block", async () => {
		const registry = new McpHealthRegistry();
		registry.recordSkipped(
			"cyrus-docs",
			"needs-interactive-oauth",
			"headless container mode",
		);
		const fetchFn = vi.fn<McpProbeFetch>().mockResolvedValue({
			ok: false,
			status: 503,
		});
		const { instance } = monitor({ fetchFn, registry });
		await instance.probeServer("linear", LINEAR);
		registry.recordConnected("cyrus-tools", "session-init", "sess-1");

		expect(instance.diagnosticLines()).toEqual([
			"🔌 MCP servers: 1 connected, 1 degraded, 1 skipped",
			"   • cyrus-docs — skipped, needs-interactive-oauth: headless container mode",
			"   • cyrus-tools — connected",
			"   • linear — degraded, after 4 attempts, server-error: HTTP 503",
		]);
	});

	it("is empty before anything is observed", () => {
		const { instance } = monitor({ fetchFn: vi.fn(ok) });
		expect(instance.diagnosticLines()).toEqual([]);
	});
});
