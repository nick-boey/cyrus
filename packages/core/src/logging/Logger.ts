import type {
	ErrorReporterLogAttributes,
	ErrorReporterLogLevel,
} from "../error-reporting/ErrorReporter.js";
import {
	getGlobalErrorReporter,
	getGlobalErrorTags,
} from "../error-reporting/globalReporter.js";
import type { ILogger, LogContext, LogEventAttributes } from "./ILogger.js";
import { LogLevel } from "./ILogger.js";

function formatContext(context: LogContext): string {
	const parts: string[] = [];
	if (context.sessionId) {
		parts.push(`session=${context.sessionId.slice(0, 8)}`);
	}
	if (context.platform) {
		parts.push(`platform=${context.platform}`);
	}
	if (context.issueIdentifier) {
		parts.push(`issue=${context.issueIdentifier}`);
	}
	if (context.repository) {
		parts.push(`repo=${context.repository}`);
	}
	return parts.length > 0 ? ` {${parts.join(", ")}}` : "";
}

/**
 * Wire format for a rendered log line.
 *
 * - `text` — the human-readable `<ts> [LEVEL] [component] {ctx} message` form.
 *   This is the default and its output is byte-for-byte unchanged.
 * - `json` — one JSON object per line, so log aggregators (Azure Log
 *   Analytics, Loki, …) can index individual fields instead of regexing prose.
 */
export type LogFormat = "text" | "json";

function parseFormatFromEnv(): LogFormat | undefined {
	switch (process.env.CYRUS_LOG_FORMAT?.toLowerCase()) {
		case "json":
			return "json";
		case "text":
			return "text";
		default:
			return undefined;
	}
}

function parseLevelFromEnv(): LogLevel | undefined {
	const envLevel = process.env.CYRUS_LOG_LEVEL?.toUpperCase();
	switch (envLevel) {
		case "DEBUG":
			return LogLevel.DEBUG;
		case "INFO":
			return LogLevel.INFO;
		case "WARN":
			return LogLevel.WARN;
		case "ERROR":
			return LogLevel.ERROR;
		case "SILENT":
			return LogLevel.SILENT;
		default:
			return undefined;
	}
}

const LEVEL_LABELS: Record<LogLevel, string> = {
	[LogLevel.DEBUG]: "DEBUG",
	[LogLevel.INFO]: "INFO",
	[LogLevel.WARN]: "WARN",
	[LogLevel.ERROR]: "ERROR",
	[LogLevel.SILENT]: "",
};

class Logger implements ILogger {
	private level: LogLevel;
	private component: string;
	private context: LogContext;
	private format: LogFormat | undefined;

	constructor(options: {
		component: string;
		level?: LogLevel;
		context?: LogContext;
		format?: LogFormat;
	}) {
		this.component = options.component;
		this.level = options.level ?? parseLevelFromEnv() ?? LogLevel.INFO;
		this.context = options.context ?? {};
		this.format = options.format;
	}

	/**
	 * Resolved per call rather than cached at construction: several modules
	 * create their logger at import time, so caching would freeze the format
	 * before a host (or a test) had a chance to set CYRUS_LOG_FORMAT.
	 */
	private resolveFormat(): LogFormat {
		return this.format ?? parseFormatFromEnv() ?? "text";
	}

	private formatPrefix(level: LogLevel): string {
		const timestamp = new Date().toISOString();
		const label = LEVEL_LABELS[level];
		const padded = label.padEnd(5);
		const ctx = formatContext(this.context);
		return `${timestamp} [${padded}] [${this.component}]${ctx}`;
	}

