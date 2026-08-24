import type { LogAttributes, Logger } from "@opentelemetry/api-logs";
import type { LogRecord, LogSink } from "cyrus-core";
import { LogLevel } from "cyrus-core";
import { severityFor, severityTextFor } from "./severity.js";

/**
 * Hard caps applied before a record is handed to the OTLP exporter. Mirrors the
 * caps `RouterLogForwarder` applies on the WSS path, and for the same reason:
 * the destination is billed per GB, and a stack trace, a stringified config, or
 * a Claude response can each be arbitrarily large.
 */
const MAX_BODY_CHARS = 8_000;
const MAX_ARGS_CHARS = 2_000;
const MAX_ATTRIBUTE_CHARS = 1_000;
const MAX_ATTRIBUTES = 64;

export interface OtelLogSinkOptions {
	/** The OTel API logger to emit through. */
	logger: Logger;
	/**
	 * Records strictly below this level are never offered to {@link
	 * OtelLogSink.write}. Defaults to INFO — see {@link OtelLogSink} on why this
	 * is higher than the console default.
	 */
	minLevel?: LogLevel;
}

/**
 * A {@link LogSink} that emits Cyrus log records through the OpenTelemetry Logs
 * API.
 *
 * ── WHY THIS EXISTS ──
 * Adopting `ILogger` alone does not produce queryable fields: the default sink
 * is `console.log(prefix + message, ...args)`, i.e. prose. `LogRecord` is the
 * first point in the pipeline where the fields are still separate, so this is
 * where a structured payload can be built without re-parsing anything.
 *
 * ── ATTRIBUTE NAMING ──
 * Attribute keys deliberately match the keys `Logger`'s JSON console format
 * already emits (`component`, `sessionId`, `issueIdentifier`, `repository`,
 * `platform`, `event`, `args`) rather than being translated to OTel semconv.
 * Two reasons: OTel defines no semconv for any of them, and operators already
 * have Phase 0/2 queries written against those names. A rename would silently
 * break every saved query for no gain.
 *
 * ── RE-ENTRANCY ──
 * Like `RouterLogForwarder`, this sink is called FROM the logger, and the
 * exporter beneath it does I/O. If anything on that path ever logs through an
 * `ILogger`, one log line becomes an unbounded loop. {@link inWrite} drops
 * anything emitted while a write is in flight, and this class never logs
 * anything itself.
 */
export class OtelLogSink implements LogSink {
	private readonly otelLogger: Logger;
	private level: LogLevel;
	private inWrite = false;
	private dropped = 0;

	constructor(options: OtelLogSinkOptions) {
		this.otelLogger = options.logger;
		this.level = options.minLevel ?? LogLevel.INFO;
	}

	get minLevel(): LogLevel {
		return this.level;
	}

	/** Widen or narrow the threshold at runtime (e.g. from a config reload). */
	setMinLevel(level: LogLevel): void {
		this.level = level;
	}

	/**
	 * Records discarded because the exporter path threw. Exposed as a test seam
	 * and for a caller that wants to surface the count; a silent drop that is not
	 * counted anywhere reads as "nothing went wrong".
	 */
	get droppedCount(): number {
		return this.dropped;
	}

	write(record: LogRecord): void {
		// See the class doc's RE-ENTRANCY note.
		if (this.inWrite) return;

		// `Logger` already applies this as a pre-filter, but an `event()` bypasses
		// it there by design and a sink must not depend on its caller's filtering.
		if (record.event === undefined && record.level < this.level) return;

		this.inWrite = true;
		try {
			this.otelLogger.emit({
				timestamp: record.timestampMs,
				severityNumber: severityFor(record.level),
				...(severityTextFor(record.level) !== undefined
					? { severityText: severityTextFor(record.level) }
					: {}),
				body: truncate(record.message, MAX_BODY_CHARS),
				attributes: this.buildAttributes(record),
			});
		} catch {
			// A broken exporter must never take down the caller. Counted rather than
			// swallowed so the loss is at least observable in-process.
			this.dropped += 1;
		} finally {
			this.inWrite = false;
		}
	}

	private buildAttributes(record: LogRecord): LogAttributes {
		const attributes: LogAttributes = { component: record.component };

		const { sessionId, platform, issueIdentifier, repository } = record.context;
		if (sessionId) attributes.sessionId = sessionId;
		if (platform) attributes.platform = platform;
		if (issueIdentifier) attributes.issueIdentifier = issueIdentifier;
		if (repository) attributes.repository = repository;
		if (record.event !== undefined) attributes.event = record.event;
		if (record.args !== undefined) {
			attributes.args = truncate(record.args, MAX_ARGS_CHARS);
		}

		// Call-site attributes come last so they win a collision with the context
		// keys above — the same precedence `Logger.formatJson` applies, so the OTLP
		// payload and the JSON console line never disagree about a shared key.
		let count = Object.keys(attributes).length;
		for (const [key, value] of Object.entries(record.attributes ?? {})) {
			if (value === undefined) continue;
			// A key already present is an overwrite, not a new slot, so it must not
			// be blocked by a full map — otherwise which of two colliding keys wins
			// would depend on iteration order.
			if (count >= MAX_ATTRIBUTES && !(key in attributes)) continue;
			if (!(key in attributes)) count += 1;
			attributes[key] =
				typeof value === "string"
					? truncate(value, MAX_ATTRIBUTE_CHARS)
					: value;
		}

		return attributes;
	}
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}
