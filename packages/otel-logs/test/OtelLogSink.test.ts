import type { LogRecord as OtelApiLogRecord } from "@opentelemetry/api-logs";
import { SeverityNumber } from "@opentelemetry/api-logs";
import type { LogRecord } from "cyrus-core";
import { LogLevel } from "cyrus-core";
import { beforeEach, describe, expect, it } from "vitest";
import { OtelLogSink } from "../src/OtelLogSink.js";

/**
 * Minimal stand-in for the OTel API `Logger`. Deliberately not the real SDK:
 * these tests are about the record→OTLP field mapping, and a real provider would
 * put a batch processor's timing between the assertion and the data.
 */
class FakeOtelLogger {
	readonly emitted: OtelApiLogRecord[] = [];
	throwOnEmit = false;
	/** Set to re-enter the sink from inside emit(), simulating a logging exporter. */
	reenter?: () => void;

	emit(record: OtelApiLogRecord): void {
		if (this.reenter) this.reenter();
		if (this.throwOnEmit) throw new Error("exporter is broken");
		this.emitted.push(record);
	}
}

function record(overrides: Partial<LogRecord> = {}): LogRecord {
	return {
		timestampMs: 1_700_000_000_000,
		level: LogLevel.INFO,
		component: "EventRouter",
		message: "routed webhook",
		context: {},
		...overrides,
	};
}

