import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	assertKekVersion,
	BundleTooLargeError,
	KeyVaultKeyWrapper,
	type KeyWrapper,
	MAX_BUNDLE_BYTES,
	openBundle,
	sealBundle,
} from "../src/setup/envelope.js";

const VAULT = "https://kv-test.vault.azure.net";
const KEY_NAME = "cyrus-setup-kek";
const VERSION_A = "0123456789abcdef0123456789abcdef";
const VERSION_B = "fedcba9876543210fedcba9876543210";
const KEY_ID = `${VAULT}/keys/${KEY_NAME}/${VERSION_A}`;

/**
 * Hostile `KekVersion` values. Each must be rejected before a single byte
 * leaves the process — the unwrap request carries a vault-scoped bearer token,
 * so building its URL from stored data would be an authenticated SSRF (D4′).
 */
const HOSTILE_VERSIONS = [
	"https://attacker.example/x",
	"../../evil",
	`${VERSION_A}f`, // 33 hex chars
	"",
	`${VERSION_A}\n`,
] as const;

/** Deterministic stand-in for Key Vault: XOR wrap, so tests need no network. */
function fakeWrapper(version = VERSION_A): KeyWrapper {
	const mask = Buffer.alloc(32, 0xab);
	return {
		async wrap(dek) {
			const wrapped = Buffer.alloc(dek.length);
			for (let i = 0; i < dek.length; i++) wrapped[i] = dek[i]! ^ mask[i]!;
			return { version, wrapped };
		},
		async unwrap(_version, wrapped) {
			const dek = Buffer.alloc(wrapped.length);
			for (let i = 0; i < wrapped.length; i++) dek[i] = wrapped[i]! ^ mask[i]!;
			return dek;
		},
	};
}

/** A wrapper that fails the test if it is ever touched. */
function forbiddenWrapper(): KeyWrapper & { calls: number } {
	const wrapper = {
		calls: 0,
		async wrap(): Promise<{ version: string; wrapped: Buffer }> {
			wrapper.calls++;
			throw new Error("wrap must not be reached");
		},
		async unwrap(): Promise<Buffer> {
			wrapper.calls++;
			throw new Error("unwrap must not be reached");
		},
	};
	return wrapper;
}

