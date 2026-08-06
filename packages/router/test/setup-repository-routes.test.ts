import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	RegisteredRepository,
	RegistrySnapshot,
	RepositoryRegistry,
} from "../src/RepositoryRegistry.js";
import { RouterStore } from "../src/RouterStore.js";
import { SetupBootstrap } from "../src/setup/bootstrap.js";
import { createCsrfTokens } from "../src/setup/csrf.js";
import type { SetupAuthConfig } from "../src/setup/principal.js";
import {
	applyRepositoryEdits,
	registerRepositoryRoutes,
} from "../src/setup/repositoryRoutes.js";
import { SetupConflictError } from "../src/TableSecretStore.js";

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const FORM = "application/x-www-form-urlencoded";
const DEV_AUTH: SetupAuthConfig = { auth: { mode: "dev-insecure-headers" } };

const API: RegisteredRepository = {
	name: "cyrus-api",
	githubSlug: "acme/cyrus-api",
	linearWorkspaceId: "ws-1",
	baseBranch: "main",
	projectKeys: ["Platform"],
	isDefault: true,
};

/** In-memory registry with real optimistic concurrency. */
function fakeRegistry(initial: RegisteredRepository[] = []) {
	let repositories = [...initial];
	let version = initial.length > 0 ? 1 : 0;
	const registry: RepositoryRegistry & {
		current: () => RegisteredRepository[];
	} = {
		current: () => repositories,
		list: async () => ({
			repositories: [...repositories],
			version: String(version),
		}),
		put: async (next, ifMatch) => {
			if (ifMatch !== undefined && ifMatch !== String(version)) {
				throw new SetupConflictError();
			}
			repositories = [...next];
			version += 1;
			return { version: String(version) };
		},
	};
	return registry;
}

const openApps: FastifyInstance[] = [];

function build(registry: RepositoryRegistry, registered = [ALICE]) {
	const store = new RouterStore(":memory:");
	for (const email of registered) store.addUser({ email });
	const fastify = Fastify();
	const csrf = createCsrfTokens("test-secret");
	registerRepositoryRoutes(fastify, {
		registry,
		workspaceIds: ["ws-1"],
		auth: DEV_AUTH,
		bootstrap: new SetupBootstrap({
			store,
			secrets: { get: async () => ({}), set: async () => {} } as never,
			requiredKeys: [],
			autoProvisionUsers: false,
			logger: { info: vi.fn(), warn: vi.fn() },
		}),
		csrf,
		logger: { info: vi.fn(), warn: vi.fn() },
	});
	openApps.push(fastify);
	return { fastify, store, csrf };
}

/**
 * A registry double that mirrors `TableRepositoryRegistry.list()`'s real
 * behaviour on an empty/never-written registry: `version` is genuinely
 * `undefined` (no `version` key at all), not `fakeRegistry`'s always-defined
 * `"0"`. This is what the "empty registry permanently 409s" regression needs
 * — `fakeRegistry` can never reproduce it because it always returns a version.
 */
function neverWrittenRegistry(): RepositoryRegistry & {
	current: () => RegisteredRepository[];
} {
	let repositories: RegisteredRepository[] = [];
	let version: string | undefined;
	return {
		current: () => repositories,
		list: async (): Promise<RegistrySnapshot> => ({
			repositories: [...repositories],
			...(version !== undefined ? { version } : {}),
		}),
		put: async (next, ifMatch) => {
			if (ifMatch !== version) throw new SetupConflictError();
			repositories = [...next];
			version = 'W/"v1"';
			return { version };
		},
	};
}

afterEach(async () => {
	await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function csrfFrom(fastify: FastifyInstance): Promise<string> {
	const page = await fastify.inject({
		method: "GET",
		url: "/setup/repositories",
		headers: { "x-ms-client-principal-name": ALICE },
	});
	return /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] as string;
}

async function versionFrom(fastify: FastifyInstance): Promise<string> {
	const page = await fastify.inject({
		method: "GET",
		url: "/setup/repositories",
		headers: { "x-ms-client-principal-name": ALICE },
	});
	return /name="version" value="([^"]+)"/.exec(page.body)?.[1] as string;
}

describe("GET /setup/repositories", () => {
	it("renders the registry for a registered user", async () => {
		const { fastify } = build(fakeRegistry([API]));
		const response = await fastify.inject({
			method: "GET",
			url: "/setup/repositories",
			headers: { "x-ms-client-principal-name": ALICE },
		});
		expect(response.statusCode).toBe(200);
		expect(response.body).toContain("cyrus-api");
		expect(response.body).toContain('value="p=Platform"');
	});

	it("refuses an unregistered principal with 403", async () => {
		const { fastify } = build(fakeRegistry([API]));
		const response = await fastify.inject({
			method: "GET",
			url: "/setup/repositories",
			headers: { "x-ms-client-principal-name": BOB },
		});
		expect(response.statusCode).toBe(403);
		expect(response.body).not.toContain("cyrus-api");
	});

	it("refuses an unauthenticated request with 401", async () => {
		const { fastify } = build(fakeRegistry([API]));
		expect(
			(await fastify.inject({ method: "GET", url: "/setup/repositories" }))
				.statusCode,
		).toBe(401);
	});
});

