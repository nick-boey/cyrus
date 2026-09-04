import type { SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeMessageFormatter } from "cyrus-claude-runner";
import { describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * CYR-68 — the execution identity a worker reports alongside every explicit run
 * state.
 *
 * These are the facts a fleet operator filters and groups by ("show me every
 * codex run", "which model was this one on?"), so the rule that matters is that
 * NOTHING here is guessed. A runner the manager cannot identify, or a model the
 * runner has not announced yet, is reported as absent — an invented value in a
 * filter column is worse than a missing one, because it silently answers the
 * wrong question rather than declining to answer.
 */

const SESSION_ID = "session-run-facts";
const ISSUE_ID = "issue-run-facts";

function makeManager(runnerName?: string) {
	const sink: IActivitySink = {
		id: "test-workspace",
		postActivity: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
		createAgentSession: vi.fn().mockResolvedValue("ext-session-1"),
	};
	const manager = new AgentSessionManager();
	manager.createCyrusAgentSession(
		SESSION_ID,
		ISSUE_ID,
		{
			id: ISSUE_ID,
			identifier: "CYR-68",
			title: "Capture routing and worker-reported run facts",
			description: "",
			branchName: "test-branch",
		},
		{ path: "/tmp/workspace", isGitWorktree: false },
	);
	manager.setActivitySink(SESSION_ID, sink);

	if (runnerName !== undefined) {
		const formatter = new ClaudeMessageFormatter();
		const runner = {
			getFormatter: () => formatter,
			constructor: { name: runnerName },
		} as unknown as Parameters<typeof manager.addAgentRunner>[1];
		manager.addAgentRunner(SESSION_ID, runner);
	}
	return manager;
}

/** The runner's init message, which is where the model name first arrives. */
function initMessage(model: string): SDKSystemMessage {
	return {
		type: "system",
		subtype: "init",
		session_id: "runner-session-1",
		model,
		tools: [],
		permissionMode: "default",
		apiKeySource: "none",
	} as unknown as SDKSystemMessage;
}

describe("AgentSessionManager run facts", () => {
	it.each([
		["ClaudeRunner", "claude"],
		["GeminiRunner", "gemini"],
		["CodexRunner", "codex"],
		["CursorRunner", "cursor"],
		["OpenCodeRunner", "opencode"],
	])("reports %s as runner %s", (constructorName, expected) => {
		const manager = makeManager(constructorName);

		expect(manager.getRunFacts(SESSION_ID).runner).toBe(expected);
	});

	it("reports the model only once the runner has announced one", () => {
		const manager = makeManager("ClaudeRunner");

		// Before the init message there is nothing to report. A placeholder here
		// would put a model an operator could filter on into a run that never ran
		// under it.
		expect(manager.getRunFacts(SESSION_ID)).toEqual({ runner: "claude" });

		manager.updateAgentSessionWithRunnerSessionId(
			SESSION_ID,
			initMessage("claude-opus-5"),
		);

		expect(manager.getRunFacts(SESSION_ID)).toEqual({
			runner: "claude",
			model: "claude-opus-5",
		});
	});

	it("reports no runner for a session that has none attached", () => {
		// A session created but not yet started. Reporting the default runner here
		// would claim an identity for a run that has not chosen one — and unlike
		// the model-name prefix path, nothing downstream needs a value.
		const manager = makeManager();

		expect(manager.getRunFacts(SESSION_ID)).toEqual({});
	});

	it("reports nothing at all for an unknown session", () => {
		const manager = makeManager("ClaudeRunner");

		expect(manager.getRunFacts("no-such-session")).toEqual({});
	});
});
