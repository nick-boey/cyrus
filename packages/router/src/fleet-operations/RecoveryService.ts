import { randomUUID } from "node:crypto";
import type { ILogger } from "cyrus-core";
import type {
	RecoveryEvidenceV1,
	RecoveryPhaseV1,
	RecoveryRefusalReasonV1,
	RecoveryRequestV1,
} from "cyrus-operator-protocol";
import {
	isTerminalRecoveryPhase,
	isTerminalRunLifecycleState,
} from "cyrus-operator-protocol";
import type {
	AgentRunInfo,
	RecoveryOperationRecord,
	RecoveryOperationScope,
	RouterStore,
} from "../RouterStore.js";
import { observeRun } from "../runs.js";
import {
	auditRecoveryAccepted,
	auditRecoveryJoined,
	auditRecoveryPhase,
	auditRecoveryRefusal,
	auditRecoverySettled,
	redactAuditText,
} from "./RecoveryAudit.js";
import type { OperatorPrincipal } from "./types.js";
import { AUTH_METHOD_BY_KIND } from "./types.js";

/**
 * How a recovery attempt ends. The coordinator RETURNS this rather than
 * reporting it, which is what keeps "the operation finished" a single event
 * with a single after-evidence capture, rather than something that could be
 * asserted twice or asserted while the coordinator is still running.
 */
export interface RecoveryTerminalResult {
	phase: "recovered" | "needs_input" | "refused" | "failed";
	/** One line about the outcome, recorded on the terminal phase transition. */
	detail?: string;
	/** Required for — and only for — `refused`. */
	refusalReason?: RecoveryRefusalReasonV1;
	/** Required for — and only for — `failed`. A thrown error lands here too. */
	failureMessage?: string;
}

/**
 * The seam between the guarded recovery RESOURCE — this module: authorization,
 * idempotency, persistence, audit — and the coordinator that actually
 * reconciles a run.
 *
 * Deliberately narrow, and deliberately not given the store: everything the
 * resource guarantees (an operation is created once, advances monotonically,
 * ends exactly once, and is durable at every step) has to hold whatever the
 * coordinator does, including nothing at all. That is what lets CYR-75 wire the
 * real coordinator behind an interface these tests already pin, and what lets
 * this ship with recovery disabled and a fake behind it.
 *
 * `report` is FIRE-AND-FORGET from the coordinator's side: it persists, appends
 * a run change, and audits, synchronously, and throws only when the coordinator
 * breaks the contract (a terminal phase, or one that goes backwards). It must
 * be called with NON-terminal phases only.
 */
export interface RunReconciler {
	reconcile(
		request: RecoveryRequestV1,
		principal: OperatorPrincipal,
		report: (phase: RecoveryPhaseV1, evidence?: unknown) => void,
	): Promise<RecoveryTerminalResult>;
}

/**
 * A request refused before it became an operation.
 *
 * Distinct from a `refused` OPERATION, and the distinction is the contract's:
 * an operation is something the router accepted and acted on, so a request that
 * never got that far must not leave one behind — otherwise every mistyped run id
 * becomes a durable record of a recovery that never happened. These refusals are
 * still audited (`recovery.refused`), which is where their durable trace lives.
 */
export class RecoveryRequestError extends Error {
	constructor(
		readonly status: 400 | 403 | 404 | 409,
		readonly code: string,
		message: string,
		readonly details?: Record<string, string | number | boolean>,
	) {
		super(message);
		this.name = "RecoveryRequestError";
	}
}

/** What accepting a request produced. */
export interface RecoveryAcceptance {
	operation: RecoveryOperationRecord;
	/** True when a retry joined an operation that already existed. */
	joined: boolean;
}

export interface RecoveryServiceOptions {
	store: RouterStore;
	reconciler: RunReconciler;
	logger?: ILogger;
	now?: () => number;
	/** Injectable so a test can pin operation ids. */
	newOperationId?: () => string;
}

/**
 * A run that has ended cannot be recovered, and neither can one whose evidence
 * has moved since the caller read it. Both are the caller's problem to re-read
 * and retry, so both are `409` rather than a persisted refusal.
 */
const RUN_NOT_FOUND_MESSAGE =
	"No such run, or it is not one this principal may read";

