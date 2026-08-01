import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouterStore } from "../src/RouterStore.js";
import {
	FileSecretStore,
	normalizeSecretKey,
	type SecretStoreBackend,
	type UserSecretBundle,
} from "../src/SecretStore.js";
import { SetupBootstrap } from "../src/setup/bootstrap.js";
import { createCsrfTokens } from "../src/setup/csrf.js";
import { MAX_BUNDLE_BYTES } from "../src/setup/envelope.js";
import type {
	SetupAuthConfig,
	SetupIdTokenVerifier,
} from "../src/setup/principal.js";
import { applyEdits, registerSetupRoutes } from "../src/setup/routes.js";
import { SetupConflictError } from "../src/TableSecretStore.js";

const REQUIRED = ["CLAUDE_CODE_OAUTH_TOKEN", "GIT_TOKEN"] as const;
const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const FORM = "application/x-www-form-urlencoded";

const DEV_AUTH: SetupAuthConfig = { auth: { mode: "dev-insecure-headers" } };

function tempSecretsFile(): string {
	return join(
		mkdtempSync(join(tmpdir(), "cyrus-routes-")),
		"user-secrets.json",
	);
}

/**
 * A hand-rolled stand-in for {@link TableSecretStore} with **real** optimistic
 * concurrency: every write bumps a version, and a conditional write against a
 * stale version raises {@link SetupConflictError} exactly as HTTP 412 does.
 *
 * The conflict in the two-tab test below is produced by this machinery
 * reacting to two genuine sequential saves — it is never injected by the fake.
 */
class FakeRecordStore implements SecretStoreBackend {
	private readonly records = new Map<
		string,
		{ bundle: UserSecretBundle; version: number }
	>();
	readonly putRecordCalls: Array<{
		email: string;
		bundle: UserSecretBundle;
		ifMatch: string | undefined;
	}> = [];
	readonly setCalls: Array<{ key: string; value: string | undefined }> = [];

	supportsRecords(): boolean {
		return true;
	}

	private etagOf(version: number): string {
		return `W/"datetime'2026-08-01T00%3A00%3A0${version}Z'"`;
	}

	async get(email: string): Promise<UserSecretBundle> {
		return { ...(this.records.get(email.toLowerCase())?.bundle ?? {}) };
	}

	async getRecord(
		email: string,
	): Promise<{ bundle: UserSecretBundle; etag: string } | undefined> {
		const record = this.records.get(email.toLowerCase());
		if (!record) return undefined;
		return { bundle: { ...record.bundle }, etag: this.etagOf(record.version) };
	}

	async putRecord(
		email: string,
		bundle: UserSecretBundle,
		ifMatch?: string,
	): Promise<{ etag: string }> {
		this.putRecordCalls.push({ email, bundle: { ...bundle }, ifMatch });
		if (ifMatch === "" || ifMatch === "*") {
			throw new Error(`refusing to write with If-Match: ${ifMatch}`);
		}
		const id = email.toLowerCase();
		const existing = this.records.get(id);
		if (ifMatch === undefined) {
			// Insert Entity. A record that already exists means someone else won
			// the create race — the Table service's 409 EntityAlreadyExists.
			if (existing) {
				throw new SetupConflictError(
					"another writer created this record first",
				);
			}
			this.records.set(id, { bundle: { ...bundle }, version: 1 });
			return { etag: this.etagOf(1) };
		}
		// Conditional Update Entity: HTTP 412 when the ETag no longer matches.
		if (!existing || this.etagOf(existing.version) !== ifMatch) {
			throw new SetupConflictError();
		}
		existing.version += 1;
		existing.bundle = { ...bundle };
		return { etag: this.etagOf(existing.version) };
	}

	async ensureRecord(
		email: string,
		requiredKeys: readonly string[],
	): Promise<{ created: boolean }> {
		const normalized = requiredKeys.map((key) => normalizeSecretKey(key));
		const record = await this.getRecord(email);
		const bundle = record?.bundle ?? {};
		let changed = record === undefined;
		for (const key of normalized) {
			if (!Object.hasOwn(bundle, key)) {
				bundle[key] = "";
				changed = true;
			}
		}
		if (!changed) return { created: false };
		await this.putRecord(email, bundle, record?.etag);
		return { created: true };
	}

	async set(
		email: string,
		key: string,
		value: string | undefined,
	): Promise<void> {
		const normalizedKey = normalizeSecretKey(key);
		this.setCalls.push({ key: normalizedKey, value });
		const record = await this.getRecord(email);
		const bundle = record?.bundle ?? {};
		if (value === undefined) delete bundle[normalizedKey];
		else bundle[normalizedKey] = value;
		await this.putRecord(email, bundle, record?.etag);
	}

	async isFullyAuthenticated(
		email: string,
		requiredKeys: readonly string[],
	): Promise<{ ok: boolean; missing: string[] }> {
		const bundle = await this.get(email);
		const missing = requiredKeys.filter((key) => !bundle[key]);
		return { ok: missing.length === 0, missing };
	}
}

interface HarnessOptions {
	auth?: SetupAuthConfig;
	autoProvisionUsers?: boolean;
	secrets?: SecretStoreBackend;
	verifyIdToken?: SetupIdTokenVerifier;
	requiredKeys?: readonly string[];
}

const openApps: FastifyInstance[] = [];
const openStores: RouterStore[] = [];

afterEach(async () => {
	for (const app of openApps.splice(0)) await app.close();
	for (const store of openStores.splice(0)) store.close();
	vi.restoreAllMocks();
});

