import { z } from "zod";
import {
	identifierV1Schema,
	isoTimestampV1Schema,
	revisionV1Schema,
	schemaVersionV1Schema,
} from "./primitives.js";

/**
 * Run observations, their pages, and the append-only feed of material changes
 * a watch consumes.
 */

/**
 * The lifecycle of an agent run — a continuous episode of work within an agent
 * session.
 *
 * This is NOT the state of the machine the run is executing on; see
 * {@link executorStateV1Schema}. There is no `parked` here: park is what
 * happens to an idle container, and the run-level concept it used to stand for
 * is now the explicitly worker-reported `waiting`.
 *
 * `unknown` means ownership ended without a terminal outcome reaching the
 * router. It is not a failure verdict.
 */
export const runLifecycleStateV1Schema = z.enum([
	"routed",
	"active",
	"waiting",
	"complete",
	"error",
	"stopped",
	"unknown",
]);
export type RunLifecycleStateV1 = z.infer<typeof runLifecycleStateV1Schema>;

/** The lifecycle states from which a run does not resume. */
export const TERMINAL_RUN_LIFECYCLE_STATES = [
	"complete",
	"error",
	"stopped",
	"unknown",
] as const satisfies readonly RunLifecycleStateV1[];

export function isTerminalRunLifecycleState(
	state: RunLifecycleStateV1,
): boolean {
	return (TERMINAL_RUN_LIFECYCLE_STATES as readonly string[]).includes(state);
}

/**
 * Why a worker reports that a run cannot currently progress.
 *
 * The router never infers this from silence, elapsed time, or executor state.
 * `elicitation` is the only condition v1 models; `other` preserves a
 * worker-reported condition the schema does not model yet, which is why it is
 * useless — and therefore refused — without the condition text.
 *
 * Note what is absent: pending background work is an active-run fact, not a
 * wait reason, and a rate limit is terminal until a resumable-backoff design
 * changes that.
 */
export const waitReasonV1Schema = z.enum(["elicitation", "other"]);
export type WaitReasonV1 = z.infer<typeof waitReasonV1Schema>;

export const runWaitV1Schema = z.object({
	reason: waitReasonV1Schema,
	since: isoTimestampV1Schema,
	/** The worker's own description of the condition. */
	reportedCondition: z.string().min(1).optional(),
});
export type RunWaitV1 = z.infer<typeof runWaitV1Schema>;

export const executorKindV1Schema = z.enum(["device", "container"]);
export type ExecutorKindV1 = z.infer<typeof executorKindV1Schema>;

/**
 * The last sampled state of the machine a run executes on — infrastructure
 * state, never worker-process liveness and never run lifecycle. A container
 * can read `running` with no worker alive inside it.
 */
export const executorStateV1Schema = z.enum([
	"running",
	"stopped",
	"absent",
	"unknown",
]);
export type ExecutorStateV1 = z.infer<typeof executorStateV1Schema>;

/**
 * The workspace, owner, and Linear context captured WHEN INPUT WAS ROUTED.
 *
 * Historical filters read these snapshots rather than calling Linear at query
 * time, so an issue that later moves team or project does not rewrite the
 * history of runs that already happened. IDs stay canonical; names are
 * captured alongside them for display and exact-name filtering, which is why a
 * name may never appear without its ID.
 */
export const runRoutingSnapshotV1Schema = z
	.object({
		workspaceId: identifierV1Schema,
		workspaceName: z.string().min(1).optional(),
		/** The Cyrus user who owns the run. */
		ownerUserId: identifierV1Schema,
		ownerName: z.string().min(1).optional(),
		linearTeamId: identifierV1Schema.optional(),
		linearTeamName: z.string().min(1).optional(),
		linearProjectId: identifierV1Schema.optional(),
		linearProjectName: z.string().min(1).optional(),
		routedAt: isoTimestampV1Schema,
	})
	.superRefine((routing, ctx) => {
		const pairs = [
			["workspaceId", "workspaceName"],
			["ownerUserId", "ownerName"],
			["linearTeamId", "linearTeamName"],
			["linearProjectId", "linearProjectName"],
		] as const;
		for (const [idKey, nameKey] of pairs) {
			if (routing[nameKey] !== undefined && routing[idKey] === undefined) {
				ctx.addIssue({
					code: "custom",
					path: [nameKey],
					message: `A captured \`${nameKey}\` requires its canonical \`${idKey}\``,
				});
			}
		}
	});
