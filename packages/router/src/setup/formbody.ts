/**
 * Minimal `application/x-www-form-urlencoded` body parser.
 *
 * The router runs a bare `Fastify()` with no `@fastify/formbody` plugin, and
 * per the project's dependency policy we are not adding one for this. This
 * module is the hand-rolled parser, plus the safety rails a hand-rolled
 * parser needs to not become a liability:
 *  - a hard body-size ceiling (a urlencoded body is read fully into memory
 *    before parsing, so there is no other backpressure), and
 *  - an explicit prototype-pollution guard on the returned object's keys.
 *
 * Repeated keys matter here — the setup save form submits `value:NAME` /
 * `clear:NAME` fields per row — so every field comes back as a `string[]`,
 * never a bare string, regardless of whether it repeated.
 *
 * This module has no Fastify dependency itself; the routes layer (a later
 * wave) is responsible for registering it as a content-type parser.
 */

/** 64 KiB — a setup form is a handful of tokens, never more. */
export const DEFAULT_MAX_FORM_BODY_BYTES = 64 * 1024;

/** Names that must never become own properties of a plain object we build. */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export class FormBodyTooLargeError extends Error {
	constructor(byteLength: number, maxBytes: number) {
		super(
			`form body of ${byteLength} bytes exceeds the ${maxBytes}-byte limit`,
		);
		this.name = "FormBodyTooLargeError";
	}
}

export interface ParseFormBodyOptions {
	/** Maximum accepted body size in bytes. Default 64 KiB. */
	maxBytes?: number;
}

/**
 * Parses a raw `application/x-www-form-urlencoded` body string.
 *
 * Never throws on malformed input — a bad percent-escape or a stray `%`
 * decodes leniently rather than raising, because `decodeURIComponent` would
 * throw on exactly the malformed input a hostile or buggy client is most
 * likely to send, and a parser that can be crashed by a malformed body is
 * itself a liability. The one exception is `maxBytes`, which throws
 * {@link FormBodyTooLargeError} deliberately.
 */
export function parseFormBody(
	body: string,
	options: ParseFormBodyOptions = {},
): Record<string, string[]> {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_FORM_BODY_BYTES;
	const byteLength = Buffer.byteLength(body, "utf8");
	if (byteLength > maxBytes) {
		throw new FormBodyTooLargeError(byteLength, maxBytes);
	}

	// Object.create(null) is the first line of defense: even if a
	// "__proto__" key slipped past the explicit guard below, assigning it as
	// a bracket property on a null-prototype object just creates an ordinary
	// own data property — there is no inherited `__proto__` accessor here to
	// trigger, unlike on `{}`. We ALSO explicitly drop the three dangerous
	// names below so no caller ever observes them on the returned object,
	// regardless of what it does with the result (e.g. spreading it into a
	// ordinary object elsewhere).
	const result: Record<string, string[]> = Object.create(null);
	if (body.length === 0) return result;

	for (const pair of body.split("&")) {
		if (pair === "") continue;
		const eq = pair.indexOf("=");
		const rawKey = eq === -1 ? pair : pair.slice(0, eq);
		const rawValue = eq === -1 ? "" : pair.slice(eq + 1);

		const key = decodeFormComponent(rawKey);
		if (DANGEROUS_KEYS.has(key)) continue;

		const value = decodeFormComponent(rawValue);
		if (!Object.hasOwn(result, key)) result[key] = [];
		result[key]?.push(value);
	}

	return result;
}

/**
 * Decodes a single urlencoded component: `+` as space, then percent-decoded
 * as UTF-8. Bytes are accumulated across the whole component (not decoded
 * triplet-by-triplet) so a multi-byte UTF-8 sequence split across several
 * `%XX` escapes decodes correctly; the accumulated bytes are then decoded
 * with a non-fatal `TextDecoder`, which substitutes U+FFFD for genuinely
 * invalid UTF-8 instead of throwing.
 */
function decodeFormComponent(raw: string): string {
	const withSpaces = raw.replace(/\+/g, " ");
	const bytes: number[] = [];

	for (let i = 0; i < withSpaces.length; i++) {
		const ch = withSpaces[i] as string;
		if (
			ch === "%" &&
			isHexDigit(withSpaces[i + 1]) &&
			isHexDigit(withSpaces[i + 2])
		) {
			bytes.push(Number.parseInt(withSpaces.slice(i + 1, i + 3), 16));
			i += 2;
			continue;
		}
		// Not a valid %XX escape (including a stray trailing '%'): keep the
		// character literally, re-encoded as its own UTF-8 bytes.
		const codePoint = withSpaces.codePointAt(i) as number;
		for (const byte of Buffer.from(String.fromCodePoint(codePoint), "utf8")) {
			bytes.push(byte);
		}
		if (codePoint > 0xffff) i++; // consumed both halves of a surrogate pair
	}

	return new TextDecoder("utf-8", { fatal: false }).decode(
		Uint8Array.from(bytes),
	);
}

function isHexDigit(ch: string | undefined): boolean {
	return ch !== undefined && /^[0-9a-fA-F]$/.test(ch);
}
