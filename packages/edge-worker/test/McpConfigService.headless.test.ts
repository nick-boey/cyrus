import type { IIssueTrackerService } from "cyrus-core";
import { McpHealthRegistry } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { McpConfigService } from "../src/McpConfigService.js";

/**
 * Headless-safe MCP server selection (TODO item 5).
 *
 * Inside an ephemeral worker container there is no browser and no user, so a
 * server that authenticates through an interactive OAuth flow can never
 * connect. `cyrus-docs` is the known offender — the live ACA drive found it
 * sitting in `needs-auth` for the whole session.
 *
 * Headless mode is detected from the env vars every container provider already
 * sets (`CYRUS_ISSUE_KEY` + `CYRUS_DEVICE_TOKEN`), never from a new flag.
 */

const CONTAINER_ENV: NodeJS.ProcessEnv = {
	CYRUS_ISSUE_KEY: "NOR-252",
	CYRUS_DEVICE_TOKEN: "device-token-abc",
};

function makeTracker(metadata: Record<string, unknown>): IIssueTrackerService {
	return {
		getPlatformType: () => "linear",
		getPlatformMetadata: () => metadata,
	} as unknown as IIssueTrackerService;
}

function service(options: {
	env?: NodeJS.ProcessEnv;
	linearToken?: string | null;
	tracker?: IIssueTrackerService;
	registry?: McpHealthRegistry;
}): McpConfigService {
	return new McpConfigService({
		getLinearTokenForWorkspace: () => options.linearToken ?? null,
		getIssueTracker: () =>
			options.tracker ??
			makeTracker({ transport: "router", workspaceId: "ws-1" }),
		getCyrusToolsMcpUrl: () => "http://127.0.0.1:3456/mcp/cyrus-tools",
		createCyrusToolsOptions: () => ({}),
		env: options.env ?? {},
		...(options.registry ? { healthRegistry: options.registry } : {}),
	});
}

describe("McpConfigService headless-mode server selection", () => {
	it("reports headless mode from the container env vars", () => {
		expect(service({ env: CONTAINER_ENV }).isHeadless()).toBe(true);
		expect(service({ env: {} }).isHeadless()).toBe(false);
	});

	it("omits cyrus-docs inside a container", () => {
		const config = service({ env: CONTAINER_ENV }).buildMcpConfig(
			"repo-1",
			"ws-1",
			"parent-1",
		);

		expect(config["cyrus-docs"]).toBeUndefined();
		// Everything Cyrus authenticates itself survives.
		expect(config["cyrus-tools"]).toBeDefined();
	});

	it("keeps cyrus-docs on a workstation", () => {
		const config = service({ env: {} }).buildMcpConfig(
			"repo-1",
			"ws-1",
			"parent-1",
		);
		expect(config["cyrus-docs"]).toEqual({
			type: "http",
			url: "https://atcyrus.com/docs/mcp",
		});
	});

	it("keeps cyrus-docs in a container when CYRUS_DOCS_MCP_TOKEN preconfigures it", () => {
		const config = service({
			env: { ...CONTAINER_ENV, CYRUS_DOCS_MCP_TOKEN: "docs_tok" },
		}).buildMcpConfig("repo-1", "ws-1", "parent-1");

		expect(config["cyrus-docs"]).toEqual({
			type: "http",
			url: "https://atcyrus.com/docs/mcp",
			headers: { Authorization: "Bearer docs_tok" },
		});
	});

	it("omits cyrus-docs from the docs-only CLI-mode config too", () => {
		const cliService = service({
			env: CONTAINER_ENV,
			tracker: makeTracker({ platform: "cli" }),
		});
		expect(cliService.buildMcpConfig("repo-1", "ws-1")).toEqual({});
	});

	it("still emits cyrus-docs in docs-only CLI mode on a workstation", () => {
		const cliService = service({
			env: {},
			tracker: makeTracker({ platform: "cli" }),
		});
		expect(Object.keys(cliService.buildMcpConfig("repo-1", "ws-1"))).toEqual([
			"cyrus-docs",
		]);
	});

	it("records the skip (with a reason) and declares the kept servers in the health registry", () => {
		const registry = new McpHealthRegistry({ now: () => 42 });
		service({
			env: CONTAINER_ENV,
			linearToken: "lin_api_static",
			registry,
		}).buildMcpConfig("repo-1", "ws-1", "parent-1");

		const byName = new Map(registry.snapshot().map((e) => [e.name, e]));
		expect(byName.get("cyrus-docs")).toMatchObject({
			state: "skipped",
			reason: "needs-interactive-oauth",
		});
		expect(byName.get("cyrus-tools")?.state).toBe("declared");
		expect(byName.get("linear")?.state).toBe("declared");
		expect(registry.summary()).toMatchObject({ total: 3, skipped: 1 });
	});

	it("shares one registry with the caller so diagnostics have a single source", () => {
		const registry = new McpHealthRegistry();
		const svc = service({ env: {}, registry });
		expect(svc.getHealthRegistry()).toBe(registry);
	});

	it("creates its own registry when none is injected", () => {
		const svc = service({ env: {} });
		svc.buildMcpConfig("repo-1", "ws-1", "parent-1");
		expect(svc.getHealthRegistry().snapshot().length).toBeGreaterThan(0);
	});
});

describe("McpConfigService connection hardening", () => {
	it("pins cyrus-tools as alwaysLoad with a bounded tool timeout", () => {
		const config = service({ env: {} }).buildMcpConfig(
			"repo-1",
			"ws-1",
			"parent-1",
		);
		// `MCP_CONNECTION_NONBLOCKING=true` otherwise makes turn-1 availability of
		// `mcp__cyrus-tools__*` a race; this server is served over loopback by the
		// same process, so blocking on its connect is free.
		expect(config["cyrus-tools"]).toMatchObject({
			alwaysLoad: true,
			timeout: 60_000,
		});
	});

	it("gives the remote Linear MCP a bounded tool timeout but does NOT block startup on it", () => {
		const config = service({
			env: {},
			linearToken: "lin_api_static",
		}).buildMcpConfig("repo-1", "ws-1", "parent-1");

		expect(config.linear).toMatchObject({ timeout: 60_000 });
		expect(
			(config.linear as Record<string, unknown>).alwaysLoad,
		).toBeUndefined();
	});
});

describe("McpConfigService.describeMcpServers", () => {
	it("returns the same inventory as buildMcpConfig without registering a context", () => {
		const svc = service({ env: {}, linearToken: "lin_api_static" });
		const described = svc.describeMcpServers("repo-1", "ws-1");

		expect(Object.keys(described).sort()).toEqual([
			"cyrus-docs",
			"cyrus-tools",
			"linear",
		]);

		// No context was minted, so the endpoint has nothing extra to serve.
		const contextId = (
			described["cyrus-tools"] as { headers: Record<string, string> }
		).headers["x-cyrus-mcp-context-id"] as string;
		expect(svc.getContext(contextId)).toBeUndefined();
	});

	it("still honours headless omission", () => {
		const described = service({ env: CONTAINER_ENV }).describeMcpServers(
			"repo-1",
			"ws-1",
		);
		expect(described["cyrus-docs"]).toBeUndefined();
	});
});