async function harness(options: HarnessOptions = {}) {
	const store = new RouterStore(":memory:");
	openStores.push(store);
	const secrets = options.secrets ?? new FileSecretStore(tempSecretsFile());
	const requiredKeys = options.requiredKeys ?? REQUIRED;
	const logger = { info: vi.fn(), warn: vi.fn() };
	const bootstrap = new SetupBootstrap({
		store,
		secrets,
		requiredKeys,
		autoProvisionUsers: options.autoProvisionUsers ?? true,
		logger,
	});
	const csrf = createCsrfTokens("test-secret-for-routes");
	const app = Fastify();
	openApps.push(app);
	registerSetupRoutes(app, {
		secrets,
		requiredKeys,
		auth: options.auth ?? DEV_AUTH,
		bootstrap,
		csrf,
		logger,
		...(options.verifyIdToken ? { verifyIdToken: options.verifyIdToken } : {}),
	});
	await app.ready();
	return { app, store, secrets, bootstrap, csrf, logger, requiredKeys };
}

type Harness = Awaited<ReturnType<typeof harness>>;

/** Provisions a user the way `POST /setup/provision` would, without HTTP. */
async function provisioned(h: Harness, email = ALICE): Promise<Harness> {
	await h.bootstrap.ensure({ email });
	return h;
}

function signedIn(email: string): Record<string, string> {
	return { "x-ms-client-principal-name": email };
}

function formHeaders(email: string): Record<string, string> {
	return { ...signedIn(email), "content-type": FORM };
}

function field(html: string, name: string): string {
	const match = html.match(
		new RegExp(`name="${name}"[^>]*?value="([^"]*)"`, "i"),
	);
	if (!match?.[1]) throw new Error(`no ${name} field in response`);
	return match[1];
}

function form(fields: Record<string, string>): string {
	return Object.entries(fields)
		.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
		.join("&");
}

function get(h: Harness, url: string, email?: string) {
	return h.app.inject({
		method: "GET",
		url,
		...(email ? { headers: signedIn(email) } : {}),
	});
}

function post(
	h: Harness,
	url: string,
	fields: Record<string, string>,
	email = ALICE,
) {
	return h.app.inject({
		method: "POST",
		url,
		payload: form(fields),
		headers: formHeaders(email),
	});
}

/**
 * A DELETE shaped exactly like the one the vendored htmx emits (R2-03):
 * **no request body and no query string** — the token rides in `X-CSRF-Token`.
 *
 * This helper used to inject a urlencoded DELETE body. htmx never sends one:
 * its `methodsThatUseUrlParams` list contains `delete`, so anything it
 * collects goes in the URL, which this route refuses by design. Every delete
 * test therefore passed against a transport no browser produces, which is
 * precisely what hid the fact that the button 403'd on every real click.
 */
function del(h: Harness, name: string, email = ALICE) {
	return h.app.inject({
		method: "DELETE",
		url: `/setup/variables/${encodeURIComponent(name)}`,
		headers: { ...signedIn(email), "x-csrf-token": h.csrf.issue(email) },
	});
}

/* ------------------------------------------------------------------ auth -- */

describe("setup routes — authentication", () => {
	it("401s an unauthenticated GET /setup", async () => {
		const h = await harness();
		const res = await get(h, "/setup");
		expect(res.statusCode).toBe(401);
	});

	it("403s a principal outside the allowed domain", async () => {
		const h = await harness({
			auth: { ...DEV_AUTH, allowedDomain: "example.com" },
		});
		const res = await get(h, "/setup", "eve@evil.test");
		expect(res.statusCode).toBe(403);
	});

	it("401s an unauthenticated GET /setup/variables", async () => {
		const h = await harness();
		expect((await get(h, "/setup/variables")).statusCode).toBe(401);
	});

	it("401s every mutating route with no principal", async () => {
		const h = await harness();
		for (const url of ["/setup/provision", "/setup/variables", "/setup/save"]) {
			const res = await h.app.inject({
				method: "POST",
				url,
				payload: "csrf=whatever&name=FOO",
				headers: { "content-type": FORM },
			});
			expect(res.statusCode, url).toBe(401);
		}
		const del = await h.app.inject({
			method: "DELETE",
			url: "/setup/variables/FOO",
			payload: "csrf=whatever",
			headers: { "content-type": FORM },
		});
		expect(del.statusCode).toBe(401);
	});

	it("ignores identity headers entirely in entra-token mode", async () => {
		const verifyIdToken = vi.fn<SetupIdTokenVerifier>(async () => ({
			email: ALICE,
		}));
		const h = await harness({
			auth: { auth: { mode: "entra-token", idTokenAudience: "client-guid" } },
			verifyIdToken,
		});
		const res = await get(h, "/setup", ALICE);
		expect(res.statusCode).toBe(401);
		expect(verifyIdToken).not.toHaveBeenCalled();
	});

	it("accepts a verified ID token in entra-token mode", async () => {
		const verifyIdToken = vi.fn<SetupIdTokenVerifier>(async (token) => {
			if (token !== "good-token") throw new Error("bad token");
			return { email: ALICE };
		});
		const h = await harness({
			auth: { auth: { mode: "entra-token", idTokenAudience: "client-guid" } },
			verifyIdToken,
		});
		await provisioned(h);
		const res = await h.app.inject({
			method: "GET",
			url: "/setup",
			headers: { "x-ms-token-aad-id-token": "good-token" },
		});
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain(ALICE);
	});
});

/* -------------------------------------------------------- GET /setup (F18) */

