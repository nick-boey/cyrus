import { describe, expect, it, vi } from "vitest";
import {
	KeyVaultTokenStore,
	linearTokenSecretName,
} from "../src/KeyVaultTokenStore.js";

const VAULT = "https://example.vault.azure.net";
const WS = "75294f85-72ad-42ef-b9d7-c6ded611fc42";

const envelope = {
	refreshToken: "rt-2",
	accessToken: "at-2",
	seedRefreshToken: "rt-0",
	updatedMs: 1785457484664,
};

function store(fetchFn: typeof fetch) {
	return new KeyVaultTokenStore({
		vaultUrl: `${VAULT}/`,
		tokenProvider: async () => "kv-token",
		fetchFn,
	});
}

describe("linearTokenSecretName", () => {
	it("prefixes the workspace id", () => {
		expect(linearTokenSecretName(WS)).toBe(`cyrus-linear-refresh-${WS}`);
	});

	it("replaces characters Key Vault rejects", () => {
		expect(linearTokenSecretName("acme_corp.1")).toBe(
			"cyrus-linear-refresh-acme-corp-1",
		);
	});
});

describe("KeyVaultTokenStore", () => {
	it("PUTs the envelope as a JSON string using REST 7.4 and a bearer token", async () => {
		const fetchFn = vi.fn(
			async () => new Response(JSON.stringify({ id: "ok" }), { status: 200 }),
		);
		await store(fetchFn as unknown as typeof fetch).set(WS, envelope);

		const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			`${VAULT}/secrets/cyrus-linear-refresh-${WS}?api-version=7.4`,
		);
		expect(init.method).toBe("PUT");
		expect((init.headers as Record<string, string>).authorization).toBe(
			"Bearer kv-token",
		);
		expect(JSON.parse(init.body as string).value).toBe(
			JSON.stringify(envelope),
		);
	});

	it("round-trips an envelope through get", async () => {
		const fetchFn = vi.fn(
			async () =>
				new Response(JSON.stringify({ value: JSON.stringify(envelope) }), {
					status: 200,
				}),
		);
		await expect(
			store(fetchFn as unknown as typeof fetch).get(WS),
		).resolves.toEqual(envelope);
	});

	it("returns undefined when the secret does not exist", async () => {
		const fetchFn = vi.fn(async () => new Response("", { status: 404 }));
		await expect(
			store(fetchFn as unknown as typeof fetch).get(WS),
		).resolves.toBeUndefined();
	});

	it("returns undefined for a corrupt or partial envelope", async () => {
		const fetchFn = vi.fn(
			async () =>
				new Response(JSON.stringify({ value: '{"refreshToken":"only"}' }), {
					status: 200,
				}),
		);
		await expect(
			store(fetchFn as unknown as typeof fetch).get(WS),
		).resolves.toBeUndefined();
	});

	it("throws on a non-404 error status", async () => {
		const fetchFn = vi.fn(async () => new Response("boom", { status: 500 }));
		await expect(
			store(fetchFn as unknown as typeof fetch).get(WS),
		).rejects.toThrow(/500/);
	});
});
