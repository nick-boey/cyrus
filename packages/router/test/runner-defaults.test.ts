import { describe, expect, it, vi } from "vitest";
import {
	isLateReservedEnvKey,
	isReservedEnvKey,
	RUNNER_REQUIRED_SECRET_KEYS,
	requiredSecretKeysFor,
} from "../src/SecretStore.js";
import {
	DEFAULT_RUNNER_ENV,
	defaultRunnerEnv,
	encodeDefaultRunnerJson,
	encodeSelection,
	MODEL_ENV_BY_RUNNER,
	parseSelection,
	RUNNER_CATALOG,
	resolveDefaultRunner,
	SELECTABLE_RUNNERS,
} from "../src/setup/runnerDefaults.js";

describe("the runner catalog", () => {
	it("offers only runners that work in a container", () => {
		// Gemini has no CLI in the worker image and Cursor's default model is
		// never read; neither host is on the egress allowlist. Rendering either
		// would be a choice guaranteed to fail.
		expect([...SELECTABLE_RUNNERS].sort()).toEqual(["claude", "codex"]);
	});

	it("offers the current flagship Codex model, and prefers it", () => {
		// CYR-79: the picker hard-coded `gpt-5.5` while the edge worker had its
		// own idea of the default, so `/setup` and the session could disagree
		// about which model a container was going to run. The FIRST entry is the
		// load-bearing one — `resolveDefaultRunner` degrades a retired selection
		// onto it — so this asserts order, not just membership.
		const codex = RUNNER_CATALOG.find((entry) => entry.runner === "codex");
		expect(codex?.models[0]?.model).toBe("gpt-5.6-sol");
		expect(codex?.models.map((option) => option.model)).toContain("gpt-5.5");
	});

	it("keeps a stored selection for a model still in the catalog", () => {
		// The migration half of CYR-79: adding GPT-5.6 must not disturb anyone
		// already on GPT-5.5 — no warning, no silent model change.
		const warn = vi.fn();
		expect(
			resolveDefaultRunner('{"runner":"codex","model":"gpt-5.5"}', { warn }),
		).toEqual({ runner: "codex", model: "gpt-5.5" });
		expect(warn).not.toHaveBeenCalled();
	});

	it("has at least one model per runner and no duplicate values", () => {
		const seen = new Set<string>();
		for (const entry of RUNNER_CATALOG) {
			expect(entry.models.length).toBeGreaterThan(0);
			for (const option of entry.models) {
				const value = encodeSelection({
					runner: entry.runner,
					model: option.model,
				});
				expect(seen.has(value)).toBe(false);
				seen.add(value);
			}
		}
	});
});

describe("parseSelection", () => {
	it("accepts every value the picker can render", () => {
		for (const entry of RUNNER_CATALOG) {
			for (const option of entry.models) {
				const selection = { runner: entry.runner, model: option.model };
				expect(parseSelection(encodeSelection(selection))).toEqual(selection);
			}
		}
	});

	it.each([
		["", "empty"],
		["claude", "no separator"],
		["claude:", "no model"],
		["Claude:opus", "wrong case on the runner"],
		["claude:opuss", "a typo'd model"],
		["gemini:gemini-2.5-pro", "a runner that is not offered"],
		["codex:opus", "a model belonging to another runner"],
	])("rejects %j (%s)", (raw) => {
		expect(parseSelection(raw)).toBeUndefined();
	});

	it("rejects rather than passing an unknown value through", () => {
		// The whole reason this is a typed control: WorkerService used to cast
		// CYRUS_DEFAULT_RUNNER without parsing, so a bad value reached
		// createRunnerForType and threw inside the sandbox at session start.
		expect(parseSelection("claude:o pus")).toBeUndefined();
	});
});

describe("resolveDefaultRunner", () => {
	it("round-trips a stored selection", () => {
		const selection = { runner: "codex" as const, model: "gpt-5.5" };
		expect(resolveDefaultRunner(encodeDefaultRunnerJson(selection))).toEqual(
			selection,
		);
	});

	it.each([
		[null, "NULL"],
		[undefined, "absent"],
		["", "empty"],
		["   ", "whitespace"],
	])("treats %j (%s) as no preference, silently", (stored) => {
		const warn = vi.fn();
		expect(resolveDefaultRunner(stored, { warn })).toBeUndefined();
		expect(warn).not.toHaveBeenCalled();
	});

	it.each([
		["{ not json", "corrupt JSON"],
		["[]", "an array"],
		['"claude"', "a bare string"],
		['{"runner":"claude"}', "no model"],
		['{"runner":"gemini","model":"gemini-2.5-pro"}', "an unoffered runner"],
	])("degrades %j (%s) to no preference, with a warning", (stored) => {
		const warn = vi.fn();
		expect(resolveDefaultRunner(stored, { warn })).toBeUndefined();
		// Silence here would be the bad outcome: the user's stored preference has
		// stopped applying and only a log line can say why.
		expect(warn).toHaveBeenCalledTimes(1);
	});

	// A RETIRED MODEL keeps the runner, unlike every case above. Dropping the
	// whole selection also drops the runner, and the runner is what
	// `requiredSecretKeysFor` keys off — so a Codex user whose model left the
	// catalog would be asked for a Claude token they never had and every
	// container they own would refuse to boot. Retiring a model is the routine
	// change here (phase 3 retired three of four Codex models), so a catalog
	// edit must never be able to revoke "Codex needs no Anthropic subscription".
	it.each([
		['{"runner":"claude","model":"opus-4"}', "claude", "opus"],
		['{"runner":"codex","model":"gpt-5.5-codex"}', "codex", "gpt-5.6-sol"],
	])(
		"keeps the runner in %j and falls back to its first catalog model",
		(stored, runner, model) => {
			const warn = vi.fn();
			expect(resolveDefaultRunner(stored, { warn })).toEqual({
				runner,
				model,
			});
			expect(warn).toHaveBeenCalledTimes(1);
		},
	);

	it("keeps a codex user off the Claude-token gate when their model retires", () => {
		// The failure this exists to prevent, stated end to end.
		const selection = resolveDefaultRunner(
			'{"runner":"codex","model":"gpt-5.5-codex"}',
		);
		expect(selection?.runner).toBe("codex");
		expect(requiredSecretKeysFor(selection?.runner, undefined)).not.toContain(
			"CLAUDE_CODE_OAUTH_TOKEN",
		);
	});
});

