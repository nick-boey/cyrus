import type { ExecutorRegistry } from "cyrus-router-executors";
import type { RouterStore } from "./RouterStore.js";

export interface ContainerLifecycleOptions {
	store: RouterStore;
	executors: ExecutorRegistry;
	/** A running, affinity-free container idle past this many ms is stopped (Task 8 default: 15 minutes). */
	idleStopMs: number;
	/** A container untouched past this many ms is destroyed and its device row deleted (Task 8 default: 14 days). */
	staleDestroyMs: number;
	logger: { info(msg: string): void; warn(msg: string): void };
	/** Injectable clock (default `Date.now`) so time-based policy is deterministic in tests. */
	now?: () => number;
}

/**
 * Periodic sweep that keeps ephemeral containers bounded in cost and disk:
 *
 *  - Idle-stop: a container with no active session affinity, untouched for
 *    `idleStopMs`, gets `stop()`ed — parked, volume retained, cheap to
 *    resume.
 *  - Stale-destroy: a container untouched for `staleDestroyMs` gets
 *    `destroy()`ed (container AND volume) and its device row deleted. Safe
 *    only because of the persistence floor: the git branch and the artifact
 *    bundle survive, so a later prompt rebuilds the workspace from the
 *    restore ladder.
 *  - Orphan GC: any container a provider still owns with no matching device
 *    row gets `destroy()`ed — reclaims containers left behind when a user is
 *    revoked (`revokeDevice` deletes device rows without touching providers)
 *    or a device row is manually destroyed via the CLI.
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
	private readonly logger: { info(msg: string): void; warn(msg: string): void };
	private readonly now: () => number;

	constructor(opts: ContainerLifecycleOptions) {
		this.store = opts.store;
		this.executors = opts.executors;
		this.idleStopMs = opts.idleStopMs;
		this.staleDestroyMs = opts.staleDestroyMs;
		this.logger = opts.logger;
		this.now = opts.now ?? Date.now;
	}

	async sweep(): Promise<void> {
		const now = this.now();
		const rows = this.store.listContainerDevices();
		const knownKeys = new Set(rows.map((r) => r.issueKey));

		for (const row of rows) {
			const executor = this.executors.get(row.provider);
			if (!executor) continue;
			try {
				const active =
					this.store.countSessionAffinityForDevice(row.deviceId) > 0;
				if (active) continue;
				const lastTouch = Math.max(
					row.lastRoutedMs ?? 0,
					row.lastSeenMs ?? 0,
					row.createdMs,
				);
				if (now - lastTouch > this.staleDestroyMs) {
					await executor.destroy(row.issueKey);
					this.store.deleteContainerDevice(row.deviceId);
					this.logger.info(`Destroyed stale container for ${row.issueKey}`);
					continue;
				}
				const idleSince = row.lastRoutedMs ?? row.createdMs;
				if (
					now - idleSince > this.idleStopMs &&
					(await executor.status(row.issueKey)) === "running"
				) {
					await executor.stop(row.issueKey);
					this.logger.info(`Idle-stopped container for ${row.issueKey}`);
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
					if (!knownKeys.has(key)) {
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
