/**
 * MCP connection health tracking.
 *
 * The Claude Agent SDK reports per-server connection state exactly once per
 * session, in the `system`/`init` message's `mcp_servers: { name, status }[]`
 * array. Cyrus previously dropped that message on the floor (`case "system":`
 * in `ClaudeRunner.processMessage` was a no-op), so a server that was retrying
 * or had failed outright was invisible to the operator — the live ACA drive
 * only learned that `linear` and `cyrus-tools` were reconnecting because Claude
 * happened to mention it in prose.
 *
 * This registry is the record of truth for "which MCP servers are healthy right
 * now", fed from three sources:
 *
 * 1. `config`   — what we asked for, and what we deliberately skipped
 *                 (see {@link module:mcp/headless}).
 * 2. `probe`    — an explicit reachability check with bounded backoff.
 * 3. `session-init` — the SDK's own per-session status report.
 *
 * @module mcp/health
 */

import type {
	McpFailureClass,
	McpFailureClassification,
	McpRetryAttempt,
} from "./retry.js";
import { classifyMcpFailure } from "./retry.js";

/** Where a health observation came from. */
export type McpHealthSource = "config" | "probe" | "session-init";

/**
 * Lifecycle state of one MCP server.
 *
 * - `declared`  — in the config, not yet observed.
 * - `connecting`— a connection attempt is in flight (or the SDK reports
 *                 `pending`, which under `MCP_CONNECTION_NONBLOCKING=true` is
 *                 the normal turn-1 state).
 * - `connected` — healthy.
 * - `retrying`  — a transient failure was seen and a bounded retry is pending.
 * - `degraded`  — retries were exhausted on a transient failure. The server may
 *                 still recover on its own inside the SDK; Cyrus has stopped
 *                 chasing it.
 * - `failed`    — a permanent failure (rejected credential, missing binary,
 *                 wrong URL). Not retried.
 * - `skipped`   — intentionally omitted from the session config.
 */
export type McpHealthState =
	| "declared"
	| "connecting"
	| "connected"
	| "retrying"
	| "degraded"
	| "failed"
	| "skipped";

/** Health snapshot for a single MCP server. */
export interface McpServerHealth {
	name: string;
	state: McpHealthState;
	/** Connection attempts observed so far (probe attempts + init reports). */
	attempts: number;
	/** Where the most recent observation came from. */
	source: McpHealthSource;
	/** Epoch ms of the most recent observation. */
	observedAt: number;
	/** Set whenever the last observation was a failure. */
	failureClass?: McpFailureClass;
	/** Stable short reason for the current non-healthy state. */
	reason?: string;
	/** Free-text detail behind {@link reason}. */
	detail?: string;
	/** Backoff delay before the next attempt, when `state` is `retrying`. */
	nextRetryDelayMs?: number;
	/** Session that produced the observation, for `session-init` sources. */
	sessionId?: string;
}

/** Roll-up counts across all tracked servers. */
export interface McpHealthSummary {
	total: number;
	connected: number;
	connecting: number;
	retrying: number;
	degraded: number;
	failed: number;
	skipped: number;
	/** True when every server is either connected or intentionally skipped. */
	healthy: boolean;
}

interface McpHealthRegistryOptions {
	/** Injectable clock so tests get deterministic `observedAt` values. */
	now?: () => number;
}

/**
 * In-memory registry of MCP connection health, keyed by server name.
 *
 * Server names are global (the SDK merges every config source into one
 * namespace), so a flat map matches reality: two repositories configuring a
 * `linear` server are configuring the same server.
 */
export class McpHealthRegistry {
	private readonly entries = new Map<string, McpServerHealth>();
	private readonly now: () => number;

	constructor(options: McpHealthRegistryOptions = {}) {
		this.now = options.now ?? (() => Date.now());
	}

