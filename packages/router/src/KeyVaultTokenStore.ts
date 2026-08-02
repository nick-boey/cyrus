import { createKeyVaultTokenProvider } from "./KeyVaultSecretStore.js";

/**
 * A workspace's Linear OAuth tokens as stored in Key Vault.
 *
 * `seedRefreshToken` records the config/env refresh token that started this
 * rotation chain. Startup compares it against the current config value: if an
 * operator has re-authorized and seeded a new token, the stored chain is stale
 * and must be abandoned rather than preferred. Without this field a re-auth
 * would appear to do nothing, because the router would keep choosing the dead
 * stored token over the fresh config one.
 */
export interface LinearTokenEnvelope {
	refreshToken: string;
	accessToken: string;
	seedRefreshToken: string;
	updatedMs: number;
}

export interface KeyVaultTokenStoreOptions {
	vaultUrl: string;
	tokenProvider?: () => Promise<string>;
	fetchFn?: typeof fetch;
}

/** Key Vault secret names allow only `[0-9a-zA-Z-]`. */
export function linearTokenSecretName(workspaceId: string): string {
	return `cyrus-linear-refresh-${workspaceId.replace(/[^0-9a-zA-Z-]/g, "-")}`;
}

function parseEnvelope(raw: string): LinearTokenEnvelope | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined;
	}
	const e = parsed as Partial<LinearTokenEnvelope>;
	// We always write all four fields, so a partial envelope means corruption.
	// Treat it as absent and let the caller fall back to the config value.
	if (
		typeof e.refreshToken !== "string" ||
		typeof e.accessToken !== "string" ||
		typeof e.seedRefreshToken !== "string" ||
		typeof e.updatedMs !== "number"
	) {
		return undefined;
	}
	return {
		refreshToken: e.refreshToken,
		accessToken: e.accessToken,
		seedRefreshToken: e.seedRefreshToken,
		updatedMs: e.updatedMs,
	};
}

/**
 * Per-workspace Linear token storage in Azure Key Vault.
 *
 * Deliberately NOT built on {@link KeyVaultSecretStore}: that class models
 * per-user secret *bundles* (email-hashed names, `email`/`key` tags, tombstones,
 * `UserSecretBundle`), none of which applies to a single per-workspace envelope.
 */
export class KeyVaultTokenStore {
	private readonly vaultUrl: string;
	private readonly tokenProvider: () => Promise<string>;
	private readonly fetchFn: typeof fetch;

	constructor(opts: KeyVaultTokenStoreOptions) {
		this.vaultUrl = opts.vaultUrl.replace(/\/$/, "");
		this.tokenProvider = opts.tokenProvider ?? createKeyVaultTokenProvider();
		this.fetchFn = opts.fetchFn ?? fetch;
	}

	private url(workspaceId: string): string {
		return `${this.vaultUrl}/secrets/${linearTokenSecretName(workspaceId)}?api-version=7.4`;
	}

	async get(workspaceId: string): Promise<LinearTokenEnvelope | undefined> {
		const url = this.url(workspaceId);
		const response = await this.fetchFn(url, {
			method: "GET",
			headers: { authorization: `Bearer ${await this.tokenProvider()}` },
		});
		if (response.status === 404) return undefined;
		if (!response.ok) {
			throw new Error(
				`Key Vault GET ${url} failed (${response.status}): ${await response.text()}`,
			);
		}
		const body = (await response.json()) as { value?: string };
		if (!body.value) return undefined;
		return parseEnvelope(body.value);
	}

	async set(workspaceId: string, envelope: LinearTokenEnvelope): Promise<void> {
		const url = this.url(workspaceId);
		const response = await this.fetchFn(url, {
			method: "PUT",
			headers: {
				authorization: `Bearer ${await this.tokenProvider()}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				value: JSON.stringify(envelope),
				tags: { cyrusLinearWorkspace: workspaceId },
			}),
		});
		if (!response.ok) {
			throw new Error(
				`Key Vault PUT ${url} failed (${response.status}): ${await response.text()}`,
			);
		}
	}
}
