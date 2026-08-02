import { describe, expect, it } from "vitest";
import {
	PROTOCOL_VERSION,
	parseDeviceFrame,
	parseServerFrame,
	RPC_METHODS,
	SESSION_SCOPED_RPC_METHODS,
	SESSIONS_QUERY_CAPABILITY,
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

	it.each(["complete", "error", "stopped", "parked"])(
		"parses a %s session_state frame",
		(state) => {
			const frame = parseDeviceFrame(
				JSON.stringify({
					type: "session_state",
					id: "f1",
					sessionId: "sess-1",
					state,
				}),
			);
			if (frame.type !== "session_state") throw new Error("wrong type");
			expect(frame.state).toBe(state);
		},
	);

	it("rejects an unknown session_state value", () => {
		expect(() =>
			parseDeviceFrame(
				JSON.stringify({
					type: "session_state",
					id: "f1",
					sessionId: "sess-1",
					state: "napping",
				}),
			),
		).toThrow();
	});

	it("session-scoped methods are a subset of the allowlist", () => {
		for (const m of SESSION_SCOPED_RPC_METHODS) {
			expect(RPC_METHODS).toContain(m);
		}
	});
});

describe("sessions query frames", () => {
	it("parses a sessions_query as a server frame", () => {
		const raw = JSON.stringify({ type: "sessions_query", id: "q-1" });
		expect(parseServerFrame(raw)).toEqual({
			type: "sessions_query",
			id: "q-1",
		});
	});

	it("parses a sessions_report as a device frame", () => {
		const raw = JSON.stringify({
			type: "sessions_report",
			id: "q-1",
			activeSessions: ["sess-1", "sess-2"],
		});
		expect(parseDeviceFrame(raw)).toEqual({
			type: "sessions_report",
			id: "q-1",
			activeSessions: ["sess-1", "sess-2"],
		});
	});

	it("accepts an empty activeSessions list, distinct from omitting the field", () => {
		const raw = JSON.stringify({
			type: "sessions_report",
			id: "q-1",
			activeSessions: [],
		});
		expect(parseDeviceFrame(raw)).toEqual({
			type: "sessions_report",
			id: "q-1",
			activeSessions: [],
		});
		expect(() =>
			parseDeviceFrame(JSON.stringify({ type: "sessions_report", id: "q-1" })),
		).toThrow();
	});

	it("carries optional capabilities on hello without bumping PROTOCOL_VERSION", () => {
		const withCaps = parseDeviceFrame(
			JSON.stringify({
				type: "hello",
				deviceToken: "t",
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
				capabilities: [SESSIONS_QUERY_CAPABILITY],
			}),
		);
		expect(withCaps).toMatchObject({ capabilities: ["sessions_query"] });

		// An old worker omits the field entirely and must still parse.
		const withoutCaps = parseDeviceFrame(
			JSON.stringify({
				type: "hello",
				deviceToken: "t",
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);
		expect(withoutCaps).not.toHaveProperty("capabilities");
	});
});
