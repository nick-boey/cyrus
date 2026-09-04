import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EdgeConfig, OperatorConnectionConfig } from "cyrus-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	ConnectionStore,
	type ConnectionStorePersistence,
	normalizeConnectionUrl,
} from "./ConnectionStore.js";
import { EXIT_USAGE, UsageError } from "./errors.js";

const entra: OperatorConnectionConfig = {
	url: "https://router.example.com",
	auth: {
		kind: "entra",
		tenantId: "tenant-1",
		audience: "api://cyrus-router",
	},
};

const local: OperatorConnectionConfig = {
	url: "http://localhost:8787",
	auth: { kind: "local", tokenEnv: "CYRUS_DEV_OPERATOR_TOKEN" },
};

/** In-memory config file, plus a real path so the chmod is exercised. */
function fakePersistence(initial: Partial<EdgeConfig> = {}): {
	persistence: ConnectionStorePersistence;
	current: () => EdgeConfig;
	configPath: string;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "cyrus-connection-store-"));
	const configPath = join(dir, "config.json");
	writeFileSync(configPath, "{}", { mode: 0o644 });
	let config: EdgeConfig = { repositories: [], ...initial } as EdgeConfig;
	return {
		configPath,
		current: () => config,
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
		persistence: {
			load: () => structuredClone(config),
			save: (next) => {
				config = structuredClone(next);
				writeFileSync(configPath, JSON.stringify(config), { mode: 0o644 });
			},
			getConfigPath: () => configPath,
		},
	};
}

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length) cleanups.pop()?.();
});

function newStore(initial: Partial<EdgeConfig> = {}) {
	const harness = fakePersistence(initial);
	cleanups.push(harness.cleanup);
	return { store: new ConnectionStore(harness.persistence), ...harness };
}

