import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ENTRYPOINT = fileURLToPath(new URL("./entrypoint.mjs", import.meta.url));

function run(extra = {}) {
	const dir = mkdtempSync(join(tmpdir(), "router-entrypoint-"));
	const app = join(dir, "app.mjs");
	writeFileSync(app, "");
	const result = spawnSync(process.execPath, [ENTRYPOINT], {
		encoding: "utf8",
		env: {
			PATH: process.env.PATH,
			CYRUS_DATA_DIR: dir,
			CYRUS_APP_PATH: app,
			LINEAR_WORKSPACE_ID: "ws-1",
			LINEAR_WORKSPACE_TOKEN: "token",
			LINEAR_WEBHOOK_SECRET: "secret",
			...extra,
		},
	});
	const configPath = join(dir, "router-config.json");
	return {
		...result,
		config:
			result.status === 0
				? JSON.parse(readFileSync(configPath, "utf8"))
				: undefined,
	};
}

test("optional Azure env is absent by default", () => {
	const result = run();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.config.containers, undefined);
	assert.equal(result.config.backup, undefined);
	assert.equal(result.config.entra, undefined);
	assert.equal(result.config.linearTokenStore, undefined);
});

test("maps CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL into linearTokenStore", () => {
	const result = run({
		CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL:
			"https://kv-cyrus-dev.vault.azure.net/",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(result.config.linearTokenStore, {
		keyVaultUrl: "https://kv-cyrus-dev.vault.azure.net/",
	});
});

test("passes containers, backup and complete Entra config through", () => {
	const containers = {
		image: "worker",
		repositories: [],
		keyVaultUrl: "https://vault",
	};
	const result = run({
		CYRUS_ROUTER_CONTAINERS_JSON: JSON.stringify(containers),
		CYRUS_ROUTER_BACKUP_BLOB_URL: "https://storage/backups",
		CYRUS_ROUTER_ENTRA_TENANT_ID: "tenant-id",
		CYRUS_ROUTER_ENTRA_AUDIENCE: "api://router",
		CYRUS_ROUTER_ENTRA_ALLOWED_DOMAIN: "example.com",
		CYRUS_ROUTER_ENTRA_JWKS_URL: "https://login/keys",
		CYRUS_ROUTER_ENTRA_CERT_ISSUER_ID: "issuer-id",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(result.config.containers, containers);
	assert.deepEqual(result.config.backup, {
		blobContainerUrl: "https://storage/backups",
	});
	assert.deepEqual(result.config.entra, {
		tenantId: "tenant-id",
		audience: "api://router",
		allowedDomain: "example.com",
		jwksUrl: "https://login/keys",
		certificateIssuerId: "issuer-id",
	});
});

test("rejects malformed and array containers JSON", () => {
	for (const value of ["{bad", "[]"]) {
		const result = run({ CYRUS_ROUTER_CONTAINERS_JSON: value });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /CYRUS_ROUTER_CONTAINERS_JSON/);
	}
});

test("an incomplete Entra group names the exact missing variable", () => {
	const result = run({ CYRUS_ROUTER_ENTRA_JWKS_URL: "https://login/keys" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /CYRUS_ROUTER_ENTRA_TENANT_ID/);
	assert.match(result.stderr, /CYRUS_ROUTER_ENTRA_AUDIENCE/);
	assert.match(result.stderr, /CYRUS_ROUTER_ENTRA_CERT_ISSUER_ID/);
});

test("an incomplete canonical Entra group names tenant and audience precisely", () => {
	const result = run({ CYRUS_ROUTER_ENTRA_ALLOWED_DOMAIN: "example.com" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /CYRUS_ROUTER_ENTRA_TENANT_ID/);
	assert.match(result.stderr, /CYRUS_ROUTER_ENTRA_AUDIENCE/);
});

test("setupUi is absent unless explicitly enabled", () => {
	const result = run();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.config.setupUi, undefined);
});

test("maps the entra-token strategy into setupUi", () => {
	const result = run({
		CYRUS_ROUTER_SETUP_UI_ENABLED: "true",
		CYRUS_ROUTER_SETUP_UI_AUTH_MODE: "entra-token",
		CYRUS_ROUTER_SETUP_UI_ID_TOKEN_AUDIENCE: "client-id-guid",
		CYRUS_ROUTER_SETUP_UI_ALLOWED_DOMAIN: "example.com",
		CYRUS_ROUTER_SETUP_UI_AUTO_PROVISION: "true",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(result.config.setupUi, {
		enabled: true,
		auth: { mode: "entra-token", idTokenAudience: "client-id-guid" },
		allowedDomain: "example.com",
		autoProvisionUsers: true,
	});
});

test("entra-token without an audience names the missing variable", () => {
	const result = run({
		CYRUS_ROUTER_SETUP_UI_ENABLED: "true",
		CYRUS_ROUTER_SETUP_UI_AUTH_MODE: "entra-token",
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /CYRUS_ROUTER_SETUP_UI_ID_TOKEN_AUDIENCE/);
});

test("easyauth-headers refuses without the verified header-strip flag", () => {
	const result = run({
		CYRUS_ROUTER_SETUP_UI_ENABLED: "true",
		CYRUS_ROUTER_SETUP_UI_AUTH_MODE: "easyauth-headers",
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /VERIFIED_HEADER_STRIP/);
});

test("easyauth-headers is accepted once the header strip is verified", () => {
	const result = run({
		CYRUS_ROUTER_SETUP_UI_ENABLED: "true",
		CYRUS_ROUTER_SETUP_UI_AUTH_MODE: "easyauth-headers",
		CYRUS_ROUTER_SETUP_UI_VERIFIED_HEADER_STRIP: "true",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(result.config.setupUi.auth, {
		mode: "easyauth-headers",
		verifiedHeaderStrip: true,
	});
});

test("an unrecognised auth mode is refused rather than defaulted", () => {
	const result = run({
		CYRUS_ROUTER_SETUP_UI_ENABLED: "true",
		CYRUS_ROUTER_SETUP_UI_AUTH_MODE: "trust-me",
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /CYRUS_ROUTER_SETUP_UI_AUTH_MODE/);
});

test("autoProvisionUsers is not enabled by a non-true value", () => {
	const result = run({
		CYRUS_ROUTER_SETUP_UI_ENABLED: "true",
		CYRUS_ROUTER_SETUP_UI_AUTH_MODE: "dev-insecure-headers",
		CYRUS_ROUTER_SETUP_UI_AUTO_PROVISION: "yes",
	});
	assert.equal(result.status, 0, result.stderr);
	assert.equal(result.config.setupUi.autoProvisionUsers, false);
});

test("SETUP_UI_ENABLED alone regenerates config rather than being ignored", () => {
	// The anyProvided gate: an env var missing from that list is silently
	// dropped whenever a config file already exists.
	const result = run({ CYRUS_ROUTER_SETUP_UI_ENABLED: "true" });
	// Fails on the auth mode, which proves the gate fired and generation ran.
	assert.equal(result.status, 1);
	assert.match(result.stderr, /CYRUS_ROUTER_SETUP_UI_AUTH_MODE/);
});
