import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterStore } from "../src/RouterStore.js";
import { StateBackup } from "../src/StateBackup.js";

describe("StateBackup", () => {
	afterEach(() => vi.useRealTimers());

	function path(): string {
		return join(mkdtempSync(join(tmpdir(), "router-backup-")), "router.db");
	}

	it("treats a 404 restore as a fresh database", async () => {
		const dbPath = path();
		const fetchFn = vi.fn(async () => new Response("missing", { status: 404 }));
		const backup = new StateBackup({
			dbPath,
			blobContainerUrl: "https://account.blob.core.windows.net/backups",
			tokenProvider: async () => "token",
			fetchFn,
		});

		await expect(backup.restoreIfNeeded()).resolves.toBe("fresh");
		expect(existsSync(dbPath)).toBe(false);
		expect(fetchFn.mock.calls[0]?.[0]).toBe(
			"https://account.blob.core.windows.net/backups/router.db",
		);
	});

	it("restores and validates a downloaded SQLite database", async () => {
		const sourcePath = path();
		const source = new RouterStore(sourcePath);
		source.addUser({ email: "restored@example.com" });
		source.close();
		const dbPath = path();
		const backup = new StateBackup({
			dbPath,
			blobContainerUrl: "https://account.blob.core.windows.net/backups",
			tokenProvider: async () => "token",
			fetchFn: async () => new Response(readFileSync(sourcePath)),
		});

		await expect(backup.restoreIfNeeded()).resolves.toBe("restored");
		const restored = new RouterStore(dbPath);
		expect(restored.listUsers()).toEqual([
			expect.objectContaining({ email: "restored@example.com" }),
		]);
		restored.close();
	});

	it.each([
		["failed download", () => new Response("denied", { status: 403 })],
		["corrupt SQLite", () => new Response("not sqlite", { status: 200 })],
	])("makes %s restore fatal", async (_label, response) => {
		const backup = new StateBackup({
			dbPath: path(),
			blobContainerUrl: "https://account.blob.core.windows.net/backups",
			tokenProvider: async () => "token",
			fetchFn: async () => response(),
		});
		await expect(backup.restoreIfNeeded()).rejects.toThrow(/restore/);
	});

	it("uploads an atomic better-sqlite3 snapshot periodically", async () => {
		const dbPath = path();
		const store = new RouterStore(dbPath);
		store.addUser({ email: "periodic@example.com" });
		const fetchFn = vi.fn(async () => new Response(null, { status: 201 }));
		const backup = new StateBackup({
			dbPath,
			blobContainerUrl: "https://account.blob.core.windows.net/backups",
			intervalMs: 10,
			tokenProvider: async () => "token",
			fetchFn,
		});

		backup.start();
		await vi.waitFor(() =>
			expect(fetchFn.mock.calls.length).toBeGreaterThan(0),
		);
		await backup.stop();
		const init = fetchFn.mock.calls[0]?.[1] as RequestInit;
		expect(init.method).toBe("PUT");
		expect(new Headers(init.headers).get("x-ms-blob-type")).toBe("BlockBlob");
		expect((init.body as Buffer).length).toBeGreaterThan(0);
		store.close();
	});

	it("flushes once on shutdown", async () => {
		const dbPath = path();
		const store = new RouterStore(dbPath);
		const fetchFn = vi.fn(async () => new Response(null, { status: 201 }));
		const backup = new StateBackup({
			dbPath,
			blobContainerUrl: "https://account.blob.core.windows.net/backups",
			tokenProvider: async () => "token",
			fetchFn,
		});
		backup.start();
		await backup.stop();
		expect(fetchFn).toHaveBeenCalledTimes(1);
		store.close();
	});

	it("logs runtime failures and resolves so the next tick can retry", async () => {
		const dbPath = path();
		const store = new RouterStore(dbPath);
		const logger = { info: vi.fn(), warn: vi.fn() };
		const fetchFn = vi
			.fn()
			.mockResolvedValueOnce(new Response("no", { status: 500 }))
			.mockResolvedValueOnce(new Response(null, { status: 201 }));
		const backup = new StateBackup({
			dbPath,
			blobContainerUrl: "https://account.blob.core.windows.net/backups",
			tokenProvider: async () => "token",
			fetchFn,
			logger,
		});

		await expect(backup.flush()).resolves.toBeUndefined();
		await expect(backup.flush()).resolves.toBeUndefined();
		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("router state backup failed"),
		);
		store.close();
	});
});
