/**
 * The per-user default runner/model preference: its curated catalog, its
 * stored representation on `users.default_runner_json`, and the env vars it
 * becomes inside a container.
 *
 * Three axes were conflated in the original framing of NOR-364 and are kept
 * apart here (see `CONTEXT.md`):
 *
 * - **Executor** — which machine, device vs container. Not selectable; forced
 *   to `aca` wherever an ACA provider is registered (see `resolveExecutor`).
 * - **Runner** — which coding agent. Selectable, per-user, workspace-wide.
 * - **Model** — which model within a runner. Selectable; naming a model names
 *   the runner, so one `<select>` covers both.
 *
 * This default slots in exactly where `config.defaultRunner` sits in
 * `RunnerSelectionService`, **below** per-issue `[agent=]`/`[model=]` tags and
 * labels. Those remain as overrides — the complaint that motivated this work
 * was that labels are *mandatory*, not that they are harmful.
 */

import type { RunnerType } from "cyrus-core";

/** One selectable model within a runner. */
export interface RunnerModelOption {
	/** The value handed to the runner, verbatim. */
	model: string;
	/** What the picker shows. */
	label: string;
}

export interface RunnerCatalogEntry {
	runner: RunnerType;
	/** Group heading in the picker. */
	label: string;
	models: readonly RunnerModelOption[];
}

/**
 * The runners a container can actually run, and the models each offers.
 *
 * **Gemini and Cursor are absent, not disabled.** Neither works in a
 * container: there is no `gemini` binary in the worker image, nothing reads
 * `CYRUS_CURSOR_DEFAULT_MODEL`, and neither provider's hosts are on the egress
 * allowlist. Rendering a choice that is guaranteed to fail is worse than not
 * rendering it — `[agent=gemini]` remains available as a per-issue escape
 * hatch for physical-device users, where it genuinely runs.
 *
 * **Curated rather than free text.** The whole reason this is a typed control
 * is that `WorkerService` casts `CYRUS_DEFAULT_RUNNER` without parsing it, so
 * a typo reaches `createRunnerForType` and throws *inside the sandbox at
 * session start* — which a user experiences as a dead session rather than as a
 * setup error. Under Codex subscription auth the same is true of a typo'd
 * model: `CodexConfigBuilder`'s 404 fallback probe is a no-op without an API
 * key, so a bad model is a hard app-server error rather than a silent
 * downgrade. The accepted cost is maintenance — this list needs an entry when
 * OpenAI or Anthropic ship a model, which the old free-text label regex did
 * not.
 */
export const RUNNER_CATALOG: readonly RunnerCatalogEntry[] = [
	{
		runner: "claude",
		label: "Claude Code",
		models: [
			{ model: "opus", label: "Opus — most capable" },
			{ model: "sonnet", label: "Sonnet — balanced" },
			{ model: "haiku", label: "Haiku — fastest" },
			{ model: "fable", label: "Fable" },
		],
	},
	{
		runner: "codex",
		// One model, and that is not an oversight. Cyrus runs Codex on a
		// router-held ChatGPT subscription (ADR 0005), and OpenAI serves a
		// narrower model set to subscription auth than to a metered API key: on
		// a live account every other name we shipped came back
		// `400 invalid_request_error — The '<model>' model is not supported when
		// using Codex with a ChatGPT account`. That is a semantic rejection AFTER
		// a successful auth, so it cannot be probed for and does not degrade —
		// the session simply dies. Measured 2026-08-31 against a real
		// subscription inside the worker image (codex-cli 0.144.6): `gpt-5.5`
		// answered; `gpt-5.5-codex`, `gpt-5.2-codex`, `gpt-5.1-codex`, `gpt-5`,
		// `gpt-5-codex`, `gpt-5.5-codex-mini`, `gpt-5.5-mini`, `gpt-5.5-pro` and
		// `codex-mini-latest` were all rejected.
		//
		// Listing them anyway for the sake of the `OPENAI_API_KEY` fallback would
		// invert the whole point of a curated control: it would render an option
		// that is a guaranteed dead session for every user on the credential the
		// product actually mandates, to serve the path documented as the
		// fallback. Same rule that keeps Gemini and Cursor out.
		//
		// Re-run the probe when OpenAI ships a model — a name that works here is
		// a one-line addition, and one that does not must stay out.
		label: "Codex",
		models: [{ model: "gpt-5.5", label: "GPT-5.5" }],
	},
] as const;

/** Runners the picker offers, in display order. */
export const SELECTABLE_RUNNERS: readonly RunnerType[] = RUNNER_CATALOG.map(
	(entry) => entry.runner,
);

/** A resolved per-user default: a runner and one of its catalog models. */
export interface DefaultRunnerSelection {
	runner: RunnerType;
	model: string;
}

/**
 * The env var each runner reads its default model from, as consumed by
 * `WorkerService` when it builds the in-sandbox `EdgeWorkerConfig`.
 *
 * Gemini and Cursor appear here for completeness only — neither is selectable
 * (see {@link RUNNER_CATALOG}) so neither name is ever emitted today.
 */
export const MODEL_ENV_BY_RUNNER: Record<RunnerType, string> = {
	claude: "CYRUS_CLAUDE_DEFAULT_MODEL",
	codex: "CYRUS_CODEX_DEFAULT_MODEL",
	gemini: "CYRUS_GEMINI_DEFAULT_MODEL",
	cursor: "CYRUS_CURSOR_DEFAULT_MODEL",
};

