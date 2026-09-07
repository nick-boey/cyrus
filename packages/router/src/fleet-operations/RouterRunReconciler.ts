import { createNoopLogger, type ILogger } from "cyrus-core";
import type {
	RecoveryPhaseV1,
	RecoveryRequestV1,
} from "cyrus-operator-protocol";
import { isTerminalRunLifecycleState } from "cyrus-operator-protocol";
import type { AgentRunInfo, RouterStore } from "../RouterStore.js";
import {
	emitRunEvent,
	RUN_EVENTS,
	type RunUnknownReason,
	runAttribution,
} from "../RouterTelemetry.js";
import type {
	RecoveryTerminalResult,
	RunReconciler,
} from "./RecoveryService.js";
import type { OperatorPrincipal } from "./types.js";

/** What one idempotent container boot did. */
export interface RunRecoveryBootOutcome {
	ok: boolean;
	/** The provider's own message when it did not come up. */
	detail?: string;
}

/**
 * Starting a container, for recovery.
 *
 * Narrow to ONE verb on purpose. `ContainerTargetService` can also stop and
 * destroy, and `ExecutorRegistry` can terminate — and recovery may do none of
 * those. Handing the coordinator the whole service and trusting it to call only
 * `boot` would make "recovery never terminates live work or destroys an
 * executor" a property of this file's current contents rather than of its type.
 */
export interface RunRecoveryExecutor {
	/**
	 * Boots the device's container and resolves once the provider reports it
	 * running, or with `ok: false` when it did not. Idempotent: a container that
	 * is already up returns immediately.
	 */
	boot(deviceId: number): Promise<RunRecoveryBootOutcome>;
}

/** The router's live view of one device's worker process. */
export interface RunRecoveryWorker {
	isOnline(deviceId: number): boolean;
	/**
	 * Resolves `true` once the device holds an AUTHENTICATED socket, `false` if
	 * it has not by `timeoutMs`. Authentication is the load-bearing word: a TCP
	 * connection proves nothing about who is on the other end, and this answer is
	 * what licenses a release.
	 */
	awaitOnline(deviceId: number, timeoutMs: number): Promise<boolean>;
	/**
	 * The worker's authoritative session set, or `undefined` for "can't tell" —
	 * offline, no capability, or no answer in time. The two are never collapsed:
	 * an empty array means "running nothing", and reading silence that way would
	 * let a mute worker license the release of a session it is still running.
	 */
	querySessions(
		deviceId: number,
		timeoutMs: number,
	): Promise<string[] | undefined>;
}

export interface RunRecoveryTimeouts {
	/** How long an authenticated reconnect may take after the boot returns. */
	reconnectMs: number;
	/** How long the worker has to answer the session query. */
	sessionsQueryMs: number;
	/**
	 * How long durable frames get to replay before ownership is judged stale.
	 *
	 * A worker's `session_state` frame is buffered and replayed until acked, so a
	 * terminal frame from the run we are about to declare `unknown` may still be
	 * in flight at the instant the worker answers the session query. Waiting is
	 * what turns "the worker does not claim it" into "the worker is done with
	 * it", and re-reading the run afterwards is what stops recovery overwriting
	 * an outcome the worker actually reported.
	 */
	replayMs: number;
	/**
	 * How recently a session may have been claimed and still be treated as one
	 * the reconnected worker can authoritatively disown.
	 *
	 * The same window `EventRouter.reconcileDeviceAffinity` applies to an affinity
	 * row, and applied here for the same reason: a session routed moments ago has
	 * its event queued or in the worker's hands but no runner up yet, so the
	 * worker truthfully reports it is running nothing. Releasing there produces
	 * CYR-81's disowned session.
	 */
	ownershipGraceMs: number;
}

/**
 * ACA cold boots are ~60s and an image pull can be minutes, so a reconnect
 * deadline shorter than that would report a healthy recovery as failed.
 *
 * `sessionsQueryMs` and `ownershipGraceMs` mirror `RouterServer`'s
 * `DEFAULT_SESSIONS_QUERY_TIMEOUT_MS` and `DEFAULT_AFFINITY_GRACE_MS`. They are
 * duplicated rather than imported because this module must not depend on the
 * composition root, and they are only reached on a router with no `containers`
 * block — where every recovery is refused before any of them is read.
 */
