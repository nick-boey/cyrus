import { describe, expect, it, vi } from "vitest";
import type { KeyWrapper } from "../src/setup/envelope.js";
import {
	SETUP_ROW_KEY,
	SetupConflictError,
	setupPartitionKey,
	TableSecretStore,
	type TableSecretStoreOptions,
} from "../src/TableSecretStore.js";

const ENDPOINT = "https://sttest.table.core.windows.net";
const VAULT = "https://kv-test.vault.azure.net";
const KEY_NAME = "cyrus-setup-kek";
const VERSION = "0123456789abcdef0123456789abcdef";
const KEY_ID = `${VAULT}/keys/${KEY_NAME}/${VERSION}`;
const TABLE = "cyrussetup";
const ALICE = "alice@example.com";
const BOB = "bob@example.com";

/** See D4′: none of these may reach the network or the token provider. */
const HOSTILE_VERSIONS = [
	"https://attacker.example/x",
	"../../evil",
	`${VERSION}f`,
	"",
	`${VERSION}\n`,
] as const;

function entityKey(email: string): string {
	return `${TABLE}(PartitionKey='${setupPartitionKey(email)}',RowKey='${SETUP_ROW_KEY}')`;
}

/** XOR "wrap" — lets a test exercise the Table path with no Key Vault traffic. */
function identityWrapper(version = VERSION): KeyWrapper {
	const mask = Buffer.alloc(32, 0x5a);
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

/** In-memory Azure Table + Key Vault crypto double. */
function harness() {
	const rows = new Map<string, Record<string, unknown>>();
	const etags = new Map<string, string>();
	const kvUrls: string[] = [];
	let etagCounter = 0;
	let now = 1_000;
	let vaultTokenCalls = 0;
	let storageTokenCalls = 0;
	let beforeInsert: (() => Promise<void>) | undefined;

	const fetchFn = vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		const headers = new Headers(init?.headers);

		if (url.includes("/wrapkey") || url.includes("/unwrapkey")) {
			kvUrls.push(url);
			const { value } = JSON.parse(String(init?.body)) as { value: string };
			// Identity "crypto": exercises encoding, not cryptography.
			return new Response(
				JSON.stringify({
					kid: url.replace(/\/(un)?wrapkey\?.*$/, ""),
					value,
				}),
				{ status: 200 },
			);
		}

		if (method === "POST") {
			const hook = beforeInsert;
			beforeInsert = undefined;
			if (hook) await hook();
			const row = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const key = `${TABLE}(PartitionKey='${row.PartitionKey}',RowKey='${row.RowKey}')`;
			if (rows.has(key)) {
				return new Response(
					JSON.stringify({
						"odata.error": { code: "EntityAlreadyExists" },
					}),
					{ status: 409 },
				);
			}
			const etag = `W/"datetime'${++etagCounter}'"`;
			rows.set(key, row);
			etags.set(key, etag);
			return new Response(null, { status: 204, headers: { ETag: etag } });
		}

		const key = url.slice(url.indexOf(`${TABLE}(`));
		if (method === "GET") {
			const row = rows.get(key);
			if (!row) return new Response("ResourceNotFound", { status: 404 });
			return new Response(JSON.stringify(row), {
				status: 200,
				headers: { ETag: etags.get(key)! },
			});
		}
		if (method === "PUT") {
			const ifMatch = headers.get("if-match");
			if (!ifMatch) {
				// An unconditional PUT silently becomes Insert-Or-Replace. The
				// store must never emit one — fail loudly if it does.
				throw new Error(`PUT without If-Match: ${url}`);
			}
			if (ifMatch !== etags.get(key)) {
				return new Response("UpdateConditionNotSatisfied", { status: 412 });
			}
			const row = JSON.parse(String(init?.body)) as Record<string, unknown>;
			const etag = `W/"datetime'${++etagCounter}'"`;
			rows.set(key, row);
			etags.set(key, etag);
			return new Response(null, { status: 204, headers: { ETag: etag } });
		}
		throw new Error(`unexpected ${method} ${url}`);
	});

	const create = (overrides: Partial<TableSecretStoreOptions> = {}) =>
		new TableSecretStore({
			tableEndpoint: ENDPOINT,
			tableName: TABLE,
			keyId: KEY_ID,
			tokenProvider: async () => {
				storageTokenCalls++;
				return "storage-token";
			},
			keyVaultTokenProvider: async () => {
				vaultTokenCalls++;
				return "vault-token";
			},
			fetchFn: fetchFn as unknown as typeof fetch,
			now: () => now,
			sleep: async () => {},
			...overrides,
		});

	return {
		create,
		store: create(),
		fetchFn,
		rows,
		etags,
		kvUrls,
		vaultTokenCalls: () => vaultTokenCalls,
		storageTokenCalls: () => storageTokenCalls,
		advance: (ms: number) => {
			now += ms;
		},
		raceInsert: (hook: () => Promise<void>) => {
			beforeInsert = hook;
		},
	};
}

