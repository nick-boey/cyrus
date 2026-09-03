import { ClaudeMessageFormatter } from "cyrus-claude-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * A session that throws on the way up never reaches the message loop, so
 * neither `completeSession` (the result branch) nor `abortSession` (an explicit
 * stop) ever runs. Before `failSession` existed, the rejection travelled as far
 * as `EdgeWorker.handleWebhook`'s catch — which deliberately does not rethrow —
 * and stopped there as a single log line, while Linear went on rendering the
 * session as working because `postInstantAcknowledgment` had already posted a
 * thought. The router's issue lock and session affinity stayed pinned too,
 * since only "sessionTerminal" releases them.
 *
 * That is the NOR-402 shape, and it is exactly what NOR-412's fatal env-scrub
 * abort would have produced on a host that opted in and could not comply — the
 * "off, with a log line nothing alerts on" outcome the control exists to
 * prevent.
 */
describe("AgentSessionManager.failSession", () => {
	const sessionId = "session-fail";
	const issueId = "issue-fail";

	let manager: AgentSessionManager;
	let sink: IActivitySink;
	let events: string[];
	let postedBodies: string[];

	beforeEach(() => {
		events = [];
		postedBodies = [];
		sink = {
			id: "test-workspace",
			postActivity: vi.fn().mockImplementation(async (...args: unknown[]) => {
				events.push("activity");
				postedBodies.push(JSON.stringify(args));
				return { activityId: "activity-1" };
			}),
			createAgentSession: vi.fn().mockResolvedValue("ext-session-1"),
		};

		manager = new AgentSessionManager();
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "NOR-412",
				title: "Startup failure",
				description: "",
				branchName: "test-branch",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, sink);
		manager.addAgentRunner(sessionId, {
			getFormatter: () => new ClaudeMessageFormatter(),
			constructor: { name: "ClaudeRunner" },
		} as unknown as Parameters<typeof manager.addAgentRunner>[1]);

		manager.on("sessionTerminal", (_id: string, state: string) => {
			events.push(`terminal:${state}`);
		});
	});

	it("posts the reason and then goes terminal, in that order", async () => {
		await manager.failSession(sessionId, "CYRUS_SUBPROCESS_ENV_SCRUB is set");

		// Order matters for the same reason it does in completeSession: the
		// router authorizes `createAgentActivity` against the session affinity
		// that the terminal signal releases, so a terminal emitted first would
		// get the explanation rejected as "session not owned by this device".
		expect(events).toEqual(["activity", "terminal:error"]);
		expect(postedBodies.join("\n")).toContain(
			"CYRUS_SUBPROCESS_ENV_SCRUB is set",
		);
	});

	it("still signals terminal when the explanation cannot be posted", async () => {
		vi.mocked(sink.postActivity).mockRejectedValue(new Error("Linear down"));

		await manager.failSession(sessionId, "boom");

		// A lost activity is recoverable. An issue whose lock is never released
		// needs an admin running `cyrus router unlock`, so the terminal signal
		// must not be reachable only through a successful network call.
		expect(events).toEqual(["terminal:error"]);
	});

	it("leaves the session in an error state", async () => {
		await manager.failSession(sessionId, "boom");

		const session = manager.getSession(sessionId);
		expect(session?.terminalState).toBe("error");
	});

	it("is idempotent, so a later terminal signal cannot double-fire", async () => {
		await manager.failSession(sessionId, "boom");
		await manager.failSession(sessionId, "boom again");

		expect(events.filter((e) => e.startsWith("terminal:"))).toEqual([
			"terminal:error",
		]);
	});
});