	/**
	 * Record that a server is present in the session config. Idempotent, and
	 * never downgrades a server that has already been observed connected —
	 * rebuilding the MCP config for a new session must not wipe known state.
	 */
	declare(name: string): void {
		const existing = this.entries.get(name);
		if (existing && existing.state !== "skipped") {
			return;
		}
		this.entries.set(name, {
			name,
			state: "declared",
			attempts: 0,
			source: "config",
			observedAt: this.now(),
		});
	}

	/** Record that a server was intentionally left out of the session config. */
	recordSkipped(name: string, reason: string, detail?: string): void {
		this.entries.set(name, {
			name,
			state: "skipped",
			attempts: 0,
			source: "config",
			observedAt: this.now(),
			reason,
			...(detail === undefined ? {} : { detail }),
		});
	}

	/** Record that a connection attempt is in flight. */
	recordConnecting(
		name: string,
		source: McpHealthSource = "probe",
		sessionId?: string,
	): void {
		const previous = this.entries.get(name);
		this.entries.set(name, {
			name,
			state: "connecting",
			attempts: previous?.attempts ?? 0,
			source,
			observedAt: this.now(),
			...(sessionId === undefined ? {} : { sessionId }),
		});
	}

	/** Record a healthy connection, clearing any prior failure detail. */
	recordConnected(
		name: string,
		source: McpHealthSource = "probe",
		sessionId?: string,
	): void {
		const previous = this.entries.get(name);
		this.entries.set(name, {
			name,
			state: "connected",
			attempts: (previous?.attempts ?? 0) + 1,
			source,
			observedAt: this.now(),
			...(sessionId === undefined ? {} : { sessionId }),
		});
	}

	/**
	 * Record one failed attempt from {@link retryMcpConnection}'s `onAttempt`
	 * hook. `willRetry` decides whether the server lands in `retrying` (more
	 * budget, transient cause) or a terminal state.
	 */
	recordAttempt(
		attempt: McpRetryAttempt,
		source: McpHealthSource = "probe",
		sessionId?: string,
	): void {
		const state: McpHealthState = attempt.willRetry
			? "retrying"
			: attempt.classification.class === "permanent"
				? "failed"
				: "degraded";
		this.entries.set(attempt.server, {
			name: attempt.server,
			state,
			attempts: attempt.attempt,
			source,
			observedAt: this.now(),
			failureClass: attempt.classification.class,
			reason: attempt.classification.reason,
			detail: attempt.classification.detail,
			...(attempt.nextDelayMs === undefined
				? {}
				: { nextRetryDelayMs: attempt.nextDelayMs }),
			...(sessionId === undefined ? {} : { sessionId }),
		});
	}

	/**
	 * Record a terminal failure directly (no retry loop involved) — e.g. the
	 * SDK reported `needs-auth` at session init.
	 */
	recordFailure(
		name: string,
		classification: McpFailureClassification,
		source: McpHealthSource = "probe",
		sessionId?: string,
	): void {
		const previous = this.entries.get(name);
		this.entries.set(name, {
			name,
			state: classification.class === "permanent" ? "failed" : "degraded",
			attempts: (previous?.attempts ?? 0) + 1,
			source,
			observedAt: this.now(),
			failureClass: classification.class,
			reason: classification.reason,
			detail: classification.detail,
			...(sessionId === undefined ? {} : { sessionId }),
		});
	}

	get(name: string): McpServerHealth | undefined {
		return this.entries.get(name);
	}

	/** All tracked servers, sorted by name for stable diagnostics output. */
	snapshot(): McpServerHealth[] {
		return [...this.entries.values()].sort((a, b) =>
			a.name.localeCompare(b.name),
		);
	}

	summary(): McpHealthSummary {
		const snapshot = this.snapshot();
		const count = (state: McpHealthState): number =>
			snapshot.filter((entry) => entry.state === state).length;
		const connected = count("connected");
		const skipped = count("skipped");
		return {
			total: snapshot.length,
			connected,
			connecting: count("connecting") + count("declared"),
			retrying: count("retrying"),
			degraded: count("degraded"),
			failed: count("failed"),
			skipped,
			healthy: snapshot.length === connected + skipped,
		};
	}

