import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { RunnerType } from "cyrus-core";
import { CODEX_AUTH_JSON_ENV } from "./setup/codexAuth.js";
import {
	DEFAULT_RUNNER_ENV,
	MODEL_ENV_BY_RUNNER,
} from "./setup/runnerDefaults.js";

/** Per-user container secrets: an env-var-name → value map. */
export type UserSecretBundle = Record<string, string>;

/** Async storage contract shared by the file and Azure Key Vault backends. */
export interface SecretStoreBackend {
	get(email: string): UserSecretBundle | Promise<UserSecretBundle>;
	set(
		email: string,
		key: string,
		value: string | undefined,
	): void | Promise<void>;
	isFullyAuthenticated(
		email: string,
		requiredKeys: readonly string[],
	):
		| { ok: boolean; missing: string[] }
		| Promise<{ ok: boolean; missing: string[] }>;
}

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
	// Tracing switches are propagated from the ROUTER's own env
	// (`ContainerTargets.buildEnv`), and must stay in lockstep with it. A user
	// who could set these per-sandbox could produce a trace the router sampled
	// and the worker did not — a half-collected trace, which renders as a
	// complete story with a hole in the middle. See
	// `docs/adr/0004-parent-based-head-sampling-for-traces.md`.
	"CYRUS_OTEL_TRACES_ENABLED",
	"CYRUS_OTEL_TRACES_SAMPLE_RATIO",
	// The runner/model picker on `/setup`. Once the router owns these keys, a
	// stale hand-typed variable must not shadow the picker — the user would
	// change their default, see it saved, and get the old runner anyway, with
	// nothing anywhere saying why.
	DEFAULT_RUNNER_ENV,
	MODEL_ENV_BY_RUNNER.claude,
	MODEL_ENV_BY_RUNNER.codex,
	// The router is the sole holder and sole refresher of a user's Codex
	// subscription credential (ADR 0005). A hand-set value would shadow the
	// freshly-minted token with a stale one and reintroduce exactly the
	// rotation race that decision exists to dissolve — and it would fail
	// invisibly, because the boot step cannot tell a user's paste from the
	// router's injection.
	CODEX_AUTH_JSON_ENV,
	"PATH",
	"HOME",
	"NODE_OPTIONS",
] as const;

/**
 * The credentials each runner needs before a container can usefully boot.
 *
 * This used to be a flat `["CLAUDE_CODE_OAUTH_TOKEN"]`, which made
 * "select Codex as your default" a lie: a codex-only user could not boot a
 * container at all, because the boot gate demanded an Anthropic credential
 * they had no reason to hold.
 *
 * Codex requires nothing here on purpose. Its credential is a router-held
 * ChatGPT subscription token that never lives in the secret bundle (ADR 0005),
 * with `OPENAI_API_KEY` as the documented fallback — so neither is a bundle key
 * the readiness banner can meaningfully demand. A Codex user with no usable
 * credential fails at boot with a message naming the remedy, which is the
 * failure this table cannot express and {@link CodexTokenService} can.
 *
 * OpenCode requires nothing here for a different reason: it is a multi-provider
 * harness whose credential depends on the provider the chosen model names, so
 * there is no single key to demand. It is also not selectable in the cloud
 * picker, so this entry is not reached today.
 */
export const RUNNER_REQUIRED_SECRET_KEYS: Record<
	RunnerType,
	readonly string[]
> = {
	claude: ["CLAUDE_CODE_OAUTH_TOKEN"],
	codex: [],
	gemini: [],
	cursor: [],
	opencode: [],
};

/**
 * Default "fully authenticated" set for a user with no stored runner
 * preference. The gate is additive on top of this.
 *
 * Kept as the Claude set because that is what an unset preference resolves to
 * downstream (`RunnerSelectionService.getDefaultRunner` falls back to
 * `"claude"`), so the readiness banner keeps asking for exactly the credential
 * such a user's sessions will actually try to use.
 */
export const DEFAULT_REQUIRED_SECRET_KEYS = RUNNER_REQUIRED_SECRET_KEYS.claude;

/**
 * The one expression for "which variables must this user have set".
 *
 * There is deliberately a single implementation rather than one per caller:
 * the `/setup` readiness banner, the record backfill in `SetupBootstrap`, and
 * the boot gate in `ContainerTargets.buildEnv` must never disagree, because
 * the failure mode when they do is a page that says "all set" above a
 * container that refuses to boot.
 */
export function requiredSecretKeysFor(
	runner: RunnerType | undefined,
	extra: readonly string[] | undefined,
): string[] {
	const runnerKeys =
		(runner ? RUNNER_REQUIRED_SECRET_KEYS[runner] : undefined) ??
		DEFAULT_REQUIRED_SECRET_KEYS;
	return [...new Set([...runnerKeys, ...(extra ?? [])])];
}

/** POSIX-style environment variable name. */
export const VALID_ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isReservedEnvKey(key: string): boolean {
	return (RESERVED_ENV_KEYS as readonly string[]).includes(key);
}

/**
 * Keys that became reserved AFTER users could already store them.
 *
 * Everything else in {@link RESERVED_ENV_KEYS} has been reserved since before
 * any bundle existed, so a form submitting one can only be tampered with — and
 * `applyEdits` fails the whole save, deliberately, rather than making an attack
 * look like a success.
 *
 * These four are different: they were ordinary variables until the `/setup`
 * runner picker took ownership of them (NOR-364), so a user may hold one
 * legitimately, from before. Failing their save would leave them unable to
 * change anything at all until an operator edited their record by hand, which
 * is a worse outcome than treating the field as stale — which is what it is.
 */
export const LATE_RESERVED_ENV_KEYS: readonly string[] = [
	DEFAULT_RUNNER_ENV,
	MODEL_ENV_BY_RUNNER.claude,
	MODEL_ENV_BY_RUNNER.codex,
	CODEX_AUTH_JSON_ENV,
];

export function isLateReservedEnvKey(key: string): boolean {
	return LATE_RESERVED_ENV_KEYS.includes(key);
}

/** A key a user may store: a valid env-var name that is not reserved. */
export function isStorableSecretKey(key: string): boolean {
	return VALID_ENV_NAME_RE.test(key) && !isReservedEnvKey(key);
}

/** Normalizes legacy names and applies the common backend validation rules. */
export function normalizeSecretKey(key: string): string {
	const normalizedKey = Object.hasOwn(LEGACY_SECRET_KEY_MAP, key)
		? LEGACY_SECRET_KEY_MAP[key]!
		: key;
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
	return normalizedKey;
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
		const envName = Object.hasOwn(LEGACY_SECRET_KEY_MAP, key)
			? LEGACY_SECRET_KEY_MAP[key]
			: undefined;
		if (envName && !Object.hasOwn(out, envName)) out[envName] = value;
	}
	return out;
}

/**
 * Per-user secret bundles for container launches, stored as a single JSON
 * file (keyed by lowercased email) next to router-config.json. Single-org
 * threat model: file perms (0600) are the protection boundary.
 */
export class FileSecretStore implements SecretStoreBackend {
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
		const normalizedKey = normalizeSecretKey(key);

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
		const missing = requiredKeys.filter(
			(key) => !(Object.hasOwn(bundle, key) && bundle[key]),
		);
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

/** Backward-compatible class export for the original file-backed store. */
export { FileSecretStore as SecretStore };
