import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	FileRepositoryRegistry,
	type RegisteredRepository,
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
