import { randomUUID } from "node:crypto";
import {
	isTerminalRecoveryPhase,
	isTerminalRunLifecycleState,
	type RecoveryOperationV1,
	type RecoveryPhaseTransitionV1,
	type RecoveryRequestV1,
	type RunObservationPageV1,
	type RunObservationV1,
} from "cyrus-operator-protocol";
import { TransientError, UsageError } from "./errors.js";

/**
 * The guarded run-recovery workflow: pick a target, quote the revision it was
 * read at, and follow the operation the router persisted.
 *
 * ── WHY THIS IS A MODULE AND NOT PART OF THE COMMAND ──
 * Everything that decides WHETHER a mutation is safe lives here, ahead of the
 * command's option parsing and its output policy. The two questions the ADR
 * cares about — "was this the only non-terminal run?" and "is the revision I am
 * about to quote the one I actually read?" — are answered by pure functions
 * over a narrow client, so they can be tested without a Commander program, a
 * process exit, or a stream.
 *
 * ── {@link RecoveryClient} IS THE WHOLE SURFACE ──
 * Three operations: read observations, ask for a recovery, read the operation
 * back. There is no `stop`, no `destroy`, no `unlock`, and no Linear client
 * anywhere in reach — so "the CLI asks only for semantic run recovery and
 * cannot choose internal restart, redeliver, or unlock steps" holds by
 * construction rather than by inspection. Widening that surface is the edit a
 * reviewer would have to approve.
 */

/** How often the workflow asks the router how an operation is progressing. */
export const DEFAULT_RECOVERY_POLL_INTERVAL_MS = 2_000;

/**
 * How long the waiting form follows an operation before reporting a timeout.
 *
 * Sized against what recovery actually does rather than what feels responsive:
 * the coordinator boots the run's container and waits for an AUTHENTICATED
 * reconnect, and a cold ACA sandbox start is minutes, not seconds. A tighter
 * default would report exit `4` over recoveries that were going to succeed —
 * and since exit `4` is what an orchestrator escalates on, that noise is worse
 * than waiting.
 */
export const DEFAULT_RECOVERY_TIMEOUT_MS = 600_000;

/**
 * Consecutive transient poll failures tolerated before the follow gives up.
 *
 * A poll is a READ of an operation the router is already driving, so a 503 in
 * the middle of one says nothing about the recovery — abandoning on the first
 * would convert a momentary router hiccup into an exit `6` over work that
 * completed fine. Bounded so a router that has genuinely gone away is still
 * reported rather than waited out to the timeout.
 */
export const MAX_TRANSIENT_POLL_FAILURES = 5;

/**
 * A ceiling on pagination while resolving a target, so a router that keeps
 * returning the same cursor cannot spin the resolution forever.
 */
const MAX_LIST_PAGES = 1_000;

/**
 * Everything the recovery workflow is able to ask a router for.
 *
 * Structurally satisfied by `OperatorHttpClient`, and deliberately narrower than
 * it: this type is the enumeration of what a recovery can do.
 */
export interface RecoveryClient {
	listRuns(query?: Record<string, string>): Promise<RunObservationPageV1>;
	requestRecovery(
		request: RecoveryRequestV1,
	): Promise<{ operation: RecoveryOperationV1; joined: boolean }>;
	getRecovery(operationId: string): Promise<RecoveryOperationV1>;
}

/** The run a recovery will name, and the revision it will quote for it. */
export interface RecoveryTarget {
	runId: string;
	expectedRevision: number;
	/** The observation the revision came from, when one was read. */
	run?: RunObservationV1;
}

/**
 * Mints an idempotency key for a recovery request.
 *
 * Prefixed so a key is recognizable in an audit record as one this CLI
 * generated, and long enough to satisfy the contract's 8-character floor with a
 * UUID's collision properties. A caller that needs a retry to survive a process
 * restart supplies its own instead — that is the whole reason
 * `--idempotency-key` exists.
 */
export function generateIdempotencyKey(
	uuid: () => string = randomUUID,
): string {
	return `cyrec_${uuid()}`;
}

