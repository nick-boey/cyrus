/**
 * Headless-safe MCP server selection.
 *
 * Some MCP servers authenticate through an interactive OAuth flow: the client
 * opens a browser, a human consents, and a token comes back. That works on a
 * developer's laptop and is *impossible* inside an ephemeral worker container —
 * there is no browser, no user, and no way to persist the result. The live ACA
 * drive hit exactly this with `cyrus-docs` (`https://atcyrus.com/docs/mcp`,
 * configured with no `Authorization` header), which sat in `needs-auth` forever.
 *
 * `needs-auth` is classified `permanent` by {@link module:mcp/retry}, so it is
 * never retried — but it still burns a connect slot, pollutes the health report,
 * and (with `MCP_CONNECTION_NONBLOCKING=true`) leaves a server in the SDK's
 * server list that can never serve a tool call. So in headless container mode we
 * omit it up front instead.
 *
 * @module mcp/headless
 */

import type { McpServerConfig } from "../agent-runner-types.js";

/**
 * MCP servers Cyrus ships whose only auth path is an interactive OAuth flow.
 *
 * A server on this list is still emitted when its config carries a
 * pre-provisioned credential (see {@link isMcpServerPreconfigured}) — that is
 * the "or preconfigure" half of the fix: an operator who mints a token can keep
 * the server in headless mode.
 */
export const INTERACTIVE_OAUTH_MCP_SERVERS: readonly string[] = ["cyrus-docs"];

/**
 * Detect an ephemeral worker container (Local Docker or Azure Container Apps).
 *
 * Uses the signal that already exists rather than inventing a new flag:
 * `CYRUS_ISSUE_KEY` is a router-reserved env var (`RESERVED_ENV_KEYS` in
 * `packages/router/src/SecretStore.ts`) that is set by *every* container
 * provider — `LocalDockerProvider` and `AcaSandboxesProvider` both build their
 * env from `ContainerTargets.buildEnv()`, which always sets it — and is a hard
 * requirement of the container entrypoint (`REQUIRED_ENV_VARS` in
 * `apps/cli/src/commands/ContainerBootCommand.ts`). It is never set for a
 * `cyrus start` on a workstation or for a teammate client device, because one
 * `CYRUS_ISSUE_KEY` means "this whole process exists to serve one issue", which
 * is only ever true of a container.
 *
 * `CYRUS_DEVICE_TOKEN` is required alongside it so a hand-run `CYRUS_ISSUE_KEY=…`
 * in a developer shell does not accidentally trip headless mode.
 */
export function isHeadlessContainerMode(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const issueKey = env.CYRUS_ISSUE_KEY?.trim();
	const deviceToken = env.CYRUS_DEVICE_TOKEN?.trim();
	return Boolean(issueKey) && Boolean(deviceToken);
}

/**
 * Whether a config carries a credential of its own, making an interactive OAuth
 * flow unnecessary.
 *
 * - remote transports (`http`/`sse`): an `Authorization` header (any casing).
 * - `stdio`: any non-empty `env` entry — a stdio server's credential is
 *   necessarily passed that way.
 * - `sdk`: in-process, no external auth at all.
 */
export function isMcpServerPreconfigured(config: McpServerConfig): boolean {
	const record = config as unknown as Record<string, unknown>;

	if (record.type === "sdk") return true;

	const headers = record.headers;
	if (headers && typeof headers === "object") {
		for (const [key, value] of Object.entries(
			headers as Record<string, unknown>,
		)) {
			if (key.toLowerCase() !== "authorization") continue;
			if (typeof value === "string" && value.trim().length > 0) return true;
		}
	}

	if (typeof record.command === "string") {
		const env = record.env;
		if (env && typeof env === "object") {
			return Object.values(env as Record<string, unknown>).some(
				(value) => typeof value === "string" && value.trim().length > 0,
			);
		}
	}

	return false;
}

/**
 * Whether a server would need an interactive OAuth flow to connect.
 *
 * Deliberately conservative: only the explicitly-known-bad names in
 * {@link INTERACTIVE_OAUTH_MCP_SERVERS} qualify, and only when they arrive with
 * no credential. A user's own `.mcp.json` server that happens to be unauthed is
 * left alone — guessing wrong there would silently remove a working tool.
 */
export function requiresInteractiveOAuth(
	name: string,
	config: McpServerConfig,
): boolean {
	if (!INTERACTIVE_OAUTH_MCP_SERVERS.includes(name)) return false;
	return !isMcpServerPreconfigured(config);
}

/** One server dropped by {@link filterHeadlessSafeMcpServers}. */
export interface OmittedMcpServer {
	name: string;
	/** Stable short reason, suitable for the health registry. */
	reason: string;
	/** Human-readable explanation for diagnostics. */
	detail: string;
}

export interface HeadlessMcpFilterResult {
	/** The servers that survived. A new object; the input is never mutated. */
	servers: Record<string, McpServerConfig>;
	omitted: OmittedMcpServer[];
}

/**
 * Drop MCP servers that cannot possibly authenticate in the current mode.
 *
 * A no-op when `headless` is false, so a workstation keeps `cyrus-docs` and its
 * locally-cached OAuth token.
 */
export function filterHeadlessSafeMcpServers(
	servers: Record<string, McpServerConfig>,
	options: { headless: boolean },
): HeadlessMcpFilterResult {
	if (!options.headless) {
		return { servers: { ...servers }, omitted: [] };
	}

	const kept: Record<string, McpServerConfig> = {};
	const omitted: OmittedMcpServer[] = [];

	for (const [name, config] of Object.entries(servers)) {
		if (requiresInteractiveOAuth(name, config)) {
			omitted.push({
				name,
				reason: "needs-interactive-oauth",
				detail:
					"omitted in headless container mode — this server authenticates via an interactive OAuth flow, which a container cannot complete",
			});
			continue;
		}
		kept[name] = config;
	}

	return { servers: kept, omitted };
}