export type RunRoutingSnapshotV1 = z.infer<typeof runRoutingSnapshotV1Schema>;

/**
 * One routed input. Prompt text and comment previews are never retained — only
 * the Linear references the input arrived under, and the instant it was routed.
 *
 * BOTH identifiers are optional, and that is deliberate rather than lax: a
 * delegation raises `agentSessionCreated` with no agent activity and no source
 * comment, so the router's own `extractRunInput` yields `{routedMs}` alone and
 * `parseRunInputs` keeps it. Since delegation is the primary way a first agent
 * session begins, requiring an identifier here would make that run's ONLY input
 * invalid — and a fleet operator would lose sight of exactly the runs they most
 * need to see. `routedAt`, against the run's own identity, is still the fact
 * that the router accepted input at that instant.
 */
export const runInputV1Schema = z.object({
	activityId: identifierV1Schema.optional(),
	commentId: identifierV1Schema.optional(),
	routedAt: isoTimestampV1Schema,
});
export type RunInputV1 = z.infer<typeof runInputV1Schema>;

export const runWorkerV1Schema = z.object({
	online: z.boolean(),
	lastHeartbeatAt: isoTimestampV1Schema.optional(),
});
export type RunWorkerV1 = z.infer<typeof runWorkerV1Schema>;

/**
 * Everything the router durably knows about one agent run.
 *
 * It reports EVIDENCE, not a verdict: there is no `healthy` or `stalled` field,
 * because different callers would immediately need to override whichever
 * threshold we picked. Freshness is expressed as timestamps the caller can
 * apply its own policy to.
 *
 * Tolerant of unknown keys — a newer router may add facts an older CLI ignores.
 * The cross-field rules below are what a client may actually rely on.
 *
 * EMITTING THIS REQUIRES A STORE MIGRATION, and the required fields say which:
 * today's `agent_runs` table holds no `issue_id`, no `runner`, no `model`, and
 * none of the routing snapshot, so `issueId`, `runner`, and `routing` cannot be
 * populated from an existing row. They are required anyway because the spec
 * makes them part of the observation and an optional identity is one every
 * consumer must then handle forever. The consequence is deliberate and belongs
 * to whichever issue adds the route: rows written before that migration cannot
 * be rendered as v1, so it must backfill them or scope `/api/v1/runs` to runs
 * routed after it. Note that terminal runs age out in 24 hours but non-terminal
 * ones do not — a long-stuck run is both the hardest to backfill and the one an
 * operator most needs to see.
 */
