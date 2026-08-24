import type { LogRecord, LogSink } from "cyrus-core";
import { LogLevel } from "cyrus-core";
import type { LogFrame, LogFrameLevel } from "cyrus-router-protocol";
import type { RouterConnection } from "./RouterConnection.js";

/**
 * Default level threshold. WARN rather than INFO because the workspace behind
 * this is PerGB2018 and every sandbox pays into it: warnings and errors are the
 * lines an operator actually opens Log Analytics to find, and named lifecycle
 * events ride past this threshold anyway (see {@link RouterLogForwarder.write}),
 * so the useful `sandbox_*` vocabulary from Phase 1 ships regardless.
 */
const DEFAULT_MIN_LEVEL = LogLevel.WARN;

/**
 * Token-bucket defaults: 2 records/second sustained, 40 in a burst.
 *
 * Sized against what a worker actually emits — a session start or a crash
 * produces a short burst of tens of lines, which the bucket absorbs whole,
 * while a stuck retry loop producing thousands is clamped to a rate that stays
 * legible and cheap. Both are overridable; see {@link RouterLogForwarderOptions}.
 */
const DEFAULT_RATE_PER_SEC = 2;
const DEFAULT_BURST = 40;

/**
 * Hard caps applied before the frame goes on the wire. A single log line should
 * never be able to push a multi-megabyte payload through the socket — a stack
 * trace, a stringified config, or a Claude response can all get very large.
 */
const MAX_MESSAGE_CHARS = 4_000;
const MAX_ARGS_CHARS = 2_000;
const MAX_ATTRIBUTES = 32;
/**
 * Stacktraces get a larger cap than a plain attribute: the stack (plus any
 * `Caused by:` chain) is the payload an operator opens a sandbox error to read,
 * and clipping it at the message cap loses the frames in our own code.
 */
const MAX_STACKTRACE_CHARS = 8_000;

const LEVEL_NAMES: Record<number, LogFrameLevel> = {
	[LogLevel.DEBUG]: "debug",
	[LogLevel.INFO]: "info",
	[LogLevel.WARN]: "warn",
	[LogLevel.ERROR]: "error",
};

function parseLevel(raw: string | undefined): LogLevel | undefined {
	switch (raw?.toUpperCase()) {
		case "DEBUG":
			return LogLevel.DEBUG;
		case "INFO":
			return LogLevel.INFO;
		case "WARN":
			return LogLevel.WARN;
		case "ERROR":
			return LogLevel.ERROR;
		// SILENT is a valid way to turn forwarding off entirely without
		// unregistering the sink.
		case "SILENT":
			return LogLevel.SILENT;
		default:
			return undefined;
	}
}

