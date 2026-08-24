import { SeverityNumber } from "@opentelemetry/api-logs";
import { LogLevel } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { severityFor, severityTextFor } from "../src/severity.js";

describe("severityFor", () => {
	it("maps each emittable level onto the base of its OTel severity band", () => {
		expect(severityFor(LogLevel.DEBUG)).toBe(SeverityNumber.DEBUG);
		expect(severityFor(LogLevel.INFO)).toBe(SeverityNumber.INFO);
		expect(severityFor(LogLevel.WARN)).toBe(SeverityNumber.WARN);
		expect(severityFor(LogLevel.ERROR)).toBe(SeverityNumber.ERROR);
	});

	/**
	 * The numeric values are the wire contract — an exporter ships the number,
	 * not our enum — so pin them rather than only asserting they differ.
	 */
	it("emits the spec's numeric severities", () => {
		expect(severityFor(LogLevel.DEBUG)).toBe(5);
		expect(severityFor(LogLevel.INFO)).toBe(9);
		expect(severityFor(LogLevel.WARN)).toBe(13);
		expect(severityFor(LogLevel.ERROR)).toBe(17);
	});

	it("treats SILENT as unspecified rather than throwing", () => {
		// SILENT is a threshold, not something a call site can emit — but a sink
		// must never be the thing that breaks the call it was describing.
		expect(severityFor(LogLevel.SILENT)).toBe(SeverityNumber.UNSPECIFIED);
	});

	it("degrades an out-of-range level to unspecified", () => {
		expect(severityFor(99 as LogLevel)).toBe(SeverityNumber.UNSPECIFIED);
	});
});

describe("severityTextFor", () => {
	it("reuses the console renderer's level labels", () => {
		expect(severityTextFor(LogLevel.DEBUG)).toBe("DEBUG");
		expect(severityTextFor(LogLevel.INFO)).toBe("INFO");
		expect(severityTextFor(LogLevel.WARN)).toBe("WARN");
		expect(severityTextFor(LogLevel.ERROR)).toBe("ERROR");
	});

	it("has no text for a non-emittable level", () => {
		expect(severityTextFor(LogLevel.SILENT)).toBeUndefined();
	});
});
