import type { EdgeWorkerConfig, RunnerType } from "cyrus-core";

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
	 * 2. Auto-detect from available API keys (if exactly one runner has keys)
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
	public getDefaultModelForRunner(runnerType: RunnerType): string {
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
		return this.config.codexDefaultModel || "gpt-5.5";
	}

	/**
	 * Resolve default fallback model for a given runner from config with sensible built-in defaults.
	 * Supports legacy Claude fallback key for backwards compatibility.
	 */
	public getDefaultFallbackModelForRunner(runnerType: RunnerType): string {
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
			return "gpt-5.2-codex";
		}
		if (runnerType === "cursor") {
			return this.config.cursorDefaultFallbackModel || "composer-2";
		}
		return "gpt-5";
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
	 * - [agent=claude|gemini|codex|cursor]
	 * - [model=<model-name>]
	 *
	 * Precedence:
	 * 1. Description tags override labels
	 * 2. Agent labels override model labels
	 * 3. Model labels can infer agent type
	 * 4. Defaults to claude runner
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

		const defaultModelByRunner: Record<RunnerType, string> = {
			claude: this.getDefaultModelForRunner("claude"),
			gemini: this.getDefaultModelForRunner("gemini"),
			codex: this.getDefaultModelForRunner("codex"),
			cursor: this.getDefaultModelForRunner("cursor"),
		};
		const defaultFallbackByRunner: Record<RunnerType, string> = {
			claude: this.getDefaultFallbackModelForRunner("claude"),
			gemini: this.getDefaultFallbackModelForRunner("gemini"),
			codex: this.getDefaultFallbackModelForRunner("codex"),
			cursor: this.getDefaultFallbackModelForRunner("cursor"),
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
			if (isCodexModel(normalizedModel)) {
				return "gpt-5.2-codex";
			}
			return "gpt-5";
		};

		const resolveAgentFromLabel = (
			lowercaseLabels: string[],
		): RunnerType | undefined => {
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
			agentFromDescription === "cursor"
				? "cursor"
				: agentFromDescription === "codex" || agentFromDescription === "openai"
					? "codex"
					: agentFromDescription === "gemini"
						? "gemini"
						: agentFromDescription === "claude"
							? "claude"
							: undefined;
		const resolvedAgentFromLabels = resolveAgentFromLabel(normalizedLabels);

		const modelFromDescription = descriptionModelTagRaw;
		const modelFromLabels = resolveModelFromLabel(normalizedLabels);
		const explicitModel = modelFromDescription || modelFromLabels;

		const runnerType: RunnerType =
			resolvedAgentFromDescription ||
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

		let fallbackModelOverride = inferFallbackModel(
			resolvedModelOverride,
			runnerType,
		);
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