/** `CYRUS_DEFAULT_RUNNER` — the runner half of the picker, as delivered. */
export const DEFAULT_RUNNER_ENV = "CYRUS_DEFAULT_RUNNER";

/**
 * The form the picker round-trips a selection in: `<runner>:<model>`. A single
 * `<select>` covers both axes because naming a model names the runner.
 */
export function encodeSelection(selection: DefaultRunnerSelection): string {
	return `${selection.runner}:${selection.model}`;
}

/**
 * Parses a `<runner>:<model>` picker value against the catalog.
 *
 * Rejects anything not in the catalog rather than passing it through. A value
 * that did not come from a rendered `<option>` is either a stale page or a
 * tampered form, and the entire point of the typed control is that an
 * unusable value fails *here*, where the user can see it, rather than at
 * session start inside a sandbox.
 */
export function parseSelection(
	raw: string | undefined,
): DefaultRunnerSelection | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim();
	if (trimmed === "") return undefined;
	const separator = trimmed.indexOf(":");
	if (separator < 0) return undefined;
	const runner = trimmed.slice(0, separator);
	const model = trimmed.slice(separator + 1);
	const entry = RUNNER_CATALOG.find((candidate) => candidate.runner === runner);
	if (!entry) return undefined;
	if (!entry.models.some((option) => option.model === model)) return undefined;
	return { runner: entry.runner, model };
}

/** The literal stored on `users.default_runner_json`. */
export function encodeDefaultRunnerJson(
	selection: DefaultRunnerSelection,
): string {
	return JSON.stringify({ runner: selection.runner, model: selection.model });
}

/**
 * Reads `users.default_runner_json` back.
 *
 * Every unreadable state — NULL, empty, malformed JSON, an unknown runner —
 * resolves to `undefined`, meaning "no per-user default", which leaves
 * `RunnerSelectionService`'s own fallback chain intact. That is the honest
 * degradation: an absent default costs a user the convenience of the picker,
 * whereas inventing one would silently run a different agent than they chose.
 *
 * **A retired MODEL is the one case that does not degrade to `undefined`**, and
 * that exception is load-bearing. Dropping the whole selection also drops the
 * RUNNER, and the runner is what `requiredSecretKeysFor` keys off — so a Codex
 * user whose model left the catalog stops being a Codex user, is asked for a
 * `CLAUDE_CODE_OAUTH_TOKEN` they were never required to have, and every
 * container they own refuses to boot. The picker's whole premise is that
 * choosing Codex must not require an Anthropic subscription; a catalog edit
 * must not be able to revoke that. Retiring a model is also the *routine*
 * change here — NOR-364 phase 3 retired three of four Codex models on its first
 * live run — so this path is exercised, not theoretical.
 *
 * Falling back to the runner's first catalog model keeps the axis the user
 * actually chose (which agent) and moves only the axis the catalog controls
 * (which of its models). It is logged either way, because their stored
 * preference has quietly stopped applying and only a log line can say why.
 */
export function resolveDefaultRunner(
	defaultRunnerJson: string | null | undefined,
	logger?: { warn(msg: string): void },
): DefaultRunnerSelection | undefined {
	if (
		defaultRunnerJson === null ||
		defaultRunnerJson === undefined ||
		defaultRunnerJson.trim() === ""
	) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(defaultRunnerJson);
	} catch {
		logger?.warn(
			`Corrupt default_runner_json ${JSON.stringify(defaultRunnerJson)}; using the router's own runner defaults`,
		);
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		logger?.warn(
			`default_runner_json ${JSON.stringify(defaultRunnerJson)} is not a JSON object; using the router's own runner defaults`,
		);
		return undefined;
	}

	const { runner, model } = parsed as { runner?: unknown; model?: unknown };
	if (typeof runner !== "string" || typeof model !== "string") {
		logger?.warn(
			`default_runner_json ${JSON.stringify(defaultRunnerJson)} has no usable "runner"/"model"; using the router's own runner defaults`,
		);
		return undefined;
	}
	const selection = parseSelection(`${runner}:${model}`);
	if (selection) return selection;

	// The runner survives even when its model does not — see the note above on
	// why losing the runner is not an acceptable degradation.
	const entry = RUNNER_CATALOG.find((candidate) => candidate.runner === runner);
	const replacement = entry?.models[0];
	if (entry && replacement) {
		logger?.warn(
			`Stored default model ${runner}/${model} is no longer offered; falling back to ${runner}/${replacement.model}`,
		);
		return { runner: entry.runner, model: replacement.model };
	}

	logger?.warn(
		`Stored default runner ${runner}/${model} is no longer offered; using the router's own runner defaults`,
	);
	return undefined;
}

/**
 * The env a container inherits from a stored selection.
 *
 * Both keys are in `RESERVED_ENV_KEYS`: once the router owns a key, a stale
 * hand-typed variable in the user's secret bundle must not shadow the picker.
 */
export function defaultRunnerEnv(
	selection: DefaultRunnerSelection | undefined,
): Record<string, string> {
	if (!selection) return {};
	return {
		[DEFAULT_RUNNER_ENV]: selection.runner,
		[MODEL_ENV_BY_RUNNER[selection.runner]]: selection.model,
	};
}
