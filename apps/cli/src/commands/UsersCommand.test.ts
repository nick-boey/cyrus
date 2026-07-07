import { describe, expect, it } from "vitest";
import { buildUserEnvFile, slugForEmail } from "./UsersCommand.js";

describe("slugForEmail", () => {
	it("uses the sanitized email local part", () => {
		expect(slugForEmail("Alice.Smith+x@org.com", new Set())).toBe(
			"alice-smith-x",
		);
	});

	it("de-duplicates against taken slugs", () => {
		expect(slugForEmail("alice@org.com", new Set(["alice"]))).toBe("alice-2");
		expect(slugForEmail("alice@org.com", new Set(["alice", "alice-2"]))).toBe(
			"alice-3",
		);
	});

	it("falls back to 'user' for degenerate local parts", () => {
		expect(slugForEmail("---@org.com", new Set())).toBe("user");
	});
});

describe("buildUserEnvFile", () => {
	it("writes provided credentials under both GitHub names", () => {
		const content = buildUserEnvFile({
			claudeToken: "sk-ant-oat01-xyz",
			githubPat: "github_pat_abc",
		});
		expect(content).toBe(
			[
				"CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-xyz",
				"GH_TOKEN=github_pat_abc",
				"GITHUB_TOKEN=github_pat_abc",
				"",
			].join("\n"),
		);
	});

	it("omits absent credentials", () => {
		expect(buildUserEnvFile({ githubPat: "p" })).toBe(
			"GH_TOKEN=p\nGITHUB_TOKEN=p\n",
		);
		expect(buildUserEnvFile({})).toBe("");
	});
});
