import type { SDKSystemMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeMessageFormatter } from "cyrus-claude-runner";
import { installRecordingLogSink } from "cyrus-core";
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

/**
 * CYR-72 — the same facts, on the log records rather than on the frames.
 *
 * A run frame reaches the router only when the worker manages to send one. The
 * terminal events are the two points at which a session's fate is recorded in
 * the LOG stream, and until now they carried the agent SDK's session id and
 * nothing else — so a stalled session could be found in the logs only by
 * someone who already knew that id, which is not the id anything else is keyed
 * on.
 */
describe("AgentSessionManager canonical log attribution", () => {
	it("stamps the Linear session id, runner and model on the terminal signal", async () => {
		const recorder = installRecordingLogSink();
		try {
			const manager = makeManager("ClaudeRunner");
			manager.updateAgentSessionWithRunnerSessionId(
				SESSION_ID,
				initMessage("claude-opus-5"),
			);

			await manager.abortSession(SESSION_ID);

			const event = recorder.sink.find({ event: "session.terminal_signalled" });
			expect(event?.attributes).toMatchObject({
				"cyrus.session_id": SESSION_ID,
				"cyrus.runner": "claude",
				"cyrus.model": "claude-opus-5",
				// The agent SDK's own id, kept under its established name: the two
				// families do not join, and a query that mixes them silently returns
				// nothing rather than erroring.
				"cyrus.agent_session_id": SESSION_ID,
				"cyrus.terminal_state": "stopped",
			});
		} finally {
			recorder.restore();
		}
	});

	it("omits a run fact the worker does not know rather than inventing one", async () => {
		// A session aborted before its runner announced a model. Reporting
		// "claude-opus-5" — or any default — would put a model an operator filters
		// on into a run that never used it.
		const recorder = installRecordingLogSink();
		try {
			const manager = makeManager();

			await manager.abortSession(SESSION_ID);

			const event = recorder.sink.find({ event: "session.terminal_signalled" });
			expect(event?.attributes).not.toHaveProperty("cyrus.model");
			expect(event?.attributes).not.toHaveProperty("cyrus.runner");
			expect(event?.attributes?.["cyrus.session_id"]).toBe(SESSION_ID);
		} finally {
			recorder.restore();
		}
	});

	it("claims no fact the router is the authority on", async () => {
		// The worker has no trustworthy view of the workspace, owner, team,
		// project, run or device. `SandboxLogRelay` stamps all of those from the
		// authenticated device row and would discard a worker's copy anyway, so
		// sending one would be bytes on the wire that are believed only on the
		// deployment where nothing checks them.
		const recorder = installRecordingLogSink();
		try {
			const manager = makeManager("ClaudeRunner");

			await manager.abortSession(SESSION_ID);

			const event = recorder.sink.find({ event: "session.terminal_signalled" });
			for (const key of [
				"cyrus.workspace_id",
				"cyrus.owner_id",
				"cyrus.team_id",
				"cyrus.project_id",
				"cyrus.run_id",
				"cyrus.device_id",
			]) {
				expect(event?.attributes).not.toHaveProperty(key);
			}
		} finally {
			recorder.restore();
		}
	});
});
