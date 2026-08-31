import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CodexTokenStore } from "../src/CodexTokenStore.js";
import { RouterStore } from "../src/RouterStore.js";
import type { CodexCredential } from "../src/setup/codexAuth.js";
import { LocalKeyWrapper } from "../src/setup/localKeyWrapper.js";
import { testLogger } from "./helpers/logger.js";

const NOW = 1_800_000_000_000;

function jwtExpiringAt(ms: number): string {
	const payload = Buffer.from(
		JSON.stringify({ exp: Math.floor(ms / 1000) }),
	).toString("base64url");
	return `h.${payload}.`;
}

function tempKeyPath(): string {
	return join(mkdtempSync(join(tmpdir(), "cyrus-codex-kek-")), "codex-kek.key");
}

function harness(options: { fetchFn?: typeof fetch; dbPath?: string } = {}) {
	const store = new RouterStore(options.dbPath ?? ":memory:");
	const logger = testLogger();
	const tokens = new CodexTokenStore({
		store,
		wrapper: new LocalKeyWrapper(tempKeyPath()),
		logger,
		now: () => NOW,
		...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
	});
	const { userId } = store.addUser({ email: "alice@example.com" });
	return { store, tokens, logger, userId };
}

const LIVE: CodexCredential = {
	refreshToken: "refresh-1",
	accessToken: "access-1",
	accessTokenExpiresMs: NOW + 3_600_000,
	updatedMs: NOW,
};

describe("CodexTokenStore", () => {
	it("round-trips a credential through the seal", async () => {
		const { tokens, userId } = harness();
		await tokens.put(userId, LIVE);
		expect(await tokens.get(userId)).toEqual(LIVE);
	});

	it("never writes the credential to the database in the clear", async () => {
		// `users` is plaintext SQLite and StateBackup PUTs the raw .db to blob
		// storage, so an unsealed column would be a strict confidentiality
		// downgrade from the envelope-encrypted secret bundle.
		const dbPath = join(
			mkdtempSync(join(tmpdir(), "cyrus-codex-db-")),
			"router.db",
		);
		const { store, tokens, userId } = harness({ dbPath });
		await tokens.put(userId, LIVE);
		store.close();

		const raw = readFileSync(dbPath, "utf-8");
		expect(raw).not.toContain("refresh-1");
		expect(raw).not.toContain("access-1");
	});

	it("reports absent for a user who never connected", async () => {
		const { tokens, userId } = harness();
		expect(await tokens.get(userId)).toBeUndefined();
		expect(await tokens.view(userId)).toEqual({ status: "absent" });
	});

	it("clears on disconnect", async () => {
		const { tokens, userId } = harness();
		await tokens.put(userId, LIVE);
		tokens.clear(userId);
		expect(await tokens.get(userId)).toBeUndefined();
	});

	it("refuses to open a record sealed under another user's row", async () => {
		// The AAD binds the ciphertext to the row it lives on, so a blob copied
		// across rows fails to authenticate rather than decrypting into someone
		// else's container.
		const { store, tokens, userId, logger } = harness();
		await tokens.put(userId, LIVE);
		const sealed = store.getUserCodexAuth(userId) as string;
		const { userId: otherId } = store.addUser({ email: "bob@example.com" });
		store.setUserCodexAuth(otherId, sealed);

		expect(await tokens.get(otherId)).toBeUndefined();
		expect(logger.error).toHaveBeenCalled();
	});

	it("reports an unreadable record as absent rather than throwing", async () => {
		// The caller's next step either way is "this user has no usable
		// credential"; throwing would turn a recoverable re-paste into a
		// router-level boot exception.
		const { store, tokens, userId, logger } = harness();
		store.setUserCodexAuth(userId, "{not json");
		expect(await tokens.get(userId)).toBeUndefined();
		expect(logger.error).toHaveBeenCalled();
	});

	describe("mint", () => {
		it("returns the stored credential untouched when it is still live", async () => {
			const fetchFn = vi.fn() as unknown as typeof fetch;
			const { tokens, userId } = harness({ fetchFn });
			await tokens.put(userId, LIVE);

			expect(await tokens.mint(userId)).toEqual(LIVE);
			expect(fetchFn).not.toHaveBeenCalled();
		});

		it("refreshes inside the buffer and persists the rotated token", async () => {
			const fetchFn = vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							access_token: jwtExpiringAt(NOW + 3_600_000),
							refresh_token: "refresh-2",
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			) as unknown as typeof fetch;
			const { tokens, userId } = harness({ fetchFn });
			await tokens.put(userId, {
				...LIVE,
				accessTokenExpiresMs: NOW + 1000,
			});

			const minted = await tokens.mint(userId);
			expect(minted?.refreshToken).toBe("refresh-2");
			// Persisted, not just returned: the old refresh token is dead the
			// moment it is redeemed.
			expect((await tokens.get(userId))?.refreshToken).toBe("refresh-2");
		});

		it("returns undefined — not an error — when nothing is connected", async () => {
			const { tokens, userId } = harness();
			expect(await tokens.mint(userId)).toBeUndefined();
		});

		it("throws and records the reason when the credential is revoked", async () => {
			const fetchFn = vi.fn(
				async () =>
					new Response(JSON.stringify({ error: "invalid_grant" }), {
						status: 400,
						headers: { "content-type": "application/json" },
					}),
			) as unknown as typeof fetch;
			const { tokens, userId } = harness({ fetchFn });
			await tokens.put(userId, { ...LIVE, accessTokenExpiresMs: NOW - 1 });

			await expect(tokens.mint(userId)).rejects.toMatchObject({
				name: "CodexRefreshError",
			});
			// Recorded so /setup can show "needs attention" with the real reason
			// instead of a "connected" that is about to fail a boot.
			expect(await tokens.view(userId)).toMatchObject({
				status: "needs-attention",
			});
		});
	});
});

describe("LocalKeyWrapper", () => {
	it("reuses the key file across instances", async () => {
		const path = tempKeyPath();
		const first = new LocalKeyWrapper(path);
		const second = new LocalKeyWrapper(path);
		const dek = Buffer.alloc(32, 7);

		const { version, wrapped } = await first.wrap(dek);
		expect(await second.unwrap(version, wrapped)).toEqual(dek);
	});

	it("says so plainly when the key file was replaced", async () => {
		const dek = Buffer.alloc(32, 7);
		const { version, wrapped } = await new LocalKeyWrapper(tempKeyPath()).wrap(
			dek,
		);
		const other = new LocalKeyWrapper(tempKeyPath());

		await expect(other.unwrap(version, wrapped)).rejects.toThrow(
			/sealed with a different local key/,
		);
	});
});
