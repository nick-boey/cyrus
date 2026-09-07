import type {
	AzureLogAnalyticsDescriptorV1,
	LogQueryV1,
} from "cyrus-operator-protocol";

/**
 * Compiles a normalized {@link LogQueryV1} into KQL over
 * `ContainerAppConsoleLogs_CL`.
 *
 * ── THIS IS THE ONLY FILE THAT KNOWS KQL ──
 * The table name, `parse_json(Log_s)`, and the `p["cyrus.*"]` bracket access all
 * live here and nowhere else — not in `LogsCommand`, not in the router. That is
 * an acceptance criterion of CYR-73 rather than a preference: a command that
 * assembled fragments of a query language would have no way to state that an
 * operator's `--text` cannot reach the backend as syntax.
 *
 * ── NO USER-SUPPLIED QUERY, EVER ──
 * There is no path by which an operator supplies KQL. Every filter arrives as a
 * typed field on a STRICT schema, and every value crosses into the query through
 * {@link kqlString}. That is what makes the injection question answerable: the
 * grammar of the emitted query is fixed by this file, and the operator
 * contributes only string literals.
 *
 * ── THE BRACKET RULE ──
 * `p.cyrus.run_id` parses as a nested lookup and silently returns null — it does
 * not error. Every Cyrus attribute is therefore read as `p["cyrus.run_id"]`.
 * Getting this wrong yields a query that runs, returns nothing, and reads as a
 * quiet fleet. (Same rule as the saved searches in `monitoring.bicep`.)
 */

/** The one table structured router and relayed worker logs land in. */
export const CONSOLE_LOG_TABLE = "ContainerAppConsoleLogs_CL";

export interface CompiledAzureQuery {
	/** The KQL text, exactly as sent and exactly as `--show-query` prints it. */
	query: string;
	/** The record ceiling this query was compiled for, WITHOUT the probe record. */
	limit: number;
	/** `limit + 1` — what the query actually asks for. See {@link compileAzureKql}. */
	take: number;
}

/**
 * Builds the query text.
 *
 * ── WHY `take` IS `limit + 1` ──
 * A result of exactly `limit` records is ambiguous: it is either all of them or
 * an arbitrary prefix of many more. Asking for one extra makes the two
 * distinguishable, and the caller refuses rather than truncates when the extra
 * record shows up. One row is a negligible cost for removing the failure mode
 * where an operator concludes an error never happened.
 *
 * ── WHY THE RANGE IS IN THE TEXT ──
 * The SDK also takes the range as a `timespan` argument, and that argument is
 * what the service enforces. It is repeated in the query text anyway so that
 * what `--show-query` prints is a query an operator can paste into the portal
 * and get the same answer from. A printed query missing its own time bound is a
 * query that means something different everywhere else it is run.
 *
 * ── WHY BOTH SOURCES ──
 * Nothing here filters on `cyrus.source`. Router lines and relayed sandbox lines
 * share this table (the relay forwards worker records through the router's own
 * stdout), and an operator asking what happened on a run needs both halves —
 * the router's routing decisions and the worker's own account of the work. The
 * `source` attribute is preserved on each record so the two remain tellable
 * apart afterwards.
 */
export function compileAzureKql(
	descriptor: AzureLogAnalyticsDescriptorV1,
	query: LogQueryV1,
	limit: number,
): CompiledAzureQuery {
	const take = limit + 1;
	const lines: string[] = [
		descriptor.table,
		`| where TimeGenerated >= datetime(${isoLiteral(query.range.from)}) and TimeGenerated < datetime(${isoLiteral(query.range.to)})`,
		"| extend p = parse_json(Log_s)",
		// A container's stdout also carries lines we did not write as JSON —
		// runtime banners, a dependency's warning, a crash dump. `parse_json` hands
		// those back as a scalar rather than failing, so the type check is what
		// keeps them from consuming the record budget and drowning the answer.
		'| where gettype(p) == "dictionary"',
	];

	for (const clause of whereClauses(query)) lines.push(`| where ${clause}`);

	lines.push(
		// Ordered before it is taken, and by a total key. `take` without an order
		// is explicitly non-deterministic in KQL: the same query would return a
		// different subset each run, and a `follow` built on it would show records
		// appearing and disappearing. `Log_s` breaks ties on identical timestamps
		// because it is the whole line, so no two distinct records compare equal.
		"| order by TimeGenerated asc, Log_s asc",
		`| take ${take}`,
		// `TimeGenerated` is the INGESTION-side timestamp and is projected beside
		// the record's own so the client can report observed ingestion lag. They
		// are different clocks and the gap between them is the thing a `follow`
		// has to overlap for; collapsing them would hide it.
		"| project TimeGenerated, record = p",
	);

	return { query: lines.join("\n"), limit, take };
}

