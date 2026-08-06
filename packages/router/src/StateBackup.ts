import { existsSync, mkdirSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createNoopLogger, type ILogger } from "cyrus-core";
import Database from "better-sqlite3";

const STORAGE_SCOPE = "https://storage.azure.com/.default";
const DEFAULT_INTERVAL_MS = 300_000;

export interface StateBackupOptions {
	dbPath: string;
	blobContainerUrl: string;
	intervalMs?: number;
	tokenProvider?: () => Promise<string>;
	fetchFn?: typeof fetch;
	logger?: ILogger;
}

export function createStorageTokenProvider(): () => Promise<string> {
	let credential:
		| { getToken(scope: string): Promise<{ token: string } | null> }
		| undefined;
	return async () => {
		if (!credential) {
			const { DefaultAzureCredential } = await import("@azure/identity");
			credential = new DefaultAzureCredential();
		}
		const token = await credential!.getToken(STORAGE_SCOPE);
		if (!token?.token)
			throw new Error("DefaultAzureCredential returned no access token");
		return token.token;
	};
}

/** Restores and periodically uploads the router SQLite database as router.db. */
export class StateBackup {
	private readonly dbPath: string;
	private readonly blobUrl: string;
	private readonly intervalMs: number;
	private readonly tokenProvider: () => Promise<string>;
	private readonly fetchFn: typeof fetch;
	private readonly logger: ILogger;
	private timer: NodeJS.Timeout | undefined;
	private inFlight: Promise<void> | undefined;

	constructor(opts: StateBackupOptions) {
		this.dbPath = opts.dbPath;
		this.blobUrl = appendBlobName(opts.blobContainerUrl, "router.db");
		this.intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
		this.tokenProvider = opts.tokenProvider ?? createStorageTokenProvider();
		this.fetchFn = opts.fetchFn ?? fetch;
		this.logger = opts.logger ?? createNoopLogger();
	}

	/** Must run before RouterStore opens the database. */
	async restoreIfNeeded(): Promise<"restored" | "fresh" | "existing"> {
		if (existsSync(this.dbPath)) return "existing";
		const response = await this.fetchFn(this.blobUrl, {
			headers: {
				authorization: `Bearer ${await this.tokenProvider()}`,
				"x-ms-version": "2023-11-03",
			},
		});
		if (response.status === 404) return "fresh";
		if (!response.ok) {
			throw new Error(
				`router state restore failed (${response.status}): ${await response.text()}`,
			);
		}

		mkdirSync(dirname(this.dbPath), { recursive: true });
		const tmp = `${this.dbPath}.restore.tmp`;
		try {
			await writeFile(tmp, Buffer.from(await response.arrayBuffer()), {
				mode: 0o600,
			});
			const db = new Database(tmp, { readonly: true });
			try {
				const result = db.pragma("quick_check") as Array<{
					quick_check: string;
				}>;
				if (result.some((row) => row.quick_check !== "ok")) {
					throw new Error(
						`SQLite quick_check failed: ${JSON.stringify(result)}`,
					);
				}
			} finally {
				db.close();
			}
			await rename(tmp, this.dbPath);
			this.logger.info(`Restored router state from ${this.blobUrl}`);
			return "restored";
		} catch (error) {
			await rm(tmp, { force: true });
			throw new Error(
				`router state restore is corrupt or unreadable: ${String(error)}`,
			);
		}
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => void this.flush(), this.intervalMs);
		this.timer.unref?.();
	}

	/** Runtime failures are logged and deliberately never escape. */
	async flush(): Promise<void> {
		if (this.inFlight) return this.inFlight;
		this.inFlight = this.upload().catch((error: unknown) => {
			this.logger.warn(`router state backup failed: ${String(error)}`);
		});
		try {
			await this.inFlight;
		} finally {
			this.inFlight = undefined;
		}
	}

	async stop(): Promise<void> {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		await this.inFlight;
		await this.flush();
	}

	private async upload(): Promise<void> {
		const tmp = `${this.dbPath}.backup.tmp`;
		await rm(tmp, { force: true });
		const db = new Database(this.dbPath, { readonly: true });
		try {
			await db.backup(tmp);
		} finally {
			db.close();
		}
		try {
			const response = await this.fetchFn(this.blobUrl, {
				method: "PUT",
				headers: {
					authorization: `Bearer ${await this.tokenProvider()}`,
					"content-type": "application/octet-stream",
					"x-ms-blob-type": "BlockBlob",
					"x-ms-version": "2023-11-03",
				},
				body: await readFile(tmp),
			});
			if (!response.ok) {
				throw new Error(
					`PutBlob failed (${response.status}): ${await response.text()}`,
				);
			}
		} finally {
			await rm(tmp, { force: true });
		}
	}
}

function appendBlobName(containerUrl: string, name: string): string {
	const url = new URL(containerUrl);
	url.pathname = `${url.pathname.replace(/\/$/, "")}/${name}`;
	return url.toString();
}
