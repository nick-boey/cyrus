import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, LogLevel } from "../../src/logging/index.js";

/**
 * Parse the single argument a JSON-format log call passes to console.
 * Asserting on the parsed object (rather than the raw string) is the whole
 * point of the format: a Log Analytics query sees fields, not prose.
 */
function parsed(spy: ReturnType<typeof vi.spyOn>, call = 0): any {
	const args = spy.mock.calls[call];
	expect(args, `expected a console call at index ${call}`).toBeDefined();
	expect(
		args!.length,
		"JSON format must emit exactly one console argument",
	).toBe(1);
	return JSON.parse(args![0] as string);
}

describe("Logger CYRUS_LOG_FORMAT=json", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		process.env.CYRUS_LOG_FORMAT = "json";
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.CYRUS_LOG_FORMAT;
		delete process.env.CYRUS_LOG_LEVEL;
	});

	it("emits one parseable JSON object per line with the core fields", () => {
		createLogger({ component: "DeviceGateway" }).info("Device 7 connected");

		const record = parsed(logSpy);
		expect(record).toMatchObject({
			level: "info",
			component: "DeviceGateway",
			message: "Device 7 connected",
		});
		expect(Date.parse(record.timestamp)).not.toBeNaN();
	});

	it("labels each level and keeps the console sink each level already used", () => {
		const logger = createLogger({
			component: "Test",
			level: LogLevel.DEBUG,
		});
		logger.debug("d");
		logger.info("i");
		logger.warn("w");
		logger.error("e");

		expect(parsed(logSpy, 0).level).toBe("debug");
		expect(parsed(logSpy, 1).level).toBe("info");
		expect(parsed(warnSpy).level).toBe("warn");
		expect(parsed(errorSpy).level).toBe("error");
	});

	it("promotes context into top-level queryable fields", () => {
		createLogger({ component: "EventRouter" })
			.withContext({
				sessionId: "sess-1",
				platform: "linear",
				issueIdentifier: "NOR-278",
				repository: "cyrus",
			})
			.info("routed");

		expect(parsed(logSpy)).toMatchObject({
			sessionId: "sess-1",
			platform: "linear",
			issueIdentifier: "NOR-278",
			repository: "cyrus",
		});
	});

	it("hoists a trailing Error to `error` with its stack intact", () => {
		const boom = new TypeError("wake failed");
		createLogger({ component: "ContainerTargets" }).error(
			"Container boot failed for NOR-1",
			boom,
		);

		const record = parsed(errorSpy);
		expect(record.error).toMatchObject({
			name: "TypeError",
			message: "wake failed",
		});
		// The stack is the reason we stopped pre-stringifying with String(err).
		expect(record.error.stack).toContain("wake failed");
		// The hoisted Error is not also duplicated into `args`.
		expect(record.args).toBeUndefined();
	});

	it("keeps non-Error trailing args in `args`", () => {
		createLogger({ component: "Test" }).info("boot", { deviceId: 7 }, "extra");

		expect(parsed(logSpy).args).toEqual([{ deviceId: 7 }, "extra"]);
	});

	it("renders event() with a dedicated `event` field", () => {
		createLogger({ component: "Test" }).event("session.started", {
			sessionId: "s1",
		});

		expect(parsed(logSpy)).toMatchObject({
			level: "info",
			event: "session.started",
			sessionId: "s1",
			message: "event:session.started",
		});
	});

	it("survives a circular arg instead of throwing on the log call", () => {
		const circular: Record<string, unknown> = { name: "loop" };
		circular.self = circular;

		expect(() =>
			createLogger({ component: "Test" }).info("cycle", circular),
		).not.toThrow();
		expect(parsed(logSpy).args[0]).toMatchObject({ name: "loop" });
	});

	it("leaves text output unchanged when the env var is unset", () => {
		delete process.env.CYRUS_LOG_FORMAT;
		createLogger({ component: "Test" }).info("plain message", "tail");

		const [line, ...rest] = logSpy.mock.calls[0] as [string, ...unknown[]];
		expect(line).toMatch(/\[INFO \] \[Test\] plain message$/);
		expect(rest).toEqual(["tail"]);
	});

	it("honours an explicit format option over the env var", () => {
		createLogger({ component: "Test", format: "text" }).info("still text");

		expect(logSpy.mock.calls[0]![0]).toContain("[Test] still text");
		expect(() => JSON.parse(logSpy.mock.calls[0]![0] as string)).toThrow();
	});

	it("carries the explicit format through withContext", () => {
		delete process.env.CYRUS_LOG_FORMAT;
		createLogger({ component: "Test", format: "json" })
			.withContext({ sessionId: "s1" })
			.info("child");

		expect(parsed(logSpy)).toMatchObject({ message: "child", sessionId: "s1" });
	});
});
