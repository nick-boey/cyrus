import { describe, expect, it, vi } from "vitest";
import type { RegisteredRepository } from "../src/RepositoryRegistry.js";
import {
	REGISTRY_PARTITION_KEY,
	REGISTRY_ROW_KEY,
	TableRepositoryRegistry,
} from "../src/TableRepositoryRegistry.js";
import { SetupConflictError } from "../src/TableSecretStore.js";

const API: RegisteredRepository = {
	name: "cyrus-api",
	githubSlug: "acme/cyrus-api",
	linearWorkspaceId: "ws-1",
	projectKeys: ["Platform"],
	isDefault: true,
};

function reply(status: number, body: unknown, etag?: string): Response {
	return new Response(status === 204 ? null : JSON.stringify(body), {
		status,
		headers: etag ? { etag } : {},
	});
}

function registry(fetchFn: typeof fetch) {
	return new TableRepositoryRegistry({
		tableEndpoint: "https://stexample.table.core.windows.net",
		tableName: "cyrussetup",
		fetchFn,
		tokenProvider: async () => "token",
		sleep: async () => {},
		newCorrelationId: () => "corr-1",
		now: () => 0,
		logger: { warn: vi.fn() },
	});
}

describe("TableRepositoryRegistry", () => {
	it("uses a partition key that cannot collide with a user record", () => {
		expect(REGISTRY_PARTITION_KEY).toBe(`g${"0".repeat(64)}`);
		expect(REGISTRY_PARTITION_KEY.startsWith("u")).toBe(false);
		expect(REGISTRY_ROW_KEY).toBe("repositories");
	});

	it("reports an empty registry when the entity does not exist", async () => {
		const fetchFn = vi.fn(async () =>
			reply(404, { "odata.error": { code: "ResourceNotFound" } }),
		) as unknown as typeof fetch;
		expect(await registry(fetchFn).list()).toEqual({ repositories: [] });
	});

	it("reads plaintext JSON and returns the ETag as the version", async () => {
		const fetchFn = vi.fn(async () =>
			reply(200, { ReposJson: JSON.stringify([API]) }, 'W/"v1"'),
		) as unknown as typeof fetch;
		expect(await registry(fetchFn).list()).toEqual({
			repositories: [API],
			version: 'W/"v1"',
		});
	});

	it("stores plaintext, never an encrypted envelope", async () => {
		const bodies: string[] = [];
		const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
			bodies.push(String(init.body));
			return reply(204, null, 'W/"v1"');
		}) as unknown as typeof fetch;

		await registry(fetchFn).put([API]);

		const body = JSON.parse(bodies[0] as string);
		expect(body.PartitionKey).toBe(REGISTRY_PARTITION_KEY);
		expect(body.RowKey).toBe(REGISTRY_ROW_KEY);
		expect(JSON.parse(body.ReposJson)).toEqual([API]);
		expect(body).not.toHaveProperty("Ciphertext");
		expect(body).not.toHaveProperty("WrappedDek");
	});

	it("POSTs an insert with no If-Match when no version is supplied", async () => {
		const seen: Array<{ method: string; headers: Record<string, string> }> = [];
		const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
			seen.push({
				method: String(init.method),
				headers: init.headers as Record<string, string>,
			});
			return reply(204, null, 'W/"v1"');
		}) as unknown as typeof fetch;

		await registry(fetchFn).put([API]);
		expect(seen[0]?.method).toBe("POST");
		expect(seen[0]?.headers["if-match"]).toBeUndefined();
	});

	it("PUTs with If-Match when a version is supplied, and never If-Match:*", async () => {
		const seen: Array<{ method: string; headers: Record<string, string> }> = [];
		const fetchFn = vi.fn(async (_url: string, init: RequestInit) => {
			seen.push({
				method: String(init.method),
				headers: init.headers as Record<string, string>,
			});
			return reply(204, null, 'W/"v3"');
		}) as unknown as typeof fetch;

		expect(await registry(fetchFn).put([API], 'W/"v2"')).toEqual({
			version: 'W/"v3"',
		});
		expect(seen[0]?.method).toBe("PUT");
		expect(seen[0]?.headers["if-match"]).toBe('W/"v2"');
	});

	it("raises SetupConflictError on 412", async () => {
		const fetchFn = vi.fn(async () =>
			reply(412, { "odata.error": { code: "UpdateConditionNotSatisfied" } }),
		) as unknown as typeof fetch;
		await expect(
			registry(fetchFn).put([API], 'W/"stale"'),
		).rejects.toBeInstanceOf(SetupConflictError);
	});

	it("raises SetupConflictError on a 409 insert race", async () => {
		const fetchFn = vi.fn(async () =>
			reply(409, { "odata.error": { code: "EntityAlreadyExists" } }),
		) as unknown as typeof fetch;
		await expect(registry(fetchFn).put([API])).rejects.toBeInstanceOf(
			SetupConflictError,
		);
	});

	it("refuses to write with If-Match: * or an empty string, before any request", async () => {
		const fetchFn = vi.fn(async () =>
			reply(204, null, 'W/"v1"'),
		) as unknown as typeof fetch;
		const reg = registry(fetchFn);

		await expect(reg.put([API], "*")).rejects.toThrow(
			"Refusing to write with If-Match",
		);
		await expect(reg.put([API], "")).rejects.toThrow(
			"Refusing to write with If-Match",
		);
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("refuses an invalid repository before making any request", async () => {
		const fetchFn = vi.fn(async () =>
			reply(204, null),
		) as unknown as typeof fetch;
		await expect(
			registry(fetchFn).put([{ ...API, name: "../escape" }]),
		).rejects.toThrow("is not valid");
		expect(fetchFn).not.toHaveBeenCalled();
	});

	it("treats an unreadable stored payload as empty rather than throwing", async () => {
		const fetchFn = vi.fn(async () =>
			reply(200, { ReposJson: "{ not json" }, 'W/"v1"'),
		) as unknown as typeof fetch;
		expect(await registry(fetchFn).list()).toEqual({
			repositories: [],
			version: 'W/"v1"',
		});
	});

	it("treats a well-formed JSON array with a malformed entry as empty rather than throwing", async () => {
		const fetchFn = vi.fn(async () =>
			reply(
				200,
				{
					ReposJson: JSON.stringify([
						{ name: 123, githubSlug: true, linearWorkspaceId: "ws-1" },
					]),
				},
				'W/"v1"',
			),
		) as unknown as typeof fetch;
		expect(await registry(fetchFn).list()).toEqual({
			repositories: [],
			version: 'W/"v1"',
		});
	});

	it("permits an unconditional write only when nothing is stored yet", async () => {
		let call = 0;
		const fetchFn = vi.fn(async () => {
			call++;
			if (call === 1) return reply(204, null, 'W/"v1"');
			return reply(409, { "odata.error": { code: "EntityAlreadyExists" } });
		}) as unknown as typeof fetch;
		const reg = registry(fetchFn);

		await expect(reg.put([API])).resolves.toEqual({ version: 'W/"v1"' });
		await expect(reg.put([API])).rejects.toBeInstanceOf(SetupConflictError);
	});
});
