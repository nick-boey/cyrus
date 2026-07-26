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