export const runObservationV1Schema = z
	.object({
		schemaVersion: schemaVersionV1Schema,
		runId: identifierV1Schema,
		agentSessionId: identifierV1Schema,
		issueId: identifierV1Schema,
		issueKey: identifierV1Schema,
		routing: runRoutingSnapshotV1Schema,
		runner: z.string().min(1),
		model: z.string().min(1).optional(),
		executorKind: executorKindV1Schema,
		provider: z.string().min(1).optional(),
		lifecycle: runLifecycleStateV1Schema,
		wait: runWaitV1Schema.optional(),
		/**
		 * Background work the run is still carrying. Not a wait reason — that
		 * distinction is carried by {@link waitReasonV1Schema} being a closed
		 * enum that does not contain it, not by forbidding the two to coexist.
		 * A run blocked on an elicitation WITH a live background build is a
		 * state the worker explicitly models, and it is the evidence that
		 * predicts a `worker_owns_active_work` refusal.
		 */
		pendingWorkCount: z.int().nonnegative().optional(),
		/**
		 * May be empty. A run always had input — that is what started it — but
		 * an observation must never become unemittable because its input
		 * provenance is thin, since that loses the whole run from the fleet
		 * view rather than one correlation detail.
		 */
		inputs: z.array(runInputV1Schema),
		/** The latest agent activity SUCCESSFULLY published to the timeline. */
		lastPublishedActivityAt: isoTimestampV1Schema.optional(),
		worker: runWorkerV1Schema,
		executorState: executorStateV1Schema.optional(),
		executorStateObservedAt: isoTimestampV1Schema.optional(),
		startedAt: isoTimestampV1Schema,
		endedAt: isoTimestampV1Schema.optional(),
		observedAt: isoTimestampV1Schema,
		/** Incremented on each material change; quoted by a recovery request. */
		revision: revisionV1Schema,
	})
	.superRefine((run, ctx) => {
		const waiting = run.lifecycle === "waiting";
		const terminal = isTerminalRunLifecycleState(run.lifecycle);

		// Waiting is worker-reported, so the lifecycle and the evidence for it
		// travel together or not at all. A `waiting` run with no wait record
		// would be a router guess, which is the thing ADR-0012 forbids.
		if (waiting && run.wait === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["wait"],
				message: "A waiting run must carry the wait its worker reported",
			});
		}
		if (!waiting && run.wait !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["wait"],
				message: `Wait evidence does not apply to a \`${run.lifecycle}\` run`,
			});
		}
		// `other` exists only to carry a condition v1 does not model. Without
		// the text it records nothing an operator could act on.
		if (
			run.wait?.reason === "other" &&
			run.wait.reportedCondition === undefined
		) {
			ctx.addIssue({
				code: "custom",
				path: ["wait", "reportedCondition"],
				message: "An `other` wait must carry the condition the worker reported",
			});
		}

		// Pending work belongs to a run that can still resume. Asserting live
		// background work under a run that has ENDED is the contradiction worth
		// refusing; a waiting run carrying it is not — the worker's own
		// "safe to park?" gate exists precisely for a session blocked on a user
		// answer with a background build still running, and dropping the count
		// there would destroy the evidence that decides both parking and a
		// `worker_owns_active_work` recovery refusal.
		if (run.pendingWorkCount !== undefined && terminal) {
			ctx.addIssue({
				code: "custom",
				path: ["pendingWorkCount"],
				message: `Pending work cannot be carried by a \`${run.lifecycle}\` run, which has ended`,
			});
		}

		if (terminal && run.endedAt === undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["endedAt"],
				message: `A \`${run.lifecycle}\` run must record when it ended`,
			});
		}
		if (!terminal && run.endedAt !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["endedAt"],
				message: `A \`${run.lifecycle}\` run has not ended`,
			});
		}

		// Only a container has a sampled executor state: park applies to a
		// container, and a physical device is not something the router samples.
		if (run.executorKind !== "container" && run.executorState !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["executorState"],
				message: "Only a container run carries a sampled executor state",
			});
		}
		// A sample with no observation time cannot be aged, and a caller would
		// have to treat it as current — which is exactly the mistake that makes
		// a stale gauge look like a live fact.
		if (
			(run.executorState === undefined) !==
			(run.executorStateObservedAt === undefined)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["executorStateObservedAt"],
				message:
					"A sampled executor state and its observation time travel together",
			});
		}
	});
export type RunObservationV1 = z.infer<typeof runObservationV1Schema>;

/* ------------------------------------------------------------------ cursors */

const CURSOR_SEGMENT = "[A-Za-z0-9_-]+";
const CHANGE_CURSOR_RE = new RegExp(
	`^v1\\.changes\\.${CURSOR_SEGMENT}\\.${CURSOR_SEGMENT}$`,
);
const RUN_PAGE_CURSOR_RE = new RegExp(`^v1\\.runs\\.${CURSOR_SEGMENT}$`);

/**
 * An opaque resume point in the material-change feed.
 *
 * Clients treat it as a string. It is encoded rather than structured so that
 * the router can change what it needs to track without a schema version bump,
 * and so a client cannot hand-craft one and land in the middle of a stream.
 */
export const runChangeCursorV1Schema = z
	.string()
	.regex(CHANGE_CURSOR_RE, "Malformed run-change cursor");

