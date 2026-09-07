import type {
	LogQueryV1,
	LogRecordV1,
	LogSourceDescriptorV1,
	LogSourceKindV1,
} from "cyrus-operator-protocol";
import { UsageError } from "../errors.js";

/**
 * The seam every historical log backend sits behind.
 *
 * ── WHY A SEAM AT ALL ──
 * `LogsCommand` is the operator's vocabulary — a time range and a set of Cyrus
 * facts to narrow on — and Azure Log Analytics is one way to answer it. Keeping
 * the two apart is not speculative generality: it is the only way to state, and
 * then TEST, that no KQL, no table name, and no `Log_s` column reaches the
 * command or the router. An adapter that leaked its query language upward would
 * make the next backend a rewrite of the command rather than a new file, and
 * would put a query string on a path where an operator's `--text` argument could
 * reach the backend uninterpreted.
 *
 * ── WHAT AN ADAPTER OWES ──
 * An adapter receives the credential-free descriptor the ROUTER published and
 * the normalized query the COMMAND compiled, and returns normalized records. It
 * authenticates itself, from local credentials; log records never travel back
 * through the router (ADR: the router describes the source, the client reads
 * it). Everything an adapter must enforce on the way is in this file, beside the
 * interface, because a budget enforced by one adapter and forgotten by the next
 * is indistinguishable — from the operator's side — from a quiet fleet.
 */
export interface LogSourceAdapter {
	/** The descriptor kind this adapter answers for. */
	readonly kind: LogSourceKindV1;

	/**
	 * Reads the records matching `query`.
	 *
	 * @param signal aborts an in-flight backend request. A `follow` that is
	 * interrupted mid-poll must not leave a request running against a billed
	 * backend, and a poll that outlives its own interval must be abandoned rather
	 * than allowed to overlap the next one.
	 *
	 * @throws {UsageError} when a budget in {@link LogQueryBudgetsV1} is exceeded.
	 * Never truncates: a short answer an operator reads as complete is the one
	 * failure mode this whole command is arranged to avoid.
	 */
	query(
		descriptor: LogSourceDescriptorV1,
		query: LogQueryV1,
		signal?: AbortSignal,
	): Promise<LogQueryResultV1>;
}

/** What one adapter read, plus how long its backend took to answer. */
export interface LogQueryResultV1 {
	records: LogRecordV1[];
	/**
	 * Time spent in the backend, when it reports one.
	 *
	 * Separate from the command's own wall clock because the two answer different
	 * questions: a slow `logs query` is either a slow backend or a slow client,
	 * and an operator deciding whether to narrow their range needs to know which.
	 */
	backendLatencyMs?: number;
	/**
	 * Rows the backend returned that carried no readable Cyrus record.
	 *
	 * Reported rather than dropped quietly. Non-zero is normal — a container's
	 * stdout carries lines Cyrus did not write — but an operator who expected
	 * records and got none needs to be able to tell "nothing matched" from
	 * "nothing was readable".
	 */
	skipped?: number;
	/**
	 * The largest gap observed between a record's own clock and the backend's
	 * ingestion clock, in milliseconds.
	 *
	 * The number `follow` overlaps for. Measured rather than assumed: a follow
	 * built on a guessed lag either misses records or re-reads the same window
	 * forever, and neither failure announces itself.
	 */
	maxIngestionLagMs?: number;
}

/**
 * Ceiling on ONE normalized record, in bytes of its JSON encoding.
 *
 * A single log line can be a megabyte — a stack trace, a dumped config, an
 * agent transcript — and a handful of them will exhaust a terminal, a pipe
 * buffer, and an orchestrator's context window before the operator sees the
 * line they came for.
 */
export const MAX_RECORD_BYTES = 256 * 1024;

/**
 * Ceiling on ONE query's normalized result set, in bytes of its JSON encoding.
 *
 * Applied per RESULT SET rather than per command run, which matters only for
 * `follow`: a follow that runs for an hour legitimately emits more than this in
 * total, and failing it for that would be failing it for working. What the
 * budget protects against is a single answer too large to handle, and that is a
 * property of one result set whichever subcommand asked for it.
 */
