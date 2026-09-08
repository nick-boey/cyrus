import type {
	AuthorizedWorkspaceV1,
	LogRecordV1,
	RecoveryOperationV1,
	RecoveryPhaseTransitionV1,
	RunChangeKindV1,
	RunObservationV1,
} from "cyrus-operator-protocol";
import type { RunFilters } from "./runFilters.js";

/**
 * Output policy for the remote-operator commands: what a document looks like,
 * what a table looks like, and which stream each goes to.
 *
 * Deliberately outside the transport. `OperatorHttpClient` returns validated
 * documents and knows nothing about tables, NDJSON, or streams; this module
 * knows nothing about fetch, credentials, or capabilities. That separation is
 * what lets a new command choose a rendering without re-deriving the wire, and
 * lets the wire change without touching what an operator reads.
 */

/**
 * The two streams a fleet command writes to.
 *
 * The split is the machine contract, not a formatting preference: an
 * orchestrator pipes stdout straight into a JSON parser, so ONE deprecation
 * notice on the wrong stream makes every document it emits unparseable. Every
 * diagnostic — warnings, deprecations, errors, progress — is a `diagnostic`.
 */
export interface OutputStreams {
	/** stdout. Data only: documents, NDJSON events, tables. */
	data(line: string): void;
	/** stderr. Everything a human reads and a parser must not. */
	diagnostic(line: string): void;
	/**
	 * Resolves once every line written so far has reached the OS.
	 *
	 * Must be awaited before `process.exit`, which does NOT drain pending
	 * writes. `process.stdout` is asynchronous when it is a pipe on macOS, so
	 * without this a command that prints its document and then exits non-zero —
	 * exactly what `runs wait` does for every outcome but `complete` — truncates
	 * or loses the document on the one path a caller most needs it.
	 */
	flush(): Promise<void>;
}

export function createOutputStreams(
	stdout: NodeJS.WritableStream = process.stdout,
	stderr: NodeJS.WritableStream = process.stderr,
): OutputStreams {
	// Chained rather than counted so `flush` awaits the LAST write on each
	// stream, and so an error on one write cannot leave the chain unresolved.
	let pending: Promise<void> = Promise.resolve();
	const write = (stream: NodeJS.WritableStream, line: string): void => {
		const written = new Promise<void>((resolve) => {
			stream.write(`${line}\n`, () => resolve());
		});
		pending = pending.then(() => written).catch(() => undefined);
	};
	return {
		data: (line) => write(stdout, line),
		diagnostic: (line) => write(stderr, line),
		flush: () => pending,
	};
}

/** A recording pair, so a test can prove nothing crossed between the streams. */
export interface RecordingOutput extends OutputStreams {
	/** Lines written to stdout. Trailing underscore avoids clashing with `data`. */
	data_: string[];
	diagnostics: string[];
}

export function createRecordingOutput(): RecordingOutput {
	const data_: string[] = [];
	const diagnostics: string[] = [];
	return {
		data_,
		diagnostics,
		data: (line) => {
			data_.push(line);
		},
		diagnostic: (line) => {
			diagnostics.push(line);
		},
		flush: async () => {},
	};
}

/** Every JSON document these commands emit carries this. */
export const OUTPUT_SCHEMA_VERSION = 1 as const;

/* ------------------------------------------------------------------- list */

export interface RunsListDocument {
	schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
	observedAt: string;
	/** The single authorized workspace this listing was scoped to. */
	workspace: AuthorizedWorkspaceV1;
	/** Echoed so a stored document says what question it answered. */
	filters: RunFilters;
	runs: RunObservationV1[];
}

export function runsListDocument(input: {
	observedAt: string;
	workspace: AuthorizedWorkspaceV1;
	filters: RunFilters;
	runs: RunObservationV1[];
}): RunsListDocument {
	return { schemaVersion: OUTPUT_SCHEMA_VERSION, ...input };
}

/* ------------------------------------------------------------------ watch */

export type WatchEvent =
	| {
			schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
			event: "snapshot";
			observedAt: string;
			workspace: AuthorizedWorkspaceV1;
			runs: RunObservationV1[];
	  }
	| {
			schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
			event: "change";
			observedAt: string;
			changeId: string;
			cursor: string;
			runId: string;
			kind: RunChangeKindV1;
			observation: RunObservationV1;
	  }
	| {
			schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
			event: "resync";
			observedAt: string;
			reason: "stream_epoch_changed";
			streamEpoch: string;
	  }
	| {
			schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
			event: "stopped";
			observedAt: string;
			reason: "timeout" | "interrupted";
	  };

