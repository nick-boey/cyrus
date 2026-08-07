export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
	SILENT = 4,
}

export interface LogContext {
	sessionId?: string;
	platform?: string;
	issueIdentifier?: string;
	repository?: string;
	/**
	 * Extra flat attributes carried by every line this logger emits, spread
	 * into the JSON record exactly like an `event()`'s attributes are.
	 *
	 * The named fields above cover what most call sites need; this is the escape
	 * hatch for identifiers a specific host has and core does not model — the
	 * router's `device_id` / `issue_key` when it re-emits a sandbox worker's log,
	 * for instance. Keys are used verbatim, so use the same flat snake_case
	 * convention as the event vocabulary if the value is meant to be queried.
	 */
	attributes?: LogEventAttributes;
}

/**
 * Attribute values permitted on a structured log/event. Mirrors Sentry Logs'
 * primitive-only constraint so call sites can't accidentally ship rich objects
 * that would be silently dropped on the wire.
 */
export type LogEventAttributes = Record<
	string,
	string | number | boolean | null | undefined
>;

export interface ILogger {
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	/**
	 * Emit a named major event (session lifecycle, webhook received, message
	 * emitted, …). Always forwarded to the structured-log stream regardless of
	 * the local log level — call sites use this when a fact needs to land in
	 * Sentry Logs even when the operator is running at WARN or ERROR locally.
	 */
	event(name: string, attributes?: LogEventAttributes): void;
	withContext(context: LogContext): ILogger;
	getLevel(): LogLevel;
	setLevel(level: LogLevel): void;
}
