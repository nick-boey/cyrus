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
		const activityFrame = frame(
			"createAgentActivity",
			[{ agentSessionId: "s1", content: { type: "thought", body: "hi" } }],
			{ mutationId: "m1" },
		);
		const first = await executor.dispatch(DEVICE_A, activityFrame);
		const second = await executor.dispatch(DEVICE_A, activityFrame);
		expect(tracker.createAgentActivity).toHaveBeenCalledTimes(1);
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

describe("LinearExecutor.downloadAttachment (token host allowlist)", () => {
	const TOKEN = "secret-linear-token";
	let store: RouterStore;
	let executor: LinearExecutor;
	let fetchMock: ReturnType<typeof vi.fn>;

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
		executor = new LinearExecutor({
			trackers,
			store,
			workspaceTokens: new Map([[WS, TOKEN]]),
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
