import {
	createLogger,
	cyrusAttributes,
	type ILogger,
	type LogEventAttributes,
} from "cyrus-core";
import type { LogFrame } from "cyrus-router-protocol";

/**
 * Re-emitted worker lines are tagged with this so a KQL query can separate them
 * from the router's own output in a single predicate
 * (`where p["cyrus.source"] == "sandbox"`), and so an operator reading raw
 * console output is never misled into thinking the router itself logged
 * something.
 */
export const SANDBOX_LOG_SOURCE = "sandbox";

/**
 * Component prefix applied to the worker's own component name. Keeps
 * `component` a single queryable value that is unambiguous about where the line
 * came from: `sandbox/EdgeWorker` can never collide with the router's own
 * `EdgeWorker`-like names.
 */
const COMPONENT_PREFIX = "sandbox/";

/**
 * Defensive caps on values that arrived over the wire. The device already
 * truncates, but the router must not depend on a well-behaved device: these are
 * the values that get written into the log stream we pay for per GB.
 */
const MAX_MESSAGE_CHARS = 8_000;
const MAX_COMPONENT_CHARS = 128;
const MAX_ATTRIBUTES = 32;
const MAX_ATTRIBUTE_CHARS = 1_000;
/** Stacktraces are the payload of an error record; see RouterLogForwarder. */
const MAX_STACKTRACE_CHARS = 8_000;

/**
 * How many distinct worker components we keep a cached logger for. Bounded
 * because `component` is device-supplied: an unbounded map keyed on it is a
 * memory leak a buggy (or hostile) worker could drive.
 */
const MAX_CACHED_LOGGERS = 64;

/** Identity the ROUTER holds for a device, not anything the device asserted. */
export interface SandboxLogOrigin {
	deviceId: number;
	issueKey?: string;
	provider?: string;
}

/**
 * Re-emits a sandbox worker's forwarded log lines through the router's own
 * logger, attributed to the originating device and issue.
 *
 * This is the whole point of Phase 2. The ACA `sandboxGroups` resource is a
 * separate ARM resource from the Container Apps environment, so the Log
 * Analytics wiring on the environment never reaches it, and its data-plane API
 * has no logs endpoint at all. The router, by contrast, IS a Container App with
 * `CYRUS_LOG_FORMAT=json` — every line it writes to stdout is already collected
 * into `ContainerAppConsoleLogs_CL`. Re-emitting here therefore lets sandbox
 * logs inherit that path with no exporter, no egress-allowlist change, and no
 * Azure credential inside the sandbox.
 *
 * ── ATTRIBUTION IS ROUTER-SIDE ──
 * `cyrus.device_id` / `cyrus.issue_key` come from the device row the gateway
 * authenticated, NOT from the frame. A worker cannot label its logs with someone
 * else's issue. The device's own `issueIdentifier` is carried separately as
 * `cyrus.reported_issue_identifier` so a mismatch is visible rather than
 * silently resolved one way or the other.
 *
 * ── LEVEL MAPPING ──
 * A worker's WARN/ERROR is re-emitted at the SAME level, which means it also
 * inherits the router's `Logger.warn`/`Logger.error` side effects (Sentry
 * forwarding, when a reporter is installed). That is deliberate: a sandbox
 * error is a real error in the product, and burying it at INFO because it
 * happened one process away would defeat the purpose. `debug`/`info` map
 * straight across.
 */
export class SandboxLogRelay {
	private readonly baseLogger: ILogger;
	private readonly loggers = new Map<string, ILogger>();

	constructor(opts?: { logger?: ILogger }) {
		// Only used to inherit a level in tests; per-line loggers are built with
		// the worker's own component name.
		this.baseLogger = opts?.logger ?? createLogger({ component: "sandbox" });
	}

	/**
	 * Re-emit one forwarded frame. Never throws — this runs on the gateway's
	 * message path, where an exception would take down the device socket that
	 * happened to send a malformed line.
	 */
	relay(frame: LogFrame, origin: SandboxLogOrigin): void {
		try {
			const logger = this.loggerFor(frame.component, frame, origin);
			const message = truncate(frame.message, MAX_MESSAGE_CHARS);
			// Passed as a trailing arg rather than an attribute so it re-enters the
			// logger through the ordinary error path: `Logger` then derives the same
			// `exception.*` semconv it would for a locally-thrown error, and the
			// error reporter captures it as an exception with the WORKER's stack
			// instead of an opaque message. See rehydrateError.
			const args = rehydrateError(frame.exception);
			switch (frame.level) {
				case "error":
					logger.error(message, ...args);
					break;
				case "warn":
					logger.warn(message, ...args);
					break;
				case "debug":
					logger.debug(message, ...args);
					break;
				default:
					logger.info(message, ...args);
					break;
			}
		} catch {
			// A malformed line must not be able to break the socket it came from.
		}
	}

