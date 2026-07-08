import { EventEmitter } from "node:events";
import type { AgentEvent, IIssueTrackerService } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import type { RouterConnection } from "../src/RouterConnection.js";
import { RouterEventTransport } from "../src/RouterEventTransport.js";
import { RouterIssueTrackerService } from "../src/RouterIssueTrackerService.js";

/** Minimal stub matching the brief's shape, cast via `unknown`. */
function makeStubConnection(): {
	rpc: ReturnType<typeof vi.fn>;
	bufferedRpc: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
} {
	return {
		rpc: vi.fn(async () => ({ id: "i1" })),
		bufferedRpc: vi.fn(async () => ({ success: true })),
		on: vi.fn(),
	};
}

/**
 * A real EventEmitter standing in for RouterConnection, used only for
 * scenario (d) where we need `on("event", …)` to actually register and be
 * invocable so we can assert the synchronous re-emit behavior.
 */
function makeEmitterConnection(): RouterConnection {
	const emitter = new EventEmitter();
	return emitter as unknown as RouterConnection;
}

describe("RouterIssueTrackerService", () => {
	it("(a) fetchIssue calls rpc('fetchIssue', ['ws-1', 'ABC-1'])", async () => {
		const conn = makeStubConnection();
		const svc = new RouterIssueTrackerService(
			conn as unknown as RouterConnection,
			"ws-1",
		);

		await svc.fetchIssue("ABC-1");

		expect(conn.rpc).toHaveBeenCalledWith("fetchIssue", ["ws-1", "ABC-1"]);
	});

	it("(b) createAgentActivity calls bufferedRpc with workspace prepended, and the result satisfies AgentActivityPayload (success:true)", async () => {
		const conn = makeStubConnection();
		const svc = new RouterIssueTrackerService(
			conn as unknown as RouterConnection,
			"ws-1",
		);
		const input = {
			agentSessionId: "s1",
			content: { type: "thought" as const, body: "thinking" },
		};

		const result = await svc.createAgentActivity(input as never);

		expect(conn.bufferedRpc).toHaveBeenCalledWith("createAgentActivity", [
			"ws-1",
			input,
		]);
		expect(conn.rpc).not.toHaveBeenCalled();
		// LinearActivitySink.ts reads `.success` — must be present and true
		// whether the router answered live or the call was buffered offline.
		expect(result.success).toBe(true);
	});

	it("(c) getPlatformType returns 'linear'", () => {
		const conn = makeStubConnection();
		const svc = new RouterIssueTrackerService(
			conn as unknown as RouterConnection,
			"ws-1",
		);

		expect(svc.getPlatformType()).toBe("linear");
	});

	it("getPlatformMetadata returns transport + workspaceId", () => {
		const conn = makeStubConnection();
		const svc = new RouterIssueTrackerService(
			conn as unknown as RouterConnection,
			"ws-1",
		);

		expect(svc.getPlatformMetadata()).toEqual({
			transport: "router",
			workspaceId: "ws-1",
		});
	});

	it("(d) createEventTransport returns a transport whose register() does not throw and which re-emits a connection 'event' as a transport 'event'", () => {
		const conn = makeEmitterConnection();
		const svc = new RouterIssueTrackerService(conn, "ws-1");

		const transport = svc.createEventTransport({
			fastifyServer: {} as never,
			platform: "cli",
		});

		expect(() => transport.register()).not.toThrow();

		const received: AgentEvent[] = [];
		transport.on("event", (event: AgentEvent) => {
			received.push(event);
		});

		const payload = {
			type: "AppUserNotification",
			action: "issueAssignedToYou",
		} as unknown as AgentEvent;
		(conn as unknown as EventEmitter).emit("event", payload, 1);

		expect(received).toEqual([payload]);
	});

	it("re-emits synchronously: the transport's 'event' listener fires before RouterConnection.emit('event', …) returns", () => {
		const conn = makeEmitterConnection();
		const svc = new RouterIssueTrackerService(conn, "ws-1");
		const transport = svc.createEventTransport({
			fastifyServer: {} as never,
			platform: "cli",
		});

		let sawEventDuringEmit = false;
		transport.on("event", () => {
			sawEventDuringEmit = true;
		});

		const delivered = (conn as unknown as EventEmitter).emit(
			"event",
			{ type: "AppUserNotification", action: "issueAssignedToYou" },
			1,
		);

		// By the time RouterConnection's own emit() call returns, our
		// transport listener must already have fired synchronously — this is
		// the Task 10 consumer contract RouterEventTransport must honor.
		expect(delivered).toBe(true);
		expect(sawEventDuringEmit).toBe(true);
	});

	it("type-level conformance: RouterIssueTrackerService satisfies IIssueTrackerService", () => {
		const conn = makeStubConnection();
		// This assignment is the conformance gate: it must compile with every
		// IIssueTrackerService method present with the exact signature.
		const svc: IIssueTrackerService = new RouterIssueTrackerService(
			conn as unknown as RouterConnection,
			"ws-1",
		);
		expect(svc.getPlatformType()).toBe("linear");
	});
});

describe("RouterEventTransport", () => {
	it("subscribes to the connection's 'event' synchronously in the constructor", () => {
		const conn = makeEmitterConnection();
		new RouterEventTransport(conn);

		expect((conn as unknown as EventEmitter).listenerCount("event")).toBe(1);
	});
});
