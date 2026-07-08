import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import * as readline from "node:readline/promises";
import { Writable } from "node:stream";
import type { UserCredentialConfig } from "cyrus-core";
import { BaseCommand } from "./ICommand.js";

/** Slug for the per-user credentials directory, derived from the email local part. */
export function slugForEmail(email: string, taken: Set<string>): string {
	const base =
		email
			.split("@")[0]!
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "user";
	if (!taken.has(base)) return base;
	let n = 2;
	while (taken.has(`${base}-${n}`)) n++;
	return `${base}-${n}`;
}

/** Render the per-user .env file content from the collected secrets. */
export function buildUserEnvFile(input: {
	claudeToken?: string;
	githubPat?: string;
}): string {
	const lines: string[] = [];
	if (input.claudeToken) {
		lines.push(`CLAUDE_CODE_OAUTH_TOKEN=${input.claudeToken}`);
	}
	if (input.githubPat) {
		lines.push(`GH_TOKEN=${input.githubPat}`);
		lines.push(`GITHUB_TOKEN=${input.githubPat}`);
	}
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function userEmailOf(entry: UserCredentialConfig): string | undefined {
	if (typeof entry.linearUser === "object" && "email" in entry.linearUser) {
		return entry.linearUser.email;
	}
	return undefined;
}

/**
 * Manage per-user credential profiles for multi-user deployments.
 *
 *   cyrus users add             # interactive registration (idempotent per email)
 *   cyrus users list            # registered users (no secrets)
 *   cyrus users remove <email>  # remove from config (credential files kept)
 *
 * Hardening notes:
 * - Directory/file modes are enforced with chmod on EVERY run (Node's mkdir/
 *   writeFile `mode` only applies at creation, so re-registration over
 *   pre-existing permissive files must re-tighten them).
 * - Credential files are written BEFORE the config entry so a config
 *   hot-reload can never observe a profile whose files aren't ready.
 */
export class UsersCommand extends BaseCommand {
	async execute(args: string[]): Promise<void> {
		const [subcommand, ...rest] = args;
		switch (subcommand) {
			case "add":
				return this.add();
			case "list":
				return this.list();
			case "remove":
				return this.remove(rest[0]);
			default:
				this.exitWithError("Usage: cyrus users <add|list|remove <email>>");
		}
	}

	private async add(): Promise<void> {
		const rl = makePrompter();
		try {
			const email = (await rl.question("Linear account email: ")).trim();
			if (!email.includes("@")) {
				this.exitWithError("A valid email is required.");
			}

			const config = this.app.config.load();
			const users: UserCredentialConfig[] = config.users ?? [];
			const existing = users.find(
				(u) => userEmailOf(u)?.toLowerCase() === email.toLowerCase(),
			);
			if (existing) {
				this.logger.info(
					`${email} is already registered (${existing.credentialsDir}) — updating in place.`,
				);
			}

			const defaultName = email.split("@")[0]!;
			const gitName =
				(await rl.question(`Git author name [${defaultName}]: `)).trim() ||
				defaultName;
			const gitEmail =
				(await rl.question(`Git author email [${email}]: `)).trim() || email;

			const claudeToken = (
				await rl.questionSecret(
					"Claude Code OAuth token (from `claude setup-token`, blank to skip): ",
				)
			).trim();
			const githubPat = (
				await rl.questionSecret("GitHub PAT (blank to skip): ")
			).trim();
			const codexAuthPath = (
				await rl.question(
					"Path to Codex auth.json (from `codex login`, blank to skip): ",
				)
			).trim();
			if (codexAuthPath && !existsSync(codexAuthPath)) {
				this.exitWithError(`No file at ${codexAuthPath}`);
			}

			// Reuse the existing profile dir on re-registration (idempotent update)
			const usersRoot = join(this.app.cyrusHome, "users");
			mkdirSync(usersRoot, { recursive: true });
			const taken = new Set(readdirSync(usersRoot));
			const credentialsDir =
				existing?.credentialsDir ?? join(usersRoot, slugForEmail(email, taken));

			// 1) Credential files first, with modes re-enforced on every run
			mkdirSync(credentialsDir, { recursive: true });
			chmodSync(credentialsDir, 0o700);

			const envContent = buildUserEnvFile({
				claudeToken: claudeToken || undefined,
				githubPat: githubPat || undefined,
			});
			const envPath = join(credentialsDir, ".env");
			if (envContent) {
				writeFileSync(envPath, envContent);
				chmodSync(envPath, 0o600);
			} else if (!existsSync(envPath)) {
				this.logger.warn(
					"No credentials provided and no existing .env — this profile will be treated as unregistered until one exists.",
				);
			}

			if (codexAuthPath) {
				const codexDir = join(credentialsDir, "codex");
				mkdirSync(codexDir, { recursive: true });
				chmodSync(codexDir, 0o700);
				const authDest = join(codexDir, "auth.json");
				copyFileSync(codexAuthPath, authDest);
				chmodSync(authDest, 0o600);
			}

			// 2) Config entry last — a hot-reload between the writes above and
			// this save only ever sees a complete profile.
			const entry: UserCredentialConfig = {
				linearUser: { email },
				credentialsDir,
				gitAuthor: { name: gitName, email: gitEmail },
			};
			const updated = existing
				? users.map((u) => (u === existing ? entry : u))
				: [...users, entry];
			this.app.config.save({ ...config, users: updated });

			this.logSuccess(
				`${existing ? "Updated" : "Registered"} ${email} → ${credentialsDir}`,
			);
			this.logger.info(
				"The change takes effect on the next config reload (or cyrus restart).",
			);
		} finally {
			rl.close();
		}
	}

	private list(): void {
		const config = this.app.config.load();
		const users = config.users ?? [];
		if (users.length === 0) {
			this.logger.info(
				"No users registered. Multi-user mode is OFF (sessions use the global ~/.cyrus/.env credentials).",
			);
			return;
		}
		for (const u of users) {
			const who =
				typeof u.linearUser === "string"
					? u.linearUser
					: "email" in u.linearUser
						? u.linearUser.email
						: u.linearUser.id;
			const has = (p: string) =>
				existsSync(join(u.credentialsDir, p)) ? "yes" : "no";
			this.logger.info(
				`${who}  dir=${u.credentialsDir}  env=${has(".env")} codex=${has("codex/auth.json")} claude-dir=${has("claude")}`,
			);
		}
	}

	private remove(email: string | undefined): void {
		if (!email) {
			this.exitWithError("Usage: cyrus users remove <email>");
		}
		const config = this.app.config.load();
		const users = config.users ?? [];
		const remaining = users.filter(
			(u) => userEmailOf(u)?.toLowerCase() !== email.toLowerCase(),
		);
		if (remaining.length === users.length) {
			this.exitWithError(`No registered user with email ${email}`);
		}
		this.app.config.save({ ...config, users: remaining });
		this.logSuccess(
			`Removed ${email} from config. Credential files were NOT deleted — remove the directory manually if desired.`,
		);
	}
}

interface Prompter {
	question(q: string): Promise<string>;
	questionSecret(q: string): Promise<string>;
	close(): void;
}

/**
 * Interactive prompter. On a TTY, secrets are read with terminal echo muted.
 * On non-TTY stdin (piped/scripted input), lines are consumed through the
 * readline async iterator — sequential `rl.question` calls drop lines that
 * arrive in one chunk, so piped input needs the queued iterator instead.
 */
function makePrompter(): Prompter {
	if (!process.stdin.isTTY) {
		const rl = readline.createInterface({ input: process.stdin });
		const iterator = rl[Symbol.asyncIterator]();
		const ask = async (q: string): Promise<string> => {
			process.stdout.write(q);
			const next = await iterator.next();
			process.stdout.write("\n");
			return next.done ? "" : next.value;
		};
		return {
			question: ask,
			questionSecret: ask,
			close: () => rl.close(),
		};
	}

	const rl = readline.createInterface({
		input: process.stdin,
		output: process.stdout,
	});
	return {
		question: (q: string) => rl.question(q),
		questionSecret: async (q: string) => {
			process.stdout.write(q);
			const muted = new Writable({
				write(_chunk, _enc, cb) {
					cb();
				},
			});
			const secretRl = readline.createInterface({
				input: process.stdin,
				output: muted,
				terminal: true,
			});
			try {
				const answer = await secretRl.question("");
				process.stdout.write("\n");
				return answer;
			} finally {
				secretRl.close();
			}
		},
		close: () => rl.close(),
	};
}
