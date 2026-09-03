import type {
	CyrusAgentSession,
	ILogger,
	RepositoryConfig,
	RunnerType,
} from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";
import { RunnerSelectionService } from "../src/RunnerSelectionService.js";

/**
 * `repository.model` and `repository.fallbackModel` were unreachable dead
 * config: `determineRunnerSelection` always returns a non-empty
 * `modelOverride` (it falls back to the runner default), so the
 * `modelOverride || repository.model || …` chain could never reach the middle
 * term. Setting `"model": "haiku"` on a repository silently did nothing, while
 * the comment above it claimed "label override > repository config > global
 * default".
 */

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

/** The real selector, so the precedence under test is the shipped one. */
function realSelector(): IRunnerSelector {
	return new RunnerSelectionService({} as never);
}

function makeBuilder(selector: IRunnerSelector = realSelector()) {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig: () => ({}),
		buildMergedMcpConfigPath: () => undefined,
	};
	return new RunnerConfigBuilder(chatToolResolver, mcpConfigProvider, selector);
}

function repository(overrides: Partial<RepositoryConfig> = {}) {
	return {
		id: "repo-a",
		name: "Repo A",
		repositoryPath: "/repos/repo-a",
		allowedTools: [],
		...overrides,
	} as unknown as RepositoryConfig;
}

function session(overrides: Record<string, unknown> = {}): CyrusAgentSession {
	return {
		issueId: "issue-1",
		issue: { identifier: "ABC-1" },
		workspace: { path: "/ws/root", isGitWorktree: true },
		...overrides,
	} as unknown as CyrusAgentSession;
}

function build(options: {
	repository?: RepositoryConfig;
	labels?: string[];
	issueDescription?: string;
	session?: CyrusAgentSession;
	selector?: IRunnerSelector;
}) {
	const { config } = makeBuilder(options.selector).buildIssueConfig({
		session: options.session ?? session(),
		repository: options.repository ?? repository(),
		sessionId: "sess-1",
		systemPrompt: "test",
		allowedTools: ["Read(**)"],
		allowedDirectories: ["/repos/repo-a"],
		disallowedTools: [],
		cyrusHome: "/tmp/cyrus-home",
		linearWorkspaceId: "ws-1",
		logger: silentLogger,
		onMessage: () => {},
		onError: () => {},
		requireLinearWorkspaceId: () => "ws-1",
		...(options.labels ? { labels: options.labels } : {}),
		...(options.issueDescription
			? { issueDescription: options.issueDescription }
			: {}),
	});
	return config as unknown as { model: string; fallbackModel: string };
}

describe("repository.model / repository.fallbackModel", () => {
	it("is used when nothing on the issue names a model", () => {
		const config = build({ repository: repository({ model: "haiku" }) });
		expect(config.model).toBe("haiku");
	});

	it("is used for the fallback too", () => {
		const config = build({
			repository: repository({ model: "haiku", fallbackModel: "sonnet" }),
		});
		expect(config.fallbackModel).toBe("sonnet");
	});

	it("still falls back to the runner default when the repository sets nothing", () => {
		expect(build({}).model).toBe("opus");
	});

	it("loses to a [model=] description tag", () => {
		const config = build({
			repository: repository({ model: "haiku" }),
			issueDescription: "Do the thing [model=sonnet]",
		});
		expect(config.model).toBe("sonnet");
	});

	it("loses to a model label", () => {
		const config = build({
			repository: repository({ model: "haiku" }),
			labels: ["sonnet"],
		});
		expect(config.model).toBe("sonnet");
	});

	it("is ignored when it belongs to a different runner than the one resolved", () => {
		// `repository.model` is one field shared by every runner an issue in
		// that repo might route to. Handing a Claude alias to Codex is a hard
		// app-server error under subscription auth, not a downgrade.
		const config = build({
			repository: repository({ model: "haiku" }),
			labels: ["codex"],
		});
		expect(config.model).toBe("gpt-5.6-sol");
	});

	it("applies when it does belong to the resolved runner", () => {
		const config = build({
			repository: repository({ model: "gpt-5.2-codex" }),
			labels: ["codex"],
		});
		expect(config.model).toBe("gpt-5.2-codex");
	});

	it("is not overridden by a resumed session's runner reset", () => {
		// The resume branch pins the runner and resets the model to that
		// runner's default; the repository preference should still apply on top
		// of that default, since it is not runner-specific here.
		const config = build({
			repository: repository({ model: "haiku" }),
			labels: ["codex"],
			session: session({ claudeSessionId: "claude-session-1" }),
		});
		expect(config.model).toBe("haiku");
	});
});

describe("determineRunnerSelection explicitModel", () => {
	const selector = new RunnerSelectionService({} as never);

	it("is absent when nothing named a model", () => {
		const selection = selector.determineRunnerSelection([], "");
		expect(selection.explicitModel).toBeUndefined();
		// `modelOverride` is still populated — which is exactly why it could not
		// be used to tell "asked for" from "defaulted to".
		expect(selection.modelOverride).toBe("opus");
	});

	it("is set by a description tag", () => {
		expect(
			selector.determineRunnerSelection([], "[model=sonnet]").explicitModel,
		).toBe("sonnet");
	});

	it("is set by a label", () => {
		expect(selector.determineRunnerSelection(["haiku"], "").explicitModel).toBe(
			"haiku",
		);
	});

	it("is cleared when the named model conflicts with an explicit agent", () => {
		const selection = selector.determineRunnerSelection(
			[],
			"[agent=claude][model=gpt-5.5]",
		);
		expect(selection.runnerType).toBe<RunnerType>("claude");
		expect(selection.explicitModel).toBeUndefined();
	});
});
