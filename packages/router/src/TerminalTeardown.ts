import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutorRegistry } from "cyrus-router-executors";
import type { FastifyInstance } from "fastify";
import type { RouterStore } from "./RouterStore.js";

export type TerminalTeardownAction = "closed" | "deleted";
const ISSUE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

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
	>;
	executors: ExecutorRegistry;
	artifactsDir: string;
	graceMs: number;
	retryMs?: number;
	logger: { info(msg: string): void; warn(msg: string): void };
	now?: () => number;
	setTimeout?: (callback: () => void, delayMs: number) => unknown;
	clearTimeout?: (timer: unknown) => void;
}

/**
 * In-memory coordinator for terminal issue teardown. The first terminal
 * webhook for an issue wins, except that deletion upgrades a pending close.
 * Failed destroys remain pending for bounded retries. Router restarts
 * intentionally lose this state; stale lifecycle GC is the durable backstop.
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
		this.pending.set(input.issueKey, { ...input, deadline, timer });
		return true;
	}

	has(issueKey: string): boolean {
		return this.pending.has(issueKey);
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

	async handleCallback(issueKey: string, deviceId: number): Promise<void> {
		await this.complete(issueKey, deviceId, "callback");
	}

	private async complete(
		issueKey: string,
		deviceId: number,
		reason: "callback" | "grace expiry" | "retry",
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
		reason: "callback" | "grace expiry" | "retry",
	): Promise<void> {
		const { issueKey } = entry;

		const current = this.opts.store.getContainerDeviceForIssue(issueKey);
		if (!current || current.deviceId !== entry.deviceId) {
			this.pending.delete(issueKey);
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
		this.opts.store.deleteContainerDevice(entry.deviceId);
		if (entry.action === "deleted") {
			try {
				await this.deleteRetainedBundle(issueKey);
			} catch (error) {
				this.opts.logger.warn(
					`Container for deleted issue ${issueKey} was destroyed, but its artifact bundle could not be removed: ${String(error)}`,
				);
			}
		}
		this.opts.logger.info(
			`Completed terminal teardown for ${issueKey} after ${reason}`,
		);
	}

	private scheduleRetry(
		entry: PendingTeardown,
		reason: "callback" | "grace expiry" | "retry",
		error: unknown,
	): void {
		this.opts.logger.warn(
			`Terminal teardown destroy failed for ${entry.issueKey} after ${reason}; retaining device row and retrying in ${this.retryMs}ms: ${String(error)}`,
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
			this.opts.logger.warn(
				`Terminal teardown ${reason} handler failed for ${issueKey}: ${String(error)}`,
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

			try {
				await teardown.handleCallback(request.params.issueKey, device.deviceId);
			} catch {
				return reply.status(503).send({
					error: "container destroy failed; retry scheduled",
				});
			}
			return { ok: true };
		},
	);
}