export const DEFAULT_RUN_RECOVERY_TIMEOUTS: RunRecoveryTimeouts = {
	reconnectMs: 180_000,
	sessionsQueryMs: 5_000,
	replayMs: 5_000,
	ownershipGraceMs: 600_000,
};

export interface RouterRunReconcilerOptions {
	store: RouterStore;
	worker: RunRecoveryWorker;
	/**
	 * Absent on a router with no container executors. A container run then fails
	 * rather than being silently skipped: an operator who asked for a recovery
	 * this deployment cannot perform must be told so.
	 */
	executor?: RunRecoveryExecutor;
	/**
	 * Retires the router's IN-MEMORY ownership records for a session whose
	 * ownership has just been released.
	 *
	 * Not optional for correctness so much as for construction order: the store
	 * is not the only place ownership lives. `EventRouter.parkedSessionCreators`
	 * is a map, and it is the only thing the `active` branch consults before
	 * writing full session affinity — so a stray or late `active` frame from the
	 * disproved device would re-pin a run this recovery just marked `unknown`,
	 * and a run that has ended can never end again. That is PAR-146's permanent
	 * pin, recreated by the tool meant to fix it.
	 *
	 * Failures here are swallowed: they happen after the durable write, and an
	 * operation reported `failed` over a release that did happen is a worse
	 * outcome than a stale map entry.
	 */
	forgetOwnership?: (sessionId: string, deviceId: number) => void;
	logger?: ILogger;
	now?: () => number;
	/**
	 * The replay window, injected. Every wait in this coordinator goes through
	 * here or through {@link RunRecoveryWorker.awaitOnline}, so the whole class is
	 * testable without a real sleep.
	 */
	delay?: (ms: number) => Promise<void>;
	timeouts?: Partial<RunRecoveryTimeouts>;
}

/**
 * The production coordinator behind guarded recovery: reconcile a run's
 * observation, its worker's ownership, and its executor state — and release
 * ownership only once the worker itself has disowned it.
 *
 * ── THE SHAPE THIS EXISTS FOR ──
 * A container that is stopped, whose worker is offline, and whose session still
 * holds affinity and an issue lock. Nothing about it produces a lifecycle
 * transition, Linear keeps rendering a live agent session, and every new
 * top-level comment on the issue is rejected at the lock — the failure
 * `noteStranded`'s `offline_pinned` reason detects but cannot fix. Recovery is
 * how an operator fixes it without break-glass.
 *
 * ── THE ORDER OF THE GUARDS IS THE SAFETY ARGUMENT ──
 * Each of the first four steps can only REFUSE, and each is checked before
 * anything is started, so a request that was never safe costs nothing and
 * mutates nothing:
 *
 *   1. The run still exists and still reads the way the caller read it.
 *   2. It has not ended — the worker's own outcome always wins.
 *   3. It is not waiting on an elicitation. Recovery cannot manufacture an
 *      answer, and pretending otherwise would release a session that is
 *      correctly parked on a question.
 *   4. Its worker is offline. A connected worker owns its own run, full stop;
 *      this is the guard that keeps recovery from disturbing a run that is
 *      merely busy.
 *
 * Only then does it act, and even then the release is conditional twice more:
 * on an authenticated worker having reconnected and disowned the session, and
 * on a single compare-and-swap that re-checks the revision and the device.
 *
 * ── WHICH RELEASE PATH ACTUALLY RUNS ──
 * Worth knowing before reading the two of them. Booting the container is itself
 * what brings its worker back, and `RouterServer` runs
 * `EventRouter.reconcileDeviceAffinity` and `reconcileDeviceLocks` on the
 * `deviceConnected` this coordinator is waiting for — both synchronously ahead
 * of `awaitOnline`'s own listener. On the canonical shape (a session stranded for
 * hours, so its affinity row is well past `affinityGraceMs`) that reclaim
 * therefore usually wins the race, and by the time the replay window closes the
 * run is already terminal. So the COMMON path is `releaseResidualOwnership`, and
 * what recovery adds over the reconnect reconciliation is the issue lock, the
 * ownership grace, and the in-memory park record — none of which that path
 * touches, and the first of which is what makes the issue write-only.
 *
 * `releaseStaleRunOwnership` is still the one that may write `unknown` over a
 * live run, so it remains the compare-and-swap: it covers the cases where the
 * reconnect reconciliation did not fire or did not apply, and it is the only
 * release that is atomic with the outcome it records.
 *
 * ── WHAT IT CANNOT DO, BY CONSTRUCTION ──
 * It holds no Linear client, no issue-tracker, and no way to stop or destroy an
 * executor. `RunRecoveryExecutor` exposes `boot` and nothing else. So "recovery
 * never terminates live work, destroys an executor, answers an elicitation, or
 * relies on a Linear comment" is enforced by what this class is given, not by
 * what it currently chooses to call.
 */
