import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LogRecord, LogSink } from "../../src/logging/index.js";
import {
	createLogger,
	getGlobalLogSink,
	LogLevel,
	resetGlobalLogSink,
	setGlobalLogSink,
} from "../../src/logging/index.js";

class RecordingSink implements LogSink {
	readonly records: LogRecord[] = [];
	constructor(readonly minLevel: LogLevel = LogLevel.DEBUG) {}
	write(record: LogRecord): void {
		this.records.push(record);
	}
}

describe("global LogSink", () => {
	let sink: RecordingSink;

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		sink = new RecordingSink();
		setGlobalLogSink(sink);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetGlobalLogSink();
		delete process.env.CYRUS_LOG_LEVEL;
	});

	it("defaults to a no-op sink that swallows everything", () => {
		resetGlobalLogSink();
		expect(getGlobalLogSink().minLevel).toBe(LogLevel.SILENT);
		expect(() =>
			createLogger({ component: "X" }).error("nobody is listening"),
		).not.toThrow();
	});

	it("returns the previous sink so a host can restore it", () => {
		const replacement = new RecordingSink();
		const previous = setGlobalLogSink(replacement);
		expect(previous).toBe(sink);
		setGlobalLogSink(previous);
		expect(getGlobalLogSink()).toBe(sink);
	});

	it("offers every level to the sink", () => {
		const logger = createLogger({ component: "EdgeWorker" });
		logger.debug("d");
		logger.info("i");
		logger.warn("w");
		logger.error("e");
		expect(sink.records.map((r) => r.level)).toEqual([
			LogLevel.DEBUG,
			LogLevel.INFO,
			LogLevel.WARN,
			LogLevel.ERROR,
		]);
		expect(sink.records[0]).toMatchObject({
			component: "EdgeWorker",
			message: "d",
		});
	});

	it("pre-filters on the sink's own minLevel", () => {
		setGlobalLogSink(new RecordingSink(LogLevel.WARN));
		const logger = createLogger({ component: "EdgeWorker" });
		logger.info("quiet");
		logger.warn("loud");
		const records = (getGlobalLogSink() as RecordingSink).records;
		expect(records.map((r) => r.message)).toEqual(["loud"]);
	});

	/**
	 * The local level governs what an operator sees on the console; the sink
	 * governs what leaves the process. A container running quietly must still be
	 * able to ship its errors.
	 */
	it("forwards independently of the logger's own console level", () => {
		const logger = createLogger({
			component: "EdgeWorker",
			level: LogLevel.SILENT,
		});
		logger.error("still shipped");
		expect(console.error).not.toHaveBeenCalled();
		expect(sink.records.map((r) => r.message)).toEqual(["still shipped"]);
	});

	it("forwards an event past a threshold that would otherwise drop it", () => {
		// ILogger.event promises a named event always reaches the structured
		// stream regardless of level.
		setGlobalLogSink(new RecordingSink(LogLevel.ERROR));
		createLogger({ component: "ContainerLifecycle" }).event("sandbox_gauge", {
			issue_key: "NOR-280",
			sessions: 2,
		});
		const records = (getGlobalLogSink() as RecordingSink).records;
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({
			event: "sandbox_gauge",
			message: "event:sandbox_gauge",
			attributes: { issue_key: "NOR-280", sessions: 2 },
		});
	});

	it("carries the logger's context and summarises trailing args", () => {
		createLogger({ component: "EdgeWorker" })
			.withContext({ sessionId: "sess-1", issueIdentifier: "NOR-280" })
			.error("boom", new Error("underlying"));
		expect(sink.records[0]).toMatchObject({
			context: { sessionId: "sess-1", issueIdentifier: "NOR-280" },
			args: "Error: underlying",
		});
	});

	it("never lets a throwing sink break the call it was describing", () => {
		setGlobalLogSink({
			minLevel: LogLevel.DEBUG,
			write: () => {
				throw new Error("sink is broken");
			},
		});
		expect(() =>
			createLogger({ component: "EdgeWorker" }).warn("still fine"),
		).not.toThrow();
		expect(console.warn).toHaveBeenCalled();
	});
});

describe("LogContext.attributes", () => {
	beforeEach(() => {
		process.env.CYRUS_LOG_FORMAT = "json";
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetGlobalLogSink();
		delete process.env.CYRUS_LOG_FORMAT;
	});

	it("spreads flat attributes into the JSON record", () => {
		createLogger({ component: "sandbox/EdgeWorker" })
			.withContext({ attributes: { device_id: 42, issue_key: "NOR-280" } })
			.warn("relayed");
		const record = JSON.parse(
			String(
				(console.warn as unknown as ReturnType<typeof vi.fn>).mock
					.calls[0]?.[0],
			),
		);
		expect(record).toMatchObject({
			component: "sandbox/EdgeWorker",
			message: "relayed",
			device_id: 42,
			issue_key: "NOR-280",
		});
	});

	it("lets an event's own attributes win a key collision", () => {
		createLogger({ component: "X" })
			.withContext({ attributes: { source: "context" } })
			.event("thing", { source: "event" });
		const record = JSON.parse(
			String(
				(console.log as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
			),
		);
		expect(record.source).toBe("event");
	});

	it("renders attributes in the text format's context braces", () => {
		delete process.env.CYRUS_LOG_FORMAT;
		createLogger({ component: "X" })
			.withContext({ attributes: { device_id: 42 } })
			.warn("hello");
		expect(console.warn).toHaveBeenCalledWith(
			expect.stringContaining("{device_id=42}"),
			...[],
		);
	});
});
