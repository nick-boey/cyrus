import { cyrusAttributes, type ILogger } from "cyrus-core";
import { withSpan } from "cyrus-otel-traces";
import type {
	ExecutorRegistry,
	ManagedContainerState,
} from "cyrus-router-executors";
import type { ContainerDeviceInfo, RouterStore } from "./RouterStore.js";
import {
	emitSandboxEvent,
	emitSandboxGauge,
	SANDBOX_EVENTS,
	type SandboxDestroyReason,
	type SandboxGaugeState,
	type SandboxIdleStopSkipReason,
} from "./SandboxTelemetry.js";
import { ROUTER_SPANS, routerTracer } from "./telemetry/tracing.js";

/**
 * One provider's view of the containers it manages, taken once per sweep tick.
 *
 * `states` is absent (rather than empty) for a provider with no
 * {@link ManagedContainerState} bulk seam: its listing proves the containers
 * exist but says nothing about whether they are running.
 *
 * `capturedMs` is when the listing was read. It is NOT decoration: the loop
 * that consumes it is sequential and blocks on provider control-plane calls, so
 * by the time a late row is reached this snapshot can be minutes old, and any
 * write made on the strength of it has to be able to tell that.
 */
interface ProviderListing {
	keys: Set<string>;
	states?: Map<string, ManagedContainerState>;
	capturedMs: number;
}

/**
 * A decision to abandon an idle-stop.
 *
 * `code` is the closed-set telemetry attribute, `reason` the human-readable
 * line. The numeric fields are whatever the guard that fired happened to know;
 * each is emitted as `null` when the guard could not compute it, so the shape
 * of the event never depends on which branch produced it.
 */
interface IdleStopVeto {
	code: SandboxIdleStopSkipReason;
	reason: string;
	idleForMs?: number;
	runEndedAgoMs?: number;
	claimedSessions?: number;
}

/**
 * 10 minutes — default {@link ContainerLifecycleOptions.strandedSessionGraceMs}.
 *
 * Sized against a COLD BOOT, not against the sweep interval. Between the moment
 * a session is routed and the moment its worker dials back, the container is
 * legitimately `absent`/`stopped` with affinity held and no socket — exactly the
 * shape of the invariant violation — and a first ACA boot that pulls the image
 * can take minutes. Reporting inside that window would make the signal fire on
 * every cold start, which is the fastest way to get an alert rule ignored.
 */
const DEFAULT_STRANDED_SESSION_GRACE_MS = 600_000;

/**
 * 2 minutes — default {@link ContainerLifecycleOptions.terminalSettleMs}.
 *
 * The window after a run ends in which a container is left alone so its worker
 * can finish saying so. A `session_state` frame is durably buffered on the
 * device and replayed until the router acks it, and the artifact bundle is
 * still uploading — but the process that would do either had been stopped
 * (NOR-406: the stop landed 3.8s after the completion, the frame never
 * arrived, and the affinity row plus the issue lock survived for 37 minutes
 * while Linear rendered a live session).
 *
 * Know when this can actually fire, because it is narrower than it looks. The
 * idle clock's freshest input, `last_active_ms`, is stamped by the SWEEP on
 * every pinned tick, so it is itself up to one tick-interval stale. Combined
 * with the clamp below, a veto needs the newest run stamp to beat the whole
 * idle clock by more than `idleStopMs - terminalSettleMs` — 180s at the shipped
 * defaults. On a healthy 60s tick that is unreachable, and the fresh per-row
 * read is doing all the work.
 *
 * It becomes live exactly in the regime NOR-406 happened in: 392-second ticks,
 * where a container's idle clock is minutes stale through no fault of the read
 * that fetched it, and a run can begin and end entirely between two visits to
 * the same row. That is the residue the fresh read cannot cover, which is why
 * the issue asked for both. It is bounded — a stop deferred here happens on a
 * later tick — so it can never become a permanent pin.
 */
const DEFAULT_TERMINAL_SETTLE_MS = 120_000;

/**
 * 4 hours — default {@link ContainerLifecycleOptions.sessionNoProgressMs}.
 *
 * The window a device may hold session affinity while doing nothing the router
 * can observe. NOT sized against a turn: an agent posts a thought or an action
 * for every step it takes and each is an RPC through the router, so a busy
 * session stamps its progress clock every few seconds however long the turn
 * runs. A single blocking tool call — a long build, a full test suite — is
 * minutes, two orders of magnitude under this.
 *
 * It is sized against the DELIBERATE IDLE instead, and that is the whole
 * difficulty. `AgentSessionManager.completeSession` withholds the terminal
 * signal while the runner reports pending work, so a session waiting on a
 * `ScheduleWakeup` or a cron keeps its affinity and posts nothing for the
 * duration — every input to the progress clock frozen, and from the router's
 * side indistinguishable from the strand this detector exists to find. The two
 * facts only ever meet on the DEVICE, so the router cannot currently tell them
 * apart at all (see {@link noteStranded}, which says so in what it reports).
 *
 * 4 hours clears the bounded case outright: `ScheduleWakeup` is clamped to at
 * most 1 hour, so no wakeup-pending session can reach this. It does NOT clear a
 * cron with a period above 4 hours, which will be reported and is a known,
 * accepted false-positive class until the deferral is propagated to the router.
 * And it still catches the fault: CAN-133 held its issue for 5h17m.
 *
 * Erring long is the cheap direction, but not free — this is DETECTION ONLY, so
 * a false negative costs hours of a sandbox burning 4 vCPU on an issue nobody
 * can reach, while a false positive costs a severity-1 page for a healthy
 * session, which is how a rule gets muted. That is the same failure the ticket
 * this came from warns about, inverted, so do not lower this without first
 * giving the router a way to see the deferral.
 */
const DEFAULT_SESSION_NO_PROGRESS_MS = 4 * 3_600_000;

/**
 * Why a device is stranded. Two genuinely different faults, kept as one event
 * with a dimension rather than two events: an operator's question is "which
 * sandboxes are holding an issue hostage", and the answer should not depend on
 * remembering to union two queries.
 */
export type StrandedReason = "offline_pinned" | "no_progress";

/**
 * Lets the sweep re-derive a device's affinity from the device itself rather
 * than trusting rows that only ever clear on a frame the worker may never
 * send. Injected so the sweep stays unit-testable without a gateway.
 */
export interface SessionReconciler {
	/** Reconciles the device's affinity against what it reports running.
	 *  Returns the affinity count remaining afterwards. */
	reconcile(deviceId: number): Promise<number>;
	/** True when the router currently holds a live socket for the device. */
	isOnline(deviceId: number): boolean;
}

