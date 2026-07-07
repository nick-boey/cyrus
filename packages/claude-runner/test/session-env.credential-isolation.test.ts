import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { serializeQueryOptionsReplacer } from "../src/ClaudeRunner.js";
import { composeSessionEnv } from "../src/session-env.js";

describe("composeSessionEnv credential isolation", () => {
	const savedEnv: Record<string, string | undefined> = {};
	const globalKeys = [
		"ANTHROPIC_API_KEY",
		"CLAUDE_CODE_OAUTH_TOKEN",
		"OPENAI_API_KEY",
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"GIT_AUTHOR_NAME",
	];

	beforeEach(() => {
		for (const key of globalKeys) {
			savedEnv[key] = process.env[key];
		}
		process.env.ANTHROPIC_API_KEY = "global-api-key";
		process.env.CLAUDE_CODE_OAUTH_TOKEN = "global-oauth";
		process.env.OPENAI_API_KEY = "global-openai";
		process.env.GH_TOKEN = "global-gh";
		process.env.GITHUB_TOKEN = "global-github";
		process.env.GIT_AUTHOR_NAME = "Global Bot";
	});

	afterEach(() => {
		for (const key of globalKeys) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	it("keeps global credentials without isolation (single-user mode)", () => {
		const env = composeSessionEnv({});
		expect(env.ANTHROPIC_API_KEY).toBe("global-api-key");
		expect(env.GITHUB_TOKEN).toBe("global-github");
	});

	it("scrubs every global credential group under isolation", () => {
		const env = composeSessionEnv({
			credentialIsolation: true,
			additionalEnv: { CLAUDE_CODE_OAUTH_TOKEN: "user-oauth" },
		});
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.GH_TOKEN).toBeUndefined();
		expect(env.GITHUB_TOKEN).toBeUndefined();
		expect(env.GIT_AUTHOR_NAME).toBeUndefined();
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("user-oauth");
	});

	it("scrubs credentials reintroduced by the repository .env", () => {
		const env = composeSessionEnv({
			credentialIsolation: true,
			repositoryEnv: { ANTHROPIC_API_KEY: "repo-key", CUSTOM_VAR: "kept" },
			additionalEnv: { GH_TOKEN: "user-pat" },
		});
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.CUSTOM_VAR).toBe("kept");
		expect(env.GH_TOKEN).toBe("user-pat");
	});

	it("keeps non-credential env like PATH under isolation", () => {
		const env = composeSessionEnv({ credentialIsolation: true });
		expect(env.PATH).toBe(process.env.PATH);
	});
});

describe("serializeQueryOptionsReplacer credential redaction", () => {
	it("redacts credential-shaped keys in debug serialization", () => {
		const options = {
			env: {
				ANTHROPIC_API_KEY: "sk-secret",
				CLAUDE_CODE_OAUTH_TOKEN: "oauth-secret",
				GH_TOKEN: "gh-secret",
				PATH: "/usr/bin",
			},
		};
		const serialized = JSON.parse(
			JSON.stringify(options, serializeQueryOptionsReplacer),
		);
		expect(serialized.env.ANTHROPIC_API_KEY).toBe("[REDACTED]");
		expect(serialized.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("[REDACTED]");
		expect(serialized.env.GH_TOKEN).toBe("[REDACTED]");
		expect(serialized.env.PATH).toBe("/usr/bin");
	});
});
