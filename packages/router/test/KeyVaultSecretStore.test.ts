import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
	KeyVaultSecretStore,
	keyVaultSecretName,
} from "../src/KeyVaultSecretStore.js";

const VAULT = "https://example.vault.azure.net";

describe("KeyVaultSecretStore", () => {
	it("uses the hashed name, tags, REST 7.4, and bearer token for writes", async () => {
		const fetchFn = vi.fn(
			async () => new Response(JSON.stringify({ id: "ok" }), { status: 200 }),
		);
		const store = new KeyVaultSecretStore({
			vaultUrl: `${VAULT}/`,
			tokenProvider: async () => "kv-token",
			fetchFn,
		});

		await store.set("Alice@Example.com", "githubPat", "secret");
		const expectedName = `u${createHash("sha256").update("alice@example.com").digest("hex").slice(0, 20)}-${createHash("sha256").update("GIT_TOKEN").digest("hex").slice(0, 10)}`;
		expect(keyVaultSecretName("alice@example.com", "GIT_TOKEN")).toBe(
			expectedName,
		);
		expect(fetchFn.mock.calls[0]?.[0]).toBe(
			`${VAULT}/secrets/${expectedName}?api-version=7.4`,
		);
		const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
		expect(new Headers(init.headers).get("authorization")).toBe(
			"Bearer kv-token",
		);
		expect(JSON.parse(String(init.body))).toEqual({
			value: "secret",
			tags: { email: "alice@example.com", key: "GIT_TOKEN" },
		});
	});

	it("paginates list metadata, point-gets values, and caches a bundle for 60s", async () => {
		let now = 1_000;
		const name = keyVaultSecretName("a@example.com", "GIT_TOKEN");
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						value: [],
						nextLink: `${VAULT}/secrets?api-version=7.4&skiptoken=next`,
					}),
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						value: [
							{
								id: `${VAULT}/secrets/${name}`,
								tags: { email: "a@example.com", key: "GIT_TOKEN" },
							},
						],
					}),
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						value: "pat",
						tags: { email: "a@example.com", key: "GIT_TOKEN" },
					}),
				),
			);
		const store = new KeyVaultSecretStore({
			vaultUrl: VAULT,
			tokenProvider: async () => "token",
			fetchFn,
			now: () => now,
		});

		await expect(store.get("A@Example.com")).resolves.toEqual({
			GIT_TOKEN: "pat",
		});
		await expect(store.get("a@example.com")).resolves.toEqual({
			GIT_TOKEN: "pat",
		});
		expect(fetchFn).toHaveBeenCalledTimes(3);
		now += 60_001;
		fetchFn.mockResolvedValueOnce(new Response(JSON.stringify({ value: [] })));
		await store.get("a@example.com");
		expect(fetchFn).toHaveBeenCalledTimes(4);
	});

	it("invalidates cached reads on PUT and tombstone PUT", async () => {
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(new Response(JSON.stringify({ value: [] })))
			.mockResolvedValueOnce(new Response(JSON.stringify({})))
			.mockResolvedValueOnce(new Response(JSON.stringify({ value: [] })))
			.mockResolvedValueOnce(new Response(JSON.stringify({})))
			.mockResolvedValueOnce(new Response(JSON.stringify({ value: [] })));
		const store = new KeyVaultSecretStore({
			vaultUrl: VAULT,
			tokenProvider: async () => "token",
			fetchFn,
		});
		await store.get("a@example.com");
		await store.set("a@example.com", "GIT_TOKEN", "new");
		await store.get("a@example.com");
		await store.set("a@example.com", "GIT_TOKEN", undefined);
		await store.get("a@example.com");
		expect(fetchFn).toHaveBeenCalledTimes(5);
		const unsetInit = fetchFn.mock.calls[3]?.[1] as RequestInit;
		expect(unsetInit.method).toBe("PUT");
		expect(JSON.parse(String(unsetInit.body))).toEqual({
			value: "",
			attributes: { enabled: true },
			tags: {
				email: "a@example.com",
				key: "GIT_TOKEN",
				cyrusDeleted: "true",
			},
		});
	});

	it("can set the same deterministic secret again after unset", async () => {
		const writes: Array<{ value: string; tags: Record<string, string> }> = [];
		const fetchFn = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				if (init?.method === "PUT") {
					writes.push(JSON.parse(String(init.body)));
					return new Response(JSON.stringify({}));
				}
				return new Response(JSON.stringify({ value: [] }));
			},
		);
		const store = new KeyVaultSecretStore({
			vaultUrl: VAULT,
			tokenProvider: async () => "token",
			fetchFn,
		});

		await store.set("a@example.com", "GIT_TOKEN", undefined);
		await store.set("a@example.com", "GIT_TOKEN", "replacement");

		expect(writes).toEqual([
			{
				value: "",
				attributes: { enabled: true },
				tags: {
					email: "a@example.com",
					key: "GIT_TOKEN",
					cyrusDeleted: "true",
				},
			},
			{
				value: "replacement",
				tags: { email: "a@example.com", key: "GIT_TOKEN" },
			},
		]);
		expect(fetchFn.mock.calls[0]?.[0]).toBe(fetchFn.mock.calls[1]?.[0]);
	});

	it("ignores tombstones and malformed or reserved key tags", async () => {
		const logger = { warn: vi.fn() };
		const names = ["deleted", "reserved", "malformed", "valid"];
		const tags: Record<string, Record<string, string>> = {
			deleted: {
				email: "a@example.com",
				key: "GIT_TOKEN",
				cyrusDeleted: "true",
			},
			reserved: { email: "a@example.com", key: "CYRUS_ROUTER_URL" },
			malformed: { email: "a@example.com", key: "not a key" },
			valid: { email: "a@example.com", key: "githubPat" },
		};
		const fetchFn = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url === `${VAULT}/secrets?api-version=7.4`) {
				return new Response(
					JSON.stringify({
						value: names.map((name) => ({
							id: `${VAULT}/secrets/${name}`,
							tags: tags[name],
						})),
					}),
				);
			}
			return new Response(
				JSON.stringify({
					value: "pat",
					tags: { email: "a@example.com", key: "githubPat" },
				}),
			);
		});
		const store = new KeyVaultSecretStore({
			vaultUrl: VAULT,
			tokenProvider: async () => "token",
			fetchFn,
			logger,
		});

		await expect(store.get("a@example.com")).resolves.toEqual({
			GIT_TOKEN: "pat",
		});
		expect(logger.warn).toHaveBeenCalledTimes(2);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it("validates point-read tags before exposing a listed key", async () => {
		const name = keyVaultSecretName("a@example.com", "GIT_TOKEN");
		const logger = { warn: vi.fn() };
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						value: [
							{
								id: `${VAULT}/secrets/${name}`,
								tags: { email: "a@example.com", key: "GIT_TOKEN" },
							},
						],
					}),
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						value: "evil",
						tags: { email: "a@example.com", key: "NODE_OPTIONS" },
					}),
				),
			);
		const store = new KeyVaultSecretStore({
			vaultUrl: VAULT,
			tokenProvider: async () => "token",
			fetchFn,
			logger,
		});

		await expect(store.get("a@example.com")).resolves.toEqual({});
		expect(logger.warn).toHaveBeenCalledOnce();
	});

	it.each(["CYRUS_ROUTER_URL", "not a name", "1BAD"])(
		"rejects invalid/reserved key %s before network access",
		async (key) => {
			const fetchFn = vi.fn();
			const store = new KeyVaultSecretStore({
				vaultUrl: VAULT,
				tokenProvider: async () => "token",
				fetchFn,
			});
			await expect(store.set("a@example.com", key, "x")).rejects.toThrow();
			expect(fetchFn).not.toHaveBeenCalled();
		},
	);
});

