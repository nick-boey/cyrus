import { LogLevel } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	isOtelLoggingEnabled,
	parseOtelLogLevel,
	readOtelLogLevel,
	readOtelResourceEnvOverrides,
} from "../src/env.js";

describe("isOtelLoggingEnabled", () => {
	it("is off when unset, so adding this package changes nothing by itself", () => {
		expect(isOtelLoggingEnabled({})).toBe(false);
	});

	it("accepts the spellings an operator plausibly writes", () => {
		for (const value of ["true", "TRUE", "True", "1", "yes", "on", " true "]) {
			expect(isOtelLoggingEnabled({ CYRUS_OTEL_LOGS_ENABLED: value })).toBe(
				true,
			);
		}
	});

	/**
	 * The mistake a truthiness check would make. `ENABLED=false` must mean
	 * disabled — an operator turning telemetry off by editing the value, rather
	 * than deleting the variable, is the common case.
	 */
	it("treats every other value as off, including 'false' and empty", () => {
		for (const value of ["false", "0", "no", "off", "", "  ", "maybe"]) {
			expect(isOtelLoggingEnabled({ CYRUS_OTEL_LOGS_ENABLED: value })).toBe(
				false,
			);
		}
	});
});

describe("parseOtelLogLevel", () => {
	it("parses every level name, case- and whitespace-insensitively", () => {
		expect(parseOtelLogLevel("debug")).toBe(LogLevel.DEBUG);
		expect(parseOtelLogLevel("INFO")).toBe(LogLevel.INFO);
		expect(parseOtelLogLevel(" warn ")).toBe(LogLevel.WARN);
		expect(parseOtelLogLevel("Error")).toBe(LogLevel.ERROR);
		// SILENT stops export volume without unregistering the pipeline.
		expect(parseOtelLogLevel("SILENT")).toBe(LogLevel.SILENT);
	});

	it("returns undefined for unset or unrecognised values", () => {
		// So a typo means "use the caller's default", not "ship everything".
		expect(parseOtelLogLevel(undefined)).toBeUndefined();
		expect(parseOtelLogLevel("")).toBeUndefined();
		expect(parseOtelLogLevel("verbose")).toBeUndefined();
	});

	it("reads the level off the environment", () => {
		expect(readOtelLogLevel({ CYRUS_OTEL_LOGS_LEVEL: "warn" })).toBe(
			LogLevel.WARN,
		);
		expect(readOtelLogLevel({})).toBeUndefined();
	});
});

describe("readOtelResourceEnvOverrides", () => {
	it("reads every override", () => {
		expect(
			readOtelResourceEnvOverrides({
				CYRUS_OTEL_SERVICE_NAME: "cyrus-router",
				CYRUS_OTEL_SERVICE_VERSION: "1.2.3",
				CYRUS_OTEL_SERVICE_INSTANCE_ID: "replica-7",
				CYRUS_OTEL_DEPLOYMENT_ENV: "staging",
				CYRUS_OTEL_CLOUD_REGION: "australiaeast",
			}),
		).toEqual({
			serviceName: "cyrus-router",
			serviceVersion: "1.2.3",
			serviceInstanceId: "replica-7",
			deploymentEnvironment: "staging",
			cloudRegion: "australiaeast",
		});
	});

	it("omits keys entirely rather than setting them undefined", () => {
		// The result is spread over host-derived defaults, so a present-but-
		// undefined key would erase the better value underneath it.
		expect(readOtelResourceEnvOverrides({})).toEqual({});
		expect(
			readOtelResourceEnvOverrides({ CYRUS_OTEL_SERVICE_NAME: "  " }),
		).toEqual({});
	});

	it("trims values it keeps", () => {
		expect(
			readOtelResourceEnvOverrides({ CYRUS_OTEL_CLOUD_REGION: " eastus " }),
		).toEqual({ cloudRegion: "eastus" });
	});
});