/**
 * The human rendering of one event, as the lines it occupies.
 *
 * Only `snapshot` is more than one line, and deliberately: it is the operator's
 * first and only view of the fleet's CURRENT state, and "3 run(s)" answers none
 * of the questions they opened a watch to ask. The NDJSON path is unaffected —
 * there, the snapshot's runs are already in the event.
 */
export function renderWatchEventLines(event: WatchEvent): string[] {
	return event.event === "snapshot"
		? [renderWatchEvent(event), ...renderRunsTable(event.runs)]
		: [renderWatchEvent(event)];
}

/**
 * One human line per watch event.
 *
 * A watch has no final document to render, so every event has to be legible on
 * its own — including the two that are not run transitions. `resync` says the
 * router restarted rather than pretending the gap was observed, and `stopped`
 * marks a deliberate end so a truncated stream is distinguishable from one that
 * finished.
 */
export function renderWatchEvent(event: WatchEvent): string {
	switch (event.event) {
		case "snapshot":
			return `${event.observedAt}  snapshot  ${event.runs.length} run(s) in ${describeWorkspace(event.workspace)}`;
		case "change":
			return [
				event.observedAt,
				event.kind,
				event.observation.issueKey,
				describeLifecycle(event.observation),
				event.runId,
			].join("  ");
		case "resync":
			return `${event.observedAt}  resync  the router restarted (stream epoch ${event.streamEpoch}); resumed from a fresh snapshot`;
		case "stopped":
			return `${event.observedAt}  stopped  ${event.reason}`;
	}
}

/* ------------------------------------------------------------------- wait */

/**
 * How a `runs wait` ended.
 *
 * Every value but `timeout` is a state a WORKER reported. `timeout` is this
 * command's own condition going unmet, and keeping it in the same field as an
 * outcome — beside the `observed` flag — is what stops a caller reading "the run
 * is waiting for you" and "we stopped looking" as the same event.
 */
export type WaitOutcome =
	| "complete"
	| "waiting"
	| "error"
	| "stopped"
	| "unknown"
	| "timeout";

export interface RunWaitDocument {
	schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
	observedAt: string;
	runId: string;
	outcome: WaitOutcome;
	/** True when the outcome is the run's own; false only for `timeout`. */
	observed: boolean;
	/** The last observation seen, whatever the outcome. */
	run?: RunObservationV1;
}

export function waitDocument(input: {
	observedAt: string;
	runId: string;
	outcome: WaitOutcome;
	run?: RunObservationV1;
}): RunWaitDocument {
	return {
		schemaVersion: OUTPUT_SCHEMA_VERSION,
		observed: input.outcome !== "timeout",
		...input,
	};
}

export function renderWaitOutcome(document: RunWaitDocument): string[] {
	const lines: string[] = [];
	if (document.outcome === "timeout") {
		lines.push(
			`Run ${document.runId} timed out: it had not reached a terminal or waiting outcome when this command stopped looking.`,
		);
	} else {
		lines.push(`Run ${document.runId} ${describeWaitOutcome(document)}.`);
	}
	if (document.run) lines.push(...renderRunsTable([document.run]));
	return lines;
}

function describeWaitOutcome(document: RunWaitDocument): string {
	const wait = document.run?.wait;
	return document.outcome === "waiting" && wait
		? `is waiting (${wait.reason}${wait.reportedCondition ? `: ${wait.reportedCondition}` : ""}) since ${wait.since}`
		: `ended: ${document.outcome}`;
}

/* --------------------------------------------------------------- recover */

/**
 * How a `cyrus recover` invocation ended.
 *
 * The first four are the operation's own terminal phases. The other two are
 * this command's, and keeping all six in one field — beside `complete` — is
 * what stops a caller reading "the router refused" and "we stopped watching" as
 * the same event:
 *
 * - `pending` means the operation is still running on the router and this
 *   invocation deliberately did not wait (`--no-wait`, or a one-shot `status`).
 *   The recovery may yet succeed; nothing has been decided.
 * - `timeout` means this command's own wait condition went unmet. The operation
 *   is still running, and `cyrus recover status <operationId>` resumes it.
 */
export type RecoveryOutcome =
	| "recovered"
	| "needs_input"
	| "refused"
	| "failed"
	| "pending"
	| "timeout";

export interface RecoveryDocument {
	schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
	observedAt: string;
	/** Always present, so `recover status` can pick up anything this left. */
	operationId: string;
	runId: string;
	/** Echoed so a stored document says which key to retry with. */
	idempotencyKey: string;
	expectedRevision: number;
	/** True when this request joined an operation that already existed. */
	joined: boolean;
	/** False whenever the operation had not reached a terminal phase. */
	complete: boolean;
	outcome: RecoveryOutcome;
	/** The operation as the router last reported it, phase history included. */
	operation: RecoveryOperationV1;
}