describe("sealBundle / openBundle", () => {
	const aad = `u${"a".repeat(64)}|bundle|1`;

	it("round-trips a bundle", async () => {
		const bundle = { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-x", GIT_TOKEN: "ghp_y" };
		const sealed = await sealBundle(bundle, fakeWrapper(), aad);
		expect(await openBundle(sealed, fakeWrapper(), aad)).toEqual(bundle);
	});

	it("round-trips an empty bundle", async () => {
		const sealed = await sealBundle({}, fakeWrapper(), aad);
		expect(await openBundle(sealed, fakeWrapper(), aad)).toEqual({});
	});

	it("never leaks a plaintext value or key name into the envelope", async () => {
		const sealed = await sealBundle(
			{ SECRET: "correct-horse-battery-staple" },
			fakeWrapper(),
			aad,
		);
		expect(JSON.stringify(sealed)).not.toContain("correct-horse");
		expect(JSON.stringify(sealed)).not.toContain("SECRET");
	});

	it("uses a fresh IV and DEK on every seal", async () => {
		const a = await sealBundle({ K: "v" }, fakeWrapper(), aad);
		const b = await sealBundle({ K: "v" }, fakeWrapper(), aad);
		expect(a.iv).not.toBe(b.iv);
		expect(a.wrappedDek).not.toBe(b.wrappedDek);
		expect(a.ciphertext).not.toBe(b.ciphertext);
	});

	it("rejects a tampered ciphertext", async () => {
		const sealed = await sealBundle({ K: "v" }, fakeWrapper(), aad);
		const raw = Buffer.from(sealed.ciphertext, "base64");
		raw[0] = raw[0]! ^ 0xff;
		await expect(
			openBundle(
				{ ...sealed, ciphertext: raw.toString("base64") },
				fakeWrapper(),
				aad,
			),
		).rejects.toThrow();
	});

	it("rejects a tampered auth tag", async () => {
		const sealed = await sealBundle({ K: "v" }, fakeWrapper(), aad);
		const tag = Buffer.from(sealed.authTag, "base64");
		tag[0] = tag[0]! ^ 0xff;
		await expect(
			openBundle(
				{ ...sealed, authTag: tag.toString("base64") },
				fakeWrapper(),
				aad,
			),
		).rejects.toThrow();
	});

	it("rejects a ciphertext moved onto another row (AAD binding)", async () => {
		const sealed = await sealBundle(
			{ K: "v" },
			fakeWrapper(),
			`u${"a".repeat(64)}|bundle|1`,
		);
		await expect(
			openBundle(sealed, fakeWrapper(), `u${"b".repeat(64)}|bundle|1`),
		).rejects.toThrow();
	});

	it("rejects a ciphertext replayed under a different schema version", async () => {
		const sealed = await sealBundle({ K: "v" }, fakeWrapper(), `${aad}`);
		await expect(
			openBundle(sealed, fakeWrapper(), aad.replace("|1", "|2")),
		).rejects.toThrow();
	});

	it("records the bare KEK version — never a URL", async () => {
		const sealed = await sealBundle({}, fakeWrapper(VERSION_B), aad);
		expect(sealed.kekVersion).toBe(VERSION_B);
		expect(JSON.stringify(sealed)).not.toContain("https://");
	});

	it("passes the stored version back to unwrap so a rotated KEK still opens old rows", async () => {
		const seen: string[] = [];
		const wrapper = fakeWrapper(VERSION_B);
		const spy: KeyWrapper = {
			wrap: wrapper.wrap,
			unwrap: async (version, wrapped) => {
				seen.push(version);
				return wrapper.unwrap(version, wrapped);
			},
		};
		const sealed = await sealBundle({ K: "v" }, spy, aad);
		await openBundle(sealed, spy, aad);
		expect(seen).toEqual([VERSION_B]);
	});

	it("rejects a non-string bundle value before encrypting", async () => {
		await expect(
			sealBundle({ K: 5 as unknown as string }, forbiddenWrapper(), aad),
		).rejects.toThrow(/not a string/);
	});

	it("rejects a decrypted payload that is not a flat string map", async () => {
		const dek = randomBytes(32);
		const iv = randomBytes(12);
		const cipher = createCipheriv("aes-256-gcm", dek, iv);
		cipher.setAAD(Buffer.from(aad, "utf-8"));
		const ciphertext = Buffer.concat([
			cipher.update(JSON.stringify(["a"]), "utf-8"),
			cipher.final(),
		]);
		const wrapper: KeyWrapper = {
			async wrap() {
				throw new Error("unused");
			},
			async unwrap() {
				return dek;
			},
		};
		await expect(
			openBundle(
				{
					kekVersion: VERSION_A,
					wrappedDek: dek.toString("base64"),
					iv: iv.toString("base64"),
					authTag: cipher.getAuthTag().toString("base64"),
					ciphertext: ciphertext.toString("base64"),
				},
				wrapper,
				aad,
			),
		).rejects.toThrow(/object/);
	});
});

describe("bundle size limit (D3′)", () => {
	const aad = `u${"a".repeat(64)}|bundle|1`;

	it("accepts a bundle of exactly the limit", async () => {
		// {"BIG":"<pad>"} — 10 bytes of framing plus the padding.
		const pad = "x".repeat(MAX_BUNDLE_BYTES - 10);
		const bundle = { BIG: pad };
		expect(Buffer.byteLength(JSON.stringify(bundle), "utf-8")).toBe(
			MAX_BUNDLE_BYTES,
		);
		await expect(sealBundle(bundle, fakeWrapper(), aad)).resolves.toBeDefined();
	});

	it("rejects one byte over the limit, naming the offending variable", async () => {
		const wrapper = forbiddenWrapper();
		const bundle = {
			SMALL: "a",
			HUGE: "x".repeat(MAX_BUNDLE_BYTES),
		};
		await expect(sealBundle(bundle, wrapper, aad)).rejects.toBeInstanceOf(
			BundleTooLargeError,
		);
		await expect(sealBundle(bundle, wrapper, aad)).rejects.toThrow(/HUGE/);
		expect(wrapper.calls).toBe(0);
	});

	it("measures bytes, not characters, for multi-byte values", async () => {
		// "🔐" is 2 UTF-16 code units but 4 UTF-8 bytes, so this is half the
		// limit in JS string length and twice it in bytes.
		const value = "🔐".repeat(MAX_BUNDLE_BYTES / 4 + 1);
		expect(value.length).toBeLessThan(MAX_BUNDLE_BYTES);
		expect(Buffer.byteLength(value, "utf-8")).toBeGreaterThan(MAX_BUNDLE_BYTES);
		const wrapper = forbiddenWrapper();
		await expect(
			sealBundle({ EMOJI: value }, wrapper, aad),
		).rejects.toBeInstanceOf(BundleTooLargeError);
		expect(wrapper.calls).toBe(0);
	});
});

describe("assertKekVersion", () => {
	it("accepts a 32-char lowercase hex version", () => {
		expect(() => assertKekVersion(VERSION_A)).not.toThrow();
	});

	it.each(HOSTILE_VERSIONS)("rejects %j", (version) => {
		expect(() => assertKekVersion(version)).toThrow();
	});

	it("rejects uppercase hex", () => {
		expect(() => assertKekVersion(VERSION_A.toUpperCase())).toThrow();
	});
});

describe("openBundle never touches the key wrapper for a hostile version", () => {
	const aad = `u${"a".repeat(64)}|bundle|1`;

	it.each(HOSTILE_VERSIONS)("%j", async (version) => {
		const wrapper = forbiddenWrapper();
		await expect(
			openBundle(
				{
					kekVersion: version,
					wrappedDek: "AAAA",
					iv: "AAAA",
					authTag: "AAAA",
					ciphertext: "AAAA",
				},
				wrapper,
				aad,
			),
		).rejects.toThrow();
		expect(wrapper.calls).toBe(0);
	});
});

describe("KeyVaultKeyWrapper", () => {
	function harness(
		responder?: (url: string, body: { alg: string; value: string }) => Response,
	) {
		let tokenCalls = 0;
		const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
			const url = String(input);
			const body = JSON.parse(String(init?.body)) as {
				alg: string;
				value: string;
			};
			if (responder) return responder(url, body);
			// Identity "crypto": exercises encoding, not cryptography.
			return new Response(
				JSON.stringify({
					kid: url.replace(/\/(un)?wrapkey\?.*$/, ""),
					value: body.value,
				}),
				{ status: 200 },
			);
		});
		const wrapper = new KeyVaultKeyWrapper({
			keyId: KEY_ID,
			tokenProvider: async () => {
				tokenCalls++;
				return "vault-token";
			},
			fetchFn: fetchFn as unknown as typeof fetch,
			sleep: async () => {},
		});
		return { wrapper, fetchFn, tokenCalls: () => tokenCalls };
	}

	it("builds the wrap URL from the configured vault and key name only", async () => {
		const { wrapper, fetchFn } = harness();
		const dek = Buffer.alloc(32, 7);
		const { version } = await wrapper.wrap(dek);
		expect(version).toBe(VERSION_A);
		expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
			`${VAULT}/keys/${KEY_NAME}/${VERSION_A}/wrapkey?api-version=7.4`,
		);
		const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
		expect(init.method).toBe("POST");
		expect(new Headers(init.headers).get("authorization")).toBe(
			"Bearer vault-token",
		);
		expect(JSON.parse(String(init.body)).alg).toBe("RSA-OAEP-256");
	});

	it("builds the unwrap URL from the configured vault, never from the stored version's shape", async () => {
		const { wrapper, fetchFn } = harness();
		await wrapper.unwrap(VERSION_B, Buffer.alloc(4, 1));
		expect(String(fetchFn.mock.calls[0]?.[0])).toBe(
			`${VAULT}/keys/${KEY_NAME}/${VERSION_B}/unwrapkey?api-version=7.4`,
		);
	});

	it.each(HOSTILE_VERSIONS)(
		"makes zero fetch and zero token calls for hostile version %j",
		async (version) => {
			const { wrapper, fetchFn, tokenCalls } = harness();
			await expect(
				wrapper.unwrap(version, Buffer.alloc(4, 1)),
			).rejects.toThrow();
			expect(fetchFn).toHaveBeenCalledTimes(0);
			expect(tokenCalls()).toBe(0);
		},
	);

	it("rejects a kid that is not exactly the URL we constructed", async () => {
		const { wrapper } = harness(
			() =>
				new Response(
					JSON.stringify({
						kid: `https://attacker.example/keys/${KEY_NAME}/${VERSION_A}`,
						value: "AAAA",
					}),
					{ status: 200 },
				),
		);
		await expect(wrapper.wrap(Buffer.alloc(32, 1))).rejects.toThrow(
			/unexpected key id/,
		);
	});

	it("rejects a response with no kid at all", async () => {
		const { wrapper } = harness(
			() => new Response(JSON.stringify({ value: "AAAA" }), { status: 200 }),
		);
		await expect(wrapper.unwrap(VERSION_A, Buffer.alloc(4, 1))).rejects.toThrow(
			/unexpected key id/,
		);
	});

	it("sends and decodes base64url (NOT the standard base64 the Table uses)", async () => {
		const { wrapper, fetchFn } = harness();
		// fb ff bf => "+/+/" in standard base64, "-_-_" in base64url.
		const raw = Buffer.from([0xfb, 0xff, 0xbf]);
		expect(raw.toString("base64")).toBe("+/+/");
		await wrapper.unwrap(VERSION_A, raw);
		const sent = JSON.parse(String(fetchFn.mock.calls[0]?.[1]?.body)) as {
			value: string;
		};
		expect(sent.value).toBe("-_-_");
		expect(sent.value).not.toMatch(/[+/=]/);
	});

	it("decodes a base64url response value back to the original bytes", async () => {
		const expected = Buffer.from([0xfb, 0xff, 0xbf, 0xfa]);
		const { wrapper } = harness(
			(url) =>
				new Response(
					JSON.stringify({
						kid: url.replace(/\/(un)?wrapkey\?.*$/, ""),
						value: expected.toString("base64url"),
					}),
					{ status: 200 },
				),
		);
		const out = await wrapper.unwrap(VERSION_A, Buffer.alloc(4, 1));
		expect(Buffer.compare(out, expected)).toBe(0);
	});

	it.each([
		[`http://kv.test/keys/k/${VERSION_A}`, /https/],
		[`${VAULT}/keys/${KEY_NAME}`, /versioned/],
		[`${VAULT}/secrets/${KEY_NAME}/${VERSION_A}`, /\/keys\//],
		[`${VAULT}/keys/bad name/${VERSION_A}`, /key name/],
		[`${VAULT}/keys/${KEY_NAME}/not-a-version`, /version/],
	])("refuses to construct with keyId %s", (keyId, pattern) => {
		expect(
			() =>
				new KeyVaultKeyWrapper({
					keyId,
					tokenProvider: async () => "t",
					fetchFn: (async () => new Response("")) as unknown as typeof fetch,
				}),
		).toThrow(pattern);
	});

	it("retries a 429 and honours Retry-After", async () => {
		let calls = 0;
		const sleep = vi.fn(async () => {});
		const fetchFn = vi.fn(async (input: string | URL) => {
			calls++;
			if (calls === 1) {
				return new Response("slow down", {
					status: 429,
					headers: { "retry-after": "2" },
				});
			}
			return new Response(
				JSON.stringify({
					kid: String(input).replace(/\/(un)?wrapkey\?.*$/, ""),
					value: "AAAA",
				}),
				{ status: 200 },
			);
		});
		const wrapper = new KeyVaultKeyWrapper({
			keyId: KEY_ID,
			tokenProvider: async () => "vault-token",
			fetchFn: fetchFn as unknown as typeof fetch,
			sleep,
		});
		await expect(
			wrapper.unwrap(VERSION_A, Buffer.alloc(4, 1)),
		).resolves.toBeDefined();
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(2000);
	});

	it("throws — never silently succeeds — when the vault keeps failing", async () => {
		const fetchFn = vi.fn(async () => new Response("nope", { status: 503 }));
		const wrapper = new KeyVaultKeyWrapper({
			keyId: KEY_ID,
			tokenProvider: async () => "vault-token",
			fetchFn: fetchFn as unknown as typeof fetch,
			sleep: async () => {},
			maxAttempts: 3,
		});
		await expect(wrapper.wrap(Buffer.alloc(32, 1))).rejects.toThrow(/503/);
		expect(fetchFn).toHaveBeenCalledTimes(3);
	});
});