export class RouterRunReconciler implements RunReconciler {
	private readonly store: RouterStore;
	private readonly worker: RunRecoveryWorker;
	private readonly executor: RunRecoveryExecutor | undefined;
	private readonly forgetOwnership:
		| ((sessionId: string, deviceId: number) => void)
		| undefined;
	private readonly logger: ILogger | undefined;
	private readonly now: () => number;
	private readonly delay: (ms: number) => Promise<void>;
	private readonly timeouts: RunRecoveryTimeouts;

	constructor(options: RouterRunReconcilerOptions) {
		this.store = options.store;
		this.worker = options.worker;
		this.executor = options.executor;
		this.forgetOwnership = options.forgetOwnership;
		this.logger = options.logger;
		this.now = options.now ?? (() => Date.now());
		this.delay =
			options.delay ??
			((ms) =>
				new Promise((resolve) => {
					setTimeout(resolve, ms).unref?.();
				}));
		this.timeouts = { ...DEFAULT_RUN_RECOVERY_TIMEOUTS, ...options.timeouts };
	}

	async reconcile(
		request: RecoveryRequestV1,
		principal: OperatorPrincipal,
		report: (phase: RecoveryPhaseV1, evidence?: unknown) => void,
	): Promise<RecoveryTerminalResult> {
		// Re-read rather than trusting the record: `RecoveryService` checked these
		// facts when it accepted the request, and the operation has been queued
		// behind whatever else the process was doing since.
		const run = this.store.getAgentRunById(request.runId);
		if (!run) {
			return failure("The run no longer exists; nothing was changed");
		}
		// Terminal before revision, matching `RecoveryService`'s own order. Both
		// mean "re-read and decide again", but a run that ENDED has a more useful
		// answer than the revision bump its ending produced — and every ending
		// produces one, so checking the number first would report the cause as
		// staleness every time.
		if (isTerminalRunLifecycleState(run.state)) {
			return refusal(
				"run_already_terminal",
				`The run ended (${run.state}) before reconciliation began`,
			);
		}
		if (run.revision !== request.expectedRevision) {
			return refusal(
				"stale_revision",
				`The run moved to revision ${run.revision} since the observation this request quotes`,
			);
		}
		// An elicitation is a question put to a HUMAN. The router holds no answer
		// and must not release a session that is correctly waiting for one.
		if (run.state === "waiting" && run.wait?.reason === "elicitation") {
			return {
				phase: "needs_input",
				detail:
					"The run is waiting on an elicitation; answer it in Linear rather than recovering the run",
			};
		}
		if (this.worker.isOnline(run.deviceId)) {
			return refusal(
				"worker_owns_active_work",
				"The run's worker is connected and still owns it",
			);
		}
		if (run.executorKind !== "container") {
			// A physical device is a teammate's own machine. There is no control
			// plane to start it, so there is nothing to reconcile against and
			// nothing this coordinator may safely conclude from its silence.
			return refusal(
				"executor_not_startable",
				"The run is on an offline physical device, which the router cannot start",
			);
		}
		if (!this.executor) {
			return failure(
				"This router has no container executor configured, so it cannot start the run's container",
			);
		}

		this.logger?.info(
			`Recovering run ${run.runId} (${run.issueKey}, session ${run.sessionId}) for ${principal.id}`,
		);

		report("starting_executor", {
			deviceId: run.deviceId,
			executorState: run.executorState ?? "unknown",
		});
		const boot = await this.executor.boot(run.deviceId);
		if (!boot.ok) {
			return failure(
				`Could not start the run's container: ${boot.detail ?? "the provider reported no detail"}`,
			);
		}
		// Infrastructure "running" is not worker-process liveness: an ACA sandbox
		// can report Running with an exited entrypoint. The authenticated socket is
		// the only evidence that the process which owns this run is back.
		const reconnected = await this.worker.awaitOnline(
			run.deviceId,
			this.timeouts.reconnectMs,
		);
		if (!reconnected) {
			return failure(
				`The container started but its worker did not reconnect within ${this.timeouts.reconnectMs}ms`,
			);
		}

		report("reconciling", { deviceId: run.deviceId });
		// A worker's session list is only authoritative once it has actually
		// RECEIVED the work it is being asked about. `deviceConnected` — what
		// `awaitOnline` resolves on — is emitted one line before `deliverPending`,
		// so a cold-booted sandbox answers "running nothing" while a routed event
		// is still queued for it, and again while it clones the repository and
		// starts a runner. Releasing there is CYR-81 exactly: the event still
		// lands, the session runs DISOWNED with every Linear post refused, and the
		// idle sweep reads `affinity = 0` and suspends the sandbox mid-work.
		//
		// The router already refuses this decision on both grounds elsewhere —
		// `reconcileDeviceLocks` on `hasPendingEvents`, `reconcileDeviceAffinity`
		// on the affinity grace — and recovery must not be the one path that
		// concludes without them.
		const unsettled = this.describeUnsettledWork(run);
		if (unsettled) {
			return failure(
				`The worker's session list is not yet authoritative: ${unsettled}`,
			);
		}
		const declared = await this.worker.querySessions(
			run.deviceId,
			this.timeouts.sessionsQueryMs,
		);
		if (declared === undefined) {
			return failure(
				"The reconnected worker did not report which sessions it is running, so its ownership could not be disproved",
			);
		}
		if (declared.includes(run.sessionId)) {
			// The pin was never stale. The container is now up and the worker owns
			// its run again, which is the outcome that unblocks the issue — so this
			// is `recovered`, not a refusal: the router did the work and the
			// evidence pair records that it released nothing.
			return {
				phase: "recovered",
				detail:
					"The reconnected worker still claims this session; its ownership was preserved and nothing was released",
			};
		}

		// The worker's `session_state` frames are durably buffered and replayed
		// until acked, so a terminal frame for this very run may be in flight.
		report("replaying", { declaredSessions: declared.length });
		await this.delay(this.timeouts.replayMs);

		// The evidence is re-read once more before the release is ANNOUNCED, not
		// only inside the compare-and-swap. The swap is still the authority — it is
		// the only thing that makes the release atomic — but a
		// `releasing_stale_ownership` phase that a client polls and then sees
		// refused describes a release the router never attempted, and the phase
		// history is the audit trail.
		const settled = this.recheck(run, report);
		if (settled) return settled;

		// Re-read once more, because the revision the swap is conditional on must
		// be the one this decision was made from — and it is NOT `run.revision`.
		// `worker_online` and `executor_state` are MATERIAL columns, and
		// `DeviceGateway.handleHello` writes connectivity before it emits the event
		// `awaitOnline` resolves on. The offline→online transition is therefore
		// GUARANTEED by the guard above, so quoting the pre-boot revision would
		// make every recovery refuse itself with `stale_revision` on the exact path
		// the feature exists for. `recheck` has already established that nothing
		// about the run's OWN facts moved; the swap covers the window between that
		// check and this write.
		const current = this.store.getAgentRunById(run.runId);
		if (!current) {
			return failure("The run aged out before its ownership could be released");
		}
		report("releasing_stale_ownership", {
			deviceId: run.deviceId,
			revision: current.revision,
		});
		const outcome = this.store.releaseStaleRunOwnership({
			runId: run.runId,
			expectedRevision: current.revision,
			expectedDeviceId: run.deviceId,
			nowMs: this.now(),
		});
		if (outcome.status === "declined") {
			return this.declineToTerminal(outcome.reason, outcome.run, run, report);
		}

		this.noteRelease(run, principal, outcome);
		return {
			phase: "recovered",
			detail: `The reconnected worker does not claim this session; released ${describeRelease(outcome)} and marked the outcome unknown`,
		};
	}

