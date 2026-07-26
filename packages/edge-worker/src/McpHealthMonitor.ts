import {
	createLogger,
	formatMcpHealthDiagnostics,
	type ILogger,
	type McpHealthRegistry,
	type McpInitServerStatus,
	type McpRetryPolicy,
	type McpServerConfig,
	recordMcpInitStatuses,
	retryMcpConnection,
} from "cyrus-core";

/**
 * Minimal `fetch` shape used for MCP reachability probes. Injected so tests
 * never touch the network.
 */
export type McpProbeFetch = (
	url: string,
	init: {
		method: string;
		headers: Record<string, string>;
		body: string;
		signal?: AbortSignal;
	},
) => Promise<{ ok: boolean; status: number; statusText?: string }>;

export interface McpHealthMonitorDeps {
	/** Shared with `McpConfigService` so both write to one view of health. */
	registry: McpHealthRegistry;
	logger?: ILogger;
	/** Defaults to global `fetch`. */
	fetchFn?: McpProbeFetch;
	/** Bounded-backoff policy override. */
	policy?: Partial<McpRetryPolicy>;
	/** Injectable sleep so tests assert delays without waiting. */
	sleep?: (ms: number) => Promise<void>;
	/** Per-attempt probe timeout. Defaults to 5s (the SDK's connect cap). */
	probeTimeoutMs?: number;
}

/** JSON-RPC `initialize` body — the cheapest legitimate MCP handshake. */
function initializeRequestBody(): string {
	return JSON.stringify({
		jsonrpc: "2.0",
		id: "cyrus-health-probe",
		method: "initialize",
		params: {
			protocolVersion: "2025-06-18",
			capabilities: {},
			clientInfo: { name: "cyrus-mcp-health-probe", version: "1" },
		},
	});
}

/**
 * Watches the health of the MCP servers Cyrus configures.
 *
 * Two inputs, one output:
 *
 * - {@link probeAll} actively handshakes remote (`http`/`sse`) servers with
 *   bounded exponential backoff. Runs at EdgeWorker startup so an operator sees
 *   "linear: connected / cyrus-docs: skipped" before the first issue arrives,
 *   instead of discovering a dead server mid-session.
 * - {@link recordSessionInit} folds in the SDK's own per-session
 *   `system`/`init` `mcp_servers` report and — for servers the SDK says are
 *   *transiently* broken — kicks a bounded background re-probe. Permanent
 *   failures (rejected token, `needs-auth`, missing binary) are recorded and
 *   left alone: retrying cannot fix them and would only add log noise.
 *
 * Both paths write into the same {@link McpHealthRegistry} that
 * `McpConfigService` declares servers into, so {@link diagnosticLines} renders
 * one consistent picture.
 *
 * stdio servers are never probed: spawning the child process a second time just
 * to see whether it starts is both expensive and misleading (the SDK's own spawn
 * is the only one that matters). Their health comes from `session-init` only.
 */
export class McpHealthMonitor {
	private readonly registry: McpHealthRegistry;
	private readonly logger: ILogger;
	private readonly fetchFn: McpProbeFetch;
	private readonly policy: Partial<McpRetryPolicy> | undefined;
	private readonly sleep: ((ms: number) => Promise<void>) | undefined;
	private readonly probeTimeoutMs: number;
	/** Servers with a re-probe already in flight — never stack retry loops. */
	private readonly inFlight = new Set<string>();

	constructor(deps: McpHealthMonitorDeps) {
		this.registry = deps.registry;
		this.logger =
			deps.logger ?? createLogger({ component: "McpHealthMonitor" });
		this.fetchFn =
			deps.fetchFn ??
			((url, init) =>
				fetch(
					url,
					init as RequestInit,
				) as unknown as ReturnType<McpProbeFetch>);
		this.policy = deps.policy;
		this.sleep = deps.sleep;
		this.probeTimeoutMs = deps.probeTimeoutMs ?? 5_000;
	}

	/** Diagnostic lines for the startup banner / per-session log. */
	diagnosticLines(label?: string): string[] {
		return formatMcpHealthDiagnostics(
			this.registry,
			label === undefined ? {} : { label },
		);
	}

	/**
	 * Probe every remote server in `servers`, in parallel. Resolves once all
	 * probes have settled; callers that must not block on the network should not
	 * await it (EdgeWorker.start() deliberately does not).
	 *
	 * Servers already recorded as `skipped` (headless omissions) are never
	 * probed, and `options.skip` lets the caller exempt servers whose handshake
	 * needs per-session state a probe cannot supply.
	 */
	async probeAll(
		servers: Record<string, McpServerConfig>,
		options: { skip?: readonly string[] } = {},
	): Promise<void> {
		const skip = new Set(options.skip ?? []);
		await Promise.all(
			Object.entries(servers)
				.filter(([name]) => !skip.has(name))
				.filter(([name]) => this.registry.get(name)?.state !== "skipped")
				.map(([name, config]) => this.probeServer(name, config)),
		);
	}