describe("OtelLogSink", () => {
	let logger: FakeOtelLogger;
	let sink: OtelLogSink;

	beforeEach(() => {
		logger = new FakeOtelLogger();
		sink = new OtelLogSink({ logger, minLevel: LogLevel.DEBUG });
	});

	it("defaults its threshold to INFO", () => {
		expect(new OtelLogSink({ logger }).minLevel).toBe(LogLevel.INFO);
	});

	it("maps timestamp, severity, and body onto the OTel record", () => {
		sink.write(record({ level: LogLevel.WARN, message: "degraded" }));
		expect(logger.emitted).toHaveLength(1);
		expect(logger.emitted[0]).toMatchObject({
			timestamp: 1_700_000_000_000,
			severityNumber: SeverityNumber.WARN,
			severityText: "WARN",
			body: "degraded",
		});
	});

	it("carries the logger context under the JSON console format's key names", () => {
		// Matching Phase 0's key names means an operator's existing KQL transfers
		// verbatim to the OTLP stream.
		sink.write(
			record({
				context: {
					sessionId: "sess-1",
					platform: "linear",
					issueIdentifier: "NOR-281",
					repository: "cyrus",
				},
			}),
		);
		expect(logger.emitted[0]?.attributes).toEqual({
			component: "EventRouter",
			sessionId: "sess-1",
			platform: "linear",
			issueIdentifier: "NOR-281",
			repository: "cyrus",
		});
	});

	it("carries the event name and summarised args", () => {
		sink.write(
			record({
				event: "sandbox_gauge",
				message: "event:sandbox_gauge",
				attributes: { issue_key: "NOR-281", sessions: 2, parked: false },
				args: "Error: underlying",
			}),
		);
		expect(logger.emitted[0]?.attributes).toEqual({
			component: "EventRouter",
			event: "sandbox_gauge",
			args: "Error: underlying",
			issue_key: "NOR-281",
			sessions: 2,
			parked: false,
		});
	});

	describe("exception semconv", () => {
		/**
		 * The one place this sink speaks OTel semconv rather than Cyrus-native
		 * names. `exception.*` is STABLE, describes nothing Cyrus-specific, and is
		 * what makes a backend render the record as an exception rather than a
		 * line of text.
		 */
		it("emits the three stable exception attributes", () => {
			sink.write(
				record({
					level: LogLevel.ERROR,
					message: "session error",
					exception: {
						type: "TypeError",
						message: "cannot read properties of undefined",
						stacktrace: "TypeError: cannot read…\n    at ClaudeRunner.ts:12",
					},
				}),
			);
			expect(logger.emitted[0]?.attributes).toMatchObject({
				"exception.type": "TypeError",
				"exception.message": "cannot read properties of undefined",
				"exception.stacktrace":
					"TypeError: cannot read…\n    at ClaudeRunner.ts:12",
			});
		});

		it("omits exception.stacktrace when the record carried none", () => {
			sink.write(
				record({ exception: { type: "Error", message: "no frames" } }),
			);
			expect(logger.emitted[0]?.attributes).not.toHaveProperty(
				"exception.stacktrace",
			);
		});

		it("gives the stacktrace a larger cap than a plain attribute", () => {
			// The generic 1 KB attribute cap cuts a Node stack (plus any
			// `Caused by:` chain) off around the tenth frame — usually before it
			// reaches our own code, which is the only part worth reading.
			sink.write(
				record({
					exception: {
						type: "Error",
						message: "deep",
						stacktrace: "x".repeat(20_000),
					},
				}),
			);
			expect(
				String(logger.emitted[0]?.attributes?.["exception.stacktrace"]),
			).toHaveLength(8_000 + "…[truncated]".length);
		});

		it("adds nothing when the record has no exception", () => {
			sink.write(record());
			expect(Object.keys(logger.emitted[0]?.attributes ?? {})).not.toContain(
				"exception.type",
			);
		});
	});

	it("preserves a null attribute rather than dropping it", () => {
		// `null` is a meaningful value in the Phase 1/2 event vocabulary — e.g.
		// `issue_key: null` for a line with no issue — and distinct from absent.
		sink.write(record({ attributes: { issue_key: null } }));
		expect(logger.emitted[0]?.attributes).toHaveProperty("issue_key", null);
	});

	it("drops an undefined attribute, which has no wire representation", () => {
		sink.write(record({ attributes: { issue_key: undefined } }));
		expect(logger.emitted[0]?.attributes).not.toHaveProperty("issue_key");
	});

	it("lets a call-site attribute win a collision with a context key", () => {
		// Same precedence as Logger.formatJson, so the OTLP payload and the JSON
		// console line never disagree about a shared key.
		sink.write(
			record({
				context: { repository: "from-context" },
				attributes: { repository: "from-call-site" },
			}),
		);
		expect(logger.emitted[0]?.attributes?.repository).toBe("from-call-site");
	});

	describe("level filtering", () => {
		it("drops records below its threshold", () => {
			const warnSink = new OtelLogSink({ logger, minLevel: LogLevel.WARN });
			warnSink.write(record({ level: LogLevel.INFO, message: "quiet" }));
			warnSink.write(record({ level: LogLevel.ERROR, message: "loud" }));
			expect(logger.emitted.map((r) => r.body)).toEqual(["loud"]);
		});

		it("lets an event ride past a threshold that would otherwise drop it", () => {
			// ILogger.event promises a named event always reaches the structured
			// stream regardless of level.
			const errorSink = new OtelLogSink({ logger, minLevel: LogLevel.ERROR });
			errorSink.write(
				record({
					level: LogLevel.INFO,
					event: "sandbox_started",
					message: "event:sandbox_started",
				}),
			);
			expect(logger.emitted).toHaveLength(1);
		});

		it("re-applies the threshold itself rather than trusting its caller", () => {
			// Logger pre-filters, but a sink handed a record directly (a relay, a
			// test, a future second caller) must still honour its own contract.
			const silent = new OtelLogSink({ logger, minLevel: LogLevel.SILENT });
			silent.write(record({ level: LogLevel.ERROR }));
			expect(logger.emitted).toHaveLength(0);
		});

		it("honours a threshold widened at runtime", () => {
			const warnSink = new OtelLogSink({ logger, minLevel: LogLevel.WARN });
			warnSink.write(record({ level: LogLevel.DEBUG, message: "before" }));
			warnSink.setMinLevel(LogLevel.DEBUG);
			warnSink.write(record({ level: LogLevel.DEBUG, message: "after" }));
			expect(logger.emitted.map((r) => r.body)).toEqual(["after"]);
		});
	});

	describe("bounds", () => {
		it("truncates an oversized message body", () => {
			sink.write(record({ message: "x".repeat(9_000) }));
			const body = String(logger.emitted[0]?.body);
			expect(body).toHaveLength(8_000 + "…[truncated]".length);
			expect(body.endsWith("…[truncated]")).toBe(true);
		});

		it("truncates oversized args and string attributes", () => {
			sink.write(
				record({
					args: "a".repeat(3_000),
					attributes: { blob: "b".repeat(2_000) },
				}),
			);
			expect(String(logger.emitted[0]?.attributes?.args)).toHaveLength(
				2_000 + "…[truncated]".length,
			);
			expect(String(logger.emitted[0]?.attributes?.blob)).toHaveLength(
				1_000 + "…[truncated]".length,
			);
		});

		it("caps the attribute count", () => {
			const attributes: Record<string, number> = {};
			for (let i = 0; i < 200; i++) attributes[`k${i}`] = i;
			sink.write(record({ attributes }));
			expect(Object.keys(logger.emitted[0]?.attributes ?? {})).toHaveLength(64);
		});

		/**
		 * A key already present is an overwrite, not a new slot. If a full map
		 * blocked it, which of two colliding keys won would depend on iteration
		 * order — so the cap must not change the collision winner.
		 */
		it("still applies a colliding attribute once the cap is reached", () => {
			const attributes: Record<string, string | number> = {
				repository: "from-call-site",
			};
			for (let i = 0; i < 200; i++) attributes[`k${i}`] = i;
			sink.write(
				record({ context: { repository: "from-context" }, attributes }),
			);
			expect(logger.emitted[0]?.attributes?.repository).toBe("from-call-site");
		});
	});

	describe("robustness", () => {
		it("never lets a throwing exporter break the call it was describing", () => {
			logger.throwOnEmit = true;
			expect(() => sink.write(record())).not.toThrow();
			expect(sink.droppedCount).toBe(1);
		});

		/**
		 * The sink is called FROM the logger and the exporter beneath it does I/O.
		 * A single log line on that path would otherwise recurse without bound.
		 */
		it("drops a record emitted re-entrantly from the exporter path", () => {
			logger.reenter = () => {
				logger.reenter = undefined;
				sink.write(record({ message: "from inside emit" }));
			};
			sink.write(record({ message: "outer" }));
			expect(logger.emitted.map((r) => r.body)).toEqual(["outer"]);
		});

		it("recovers after a throw rather than latching shut", () => {
			logger.throwOnEmit = true;
			sink.write(record({ message: "lost" }));
			logger.throwOnEmit = false;
			sink.write(record({ message: "delivered" }));
			expect(logger.emitted.map((r) => r.body)).toEqual(["delivered"]);
		});
	});
});
