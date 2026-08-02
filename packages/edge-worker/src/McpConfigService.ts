import type { LinearClient } from "@linear/sdk";
import type { McpServerConfig } from "cyrus-claude-runner";
import type { IIssueTrackerService, RepositoryConfig } from "cyrus-core";
import {
	filterHeadlessSafeMcpServers,
	isHeadlessContainerMode,
	McpHealthRegistry,
} from "cyrus-core";
import {
	type CyrusToolsOptions,
	createCyrusToolsServer,
} from "cyrus-mcp-tools";

type CyrusToolsMcpContextEntry = {
	contextId: string;
	/** Present in token-authenticated Linear mode; absent in router mode. */
	linearToken?: string;
	/** Present in token-authenticated Linear mode; absent in router mode. */
	linearClient?: LinearClient;
	/** Present in router mode: backs cyrus-tools over the tracker interface. */
	issueTracker?: IIssueTrackerService;
	parentSessionId?: string;
	prebuiltServer?: ReturnType<typeof createCyrusToolsServer>;
	createdAt: number;
};

/**
 * Dependencies injected into McpConfigService from the EdgeWorker.
 */
export interface McpConfigServiceDeps {
	/** Retrieve the stored Linear API token for a workspace */
	getLinearTokenForWorkspace: (workspaceId: string) => string | null;
	/** Retrieve the issue tracker service for a workspace (must expose getClient()) */
	getIssueTracker: (
		workspaceId: string,
	) => (IIssueTrackerService & { getClient?: () => LinearClient }) | undefined;
	/** Get the HTTP URL where the cyrus-tools MCP endpoint is registered */
	getCyrusToolsMcpUrl: () => string;
	/** Factory that creates CyrusToolsOptions with session callbacks */
	createCyrusToolsOptions: (parentSessionId?: string) => CyrusToolsOptions;
	/**
	 * Environment used for headless-container detection. Injected so tests can
	 * exercise both modes without mutating `process.env`. Defaults to
	 * `process.env`.
	 */
	env?: NodeJS.ProcessEnv;
	/**
	 * Registry that records which MCP servers were configured and which were
	 * skipped. Shared with `McpHealthMonitor` so startup/session diagnostics
	 * report one consistent view. A private registry is created when omitted.
	 */
	healthRegistry?: McpHealthRegistry;
}

/**
 * Per-server tool-call timeout for the MCP servers Cyrus itself depends on.
 *
 * Without it these servers inherit `MCP_TOOL_TIMEOUT` (or the SDK default), so
 * a tool call against a half-dead transport can hang far longer than a session
 * turn should. 60s is generous for a Linear mutation and short enough that a
 * dead connection surfaces as a tool error the agent can react to.
 */
const CYRUS_MCP_TOOL_TIMEOUT_MS = 60_000;

/**
 * Single source of truth for MCP server configuration assembly.
 *
 * Handles:
 * - Building inline MCP server configs (Linear, cyrus-tools, Slack)
 * - Merging file-based MCP config paths from repositories
 * - Cyrus-tools MCP context lifecycle management
 *
 * Both EdgeWorker (issue sessions) and ChatSessionHandler (chat sessions)
 * consume this service instead of duplicating MCP config logic.
 */
export class McpConfigService {
	private deps: McpConfigServiceDeps;
	private contexts = new Map<string, CyrusToolsMcpContextEntry>();
	private readonly env: NodeJS.ProcessEnv;
	private readonly healthRegistry: McpHealthRegistry;

	constructor(deps: McpConfigServiceDeps) {
		this.deps = deps;
		this.env = deps.env ?? process.env;
		this.healthRegistry = deps.healthRegistry ?? new McpHealthRegistry();
	}

	/**
	 * The MCP connection-health registry backing startup/session diagnostics.
	 * Every server this service emits is declared here, and every server it
	 * omits is recorded with its reason.
	 */
	getHealthRegistry(): McpHealthRegistry {
		return this.healthRegistry;
	}