describe("POST /setup/repositories", () => {
	it("adds a repository", async () => {
		const registry = fakeRegistry();
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);

		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories",
			headers: { "x-ms-client-principal-name": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				name: "cyrus-web",
				githubSlug: "acme/cyrus-web",
				baseBranch: "main",
				associations: "t=WEB",
				linearWorkspaceId: "ws-1",
			}).toString(),
		});

		expect(response.statusCode).toBe(200);
		expect(registry.current()).toEqual([
			{
				name: "cyrus-web",
				githubSlug: "acme/cyrus-web",
				linearWorkspaceId: "ws-1",
				baseBranch: "main",
				teamKeys: ["WEB"],
			},
		]);
	});

	it("rejects a missing CSRF token with 403 and writes nothing", async () => {
		const registry = fakeRegistry();
		const { fastify } = build(registry);
		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories",
			headers: { "x-ms-client-principal-name": ALICE, "content-type": FORM },
			payload: new URLSearchParams({ name: "x", githubSlug: "a/b" }).toString(),
		});
		expect(response.statusCode).toBe(403);
		expect(registry.current()).toEqual([]);
	});

	it("rejects a name that could escape the repos directory", async () => {
		const registry = fakeRegistry();
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories",
			headers: { "x-ms-client-principal-name": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				name: "../escape",
				githubSlug: "acme/x",
				linearWorkspaceId: "ws-1",
			}).toString(),
		});
		expect(response.statusCode).toBe(400);
		expect(response.body).toContain("is not valid");
		expect(registry.current()).toEqual([]);
	});

	it("rejects a duplicate name case-insensitively", async () => {
		const registry = fakeRegistry([API]);
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories",
			headers: { "x-ms-client-principal-name": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				name: "CYRUS-API",
				githubSlug: "acme/other",
				linearWorkspaceId: "ws-1",
			}).toString(),
		});
		expect(response.statusCode).toBe(400);
		expect(response.body).toContain("already registered");
		expect(registry.current()).toHaveLength(1);
	});

	it("surfaces an association parse error verbatim", async () => {
		const registry = fakeRegistry();
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories",
			headers: { "x-ms-client-principal-name": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				name: "ok",
				githubSlug: "acme/ok",
				associations: "x=nope",
				linearWorkspaceId: "ws-1",
			}).toString(),
		});
		expect(response.statusCode).toBe(400);
		expect(response.body).toContain("Unknown key");
	});

	it("defaults the base branch to main", async () => {
		const registry = fakeRegistry();
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		await fastify.inject({
			method: "POST",
			url: "/setup/repositories",
			headers: { "x-ms-client-principal-name": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				name: "ok",
				githubSlug: "acme/ok",
				linearWorkspaceId: "ws-1",
			}).toString(),
		});
		expect(registry.current()[0]?.baseBranch).toBe("main");
	});

	it("rejects a base branch that could reach a shell", async () => {
		const registry = fakeRegistry();
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories",
			headers: { "x-ms-client-principal-name": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				name: "ok",
				githubSlug: "acme/ok",
				baseBranch: "$(rm -rf /)",
				linearWorkspaceId: "ws-1",
			}).toString(),
		});
		expect(response.statusCode).toBe(400);
		expect(response.body).toContain("Base branch");
		expect(registry.current()).toEqual([]);
	});

	it("rejects a Linear workspace id that isn't configured", async () => {
		const registry = fakeRegistry();
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories",
			headers: { "x-ms-client-principal-name": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				name: "ok",
				githubSlug: "acme/ok",
				linearWorkspaceId: "ws-bogus",
			}).toString(),
		});
		expect(response.statusCode).toBe(400);
		expect(registry.current()).toEqual([]);
	});

	it("refuses an unregistered principal with 403 and writes nothing", async () => {
		const registry = fakeRegistry([API]);
		const { fastify, csrf } = build(registry);

		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories",
			headers: { "x-ms-client-principal-name": BOB, "content-type": FORM },
			payload: new URLSearchParams({
				csrf: csrf.issue(BOB),
				name: "unauthorized-repo",
				githubSlug: "acme/unauthorized-repo",
				linearWorkspaceId: "ws-1",
			}).toString(),
		});

		expect(response.statusCode).toBe(403);
		expect(registry.current()).toEqual([API]);
	});
});