describe("base64 vs base64url at the storage boundary", () => {
	const aad = `u${"a".repeat(64)}|bundle|1`;

	it("stores the wrapped DEK as standard base64, whatever the wrapper returns", async () => {
		const wrapped = Buffer.from([0xfb, 0xff, 0xbf, 0xfa, 0xff, 0xbf]);
		const wrapper: KeyWrapper = {
			async wrap() {
				return { version: VERSION_A, wrapped };
			},
			async unwrap() {
				throw new Error("not used");
			},
		};
		const sealed = await sealBundle({ K: "v" }, wrapper, aad);
		expect(sealed.wrappedDek).toBe(wrapped.toString("base64"));
		expect(sealed.wrappedDek).toMatch(/[+/]/);
		expect(
			Buffer.compare(Buffer.from(sealed.wrappedDek, "base64"), wrapped),
		).toBe(0);
	});

	it("hands the wrapper raw bytes on the way back in", async () => {
		const seen: Buffer[] = [];
		const inner = fakeWrapper();
		const wrapper: KeyWrapper = {
			wrap: inner.wrap,
			unwrap: async (version, wrapped) => {
				seen.push(Buffer.from(wrapped));
				return inner.unwrap(version, wrapped);
			},
		};
		const sealed = await sealBundle({ K: "v" }, wrapper, aad);
		await openBundle(sealed, wrapper, aad);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toHaveLength(32);
		expect(seen[0]!.toString("base64")).toBe(sealed.wrappedDek);
	});
});
