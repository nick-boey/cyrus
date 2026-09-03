import type { EdgeWorkerConfig } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerSelectionService } from "../src/RunnerSelectionService.js";

const envKeys = [
	"CLAUDE_CODE_OAUTH_TOKEN",
	"ANTHROPIC_API_KEY",
	"GEMINI_API_KEY",
	"OPENAI_API_KEY",
	"CURSOR_API_KEY",
	"OPENCODE_API_KEY",
] as const;

describe("RunnerSelectionService", () => {
	const originalEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of envKeys) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of envKeys) {
			const value = originalEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("does not auto-detect OpenCode from an API key because OpenCode auth is CLI-managed", () => {
		process.env.OPENCODE_API_KEY = "not-used-by-opencode";

		const service = new RunnerSelectionService({} as EdgeWorkerConfig);

		expect(service.getDefaultRunner()).toBe("claude");
	});

	it("supports explicit OpenCode default runner without requiring model config", () => {
		const service = new RunnerSelectionService({
			defaultRunner: "opencode",
		} as EdgeWorkerConfig);

		expect(service.getDefaultRunner()).toBe("opencode");
		expect(service.getDefaultModelForRunner("opencode")).toBeUndefined();
		expect(
			service.getDefaultFallbackModelForRunner("opencode"),
		).toBeUndefined();
	});

	it("does not infer OpenCode from provider/model syntax unless configured", () => {
		const service = new RunnerSelectionService({} as EdgeWorkerConfig);

		const selection = service.determineRunnerSelection(
			[],
			"[model=anthropic/claude-sonnet-4.5]",
		);

		expect(selection.runnerType).toBe("claude");
		expect(selection.modelOverride).toBe("anthropic/claude-sonnet-4.5");
	});

	it("infers OpenCode from provider/model syntax when configured", () => {
		const service = new RunnerSelectionService({
			inferOpenCodeRunnerFromProviderModel: true,
		} as EdgeWorkerConfig);

		const selection = service.determineRunnerSelection(
			[],
			"[model=anthropic/claude-sonnet-4.5]",
		);

		expect(selection.runnerType).toBe("opencode");
		expect(selection.modelOverride).toBe("anthropic/claude-sonnet-4.5");
	});

	it("keeps explicit OpenCode model selection independent of provider/model inference", () => {
		const service = new RunnerSelectionService({} as EdgeWorkerConfig);

		const selection = service.determineRunnerSelection(
			[],
			"[agent=opencode]\n[model=openai/gpt-5]",
		);

		expect(selection.runnerType).toBe("opencode");
		expect(selection.modelOverride).toBe("openai/gpt-5");
	});

	it("selects OpenCode runner and provider-qualified model from a three-part label", () => {
		const service = new RunnerSelectionService({} as EdgeWorkerConfig);

		const selection = service.determineRunnerSelection([
			"opencode/openai/gpt-5.5",
		]);

		expect(selection.runnerType).toBe("opencode");
		expect(selection.modelOverride).toBe("openai/gpt-5.5");
		expect(selection.fallbackModelOverride).toBeUndefined();
	});

	it("passes two-part OpenCode labels through for runner validation", () => {
		const service = new RunnerSelectionService({} as EdgeWorkerConfig);

		const selection = service.determineRunnerSelection([
			"opencode/kimi-k2.7-code",
		]);

		expect(selection.runnerType).toBe("opencode");
		expect(selection.modelOverride).toBe("opencode/kimi-k2.7-code");
	});

	it("maps openai provider labels to the Codex runner", () => {
		const service = new RunnerSelectionService({} as EdgeWorkerConfig);

		const selection = service.determineRunnerSelection(["openai/gpt-5.5"]);

		expect(selection.runnerType).toBe("codex");
		expect(selection.modelOverride).toBe("gpt-5.5");
	});

	it("lets description selectors override provider/model labels", () => {
		const service = new RunnerSelectionService({} as EdgeWorkerConfig);

		const selection = service.determineRunnerSelection(
			["opencode/openai/gpt-5.5"],
			"[agent=claude]\n[model=sonnet]",
		);

		expect(selection.runnerType).toBe("claude");
		expect(selection.modelOverride).toBe("sonnet");
	});

	// CYR-79. This is the selection half of the defect: the runner an issue gets
	// is decided HERE, inside the sandbox, from tags and labels — long after the
	// router built the container's environment from the user's workspace-wide
	// default. The router used to attach the ChatGPT-subscription credential only
	// when that default was Codex, so every selection below started a Codex
	// session with nothing to authenticate with.
	describe("an issue-level Codex selection under a non-Codex default", () => {
		const claudeDefault = {
			defaultRunner: "claude",
			claudeDefaultModel: "opus",
		} as EdgeWorkerConfig;

		it("wins over a Claude default via an [agent=codex] tag", () => {
			const service = new RunnerSelectionService(claudeDefault);

			const selection = service.determineRunnerSelection([], "[agent=codex]");

			expect(service.getDefaultRunner()).toBe("claude");
			expect(selection.runnerType).toBe("codex");
			expect(selection.modelOverride).toBe("gpt-5.6-sol");
		});

		it("wins over a Claude default via a [model=] tag naming a Codex model", () => {
			const service = new RunnerSelectionService(claudeDefault);

			const selection = service.determineRunnerSelection(
				[],
				"[model=gpt-5.6-sol]",
			);

			expect(selection.runnerType).toBe("codex");
			expect(selection.modelOverride).toBe("gpt-5.6-sol");
		});

		it("wins over a Claude default via a label", () => {
			const service = new RunnerSelectionService(claudeDefault);

			const selection = service.determineRunnerSelection(["codex"]);

			expect(selection.runnerType).toBe("codex");
		});
	});

	// The catalog in `/setup` (`RUNNER_CATALOG`), this service, and
	// `cyrus-codex-runner`'s `DEFAULT_CODEX_MODEL` are three independent copies
	// of one decision, and CYR-79 found them disagreeing — so a container whose
	// picker said one model could silently run another.
	describe("Codex model defaults", () => {
		it("defaults to the same model the /setup picker prefers", () => {
			const service = new RunnerSelectionService({} as EdgeWorkerConfig);

			expect(service.getDefaultModelForRunner("codex")).toBe("gpt-5.6-sol");
		});

		it("lets an explicit config value win", () => {
			const service = new RunnerSelectionService({
				codexDefaultModel: "gpt-5.5",
			} as EdgeWorkerConfig);

			expect(service.getDefaultModelForRunner("codex")).toBe("gpt-5.5");
		});

		it("falls back to a model subscription auth actually serves", () => {
			// `gpt-5.2-codex` was rejected outright on a live ChatGPT account, so
			// the old fallback could only ever fail for the credential most
			// sessions run on.
			const service = new RunnerSelectionService({} as EdgeWorkerConfig);

			expect(service.getDefaultFallbackModelForRunner("codex")).toBe("gpt-5.5");
		});
	});
});