	/**
	 * Render one log line as a single JSON object. Keys are flat and stable so
	 * they survive Log Analytics' dynamic-column projection: an operator can
	 * write `where component == "EventRouter" and level == "error"` without
	 * parsing the message. Trailing args are folded into `args`, and the first
	 * Error found is hoisted to `error` with its stack intact.
	 */
	private formatJson(
		level: LogLevel,
		message: string,
		args: unknown[],
		extra?: Record<string, unknown>,
	): string {
		const record: Record<string, unknown> = {
			timestamp: new Date().toISOString(),
			level: LEVEL_LABELS[level].toLowerCase(),
			component: this.component,
			message,
		};
		if (this.context.sessionId) record.sessionId = this.context.sessionId;
		if (this.context.platform) record.platform = this.context.platform;
		if (this.context.issueIdentifier)
			record.issueIdentifier = this.context.issueIdentifier;
		if (this.context.repository) record.repository = this.context.repository;
		if (extra) Object.assign(record, extra);

		const error = extractError(args);
		if (error) {
			record.error = {
				name: error.name,
				message: error.message,
				...(error.stack ? { stack: error.stack } : {}),
			};
		}
		const rest = args.filter((arg) => arg !== error);
		if (rest.length > 0) record.args = rest.map(toJsonSafe);

		return safeStringify(record);
	}

	/**
	 * Single console egress for every level. Text output is produced by exactly
	 * the same expression as before so the default rendering is unchanged.
	 */
	private write(
		level: LogLevel,
		message: string,
		args: unknown[],
		extra?: Record<string, unknown>,
	): void {
		const sink =
			level >= LogLevel.ERROR
				? console.error
				: level === LogLevel.WARN
					? console.warn
					: console.log;
		if (this.resolveFormat() === "json") {
			sink(this.formatJson(level, message, args, extra));
			return;
		}
		sink(`${this.formatPrefix(level)} ${message}`, ...args);
	}

	debug(message: string, ...args: unknown[]): void {
		if (this.level <= LogLevel.DEBUG) {
			this.write(LogLevel.DEBUG, message, args);
		}
		// debug/info are NOT forwarded to Sentry Logs — they're far too high-volume
		// to ship unconditionally. Use {@link event} for major lifecycle events
		// that should always reach Sentry; warn/error keep auto-forwarding.
	}

	info(message: string, ...args: unknown[]): void {
		if (this.level <= LogLevel.INFO) {
			this.write(LogLevel.INFO, message, args);
		}
		// See debug() — info is local-only. Promote to event() if it must ship.
	}

	warn(message: string, ...args: unknown[]): void {
		if (this.level <= LogLevel.WARN) {
			this.write(LogLevel.WARN, message, args);
		}
		// All WARN logs forward to Sentry Logs unconditionally so operators see
		// degraded-state signals even when running production at higher local
		// verbosity thresholds.
		this.forwardLog("warn", message, args);
	}

	error(message: string, ...args: unknown[]): void {
		if (this.level <= LogLevel.ERROR) {
			this.write(LogLevel.ERROR, message, args);
		}

		// Forward to the process-wide error reporter so ad-hoc `logger.error(msg, err)`
		// calls scattered across the codebase (claude-runner, edge-worker, transports,
		// persistence, etc.) automatically surface in Sentry without requiring the
		// reporter to be threaded through every constructor.
		this.forwardToErrorReporter(message, args);
		this.forwardLog("error", message, args);
	}

	event(name: string, attributes?: LogEventAttributes): void {
		// Mirror major events to the local console at INFO so operators reading
		// terminal output see lifecycle transitions without reading Sentry.
		if (this.level <= LogLevel.INFO) {
			if (this.resolveFormat() === "json") {
				// Events keep the `event` key rather than burying the name in the
				// message, so a KQL query can group on it directly.
				console.log(
					this.formatJson(LogLevel.INFO, `event:${name}`, [], {
						event: name,
						...(attributes ?? {}),
					}),
				);
			} else {
				const suffix =
					attributes && Object.keys(attributes).length > 0
						? ` ${JSON.stringify(attributes)}`
						: "";
				console.log(
					`${this.formatPrefix(LogLevel.INFO)} [event:${name}]${suffix}`,
				);
			}
		}
		this.forwardEvent(name, attributes);
	}

	/**
	 * Common per-call attribute scaffold shared between {@link forwardLog} and
	 * {@link forwardEvent}. Centralises the merge of process-wide tags
	 * (team_id, …), the component name, and the structured logger context so
	 * the two forwarding paths stay in lockstep.
	 */
	private buildBaseAttributes(): ErrorReporterLogAttributes {
		const attrs: ErrorReporterLogAttributes = {
			...getGlobalErrorTags(),
			component: this.component,
		};
		if (this.context.sessionId) attrs.sessionId = this.context.sessionId;
		if (this.context.platform) attrs.platform = this.context.platform;
		if (this.context.issueIdentifier)
			attrs.issueIdentifier = this.context.issueIdentifier;
		if (this.context.repository) attrs.repository = this.context.repository;
		return attrs;
	}