describe("POST /setup/repositories/save", () => {
	it("moves the default to the selected repository", async () => {
		const registry = fakeRegistry([
			API,
			{
				name: "cyrus-web",
				githubSlug: "acme/cyrus-web",
				linearWorkspaceId: "ws-1",
			},
		]);
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const version = await versionFrom(fastify);

		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories/save",
			headers: { "x-ms-client-principal-name": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				version,
				"repo:cyrus-api": "1",
				"slug:cyrus-api": "acme/cyrus-api",
				"branch:cyrus-api": "main",
				"assoc:cyrus-api": "p=Platform",
				"repo:cyrus-web": "1",
				"slug:cyrus-web": "acme/cyrus-web",
				"branch:cyrus-web": "main",
				"assoc:cyrus-web": "",
				isDefault: "cyrus-web",
			}).toString(),
		});

		expect(response.statusCode).toBe(200);
		expect(
			registry.current().find((r) => r.name === "cyrus-api")?.isDefault,
		).toBe(undefined);
		expect(
			registry.current().find((r) => r.name === "cyrus-web")?.isDefault,
		).toBe(true);
	});

	it("409s on a stale version rather than overwriting", async () => {
		const registry = fakeRegistry([API]);
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		// `stale` is the SIGNED token scraped from the render — that's what the
		// HTTP save below resubmits. The direct `registry.put` call bypasses HTTP
		// entirely to simulate an out-of-band write, so it needs the registry's
		// actual raw version, not the opaque signed token wrapping it.
		const stale = await versionFrom(fastify);
		await registry.put(
			[{ ...API, baseBranch: "develop" }],
			(await registry.list()).version,
		);

		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories/save",
			headers: { "x-ms-client-principal-name": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				version: stale,
				"repo:cyrus-api": "1",
				"slug:cyrus-api": "acme/cyrus-api",
				"branch:cyrus-api": "release",
				"assoc:cyrus-api": "",
			}).toString(),
		});

		expect(response.statusCode).toBe(409);
		expect(registry.current()[0]?.baseBranch).toBe("develop");
	});

	it("refuses a version token with a forged signature and writes nothing", async () => {
		const registry = fakeRegistry([API]);
		const putSpy = vi.spyOn(registry, "put");
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const version = await versionFrom(fastify);
		putSpy.mockClear();
		const separator = version.indexOf(".");
		const tampered = `${version.slice(0, separator)}.not-the-real-signature`;

		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories/save",
			headers: { "x-ms-client-principal-name": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				version: tampered,
				"repo:cyrus-api": "1",
				"slug:cyrus-api": "acme/cyrus-api",
				"branch:cyrus-api": "release",
				"assoc:cyrus-api": "",
			}).toString(),
		});

		expect(response.statusCode).toBe(409);
		expect(putSpy).not.toHaveBeenCalled();
		expect(registry.current()[0]?.baseBranch).toBe("main");
	});

	it('refuses a forged version="*" (unconditional-overwrite bypass) and writes nothing', async () => {
		const registry = fakeRegistry([API]);
		const putSpy = vi.spyOn(registry, "put");
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		putSpy.mockClear();

		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories/save",
			headers: { "x-ms-client-principal-name": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				version: "*",
				"repo:cyrus-api": "1",
				"slug:cyrus-api": "acme/cyrus-api",
				"branch:cyrus-api": "release",
				"assoc:cyrus-api": "",
			}).toString(),
		});

		expect(response.statusCode).toBe(409);
		expect(putSpy).not.toHaveBeenCalled();
		expect(registry.current()[0]?.baseBranch).toBe("main");
	});

	it("does not 409 forever when the registry has never been written", async () => {
		const registry = neverWrittenRegistry();
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const version = await versionFrom(fastify);

		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories/save",
			headers: { "x-ms-client-principal-name": ALICE, "content-type": FORM },
			payload: new URLSearchParams({ csrf, version }).toString(),
		});

		expect(response.statusCode).toBe(200);
		expect(response.body).toContain("No changes to save");
	});

	it("reports no changes without writing", async () => {
		const registry = fakeRegistry([API]);
		const putSpy = vi.spyOn(registry, "put");
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const version = await versionFrom(fastify);
		putSpy.mockClear();

		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories/save",
			headers: { "x-ms-client-principal-name": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				version,
				"repo:cyrus-api": "1",
				"slug:cyrus-api": "acme/cyrus-api",
				"branch:cyrus-api": "main",
				"assoc:cyrus-api": "p=Platform",
				isDefault: "cyrus-api",
			}).toString(),
		});

		expect(response.statusCode).toBe(200);
		expect(response.body).toContain("No changes to save");
		expect(putSpy).not.toHaveBeenCalled();
	});

	it("rejects a base branch that could reach a shell", async () => {
		const registry = fakeRegistry([API]);
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const version = await versionFrom(fastify);

		const response = await fastify.inject({
			method: "POST",
			url: "/setup/repositories/save",
			headers: { "x-ms-client-principal-name": ALICE, "content-type": FORM },
			payload: new URLSearchParams({
				csrf,
				version,
				"repo:cyrus-api": "1",
				"slug:cyrus-api": "acme/cyrus-api",
				"branch:cyrus-api": "$(evil)",
				"assoc:cyrus-api": "",
			}).toString(),
		});

		expect(response.statusCode).toBe(400);
		expect(response.body).toContain("Base branch");
		expect(registry.current()[0]?.baseBranch).toBe("main");
	});
});