export const MAX_TOTAL_OUTPUT_BYTES = 10 * 1024 * 1024;

/**
 * The record limit a query should be compiled with, refusing anything the
 * descriptor's budget does not allow.
 *
 * REFUSES rather than clamps. Clamping `--limit 10000` down to 5,000 answers a
 * different question than the one asked and says nothing about having done so,
 * which is the same defect as truncating a result — the operator reads 5,000
 * records as "that is all of them".
 */
export function resolveQueryLimit(
	descriptor: LogSourceDescriptorV1,
	query: LogQueryV1,
): number {
	const max = descriptor.budgets.maxRecords;
	if (query.limit === undefined) return max;
	if (query.limit > max) {
		throw new UsageError(
			`This log source allows at most ${max} records per query, and ${query.limit} were requested. ` +
				"Narrow the time range or the filters instead of raising the limit.",
		);
	}
	return query.limit;
}

/**
 * Refuses a query whose range exceeds what the source advertises.
 *
 * Checked HERE, against the descriptor, rather than against a constant in this
 * CLI: the range a source can serve is a property of that source's retention and
 * cost, the router publishes it, and a client-side constant would either refuse
 * queries a generous source would have answered or wave through ones it will
 * bill heavily for.
 */
export function assertQueryRange(
	descriptor: LogSourceDescriptorV1,
	query: LogQueryV1,
): void {
	const from = Date.parse(query.range.from);
	const to = Date.parse(query.range.to);
	const seconds = (to - from) / 1000;
	const max = descriptor.budgets.maxRangeSeconds;
	if (seconds > max) {
		throw new UsageError(
			`This log source allows a range of at most ${describeSeconds(max)}, and ${describeSeconds(
				Math.round(seconds),
			)} was requested (${query.range.from} → ${query.range.to}).`,
		);
	}
}

/**
 * Refuses a result the backend capped.
 *
 * The caller asks for `limit + 1` records and hands the whole answer here. That
 * extra record is the ONLY way to tell "there were exactly `limit` records" from
 * "there were more and you are looking at an arbitrary subset", and the
 * distinction is the difference between an operator concluding an error never
 * happened and an operator knowing they have not looked at everything.
 */
export function assertRecordBudget(
	records: readonly LogRecordV1[],
	limit: number,
): void {
	if (records.length > limit) {
		throw new UsageError(
			`This query matched more than the ${limit} records allowed, so no records were emitted rather than an arbitrary subset. ` +
				"Narrow the time range, add a filter, or lower --limit to a window you can read in full.",
		);
	}
}

/**
 * Refuses an oversized record or result set.
 *
 * Deliberately a REFUSAL rather than a truncation, and the message names the
 * offending record so the refusal is actionable: a truncated log line reads as a
 * complete one, and the reader has no way to tell that the part explaining the
 * failure was the part removed.
 */
export function assertSizeBudget(records: readonly LogRecordV1[]): void {
	let total = 0;
	for (const record of records) {
		const bytes = Buffer.byteLength(JSON.stringify(record), "utf8");
		if (bytes > MAX_RECORD_BYTES) {
			throw new UsageError(
				`A single log record at ${record.timestamp} is ${describeBytes(bytes)}, over the ${describeBytes(
					MAX_RECORD_BYTES,
				)} per-record limit, and was not truncated. ` +
					"Narrow the time range to exclude it, or read that line in the backend directly.",
			);
		}
		total += bytes;
	}
	if (total > MAX_TOTAL_OUTPUT_BYTES) {
		throw new UsageError(
			`This query produced ${describeBytes(total)} of records, over the ${describeBytes(
				MAX_TOTAL_OUTPUT_BYTES,
			)} limit, and nothing was emitted rather than a partial answer. ` +
				"Narrow the time range or add a filter.",
		);
	}
}

