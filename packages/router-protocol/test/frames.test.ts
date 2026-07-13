import { describe, expect, it } from "vitest";
import {
	PROTOCOL_VERSION,
	parseDeviceFrame,
	parseServerFrame,
	RPC_METHODS,
	SESSION_SCOPED_RPC_METHODS,
} from "../src/index.js";

describe("frames", () => {
	it("round-trips a hello frame", () => {
		const frame = parseDeviceFrame(
			JSON.stringify({
				type: "hello",
				deviceToken: "tok",
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);
		expect(frame.type).toBe("hello");
	});

	it("rejects an unknown frame type", () => {
		expect(() => parseDeviceFrame(JSON.stringify({ type: "nope" }))).toThrow();
	});

	it("parses an rpc_request with positional params", () => {
		const frame = parseDeviceFrame(
			JSON.stringify({
				type: "rpc_request",
				id: "r1",
				method: "fetchIssue",
				params: ["ABC-1"],
			}),
		);
		if (frame.type !== "rpc_request") throw new Error("wrong type");
		expect(frame.method).toBe("fetchIssue");
	});

	it("parses a server event frame with opaque payload", () => {
		const frame = parseServerFrame(
			JSON.stringify({ type: "event", seq: 7, event: { action: "created" } }),
		);
		if (frame.type !== "event") throw new Error("wrong type");
		expect(frame.seq).toBe(7);
	});

	it("session-scoped methods are a subset of the allowlist", () => {
		for (const m of SESSION_SCOPED_RPC_METHODS) {
			expect(RPC_METHODS).toContain(m);
		}
	});
});