	/**
	 * Records a release that actually happened — and never lets recording it
	 * change the outcome.
	 *
	 * Everything here runs AFTER the durable write. A throwing log sink or a
	 * retired-park callback that fails would otherwise propagate into
	 * `RecoveryService.drive`, which settles the operation `failed` — an audit
	 * that reports "released nothing" over a release that did happen, which is
	 * worse than no audit at all.
	 */
	private noteRelease(
		run: AgentRunInfo,
		principal: OperatorPrincipal,
		outcome: {
			run: AgentRunInfo;
			affinityReleased: boolean;
			lockReleased: boolean;
			graceReleased: boolean;
		},
	): void {
		try {
			// The in-memory park record is the LAST ownership route, and it is not in
			// the store: an `active` frame from this same device redeems it with an
			// unconditional `setSessionAffinity`, which would re-pin a run that is
			// now `unknown` and can therefore never end again — PAR-146's permanent
			// pin, recreated by the tool meant to fix it.
			this.forgetOwnership?.(run.sessionId, run.deviceId);
			// Deliberately `run.unknown` rather than a recovery-specific name: the
			// fact reported is that a run ended with its outcome never observed,
			// which is the same fact whatever ended it. The reason is what says
			// recovery did.
			emitRunEvent(
				this.logger ?? createNoopLogger(),
				RUN_EVENTS.unknown,
				runAttribution(outcome.run),
				{
					reason: "recovery_reconciled" satisfies RunUnknownReason,
					affinity_released: outcome.affinityReleased,
					lock_released: outcome.lockReleased,
					grace_released: outcome.graceReleased,
					principal_id: principal.id,
				},
			);
			this.logger?.info(
				`Released stale ownership for run ${run.runId} (${run.issueKey}): the reconnected worker on device ${run.deviceId} does not claim session ${run.sessionId}`,
			);
		} catch (error) {
			this.logger?.warn(
				`Recovery released ownership for run ${run.runId} but could not record it`,
				error,
			);
		}
	}