describe("GET /setup — read-only (F18)", () => {
	it("never provisions: no bootstrap call, no user row, no record", async () => {
		const h = await harness();
		const ensure = vi.spyOn(h.bootstrap, "ensure");
		const res = await get(h, "/setup", ALICE);
		expect(res.statusCode).toBe(200);
		expect(ensure).not.toHaveBeenCalled();
		expect(h.store.listUsers()).toHaveLength(0);
		expect(await h.secrets.get(ALICE)).toEqual({});
	});

	it("renders a set-up-your-account state whose only control is a CSRF-protected POST", async () => {
		const h = await harness();
		const res = await get(h, "/setup", ALICE);
		expect(res.body).toMatch(/set up your account/i);
		expect(res.body).toContain('method="post"');
		expect(res.body).toContain('action="/setup/provision"');
		expect(res.body).toMatch(/name="csrf" value="[^"]+"/);
		// No mutating GET affordance anywhere on the page.
		expect(res.body).not.toContain("hx-get");
	});

	it("renders the variables page for a provisioned teammate", async () => {
		const h = await provisioned(await harness());
		const res = await get(h, "/setup", ALICE);
		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toContain("text/html");
		expect(res.body).toContain(ALICE);
		expect(res.body).toContain("CLAUDE_CODE_OAUTH_TOKEN");
		expect(res.body).toContain("GIT_TOKEN");
	});

	it("never sends a stored value to the browser", async () => {
		const h = await provisioned(await harness());
		await h.secrets.set(ALICE, "GIT_TOKEN", "ghp_supersecret");
		const res = await get(h, "/setup", ALICE);
		expect(res.body).not.toContain("ghp_supersecret");
	});

	it("sets no-store and the hardening headers", async () => {
		const h = await provisioned(await harness());
		const res = await get(h, "/setup", ALICE);
		expect(res.headers["cache-control"]).toBe("no-store");
		expect(res.headers["content-security-policy"]).toContain(
			"default-src 'none'",
		);
		expect(res.headers["x-content-type-options"]).toBe("nosniff");
		expect(res.headers["referrer-policy"]).toBe("no-referrer");
		expect(res.headers["x-frame-options"]).toBe("DENY");
	});

	// htmx issues its POST to /setup/save over XMLHttpRequest, which CSP governs
	// with `connect-src` — NOT `form-action`, which only covers real form
	// submissions. With `connect-src` absent it falls back to `default-src
	// 'none'` and the browser blocks every save, so the page renders and reads
	// correctly while silently refusing to write anything.
	it("allows same-origin XHR so htmx can POST /setup/save", async () => {
		const h = await provisioned(await harness());
		const res = await get(h, "/setup", ALICE);
		expect(res.headers["content-security-policy"]).toContain(
			"connect-src 'self'",
		);
	});

	it("embeds a version token bound to the principal", async () => {
		const h = await provisioned(
			await harness({ secrets: new FakeRecordStore() }),
		);
		const res = await get(h, "/setup", ALICE);
		expect(field(res.body, "version")).toBeTruthy();
	});
});

describe("GET /setup/variables", () => {
	it("returns just the table fragment", async () => {
		const h = await provisioned(await harness());
		const res = await get(h, "/setup/variables", ALICE);
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('id="variables"');
		expect(res.body).not.toContain("<!doctype html>");
	});
});

/* ---------------------------------------------------- POST /setup/provision */

describe("POST /setup/provision", () => {
	it("provisions the user and renders the variables page", async () => {
		const h = await harness();
		const csrf = h.csrf.issue(ALICE);
		const res = await post(h, "/setup/provision", { csrf });
		expect(res.statusCode).toBe(200);
		expect(h.store.listUsers().map((u) => u.email)).toContain(ALICE);
		expect(await h.secrets.get(ALICE)).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "",
			GIT_TOKEN: "",
		});
		expect(res.body).toContain('id="variables"');
	});

	it("refuses without a CSRF token and provisions nothing", async () => {
		const h = await harness();
		const res = await post(h, "/setup/provision", {});
		expect(res.statusCode).toBe(403);
		expect(h.store.listUsers()).toHaveLength(0);
	});

	it("refuses a CSRF token issued for another principal", async () => {
		const h = await harness();
		const res = await post(h, "/setup/provision", {
			csrf: h.csrf.issue(BOB),
		});
		expect(res.statusCode).toBe(403);
		expect(h.store.listUsers()).toHaveLength(0);
	});

	it("explains how to register when auto-provisioning is off", async () => {
		const h = await harness({ autoProvisionUsers: false });
		const stranger = "stranger@example.com";
		const res = await post(
			h,
			"/setup/provision",
			{ csrf: h.csrf.issue(stranger) },
			stranger,
		);
		expect(res.statusCode).toBe(403);
		expect(res.body).toContain("cyrus router users add");
		expect(h.store.listUsers()).toHaveLength(0);
	});
});

/* --------------------------------------------------------------- assets --- */

describe("GET /setup/assets", () => {
	it("serves the vendored css with a long cache", async () => {
		const h = await harness();
		const res = await get(h, "/setup/assets/pico.css");
		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toContain("text/css");
		expect(String(res.headers["cache-control"])).toContain("immutable");
	});

	it("serves assets without authentication (they contain nothing private)", async () => {
		const h = await harness({
			auth: { ...DEV_AUTH, allowedDomain: "example.com" },
		});
		const res = await get(h, "/setup/assets/htmx.js");
		expect(res.statusCode).toBe(200);
		expect(res.headers["content-type"]).toContain("javascript");
	});
});

/* ------------------------------------------------------- mutation guard --- */

