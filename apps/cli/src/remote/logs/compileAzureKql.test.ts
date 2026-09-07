import { describe, expect, it } from "vitest";
import { compileAzureKql, kqlString } from "./compileAzureKql.js";
import { azureTarget, query } from "./fixtures/index.js";

/**
 * Golden tests for the KQL compiler.
 *
 * These assert the WHOLE query text, not fragments of it. A `toContain` check
 * would pass for a query that had also grown a clause nobody intended — which is
 * exactly how a filter comes to be silently dropped or a limit silently doubled,
 * and neither shows up as an error. The cost is that any deliberate change to
 * the emitted query has to be re-approved here, which is the point.
 */

/** A control character by code point, so this source file stays plain text. */
const C = (code: number): string => String.fromCharCode(code);

const RANGE = {
	from: "2026-09-07T00:00:00.000Z",
	to: "2026-09-07T00:15:00.000Z",
};

const HEADER = [
	"ContainerAppConsoleLogs_CL",
	`| where TimeGenerated >= datetime("${RANGE.from}") and TimeGenerated < datetime("${RANGE.to}")`,
	"| extend p = parse_json(Log_s)",
	'| where gettype(p) == "dictionary"',
];

const FOOTER = (take: number) => [
	"| order by TimeGenerated asc, Log_s asc",
	`| take ${take}`,
	"| project TimeGenerated, record = p",
];

function golden(clauses: string[], take = 11): string {
	return [...HEADER, ...clauses, ...FOOTER(take)].join("\n");
}

describe("compileAzureKql", () => {
	it("compiles an unfiltered query over the pinned table and range", () => {
		const compiled = compileAzureKql(azureTarget(), query(), 10);

		expect(compiled.query).toBe(golden([]));
		expect(compiled.limit).toBe(10);
	});

	it("asks for one record more than the limit, so a capped result is detectable", () => {
		// The whole reason this is not `take limit`: a result of exactly `limit`
		// records is otherwise ambiguous between "all of them" and "an arbitrary
		// prefix of many more", and an operator reads the short answer as complete.
		const compiled = compileAzureKql(azureTarget(), query(), 5_000);

		expect(compiled.take).toBe(5_001);
		expect(compiled.query).toContain("| take 5001");
	});

	it("orders by a total key before taking, so the same query returns the same records", () => {
		// `take` without an order is explicitly non-deterministic in KQL. `Log_s`
		// breaks ties on identical timestamps because it is the whole line.
		const compiled = compileAzureKql(azureTarget(), query(), 10);
		const lines = compiled.query.split("\n");

		expect(
			lines.indexOf("| order by TimeGenerated asc, Log_s asc"),
		).toBeLessThan(lines.indexOf("| take 11"));
	});

	it("excludes lines that are not JSON objects before they consume the budget", () => {
		// A container's stdout carries runtime banners too. `parse_json` returns
		// those as a scalar rather than failing, so the type check is what keeps
		// them out of the record count.
		expect(compileAzureKql(azureTarget(), query(), 10).query).toContain(
			'| where gettype(p) == "dictionary"',
		);
	});

	describe("every filter compiles to exactly one clause", () => {
		const cases: Array<[string, Partial<Parameters<typeof query>[0]>, string]> =
			[
				[
					"workspace",
					{ workspaceId: "ws-1" },
					'| where tostring(p["cyrus.workspace_id"]) == "ws-1"',
				],
				[
					"owner",
					{ ownerUserId: "user-1" },
					'| where tostring(p["cyrus.owner_id"]) == "user-1"',
				],
				[
					"team",
					{ teamId: "team-1" },
					'| where tostring(p["cyrus.team_id"]) == "team-1"',
				],
				[
					"project",
					{ projectId: "project-1" },
					'| where tostring(p["cyrus.project_id"]) == "project-1"',
				],
				[
					"issue",
					{ issueKey: "NOR-402" },
					'| where tostring(p["cyrus.issue_key"]) == "NOR-402"',
				],
				[
					"run",
					{ runId: "run-1" },
					'| where tostring(p["cyrus.run_id"]) == "run-1"',
				],
				[
					"session",
					{ sessionId: "session-1" },
					'| where tostring(p["cyrus.session_id"]) == "session-1"',
				],
				[
					"component",
					{ component: "EventRouter" },
					'| where tostring(p.component) == "EventRouter"',
				],
				[
					"trace",
					{ traceId: "0af7651916cd43dd8448eb211c80319c" },
					'| where tostring(p.trace_id) == "0af7651916cd43dd8448eb211c80319c"',
				],
				[
					"level",
					{ levels: ["warn", "error"] as const },
					'| where tostring(p.level) in ("warn", "error")',
				],
				[
					"text",
					{ text: "timed out" },
					'| where tostring(p.message) contains "timed out"',
				],
			];

		for (const [name, filter, clause] of cases) {
			it(name, () => {
				const compiled = compileAzureKql(
					azureTarget(),
					query(filter as never),
					10,
				);
				expect(compiled.query).toBe(golden([clause]));
			});
		}
	});

	it("uses bracket syntax for every cyrus.* attribute", () => {
		// `p.cyrus.run_id` parses as a nested lookup and silently returns null — it
		// does not error. A query written that way runs, returns nothing, and reads
		// as a quiet fleet, so this is asserted directly rather than left to the
		// golden strings above.
		const compiled = compileAzureKql(
			azureTarget(),
			query({
				workspaceId: "ws-1",
				ownerUserId: "user-1",
				teamId: "team-1",
				projectId: "project-1",
				issueKey: "NOR-402",
				runId: "run-1",
				sessionId: "session-1",
			}),
			10,
		);

		expect(compiled.query).not.toMatch(/p\.cyrus\./);
		for (const key of [
			"workspace_id",
			"owner_id",
			"team_id",
			"project_id",
			"issue_key",
			"run_id",
			"session_id",
		]) {
			expect(compiled.query).toContain(`p["cyrus.${key}"]`);
		}
	});

	it("keeps structural keys on their bare names", () => {
		// `component`, `level`, `message`, and `trace_id` are NOT namespaced — see
		// the naming split in CLAUDE.md §13. Reading them as `cyrus.component`
		// would return null for every row.
		const compiled = compileAzureKql(
			azureTarget(),
			query({ component: "EventRouter", levels: ["error"], text: "boom" }),
			10,
		);

		expect(compiled.query).toContain("tostring(p.component)");
		expect(compiled.query).toContain("tostring(p.level)");
		expect(compiled.query).toContain("tostring(p.message)");
		expect(compiled.query).not.toContain('p["cyrus.component"]');
	});

	it("emits both router and sandbox lines", () => {
		// Relayed worker logs share this table with the router's own. An operator
		// asking what happened on a run needs both halves, so nothing filters on
		// `cyrus.source`.
		const compiled = compileAzureKql(
			azureTarget(),
			query({ runId: "run-1" }),
			10,
		);

		expect(compiled.query).not.toContain("cyrus.source");
	});

	it("composes multiple filters as separate clauses in a stable order", () => {
		const compiled = compileAzureKql(
			azureTarget(),
			query({
				issueKey: "NOR-402",
				runId: "run-1",
				levels: ["error"],
				text: "boom",
			}),
			10,
		);

		expect(compiled.query).toBe(
			golden([
				'| where tostring(p["cyrus.issue_key"]) == "NOR-402"',
				'| where tostring(p["cyrus.run_id"]) == "run-1"',
				'| where tostring(p.level) in ("error")',
				'| where tostring(p.message) contains "boom"',
			]),
		);
	});
});

