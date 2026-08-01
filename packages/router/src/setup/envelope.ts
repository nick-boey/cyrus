import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	randomUUID,
} from "node:crypto";
import type { UserSecretBundle } from "../SecretStore.js";

const ALGORITHM = "aes-256-gcm";
const DEK_BYTES = 32;
const IV_BYTES = 12;
const WRAP_ALG = "RSA-OAEP-256";
const KEY_VAULT_SCOPE = "https://vault.azure.net/.default";
const KEY_VAULT_API_VERSION = "7.4";

/**
 * Ceiling on the serialized plaintext bundle. Azure documents `Edm.Binary` at
 * 64 KiB per property, but a limit you never check is a limit you discover in
 * production: reject well below it, before wrapping, with an error a UI can
 * render. See D3′ on the plan.
 */
export const MAX_BUNDLE_BYTES = 32 * 1024;

/**
 * A Key Vault key version is exactly 32 lowercase hex characters. Anything
 * else — most of all anything URL-shaped — is refused before it can influence
 * a request URL. See {@link assertKekVersion}.
 */
export const KEK_VERSION_RE = /^[0-9a-f]{32}$/;

/** Key Vault object names: alphanumerics and dashes, 1–127 characters. */
const KEY_NAME_RE = /^[0-9a-zA-Z-]{1,127}$/;

/** Raised when a bundle is too large to store. Carries the offending name. */
export class BundleTooLargeError extends Error {
	constructor(
		message: string,
		readonly variableName: string,
	) {
		super(message);
		this.name = "BundleTooLargeError";
	}
}

/** An encrypted bundle plus everything needed to open it. No plaintext. */
export interface SealedBundle {
	/**
	 * The **bare** Key Vault key version the DEK was wrapped with — never a
	 * URL, and never used to build one. See {@link assertKekVersion}.
	 */
	kekVersion: string;
	/** Standard base64 (RFC 4648 §4) — NOT the base64url Key Vault speaks. */
	wrappedDek: string;
	/** Standard base64 of the 12-byte GCM IV. */
	iv: string;
	/** Standard base64 of the 16-byte GCM tag. */
	authTag: string;
	/** Standard base64 of AES-256-GCM(JSON.stringify(bundle)). */
	ciphertext: string;
}

/** Wraps and unwraps a data encryption key. The Key Vault seam. */
export interface KeyWrapper {
	wrap(dek: Buffer): Promise<{ version: string; wrapped: Buffer }>;
	/** `version` is a bare key version, validated by the implementation. */
	unwrap(version: string, wrapped: Buffer): Promise<Buffer>;
}

/**
 * Rejects any key version that is not exactly 32 lowercase hex characters.
 *
 * This is the load-bearing check behind D4′. The original design stored a full
 * versioned key URL per row and built the unwrap request from it — an
 * authenticated SSRF, because the request carries a vault-scoped bearer token
 * and is sent *before* AES-GCM can authenticate anything, so the AAD binding
 * cannot help. Anyone with Table write access could point a row at their own
 * host and harvest a token with the router identity's Key Vault permissions.
 *
 * Callers must run this before touching a token provider or the network.
 */
export function assertKekVersion(version: string): void {
	if (typeof version !== "string" || !KEK_VERSION_RE.test(version)) {
		throw new Error(
			`Refusing to use a stored KEK version that is not 32 lowercase hex characters (got ${JSON.stringify(
				String(version).slice(0, 64),
			)}). Key Vault request URLs are built only from configuration.`,
		);
	}
}

function assertStorableBundle(bundle: UserSecretBundle): string {
	for (const [key, value] of Object.entries(bundle)) {
		if (typeof value !== "string") {
			throw new Error(
				`Cannot store "${key}": the value is not a string (got ${typeof value}).`,
			);
		}
	}
	const serialized = JSON.stringify(bundle);
	const bytes = Buffer.byteLength(serialized, "utf-8");
	if (bytes <= MAX_BUNDLE_BYTES) return serialized;

	let worstName = "(none)";
	let worstBytes = -1;
	for (const [key, value] of Object.entries(bundle)) {
		const size = Buffer.byteLength(value, "utf-8");
		if (size > worstBytes) {
			worstBytes = size;
			worstName = key;
		}
	}
	throw new BundleTooLargeError(
		`Your saved variables total ${bytes} bytes, which is over the ${MAX_BUNDLE_BYTES} byte limit. The largest is "${worstName}" at ${worstBytes} bytes — shorten or remove it and try again.`,
		worstName,
	);
}

