import type { IIssueTrackerService } from "cyrus-core";
import type { RpcRequestFrame } from "cyrus-router-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinearExecutor } from "../src/LinearExecutor.js";
import { RouterStore } from "../src/RouterStore.js";

const WS = "ws-1";
const DEVICE_A = 1;
const DEVICE_B = 2;

/** Build an rpc_request frame; the client always prepends workspaceId. */
function frame(
	method: string,
	params: unknown[],
	opts?: { id?: string; mutationId?: string },
): RpcRequestFrame {
	return {
		type: "rpc_request",
		id: opts?.id ?? "req-1",
		method,
		params: [WS, ...params],
		...(opts?.mutationId ? { mutationId: opts.mutationId } : {}),
	};
}

interface StubTracker {
	fetchIssue: ReturnType<typeof vi.fn>;
	createAgentActivity: ReturnType<typeof vi.fn>;
}

function makeExecutor(): {
	executor: LinearExecutor;
	store: RouterStore;
	tracker: StubTracker;
} {
	const store = new RouterStore(":memory:");
	const tracker: StubTracker = {
		fetchIssue: vi.fn(async () => ({ id: "i1" })),
		createAgentActivity: vi.fn(async () => ({ success: true })),
	};
	const trackers = new Map<string, IIssueTrackerService>([
		[WS, tracker as unknown as IIssueTrackerService],
	]);
	const executor = new LinearExecutor({ trackers, store });
	return { executor, store, tracker };
}

/**
 * Builds a `LinearExecutor` whose only tracker is registered under
 * `workspaceId`, backed by a real in-memory `RouterStore` (matching
 * `makeExecutor`'s convention). `tracker` only needs to implement whichever
 * `IIssueTrackerService` methods the test actually exercises.
 */
function executorWithTracker(
	workspaceId: string,
	tracker: Partial<IIssueTrackerService>,
): LinearExecutor {
	const store = new RouterStore(":memory:");
	const trackers = new Map<string, IIssueTrackerService>([
		[workspaceId, tracker as IIssueTrackerService],
	]);
	return new LinearExecutor({ trackers, store });
}

