/**
 * Credential-bearing environment variable groups shared by the runner
 * packages. Used for multi-user credential isolation: when a session runs
 * with a per-user credential bundle, ALL of these keys are scrubbed from the
 * inherited (global) environment first, so a session can never silently fall
 * back to the host's shared identity for a provider the user didn't register.
 */
export const CREDENTIAL_ENV_GROUPS = {
	/** Claude Code / Anthropic auth. ANTHROPIC_API_KEY would otherwise take
	 * precedence inside Claude Code and shadow an injected OAuth token. */
	claudeAuth: [
		"ANTHROPIC_API_KEY",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"ANTHROPIC_AUTH_TOKEN",
	],
	/** OpenAI/Codex auth. A global OPENAI_API_KEY would shadow per-user
	 * ChatGPT-subscription auth resolved from CODEX_HOME/auth.json. */
	openaiAuth: ["OPENAI_API_KEY"],
	/** GitHub tokens consumed by gh and gh-as-git-credential-helper. */
	github: ["GH_TOKEN", "GITHUB_TOKEN"],
	/** Git commit attribution identity. */
	gitAuthor: [
		"GIT_AUTHOR_NAME",
		"GIT_AUTHOR_EMAIL",
		"GIT_COMMITTER_NAME",
		"GIT_COMMITTER_EMAIL",
	],
} as const;

/** Flat list of every credential env key across all groups. */
export const ALL_CREDENTIAL_ENV_KEYS: readonly string[] = Object.values(
	CREDENTIAL_ENV_GROUPS,
).flat();

/**
 * Return a copy of `env` with every credential-group key removed.
 * Does not mutate the input.
 */
export function scrubCredentialEnv(
	env: Record<string, string>,
): Record<string, string> {
	const scrubbed = { ...env };
	for (const key of ALL_CREDENTIAL_ENV_KEYS) {
		delete scrubbed[key];
	}
	return scrubbed;
}