	/**
	 * Probe one server with bounded exponential backoff, recording every attempt
	 * in the registry and the log. Returns true when the server answered.
	 *
	 * Non-remote (stdio/sdk) servers resolve `true` without being touched.
	 */
	async probeServer(name: string, config: McpServerConfig): Promise<boolean> {
		const remote = asRemote(config);
		if (!remote) return true;
		if (this.inFlight.has(name)) return false;
		this.inFlight.add(name);

		try {
			this.registry.recordConnecting(name, "probe");
			const result = await retryMcpConnection(
				async () => {
					await this.handshake(remote);
				},
				{
					server: name,
					...(this.policy ? { policy: this.policy } : {}),
					...(this.sleep ? { sleep: this.sleep } : {}),
					onAttempt: (attempt) => {
						this.registry.recordAttempt(attempt, "probe");
						const suffix = attempt.willRetry
							? `retrying in ${attempt.nextDelayMs}ms`
							: attempt.classification.class === "permanent"
								? "not retrying (permanent failure)"
								: "giving up (retry budget exhausted)";
						this.logger.warn(
							`MCP server "${name}" probe attempt ${attempt.attempt}/${attempt.maxAttempts} failed ` +
								`[${attempt.classification.class}/${attempt.classification.reason}] ` +
								`${attempt.classification.detail} — ${suffix}`,
						);
					},
				},
			);

			if (result.ok) {
				this.registry.recordConnected(name, "probe");
				this.logger.debug(
					`MCP server "${name}" reachable after ${result.attempts} attempt(s)`,
				);
				return true;
			}

			this.logger.error(
				`MCP server "${name}" unreachable after ${result.attempts} attempt(s): ` +
					`${result.failure?.reason} (${result.failure?.class})`,
			);
			return false;
		} finally {
			this.inFlight.delete(name);
		}
	}

	/**
	 * Fold the SDK's per-session `system`/`init` statuses into the registry and
	 * log them, then kick a bounded background re-probe for anything that failed
	 * transiently.
	 *
	 * Returns the diagnostic lines so the caller can log them (or attach them to
	 * a session record) without re-deriving the summary.
	 */
	recordSessionInit(options: {
		sessionId: string;
		servers: readonly McpInitServerStatus[];
		/**
		 * The configs the session was started with, so a transient failure can be
		 * re-probed. Omit to record statuses only.
		 */
		configs?: Record<string, McpServerConfig>;
	}): string[] {
		const { sessionId, servers, configs } = options;
		if (servers.length === 0) return [];

		const unhealthy = recordMcpInitStatuses(this.registry, servers, sessionId);
		const lines = this.diagnosticLines(`MCP servers (session ${sessionId})`);
		for (const line of lines) {
			this.logger.info(line);
		}

		for (const { name, classification } of unhealthy) {
			if (classification.class === "permanent") {
				this.logger.error(
					`MCP server "${name}" is permanently unavailable for session ${sessionId}: ` +
						`${classification.reason} (${classification.detail}) — not retrying`,
				);
				continue;
			}
			const config = configs?.[name];
			if (!config) continue;
			this.logger.warn(
				`MCP server "${name}" reported "${classification.detail}" at session ${sessionId} init — ` +
					"starting bounded re-probe",
			);
			// Fire-and-forget: a probe must never delay or fail a live session.
			void this.probeServer(name, config).catch((error: unknown) => {
				this.logger.warn(`MCP re-probe for "${name}" threw: ${String(error)}`);
			});
		}

		return lines;
	}

	/**
	 * One `initialize` round trip. Throws on any non-2xx or transport error and
	 * leaves classification to the retry loop, so the recorded reason always
	 * comes from the single classifier in `cyrus-core`.
	 */
	private async handshake(remote: {
		url: string;
		headers: Record<string, string>;
	}): Promise<void> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.probeTimeoutMs);
		try {
			const response = await this.fetchFn(remote.url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					// Streamable-HTTP transports require BOTH media types here; a
					// server that only speaks SSE 406s without the second one.
					accept: "application/json, text/event-stream",
					...remote.headers,
				},
				body: initializeRequestBody(),
				signal: controller.signal,
			});
			if (!response.ok) {
				// Classified by the retry loop: 401/403/404 → permanent,
				// 5xx/429 → transient.
				throw new Error(
					`HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
				);
			}
		} finally {
			clearTimeout(timer);
		}
	}
}

/** Narrow an `McpServerConfig` to the remote transports a probe can reach. */
function asRemote(
	config: McpServerConfig,
): { url: string; headers: Record<string, string> } | undefined {
	const record = config as unknown as Record<string, unknown>;
	if (record.type !== "http" && record.type !== "sse") return undefined;
	if (typeof record.url !== "string" || record.url.length === 0)
		return undefined;
	const headers =
		record.headers && typeof record.headers === "object"
			? (record.headers as Record<string, string>)
			: {};
	return { url: record.url, headers };
}
