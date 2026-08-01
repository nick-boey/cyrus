import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RouterStore } from "../src/RouterStore.js";
import {
	FileSecretStore,
	type SecretStoreBackend,
	type UserSecretBundle,
} from "../src/SecretStore.js";
import {
	INHERIT_DEFAULT_EXECUTOR_JSON,
	resolveExecutor,
	SetupBootstrap,
} from "../src/setup/bootstrap.js";
import { SetupAuthError } from "../src/setup/principal.js";
import { SetupConflictError } from "../src/TableSecretStore.js";

const REQUIRED = ["CLAUDE_CODE_OAUTH_TOKEN", "GIT_TOKEN"] as const;

function tempSecretsFile(): string {
	return join(
		mkdtempSync(join(tmpdir(), "cyrus-bootstrap-")),
		"user-secrets.json",
	);
}

function harness(
	options: {
		autoProvisionUsers?: boolean;
		secrets?: SecretStoreBackend;
		store?: RouterStore;
	} = {},
) {
	const store = options.store ?? new RouterStore(":memory:");
	const secrets = options.secrets ?? new FileSecretStore(tempSecretsFile());
	const logger = { info: vi.fn(), warn: vi.fn() };
	const bootstrap = new SetupBootstrap({
		store,
		secrets,
		requiredKeys: REQUIRED,
		autoProvisionUsers: options.autoProvisionUsers ?? true,
		logger,
	});
	return { store, secrets, bootstrap, logger };
}

/**
 * Stands in for the `users.entra_object_id` column NOR-274 needs and this
 * change adds. `SetupBootstrap` feature-detects the accessor pair, so this
 * exercises the "column present" branch while the real `RouterStore` patch is
 * applied separately.
 */
function withEntraObjectIds(store: RouterStore) {
	const oids = new Map<number, string>();
	return Object.assign(store, {
		getUserEntraObjectId: (userId: number): string | undefined =>
			oids.get(userId),
		setUserEntraObjectId: (userId: number, objectId: string): boolean => {
			oids.set(userId, objectId);
			return true;
		},
	});
}

/**
 * A backend that owns the whole-record API. `supportsRecords` is what
 * `SetupBootstrap` feature-detects on, so it can be flipped off independently
 * of `ensureRecord` existing — which is what proves the detection is a
 * declaration and not just a `typeof … === "function"` check.
 */
class FakeRecordBackend implements SecretStoreBackend {
	bundle: UserSecretBundle = {};
	ensureRecordCalls: Array<{ email: string; keys: readonly string[] }> = [];
	setCalls: Array<{ key: string; value: string | undefined }> = [];

	constructor(
		private readonly opts: {
			supportsRecords: boolean;
			conflict?: boolean;
		},
	) {}

	supportsRecords(): boolean {
		return this.opts.supportsRecords;
	}

	async ensureRecord(
		email: string,
		requiredKeys: readonly string[],
	): Promise<{ created: boolean }> {
		this.ensureRecordCalls.push({ email, keys: [...requiredKeys] });
		if (this.opts.conflict) {
			throw new SetupConflictError("another writer created this record first");
		}
		let created = false;
		for (const key of requiredKeys) {
			if (!Object.hasOwn(this.bundle, key)) {
				this.bundle[key] = "";
				created = true;
			}
		}
		return { created };
	}

	async get(): Promise<UserSecretBundle> {
		return { ...this.bundle };
	}

	async set(
		_email: string,
		key: string,
		value: string | undefined,
	): Promise<void> {
		this.setCalls.push({ key, value });
		if (value === undefined) delete this.bundle[key];
		else this.bundle[key] = value;
	}

	async isFullyAuthenticated(
		_email: string,
		requiredKeys: readonly string[],
	): Promise<{ ok: boolean; missing: string[] }> {
		const missing = requiredKeys.filter((key) => !this.bundle[key]);
		return { ok: missing.length === 0, missing };
	}
}

