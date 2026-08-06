import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	FileRepositoryRegistry,
	type RegisteredRepository,
	seedRepositoryRegistry,
	toRoutable,
	validateRegisteredRepository,
} from "../src/RepositoryRegistry.js";
import { SetupConflictError } from "../src/TableSecretStore.js";

function freshPath(): string {
	return join(
		mkdtempSync(join(tmpdir(), "cyrus-registry-")),
		"repositories.json",
	);
}

const API: RegisteredRepository = {
	name: "cyrus-api",
	githubSlug: "acme/cyrus-api",
	linearWorkspaceId: "ws-1",
	baseBranch: "main",
	projectKeys: ["Platform"],
	teamKeys: ["NOR"],
	isDefault: true,
};

describe("FileRepositoryRegistry", () => {
	it("reports an empty list when the file does not exist", async () => {
		expect(await new FileRepositoryRegistry(freshPath()).list()).toEqual({
			repositories: [],
			version: "0",
		});
	});

	it("round-trips a written registry", async () => {
		const registry = new FileRepositoryRegistry(freshPath());
		expect(await registry.put([API])).toEqual({ version: "1" });
		expect(await registry.list()).toEqual({
			repositories: [API],
			version: "1",
		});
	});

	it("accepts a conditional write against the current version", async () => {
		const registry = new FileRepositoryRegistry(freshPath());
		const first = await registry.put([API]);
		await expect(
			registry.put([{ ...API, isDefault: false }], first.version),
		).resolves.toEqual({ version: "2" });
	});

	it("rejects a conditional write against a stale version", async () => {
		const registry = new FileRepositoryRegistry(freshPath());
		const stale = await registry.put([API]);
		await registry.put([API], stale.version);
		await expect(registry.put([API], stale.version)).rejects.toBeInstanceOf(
			SetupConflictError,
		);
	});

	it("permits an unconditional write only when nothing is stored yet", async () => {
		const registry = new FileRepositoryRegistry(freshPath());
		await expect(registry.put([API])).resolves.toEqual({ version: "1" });
		await expect(registry.put([API])).rejects.toBeInstanceOf(
			SetupConflictError,
		);
	});

	it("writes atomically at mode 0600", async () => {
		const path = freshPath();
		await new FileRepositoryRegistry(path).put([API]);
		if (process.platform !== "win32") {
			expect(statSync(path).mode & 0o777).toBe(0o600);
		}
		expect(JSON.parse(readFileSync(path, "utf-8")).repositories).toHaveLength(
			1,
		);
	});

	it("treats a corrupt file as empty rather than throwing", async () => {
		const path = freshPath();
		writeFileSync(path, "{ not json");
		expect(await new FileRepositoryRegistry(path).list()).toEqual({
			repositories: [],
			version: "0",
		});
	});

	it("treats a parseable file with a malformed entry as empty rather than throwing", async () => {
		const path = freshPath();
		writeFileSync(
			path,
			JSON.stringify({
				version: "3",
				repositories: [
					{ name: 123, githubSlug: true, linearWorkspaceId: "ws-1" },
				],
			}),
		);
		expect(await new FileRepositoryRegistry(path).list()).toEqual({
			repositories: [],
			version: "0",
		});
	});

	it("treats a non-numeric version as empty rather than pinning at NaN", async () => {
		const path = freshPath();
		writeFileSync(
			path,
			JSON.stringify({ version: "not-a-number", repositories: [API] }),
		);
		const registry = new FileRepositoryRegistry(path);
		expect(await registry.list()).toEqual({
			repositories: [API],
			version: "0",
		});
		expect(await registry.put([API], "0")).toEqual({ version: "1" });
	});

	it("validates every entry before writing anything", async () => {
		const path = freshPath();
		const registry = new FileRepositoryRegistry(path);
		await expect(
			registry.put([API, { ...API, name: "../escape" }]),
		).rejects.toThrow("is not valid");
		expect(await registry.list()).toEqual({ repositories: [], version: "0" });
	});
});

