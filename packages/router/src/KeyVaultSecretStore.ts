import { createHash } from "node:crypto";
import {
	normalizeSecretKey,
	type SecretStoreBackend,
	type UserSecretBundle,
} from "./SecretStore.js";

const KEY_VAULT_SCOPE = "https://vault.azure.net/.default";
const CACHE_TTL_MS = 60_000;
const TOMBSTONE_TAG = "cyrusDeleted";
const TOMBSTONE_VALUE = "";

export interface KeyVaultSecretStoreOptions {
	vaultUrl: string;
	tokenProvider?: () => Promise<string>;
	fetchFn?: typeof fetch;
	now?: () => number;
	logger?: { warn(msg: string): void };
}

interface CachedBundle {
	expiresAt: number;
	value: UserSecretBundle;
}

function hash(value: string, length: number): string {
	return createHash("sha256").update(value).digest("hex").slice(0, length);
}

export function keyVaultSecretName(email: string, key: string): string {
	return `u${hash(email.toLowerCase(), 20)}-${hash(key, 10)}`;
}

export function createKeyVaultTokenProvider(): () => Promise<string> {
	let credential:
		| { getToken(scope: string): Promise<{ token: string } | null> }
		| undefined;
	return async () => {
		if (!credential) {
			const { DefaultAzureCredential } = await import("@azure/identity");
			credential = new DefaultAzureCredential();
		}
		const token = await credential!.getToken(KEY_VAULT_SCOPE);
		if (!token?.token)
			throw new Error("DefaultAzureCredential returned no access token");
		return token.token;
	};
}

/** Azure Key Vault REST 7.4 implementation of per-user container secrets. */
export class KeyVaultSecretStore implements SecretStoreBackend {
	private readonly vaultUrl: string;
	private readonly tokenProvider: () => Promise<string>;
	private readonly fetchFn: typeof fetch;
	private readonly now: () => number;
	private readonly logger: { warn(msg: string): void };
	private readonly cache = new Map<string, CachedBundle>();

	constructor(opts: KeyVaultSecretStoreOptions) {
		this.vaultUrl = opts.vaultUrl.replace(/\/$/, "");
		this.tokenProvider = opts.tokenProvider ?? createKeyVaultTokenProvider();
		this.fetchFn = opts.fetchFn ?? fetch;
		this.now = opts.now ?? Date.now;
		this.logger = opts.logger ?? console;
	}

	async get(email: string): Promise<UserSecretBundle> {
		const id = email.toLowerCase();
		const cached = this.cache.get(id);
		if (cached && cached.expiresAt > this.now()) return { ...cached.value };

		const tagged = await this.listForEmail(id);
		const bundle: UserSecretBundle = {};
		await Promise.all(
			tagged.map(async ({ name, key }) => {
				const body = await this.request<{
					value: string;
					tags?: Record<string, string>;
				}>(
					"GET",
					`${this.vaultUrl}/secrets/${encodeURIComponent(name)}?api-version=7.4`,
				);
				const readKey = this.validTaggedKey(body.tags, id, name);
				if (!readKey || body.tags?.[TOMBSTONE_TAG] === "true") return;
				if (readKey !== key) {
					this.logger.warn(
						`Ignoring Key Vault secret ${name}: list/read key tags disagree`,
					);
					return;
				}
				bundle[key] = body.value;
			}),
		);
		this.cache.set(id, { expiresAt: this.now() + CACHE_TTL_MS, value: bundle });
		return { ...bundle };
	}

	async set(
		email: string,
		key: string,
		value: string | undefined,
	): Promise<void> {
		const normalizedKey = normalizeSecretKey(key);
		const id = email.toLowerCase();
		const name = keyVaultSecretName(id, normalizedKey);
		const url = `${this.vaultUrl}/secrets/${name}?api-version=7.4`;
		this.cache.delete(id);
		if (value === undefined) {
			await this.request("PUT", url, {
				value: TOMBSTONE_VALUE,
				attributes: { enabled: true },
				tags: {
					email: id,
					key: normalizedKey,
					[TOMBSTONE_TAG]: "true",
				},
			});
			return;
		}
		await this.request("PUT", url, {
			value,
			tags: { email: id, key: normalizedKey },
		});
	}

	async isFullyAuthenticated(
		email: string,
		requiredKeys: readonly string[],
	): Promise<{ ok: boolean; missing: string[] }> {
		const bundle = await this.get(email);
		const missing = requiredKeys.filter(
			(key) => !(Object.hasOwn(bundle, key) && bundle[key]),
		);
		return { ok: missing.length === 0, missing };
	}

	private async listForEmail(
		email: string,
	): Promise<Array<{ name: string; key: string }>> {
		const found: Array<{ name: string; key: string }> = [];
		let nextUrl: string | undefined =
			`${this.vaultUrl}/secrets?api-version=7.4`;
		while (nextUrl) {
			const page: {
				value?: Array<{ id?: string; tags?: Record<string, string> }>;
				nextLink?: string;
			} = await this.request("GET", nextUrl);
			for (const item of page.value ?? []) {
				if (item.tags?.email?.toLowerCase() !== email || !item.id) continue;
				const name = decodeURIComponent(
					new URL(item.id).pathname.split("/").pop() ?? "",
				);
				const key = this.validTaggedKey(item.tags, email, name);
				if (!key || item.tags?.[TOMBSTONE_TAG] === "true") continue;
				found.push({
					name,
					key,
				});
			}
			nextUrl = page.nextLink;
		}
		return found;
	}

	private validTaggedKey(
		tags: Record<string, string> | undefined,
		email: string,
		name: string,
	): string | undefined {
		if (tags?.email?.toLowerCase() !== email || !tags.key) {
			this.logger.warn(
				`Ignoring Key Vault secret ${name}: missing or mismatched Cyrus tags`,
			);
			return undefined;
		}
		try {
			return normalizeSecretKey(tags.key);
		} catch (error) {
			this.logger.warn(
				`Ignoring Key Vault secret ${name}: invalid key tag: ${String(error)}`,
			);
			return undefined;
		}
	}

	private async request<T>(
		method: string,
		url: string,
		body?: unknown,
		allow404 = false,
	): Promise<T> {
		const response = await this.fetchFn(url, {
			method,
			headers: {
				authorization: `Bearer ${await this.tokenProvider()}`,
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		});
		if (allow404 && response.status === 404) return undefined as T;
		if (!response.ok) {
			throw new Error(
				`Key Vault ${method} ${url} failed (${response.status}): ${await response.text()}`,
			);
		}
		if (response.status === 204) return undefined as T;
		return (await response.json()) as T;
	}
}
