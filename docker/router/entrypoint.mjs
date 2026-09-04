#!/usr/bin/env node
/**
 * Container entrypoint for the Cyrus router image.
 *
 * Materializes <dataDir>/router-config.json from environment variables, then
 * spawns `cyrus router start` with --cyrus-home pointed at the data dir and
 * forwards SIGTERM/SIGINT so `docker stop` shuts the server down cleanly.
 *
 * Config precedence:
 *   1. Config env vars set and complete -> (re)generate router-config.json
 *      (env is the source of truth on every start).
 *   2. Config env vars set but incomplete -> exit 1 naming what is missing.
 *   3. No config env vars, router-config.json exists -> use the file as-is.
 *   4. Neither -> exit 1 listing the required variables.
 *
 * CYRUS_DATA_DIR and CYRUS_APP_PATH exist as test seams so this script can be
 * exercised outside the image; the Dockerfile relies on their defaults.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.CYRUS_DATA_DIR ?? "/data";
const APP_PATH = process.env.CYRUS_APP_PATH ?? "/app/dist/src/app.js";
const CONFIG_PATH = join(DATA_DIR, "router-config.json");

function fail(message) {
	console.error(`[entrypoint] ${message}`);
	process.exit(1);
}

/** Coerce a numeric env var, failing fast on malformed values. */
function toNumber(name, value) {
	const n = String(value).trim() === "" ? Number.NaN : Number(value);
	if (!Number.isFinite(n)) {
		fail(`${name} must be a number, got: ${value}`);
	}
	return n;
}

/** Coerce a boolean env var, failing fast on anything but "true"/"false". */
function toBoolean(name, value) {
	if (value !== "true" && value !== "false") {
		fail(`${name} must be "true" or "false", got: ${value}`);
	}
	return value === "true";
}

/** workspaces map from env: JSON escape hatch wins over the single ID+token pair. */
function buildWorkspaces(env) {
	if (env.CYRUS_ROUTER_WORKSPACES_JSON) {
		let parsed;
		try {
			parsed = JSON.parse(env.CYRUS_ROUTER_WORKSPACES_JSON);
		} catch (error) {
			fail(`CYRUS_ROUTER_WORKSPACES_JSON is not valid JSON: ${error.message}`);
		}
		if (
			typeof parsed !== "object" ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			fail(
				'CYRUS_ROUTER_WORKSPACES_JSON must be a JSON object: {"<workspace-id>": {"linearToken": "..."}}',
			);
		}
		return parsed;
	}
	if (env.LINEAR_WORKSPACE_ID && env.LINEAR_WORKSPACE_TOKEN) {
		return {
			[env.LINEAR_WORKSPACE_ID]: { linearToken: env.LINEAR_WORKSPACE_TOKEN },
		};
	}
	return undefined;
}

