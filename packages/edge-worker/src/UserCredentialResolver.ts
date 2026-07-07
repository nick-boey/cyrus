import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
	GitCommitAuthorConfig,
	ILogger,
	SessionCreator,
	UserCredentialConfig,
} from "cyrus-core";
import dotenv from "dotenv";
import { userMatchesIdentifier } from "./UserAccessControl.js";

/**
 * Credential env keys read from a user's `<credentialsDir>/.env`.
 * Anything else in that file is intentionally ignored so a stray var
 * can't silently alter session behavior.
 */
const CREDENTIAL_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"ANTHROPIC_AUTH_TOKEN",
	"OPENAI_API_KEY",
	"GH_TOKEN",
	"GITHUB_TOKEN",
] as const;

/** Message posted when an unregistered user starts/prompts a session. */
export const DEFAULT_UNREGISTERED_USER_MESSAGE =
	"{{userName}}, you don't have credentials registered with this Cyrus deployment, so I can't run this session as you. Ask your Cyrus admin to run `cyrus users add` on the host to register your Claude, Codex, and GitHub credentials.";

/**
 * Thrown by the fail-closed backstop when a Linear session reaches runner
 * config assembly in multi-user mode without a resolvable credential
 * profile (unregistered creator, pre-feature session with no stored
 * creator, or a user deregistered mid-flight).
 */
export class UnregisteredUserError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnregisteredUserError";
	}
}

export interface UserCredentialProfile {
	credentialsDir: string;
	/** Env vars to inject into the session subprocess (and its children). */
	env: Record<string, string>;
}

/**
 * Resolves the Linear session creator to a per-user credential env bundle.
 *
 * When `users` is non-empty ("multi-user mode"), Linear sessions run with
 * the creator's credentials; a creator with no profile (or a profile whose
 * `.env` is missing) is treated as unregistered and must be blocked by the
 * caller. Credentials follow the session creator, not later prompters.
 */
export class UserCredentialResolver {
	private users: UserCredentialConfig[] | undefined;
	private gitCommitAuthor: GitCommitAuthorConfig | undefined;
	private logger: ILogger;

	constructor(
		users: UserCredentialConfig[] | undefined,
		gitCommitAuthor: GitCommitAuthorConfig | undefined,
		logger: ILogger,
	) {
		this.users = users;
		this.gitCommitAuthor = gitCommitAuthor;
		this.logger = logger;
	}

	/** Replace the registry on config hot-reload. */
	setConfig(
		users: UserCredentialConfig[] | undefined,
		gitCommitAuthor: GitCommitAuthorConfig | undefined,
	): void {
		this.users = users;
		this.gitCommitAuthor = gitCommitAuthor;
	}

	/** Multi-user mode is on whenever at least one user is registered. */
	isEnabled(): boolean {
		return (this.users?.length ?? 0) > 0;
	}

	/**
	 * Resolve a session creator to their credential profile.
	 * Returns null when multi-user mode is off, the creator is unknown,
	 * or the profile's `.env` file is unreadable (treated as unregistered).
	 */
	resolve(creator: SessionCreator | undefined): UserCredentialProfile | null {
		if (!this.isEnabled() || !creator) {
			return null;
		}

		const matches = this.users!.filter((u) =>
			userMatchesIdentifier(creator.id, creator.email, u.linearUser),
		);
		if (matches.length === 0) {
			return null;
		}
		if (matches.length > 1) {
			this.logger.warn(
				`Multiple user credential entries match ${creator.email ?? creator.id} — using the first (${matches[0]!.credentialsDir})`,
			);
		}
		const entry = matches[0]!;

		const envPath = join(entry.credentialsDir, ".env");
		if (!existsSync(envPath)) {
			this.logger.warn(
				`User credential profile matched for ${creator.email ?? creator.id} but ${envPath} is missing — treating as unregistered`,
			);
			return null;
		}

		let parsed: Record<string, string>;
		try {
			parsed = dotenv.parse(readFileSync(envPath, "utf8"));
		} catch (error) {
			this.logger.warn(`Failed to read ${envPath}:`, error);
			return null;
		}

		const env: Record<string, string> = {};
		for (const key of CREDENTIAL_ENV_KEYS) {
			if (parsed[key]) {
				env[key] = parsed[key];
			}
		}

		const codexHome = join(entry.credentialsDir, "codex");
		if (existsSync(codexHome)) {
			env.CODEX_HOME = codexHome;
		}
		const claudeConfigDir = join(entry.credentialsDir, "claude");
		if (existsSync(claudeConfigDir)) {
			env.CLAUDE_CONFIG_DIR = claudeConfigDir;
		}

		const mode = this.gitCommitAuthor?.mode ?? "user";
		const author =
			mode === "user" ? entry.gitAuthor : this.gitCommitAuthor?.shared;
		if (author) {
			env.GIT_AUTHOR_NAME = author.name;
			env.GIT_AUTHOR_EMAIL = author.email;
			env.GIT_COMMITTER_NAME = author.name;
			env.GIT_COMMITTER_EMAIL = author.email;
		}

		return { credentialsDir: entry.credentialsDir, env };
	}
}
