import type { IIssueTrackerService } from "cyrus-core";
import type { RpcRequestFrame } from "cyrus-router-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
