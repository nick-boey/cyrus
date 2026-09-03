import { describe, expect, it } from "vitest";
import {
	logLevelV1Schema,
	logQueryV1Schema,
	logRecordV1Schema,
	logSourceDescriptorV1Schema,
	logSourceKindV1Schema,
} from "../src/logs.js";
import { azureLogSourceDescriptor, logQuery, logRecord } from "./fixtures.js";

describe("LogSourceDescriptorV1", () => {
	it("round-trips a complete Azure Log Analytics descriptor", () => {
		expect(logSourceDescriptorV1Schema.parse(azureLogSourceDescriptor)).toEqual(
			azureLogSourceDescriptor,
		);
	});

	it("rejects a document with no schema version", () => {
		const { schemaVersion: _omitted, ...withoutVersion } =
			azureLogSourceDescriptor;
		expect(logSourceDescriptorV1Schema.safeParse(withoutVersion).success).toBe(
			false,
		);
	});

	it("closes the log-source kind enum", () => {
		expect(logSourceKindV1Schema.options).toEqual([
			"azure-log-analytics",
			"fake",
		]);
		expect(logSourceKindV1Schema.safeParse("file").success).toBe(false);
	});

	// ADR-0010: the router describes the log source; the client authenticates to
	// it. A descriptor that could carry a credential would make that a lie, so
	// the document is strict and every credential-shaped field is refused.
	it("cannot carry a credential", () => {
		for (const credential of [
			{ sharedKey: "abc" },
			{ apiKey: "abc" },
			{ connectionString: "InstrumentationKey=abc" },
			{ clientSecret: "abc" },
			{ token: "abc" },
		]) {
			expect(
				logSourceDescriptorV1Schema.safeParse({
					...azureLogSourceDescriptor,
					...credential,
				}).success,
			).toBe(false);
			expect(
				logSourceDescriptorV1Schema.safeParse({
					...azureLogSourceDescriptor,
					azure: { ...azureLogSourceDescriptor.azure, ...credential },
				}).success,
			).toBe(false);
		}
	});

	it("pins the canonical Azure table", () => {
		expect(
			logSourceDescriptorV1Schema.safeParse({
				...azureLogSourceDescriptor,
				azure: { ...azureLogSourceDescriptor.azure, table: "AppTraces" },
			}).success,
		).toBe(false);
	});

	it("requires Azure details for an Azure source and forbids them otherwise", () => {
		const { azure: _dropped, ...withoutAzure } = azureLogSourceDescriptor;
		expect(logSourceDescriptorV1Schema.safeParse(withoutAzure).success).toBe(
			false,
		);
		expect(
			logSourceDescriptorV1Schema.safeParse({
				...azureLogSourceDescriptor,
				kind: "fake",
			}).success,
		).toBe(false);
		expect(
			logSourceDescriptorV1Schema.safeParse({ ...withoutAzure, kind: "fake" })
				.success,
		).toBe(true);
	});

	it("advertises the query budgets the client enforces", () => {
		const parsed = logSourceDescriptorV1Schema.parse(azureLogSourceDescriptor);
		expect(parsed.budgets).toEqual({
			defaultLookbackSeconds: 900,
			maxRangeSeconds: 86_400,
			maxRecords: 5_000,
			minFollowIntervalSeconds: 15,
		});
	});

	it("rejects a default lookback wider than the maximum range", () => {
		expect(
			logSourceDescriptorV1Schema.safeParse({
				...azureLogSourceDescriptor,
				budgets: {
					...azureLogSourceDescriptor.budgets,
					defaultLookbackSeconds: 100_000,
				},
			}).success,
		).toBe(false);
	});
});

