/**
 * Error extraction and OpenTelemetry exception-semconv shaping.
 *
 * Split out of `Logger.ts` so the two consumers that need it — the logger
 * itself, and anything reconstructing a record that arrived over a wire — share
 * one definition of "which Error did this call site mean, and how does it map
 * onto `exception.*`".
 *
 * Semconv reference: the exception attributes (`exception.type`,
 * `exception.message`, `exception.stacktrace`) are STABLE in OpenTelemetry, which
 * is why this is the one place Phase 4 adopts semconv wholesale rather than
 * keeping Cyrus-native names. Everything Cyrus-specific stays in `cyrus.*`.
 */

/** How many `cause` links to walk before giving up. */
const MAX_CAUSE_DEPTH = 5;

/**
 * The OTel exception attributes for one log record, in structured form.
 *
 * Kept as an object on `LogRecord` rather than three flat fields so a sink that
 * does not speak semconv (the JSON console renderer, the router WSS frame) can
 * carry it as a unit, and only the OTLP sink has to know the attribute names.
 */
export interface LogException {
	/** OTel `exception.type` — the error's `name`, e.g. `TypeError`. */
	type: string;
	/** OTel `exception.message`. */
	message: string;
	/**
	 * OTel `exception.stacktrace` — the runtime's natural representation,
	 * including any `cause` chain appended as `Caused by:` blocks. Absent when
	 * the Error carried no stack (possible for a hand-rolled error object).
	 */
	stacktrace?: string;
}

/**
 * Find the {@link Error} a `logger.error(msg, ...args)` call site meant.
 *
 * Returns the OUTERMOST error — the one the call site was actually handed —
 * rather than the root cause, because that is what the message describes and
 * what its stack frames point at. The cause chain is preserved separately, in
 * {@link describeException}'s stacktrace.
 *
 * Also unwraps objects shaped like `{ error: Error }`, which several transports
 * pass instead of the bare Error.
 */
export function extractError(args: unknown[]): Error | undefined {
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

/**
 * Shape an {@link Error} into OTel exception semconv fields.
 *
 * The `cause` chain is folded into the stacktrace rather than dropped, because
 * semconv has no attribute for it and the root cause is routinely the only
 * useful frame: a transport that wraps `ECONNREFUSED` in
 * `new Error("failed to send", { cause })` produces an outer stack that points
 * exclusively at our own retry helper.
 *
 * Cycle- and depth-guarded: `cause` is caller-supplied and nothing stops it
 * pointing back at its own wrapper.
 */
export function describeException(error: Error): LogException {
	const exception: LogException = {
		type: error.name || error.constructor?.name || "Error",
		message: error.message,
	};
	const stacktrace = buildStacktrace(error);
	if (stacktrace) exception.stacktrace = stacktrace;
	return exception;
}

/** {@link describeException} for the first Error in a set of trailing args. */
export function describeExceptionFromArgs(
	args: unknown[],
): LogException | undefined {
	const error = extractError(args);
	return error ? describeException(error) : undefined;
}

/**
 * Render `exception.*` as the flat attribute map OTLP wants. Kept here so the
 * OTLP sink and the router's relay (which re-stamps a worker's exception onto
 * its own record) cannot drift on the key names.
 */
export function exceptionAttributes(
	exception: LogException,
): Record<string, string> {
	return {
		"exception.type": exception.type,
		"exception.message": exception.message,
		...(exception.stacktrace !== undefined
			? { "exception.stacktrace": exception.stacktrace }
			: {}),
	};
}

function buildStacktrace(error: Error): string | undefined {
	const parts: string[] = [];
	const seen = new WeakSet<object>();
	let current: unknown = error;
	let depth = 0;

	while (current instanceof Error && depth <= MAX_CAUSE_DEPTH) {
		if (seen.has(current)) break;
		seen.add(current);
		const rendered = current.stack ?? `${current.name}: ${current.message}`;
		parts.push(depth === 0 ? rendered : `Caused by: ${rendered}`);
		current = current.cause;
		depth += 1;
	}

	// A non-Error cause (a string, a response body) still names the real
	// failure often enough to be worth one line.
	if (current !== undefined && !(current instanceof Error)) {
		parts.push(`Caused by: ${stringifyCause(current)}`);
	}

	if (parts.length === 0) return undefined;
	// A single frame-less error contributes only `Name: message`, which
	// `exception.type` and `exception.message` already carry.
	if (parts.length === 1 && error.stack === undefined) return undefined;
	return parts.join("\n");
}

function stringifyCause(cause: unknown): string {
	if (typeof cause === "string") return cause;
	try {
		return JSON.stringify(cause) ?? String(cause);
	} catch {
		return String(cause);
	}
}