describe("shared mutation guard", () => {
	it("rejects a mutation with a missing csrf token", async () => {
		const h = await provisioned(await harness());
		const res = await post(h, "/setup/variables", { name: "FOO" });
		expect(res.statusCode).toBe(403);
	});

	it("rejects a csrf token issued for another principal", async () => {
		const h = await provisioned(await harness());
		const res = await post(h, "/setup/variables", {
			name: "FOO",
			csrf: h.csrf.issue(BOB),
		});
		expect(res.statusCode).toBe(403);
		expect(await h.secrets.get(ALICE)).not.toHaveProperty("FOO");
	});

	it("checks auth before csrf, so an anonymous caller never probes token state", async () => {
		const h = await harness();
		const res = await h.app.inject({
			method: "POST",
			url: "/setup/variables",
			payload: form({ name: "FOO", csrf: h.csrf.issue(ALICE) }),
			headers: { "content-type": FORM },
		});
		expect(res.statusCode).toBe(401);
	});

	it("accepts the token from the X-CSRF-Token header", async () => {
		const h = await provisioned(await harness());
		const res = await h.app.inject({
			method: "POST",
			url: "/setup/variables",
			payload: form({ name: "MY_TOOL_KEY" }),
			headers: { ...formHeaders(ALICE), "x-csrf-token": h.csrf.issue(ALICE) },
		});
		expect(res.statusCode).toBe(200);
		expect(await h.secrets.get(ALICE)).toHaveProperty("MY_TOOL_KEY");
	});

	it("never accepts a csrf token from the query string (F18)", async () => {
		const h = await provisioned(await harness());
		await h.secrets.set(ALICE, "MY_TOOL_KEY", "v");
		const res = await h.app.inject({
			method: "DELETE",
			url: `/setup/variables/MY_TOOL_KEY?csrf=${encodeURIComponent(h.csrf.issue(ALICE))}`,
			headers: signedIn(ALICE),
		});
		expect(res.statusCode).toBe(403);
		expect(await h.secrets.get(ALICE)).toMatchObject({ MY_TOOL_KEY: "v" });
	});

	it("rejects a body field that is not a valid name before writing anything", async () => {
		const h = await provisioned(await harness());
		const res = await post(h, "/setup/variables", {
			name: "not-a-valid-name",
			csrf: h.csrf.issue(ALICE),
		});
		expect(res.statusCode).toBe(400);
		expect(await h.secrets.get(ALICE)).toEqual({
			CLAUDE_CODE_OAUTH_TOKEN: "",
			GIT_TOKEN: "",
		});
	});
});

/* ---------------------------------------------- registration gate (R2-02) -- */

/**
 * Authentication is not authorization. Every mutating route must also confirm
 * the principal maps to an existing RouterStore user; otherwise any tenant
 * principal EasyAuth admits can load `/setup`, take the CSRF token it is handed,
 * and have the router create an encrypted secret record for an address that was
 * never registered — pre-seeding values that attach to the real account the
 * moment an administrator registers that email.
 *
 * `POST /setup/provision` is the deliberate exception: it is the route whose
 * entire job is to create that user, so it goes through `bootstrap.ensure`,
 * which may auto-provision when the operator has enabled it.
 */
