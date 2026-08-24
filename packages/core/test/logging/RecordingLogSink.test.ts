import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LogLevel } from "../../src/logging/ILogger.js";
import { createLogger } from "../../src/logging/Logger.js";
import {
	getGlobalLogSink,
	setGlobalLogSink,
} from "../../src/logging/LogSink.js";
import {
	installRecordingLogSink,
	RecordingLogSink,
} from "../../src/logging/RecordingLogSink.js";

describe("RecordingLogSink", () => {
	let recorder: ReturnType<typeof installRecordingLogSink>;

	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		recorder = installRecordingLogSink();
	});

	afterEach(() => {
		recorder.restore();
		vi.restoreAllMocks();
	});

	it("records every level in order", () => {
		const logger = createLogger({ component: "EdgeWorker" });
		logger.debug("d");
		logger.info("i");
		logger.warn("w");
		logger.error("e");
		expect(recorder.sink.messages()).toEqual(["d", "i", "w", "e"]);
		expect(recorder.sink.records.map((r) => r.level)).toEqual([
			LogLevel.DEBUG,
			LogLevel.INFO,
			LogLevel.WARN,
			LogLevel.ERROR,
		]);
	});

	it("lists event names, ignoring ordinary log lines", () => {
		const logger = createLogger({ component: "ContainerLifecycle" });
		logger.info("not an event");
		logger.event("sandbox_started");
		logger.event("sandbox_gauge", { sessions: 2 });
		expect(recorder.sink.eventNames()).toEqual([
			"sandbox_started",
			"sandbox_gauge",
		]);
	});

	describe("find", () => {
		beforeEach(() => {
			const logger = createLogger({ component: "EventRouter" });
			logger.warn("no repository matched NOR-281");
			logger.error("boom", new Error("underlying"));
			createLogger({ component: "DeviceGateway" }).info("device connected");
			logger.event("sandbox_gauge", { sessions: 2 });
		});

		/**
		 * Substring, not equality — most call sites interpolate an id or a path,
		 * and a test asserting on the stable part should not have to reproduce the
		 * whole string.
		 */
		it("matches a message by substring", () => {
			expect(
				recorder.sink.find({ message: "no repository matched" }),
			).toMatchObject({ message: "no repository matched NOR-281" });
		});

		it("matches a message by pattern", () => {
			expect(recorder.sink.find({ message: /NOR-\d+/ })).toMatchObject({
				component: "EventRouter",
			});
		});

		it("matches on level, component, and event", () => {
			expect(recorder.sink.find({ level: LogLevel.ERROR })).toMatchObject({
				message: "boom",
				args: "Error: underlying",
			});
			expect(recorder.sink.find({ component: "DeviceGateway" })).toMatchObject({
				message: "device connected",
			});
			expect(recorder.sink.find({ event: "sandbox_gauge" })).toMatchObject({
				attributes: { sessions: 2 },
			});
		});

		it("requires every supplied field to match", () => {
			// Right message, wrong level — must not match.
			expect(
				recorder.sink.find({ message: "boom", level: LogLevel.WARN }),
			).toBeUndefined();
		});

		it("returns undefined rather than throwing when nothing matches", () => {
			expect(recorder.sink.find({ message: "never logged" })).toBeUndefined();
		});

		it("findAll returns every match", () => {
			expect(recorder.sink.findAll({ component: "EventRouter" })).toHaveLength(
				3,
			);
			expect(recorder.sink.findAll({ message: "nope" })).toEqual([]);
		});
	});

	it("clears its buffer without being reinstalled", () => {
		createLogger({ component: "X" }).info("first");
		recorder.sink.clear();
		createLogger({ component: "X" }).info("second");
		expect(recorder.sink.messages()).toEqual(["second"]);
	});

	it("applies its own minLevel as the logger's pre-filter", () => {
		const narrow = new RecordingLogSink(LogLevel.WARN);
		setGlobalLogSink(narrow);
		const logger = createLogger({ component: "X" });
		logger.info("quiet");
		logger.warn("loud");
		expect(narrow.messages()).toEqual(["loud"]);
	});

	describe("installRecordingLogSink", () => {
		it("installs itself process-wide", () => {
			expect(getGlobalLogSink()).toBe(recorder.sink);
		});

		/**
		 * Restoring the PREVIOUS sink rather than resetting to the no-op: a nested
		 * recorder that reset unconditionally would silently disarm the outer one
		 * for the rest of the suite.
		 */
		it("restores the sink that was installed before it", () => {
			const inner = installRecordingLogSink();
			expect(getGlobalLogSink()).toBe(inner.sink);
			inner.restore();
			expect(getGlobalLogSink()).toBe(recorder.sink);
		});

		it("is idempotent, so an afterEach and a finally can both call it", () => {
			const inner = installRecordingLogSink();
			inner.restore();
			// A second restore must not re-install anything, which would undo a
			// sink some later test installed in between.
			const afterFirst = getGlobalLogSink();
			setGlobalLogSink(new RecordingLogSink());
			const replacement = getGlobalLogSink();
			inner.restore();
			expect(getGlobalLogSink()).toBe(replacement);
			expect(afterFirst).toBe(recorder.sink);
		});
	});
});