describe("DELETE /setup/repositories/:name", () => {
	it("removes a repository when the CSRF token is a header", async () => {
		const registry = fakeRegistry([API]);
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);

		const response = await fastify.inject({
			method: "DELETE",
			url: "/setup/repositories/cyrus-api",
			headers: { "x-ms-client-principal-name": ALICE, "x-csrf-token": csrf },
		});

		expect(response.statusCode).toBe(200);
		expect(registry.current()).toEqual([]);
	});

	it("refuses a CSRF token supplied in the query string", async () => {
		const registry = fakeRegistry([API]);
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);

		const response = await fastify.inject({
			method: "DELETE",
			url: `/setup/repositories/cyrus-api?csrf=${encodeURIComponent(csrf)}`,
			headers: { "x-ms-client-principal-name": ALICE },
		});

		expect(response.statusCode).toBe(403);
		expect(registry.current()).toHaveLength(1);
	});

	it("is a no-op for an unknown repository", async () => {
		const registry = fakeRegistry([API]);
		const { fastify } = build(registry);
		const csrf = await csrfFrom(fastify);
		const response = await fastify.inject({
			method: "DELETE",
			url: "/setup/repositories/nope",
			headers: { "x-ms-client-principal-name": ALICE, "x-csrf-token": csrf },
		});
		expect(response.statusCode).toBe(200);
		expect(registry.current()).toHaveLength(1);
	});
});

describe("applyRepositoryEdits", () => {
	it("updates slug, branch, associations, and default together", () => {
		const result = applyRepositoryEdits([API], {
			"repo:cyrus-api": ["1"],
			"slug:cyrus-api": ["acme/renamed"],
			"branch:cyrus-api": ["develop"],
			"assoc:cyrus-api": ["t=NOR"],
			isDefault: ["cyrus-api"],
		});
		expect(result.changed).toBe(true);
		expect(result.next[0]).toEqual({
			name: "cyrus-api",
			githubSlug: "acme/renamed",
			linearWorkspaceId: "ws-1",
			baseBranch: "develop",
			teamKeys: ["NOR"],
			isDefault: true,
		});
	});

	it("drops a repository whose row was not submitted", () => {
		const result = applyRepositoryEdits(
			[API, { name: "b", githubSlug: "acme/b", linearWorkspaceId: "ws-1" }],
			{
				"repo:cyrus-api": ["1"],
				"slug:cyrus-api": ["acme/cyrus-api"],
				"branch:cyrus-api": ["main"],
				"assoc:cyrus-api": ["p=Platform"],
				isDefault: ["cyrus-api"],
			},
		);
		expect(result.next.map((repo) => repo.name)).toEqual(["cyrus-api"]);
		expect(result.changed).toBe(true);
	});

	it("clears associations when the field is emptied", () => {
		const result = applyRepositoryEdits([API], {
			"repo:cyrus-api": ["1"],
			"slug:cyrus-api": ["acme/cyrus-api"],
			"branch:cyrus-api": ["main"],
			"assoc:cyrus-api": [""],
			isDefault: ["cyrus-api"],
		});
		expect(result.next[0]?.projectKeys).toBeUndefined();
	});

	it("reports no change regardless of the stored entry's key order", () => {
		// Same repository as API, field-for-field, but built with a different key
		// order — e.g. what a registry seeded from `containers.repositories`
		// (arbitrary JSON key order) could hand back. A naive
		// `JSON.stringify(next) !== JSON.stringify(current)` is sensitive to this
		// and would misreport "changed" on a save that changed nothing.
		const reordered: RegisteredRepository = {
			isDefault: true,
			baseBranch: "main",
			linearWorkspaceId: "ws-1",
			githubSlug: "acme/cyrus-api",
			projectKeys: ["Platform"],
			name: "cyrus-api",
		};
		const result = applyRepositoryEdits([reordered], {
			"repo:cyrus-api": ["1"],
			"slug:cyrus-api": ["acme/cyrus-api"],
			"branch:cyrus-api": ["main"],
			"assoc:cyrus-api": ["p=Platform"],
			isDefault: ["cyrus-api"],
		});
		expect(result.changed).toBe(false);
	});
});
