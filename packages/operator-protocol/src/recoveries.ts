import { z } from "zod";
import { operatorAuthMethodV1Schema } from "./discovery.js";
import { operatorRoleV1Schema } from "./identity.js";
import {
	identifierV1Schema,
	isoTimestampV1Schema,
	revisionV1Schema,
	schemaVersionV1Schema,
} from "./primitives.js";
import { executorStateV1Schema, runLifecycleStateV1Schema } from "./runs.js";

/**
 * The one guarded mutation in the operator contract: ask the router to
 * reconcile a run whose ownership, worker, and executor evidence no longer
 * agree.
 *
 * Recovery is asynchronous by design — a request is ACCEPTED and an operation
 * advances — which is why the request and the operation are two documents.
 */

/**
 * A request to reconcile one run.
 *
 * STRICT, and here that is a safety property rather than hygiene. If Zod
 * silently stripped a misspelled `expectedRevision`, the router would receive a
 * request with no revision at all and an unconditional recovery would run in
 * place of the conditional one the caller wrote — the exact overwrite the
 * revision check exists to prevent. Strictness also makes it checkable that no
 * `force`, `unlock`, or `destroyExecutor` field exists: break-glass
 * administration stays outside this contract.
 */
export const recoveryRequestV1Schema = z.strictObject({
	schemaVersion: schemaVersionV1Schema,
	/**
	 * The canonical target. `--issue` is a CLI convenience resolved before the
	 * request is made — it acts only when exactly one non-terminal run matches —
	 * so no issue key reaches the router here.
	 */
	runId: identifierV1Schema,
	/**
	 * The revision the caller actually inspected. The router refuses if the run
	 * has moved on, so a concurrent transition cannot be overwritten by a
	 * decision made from stale evidence.
	 */
	expectedRevision: revisionV1Schema,
	/** Retrying the same key joins the same operation rather than competing. */
	idempotencyKey: z.string().min(8).max(200),
	reason: z.string().min(1).max(500).optional(),
});
export type RecoveryRequestV1 = z.infer<typeof recoveryRequestV1Schema>;

/**
 * The coordinator's sequence, in order.
 *
 * The middle phases are what the router does — start the executor, request
 * session reconciliation, let durable frames replay, and only then release
 * ownership it has proven stale. Exposing them lets an operator see which step
 * a recovery is on without exposing the controls to invoke any of them
 * individually.
 */
export const recoveryPhaseV1Schema = z.enum([
	"accepted",
	"starting_executor",
	"reconciling",
	"replaying",
	"releasing_stale_ownership",
	"recovered",
	"needs_input",
	"refused",
	"failed",
]);
export type RecoveryPhaseV1 = z.infer<typeof recoveryPhaseV1Schema>;

/** The phases from which an operation does not advance. */
export const TERMINAL_RECOVERY_PHASES = [
	"recovered",
	"needs_input",
	"refused",
	"failed",
] as const satisfies readonly RecoveryPhaseV1[];

export function isTerminalRecoveryPhase(phase: RecoveryPhaseV1): boolean {
	return (TERMINAL_RECOVERY_PHASES as readonly string[]).includes(phase);
}

/**
 * Why the router declined to act. Each is a decision it made deliberately, not
 * an error — `worker_owns_active_work` in particular is the guard that keeps
 * recovery from disturbing a run that is simply busy.
 */
export const recoveryRefusalReasonV1Schema = z.enum([
	"worker_owns_active_work",
	"stale_revision",
	"run_already_terminal",
	"not_authorized",
]);
export type RecoveryRefusalReasonV1 = z.infer<
	typeof recoveryRefusalReasonV1Schema
>;

/**
 * What the router observed about ownership at a point in the operation.
 *
 * Recorded before and after so the audit trail shows what changed rather than
 * only that something did — an operation that released nothing and one that
 * released a live pin look identical without it.
 */