	/**
	 * Whether this process is an ephemeral worker container (Local Docker / ACA)
	 * and therefore cannot complete an interactive OAuth flow.
	 */
	isHeadless(): boolean {
		return isHeadlessContainerMode(this.env);
	}

	/**
	 * Apply headless-safe server selection and record the outcome in the health
	 * registry, so `cyrus start`'s banner and the per-session diagnostics both
	 * show which servers were configured and which were deliberately dropped.
	 */
	private finalizeMcpConfig(
		servers: Record<string, McpServerConfig>,
	): Record<string, McpServerConfig> {
		const { servers: kept, omitted } = filterHeadlessSafeMcpServers(servers, {
			headless: this.isHeadless(),
		});

		for (const entry of omitted) {
			this.healthRegistry.recordSkipped(entry.name, entry.reason, entry.detail);
		}
		for (const name of Object.keys(kept)) {
			this.healthRegistry.declare(name);
		}

		return kept;
	}

	/**
	 * The optional documentation MCP server.
	 *
	 * Authenticates via an interactive OAuth flow, which a headless container
	 * cannot complete — `filterHeadlessSafeMcpServers` drops it there unless an
	 * operator provisions `CYRUS_DOCS_MCP_TOKEN`, in which case it is emitted
	 * with a bearer header and kept (the "preconfigure" escape hatch).
	 */
	private buildCyrusDocsServer(): McpServerConfig {
		const token = this.env.CYRUS_DOCS_MCP_TOKEN?.trim();
		return {
			type: "http",
			url: "https://atcyrus.com/docs/mcp",
			...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
		};
	}

	/**
	 * Build MCP configuration with automatic Linear server injection and cyrus-tools over Fastify MCP.
	 * Workspace-level servers (Linear, cyrus-tools, Slack) are configured once using workspace-level token.
	 *
	 * Whether the agent can actually CALL into any of these servers is gated
	 * by the per-platform allowed-tools array (`teams.{linear,slack,github}_allowed_tools`),
	 * not by anything done here — so it's safe to always spin them up when
	 * their underlying transport credentials exist (Slack inline via
	 * `SLACK_BOT_TOKEN`, Linear via the workspace's Linear token, etc.).
	 *
	 * @param repoId - Repository ID for MCP context scoping
	 * @param linearWorkspaceId - Linear workspace ID (from webhook.organizationId or repo config)
	 * @param parentSessionId - Parent session ID for cyrus-tools context
	 */
	buildMcpConfig(
		repoId: string,
		linearWorkspaceId: string,
		parentSessionId?: string,
	): Record<string, McpServerConfig> {
		return this.assembleMcpConfig(repoId, linearWorkspaceId, parentSessionId, {
			registerContext: true,
		});
	}

	/**
	 * The same server inventory {@link buildMcpConfig} would produce, but with NO
	 * side effects: no cyrus-tools MCP context is registered and no SDK server is
	 * prebuilt.
	 *
	 * Used by the startup health probe, which wants to know *what* is configured
	 * (and to record it in the health registry) without minting a throwaway
	 * context that the endpoint would then have to serve.
	 */
	describeMcpServers(
		repoId: string,
		linearWorkspaceId: string,
	): Record<string, McpServerConfig> {
		return this.assembleMcpConfig(repoId, linearWorkspaceId, undefined, {
			registerContext: false,
		});
	}

