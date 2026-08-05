import { randomUUID } from "node:crypto";
import type {
	RegisteredRepository,
	RegistrySnapshot,
	RepositoryRegistry,
} from "./RepositoryRegistry.js";
import { validateRegisteredRepository } from "./RepositoryRegistry.js";
import {
	type AzureRequestPolicy,
	azureRequest,
	DEFAULT_MAX_ATTEMPTS,
	DEFAULT_MAX_RETRY_DELAY_MS,
	DEFAULT_REQUEST_TIMEOUT_MS,
	defaultSleep,
} from "./setup/envelope.js";
import { SetupConflictError } from "./TableSecretStore.js";

const TABLE_SCOPE = "https://storage.azure.com/.default";
const DEFAULT_TABLE_NAME = "cyrussetup";

/**
 * The registry's partition key.
 *
 * `setupPartitionKey` mints per-user keys as `u` + 64 hex characters, so a
 * different first character alone guarantees this can never collide with a
 * user's secret record — and no email can ever hash to it. The 64 zeros keep
 * the key the same length as a user key, so a human scanning the table sees
 * one consistent shape.
 */
export const REGISTRY_PARTITION_KEY = `g${"0".repeat(64)}`;

/** The registry's single row. */
export const REGISTRY_ROW_KEY = "repositories";

export interface TableRepositoryRegistryOptions {
	/** Bare https origin, e.g. "https://stexample.table.core.windows.net". */
	tableEndpoint: string;
	/** Default {@link DEFAULT_TABLE_NAME}. */
	tableName?: string;
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

function createTableTokenProvider(): () => Promise<string> {
	let credential:
		| { getToken(scope: string): Promise<{ token: string } | null> }
		| undefined;
	return async () => {
		if (!credential) {
			const { DefaultAzureCredential } = await import("@azure/identity");
			credential = new DefaultAzureCredential();
		}
		const token = await credential.getToken(TABLE_SCOPE);
		if (!token?.token) {
			throw new Error("DefaultAzureCredential returned no access token");
		}
		return token.token;
	};
}

/**
 * The global repository registry, stored as ONE Azure Table entity.
 *
 * Deliberately **plaintext**, unlike `TableSecretStore`: repository names and
 * `org/repo` slugs are not credentials, and keeping the KEK out of this path
 * means the registry works in a deployment that holds the Table role but not
 * *Key Vault Crypto User*. Encrypting it would add a failure mode to every
 * container boot in exchange for hiding nothing.
 *
 * Concurrency is the Table service's own ETag: `list` returns it as the opaque
 * `version` and `put` sends it back as `If-Match`. A 412 — or a 409 from a lost
 * insert race — becomes a {@link SetupConflictError}, which the setup UI renders
 * as "someone else changed this" instead of silently overwriting.
 */
export class TableRepositoryRegistry implements RepositoryRegistry {
	private readonly tableUrl: string;
	private readonly tokenProvider: () => Promise<string>;
	private readonly policy: AzureRequestPolicy;

	constructor(options: TableRepositoryRegistryOptions) {
		const origin = options.tableEndpoint.replace(/\/+$/, "");
		this.tableUrl = `${origin}/${options.tableName ?? DEFAULT_TABLE_NAME}`;
		this.tokenProvider = options.tokenProvider ?? createTableTokenProvider();
		this.policy = {
			fetchFn: options.fetchFn ?? fetch,
			requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			maxAttempts: options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
			maxRetryDelayMs: options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS,
			sleep: options.sleep ?? defaultSleep,
			newCorrelationId: options.newCorrelationId ?? randomUUID,
			now: options.now ?? Date.now,
			logger: options.logger ?? console,
			...(options.signal ? { signal: options.signal } : {}),
		};
	}

	private entityUrl(): string {
		return `${this.tableUrl}(PartitionKey='${REGISTRY_PARTITION_KEY}',RowKey='${REGISTRY_ROW_KEY}')`;
	}