/** An opaque resume point in a paginated run listing. */
export const runPageCursorV1Schema = z
	.string()
	.regex(RUN_PAGE_CURSOR_RE, "Malformed run-page cursor");

export interface RunChangeCursorV1 {
	/**
	 * Rotates whenever the router process starts. A cursor from an older epoch
	 * gets `410 Gone` so the client re-snapshots rather than pretending it
	 * observed the restart interval.
	 */
	streamEpoch: string;
	sequence: string;
}

function encodeSegment(value: string, label: string): string {
	if (value.length === 0) {
		throw new Error(`A run cursor ${label} must not be empty`);
	}
	return Buffer.from(value, "utf8").toString("base64url");
}

function decodeSegment(segment: string): string {
	return Buffer.from(segment, "base64url").toString("utf8");
}

export function encodeRunChangeCursor(cursor: RunChangeCursorV1): string {
	return [
		"v1.changes",
		encodeSegment(cursor.streamEpoch, "stream epoch"),
		encodeSegment(cursor.sequence, "sequence"),
	].join(".");
}

/**
 * Non-throwing decode, for use inside schema refinements.
 *
 * A refinement that threw would escape `safeParse` entirely: Zod still runs an
 * object-level refinement when a property failed only a string-format check,
 * so a malformed cursor would raise where a caller validating untrusted input
 * expects `{ success: false }`. Returns `undefined` instead, and the field-level
 * check reports the malformed cursor on its own.
 */
function tryDecodeRunChangeCursor(
	cursor: string,
): RunChangeCursorV1 | undefined {
	const parsed = runChangeCursorV1Schema.safeParse(cursor);
	if (!parsed.success) return undefined;
	const [, , streamEpoch, sequence] = parsed.data.split(".") as [
		string,
		string,
		string,
		string,
	];
	return {
		streamEpoch: decodeSegment(streamEpoch),
		sequence: decodeSegment(sequence),
	};
}

/** @throws if the cursor is not a well-formed run-change cursor. */
export function decodeRunChangeCursor(cursor: string): RunChangeCursorV1 {
	const decoded = tryDecodeRunChangeCursor(cursor);
	if (decoded === undefined) {
		// Re-run through `parse` so the caller gets the schema's own ZodError
		// rather than a second, differently-shaped error type.
		runChangeCursorV1Schema.parse(cursor);
	}
	return decoded as RunChangeCursorV1;
}

export function encodeRunPageCursor(position: string): string {
	return `v1.runs.${encodeSegment(position, "position")}`;
}

/** @throws if the cursor is not a well-formed run-page cursor. */
export function decodeRunPageCursor(cursor: string): { position: string } {
	const [, , position] = runPageCursorV1Schema.parse(cursor).split(".") as [
		string,
		string,
		string,
	];
	return { position: decodeSegment(position) };
}

/* -------------------------------------------------------------------- pages */

/**
 * One page of current run observations. A list is a SNAPSHOT and succeeds
 * regardless of the states it reports — an unhealthy fleet is a successful
 * read, not a command failure.
 */
export const runObservationPageV1Schema = z.object({
	schemaVersion: schemaVersionV1Schema,
	observedAt: isoTimestampV1Schema,
	runs: z.array(runObservationV1Schema),
	/** Absent on the last page. */
	nextCursor: runPageCursorV1Schema.optional(),
});
export type RunObservationPageV1 = z.infer<typeof runObservationPageV1Schema>;

/**
 * The material facts whose change is worth a feed entry.
 *
 * Repeated heartbeats and unchanged gauge samples update freshness without
 * producing an entry, so a watch is not a firehose of "still the same".
 */
export const runChangeKindV1Schema = z.enum([
	"routing",
	"lifecycle",
	"wait",
	"worker_connectivity",
	"executor_state",
	"published_activity",
	"recovery",
]);
export type RunChangeKindV1 = z.infer<typeof runChangeKindV1Schema>;

/**
 * One durable entry in the append-only change feed. It carries no prompt text
 * and no agent-activity content — the observation it embeds is the same facts
 * a list would return, so a watching client needs no second request.
 */