describe("ConnectionStore", () => {
	it("persists a connection under operatorConnections", () => {
		const { store, current } = newStore();

		store.add("prod", entra);

		expect(current().operatorConnections).toEqual({ prod: entra });
		expect(store.get("prod")).toEqual(entra);
	});

	it("leaves the rest of config.json untouched", () => {
		// `cyrus connection add` is run on machines that are already enrolled
		// workers; losing their repositories or device token would be far worse
		// than failing to store the connection.
		const { store, current } = newStore({
			repositories: [{ id: "repo-1" } as never],
			platform: "router",
			router: { url: "wss://router.example.com", deviceToken: "dev_secret" },
		});

		store.add("prod", entra);

		expect(current().repositories).toEqual([{ id: "repo-1" }]);
		expect(current().router).toEqual({
			url: "wss://router.example.com",
			deviceToken: "dev_secret",
		});
		expect(current().platform).toBe("router");
	});

	it("never writes to the device-enrollment router block", () => {
		// ADR 0009: a device bearer token keeps its least-privilege scope and is
		// not broadened into an operator credential.
		const { store, current } = newStore();

		store.add("prod", entra);

		expect(current().router).toBeUndefined();
		expect(current().platform).toBeUndefined();
	});

	it("re-tightens config.json to 0600 after writing", () => {
		// The same file holds `router.deviceToken`, and ConfigService.save writes
		// with the process umask.
		const { store, configPath } = newStore();

		store.add("prod", entra);

		expect(statSync(configPath).mode & 0o777).toBe(0o600);
	});

	it("refuses to overwrite an existing name", () => {
		const { store, current } = newStore();
		store.add("prod", entra);

		const error = catchError(() => store.add("prod", local));

		expect(error).toBeInstanceOf(UsageError);
		expect(error.exitCode).toBe(EXIT_USAGE);
		expect(error.message).toContain("prod");
		// The original survives: a silent repoint is how a fleet command ends up
		// reading the wrong environment under the name the operator expected.
		expect(current().operatorConnections?.prod).toEqual(entra);
	});

	it("rejects names that would be unusable as a --connection argument", () => {
		const { store } = newStore();

		for (const name of ["", "-prod", "two words", "a/b", "a;b"]) {
			expect(() => store.add(name, entra)).toThrow(UsageError);
		}
		expect(() => store.add("prod-eu_2.1", entra)).not.toThrow();
	});

	it("lists connections ordered by name", () => {
		const { store } = newStore();
		store.add("zulu", entra);
		store.add("alpha", local);

		expect(store.list().map((record) => record.name)).toEqual([
			"alpha",
			"zulu",
		]);
	});

	it("removes a connection and reports an unknown one", () => {
		const { store, current } = newStore();
		store.add("prod", entra);
		store.add("dev", local);

		store.remove("prod");

		expect(current().operatorConnections).toEqual({ dev: local });
		const error = catchError(() => store.remove("prod"));
		expect(error).toBeInstanceOf(UsageError);
		expect(error.message).toContain("dev");
	});

	describe("select", () => {
		it("uses the single stored connection implicitly", () => {
			const { store } = newStore();
			store.add("prod", entra);

			expect(store.select()).toEqual({ name: "prod", connection: entra });
		});

		it("requires --connection when more than one is stored", () => {
			const { store } = newStore();
			store.add("prod", entra);
			store.add("dev", local);

			const error = catchError(() => store.select());

			expect(error).toBeInstanceOf(UsageError);
			expect(error.exitCode).toBe(EXIT_USAGE);
			expect(error.message).toContain("--connection");
			// Both names are listed, so the remedy is in the error itself.
			expect(error.message).toContain("dev");
			expect(error.message).toContain("prod");
		});

		it("selects by name when one is given", () => {
			const { store } = newStore();
			store.add("prod", entra);
			store.add("dev", local);

			expect(store.select("dev")).toEqual({ name: "dev", connection: local });
		});

		it("reports the known names for an unknown selection", () => {
			const { store } = newStore();
			store.add("prod", entra);

			const error = catchError(() => store.select("staging"));

			expect(error).toBeInstanceOf(UsageError);
			expect(error.message).toContain("staging");
			expect(error.message).toContain("prod");
		});

		it("points at `connection add` when nothing is configured", () => {
			const { store } = newStore();

			const error = catchError(() => store.select());

			expect(error).toBeInstanceOf(UsageError);
			expect(error.message).toContain("cyrus connection add");
		});
	});
});

describe("normalizeConnectionUrl", () => {
	it("accepts http and https origins and strips a trailing slash", () => {
		expect(normalizeConnectionUrl("https://router.example.com/")).toBe(
			"https://router.example.com",
		);
		expect(normalizeConnectionUrl("http://localhost:8787")).toBe(
			"http://localhost:8787",
		);
		expect(normalizeConnectionUrl("  https://router.example.com  ")).toBe(
			"https://router.example.com",
		);
	});

	it("keeps a path prefix, which a router behind a gateway may have", () => {
		expect(normalizeConnectionUrl("https://gw.example.com/cyrus/")).toBe(
			"https://gw.example.com/cyrus",
		);
	});

	it("rejects a WebSocket URL with the specific remedy", () => {
		// `router.url` in config.json IS a wss:// URL, so it is the value an
		// operator is most likely to paste here.
		const error = catchError(() =>
			normalizeConnectionUrl("wss://router.example.com"),
		);

		expect(error).toBeInstanceOf(UsageError);
		expect(error.message).toContain("HTTP origin");
	});

	it("rejects a non-URL, a non-http scheme, and a URL carrying a query", () => {
		for (const bad of [
			"router.example.com",
			"",
			"file:///etc/passwd",
			"https://router.example.com/?token=abc",
			"https://router.example.com/#frag",
		]) {
			expect(() => normalizeConnectionUrl(bad)).toThrow(UsageError);
		}
	});
});

function catchError(fn: () => unknown): any {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error("Expected the call to throw, but it returned.");
}
