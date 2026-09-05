import { describe, expect, it, vi } from "vitest";
import type { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";

/**
 * A run must say which runner it is WHILE it runs, not only once it stops.
 *
 * Run facts used to reach the router from three places only — a wait, a turn
 * that ended holding pending work, and the terminal frame. An ordinary run
 * reaches none of them until it is over, so `agent_runs.runner` stayed NULL for
 * its entire life and `cyrus runs list` rendered every in-flight run as
 * `unknown`: the column an operator reads to answer "what is running on this?"
 * was blank exactly while the answer was worth having.
 *
 * Attaching a runner is the first instant the session can answer, so that is
 * where it now reports.
 */

const SESSION_ID = "session-1";

function makeWorker(platform: "router" | "linear" = "router") {
	const worker = new EdgeWorker({
		platform,
		...(platform === "linear"
			? {}
			: { router: { url: "ws://127.0.0.1:9", deviceToken: "tok" } }),
		cyrusHome: "/tmp/cyrus-run-facts-test",
		repositories: [],
	} as never);

	const routerConnection = {
		sendRunFacts: vi.fn(),
		discardBufferedSessionState: vi.fn(),
	};
	const internals = worker as unknown as {
		routerConnection?: typeof routerConnection;
		agentSessionManager: AgentSessionManager;
	};
	internals.routerConnection = routerConnection;
	return { routerConnection, manager: internals.agentSessionManager };
}

describe("run facts on runner attach", () => {
	it("reports the runner as soon as one is attached", () => {
		const { routerConnection, manager } = makeWorker();
		vi.spyOn(manager, "getRunFacts").mockReturnValue({
			runner: "claude",
			model: "claude-opus-5",
		});

		manager.emit("sessionResumed", SESSION_ID);

		expect(routerConnection.sendRunFacts).toHaveBeenCalledWith(SESSION_ID, {
			runner: "claude",
			model: "claude-opus-5",
		});
	});

	it("omits the model rather than guessing one before init lands", () => {
		// `getRunFacts` reports the runner as soon as it is attached but the model
		// only once the runner's init message has arrived. The router merges the
		// keys a frame carries, so an absent model is filled in by a later frame —
		// whereas a placeholder written here would sit in a column operators
		// filter on.
		const { routerConnection, manager } = makeWorker();
		vi.spyOn(manager, "getRunFacts").mockReturnValue({ runner: "codex" });

		manager.emit("sessionResumed", SESSION_ID);

		expect(routerConnection.sendRunFacts).toHaveBeenCalledWith(SESSION_ID, {
			runner: "codex",
		});
	});

	it("still discards the buffered terminal frame when reporting throws", () => {
		// The two are independent: losing a run fact costs one observation, while
		// failing to discard a stale terminal frame lets it replay mid-turn and
		// strip the affinity this turn's activities post under.
		const { routerConnection, manager } = makeWorker();
		vi.spyOn(manager, "getRunFacts").mockReturnValue({ runner: "claude" });
		routerConnection.sendRunFacts.mockImplementation(() => {
			throw new Error("socket closed");
		});

		expect(() => manager.emit("sessionResumed", SESSION_ID)).not.toThrow();
		expect(routerConnection.discardBufferedSessionState).toHaveBeenCalledWith(
			SESSION_ID,
		);
	});

	it("is inert outside router platform mode", () => {
		const { routerConnection, manager } = makeWorker("linear");
		vi.spyOn(manager, "getRunFacts").mockReturnValue({ runner: "claude" });

		manager.emit("sessionResumed", SESSION_ID);

		expect(routerConnection.sendRunFacts).not.toHaveBeenCalled();
	});
});