/**
 * Resolves what a recovery will act on, reading a fresh observation unless the
 * caller already quoted a revision.
 *
 * ── THE ORDER IS THE SAFETY PROPERTY ──
 * Every path that can end in "I do not know exactly which run, at exactly which
 * revision" throws BEFORE any mutation is possible, because resolution happens
 * before the request is built. An ambiguous issue key costs nothing and changes
 * nothing.
 *
 * ── WHY A TERMINAL RUN IS NOT REFUSED HERE, AND IS UNDER `--issue` ──
 * Under `--issue` the contract is explicit: the convenience acts only when
 * exactly one NON-TERMINAL run matches, so terminal runs are filtered out and a
 * tie is reported with its candidates. Given a run id, the caller named that run
 * deliberately and the ROUTER is the authority on whether it has ended — it
 * answers `run_already_terminal`, which is a refusal (exit 3) rather than a
 * mistyped command (exit 2). Second-guessing it here would report the wrong
 * category for the same fact.
 */
export async function resolveRecoveryTarget(
	client: RecoveryClient,
	input: {
		workspaceId: string;
		runId?: string;
		issue?: string;
		expectedRevision?: number;
	},
): Promise<RecoveryTarget> {
	if (input.runId !== undefined && input.issue !== undefined) {
		throw new UsageError(
			"Name a run id or `--issue <key>`, not both. `--issue` is a convenience that resolves to exactly one run id.",
		);
	}
	if (input.runId === undefined && input.issue === undefined) {
		throw new UsageError(
			"Usage: cyrus recover <runId> | cyrus recover --issue <issueKey>",
		);
	}

	if (input.runId !== undefined) {
		// An explicit revision IS the caller's fresh observation — they read the
		// run and are quoting what they saw. Reading it again here would replace
		// their evidence with ours and defeat the conditional request.
		if (input.expectedRevision !== undefined) {
			return { runId: input.runId, expectedRevision: input.expectedRevision };
		}
		const runs = await listAllRuns(client, {
			workspace: input.workspaceId,
			runId: input.runId,
		});
		const run = runs.find((candidate) => candidate.runId === input.runId);
		if (!run) {
			throw new UsageError(
				`No run ${input.runId} is visible on this connection. It may be mistyped, belong to another workspace, ` +
					"or have aged out of the router's retention window. `cyrus runs list` shows what is visible.",
			);
		}
		return { runId: run.runId, expectedRevision: run.revision, run };
	}

	const issue = input.issue as string;
	const runs = await listAllRuns(client, {
		workspace: input.workspaceId,
		[looksLikeIssueIdentifier(issue) ? "issueKey" : "issueId"]: issue,
	});
	const live = runs.filter(
		(run) => !isTerminalRunLifecycleState(run.lifecycle),
	);
	if (live.length === 0) {
		throw new UsageError(
			`No non-terminal run matches issue ${issue} on this connection. ` +
				(runs.length > 0
					? `${runs.length} run(s) matched, all of them ended. `
					: "") +
				"`cyrus runs list --issue " +
				issue +
				"` shows what is visible; a run that has ended cannot be recovered.",
		);
	}
	if (live.length > 1) {
		// Refused rather than resolved by position. Picking one would make the
		// exit code — and the mutation — describe a run the caller never chose.
		// The revisions travel with the candidates because they are what the
		// caller quotes on the retry that picks one.
		throw new UsageError(
			`Issue ${issue} has ${live.length} non-terminal runs: ` +
				`${live
					.map(
						(run) =>
							`${run.runId} (${run.lifecycle}, revision ${run.revision})`,
					)
					.join(", ")}. ` +
				"Recover one explicitly with `cyrus recover <runId>`.",
		);
	}
	const run = live[0] as RunObservationV1;
	return {
		runId: run.runId,
		expectedRevision: input.expectedRevision ?? run.revision,
		run,
	};
}

/**
 * Reports the phase transitions an operation has recorded but that a caller has
 * not yet seen, and returns the new count.
 *
 * Driven off the operation's own `phases` history rather than off its current
 * `phase`, and that is what makes a poll interval safe: the coordinator moves
 * through five phases and nothing guarantees a poll lands on each one. Diffing
 * against a count means two transitions that happened between polls are both
 * reported, in order, instead of one being silently skipped.
 */