export interface ContainerLifecycleOptions {
	store: RouterStore;
	executors: ExecutorRegistry;
	/** A running, affinity-free container idle past this many ms is stopped (Task 8 default: 15 minutes). */
	idleStopMs: number;
	/** Backstop: a container untouched past this many ms is destroyed and its device row deleted (default: 14 days). */
	staleDestroyMs: number;
	/** Affinity on an OFFLINE device older than this stops blocking the sweep.
	 *  Safe because an offline device is by definition running nothing, so there
	 *  is no live session to freeze. Default: 1 hour. */
	offlineAgeOutMs: number;
	/** How long the `stopped && sessions > 0 && !online` invariant violation must
	 *  hold before it is reported. Must comfortably exceed a cold boot, during
	 *  which those same three facts are the EXPECTED state. Default: 10 minutes. */
	strandedSessionGraceMs?: number;
	/** How long after an agent run on a device ends the container is left alone,
	 *  so the worker can flush and get its terminal frame acked. Default: 2 minutes. */
	terminalSettleMs?: number;
	/** How long a device may hold session affinity with NO observable progress —
	 *  nothing routed to it and nothing posted by its agent — before it is
	 *  reported as stranded. Independent of the container's infrastructure state:
	 *  the fault this catches looks perfectly healthy (NOR-402).
	 *  Default: {@link DEFAULT_SESSION_NO_PROGRESS_MS} (4 hours) — see that
	 *  constant for why it is that high and what must be true before lowering it.
	 *  Operator-settable as `containers.sessionNoProgressMs`. */
	sessionNoProgressMs?: number;
	/** Omitted (e.g. in tests) leaves today's behaviour: affinity is trusted as-is. */
	sessionReconciler?: SessionReconciler;
	logger: ILogger;
	/** Injectable clock (default `Date.now`) so time-based policy is deterministic in tests. */
	now?: () => number;
}

export interface SandboxObservation {
	state: SandboxGaugeState;
	observedMs: number;
}

/**
 * Periodic sweep that keeps ephemeral containers bounded in cost and disk:
 *
 *  - Idle-stop: a container with no active session affinity, untouched for
 *    `idleStopMs`, gets `stop()`ed — parked, volume retained, cheap to
 *    resume. "Untouched" means untouched by anything, INCLUDING the agent's
 *    own work: the clock resets while a session holds the device (see
 *    `markDeviceActive` at the pin below). Before that it only ever reset on
 *    something the router did, so a container that had been busy for half an
 *    hour was permanently past the threshold and survived on the pin alone —
 *    NOR-366.
 *  - Stale-destroy backstop: terminal webhooks normally destroy containers
 *    immediately. A container untouched for `staleDestroyMs` still gets
 *    `destroy()`ed (container AND volume) and its device row deleted. Safe
 *    only because of the persistence floor: the git branch and the artifact
 *    bundle survive, so a later prompt rebuilds the workspace from the
 *    restore ladder.
 *    This also bounds terminal-webhook blind spots: Linear emits no
 *    issueStatusChanged notification for self-actored closes or Duplicate.
 *  - Orphan GC: any container a provider still owns with no matching device
 *    row gets `destroy()`ed — reclaims containers left behind when a
 *    container device row is deleted without touching the provider itself:
 *    `cyrus router containers destroy <issueKey>` deletes just the
 *    bookkeeping row, or a user is removed entirely (`removeUser` cascades
 *    away every device row it owns, physical and container). Note
 *    `revokeDevice` (a physical-device swap, e.g. a new laptop) is scoped to
 *    `kind = 'device'` and never touches a user's container rows, so it does
 *    NOT feed this path — see its doc comment in `RouterStore`.
 *
 * A device with active session affinity is NEVER stopped or destroyed,
 * regardless of timestamps — this is the safety invariant that keeps work in
 * progress from being yanked out from under a live session. It is re-checked
 * immediately before the stop as well as at the gate, because the gate's
 * decision is separated from the stop by two provider round trips, and a
 * session that claims the device in between would otherwise be killed within
 * seconds of starting. Affinity that is NOT backed by progress — held against a
 * container that is not running, or held while neither the router nor the agent
 * does anything for {@link ContainerLifecycleOptions.sessionNoProgressMs} — is
 * reported by {@link noteStranded}. That is the
 * price of the invariant: the pin is unconditional, so the only defence against
 * a pin that should have been released is seeing it.
 *
 * Every value the STOP and DESTROY decisions are made from is read inside the
 * row's own iteration, never from the tick's opening snapshot. A tick is
 * sequential and blocks on provider control-plane calls, so it routinely
 * outlives its own 60s interval — one measured 392 seconds. Deciding from the
 * top-of-tick clock and row set then means deciding from data minutes old,
 * which stopped a container four seconds after a new session started on it and
 * left the issue stuck for 37 minutes (NOR-406). The snapshot is a work list;
 * `getContainerDevice` and `this.now()` inside the loop are the truth.
 *
 * The ONE deliberate exception is the provider listing, which stays tick-level
 * because one call per provider per tick is the gauge's entire cost model (see
 * {@link readProviderListings}). So the gauge state, and the `running_since_ms`
 * reconciliation derived from it, are up to one tick stale — stated here rather
 * than left implicit, because that listing is not read-only input: it drives
 * writes. {@link sampleSandbox} carries its capture time and refuses to clear a
 * running clock the listing predates, and every sample reports its own
 * `listing_age_ms` so the staleness is a number rather than an assumption.
 *
 * Executor errors are logged and skipped, never thrown: one unreachable
 * provider (e.g. a dead Docker daemon) must not stop the sweep from
 * reclaiming every other container.
 */
export class ContainerLifecycle {
	private readonly store: RouterStore;
	private readonly executors: ExecutorRegistry;
	private readonly idleStopMs: number;
	private readonly staleDestroyMs: number;
	private readonly offlineAgeOutMs: number;
	private readonly strandedSessionGraceMs: number;
	private readonly terminalSettleMs: number;
	private readonly sessionNoProgressMs: number;
	private readonly sessionReconciler: SessionReconciler | undefined;
	/** Devices already reported as pinned, so the 60s tick logs on transition only. */
	private readonly pinnedDevices = new Set<number>();
	/** Same idea for the stranded-session invariant: the EVENT is emitted every
	 *  tick (an alert rule needs a non-zero count in its window) but the
	 *  human-readable ERROR line is logged once per entry into the state.
	 *
	 *  Keyed by REASON, not merely by membership: a device that goes from
	 *  "no progress" to "stopped and offline" is a different diagnosis with a
	 *  different remedy, and a plain Set would swallow the second one. */
	private readonly strandedDevices = new Map<number, StrandedReason>();
	private readonly logger: ILogger;
	private readonly now: () => number;
	private readonly observations = new Map<number, SandboxObservation>();
	/** Non-undefined while a tick is running; see {@link sweep}. */
	private inFlight: Promise<void> | undefined;

