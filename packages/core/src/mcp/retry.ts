/**
 * Bounded-backoff retry policy for MCP server connections.
 *
 * Cyrus runs every Claude session with `MCP_CONNECTION_NONBLOCKING=true` (see
 * `CYRUS_SESSION_ENV` in `packages/claude-runner/src/session-env.ts`), so MCP
 * servers connect in the background and the SDK reports their state through the
 * `system`/`init` message rather than failing the session outright. That makes
 * "connected" a best-effort outcome: a long-lived worker can sit with a
 * degraded `linear` or `cyrus-tools` server and nobody notices until a tool
 * call fails.
 *
 * This module is the policy half of the fix: a *bounded* exponential backoff
 * (capped delay AND capped attempt count) plus a transient-vs-permanent
 * classifier so we never sit in a retry loop against a failure that retrying
 * cannot fix (a rejected token, a missing binary, a 404 endpoint).
 *
 * Deliberately dependency-free and clock-free — the caller injects `sleep`, so
 * tests assert the exact delay sequence without waiting.
 *
 * @module mcp/retry
 */

/**
 * Whether retrying a failure has any chance of succeeding.
 *
 * - `transient` — the failure is about the network or the moment: a reset
 *   socket, a 503, a connect timeout, a suspended sandbox that has just
 *   resumed. Retry with backoff.
 * - `permanent` — the failure is about the configuration or the credential: a
 *   rejected token, an OAuth flow that needs a human, a missing binary, a
 *   wrong URL. Retrying burns time and log volume without ever succeeding, so
 *   we stop after the first attempt and report it.
 */
export type McpFailureClass = "transient" | "permanent";

/** A classified MCP connection failure. */
export interface McpFailureClassification {
	/** Whether retrying could plausibly help. */
	class: McpFailureClass;
	/**
	 * Short, stable, machine-readable reason — safe to assert on in tests and
	 * to render in diagnostics (e.g. `needs-auth`, `connection-reset`).
	 */
	reason: string;
	/** The (truncated) message the classification was derived from. */
	detail: string;
}

/** Longest `detail` we keep. MCP errors can embed whole HTML error pages. */
const MAX_DETAIL_LENGTH = 300;

/**
 * Ordered match table — FIRST match wins, so more specific patterns must come
 * before more general ones (`command not found` before a bare `not found`).
 */
const CLASSIFICATION_PATTERNS: ReadonlyArray<
	readonly [RegExp, McpFailureClass, string]
> = [
	// ---- Permanent: the server needs a human to authenticate -------------
	// Claude Code's own `mcp_servers[].status` value for "an interactive OAuth
	// flow is required". This is the `cyrus-docs` failure mode inside a
	// headless container: no browser, no way to complete the flow, ever.
	[/needs[-_\s]?auth/i, "permanent", "needs-auth"],
	[/authentication[-_\s]?(?:required|needed)/i, "permanent", "needs-auth"],
	[/\boauth\b/i, "permanent", "needs-auth"],
	[
		/\bconsent\b|\bauthoriz(?:e|ation) (?:required|url)\b/i,
		"permanent",
		"needs-auth",
	],

	// ---- Permanent: the credential itself was rejected -------------------
	[/\b401\b|\bunauthorized\b/i, "permanent", "unauthorized"],
	[/\b403\b|\bforbidden\b/i, "permanent", "forbidden"],
	[
		/invalid[-_\s]?(?:api[-_\s]?key|token|credential)/i,
		"permanent",
		"invalid-credentials",
	],
	[
		/authentication (?:failed|error)|\bauth failed\b/i,
		"permanent",
		"authentication-failed",
	],

	// ---- Permanent: the server can never start on this host --------------
	// `command not found` / ENOENT on spawn means the stdio server's binary is
	// not in the image. No amount of backoff installs it.
	[
		/command not found|\bENOENT\b|no such file or directory|is not recognized as an internal/i,
		"permanent",
		"missing-binary",
	],
	[
		/\bEACCES\b|permission denied|\bnot executable\b/i,
		"permanent",
		"permission-denied",
	],

	// ---- Permanent: the configuration is wrong ---------------------------
	[/\b404\b|\bnot found\b/i, "permanent", "endpoint-not-found"],
	[/\b400\b|\bbad request\b/i, "permanent", "bad-request"],
	[
		/invalid url|unsupported (?:protocol|transport|scheme)|malformed/i,
		"permanent",
		"invalid-config",
	],
	[
		/protocol version mismatch|unsupported protocol version/i,
		"permanent",
		"protocol-mismatch",
	],

	// ---- Transient: the network or the peer had a bad moment -------------
	[/\b429\b|too many requests|rate limit/i, "transient", "rate-limited"],
	[
		/\b5\d\d\b|bad gateway|service unavailable|gateway timeout/i,
		"transient",
		"server-error",
	],
	[
		/\bECONNRESET\b|socket hang up|connection reset/i,
		"transient",
		"connection-reset",
	],
	[/\bECONNREFUSED\b|connection refused/i, "transient", "connection-refused"],
	[
		/\bETIMEDOUT\b|\bESOCKETTIMEDOUT\b|timed? ?out|timeout/i,
		"transient",
		"timeout",
	],
	[/\bEPIPE\b|broken pipe/i, "transient", "broken-pipe"],
	[/\bEAI_AGAIN\b|\bENOTFOUND\b|getaddrinfo/i, "transient", "dns-failure"],
	[
		/\bEHOSTUNREACH\b|\bENETUNREACH\b|network is unreachable/i,
		"transient",
		"network-unreachable",
	],
	[/fetch failed|network error|aborted/i, "transient", "network-error"],
	[
		/\bdisconnect(?:ed)?\b|\breconnect(?:ing)?\b|closed|\bEOF\b/i,
		"transient",
		"disconnected",
	],
	// Claude Code reports a server it has not finished connecting to as
	// `pending`, and one whose transport dropped as `failed`. Neither carries
	// a cause, so both are treated as retryable — the retry itself is bounded,
	// so an unknown-but-permanent cause costs us `maxAttempts` probes, not an
	// infinite loop.
	[/^pending$|^connecting$/i, "transient", "pending"],
	[/^failed$|^error$/i, "transient", "connect-failed"],
];

