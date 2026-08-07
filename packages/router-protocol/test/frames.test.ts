import { describe, expect, it } from "vitest";
import {
	LOG_INGEST_CAPABILITY,
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

describe("log frames", () => {
	const minimal = {
		type: "log",
		ts: "2026-08-07T12:00:00.000Z",
		level: "warn",
		component: "EdgeWorker",
		message: "something went sideways",
	};

	it("parses a minimal log frame as a device frame", () => {
		expect(parseDeviceFrame(JSON.stringify(minimal))).toEqual(minimal);
	});

	it.each(["debug", "info", "warn", "error"])("accepts level %s", (level) => {
		const frame = parseDeviceFrame(JSON.stringify({ ...minimal, level }));
		if (frame.type !== "log") throw new Error("wrong type");
		expect(frame.level).toBe(level);
	});

	it("rejects a level outside the vocabulary", () => {
		expect(() =>
			parseDeviceFrame(JSON.stringify({ ...minimal, level: "fatal" })),
		).toThrow();
	});

	it("carries event, attributes, dropped and session context", () => {
		const frame = parseDeviceFrame(
			JSON.stringify({
				...minimal,
				level: "info",
				event: "sandbox_gauge",
				sessionId: "sess-1",
				issueIdentifier: "NOR-280",
				repository: "cyrus",
				attributes: {
					issue_key: "NOR-280",
					sessions: 2,
					online: true,
					x: null,
				},
				args: "Error: boom",
				dropped: 17,
			}),
		);
		if (frame.type !== "log") throw new Error("wrong type");
		expect(frame.event).toBe("sandbox_gauge");
		expect(frame.attributes).toEqual({
			issue_key: "NOR-280",
			sessions: 2,
			online: true,
			x: null,
		});
		expect(frame.dropped).toBe(17);
	});

	it("rejects a non-primitive attribute value", () => {
		expect(() =>
			parseDeviceFrame(
				JSON.stringify({ ...minimal, attributes: { nested: { a: 1 } } }),
			),
		).toThrow();
	});

	it("rejects a negative dropped count", () => {
		expect(() =>
			parseDeviceFrame(JSON.stringify({ ...minimal, dropped: -1 })),
		).toThrow();
	});

	it("reserves traceparent/tracestate for Phase 5 without requiring them", () => {
		const frame = parseDeviceFrame(
			JSON.stringify({
				...minimal,
				traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
				tracestate: "cyrus=1",
			}),
		);
		if (frame.type !== "log") throw new Error("wrong type");
		expect(frame.traceparent).toBe(
			"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
		);
		expect(parseDeviceFrame(JSON.stringify(minimal))).not.toHaveProperty(
			"traceparent",
		);
	});

	it("does not bump PROTOCOL_VERSION — the router negotiates via hello_ack", () => {
		// A bump would reject every not-yet-updated worker outright. Instead the
		// router advertises the capability and an old router simply never does.
		expect(PROTOCOL_VERSION).toBe(2);

		const ack = parseServerFrame(
			JSON.stringify({
				type: "hello_ack",
				user: {},
				serverVersion: "1",
				capabilities: [LOG_INGEST_CAPABILITY],
			}),
		);
		if (ack.type !== "hello_ack") throw new Error("wrong type");
		expect(ack.capabilities).toEqual(["log_ingest"]);

		// An older router omits the field; the device reads that as "no logs".
		const legacy = parseServerFrame(
			JSON.stringify({ type: "hello_ack", user: {}, serverVersion: "1" }),
		);
		expect(legacy).not.toHaveProperty("capabilities");
	});
});
