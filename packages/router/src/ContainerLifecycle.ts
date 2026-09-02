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
} from "./SandboxTelemetry.js";
import { ROUTER_SPANS, routerTracer } from "./telemetry/tracing.js";

/**
 * One provider's view of the containers it manages, taken once per sweep tick.
 *
 * `states` is absent (rather than empty) for a provider with no
 * {@link ManagedContainerState} bulk seam: its listing proves the containers
 * exist but says nothing about whether they are running.
 */
interface ProviderListing {
	keys: Set<string>;
	states?: Map<string, ManagedContainerState>;
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
 * seconds of starting. The converse — affinity held against a container that
 * is NOT running — is reported by {@link noteStranded}; it is the only state
 * here that should be impossible.
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
	private readonly sessionReconciler: SessionReconciler | undefined;
	/** Devices already reported as pinned, so the 60s tick logs on transition only. */
	private readonly pinnedDevices = new Set<number>();
	/** Same idea for the stranded-session invariant: the EVENT is emitted every
	 *  tick (an alert rule needs a non-zero count in its window) but the
	 *  human-readable ERROR line is logged once per entry into the state. */
	private readonly strandedDevices = new Set<number>();
	private readonly logger: ILogger;
	private readonly now: () => number;
	private readonly observations = new Map<number, SandboxObservation>();
	/** Non-undefined while a tick is running; see {@link sweep}. */
	private inFlight: Promise<void> | undefined;

	constructor(opts: ContainerLifecycleOptions) {
		this.store = opts.store;
		this.executors = opts.executors;
		this.idleStopMs = opts.idleStopMs;
		this.staleDestroyMs = opts.staleDestroyMs;
		this.offlineAgeOutMs = opts.offlineAgeOutMs;
		this.strandedSessionGraceMs =
			opts.strandedSessionGraceMs ?? DEFAULT_STRANDED_SESSION_GRACE_MS;
		this.sessionReconciler = opts.sessionReconciler;
		this.logger = opts.logger;
		this.now = opts.now ?? Date.now;
	}