/**
 * The guarded-recovery resource: accept, persist, drive, audit.
 *
 * ── WHAT THIS OWNS AND WHY IT IS NOT THE COORDINATOR ──
 * Recovery is the one mutation the operator contract exposes, so the parts that
 * must be true regardless of what reconciliation does — authorization, the
 * idempotency contract, monotonic durable phases, before/after evidence, and the
 * audit trail — live here, ahead of the seam. `RunReconciler` supplies only the
 * mechanics, and nothing it does can weaken any of the above.
 *
 * ── ASYNCHRONOUS BY DESIGN ──
 * `request` persists `accepted` and returns; the coordinator runs afterwards.
 * That is the ADR's own shape (`202` plus an operation to poll) and it is what
 * lets a recovery outlive the HTTP request that asked for it. Correctness never
 * depends on the caller still being connected, and never on anything having been
 * posted to Linear.
 *
 * ── WHAT IT DOES NOT DO ──
 * It does not resume across a restart. An in-flight operation is driven by an
 * in-memory coordinator, so a process that goes away leaves nothing to advance
 * it — {@link failInterruptedOperations} ends those explicitly at start rather
 * than leaving a client polling an `accepted` operation forever.
 */
export class RecoveryService {
	private readonly store: RouterStore;
	private readonly reconciler: RunReconciler;
	private readonly logger: ILogger | undefined;
	private readonly now: () => number;
	private readonly newOperationId: () => string;
	/** In-flight coordinator runs, so `whenIdle` can await them. */
	private readonly running = new Set<Promise<void>>();

	constructor(options: RecoveryServiceOptions) {
		this.store = options.store;
		this.reconciler = options.reconciler;
		this.logger = options.logger;
		this.now = options.now ?? (() => Date.now());
		this.newOperationId = options.newOperationId ?? (() => randomUUID());
	}

	/**
	 * Accepts one recovery request, or refuses it.
	 *
	 * ── ORDER OF CHECKS, AND WHY IT IS THIS ORDER ──
	 * 1. **Idempotency first.** A retry must join the operation it already named,
	 *    even when the run has since moved on — checking the revision first would
	 *    answer `stale_revision` to a retry of a request accepted at that very
	 *    revision, which is precisely the case the key exists to make safe.
	 * 2. **Target resolution, through the authorized query.** A run in another
	 *    workspace and a run that does not exist produce the SAME `404`, because
	 *    the difference between them is exactly what a caller must not be able to
	 *    probe for.
	 * 3. **Terminal, then revision.** Both mean "re-read and decide again".
	 *
	 * The capability check is NOT here: it belongs to `FleetOperations`, which
	 * owns every capability decision, and it runs before this is ever called.
	 */
	request(
		principal: OperatorPrincipal,
		scope: RecoveryOperationScope,
		request: RecoveryRequestV1,
	): RecoveryAcceptance {
		const existing = this.store.getRecoveryOperationByKey(
			principal.id,
			request.idempotencyKey,
		);
		if (existing) {
			if (
				existing.runId === request.runId &&
				existing.expectedRevision === request.expectedRevision
			) {
				auditRecoveryJoined(this.logger, existing);
				return { operation: existing, joined: true };
			}
			throw this.refuse(principal, request, {
				status: 409,
				code: "idempotency_key_conflict",
				message:
					"This idempotency key is already bound to a different run or revision",
			});
		}

		const run = this.resolveRun(scope, request.runId);
		if (!run) {
			throw this.refuse(principal, request, {
				status: 404,
				code: "run_not_found",
				message: RUN_NOT_FOUND_MESSAGE,
			});
		}
		const evidenceBefore = this.observe(run);
		if (isTerminalRunLifecycleState(evidenceBefore.lifecycle)) {
			throw this.refuse(principal, request, {
				status: 409,
				code: "run_already_terminal",
				message: `This run has already ended (${evidenceBefore.lifecycle})`,
				details: { lifecycle: evidenceBefore.lifecycle },
			});
		}
		if (evidenceBefore.revision !== request.expectedRevision) {
			throw this.refuse(principal, request, {
				status: 409,
				code: "stale_revision",
				message:
					"This run has changed since the observation the request quotes; re-read it and retry",
				details: { currentRevision: evidenceBefore.revision },
			});
		}

		const workspaceId = run.routing.workspaceId;
		if (workspaceId === undefined) {
			// Unreachable through `listFleetAgentRuns`, which cannot return a run
			// without a workspace — the authorization clause is an `IN` over the
			// column. Checked anyway because the alternative is writing an operation
			// whose workspace is a lie, and a workspace is the only thing deciding
			// who may read it back.
			throw this.refuse(principal, request, {
				status: 404,
				code: "run_not_found",
				message: RUN_NOT_FOUND_MESSAGE,
			});
		}

		const claim = this.store.createRecoveryOperation({
			operationId: this.newOperationId(),
			runId: run.runId,
			idempotencyKey: request.idempotencyKey,
			principalId: principal.id,
			authMethod: AUTH_METHOD_BY_KIND[principal.authKind],
			roles: [...principal.roles],
			workspaceId,
			...(scope.ownerScopeUserId !== undefined
				? { ownerUserId: scope.ownerScopeUserId }
				: {}),
			expectedRevision: request.expectedRevision,
			...(request.reason !== undefined ? { reason: request.reason } : {}),
			evidenceBefore,
			nowMs: this.now(),
		});
		// The claim is re-decided inside the store's transaction, so a second
		// concurrent request with the same key lands here rather than creating a
		// competing operation.
		if (claim.status === "conflict") {
			throw this.refuse(principal, request, {
				status: 409,
				code: "idempotency_key_conflict",
				message:
					"This idempotency key is already bound to a different run or revision",
			});
		}
		if (claim.status === "joined") {
			auditRecoveryJoined(this.logger, claim.operation);
			return { operation: claim.operation, joined: true };
		}

		this.store.appendRecoveryRunChange(claim.operation.runId, this.now());
		auditRecoveryAccepted(this.logger, claim.operation);
		this.drive(claim.operation, request, principal);
		return { operation: claim.operation, joined: false };
	}

