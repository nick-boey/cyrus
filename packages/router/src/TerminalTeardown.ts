import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ILogger } from "cyrus-core";
import type { ExecutorRegistry } from "cyrus-router-executors";
import { TEARDOWN_IDEMPOTENCY_HEADER } from "cyrus-workspace-sync";
import type { FastifyInstance } from "fastify";
import type { RouterStore } from "./RouterStore.js";
import {
	emitSandboxEvent,
	SANDBOX_EVENTS,
	type SandboxDestroyReason,
} from "./SandboxTelemetry.js";

export type TerminalTeardownAction = "closed" | "deleted";
/**
 * Why a destroy attempt is running. `callback retry` is deliberately separate
 * from `grace expiry`: the first says the worker is alive and re-delivering its
 * durable callback, the second says no worker ever reported in.
 */
type TeardownReason = "callback" | "callback retry" | "grace expiry" | "retry";
const ISSUE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
/** Bounded, log-safe shape for a device-supplied callback idempotency key. */
const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._:-]{1,128}$/;

interface PendingTeardown {
	issueKey: string;
	deviceId: number;
	action: TerminalTeardownAction;
	deadline: number;
	timer: unknown;
	inFlight?: Promise<void>;
}

export interface TerminalTeardownOptions {
	store: Pick<
		RouterStore,
		| "getDeviceByToken"
		| "getDeviceInfo"
		| "getContainerDeviceForIssue"
		| "deleteContainerDevice"
		| "upsertPendingTeardown"
		| "recordTeardownCallback"
		| "deletePendingTeardown"
		| "clearPendingTeardowns"
	>;
	executors: ExecutorRegistry;
	artifactsDir: string;
	graceMs: number;
	retryMs?: number;
	logger: ILogger;
	now?: () => number;
	setTimeout?: (callback: () => void, delayMs: number) => unknown;
	clearTimeout?: (timer: unknown) => void;
}

/**
 * In-memory coordinator for terminal issue teardown. The first terminal
 * webhook for an issue wins, except that deletion upgrades a pending close.
 * Failed destroys remain pending for bounded retries. Router restarts
 * intentionally lose this state; stale lifecycle GC is the durable backstop.
 *
 * Each pending teardown is ALSO mirrored into `container_teardowns` so the
 * out-of-process `cyrus router containers list` can show whether a container is
 * still waiting on its worker's authenticated callback. That table is
 * observability + callback-retry accounting only — it is deliberately NOT a
 * restart journal, and is cleared at construction to match this object's own
 * empty starting state (see {@link RouterStore.clearPendingTeardowns}).
 */
export class TerminalTeardown {
	private readonly pending = new Map<string, PendingTeardown>();
	private readonly now: () => number;
	private readonly schedule: (callback: () => void, delayMs: number) => unknown;
	private readonly cancel: (timer: unknown) => void;
	private readonly retryMs: number;
	private stopped = false;

	constructor(private readonly opts: TerminalTeardownOptions) {
		this.now = opts.now ?? Date.now;
		// This coordinator starts with no pending entries and no armed timers, so
		// any row left by a previous process is a ghost that would misreport as
		// "callback pending" forever.
		const ghosts = opts.store.clearPendingTeardowns();
		if (ghosts > 0) {
			opts.logger.info(
				`Cleared ${ghosts} terminal teardown row(s) left by a previous router process; stale-container GC remains the backstop for them`,
			);
		}
		this.schedule =
			opts.setTimeout ??
			((callback, delayMs) => {
				const timer = setTimeout(callback, delayMs);
				timer.unref?.();
				return timer;
			});
		this.cancel =
			opts.clearTimeout ?? ((timer) => clearTimeout(timer as NodeJS.Timeout));
		this.retryMs = opts.retryMs ?? 60_000;
	}

	register(input: {
		issueKey: string;
		deviceId: number;
		action: TerminalTeardownAction;
	}): boolean {
		const existing = this.pending.get(input.issueKey);
		if (existing) {
			if (
				existing.deviceId === input.deviceId &&
				existing.action === "closed" &&
				input.action === "deleted"
			) {
				existing.action = "deleted";
				this.persistPending(existing);
				this.opts.logger.info(
					`Upgraded terminal teardown for ${input.issueKey} from closed to deleted`,
				);
				return true;
			}
			this.opts.logger.info(
				`Ignoring repeated terminal teardown for ${input.issueKey}; the first registration wins`,
			);
			return false;
		}

		const deadline = this.now() + this.opts.graceMs;
		const timer = this.schedule(() => {
			this.opts.logger.warn(
				`Terminal teardown grace expired for ${input.issueKey}; destroying the container`,
			);
			this.runScheduled(input.issueKey, input.deviceId, "grace expiry");
		}, this.opts.graceMs);
		const entry: PendingTeardown = { ...input, deadline, timer };
		this.pending.set(input.issueKey, entry);
		this.persistPending(entry);
		return true;
	}