/** All Table (non-Key-Vault) requests the fake saw, oldest first. */
function tableCalls(fetchFn: ReturnType<typeof harness>["fetchFn"]) {
	return fetchFn.mock.calls
		.map(([input, init]) => ({
			url: String(input),
			method: (init as RequestInit | undefined)?.method ?? "GET",
			init: init as RequestInit | undefined,
		}))
		.filter((call) => !call.url.includes("wrapkey"));
}

describe("TableSecretStore — SecretStoreBackend contract", () => {
	it("advertises the record surface", () => {
		expect(harness().store.supportsRecords()).toBe(true);
	});

	it("returns an empty bundle for a user with no record", async () => {
		const { store } = harness();
		expect(await store.get(ALICE)).toEqual({});
	});

	it("round-trips a value through set/get", async () => {
		const { store } = harness();
		await store.set(ALICE, "GIT_TOKEN", "ghp_x");
		expect(await store.get(ALICE)).toEqual({ GIT_TOKEN: "ghp_x" });
	});

	it("is case-insensitive on email", async () => {
		const { store } = harness();
		await store.set("Alice@Example.COM", "GIT_TOKEN", "ghp_x");
		expect(await store.get(ALICE)).toEqual({ GIT_TOKEN: "ghp_x" });
	});

	it("maps legacy key names through normalizeSecretKey", async () => {
		const { store } = harness();
		await store.set(ALICE, "githubPat", "ghp_x");
		expect(await store.get(ALICE)).toEqual({ GIT_TOKEN: "ghp_x" });
	});

	it("rejects reserved env keys before any network call", async () => {
		const { store, fetchFn } = harness();
		await expect(store.set(ALICE, "CYRUS_DEVICE_TOKEN", "x")).rejects.toThrow(
			/reserved/,
		);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("rejects an invalid env var name before any network call", async () => {
		const { store, fetchFn } = harness();
		await expect(store.set(ALICE, "not a name", "x")).rejects.toThrow(
			/not a valid environment variable name/,
		);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("removes a key when the value is undefined", async () => {
		const { store } = harness();
		await store.set(ALICE, "A", "1");
		await store.set(ALICE, "B", "2");
		await store.set(ALICE, "A", undefined);
		expect(await store.get(ALICE)).toEqual({ B: "2" });
	});

	it("keeps users isolated", async () => {
		const { store } = harness();
		await store.set(ALICE, "A", "1");
		await store.set(BOB, "A", "2");
		expect(await store.get(ALICE)).toEqual({ A: "1" });
		expect(await store.get(BOB)).toEqual({ A: "2" });
	});

	it("reports missing required keys", async () => {
		const { store } = harness();
		await store.set(ALICE, "A", "1");
		expect(await store.isFullyAuthenticated(ALICE, ["A", "B"])).toEqual({
			ok: false,
			missing: ["B"],
		});
	});

	it("treats an empty string as missing", async () => {
		const { store } = harness();
		await store.set(ALICE, "A", "");
		expect(await store.isFullyAuthenticated(ALICE, ["A"])).toEqual({
			ok: false,
			missing: ["A"],
		});
	});
});

describe("TableSecretStore — confidentiality", () => {
	it("never writes a plaintext value into a request body", async () => {
		const { store, fetchFn } = harness();
		await store.set(ALICE, "GIT_TOKEN", "super-secret-value");
		const bodies = fetchFn.mock.calls
			.map(([, init]) => String((init as RequestInit | undefined)?.body ?? ""))
			.join("\n");
		expect(bodies).not.toContain("super-secret-value");
		expect(bodies).not.toContain("GIT_TOKEN");
	});

	it("does not put the email in any URL", async () => {
		const { store, fetchFn } = harness();
		await store.set(ALICE, "A", "1");
		const urls = fetchFn.mock.calls.map(([input]) => String(input)).join("\n");
		expect(urls).not.toContain(ALICE);
		expect(urls).toContain(setupPartitionKey(ALICE));
	});

	it("binds the ciphertext to its row — a copied payload will not open", async () => {
		const h = harness();
		await h.store.set(ALICE, "SECRET", "alice-only");
		const stolen = { ...h.rows.get(entityKey(ALICE))! };
		h.rows.set(entityKey(BOB), {
			...stolen,
			PartitionKey: setupPartitionKey(BOB),
			Email: BOB,
		});
		h.etags.set(entityKey(BOB), 'W/"copied"');
		await expect(h.create().get(BOB)).rejects.toThrow();
	});
});

describe("TableSecretStore — Table REST wire format", () => {
	it("sends every required header on every request", async () => {
		const { store, fetchFn } = harness();
		await store.get(ALICE);
		const call = tableCalls(fetchFn)[0]!;
		const headers = new Headers(call.init?.headers);
		expect(headers.get("authorization")).toBe("Bearer storage-token");
		expect(headers.get("x-ms-version")).toBe("2020-12-06");
		expect(headers.get("accept")).toBe(
			"application/json;odata=minimalmetadata",
		);
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("dataserviceversion")).toBe("3.0;NetFx");
		expect(headers.get("maxdataserviceversion")).toBe("3.0;NetFx");
		expect(headers.get("x-ms-date")).toBe(new Date(1_000).toUTCString());
		expect(headers.get("x-ms-client-request-id")).toBeTruthy();
	});

	it("asks for minimalmetadata, never nometadata", async () => {
		const { store, fetchFn } = harness();
		await store.get(ALICE);
		for (const call of tableCalls(fetchFn)) {
			const accept = new Headers(call.init?.headers).get("accept");
			expect(accept).toContain("odata=minimalmetadata");
			expect(accept).not.toContain("nometadata");
		}
	});

	it("encodes UpdatedMs as an annotated Edm.Int64 string", async () => {
		const { store, fetchFn } = harness();
		await store.set(ALICE, "A", "1");
		const insert = tableCalls(fetchFn).find((c) => c.method === "POST")!;
		const body = JSON.parse(String(insert.init?.body)) as Record<
			string,
			unknown
		>;
		expect(body["UpdatedMs@odata.type"]).toBe("Edm.Int64");
		expect(body.UpdatedMs).toBe("1000");
		expect(typeof body.UpdatedMs).toBe("string");
	});

	it("encodes the crypto columns as annotated Edm.Binary standard base64", async () => {
		const { store, fetchFn } = harness();
		await store.set(ALICE, "A", "1");
		const insert = tableCalls(fetchFn).find((c) => c.method === "POST")!;
		const body = JSON.parse(String(insert.init?.body)) as Record<
			string,
			string
		>;
		for (const column of ["Ciphertext", "WrappedDek", "Iv", "AuthTag"]) {
			expect(body[`${column}@odata.type`]).toBe("Edm.Binary");
			const value = body[column]!;
			// Standard base64 (RFC 4648 §4), NOT the base64url Key Vault speaks.
			expect(value).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
			expect(Buffer.from(value, "base64").toString("base64")).toBe(value);
		}
		expect(Buffer.from(body.Iv!, "base64")).toHaveLength(12);
		expect(Buffer.from(body.AuthTag!, "base64")).toHaveLength(16);
	});

	it("stores the bare KEK version, never a URL", async () => {
		const h = harness();
		await h.store.set(ALICE, "A", "1");
		const row = h.rows.get(entityKey(ALICE))!;
		expect(row.KekVersion).toBe(VERSION);
		expect(JSON.stringify(row)).not.toContain("https://");
	});

	it("targets the configured table and hashed partition key", async () => {
		const h = harness();
		await h.store.set(ALICE, "A", "1");
		const calls = tableCalls(h.fetchFn);
		expect(calls.find((c) => c.method === "POST")!.url).toBe(
			`${ENDPOINT}/${TABLE}`,
		);
		expect(calls[0]!.url).toBe(`${ENDPOINT}/${entityKey(ALICE)}`);
	});

	it("refuses an endpoint or table name that could smuggle a path", () => {
		expect(
			() =>
				new TableSecretStore({
					tableEndpoint: `${ENDPOINT}/evil`,
					keyId: KEY_ID,
					keyWrapper: identityWrapper(),
				}),
		).toThrow(/endpoint/);
		expect(
			() =>
				new TableSecretStore({
					tableEndpoint: ENDPOINT,
					tableName: "bad-name",
					keyId: KEY_ID,
					keyWrapper: identityWrapper(),
				}),
		).toThrow(/table name/);
		expect(
			() =>
				new TableSecretStore({
					tableEndpoint: ENDPOINT,
					tableName: "9leading",
					keyId: KEY_ID,
					keyWrapper: identityWrapper(),
				}),
		).toThrow(/table name/);
	});

	it("rejects a row written under an unsupported schema version", async () => {
		const h = harness();
		await h.store.set(ALICE, "A", "1");
		h.rows.get(entityKey(ALICE))!.SchemaVersion = 2;
		await expect(h.create().get(ALICE)).rejects.toThrow(/schema version/i);
	});
});

describe("TableSecretStore — concurrency", () => {
	it("creates with POST and updates with a conditional PUT", async () => {
		const h = harness();
		await h.store.set(ALICE, "A", "1");
		await h.store.set(ALICE, "B", "2");
		const methods = tableCalls(h.fetchFn).map((c) => c.method);
		expect(methods.filter((m) => m === "POST")).toHaveLength(1);
		const put = tableCalls(h.fetchFn).find((c) => c.method === "PUT")!;
		const ifMatch = new Headers(put.init?.headers).get("if-match");
		expect(ifMatch).toMatch(/^W\//);
	});

	it("returns an etag from getRecord", async () => {
		const { store } = harness();
		await store.set(ALICE, "A", "1");
		const record = await store.getRecord(ALICE);
		expect(record?.bundle).toEqual({ A: "1" });
		expect(record?.etag).toMatch(/^W\//);
	});

	it("returns undefined from getRecord when there is no record", async () => {
		const { store } = harness();
		expect(await store.getRecord(ALICE)).toBeUndefined();
	});

	it("putRecord with a stale etag throws SetupConflictError", async () => {
		const { store } = harness();
		await store.set(ALICE, "A", "1");
		const first = await store.getRecord(ALICE);
		await store.putRecord(ALICE, { A: "2" }, first!.etag);
		await expect(
			store.putRecord(ALICE, { A: "3" }, first!.etag),
		).rejects.toBeInstanceOf(SetupConflictError);
	});

	it("never retries a 412", async () => {
		const h = harness();
		await h.store.set(ALICE, "A", "1");
		const first = await h.store.getRecord(ALICE);
		await h.store.putRecord(ALICE, { A: "2" }, first!.etag);
		const before = h.fetchFn.mock.calls.length;
		await expect(
			h.store.putRecord(ALICE, { A: "3" }, first!.etag),
		).rejects.toBeInstanceOf(SetupConflictError);
		const after = h.fetchFn.mock.calls.slice(before);
		expect(after.filter(([, init]) => init?.method === "PUT")).toHaveLength(1);
	});

	it("refuses an empty or wildcard If-Match rather than falling back to upsert", async () => {
		const { store } = harness();
		await expect(store.putRecord(ALICE, { A: "1" }, "")).rejects.toThrow(
			/If-Match/,
		);
		await expect(store.putRecord(ALICE, { A: "1" }, "*")).rejects.toThrow(
			/If-Match/,
		);
	});

	it("recovers when another writer wins the create race", async () => {
		const h = harness();
		const other = h.create();
		h.raceInsert(async () => {
			await other.set(ALICE, "FROM_OTHER", "other-value");
		});
		await h.store.set(ALICE, "FROM_ME", "my-value");
		expect(await h.create().get(ALICE)).toEqual({
			FROM_OTHER: "other-value",
			FROM_ME: "my-value",
		});
	});

	it("surfaces a create race that never resolves as a conflict", async () => {
		const h = harness();
		const store = h.create({ maxWriteAttempts: 1 });
		const other = h.create();
		h.raceInsert(async () => {
			await other.set(ALICE, "FROM_OTHER", "other-value");
		});
		await expect(
			store.set(ALICE, "FROM_ME", "my-value"),
		).rejects.toBeInstanceOf(SetupConflictError);
	});

	it("throws when a successful GET carries no ETag", async () => {
		const h = harness();
		await h.store.set(ALICE, "A", "1");
		const row = h.rows.get(entityKey(ALICE))!;
		const store = h.create();
		h.fetchFn.mockImplementationOnce(
			async () => new Response(JSON.stringify(row), { status: 200 }),
		);
		await expect(store.getRecord(ALICE)).rejects.toThrow(/ETag/);
	});

	it("throws when a successful write carries no ETag", async () => {
		const h = harness();
		const store = h.create({ keyWrapper: identityWrapper() });
		h.fetchFn.mockImplementationOnce(
			async () => new Response("ResourceNotFound", { status: 404 }),
		);
		h.fetchFn.mockImplementationOnce(
			async () => new Response(null, { status: 204 }),
		);
		await expect(store.set(ALICE, "A", "1")).rejects.toThrow(/ETag/);
	});
});

describe("TableSecretStore — ensureRecord", () => {
	it("creates required keys as empty strings", async () => {
		const { store } = harness();
		expect(
			await store.ensureRecord(ALICE, ["CLAUDE_CODE_OAUTH_TOKEN"]),
		).toEqual({ created: true });
		expect(await store.get(ALICE)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "" });
	});

	it("is idempotent and never clobbers an existing value", async () => {
		const { store } = harness();
		await store.set(ALICE, "CLAUDE_CODE_OAUTH_TOKEN", "real");
		expect(
			await store.ensureRecord(ALICE, ["CLAUDE_CODE_OAUTH_TOKEN"]),
		).toEqual({ created: false });
		expect(await store.get(ALICE)).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "real",
		});
	});

	it("backfills a newly-required key onto an existing record", async () => {
		const { store } = harness();
		await store.set(ALICE, "CLAUDE_CODE_OAUTH_TOKEN", "real");
		expect(
			await store.ensureRecord(ALICE, [
				"CLAUDE_CODE_OAUTH_TOKEN",
				"LINEAR_API_TOKEN",
			]),
		).toEqual({ created: true });
		expect(await store.get(ALICE)).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "real",
			LINEAR_API_TOKEN: "",
		});
	});

	it("normalizes legacy required keys and writes no duplicate", async () => {
		const { store } = harness();
		expect(await store.ensureRecord(ALICE, ["githubPat"])).toEqual({
			created: true,
		});
		expect(await store.get(ALICE)).toEqual({ GIT_TOKEN: "" });
	});

	it("rejects a reserved required key before any network call", async () => {
		const { store, fetchFn } = harness();
		await expect(store.ensureRecord(ALICE, ["PATH"])).rejects.toThrow(
			/reserved/,
		);
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe("TableSecretStore — caching", () => {
	it("caches reads briefly and invalidates on write", async () => {
		const { store, fetchFn } = harness();
		await store.set(ALICE, "A", "1");
		await store.get(ALICE);
		const afterFirst = fetchFn.mock.calls.length;
		await store.get(ALICE);
		expect(fetchFn.mock.calls.length).toBe(afterFirst);
		await store.set(ALICE, "B", "2");
		const afterWrite = fetchFn.mock.calls.length;
		await store.get(ALICE);
		expect(fetchFn.mock.calls.length).toBeGreaterThan(afterWrite);
	});

	it("expires the cache after the TTL", async () => {
		const h = harness();
		await h.store.set(ALICE, "A", "1");
		await h.store.get(ALICE);
		const before = h.fetchFn.mock.calls.length;
		h.advance(60_001);
		await h.store.get(ALICE);
		expect(h.fetchFn.mock.calls.length).toBeGreaterThan(before);
	});
});

describe("TableSecretStore — deadlines, retries, and failure modes", () => {
	it("throws rather than resolving to {} on a 500 from Table storage", async () => {
		const h = harness();
		const store = h.create({ maxAttempts: 1 });
		h.fetchFn.mockImplementationOnce(
			async () => new Response("boom", { status: 500 }),
		);
		// The message must come from the request-failure path, not from some
		// later incidental check: a read that degrades to {} would boot a
		// worker with no credentials and let the next write destroy the record.
		await expect(store.get(ALICE)).rejects.toThrow(/failed \(500\).*boom/s);
	});

	it("retries a 429 and honours Retry-After", async () => {
		const h = harness();
		const sleep = vi.fn(async () => {});
		const store = h.create({ sleep });
		h.fetchFn.mockImplementationOnce(
			async () =>
				new Response("throttled", {
					status: 429,
					headers: { "retry-after": "1" },
				}),
		);
		expect(await store.get(ALICE)).toEqual({});
		expect(sleep).toHaveBeenCalledWith(1_000);
	});

	it("clamps an absurd Retry-After", async () => {
		const h = harness();
		const sleep = vi.fn(async () => {});
		const store = h.create({ sleep, maxRetryDelayMs: 5_000 });
		h.fetchFn.mockImplementationOnce(
			async () =>
				new Response("throttled", {
					status: 503,
					headers: { "retry-after": "86400" },
				}),
		);
		expect(await store.get(ALICE)).toEqual({});
		expect(sleep).toHaveBeenCalledWith(5_000);
	});

	it("gives up after the configured number of attempts", async () => {
		const h = harness();
		const fetchFn = vi.fn(async () => new Response("nope", { status: 503 }));
		const store = h.create({
			fetchFn: fetchFn as unknown as typeof fetch,
			maxAttempts: 3,
		});
		await expect(store.get(ALICE)).rejects.toThrow(/failed \(503\).*nope/s);
		expect(fetchFn).toHaveBeenCalledTimes(3);
	});

	it("times out a hanging request instead of hanging forever", async () => {
		const h = harness();
		const fetchFn = vi.fn(
			async (_input: string | URL, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => {
						reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
					});
				}),
		);
		const store = h.create({
			fetchFn: fetchFn as unknown as typeof fetch,
			requestTimeoutMs: 5,
		});
		await expect(store.get(ALICE)).rejects.toThrow(/timed out/);
	});

	it("honours an externally aborted signal without dispatching", async () => {
		const h = harness();
		const controller = new AbortController();
		controller.abort();
		const store = h.create({ signal: controller.signal });
		await expect(store.get(ALICE)).rejects.toThrow(/abort/i);
		expect(h.fetchFn).not.toHaveBeenCalled();
	});

	it("rejects a bundle over the size limit without writing anything", async () => {
		const h = harness();
		await expect(
			h.store.set(ALICE, "HUGE", "x".repeat(40_000)),
		).rejects.toThrow(/HUGE/);
		expect(h.rows.size).toBe(0);
		expect(h.kvUrls).toHaveLength(0);
	});
});

describe("TableSecretStore — a stored KekVersion is never trusted (D4′)", () => {
	it.each(HOSTILE_VERSIONS)(
		"makes zero Key Vault calls for stored version %j",
		async (hostile) => {
			const h = harness();
			await h.store.set(ALICE, "A", "1");
			h.rows.get(entityKey(ALICE))!.KekVersion = hostile;
			const kvBefore = h.kvUrls.length;
			const vaultBefore = h.vaultTokenCalls();
			await expect(h.create().get(ALICE)).rejects.toThrow();
			expect(h.kvUrls.length).toBe(kvBefore);
			expect(h.vaultTokenCalls()).toBe(vaultBefore);
		},
	);

	it("only ever talks to the configured vault and key name", async () => {
		const h = harness();
		await h.store.set(ALICE, "A", "1");
		h.advance(60_001);
		await h.store.get(ALICE);
		expect(h.kvUrls.length).toBeGreaterThan(0);
		for (const url of h.kvUrls) {
			expect(url.startsWith(`${VAULT}/keys/${KEY_NAME}/`)).toBe(true);
		}
	});
});