	/** One operation, if this caller may read it. */
	get(
		scope: RecoveryOperationScope,
		operationId: string,
	): RecoveryOperationRecord | undefined {
		return this.store.getRecoveryOperation(operationId, scope);
	}

	/**
	 * Records a refusal taken OUTSIDE this service — today, the capability check
	 * `FleetOperations` owns.
	 *
	 * An unauthorized attempt at the contract's one mutation is exactly what an
	 * audit is read for, and it would otherwise leave no trace at all: it never
	 * reaches a store write, and the route body deliberately says only
	 * "forbidden".
	 */
	noteRefusal(
		principal: OperatorPrincipal,
		request: RecoveryRequestV1,
		outcome: { status: number; code: string; detail?: string },
	): void {
		auditRecoveryRefusal(this.logger, this.identityFor(principal, request), {
			code: outcome.code,
			status: outcome.status,
			...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
		});
	}

	/**
	 * Ends every operation this process inherited mid-flight, and audits each.
	 *
	 * Called from `RouterServer.start()` and nowhere else — the router's SQLite
	 * file is shared with out-of-process CLI commands, so doing this on
	 * construction would let `cyrus router containers list` fail a live operation
	 * belonging to the running router. Same discipline as
	 * `RouterStore.resetRunWorkerConnectivity`.
	 */
	failInterruptedOperations(): void {
		const nowMs = this.now();
		const failed = this.store.failInterruptedRecoveryOperations(
			nowMs,
			"The router restarted while this recovery was in flight; request a new one",
		);
		for (const operation of failed) {
			this.store.appendRecoveryRunChange(operation.runId, nowMs);
			auditRecoverySettled(this.logger, operation);
		}
		if (failed.length > 0) {
			this.logger?.warn(
				`Failed ${failed.length} recovery operation(s) interrupted by a router restart`,
			);
		}
	}

	/**
	 * Resolves once no coordinator run is outstanding.
	 *
	 * Used at shutdown and by tests. It is NOT a way to make `request`
	 * synchronous: the operation record is authoritative and a caller polls it.
	 */
	async whenIdle(): Promise<void> {
		while (this.running.size > 0) {
			await Promise.all([...this.running]);
		}
	}