describe("LinearExecutor.dispatch", () => {
	let executor: LinearExecutor;
	let store: RouterStore;
	let tracker: StubTracker;

	beforeEach(() => {
		({ executor, store, tracker } = makeExecutor());
	});

	it("dispatches an allowed method with the workspace param popped", async () => {
		const response = await executor.dispatch(
			DEVICE_A,
			frame("fetchIssue", ["TEAM-123"]),
		);
		expect(tracker.fetchIssue).toHaveBeenCalledTimes(1);
		expect(tracker.fetchIssue).toHaveBeenCalledWith("TEAM-123");
		expect(response).toEqual({
			type: "rpc_response",
			id: "req-1",
			ok: true,
			result: { id: "i1" },
		});
	});

	it("rejects a disallowed method without touching the tracker", async () => {
		const response = await executor.dispatch(
			DEVICE_A,
			frame("dropAllTables", []),
		);
		expect(response).toEqual({
			type: "rpc_response",
			id: "req-1",
			ok: false,
			error: "method not allowed",
		});
		expect(tracker.fetchIssue).not.toHaveBeenCalled();
	});

	it("rejects an unknown workspace", async () => {
		const response = await executor.dispatch(DEVICE_A, {
			type: "rpc_request",
			id: "req-1",
			method: "fetchIssue",
			params: ["ws-unknown", "TEAM-1"],
		});
		expect(response.ok).toBe(false);
		expect(response.error).toContain("workspace");
		expect(tracker.fetchIssue).not.toHaveBeenCalled();
	});

	it("blocks a session-scoped call for a session owned by another device", async () => {
		store.setSessionAffinity("s1", DEVICE_A);
		const activityFrame = frame("createAgentActivity", [
			{ agentSessionId: "s1", content: { type: "thought", body: "hi" } },
		]);
		const response = await executor.dispatch(DEVICE_B, activityFrame);
		expect(response).toEqual({
			type: "rpc_response",
			id: "req-1",
			ok: false,
			error: "session not owned by this device",
		});
		expect(tracker.createAgentActivity).not.toHaveBeenCalled();
	});

	it("allows a session-scoped call for a session owned by the calling device", async () => {
		store.setSessionAffinity("s1", DEVICE_A);
		const activityObserved = vi.spyOn(store, "recordAgentRunActivity");
		const activityFrame = frame("createAgentActivity", [
			{ agentSessionId: "s1", content: { type: "thought", body: "hi" } },
		]);
		const response = await executor.dispatch(DEVICE_A, activityFrame);
		expect(response.ok).toBe(true);
		expect(tracker.createAgentActivity).toHaveBeenCalledTimes(1);
		expect(tracker.createAgentActivity).toHaveBeenCalledWith({
			agentSessionId: "s1",
			content: { type: "thought", body: "hi" },
		});
		expect(activityObserved).toHaveBeenCalledWith("s1", expect.any(Number));
	});

	it("clears a wait when the run publishes an activity", async () => {
		store.addUser({ email: "alice@example.com" });
		const code = store.mintEnrollmentCode("alice@example.com", 1);
		const device = store.redeemEnrollmentCode(code, 1);
		if (!device) throw new Error("enroll failed");
		store.recordAgentRunRouted({
			deviceId: device.deviceId,
			issueKey: "NOR-1",
			sessionId: "s1",
			routedMs: 1_000,
		});
		store.setAgentRunState("s1", "waiting", {
			wait: { reason: "elicitation", sinceMs: 1_100 },
		});
		store.setSessionAffinity("s1", device.deviceId);

		await executor.dispatch(
			device.deviceId,
			frame("createAgentActivity", [
				{ agentSessionId: "s1", content: { type: "thought", body: "hi" } },
			]),
		);

		// A run that just published to the timeline is demonstrably progressing.
		// Leaving the wait behind would go on reporting a block the run itself has
		// disproved — and `lastPublishedActivityAt` is the freshness a caller
		// applies its own staleness policy to.
		const run = store.listAgentRuns({ userId: 1 })[0];
		expect(run?.state).toBe("active");
		expect(run?.wait).toBeUndefined();
		expect(run?.lastAgentActivityMs).toEqual(expect.any(Number));
	});

	it("does not count an activity payload that Linear reports unsuccessful", async () => {
		store.setSessionAffinity("s1", DEVICE_A);
		tracker.createAgentActivity.mockResolvedValueOnce({ success: false });
		const activityObserved = vi.spyOn(store, "recordAgentRunActivity");

		await executor.dispatch(
			DEVICE_A,
			frame("createAgentActivity", [
				{ agentSessionId: "s1", content: { type: "thought", body: "hi" } },
			]),
		);

		expect(activityObserved).not.toHaveBeenCalled();
	});

	it("converts a tracker throw into an ok:false response with the message", async () => {
		tracker.fetchIssue.mockRejectedValueOnce(new Error("boom"));
		const response = await executor.dispatch(
			DEVICE_A,
			frame("fetchIssue", ["TEAM-123"]),
		);
		expect(response).toEqual({
			type: "rpc_response",
			id: "req-1",
			ok: false,
			error: "boom",
		});
	});

	it("dedupes a mutation: same mutationId invokes the tracker exactly once", async () => {
		store.setSessionAffinity("s1", DEVICE_A);
		const activityObserved = vi.spyOn(store, "recordAgentRunActivity");
		const activityFrame = frame(
			"createAgentActivity",
			[{ agentSessionId: "s1", content: { type: "thought", body: "hi" } }],
			{ mutationId: "m1" },
		);
		const first = await executor.dispatch(DEVICE_A, activityFrame);
		const second = await executor.dispatch(DEVICE_A, activityFrame);
		expect(tracker.createAgentActivity).toHaveBeenCalledTimes(1);
		expect(activityObserved).toHaveBeenCalledTimes(1);
		expect(first.ok).toBe(true);
		expect(second).toEqual(first);
	});

	it("never rejects: a pre-invoke store throw becomes an ok:false response", async () => {
		// getMutation runs before the invoke — a corrupt row / DB error here must
		// still return a response frame, never reject across the socket.
		vi.spyOn(store, "getMutation").mockImplementation(() => {
			throw new Error("db boom");
		});
		const response = await executor.dispatch(
			DEVICE_A,
			frame("fetchIssue", ["TEAM-1"], { mutationId: "m9" }),
		);
		expect(response).toEqual({
			type: "rpc_response",
			id: "req-1",
			ok: false,
			error: "db boom",
		});
	});

	// Dispatch checks the RPC_METHODS allowlist before reflecting onto the
	// tracker, so a method absent from that list is rejected at runtime even
	// though it typechecks against the interface.
	it("dispatches fetchIssueInverseRelations (i.e. it is on the allowlist)", async () => {
		const relations = [
			{ id: "rel-1", type: "blocks", issue: { id: "blocker" } },
		];
		const stub = tracker as unknown as Record<string, unknown>;
		stub.fetchIssueInverseRelations = vi.fn(async () => relations);

		const response = await executor.dispatch(
			DEVICE_A,
			frame("fetchIssueInverseRelations", ["issue-uuid"]),
		);

		expect(response.ok).toBe(true);
		if (response.ok) {
			expect(response.result).toEqual(relations);
		}
		expect(stub.fetchIssueInverseRelations).toHaveBeenCalledWith("issue-uuid");
	});
});

