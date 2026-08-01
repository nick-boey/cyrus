import { describe, expect, it } from "vitest";
import { createCsrfTokens } from "../src/setup/csrf.js";

const SECRET = "unit-test-secret-do-not-use-in-prod";

describe("createCsrfTokens", () => {
	it("accepts a token it issued for the same principal", () => {
		const csrf = createCsrfTokens(SECRET, { now: () => 1_000 });
		expect(
			csrf.verify("alice@example.com", csrf.issue("alice@example.com")),
		).toBe(true);
	});

	// The token is bound to the principal it was issued for — this is what
	// makes it a *signed synchronizer* token rather than a bare shared
	// secret; a token intercepted or replayed under a different identity
	// must not verify.
	it("rejects a token issued for a different principal", () => {
		const csrf = createCsrfTokens(SECRET, { now: () => 1_000 });
		expect(
			csrf.verify("bob@example.com", csrf.issue("alice@example.com")),
		).toBe(false);
	});

	it("binds case-insensitively on the principal, matching email semantics elsewhere in the store", () => {
		const csrf = createCsrfTokens(SECRET, { now: () => 1_000 });
		const token = csrf.issue("Alice@Example.com");
		expect(csrf.verify("alice@example.com", token)).toBe(true);
	});

	it("defaults to an 8 hour TTL", () => {
		let now = 0;
		const csrf = createCsrfTokens(SECRET, { now: () => now });
		const token = csrf.issue("alice@example.com");

		now = 8 * 60 * 60 * 1000 - 1;
		expect(csrf.verify("alice@example.com", token)).toBe(true);

		now = 8 * 60 * 60 * 1000;
		expect(csrf.verify("alice@example.com", token)).toBe(false);
	});

	it("honors a configured ttlMs", () => {
		let now = 1_000;
		const csrf = createCsrfTokens(SECRET, { now: () => now, ttlMs: 60_000 });
		const token = csrf.issue("alice@example.com");

		now = 60_999;
		expect(csrf.verify("alice@example.com", token)).toBe(true);

		now = 61_001;
		expect(csrf.verify("alice@example.com", token)).toBe(false);
	});

	it("rejects a tampered signature", () => {
		const csrf = createCsrfTokens(SECRET, { now: () => 1_000 });
		const token = csrf.issue("alice@example.com");
		expect(csrf.verify("alice@example.com", `${token}x`)).toBe(false);
	});

	it("rejects a tampered expiry", () => {
		const csrf = createCsrfTokens(SECRET, { now: () => 1_000 });
		const token = csrf.issue("alice@example.com");
		const separator = token.lastIndexOf(".");
		const signature = token.slice(0, separator);
		const expiresAt = Number(token.slice(separator + 1));
		const tampered = `${signature}.${expiresAt + 60_000}`;
		expect(csrf.verify("alice@example.com", tampered)).toBe(false);
	});

	it("rejects malformed, truncated, or empty tokens without throwing", () => {
		const csrf = createCsrfTokens(SECRET, { now: () => 1_000 });
		const badTokens = [
			"",
			"nodot",
			"a.b.c",
			"....",
			"x.notanumber",
			".",
			".5000",
			"sig.",
			"sig",
		];
		for (const bad of badTokens) {
			expect(() => csrf.verify("alice@example.com", bad)).not.toThrow();
			expect(csrf.verify("alice@example.com", bad)).toBe(false);
		}
	});

	it("truncating a valid token invalidates it", () => {
		const csrf = createCsrfTokens(SECRET, { now: () => 1_000 });
		const token = csrf.issue("alice@example.com");
		expect(() =>
			csrf.verify("alice@example.com", token.slice(0, -5)),
		).not.toThrow();
		expect(csrf.verify("alice@example.com", token.slice(0, -5))).toBe(false);
	});

	// HMAC-SHA256: verified indirectly — the signature is deterministic given
	// (secret, principal, expiry), so a token issued under one secret must
	// fail verification under a different secret.
	it("uses the configured secret in the signature (a different secret invalidates every outstanding token)", () => {
		const token = createCsrfTokens(SECRET, { now: () => 1_000 }).issue(
			"alice@example.com",
		);
		const otherCsrf = createCsrfTokens("a-completely-different-secret", {
			now: () => 1_000,
		});
		expect(otherCsrf.verify("alice@example.com", token)).toBe(false);
	});

	it("produces a signature segment safe for a form field (no query-string-hostile characters)", () => {
		const csrf = createCsrfTokens(SECRET, { now: () => 1_000 });
		const token = csrf.issue("alice@example.com");
		const [signature] = token.split(".");
		expect(signature).toMatch(/^[A-Za-z0-9_-]+$/);
	});
});
