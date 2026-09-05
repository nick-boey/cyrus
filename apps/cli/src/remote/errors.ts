import { ExitCode } from "./exitCodes.js";

/**
 * Failure vocabulary for the remote-operator commands.
 *
 * An orchestrating agent reads the exit code, not the prose, so the code is a
 * property of the ERROR rather than of the call site that happens to catch it.
 * The categories themselves live in {@link ExitCode}; the aliases below are the
 * names this module shipped with and are kept so existing imports keep working.
 */

/** Success, or a satisfied wait condition. */
export const EXIT_SUCCESS = ExitCode.success;
/** Invalid invocation, invalid configuration, or an unsupported capability. */
export const EXIT_USAGE = ExitCode.usage;
/** A valid non-success run outcome, or a refused recovery. */
export const EXIT_OUTCOME = ExitCode.outcome;
/** The command's own wait condition was not met in time. */
export const EXIT_TIMEOUT = ExitCode.timeout;
/** Authentication or authorization failure. */
export const EXIT_AUTH = ExitCode.auth;
/** A transient router or log-source failure. */
export const EXIT_TRANSIENT = ExitCode.transient;

/**
 * Base class for every failure the remote commands report deliberately.
 *
 * Anything NOT derived from this is an unexpected defect and must not be
 * flattened into one of these categories — a bug reported as `6` tells an
 * operator to retry a command that will never succeed.
 */
export abstract class RemoteOperatorError extends Error {
	abstract readonly exitCode: number;

	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = new.target.name;
	}
}

/** Invalid invocation, invalid configuration, or an unsupported capability. */
export class UsageError extends RemoteOperatorError {
	readonly exitCode = EXIT_USAGE;
}

/** A valid but non-success outcome, e.g. a run that ended in error. */
export class OutcomeError extends RemoteOperatorError {
	readonly exitCode = EXIT_OUTCOME;
}

/** The command's own wait condition was not satisfied in time. */
export class TimeoutError extends RemoteOperatorError {
	readonly exitCode = EXIT_TIMEOUT;
}

/**
 * The credential was missing, rejected, or insufficient.
 *
 * Distinct from {@link TransientError} on purpose: retrying an unauthorized
 * request is pure noise against the router, and an orchestrator that cannot
 * tell the two apart will do exactly that.
 */
export class AuthorizationError extends RemoteOperatorError {
	readonly exitCode = EXIT_AUTH;
}

/** The router or log source failed in a way that may succeed on retry. */
export class TransientError extends RemoteOperatorError {
	readonly exitCode = EXIT_TRANSIENT;
}

/**
 * The change cursor was minted by a previous router process (`410 Gone`).
 *
 * Categorized as transient because that is the honest answer if it ever escapes
 * uncaught — the router is up, and the next attempt succeeds. In practice it
 * never should: `runs watch` and `runs wait` catch it, emit a `resync`, take a
 * fresh snapshot, and resume from the new epoch, because the one thing they must
 * NOT do is claim continuity across the restart interval (ADR 0016).
 */
export class StreamEpochChangedError extends RemoteOperatorError {
	readonly exitCode = EXIT_TRANSIENT;
}

export function isRemoteOperatorError(
	error: unknown,
): error is RemoteOperatorError {
	return error instanceof RemoteOperatorError;
}

/** What a redacted value is replaced with, so a reader can see something WAS removed. */
export const REDACTED = "[redacted]";

const REDACTION_PATTERNS: readonly RegExp[] = [
	// `Authorization: Bearer …` in any casing, however the router echoed it.
	/\bbearer\s+[\w\-._~+/]+=*/gi,
	// A JWT anywhere — an Entra access token, whether or not it was labelled.
	/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g,
	// A local operator token minted by `cyrus router operators create-token`.
	/\bcyop_[0-9a-f]{8,}/gi,
	// An `authorization`/`token`/`secret` field in a JSON or header dump.
	/(["']?(?:authorization|token|access_token|secret)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
];

/**
 * Strips credential material out of text destined for a log or an error.
 *
 * Applied at the point text becomes a DIAGNOSTIC rather than at the point it is
 * printed: a router response body reaches us as an error message long before
 * anyone decides to log it, and by then the redaction site is whoever happens
 * to catch it. The patterns are deliberately broad — over-redacting a router's
 * error prose costs an operator one extra request; under-redacting writes a
 * live bearer token into a CI log that outlives the token.
 */
export function redactSecrets(text: string): string {
	let redacted = text;
	for (const pattern of REDACTION_PATTERNS) {
		redacted = redacted.replace(pattern, (_match, prefix?: string) =>
			// The two-group patterns keep their field name so the reader can see
			// WHICH field was removed; the rest are replaced whole.
			typeof prefix === "string" ? `${prefix}${REDACTED}` : REDACTED,
		);
	}
	return redacted;
}

/**
 * A short, redacted excerpt of a response body for an error message.
 *
 * Bounded because a router that returns an HTML error page or a large JSON
 * document would otherwise bury the status code that actually explains the
 * failure.
 */
export function summarizeBody(body: string, maxLength = 300): string {
	const collapsed = redactSecrets(body).replace(/\s+/g, " ").trim();
	return collapsed.length > maxLength
		? `${collapsed.slice(0, maxLength)}…`
		: collapsed;
}