describe("SetupBootstrap.ensure", () => {
	it("creates the user row and the empty required keys on first sign-in", async () => {
		const { store, secrets, bootstrap } = harness();

		const result = await bootstrap.ensure({
			email: "alice@example.com",
			name: "Alice Example",
		});

		expect(result).toEqual({
			userId: expect.any(Number),
			createdUser: true,
			createdRecord: true,
		});
		expect(store.listUsers()).toEqual([
			expect.objectContaining({
				userId: result.userId,
				email: "alice@example.com",
				name: "Alice Example",
			}),
		]);
		expect(await secrets.get("alice@example.com")).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "",
			GIT_TOKEN: "",
		});
	});

	it("gives a newly provisioned user the inherit-default sentinel, not NULL", async () => {
		const { store, bootstrap } = harness();

		const { userId } = await bootstrap.ensure({ email: "alice@example.com" });

		// NULL would mean "physical device" forever (F11); only the explicit
		// sentinel picks up `containers.defaultExecutor`.
		expect(store.getUserExecutor(userId)).toBe(INHERIT_DEFAULT_EXECUTOR_JSON);
		expect(resolveExecutor(store.getUserExecutor(userId), "aca")).toBe("aca");
	});

	it("leaves an existing user's NULL executor alone", async () => {
		const { store, bootstrap } = harness();
		const { userId } = store.addUser({ email: "alice@example.com" });

		await bootstrap.ensure({ email: "alice@example.com" });

		// Retro-fitting the sentinel onto existing NULL rows would silently move
		// every deliberately-device user onto cloud sandboxes.
		expect(store.getUserExecutor(userId)).toBeUndefined();
		expect(
			resolveExecutor(store.getUserExecutor(userId), "aca"),
		).toBeUndefined();
	});

	it("leaves an existing user's explicit device pin alone", async () => {
		const { store, bootstrap } = harness();
		const { userId } = store.addUser({ email: "alice@example.com" });
		store.setUserExecutor("alice@example.com", '{"type":"device"}');

		await bootstrap.ensure({ email: "alice@example.com" });

		expect(store.getUserExecutor(userId)).toBe('{"type":"device"}');
	});

	it("is idempotent — a second sign-in creates nothing", async () => {
		const { store, bootstrap } = harness();

		const first = await bootstrap.ensure({ email: "alice@example.com" });
		const second = await bootstrap.ensure({ email: "alice@example.com" });

		expect(second).toEqual({
			userId: first.userId,
			createdUser: false,
			createdRecord: false,
		});
		expect(store.listUsers()).toHaveLength(1);
	});

	it("never overwrites a stored value", async () => {
		const { secrets, bootstrap } = harness();
		await secrets.set("alice@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "real");

		await bootstrap.ensure({ email: "alice@example.com" });

		expect(await secrets.get("alice@example.com")).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "real",
			GIT_TOKEN: "",
		});
	});

	it("backfills a newly-required key for an existing user", async () => {
		const { store, secrets, bootstrap } = harness();
		store.addUser({ email: "alice@example.com" });
		await secrets.set("alice@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "real");

		const result = await bootstrap.ensure({ email: "alice@example.com" });

		expect(result).toEqual({
			userId: expect.any(Number),
			createdUser: false,
			createdRecord: true,
		});
		expect(await secrets.get("alice@example.com")).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "real",
			GIT_TOKEN: "",
		});
	});

	it("matches an existing user case-insensitively instead of duplicating", async () => {
		const { store, bootstrap } = harness();
		const { userId } = store.addUser({ email: "Alice@Example.com" });

		const result = await bootstrap.ensure({ email: "ALICE@example.COM" });

		expect(result.userId).toBe(userId);
		expect(result.createdUser).toBe(false);
		expect(store.listUsers()).toHaveLength(1);
	});

	it("does not create a device row", async () => {
		const { store, bootstrap } = harness();

		await bootstrap.ensure({ email: "alice@example.com" });

		expect(store.listDevices()).toHaveLength(0);
	});

	it("logs provisioning once, at info", async () => {
		const { bootstrap, logger } = harness();

		await bootstrap.ensure({ email: "alice@example.com" });
		await bootstrap.ensure({ email: "alice@example.com" });

		expect(logger.info).toHaveBeenCalledTimes(1);
		expect(logger.info.mock.calls[0]?.[0]).toContain("alice@example.com");
	});

	it("survives a concurrent first sign-in from two tabs", async () => {
		const { store, bootstrap } = harness();

		const [a, b] = await Promise.all([
			bootstrap.ensure({ email: "alice@example.com" }),
			bootstrap.ensure({ email: "alice@example.com" }),
		]);

		expect(a?.userId).toBe(b?.userId);
		expect(store.listUsers()).toHaveLength(1);
	});

	it("recovers when the row appears between the lookup and the insert", async () => {
		const store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "alice@example.com" });
		// Force the genuine loser-of-the-race path: the lookup reports "no such
		// user" once, so `addUser` runs and trips `users.email UNIQUE COLLATE
		// NOCASE`. A raw SQLITE_CONSTRAINT must never reach a teammate whose
		// only mistake was double-clicking.
		const real = store.listUsers.bind(store);
		let calls = 0;
		store.listUsers = (() => (calls++ === 0 ? [] : real())) as typeof real;
		const { bootstrap } = harness({ store });

		const result = await bootstrap.ensure({ email: "alice@example.com" });

		expect(result.userId).toBe(userId);
		expect(result.createdUser).toBe(false);
		expect(calls).toBeGreaterThan(1);
	});

	it("rethrows a store failure that is not a lost create race", async () => {
		const store = new RouterStore(":memory:");
		store.addUser = () => {
			throw new Error("database is locked");
		};
		const { bootstrap } = harness({ store });

		await expect(
			bootstrap.ensure({ email: "alice@example.com" }),
		).rejects.toThrow("database is locked");
	});

	it("rejects a principal with a blank email before writing anything", async () => {
		const { bootstrap, store } = harness();

		await expect(bootstrap.ensure({ email: "   " })).rejects.toMatchObject({
			status: 401,
		});
		expect(store.listUsers()).toHaveLength(0);
	});
});

