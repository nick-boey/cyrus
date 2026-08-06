import { createHash, randomUUID } from "node:crypto";
import {
	normalizeSecretKey,
	type SecretStoreBackend,
	type UserSecretBundle,
} from "./SecretStore.js";
import {
	type AzureRequestPolicy,
	azureRequest,
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_MAX_RETRY_DELAY_MS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	defaultSleep,
	KeyVaultKeyWrapper,
	type KeyWrapper,
	openBundle,
	type SealedBundle,
	sealBundle,
} from "./setup/envelope.js";

const STORAGE_SCOPE = "https://storage.azure.com/.default";
/**
 * Minimum Table service version that honours OAuth bearer tokens. The
 * "Optional" label on `x-ms-version` in the per-operation REST docs is
 * boilerplate and does not apply to Table under Entra auth.
 */
const X_MS_VERSION = "2020-12-06";
/**
 * `minimalmetadata`, never `nometadata`: `nometadata` strips the
 * `@odata.type` annotations, and without them an `Edm.Int64` is
 * indistinguishable from a string and an `Edm.Binary` from base64 text.
 */
const ACCEPT = "application/json;odata=minimalmetadata";
const DATA_SERVICE_VERSION = "3.0;NetFx";
const CACHE_TTL_MS = 60_000;
const SCHEMA_VERSION = 1;
const MAX_WRITE_ATTEMPTS = 3;

export const SETUP_ROW_KEY = "bundle";
export const DEFAULT_TABLE_NAME = "cyrussetup";

/** Table names: alphanumeric, 3–63 characters, must not start with a digit. */
const TABLE_NAME_RE = /^[A-Za-z][A-Za-z0-9]{2,62}$/;

/** Optimistic-concurrency failure — the record changed since it was read. */
export class SetupConflictError extends Error {
	constructor(message = "the record was modified by someone else") {
		super(message);
		this.name = "SetupConflictError";
	}
}

/** `u` + sha256(lowercased email). Keeps PII out of URLs and diagnostic logs. */
export function setupPartitionKey(email: string): string {
	return `u${createHash("sha256").update(email.toLowerCase()).digest("hex")}`;
}

export interface TableSecretStoreOptions {
	/** e.g. "https://stexample.table.core.windows.net" — origin only. */
	tableEndpoint: string;
	/** Default {@link DEFAULT_TABLE_NAME}. */
	tableName?: string;
	/**
	 * The **versioned** Key Vault key id used as the KEK. This is the sole
	 * source of the vault host and key name for every crypto request; stored
	 * record data never contributes to a URL. See D4′.
	 */
	keyId: string;
	tokenProvider?: () => Promise<string>;
	keyVaultTokenProvider?: () => Promise<string>;
	fetchFn?: typeof fetch;
	now?: () => number;
	logger?: { warn(msg: string): void };
	/** Test seam; defaults to a {@link KeyVaultKeyWrapper} over `keyId`. */
	keyWrapper?: KeyWrapper;
	/** Per-request deadline. Default 30s. */
	requestTimeoutMs?: number;
	/** Total HTTP attempts per request, including the first. Default 4. */
	maxAttempts?: number;
	maxRetryDelayMs?: number;
	/** Read-modify-write attempts before a race is reported. Default 3. */
	maxWriteAttempts?: number;
	sleep?: (ms: number) => Promise<void>;
	newCorrelationId?: () => string;
	cacheTtlMs?: number;
	/** Aborts every in-flight and future request (e.g. on shutdown). */
	signal?: AbortSignal;
}

/**
 * Named distinctly from `StateBackup`'s `createStorageTokenProvider` (which is
 * already exported from `index.ts`) to avoid a re-export collision. Both mint a
 * token for the same `https://storage.azure.com/.default` scope — Blob there,
 * Table here — so they can be deduplicated later if that is worth doing.
 */