	/**
	 * Runs the coordinator for one accepted operation.
	 *
	 * Every exit path settles the operation, including a coordinator that throws
	 * and one that returns something malformed. An operation that could be left
	 * un-settled is the failure mode this whole resource exists to prevent — a
	 * client polls `accepted` forever and reads it as work in progress.
	 */
	private drive(
		operation: RecoveryOperationRecord,
		request: RecoveryRequestV1,
		principal: OperatorPrincipal,
	): void {
		const run = (async () => {
			try {
				const result = await this.reconciler.reconcile(
					request,
					principal,
					(phase, evidence) =>
						this.report(operation.operationId, phase, evidence),
				);
				this.settle(operation.operationId, result);
			} catch (error) {
				this.settle(operation.operationId, {
					phase: "failed",
					failureMessage: messageOf(error),
				});
			}
		})();
		this.running.add(run);
		void run.finally(() => this.running.delete(run));
	}

	/**
	 * Persists one non-terminal phase, then reports it.
	 *
	 * Persist-then-emit, never the other way round: a change entry or an audit
	 * line describing a phase the store never recorded is evidence of something
	 * that did not durably happen.
	 *
	 * The coordinator's `evidence` becomes the transition's DETAIL rather than a
	 * second evidence snapshot. The before/after pair is captured by this service
	 * from the store, so it always describes the same facts in the same units;
	 * letting a coordinator supply its own would make the audit's central
	 * comparison depend on whoever implemented reconciliation.
	 */
	private report(
		operationId: string,
		phase: RecoveryPhaseV1,
		evidence?: unknown,
	): void {
		if (isTerminalRecoveryPhase(phase)) {
			// Thrown INTO the coordinator, which is the only place that can still
			// stop. Accepting it would settle the operation with no after-evidence
			// while reconciliation carried on running against a run the router has
			// already declared finished with.
			throw new Error(
				`A recovery coordinator must RETURN its outcome; \`${phase}\` cannot be reported as a phase`,
			);
		}
		const operation = this.store.advanceRecoveryOperation({
			operationId,
			phase,
			atMs: this.now(),
			...(evidence !== undefined ? { detail: describe(evidence) } : {}),
		});
		this.store.appendRecoveryRunChange(operation.runId, this.now());
		auditRecoveryPhase(this.logger, operation);
	}

	/**
	 * Records the outcome, with the after-evidence it is judged on.
	 *
	 * Catches its own errors: it is called from both the success and the failure
	 * path of {@link drive}, and a throw here would either re-enter the failure
	 * path (which would then throw again on an already-terminal operation) or
	 * escape as an unhandled rejection.
	 */
	private settle(operationId: string, result: RecoveryTerminalResult): void {
		try {
			const outcome = normalizeOutcome(result);
			const current = this.store.getRecoveryOperationById(operationId);
			const evidenceAfter = current
				? this.observeById(current.runId)
				: undefined;
			const operation = this.store.advanceRecoveryOperation({
				operationId,
				phase: outcome.phase,
				atMs: this.now(),
				...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
				...(evidenceAfter ? { evidenceAfter } : {}),
				...(outcome.refusalReason !== undefined
					? { refusalReason: outcome.refusalReason }
					: {}),
				...(outcome.failureMessage !== undefined
					? { failureMessage: redactAuditText(outcome.failureMessage) }
					: {}),
			});
			this.store.appendRecoveryRunChange(operation.runId, this.now());
			auditRecoverySettled(this.logger, operation);
		} catch (error) {
			this.logger?.error(
				`Could not settle recovery operation ${operationId}`,
				error,
			);
		}
	}

	/** The authorized read. An unauthorized run is indistinguishable from none. */
	private resolveRun(
		scope: RecoveryOperationScope,
		runId: string,
	): AgentRunInfo | undefined {
		return this.store.listFleetAgentRuns({
			workspaceIds: scope.workspaceIds,
			...(scope.ownerScopeUserId !== undefined
				? { ownerScopeUserId: scope.ownerScopeUserId }
				: {}),
			runId,
			limit: 1,
		})[0];
	}

