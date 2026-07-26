import { createLogger, LogLevel } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

vi.mock("../src/sandbox-requirements", () => ({
	checkLinuxSandboxRequirements: vi.fn(() => ({
		supported: true,
		platform: "linux",
		failures: [],
	})),
	logSandboxRequirementFailures: vi.fn(),
	resetSandboxRequirementsCacheForTesting: vi.fn(),
}));

vi.mock("fs", () => ({
	mkdirSync: vi.fn(),
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ""),
	createWriteStream: vi.fn(() => ({
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
	})),
	writeFileSync: vi.fn(),
}));

vi.mock("os", () => ({
	homedir: vi.fn(() => "/mock/home"),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRunner } from "../src/ClaudeRunner";
import type { ClaudeRunnerConfig, McpServerStatusReport } from "../src/types";

const mockQuery = vi.mocked(query);

/**
 * The SDK reports MCP connection state exactly once per session, in the
 * `system`/`init` message. Everything downstream (health registry, startup
 * banner, bounded re-probe) hangs off this one message — `case "system":` used
 * to be a silent no-op, which is why the live ACA drive had no visibility into
 * `linear`/`cyrus-tools` reconnecting.
 */
function mockInitQuery(
	mcpServers: McpServerStatusReport[] | undefined,
	sessionId = "session-abc",
): void {
	mockQuery.mockImplementation(async function* () {
		yield {
			type: "system",
			subtype: "init",
			session_id: sessionId,
			tools: [],
			...(mcpServers === undefined ? {} : { mcp_servers: mcpServers }),
		} as any;
		yield {
			type: "assistant",
			message: { content: [{ type: "text", text: "Done" }] },
			parent_tool_use_id: null,
			session_id: sessionId,
		} as any;
	});
}

function makeConfig(
	overrides: Partial<ClaudeRunnerConfig> = {},
): ClaudeRunnerConfig & {
	logger: ReturnType<typeof createLogger> & {
		info: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
	};
} {
	const logger = createLogger({
		component: "ClaudeRunner",
		level: LogLevel.INFO,
	});
	logger.info = vi.fn();
	logger.warn = vi.fn();
	return {
		workingDirectory: "/repo-a",
		cyrusHome: "/tmp/test-cyrus-home",
		logger,
		...overrides,
	} as never;
}

describe("ClaudeRunner MCP server status reporting", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("forwards the init statuses to onMcpServerStatus with the session id", async () => {
		const onMcpServerStatus = vi.fn();
		mockInitQuery([
			{ name: "cyrus-tools", status: "connected" },
			{ name: "linear", status: "connected" },
		]);

		const runner = new ClaudeRunner(makeConfig({ onMcpServerStatus }));
		await runner.start("test");

		expect(onMcpServerStatus).toHaveBeenCalledTimes(1);
		expect(onMcpServerStatus).toHaveBeenCalledWith(
			[
				{ name: "cyrus-tools", status: "connected" },
				{ name: "linear", status: "connected" },
			],
			"session-abc",
		);
	});

	it("emits an mcp-server-status event as well", async () => {
		const listener = vi.fn();
		mockInitQuery([{ name: "linear", status: "failed" }]);

		const runner = new ClaudeRunner(makeConfig());
		runner.on("mcp-server-status", listener);
		await runner.start("test");

		expect(listener).toHaveBeenCalledWith(
			[{ name: "linear", status: "failed" }],
			"session-abc",
		);
	});

	it("logs at info level when every server connected", async () => {
		const config = makeConfig();
		mockInitQuery([{ name: "cyrus-tools", status: "connected" }]);

		await new ClaudeRunner(config).start("test");

		expect(config.logger.info).toHaveBeenCalledWith(
			"MCP servers for session session-abc: cyrus-tools=connected",
		);
		expect(config.logger.warn).not.toHaveBeenCalled();
	});

	it("logs at warn level when any server is not connected", async () => {
		const config = makeConfig();
		mockInitQuery([
			{ name: "cyrus-tools", status: "connected" },
			{ name: "cyrus-docs", status: "needs-auth" },
		]);

		await new ClaudeRunner(config).start("test");

		expect(config.logger.warn).toHaveBeenCalledWith(
			"MCP servers for session session-abc: cyrus-tools=connected, cyrus-docs=needs-auth",
		);
	});

	it("stays silent when the init message carries no MCP servers", async () => {
		const onMcpServerStatus = vi.fn();
		mockInitQuery(undefined);

		await new ClaudeRunner(makeConfig({ onMcpServerStatus })).start("test");

		expect(onMcpServerStatus).not.toHaveBeenCalled();
	});

	it("stays silent for an empty MCP server list", async () => {
		const onMcpServerStatus = vi.fn();
		mockInitQuery([]);

		await new ClaudeRunner(makeConfig({ onMcpServerStatus })).start("test");

		expect(onMcpServerStatus).not.toHaveBeenCalled();
	});

	it("does not let a throwing callback abort the session", async () => {
		const config = makeConfig({
			onMcpServerStatus: () => {
				throw new Error("diagnostic blew up");
			},
		});
		mockInitQuery([{ name: "linear", status: "connected" }]);

		const runner = new ClaudeRunner(config);
		await expect(runner.start("test")).resolves.toBeDefined();
		expect(config.logger.warn).toHaveBeenCalledWith(
			"onMcpServerStatus callback threw:",
			expect.any(Error),
		);
	});
});