describe("KeyVaultSecretStore.listEmails", () => {
	function page(
		items: Array<{ email?: string; key?: string; deleted?: boolean }>,
		nextLink?: string,
	) {
		return JSON.stringify({
			value: items.map((item, index) => ({
				id: `${VAULT}/secrets/secret-${index}`,
				tags: {
					...(item.email ? { email: item.email } : {}),
					...(item.key ? { key: item.key } : {}),
					...(item.deleted ? { cyrusDeleted: "true" } : {}),
				},
			})),
			...(nextLink ? { nextLink } : {}),
		});
	}

	it("paginates to completion and returns distinct lowercased emails", async () => {
		// A partial enumeration would silently migrate a subset and look like
		// success, so following nextLink is the load-bearing behaviour here.
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					page(
						[
							{ email: "Alice@Example.com", key: "GIT_TOKEN" },
							{ email: "alice@example.com", key: "CLAUDE_CODE_OAUTH_TOKEN" },
						],
						`${VAULT}/secrets?api-version=7.4&$skiptoken=2`,
					),
					{ status: 200 },
				),
			)
			.mockResolvedValueOnce(
				new Response(page([{ email: "bob@example.com", key: "GIT_TOKEN" }]), {
					status: 200,
				}),
			);
		const store = new KeyVaultSecretStore({
			vaultUrl: VAULT,
			tokenProvider: async () => "token",
			fetchFn,
		});

		expect(await store.listEmails()).toEqual([
			"alice@example.com",
			"bob@example.com",
		]);
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it("omits tombstoned and untagged secrets", async () => {
		const fetchFn = vi.fn(
			async () =>
				new Response(
					page([
						{ email: "gone@example.com", key: "GIT_TOKEN", deleted: true },
						{ key: "GIT_TOKEN" },
						{ email: "live@example.com", key: "GIT_TOKEN" },
					]),
					{ status: 200 },
				),
		);
		const store = new KeyVaultSecretStore({
			vaultUrl: VAULT,
			tokenProvider: async () => "token",
			fetchFn,
		});

		expect(await store.listEmails()).toEqual(["live@example.com"]);
	});
});
