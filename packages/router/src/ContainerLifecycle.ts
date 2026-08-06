import type { ILogger } from "cyrus-core";
import type { ExecutorRegistry } from "cyrus-router-executors";
import type { ContainerDeviceInfo, RouterStore } from "./RouterStore.js";

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
	/** Omitted (e.g. in tests) leaves today's behaviour: affinity is trusted as-is. */
	sessionReconciler?: SessionReconciler;
	logger: ILogger;
	/** Injectable clock (default `Date.now`) so time-based policy is deterministic in tests. */
	now?: () => number;
}

/**
 * Periodic sweep that keeps ephemeral containers bounded in cost and disk:
 *
 *  - Idle-stop: a container with no active session affinity, untouched for
 *    `idleStopMs`, gets `stop()`ed — parked, volume retained, cheap to
 *    resume.
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
 * progress from being yanked out from under a live session.
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
	private readonly sessionReconciler: SessionReconciler | undefined;
	/** Devices already reported as pinned, so the 60s tick logs on transition only. */
	private readonly pinnedDevices = new Set<number>();
	private readonly logger: ILogger;
	private readonly now: () => number;

	constructor(opts: ContainerLifecycleOptions) {
		this.store = opts.store;
		this.executors = opts.executors;
		this.idleStopMs = opts.idleStopMs;
		this.staleDestroyMs = opts.staleDestroyMs;
		this.offlineAgeOutMs = opts.offlineAgeOutMs;
		this.sessionReconciler = opts.sessionReconciler;
		this.logger = opts.logger;
		this.now = opts.now ?? Date.now;
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

	async sweep(): Promise<void> {
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
			this.logger.warn(
				`lifecycle sweep failed to list container devices: ${String(err)}`,
			);
			return;
		}
		const knownKeys = new Set(rows.map((r) => r.issueKey));

		for (const row of rows) {
			const executor = this.executors.get(row.provider);
			if (!executor) continue;
			try {
				const affinity = await this.resolveAffinity(row.deviceId, now);
				if (affinity > 0) {
					this.notePinned(row.deviceId, row.issueKey);
					continue;
				}
				this.noteUnpinned(row.deviceId);
				const lastTouch = Math.max(
					row.lastRoutedMs ?? 0,
					row.lastSeenMs ?? 0,
					row.createdMs,
				);
				if (now - lastTouch > this.staleDestroyMs) {
					await executor.destroy(row.issueKey);
					this.store.deleteContainerDevice(row.deviceId);
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
				// `parkedAtMs` is when a session on this device blocked on a user
				// answer. Without it the clock is `lastRoutedMs`, so an agent that
				// worked for twenty minutes and only then asked a question would be
				// suspended on the very next tick — the clock having expired while
				// it was legitimately busy.
				const idleSince = Math.max(
					row.lastRoutedMs ?? 0,
					row.parkedAtMs ?? 0,
					row.createdMs,
				);
				const idleForMs = now - idleSince;
				if (idleForMs > this.idleStopMs) {
					// `status` is read only once the clock already qualifies, so the
					// logged value is the same one the decision used.
					const status = await executor.status(row.issueKey);
					if (status === "running") {
						await executor.stop(row.issueKey);
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
				this.logger.warn(
					`lifecycle sweep failed for ${row.issueKey}: ${String(err)}`,
				);
			}
		}

		for (const [provider, executor] of this.executors) {
			try {
				for (const key of await executor.listManaged()) {
					// `knownKeys` is a snapshot taken before this loop's `await`s —
					// it's a cheap pre-filter only, never the final say. A route
					// landing mid-sweep (ContainerTargetService.ensureDevice writing
					// the device row + boot() starting ensureRunning concurrently)
					// can make a brand-new, still-booting container visible to
					// listManaged() before it existed in that snapshot, which would
					// otherwise misidentify it as an orphan and destroy() it — TOCTOU.
					// Re-check the store immediately before each destroy() so a
					// device row created after the snapshot still saves the container.
					if (
						!knownKeys.has(key) &&
						!this.store.getContainerDeviceForIssue(key)
					) {
						await executor.destroy(key);
						this.logger.info(
							`Destroyed orphan ${provider} container for ${key}`,
						);
					}
				}
			} catch (err) {
				this.logger.warn(
					`orphan GC failed for provider ${provider}: ${String(err)}`,
				);
			}
		}
	}
}