/**
 * The whole budget pass, in the order an adapter should apply it.
 *
 * Exposed as one call so that "an adapter enforces the budgets" is a single
 * line in each adapter rather than four that a new backend can implement three
 * of.
 */
export function enforceLogBudgets(
	records: readonly LogRecordV1[],
	limit: number,
): void {
	assertRecordBudget(records, limit);
	assertSizeBudget(records);
}

/* -------------------------------------------------- reference filter semantics */

/**
 * What each filter MEANS, as executable reference semantics.
 *
 * ── WHY THE SEAM OWNS THIS AND NOT EACH ADAPTER ──
 * Every adapter re-expresses these rules in its own backend's language — the
 * Azure one as KQL — and a backend that quietly disagrees produces a result that
 * is wrong rather than absent. `--text` matching case-sensitively in one backend
 * and insensitively in another is not a discrepancy anybody notices; it is an
 * operator concluding that a message they searched for was never logged.
 *
 * So the meaning is written down once, here, in a form that runs. The fake
 * adapter IS this function, and the contract suite drives every adapter against
 * cases derived from it — which turns "do these two backends agree" from a
 * question about someone else's query engine into a test.
 */
export function matchesLogQuery(
	record: LogRecordV1,
	query: LogQueryV1,
): boolean {
	return (
		withinLogRange(record, query.range) && matchesLogFilters(record, query)
	);
}

/**
 * `[from, to)` — half-open, deliberately.
 *
 * A closed upper bound would re-emit the boundary record on every `follow` poll
 * that resumed from its own previous `to`. Deduplication would hide that, which
 * is worse than not having the bug: it would hide it until the day the dedup
 * window aged the record out first.
 */
export function withinLogRange(
	record: LogRecordV1,
	range: { from: string; to: string },
): boolean {
	const at = Date.parse(record.timestamp);
	return at >= Date.parse(range.from) && at < Date.parse(range.to);
}

function matchesLogFilters(record: LogRecordV1, query: LogQueryV1): boolean {
	const equals = (
		expected: string | undefined,
		actual: string | undefined,
	): boolean => expected === undefined || expected === actual;

	return (
		equals(query.workspaceId, record.workspaceId) &&
		equals(query.ownerUserId, record.ownerUserId) &&
		equals(query.issueKey, record.issueKey) &&
		equals(query.runId, record.runId) &&
		equals(query.sessionId, record.sessionId) &&
		equals(query.component, record.component) &&
		equals(query.traceId, record.traceId) &&
		// Team and project are not hoisted onto `LogRecordV1` — they narrow a query
		// but are not among the identifiers a reader scans a line for — so they are
		// matched where they live, in the canonical attribute bag (CYR-72).
		equals(query.teamId, record.attributes?.["cyrus.team_id"]) &&
		equals(query.projectId, record.attributes?.["cyrus.project_id"]) &&
		(query.levels === undefined || query.levels.includes(record.level)) &&
		// Case-INSENSITIVE, matching KQL's `contains`. An operator grepping their
		// logs is not writing a regex and should not have to match case; a backend
		// that did would answer "never logged" for a line that was.
		(query.text === undefined ||
			record.message.toLowerCase().includes(query.text.toLowerCase()))
	);
}

/**
 * The total order every adapter returns records in: oldest first, ties broken
 * by record id.
 *
 * Oldest-first because that is reading order for a log, and because `follow`
 * appends. A TOTAL order — rather than time alone — because a limit applied to a
 * partially-ordered result returns a different subset each run, and a follow
 * built on that shows records appearing and disappearing.
 */
export function compareLogRecords(a: LogRecordV1, b: LogRecordV1): number {
	if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? -1 : 1;
	if (a.recordId === b.recordId) return 0;
	return a.recordId < b.recordId ? -1 : 1;
}

function describeSeconds(seconds: number): string {
	if (seconds % 3600 === 0) return `${seconds / 3600}h`;
	if (seconds % 60 === 0) return `${seconds / 60}m`;
	return `${seconds}s`;
}

function describeBytes(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
	if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${bytes} B`;
}
