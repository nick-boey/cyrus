import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

/** Per-user container secrets: an env-var-name → value map. */
export type UserSecretBundle = Record<string, string>;

/** Legacy named secret keys → the container env-var names they map to. */
export const LEGACY_SECRET_KEY_MAP: Record<string, string> = {
	claudeOauthToken: "CLAUDE_CODE_OAUTH_TOKEN",
	githubPat: "GIT_TOKEN",
	gitUserName: "GIT_USER_NAME",
	gitUserEmail: "GIT_USER_EMAIL",
	dotfilesRepo: "DOTFILES_REPO",
};

/**
 * Env vars the router controls; a user may never override them. CYRUS_*
 * routing/identity + the two container bootstrap dirs
 * (CYRUS_WORKSPACES_DIR / CYRUS_REPO_CACHE_DIR, which decide where state and
 * credential-bearing config are written) hijack/redirect routing or state;
 * PATH/HOME/NODE_OPTIONS break or inject into the runtime. Shared by
 * `SecretStore.set` (hard reject) and `ContainerTargets.buildEnv`
 * (skip-with-warning).
 */
export const RESERVED_ENV_KEYS = [
	"CYRUS_ROUTER_URL",
	"CYRUS_DEVICE_TOKEN",
	"CYRUS_ISSUE_KEY",
	"CYRUS_REPOS_JSON",
	"CYRUS_WORKSPACES_DIR",
	"CYRUS_REPO_CACHE_DIR",
	"PATH",
	"HOME",
	"NODE_OPTIONS",
] as const;

/** Default "fully authenticated" set. The gate is additive on top of this. */
export const DEFAULT_REQUIRED_SECRET_KEYS = [
	"CLAUDE_CODE_OAUTH_TOKEN",
] as const;

/** POSIX-style environment variable name. */
export const VALID_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isReservedEnvKey(key: string): boolean {
	return (RESERVED_ENV_KEYS as readonly string[]).includes(key);
}

/** A key a user may store: a valid env-var name that is not reserved. */
export function isStorableSecretKey(key: string): boolean {
	return VALID_ENV_NAME_RE.test(key) && !isReservedEnvKey(key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Maps any legacy named keys in `raw` to their env-var names. Env-var-named
 * keys already present win over a legacy key mapping to the same name (the
 * legacy key is dropped). Idempotent: a fully-migrated bundle is unchanged.
 */
function migrateBundle(raw: Record<string, string>): UserSecretBundle {
	const out: UserSecretBundle = {};
	for (const [key, value] of Object.entries(raw)) {
		if (!Object.hasOwn(LEGACY_SECRET_KEY_MAP, key)) out[key] = value;
	}
	for (const [key, value] of Object.entries(raw)) {
		const envName = LEGACY_SECRET_KEY_MAP[key];
		if (envName && !Object.hasOwn(out, envName)) out[envName] = value;
	}
	return out;
}

/**
 * Per-user secret bundles for container launches, stored as a single JSON
 * file (keyed by lowercased email) next to router-config.json. Single-org
 * threat model: file perms (0600) are the protection boundary.
 */
export class SecretStore {
	constructor(private readonly filePath: string) {}

	/** Returns the user's bundle with legacy keys migrated to env-var names. */
	get(email: string): UserSecretBundle {
		return this.readAll()[email.toLowerCase()] ?? {};
	}

	/**
	 * Sets or (when `value === undefined`) unsets a single env var. A legacy
	 * key is normalized to its env-var name FIRST, so an update/unset targets
	 * the same key the migrated bundle exposes (otherwise a legacy update
	 * would write a second key that the old value shadows on the next read).
	 * Rejects reserved keys and non-env-var-name keys.
	 */
	set(email: string, key: string, value: string | undefined): void {
		const normalizedKey = LEGACY_SECRET_KEY_MAP[key] ?? key;
		if (isReservedEnvKey(normalizedKey)) {
			throw new Error(
				`"${normalizedKey}" is a reserved env var and cannot be stored as a per-user secret. Reserved: ${RESERVED_ENV_KEYS.join(", ")}`,
			);
		}
		if (!VALID_ENV_NAME_RE.test(normalizedKey)) {
			throw new Error(
				`"${normalizedKey}" is not a valid environment variable name (expected ${VALID_ENV_NAME_RE}).`,
			);
		}

		const all = this.readAll();
		const id = email.toLowerCase();
		const bundle = { ...(all[id] ?? {}) };
		if (value === undefined) {
			delete bundle[normalizedKey];
		} else {
			bundle[normalizedKey] = value;
		}
		if (Object.keys(bundle).length === 0) {
			delete all[id];
		} else {
			all[id] = bundle;
		}
		mkdirSync(dirname(this.filePath), { recursive: true });
		const tmp = `${this.filePath}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
		// `mode` on writeFileSync only applies on creation; force 0600 in case a
		// crash-leftover `.tmp` had looser perms.
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.filePath);
	}

	/**
	 * Reports whether a user has every key in `requiredKeys` set to a
	 * non-empty value. `missing` lists absent keys in the given order.
	 */
	isFullyAuthenticated(
		email: string,
		requiredKeys: readonly string[],
	): { ok: boolean; missing: string[] } {
		const bundle = this.get(email);
		const missing = requiredKeys.filter((key) => !bundle[key]);
		return { ok: missing.length === 0, missing };
	}

	private readAll(): Record<string, UserSecretBundle> {
		// A missing file is the documented "no secrets yet" state.
		if (!existsSync(this.filePath)) return {};
		// Once the file exists, any failure to read/parse — or a structurally
		// invalid shape — is a real error and must throw, never resolve to `{}`
		// (which a later `set()` would overwrite, destroying every user's data).
		let raw: string;
		try {
			raw = readFileSync(this.filePath, "utf-8");
		} catch (err) {
			throw new Error(
				`SecretStore: failed to read ${this.filePath}: ${(err as Error).message}`,
			);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (err) {
			throw new Error(
				`SecretStore: failed to parse ${this.filePath} as JSON: ${(err as Error).message}`,
			);
		}
		if (!isPlainObject(parsed)) {
			throw new Error(
				`SecretStore: ${this.filePath} is not a JSON object at the root`,
			);
		}
		const migrated: Record<string, UserSecretBundle> = {};
		for (const [id, bundle] of Object.entries(parsed)) {
			if (!isPlainObject(bundle)) {
				throw new Error(
					`SecretStore: ${this.filePath} entry for "${id}" is not an object`,
				);
			}
			for (const [key, value] of Object.entries(bundle)) {
				if (typeof value !== "string") {
					throw new Error(
						`SecretStore: ${this.filePath} value for "${id}.${key}" is not a string`,
					);
				}
			}
			migrated[id] = migrateBundle(bundle as Record<string, string>);
		}
		return migrated;
	}
}