describe("LinearExecutor.postActivity", () => {
	it("posts a thought activity to the workspace tracker", async () => {
		const { executor, tracker } = makeExecutor();
		await executor.postActivity(WS, "s1", "hello world");
		expect(tracker.createAgentActivity).toHaveBeenCalledTimes(1);
		const arg = tracker.createAgentActivity.mock.calls[0][0];
		expect(arg.agentSessionId).toBe("s1");
		expect(arg.content.body).toBe("hello world");
	});

	it("is a no-op for an unknown workspace", async () => {
		const { executor, tracker } = makeExecutor();
		await executor.postActivity("ws-unknown", "s1", "hello");
		expect(tracker.createAgentActivity).not.toHaveBeenCalled();
	});
});

describe("LinearExecutor.moveIssueToStartedState", () => {
	/** A tracker whose `fetchIssue` returns an issue with the given state/team. */
	function makeStartedStateExecutor(issue: {
		state?: { type: string; name: string };
		team?: { id: string };
		states?: Array<{
			id: string;
			name: string;
			type: string;
			position: number;
		}>;
	}) {
		const store = new RouterStore(":memory:");
		const tracker = {
			fetchIssue: vi.fn(async () => ({
				id: "i1",
				state: issue.state ? Promise.resolve(issue.state) : undefined,
				team: issue.team ? Promise.resolve(issue.team) : undefined,
			})),
			fetchWorkflowStates: vi.fn(async () => ({ nodes: issue.states ?? [] })),
			updateIssue: vi.fn(async () => ({ id: "i1" })),
		};
		const trackers = new Map<string, IIssueTrackerService>([
			[WS, tracker as unknown as IIssueTrackerService],
		]);
		return {
			executor: new LinearExecutor({ trackers, store }),
			tracker,
		};
	}

	const IN_PROGRESS = {
		id: "st-progress",
		name: "In Progress",
		type: "started",
		position: 1,
	};
	const IN_REVIEW = {
		id: "st-review",
		name: "In Review",
		type: "started",
		position: 2,
	};
	const BACKLOG = {
		id: "st-backlog",
		name: "Backlog",
		type: "backlog",
		position: 0,
	};

	it("moves a backlog issue to the lowest-position started state", async () => {
		const { executor, tracker } = makeStartedStateExecutor({
			state: { type: "backlog", name: "Backlog" },
			team: { id: "team-1" },
			// Deliberately out of order: selection must sort by position, not input order.
			states: [IN_REVIEW, BACKLOG, IN_PROGRESS],
		});

		await expect(executor.moveIssueToStartedState(WS, "i1")).resolves.toBe(
			"In Progress",
		);
		expect(tracker.fetchWorkflowStates).toHaveBeenCalledWith("team-1");
		expect(tracker.updateIssue).toHaveBeenCalledWith("i1", {
			stateId: "st-progress",
		});
	});

	it("is a no-op when the issue is already started", async () => {
		const { executor, tracker } = makeStartedStateExecutor({
			state: { type: "started", name: "In Progress" },
			team: { id: "team-1" },
			states: [IN_PROGRESS],
		});

		await expect(
			executor.moveIssueToStartedState(WS, "i1"),
		).resolves.toBeUndefined();
		expect(tracker.updateIssue).not.toHaveBeenCalled();
	});

	it("is a no-op for an unknown workspace", async () => {
		const { executor, tracker } = makeStartedStateExecutor({
			team: { id: "team-1" },
		});
		await expect(
			executor.moveIssueToStartedState("ws-unknown", "i1"),
		).resolves.toBeUndefined();
		expect(tracker.fetchIssue).not.toHaveBeenCalled();
	});

	it("throws when the team has no started state", async () => {
		const { executor, tracker } = makeStartedStateExecutor({
			state: { type: "backlog", name: "Backlog" },
			team: { id: "team-1" },
			states: [BACKLOG],
		});
		await expect(executor.moveIssueToStartedState(WS, "i1")).rejects.toThrow(
			/no workflow state of type "started"/,
		);
		expect(tracker.updateIssue).not.toHaveBeenCalled();
	});

	it("throws when the issue has no team", async () => {
		const { executor } = makeStartedStateExecutor({
			state: { type: "backlog", name: "Backlog" },
		});
		await expect(executor.moveIssueToStartedState(WS, "i1")).rejects.toThrow(
			/has no team/,
		);
	});
});