	private assembleMcpConfig(
		repoId: string,
		linearWorkspaceId: string,
		parentSessionId: string | undefined,
		options: { registerContext: boolean },
	): Record<string, McpServerConfig> {
		const contextId = this.buildContextId(repoId, parentSessionId);

		// Prebuild one SDK server for this context so callback wiring remains deterministic.
		const linearToken = this.deps.getLinearTokenForWorkspace(linearWorkspaceId);
		const issueTracker = this.deps.getIssueTracker(linearWorkspaceId);
		// Router mode: the device holds no Linear token, but a router-backed
		// tracker exists — back cyrus-tools with the tracker interface instead.
		const isRouterTracker =
			issueTracker?.getPlatformMetadata?.().transport === "router";

		let linearClient: LinearClient | undefined;
		let trackerBacking: IIssueTrackerService | undefined;
		let prebuiltServer: ReturnType<typeof createCyrusToolsServer> | undefined;
		if (linearToken && issueTracker?.getClient) {
			// Token-authenticated Linear mode — back cyrus-tools with the SDK client.
			linearClient = issueTracker.getClient();
			if (options.registerContext) {
				prebuiltServer = createCyrusToolsServer(
					linearClient,
					this.deps.createCyrusToolsOptions(parentSessionId),
				);
			}
		} else if (isRouterTracker && issueTracker) {
			// Router mode — back cyrus-tools with the tracker interface (no token).
			trackerBacking = issueTracker;
			if (options.registerContext) {
				prebuiltServer = createCyrusToolsServer(
					{ issueTracker },
					this.deps.createCyrusToolsOptions(parentSessionId),
				);
			}
		} else {
			// CLI platform mode / unconfigured — no cyrus-tools backing available.
			return this.finalizeMcpConfig({
				"cyrus-docs": this.buildCyrusDocsServer(),
			});
		}

		if (options.registerContext) {
			this.contexts.set(contextId, {
				contextId,
				...(linearToken ? { linearToken } : {}),
				...(linearClient ? { linearClient } : {}),
				...(trackerBacking ? { issueTracker: trackerBacking } : {}),
				parentSessionId,
				prebuiltServer,
				createdAt: Date.now(),
			});
			this.pruneContexts();
		}

		const cyrusToolsAuthorizationHeader = this.getAuthorizationHeaderValue();

		// Workspace-level MCP servers — configured once regardless of repo count.
		// The token-authenticated official Linear MCP server (https://linear.app/docs/mcp)
		// is emitted only when we actually hold a Linear token. Router-mode
		// devices usually have none (users install the Linear MCP locally with
		// their own OAuth), so it is omitted — UNLESS an operator provisions a
		// static per-user Linear token (LINEAR_API_TOKEN → linearWorkspaces) for
		// a container, in which case getLinearTokenForWorkspace returns it and
		// the server IS emitted here.
		const mcpConfig: Record<string, McpServerConfig> = {
			...(linearToken
				? {
						linear: {
							type: "http",
							url: "https://mcp.linear.app/mcp",
							headers: {
								Authorization: `Bearer ${linearToken}`,
							},
							// Bound how long a Linear tool call can hang on a
							// half-dead transport. Deliberately NOT `alwaysLoad`:
							// that would block session start on a round trip to
							// mcp.linear.app (up to the SDK's 5s connect cap) on
							// every single turn, and Linear tools are reached via
							// tool search rather than named in turn-1 prompts.
							timeout: CYRUS_MCP_TOOL_TIMEOUT_MS,
						} satisfies McpServerConfig,
					}
				: {}),
			"cyrus-tools": {
				type: "http",
				url: this.deps.getCyrusToolsMcpUrl(),
				headers: {
					"x-cyrus-mcp-context-id": contextId,
					...(cyrusToolsAuthorizationHeader
						? {
								Authorization: cyrusToolsAuthorizationHeader,
							}
						: {}),
				},
				timeout: CYRUS_MCP_TOOL_TIMEOUT_MS,
				// `MCP_CONNECTION_NONBLOCKING=true` (see CYRUS_SESSION_ENV) makes
				// every MCP server connect in the background, so whether
				// `mcp__cyrus-tools__*` is available on turn 1 is a race. It is
				// not an optional server: Cyrus's own prompts name these tools
				// directly (see SlackChatAdapter / failureModePromptAddendum), and
				// it is served by this very process over loopback, so blocking on
				// its connect costs microseconds rather than a network round trip.
				alwaysLoad: true,
			},
			"cyrus-docs": this.buildCyrusDocsServer(),
		};

		// Inject the Slack MCP server whenever SLACK_BOT_TOKEN is available —
		// per-platform availability is enforced upstream by the allowed-tools
		// array. https://github.com/korotovsky/slack-mcp-server
		const slackBotToken = process.env.SLACK_BOT_TOKEN?.trim();
		if (slackBotToken) {
			mcpConfig.slack = {
				command: "npx",
				args: ["-y", "slack-mcp-server@1.2.3", "--transport", "stdio"],
				env: {
					SLACK_MCP_XOXB_TOKEN: slackBotToken,
				},
				timeout: CYRUS_MCP_TOOL_TIMEOUT_MS,
			};
		}

		return this.finalizeMcpConfig(mcpConfig);
	}