/**
 * One `where` clause per filter the operator supplied.
 *
 * Every clause compares a `tostring(...)` projection rather than the dynamic
 * value directly: a dynamic compared to a string literal in KQL is a type
 * mismatch that yields `false` for every row instead of an error — the same
 * silent-empty-result failure the bracket rule exists to prevent.
 */
function whereClauses(query: LogQueryV1): string[] {
	const clauses: string[] = [];

	const equals = (expression: string, value: string | undefined): void => {
		if (value !== undefined) {
			clauses.push(`tostring(${expression}) == ${kqlString(value)}`);
		}
	};

	equals('p["cyrus.workspace_id"]', query.workspaceId);
	equals('p["cyrus.owner_id"]', query.ownerUserId);
	equals('p["cyrus.team_id"]', query.teamId);
	equals('p["cyrus.project_id"]', query.projectId);
	equals('p["cyrus.issue_key"]', query.issueKey);
	equals('p["cyrus.run_id"]', query.runId);
	equals('p["cyrus.session_id"]', query.sessionId);
	// `component` is a STRUCTURAL key the renderer owns, not a `cyrus.*`
	// attribute, so it keeps its bare name and its dot syntax (see the naming
	// split in CLAUDE.md §13).
	equals("p.component", query.component);
	// `trace_id` is left unnamespaced by `runAttributionAttributes` on purpose —
	// it is a W3C-owned name, and matching Azure's own `OperationId` is what lets
	// a log line be joined to its trace.
	equals("p.trace_id", query.traceId);

	if (query.levels !== undefined) {
		clauses.push(
			`tostring(p.level) in (${query.levels.map(kqlString).join(", ")})`,
		);
	}
	if (query.text !== undefined) {
		// `contains` is the case-insensitive substring operator. An operator
		// grepping their logs is not writing a regex and should not have to escape
		// one; `has` would match whole terms only and silently miss a substring
		// inside an identifier, which is most of what gets searched for here.
		clauses.push(`tostring(p.message) contains ${kqlString(query.text)}`);
	}

	return clauses;
}

/**
 * Renders a value as a KQL string literal.
 *
 * The ONE place operator input becomes query text. Everything that could end a
 * literal or start a new statement is escaped, and every control character is
 * escaped numerically rather than passed through — a raw newline inside a
 * literal is both a parse hazard and, in a query that gets logged, a way to
 * forge a second line of output.
 *
 * KQL string literals accept the C-style escapes below, and `\u{...}` for
 * anything else. Backslash is replaced FIRST; doing it later would re-escape the
 * backslashes the other rules just introduced.
 */
export function kqlString(value: string): string {
	const escaped = value
		.replace(/\\/g, "\\\\")
		.replace(/"/g, '\\"')
		.replace(/\n/g, "\\n")
		.replace(/\r/g, "\\r")
		.replace(/\t/g, "\\t")
		// Everything else in the C0/C1 control ranges, plus the Unicode line and
		// paragraph separators, which some parsers treat as line breaks. Spelled as
		// `\u` escapes rather than literal characters, so this source file stays
		// plain text: a literal NUL would make it read as binary to grep and diff.
		.replace(
			// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the entire purpose - they are what must not reach a query literal unescaped
			/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g,
			(character) =>
				`\\u{${character.codePointAt(0)?.toString(16).padStart(4, "0")}}`,
		);
	return `"${escaped}"`;
}

/**
 * Renders an ISO instant as the argument to `datetime()`.
 *
 * The value has already been validated as an ISO-8601 UTC instant by
 * `logQueryV1Schema`, so this cannot smuggle anything — but it goes through
 * {@link kqlString} regardless, because "validated upstream" is a property of
 * today's call site and this file's guarantee must not depend on it.
 */
function isoLiteral(value: string): string {
	return kqlString(value);
}
