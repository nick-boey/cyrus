import { describe, expect, it } from "vitest";
import {
	ALL_CREDENTIAL_ENV_KEYS,
	scrubCredentialEnv,
} from "../src/credential-env.js";

describe("scrubCredentialEnv", () => {
	const base = {
		ANTHROPIC_API_KEY: "global-api-key",
		CLAUDE_CODE_OAUTH_TOKEN: "global-oauth",
		ANTHROPIC_AUTH_TOKEN: "global-auth",
		OPENAI_API_KEY: "global-openai",
		GH_TOKEN: "global-gh",
		GITHUB_TOKEN: "global-github",
		GIT_AUTHOR_NAME: "Global Bot",
		GIT_AUTHOR_EMAIL: "bot@org.com",
		GIT_COMMITTER_NAME: "Global Bot",
		GIT_COMMITTER_EMAIL: "bot@org.com",
		PATH: "/usr/bin",
		HOME: "/home/host",
	};

	it("removes every credential group key", () => {
		const result = scrubCredentialEnv(base);
		for (const key of ALL_CREDENTIAL_ENV_KEYS) {
			expect(result[key]).toBeUndefined();
		}
	});

	it("preserves non-credential keys", () => {
		const result = scrubCredentialEnv(base);
		expect(result.PATH).toBe("/usr/bin");
		expect(result.HOME).toBe("/home/host");
	});

	it("does not mutate the input", () => {
		scrubCredentialEnv(base);
		expect(base.ANTHROPIC_API_KEY).toBe("global-api-key");
	});

	it("handles an env with no credential keys", () => {
		expect(scrubCredentialEnv({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
	});
});