/**
 * Encrypts `bundle` under a **fresh** 256-bit DEK and wraps that DEK with the
 * KEK. A new DEK per write means a compromised single-record DEK never widens
 * to the rest of the table, and it removes any IV-reuse hazard entirely.
 *
 * `aad` binds the ciphertext to the row it lives on, so a ciphertext copied
 * onto another user's row fails to authenticate rather than decrypting into
 * their environment.
 */
export async function sealBundle(
	bundle: UserSecretBundle,
	wrapper: KeyWrapper,
	aad: string,
): Promise<SealedBundle> {
	// Validate before generating key material or making any network call.
	const plaintext = assertStorableBundle(bundle);

	const dek = randomBytes(DEK_BYTES);
	const iv = randomBytes(IV_BYTES);
	try {
		const cipher = createCipheriv(ALGORITHM, dek, iv);
		cipher.setAAD(Buffer.from(aad, "utf-8"));
		const ciphertext = Buffer.concat([
			cipher.update(plaintext, "utf-8"),
			cipher.final(),
		]);
		const authTag = cipher.getAuthTag();
		const { version, wrapped } = await wrapper.wrap(dek);
		assertKekVersion(version);
		return {
			kekVersion: version,
			wrappedDek: wrapped.toString("base64"),
			iv: iv.toString("base64"),
			authTag: authTag.toString("base64"),
			ciphertext: ciphertext.toString("base64"),
		};
	} finally {
		dek.fill(0);
	}
}

/** Inverse of {@link sealBundle}. Throws on any tampering or AAD mismatch. */
export async function openBundle(
	sealed: SealedBundle,
	wrapper: KeyWrapper,
	aad: string,
): Promise<UserSecretBundle> {
	// Before anything else, and in particular before any token or network use.
	assertKekVersion(sealed.kekVersion);

	const dek = await wrapper.unwrap(
		sealed.kekVersion,
		Buffer.from(sealed.wrappedDek, "base64"),
	);
	try {
		const decipher = createDecipheriv(
			ALGORITHM,
			dek,
			Buffer.from(sealed.iv, "base64"),
		);
		decipher.setAAD(Buffer.from(aad, "utf-8"));
		decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
		const plaintext = Buffer.concat([
			decipher.update(Buffer.from(sealed.ciphertext, "base64")),
			decipher.final(),
		]);
		const parsed: unknown = JSON.parse(plaintext.toString("utf-8"));
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new Error(
				"Decrypted secret bundle is not a JSON object at the root",
			);
		}
		for (const [key, value] of Object.entries(parsed)) {
			if (typeof value !== "string") {
				throw new Error(
					`Decrypted secret bundle value for "${key}" is not a string`,
				);
			}
		}
		return parsed as UserSecretBundle;
	} finally {
		dek.fill(0);
	}
}

/* -------------------------------------------------------------------------- */
/* Shared Azure request policy                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Deadline / retry policy shared by {@link KeyVaultKeyWrapper} and the Azure
 * Table store. It lives beside the envelope rather than in its own module so
 * both hand-rolled REST clients are guaranteed to apply exactly the same
 * deadline, retry, and correlation-id rules.
 */
export interface AzureRequestPolicy {
	fetchFn: typeof fetch;
	/** Per-attempt deadline. Node's fetch has none of its own. */
	requestTimeoutMs: number;
	/** Total attempts, including the first. */
	maxAttempts: number;
	maxRetryDelayMs: number;
	sleep: (ms: number) => Promise<void>;
	newCorrelationId: () => string;
	now: () => number;
	logger: { warn(msg: string): void };
	signal?: AbortSignal | undefined;
}

export interface AzureRequestInput {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string | undefined;
	/** For error messages: "Azure Table" / "Key Vault". */
	service: string;
	/** Statuses that must never be retried even if otherwise retryable. */
	noRetryStatuses?: readonly number[];
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_ATTEMPTS = 4;
export const DEFAULT_MAX_RETRY_DELAY_MS = 10_000;

export function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		if (typeof timer === "object" && typeof timer.unref === "function") {
			timer.unref();
		}
	});
}

function isRetryableStatus(status: number): boolean {
	return status === 408 || status === 429 || status >= 500;
}

function parseRetryAfter(
	header: string | null,
	now: number,
): number | undefined {
	if (!header) return undefined;
	const seconds = Number(header.trim());
	if (Number.isFinite(seconds) && seconds >= 0)
		return Math.round(seconds * 1000);
	const at = Date.parse(header);
	if (Number.isNaN(at)) return undefined;
	return Math.max(0, at - now);
}

/**
 * Bounds a request in time, without depending on `AbortSignal.timeout` /
 * `AbortSignal.any` so the module works on every supported Node line.
 */
