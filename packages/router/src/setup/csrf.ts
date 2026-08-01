import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless signed synchronizer token for the `/setup*` routes.
 *
 * This is deliberately NOT the "double-submit cookie" pattern (F18): there is
 * no second, independently-set cookie for the server to compare against. It
 * is a single opaque token — HMAC-SHA256 over the principal and an expiry —
 * that the server hands out when it renders a page ({@link CsrfTokens.issue})
 * and requires back, unmodified and bound to the SAME principal, on every
 * mutating request ({@link CsrfTokens.verify}).
 *
 * Why this is needed at all: the EasyAuth session cookie is issued by the ACA
 * auth sidecar, so its `SameSite` attribute is not ours to set. A cross-site
 * form POST riding that cookie is therefore possible, and this token is what
 * a mutating `/setup*` route checks to refuse it.
 *
 * Delivery (F18): the token belongs in the POST form body or an
 * `X-CSRF-Token` header — NEVER a query string, where an 8-hour-lived token
 * would land in server access logs and browser history.
 */

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

export interface CsrfTokensOptions {
	/** Token lifetime in milliseconds. Default 8 hours. */
	ttlMs?: number;
	/** Test seam. Defaults to `Date.now`. */
	now?: () => number;
}

export interface CsrfTokens {
	/** Mints a token bound to `principalKey`, valid from now for `ttlMs`. */
	issue(principalKey: string): string;
	/**
	 * True only for a token that: verifies against `secret`, has not
	 * expired, and was issued for exactly this `principalKey`.
	 */
	verify(principalKey: string, token: string): boolean;
}

function sign(secret: string, principalKey: string, expiresAt: number): string {
	return createHmac("sha256", secret)
		.update(`${principalKey.toLowerCase()}|${expiresAt}`)
		.digest("base64url");
}

/**
 * Builds a `CsrfTokens` instance over a caller-supplied `secret`. The router
 * is single-replica (per `CLAUDE.md`), so there is no cross-replica
 * validation to worry about; the routes layer (a later wave) is expected to
 * pass a per-process secret so a restart naturally invalidates outstanding
 * tokens.
 */
export function createCsrfTokens(
	secret: string,
	opts: CsrfTokensOptions = {},
): CsrfTokens {
	const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
	const now = opts.now ?? Date.now;

	return {
		issue(principalKey: string): string {
			const expiresAt = now() + ttlMs;
			return `${sign(secret, principalKey, expiresAt)}.${expiresAt}`;
		},

		verify(principalKey: string, token: string): boolean {
			try {
				const separator = token.lastIndexOf(".");
				if (separator <= 0) return false;

				const signature = token.slice(0, separator);
				const expiresAtRaw = token.slice(separator + 1);
				if (!/^\d+$/.test(expiresAtRaw)) return false;

				const expiresAt = Number(expiresAtRaw);
				if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) {
					return false;
				}

				const expected = Buffer.from(sign(secret, principalKey, expiresAt));
				const actual = Buffer.from(signature);
				// timingSafeEqual throws on a length mismatch, so gate on
				// length first — that comparison is not itself required to be
				// constant time, since token length reveals nothing.
				return (
					expected.length === actual.length && timingSafeEqual(expected, actual)
				);
			} catch {
				// A malformed/garbage token must never throw out of verify()
				// — it is untrusted input on every mutating request.
				return false;
			}
		},
	};
}