export function recoveryDocument(input: {
	observedAt: string;
	joined: boolean;
	outcome: RecoveryOutcome;
	operation: RecoveryOperationV1;
}): RecoveryDocument {
	return {
		schemaVersion: OUTPUT_SCHEMA_VERSION,
		observedAt: input.observedAt,
		operationId: input.operation.operationId,
		runId: input.operation.runId,
		idempotencyKey: input.operation.idempotencyKey,
		expectedRevision: input.operation.expectedRevision,
		joined: input.joined,
		complete: input.outcome !== "pending" && input.outcome !== "timeout",
		outcome: input.outcome,
		operation: input.operation,
	};
}

/**
 * One NDJSON line of a `cyrus recover`.
 *
 * The stream opens with `accepted` — which carries the operation id BEFORE any
 * phase is known, so a reader killed mid-recovery still has the id it needs to
 * resume — then one `phase` per transition, and closes with a `result`. A
 * truncated stream is therefore distinguishable from a finished one.
 */
export type RecoveryEvent =
	| {
			schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
			event: "accepted";
			observedAt: string;
			operationId: string;
			runId: string;
			idempotencyKey: string;
			expectedRevision: number;
			joined: boolean;
	  }
	| {
			schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
			event: "phase";
			observedAt: string;
			operationId: string;
			phase: RecoveryPhaseTransitionV1["phase"];
			detail?: string;
	  }
	| ({
			schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
			event: "result";
	  } & Omit<RecoveryDocument, "schemaVersion">);

export function recoveryResultEvent(document: RecoveryDocument): RecoveryEvent {
	const { schemaVersion: _dropped, ...rest } = document;
	return { schemaVersion: OUTPUT_SCHEMA_VERSION, event: "result", ...rest };
}

/** One human line per phase the operation entered. */
export function renderRecoveryPhase(
	transition: RecoveryPhaseTransitionV1,
): string {
	return [transition.enteredAt, transition.phase, transition.detail ?? ""]
		.join("  ")
		.trimEnd();
}

/**
 * The human rendering of a finished (or abandoned) recovery.
 *
 * Every branch names the operation id. That is not decoration: on the two
 * non-terminal outcomes the recovery is still running on the router, and the id
 * is the only way back to it.
 */
export function renderRecoveryOutcome(document: RecoveryDocument): string[] {
	const operation = document.operation;
	const lines: string[] = [];
	switch (document.outcome) {
		case "recovered":
			lines.push(
				`Run ${document.runId} recovered (operation ${document.operationId}).`,
			);
			break;
		case "needs_input":
			lines.push(
				`Run ${document.runId} needs input and cannot be recovered by reconciliation (operation ${document.operationId}). ` +
					"Answer it in Linear; recovery cannot manufacture the missing answer.",
			);
			break;
		case "refused":
			lines.push(
				`The router refused to recover run ${document.runId}: ${operation.refusalReason ?? "no reason given"} (operation ${document.operationId}).`,
			);
			break;
		case "failed":
			lines.push(
				`Recovery of run ${document.runId} failed: ${operation.failure?.message ?? "no detail given"} (operation ${document.operationId}).`,
			);
			break;
		case "pending":
			lines.push(
				`Recovery of run ${document.runId} is running as operation ${document.operationId} (currently ${operation.phase}). ` +
					`Follow it with \`cyrus recover status ${document.operationId} --wait\`.`,
			);
			break;
		case "timeout":
			lines.push(
				`Stopped watching operation ${document.operationId} for run ${document.runId} while it was ${operation.phase}. ` +
					`The recovery is still running on the router; resume with \`cyrus recover status ${document.operationId} --wait\`.`,
			);
			break;
	}
	if (document.joined) {
		lines.push(
			`This request joined an operation that already existed under idempotency key ${document.idempotencyKey}.`,
		);
	}
	return lines;
}

/* ------------------------------------------------------------------- logs */

export interface LogsQueryDocument {
	schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
	observedAt: string;
	workspace: AuthorizedWorkspaceV1;
	/** The log source, as the ROUTER named it — never a table or a URL. */
	source: string;
	/** Echoed so a stored document says which window it answered for. */
	range: { from: string; to: string };
	records: LogRecordV1[];
	backendLatencyMs?: number;
	/**
	 * The worst record-clock-to-ingestion-clock gap observed in this answer.
	 *
	 * On the document rather than only in a diagnostic because it qualifies the
	 * RESULT: records written more recently than this may exist and not yet be
	 * queryable, and a reader deciding whether "no errors" means "no errors"
	 * needs that number as data, not as prose on another stream.
	 */
	ingestionLagMs?: number;
}