function withDeadline(
	timeoutMs: number,
	external: AbortSignal | undefined,
): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
	const controller = new AbortController();
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	if (typeof timer === "object" && typeof timer.unref === "function") {
		timer.unref();
	}
	const onExternalAbort = () => controller.abort();
	external?.addEventListener("abort", onExternalAbort, { once: true });
	return {
		signal: controller.signal,
		timedOut: () => timedOut,
		dispose: () => {
			clearTimeout(timer);
			external?.removeEventListener("abort", onExternalAbort);
		},
	};
}

/**
 * One Azure REST request with a deadline, a correlation id, and bounded
 * retries on 408/429/5xx honouring `Retry-After`. A 412 is a meaningful
 * answer, never a transient failure, and is never retried.
 *
 * Returns the raw {@link Response}; deciding which non-2xx statuses are
 * meaningful is the caller's job.
 */
export async function azureRequest(
	input: AzureRequestInput,
	policy: AzureRequestPolicy,
): Promise<{ response: Response; correlationId: string }> {
	const correlationId = policy.newCorrelationId();
	const noRetry = new Set<number>([412, ...(input.noRetryStatuses ?? [])]);
	const label = `${input.service} ${input.method} ${input.url} [${correlationId}]`;

	for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
		if (policy.signal?.aborted) {
			throw new Error(`${label} aborted before dispatch`);
		}
		const deadline = withDeadline(policy.requestTimeoutMs, policy.signal);
		let response: Response;
		try {
			response = await policy.fetchFn(input.url, {
				method: input.method,
				headers: {
					...input.headers,
					"x-ms-client-request-id": correlationId,
				},
				...(input.body === undefined ? {} : { body: input.body }),
				signal: deadline.signal,
			});
		} catch (error) {
			if (deadline.timedOut()) {
				throw new Error(
					`${label} timed out after ${policy.requestTimeoutMs}ms`,
				);
			}
			if (policy.signal?.aborted) throw new Error(`${label} aborted`);
			throw new Error(`${label} failed: ${(error as Error).message}`);
		} finally {
			deadline.dispose();
		}

		const retryable =
			!noRetry.has(response.status) && isRetryableStatus(response.status);
		if (!retryable || attempt === policy.maxAttempts) {
			return { response, correlationId };
		}

		const retryAfter = parseRetryAfter(
			response.headers.get("retry-after"),
			policy.now(),
		);
		const backoff = 200 * 2 ** (attempt - 1);
		const delay = Math.min(policy.maxRetryDelayMs, retryAfter ?? backoff);
		policy.logger.warn(
			`${label} returned ${response.status}; retrying in ${delay}ms (attempt ${attempt}/${policy.maxAttempts})`,
		);
		await policy.sleep(delay);
	}

	// Unreachable: the loop always returns on its final attempt.
	throw new Error(`${label} exhausted ${policy.maxAttempts} attempts`);
}

/* -------------------------------------------------------------------------- */
/* Key Vault RSA-OAEP-256 key wrapper                                          */
/* -------------------------------------------------------------------------- */

export interface KeyVaultKeyWrapperOptions {
	/**
	 * The **configured** versioned key id:
	 * `https://<vault>/keys/<name>/<version>`. This is the only source of the
	 * vault host and key name for every request this class makes. Stored row
	 * data never contributes to a URL.
	 */
	keyId: string;
	tokenProvider?: () => Promise<string>;
	fetchFn?: typeof fetch;
	requestTimeoutMs?: number;
	maxAttempts?: number;
	maxRetryDelayMs?: number;
	sleep?: (ms: number) => Promise<void>;
	newCorrelationId?: () => string;
	now?: () => number;
	logger?: { warn(msg: string): void };
	signal?: AbortSignal;
}

export function createKeyVaultCryptoTokenProvider(): () => Promise<string> {
	let credential:
		| { getToken(scope: string): Promise<{ token: string } | null> }
		| undefined;
	return async () => {
		if (!credential) {
			const { DefaultAzureCredential } = await import("@azure/identity");
			credential = new DefaultAzureCredential();
		}
		const token = await credential.getToken(KEY_VAULT_SCOPE);
		if (!token?.token)
			throw new Error("DefaultAzureCredential returned no access token");
		return token.token;
	};
}

/**
 * Key Vault REST 7.4 wrapKey/unwrapKey. Needs the *Key Vault Crypto User* role
 * on the vault — the router's existing Secrets User/Officer grants do not
 * cover key operations.
 *
 * Every request URL is `<configured vault>/keys/<configured name>/<version>`,
 * where only `<version>` may come from a stored record and only after passing
 * {@link assertKekVersion}. The `kid` Key Vault echoes back must equal the URL
 * we constructed, or the response is refused.
 */
