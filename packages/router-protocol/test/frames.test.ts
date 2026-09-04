import { describe, expect, it } from "vitest";
import {
	LOG_INGEST_CAPABILITY,
	PROTOCOL_VERSION,
	parseDeviceFrame,
	parseServerFrame,
	RPC_METHODS,
	SESSION_SCOPED_RPC_METHODS,
	SESSIONS_QUERY_CAPABILITY,
	SPAN_INGEST_CAPABILITY,
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

	it.each(["complete", "error", "stopped", "parked", "active"])(
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

	describe("explicit run facts on session_state", () => {
		const base = { type: "session_state", id: "f1", sessionId: "sess-1" };

		function parse(extra: Record<string, unknown>) {
			const frame = parseDeviceFrame(JSON.stringify({ ...base, ...extra }));
			if (frame.type !== "session_state") throw new Error("wrong type");
			return frame;
		}

		it("parses an explicit elicitation wait that may park its executor", () => {
			const frame = parse({
				state: "waiting",
				wait: { reason: "elicitation", since: "2026-09-04T00:00:00.000Z" },
				executorMayPark: true,
				runner: "claude",
				model: "claude-opus-5",
			});

			expect(frame.state).toBe("waiting");
			expect(frame.wait).toEqual({
				reason: "elicitation",
				since: "2026-09-04T00:00:00.000Z",
			});
			// Parking is a separate declaration from the wait itself: the run is
			// blocked either way, but only some waits leave the container safe to
			// suspend.
			expect(frame.executorMayPark).toBe(true);
			expect(frame.runner).toBe("claude");
			expect(frame.model).toBe("claude-opus-5");
		});

		it("parses an explicit `other` wait carrying its reported condition", () => {
			const frame = parse({
				state: "waiting",
				wait: {
					reason: "other",
					since: "2026-09-04T00:00:00.000Z",
					reportedCondition: "waiting on a deploy lock",
				},
			});

			expect(frame.wait?.reason).toBe("other");
			expect(frame.wait?.reportedCondition).toBe("waiting on a deploy lock");
			// A wait the schema does not model says nothing about the executor, so
			// nothing is parked on its account.
			expect(frame.executorMayPark).toBeUndefined();
		});

		it("refuses an `other` wait with no condition", () => {
			// It exists only to carry a condition v1 does not model. Without the text
			// it records nothing an operator could act on.
			expect(() =>
				parse({
					state: "waiting",
					wait: { reason: "other", since: "2026-09-04T00:00:00.000Z" },
				}),
			).toThrow();
		});

		it("refuses a `waiting` frame with no wait", () => {
			// Waiting is worker-reported. Without the evidence the router would have
			// to guess why, which is the thing this frame exists to stop.
			expect(() => parse({ state: "waiting" })).toThrow();
		});

		it("refuses wait evidence on a frame that is not waiting", () => {
			expect(() =>
				parse({
					state: "active",
					wait: { reason: "elicitation", since: "2026-09-04T00:00:00.000Z" },
				}),
			).toThrow();
		});

		it("carries pending work on an active run", () => {
			// Pending background work is an ACTIVE-run fact, not a wait reason — a
			// seven-hour cron run must stay active and observable with its count.
			const frame = parse({
				state: "active",
				pendingWorkCount: 3,
				runner: "claude",
			});

			expect(frame.state).toBe("active");
			expect(frame.pendingWorkCount).toBe(3);
			expect(frame.wait).toBeUndefined();
		});

		it("keeps parsing a legacy parked frame that carries no facts at all", () => {
			// A pre-run-facts worker sends exactly this. The router reads it as
			// waiting-on-elicitation plus executor parking; nothing here is required.
			const frame = parse({ state: "parked" });

			expect(frame.state).toBe("parked");
			expect(frame.wait).toBeUndefined();
			expect(frame.executorMayPark).toBeUndefined();
		});

		it("ignores facts an older router would not understand", () => {
			// The additive FIELDS are safe against an old router because `z.object`
			// strips unknown keys. Only the new `state` value needs the capability
			// gate, which is why that asymmetry is worth pinning.
			const frame = parse({ state: "complete", somethingNewer: 1 });

			expect(frame.state).toBe("complete");
			expect(frame).not.toHaveProperty("somethingNewer");
		});
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

describe("span frames", () => {
	const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
	const SPAN_ID = "b7ad6b7169203331";

	const span = {
		traceId: TRACE_ID,
		spanId: SPAN_ID,
		traceFlags: 1,
		name: "session.turn",
		kind: 1,
		startTime: [1_800_000_000, 250_000_000],
		endTime: [1_800_000_004, 100_000_000],
		statusCode: 0,
	};

	it("parses a minimal span frame", () => {
		const frame = parseDeviceFrame(
			JSON.stringify({ type: "span", spans: [span] }),
		);
		if (frame.type !== "span") throw new Error("wrong type");
		expect(frame.spans).toHaveLength(1);
		expect(frame.spans[0]?.traceId).toBe(TRACE_ID);
	});

	it("carries the originating process's resource so the router does not restamp it", () => {
		const frame = parseDeviceFrame(
			JSON.stringify({
				type: "span",
				resource: { "service.name": "cyrus-worker" },
				spans: [span],
			}),
		);
		if (frame.type !== "span") throw new Error("wrong type");
		expect(frame.resource).toEqual({ "service.name": "cyrus-worker" });
	});

	it("keeps HrTime as a two-element tuple", () => {
		// A millisecond number would discard the sub-millisecond precision that
		// is the whole reason to look at a span.
		const frame = parseDeviceFrame(
			JSON.stringify({ type: "span", spans: [span] }),
		);
		if (frame.type !== "span") throw new Error("wrong type");
		expect(frame.spans[0]?.startTime).toEqual([1_800_000_000, 250_000_000]);
	});

	it("rejects a wrong-length trace id", () => {
		// A malformed id breaks the backend's own parsing; better to refuse it at
		// the door than to ship a batch that silently disappears downstream.
		expect(() =>
			parseDeviceFrame(
				JSON.stringify({
					type: "span",
					spans: [{ ...span, traceId: "too-short" }],
				}),
			),
		).toThrow();
	});

	it("rejects an empty batch", () => {
		expect(() =>
			parseDeviceFrame(JSON.stringify({ type: "span", spans: [] })),
		).toThrow();
	});

	it("rejects a null attribute value", () => {
		// Unlike a log attribute, OTel has no null span attribute — accepting one
		// would mean inventing a representation for it on the way back out.
		expect(() =>
			parseDeviceFrame(
				JSON.stringify({
					type: "span",
					spans: [{ ...span, attributes: { k: null } }],
				}),
			),
		).toThrow();
	});

	it("carries the device's dropped count so a truncated stream says so", () => {
		const frame = parseDeviceFrame(
			JSON.stringify({ type: "span", spans: [span], dropped: 7 }),
		);
		if (frame.type !== "span") throw new Error("wrong type");
		expect(frame.dropped).toBe(7);
	});

	it("is gated by a router-advertised capability, not a version bump", () => {
		const ack = parseServerFrame(
			JSON.stringify({
				type: "hello_ack",
				user: {},
				serverVersion: "1",
				capabilities: [LOG_INGEST_CAPABILITY, SPAN_INGEST_CAPABILITY],
			}),
		);
		if (ack.type !== "hello_ack") throw new Error("wrong type");
		expect(ack.capabilities).toContain("span_ingest");
		expect(PROTOCOL_VERSION).toBe(2);
	});
});

describe("trace context on dispatch frames", () => {
	const TRACEPARENT = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

	it("carries trace context on an event frame", () => {
		const frame = parseServerFrame(
			JSON.stringify({
				type: "event",
				seq: 1,
				event: {},
				traceparent: TRACEPARENT,
				tracestate: "vendor=v",
			}),
		);
		if (frame.type !== "event") throw new Error("wrong type");
		expect(frame.traceparent).toBe(TRACEPARENT);
		expect(frame.tracestate).toBe("vendor=v");
	});

	it("carries trace context on an rpc_request frame", () => {
		const frame = parseDeviceFrame(
			JSON.stringify({
				type: "rpc_request",
				id: "r1",
				method: "fetchIssue",
				params: ["ABC-1"],
				traceparent: TRACEPARENT,
			}),
		);
		if (frame.type !== "rpc_request") throw new Error("wrong type");
		expect(frame.traceparent).toBe(TRACEPARENT);
	});

	it("treats trace context as optional on both", () => {
		// A build without tracing sends neither, and both sides must tolerate it.
		expect(
			parseServerFrame(JSON.stringify({ type: "event", seq: 1, event: {} })),
		).not.toHaveProperty("traceparent");
		expect(
			parseDeviceFrame(
				JSON.stringify({
					type: "rpc_request",
					id: "r1",
					method: "fetchIssue",
					params: [],
				}),
			),
		).not.toHaveProperty("traceparent");
	});
});