describe("registration gate (R2-02)", () => {
	const STRANGER = "stranger@example.com";

	/**
	 * A signed-in principal with no `users` row, auto-provisioning off. ALICE is
	 * registered in the same harness so a passing test can never be explained by
	 * "the secret store was never reachable at all".
	 */
	async function gate() {
		const secrets = new FakeRecordStore();
		const h = await harness({ secrets, autoProvisionUsers: false });
		h.store.addUser({ email: ALICE });
		await h.bootstrap.ensure({ email: ALICE });
		// ALICE's own provisioning writes are setup, not evidence.
		secrets.setCalls.length = 0;
		secrets.putRecordCalls.length = 0;
		const calls = {
			get: vi.spyOn(secrets, "get"),
			getRecord: vi.spyOn(secrets, "getRecord"),
			set: vi.spyOn(secrets, "set"),
			putRecord: vi.spyOn(secrets, "putRecord"),
		};
		return { h, secrets, calls };
	}

	type Gate = Awaited<ReturnType<typeof gate>>;

	/** The whole point: not merely "403", but "the store was never touched". */
	function expectNoSecretAccess({ calls, secrets }: Gate): void {
		expect(calls.set).not.toHaveBeenCalled();
		expect(calls.putRecord).not.toHaveBeenCalled();
		expect(calls.get).not.toHaveBeenCalled();
		expect(calls.getRecord).not.toHaveBeenCalled();
		expect(secrets.setCalls).toEqual([]);
		expect(secrets.putRecordCalls).toEqual([]);
	}

	it("403s POST /setup/variables and writes nothing", async () => {
		const g = await gate();
		const res = await post(
			g.h,
			"/setup/variables",
			{ name: "FOO", csrf: g.h.csrf.issue(STRANGER) },
			STRANGER,
		);
		expect(res.statusCode).toBe(403);
		expect(res.body).toContain("cyrus router users add");
		expectNoSecretAccess(g);
		expect(await g.secrets.get(STRANGER)).toEqual({});
		expect(g.h.store.listUsers().map((u) => u.email)).toEqual([ALICE]);
	});

	it("403s DELETE /setup/variables/:name and writes nothing", async () => {
		const g = await gate();
		const res = await del(g.h, "MY_TOOL_KEY", STRANGER);
		expect(res.statusCode).toBe(403);
		expect(res.body).toContain("cyrus router users add");
		expectNoSecretAccess(g);
	});

	it("403s POST /setup/save and writes nothing", async () => {
		const g = await gate();
		const res = await post(
			g.h,
			"/setup/save",
			{
				csrf: g.h.csrf.issue(STRANGER),
				"value:CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-attacker",
			},
			STRANGER,
		);
		expect(res.statusCode).toBe(403);
		expect(res.body).not.toContain("sk-ant-attacker");
		expectNoSecretAccess(g);
	});

	it("still lets a registered user mutate, and the counters prove it", async () => {
		const g = await gate();
		const add = await post(
			g.h,
			"/setup/variables",
			{ name: "MY_TOOL_KEY", csrf: g.h.csrf.issue(ALICE) },
			ALICE,
		);
		expect(add.statusCode).toBe(200);
		expect(g.calls.set).toHaveBeenCalled();

		const removed = await del(g.h, "MY_TOOL_KEY", ALICE);
		expect(removed.statusCode).toBe(200);

		const page = await get(g.h, "/setup", ALICE);
		const saved = await post(
			g.h,
			"/setup/save",
			{
				csrf: field(page.body, "csrf"),
				version: field(page.body, "version"),
				"value:CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-legit",
			},
			ALICE,
		);
		expect(saved.statusCode).toBe(200);
		expect(await g.secrets.get(ALICE)).toMatchObject({
			CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-legit",
		});
	});

	it("keeps POST /setup/provision as the one route that may create the user", async () => {
		const h = await harness({ autoProvisionUsers: true });
		const res = await post(
			h,
			"/setup/provision",
			{ csrf: h.csrf.issue(STRANGER) },
			STRANGER,
		);
		expect(res.statusCode).toBe(200);
		expect(h.store.listUsers().map((u) => u.email)).toContain(STRANGER);
	});

	/**
	 * Readiness must come from the RouterStore user, not from "the bundle has
	 * some key in it". Otherwise a record prepared by any of the routes above —
	 * or by an earlier build that had no gate — makes the router treat an
	 * unregistered principal as fully provisioned.
	 */
	it("treats an unregistered principal with a secret record as NOT provisioned", async () => {
		const secrets = new FakeRecordStore();
		const h = await harness({ secrets, autoProvisionUsers: false });
		await secrets.set(STRANGER, "PLANTED_KEY", "prepared-earlier");

		const res = await get(h, "/setup", STRANGER);
		expect(res.statusCode).toBe(200);
		expect(res.body).toMatch(/set up your account/i);
		expect(res.body).not.toContain("PLANTED_KEY");
		expect(res.body).not.toContain("prepared-earlier");
	});

	it("renders the variables page for a registered user whose record is empty", async () => {
		const secrets = new FakeRecordStore();
		const h = await harness({ secrets, autoProvisionUsers: false });
		// `cyrus router users add` creates the row and nothing else.
		h.store.addUser({ email: ALICE });

		const res = await get(h, "/setup", ALICE);
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain('id="variables"');
		expect(res.body).toContain("CLAUDE_CODE_OAUTH_TOKEN");
	});
});

/* ------------------------------------------------ POST /setup/variables --- */

describe("POST /setup/variables", () => {
	async function add(h: Harness, name: string, email = ALICE) {
		return post(
			h,
			"/setup/variables",
			{ name, csrf: h.csrf.issue(email) },
			email,
		);
	}

	it("adds an optional variable with an empty value", async () => {
		const h = await provisioned(await harness());
		const res = await add(h, "MY_TOOL_KEY");
		expect(res.statusCode).toBe(200);
		expect(res.body).toContain("MY_TOOL_KEY");
		expect(await h.secrets.get(ALICE)).toMatchObject({ MY_TOOL_KEY: "" });
	});

	it("returns the whole table fragment, not a row", async () => {
		const h = await provisioned(await harness());
		const res = await add(h, "MY_TOOL_KEY");
		expect(res.body).toContain('id="variables"');
		expect(res.body).toContain("CLAUDE_CODE_OAUTH_TOKEN");
	});

	it("rejects a reserved env name with the store's own message", async () => {
		const h = await provisioned(await harness());
		const res = await add(h, "CYRUS_DEVICE_TOKEN");
		expect(res.statusCode).toBe(400);
		expect(res.body).toMatch(/reserved/i);
		expect(await h.secrets.get(ALICE)).not.toHaveProperty("CYRUS_DEVICE_TOKEN");
	});

	it("rejects an invalid env name with the store's own message", async () => {
		const h = await provisioned(await harness());
		const res = await add(h, "not-a-valid-name");
		expect(res.statusCode).toBe(400);
		expect(res.body).toMatch(/environment variable name/i);
	});

	it("rejects an empty name", async () => {
		const h = await provisioned(await harness());
		expect((await add(h, "")).statusCode).toBe(400);
	});

	it("normalizes a legacy name instead of creating a duplicate row", async () => {
		const h = await provisioned(await harness());
		await add(h, "githubPat");
		const bundle = await h.secrets.get(ALICE);
		expect(bundle).toHaveProperty("GIT_TOKEN");
		expect(bundle).not.toHaveProperty("githubPat");
	});

	it("reports a duplicate without clobbering the stored value", async () => {
		const h = await provisioned(await harness());
		await h.secrets.set(ALICE, "MY_TOOL_KEY", "existing");
		const res = await add(h, "MY_TOOL_KEY");
		expect(res.statusCode).toBe(400);
		expect(res.body).toMatch(/already/i);
		expect(await h.secrets.get(ALICE)).toMatchObject({
			MY_TOOL_KEY: "existing",
		});
	});

	it("re-renders with a fresh csrf token after an error", async () => {
		const h = await provisioned(await harness());
		const res = await add(h, "PATH");
		expect(res.statusCode).toBe(400);
		const token = field(res.body, "csrf");
		expect(h.csrf.verify(ALICE, token)).toBe(true);
	});

	it("does not leak values in the error re-render", async () => {
		const h = await provisioned(await harness());
		await h.secrets.set(ALICE, "MY_TOOL_KEY", "ghp_secret");
		const res = await add(h, "MY_TOOL_KEY");
		expect(res.body).not.toContain("ghp_secret");
	});
});

