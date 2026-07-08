import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeBuilder(runnerType: "claude" | "codex"): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType }),
		getDefaultModelForRunner: () => "model-x",
		getDefaultFallbackModelForRunner: () => "model-y",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function buildConfig(
	runnerType: "claude" | "codex",
	extras: Record<string, unknown> = {},
) {
	const { config } = makeBuilder(runnerType).buildIssueConfig({
		session: {
			issueId: "issue-1",
			issue: { identifier: "ABC-1" },
			workspace: { path: "/ws/root", isGitWorktree: true },
		} as unknown as CyrusAgentSession,
		repository: {
			id: "repo-a",
			name: "Repo A",
			repositoryPath: "/repos/repo-a",
			allowedTools: [],
		} as unknown as RepositoryConfig,
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/ws/root"],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
		...extras,
	});
	return config as {
		additionalEnv?: Record<string, string>;
		credentialIsolation?: boolean;
		codexHome?: string;
	};
}

const userEnv = {
	CLAUDE_CODE_OAUTH_TOKEN: "user-oauth",
	GH_TOKEN: "user-pat",
	CODEX_HOME: "/home/x/.cyrus/users/alice/codex",
	GIT_AUTHOR_NAME: "Alice",
};

describe("RunnerConfigBuilder per-user env injection", () => {
	it("merges userEnv into additionalEnv and enables isolation for Claude", () => {
		const config = buildConfig("claude", { userEnv });
		expect(config.additionalEnv).toMatchObject(userEnv);
		expect(config.credentialIsolation).toBe(true);
	});

	it("preserves CA-cert env vars when both sandbox and userEnv are set", () => {
		const config = buildConfig("claude", {
			userEnv,
			sandboxSettings: { enabled: true },
			egressCaCertPath: "/certs/ca.pem",
		});
		expect(config.additionalEnv?.NODE_EXTRA_CA_CERTS).toBe("/certs/ca.pem");
		expect(config.additionalEnv?.CLAUDE_CODE_OAUTH_TOKEN).toBe("user-oauth");
	});

	it("sets codexHome, additionalEnv, and isolation for codex-primary sessions", () => {
		const config = buildConfig("codex", { userEnv });
		expect(config.codexHome).toBe("/home/x/.cyrus/users/alice/codex");
		expect(config.additionalEnv).toMatchObject({ GH_TOKEN: "user-pat" });
		expect(config.credentialIsolation).toBe(true);
	});

	it("leaves configs untouched when userEnv is absent", () => {
		const config = buildConfig("claude", {});
		expect(config.additionalEnv).toBeUndefined();
		expect(config.credentialIsolation).toBeUndefined();
		expect(config.codexHome).toBeUndefined();
	});
});