	/** Forget everything. Used by tests and by a full config reload. */
	reset(): void {
		this.entries.clear();
	}
}

/** Human-readable one-liner for a single server's health. */
export function formatMcpServerHealth(entry: McpServerHealth): string {
	const parts: string[] = [entry.state];
	if (entry.state === "retrying") {
		parts.push(`attempt ${entry.attempts}`);
		if (entry.nextRetryDelayMs !== undefined) {
			parts.push(`next retry in ${entry.nextRetryDelayMs}ms`);
		}
	} else if (entry.state === "degraded" || entry.state === "failed") {
		parts.push(
			`after ${entry.attempts} attempt${entry.attempts === 1 ? "" : "s"}`,
		);
	}
	if (entry.reason) {
		parts.push(
			entry.detail ? `${entry.reason}: ${entry.detail}` : entry.reason,
		);
	}
	return `${entry.name} — ${parts.join(", ")}`;
}

/**
 * Render the registry as diagnostic lines for the startup banner / session log.
 *
 * Returns `[]` when nothing is tracked so callers can splice the result into an
 * existing banner without special-casing the empty state.
 */
export function formatMcpHealthDiagnostics(
	registry: McpHealthRegistry,
	options: { label?: string } = {},
): string[] {
	const snapshot = registry.snapshot();
	if (snapshot.length === 0) return [];

	const summary = registry.summary();
	const counts = [
		`${summary.connected} connected`,
		summary.connecting > 0 ? `${summary.connecting} connecting` : undefined,
		summary.retrying > 0 ? `${summary.retrying} retrying` : undefined,
		summary.degraded > 0 ? `${summary.degraded} degraded` : undefined,
		summary.failed > 0 ? `${summary.failed} failed` : undefined,
		summary.skipped > 0 ? `${summary.skipped} skipped` : undefined,
	].filter((part): part is string => part !== undefined);

	const label = options.label ?? "MCP servers";
	return [
		`🔌 ${label}: ${counts.join(", ")}`,
		...snapshot.map((entry) => `   • ${formatMcpServerHealth(entry)}`),
	];
}

/** One entry of the SDK `system`/`init` message's `mcp_servers` array. */
export interface McpInitServerStatus {
	name: string;
	status: string;
}

/** Statuses Claude Code reports for a server it considers healthy. */
const HEALTHY_INIT_STATUSES = new Set(["connected", "ready", "ok"]);
/** Statuses that mean "still working on it" rather than "failed". */
const PENDING_INIT_STATUSES = new Set([
	"pending",
	"connecting",
	"needs-restart",
]);

/**
 * Fold the SDK's per-session `mcp_servers` status report into the registry.
 *
 * Returns the servers that are NOT healthy, so the caller can decide whether to
 * kick off a bounded retry (transient) or just surface the failure (permanent).
 */
export function recordMcpInitStatuses(
	registry: McpHealthRegistry,
	servers: readonly McpInitServerStatus[],
	sessionId?: string,
): Array<{ name: string; classification: McpFailureClassification }> {
	const unhealthy: Array<{
		name: string;
		classification: McpFailureClassification;
	}> = [];

	for (const server of servers) {
		const status = (server.status ?? "").trim();
		if (HEALTHY_INIT_STATUSES.has(status.toLowerCase())) {
			registry.recordConnected(server.name, "session-init", sessionId);
			continue;
		}
		if (PENDING_INIT_STATUSES.has(status.toLowerCase())) {
			registry.recordConnecting(server.name, "session-init", sessionId);
			continue;
		}
		const classification = classifyMcpFailure(status);
		registry.recordFailure(
			server.name,
			classification,
			"session-init",
			sessionId,
		);
		unhealthy.push({ name: server.name, classification });
	}

	return unhealthy;
}