describe("validateRegisteredRepository", () => {
	it("accepts a well-formed entry", () => {
		expect(() => validateRegisteredRepository(API)).not.toThrow();
	});

	it("rejects a name that could escape the repos directory", () => {
		expect(() =>
			validateRegisteredRepository({ ...API, name: "../etc" }),
		).toThrow('Repository name "../etc" is not valid');
	});

	it("rejects an empty name", () => {
		expect(() => validateRegisteredRepository({ ...API, name: "" })).toThrow(
			"Repository name",
		);
	});

	it("rejects a slug that is not owner/repo", () => {
		expect(() =>
			validateRegisteredRepository({ ...API, githubSlug: "acme" }),
		).toThrow('GitHub slug "acme" must be in owner/repo form');
	});

	it("rejects a missing Linear workspace id", () => {
		expect(() =>
			validateRegisteredRepository({ ...API, linearWorkspaceId: "" }),
		).toThrow("Linear workspace id is required");
	});

	it("accepts a base branch with a slash, e.g. release/1.2", () => {
		expect(() =>
			validateRegisteredRepository({ ...API, baseBranch: "release/1.2" }),
		).not.toThrow();
	});

	it("accepts a repository with no base branch at all", () => {
		const { baseBranch: _drop, ...withoutBranch } = API;
		expect(() => validateRegisteredRepository(withoutBranch)).not.toThrow();
	});

	it("rejects a base branch that could reach a shell", () => {
		expect(() =>
			validateRegisteredRepository({ ...API, baseBranch: "$(rm -rf /)" }),
		).toThrow('Base branch "$(rm -rf /)" is not valid');
	});

	it("rejects a base branch containing a backtick", () => {
		expect(() =>
			validateRegisteredRepository({ ...API, baseBranch: "main`whoami`" }),
		).toThrow("Base branch");
	});

	it("rejects a base branch containing a double quote", () => {
		expect(() =>
			validateRegisteredRepository({
				...API,
				baseBranch: 'main" ; rm -rf / #',
			}),
		).toThrow("Base branch");
	});

	it("rejects a base branch starting with a dash (option injection)", () => {
		expect(() =>
			validateRegisteredRepository({
				...API,
				baseBranch: "--upload-pack=evil",
			}),
		).toThrow("Base branch");
	});

	it("rejects a base branch containing ..", () => {
		expect(() =>
			validateRegisteredRepository({ ...API, baseBranch: "foo..bar" }),
		).toThrow("Base branch");
	});

	it("rejects a base branch containing whitespace", () => {
		expect(() =>
			validateRegisteredRepository({ ...API, baseBranch: "main branch" }),
		).toThrow("Base branch");
	});
});

describe("toRoutable", () => {
	it("derives id, name, and a GitHub URL the matcher can suffix-match", () => {
		const routable = toRoutable(API);
		expect(routable.id).toBe("cyrus-api");
		expect(routable.name).toBe("cyrus-api");
		expect(routable.githubUrl).toBe("https://github.com/acme/cyrus-api");
		expect(routable.projectKeys).toEqual(["Platform"]);
		expect(routable.isDefault).toBe(true);
		expect(routable.source).toBe(API);
	});

	it("omits optional routing fields that are absent", () => {
		const routable = toRoutable({
			name: "bare",
			githubSlug: "acme/bare",
			linearWorkspaceId: "ws-1",
		});
		expect(routable.teamKeys).toBeUndefined();
		expect(routable.projectKeys).toBeUndefined();
		expect(routable.routingLabels).toBeUndefined();
		expect(routable.isDefault).toBeUndefined();
	});
});

describe("seedRepositoryRegistry", () => {
	const logger = () => ({ info: vi.fn(), warn: vi.fn() });

	it("writes the configured repositories into an empty registry", async () => {
		const registry = new FileRepositoryRegistry(freshPath());
		const log = logger();
		expect(await seedRepositoryRegistry(registry, [API], log)).toEqual({
			seeded: true,
			count: 1,
		});
		expect((await registry.list()).repositories).toEqual([API]);
		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining("Seeded the repository registry with 1"),
		);
	});

	it("never overwrites a non-empty registry, and says so", async () => {
		const registry = new FileRepositoryRegistry(freshPath());
		await registry.put([{ ...API, name: "already-here" }]);
		const log = logger();

		expect(await seedRepositoryRegistry(registry, [API], log)).toEqual({
			seeded: false,
			count: 1,
		});
		expect((await registry.list()).repositories[0]?.name).toBe("already-here");
		expect(log.info).toHaveBeenCalledWith(
			expect.stringContaining("authoritative"),
		);
	});

	it("is a no-op with no configured repositories and an empty registry", async () => {
		const registry = new FileRepositoryRegistry(freshPath());
		expect(await seedRepositoryRegistry(registry, [], logger())).toEqual({
			seeded: false,
			count: 0,
		});
	});

	it("warns and continues when a configured entry is invalid", async () => {
		const registry = new FileRepositoryRegistry(freshPath());
		const log = logger();
		const result = await seedRepositoryRegistry(
			registry,
			[API, { ...API, name: "../escape" }],
			log,
		);
		expect(result).toEqual({ seeded: false, count: 0 });
		expect(log.warn).toHaveBeenCalledWith(
			expect.stringContaining("is not valid"),
		);
		expect((await registry.list()).repositories).toEqual([]);
	});
});