	async list(): Promise<RegistrySnapshot> {
		const { response, correlationId } = await azureRequest(
			{
				method: "GET",
				url: this.entityUrl(),
				headers: {
					accept: "application/json;odata=nometadata",
					"x-ms-version": "2019-02-02",
					dataserviceversion: "3.0",
				},
				tokenProvider: this.tokenProvider,
				service: "Azure Table",
				noRetryStatuses: [404],
			},
			this.policy,
		);

		if (response.status === 404) return { repositories: [] };
		if (!response.ok) {
			throw new Error(
				`Azure Table read of the repository registry failed (${response.status}) [${correlationId}]: ${await response.text()}`,
			);
		}

		const etag = response.headers.get("etag") ?? undefined;
		const body = (await response.json()) as { ReposJson?: unknown };
		return {
			repositories: this.parseRepositories(body.ReposJson, correlationId),
			...(etag ? { version: etag } : {}),
		};
	}

	/**
	 * A stored payload we cannot read is reported as an empty registry, never a
	 * throw. Throwing would make every container boot fail on one corrupt row;
	 * empty degrades to "no repositories configured", which the boot path
	 * already reports with actionable copy, and the next save heals the row.
	 *
	 * Every entry must also be a well-formed `RegisteredRepository`, not just an
	 * array — a syntactically valid `ReposJson` with e.g. a numeric `name` would
	 * otherwise reach `toRoutable`/`matchRepositories` and throw at runtime. This
	 * mirrors `FileRepositoryRegistry.read()`'s same check: a malformed entry is
	 * the same class of corruption as unparseable JSON, so it gets the same
	 * "reads as empty" treatment.
	 */
	private parseRepositories(
		raw: unknown,
		correlationId: string,
	): RegisteredRepository[] {
		if (typeof raw !== "string" || raw === "") return [];
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (!Array.isArray(parsed)) throw new Error("not a JSON array");
			for (const repo of parsed) {
				validateRegisteredRepository(repo as RegisteredRepository);
			}
			return parsed as RegisteredRepository[];
		} catch (error) {
			this.policy.logger.warn(
				`Stored repository registry is unreadable [${correlationId}]: ${(error as Error).message}. Treating it as empty.`,
			);
			return [];
		}
	}

	async put(
		repositories: RegisteredRepository[],
		version?: string,
	): Promise<{ version: string }> {
		// Defence in depth, mirroring `TableSecretStore.putRecord`'s identical
		// guard: the routes layer is the thing that is supposed to keep a caller
		// from ever presenting `"*"` or `""` here (a signed, principal-bound
		// version token that decodes to one of those could never be forged
		// without the CSRF secret), but the store is the thing actually making
		// the "conditional write only" guarantee this class's own doc comment
		// promises, so it must not trust a caller to have upheld that.
		if (version !== undefined && (version === "" || version === "*")) {
			throw new Error(
				`Refusing to write with If-Match: ${JSON.stringify(version)}. A missing or wildcard ETag turns a conditional update into a last-writer-wins upsert.`,
			);
		}
		// Before any token acquisition or network use, so a malformed entry costs
		// nothing and fails with a message the UI can render.
		for (const repo of repositories) validateRegisteredRepository(repo);

		const entity = {
			PartitionKey: REGISTRY_PARTITION_KEY,
			RowKey: REGISTRY_ROW_KEY,
			ReposJson: JSON.stringify(repositories),
			UpdatedMs: this.policy.now(),
		};

		// No version -> Insert Entity (POST to the table). A version -> Update
		// Entity (PUT to the row) with If-Match. `If-Match: *` is deliberately
		// never sent: it is exactly the unconditional overwrite the ETag exists
		// to prevent.
		const isInsert = version === undefined;
		const { response, correlationId } = await azureRequest(
			{
				method: isInsert ? "POST" : "PUT",
				url: isInsert ? this.tableUrl : this.entityUrl(),
				headers: {
					"content-type": "application/json",
					accept: "application/json;odata=nometadata",
					"x-ms-version": "2019-02-02",
					dataserviceversion: "3.0",
					prefer: "return-no-content",
					...(isInsert ? {} : { "if-match": version }),
				},
				tokenProvider: this.tokenProvider,
				body: JSON.stringify(entity),
				service: "Azure Table",
			},
			this.policy,
		);

		if (response.status === 412 || response.status === 409) {
			throw new SetupConflictError(
				`the repository registry was modified by someone else [${correlationId}]`,
			);
		}
		if (!response.ok) {
			throw new Error(
				`Azure Table write of the repository registry failed (${response.status}) [${correlationId}]: ${await response.text()}`,
			);
		}
		const etag = response.headers.get("etag");
		if (!etag) {
			throw new Error(
				`Azure Table write of the repository registry returned no ETag [${correlationId}]`,
			);
		}
		return { version: etag };
	}
}