/** Extract a human-readable message from anything a rejected promise carries. */
function messageOf(input: unknown): string {
	if (input == null) return "";
	if (typeof input === "string") return input;
	if (input instanceof Error) {
		// Node wraps the useful bit in `cause` for `fetch` failures.
		const cause = (input as { cause?: unknown }).cause;
		const causeMessage =
			cause instanceof Error
				? cause.message
				: typeof cause === "string"
					? cause
					: undefined;
		// Include `code` (ECONNRESET, ENOENT, …) — `message` often omits it.
		const code = (input as { code?: unknown }).code;
		return [
			input.message,
			typeof code === "string" ? code : undefined,
			causeMessage,
		]
			.filter(Boolean)
			.join(" ");
	}
	if (typeof input === "object") {
		const record = input as Record<string, unknown>;
		const parts = ["status", "statusText", "message", "error", "reason", "code"]
			.map((key) => record[key])
			.filter((value) => typeof value === "string" || typeof value === "number")
			.map(String);
		if (parts.length > 0) return parts.join(" ");
		try {
			return JSON.stringify(input);
		} catch {
			return String(input);
		}
	}
	return String(input);
}

/**
 * Classify an MCP connection failure as transient (retry) or permanent (stop).
 *
 * Accepts anything: an `Error`, a Claude Code `mcp_servers[].status` string, an
 * HTTP-ish object (`{ status, statusText }`), or a bare string.
 *
 * Unrecognised failures default to `transient` — the retry budget is bounded,
 * so guessing "retryable" costs at most `maxAttempts` probes, whereas guessing
 * "permanent" would silently give up on a genuinely flaky server.
 */
export function classifyMcpFailure(input: unknown): McpFailureClassification {
	const raw = messageOf(input).trim();
	const detail =
		raw.length > MAX_DETAIL_LENGTH
			? `${raw.slice(0, MAX_DETAIL_LENGTH)}…`
			: raw;

	for (const [pattern, failureClass, reason] of CLASSIFICATION_PATTERNS) {
		if (pattern.test(raw)) {
			return { class: failureClass, reason, detail };
		}
	}

	return { class: "transient", reason: "unknown", detail };
}

/** Bounded exponential-backoff parameters. */
export interface McpRetryPolicy {
	/** Total attempts, INCLUDING the first. Must be >= 1. */
	maxAttempts: number;
	/** Delay before attempt 2. */
	initialDelayMs: number;
	/** Hard ceiling on any single delay — the "bounded" in bounded backoff. */
	maxDelayMs: number;
	/** Delay multiplier applied per attempt. */
	backoffMultiplier: number;
}

/**
 * Default policy: 5 attempts over ~15.5s of backoff (0.5s, 1s, 2s, 4s), capped
 * at 15s per delay. Short enough that a session start is not held hostage,
 * long enough to ride out an ACA resume or a router revision rollover.
 */
export const DEFAULT_MCP_RETRY_POLICY: McpRetryPolicy = {
	maxAttempts: 5,
	initialDelayMs: 500,
	maxDelayMs: 15_000,
	backoffMultiplier: 2,
};

