import { CodexRunner } from "cyrus-codex-runner";
import type { SDKMessage } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * CYR-79 follow-up. The credential preflight fails a Codex session *before* the
 * backend is opened, so the mapper synthesizes a `system/init` carrying the
 * local UUID `startWithPrompt` seeded — an id Codex has never issued.
 *
 * Storing that as `codexSessionId` turned one failed start into a permanently
 * broken Linear session: `EdgeWorker.resumeAgentSession` sets `resumeSessionId`
 * from it, `thread/resume` answers `no rollout found for thread id`, and the
 * fabricated id is re-emitted — so the user who read the actionable message,
 * connected their subscription and replied in the thread got an opaque failure
 * instead, forever.
 */
describe("runner session ids from a session that never started", () => {
	let manager: AgentSessionManager;
	let sink: IActivitySink;
	const sessionId = "session-1";
	const issueId = "issue-1";

	function seedSession(runner: CodexRunner): void {
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "TEST-1",
				title: "t",
				description: "",
				branchName: "b",
			},
			{ path: "/tmp", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, sink);
		manager.addAgentRunner(sessionId, runner);
	}

	function initMessage(id: string): SDKMessage {
		return {
			type: "system",
			subtype: "init",
			session_id: id,
			model: "gpt-5.5",
			tools: [],
			mcp_servers: [],
			apiKeySource: "none",
			cwd: "/tmp",
			permissionMode: "default",
			slash_commands: [],
			output_style: "default",
			uuid: "11111111-1111-1111-1111-111111111111",
			agents: [],
		} as unknown as SDKMessage;
	}

	beforeEach(() => {
		sink = {
			id: "ws",
			postActivity: vi.fn().mockResolvedValue({ activityId: "a1" }),
			createAgentSession: vi.fn().mockResolvedValue("s1"),
		};
		manager = new AgentSessionManager();
	});

	it("is not stored when Codex never issued a thread id", () => {
		const runner = new CodexRunner({ workingDirectory: "/tmp" });
		seedSession(runner);
		expect(runner.hasEstablishedRunnerSession()).toBe(false);

		manager.updateAgentSessionWithRunnerSessionId(
			sessionId,
			initMessage("fabricated-local-uuid") as never,
		);

		// The absence is the whole point: with no stored id the next turn starts a
		// fresh Codex thread instead of resuming one that does not exist.
		expect(manager.getSession(sessionId)?.codexSessionId).toBeUndefined();
	});

	it("is stored once Codex has issued one", () => {
		const runner = new CodexRunner({ workingDirectory: "/tmp" });
		seedSession(runner);
		// What `onThreadStarted` does when the backend reports `thread-started`.
		(runner as unknown as { threadStarted: boolean }).threadStarted = true;

		manager.updateAgentSessionWithRunnerSessionId(
			sessionId,
			initMessage("real-thread-id") as never,
		);

		expect(manager.getSession(sessionId)?.codexSessionId).toBe(
			"real-thread-id",
		);
	});

	it("is stored on a resume, whose id Codex issued on an earlier turn", () => {
		const runner = new CodexRunner({
			workingDirectory: "/tmp",
			resumeSessionId: "earlier-thread-id",
		});
		seedSession(runner);
		expect(runner.hasEstablishedRunnerSession()).toBe(true);

		manager.updateAgentSessionWithRunnerSessionId(
			sessionId,
			initMessage("earlier-thread-id") as never,
		);

		expect(manager.getSession(sessionId)?.codexSessionId).toBe(
			"earlier-thread-id",
		);
	});

	it("leaves runners that cannot report establishment untouched", () => {
		// Claude and the rest have no such window; the guard must not become a new
		// gate on them.
		const runner = {
			supportsStreamingInput: false,
			start: vi.fn(),
			stop: vi.fn(),
			isRunning: () => false,
			getMessages: () => [],
			getFormatter: () => ({}) as never,
		} as never;
		seedSession(runner);

		manager.updateAgentSessionWithRunnerSessionId(
			sessionId,
			initMessage("claude-session-id") as never,
		);

		expect(manager.getSession(sessionId)?.claudeSessionId).toBe(
			"claude-session-id",
		);
	});
});