	/**
	 * Forward a named major event to the structured-log stream. Distinct from
	 * {@link forwardLog} so call sites can opt specific lifecycle/audit-style
	 * events into Sentry Logs without re-enabling the firehose of debug/info
	 * logs. Reporter implementations gate this independently (e.g. the Sentry
	 * reporter only ships logs when CYRUS_TEAM_ID is configured).
	 */
	private forwardEvent(name: string, attributes?: LogEventAttributes): void {
		const reporter = getGlobalErrorReporter();
		if (!reporter.isEnabled) return;
		const merged: ErrorReporterLogAttributes = {
			...this.buildBaseAttributes(),
			event: name,
			...(attributes ?? {}),
		};
		reporter.log("info", `event:${name}`, merged);
	}

	/**
	 * Forward a log line at any level to the process-wide error reporter's
	 * structured-log stream (e.g. Sentry Logs). Distinct from {@link
	 * forwardToErrorReporter} which captures errors as Sentry Issues — Logs
	 * accept every level without spamming alerts and let us slice/dice via
	 * attributes (team_id, component, sessionId, …). Safe to call when the
	 * reporter is disabled; the noop implementation drops the call.
	 */
	private forwardLog(
		level: ErrorReporterLogLevel,
		message: string,
		args: unknown[],
	): void {
		const reporter = getGlobalErrorReporter();
		if (!reporter.isEnabled) return;

		const attributes = this.buildBaseAttributes();

		// Sentry Logs only accept primitive attribute values, so summarise non-
		// primitive trailing args (Errors, objects) into a one-line tail rather
		// than dropping them. The full structured payload still goes via
		// captureException for level=error.
		if (args.length > 0) {
			const tail = summariseArgs(args);
			if (tail) attributes.args = tail;
		}

		reporter.log(level, message, attributes);
	}

	private forwardToErrorReporter(message: string, args: unknown[]): void {
		const reporter = getGlobalErrorReporter();
		if (!reporter.isEnabled) return;

		const error = extractError(args);
		// Start with process-wide tags (e.g. team_id from CYRUS_TEAM_ID) so they
		// apply to every forwarded event. Per-call context wins on key collisions.
		// Sentry tags are string-only — coerce primitives, drop nullish.
		const baseAttrs = this.buildBaseAttributes();
		const contextTags: Record<string, string> = {};
		for (const [k, v] of Object.entries(baseAttrs)) {
			if (v === undefined || v === null) continue;
			contextTags[k] = typeof v === "string" ? v : String(v);
		}

		const extra: Record<string, unknown> = { message };
		if (args.length > 0) extra.args = args;

		// Stable fingerprint so messages with embedded IDs (issue identifiers,
		// session UUIDs, file paths) don't fragment into one Sentry issue per
		// unique value. Errors with their own stack frames already group well, so
		// we still pass a fingerprint to bias grouping toward (component +
		// templated message) — keeps the same logical failure together even when
		// the underlying Error type differs across call sites.
		const fingerprint = ["logger", this.component, templatizeMessage(message)];

		if (error) {
			reporter.captureException(error, {
				tags: contextTags,
				extra,
				fingerprint,
			});
		} else {
			// No Error object found — capture the message at "error" severity so
			// otherwise-invisible failure paths still produce a Sentry event.
			reporter.captureMessage(message, "error", {
				tags: contextTags,
				extra,
				fingerprint,
			});
		}
	}

	withContext(context: LogContext): ILogger {
		return new Logger({
			component: this.component,
			level: this.level,
			context: { ...this.context, ...context },
			format: this.format,
		});
	}

	getLevel(): LogLevel {
		return this.level;
	}

	setLevel(level: LogLevel): void {
		this.level = level;
	}
}

export function createLogger(options: {
	component: string;
	level?: LogLevel;
	context?: LogContext;
	/** Overrides CYRUS_LOG_FORMAT for this logger. Defaults to the env value. */
	format?: LogFormat;
}): ILogger {
	return new Logger(options);
}