	/**
	 * Why the worker cannot yet be taken at its word, or `undefined` when it can.
	 *
	 * Two independent reasons, both already load-bearing elsewhere in the router:
	 * an undelivered event means the worker has not been told about work it is
	 * about to start, and a claim established moments ago means the same thing
	 * with the event already handed over but the runner not yet up.
	 */
	private describeUnsettledWork(run: AgentRunInfo): string | undefined {
		const now = this.now();
		if (this.store.hasPendingEvents(run.deviceId, now)) {
			return `device ${run.deviceId} still has undelivered events`;
		}
		const affinity = this.store
			.listSessionAffinityForDevice(run.deviceId)
			.find((row) => row.sessionId === run.sessionId);
		const claimedMs = Math.max(affinity?.establishedMs ?? 0, run.lastRoutedMs);
		const age = now - claimedMs;
		if (age < this.timeouts.ownershipGraceMs) {
			return `this session was claimed ${age}ms ago, inside the ${this.timeouts.ownershipGraceMs}ms grace a freshly routed session gets to start`;
		}
		return undefined;
	}

	/**
	 * Re-reads everything the release is conditional on, after the replay window.
	 *
	 * @returns the outcome to finish with, or `undefined` to go ahead.
	 *
	 * A terminal run is `recovered` and not a refusal, and the wording is
	 * deliberately neutral about WHO ended it: the worker's own replayed frame, the
	 * reconnect reconciliation this recovery's own boot triggered, and a second
	 * concurrent recovery all land here, and this coordinator cannot tell them
	 * apart — nor does it need to.
	 *
	 * What it must NOT do is treat "the run ended" as "the ownership is gone".
	 * `EventRouter.reconcileDeviceAffinity` ends a run and clears its affinity
	 * while leaving the issue lock, and the pass that would have released the lock
	 * skips a device whose events are still undelivered — so the run reads
	 * terminal with the issue still write-only, which is the exact failure
	 * recovery was called about. Any residual ownership is released here, without
	 * touching the outcome the run already reported.
	 */
	private recheck(
		run: AgentRunInfo,
		report: (phase: RecoveryPhaseV1, evidence?: unknown) => void,
	): RecoveryTerminalResult | undefined {
		const settled = this.store.getAgentRunById(run.runId);
		if (!settled) {
			return failure("The run aged out while its worker's frames replayed");
		}
		if (isTerminalRunLifecycleState(settled.state)) {
			return this.releaseResidualOwnership(run, settled, report);
		}
		// Compared on the run's OWN facts, deliberately NOT on the revision.
		// `worker_online` and `executor_state` are material columns, so the
		// reconnect this recovery just caused — and the sweep sampling the sandbox
		// it just started — both bump the number. Refusing on that would be the
		// coordinator refusing itself, every time, on the one path that matters.
		// The revision is still what the swap is conditional on; it is just read
		// fresh at the point of decision rather than carried from before the boot.
		const moved = describeRunFactsChange(run, settled);
		if (moved) {
			return refusal(
				"stale_revision",
				`The run's ${moved} changed while its container was being reconciled`,
			);
		}
		const affinityDevice = this.store.getSessionAffinity(run.sessionId);
		const lockDevice = this.store.getIssueLockDeviceForSession(run.sessionId);
		if (
			settled.deviceId !== run.deviceId ||
			(affinityDevice !== undefined && affinityDevice !== run.deviceId) ||
			(lockDevice !== undefined && lockDevice !== run.deviceId)
		) {
			return refusal(
				"worker_owns_active_work",
				"The run's ownership moved to another device while its container was being reconciled",
			);
		}
		return undefined;
	}