describe("kqlString", () => {
	it("escapes a quote so a literal cannot be ended early", () => {
		expect(kqlString('say "hi"')).toBe('"say \\"hi\\""');
	});

	it("escapes backslashes before anything else, so escapes are not doubled", () => {
		// Replacing quotes first would leave `\"` and then escape its backslash,
		// producing `\\"` — a closed literal followed by garbage.
		expect(kqlString('a\\"b')).toBe('"a\\\\\\"b"');
	});

	it.each([
		['" | project *', '"\\" | project *"'],
		['"; drop table x; //', '"\\"; drop table x; //"'],
		['" or 1==1 //', '"\\" or 1==1 //"'],
		["') | union *", '"\') | union *"'],
	])("neutralizes the injection attempt %j", (input, expected) => {
		// Nothing here is rejected — an operator may legitimately search for a
		// string containing a quote. The guarantee is that it stays a LITERAL: the
		// grammar of the query is fixed by the compiler, and the operator
		// contributes only the contents of a string.
		expect(kqlString(input)).toBe(expected);
	});

	it("escapes newlines, so a value cannot forge a second line of query", () => {
		expect(kqlString("a\nb\r\nc\td")).toBe('"a\\nb\\r\\nc\\td"');
	});

	it("escapes other control characters numerically", () => {
		const input = ["a", C(0x00), "b", C(0x1f), "c", C(0x7f)].join("");
		expect(kqlString(input)).toBe('"a\\u{0000}b\\u{001f}c\\u{007f}"');
	});

	it("escapes the Unicode line separators some parsers treat as breaks", () => {
		const input = ["a", C(0x2028), "b", C(0x2029), "c"].join("");
		expect(kqlString(input)).toBe('"a\\u{2028}b\\u{2029}c"');
	});

	it("leaves ordinary text alone", () => {
		expect(kqlString("NOR-402 timed out (again)")).toBe(
			'"NOR-402 timed out (again)"',
		);
	});

	it("escapes an injection attempt hidden inside a filter value end to end", () => {
		const compiled = compileAzureKql(
			azureTarget(),
			query({ text: '" | project Log_s | take 100000 //' }),
			10,
		);

		// One `where` clause, and the payload is inside its literal.
		expect(compiled.query.split("| where").length - 1).toBe(3);
		expect(compiled.query).toContain(
			'| where tostring(p.message) contains "\\" | project Log_s | take 100000 //"',
		);
		expect(compiled.query).toContain("| take 11");
	});
});