export function createTableStorageTokenProvider(): () => Promise<string> {
	let credential:
		| { getToken(scope: string): Promise<{ token: string } | null> }
		| undefined;
	return async () => {
		if (!credential) {
			const { DefaultAzureCredential } = await import("@azure/identity");
			credential = new DefaultAzureCredential();
		}
		const token = await credential.getToken(STORAGE_SCOPE);
		if (!token?.token)
			throw new Error("DefaultAzureCredential returned no access token");
		return token.token;
	};
}

interface CachedRecord {
	expiresAt: number;
	bundle: UserSecretBundle;
	etag: string;
}

/**
 * Per-user container secrets in an Azure Table, one entity per user, encrypted
 * with envelope encryption (see {@link sealBundle}).
 *
 * Chosen over `KeyVaultSecretStore` for the setup UI because a whole bundle is
 * one GET, one PUT, and one ETag — which is what makes a form save atomic and
 * concurrent edits detectable.
 */
export class TableSecretStore implements SecretStoreBackend {
	private readonly tableUrl: string;
	private readonly tableName: string;
	private readonly tokenProvider: () => Promise<string>;
	private readonly now: () => number;
	private readonly logger: { warn(msg: string): void };
	private readonly wrapper: KeyWrapper;
	private readonly policy: AzureRequestPolicy;
	private readonly cacheTtlMs: number;
	private readonly maxWriteAttempts: number;
	private readonly cache = new Map<string, CachedRecord>();

	constructor(opts: TableSecretStoreOptions) {
		// Validate the two values that become part of every URL before anything
		// else, so a misconfigured endpoint cannot smuggle a path or a host.
		let endpoint: URL;
		try {
			endpoint = new URL(opts.tableEndpoint);
		} catch {
			throw new Error(
				`Table endpoint is not a URL: ${JSON.stringify(opts.tableEndpoint)}`,
			);
		}
		if (endpoint.protocol !== "https:") {
			throw new Error(
				`Table endpoint must use https, got ${endpoint.protocol}`,
			);
		}
		if (
			endpoint.pathname.replace(/\/+$/, "") !== "" ||
			endpoint.search ||
			endpoint.hash
		) {
			throw new Error(
				`Table endpoint must be an origin with no path, query, or fragment: ${JSON.stringify(opts.tableEndpoint)}`,
			);
		}
		this.tableName = opts.tableName ?? DEFAULT_TABLE_NAME;
		if (!TABLE_NAME_RE.test(this.tableName)) {
			throw new Error(
				`Invalid Azure table name ${JSON.stringify(this.tableName)}: must be 3-63 alphanumeric characters and must not start with a digit`,
			);
		}
		this.tableUrl = `${endpoint.origin}/${this.tableName}`;

		this.tokenProvider =
			opts.tokenProvider ?? createTableStorageTokenProvider();
		this.now = opts.now ?? Date.now;
		this.logger = opts.logger ?? console;
		this.cacheTtlMs = opts.cacheTtlMs ?? CACHE_TTL_MS;
		this.maxWriteAttempts = opts.maxWriteAttempts ?? MAX_WRITE_ATTEMPTS;
		this.policy = {
			fetchFn: opts.fetchFn ?? fetch,
			requestTimeoutMs: opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			maxAttempts: opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
			maxRetryDelayMs: opts.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
			sleep: opts.sleep ?? defaultSleep,
			newCorrelationId: opts.newCorrelationId ?? randomUUID,
			now: this.now,
			logger: this.logger,
			signal: opts.signal,
		};
		this.wrapper =
			opts.keyWrapper ??
			new KeyVaultKeyWrapper({
				keyId: opts.keyId,
				tokenProvider: opts.keyVaultTokenProvider,
				fetchFn: opts.fetchFn,
				requestTimeoutMs: this.policy.requestTimeoutMs,
				maxAttempts: this.policy.maxAttempts,
				maxRetryDelayMs: this.policy.maxRetryDelayMs,
				sleep: this.policy.sleep,
				newCorrelationId: this.policy.newCorrelationId,
				now: this.now,
				logger: this.logger,
				signal: opts.signal,
			});
	}

	/** Lets the UI feature-detect the record surface without `instanceof`. */
	supportsRecords(): boolean {
		return true;
	}

