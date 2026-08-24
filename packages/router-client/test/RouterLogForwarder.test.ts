import { LogLevel, type LogRecord } from "cyrus-core";
import type { LogFrame } from "cyrus-router-protocol";
import { beforeEach, describe, expect, it } from "vitest";
import type { RouterConnection } from "../src/RouterConnection.js";
import { RouterLogForwarder } from "../src/RouterLogForwarder.js";

/** Minimal stand-in for the two members the forwarder actually touches. */
class FakeConnection {
	acceptsLogs = true;
	online = true;
	throwOnSend = false;
	readonly sent: LogFrame[] = [];

	sendLog(frame: LogFrame): boolean {
		if (this.throwOnSend) throw new Error("socket exploded");
		if (!this.acceptsLogs || !this.online) return false;
		this.sent.push(frame);
		return true;
	}
}

function record(over: Partial<LogRecord> = {}): LogRecord {
	return {
		timestampMs: Date.parse("2026-08-07T12:00:00.000Z"),
		level: LogLevel.WARN,
		component: "EdgeWorker",
		message: "something went sideways",
		context: {},
		...over,
	};
}

describe("RouterLogForwarder", () => {
	let connection: FakeConnection;
	let now: number;
	let forwarder: RouterLogForwarder;

	const build = (
		over: Partial<ConstructorParameters<typeof RouterLogForwarder>[0]> = {},
	) =>
		new RouterLogForwarder({
			connection: connection as unknown as RouterConnection,
			env: {},
			now: () => now,
			...over,
		});

	beforeEach(() => {
		connection = new FakeConnection();
		now = 1_000_000;
		forwarder = build();
	});

	it("defaults to a WARN threshold", () => {
		expect(forwarder.minLevel).toBe(LogLevel.WARN);
	});

	it("forwards a warn record as a log frame", () => {
		forwarder.write(record());
		expect(connection.sent).toEqual([
			{
				type: "log",
				ts: "2026-08-07T12:00:00.000Z",
				level: "warn",
				component: "EdgeWorker",
				message: "something went sideways",
			},
		]);
	});

	it("carries logger context and summarised args", () => {
		forwarder.write(
			record({
				level: LogLevel.ERROR,
				context: {
					sessionId: "sess-1",
					issueIdentifier: "NOR-280",
					repository: "cyrus",
				},
				args: "Error: boom",
			}),
		);
		expect(connection.sent[0]).toMatchObject({
			level: "error",
			sessionId: "sess-1",
			issueIdentifier: "NOR-280",
			repository: "cyrus",
			args: "Error: boom",
		});
	});

	it("drops a record below the threshold without counting it", () => {
		// Logger applies minLevel as a pre-filter, but the sink must hold the
		// line too — nothing guarantees every caller went through Logger.
		forwarder.write(record({ level: LogLevel.INFO }));
		expect(connection.sent).toEqual([]);
		expect(forwarder.droppedCount).toBe(0);
	});

	it("forwards an event even when it is below the threshold", () => {
		// ILogger.event promises a named event always reaches the structured
		// stream — the Phase 1 sandbox.* vocabulary depends on this.
		forwarder.write(
			record({
				level: LogLevel.INFO,
				message: "event:sandbox.gauge",
				event: "sandbox.gauge",
				attributes: { "cyrus.issue_key": "NOR-280", "cyrus.sessions": 2 },
			}),
		);
		expect(connection.sent[0]).toMatchObject({
			event: "sandbox.gauge",
			attributes: { "cyrus.issue_key": "NOR-280", "cyrus.sessions": 2 },
		});
	});

	it("carries an exception across the wire so the router can re-stamp it", () => {
		// `args` is a lossy one-line summary. A stack trace flattened into it is
		// the one thing an operator opening a sandbox error is looking for, so the
		// exception travels as its own structured field.
		forwarder.write(
			record({
				level: LogLevel.ERROR,
				message: "session error",
				exception: {
					type: "TypeError",
					message: "cannot read properties of undefined",
					stacktrace: "TypeError: cannot read…\n    at worker.ts:12:3",
				},
			}),
		);
		expect(connection.sent[0]?.exception).toEqual({
			type: "TypeError",
			message: "cannot read properties of undefined",
			stacktrace: "TypeError: cannot read…\n    at worker.ts:12:3",
		});
	});

	it("bounds an oversized stacktrace before it reaches the socket", () => {
		forwarder.write(
			record({
				level: LogLevel.ERROR,
				exception: {
					type: "Error",
					message: "deep",
					stacktrace: "x".repeat(20_000),
				},
			}),
		);
		expect(connection.sent[0]?.exception?.stacktrace).toHaveLength(
			8_000 + "…[truncated]".length,
		);
	});

	it("omits the exception field for a record that carried none", () => {
		forwarder.write(record({ level: LogLevel.ERROR }));
		expect(connection.sent[0]).not.toHaveProperty("exception");
	});

	it("sends nothing when the router has not advertised log_ingest", () => {
		connection.acceptsLogs = false;
		forwarder.write(record());
		expect(connection.sent).toEqual([]);
		// Not a volume-guard drop: an older router is a deployment fact, and
		// reporting it as loss would misattribute it on a later upgrade.
		expect(forwarder.droppedCount).toBe(0);
	});

	it("rate-limits a burst and reports the loss on the next frame", () => {
		forwarder = build({ ratePerSec: 1, burst: 3 });

		for (let i = 0; i < 10; i++) forwarder.write(record({ message: `m${i}` }));
		expect(connection.sent.map((f) => f.message)).toEqual(["m0", "m1", "m2"]);
		expect(forwarder.droppedCount).toBe(7);

		// One second later the bucket has exactly one token back.
		now += 1_000;
		forwarder.write(record({ message: "after" }));
		expect(connection.sent).toHaveLength(4);
		expect(connection.sent[3]).toMatchObject({ message: "after", dropped: 7 });
		// Reported once, then reset — a later frame must not double-count it.
		expect(forwarder.droppedCount).toBe(0);
		now += 1_000;
		forwarder.write(record({ message: "later" }));
		expect(connection.sent[4]).not.toHaveProperty("dropped");
	});

	it("refills the bucket from wall-clock time, not from timer ticks", () => {
		// An ACA memory suspend freezes every JS timer. A timer-driven refill
		// would resume with an empty bucket and throttle exactly the post-resume
		// lines an operator wants.
		forwarder = build({ ratePerSec: 1, burst: 5 });
		for (let i = 0; i < 5; i++) forwarder.write(record());
		expect(connection.sent).toHaveLength(5);

		now += 60_000; // suspended for a minute; no ticks fired
		for (let i = 0; i < 5; i++) forwarder.write(record());
		expect(connection.sent).toHaveLength(10);
	});

	it("counts an offline send as dropped", () => {
		connection.online = false;
		forwarder.write(record());
		expect(forwarder.droppedCount).toBe(1);

		connection.online = true;
		forwarder.write(record());
		expect(connection.sent[0]).toMatchObject({ dropped: 1 });
	});

	it("counts a throwing send as dropped rather than propagating", () => {
		connection.throwOnSend = true;
		expect(() => forwarder.write(record())).not.toThrow();
		expect(forwarder.droppedCount).toBe(1);
	});

	it("truncates an oversized message", () => {
		forwarder.write(record({ message: "x".repeat(10_000) }));
		const message = connection.sent[0]?.message ?? "";
		expect(message.length).toBeLessThan(4_100);
		expect(message.endsWith("…[truncated]")).toBe(true);
	});

	it("bounds the attribute map and strips undefined values", () => {
		const attributes: Record<string, string | undefined> = { gone: undefined };
		for (let i = 0; i < 100; i++) attributes[`k${i}`] = "v";
		forwarder.write(record({ attributes }));
		const sent = connection.sent[0]?.attributes ?? {};
		expect(Object.keys(sent)).toHaveLength(32);
		expect(sent).not.toHaveProperty("gone");
	});

	it("drops a record produced while a send is already in flight", () => {
		// The sink is called FROM the logger, and the send path has loggers of
		// its own — an unguarded re-entry recurses without bound.
		let reentered = false;
		const recursive = {
			acceptsLogs: true,
			sendLog: (frame: LogFrame): boolean => {
				if (!reentered) {
					reentered = true;
					forwarder.write(record({ message: "from inside the send" }));
				}
				connection.sent.push(frame);
				return true;
			},
		};
		forwarder = build({ connection: recursive as unknown as RouterConnection });
		forwarder.write(record({ message: "outer" }));
		expect(reentered).toBe(true);
		expect(connection.sent.map((f) => f.message)).toEqual(["outer"]);
	});

	it("reads its threshold and rate from the environment", () => {
		forwarder = build({
			env: {
				CYRUS_LOG_FORWARD_LEVEL: "debug",
				CYRUS_LOG_FORWARD_RATE: "10",
				CYRUS_LOG_FORWARD_BURST: "2",
			},
		});
		expect(forwarder.minLevel).toBe(LogLevel.DEBUG);
		forwarder.write(record({ level: LogLevel.DEBUG }));
		forwarder.write(record({ level: LogLevel.DEBUG }));
		forwarder.write(record({ level: LogLevel.DEBUG }));
		expect(connection.sent).toHaveLength(2);
	});

	it("can be silenced entirely without unregistering the sink", () => {
		forwarder = build({ env: { CYRUS_LOG_FORWARD_LEVEL: "silent" } });
		forwarder.write(record({ level: LogLevel.ERROR }));
		expect(connection.sent).toEqual([]);
	});
});
