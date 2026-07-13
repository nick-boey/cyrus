import {
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
		renameSync(tmp, this.filePath);
	}

	private readAll(): Record<string, UserSecretBundle> {
		if (!existsSync(this.filePath)) return {};
		try {
			return JSON.parse(readFileSync(this.filePath, "utf-8")) as Record<
				string,
				UserSecretBundle
			>;
		} catch {
			return {};
		}
	}
}