	/** Latest provider-backed sample, collected by the existing lifecycle sweep. */
	getSandboxObservation(deviceId: number): SandboxObservation | undefined {
		return this.observations.get(deviceId);
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
	 * Report the one sandbox state that is not supposed to be reachable: the
	 * router holds live session affinity for a container that is NOT running and
	 * whose worker is NOT connected.
	 *
	 * Nothing else surfaces it. The gauge samples it as three unremarkable
	 * fields, no lifecycle transition fires, and Linear goes on rendering an
	 * in-progress agent session for as long as it lasts — which is why NOR-366's
	 * five killed sessions sat unnoticed for nine hours. The whole value of this
	 * method is turning that silence into one queryable event.
	 *
	 * Detection only. It deliberately does NOT boot the container back up: the
	 * same three facts also describe a container legitimately parked while a
	 * leaked affinity row (PAR-146's shape) outlives the session that made it,
	 * and auto-resuming those would undo idle-stop for exactly the sandboxes
	 * idle-stop exists for. Recovery stays a prompt away — cold-booting from a
	 * new comment is reliable — while the fixes above stop the state being
	 * produced in the first place.
	 *
	 * Three exclusions keep this specific enough to alert on:
	 *  - `unknown` state: a provider we could not read this tick says nothing.
	 *  - within {@link strandedSessionGraceMs} of the last route or heartbeat: a
	 *    cold boot presents identically and is the expected path, not a fault.
	 *  - a pending terminal teardown: that container is meant to be going away,
	 *    and TerminalTeardown's own grace deadline is what covers it.
	 */
	private noteStranded(
		row: ContainerDeviceInfo,
		state: SandboxGaugeState,
		affinity: number,
		now: number,
	): void {
		const notRunning = state === "stopped" || state === "absent";
		const online = this.sessionReconciler?.isOnline(row.deviceId) ?? false;
		const lastContact = Math.max(
			row.lastRoutedMs ?? 0,
			row.lastSeenMs ?? 0,
			row.createdMs,
		);
		const strandedForMs = now - lastContact;
		if (
			!notRunning ||
			online ||
			strandedForMs <= this.strandedSessionGraceMs ||
			this.store.getPendingTeardown(row.issueKey) !== undefined
		) {
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
				state,
				sessions: affinity,
				stranded_for_ms: strandedForMs,
				stranded_grace_ms: this.strandedSessionGraceMs,
				age_ms: now - row.createdMs,
			},
		);
		if (this.strandedDevices.has(row.deviceId)) return;
		this.strandedDevices.add(row.deviceId);
		this.logger.error(
			`Container for ${row.issueKey} (device=${row.deviceId}) is ${state} and offline ` +
				`but still holds ${affinity} session affinity row(s): Linear is showing a live ` +
				`agent session against a sandbox that cannot make progress. Prompt the thread ` +
				`again to cold-boot it. (strandedForMs=${strandedForMs} state=${state})`,
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
					});
				} else {
					// A provider predating the bulk-state seam. Its listing proves
					// existence and nothing more, so `states` stays absent and the
					// gauge reports `unknown` rather than guessing at running.
					byProvider.set(provider, {
						keys: new Set(await executor.listManaged()),
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
		this.observations.set(row.deviceId, {
			state: gaugeState,
			observedMs: now,
		});

		let runningSinceMs = row.runningSinceMs;
		if (gaugeState === "running" && runningSinceMs === undefined) {
			if (this.store.markDeviceRunning(row.deviceId, now)) runningSinceMs = now;
		} else if (
			(gaugeState === "stopped" || gaugeState === "absent") &&
			runningSinceMs !== undefined
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

		for (const row of rows) {
			const executor = this.executors.get(row.provider);
			if (!executor) continue;
			try {
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
				const affinity = await this.resolveAffinity(row.deviceId, now);
				// Sampled for EVERY row, before the pinned early-return below.
				// The pinned rows are the ones the operational questions are
				// actually about — a sandbox held by session affinity is one that
				// is burning 4 vCPU right now — so skipping them would leave the
				// gauge counting only idle sandboxes.
				const state = this.sampleSandbox(
					row,
					listings.get(row.provider),
					affinity,
					now,
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
					this.store.markDeviceActive(row.deviceId, now);
					this.notePinned(row.deviceId, row.issueKey);
					this.noteStranded(row, state, affinity, now);
					continue;
				}
				this.noteUnpinned(row.deviceId);
				this.strandedDevices.delete(row.deviceId);
				const lastTouch = Math.max(
					row.lastRoutedMs ?? 0,
					row.lastSeenMs ?? 0,
					row.createdMs,
				);
				if (now - lastTouch > this.staleDestroyMs) {
					await executor.destroy(row.issueKey);
					this.observations.set(row.deviceId, {
						state: "absent",
						observedMs: this.now(),
					});
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
							stale_for_ms: now - lastTouch,
							stale_destroy_ms: this.staleDestroyMs,
							age_ms: now - row.createdMs,
						},
					);
					this.logger.info(
						`Destroyed stale container for ${row.issueKey} ` +
							`(device=${row.deviceId} affinity=${affinity} ` +
							`lastRoutedMs=${row.lastRoutedMs ?? "none"} ` +
							`lastSeenMs=${row.lastSeenMs ?? "none"} ` +
							`createdMs=${row.createdMs} ` +
							`staleForMs=${now - lastTouch} staleDestroyMs=${this.staleDestroyMs})`,
					);
					continue;
				}
				// Three inputs, each covering a way the others go stale:
				//  - `lastRoutedMs`: the router handed this device an event.
				//  - `parkedAtMs`: a session on it blocked on a user answer. Without
				//    it the clock is `lastRoutedMs`, so an agent that worked for
				//    twenty minutes and only then asked a question would be suspended
				//    on the very next tick, the clock having expired while it was
				//    legitimately busy.
				//  - `lastActiveMs`: the device last held a live session (see
				//    `RouterStore.markDeviceActive`). The only one stamped by the
				//    AGENT working rather than by the router doing something TO the
				//    agent, and so the only one that moves during a long session.
				//    Without it a 40-minute session leaves the other two frozen at its
				//    start and the container reads as idle for 35 of those minutes.
				const idleSince = Math.max(
					row.lastRoutedMs ?? 0,
					row.parkedAtMs ?? 0,
					row.lastActiveMs ?? 0,
					row.createdMs,
				);
				const idleForMs = now - idleSince;
				if (idleForMs > this.idleStopMs) {
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
						this.store.markDeviceActive(row.deviceId, now);
						this.logger.info(
							`Skipped idle-stop of ${row.issueKey} (device=${row.deviceId}): ` +
								`session(s) ${claimedMidSweep.map((r) => r.sessionId).join(", ")} ` +
								`claimed it while the sweep was deciding`,
						);
						continue;
					}
					if (status === "running") {
						await executor.stop(row.issueKey);
						this.observations.set(row.deviceId, {
							state: "stopped",
							observedMs: this.now(),
						});
						// The container is no longer running, so its continuous-uptime
						// clock stops here. Read before clearing so the event can report
						// how long the run it ends actually lasted — the single most
						// useful number for tuning `idleStopMs`.
						const uptimeMs = row.runningSinceMs
							? now - row.runningSinceMs
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
								age_ms: now - row.createdMs,
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
				this.logger.error(`Lifecycle sweep failed for ${row.issueKey}`, err);
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
				duration_ms: this.now() - now,
			}),
		);
	}
}