/* --------------------------------------- DELETE /setup/variables/:name ---- */

describe("DELETE /setup/variables/:name", () => {
	it("removes an optional variable, with the token in a header and no body (R2-03)", async () => {
		const h = await provisioned(await harness());
		await h.secrets.set(ALICE, "MY_TOOL_KEY", "v");
		const res = await del(h, "MY_TOOL_KEY");
		expect(res.statusCode).toBe(200);
		expect(await h.secrets.get(ALICE)).not.toHaveProperty("MY_TOOL_KEY");
	});

	it("refuses to delete a required variable even though the UI hides the button", async () => {
		const h = await provisioned(await harness());
		await h.secrets.set(ALICE, "CLAUDE_CODE_OAUTH_TOKEN", "v");
		const res = await del(h, "CLAUDE_CODE_OAUTH_TOKEN");
		expect(res.statusCode).toBe(400);
		expect(res.body).toMatch(/required/i);
		expect(await h.secrets.get(ALICE)).toMatchObject({
			CLAUDE_CODE_OAUTH_TOKEN: "v",
		});
	});

	it("refuses a required variable submitted under its legacy name", async () => {
		const h = await provisioned(await harness());
		await h.secrets.set(ALICE, "GIT_TOKEN", "v");
		const res = await del(h, "githubPat");
		expect(res.statusCode).toBe(400);
		expect(await h.secrets.get(ALICE)).toMatchObject({ GIT_TOKEN: "v" });
	});

	it("refuses a delete carrying no csrf token at all", async () => {
		const h = await provisioned(await harness());
		await h.secrets.set(ALICE, "MY_TOOL_KEY", "v");
		const res = await h.app.inject({
			method: "DELETE",
			url: "/setup/variables/MY_TOOL_KEY",
			headers: signedIn(ALICE),
		});
		expect(res.statusCode).toBe(403);
		expect(await h.secrets.get(ALICE)).toMatchObject({ MY_TOOL_KEY: "v" });
	});

	it("is idempotent for a variable that is already gone", async () => {
		const h = await provisioned(await harness());
		expect((await del(h, "NEVER_EXISTED")).statusCode).toBe(200);
	});

	it("rejects an invalid name", async () => {
		const h = await provisioned(await harness());
		expect((await del(h, "PATH")).statusCode).toBe(400);
	});

	it("does not let one user delete another's variable", async () => {
		const h = await provisioned(await harness());
		await provisioned(h, BOB);
		await h.secrets.set(BOB, "BOBS_KEY", "v");
		await del(h, "BOBS_KEY", ALICE);
		expect(await h.secrets.get(BOB)).toMatchObject({ BOBS_KEY: "v" });
	});
});

/* ------------------------------------------------------ POST /setup/save -- */

async function renderAndSave(
	h: Harness,
	fields: Record<string, string>,
	email = ALICE,
) {
	const page = await get(h, "/setup", email);
	return post(
		h,
		"/setup/save",
		{
			csrf: field(page.body, "csrf"),
			version: field(page.body, "version"),
			...fields,
		},
		email,
	);
}

describe("POST /setup/save", () => {
	it("stores a submitted value", async () => {
		const h = await provisioned(await harness());
		const res = await renderAndSave(h, {
			"value:CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-new",
		});
		expect(res.statusCode).toBe(200);
		expect(await h.secrets.get(ALICE)).toMatchObject({
			CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-new",
		});
	});

	it("leaves a stored value alone when the field is blank", async () => {
		const h = await provisioned(await harness());
		await h.secrets.set(ALICE, "CLAUDE_CODE_OAUTH_TOKEN", "keep");
		const res = await renderAndSave(h, { "value:CLAUDE_CODE_OAUTH_TOKEN": "" });
		expect(res.statusCode).toBe(200);
		expect(await h.secrets.get(ALICE)).toMatchObject({
			CLAUDE_CODE_OAUTH_TOKEN: "keep",
		});
	});

	it("clears a value only when the clear box is ticked", async () => {
		const h = await provisioned(await harness());
		await h.secrets.set(ALICE, "CLAUDE_CODE_OAUTH_TOKEN", "old");
		await renderAndSave(h, { "clear:CLAUDE_CODE_OAUTH_TOKEN": "on" });
		expect(await h.secrets.get(ALICE)).toMatchObject({
			CLAUDE_CODE_OAUTH_TOKEN: "",
		});
	});

	it("never echoes the submitted value back on success", async () => {
		const h = await provisioned(await harness());
		const res = await renderAndSave(h, {
			"value:CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-topsecret",
		});
		expect(res.body).not.toContain("sk-ant-topsecret");
	});

	it("never echoes the submitted value back on an error path", async () => {
		const h = await provisioned(await harness());
		const res = await renderAndSave(h, {
			"value:CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-topsecret",
			"value:PATH": "/evil",
		});
		expect(res.statusCode).toBe(400);
		expect(res.body).not.toContain("sk-ant-topsecret");
	});

	it("rejects a tampered field name and writes nothing", async () => {
		const h = await provisioned(await harness());
		const res = await renderAndSave(h, { "value:PATH": "/evil" });
		expect(res.statusCode).toBe(400);
		expect(await h.secrets.get(ALICE)).not.toHaveProperty("PATH");
	});

	it("reports a no-op save without writing", async () => {
		const h = await provisioned(await harness());
		const before = await h.secrets.get(ALICE);
		const res = await renderAndSave(h, { "value:CLAUDE_CODE_OAUTH_TOKEN": "" });
		expect(res.body).toMatch(/no changes/i);
		expect(await h.secrets.get(ALICE)).toEqual(before);
	});

	it("ignores a field for a variable the record no longer has", async () => {
		const h = await provisioned(await harness());
		const res = await renderAndSave(h, { "value:GONE": "x" });
		expect(res.statusCode).toBe(200);
		expect(await h.secrets.get(ALICE)).not.toHaveProperty("GONE");
		expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining("GONE"));
	});

	it("tells the user when the change takes effect", async () => {
		const h = await provisioned(await harness());
		const res = await renderAndSave(h, {
			"value:CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-new",
		});
		expect(res.body).toMatch(/next session|already running/i);
	});

	it("requires csrf", async () => {
		const h = await provisioned(await harness());
		const page = await get(h, "/setup", ALICE);
		const res = await post(h, "/setup/save", {
			version: field(page.body, "version"),
			"value:CLAUDE_CODE_OAUTH_TOKEN": "x",
		});
		expect(res.statusCode).toBe(403);
		expect(await h.secrets.get(ALICE)).toMatchObject({
			CLAUDE_CODE_OAUTH_TOKEN: "",
		});
	});

	it("rejects an over-limit bundle before writing, naming the variable", async () => {
		const h = await provisioned(await harness());
		await post(h, "/setup/variables", {
			name: "BIG_BLOB",
			csrf: h.csrf.issue(ALICE),
		});
		const res = await renderAndSave(h, {
			"value:BIG_BLOB": "x".repeat(MAX_BUNDLE_BYTES + 1),
		});
		expect(res.statusCode).toBe(400);
		expect(res.body).toContain("BIG_BLOB");
		expect(res.body).toMatch(/limit/i);
		expect(await h.secrets.get(ALICE)).toMatchObject({ BIG_BLOB: "" });
	});
});

