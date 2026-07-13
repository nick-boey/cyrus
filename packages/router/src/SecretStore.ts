import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface UserSecretBundle {
	claudeOauthToken?: string;
	githubPat?: string;
	gitUserName?: string;
	gitUserEmail?: string;
	dotfilesRepo?: string;
}

export const USER_SECRET_KEYS = [
	"claudeOauthToken",
	"githubPat",
	"gitUserName",
	"gitUserEmail",
	"dotfilesRepo",
] as const;

/**
 * Per-user secret bundles for container launches, stored as a single JSON
 * file (keyed by lowercased email) next to router-config.json. Single-org
 * threat model: file perms (0600) are the protection boundary.
 */
export class SecretStore {
	constructor(private readonly filePath: string) {}

	get(email: string): UserSecretBundle {
		return this.readAll()[email.toLowerCase()] ?? {};
	}

	set(
		email: string,
		key: keyof UserSecretBundle,
		value: string | undefined,
	): void {
		const all = this.readAll();
		const id = email.toLowerCase();
		const bundle = { ...(all[id] ?? {}) };
		if (value === undefined) {
			delete bundle[key];
		} else {
			bundle[key] = value;
		}
		if (Object.keys(bundle).length === 0) {
			delete all[id];
		} else {
			all[id] = bundle;
		}
		mkdirSync(dirname(this.filePath), { recursive: true });
		const tmp = `${this.filePath}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
		// `mode` on writeFileSync only applies when the file is created. If
		// `${filePath}.tmp` already existed (crash leftover, older code,
		// tampering) it may have looser permissions, so force 0600
		// unconditionally before the rename makes it the real secrets file.
		chmodSync(tmp, 0o600);
		renameSync(tmp, this.filePath);
	}

	private readAll(): Record<string, UserSecretBundle> {
		// A missing file is the documented "no secrets yet" state.
		if (!existsSync(this.filePath)) return {};
		// Once the file exists, any failure to read or parse it is a real
		// error (corruption, a transient I/O error, a TOCTOU race) and must
		// not be swallowed into `{}` — doing so would let a subsequent
		// `set()` silently overwrite the file and destroy every other
		// user's stored secrets.
		let raw: string;
		try {
			raw = readFileSync(this.filePath, "utf-8");
		} catch (err) {
			throw new Error(
				`SecretStore: failed to read ${this.filePath}: ${(err as Error).message}`,
			);
		}
		try {
			return JSON.parse(raw) as Record<string, UserSecretBundle>;
		} catch (err) {
			throw new Error(
				`SecretStore: failed to parse ${this.filePath} as JSON: ${(err as Error).message}`,
			);
		}
	}
}
