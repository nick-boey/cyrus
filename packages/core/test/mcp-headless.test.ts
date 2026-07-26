import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "../src/agent-runner-types.js";
import {
	filterHeadlessSafeMcpServers,
	INTERACTIVE_OAUTH_MCP_SERVERS,
	isHeadlessContainerMode,
	isMcpServerPreconfigured,
	requiresInteractiveOAuth,
} from "../src/mcp/headless.js";

const CYRUS_DOCS: McpServerConfig = {
	type: "http",
	url: "https://atcyrus.com/docs/mcp",
};

const CYRUS_TOOLS: McpServerConfig = {
	type: "http",
	url: "http://127.0.0.1:3456/mcp/cyrus-tools",
	headers: { "x-cyrus-mcp-context-id": "repo-1:session-1" },
};

const LINEAR: McpServerConfig = {
	type: "http",
	url: "https://mcp.linear.app/mcp",
	headers: { Authorization: "Bearer lin_api_x" },
};

const SLACK: McpServerConfig = {
	command: "npx",
	args: ["-y", "slack-mcp-server@1.2.3", "--transport", "stdio"],
	env: { SLACK_MCP_XOXB_TOKEN: "xoxb-1" },
};

describe("isHeadlessContainerMode", () => {
	it("is true inside a worker container (issue key + device token both set)", () => {
		expect(
			isHeadlessContainerMode({
				CYRUS_ISSUE_KEY: "NOR-252",
				CYRUS_DEVICE_TOKEN: "tok-1",
			}),
		).toBe(true);
	});

	it("is false on a workstation running `cyrus start`", () => {
		expect(isHeadlessContainerMode({})).toBe(false);
		expect(isHeadlessContainerMode({ HOME: "/Users/alice" })).toBe(false);
	});

	it("is false for a teammate client device (device token but no issue key)", () => {
		expect(isHeadlessContainerMode({ CYRUS_DEVICE_TOKEN: "tok-1" })).toBe(
			false,
		);
	});

	it("is false when only the issue key is set — a hand-run shell export", () => {
		expect(isHeadlessContainerMode({ CYRUS_ISSUE_KEY: "NOR-252" })).toBe(false);
	});

	it("treats whitespace-only values as unset", () => {
		expect(
			isHeadlessContainerMode({
				CYRUS_ISSUE_KEY: "  ",
				CYRUS_DEVICE_TOKEN: "tok-1",
			}),
		).toBe(false);
		expect(
			isHeadlessContainerMode({
				CYRUS_ISSUE_KEY: "NOR-252",
				CYRUS_DEVICE_TOKEN: "",
			}),
		).toBe(false);
	});
});

describe("isMcpServerPreconfigured", () => {
	it("is true for a remote server carrying an Authorization header", () => {
		expect(isMcpServerPreconfigured(LINEAR)).toBe(true);
	});

	it("is case-insensitive about the header name", () => {
		expect(
			isMcpServerPreconfigured({
				type: "http",
				url: "https://example.com/mcp",
				headers: { authorization: "Bearer x" },
			}),
		).toBe(true);
	});

	it("is false when the Authorization header is present but empty", () => {
		expect(
			isMcpServerPreconfigured({
				type: "http",
				url: "https://example.com/mcp",
				headers: { Authorization: "   " },
			}),
		).toBe(false);
	});

	it("is false for a remote server with only non-auth headers", () => {
		expect(isMcpServerPreconfigured(CYRUS_TOOLS)).toBe(false);
	});

	it("is true for a stdio server carrying a credential in env", () => {
		expect(isMcpServerPreconfigured(SLACK)).toBe(true);
	});

	it("is false for a stdio server with no env at all", () => {
		expect(isMcpServerPreconfigured({ command: "some-mcp" })).toBe(false);
	});

	it("is true for an in-process sdk server", () => {
		expect(
			isMcpServerPreconfigured({
				type: "sdk",
				name: "cyrus-tools",
				instance: {} as never,
			}),
		).toBe(true);
	});
});

describe("requiresInteractiveOAuth", () => {
	it("flags cyrus-docs, the known offender", () => {
		expect(requiresInteractiveOAuth("cyrus-docs", CYRUS_DOCS)).toBe(true);
		expect(INTERACTIVE_OAUTH_MCP_SERVERS).toContain("cyrus-docs");
	});

	it("does not flag cyrus-docs once a credential is provisioned", () => {
		expect(
			requiresInteractiveOAuth("cyrus-docs", {
				type: "http",
				url: "https://atcyrus.com/docs/mcp",
				headers: { Authorization: "Bearer docs_token" },
			}),
		).toBe(false);
	});

	it("leaves unknown unauthenticated servers alone rather than guessing", () => {
		expect(
			requiresInteractiveOAuth("some-user-server", {
				type: "http",
				url: "https://internal.example.com/mcp",
			}),
		).toBe(false);
	});

	it("never flags the servers Cyrus authenticates itself", () => {
		expect(requiresInteractiveOAuth("linear", LINEAR)).toBe(false);
		expect(requiresInteractiveOAuth("cyrus-tools", CYRUS_TOOLS)).toBe(false);
		expect(requiresInteractiveOAuth("slack", SLACK)).toBe(false);
	});
});

describe("filterHeadlessSafeMcpServers", () => {
	const all: Record<string, McpServerConfig> = {
		linear: LINEAR,
		"cyrus-tools": CYRUS_TOOLS,
		"cyrus-docs": CYRUS_DOCS,
		slack: SLACK,
	};

	it("omits cyrus-docs in headless mode and keeps everything else", () => {
		const result = filterHeadlessSafeMcpServers(all, { headless: true });

		expect(Object.keys(result.servers).sort()).toEqual([
			"cyrus-tools",
			"linear",
			"slack",
		]);
		expect(result.omitted).toEqual([
			{
				name: "cyrus-docs",
				reason: "needs-interactive-oauth",
				detail:
					"omitted in headless container mode — this server authenticates via an interactive OAuth flow, which a container cannot complete",
			},
		]);
	});

	it("is a no-op outside headless mode", () => {
		const result = filterHeadlessSafeMcpServers(all, { headless: false });
		expect(Object.keys(result.servers).sort()).toEqual([
			"cyrus-docs",
			"cyrus-tools",
			"linear",
			"slack",
		]);
		expect(result.omitted).toEqual([]);
	});

	it("keeps a preconfigured cyrus-docs even in headless mode", () => {
		const result = filterHeadlessSafeMcpServers(
			{
				...all,
				"cyrus-docs": {
					type: "http",
					url: "https://atcyrus.com/docs/mcp",
					headers: { Authorization: "Bearer docs_token" },
				},
			},
			{ headless: true },
		);
		expect(result.servers["cyrus-docs"]).toBeDefined();
		expect(result.omitted).toEqual([]);
	});

	it("never mutates the input map", () => {
		const input = { ...all };
		filterHeadlessSafeMcpServers(input, { headless: true });
		expect(Object.keys(input).sort()).toEqual([
			"cyrus-docs",
			"cyrus-tools",
			"linear",
			"slack",
		]);
	});

	it("handles an empty config", () => {
		expect(filterHeadlessSafeMcpServers({}, { headless: true })).toEqual({
			servers: {},
			omitted: [],
		});
	});
});
