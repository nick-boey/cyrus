import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexConfigBuilder } from "../src/config/CodexConfigBuilder.js";
import type { CodexRunnerConfig } from "../src/types.js";

describe("CodexConfigBuilder env handling", () => {
	let codexHome: string;
	const savedEnv: Record<string, string | undefined> = {};
	const globalKeys = [
		"OPENAI_API_KEY",
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"GIT_AUTHOR_NAME",
	];

	beforeEach(() => {
		codexHome = mkdtempSync(join(tmpdir(), "cyrus-codex-home-"));
		for (const key of globalKeys) {
			savedEnv[key] = process.env[key];
		}
		process.env.OPENAI_API_KEY = "global-openai";
		process.env.GH_TOKEN = "global-gh";
		process.env.GITHUB_TOKEN = "global-github";
		process.env.GIT_AUTHOR_NAME = "Global Bot";
	});

	afterEach(() => {
		rmSync(codexHome, { recursive: true, force: true });
		for (const key of globalKeys) {
			if (savedEnv[key] === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = savedEnv[key];
			}
		}
	});

	function makeConfig(overrides: Partial<CodexRunnerConfig> = {}) {
		return {
			workingDirectory: "/ws/root",
			cyrusHome: "/tmp/cyrus-home",
			onMessage: () => {},
			onError: () => {},
			...overrides,
		} as CodexRunnerConfig;
	}

	it("keeps returning undefined env without codexHome/additionalEnv", async () => {
		const resolved = await new CodexConfigBuilder(makeConfig()).build();
		expect(resolved.env).toBeUndefined();
	});

	it("builds env with CODEX_HOME when codexHome is configured (existing behavior)", async () => {
		const resolved = await new CodexConfigBuilder(
			makeConfig({ codexHome }),
		).build();
		expect(resolved.env?.CODEX_HOME).toBe(codexHome);
		expect(resolved.env?.OPENAI_API_KEY).toBe("global-openai");
	});

	it("merges additionalEnv into the child env", async () => {
		const resolved = await new CodexConfigBuilder(
			makeConfig({
				codexHome,
				additionalEnv: { GH_TOKEN: "user-pat", GIT_AUTHOR_NAME: "Alice" },
			}),
		).build();
		expect(resolved.env?.GH_TOKEN).toBe("user-pat");
		expect(resolved.env?.GIT_AUTHOR_NAME).toBe("Alice");
	});
});
