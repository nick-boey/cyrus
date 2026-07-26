import type { IIssueTrackerService } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { McpConfigService } from "../src/McpConfigService.js";

/**
 * Task 12 / Codex finding 6 — by default in router mode the device holds no
 * Linear token, so `getLinearTokenForWorkspace` returns null. cyrus-tools must
 * still be exposed (backed by the tracker interface), while the
 * token-authenticated official Linear MCP server must NOT be emitted (users
 * install the Linear MCP locally with their own OAuth — the "two planes"
 * split). UNLESS an operator provisions a static per-user Linear token
 * (LINEAR_API_TOKEN → linearWorkspaces) for a container, in which case
 * `getLinearTokenForWorkspace` returns it and the Linear MCP server IS
 * emitted — see the positive test below.
 */

function makeTracker(metadata: Record<string, unknown>): IIssueTrackerService {
	return {
		getPlatformType: () => "linear",
		getPlatformMetadata: () => metadata,
	} as unknown as IIssueTrackerService;
}

describe("McpConfigService router mode", () => {
	it("emits cyrus-tools but NOT the app-token Linear MCP entry when a router tracker exists with no token", () => {
		const tracker = makeTracker({ transport: "router", workspaceId: "ws-1" });
		const service = new McpConfigService({
			getLinearTokenForWorkspace: () => null,
			getIssueTracker: () => tracker,
			getCyrusToolsMcpUrl: () => "http://127.0.0.1:3456/mcp/cyrus-tools",
			createCyrusToolsOptions: () => ({}),
		});

		const config = service.buildMcpConfig("repo-1", "ws-1", "parent-1");

		expect(config["cyrus-tools"]).toBeDefined();
		expect(config["cyrus-docs"]).toBeDefined();
		// The token-authenticated official Linear MCP server must be absent.
		expect(config.linear).toBeUndefined();
	});

	it("returns docs-only (no cyrus-tools, no linear) for CLI mode with no token", () => {
		const cliTracker = makeTracker({ platform: "cli" });
		const service = new McpConfigService({
			getLinearTokenForWorkspace: () => null,
			getIssueTracker: () => cliTracker,
			getCyrusToolsMcpUrl: () => "http://127.0.0.1:3456/mcp/cyrus-tools",
			createCyrusToolsOptions: () => ({}),
		});

		const config = service.buildMcpConfig("repo-1", "ws-1");

		expect(config["cyrus-tools"]).toBeUndefined();
		expect(config.linear).toBeUndefined();
		expect(config["cyrus-docs"]).toBeDefined();
	});

	it("emits the token-authenticated Linear MCP in router mode when a static per-user token is provisioned", () => {
		const tracker = makeTracker({ transport: "router", workspaceId: "ws-1" });
		const service = new McpConfigService({
			getLinearTokenForWorkspace: () => "lin_api_static",
			getIssueTracker: () => tracker,
			getCyrusToolsMcpUrl: () => "http://127.0.0.1:3456/mcp/cyrus-tools",
			createCyrusToolsOptions: () => ({}),
		});

		const config = service.buildMcpConfig("repo-1", "ws-1", "parent-1");

		expect(config["cyrus-tools"]).toBeDefined();
		expect(config.linear).toEqual({
			type: "http",
			url: "https://mcp.linear.app/mcp",
			headers: { Authorization: "Bearer lin_api_static" },
		});
	});
});
