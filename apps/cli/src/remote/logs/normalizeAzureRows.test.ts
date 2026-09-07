import { describe, expect, it } from "vitest";
import { REDACTED } from "../errors.js";
import { consoleRow } from "./fixtures/index.js";
import { type AzureLogRow, normalizeAzureRows } from "./normalizeAzureRows.js";

const INGESTED_AT = "2026-09-07T00:05:42.000Z";

function row(
	record: unknown = consoleRow(),
	timeGenerated: string | Date | undefined = INGESTED_AT,
): AzureLogRow {
	return { timeGenerated, record };
}

describe("normalizeAzureRows", () => {
	it("maps a representative console row onto every named field", () => {
		const { records } = normalizeAzureRows([row()], { knownSecretValues: [] });

		expect(records).toHaveLength(1);
		const [record] = records;
		expect(record).toMatchObject({
			schemaVersion: 1,
			timestamp: "2026-09-07T00:05:00.000Z",
			level: "info",
			component: "EventRouter",
			message: "routed NOR-402 to device 7",
			workspaceId: "ws-1",
			ownerUserId: "user-1",
			issueKey: "NOR-402",
			runId: "run-1",
			sessionId: "session-1",
		});
	});

	it("keeps unhoisted canonical attributes in the attribute bag", () => {
		const { records } = normalizeAzureRows([row()], { knownSecretValues: [] });

		expect(records[0]?.attributes).toMatchObject({
			event: "session.routed",
			"cyrus.team_id": "team-1",
			"cyrus.project_id": "project-1",
			"cyrus.source": "router",
			"cyrus.workspace_name": "Northrop Digital",
			"cyrus.device_id": "7",
		});
	});

	it("does not duplicate a hoisted key into the attribute bag", () => {
		// Every identifier would otherwise appear twice on every record, which
		// doubles the size of a result an operator is already budget-limited on.
		const { records } = normalizeAzureRows([row()], { knownSecretValues: [] });
		const attributes = records[0]?.attributes ?? {};

		for (const key of [
			"timestamp",
			"level",
			"component",
			"message",
			"cyrus.run_id",
			"cyrus.issue_key",
		]) {
			expect(attributes).not.toHaveProperty(key);
		}
	});

	it("prefers the emitter's own clock over the ingestion clock", () => {
		// They are different clocks and the gap between them is ingestion lag. The
		// record's own is what an operator reads.
		const { records } = normalizeAzureRows([row()], { knownSecretValues: [] });

		expect(records[0]?.timestamp).toBe("2026-09-07T00:05:00.000Z");
	});

	it("falls back to the ingestion clock when the record carries no usable one", () => {
		const { records } = normalizeAzureRows(
			[row(consoleRow({ timestamp: "not-a-time" }))],
			{ knownSecretValues: [] },
		);

		expect(records[0]?.timestamp).toBe(INGESTED_AT);
	});

	it("reports the worst ingestion lag it observed", () => {
		const rows = [
			row(consoleRow({ timestamp: "2026-09-07T00:05:00.000Z" }), INGESTED_AT),
			row(consoleRow({ timestamp: "2026-09-07T00:04:00.000Z" }), INGESTED_AT),
		];

		expect(normalizeAzureRows(rows, { knownSecretValues: [] })).toMatchObject({
			maxIngestionLagMs: 102_000,
		});
	});

	it("does not report clock skew as lag", () => {
		// An emitter whose clock runs ahead of Azure's produces a negative gap.
		// Clamping it to zero would report skew as freshness.
		const result = normalizeAzureRows(
			[row(consoleRow({ timestamp: "2026-09-07T00:06:00.000Z" }), INGESTED_AT)],
			{ knownSecretValues: [] },
		);

		expect(result.maxIngestionLagMs).toBeUndefined();
	});

	it("normalizes a non-UTC timestamp to UTC", () => {
		// These strings are compared lexicographically elsewhere, and `+10:00`
		// sorts before `Z` while denoting a later instant.
		const { records } = normalizeAzureRows(
			[row(consoleRow({ timestamp: "2026-09-07T10:05:00+10:00" }))],
			{ knownSecretValues: [] },
		);

		expect(records[0]?.timestamp).toBe("2026-09-07T00:05:00.000Z");
	});

	describe("malformed input", () => {
		it("skips a line that is not JSON, and says how many it skipped", () => {
			// `parse_json` hands a non-JSON line back as a scalar rather than
			// failing. Dropping those quietly would make a surprisingly empty result
			// unexplainable.
			const result = normalizeAzureRows(
				[row("Listening on port 3456"), row()],
				{ knownSecretValues: [] },
			);

			expect(result.records).toHaveLength(1);
			expect(result.skipped).toBe(1);
		});

		it("skips a JSON array, which parses but is not a log record", () => {
			const result = normalizeAzureRows([row([1, 2, 3])], {
				knownSecretValues: [],
			});

			expect(result.records).toHaveLength(0);
			expect(result.skipped).toBe(1);
		});

		it("skips null and undefined records", () => {
			// Built literally rather than through `row()`, whose default parameter
			// would replace an explicit `undefined` with a valid record.
			const result = normalizeAzureRows(
				[
					{ timeGenerated: INGESTED_AT, record: null },
					{ timeGenerated: INGESTED_AT, record: undefined },
				],
				{ knownSecretValues: [] },
			);

			expect(result.records).toHaveLength(0);
			expect(result.skipped).toBe(2);
		});

		it("parses a record handed back as JSON text", () => {
			const result = normalizeAzureRows([row(JSON.stringify(consoleRow()))], {
				knownSecretValues: [],
			});

			expect(result.records[0]?.issueKey).toBe("NOR-402");
			expect(result.skipped).toBe(0);
		});

		it("skips a row with no usable timestamp on either clock", () => {
			// Never a synthesised "now": a fabricated timestamp is indistinguishable
			// from a measured one, and saying when something happened is the point.
			const result = normalizeAzureRows(
				[
					{
						timeGenerated: undefined,
						record: consoleRow({ timestamp: undefined }),
					},
				],
				{ knownSecretValues: [] },
			);

			expect(result.records).toHaveLength(0);
			expect(result.skipped).toBe(1);
		});

		it("defaults an unreadable level to info rather than dropping the line", () => {
			const { records } = normalizeAzureRows(
				[row(consoleRow({ level: "TRACE" }))],
				{ knownSecretValues: [] },
			);

			expect(records[0]?.level).toBe("info");
			// The original text survives in the bag, so nothing is lost.
			expect(records[0]?.message).toBe("routed NOR-402 to device 7");
		});

		it("accepts an upper-case level", () => {
			const { records } = normalizeAzureRows(
				[row(consoleRow({ level: "ERROR" }))],
				{ knownSecretValues: [] },
			);

			expect(records[0]?.level).toBe("error");
		});

		it("tolerates a record with no message", () => {
			const { records } = normalizeAzureRows(
				[row(consoleRow({ message: undefined }))],
				{ knownSecretValues: [] },
			);

			expect(records[0]?.message).toBe("");
		});
	});

	describe("trace correlation", () => {
		it("preserves a well-formed trace and span id", () => {
			const { records } = normalizeAzureRows(
				[
					row(
						consoleRow({
							trace_id: "0af7651916cd43dd8448eb211c80319c",
							span_id: "b7ad6b7169203331",
						}),
					),
				],
				{ knownSecretValues: [] },
			);

			expect(records[0]).toMatchObject({
				traceId: "0af7651916cd43dd8448eb211c80319c",
				spanId: "b7ad6b7169203331",
			});
		});

		it("drops a malformed trace id rather than joining a trace that does not exist", () => {
			// An invalid id looks like an answer, which is strictly worse than no
			// correlation. Same rule as `resolveTraceIds` in cyrus-core.
			const { records } = normalizeAzureRows(
				[row(consoleRow({ trace_id: "not-a-trace", span_id: "nope" }))],
				{ knownSecretValues: [] },
			);

			expect(records[0]?.traceId).toBeUndefined();
			expect(records[0]?.spanId).toBeUndefined();
		});

		it("drops the all-zero ids the W3C spec reserves as invalid", () => {
			const { records } = normalizeAzureRows(
				[
					row(
						consoleRow({
							trace_id: "0".repeat(32),
							span_id: "0".repeat(16),
						}),
					),
				],
				{ knownSecretValues: [] },
			);

			expect(records[0]?.traceId).toBeUndefined();
			expect(records[0]?.spanId).toBeUndefined();
		});
	});

	describe("redaction", () => {
		it("removes a credential-named attribute and marks the record", () => {
			const { records } = normalizeAzureRows(
				[row(consoleRow({ "cyrus.access_token": "aaaa1111bbbb" }))],
				{ knownSecretValues: [] },
			);

			expect(records[0]?.attributes?.["cyrus.access_token"]).toBe(REDACTED);
			expect(records[0]?.redacted).toBe(true);
		});

		it("removes a known environment secret from the message", () => {
			const { records } = normalizeAzureRows(
				[row(consoleRow({ message: "pushing with ghp_realtokenvalue123456" }))],
				{ env: { GITHUB_TOKEN: "ghp_realtokenvalue123456" } },
			);

			expect(records[0]?.message).toBe(`pushing with ${REDACTED}`);
			expect(records[0]?.redacted).toBe(true);
		});

		it("leaves a clean record unmarked", () => {
			const { records } = normalizeAzureRows([row()], {
				knownSecretValues: [],
			});

			expect(records[0]?.redacted).toBeUndefined();
		});
	});

	describe("record fingerprints", () => {
		it("gives the same row the same id on every read", () => {
			// This is what makes a `follow` overlap deduplicable: the id has to be a
			// pure function of the row's content, not an assigned value.
			const first = normalizeAzureRows([row()], { knownSecretValues: [] });
			const second = normalizeAzureRows([row()], { knownSecretValues: [] });

			expect(first.records[0]?.recordId).toBe(second.records[0]?.recordId);
		});

		it("is insensitive to property order", () => {
			// `parse_json` gives no ordering guarantee across queries, and an
			// order-sensitive hash would make a follow re-emit records it had shown.
			const base = consoleRow();
			const reversed = Object.fromEntries(Object.entries(base).reverse());

			expect(
				normalizeAzureRows([row(base)], { knownSecretValues: [] }).records[0]
					?.recordId,
			).toBe(
				normalizeAzureRows([row(reversed)], { knownSecretValues: [] })
					.records[0]?.recordId,
			);
		});

		it("distinguishes two identical messages at different times", () => {
			const a = normalizeAzureRows(
				[row(consoleRow({ timestamp: "2026-09-07T00:05:00.000Z" }))],
				{ knownSecretValues: [] },
			);
			const b = normalizeAzureRows(
				[row(consoleRow({ timestamp: "2026-09-07T00:05:00.001Z" }))],
				{ knownSecretValues: [] },
			);

			expect(a.records[0]?.recordId).not.toBe(b.records[0]?.recordId);
		});

		it("distinguishes two different lines sharing an ingestion timestamp", () => {
			const a = normalizeAzureRows([row(consoleRow({ message: "one" }))], {
				knownSecretValues: [],
			});
			const b = normalizeAzureRows([row(consoleRow({ message: "two" }))], {
				knownSecretValues: [],
			});

			expect(a.records[0]?.recordId).not.toBe(b.records[0]?.recordId);
		});
	});

	it("accepts a Date for the ingestion timestamp, as the SDK returns it", () => {
		const result = normalizeAzureRows(
			[row(consoleRow(), new Date(INGESTED_AT))],
			{ knownSecretValues: [] },
		);

		expect(result.maxIngestionLagMs).toBe(42_000);
	});

	it("returns nothing for no rows", () => {
		expect(normalizeAzureRows([])).toEqual({ records: [], skipped: 0 });
	});
});

describe("the source of this module", () => {
	it("contains no literal control characters", async () => {
		// A regression guard for a real defect: `fingerprint` originally used a
		// literal NUL as its field separator, which made git, grep, and GitHub's
		// diff view treat the whole file as binary — so the module shipped
		// unreviewable and `git diff` reported only `Bin 0 -> 12202 bytes`. Nothing
		// about that failure is visible in the code, and a linter does not catch
		// it, so it is asserted here. Control characters belong in source as
		// escapes.
		const { readFile, readdir } = await import("node:fs/promises");
		const { dirname, join } = await import("node:path");
		const { fileURLToPath } = await import("node:url");

		const here = dirname(fileURLToPath(import.meta.url));
		const offenders: string[] = [];
		for (const entry of await readdir(here)) {
			if (!entry.endsWith(".ts")) continue;
			const text = await readFile(join(here, entry), "utf8");
			const literal = [...text].filter((character) => {
				const code = character.codePointAt(0) ?? 0;
				return code < 32 && character !== "\n" && character !== "\t";
			});
			if (literal.length > 0) offenders.push(entry);
		}

		expect(offenders).toEqual([]);
	});
});