/**
 * An {@link ILogger} that discards everything, including the Sentry-forwarding
 * side effects of warn/error. Use it as the default for an optional `logger`
 * dependency so call sites can widen to the full interface without every
 * caller having to construct a real logger.
 */
export function createNoopLogger(): ILogger {
	const noop = (): void => {};
	const logger: ILogger = {
		debug: noop,
		info: noop,
		warn: noop,
		error: noop,
		event: noop,
		withContext: () => logger,
		getLevel: () => LogLevel.SILENT,
		setLevel: noop,
	};
	return logger;
}

/**
 * Convert an arbitrary log arg into something JSON.stringify won't mangle.
 * Errors keep their stack, BigInt/undefined/functions degrade to strings, and
 * everything else passes through for the stringifier to handle.
 */
function toJsonSafe(value: unknown): unknown {
	if (value instanceof Error) {
		return {
			name: value.name,
			message: value.message,
			...(value.stack ? { stack: value.stack } : {}),
		};
	}
	if (typeof value === "bigint") return value.toString();
	if (typeof value === "function")
		return `[Function ${value.name || "anonymous"}]`;
	if (typeof value === "undefined") return null;
	return value;
}

/**
 * JSON.stringify that cannot throw. A log line must never be the thing that
 * crashes the process, so circular references collapse to "[Circular]" and a
 * total failure degrades to a minimal record rather than propagating.
 */
function safeStringify(record: Record<string, unknown>): string {
	const seen = new WeakSet<object>();
	try {
		return JSON.stringify(record, (_key, value) => {
			if (value && typeof value === "object") {
				if (seen.has(value as object)) return "[Circular]";
				seen.add(value as object);
			}
			return typeof value === "bigint" ? value.toString() : value;
		});
	} catch {
		return JSON.stringify({
			timestamp: record.timestamp,
			level: record.level,
			component: record.component,
			message: record.message,
			serializationError: true,
		});
	}
}

/**
 * Find the first {@link Error} in the trailing args of a `logger.error(...)`
 * call. Also follows `error.cause` chains (used by transports that wrap an
 * underlying failure) and unwraps objects that look like `{ error: Error }`.
 */
/**
 * Replace dynamic fragments in a log message with placeholders so messages
 * that differ only by embedded IDs/paths/numbers collapse to one fingerprint.
 *
 * Conservative on purpose — over-templating would merge unrelated failures.
 * We strip the things known to vary across otherwise-identical log lines:
 *   - UUIDs, hex blobs (16+ chars)
 *   - Linear-style identifiers (TEAM-123)
 *   - Absolute paths
 *   - Long digit runs (timestamps, ports, retry counts)
 */
function templatizeMessage(message: string): string {
	return message
		.replace(
			/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
			"<uuid>",
		)
		.replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
		.replace(/\b[A-Z]{2,10}-\d+\b/g, "<id>")
		.replace(/(?:\/[\w.-]+){2,}/g, "<path>")
		.replace(/\b\d{4,}\b/g, "<num>")
		.slice(0, 200);
}

/**
 * Summarise trailing log args into a single string suitable as a structured
 * attribute value (Sentry Logs only accept primitives). Errors collapse to
 * `name: message`, objects to a JSON-stringified preview, primitives to their
 * String() form. Truncated to keep the payload bounded.
 */
function summariseArgs(args: unknown[]): string | undefined {
	const parts: string[] = [];
	for (const arg of args) {
		if (arg instanceof Error) {
			parts.push(`${arg.name}: ${arg.message}`);
		} else if (arg && typeof arg === "object") {
			try {
				parts.push(JSON.stringify(arg));
			} catch {
				parts.push("[object]");
			}
		} else if (arg !== undefined) {
			parts.push(String(arg));
		}
	}
	if (parts.length === 0) return undefined;
	const joined = parts.join(" ");
	return joined.length > 500 ? `${joined.slice(0, 500)}…` : joined;
}

function extractError(args: unknown[]): Error | undefined {
	for (const arg of args) {
		if (arg instanceof Error) return arg;
		if (
			arg &&
			typeof arg === "object" &&
			"error" in arg &&
			(arg as { error: unknown }).error instanceof Error
		) {
			return (arg as { error: Error }).error;
		}
	}
	return undefined;
}
