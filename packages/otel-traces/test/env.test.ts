import { describe, expect, it } from "vitest";
import { isOtelTracingEnabled, readOtelSampleRatio } from "../src/env.js";

describe("isOtelTracingEnabled", () => {
	it("accepts the spellings an operator actually types", () => {
		for (const value of ["true", "1", "yes", "on", "TRUE", " On "]) {
			expect(isOtelTracingEnabled({ CYRUS_OTEL_TRACES_ENABLED: value })).toBe(
				true,
			);
		}
	});

	it("is off by default so adding this package changes nothing", () => {
		expect(isOtelTracingEnabled({})).toBe(false);
		expect(isOtelTracingEnabled({ CYRUS_OTEL_TRACES_ENABLED: "" })).toBe(false);
	});

	it("treats an explicit false as false", () => {
		// The mistake reading plain truthiness would make: `ENABLED=false` has to
		// mean disabled.
		expect(isOtelTracingEnabled({ CYRUS_OTEL_TRACES_ENABLED: "false" })).toBe(
			false,
		);
		expect(isOtelTracingEnabled({ CYRUS_OTEL_TRACES_ENABLED: "0" })).toBe(
			false,
		);
	});

	it("is independent of the logs flag", () => {
		// Turning tracing off during an incident must not also lose log export.
		expect(isOtelTracingEnabled({ CYRUS_OTEL_LOGS_ENABLED: "true" })).toBe(
			false,
		);
	});
});

describe("readOtelSampleRatio", () => {
	it("reads a fraction", () => {
		expect(
			readOtelSampleRatio({ CYRUS_OTEL_TRACES_SAMPLE_RATIO: "0.25" }),
		).toBe(0.25);
	});

	it("clamps an out-of-range value to the obvious intent", () => {
		// Someone who typed `100` meant "all of it". Refusing to start tracing
		// over a fat-fingered percentage is a worse outcome.
		expect(readOtelSampleRatio({ CYRUS_OTEL_TRACES_SAMPLE_RATIO: "100" })).toBe(
			1,
		);
		expect(readOtelSampleRatio({ CYRUS_OTEL_TRACES_SAMPLE_RATIO: "-1" })).toBe(
			0,
		);
	});

	it("returns undefined for a non-number so the caller's default applies", () => {
		// A typo must NOT silently mean "sample nothing" — that failure looks
		// exactly like a broken exporter.
		expect(
			readOtelSampleRatio({ CYRUS_OTEL_TRACES_SAMPLE_RATIO: "half" }),
		).toBeUndefined();
		expect(readOtelSampleRatio({})).toBeUndefined();
	});
});