	/**
	 * Merge mcpConfigPath from multiple repositories into a single list.
	 * For same-name .mcp.json servers across repos, last wins (handled by Claude's merge behavior).
	 */
	buildMergedMcpConfigPath(
		repositories: RepositoryConfig | RepositoryConfig[],
	): string | string[] | undefined {
		const repoArray = Array.isArray(repositories)
			? repositories
			: [repositories];

		if (repoArray.length === 1) {
			return repoArray[0]!.mcpConfigPath;
		}

		// Collect all mcpConfigPaths from each repo into a flat list
		const allPaths: string[] = [];
		for (const repo of repoArray) {
			if (!repo.mcpConfigPath) continue;
			if (Array.isArray(repo.mcpConfigPath)) {
				allPaths.push(...repo.mcpConfigPath);
			} else {
				allPaths.push(repo.mcpConfigPath);
			}
		}

		if (allPaths.length === 0) return undefined;
		if (allPaths.length === 1) return allPaths[0];
		return allPaths;
	}

	/**
	 * Look up a stored cyrus-tools MCP context by its ID.
	 * Used by the MCP endpoint handler to retrieve prebuilt servers.
	 */
	getContext(contextId: string): CyrusToolsMcpContextEntry | undefined {
		return this.contexts.get(contextId);
	}

	/**
	 * Clear the prebuilt server from a context entry (after first use).
	 */
	clearPrebuiltServer(contextId: string): void {
		const context = this.contexts.get(contextId);
		if (context) {
			context.prebuiltServer = undefined;
		}
	}

	/**
	 * Clear all stored contexts. Used during shutdown.
	 */
	clearAllContexts(): void {
		this.contexts.clear();
	}

	/**
	 * Get the authorization header value for cyrus-tools MCP requests.
	 */
	getAuthorizationHeaderValue(): string | undefined {
		const apiKey = process.env.CYRUS_API_KEY?.trim();
		if (!apiKey) {
			return undefined;
		}
		return `Bearer ${apiKey}`;
	}

	/**
	 * Validate an incoming authorization header against the expected value.
	 */
	isAuthorizationValid(rawAuthorizationHeader: unknown): boolean {
		const expectedHeader = this.getAuthorizationHeaderValue();
		if (!expectedHeader) {
			return true;
		}

		const authorizationHeader = Array.isArray(rawAuthorizationHeader)
			? rawAuthorizationHeader[0]
			: rawAuthorizationHeader;

		return authorizationHeader === expectedHeader;
	}

	private buildContextId(repoId: string, parentSessionId?: string): string {
		if (parentSessionId) {
			return `${repoId}:${parentSessionId}`;
		}

		return `${repoId}:anon:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
	}

	private pruneContexts(maxEntries: number = 500): void {
		if (this.contexts.size <= maxEntries) {
			return;
		}

		const entriesByAge = Array.from(this.contexts.entries()).sort(
			(a, b) => a[1].createdAt - b[1].createdAt,
		);

		const pruneCount = this.contexts.size - maxEntries;
		for (let i = 0; i < pruneCount; i++) {
			const entry = entriesByAge[i];
			if (!entry) {
				break;
			}
			const [contextId] = entry;
			this.contexts.delete(contextId);
		}
	}
}