	constructor(opts: ContainerLifecycleOptions) {
		// Assigned first: the clamp check below has to be able to report itself.
		this.logger = opts.logger;
		this.store = opts.store;
		this.executors = opts.executors;
		this.idleStopMs = opts.idleStopMs;
		this.staleDestroyMs = opts.staleDestroyMs;
		this.offlineAgeOutMs = opts.offlineAgeOutMs;
		this.strandedSessionGraceMs =
			opts.strandedSessionGraceMs ?? DEFAULT_STRANDED_SESSION_GRACE_MS;
		// Clamped to the idle window. The settle veto exists to cover the
		// SECONDS between a run ending and its worker finishing saying so; it
		// must never be the dominant term in the stop decision. Left unclamped,
		// a deployment (or a test rig) with a short `idleStopMs` would have its
		// parking policy quietly replaced by this constant.
		this.terminalSettleMs = Math.min(
			opts.terminalSettleMs ?? DEFAULT_TERMINAL_SETTLE_MS,
			opts.idleStopMs,
		);
		// Say so when the clamp actually binds. Silently reducing an operator's
		// configured value leaves them with a deployment that does not do what
		// their config file says, and no way to find that out short of reading
		// this constructor.
		if (
			opts.terminalSettleMs !== undefined &&
			opts.terminalSettleMs > opts.idleStopMs
		) {
			this.logger.warn(
				`terminalSettleMs (${opts.terminalSettleMs}) exceeds idleStopMs ` +
					`(${opts.idleStopMs}); clamped to ${this.terminalSettleMs}. The settle ` +
					`veto covers the seconds after a run ends and must never become the ` +
					`dominant term in the parking policy`,
			);
		}
		this.sessionNoProgressMs =
			opts.sessionNoProgressMs ?? DEFAULT_SESSION_NO_PROGRESS_MS;
		this.sessionReconciler = opts.sessionReconciler;
		this.now = opts.now ?? Date.now;
	}

	/** Latest provider-backed sample, collected by the existing lifecycle sweep. */
	getSandboxObservation(deviceId: number): SandboxObservation | undefined {
		return this.observations.get(deviceId);
	}

	/**
	 * Records a sample both in memory and on the device's live runs.
	 *
	 * The in-memory map is what the legacy `/runs` route reads and is gone on
	 * restart; the durable copy is what lets the change feed report a container
	 * that stopped and restarted between two operator polls. Writing both here —
	 * rather than leaving the store write to callers — is what keeps them from
	 * drifting: there is exactly one place a sample is recorded.
	 *
	 * The store call is best-effort. A sample is a monitoring fact, and letting a
	 * store failure escape would abort the sweep tick mid-loop, which costs idle
	 * parking and stale-destroy for every container after this one.
	 *
	 * Repeats are free: the store appends nothing for an unchanged state, so the
	 * once-per-tick cadence does not grow the feed.
	 *
	 * `unknown` is the exception, and it is NOT persisted. That value does not
	 * mean "the sandbox is in an unknown state" — it means the provider could not
	 * be listed this tick, which is a fact about the control plane and not about
	 * the container. Writing it through would turn one throttled ARM call into a
	 * durable `running → unknown` transition on every live run in the fleet, and
	 * the recovery into a second one, so an operator watching the feed would see
	 * a fleet-wide executor collapse that never happened. The in-memory gauge
	 * still records it — that is what the per-tick telemetry is for — and the
	 * durable sample keeps its previous state alongside the older
	 * `executorStateObservedAt`, which is precisely what lets a client age it and
	 * decide for itself. The same reasoning already guards `running_since_ms` a
	 * few lines below.
	 */
	private recordObservation(
		deviceId: number,
		state: SandboxGaugeState,
		observedMs: number,
	): void {
		this.observations.set(deviceId, { state, observedMs });
		if (state === "unknown") return;
		try {
			this.store.setRunExecutorState(deviceId, state, observedMs);
		} catch (err) {
			this.logger.warn(
				`Could not record the executor state for device ${deviceId}`,
				err,
			);
		}
	}

	/**
	 * The affinity count the sweep should actually gate on.
	 *
	 * A raw row count is not trustworthy: `routePrompted` can leave affinity for a
	 * session that never goes terminal again, which pins the device out of
	 * idle-stop permanently. So we ask the device when we can, and fall back to
	 * ageing out rows when we cannot — but only for an OFFLINE device, where there
	 * is no live session that ageing out could freeze.
	 */
	private async resolveAffinity(
		deviceId: number,
		now: number,
	): Promise<number> {
		const affinity = this.store.countSessionAffinityForDevice(deviceId);
		if (affinity === 0 || !this.sessionReconciler) return affinity;

		if (this.sessionReconciler.isOnline(deviceId)) {
			return await this.sessionReconciler.reconcile(deviceId);
		}
		return this.store
			.listSessionAffinityForDevice(deviceId)
			.filter((r) => now - r.establishedMs <= this.offlineAgeOutMs).length;
	}

	/**
	 * When this container's idle clock last moved.
	 *
	 * Three inputs, each covering a way the others go stale:
	 *  - `lastRoutedMs`: the router handed this device an event.
	 *  - `parkedAtMs`: a session on it blocked on a user answer. Without it the
	 *    clock is `lastRoutedMs`, so an agent that worked for twenty minutes and
	 *    only then asked a question would be suspended on the very next tick, the
	 *    clock having expired while it was legitimately busy.
	 *  - `lastActiveMs`: the device last held a live session (see
	 *    `RouterStore.markDeviceActive`). The only one stamped by the AGENT
	 *    working rather than by the router doing something TO the agent, and so
	 *    the only one that moves during a long session. Without it a 40-minute
	 *    session leaves the other two frozen at its start and the container reads
	 *    as idle for 35 of those minutes.
	 *
	 * Pure, and takes the row as an argument, precisely so every caller has to
	 * decide WHICH row it is passing — the whole of NOR-406 was this arithmetic
	 * being done once against a row read minutes earlier.
	 */
	private idleSince(row: ContainerDeviceInfo): number {
		return Math.max(
			row.lastRoutedMs ?? 0,
			row.parkedAtMs ?? 0,
			row.lastActiveMs ?? 0,
			row.createdMs,
		);
	}