describe("POST /setup/save — backends", () => {
	it("uses a single conditional write on a record-capable backend", async () => {
		const secrets = new FakeRecordStore();
		const h = await provisioned(await harness({ secrets }));
		secrets.putRecordCalls.length = 0;
		const res = await renderAndSave(h, {
			"value:CLAUDE_CODE_OAUTH_TOKEN": "a",
			"value:GIT_TOKEN": "b",
		});
		expect(res.statusCode).toBe(200);
		expect(secrets.putRecordCalls).toHaveLength(1);
		expect(secrets.putRecordCalls[0]?.ifMatch).toBeTruthy();
	});

	it("falls back to per-key writes on a backend without records", async () => {
		const h = await provisioned(await harness());
		const setSpy = vi.spyOn(h.secrets, "set");
		const res = await renderAndSave(h, {
			"value:CLAUDE_CODE_OAUTH_TOKEN": "a",
			"value:GIT_TOKEN": "b",
		});
		expect(res.statusCode).toBe(200);
		expect(setSpy).toHaveBeenCalledTimes(2);
		expect(await h.secrets.get(ALICE)).toMatchObject({
			CLAUDE_CODE_OAUTH_TOKEN: "a",
			GIT_TOKEN: "b",
		});
	});

	it("saves on a non-record backend even though the page carries no usable version", async () => {
		const h = await provisioned(await harness());
		const page = await get(h, "/setup", ALICE);
		// The file backend cannot produce an ETag, so the version token degrades
		// to an empty one rather than blocking every save.
		expect(field(page.body, "version")).toBeTruthy();
		const res = await renderAndSave(h, {
			"value:CLAUDE_CODE_OAUTH_TOKEN": "a",
		});
		expect(res.statusCode).toBe(200);
	});

	it("refuses a conditional write with no version token rather than upserting", async () => {
		const secrets = new FakeRecordStore();
		const h = await provisioned(await harness({ secrets }));
		secrets.putRecordCalls.length = 0;
		const res = await post(h, "/setup/save", {
			csrf: h.csrf.issue(ALICE),
			"value:CLAUDE_CODE_OAUTH_TOKEN": "a",
		});
		expect(res.statusCode).toBe(409);
		expect(secrets.putRecordCalls).toHaveLength(0);
	});

	it("refuses a version token minted for another principal", async () => {
		const secrets = new FakeRecordStore();
		const h = await provisioned(await harness({ secrets }));
		await provisioned(h, BOB);
		const bobsPage = await get(h, "/setup", BOB);
		secrets.putRecordCalls.length = 0;
		const res = await post(h, "/setup/save", {
			csrf: h.csrf.issue(ALICE),
			version: field(bobsPage.body, "version"),
			"value:CLAUDE_CODE_OAUTH_TOKEN": "a",
		});
		expect(res.statusCode).toBe(409);
		expect(secrets.putRecordCalls).toHaveLength(0);
	});
});

