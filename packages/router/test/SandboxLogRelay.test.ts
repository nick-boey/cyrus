import type { LogFrame } from "cyrus-router-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxLogRelay } from "../src/SandboxLogRelay.js";

function frame(over: Partial<LogFrame> = {}): LogFrame {
	return {
		type: "log",
		ts: "2026-08-07T12:00:00.000Z",
		level: "warn",
		component: "EdgeWorker",
		message: "something went sideways",
		...over,
	};
}

/**
 * The relay's whole job is to put a line on the router's stdout in a shape Log
 * Analytics can index, so the assertions are on the rendered JSON line.
 */
function parseLine(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
	const call = spy.mock.calls[0];
	if (!call) throw new Error("nothing was logged");
	return JSON.parse(String(call[0])) as Record<string, unknown>;
}

describe("SandboxLogRelay", () => {
	let warn: ReturnType<typeof vi.spyOn>;
	let error: ReturnType<typeof vi.spyOn>;
	let log: ReturnType<typeof vi.spyOn>;
	let relay: SandboxLogRelay;

	beforeEach(() => {
		process.env.CYRUS_LOG_FORMAT = "json";
		process.env.CYRUS_LOG_LEVEL = "DEBUG";
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		error = vi.spyOn(console, "error").mockImplementation(() => {});
		log = vi.spyOn(console, "log").mockImplementation(() => {});
		relay = new SandboxLogRelay();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		process.env.CYRUS_LOG_FORMAT = undefined;
		process.env.CYRUS_LOG_LEVEL = undefined;
	});

	it("attributes the line to the device and issue the ROUTER knows", () => {
		relay.relay(frame(), {
			deviceId: 42,
			issueKey: "NOR-280",
			provider: "aca",
		});
		const line = parseLine(warn);
		expect(line).toMatchObject({
			level: "warn",
			component: "sandbox/EdgeWorker",
			message: "something went sideways",
			"cyrus.source": "sandbox",
			"cyrus.device_id": 42,
			"cyrus.issue_key": "NOR-280",
			"cyrus.provider": "aca",
			issueIdentifier: "NOR-280",
			"cyrus.emitted_at": "2026-08-07T12:00:00.000Z",
		});
	});

	it("ignores the issue the DEVICE claims, recording the disagreement", () => {
		// A worker must not be able to label its logs with someone else's issue.
		relay.relay(frame({ issueIdentifier: "NOR-999" }), {
			deviceId: 7,
			issueKey: "NOR-280",
		});
		const line = parseLine(warn);
		expect(line["cyrus.issue_key"]).toBe("NOR-280");
		expect(line["cyrus.reported_issue_identifier"]).toBe("NOR-999");
	});

	it("omits cyrus.reported_issue_identifier when the two agree", () => {
		relay.relay(frame({ issueIdentifier: "NOR-280" }), {
			deviceId: 7,
			issueKey: "NOR-280",
		});
		expect(parseLine(warn)).not.toHaveProperty(
			"cyrus.reported_issue_identifier",
		);
	});

	it("emits null attribution rather than dropping it for an unknown device", () => {
		// `where isnull(p["cyrus.issue_key"])` must find these; a missing column
		// would not.
		relay.relay(frame(), { deviceId: 3 });
		const line = parseLine(warn);
		expect(line["cyrus.issue_key"]).toBeNull();
		expect(line["cyrus.provider"]).toBeNull();
	});

	it("preserves the worker's level, including error", () => {
		relay.relay(frame({ level: "error", message: "boom" }), { deviceId: 1 });
		expect(parseLine(error)).toMatchObject({ level: "error", message: "boom" });
	});

	it.each([
		["debug", "debug"],
		["info", "info"],
	])("maps %s straight across", (level, expected) => {
		relay.relay(frame({ level: level as LogFrame["level"] }), { deviceId: 1 });
		expect(parseLine(log)).toMatchObject({ level: expected });
	});

	it("surfaces the device's dropped count as a queryable attribute", () => {
		relay.relay(frame({ dropped: 17 }), { deviceId: 1 });
		expect(parseLine(warn)["cyrus.dropped"]).toBe(17);
	});

	it("omits cyrus.dropped when nothing was dropped", () => {
		relay.relay(frame({ dropped: 0 }), { deviceId: 1 });
		expect(parseLine(warn)).not.toHaveProperty("cyrus.dropped");
	});

	it("spreads the worker's own attributes but never over the attribution keys", () => {
		// The worker's attributes arrive already namespaced (its own `event()`
		// calls go through `cyrusAttributes`), so a spoof attempt collides with
		// the router's attribution keys exactly — which is what must lose.
		relay.relay(
			frame({
				attributes: {
					"cyrus.sessions": 2,
					"cyrus.device_id": 999,
					"cyrus.issue_key": "NOR-999",
					"cyrus.source": "spoofed",
				},
			}),
			{ deviceId: 42, issueKey: "NOR-280" },
		);
		const line = parseLine(warn);
		expect(line).toMatchObject({
			"cyrus.sessions": 2,
			"cyrus.device_id": 42,
			"cyrus.issue_key": "NOR-280",
			"cyrus.source": "sandbox",
		});
	});

	it("re-stamps a worker's exception with the WORKER's stack, not the router's", () => {
		// Passing it back through `logger.error(msg, err)` is what makes the
		// router derive the same `exception.*` semconv it would for a local
		// failure. A freshly-constructed Error would carry the relay's own frames
		// — which describe how the line reached the router and nothing about why
		// the sandbox failed.
		relay.relay(
			frame({
				level: "error",
				message: "session error",
				exception: {
					type: "TypeError",
					message: "cannot read properties of undefined",
					stacktrace: "TypeError: cannot read…\n    at worker.ts:12:3",
				},
			}),
			{ deviceId: 1, issueKey: "NOR-282" },
		);
		expect(parseLine(error).error).toMatchObject({
			name: "TypeError",
			message: "cannot read properties of undefined",
			stack: "TypeError: cannot read…\n    at worker.ts:12:3",
		});
	});

	it("relays a frame with no exception unchanged", () => {
		relay.relay(frame({ level: "error", message: "plain" }), { deviceId: 1 });
		expect(parseLine(error)).not.toHaveProperty("error");
	});

	it("carries the event name and Phase 5 trace context through", () => {
		relay.relay(
			frame({
				level: "info",
				event: "sandbox.gauge",
				traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
				tracestate: "cyrus=1",
			}),
			{ deviceId: 1 },
		);
		expect(parseLine(log)).toMatchObject({
			event: "sandbox.gauge",
			traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
			tracestate: "cyrus=1",
		});
	});

	it("truncates an oversized message a misbehaving device sent", () => {
		relay.relay(frame({ message: "x".repeat(50_000) }), { deviceId: 1 });
		const message = String(parseLine(warn).message);
		expect(message.length).toBeLessThan(8_100);
		expect(message.endsWith("…[truncated]")).toBe(true);
	});

	it("does not grow an unbounded logger cache from device-supplied components", () => {
		for (let i = 0; i < 200; i++) {
			relay.relay(frame({ component: `c${i}` }), { deviceId: 1 });
		}
		expect(warn).toHaveBeenCalledTimes(200);
		const cache = (relay as unknown as { loggers: Map<string, unknown> })
			.loggers;
		expect(cache.size).toBeLessThanOrEqual(64);
	});

	it("never throws on a malformed frame — that would kill the device socket", () => {
		expect(() =>
			relay.relay(frame({ component: "" }), { deviceId: 1 }),
		).not.toThrow();
		expect(parseLine(warn).component).toBe("sandbox/unknown");
	});
});