	/**
	 * Reasons to abandon an idle-stop, re-derived from the store AS IT STANDS.
	 * Returns a `code` for the closed-set telemetry attribute plus a
	 * human-readable `reason`, or undefined to proceed with the stop.
	 *
	 * The two are separate so the call sites never have to re-parse prose to
	 * find out which guard fired — a `summarize by reason` needs the code.
	 *
	 * Called twice per candidate: once at the decision, and again immediately
	 * before `stop()` — the two are separated by `status()`, a provider round
	 * trip that has measured in the tens of seconds.
	 */
	private idleStopVeto(
		deviceId: number,
		nowMs: number,
	): IdleStopVeto | undefined {
		const fresh = this.store.getContainerDevice(deviceId);
		if (!fresh) {
			return {
				code: "row_deleted",
				reason: "its device row no longer exists",
			};
		}
		const idleForMs = nowMs - this.idleSince(fresh);
		if (idleForMs <= this.idleStopMs) {
			// The backstop the issue asks for by name: a stop is a no-op once the
			// row's own clock has moved past the value the decision was made from.
			return {
				code: "clock_moved",
				reason:
					`its idle clock moved while the sweep was deciding ` +
					`(idleForMs=${idleForMs} idleStopMs=${this.idleStopMs} ` +
					`lastRoutedMs=${fresh.lastRoutedMs ?? "none"} ` +
					`lastActiveMs=${fresh.lastActiveMs ?? "none"})`,
				idleForMs,
			};
		}
		const lastRunMs = this.store.getLastAgentRunActivityMs(deviceId);
		if (lastRunMs !== undefined && nowMs - lastRunMs <= this.terminalSettleMs) {
			return {
				code: "terminal_settle",
				reason:
					`an agent run on it ended ${nowMs - lastRunMs}ms ago and its worker ` +
					`may still be flushing (terminalSettleMs=${this.terminalSettleMs})`,
				idleForMs,
				runEndedAgoMs: nowMs - lastRunMs,
			};
		}
		return undefined;
	}

	/**
	 * The one place a skipped idle-stop is reported.
	 *
	 * Both halves matter and neither substitutes for the other: the `info` line
	 * is what a human tailing the router reads, and the event is what every
	 * saved search and alert rule in `infra/azure/bicep/modules/monitoring.bicep`
	 * can actually key on. Before this existed, all three skip paths reported
	 * only in prose, so a container the sweep declined to park produced exactly
	 * the silence NOR-406 was about — indistinguishable, from a dashboard, from
	 * a sweep that had stalled.
	 */
	private noteIdleStopSkipped(
		row: ContainerDeviceInfo,
		veto: IdleStopVeto,
	): void {
		emitSandboxEvent(
			this.logger,
			SANDBOX_EVENTS.idleStopSkipped,
			{
				issueKey: row.issueKey,
				deviceId: row.deviceId,
				provider: row.provider,
			},
			{
				reason: veto.code,
				idle_for_ms: veto.idleForMs ?? null,
				idle_stop_ms: this.idleStopMs,
				terminal_settle_ms: this.terminalSettleMs,
				run_ended_ago_ms: veto.runEndedAgoMs ?? null,
				claimed_sessions: veto.claimedSessions ?? null,
			},
		);
		this.logger.info(
			`Skipped idle-stop of ${row.issueKey} (device=${row.deviceId}): ` +
				veto.reason,
		);
	}

	private notePinned(deviceId: number, issueKey: string): void {
		if (this.pinnedDevices.has(deviceId)) return;
		this.pinnedDevices.add(deviceId);
		const held = this.store
			.listSessionAffinityForDevice(deviceId)
			.map((r) => r.sessionId)
			.join(", ");
		// Logged ABOVE the gate on purpose. Until now this path returned before the
		// idle-stop diagnostic, so a device pinned out of idle-stop was completely
		// silent — diagnosing PAR-146 meant downloading and querying the blob backup.
		this.logger.info(
			`Container for ${issueKey} (device=${deviceId}) is pinned out of idle-stop ` +
				`by session affinity: ${held || "none"}`,
		);
	}

	private noteUnpinned(deviceId: number): void {
		if (!this.pinnedDevices.delete(deviceId)) return;
		this.logger.info(
			`Container device ${deviceId} is no longer pinned by session affinity`,
		);
	}