	async get(email: string): Promise<UserSecretBundle> {
		return { ...((await this.getRecord(email))?.bundle ?? {}) };
	}

	async getRecord(
		email: string,
	): Promise<{ bundle: UserSecretBundle; etag: string } | undefined> {
		return this.readRecord(email.toLowerCase(), false);
	}

	async set(
		email: string,
		key: string,
		value: string | undefined,
	): Promise<void> {
		// Validate before any network call, exactly like FileSecretStore.
		const normalizedKey = normalizeSecretKey(key);
		await this.mutate(email.toLowerCase(), (bundle) => {
			if (value === undefined) {
				delete bundle[normalizedKey];
			} else {
				bundle[normalizedKey] = value;
			}
			return true;
		});
	}

	/**
	 * Writes `bundle` as the user's whole record.
	 *
	 * With `ifMatch` this is a conditional Update Entity (`PUT`) — HTTP 412
	 * means someone else wrote first. Without it, it is an Insert Entity
	 * (`POST`) — HTTP 409 means someone else created the record first. A `PUT`
	 * with no `If-Match` is never emitted: the Table service silently switches
	 * it to Insert-Or-Replace and returns 204, which would make every conflict
	 * undetectable and drop any property missing from the payload.
	 */
	async putRecord(
		email: string,
		bundle: UserSecretBundle,
		ifMatch?: string,
	): Promise<{ etag: string }> {
		if (ifMatch !== undefined && (ifMatch === "" || ifMatch === "*")) {
			throw new Error(
				`Refusing to write with If-Match: ${JSON.stringify(ifMatch)}. A missing or wildcard ETag turns a conditional update into a last-writer-wins upsert.`,
			);
		}
		const id = email.toLowerCase();
		const sealed = await sealBundle(bundle, this.wrapper, this.aad(id));
		const body = this.entityBody(id, sealed);
		this.cache.delete(id);

		if (ifMatch === undefined) {
			const { response, correlationId } = await this.send(
				"POST",
				this.tableUrl,
				{ body, headers: { prefer: "return-no-content" }, terminal: [409] },
			);
			if (response.status === 409) {
				throw new SetupConflictError(
					"another writer created this record first",
				);
			}
			return {
				etag: this.requireEtag(response, "POST", this.tableUrl, correlationId),
			};
		}

		const url = this.entityUrl(id);
		const { response, correlationId } = await this.send("PUT", url, {
			body,
			headers: { "if-match": ifMatch },
			terminal: [412],
		});
		if (response.status === 412) throw new SetupConflictError();
		return { etag: this.requireEtag(response, "PUT", url, correlationId) };
	}