	/**
	 * Clears anything the run's ending left behind, for a run that ended while
	 * this recovery was reconciling it.
	 *
	 * The phase is announced only when there is something to release, so a
	 * recovery that genuinely found nothing to do does not leave a
	 * `releasing_stale_ownership` entry describing a release of nothing.
	 */
	private releaseResidualOwnership(
		run: AgentRunInfo,
		settled: AgentRunInfo,
		report: (phase: RecoveryPhaseV1, evidence?: unknown) => void,
	): RecoveryTerminalResult {
		const held =
			this.store.getSessionAffinity(run.sessionId) === run.deviceId ||
			this.store.getIssueLockDeviceForSession(run.sessionId) === run.deviceId ||
			this.store.getSessionOwnershipGrace(run.sessionId, this.now()) ===
				run.deviceId;
		if (!held) {
			return {
				phase: "recovered",
				detail: `The run reached \`${settled.state}\` while its worker's durable frames replayed, and its ownership was released with it`,
			};
		}
		report("releasing_stale_ownership", {
			deviceId: run.deviceId,
			runEnded: settled.state,
		});
		const residual = this.store.releaseEndedRunOwnership({
			runId: run.runId,
			expectedDeviceId: run.deviceId,
		});
		if (residual.status === "declined") {
			// `superseded` is the one that matters and it is a REFUSAL, not an
			// error: the session has started a new run — typically because the
			// previously-blocked user replied in-thread, which is the documented
			// recovery for a lock rejection — so the rows named after this session
			// now belong to live work. `run_active` means the run went terminal and
			// back inside one tick, which no worker does.
			return residual.reason === "superseded"
				? refusal(
						"worker_owns_active_work",
						"The session started a new run while its container was being reconciled; that run's ownership is not this recovery's to release",
					)
				: failure(
						`The run's residual ownership could not be released (${residual.reason})`,
					);
		}
		try {
			this.forgetOwnership?.(run.sessionId, run.deviceId);
		} catch (error) {
			this.logger?.warn(
				`Recovery released residual ownership for run ${run.runId} but could not retire its park record`,
				error,
			);
		}
		this.logger?.info(
			`Released ownership left behind by run ${run.runId} (${run.issueKey}) after it reached ${settled.state}`,
		);
		return {
			phase: "recovered",
			detail: `The run reached \`${settled.state}\` while its worker's durable frames replayed; released ${describeRelease(residual)} it left behind`,
		};
	}