	/**
	 * Report a device that holds live session affinity but is not making
	 * progress on it. Two shapes, one event, distinguished by `reason`:
	 *
	 * **`offline_pinned`** — affinity held for a container that is NOT running
	 * and whose worker is NOT connected. Structurally impossible: no lifecycle
	 * transition fires, the gauge samples it as three unremarkable fields, and
	 * Linear goes on rendering an in-progress agent session for as long as it
	 * lasts, which is why NOR-366's five killed sessions sat unnoticed for nine
	 * hours.
	 *
	 * **`no_progress`** — affinity held while nothing is routed TO the device and
	 * the device posts nothing. This one looks perfectly healthy, and that is the
	 * point: CAN-133 read `state=running online=true sessions=1` once a minute for
	 * 5h17m while its issue was unreachable, and the old detector's `notRunning &&
	 * !online` gate excluded it BY DEFINITION — the severity-1 rule named after
	 * this failure could not fire for it (NOR-402). "Looks healthy" cannot be the
	 * exclusion when a healthy-looking container is what the fault produces.
	 *
	 * The `no_progress` clock is `max(lastProgressMs, lastRoutedMs, parkedAtMs,
	 * createdMs)` and the omissions matter more than the inclusions:
	 *  - NOT `lastSeenMs`: that is the heartbeat, which a wedged worker sends
	 *    just as faithfully as a working one.
	 *  - NOT `lastActiveMs`: the sweep stamps it on every tick a device is
	 *    pinned, so the detector would reset its own clock and never fire.
	 * `lastProgressMs` is the only clock moved by the AGENT (an `rpc_request`
	 * carrying an activity it posted) rather than by something the router did.
	 *
	 * Detection only, both shapes. Neither boots a container nor releases
	 * affinity: `offline_pinned` also describes a container legitimately parked
	 * while a leaked affinity row (PAR-146's shape) outlives its session, and
	 * auto-resuming those would undo idle-stop for exactly the sandboxes
	 * idle-stop exists for. Note that `no_progress`'s recovery is NOT "prompt the
	 * thread again" — the whole of NOR-402 is that a top-level comment on such an
	 * issue is rejected at the issue lock — so its remedy line says so.
	 *
	 * ── WHAT `no_progress` CANNOT DISTINGUISH, AND WHY IT SAYS SO ──
	 * A session held open by pending work (`ScheduleWakeup`, a cron, a background
	 * task) keeps its affinity and posts nothing while it waits, so it presents
	 * IDENTICALLY to a strand. The router has no way to tell: the deferral is
	 * decided in `AgentSessionManager.completeSession` and recorded only in the
	 * device's own `session.terminal_deferred` event, which reaches Log Analytics
	 * but never the router's store. So this reports both, and its message names
	 * both rather than asserting the diagnosis it cannot make — and in particular
	 * does NOT advise `cyrus router unlock`, which on a waiting session would
	 * strip the lock from a run that is about to resume and manufacture the
	 * lock-without-affinity leak. `sessionNoProgressMs` is then set high enough to
	 * clear every bounded wakeup (see its default). The real fix is to propagate
	 * the deferral to the router so this branch can exclude it; until then the
	 * honest thing is to report the ambiguity, not to hide it behind a threshold.
	 *
	 * ── WHAT NEITHER SHAPE COVERS ──
	 * Both are reached only from the sweep's `affinity > 0` gate, but what makes
	 * an issue unreachable is the ISSUE LOCK, and the two deliberately diverge: a
	 * `parked` session releases affinity and RETAINS its lock. An elicitation
	 * nobody answers therefore locks an issue with no affinity, is invisible to
	 * this method entirely, and shows up only in `RouterStore.listSessions`'
	 * orphan-lock query behind `cyrus router sessions list`. That class has no
	 * event and no alert. Do not read this detector as covering every locked
	 * issue.
	 *
	 * Exclusions:
	 *  - `unknown` state (`offline_pinned` only): a provider we could not read
	 *    this tick says nothing about whether it is running. Irrelevant to
	 *    `no_progress`, which is a clock, not a state.
	 *  - within the relevant grace window: a cold boot presents exactly like
	 *    `offline_pinned` and is the expected path, not a fault.
	 *  - a pending terminal teardown: that container is meant to be going away,
	 *    and TerminalTeardown's own grace deadline is what covers it.
	 */
	private noteStranded(
		row: ContainerDeviceInfo,
		state: SandboxGaugeState,
		affinity: number,
		now: number,
	): void {
		if (this.store.getPendingTeardown(row.issueKey) !== undefined) {
			this.strandedDevices.delete(row.deviceId);
			return;
		}
		const notRunning = state === "stopped" || state === "absent";
		const online = this.sessionReconciler?.isOnline(row.deviceId) ?? false;
		const lastContact = Math.max(
			row.lastRoutedMs ?? 0,
			row.lastSeenMs ?? 0,
			row.createdMs,
		);
		const strandedForMs = now - lastContact;
		const offlinePinned =
			notRunning && !online && strandedForMs > this.strandedSessionGraceMs;

		const lastProgress = Math.max(
			row.lastProgressMs ?? 0,
			row.lastRoutedMs ?? 0,
			row.parkedAtMs ?? 0,
			row.createdMs,
		);
		const noProgressForMs = now - lastProgress;
		const noProgress = noProgressForMs > this.sessionNoProgressMs;

		// `offline_pinned` wins when both hold: it is the more specific diagnosis
		// and the one with a known remedy, and a device should produce one event
		// per tick rather than two views of the same stall.
		const reason: StrandedReason | undefined = offlinePinned
			? "offline_pinned"
			: noProgress
				? "no_progress"
				: undefined;
		if (reason === undefined) {
			this.strandedDevices.delete(row.deviceId);
			return;
		}

		emitSandboxEvent(
			this.logger,
			SANDBOX_EVENTS.strandedSession,
			{
				issueKey: row.issueKey,
				deviceId: row.deviceId,
				provider: row.provider,
			},
			{
				reason,
				state,
				online,
				sessions: affinity,
				stranded_for_ms: strandedForMs,
				stranded_grace_ms: this.strandedSessionGraceMs,
				no_progress_for_ms: noProgressForMs,
				no_progress_ms: this.sessionNoProgressMs,
				age_ms: now - row.createdMs,
			},
		);
		if (this.strandedDevices.get(row.deviceId) === reason) return;
		this.strandedDevices.set(row.deviceId, reason);
		this.logger.error(
			reason === "offline_pinned"
				? `Container for ${row.issueKey} (device=${row.deviceId}) is ${state} and offline ` +
						`but still holds ${affinity} session affinity row(s): Linear is showing a live ` +
						`agent session against a sandbox that cannot make progress. Prompt the thread ` +
						`again to cold-boot it. (strandedForMs=${strandedForMs} state=${state})`
				: `Container for ${row.issueKey} (device=${row.deviceId}) holds ${affinity} session ` +
						`affinity row(s) but has made no observable progress for ${noProgressForMs}ms ` +
						`(threshold ${this.sessionNoProgressMs}ms, state=${state} online=${online}). ` +
						`Either its session never reached a terminal state and the issue is now locked ` +
						`to a session that has stopped working, or it is deliberately idle waiting on a ` +
						`scheduled wakeup — the router cannot tell these apart, because the deferral is ` +
						`only ever recorded on the device. Check for a 'session.terminal_deferred' ` +
						`record for this issue with no matching 'session.terminal_signalled': that is ` +
						`what says which, and what it is waiting on. Either way a new top-level comment ` +
						`will be REJECTED at the issue lock, so reply inside the existing session's ` +
						`thread. Only once you have confirmed it is NOT waiting is \`cyrus router ` +
						`unlock\` the right move — unlocking a session that is about to resume strands ` +
						`the lock instead of freeing it.`,
		);
	}

	/**
	 * One bulk state read per provider, for the whole tick.
	 *
	 * This is the telemetry gauge's entire provider cost: ONE call per provider
	 * per 60s, not one per sandbox. At an ARM request per sandbox per minute a
	 * per-row `status()` fan-out would quickly become the most expensive thing
	 * the router does, and would throttle exactly when the fleet is largest —
	 * i.e. when the numbers matter most.
	 *
	 * The result doubles as the orphan-GC listing, so adding the gauge costs
	 * zero extra provider calls: {@link listStates} returns a superset of what
	 * `listManaged()` did.
	 *
	 * A provider that fails to answer yields `undefined` rather than an empty
	 * map. The distinction is load-bearing: an empty map means "this provider
	 * manages nothing", which would make every one of its device rows look like
	 * an orphan; `undefined` means "we could not tell", and the orphan sweep
	 * skips the provider entirely for this tick.
	 */
	private async readProviderListings(): Promise<
		Map<string, ProviderListing | undefined>
	> {
		const byProvider = new Map<string, ProviderListing | undefined>();
		for (const [provider, executor] of this.executors) {
			try {
				if (executor.listStates) {
					const states = await executor.listStates();
					byProvider.set(provider, {
						keys: new Set(states.map((s) => s.issueKey)),
						states: new Map(states.map((s) => [s.issueKey, s])),
						capturedMs: this.now(),
					});
				} else {
					// A provider predating the bulk-state seam. Its listing proves
					// existence and nothing more, so `states` stays absent and the
					// gauge reports `unknown` rather than guessing at running.
					byProvider.set(provider, {
						keys: new Set(await executor.listManaged()),
						capturedMs: this.now(),
					});
				}
			} catch (err) {
				this.logger.error(
					`Could not list containers for provider ${provider}; skipping its orphan GC and reporting its sandboxes as state=unknown this tick`,
					err,
				);
				byProvider.set(provider, undefined);
			}
		}
		return byProvider;
	}