describe("SetupBootstrap.ensure — auto-provisioning gate", () => {
	it("throws 403 for an unknown user when auto-provisioning is off", async () => {
		const { bootstrap, store, secrets } = harness({
			autoProvisionUsers: false,
		});

		const error = await bootstrap
			.ensure({ email: "stranger@example.com" })
			.then(
				() => undefined,
				(caught: unknown) => caught,
			);

		expect(error).toBeInstanceOf(SetupAuthError);
		expect((error as SetupAuthError).status).toBe(403);
		expect((error as Error).message).toContain(
			"cyrus router users add stranger@example.com",
		);
		expect(store.listUsers()).toHaveLength(0);
		expect(await secrets.get("stranger@example.com")).toEqual({});
	});

	it("still ensures the record for a known user when auto-provisioning is off", async () => {
		const { bootstrap, store, secrets } = harness({
			autoProvisionUsers: false,
		});
		store.addUser({ email: "alice@example.com" });

		const result = await bootstrap.ensure({ email: "alice@example.com" });

		expect(result.createdUser).toBe(false);
		expect(result.createdRecord).toBe(true);
		expect(await secrets.get("alice@example.com")).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "",
			GIT_TOKEN: "",
		});
	});

	it("provisions an unknown user when auto-provisioning is on", async () => {
		const { bootstrap, store } = harness({ autoProvisionUsers: true });

		const result = await bootstrap.ensure({ email: "stranger@example.com" });

		expect(result.createdUser).toBe(true);
		expect(store.listUsers()).toHaveLength(1);
	});
});