describe("LinearExecutor.downloadAttachment (token host allowlist)", () => {
	const TOKEN = "secret-linear-token";
	let store: RouterStore;
	let executor: LinearExecutor;
	let fetchMock: ReturnType<typeof vi.fn>;
	let workspaceTokens: Map<string, string>;

	function okResponse(): Response {
		return {
			ok: true,
			status: 200,
			headers: new Headers({
				"content-type": "image/png",
				"content-length": "3",
			}),
			arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
		} as unknown as Response;
	}

	/** Authorization header (if any) sent on the Nth fetch call. */
	function authHeader(callIndex = 0): string | undefined {
		const init = fetchMock.mock.calls[callIndex]?.[1] as
			| { headers?: Record<string, string> }
			| undefined;
		return init?.headers?.Authorization;
	}

	beforeEach(() => {
		store = new RouterStore(":memory:");
		const tracker: StubTracker = {
			fetchIssue: vi.fn(),
			createAgentActivity: vi.fn(),
		};
		const trackers = new Map<string, IIssueTrackerService>([
			[WS, tracker as unknown as IIssueTrackerService],
		]);
		workspaceTokens = new Map([[WS, TOKEN]]);
		executor = new LinearExecutor({
			trackers,
			store,
			workspaceTokens,
		});
		fetchMock = vi.fn(async () => okResponse());
		vi.stubGlobal("fetch", fetchMock);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("sends the Bearer token to a canonical Linear host (uploads.linear.app)", async () => {
		const res = await executor.dispatch(
			DEVICE_A,
			frame("downloadAttachment", ["https://uploads.linear.app/a/file.png"]),
		);
		expect(res.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(authHeader()).toBe(`Bearer ${TOKEN}`);
	});

	it("sends the Bearer token to a *.linear.app subdomain", async () => {
		const res = await executor.dispatch(
			DEVICE_A,
			frame("downloadAttachment", ["https://cdn.linear.app/a/file.png"]),
		);
		expect(res.ok).toBe(true);
		expect(authHeader()).toBe(`Bearer ${TOKEN}`);
	});

	// RouterServer shares this map by reference with the tracker's refresh
	// callback, so a token rotated by a 401-triggered refresh must be picked up
	// here. Holding a snapshot instead would 401 every attachment download for
	// the ~24h until the next restart.
	it("reads the token through the shared map, so a refresh is picked up", async () => {
		workspaceTokens.set(WS, "rotated-linear-token");

		const res = await executor.dispatch(
			DEVICE_A,
			frame("downloadAttachment", ["https://uploads.linear.app/a/file.png"]),
		);

		expect(res.ok).toBe(true);
		expect(authHeader()).toBe("Bearer rotated-linear-token");
	});

	it("does NOT send the token to an arbitrary attacker host", async () => {
		const res = await executor.dispatch(
			DEVICE_A,
			frame("downloadAttachment", ["https://attacker.example/collect"]),
		);
		// External images still download — just without the credential.
		expect(res.ok).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(authHeader()).toBeUndefined();
	});

	it("treats lookalike hosts as non-Linear (leading-dot suffix check)", async () => {
		for (const host of [
			"https://evil-linear.app/x",
			"https://uploads.linear.app.attacker.com/x",
		]) {
			fetchMock.mockClear();
			const res = await executor.dispatch(
				DEVICE_A,
				frame("downloadAttachment", [host]),
			);
			expect(res.ok).toBe(true);
			expect(authHeader()).toBeUndefined();
		}
	});

	it("does NOT send the token over plain http, even to a Linear host", async () => {
		const res = await executor.dispatch(
			DEVICE_A,
			frame("downloadAttachment", ["http://uploads.linear.app/a/file.png"]),
		);
		expect(res.ok).toBe(true);
		expect(authHeader()).toBeUndefined();
	});

	it("returns ok:false for an unparseable url without fetching", async () => {
		const res = await executor.dispatch(
			DEVICE_A,
			frame("downloadAttachment", ["not a url"]),
		);
		expect(res.ok).toBe(false);
		if (!res.ok) {
			expect(res.error).toBe("invalid attachment url");
		}
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("LinearExecutor.postRepositorySelection", () => {
	it("posts an elicitation carrying a Select signal and the option list", async () => {
		const createAgentActivity = vi.fn(async () => ({ success: true }));
		const executor = executorWithTracker("ws-1", { createAgentActivity });

		await executor.postRepositorySelection("ws-1", "sess-1", "Which repo?", [
			"cyrus-api",
			"cyrus-web",
		]);

		expect(createAgentActivity).toHaveBeenCalledWith({
			agentSessionId: "sess-1",
			content: { type: "elicitation", body: "Which repo?" },
			signal: "select",
			signalMetadata: {
				options: [{ value: "cyrus-api" }, { value: "cyrus-web" }],
			},
		});
	});

	it("is a no-op when the workspace has no configured tracker", async () => {
		const executor = executorWithTracker("ws-other", {
			createAgentActivity: vi.fn(),
		});
		await expect(
			executor.postRepositorySelection("ws-missing", "sess-1", "x", ["a"]),
		).resolves.toBeUndefined();
	});
});

describe("LinearExecutor.postActivity (options)", () => {
	it("still posts a plain thought when no options are given", async () => {
		const createAgentActivity = vi.fn(async () => ({ success: true }));
		const executor = executorWithTracker("ws-1", { createAgentActivity });
		await executor.postActivity("ws-1", "sess-1", "hello");
		expect(createAgentActivity).toHaveBeenCalledWith({
			agentSessionId: "sess-1",
			content: { type: "thought", body: "hello" },
		});
	});
});

describe("LinearExecutor.fetchIssueFacts", () => {
	it("collects team key, project name, labels, and description in one call", async () => {
		const executor = executorWithTracker("ws-1", {
			fetchIssue: vi.fn(async () => ({
				id: "issue-1",
				description: "[repo=cyrus-api]",
				team: Promise.resolve({ key: "NOR" }),
				project: Promise.resolve({ name: "Platform" }),
				labels: async () => ({ nodes: [{ name: "bug" }, { name: "urgent" }] }),
			})),
		} as unknown as Partial<IIssueTrackerService>);

		expect(await executor.fetchIssueFacts("ws-1", "issue-1")).toEqual({
			teamKey: "NOR",
			projectName: "Platform",
			labels: ["bug", "urgent"],
			description: "[repo=cyrus-api]",
		});
	});

	it("omits facts the issue does not carry rather than inventing them", async () => {
		const executor = executorWithTracker("ws-1", {
			fetchIssue: vi.fn(async () => ({
				id: "issue-1",
				team: Promise.resolve(undefined),
				project: Promise.resolve(undefined),
				labels: async () => ({ nodes: [] }),
			})),
		} as unknown as Partial<IIssueTrackerService>);

		expect(await executor.fetchIssueFacts("ws-1", "issue-1")).toEqual({
			labels: [],
		});
	});

	it("returns undefined when the workspace has no tracker", async () => {
		const executor = executorWithTracker("ws-1", { fetchIssue: vi.fn() });
		expect(
			await executor.fetchIssueFacts("ws-missing", "issue-1"),
		).toBeUndefined();
	});

	it("degrades to the facts it did get when a sub-fetch throws", async () => {
		const executor = executorWithTracker("ws-1", {
			fetchIssue: vi.fn(async () => ({
				id: "issue-1",
				description: "hello",
				team: Promise.resolve({ key: "NOR" }),
				get project(): Promise<never> {
					throw new Error("project unavailable");
				},
				labels: async () => {
					throw new Error("labels unavailable");
				},
			})),
		} as unknown as Partial<IIssueTrackerService>);

		expect(await executor.fetchIssueFacts("ws-1", "issue-1")).toEqual({
			teamKey: "NOR",
			description: "hello",
			labels: [],
		});
	});

	it("degrades to the facts it did get when the team fetch throws", async () => {
		const executor = executorWithTracker("ws-1", {
			fetchIssue: vi.fn(async () => ({
				id: "issue-1",
				description: "hello",
				team: Promise.reject(new Error("team unavailable")),
				project: Promise.resolve({ name: "Platform" }),
				labels: async () => ({ nodes: [{ name: "bug" }] }),
			})),
		} as unknown as Partial<IIssueTrackerService>);

		expect(await executor.fetchIssueFacts("ws-1", "issue-1")).toEqual({
			projectName: "Platform",
			description: "hello",
			labels: ["bug"],
		});
	});

	it("returns undefined when fetchIssue itself throws", async () => {
		const executor = executorWithTracker("ws-1", {
			fetchIssue: vi.fn(async () => {
				throw new Error("Linear 500");
			}),
		});
		expect(await executor.fetchIssueFacts("ws-1", "issue-1")).toBeUndefined();
	});
});
