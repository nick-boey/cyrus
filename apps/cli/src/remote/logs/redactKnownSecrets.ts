import { REDACTED, redactSecrets } from "../errors.js";

/**
 * Removes credential material from a log record before it reaches an operator's
 * terminal, a CI log, or an orchestrating agent's context.
 *
 * ── WHY THIS IS NOT `redactSecrets` ALONE ──
 * `redactSecrets` (in `errors.ts`) recognises credentials by their SHAPE — a
 * bearer header, a JWT, a `cyop_` token — which is the right tool for prose we
 * did not write, like a router error body. A log record is a different problem:
 * it is a structured object, and the most common way a secret appears in one is
 * not as a recognisable shape but as an ordinary-looking string sitting under a
 * key called `token`. `sk-…`, a 40-character hex PAT, and a base64 blob are all
 * indistinguishable from an id. So this module adds two things shape-matching
 * cannot do:
 *
 *  1. KEY-based redaction. A value under a key naming a credential is redacted
 *     whatever it looks like. Over-redacting a field called `tokenCount` costs
 *     an operator one question; under-redacting writes a live credential into a
 *     log that outlives it.
 *
 *  2. VALUE-based redaction against secrets THIS PROCESS holds. If a log line
 *     happens to contain the exact value of a secret in our own environment, we
 *     can recognise it with certainty even though nothing about its shape says
 *     "secret". This is the only check that catches a credential logged as a
 *     bare argument, which is precisely how they escape.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ──
 * It does not attempt entropy heuristics. A high-entropy string is usually a
 * run id, a device id, or a git SHA, and redacting those would remove the very
 * fields an operator is correlating on — turning a working investigation into a
 * page of `[redacted]`.
 */

/**
 * Keys whose VALUE is a credential, whatever it looks like.
 *
 * Matched against the key with word boundaries so `token` and `access_token`
 * hit while `tokens_used` — a real attribute on agent-run records, and a number
 * an operator reads — does not. The list is intentionally about the noun rather
 * than the exact spelling, because every emitter in the fleet chose its own
 * casing and separator.
 */
const SECRET_KEY_PATTERN =
	/(^|[._\-\s])(token|secret|password|passwd|credential|credentials|apikey|api_key|api-key|authorization|auth_header|private_key|privatekey|client_secret|shared_key|sas|connection_string|connectionstring)($|[._\-\s])/i;

/**
 * Keys that LOOK like the above and are not.
 *
 * Checked first, so a genuinely useful numeric or boolean attribute survives.
 * Kept short on purpose: every entry here is a hole in key-based redaction, and
 * the bar for adding one is that the key is known to carry a non-secret in a
 * record an operator actually reads.
 */
const SECRET_KEY_EXCEPTIONS =
	/(^|[._-])(token_count|tokens_used|input_tokens|output_tokens|cache_read_input_tokens|cache_creation_input_tokens|has_token|token_expires_at|secret_store|secret_backend|has_secrets|credential_source)($|[._-])/i;

/**
 * Environment variables whose VALUES must never appear in output.
 *
 * These are the credentials a Cyrus host holds. A log line quoting one is
 * quoting a live secret, and because we hold the value we can recognise it
 * exactly rather than guessing from its shape.
 */
export const KNOWN_SECRET_ENV_KEYS: readonly string[] = [
	"ANTHROPIC_API_KEY",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"CYRUS_OPERATOR_TOKEN",
	"GITHUB_TOKEN",
	"GH_TOKEN",
	"LINEAR_API_TOKEN",
	"LINEAR_OAUTH_CLIENT_SECRET",
	"LINEAR_WEBHOOK_SECRET",
	"SLACK_BOT_TOKEN",
	"SLACK_SIGNING_SECRET",
	"AZURE_CLIENT_SECRET",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
];

/**
 * Below this length, a value is not treated as a secret to search for.
 *
 * An environment variable set to `1`, `true`, or a short word would otherwise
 * turn every record containing that substring into `[redacted]` — which
 * destroys the output while protecting nothing, and does so only on the hosts
 * that happen to have set it, making it look like a backend fault.
 */
const MIN_SEARCHABLE_SECRET_LENGTH = 12;

/** A redaction pass over one record's fields. */
export interface RedactionResult<T> {
	value: T;
	/** True when anything was removed, so a record can say so on the wire. */
	redacted: boolean;
}

/**
 * The exact secret values to search output for, read from an environment.
 *
 * Built once per command rather than per record: reading `process.env` for each
 * of thousands of records is measurable, and the environment does not change
 * within a run.
 */
export function collectKnownSecretValues(
	env: NodeJS.ProcessEnv = process.env,
	keys: readonly string[] = KNOWN_SECRET_ENV_KEYS,
): string[] {
	const values = new Set<string>();
	for (const key of keys) {
		const value = env[key]?.trim();
		if (value && value.length >= MIN_SEARCHABLE_SECRET_LENGTH) {
			values.add(value);
		}
	}
	// Longest first, so a secret that contains another as a prefix is replaced
	// whole rather than leaving its tail behind as a readable fragment.
	return [...values].sort((a, b) => b.length - a.length);
}

/** Whether a key names a credential, whatever its value looks like. */
export function isSecretKey(key: string): boolean {
	if (SECRET_KEY_EXCEPTIONS.test(key)) return false;
	return SECRET_KEY_PATTERN.test(key);
}

/**
 * Redacts one string: known secret values first, then credential shapes.
 *
 * Known values are removed first because they are certain, and because
 * replacing them shortens the text that the broader shape patterns then scan.
 */
export function redactText(
	text: string,
	knownValues: readonly string[] = [],
): RedactionResult<string> {
	let value = text;
	for (const secret of knownValues) {
		if (value.includes(secret)) value = value.split(secret).join(REDACTED);
	}
	const shaped = redactSecrets(value);
	return { value: shaped, redacted: shaped !== text };
}

/**
 * Redacts a record's message and attribute bag.
 *
 * Key-based redaction is applied to the attribute KEYS, and text redaction to
 * every attribute VALUE and to the message. A key that names a credential loses
 * its value entirely rather than having it scanned — the point of the key rule
 * is that its value's shape tells us nothing.
 */
export function redactKnownSecrets(
	input: { message: string; attributes?: Record<string, string> },
	knownValues: readonly string[] = [],
): RedactionResult<{ message: string; attributes?: Record<string, string> }> {
	const message = redactText(input.message, knownValues);
	let redacted = message.redacted;

	let attributes: Record<string, string> | undefined;
	if (input.attributes) {
		attributes = {};
		for (const [key, raw] of Object.entries(input.attributes)) {
			if (isSecretKey(key)) {
				// The KEY is kept. A reader has to be able to see that a credential
				// field was present and removed; dropping the key entirely makes a
				// redacted record indistinguishable from one that never had it.
				attributes[key] = REDACTED;
				redacted = true;
				continue;
			}
			const value = redactText(raw, knownValues);
			attributes[key] = value.value;
			redacted ||= value.redacted;
		}
	}

	return {
		value: {
			message: message.value,
			...(attributes ? { attributes } : {}),
		},
		redacted,
	};
}