describe("SetupBootstrap.ensure — Entra object id (interim NOR-274 mitigation)", () => {
	it("persists the oid for a newly provisioned user", async () => {
		const store = withEntraObjectIds(new RouterStore(":memory:"));
		const { bootstrap, logger } = harness({ store });

		const { userId } = await bootstrap.ensure({
			email: "alice@example.com",
			objectId: "oid-1",
		});

		expect(store.getUserEntraObjectId(userId)).toBe("oid-1");
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("backfills the oid for a known user that has none stored", async () => {
		const store = withEntraObjectIds(new RouterStore(":memory:"));
		const { userId } = store.addUser({ email: "alice@example.com" });
		const { bootstrap, logger } = harness({ store });

		await bootstrap.ensure({ email: "alice@example.com", objectId: "oid-1" });

		expect(store.getUserEntraObjectId(userId)).toBe("oid-1");
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("refuses a known email presenting a different oid (R2-07)", async () => {
		// A UPN rename changes the EMAIL and keeps the oid, producing a new user
		// row rather than a mismatch. The only thing that lands here is the same
		// address resolving to a different Entra object — an address reused for
		// a different person — where proceeding would hand them the previous
		// holder's stored secrets.
		const store = withEntraObjectIds(new RouterStore(":memory:"));
		const { bootstrap, logger } = harness({ store });
		const { userId } = await bootstrap.ensure({
			email: "alice@example.com",
			objectId: "oid-1",
		});

		await expect(
			bootstrap.ensure({ email: "alice@example.com", objectId: "oid-2" }),
		).rejects.toMatchObject({ status: 403 });

		const message = String(logger.warn.mock.calls[0]?.[0]);
		expect(message).toContain("alice@example.com");
		expect(message).toContain("oid-1");
		expect(message).toContain("oid-2");
		// The first-seen binding is never overwritten, so the block persists
		// until an operator rebinds rather than curing itself on the next visit.
		expect(store.getUserEntraObjectId(userId)).toBe("oid-1");
	});

	it("does not leak the stored oid to the refused caller", async () => {
		const store = withEntraObjectIds(new RouterStore(":memory:"));
		const { bootstrap } = harness({ store });
		await bootstrap.ensure({ email: "alice@example.com", objectId: "oid-1" });

		await expect(
			bootstrap.ensure({ email: "alice@example.com", objectId: "oid-2" }),
		).rejects.toSatisfy(
			(error: Error) =>
				!error.message.includes("oid-1") && !error.message.includes("oid-2"),
		);
	});

	it("does not warn when the same oid signs in again", async () => {
		const store = withEntraObjectIds(new RouterStore(":memory:"));
		const { bootstrap, logger } = harness({ store });

		await bootstrap.ensure({ email: "alice@example.com", objectId: "oid-1" });
		await bootstrap.ensure({ email: "alice@example.com", objectId: "oid-1" });

		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("is a no-op on a store without the oid accessors", async () => {
		const { bootstrap, store, logger } = harness();

		const result = await bootstrap.ensure({
			email: "alice@example.com",
			objectId: "oid-1",
		});

		expect(result.createdUser).toBe(true);
		expect(store.listUsers()).toHaveLength(1);
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("does not touch the oid accessors when the principal carries no oid", async () => {
		const store = withEntraObjectIds(new RouterStore(":memory:"));
		const read = vi.spyOn(store, "getUserEntraObjectId");
		const write = vi.spyOn(store, "setUserEntraObjectId");
		const { bootstrap } = harness({ store });

		await bootstrap.ensure({ email: "alice@example.com" });

		expect(read).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});
});

describe("SetupBootstrap.ensure — record API feature detection", () => {
	it("uses the whole-record API when the backend declares support", async () => {
		const secrets = new FakeRecordBackend({ supportsRecords: true });
		const { bootstrap } = harness({ secrets });

		const result = await bootstrap.ensure({ email: "alice@example.com" });

		expect(result.createdRecord).toBe(true);
		expect(secrets.ensureRecordCalls).toEqual([
			{ email: "alice@example.com", keys: [...REQUIRED] },
		]);
		// One conditional write, not one per key.
		expect(secrets.setCalls).toEqual([]);
	});

	it("falls back to per-key writes when the backend declines record support", async () => {
		const secrets = new FakeRecordBackend({ supportsRecords: false });
		const { bootstrap } = harness({ secrets });

		const result = await bootstrap.ensure({ email: "alice@example.com" });

		expect(result.createdRecord).toBe(true);
		expect(secrets.ensureRecordCalls).toEqual([]);
		expect(secrets.setCalls).toEqual([
			{ key: "CLAUDE_CODE_OAUTH_TOKEN", value: "" },
			{ key: "GIT_TOKEN", value: "" },
		]);
	});

	it("writes only the genuinely absent keys on the fallback path", async () => {
		const secrets = new FakeRecordBackend({ supportsRecords: false });
		secrets.bundle = { CLAUDE_CODE_OAUTH_TOKEN: "real" };
		const { bootstrap } = harness({ secrets });

		await bootstrap.ensure({ email: "alice@example.com" });

		expect(secrets.setCalls).toEqual([{ key: "GIT_TOKEN", value: "" }]);
		expect(secrets.bundle).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "real",
			GIT_TOKEN: "",
		});
	});

	it("uses the file backend's per-key path — it has no record API", async () => {
		// FileSecretStore and KeyVaultSecretStore have no `ensureRecord`; local
		// dev must keep working rather than crashing on a missing method.
		const { bootstrap, secrets } = harness();

		await expect(
			bootstrap.ensure({ email: "alice@example.com" }),
		).resolves.toMatchObject({ createdRecord: true });
		expect(await secrets.get("alice@example.com")).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "",
			GIT_TOKEN: "",
		});
	});

	it("treats a concurrent create conflict as success", async () => {
		const secrets = new FakeRecordBackend({
			supportsRecords: true,
			conflict: true,
		});
		// The winner of the race already wrote a complete record.
		secrets.bundle = { CLAUDE_CODE_OAUTH_TOKEN: "", GIT_TOKEN: "" };
		const { bootstrap, logger } = harness({ secrets });

		const result = await bootstrap.ensure({ email: "alice@example.com" });

		expect(result).toEqual({
			userId: expect.any(Number),
			createdUser: true,
			createdRecord: false,
		});
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(String(logger.warn.mock.calls[0]?.[0])).toContain(
			"alice@example.com",
		);
	});

	it("rethrows the conflict when the surviving record is still incomplete", async () => {
		const secrets = new FakeRecordBackend({
			supportsRecords: true,
			conflict: true,
		});
		secrets.bundle = { CLAUDE_CODE_OAUTH_TOKEN: "" };
		const { bootstrap } = harness({ secrets });

		await expect(
			bootstrap.ensure({ email: "alice@example.com" }),
		).rejects.toBeInstanceOf(SetupConflictError);
	});

	it("propagates a non-conflict record failure", async () => {
		const secrets = new FakeRecordBackend({ supportsRecords: true });
		// A complete bundle on purpose: only a SetupConflictError may be resolved
		// against the stored record. If any failure were funnelled through that
		// path, a transient 503 would be laundered into "record is fine".
		secrets.bundle = { CLAUDE_CODE_OAUTH_TOKEN: "", GIT_TOKEN: "" };
		secrets.ensureRecord = async () => {
			throw new Error("Azure Table GET failed (503)");
		};
		const { bootstrap } = harness({ secrets });

		await expect(
			bootstrap.ensure({ email: "alice@example.com" }),
		).rejects.toThrow("Azure Table GET failed (503)");
	});
});

describe("resolveExecutor", () => {
	function logger() {
		return { warn: vi.fn() };
	}

	it("never inherits the default for NULL — NULL means physical device", () => {
		const log = logger();
		expect(resolveExecutor(null, "aca", log)).toBeUndefined();
		expect(resolveExecutor(undefined, "aca", log)).toBeUndefined();
		expect(resolveExecutor("", "aca", log)).toBeUndefined();
		expect(resolveExecutor("   ", "aca", log)).toBeUndefined();
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("maps the explicit device sentinel to physical device", () => {
		const log = logger();
		expect(resolveExecutor('{"type":"device"}', "aca", log)).toBeUndefined();
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("inherits the router default only for the explicit default sentinel", () => {
		const log = logger();
		expect(resolveExecutor(INHERIT_DEFAULT_EXECUTOR_JSON, "aca", log)).toBe(
			"aca",
		);
		expect(resolveExecutor('{"type":"default"}', "docker", log)).toBe("docker");
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("resolves the sentinel to physical device when no default is configured", () => {
		const log = logger();
		expect(
			resolveExecutor(INHERIT_DEFAULT_EXECUTOR_JSON, undefined, log),
		).toBeUndefined();
		expect(
			resolveExecutor(INHERIT_DEFAULT_EXECUTOR_JSON, "", log),
		).toBeUndefined();
	});

	it("returns a concrete executor type verbatim, over the default", () => {
		const log = logger();
		expect(resolveExecutor('{"type":"aca"}', undefined, log)).toBe("aca");
		expect(resolveExecutor('{"type":"docker"}', "aca", log)).toBe("docker");
		// An unregistered provider name is still returned; whether an executor
		// exists for it is the caller's check, not this function's.
		expect(resolveExecutor('{"type":"kubernetes"}', "aca", log)).toBe(
			"kubernetes",
		);
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("degrades corrupt JSON to physical device, never to the default", () => {
		const log = logger();
		// Upgrading an unreadable setting into "boot a cloud sandbox" is the
		// wrong way to fail.
		expect(resolveExecutor("{ not json", "aca", log)).toBeUndefined();
		expect(log.warn).toHaveBeenCalledTimes(1);
	});

	it("degrades a non-object payload to physical device with a warning", () => {
		for (const json of ["null", "123", '"aca"', "[]", '["aca"]']) {
			const log = logger();
			expect(resolveExecutor(json, "aca", log)).toBeUndefined();
			expect(log.warn).toHaveBeenCalledTimes(1);
		}
	});

	it("degrades a missing or non-string type to physical device with a warning", () => {
		for (const json of ["{}", '{"type":""}', '{"type":123}', '{"type":null}']) {
			const log = logger();
			expect(resolveExecutor(json, "aca", log)).toBeUndefined();
			expect(log.warn).toHaveBeenCalledTimes(1);
		}
	});

	it("refuses a defaultExecutor that is itself a sentinel", () => {
		for (const bad of ["device", "default"]) {
			const log = logger();
			expect(
				resolveExecutor(INHERIT_DEFAULT_EXECUTOR_JSON, bad, log),
			).toBeUndefined();
			expect(log.warn).toHaveBeenCalledTimes(1);
		}
	});

	it("works without a logger", () => {
		expect(resolveExecutor("{ not json", "aca")).toBeUndefined();
		expect(resolveExecutor('{"type":"default"}', "aca")).toBe("aca");
	});

	it("covers every row of the F11 resolution table", () => {
		const table: Array<
			[string | null, string | undefined, string | undefined]
		> = [
			[null, "aca", undefined],
			['{"type":"device"}', "aca", undefined],
			['{"type":"default"}', "aca", "aca"],
			['{"type":"aca"}', undefined, "aca"],
			["{ not json", "aca", undefined],
		];
		for (const [stored, fallback, expected] of table) {
			expect(resolveExecutor(stored, fallback, { warn: () => {} })).toBe(
				expected,
			);
		}
	});
});