export function logsQueryDocument(input: {
	observedAt: string;
	workspace: AuthorizedWorkspaceV1;
	source: string;
	range: { from: string; to: string };
	records: LogRecordV1[];
	backendLatencyMs?: number;
	ingestionLagMs?: number;
}): LogsQueryDocument {
	return { schemaVersion: OUTPUT_SCHEMA_VERSION, ...input };
}

/** One NDJSON line of a `logs follow`. */
export interface LogsFollowEvent {
	schemaVersion: typeof OUTPUT_SCHEMA_VERSION;
	event: "record";
	record: LogRecordV1;
}

export function logsFollowEvent(record: LogRecordV1): LogsFollowEvent {
	return { schemaVersion: OUTPUT_SCHEMA_VERSION, event: "record", record };
}

/**
 * One human-readable line per log record.
 *
 * Fixed-width level and a compact identity suffix rather than a padded table:
 * a log window is unbounded and streamed, so there is no complete set of rows to
 * measure column widths against — and `follow` emits records one at a time, when
 * every earlier width is already printed.
 *
 * The identifiers printed are the ones an operator correlates on. They are
 * appended AFTER the message rather than before it so that the messages line up
 * and can be skimmed, which is what someone scanning a window is actually doing.
 */
export function renderLogRecord(record: LogRecordV1): string {
	const identity = [
		record.issueKey,
		record.runId ? `run=${record.runId}` : undefined,
		record.attributes?.["cyrus.source"],
	]
		.filter((part): part is string => Boolean(part))
		.join(" ");
	return [
		record.timestamp,
		record.level.toUpperCase().padEnd(5),
		`[${record.component ?? "-"}]`,
		record.message,
		identity ? `(${identity})` : "",
	]
		.join("  ")
		.trimEnd();
}

/* ------------------------------------------------------------------ table */

const COLUMNS = [
	"RUN",
	"ISSUE",
	"STATE",
	"RUNNER",
	"EXECUTOR",
	"WORKER",
	"WORKSPACE",
	"OWNER",
	"TEAM",
	"PROJECT",
	"ROUTED",
] as const;

/**
 * The human rendering of a run listing.
 *
 * Every identity column prints the canonical id AND the name captured beside it
 * when the run was routed. A name alone is display text two Linear workspaces
 * can share — which is why the router refuses to resolve an ambiguous one — and
 * an id alone is unreadable at 3am, so an operator who has to act on this needs
 * both in front of them.
 */
export function renderRunsTable(runs: RunObservationV1[]): string[] {
	if (runs.length === 0) return ["No matching runs."];
	const rows = runs.map((run) => [
		run.runId,
		run.issueKey,
		describeLifecycle(run),
		run.model ? `${run.runner}/${run.model}` : run.runner,
		describeExecutor(run),
		run.worker.online ? "online" : "offline",
		named(run.routing.workspaceId, run.routing.workspaceName),
		named(run.routing.ownerUserId, run.routing.ownerName),
		named(run.routing.linearTeamId, run.routing.linearTeamName),
		named(run.routing.linearProjectId, run.routing.linearProjectName),
		run.routing.routedAt,
	]);
	const widths = COLUMNS.map((column, index) =>
		Math.max(column.length, ...rows.map((row) => (row[index] ?? "").length)),
	);
	const line = (cells: readonly string[]): string =>
		cells
			.map((cell, index) => cell.padEnd(widths[index] as number))
			.join("  ")
			.trimEnd();
	return [line(COLUMNS), ...rows.map(line)];
}

/**
 * The lifecycle, plus the worker-reported reason when it is `waiting`.
 *
 * The reason is never omitted: `waiting` on its own reads as "stuck", and the
 * whole point of the state is that a worker said WHY it cannot progress —
 * nothing here is ever inferred from silence or elapsed time (ADR 0012).
 */
function describeLifecycle(run: RunObservationV1): string {
	return run.lifecycle === "waiting" && run.wait
		? `waiting(${run.wait.reason})`
		: run.lifecycle;
}

/** Infrastructure state, never worker liveness — a `running` box may be empty. */
function describeExecutor(run: RunObservationV1): string {
	return run.executorState
		? `${run.executorKind}/${run.executorState}`
		: run.executorKind;
}

function named(id: string | undefined, name: string | undefined): string {
	if (!id) return "-";
	return name ? `${name} (${id})` : id;
}

export function describeWorkspace(workspace: AuthorizedWorkspaceV1): string {
	return named(workspace.workspaceId, workspace.name);
}
