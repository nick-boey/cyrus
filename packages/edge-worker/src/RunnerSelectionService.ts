import type { EdgeWorkerConfig, RunnerType } from "cyrus-core";

/**
 * Codex's built-in default, when neither config nor an issue-level selector
 * names a model. One constant rather than four literals: the `/setup` picker,
 * this service and `cyrus-codex-runner`'s `DEFAULT_CODEX_MODEL` are three
 * independent copies of the same decision, and CYR-79 found them disagreeing.
 */
const CODEX_DEFAULT_MODEL = "gpt-5.6-sol";

/**
 * What a failed Codex model resolves to.
 *
 * `gpt-5.5` rather than the older `gpt-5.2-codex` this used to be: under the
 * ChatGPT-subscription auth Cyrus mandates (ADR 0005), OpenAI rejected
 * `gpt-5.2-codex` outright on a live account, so the fallback was a name that
 * could only ever fail for the credential most sessions run on. `gpt-5.5` is
 * the name that probe actually answered on.
 *
 * Note the fallback only ever applies in `OPENAI_API_KEY` mode anyway —
 * `CodexConfigBuilder`'s 404 probe returns early without a key — which is
 * exactly why the wrong value here went unnoticed.
 */
const CODEX_FALLBACK_MODEL = "gpt-5.5";

const isOpenCodeProviderModel = (model: string): boolean =>
	/^[a-z0-9_.-]+\/[a-z0-9_.:/-]+$/i.test(model);

export class RunnerSelectionService {
	private config: EdgeWorkerConfig;

	constructor(config: EdgeWorkerConfig) {
		this.config = config;
	}

	/**
	 * Update the internal config reference (e.g. after hot-reload).
	 */
	setConfig(config: EdgeWorkerConfig): void {
		this.config = config;
	}

	/**
	 * Determine the default runner type.
	 *
	 * Priority:
	 * 1. Explicit `defaultRunner` in config
	 * 2. Auto-detect from available provider credentials (if exactly one runner has keys)
	 * 3. Fall back to "claude"
	 */
	public getDefaultRunner(): RunnerType {
		if (this.config.defaultRunner) {
			return this.config.defaultRunner;
		}

		// Auto-detect from environment: if exactly one runner's API key is set, use it
		const available: Array<RunnerType> = [];
		if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
			available.push("claude");
		}
		if (process.env.GEMINI_API_KEY) {
			available.push("gemini");
		}
		if (process.env.OPENAI_API_KEY) {
			available.push("codex");
		}
		if (process.env.CURSOR_API_KEY) {
			available.push("cursor");
		}

		if (available.length === 1 && available[0]) {
			return available[0];
		}