/** Fill a partial policy from {@link DEFAULT_MCP_RETRY_POLICY} and sanitize it. */
export function resolveMcpRetryPolicy(
	policy?: Partial<McpRetryPolicy>,
): McpRetryPolicy {
	const merged = { ...DEFAULT_MCP_RETRY_POLICY, ...policy };
	return {
		maxAttempts: Math.max(1, Math.floor(merged.maxAttempts)),
		initialDelayMs: Math.max(0, merged.initialDelayMs),
		maxDelayMs: Math.max(0, merged.maxDelayMs),
		backoffMultiplier: Math.max(1, merged.backoffMultiplier),
	};
}

/**
 * Delay to wait *after* attempt `attempt` failed, before attempt `attempt + 1`.
 *
 * `attempt` is 1-based. Always clamped to `maxDelayMs`, so the sequence
 * plateaus rather than growing without bound.
 */
export function computeMcpRetryDelayMs(
	attempt: number,
	policy?: Partial<McpRetryPolicy>,
): number {
	const resolved = resolveMcpRetryPolicy(policy);
	const exponent = Math.max(0, Math.floor(attempt) - 1);
	const raw = resolved.initialDelayMs * resolved.backoffMultiplier ** exponent;
	return Math.min(Math.round(raw), resolved.maxDelayMs);
}

/** One recorded attempt, handed to `onAttempt` for logging/diagnostics. */
export interface McpRetryAttempt {
	/** MCP server name the attempt was made against. */
	server: string;
	/** 1-based attempt number. */
	attempt: number;
	/** Attempt budget, so log lines can read "attempt 2/5". */
	maxAttempts: number;
	/** Why the attempt failed, and whether retrying can help. */
	classification: McpFailureClassification;
	/** True when another attempt follows. */
	willRetry: boolean;
	/** Delay before the next attempt; `undefined` when giving up. */
	nextDelayMs?: number;
}

export interface McpRetryOptions {
	/** MCP server name — used only for logging/diagnostics. */
	server: string;
	policy?: Partial<McpRetryPolicy>;
	/**
	 * Called once per failed attempt, before the backoff sleep. This is the
	 * hook the health registry and the logger both hang off, which is why
	 * "logs/diagnostics record each attempt" is testable without a logger.
	 */
	onAttempt?: (attempt: McpRetryAttempt) => void;
	/** Injectable sleep so tests never wait. Defaults to `setTimeout`. */
	sleep?: (ms: number) => Promise<void>;
	/** Injectable classifier — defaults to {@link classifyMcpFailure}. */
	classify?: (error: unknown) => McpFailureClassification;
}

/** Outcome of a {@link retryMcpConnection} run. */
export interface McpRetryResult<T> {
	ok: boolean;
	/** Present when `ok` is true. */
	value?: T;
	/** Attempts actually made (1..maxAttempts). */
	attempts: number;
	/** Present when `ok` is false — why we stopped. */
	failure?: McpFailureClassification;
	/** The backoff delays actually waited, in order. */
	delaysMs: number[];
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise((resolve) => {
		setTimeout(resolve, ms);
	});

/**
 * Run `operation` with bounded exponential backoff.
 *
 * Stops on the first success, on a `permanent` classification, or when the
 * attempt budget is exhausted — never loops indefinitely. Every failed attempt
 * is reported through `onAttempt` before the backoff sleep.
 */
export async function retryMcpConnection<T>(
	operation: (attempt: number) => Promise<T>,
	options: McpRetryOptions,
): Promise<McpRetryResult<T>> {
	const policy = resolveMcpRetryPolicy(options.policy);
	const sleep = options.sleep ?? defaultSleep;
	const classify = options.classify ?? classifyMcpFailure;
	const delaysMs: number[] = [];

	for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
		try {
			const value = await operation(attempt);
			return { ok: true, value, attempts: attempt, delaysMs };
		} catch (error) {
			const classification = classify(error);
			const budgetLeft = attempt < policy.maxAttempts;
			const willRetry = budgetLeft && classification.class === "transient";
			const nextDelayMs = willRetry
				? computeMcpRetryDelayMs(attempt, policy)
				: undefined;

			options.onAttempt?.({
				server: options.server,
				attempt,
				maxAttempts: policy.maxAttempts,
				classification,
				willRetry,
				...(nextDelayMs === undefined ? {} : { nextDelayMs }),
			});

			if (!willRetry) {
				return {
					ok: false,
					attempts: attempt,
					failure: classification,
					delaysMs,
				};
			}

			delaysMs.push(nextDelayMs as number);
			await sleep(nextDelayMs as number);
		}
	}

	// Unreachable: the loop always returns on the final attempt. Present so the
	// function is total for the type checker.
	return {
		ok: false,
		attempts: policy.maxAttempts,
		failure: classify("retry budget exhausted"),
		delaysMs,
	};
}
