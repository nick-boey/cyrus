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
 * the identifier the input arrived under, which is what makes it observable at
 * all. An input carrying neither identifier could not be correlated with
 * anything, so it is refused.
 */
export const runInputV1Schema = z
	.object({
		activityId: identifierV1Schema.optional(),
		commentId: identifierV1Schema.optional(),
		routedAt: isoTimestampV1Schema,
	})
	.superRefine((input, ctx) => {
		if (input.activityId === undefined && input.commentId === undefined) {
			ctx.addIssue({
				code: "custom",
				message:
					"An input must carry an activity or comment identifier to be observable",
			});
		}
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
		/** Background work an ACTIVE run is still carrying. Not a wait reason. */
		pendingWorkCount: z.int().nonnegative().optional(),
		inputs: z.array(runInputV1Schema).min(1),
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

		// Pending work is an active-run fact. Allowing it on a waiting run would
		// re-create the pending-work-as-wait-reason conflation the domain
		// separates; allowing it on a terminal run would assert live background
		// work under a run that has ended.
		if (run.pendingWorkCount !== undefined && run.lifecycle !== "active") {
			ctx.addIssue({
				code: "custom",
				path: ["pendingWorkCount"],
				message: `Pending work is an active-run fact and does not apply to a \`${run.lifecycle}\` run`,
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

/** @throws if the cursor is not a well-formed run-change cursor. */
export function decodeRunChangeCursor(cursor: string): RunChangeCursorV1 {
	const [, , streamEpoch, sequence] = runChangeCursorV1Schema
		.parse(cursor)
		.split(".") as [string, string, string, string];
	return {
		streamEpoch: decodeSegment(streamEpoch),
		sequence: decodeSegment(sequence),
	};
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
		const mismatched = (cursor: string): boolean =>
			decodeRunChangeCursor(cursor).streamEpoch !== page.streamEpoch;
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
