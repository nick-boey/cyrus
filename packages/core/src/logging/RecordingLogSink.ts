import { LogLevel } from "./ILogger.js";
import type { LogRecord, LogSink } from "./LogSink.js";
import { getGlobalLogSink, setGlobalLogSink } from "./LogSink.js";

/**
 * Predicate for {@link RecordingLogSink.find}. Every supplied field must match;
 * omitted fields are ignored.
 */
export interface LogRecordQuery {
	/** Exact string, or a pattern the message must match. */
	message?: string | RegExp;
	/** The `event()` name, for records emitted via {@link ILogger.event}. */
	event?: string;
	level?: LogLevel;
	component?: string;
}

/**
 * A {@link LogSink} that keeps every record it is handed.
 *
 * ── WHY THIS IS THE RIGHT WAY TO ASSERT ON LOGGING ──
 * The obvious alternative — spying on `console.log` and regexing the rendered
 * line — couples a test to the *presentation* of a log line rather than its
 * content. Those assertions look like this:
 *
 *     expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(
 *       /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[INFO ] \[ClaudeRunner] \[event:x] \{"y":"z"\}$/))
 *
 * which breaks on a timestamp format change, a level-label width change, a
 * context-brace change, or `CYRUS_LOG_FORMAT=json` — none of which alter the
 * fact the test is actually about. Asserting on the record says what is meant:
 * `{ event: "x", attributes: { y: "z" } }`.
 *
 * Not test-only: the same class is a reasonable in-process buffer for a
 * diagnostic endpoint, which is why it ships in `src` rather than a test helper.
 */
export class RecordingLogSink implements LogSink {
	readonly records: LogRecord[] = [];

	/**
	 * Defaults to DEBUG so a test sees everything by default. `Logger` applies
	 * this as a pre-filter, so narrowing it is how a test exercises the
	 * threshold itself.
	 */
	constructor(readonly minLevel: LogLevel = LogLevel.DEBUG) {}

	write(record: LogRecord): void {
		this.records.push(record);
	}

	clear(): void {
		this.records.length = 0;
	}

	/** Every recorded message, in order. Handy for a whole-sequence assertion. */
	messages(): string[] {
		return this.records.map((record) => record.message);
	}

	/** Names of the `event()` records only, in order. */
	eventNames(): string[] {
		return this.records
			.filter((record) => record.event !== undefined)
			.map((record) => record.event as string);
	}

	/** The first record matching every supplied field of `query`. */
	find(query: LogRecordQuery): LogRecord | undefined {
		return this.records.find((record) => matchesQuery(record, query));
	}

	/** All records matching every supplied field of `query`. */
	findAll(query: LogRecordQuery): LogRecord[] {
		return this.records.filter((record) => matchesQuery(record, query));
	}
}

function matchesQuery(record: LogRecord, query: LogRecordQuery): boolean {
	if (query.event !== undefined && record.event !== query.event) return false;
	if (query.level !== undefined && record.level !== query.level) return false;
	if (query.component !== undefined && record.component !== query.component) {
		return false;
	}
	if (typeof query.message === "string") {
		// Substring rather than equality: most call sites interpolate an id or a
		// path into the message, and a test asserting on the stable part of it
		// should not have to reproduce the whole string.
		return record.message.includes(query.message);
	}
	if (query.message instanceof RegExp)
		return query.message.test(record.message);
	return true;
}

/** Handle returned by {@link installRecordingLogSink}. */
export interface InstalledRecordingLogSink {
	sink: RecordingLogSink;
	/** Restore whatever sink was installed before. Safe to call twice. */
	restore(): void;
}

/**
 * Install a {@link RecordingLogSink} process-wide and hand back a `restore`.
 *
 * Intended for a test's `beforeEach`/`afterEach`. Restoring the PREVIOUS sink
 * rather than resetting to the no-op matters when suites run in one process: a
 * test that resets unconditionally would silently disarm an outer sink.
 */
export function installRecordingLogSink(
	minLevel: LogLevel = LogLevel.DEBUG,
): InstalledRecordingLogSink {
	const sink = new RecordingLogSink(minLevel);
	const previous = getGlobalLogSink();
	let restored = false;
	setGlobalLogSink(sink);
	return {
		sink,
		restore: () => {
			if (restored) return;
			restored = true;
			setGlobalLogSink(previous);
		},
	};
}
