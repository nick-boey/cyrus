import type { AskUserQuestionResult } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";

/**
 * A session blocked on `AskUserQuestion` never sends a terminal frame — the SDK
 * query is still open inside the tool call — so before this wiring the router
 * held its affinity forever and `ContainerLifecycle` could never idle-stop the
 * container. PAR-146 sat `Running` for 41 minutes at 4 vCPU / 8 GiB on exactly
 * this path.
 *
 * The fix parks the session for the duration of the elicitation, but ONLY when
 * nothing will wake it on its own: suspending a container with a background
 * build in flight would freeze that build, and its completion — the thing that
 * would normally wake the session — could then never arrive.
 */

const SESSION_ID = "session-1";
const ORG_ID = "ws-1";

interface RouterConnectionStub {
	sendSessionState: ReturnType<typeof vi.fn>;
	discardBufferedSessionState: ReturnType<typeof vi.fn>;
}

type AskUserQuestionCallback = (
	input: unknown,
	sessionId: string,
	signal: AbortSignal,
) => Promise<AskUserQuestionResult>;

function makeWorker(opts: {
	pendingWork: boolean;
	platform?: "router" | "linear";
}) {
	const worker = new EdgeWorker({
		platform: opts.platform ?? "router",
		...(opts.platform === "linear"
			? {}
			: { router: { url: "ws://127.0.0.1:9", deviceToken: "tok" } }),
		cyrusHome: "/tmp/cyrus-park-test",
		repositories: [],
	} as never);

	const routerConnection: RouterConnectionStub = {
		sendSessionState: vi.fn(),
		discardBufferedSessionState: vi.fn(),
	};

	const internals = worker as unknown as {
		routerConnection?: RouterConnectionStub;
		agentSessionManager: AgentSessionManager;
		askUserQuestionHandler: { handleAskUserQuestion: unknown };
		createAskUserQuestionCallback: (
			sessionId: string,
			orgId: string,
		) => AskUserQuestionCallback;
	};
	internals.routerConnection = routerConnection;
	vi.spyOn(internals.agentSessionManager, "hasPendingWork").mockReturnValue(
		opts.pendingWork,
	);

	// Hand the test control of when the elicitation settles.
	let settle!: (result: AskUserQuestionResult) => void;
	let fail!: (error: Error) => void;
	const answered = new Promise<AskUserQuestionResult>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	internals.askUserQuestionHandler.handleAskUserQuestion = vi.fn(
		() => answered,
	);

	const callback = internals.createAskUserQuestionCallback(SESSION_ID, ORG_ID);
	const inFlight = callback(
		{ questions: [] },
		"claude-session-1",
		new AbortController().signal,
	);
	// Swallow the rejection path; assertions read the spies, not this promise.
	inFlight.catch(() => {});

	return { routerConnection, settle, fail, inFlight };
}

describe("park on elicitation", () => {
	it("parks before awaiting the answer when nothing is pending", async () => {
		const { routerConnection } = makeWorker({ pendingWork: false });

		expect(routerConnection.sendSessionState).toHaveBeenCalledWith(
			SESSION_ID,
			"parked",
		);
	});

	it("unparks once the user answers", async () => {
		const { routerConnection, settle, inFlight } = makeWorker({
			pendingWork: false,
		});

		settle({ answered: true, answers: { q: "CSV only" } });
		await inFlight;

		expect(routerConnection.discardBufferedSessionState).toHaveBeenCalledWith(
			SESSION_ID,
		);
	});

	it("does not park while background work is in flight", () => {
		// Suspending here would freeze the build, and nothing would ever wake it.
		const { routerConnection } = makeWorker({ pendingWork: true });

		expect(routerConnection.sendSessionState).not.toHaveBeenCalled();
	});

	it("unparks even when the question handler throws", async () => {
		const { routerConnection, fail, inFlight } = makeWorker({
			pendingWork: false,
		});

		fail(new Error("boom"));
		await expect(inFlight).rejects.toThrow("boom");

		// The `finally` must run, or the session stays parked with no live frame
		// to correct it.
		expect(routerConnection.discardBufferedSessionState).toHaveBeenCalledWith(
			SESSION_ID,
		);
	});

	it("does not unpark a session it never parked", async () => {
		const { routerConnection, settle, inFlight } = makeWorker({
			pendingWork: true,
		});

		settle({ answered: true, answers: { q: "CSV only" } });
		await inFlight;

		// Discarding here would drop an unrelated buffered frame for this session.
		expect(routerConnection.discardBufferedSessionState).not.toHaveBeenCalled();
	});

	it("is inert outside router platform mode", async () => {
		const { routerConnection, settle, inFlight } = makeWorker({
			pendingWork: false,
			platform: "linear",
		});

		settle({ answered: true, answers: { q: "CSV only" } });
		await inFlight;

		expect(routerConnection.sendSessionState).not.toHaveBeenCalled();
		expect(routerConnection.discardBufferedSessionState).not.toHaveBeenCalled();
	});
});
