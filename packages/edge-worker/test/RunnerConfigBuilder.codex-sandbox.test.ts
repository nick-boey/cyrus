import type { CyrusAgentSession, ILogger, RepositoryConfig } from "cyrus-core";
import { afterEach, describe, expect, it } from "vitest";
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

function makeCodexBuilder(): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType: "codex" as const }),
		getDefaultModelForRunner: () => "gpt-5.5",
		getDefaultFallbackModelForRunner: () => "gpt-5.4",
		inferRunnerFromModel: () => undefined,
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

function makeSession(): CyrusAgentSession {
	return {
		issueId: "issue-1",
		issue: { identifier: "ABC-1" },
		workspace: { path: "/ws/root", isGitWorktree: true },
	} as unknown as CyrusAgentSession;
}

function buildCodexConfig(sandboxSettings?: Record<string, unknown>) {
	const { config } = makeCodexBuilder().buildIssueConfig({
		session: makeSession(),
		repository: {
			id: "repo-a",
			name: "Repo A",
			repositoryPath: "/repos/repo-a",
			allowedTools: [],
		} as unknown as RepositoryConfig,
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/ws/root", "/repos/repo-a"],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
		...(sandboxSettings ? { sandboxSettings } : {}),
	});
	return config as {
		sandbox?: string;
		sandboxSettings?: { allowWrite?: string[]; allowRead?: string[] };
	};
}

describe("RunnerConfigBuilder Codex sandbox plumbing", () => {
	it("translates the egress sandbox into a Codex filesystem allow-list", () => {
		// Plumbs both write (worktree) and read (worktree + allowed dirs) roots;
		// the Codex runner turns these into a per-thread permission profile.
		const config = buildCodexConfig({ enabled: true });
		expect(config.sandboxSettings).toEqual({
			allowWrite: ["/ws/root"],
			allowRead: ["/ws/root", "/ws/root", "/repos/repo-a"],
		});
	});

	it("leaves Codex sandbox settings unset when the egress sandbox is disabled", () => {
		expect(buildCodexConfig(undefined).sandboxSettings).toBeUndefined();
	});
});

describe("RunnerConfigBuilder Codex sandbox mode in a worker container", () => {
	afterEach(() => {
		delete process.env.CYRUS_ISSUE_KEY;
		delete process.env.CYRUS_DEVICE_TOKEN;
	});

	// Codex enforces every sandbox mode through bubblewrap, and bubblewrap
	// cannot create a user namespace inside a worker container — so EVERY shell
	// command exits 1 before it starts and the session finishes having done
	// nothing. The container is the boundary in that mode.
	it("disables the nested Codex sandbox in headless container mode", () => {
		process.env.CYRUS_ISSUE_KEY = "DEF-1";
		process.env.CYRUS_DEVICE_TOKEN = "tok";
		const config = buildCodexConfig({ enabled: true });
		expect(config.sandbox).toBe("danger-full-access");
		// `sandboxSettings` must stay UNSET, not merely be overridden. With it
		// set, `resolveCodexSandbox` returns `kind: "profile"` regardless of
		// mode, and `threadOptionsParams` sends `permissions` and DROPS
		// `sandbox` — so the mode never reaches Codex and bwrap is back in the
		// path. Asserting only `.sandbox` passes while the bug is present.
		expect(config.sandboxSettings).toBeUndefined();
	});

	it("keeps the Codex sandbox on a workstation, where it is the only boundary", () => {
		const config = buildCodexConfig({ enabled: true });
		expect(config.sandbox).toBeUndefined();
		// And the filesystem profile is still built there — the workstation is
		// the case the profile exists for.
		expect(config.sandboxSettings).toEqual({
			allowWrite: ["/ws/root"],
			allowRead: ["/ws/root", "/ws/root", "/repos/repo-a"],
		});
	});

	it("needs BOTH container signals, so a stray CYRUS_ISSUE_KEY does not disarm it", () => {
		process.env.CYRUS_ISSUE_KEY = "DEF-1";
		expect(buildCodexConfig({ enabled: true }).sandbox).toBeUndefined();
	});
});