describe("LogQueryV1", () => {
	it("round-trips a complete normalized query", () => {
		expect(logQueryV1Schema.parse(logQuery)).toEqual(logQuery);
	});

	it("rejects a document with no schema version", () => {
		const { schemaVersion: _omitted, ...withoutVersion } = logQuery;
		expect(logQueryV1Schema.safeParse(withoutVersion).success).toBe(false);
	});

	it("rejects invalid range timestamps", () => {
		expect(
			logQueryV1Schema.safeParse({
				...logQuery,
				range: { from: "15 minutes ago", to: logQuery.range.to },
			}).success,
		).toBe(false);
	});

	it("rejects a range that does not move forward in time", () => {
		expect(
			logQueryV1Schema.safeParse({
				...logQuery,
				range: { from: logQuery.range.to, to: logQuery.range.from },
			}).success,
		).toBe(false);
	});

	it("rejects an unknown log level", () => {
		expect(
			logQueryV1Schema.safeParse({ ...logQuery, levels: ["fatal"] }).success,
		).toBe(false);
		expect(logLevelV1Schema.options).toEqual([
			"debug",
			"info",
			"warn",
			"error",
		]);
	});

	// A request is strict: silently dropping a misspelled filter would widen the
	// query the operator believed they had narrowed.
	it("rejects an unknown filter rather than ignoring it", () => {
		expect(
			logQueryV1Schema.safeParse({ ...logQuery, issuekey: "CYR-64" }).success,
		).toBe(false);
	});

	// KQL and Azure table names do not escape the adapter — ADR-0010.
	it("has no field through which a native query could be smuggled", () => {
		for (const native of [
			{ kql: "ContainerAppConsoleLogs_CL | take 1" },
			{ query: "ContainerAppConsoleLogs_CL" },
			{ table: "AppTraces" },
		]) {
			expect(
				logQueryV1Schema.safeParse({ ...logQuery, ...native }).success,
			).toBe(false);
		}
	});

	it("accepts a minimal query carrying only a range", () => {
		expect(
			logQueryV1Schema.safeParse({
				schemaVersion: 1,
				range: logQuery.range,
			}).success,
		).toBe(true);
	});

	it("rejects a non-positive or fractional record limit", () => {
		for (const limit of [0, -1, 10.5]) {
			expect(logQueryV1Schema.safeParse({ ...logQuery, limit }).success).toBe(
				false,
			);
		}
	});
});

describe("LogRecordV1", () => {
	it("round-trips a complete normalized record", () => {
		expect(logRecordV1Schema.parse(logRecord)).toEqual(logRecord);
	});

	it("rejects a document with no schema version", () => {
		const { schemaVersion: _omitted, ...withoutVersion } = logRecord;
		expect(logRecordV1Schema.safeParse(withoutVersion).success).toBe(false);
	});

	it("rejects an invalid record timestamp", () => {
		expect(
			logRecordV1Schema.safeParse({ ...logRecord, timestamp: "09:59:12" })
				.success,
		).toBe(false);
	});

	it("rejects an unknown level", () => {
		expect(
			logRecordV1Schema.safeParse({ ...logRecord, level: "trace" }).success,
		).toBe(false);
	});

	// The adapter preserves trace context for correlation, so the identifiers
	// must be W3C-shaped rather than whatever the backend column happened to hold.
	it("requires W3C-shaped trace and span identifiers when present", () => {
		expect(
			logRecordV1Schema.safeParse({ ...logRecord, traceId: "abc" }).success,
		).toBe(false);
		expect(
			logRecordV1Schema.safeParse({ ...logRecord, spanId: "00F067AA0BA902B7" })
				.success,
		).toBe(false);
		const { traceId: _t, spanId: _s, ...withoutTrace } = logRecord;
		expect(logRecordV1Schema.safeParse(withoutTrace).success).toBe(true);
	});

	// A response is tolerant: an unmapped backend column is dropped rather than
	// forwarded to the operator, which is also the safer default for redaction.
	it("drops unmapped backend columns instead of forwarding them", () => {
		const parsed = logRecordV1Schema.parse({
			...logRecord,
			_ResourceId: "/subscriptions/…",
			RawMessage: "ANTHROPIC_API_KEY=sk-ant-…",
		});
		expect(parsed).toEqual(logRecord);
	});
});