	/**
	 * Creates the user's record if absent, and adds any `requiredKeys` that are
	 * not present as empty strings. Never overwrites a stored value. Returns
	 * whether anything was written.
	 */
	async ensureRecord(
		email: string,
		requiredKeys: readonly string[],
	): Promise<{ created: boolean }> {
		// Validate before any network call.
		const normalized = requiredKeys.map((key) => normalizeSecretKey(key));
		const wrote = await this.mutate(email.toLowerCase(), (bundle, existed) => {
			let changed = !existed;
			for (const key of normalized) {
				if (!Object.hasOwn(bundle, key)) {
					bundle[key] = "";
					changed = true;
				}
			}
			return changed;
		});
		return { created: wrote };
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

	/* ---------------------------------------------------------------------- */

	/**
	 * Read-modify-write with bounded retries. A create race (409) and a stale
	 * ETag (412) are both resolved by re-reading — never by an unconditional
	 * write, which would silently discard the other writer's values.
	 */
	private async mutate(
		id: string,
		apply: (bundle: UserSecretBundle, existed: boolean) => boolean,
	): Promise<boolean> {
		let lastConflict: SetupConflictError | undefined;
		for (let attempt = 1; attempt <= this.maxWriteAttempts; attempt++) {
			const record = await this.readRecord(id, attempt > 1);
			const bundle = { ...(record?.bundle ?? {}) };
			if (!apply(bundle, record !== undefined)) return false;
			try {
				await this.putRecord(id, bundle, record?.etag);
				return true;
			} catch (error) {
				if (!(error instanceof SetupConflictError)) throw error;
				lastConflict = error;
				this.logger.warn(
					`Azure Table setup record for ${setupPartitionKey(id)} changed under us; re-reading (attempt ${attempt}/${this.maxWriteAttempts})`,
				);
			}
		}
		throw (
			lastConflict ??
			new SetupConflictError(`gave up after ${this.maxWriteAttempts} attempts`)
		);
	}

	private async readRecord(
		id: string,
		bypassCache: boolean,
	): Promise<{ bundle: UserSecretBundle; etag: string } | undefined> {
		if (!bypassCache) {
			const cached = this.cache.get(id);
			if (cached && cached.expiresAt > this.now()) {
				return { bundle: { ...cached.bundle }, etag: cached.etag };
			}
		}
		const url = this.entityUrl(id);
		const { response, correlationId } = await this.send("GET", url, {
			terminal: [404],
		});
		if (response.status === 404) {
			this.cache.delete(id);
			return undefined;
		}
		// Parsed before the ETag is resolved because the payload is one of the
		// two places the token may live — see `requireEtag`.
		const entity = (await response.json()) as Record<string, unknown>;
		const etag = this.requireEtag(response, "GET", url, correlationId, entity);
		const bundle = await openBundle(
			this.toSealed(entity, url, correlationId),
			this.wrapper,
			this.aad(id),
		);
		this.cache.set(id, {
			expiresAt: this.now() + this.cacheTtlMs,
			bundle,
			etag,
		});
		return { bundle: { ...bundle }, etag };
	}

	private toSealed(
		entity: Record<string, unknown>,
		url: string,
		correlationId: string,
	): SealedBundle {
		const schemaVersion = entity.SchemaVersion;
		const parsedSchema =
			typeof schemaVersion === "string" ? Number(schemaVersion) : schemaVersion;
		if (parsedSchema !== SCHEMA_VERSION) {
			throw new Error(
				`Azure Table ${url} [${correlationId}] has unsupported schema version ${JSON.stringify(schemaVersion)}; expected ${SCHEMA_VERSION}`,
			);
		}
		const str = (name: string): string => {
			const value = entity[name];
			if (typeof value !== "string" || value.length === 0) {
				throw new Error(
					`Azure Table ${url} [${correlationId}] property "${name}" is missing or not a string`,
				);
			}
			return value;
		};
		return {
			kekVersion: str("KekVersion"),
			wrappedDek: str("WrappedDek"),
			iv: str("Iv"),
			authTag: str("AuthTag"),
			ciphertext: str("Ciphertext"),
		};
	}

	/**
	 * `Edm.Binary` for every crypto column: the wire form is standard base64
	 * either way, but `Edm.String` is UTF-16 internally and caps at ~32 K
	 * *characters*, which would put the real ceiling far below the documented
	 * 64 KiB. `Edm.Int64` requires a JSON **string** plus its annotation — a
	 * bare number is inferred as Int32 (no decimal point) or Double (with one).
	 */
	private entityBody(id: string, sealed: SealedBundle): string {
		return JSON.stringify({
			PartitionKey: setupPartitionKey(id),
			RowKey: SETUP_ROW_KEY,
			Email: id,
			SchemaVersion: SCHEMA_VERSION,
			KekVersion: sealed.kekVersion,
			"WrappedDek@odata.type": "Edm.Binary",
			WrappedDek: sealed.wrappedDek,
			"Iv@odata.type": "Edm.Binary",
			Iv: sealed.iv,
			"AuthTag@odata.type": "Edm.Binary",
			AuthTag: sealed.authTag,
			"Ciphertext@odata.type": "Edm.Binary",
			Ciphertext: sealed.ciphertext,
			"UpdatedMs@odata.type": "Edm.Int64",
			UpdatedMs: String(Math.trunc(this.now())),
		});
	}

	private aad(id: string): string {
		return `${setupPartitionKey(id)}|${SETUP_ROW_KEY}|${SCHEMA_VERSION}`;
	}

	private entityUrl(id: string): string {
		// Both key components are generated: `u` + 64 hex, and a constant. No
		// user-controlled text reaches the URL.
		return `${this.tableUrl}(PartitionKey='${setupPartitionKey(id)}',RowKey='${SETUP_ROW_KEY}')`;
	}

	/**
	 * The entity's concurrency token, from either place the Table service is
	 * documented to put it.
	 *
	 * Azure's own REST reference is inconsistent about the read path. The
	 * published service contract (azure-rest-api-specs, and therefore the
	 * `Table_queryEntitiesWithPartitionAndRowKey` header mapper generated into
	 * `@azure/data-tables`) declares `ETag` as a response header on the point
	 * GET at `odata=minimalmetadata` — but the prose "Query Entities" page
	 * omits `ETag` from its response-header table, and the payload-format page
	 * marks the `odata.etag` annotation `fullmetadata`-only. Meanwhile the
	 * official SDK's `TableClient.getEntity` reads the etag out of the parsed
	 * **body** (`odata.etag`), not the header, while its write paths read the
	 * header. Relying on exactly one of the two would make every read of an
	 * existing record fail if that source turned out to be the missing one.
	 *
	 * So: prefer the header, fall back to the payload, and fail closed when
	 * neither is present. A missing token stays a protocol error — falling
	 * through to `""` would make the next write unconditional, i.e. a silent
	 * upsert, the same hazard `FileSecretStore.readAll` documents for read
	 * failures.
	 */
	private requireEtag(
		response: Response,
		method: string,
		url: string,
		correlationId: string,
		entity?: Record<string, unknown>,
	): string {
		const header = response.headers.get("etag") || undefined;
		// `odata.etag` is the OData 3.0 spelling Azure Table emits under
		// `DataServiceVersion: 3.0`; `@odata.etag` is the OData 4.0 spelling,
		// accepted here only so a future service version cannot break reads.
		const payload = entity?.["odata.etag"] ?? entity?.["@odata.etag"];
		const fromPayload =
			typeof payload === "string" && payload.length > 0 ? payload : undefined;
		if (header && fromPayload && header !== fromPayload) {
			this.logger.warn(
				`Azure Table ${method} ${url} [${correlationId}] returned disagreeing ETags (header ${header}, payload ${fromPayload}); using the header`,
			);
		}
		const etag = header ?? fromPayload;
		if (!etag) {
			throw new Error(
				`Azure Table ${method} ${url} returned ${response.status} with no ETag header and no "odata.etag" property [${correlationId}]; refusing to continue because the next write would become an unconditional upsert`,
			);
		}
		return etag;
	}

	private async send(
		method: string,
		url: string,
		opts: {
			body?: string;
			headers?: Record<string, string>;
			terminal?: readonly number[];
		} = {},
	): Promise<{ response: Response; correlationId: string }> {
		const terminal = opts.terminal ?? [];
		const { response, correlationId } = await azureRequest(
			{
				method,
				url,
				// The token is acquired inside `azureRequest`'s deadline rather
				// than awaited here, so a hung credential chain cannot outlive
				// the advertised per-request bound.
				tokenProvider: this.tokenProvider,
				headers: {
					"x-ms-version": X_MS_VERSION,
					accept: ACCEPT,
					"content-type": "application/json",
					DataServiceVersion: DATA_SERVICE_VERSION,
					MaxDataServiceVersion: DATA_SERVICE_VERSION,
					"x-ms-date": new Date(this.now()).toUTCString(),
					...(opts.headers ?? {}),
				},
				...(opts.body === undefined ? {} : { body: opts.body }),
				service: "Azure Table",
				noRetryStatuses: terminal,
			},
			this.policy,
		);
		// Anything non-2xx that is not a meaningful state MUST throw: degrading
		// a read failure to "empty bundle" would boot a worker with no
		// credentials, and let a later write destroy the record.
		if (!response.ok && !terminal.includes(response.status)) {
			throw new Error(
				`Azure Table ${method} ${url} failed (${response.status}) [${correlationId}]: ${await response.text()}`,
			);
		}
		return { response, correlationId };
	}
}