describe("POST /setup/save — two-tab conflict (F8)", () => {
	it("409s the second save when both tabs rendered before either saved", async () => {
		const secrets = new FakeRecordStore();
		const h = await provisioned(await harness({ secrets }));

		// Tab A and tab B both load the page before either one saves. This is
		// the whole point: the version each tab carries is the one it SAW.
		const tabA = await get(h, "/setup", ALICE);
		const tabB = await get(h, "/setup", ALICE);

		const saveA = await post(h, "/setup/save", {
			csrf: field(tabA.body, "csrf"),
			version: field(tabA.body, "version"),
			"value:CLAUDE_CODE_OAUTH_TOKEN": "written-by-tab-a",
		});
		expect(saveA.statusCode).toBe(200);

		const saveB = await post(h, "/setup/save", {
			csrf: field(tabB.body, "csrf"),
			version: field(tabB.body, "version"),
			"value:CLAUDE_CODE_OAUTH_TOKEN": "written-by-tab-b",
		});
		expect(saveB.statusCode).toBe(409);
		expect(saveB.body).toMatch(/changed|conflict/i);

		// Tab A's write survives — the second save overwrote nothing.
		expect(await secrets.get(ALICE)).toMatchObject({
			CLAUDE_CODE_OAUTH_TOKEN: "written-by-tab-a",
		});
	});

	it("hands the conflicting tab a usable page: fresh csrf, fresh version, no values", async () => {
		const secrets = new FakeRecordStore();
		const h = await provisioned(await harness({ secrets }));
		const tabA = await get(h, "/setup", ALICE);
		const tabB = await get(h, "/setup", ALICE);
		await post(h, "/setup/save", {
			csrf: field(tabA.body, "csrf"),
			version: field(tabA.body, "version"),
			"value:CLAUDE_CODE_OAUTH_TOKEN": "written-by-tab-a",
		});
		const saveB = await post(h, "/setup/save", {
			csrf: field(tabB.body, "csrf"),
			version: field(tabB.body, "version"),
			"value:CLAUDE_CODE_OAUTH_TOKEN": "written-by-tab-b",
		});

		expect(saveB.statusCode).toBe(409);
		expect(saveB.body).not.toContain("written-by-tab-a");
		expect(saveB.body).not.toContain("written-by-tab-b");
		expect(h.csrf.verify(ALICE, field(saveB.body, "csrf"))).toBe(true);

		// Retrying with the version the conflict page handed back succeeds.
		const retry = await post(h, "/setup/save", {
			csrf: field(saveB.body, "csrf"),
			version: field(saveB.body, "version"),
			"value:CLAUDE_CODE_OAUTH_TOKEN": "written-by-tab-b",
		});
		expect(retry.statusCode).toBe(200);
		expect(await secrets.get(ALICE)).toMatchObject({
			CLAUDE_CODE_OAUTH_TOKEN: "written-by-tab-b",
		});
	});
});

/* ----------------------------------------------------------- applyEdits --- */

describe("applyEdits", () => {
	const current: UserSecretBundle = {
		CLAUDE_CODE_OAUTH_TOKEN: "old",
		MY_TOOL_KEY: "keep",
	};

	it("writes a non-empty value", () => {
		expect(
			applyEdits(current, { "value:MY_TOOL_KEY": ["new"] }, REQUIRED).next,
		).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "old", MY_TOOL_KEY: "new" });
	});

	it("leaves an empty value unchanged", () => {
		expect(
			applyEdits(current, { "value:MY_TOOL_KEY": [""] }, REQUIRED).next,
		).toEqual(current);
	});

	it("treats a whitespace-only submission as a real value", () => {
		expect(
			applyEdits(current, { "value:MY_TOOL_KEY": ["  "] }, REQUIRED).next
				.MY_TOOL_KEY,
		).toBe("  ");
	});

	it("clears when the clear checkbox is set", () => {
		expect(
			applyEdits(current, { "clear:MY_TOOL_KEY": ["on"] }, REQUIRED).next,
		).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "old", MY_TOOL_KEY: "" });
	});

	it("lets clear win over a simultaneously submitted value", () => {
		expect(
			applyEdits(
				current,
				{ "value:MY_TOOL_KEY": ["typed"], "clear:MY_TOOL_KEY": ["on"] },
				REQUIRED,
			).next.MY_TOOL_KEY,
		).toBe("");
	});

	it("keeps a cleared required key present rather than deleting it", () => {
		const { next } = applyEdits(
			current,
			{ "clear:CLAUDE_CODE_OAUTH_TOKEN": ["on"] },
			REQUIRED,
		);
		expect(Object.hasOwn(next, "CLAUDE_CODE_OAUTH_TOKEN")).toBe(true);
		expect(next.CLAUDE_CODE_OAUTH_TOKEN).toBe("");
	});

	it("ignores a field for a variable that no longer exists", () => {
		const { next, ignored } = applyEdits(
			current,
			{ "value:GONE": ["x"] },
			REQUIRED,
		);
		expect(next).toEqual(current);
		expect(ignored).toEqual(["GONE"]);
	});

	it("rejects a reserved name outright", () => {
		expect(() =>
			applyEdits(current, { "value:PATH": ["/evil"] }, REQUIRED),
		).toThrow(/reserved/);
	});

	it("rejects an invalid env name outright", () => {
		expect(() =>
			applyEdits(current, { "value:not-valid": ["x"] }, REQUIRED),
		).toThrow(/environment variable name/);
	});

	it("ignores non-prefixed fields such as csrf and version", () => {
		expect(
			applyEdits(current, { csrf: ["tok"], version: ["v"] }, REQUIRED).next,
		).toEqual(current);
	});

	it("takes the last value when a field is duplicated", () => {
		expect(
			applyEdits(current, { "value:MY_TOOL_KEY": ["a", "b"] }, REQUIRED).next
				.MY_TOOL_KEY,
		).toBe("b");
	});

	it("reports whether anything actually changed", () => {
		expect(applyEdits(current, {}, REQUIRED).changed).toBe(false);
		expect(
			applyEdits(current, { "value:MY_TOOL_KEY": ["new"] }, REQUIRED).changed,
		).toBe(true);
	});

	it("never mutates the bundle it was handed", () => {
		const snapshot = { ...current };
		applyEdits(current, { "value:MY_TOOL_KEY": ["new"] }, REQUIRED);
		expect(current).toEqual(snapshot);
	});
});
