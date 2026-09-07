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
	/**
	 * The `TimeGenerated` window to SCAN, which is wider than the window the
	 * operator asked for. See {@link INGESTION_SLACK_MS}.
	 *
	 * Returned rather than recomputed by the caller because the SDK's `timespan`
	 * argument bounds the same column and the service enforces it: a timespan
	 * narrower than the scan would re-impose the very cut this widening removes.
	 */
	scan: { from: string; to: string };
}

/**
 * How far outside the requested window the `TimeGenerated` scan reaches.
 *
 * ── THE TWO CLOCKS ──
 * `TimeGenerated` is when Log Analytics INGESTED a line; `p.timestamp` is when
 * the emitter wrote it. The gap is routinely tens of seconds, and it differs per
 * source: a router line is ingested almost immediately, while a sandbox line is
 * relayed through the router's stdout and arrives later.
 *
 * The operator asks about EMISSION time — that is the timestamp they read in the
 * output, and the one `LogsQueryDocument.range` claims the records lie within.
 * So the filter, the ordering, and the `take` all run on `p.timestamp`. But
 * `TimeGenerated` is the indexed column, and scanning without a bound on it
 * would read the whole retention period, so the scan is bounded and merely
 * WIDENED — enough to catch a record emitted inside the window and ingested
 * outside it, in either direction, since an emitter's clock can also run ahead.
 *
 * Filtering on `TimeGenerated` directly, as this compiler first did, silently
 * drops records emitted in the window but ingested after it, and returns them in
 * ingestion order — so output is not chronological once two sources with
 * different lag are interleaved, and `take` keeps the earliest-INGESTED records
 * rather than the earliest ones. Every one of those failures looks like a quiet
 * fleet.
 */
export const INGESTION_SLACK_MS = 15 * 60_000;

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
	const scan = {
		from: new Date(
			Date.parse(query.range.from) - INGESTION_SLACK_MS,
		).toISOString(),
		to: new Date(Date.parse(query.range.to) + INGESTION_SLACK_MS).toISOString(),
	};

	const lines: string[] = [
		descriptor.table,
		// The SCAN bound, on the indexed ingestion column. Wider than the window
		// the operator asked for; the emission filter below is what narrows it.
		`| where TimeGenerated >= datetime(${isoLiteral(scan.from)}) and TimeGenerated < datetime(${isoLiteral(scan.to)})`,
		"| extend p = parse_json(Log_s)",
		// A container's stdout also carries lines we did not write as JSON —
		// runtime banners, a dependency's warning, a crash dump. `parse_json` hands
		// those back as a scalar rather than failing, so the type check is what
		// keeps them from consuming the record budget and drowning the answer.
		'| where gettype(p) == "dictionary"',
		// The record's OWN clock, falling back to ingestion when it carries none or
		// carries something unparseable. `todatetime` of a non-time is null rather
		// than an error, so the coalesce is what keeps such a line in the answer
		// instead of silently dropping it — matching `normalizeAzureRows`, which
		// applies the same fallback when it builds the record.
		"| extend cyrus_at = coalesce(todatetime(p.timestamp), TimeGenerated)",
		// The window the operator actually asked about. Half-open, matching
		// `withinLogRange`: a closed upper bound would re-emit the boundary record
		// on every `follow` poll that resumed from its own previous `to`.
		`| where cyrus_at >= datetime(${isoLiteral(query.range.from)}) and cyrus_at < datetime(${isoLiteral(query.range.to)})`,
	];

	for (const clause of whereClauses(query)) lines.push(`| where ${clause}`);

	lines.push(
		// Ordered before it is taken, and by a total key on the EMISSION clock —
		// the same order `compareLogRecords` defines, so this adapter and the
		// reference semantics agree. `Log_s` breaks ties because it is the whole
		// line, so no two distinct records compare equal; `take` without a total
		// order is explicitly non-deterministic in KQL.
		"| order by cyrus_at asc, Log_s asc",
		`| take ${take}`,
		// `TimeGenerated` is projected beside the record's own clock so the client
		// can report observed ingestion lag. Collapsing them would hide the gap a
		// `follow` has to overlap for.
		"| project TimeGenerated, record = p",
	);

	return { query: lines.join("\n"), limit, take, scan };
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

	// ── WHY THE WORKSPACE CLAUSE ADMITS UNATTRIBUTED LINES ──
	// Most of what the router writes is a plain `logger.info`/`warn`/`error`,
	// which renders as JSON carrying only `timestamp`, `level`, `component`, and
	// `message`. The canonical `cyrus.*` attribution rides only on `logger.event`
	// records and relayed sandbox records, and a relayed line whose run cannot be
	// resolved carries an explicit `null`. `tostring()` of absent-or-null is `""`,
	// so a bare equality here drops every one of those — including on
	// `cyrus logs query` with no filters at all, which would then report a quiet
	// fleet while most of the router's output sat in the table.
	//
	// This is a NARROWING filter and not an authorization boundary: the operator
	// reads the workspace with their own Azure grant, so admitting a line that
	// belongs to no workspace discloses nothing the grant did not already allow.
	// The explicit filters below are different — asking for `--team X` means a
	// line with no team is not a match — so only this one is widened.
	if (query.workspaceId !== undefined) {
		clauses.push(
			`(isempty(tostring(p["cyrus.workspace_id"])) or tostring(p["cyrus.workspace_id"]) == ${kqlString(query.workspaceId)})`,
		);
	}
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