export const recoveryEvidenceV1Schema = z.object({
	observedAt: isoTimestampV1Schema,
	revision: revisionV1Schema,
	lifecycle: runLifecycleStateV1Schema,
	workerOnline: z.boolean(),
	executorState: executorStateV1Schema.optional(),
	sessionAffinityHeld: z.boolean(),
	issueLocked: z.boolean(),
});
export type RecoveryEvidenceV1 = z.infer<typeof recoveryEvidenceV1Schema>;

export const recoveryPhaseTransitionV1Schema = z.object({
	phase: recoveryPhaseV1Schema,
	enteredAt: isoTimestampV1Schema,
	detail: z.string().min(1).optional(),
});
export type RecoveryPhaseTransitionV1 = z.infer<
	typeof recoveryPhaseTransitionV1Schema
>;

/**
 * The durable record of one recovery attempt.
 *
 * It persists actor, target, idempotency key, checked revision, phases, and
 * before/after evidence, because those are what an audit needs — and because
 * recovery correctness must not depend on anything having been posted to
 * Linear.
 */
export const recoveryOperationV1Schema = z
	.object({
		schemaVersion: schemaVersionV1Schema,
		operationId: identifierV1Schema,
		runId: identifierV1Schema,
		idempotencyKey: z.string().min(8).max(200),
		actor: z.object({
			principalId: identifierV1Schema,
			authMethod: operatorAuthMethodV1Schema,
			roles: z.array(operatorRoleV1Schema).optional(),
		}),
		expectedRevision: revisionV1Schema,
		phase: recoveryPhaseV1Schema,
		phases: z.array(recoveryPhaseTransitionV1Schema).min(1),
		requestedAt: isoTimestampV1Schema,
		updatedAt: isoTimestampV1Schema,
		completedAt: isoTimestampV1Schema.optional(),
		evidenceBefore: recoveryEvidenceV1Schema,
		evidenceAfter: recoveryEvidenceV1Schema.optional(),
		refusalReason: recoveryRefusalReasonV1Schema.optional(),
		failure: z.object({ message: z.string().min(1) }).optional(),
	})
	.superRefine((operation, ctx) => {
		const terminal = isTerminalRecoveryPhase(operation.phase);

		if (terminal !== (operation.completedAt !== undefined)) {
			ctx.addIssue({
				code: "custom",
				path: ["completedAt"],
				message: terminal
					? `A \`${operation.phase}\` operation must record when it completed`
					: `A \`${operation.phase}\` operation has not completed`,
			});
		}

		// After-evidence is the proof of what the operation changed. Publishing
		// it mid-flight would let a caller read an in-progress snapshot as the
		// settled outcome.
		if (!terminal && operation.evidenceAfter !== undefined) {
			ctx.addIssue({
				code: "custom",
				path: ["evidenceAfter"],
				message: "After-evidence is recorded only once an operation finishes",
			});
		}

		if (
			(operation.phase === "refused") !==
			(operation.refusalReason !== undefined)
		) {
			ctx.addIssue({
				code: "custom",
				path: ["refusalReason"],
				message:
					"A refusal reason belongs to a refused operation, and every refusal states one",
			});
		}

		if ((operation.phase === "failed") !== (operation.failure !== undefined)) {
			ctx.addIssue({
				code: "custom",
				path: ["failure"],
				message:
					"A failure message belongs to a failed operation, and every failure states one",
			});
		}

		// The history is the audit trail, so it must actually describe how the
		// operation reached the phase it reports.
		if (operation.phases[0]?.phase !== "accepted") {
			ctx.addIssue({
				code: "custom",
				path: ["phases", 0],
				message: "Every operation begins at `accepted`",
			});
		}
		const latest = operation.phases[operation.phases.length - 1];
		if (latest !== undefined && latest.phase !== operation.phase) {
			ctx.addIssue({
				code: "custom",
				path: ["phases", operation.phases.length - 1],
				message: "The phase history must end at the operation's current phase",
			});
		}
	});
export type RecoveryOperationV1 = z.infer<typeof recoveryOperationV1Schema>;