	has(issueKey: string): boolean {
		return this.pending.has(issueKey);
	}

	/** Mirror a pending entry for out-of-process visibility. Never throws. */
	private persistPending(entry: PendingTeardown): void {
		try {
			this.opts.store.upsertPendingTeardown({
				issueKey: entry.issueKey,
				deviceId: entry.deviceId,
				action: entry.action,
				registeredMs: this.now(),
				deadlineMs: entry.deadline,
			});
		} catch (error) {
			// Bookkeeping only: a write failure must never stop a real teardown.
			this.opts.logger.warn(
				`Could not persist pending teardown state for ${entry.issueKey}`,
				error,
			);
		}
	}

	private clearPersisted(issueKey: string): void {
		try {
			this.opts.store.deletePendingTeardown(issueKey);
		} catch (error) {
			this.opts.logger.warn(
				`Could not clear pending teardown state for ${issueKey}`,
				error,
			);
		}
	}

	/**
	 * Delete only a retained bundle after a later Issue/remove arrives. This is
	 * intentionally independent of device state: a successful close teardown
	 * has already removed the container row and its issue affinity.
	 */
	async deleteRetainedBundle(issueKey: string): Promise<void> {
		if (!ISSUE_KEY_RE.test(issueKey)) {
			throw new Error(`invalid issue key: ${issueKey}`);
		}
		await rm(join(this.opts.artifactsDir, issueKey, "bundle.tar.gz"), {
			force: true,
		});
	}

	stop(): void {
		this.stopped = true;
		for (const entry of this.pending.values()) this.cancel(entry.timer);
		this.pending.clear();
	}

	/**
	 * A worker reporting that its in-container cleanup finished.
	 *
	 * `callbackId` is the device's durable idempotency key. The device replays
	 * the SAME key until we accept the callback, so a repeat delivery is logged
	 * as `callback retry` — distinct from `grace expiry`, which means no worker
	 * ever reported in and the deadline forced the destroy. Operators reading the
	 * router log can therefore tell "the worker is talking to us, delivery is
	 * just flaky" apart from "the worker never came back".
	 */
	async handleCallback(
		issueKey: string,
		deviceId: number,
		callbackId?: string,
	): Promise<void> {
		let reason: TeardownReason = "callback";
		try {
			const noted = this.opts.store.recordTeardownCallback(
				issueKey,
				callbackId,
				this.now(),
			);
			if (noted?.retry) {
				reason = "callback retry";
				this.opts.logger.info(
					`Terminal teardown callback for ${issueKey} is a retry of callback ${noted.info.callbackId ?? "(unkeyed)"} (delivery #${noted.info.callbackAttempts}); the worker is reachable and re-reporting, not waiting on grace expiry`,
				);
			}
		} catch (error) {
			this.opts.logger.warn(
				`Could not record the teardown callback for ${issueKey}`,
				error,
			);
		}
		await this.complete(issueKey, deviceId, reason);
	}

	private async complete(
		issueKey: string,
		deviceId: number,
		reason: TeardownReason,
	): Promise<void> {
		const entry = this.pending.get(issueKey);
		if (!entry || entry.deviceId !== deviceId) {
			this.opts.logger.info(
				`Ignoring terminal teardown ${reason} for ${issueKey}: no matching pending entry`,
			);
			return;
		}

		if (entry.inFlight) return entry.inFlight;

		this.cancel(entry.timer);
		entry.inFlight = this.attempt(entry, reason);
		try {
			await entry.inFlight;
		} finally {
			entry.inFlight = undefined;
		}
	}