export class KeyVaultKeyWrapper implements KeyWrapper {
	private readonly vaultOrigin: string;
	private readonly keyName: string;
	private readonly configuredVersion: string;
	private readonly tokenProvider: () => Promise<string>;
	private readonly policy: AzureRequestPolicy;

	constructor(opts: KeyVaultKeyWrapperOptions) {
		const raw = opts.keyId.replace(/\/+$/, "");
		let parsed: URL;
		try {
			parsed = new URL(raw);
		} catch {
			throw new Error(`Key Vault keyId is not a URL: ${JSON.stringify(raw)}`);
		}
		if (parsed.protocol !== "https:") {
			throw new Error(`Key Vault keyId must use https, got ${parsed.protocol}`);
		}
		if (parsed.search || parsed.hash) {
			throw new Error("Key Vault keyId must not carry a query or fragment");
		}
		const segments = parsed.pathname.split("/").filter(Boolean);
		if (segments[0] !== "keys") {
			throw new Error(
				`Key Vault keyId must be a /keys/ identifier, got ${parsed.pathname}`,
			);
		}
		if (segments.length !== 3) {
			throw new Error(
				`Key Vault keyId must be versioned (https://<vault>/keys/<name>/<version>), got ${parsed.pathname}`,
			);
		}
		const [, name, version] = segments as [string, string, string];
		if (!KEY_NAME_RE.test(name)) {
			throw new Error(
				`Key Vault key name is not valid: ${JSON.stringify(name)}`,
			);
		}
		assertKekVersion(version);

		this.vaultOrigin = parsed.origin;
		this.keyName = name;
		this.configuredVersion = version;
		this.tokenProvider =
			opts.tokenProvider ?? createKeyVaultCryptoTokenProvider();
		this.policy = {
			fetchFn: opts.fetchFn ?? fetch,
			requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
			maxRetryDelayMs: opts.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
			sleep: opts.sleep ?? defaultSleep,
			newCorrelationId: opts.newCorrelationId ?? randomUUID,
			now: opts.now ?? Date.now,
			logger: opts.logger ?? console,
			signal: opts.signal,
		};
	}

	/** The key version this wrapper writes new records with. */
	get version(): string {
		return this.configuredVersion;
	}

	async wrap(dek: Buffer): Promise<{ version: string; wrapped: Buffer }> {
		const body = await this.crypto(
			this.configuredVersion,
			"wrapkey",
			dek.toString("base64url"),
		);
		return {
			version: this.configuredVersion,
			wrapped: Buffer.from(body.value, "base64url"),
		};
	}

	async unwrap(version: string, wrapped: Buffer): Promise<Buffer> {
		// Before the token provider and before the network — see D4′.
		assertKekVersion(version);
		const body = await this.crypto(
			version,
			"unwrapkey",
			wrapped.toString("base64url"),
		);
		return Buffer.from(body.value, "base64url");
	}

	private keyUrl(version: string): string {
		return `${this.vaultOrigin}/keys/${this.keyName}/${version}`;
	}

	private async crypto(
		version: string,
		operation: "wrapkey" | "unwrapkey",
		value: string,
	): Promise<{ kid?: string; value: string }> {
		assertKekVersion(version);
		const keyUrl = this.keyUrl(version);
		const url = `${keyUrl}/${operation}?api-version=${KEY_VAULT_API_VERSION}`;
		const { response, correlationId } = await azureRequest(
			{
				method: "POST",
				url,
				headers: {
					authorization: `Bearer ${await this.tokenProvider()}`,
					"content-type": "application/json",
					accept: "application/json",
				},
				// Key Vault crypto payloads are base64url (RFC 4648 §5, unpadded)
				// — a different encoding from the Table's standard base64.
				body: JSON.stringify({ alg: WRAP_ALG, value }),
				service: "Key Vault",
			},
			this.policy,
		);
		if (!response.ok) {
			throw new Error(
				`Key Vault ${operation} ${url} failed (${response.status}) [${correlationId}]: ${await response.text()}`,
			);
		}
		const body = (await response.json()) as { kid?: string; value?: string };
		if (body.kid !== keyUrl) {
			throw new Error(
				`Key Vault ${operation} returned an unexpected key id [${correlationId}]: expected ${keyUrl}, got ${JSON.stringify(body.kid)}`,
			);
		}
		if (typeof body.value !== "string" || body.value.length === 0) {
			throw new Error(
				`Key Vault ${operation} returned no value [${correlationId}]`,
			);
		}
		return { kid: body.kid, value: body.value };
	}
}