	/**
	 * What the router can see about a run's ownership right now.
	 *
	 * Derived from `observeRun` rather than from raw columns so the lifecycle and
	 * the executor state mean exactly what `/api/v1/runs` reported to the caller —
	 * a recovery is conditional on an observation the caller READ, so the two
	 * projections must not be able to disagree. The affinity and the lock are read
	 * live, because those are the ownership facts the recovery is about and the
	 * run row does not carry them.
	 */
	private observe(run: AgentRunInfo): RecoveryEvidenceV1 {
		const observation = observeRun(run);
		return {
			observedAt: new Date(this.now()).toISOString(),
			revision: observation.revision,
			lifecycle: observation.lifecycle,
			workerOnline: observation.worker.online,
			...(observation.executorState !== undefined
				? { executorState: observation.executorState }
				: {}),
			sessionAffinityHeld:
				this.store.getSessionAffinity(run.sessionId) !== undefined,
			issueLocked:
				this.store.getIssueLockDeviceForSession(run.sessionId) !== undefined,
		};
	}

	/**
	 * The after-evidence, read without an authorization scope.
	 *
	 * Deliberately unscoped: this is the ROUTER recording what its own operation
	 * left behind, not a caller reading someone else's run, and the operation's
	 * readership is already fixed by the workspace stored on it. A run that has
	 * since aged out yields no after-evidence rather than blocking the outcome.
	 */
	private observeById(runId: string): RecoveryEvidenceV1 | undefined {
		const run = this.store.getAgentRunById(runId);
		return run ? this.observe(run) : undefined;
	}

	private refuse(
		principal: OperatorPrincipal,
		request: RecoveryRequestV1,
		outcome: {
			status: 400 | 403 | 404 | 409;
			code: string;
			message: string;
			details?: Record<string, string | number | boolean>;
		},
	): RecoveryRequestError {
		auditRecoveryRefusal(this.logger, this.identityFor(principal, request), {
			code: outcome.code,
			status: outcome.status,
		});
		return new RecoveryRequestError(
			outcome.status,
			outcome.code,
			outcome.message,
			outcome.details,
		);
	}

	private identityFor(
		principal: OperatorPrincipal,
		request: RecoveryRequestV1,
	) {
		return {
			runId: request.runId,
			principalId: principal.id,
			authMethod: AUTH_METHOD_BY_KIND[principal.authKind],
			idempotencyKey: request.idempotencyKey,
			expectedRevision: request.expectedRevision,
		};
	}
}

/**
 * Makes a coordinator's outcome one the record can actually hold.
 *
 * A refusal with no reason, or a failure with no message, is a coordinator bug
 * — but it must not become an un-settled operation, which is the one failure
 * this resource exists to prevent. Both are recorded as `failed` naming the
 * contract violation, rather than as a refusal whose reason we invented: an
 * audit that reports a refusal reason the router did not actually decide is
 * worse than one that reports a broken coordinator.
 */
function normalizeOutcome(
	result: RecoveryTerminalResult,
): RecoveryTerminalResult {
	if (result.phase === "refused" && result.refusalReason === undefined) {
		return {
			phase: "failed",
			...(result.detail !== undefined ? { detail: result.detail } : {}),
			failureMessage:
				"The recovery coordinator refused without stating a reason",
		};
	}
	if (result.phase === "failed" && result.failureMessage === undefined) {
		return {
			...result,
			failureMessage: "Recovery failed for an unstated reason",
		};
	}
	if (result.phase !== "refused" && result.refusalReason !== undefined) {
		const { refusalReason: _dropped, ...rest } = result;
		return rest;
	}
	if (result.phase !== "failed" && result.failureMessage !== undefined) {
		const { failureMessage: _dropped, ...rest } = result;
		return rest;
	}
	return result;
}

/**
 * Renders a coordinator's opaque evidence as one line of detail.
 *
 * Redacted and bounded by {@link redactAuditText} on the way into the store, not
 * only on the way into a log: this string is durable, and a coordinator that
 * quotes an upstream error body is the likeliest way a credential reaches it.
 */
function describe(evidence: unknown): string {
	const rendered =
		typeof evidence === "string" ? evidence : safeStringify(evidence);
	return redactAuditText(rendered);
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function messageOf(error: unknown): string {
	return redactAuditText(
		error instanceof Error ? error.message : String(error),
	);
}