function parsePositiveNumber(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

export interface RouterLogForwarderOptions {
	connection: RouterConnection;
	/** Defaults to `CYRUS_LOG_FORWARD_LEVEL`, then WARN. */
	minLevel?: LogLevel;
	/** Sustained records/second. Defaults to `CYRUS_LOG_FORWARD_RATE`, then 2. */
	ratePerSec?: number;
	/** Bucket capacity. Defaults to `CYRUS_LOG_FORWARD_BURST`, then 40. */
	burst?: number;
	/** Env source for the defaults above. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Injectable clock for the token bucket (tests). Defaults to `Date.now`. */
	now?: () => number;
}

/**
 * A {@link LogSink} that ships a sandbox worker's logs to the router over the
 * WSS connection it already holds, so they land in Log Analytics instead of
 * dying with the sandbox.
 *
 * Three guards stand between the logger and the socket, in order:
 *
 *  1. **Level threshold** ({@link minLevel}) — applied by `Logger` itself as a
 *     cheap pre-filter, so a DEBUG line costs nothing when we don't want it.
 *     Named `event()` records bypass it, matching `ILogger.event`'s contract
 *     that a major event always reaches the structured stream.
 *  2. **Token bucket** — the volume guard proper. A stuck retry loop cannot
 *     turn one worker into a firehose billed per GB.
 *  3. **Size caps** — message, args, and attribute count.
 *
 * Nothing is dropped silently: every rejected record increments a counter
 * carried on the next frame that *does* get through, so
 * `summarize sum(dropped)` in KQL reports the real loss.
 *
 * ── RE-ENTRANCY ──
 * This sink is called FROM the logger, and everything it touches
 * (`RouterConnection`, `ws`) has loggers of its own. A single unguarded
 * `logger.warn` on the send path would therefore re-enter `write` and recurse
 * without bound. Hence {@link inWrite}: anything logged while a write is in
 * flight is dropped on the floor rather than forwarded. For the same reason
 * this class never logs anything itself.
 */
export class RouterLogForwarder implements LogSink {
	private readonly connection: RouterConnection;
	private readonly now: () => number;
	private readonly ratePerSec: number;
	private readonly burst: number;
	private level: LogLevel;

	private tokens: number;
	private lastRefillMs: number;
	private dropped = 0;
	private inWrite = false;

	constructor(opts: RouterLogForwarderOptions) {
		const env = opts.env ?? process.env;
		this.connection = opts.connection;
		this.now = opts.now ?? (() => Date.now());
		this.level =
			opts.minLevel ??
			parseLevel(env.CYRUS_LOG_FORWARD_LEVEL) ??
			DEFAULT_MIN_LEVEL;
		this.ratePerSec =
			opts.ratePerSec ??
			parsePositiveNumber(env.CYRUS_LOG_FORWARD_RATE) ??
			DEFAULT_RATE_PER_SEC;
		this.burst =
			opts.burst ??
			parsePositiveNumber(env.CYRUS_LOG_FORWARD_BURST) ??
			DEFAULT_BURST;
		this.tokens = this.burst;
		this.lastRefillMs = this.now();
	}

	get minLevel(): LogLevel {
		return this.level;
	}

	/** Widen or narrow the threshold at runtime (e.g. from a config reload). */
	setMinLevel(level: LogLevel): void {
		this.level = level;
	}

	/** Records the volume guard has discarded and not yet reported. Test seam. */
	get droppedCount(): number {
		return this.dropped;
	}

	write(record: LogRecord): void {
		// See the class doc's RE-ENTRANCY note. A record produced while we are
		// mid-send is discarded outright — NOT counted as dropped, because
		// counting it would itself be a change of state driven by our own
		// plumbing rather than by the worker's real log volume.
		if (this.inWrite) return;

		// An `event()` bypasses the level threshold (Logger does not apply it for
		// events) but must still pay for a token — the rate limit is about cost,
		// and a runaway event emitter costs exactly as much as a runaway warn.
		if (record.event === undefined && record.level < this.level) return;

		if (!this.connection.acceptsLogs) {
			// The router cannot ingest logs (older deployment). Don't count these:
			// a permanently-unsupported destination is a deployment fact, not a
			// volume-guard drop, and reporting it as loss on some future upgrade
			// would be misleading.
			return;
		}

		if (!this.takeToken()) {
			this.dropped += 1;
			return;
		}

		this.inWrite = true;
		try {
			const sent = this.connection.sendLog(this.toFrame(record));
			// Offline, or a socket that closed mid-send. Counted: these are real
			// lines the operator will not see, and the count rides the first frame
			// that lands after the worker reconnects.
			if (!sent) this.dropped += 1;
			else this.dropped = 0;
		} catch {
			this.dropped += 1;
		} finally {
			this.inWrite = false;
		}
	}

	/**
	 * Classic token bucket. Refills continuously from elapsed WALL-CLOCK time
	 * rather than on a timer, which matters here for the same reason it matters
	 * in `RouterConnection`'s liveness watchdog: an ACA memory suspend freezes
	 * every JavaScript timer, and a timer-driven refill would resume with an
	 * empty bucket and throttle exactly the post-resume lines an operator is
	 * most likely to be looking for.
	 */
	private takeToken(): boolean {
		const now = this.now();
		const elapsedMs = Math.max(0, now - this.lastRefillMs);
		this.lastRefillMs = now;
		this.tokens = Math.min(
			this.burst,
			this.tokens + (elapsedMs / 1000) * this.ratePerSec,
		);
		if (this.tokens < 1) return false;
		this.tokens -= 1;
		return true;
	}

	private toFrame(record: LogRecord): LogFrame {
		const level = LEVEL_NAMES[record.level] ?? "info";
		return {
			type: "log",
			ts: new Date(record.timestampMs).toISOString(),
			level,
			component: record.component,
			message: truncate(record.message, MAX_MESSAGE_CHARS),
			...(record.event !== undefined ? { event: record.event } : {}),
			...(record.context.sessionId
				? { sessionId: record.context.sessionId }
				: {}),
			...(record.context.issueIdentifier
				? { issueIdentifier: record.context.issueIdentifier }
				: {}),
			...(record.context.repository
				? { repository: record.context.repository }
				: {}),
			...(record.attributes
				? { attributes: boundAttributes(record.attributes) }
				: {}),
			...(record.args ? { args: truncate(record.args, MAX_ARGS_CHARS) } : {}),
			...(record.exception
				? {
						exception: {
							type: truncate(record.exception.type, 256),
							message: truncate(record.exception.message, MAX_MESSAGE_CHARS),
							...(record.exception.stacktrace !== undefined
								? {
										stacktrace: truncate(
											record.exception.stacktrace,
											MAX_STACKTRACE_CHARS,
										),
									}
								: {}),
						},
					}
				: {}),
			...(this.dropped > 0 ? { dropped: this.dropped } : {}),
		};
	}
}

/**
 * Bounds the attribute map and strips `undefined` (which JSON.stringify would
 * drop anyway, but which the frame schema does not permit as a value).
 */
function boundAttributes(
	attributes: Record<string, string | number | boolean | null | undefined>,
): Record<string, string | number | boolean | null> {
	const out: Record<string, string | number | boolean | null> = {};
	let count = 0;
	for (const [key, value] of Object.entries(attributes)) {
		if (value === undefined) continue;
		if (count >= MAX_ATTRIBUTES) break;
		out[key] = typeof value === "string" ? truncate(value, 512) : value;
		count += 1;
	}
	return out;
}