export const runObservationChangeV1Schema = z
	.object({
		schemaVersion: schemaVersionV1Schema,
		changeId: identifierV1Schema,
		/** The resume point immediately AFTER this change. */
		cursor: runChangeCursorV1Schema,
		runId: identifierV1Schema,
		kind: runChangeKindV1Schema,
		observedAt: isoTimestampV1Schema,
		observation: runObservationV1Schema,
	})
	.superRefine((change, ctx) => {
		if (change.observation.runId !== change.runId) {
			ctx.addIssue({
				code: "custom",
				path: ["observation", "runId"],
				message: "A change must embed the observation of the run it names",
			});
		}
	});
export type RunObservationChangeV1 = z.infer<
	typeof runObservationChangeV1Schema
>;

/**
 * One page of the change feed.
 *
 * `nextCursor` is REQUIRED, including on an empty page: a watch that polled and
 * saw nothing still has to know where to resume, and making it optional would
 * force a reconnecting orchestrator to re-snapshot to make progress.
 */
export const runChangePageV1Schema = z
	.object({
		schemaVersion: schemaVersionV1Schema,
		observedAt: isoTimestampV1Schema,
		streamEpoch: identifierV1Schema,
		changes: z.array(runObservationChangeV1Schema),
		nextCursor: runChangeCursorV1Schema,
	})
	.superRefine((page, ctx) => {
		// Every cursor on the page belongs to the epoch the page declares.
		// Mixing epochs would hand a client a resume point that its next request
		// answers `410 Gone` for, with no way to tell which entries it had
		// already consumed.
		//
		// A cursor that will not decode is already reported by the field-level
		// check, so it is skipped rather than decoded — decoding it here would
		// throw straight out of `safeParse`.
		const mismatched = (cursor: string): boolean => {
			const decoded = tryDecodeRunChangeCursor(cursor);
			return decoded !== undefined && decoded.streamEpoch !== page.streamEpoch;
		};
		if (mismatched(page.nextCursor)) {
			ctx.addIssue({
				code: "custom",
				path: ["nextCursor"],
				message: "The continuation cursor belongs to another stream epoch",
			});
		}
		page.changes.forEach((change, index) => {
			if (mismatched(change.cursor)) {
				ctx.addIssue({
					code: "custom",
					path: ["changes", index, "cursor"],
					message: "The change cursor belongs to another stream epoch",
				});
			}
		});
	});
export type RunChangePageV1 = z.infer<typeof runChangePageV1Schema>;

/* ------------------------------------------------------------ compatibility */

/**
 * The UNVERSIONED shape served by the existing `GET /runs` route.
 *
 * It lives here, rather than in the router, only so that the CLI can stop
 * importing a router implementation module for a wire type. It is frozen: new
 * facts belong on {@link RunObservationV1}, and this goes away with its route.
 *
 * Note `parked` and `sandboxState`, both of which v1 replaces — the lifecycle
 * with a worker-reported wait, the gauge with {@link ExecutorStateV1}.
 *
 * @deprecated Use {@link RunObservationV1}.
 */
export type LegacyAgentRunState =
	| "routed"
	| "active"
	| "parked"
	| "complete"
	| "error"
	| "stopped"
	| "unknown";

/** @deprecated Use {@link ExecutorStateV1}. */
export type LegacySandboxGaugeState =
	| "running"
	| "stopped"
	| "absent"
	| "unknown";

/** @deprecated Use {@link RunObservationV1}. */
export interface AgentRunObservation {
	runId: string;
	issueKey: string;
	sessionId: string;
	state: LegacyAgentRunState;
	startedAt: string;
	lastRoutedAt: string;
	lastAgentActivityAt?: string;
	endedAt?: string;
	inputs: Array<{
		activityId?: string;
		commentId?: string;
		routedAt: string;
	}>;
	executorKind: ExecutorKindV1;
	provider?: string;
	workerOnline: boolean;
	lastHeartbeatAt?: string;
	sandboxState?: LegacySandboxGaugeState;
	sandboxStateObservedAt?: string;
}

/** @deprecated Use {@link RunObservationPageV1}. */
export interface AgentRunsResponse {
	observedAt: string;
	runs: AgentRunObservation[];
}