	/**
	 * Renders a compare-and-swap decline as an outcome.
	 *
	 * `run_terminal` is not a refusal — the worker's own frame won the race and
	 * the ownership this recovery was called about may be gone — but it is not
	 * success on its own either: it routes through the residual pass for exactly
	 * the reason that pass exists, since "the run ended" is not "the ownership is
	 * gone". Reporting `recovered` here without checking would leave the write-only
	 * issue this recovery was called about, and say it had been fixed.
	 */
	private declineToTerminal(
		reason:
			| "run_missing"
			| "revision_changed"
			| "run_terminal"
			| "ownership_moved",
		settled: AgentRunInfo | undefined,
		run: AgentRunInfo,
		report: (phase: RecoveryPhaseV1, evidence?: unknown) => void,
	): RecoveryTerminalResult {
		switch (reason) {
			case "run_terminal":
				return settled
					? this.releaseResidualOwnership(run, settled, report)
					: failure("The run aged out before its ownership could be released");
			case "revision_changed":
				return refusal(
					"stale_revision",
					`The run moved to revision ${settled?.revision ?? "another revision"} between the decision and the write`,
				);
			case "ownership_moved":
				return refusal(
					"worker_owns_active_work",
					"The run's ownership moved to another device while its container was being reconciled",
				);
			case "run_missing":
				return failure(
					"The run aged out before its ownership could be released",
				);
		}
	}
}

function refusal(
	refusalReason:
		| "stale_revision"
		| "run_already_terminal"
		| "worker_owns_active_work"
		| "executor_not_startable",
	detail: string,
): RecoveryTerminalResult {
	return { phase: "refused", refusalReason, detail };
}

function failure(failureMessage: string): RecoveryTerminalResult {
	return { phase: "failed", failureMessage };
}

function describeRelease(released: {
	affinityReleased: boolean;
	lockReleased: boolean;
	graceReleased: boolean;
}): string {
	const parts = [
		released.affinityReleased ? "the session affinity" : undefined,
		released.lockReleased ? "the issue lock" : undefined,
		released.graceReleased ? "the ownership grace" : undefined,
	].filter((part): part is string => part !== undefined);
	if (parts.length === 0) return "nothing (every claim was already gone)";
	if (parts.length === 1) return parts[0] as string;
	return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/**
 * Which of the run's OWN facts moved between two reads, or `undefined` when
 * none did.
 *
 * Deliberately not a revision comparison. The revision also moves for
 * `worker_online` and `executor_state`, which a recovery CAUSES: it boots the
 * container and waits for the worker to reconnect, so the transition is
 * guaranteed rather than incidental. Every field listed here is one a
 * CONCURRENT actor would have had to change — the run being re-routed, its
 * worker publishing an activity, it being moved to a different device, its wait
 * changing — and each is a reason to stop.
 *
 * The evidence fields are excluded by omission rather than by a deny-list, so a
 * new column added to `MATERIAL_RUN_COLUMNS` is ignored here until somebody
 * decides it belongs. That is the safe default for a guard whose false
 * positives silently break the feature.
 */
function describeRunFactsChange(
	before: AgentRunInfo,
	after: AgentRunInfo,
): string | undefined {
	if (after.state !== before.state) return `lifecycle (now \`${after.state}\`)`;
	if (after.deviceId !== before.deviceId) return "device";
	if (after.lastRoutedMs !== before.lastRoutedMs) return "routed input";
	if (after.inputs.length !== before.inputs.length) return "input list";
	if (after.lastAgentActivityMs !== before.lastAgentActivityMs) {
		return "published activity";
	}
	if (after.wait?.reason !== before.wait?.reason) return "wait";
	if (after.pendingWorkCount !== before.pendingWorkCount) {
		return "pending work count";
	}
	return undefined;
}