	private async attempt(
		entry: PendingTeardown,
		reason: TeardownReason,
	): Promise<void> {
		const { issueKey } = entry;

		const current = this.opts.store.getContainerDeviceForIssue(issueKey);
		if (!current || current.deviceId !== entry.deviceId) {
			this.pending.delete(issueKey);
			this.clearPersisted(issueKey);
			this.opts.logger.info(
				`Ignoring terminal teardown ${reason} for ${issueKey}: the original container device no longer exists`,
			);
			return;
		}
		const executor = this.opts.executors.get(current.provider);
		if (!executor) {
			const error = new Error(
				`no executor registered for provider '${current.provider}'`,
			);
			this.scheduleRetry(entry, reason, error);
			throw error;
		}

		try {
			// Provider resource first. The row is the stale-GC retry handle and must
			// survive every destroy failure.
			await executor.destroy(issueKey);
		} catch (error) {
			this.scheduleRetry(entry, reason, error);
			throw error;
		}

		this.pending.delete(issueKey);
		// deleteContainerDevice drops the mirrored teardown row too; clearing it
		// first keeps the two consistent even if the device row already vanished.
		this.clearPersisted(issueKey);
		this.opts.store.deleteContainerDevice(entry.deviceId);
		if (entry.action === "deleted") {
			try {
				await this.deleteRetainedBundle(issueKey);
			} catch (error) {
				this.opts.logger.warn(
					`Container for deleted issue ${issueKey} was destroyed, but its artifact bundle could not be removed`,
					error,
				);
			}
		}
		// Both events, not one: `destroyed` belongs to the sandbox-count series
		// (it is what closes the gauge out for this issue), while
		// `teardown_completed` carries the teardown-specific dimensions — which
		// terminal action triggered it, and whether the worker's callback or the
		// grace deadline got us here. Collapsing them would force any query that
		// counts live sandboxes to special-case teardowns.
		const identity = {
			issueKey,
			deviceId: entry.deviceId,
			provider: current.provider,
		};
		emitSandboxEvent(this.opts.logger, SANDBOX_EVENTS.destroyed, identity, {
			reason: "terminal_teardown" satisfies SandboxDestroyReason,
		});
		emitSandboxEvent(
			this.opts.logger,
			SANDBOX_EVENTS.teardownCompleted,
			identity,
			{
				action: entry.action,
				trigger: reason,
				age_ms: this.now() - current.createdMs,
				uptime_ms: current.runningSinceMs
					? this.now() - current.runningSinceMs
					: null,
			},
		);
		this.opts.logger.info(
			`Completed terminal teardown for ${issueKey} after ${reason}`,
		);
	}

	private scheduleRetry(
		entry: PendingTeardown,
		reason: TeardownReason,
		error: unknown,
	): void {
		this.opts.logger.error(
			`Terminal teardown destroy failed for ${entry.issueKey} after ${reason}; retaining device row and retrying in ${this.retryMs}ms`,
			error,
		);
		if (this.stopped || this.pending.get(entry.issueKey) !== entry) return;
		entry.timer = this.schedule(
			() => this.runScheduled(entry.issueKey, entry.deviceId, "retry"),
			this.retryMs,
		);
	}

	private runScheduled(
		issueKey: string,
		deviceId: number,
		reason: "grace expiry" | "retry",
	): void {
		void this.complete(issueKey, deviceId, reason).catch((error) => {
			this.opts.logger.error(
				`Terminal teardown ${reason} handler failed for ${issueKey}`,
				error,
			);
		});
	}
}

/** Registers the device-token-authenticated container teardown callback. */
export function registerTerminalTeardownRoute(
	fastify: FastifyInstance,
	store: Pick<RouterStore, "getDeviceByToken" | "getDeviceInfo">,
	teardown: TerminalTeardown,
): void {
	fastify.post<{ Params: { issueKey: string } }>(
		"/containers/issues/:issueKey/teardown-complete",
		async (request, reply) => {
			const header = request.headers.authorization;
			const token = header?.startsWith("Bearer ")
				? header.slice("Bearer ".length)
				: undefined;
			const device = token ? store.getDeviceByToken(token) : undefined;
			if (!device) return reply.status(401).send({ error: "unauthorized" });
			if (!ISSUE_KEY_RE.test(request.params.issueKey)) {
				return reply.status(400).send({ error: "invalid issue key" });
			}

			const info = store.getDeviceInfo(device.deviceId);
			if (!info) return reply.status(401).send({ error: "unauthorized" });
			if (info.kind === "device") return { ok: true };
			if (info.issueKey !== request.params.issueKey) {
				return reply.status(403).send({ error: "forbidden" });
			}

			// Optional: an older worker sends no key, in which case a repeat
			// delivery is still deduped by the pending entry, just not labelled
			// as a retry in the router log.
			const rawKey = request.headers[TEARDOWN_IDEMPOTENCY_HEADER];
			const callbackId = Array.isArray(rawKey) ? rawKey[0] : rawKey;
			if (callbackId !== undefined && !IDEMPOTENCY_KEY_RE.test(callbackId)) {
				return reply.status(400).send({ error: "invalid idempotency key" });
			}

			try {
				await teardown.handleCallback(
					request.params.issueKey,
					device.deviceId,
					callbackId,
				);
			} catch {
				return reply.status(503).send({
					error: "container destroy failed; retry scheduled",
				});
			}
			return { ok: true };
		},
	);
}