	/**
	 * Emit the per-sandbox gauge sample and keep `running_since_ms` honest.
	 *
	 * Reconciliation lives here rather than only at the boot/stop call sites
	 * because those cover the transitions the ROUTER drives. A sandbox can also
	 * change state underneath us — ACA replaced it inside `ensureRunning`, an
	 * operator stopped it by hand, the row predates the column's migration — and
	 * without a periodic reconcile against real provider state the uptime the
	 * 6-hour alert reads would drift and never self-correct.
	 *
	 * Skipped entirely when the state is `unknown`: a provider we could not read
	 * must not be allowed to clear a running clock, or one throttled ARM call
	 * would silently reset every uptime in the fleet.
	 *
	 * The SAME principle bounds the clear when the listing is merely OLD. Unlike
	 * every other input to this loop, the listing is deliberately tick-level —
	 * one call per provider per tick is the gauge's whole cost model, and a
	 * per-row `status()` fan-out would throttle exactly when the fleet is
	 * largest. So it can be minutes stale by the time a late row is reached, and
	 * a container that was absent when the listing was taken and has been booted
	 * since would otherwise have the `running_since_ms` its boot just stamped
	 * cleared out from under it. That column is the sole input to the 6-hour
	 * long-running-sandbox alert, so the clear would silently reset the uptime of
	 * precisely the sandboxes that were busy through a slow tick. A clock stamped
	 * AFTER the listing was captured is a fact the listing cannot speak to; leave
	 * it alone and let the next tick's fresh listing settle it.
	 */
	private sampleSandbox(
		row: ContainerDeviceInfo,
		listing: ProviderListing | undefined,
		affinity: number,
		now: number,
	): SandboxGaugeState {
		const state = listing?.states?.get(row.issueKey);
		const gaugeState: SandboxGaugeState = !listing?.states
			? "unknown"
			: (state?.status ?? "absent");
		this.recordObservation(row.deviceId, gaugeState, now);

		let runningSinceMs = row.runningSinceMs;
		if (gaugeState === "running" && runningSinceMs === undefined) {
			if (this.store.markDeviceRunning(row.deviceId, now)) runningSinceMs = now;
		} else if (
			(gaugeState === "stopped" || gaugeState === "absent") &&
			runningSinceMs !== undefined &&
			// Only when the listing is actually newer than the clock it would erase.
			listing !== undefined &&
			runningSinceMs <= listing.capturedMs
		) {
			this.store.clearDeviceRunningSince(row.deviceId);
			runningSinceMs = undefined;
		}

		emitSandboxGauge(this.logger, {
			issueKey: row.issueKey,
			deviceId: row.deviceId,
			provider: row.provider,
			state: gaugeState,
			sessions: affinity,
			online: this.sessionReconciler?.isOnline(row.deviceId) ?? false,
			ageMs: now - row.createdMs,
			...(runningSinceMs !== undefined
				? { uptimeMs: now - runningSinceMs }
				: {}),
			...(row.lastSeenMs !== undefined
				? { lastSeenAgeMs: now - row.lastSeenMs }
				: {}),
			...(row.parkedAtMs !== undefined
				? { parkedForMs: now - row.parkedAtMs }
				: {}),
			...(row.lastRoutedMs !== undefined
				? { lastRoutedAgeMs: now - row.lastRoutedMs }
				: {}),
			...(listing !== undefined
				? { listingAgeMs: now - listing.capturedMs }
				: {}),
		});
		return gaugeState;
	}

	/**
	 * One tick. Serialised against itself: a tick that is still running makes the
	 * next one a no-op rather than a second concurrent pass.
	 *
	 * RouterServer fires this on a 60s interval, but a tick can easily outlive
	 * that: the loop below is sequential and `executor.stop()` blocks on the
	 * provider's per-issue lock for as long as its slowest control-plane call —
	 * an ACA snapshot of a large, long-lived sandbox measured 3m52s against a
	 * 120s client deadline. Overlapping ticks then queue ANOTHER stop() behind
	 * that same per-issue lock every 60s, so the queue grows faster than it
	 * drains, and `TerminalTeardown`'s destroy() — which takes the very same lock
	 * — is starved behind it indefinitely.
	 *
	 * That is exactly how WAG-10 (2026-08-06) kept a 4 vCPU / 8 GiB sandbox
	 * running for 1.5h after its issue went Done: its worker replayed the
	 * teardown callback 144 times, each POST hanging until the 600s ingress
	 * timeout, while the destroy never reached the front of the queue. The same
	 * stalled sweep also stopped reclaiming every OTHER container behind it.
	 */
	async sweep(): Promise<void> {
		if (this.inFlight) {
			this.logger.warn(
				"Container lifecycle sweep is still running; skipping this tick. " +
					"A tick that outlives its interval means a provider call is slow — " +
					"overlapping ticks would starve terminal teardown behind the same per-issue lock",
			);
			return;
		}
		// The sweep gets its own ROOT span rather than joining anything: it is
		// fired by a bare 60s `setInterval`, so it has no caller and no inbound
		// request to inherit from. It needs one because the ACA dependency spans
		// it produces — one per provider listing, plus one per stop/destroy —
		// would otherwise each be a root of their own, and the tick that made
		// them would be unreconstructable.
		//
		// This is also where the sampling ratio bites hardest: unlike a webhook,
		// this fires on a timer whether or not anyone is working. See
		// `docs/adr/0004-parent-based-head-sampling-for-traces.md`.
		this.inFlight = withSpan(
			routerTracer(),
			ROUTER_SPANS.sandboxSweep,
			{},
			() => this.sweepOnce(),
		).finally(() => {
			this.inFlight = undefined;
		});
		return this.inFlight;
	}

