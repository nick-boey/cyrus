import type {
	LogQueryV1,
	LogRecordV1,
	LogSourceDescriptorV1,
	LogSourceKindV1,
} from "cyrus-operator-protocol";
import { TransientError, UsageError } from "../errors.js";
import {
	assertQueryRange,
	compareLogRecords,
	enforceLogBudgets,
	type LogQueryResultV1,
	type LogSourceAdapter,
	matchesLogQuery,
	resolveQueryLimit,
} from "./LogSourceAdapter.js";

/**
 * An in-memory {@link LogSourceAdapter} over records a test seeds.
 *
 * ── WHY THIS SHIPS RATHER THAN LIVING IN A TEST FILE ──
 * It is the executable half of the seam's contract. The contract suite runs
 * against it, so every rule an adapter must obey — filter semantics, ordering,
 * cancellation, budget refusals — is stated once as a test and once as an
 * implementation short enough to read in a minute. A future backend adapter is
 * then held to the same suite, and "does the new adapter behave like the old
 * one" stops being a question anybody has to answer by reading Azure docs.
 *
 * It is also what lets `LogsCommand`'s tests be about the COMMAND: descriptor
 * ordering, stream discipline, follow deduplication, and exit codes are all
 * testable here without an Azure account, a network, or a mocked SDK whose
 * shape is a guess about someone else's library.
 *
 * `kind` is `"fake"`, which the wire contract admits as a first-class log source
 * kind — so a router can be stood up against it end to end without this CLI
 * needing a special "test mode" branch that production never exercises.
 */
export class FakeLogSourceAdapter implements LogSourceAdapter {
	readonly kind: LogSourceKindV1 = "fake";

	/** Every query this adapter was asked, in order, for a test to assert on. */
	readonly queries: LogQueryV1[] = [];

	private records: LogRecordV1[];
	private failure?: Error;
	private readonly backendLatencyMs?: number;

	constructor(options: {
		records?: LogRecordV1[];
		/** Thrown instead of answering, so a test can drive the failure paths. */
		failure?: Error;
		backendLatencyMs?: number;
	}) {
		this.records = [...(options.records ?? [])];
		this.failure = options.failure;
		this.backendLatencyMs = options.backendLatencyMs;
	}

	/** Replaces the seeded records — how a `follow` test advances time. */
	setRecords(records: LogRecordV1[]): void {
		this.records = [...records];
	}

	/** Adds records a later poll should see. */
	append(...records: LogRecordV1[]): void {
		this.records.push(...records);
	}

	/** Makes the next query fail; `undefined` clears it. */
	setFailure(failure: Error | undefined): void {
		this.failure = failure;
	}

	async query(
		descriptor: LogSourceDescriptorV1,
		query: LogQueryV1,
		signal?: AbortSignal,
	): Promise<LogQueryResultV1> {
		this.queries.push(query);

		// Checked BEFORE the seeded failure, so a test that drives a backend error
		// still gets a cancellation when it asks for one — a `follow` interrupted
		// during a failing poll must stop, not report the failure it was abandoning.
		throwIfAborted(signal);
		if (this.failure) throw this.failure;

		const limit = resolveQueryLimit(descriptor, query);
		assertQueryRange(descriptor, query);

		const matched = this.records
			// The seam's own reference semantics, not a second implementation of
			// them. This adapter IS the definition of what each filter means; the
			// Azure adapter re-expresses the same rules as KQL, and the contract
			// suite is what holds the two together.
			.filter((record) => matchesLogQuery(record, query))
			.sort(compareLogRecords)
			// `limit + 1` for exactly the reason the KQL asks for it: a result of
			// exactly `limit` records is ambiguous between "all of them" and "an
			// arbitrary prefix", and the budget check below needs to tell them apart.
			.slice(0, limit + 1);

		enforceLogBudgets(matched, limit);

		return {
			records: matched,
			...(this.backendLatencyMs !== undefined
				? { backendLatencyMs: this.backendLatencyMs }
				: {}),
		};
	}
}

/**
 * Reports an abort in the vocabulary the command already handles.
 *
 * `UsageError` rather than `TransientError`: an aborted request was cancelled by
 * this process, so telling an orchestrator it may succeed on retry would be
 * describing our own decision as the backend's fault.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw new UsageError("The log query was cancelled before it was sent.");
	}
}

/** Re-exported so a test can build the failure the contract suite expects. */
export function fakeBackendFailure(message: string): Error {
	return new TransientError(message);
}