function parseObject(name, value) {
	let parsed;
	try {
		parsed = JSON.parse(value);
	} catch (error) {
		fail(`${name} is not valid JSON: ${error.message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		fail(`${name} must be a JSON object`);
	}
	return parsed;
}

function generateConfig(env) {
	const anyProvided = Boolean(
		env.CYRUS_ROUTER_WORKSPACES_JSON ||
			env.LINEAR_WORKSPACE_ID ||
			env.LINEAR_WORKSPACE_TOKEN ||
			env.LINEAR_WEBHOOK_SECRET ||
			env.CYRUS_ROUTER_CONTAINERS_JSON ||
			env.CYRUS_ROUTER_BACKUP_BLOB_URL ||
			env.CYRUS_ROUTER_ENTRA_TENANT_ID ||
			env.CYRUS_ROUTER_ENTRA_AUDIENCE ||
			env.CYRUS_ROUTER_ENTRA_ALLOWED_DOMAIN ||
			env.CYRUS_ROUTER_ENTRA_JWKS_URL ||
			env.CYRUS_ROUTER_ENTRA_CERT_ISSUER_ID ||
			env.CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL ||
			env.CYRUS_ROUTER_SETUP_UI_ENABLED ||
			env.CYRUS_ROUTER_FLEET_OPERATIONS_JSON,
	);

	if (!anyProvided) {
		if (existsSync(CONFIG_PATH)) {
			console.log(
				`[entrypoint] no config env vars set — using existing ${CONFIG_PATH}`,
			);
			return;
		}
		fail(
			"missing required environment variables: LINEAR_WORKSPACE_ID, LINEAR_WORKSPACE_TOKEN, LINEAR_WEBHOOK_SECRET. " +
				`Set them (see docker/router/.env.example) or mount a router-config.json at ${CONFIG_PATH}.`,
		);
	}

	const workspaces = buildWorkspaces(env);
	const missing = [];
	if (!workspaces) {
		missing.push(
			"LINEAR_WORKSPACE_ID + LINEAR_WORKSPACE_TOKEN (or CYRUS_ROUTER_WORKSPACES_JSON)",
		);
	}
	if (!env.LINEAR_WEBHOOK_SECRET) {
		missing.push("LINEAR_WEBHOOK_SECRET");
	}
	if (missing.length > 0) {
		fail(`missing required environment variables: ${missing.join(", ")}`);
	}

	const config = {
		port: env.CYRUS_ROUTER_PORT
			? toNumber("CYRUS_ROUTER_PORT", env.CYRUS_ROUTER_PORT)
			: 8787,
		host: env.CYRUS_ROUTER_HOST ?? "0.0.0.0",
		workspaces,
		webhook: {
			verificationMode: env.CYRUS_ROUTER_WEBHOOK_MODE ?? "direct",
			secret: env.LINEAR_WEBHOOK_SECRET,
		},
	};
	if (env.CYRUS_ROUTER_EVENT_TTL_MS) {
		config.eventTtlMs = toNumber(
			"CYRUS_ROUTER_EVENT_TTL_MS",
			env.CYRUS_ROUTER_EVENT_TTL_MS,
		);
	}
	if (env.CYRUS_ROUTER_ISSUE_LOCK) {
		config.issueLock = toBoolean(
			"CYRUS_ROUTER_ISSUE_LOCK",
			env.CYRUS_ROUTER_ISSUE_LOCK,
		);
	}
	if (env.CYRUS_ROUTER_CREATOR_ONLY_PROMPTING) {
		config.creatorOnlyPrompting = toBoolean(
			"CYRUS_ROUTER_CREATOR_ONLY_PROMPTING",
			env.CYRUS_ROUTER_CREATOR_ONLY_PROMPTING,
		);
	}
	if (env.CYRUS_ROUTER_HEARTBEAT_MS) {
		config.heartbeatMs = toNumber(
			"CYRUS_ROUTER_HEARTBEAT_MS",
			env.CYRUS_ROUTER_HEARTBEAT_MS,
		);
	}
	if (env.CYRUS_ROUTER_CONTAINERS_JSON) {
		config.containers = parseObject(
			"CYRUS_ROUTER_CONTAINERS_JSON",
			env.CYRUS_ROUTER_CONTAINERS_JSON,
		);
	}
	if (env.CYRUS_ROUTER_FLEET_OPERATIONS_JSON) {
		// Rendered whole by main.bicep and handed over verbatim, exactly like the
		// containers block. `cyrus router start` re-validates it against its own
		// Zod schema, so remapping fields here would only give the deployed shape
		// and the router's shape a way to drift apart.
		config.fleetOperations = parseObject(
			"CYRUS_ROUTER_FLEET_OPERATIONS_JSON",
			env.CYRUS_ROUTER_FLEET_OPERATIONS_JSON,
		);
	}
	if (env.CYRUS_ROUTER_BACKUP_BLOB_URL) {
		config.backup = {
			blobContainerUrl: env.CYRUS_ROUTER_BACKUP_BLOB_URL,
		};
	}
	const anyCanonicalEntra = Boolean(
		env.CYRUS_ROUTER_ENTRA_TENANT_ID ||
			env.CYRUS_ROUTER_ENTRA_AUDIENCE ||
			env.CYRUS_ROUTER_ENTRA_ALLOWED_DOMAIN,
	);
	const anyLegacyEntra = Boolean(
		env.CYRUS_ROUTER_ENTRA_JWKS_URL || env.CYRUS_ROUTER_ENTRA_CERT_ISSUER_ID,
	);
	if (anyCanonicalEntra || anyLegacyEntra) {
		const missingEntra = [];
		if (!env.CYRUS_ROUTER_ENTRA_TENANT_ID) {
			missingEntra.push("CYRUS_ROUTER_ENTRA_TENANT_ID");
		}
		if (!env.CYRUS_ROUTER_ENTRA_AUDIENCE) {
			missingEntra.push("CYRUS_ROUTER_ENTRA_AUDIENCE");
		}
		if (anyLegacyEntra && !env.CYRUS_ROUTER_ENTRA_JWKS_URL) {
			missingEntra.push("CYRUS_ROUTER_ENTRA_JWKS_URL");
		}
		if (anyLegacyEntra && !env.CYRUS_ROUTER_ENTRA_CERT_ISSUER_ID) {
			missingEntra.push("CYRUS_ROUTER_ENTRA_CERT_ISSUER_ID");
		}
		if (missingEntra.length > 0) {
			fail(
				`missing required environment variables: ${missingEntra.join(", ")}`,
			);
		}
		config.entra = {
			...(anyCanonicalEntra
				? {
						tenantId: env.CYRUS_ROUTER_ENTRA_TENANT_ID,
						audience: env.CYRUS_ROUTER_ENTRA_AUDIENCE,
						...(env.CYRUS_ROUTER_ENTRA_ALLOWED_DOMAIN
							? { allowedDomain: env.CYRUS_ROUTER_ENTRA_ALLOWED_DOMAIN }
							: {}),
					}
				: {}),
			...(anyLegacyEntra
				? {
						jwksUrl: env.CYRUS_ROUTER_ENTRA_JWKS_URL,
						certificateIssuerId: env.CYRUS_ROUTER_ENTRA_CERT_ISSUER_ID,
					}
				: {}),
		};
	}
	if (env.CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL) {
		config.linearTokenStore = {
			keyVaultUrl: env.CYRUS_ROUTER_LINEAR_TOKEN_STORE_KEY_VAULT_URL,
		};
	}
	if (env.CYRUS_ROUTER_SETUP_UI_ENABLED === "true") {
		// `auth` is deliberately required by the router when enabled — an
		// ambiguous strategy refuses to start rather than serving /setup with no
		// enforceable trust boundary. easyauth-headers additionally demands
		// CYRUS_ROUTER_SETUP_UI_VERIFIED_HEADER_STRIP=true, which an operator
		// sets by hand only after verifying live that the ACA ingress strips
		// client-supplied X-MS-CLIENT-PRINCIPAL* headers.
		const mode = env.CYRUS_ROUTER_SETUP_UI_AUTH_MODE;
		let auth;
		if (mode === "entra-token") {
			if (!env.CYRUS_ROUTER_SETUP_UI_ID_TOKEN_AUDIENCE) {
				fail(
					"missing required environment variables: CYRUS_ROUTER_SETUP_UI_ID_TOKEN_AUDIENCE (required by CYRUS_ROUTER_SETUP_UI_AUTH_MODE=entra-token)",
				);
			}
			auth = {
				mode,
				idTokenAudience: env.CYRUS_ROUTER_SETUP_UI_ID_TOKEN_AUDIENCE,
			};
		} else if (mode === "easyauth-headers") {
			if (env.CYRUS_ROUTER_SETUP_UI_VERIFIED_HEADER_STRIP !== "true") {
				fail(
					"CYRUS_ROUTER_SETUP_UI_AUTH_MODE=easyauth-headers requires CYRUS_ROUTER_SETUP_UI_VERIFIED_HEADER_STRIP=true. Set it only after verifying live that the ingress strips client-supplied X-MS-CLIENT-PRINCIPAL* headers; prefer entra-token, which does not depend on proxy topology.",
				);
			}
			auth = { mode, verifiedHeaderStrip: true };
		} else if (mode === "dev-insecure-headers") {
			auth = { mode };
		} else {
			fail(
				`CYRUS_ROUTER_SETUP_UI_AUTH_MODE must be one of "entra-token", "easyauth-headers", "dev-insecure-headers" (got ${JSON.stringify(mode)})`,
			);
		}
		config.setupUi = {
			enabled: true,
			auth,
			...(env.CYRUS_ROUTER_SETUP_UI_ALLOWED_DOMAIN
				? { allowedDomain: env.CYRUS_ROUTER_SETUP_UI_ALLOWED_DOMAIN }
				: {}),
			...(env.CYRUS_ROUTER_SETUP_UI_AUTO_PROVISION
				? {
						autoProvisionUsers:
							env.CYRUS_ROUTER_SETUP_UI_AUTO_PROVISION === "true",
					}
				: {}),
		};
	}

	mkdirSync(DATA_DIR, { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
		mode: 0o600,
	});
	// writeFileSync's mode only applies on creation; enforce on regeneration too.
	chmodSync(CONFIG_PATH, 0o600);
	console.log(`[entrypoint] wrote ${CONFIG_PATH} from environment variables`);
}

generateConfig(process.env);

const child = spawn(
	process.execPath,
	[APP_PATH, "--cyrus-home", DATA_DIR, "router", "start"],
	{ stdio: "inherit" },
);
for (const signal of ["SIGTERM", "SIGINT"]) {
	process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
	process.exit(code ?? (signal ? 1 : 0));
});
