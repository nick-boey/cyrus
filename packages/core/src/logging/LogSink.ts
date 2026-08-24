import type { LogException } from "./exception.js";
import type { LogContext, LogEventAttributes } from "./ILogger.js";
import { LogLevel } from "./ILogger.js";

/**
 * One rendered-but-not-yet-serialised log line, handed to a {@link LogSink}.
 *
 * Deliberately structured rather than pre-formatted: a sink ships this over a
 * wire (the router WSS connection) or into an exporter, and both want the
 * fields separately. The console rendering in `Logger` is unaffected — a sink
 * is an *additional* destination, never a replacement.
 */
export interface LogRecord {
	/** Wall-clock emission time, as epoch milliseconds. */
	timestampMs: number;
	level: LogLevel;
	/** The logger's component name, e.g. "EdgeWorker". */
	component: string;
	/** The human-readable message. For an `event()` this is `event:<name>`. */
	message: string;
	/** The logger's structured context (sessionId, issueIdentifier, …). */
	context: LogContext;
	/** Set only for {@link ILogger.event} — the event name, e.g. `sandbox_gauge`. */
	event?: string;
	/**
	 * Event attributes for an `event()`, or the context's own `attributes` for
	 * an ordinary log line. Always primitive-valued.
	 */
	attributes?: LogEventAttributes;
	/**
	 * Trailing `logger.x(msg, ...args)` arguments, summarised to a single string
	 * so a sink never has to serialise arbitrary objects. Absent when there were
	 * no trailing args.
	 */
	args?: string;
	/**
	 * The Error the call site passed, if any, shaped for OTel exception semconv.
	 *
	 * Kept structured rather than folded into {@link args} because this is the
	 * one part of the payload operators query by field: `exception.type` groups
	 * failures, and `exception.stacktrace` is the whole reason to open the record.
	 * Set on any level — `logger.warn("retrying", err)` carries an exception just
	 * as much as `logger.error` does.
	 */
	exception?: LogException;
}

/**
 * A process-wide additional destination for log records.
 *
 * Mirrors the existing `setGlobalErrorReporter` seam: bootstrap installs one,
 * and every logger in the process forwards to it without the sink having to be
 * threaded through each constructor. This is what lets a sandbox worker ship
 * its logs off the box (the router WSS connection) without every call site
 * knowing it is running in a sandbox.
 */
export interface LogSink {
	/**
	 * Records strictly below this level are never offered to {@link write}.
	 *
	 * Read on every call rather than cached, so a sink can widen or narrow its
	 * own threshold at runtime. It is a cheap pre-filter, not the sink's only
	 * defence — a sink is still free to drop what it is handed (see the router
	 * forwarder's rate limit).
	 *
	 * `event()` deliberately bypasses this: a named lifecycle event is
	 * low-volume and always meant to reach the structured stream, matching the
	 * existing contract on {@link ILogger.event}.
	 */
	readonly minLevel: LogLevel;
	/**
	 * Consume one record. MUST NOT throw and MUST NOT log through an `ILogger`
	 * — `Logger` guards against both (it swallows throws and the sink is
	 * expected to guard its own re-entrancy), but a sink that recurses turns
	 * one log line into an unbounded loop.
	 */
	write(record: LogRecord): void;
}

class NoopLogSink implements LogSink {
	readonly minLevel = LogLevel.SILENT;
	write(): void {}
}

let globalSink: LogSink = new NoopLogSink();

/**
 * Install the process-wide {@link LogSink}. Returns the previously-installed
 * sink so callers (and tests) can restore it.
 */
export function setGlobalLogSink(sink: LogSink): LogSink {
	const previous = globalSink;
	globalSink = sink;
	return previous;
}

/** Read the process-wide {@link LogSink}. Defaults to a no-op. */
export function getGlobalLogSink(): LogSink {
	return globalSink;
}

/** Restore the default no-op sink. Intended for tests and shutdown paths. */
export function resetGlobalLogSink(): void {
	globalSink = new NoopLogSink();
}