		return "claude";
	}

	/**
	 * Resolve default model for a given runner from config with sensible built-in defaults.
	 */
	public getDefaultModelForRunner(runnerType: RunnerType): string | undefined {
		if (runnerType === "claude") {
			return (
				this.config.claudeDefaultModel || this.config.defaultModel || "opus"
			);
		}
		if (runnerType === "gemini") {
			return this.config.geminiDefaultModel || "gemini-2.5-pro";
		}
		if (runnerType === "cursor") {
			return this.config.cursorDefaultModel || "composer-2";
		}
		if (runnerType === "opencode") {
			return this.config.opencodeDefaultModel;
		}
		// Kept in step with the `/setup` picker's preferred Codex model
		// (`RUNNER_CATALOG` in `packages/router/src/setup/runnerDefaults.ts`) and
		// with `DEFAULT_CODEX_MODEL` in `cyrus-codex-runner`. When these disagree,
		// a container whose picker said one thing silently runs another.
		return this.config.codexDefaultModel || CODEX_DEFAULT_MODEL;
	}

	/**
	 * Resolve default fallback model for a given runner from config with sensible built-in defaults.
	 * Supports legacy Claude fallback key for backwards compatibility.
	 */
	public getDefaultFallbackModelForRunner(
		runnerType: RunnerType,
	): string | undefined {
		if (runnerType === "claude") {
			return (
				this.config.claudeDefaultFallbackModel ||
				this.config.defaultFallbackModel ||
				"sonnet"
			);
		}
		if (runnerType === "gemini") {
			return "gemini-2.5-flash";
		}
		if (runnerType === "codex") {
			return CODEX_FALLBACK_MODEL;
		}
		if (runnerType === "cursor") {
			return this.config.cursorDefaultFallbackModel || "composer-2";
		}
		if (runnerType === "opencode") {
			return this.config.opencodeDefaultFallbackModel;
		}
		return CODEX_FALLBACK_MODEL;
	}

	/**
	 * Which runner a model name belongs to, or `undefined` when no runner
	 * claims it.
	 *
	 * Public because a model name is only usable by the runner that owns it,
	 * and callers outside this class need to check that before applying one —
	 * `RunnerConfigBuilder` uses it to decide whether a repository's `model`
	 * applies to the runner an issue actually resolved to. Handing `haiku` to
	 * Codex is a hard failure, not a downgrade.
	 */
	public inferRunnerFromModel(model?: string): RunnerType | undefined {
		if (!model) return undefined;
		const normalizedModel = model.toLowerCase();
		if (
			this.config.inferOpenCodeRunnerFromProviderModel &&
			isOpenCodeProviderModel(normalizedModel)
		) {
			return "opencode";
		}
		if (normalizedModel.startsWith("gemini")) return "gemini";
		if (
			normalizedModel === "fable" ||
			normalizedModel === "opus" ||
			normalizedModel === "sonnet" ||
			normalizedModel === "haiku" ||
			normalizedModel.startsWith("claude")
		) {
			return "claude";
		}
		if (
			/gpt-[a-z0-9.-]*codex$/i.test(normalizedModel) ||
			/^gpt-[a-z0-9.-]+$/i.test(normalizedModel)
		) {
			return "codex";
		}
		return undefined;
	}

	/**
	 * Parse a bracketed tag from issue description.
	 *
	 * Supports escaped brackets (`\\[tag=value\\]`) which Linear can emit.
	 */
	public parseDescriptionTag(
		description: string,
		tagName: string,
	): string | undefined {
		const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(
			`\\\\?\\[${escapedTag}=([a-zA-Z0-9_.:/-]+)\\\\?\\]`,
			"i",
		);
		const match = description.match(pattern);
		return match?.[1];
	}

	/**
	 * Determine runner type and model using labels + issue description tags.
	 *
	 * Supported description tags:
	 * - [agent=claude|gemini|codex|cursor|opencode]
	 * - [model=<model-name>]
	 *
	 * Supported Linear label selectors:
	 * - <provider>/<model>, where provider is claude, gemini, codex, cursor, or openai
	 * - opencode/<provider>/<model> for OpenCode provider-qualified models
	 *
	 * Precedence:
	 * 1. Description tags override labels
	 * 2. Provider/model labels override separate agent or model labels
	 * 3. Agent labels override model labels
	 * 4. Model labels can infer agent type
	 * 5. Defaults to configured/default runner
	 */
	public determineRunnerSelection(
		labels: string[],
		issueDescription?: string,
	): {
		runnerType: RunnerType;
		modelOverride?: string;
		fallbackModelOverride?: string;
		/**
		 * The model a description tag or label named, if either did.
		 *
		 * `modelOverride` is NEVER empty — it falls back to the runner's default —
		 * so a caller reading it alone cannot tell "the user asked for sonnet"
		 * from "nobody asked for anything, so sonnet". That made
		 * `repository.model` and `repository.fallbackModel` unreachable in
		 * `RunnerConfigBuilder`: their branches sat behind a value that was always
		 * truthy, so setting `"model": "haiku"` on a repository silently did
		 * nothing while the comment above it claimed a three-level priority.
		 * This field is what makes the middle level reachable.
		 */
		explicitModel?: string;
		/** As {@link explicitModel}, for the fallback model. */
		explicitFallbackModel?: string;
	} {
		const normalizedLabels = (labels || []).map((label) => label.toLowerCase());
		const normalizedDescription = issueDescription || "";
		const descriptionAgentTagRaw = this.parseDescriptionTag(
			normalizedDescription,
			"agent",
		);
		const descriptionModelTagRaw = this.parseDescriptionTag(
			normalizedDescription,
			"model",
		);

		const defaultModelByRunner: Record<RunnerType, string | undefined> = {
			claude: this.getDefaultModelForRunner("claude"),
			gemini: this.getDefaultModelForRunner("gemini"),
			codex: this.getDefaultModelForRunner("codex"),
			cursor: this.getDefaultModelForRunner("cursor"),
			opencode: this.getDefaultModelForRunner("opencode"),
		};
		const defaultFallbackByRunner: Record<RunnerType, string | undefined> = {
			claude: this.getDefaultFallbackModelForRunner("claude"),
			gemini: this.getDefaultFallbackModelForRunner("gemini"),
			codex: this.getDefaultFallbackModelForRunner("codex"),
			cursor: this.getDefaultFallbackModelForRunner("cursor"),
			opencode: this.getDefaultFallbackModelForRunner("opencode"),
		};

		const isCodexModel = (model: string): boolean =>
			/gpt-[a-z0-9.-]*codex$/i.test(model) || /^gpt-[a-z0-9.-]+$/i.test(model);

		const inferRunnerFromModel = (model?: string): RunnerType | undefined =>
			this.inferRunnerFromModel(model);

		const inferFallbackModel = (
			model: string,
			runnerType: RunnerType,
		): string | undefined => {
			const normalizedModel = model.toLowerCase();
			if (runnerType === "claude") {
				if (normalizedModel === "fable") return "opus";
				if (normalizedModel === "opus") return "sonnet";
				if (normalizedModel === "sonnet") return "haiku";
				// Keep haiku fallback on sonnet for retry behavior
				if (normalizedModel === "haiku") return "sonnet";
				return "sonnet";
			}
			if (runnerType === "gemini") {
				if (
					normalizedModel === "gemini-3" ||
					normalizedModel === "gemini-3-pro" ||
					normalizedModel === "gemini-3-pro-preview"
				) {
					return "gemini-2.5-pro";
				}
				if (
					normalizedModel === "gemini-2.5-pro" ||
					normalizedModel === "gemini-2.5"
				) {
					return "gemini-2.5-flash";
				}
				if (normalizedModel === "gemini-2.5-flash") {
					return "gemini-2.5-flash-lite";
				}
				if (normalizedModel === "gemini-2.5-flash-lite") {
					return "gemini-2.5-flash-lite";
				}
				return "gemini-2.5-flash";
			}
			if (runnerType === "opencode") {
				return defaultFallbackByRunner.opencode;
			}
			// Codex, and anything that reached here without a runner claiming it.
			// The two used to differ (`gpt-5.2-codex` vs `gpt-5`); both were names
			// OpenAI rejects under subscription auth, so there was nothing to
			// preserve in the distinction.
			return CODEX_FALLBACK_MODEL;
		};

		const resolveRunnerFromName = (name?: string): RunnerType | undefined => {
			if (!name) return undefined;
			if (name === "opencode") return "opencode";
			if (name === "cursor") return "cursor";
			if (name === "codex" || name === "openai") return "codex";
			if (name === "gemini") return "gemini";
			if (name === "claude") return "claude";
			return undefined;
		};

		const resolveAgentFromLabel = (
			lowercaseLabels: string[],
		): RunnerType | undefined => {
			if (lowercaseLabels.includes("opencode")) {
				return "opencode";
			}
			if (lowercaseLabels.includes("cursor")) {
				return "cursor";
			}
			if (
				lowercaseLabels.includes("codex") ||
				lowercaseLabels.includes("openai")
			) {
				return "codex";
			}
			if (lowercaseLabels.includes("gemini")) {
				return "gemini";
			}
			if (lowercaseLabels.includes("claude")) {
				return "claude";
			}
			return undefined;
		};

		const resolveProviderModelFromLabel = (
			lowercaseLabels: string[],
		): { runnerType: RunnerType; model: string } | undefined => {
			for (const label of lowercaseLabels) {
				const opencodeMatch = label.match(
					/^opencode\/([a-z0-9_.-]+\/[a-z0-9_.:/-]+)$/i,
				);
				if (opencodeMatch?.[1]) {
					return { runnerType: "opencode", model: opencodeMatch[1] };
				}

				const match = label.match(/^([a-z0-9_.-]+)\/([a-z0-9_.:/-]+)$/i);
				if (!match?.[1] || !match[2]) continue;

				const runnerType = resolveRunnerFromName(match[1]);
				if (runnerType === "opencode") {
					return { runnerType, model: label };
				}
				if (runnerType) {
					return { runnerType, model: match[2] };
				}
			}
			return undefined;
		};

		const resolveModelFromLabel = (
			lowercaseLabels: string[],
		): string | undefined => {
			const codexModelLabel = lowercaseLabels.find((label) =>
				isCodexModel(label),
			);
			if (codexModelLabel) {
				return codexModelLabel;
			}

			if (
				lowercaseLabels.includes("gemini-2.5-pro") ||
				lowercaseLabels.includes("gemini-2.5")
			) {
				return "gemini-2.5-pro";
			}
			if (lowercaseLabels.includes("gemini-2.5-flash")) {
				return "gemini-2.5-flash";
			}
			if (lowercaseLabels.includes("gemini-2.5-flash-lite")) {
				return "gemini-2.5-flash-lite";
			}
			if (
				lowercaseLabels.includes("gemini-3") ||
				lowercaseLabels.includes("gemini-3-pro") ||
				lowercaseLabels.includes("gemini-3-pro-preview")
			) {
				return "gemini-3-pro-preview";
			}

			if (lowercaseLabels.includes("fable")) return "fable";
			if (lowercaseLabels.includes("opus")) return "opus";
			if (lowercaseLabels.includes("sonnet")) return "sonnet";
			if (lowercaseLabels.includes("haiku")) return "haiku";

			return undefined;
		};

		const agentFromDescription = descriptionAgentTagRaw?.toLowerCase();
		const resolvedAgentFromDescription =
			resolveRunnerFromName(agentFromDescription);
		const providerModelFromLabels =
			resolveProviderModelFromLabel(normalizedLabels);
		const resolvedAgentFromLabels = resolveAgentFromLabel(normalizedLabels);

		const modelFromDescription = descriptionModelTagRaw;
		const modelFromLabels =
			providerModelFromLabels?.model || resolveModelFromLabel(normalizedLabels);
		const explicitModel = modelFromDescription || modelFromLabels;

		const runnerType: RunnerType =
			resolvedAgentFromDescription ||
			providerModelFromLabels?.runnerType ||
			resolvedAgentFromLabels ||
			inferRunnerFromModel(explicitModel) ||
			this.getDefaultRunner();

		// If an explicit agent conflicts with model's implied runner, keep the agent and reset model.
		const modelRunner = inferRunnerFromModel(explicitModel);
		let modelOverride = explicitModel;
		if (modelOverride && modelRunner && modelRunner !== runnerType) {
			modelOverride = undefined;
		}

		const resolvedModelOverride =
			modelOverride ||
			defaultModelByRunner[runnerType] ||
			this.getDefaultModelForRunner(runnerType);

		let fallbackModelOverride = resolvedModelOverride
			? inferFallbackModel(resolvedModelOverride, runnerType)
			: undefined;
		if (!fallbackModelOverride) {
			fallbackModelOverride = defaultFallbackByRunner[runnerType];
		}

		return {
			runnerType,
			modelOverride: resolvedModelOverride,
			fallbackModelOverride,
			// Only when a tag or label actually named it. `modelOverride` above is
			// cleared when an explicit agent conflicts with the model's implied
			// runner, and this must be cleared with it — a gpt-* model named
			// alongside `[agent=claude]` is not a Claude model request.
			...(modelOverride ? { explicitModel: modelOverride } : {}),
			...(modelOverride
				? {
						explicitFallbackModel: inferFallbackModel(
							modelOverride,
							runnerType,
						),
					}
				: {}),
		};
	}
}