	/**
	 * Builds the contextual logger for one line.
	 *
	 * Not cached across lines despite the `loggers` map's name — the map only
	 * caches the per-component BASE logger, because the attributes
	 * (`dropped`, the frame's own event/args) differ line by line and baking
	 * them into a cached logger would leak one worker's attributes onto
	 * another's line.
	 */
	private loggerFor(
		component: string,
		frame: LogFrame,
		origin: SandboxLogOrigin,
	): ILogger {
		const safeComponent = truncate(component || "unknown", MAX_COMPONENT_CHARS);
		let base = this.loggers.get(safeComponent);
		if (!base) {
			// Bounded cache: `component` is device-supplied, so an unbounded map
			// keyed on it is a leak. Evicting the oldest is fine — a rebuilt
			// logger is cheap and behaves identically.
			if (this.loggers.size >= MAX_CACHED_LOGGERS) {
				const oldest = this.loggers.keys().next();
				if (!oldest.done) this.loggers.delete(oldest.value);
			}
			base = createLogger({
				component: `${COMPONENT_PREFIX}${safeComponent}`,
				level: this.baseLogger.getLevel(),
			});
			this.loggers.set(safeComponent, base);
		}

		// Router-side attribution, namespaced like every other Cyrus-specific
		// attribute (see `cyrusAttributes`). The structural keys below — `event`,
		// `args`, and the W3C trace-context pair — are deliberately NOT namespaced:
		// `event` and `args` mirror `LogRecord`'s own fields on the direct path, so
		// namespacing them here would make a relayed line and a locally-emitted one
		// disagree about the same fact, and `traceparent`/`tracestate` are
		// standard names owned by W3C rather than by us.
		const attributes: LogEventAttributes = cyrusAttributes({
			source: SANDBOX_LOG_SOURCE,
			device_id: origin.deviceId,
			issue_key: origin.issueKey ?? null,
			provider: origin.provider ?? null,
			// The device's clock, kept alongside the router's own timestamp so a
			// clock skew between sandbox and router is visible rather than
			// silently reordering the stream.
			emitted_at: frame.ts,
		});
		if (frame.event !== undefined) attributes.event = frame.event;
		if (frame.args !== undefined) {
			attributes.args = truncate(frame.args, MAX_ATTRIBUTE_CHARS);
		}
		if (frame.dropped !== undefined && frame.dropped > 0) {
			// Surfaced as a first-class attribute so `summarize sum(...)` reports
			// the real loss. A truncated log stream that does not say it was
			// truncated reads as complete.
			attributes["cyrus.dropped"] = frame.dropped;
		}
		if (frame.traceparent !== undefined) {
			attributes.traceparent = frame.traceparent;
		}
		if (frame.tracestate !== undefined) {
			attributes.tracestate = frame.tracestate;
		}
		if (
			frame.issueIdentifier !== undefined &&
			frame.issueIdentifier !== origin.issueKey
		) {
			// Only recorded when it disagrees with the router's own view — see
			// the class doc on router-side attribution.
			attributes["cyrus.reported_issue_identifier"] = frame.issueIdentifier;
		}
		for (const [key, value] of boundedEntries(frame.attributes)) {
			// Worker attributes never override the router's attribution keys.
			if (key in attributes) continue;
			attributes[key] = value;
		}

		return base.withContext({
			attributes,
			...(origin.issueKey ? { issueIdentifier: origin.issueKey } : {}),
			...(frame.sessionId ? { sessionId: frame.sessionId } : {}),
			...(frame.repository ? { repository: frame.repository } : {}),
		});
	}
}

/**
 * Rebuild an `Error` from a frame's exception fields, as a zero-or-one-element
 * arg list so the call sites stay a single spread.
 *
 * The reconstructed error deliberately carries the WORKER's stack verbatim. A
 * freshly-constructed Error's own stack points at this function and the gateway
 * message loop — frames that describe how the line reached the router and
 * nothing at all about why the sandbox failed.
 */
function rehydrateError(exception: LogFrame["exception"]): [Error] | [] {
	if (!exception) return [];
	const error = new Error(truncate(exception.message, MAX_MESSAGE_CHARS));
	error.name = truncate(exception.type, MAX_COMPONENT_CHARS);
	error.stack =
		exception.stacktrace !== undefined
			? truncate(exception.stacktrace, MAX_STACKTRACE_CHARS)
			: `${error.name}: ${error.message}`;
	return [error];
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

function boundedEntries(
	attributes: LogFrame["attributes"],
): Array<[string, string | number | boolean | null]> {
	if (!attributes) return [];
	return Object.entries(attributes)
		.slice(0, MAX_ATTRIBUTES)
		.map(([key, value]) => [
			key,
			typeof value === "string" ? truncate(value, MAX_ATTRIBUTE_CHARS) : value,
		]);
}