describe("defaultRunnerEnv", () => {
	it("emits nothing when the user has no preference", () => {
		expect(defaultRunnerEnv(undefined)).toEqual({});
	});

	it("emits the runner and the runner's own model var", () => {
		expect(defaultRunnerEnv({ runner: "codex", model: "gpt-5.5" })).toEqual({
			CYRUS_DEFAULT_RUNNER: "codex",
			CYRUS_CODEX_DEFAULT_MODEL: "gpt-5.5",
		});
		expect(defaultRunnerEnv({ runner: "claude", model: "sonnet" })).toEqual({
			CYRUS_DEFAULT_RUNNER: "claude",
			CYRUS_CLAUDE_DEFAULT_MODEL: "sonnet",
		});
	});

	it("emits only keys the router owns", () => {
		// Once the router emits a key, a hand-typed value must not be able to
		// shadow the picker — which is only true if the key is reserved.
		for (const selection of [
			{ runner: "claude" as const, model: "opus" },
			{ runner: "codex" as const, model: "gpt-5.5" },
		]) {
			for (const key of Object.keys(defaultRunnerEnv(selection))) {
				expect(isReservedEnvKey(key)).toBe(true);
			}
		}
	});
});

describe("reserved keys", () => {
	it("reserves the picker's env vars", () => {
		expect(isReservedEnvKey(DEFAULT_RUNNER_ENV)).toBe(true);
		expect(isReservedEnvKey(MODEL_ENV_BY_RUNNER.claude)).toBe(true);
		expect(isReservedEnvKey(MODEL_ENV_BY_RUNNER.codex)).toBe(true);
		expect(isReservedEnvKey("CODEX_AUTH_JSON")).toBe(true);
	});

	it("leaves OPENAI_API_KEY storable — it is the documented fallback", () => {
		expect(isReservedEnvKey("OPENAI_API_KEY")).toBe(false);
	});

	it("marks only the newly-reserved keys as late", () => {
		// A form submitting PATH or CYRUS_DEVICE_TOKEN cannot have come from a
		// rendered row at any point, so that must stay a hard save failure.
		expect(isLateReservedEnvKey(DEFAULT_RUNNER_ENV)).toBe(true);
		expect(isLateReservedEnvKey("CODEX_AUTH_JSON")).toBe(true);
		expect(isLateReservedEnvKey("PATH")).toBe(false);
		expect(isLateReservedEnvKey("CYRUS_DEVICE_TOKEN")).toBe(false);
	});
});

describe("requiredSecretKeysFor", () => {
	it("requires the Claude token when no runner is chosen", () => {
		expect(requiredSecretKeysFor(undefined, undefined)).toEqual([
			"CLAUDE_CODE_OAUTH_TOKEN",
		]);
	});

	it("requires no bundle credential for a Codex user", () => {
		// This is the defect that made "select Codex as your default" a lie: a
		// codex-only user could not boot a container at all.
		expect(requiredSecretKeysFor("codex", undefined)).toEqual([]);
		expect(RUNNER_REQUIRED_SECRET_KEYS.codex).toEqual([]);
	});

	it("keeps the configured extras for every runner", () => {
		expect(requiredSecretKeysFor("codex", ["GIT_TOKEN"])).toEqual([
			"GIT_TOKEN",
		]);
		expect(requiredSecretKeysFor("claude", ["GIT_TOKEN"])).toEqual([
			"CLAUDE_CODE_OAUTH_TOKEN",
			"GIT_TOKEN",
		]);
	});

	it("de-duplicates an extra that repeats a runner key", () => {
		expect(
			requiredSecretKeysFor("claude", ["CLAUDE_CODE_OAUTH_TOKEN", "GIT_TOKEN"]),
		).toEqual(["CLAUDE_CODE_OAUTH_TOKEN", "GIT_TOKEN"]);
	});
});