	private async sweepOnce(): Promise<void> {
		const now = this.now();
		let rows: ContainerDeviceInfo[];
		try {
			rows = this.store.listContainerDevices();
		} catch (err) {
			// A store-level failure here (e.g. SQLITE_BUSY) must not reject the
			// whole sweep: RouterServer's sweep interval fires this every 60s, and
			// an uncaught rejection there is an unhandled rejection that (Node
			// >=15 default) crashes the router process for every teammate, not
			// just container-executor users. Log and degrade to a no-op tick; the
			// next interval retries.
			this.logger.error(
				"Lifecycle sweep failed to list container devices; skipping this tick",
				err,
			);
			return;
		}
		const knownKeys = new Set(rows.map((r) => r.issueKey));

		// Read every provider ONCE, up front, and reuse the answer for both the
		// gauge and the orphan GC below. Listing before the per-row loop (rather
		// than after it, as the orphan pass used to) also narrows the TOCTOU
		// window it guards against: a container created while the loop runs can
		// no longer appear in a listing taken before the loop started.
		const listings = await this.readProviderListings();
		const counts = { running: 0, stopped: 0, absent: 0, unknown: 0 };
		let pinned = 0;
		// Sandboxes that qualified for parking and were spared anyway. A
		// fleet-level number, so a deferral wave is visible on a dashboard without
		// anyone first suspecting a particular issue and opening its timeline.
		let deferred = 0;

		for (const snapshot of rows) {
			const executor = this.executors.get(snapshot.provider);
			if (!executor) continue;
			try {
				// Re-read the row and re-take the clock PER ROW, not once per tick.
				//
				// `rows` and `now` above are a tick-level snapshot, and this loop is
				// sequential and blocks on provider control-plane calls: a tick that
				// began at 07:45:22 reached one row at 07:51:54 and decided from
				// 07:45:22's timestamps, so the session routed to that container at
				// 07:51:39 was invisible to every check below — including NOR-366's
				// mid-sweep guard, which compares against a snapshot taken after the
				// claim and therefore saw nothing new (NOR-406). The tick snapshot is
				// now only a WORK LIST; every value a decision is made from is read
				// here. Two indexed point reads per row against minutes of provider
				// latency.
				const rowNow = this.now();
				const row = this.store.getContainerDevice(snapshot.deviceId);
				// Gone since the snapshot — a terminal teardown destroyed it mid-tick.
				// Acting on it now would be acting on a container that no longer
				// exists, or worse, on its successor.
				//
				// Skipping the DECISIONS is the point; skipping the BOOKKEEPING is
				// not. The row still has to leave this object's latches, or a device
				// torn down while pinned never logs its unpin transition and sits in
				// `pinnedDevices` for the life of the process. It also still has to be
				// counted, because the rollup below reports `sandboxes: rows.length`
				// and a bucket that no longer sums to it is a dashboard that silently
				// under-reports on exactly the ticks where something was destroyed.
				// No gauge sample: there is no sandbox left to sample.
				if (!row) {
					this.noteUnpinned(snapshot.deviceId);
					this.strandedDevices.delete(snapshot.deviceId);
					this.observations.delete(snapshot.deviceId);
					counts.absent += 1;
					continue;
				}
				// Snapshot of the sessions the affinity gate below is about to make
				// its decision from, so the pre-stop re-check can tell a session that
				// claimed this device DURING the decision from one the gate already
				// saw and deliberately discounted (a leaked row the reconciler
				// reclaimed, or an offline device's aged-out row). Same
				// snapshot-then-re-check idiom as `knownKeys` in the orphan pass.
				const knownSessions = new Set(
					this.store
						.listSessionAffinityForDevice(row.deviceId)
						.map((r) => r.sessionId),
				);
				const affinity = await this.resolveAffinity(row.deviceId, rowNow);
				// Sampled for EVERY row, before the pinned early-return below.
				// The pinned rows are the ones the operational questions are
				// actually about — a sandbox held by session affinity is one that
				// is burning 4 vCPU right now — so skipping them would leave the
				// gauge counting only idle sandboxes.
				const state = this.sampleSandbox(
					row,
					listings.get(row.provider),
					affinity,
					rowNow,
				);
				counts[state] += 1;
				if (affinity > 0) {
					pinned += 1;
					// THE idle-clock reset. The router stamps `last_routed_ms` when it
					// hands the device an event and nothing after that, so an agent
					// working for forty minutes without a new prompt leaves every other
					// input to the clock frozen at the session's start — the container
					// is past `idleStopMs` the whole time it is busy and survives only
					// because this branch skips it. That made the pin the only thing
					// standing between a busy sandbox and a stop, and the instant it
					// lapsed during an implement->review handoff the already-expired
					// clock fired (NOR-366). Stamping here means a container that was
					// busy on the previous tick gets a FULL idle window once its
					// session ends, which is what the threshold was always meant to be.
					this.store.markDeviceActive(row.deviceId, rowNow);
					this.notePinned(row.deviceId, row.issueKey);
					this.noteStranded(row, state, affinity, rowNow);
					continue;
				}
				this.noteUnpinned(row.deviceId);
				this.strandedDevices.delete(row.deviceId);
				const lastTouch = Math.max(
					row.lastRoutedMs ?? 0,
					row.lastSeenMs ?? 0,
					row.createdMs,
				);
				if (rowNow - lastTouch > this.staleDestroyMs) {
					await executor.destroy(row.issueKey);
					this.recordObservation(row.deviceId, "absent", this.now());
					this.store.deleteContainerDevice(row.deviceId);
					emitSandboxEvent(
						this.logger,
						SANDBOX_EVENTS.destroyed,
						{
							issueKey: row.issueKey,
							deviceId: row.deviceId,
							provider: row.provider,
						},
						{
							reason: "stale" satisfies SandboxDestroyReason,
							stale_for_ms: rowNow - lastTouch,
							stale_destroy_ms: this.staleDestroyMs,
							age_ms: rowNow - row.createdMs,
						},
					);
					this.logger.info(
						`Destroyed stale container for ${row.issueKey} ` +
							`(device=${row.deviceId} affinity=${affinity} ` +
							`lastRoutedMs=${row.lastRoutedMs ?? "none"} ` +
							`lastSeenMs=${row.lastSeenMs ?? "none"} ` +
							`createdMs=${row.createdMs} ` +
							`staleForMs=${rowNow - lastTouch} staleDestroyMs=${this.staleDestroyMs})`,
					);
					continue;
				}
				// See `idleSince` for what feeds this clock. `row` is the row as it
				// stands right now, not as the tick found it — that distinction IS
				// the fix for NOR-406.
				const idleForMs = rowNow - this.idleSince(row);
				if (idleForMs > this.idleStopMs) {
					// The settle veto, before the provider round trip rather than after
					// it: a container whose run ended moments ago is not going to become
					// a better stop candidate during a `status()` call, and asking ARM
					// about it is a request we would rather not spend.
					const settleVeto = this.idleStopVeto(row.deviceId, rowNow);
					if (settleVeto) {
						this.noteIdleStopSkipped(row, settleVeto);
						deferred += 1;
						continue;
					}
					// `status` is read only once the clock already qualifies, so the
					// logged value is the same one the decision used.
					const status = await executor.status(row.issueKey);
					// Re-read affinity immediately before the stop. The gate above ran
					// before two awaits (`resolveAffinity`'s query to the device, then
					// `status()`), and a session that claimed this device during them is
					// invisible to it — a window of seconds that the implement->review
					// handoff lands in often enough to have killed 5 of 9 sessions in
					// one day (NOR-366). Same TOCTOU shape, and same remedy, as the
					// orphan-GC re-check below.
					//
					// Only sessions MISSING from the snapshot count. A bare "any
					// affinity at all" re-check would look more defensive and would in
					// fact break the two paths that reach here with rows still in the
					// table on purpose: a leaked row the reconciler declined to trust,
					// and an offline device's row aged out past `offlineAgeOutMs`. Both
					// are decisions the gate already made, and re-litigating them here
					// would restore the permanent pin those mechanisms exist to break.
					const claimedMidSweep = this.store
						.listSessionAffinityForDevice(row.deviceId)
						.filter((r) => !knownSessions.has(r.sessionId));
					if (claimedMidSweep.length > 0) {
						// Activity, and the reason this device must keep its idle window:
						// the stop is being abandoned precisely because work arrived.
						this.store.markDeviceActive(row.deviceId, rowNow);
						this.noteIdleStopSkipped(row, {
							code: "claimed_mid_sweep",
							reason:
								`session(s) ${claimedMidSweep.map((r) => r.sessionId).join(", ")} ` +
								`claimed it while the sweep was deciding`,
							idleForMs,
							claimedSessions: claimedMidSweep.length,
						});
						deferred += 1;
						continue;
					}
					// The same veto again, now against the clock as it stands after
					// `status()`. `claimedMidSweep` above catches only a session that
					// took AFFINITY during the round trip; a session can also be routed
					// (moving `lastRoutedMs`) or complete (arming the settle window)
					// without ever adding a row this loop has not already seen.
					const preStopVeto = this.idleStopVeto(row.deviceId, this.now());
					if (preStopVeto) {
						this.noteIdleStopSkipped(row, preStopVeto);
						deferred += 1;
						continue;
					}
					if (status === "running") {
						await executor.stop(row.issueKey);
						this.recordObservation(row.deviceId, "stopped", this.now());
						// The container is no longer running, so its continuous-uptime
						// clock stops here. Read before clearing so the event can report
						// how long the run it ends actually lasted — the single most
						// useful number for tuning `idleStopMs`.
						const uptimeMs = row.runningSinceMs
							? rowNow - row.runningSinceMs
							: undefined;
						this.store.clearDeviceRunningSince(row.deviceId);
						emitSandboxEvent(
							this.logger,
							SANDBOX_EVENTS.idleStopped,
							{
								issueKey: row.issueKey,
								deviceId: row.deviceId,
								provider: row.provider,
							},
							{
								idle_for_ms: idleForMs,
								idle_stop_ms: this.idleStopMs,
								uptime_ms: uptimeMs ?? null,
								age_ms: rowNow - row.createdMs,
							},
						);
						// Every input behind the decision, so a stop that looks wrong
						// (PAR-166: a live session parked mid-task) can be diagnosed
						// from this line alone rather than reconstructed from a store
						// that has since moved on.
						this.logger.info(
							`Idle-stopped container for ${row.issueKey} ` +
								`(device=${row.deviceId} affinity=${affinity} ` +
								`lastRoutedMs=${row.lastRoutedMs ?? "none"} ` +
								`parkedAtMs=${row.parkedAtMs ?? "none"} ` +
								`createdMs=${row.createdMs} ` +
								`idleForMs=${idleForMs} idleStopMs=${this.idleStopMs} ` +
								`status=${status})`,
						);
					}
				}
			} catch (err) {
				this.logger.error(
					`Lifecycle sweep failed for ${snapshot.issueKey}`,
					err,
				);
			}
		}

		for (const [provider, executor] of this.executors) {
			const listing = listings.get(provider);
			// `undefined` means the listing FAILED, not that the provider manages
			// nothing. Treating it as empty would be harmless here (nothing to
			// iterate) but the distinction is why `readProviderListings` returns
			// undefined rather than an empty set — see its doc comment.
			if (!listing) continue;
			try {
				for (const key of listing.keys) {
					// `knownKeys` is a snapshot taken before this loop's `await`s —
					// it's a cheap pre-filter only, never the final say. A route
					// landing mid-sweep (ContainerTargetService.ensureDevice writing
					// the device row + boot() starting ensureRunning concurrently)
					// can make a brand-new, still-booting container visible to the
					// provider listing before it existed in that snapshot, which
					// would otherwise misidentify it as an orphan and destroy() it —
					// TOCTOU. Re-check the store immediately before each destroy()
					// so a device row created after the snapshot still saves the
					// container.
					if (
						!knownKeys.has(key) &&
						!this.store.getContainerDeviceForIssue(key)
					) {
						await executor.destroy(key);
						emitSandboxEvent(
							this.logger,
							SANDBOX_EVENTS.destroyed,
							{ issueKey: key, provider },
							{ reason: "orphan" satisfies SandboxDestroyReason },
						);
						this.logger.info(
							`Destroyed orphan ${provider} container for ${key}`,
						);
					}
				}
			} catch (err) {
				this.logger.error(
					`Orphan GC failed for provider ${provider}; orphaned containers may keep accruing cost`,
					err,
				);
			}
		}

		// The rollup an operator actually asks for first ("how many sandboxes are
		// open right now?"). Emitted even when zero, so a flat line is
		// distinguishable from a router that stopped sweeping.
		this.logger.event(
			SANDBOX_EVENTS.sweepCompleted,
			cyrusAttributes({
				sandboxes: rows.length,
				running: counts.running,
				stopped: counts.stopped,
				absent: counts.absent,
				unknown: counts.unknown,
				pinned,
				deferred,
				duration_ms: this.now() - now,
			}),
		);
	}
}