export function emitNewPhases(
	operation: RecoveryOperationV1,
	emitted: number,
	onPhase: (transition: RecoveryPhaseTransitionV1) => void,
): number {
	for (const transition of operation.phases.slice(emitted)) {
		onPhase(transition);
	}
	return Math.max(emitted, operation.phases.length);
}

export interface RecoveryFollowResult {
	/** The operation as the router last reported it. Always present. */
	operation: RecoveryOperationV1;
	/** True when this command stopped watching, not when the router stopped. */
	timedOut: boolean;
}

/**
 * Follows a persisted operation until it reaches a terminal phase, or until this
 * command's own deadline expires.
 *
 * A timeout is REPORTED, never thrown, and the last operation comes back with
 * it. The recovery is still running on the router at that point, so the caller
 * has to be able to name the operation it abandoned — that is what makes
 * `cyrus recover status <operationId>` a resume rather than a guess, and it is
 * why this returns a flag instead of raising the exit-4 error itself.
 */
export async function followRecoveryOperation(
	client: RecoveryClient,
	input: {
		operation: RecoveryOperationV1;
		onPhase: (transition: RecoveryPhaseTransitionV1) => void;
		now: () => number;
		sleep: (ms: number) => Promise<void>;
		intervalMs?: number;
		timeoutMs?: number;
	},
): Promise<RecoveryFollowResult> {
	const intervalMs = input.intervalMs ?? DEFAULT_RECOVERY_POLL_INTERVAL_MS;
	const timeoutMs = input.timeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS;
	const deadline = input.now() + timeoutMs;

	let operation = input.operation;
	let emitted = emitNewPhases(operation, 0, input.onPhase);
	let transientFailures = 0;

	while (!isTerminalRecoveryPhase(operation.phase)) {
		if (input.now() >= deadline) {
			return { operation, timedOut: true };
		}
		await input.sleep(intervalMs);
		try {
			operation = await client.getRecovery(operation.operationId);
			// Reset on success: the bound is on CONSECUTIVE failures, so a router
			// that fails once an hour over a long recovery is not eventually
			// abandoned for a fault it recovered from every time.
			transientFailures = 0;
		} catch (error) {
			// Only a transient failure is retried. An authorization failure or a
			// malformed document will answer identically forever, and retrying one
			// is pure noise against the router.
			if (!(error instanceof TransientError)) throw error;
			if (++transientFailures >= MAX_TRANSIENT_POLL_FAILURES) throw error;
			continue;
		}
		emitted = emitNewPhases(operation, emitted, input.onPhase);
	}
	return { operation, timedOut: false };
}

/**
 * Every page of a run listing for one query.
 *
 * All pages, always: the `--issue` convenience decides uniqueness from the
 * result, and a decision made from page one would call a genuinely ambiguous
 * issue unique — which is the one mistake that turns a refusal into a mutation
 * against a run the caller never chose.
 */
async function listAllRuns(
	client: RecoveryClient,
	query: Record<string, string>,
): Promise<RunObservationV1[]> {
	const runs: RunObservationV1[] = [];
	const seen = new Set<string>();
	let cursor: string | undefined;

	for (let pages = 0; ; pages++) {
		const page = await client.listRuns(cursor ? { ...query, cursor } : query);
		runs.push(...page.runs);
		if (!page.nextCursor) break;
		if (seen.has(page.nextCursor) || pages + 1 >= MAX_LIST_PAGES) {
			throw new TransientError(
				"The router kept returning run pages without advancing its cursor; the lookup was abandoned rather than looping.",
			);
		}
		seen.add(page.nextCursor);
		cursor = page.nextCursor;
	}
	return runs;
}

/**
 * `NOR-402`, `CYPACK-1478` — a Linear issue identifier rather than an id.
 *
 * The same rule `runFilters` uses. The two shapes do not overlap (an id is a
 * UUID), so the choice of query parameter is decidable rather than a guess.
 */
function looksLikeIssueIdentifier(value: string): boolean {
	return /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(value);
}
