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
 * The RUN is reported as waiting for the duration of the elicitation, always.
 * Whether its EXECUTOR may be parked is a second, separate declaration on the
 * same frame — and only that one has consequences: suspending a container with
 * a background build in flight would freeze that build, and its completion —
 * the thing that would normally wake the session — could then never arrive.
 *
 * These used to be one decision, which meant a run blocked on a user with a
 * live background build was reported as nothing at all: the seven-hour run that
 * looks like silence (CYR-68).
 */

const SESSION_ID = "session-1";
const ORG_ID = "ws-1";

interface RouterConnectionStub {
	sendSessionState: ReturnType<typeof vi.fn>;
	sendSessionWaiting: ReturnType<typeof vi.fn>;
	sendRunFacts: ReturnType<typeof vi.fn>;
	discardBufferedSessionState: ReturnType<typeof vi.fn>;
	sendSessionUnparked: ReturnType<typeof vi.fn>;
}

type AskUserQuestionCallback = (
	input: unknown,
	sessionId: string,
	signal: AbortSignal,
) => Promise<AskUserQuestionResult>;

function makeWorker(opts: {
	/** How many things will wake this session on their own. */
	pendingWorkCount?: number;
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
		sendSessionWaiting: vi.fn(),
		sendRunFacts: vi.fn(),
		discardBufferedSessionState: vi.fn(),
		sendSessionUnparked: vi.fn(),
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
	const pendingWorkCount = opts.pendingWorkCount ?? 0;
	vi.spyOn(internals.agentSessionManager, "pendingWorkCount").mockReturnValue(
		pendingWorkCount,
	);
	vi.spyOn(internals.agentSessionManager, "getRunFacts").mockReturnValue({
		runner: "claude",
		model: "claude-opus-5",
	});

	// Hand the test control of when the elicitation settles.
	let settle!: (result: AskUserQuestionResult) => void;
	let fail!: (error: Error) => void;
	const answered = new Promise<AskUserQuestionResult>((resolve, reject) => {
		settle = resolve;
		fail = reject;
	});
	// …and of when it is posted. The real handler calls `onPosted` after the
	// elicitation reaches Linear; driving it by hand is what lets these tests
	// pin the ordering rather than just the end state.
	let postElicitation!: () => void;
	internals.askUserQuestionHandler.handleAskUserQuestion = vi.fn(
		(
			_input: unknown,
			_sessionId: string,
			_orgId: string,
			_signal: AbortSignal,
			onPosted?: () => void,
		) => {
			postElicitation = () => onPosted?.();
			return answered;
		},
	);

	const callback = internals.createAskUserQuestionCallback(SESSION_ID, ORG_ID);
	const inFlight = callback(
		{ questions: [] },
		"claude-session-1",
		new AbortController().signal,
	);
	// Swallow the rejection path; assertions read the spies, not this promise.
	inFlight.catch(() => {});

	return { routerConnection, settle, fail, inFlight, postElicitation };
}

describe("wait on elicitation", () => {
	it("does not report waiting until the elicitation has been posted", () => {
		const { routerConnection, postElicitation } = makeWorker({});

		// The waiting report can release the router's session affinity, and
		// posting the elicitation is a session-scoped RPC. Report first and the
		// post is rejected with "session not owned by this device" — the question
		// never reaches the user and every later activity is rejected too
		// (PAR-146).
		expect(routerConnection.sendSessionWaiting).not.toHaveBeenCalled();

		postElicitation();

		expect(routerConnection.sendSessionWaiting).toHaveBeenCalledWith(
			SESSION_ID,
			{ reason: "elicitation", since: expect.any(String) },
			{
				executorMayPark: true,
				runner: "claude",
				model: "claude-opus-5",
				pendingWorkCount: 0,
			},
		);
	});

	it("never reports a wait when the elicitation post fails", async () => {
		const { routerConnection, settle, inFlight } = makeWorker({});

		// The handler returns the failure without ever calling `onPosted`.
		settle({
			answered: false,
			message: "Failed to present question to user: boom",
		});
		await inFlight;

		// Nothing is in front of the user, so nothing would ever wake a parked
		// session — and the agent still needs its affinity to keep posting.
		expect(routerConnection.sendSessionWaiting).not.toHaveBeenCalled();
		expect(routerConnection.sendSessionUnparked).not.toHaveBeenCalled();
	});

	it("stops waiting once the user answers", async () => {
		const { routerConnection, settle, inFlight, postElicitation } = makeWorker(
			{},
		);
		postElicitation();

		settle({ answered: true, answers: { q: "CSV only" } });
		await inFlight;

		// The count is re-read, not carried over from the wait. A session that
		// reported 3 while blocked and finished that work while blocked would
		// otherwise keep reporting 3 until it went terminal, and a stale count is
		// worse evidence than none — it is what a `worker_owns_active_work`
		// recovery refusal keys off.
		expect(routerConnection.sendSessionUnparked).toHaveBeenCalledWith(
			SESSION_ID,
			{ runner: "claude", model: "claude-opus-5", pendingWorkCount: 0 },
		);
	});

	it("still reports the wait while background work is in flight, but withholds park permission", () => {
		const { routerConnection, postElicitation } = makeWorker({
			pendingWorkCount: 2,
		});
		postElicitation();

		// The run IS waiting and says so — reporting nothing here is what made a
		// blocked session with a live build indistinguishable from silence. What
		// pending work withholds is park permission: suspending the container
		// would freeze the build, and nothing would ever wake the session.
		expect(routerConnection.sendSessionWaiting).toHaveBeenCalledWith(
			SESSION_ID,
			{ reason: "elicitation", since: expect.any(String) },
			expect.objectContaining({ executorMayPark: false, pendingWorkCount: 2 }),
		);
	});

	it("stops waiting even when the question handler throws", async () => {
		const { routerConnection, fail, inFlight, postElicitation } = makeWorker(
			{},
		);
		postElicitation();

		fail(new Error("boom"));
		await expect(inFlight).rejects.toThrow("boom");

		// The `finally` must run, or the session stays waiting with no live frame
		// to correct it.
		expect(routerConnection.sendSessionUnparked).toHaveBeenCalledWith(
			SESSION_ID,
			expect.anything(),
		);
	});

	it("clears a wait it reported even when the executor never parked", async () => {
		const { routerConnection, settle, inFlight, postElicitation } = makeWorker({
			pendingWorkCount: 2,
		});
		postElicitation();

		settle({ answered: true, answers: { q: "CSV only" } });
		await inFlight;

		// A wait was reported, so it has to be retracted — otherwise the run reads
		// as blocked forever. Nothing was parked, and `sendSessionUnparked`'s
		// `active` frame grants nothing on the router when there is no park on
		// record, so retracting is safe.
		expect(routerConnection.sendSessionUnparked).toHaveBeenCalledWith(
			SESSION_ID,
			expect.objectContaining({ pendingWorkCount: 2 }),
		);
	});

	it("is inert outside router platform mode", async () => {
		const { routerConnection, settle, inFlight, postElicitation } = makeWorker({
			platform: "linear",
		});
		postElicitation();

		settle({ answered: true, answers: { q: "CSV only" } });
		await inFlight;

		expect(routerConnection.sendSessionWaiting).not.toHaveBeenCalled();
		expect(routerConnection.sendSessionState).not.toHaveBeenCalled();
		expect(routerConnection.sendSessionUnparked).not.toHaveBeenCalled();
	});
});
