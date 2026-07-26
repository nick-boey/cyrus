import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TeardownCallbackError } from "cyrus-workspace-sync";

/** One recorded intent to tell the router "my terminal cleanup is done". */
interface TeardownCallbackEntry {
	issueKey: string;
	/** Stable across every replay, including across process restarts. */
	idempotencyKey: string;
	recordedMs: number;
	attempts: number;
}

export interface TeardownCallbackQueueOptions {
	/** Directory for the durable queue file (normally `cyrusHome`). */
	stateDir: string;
	/** Posts one callback. Rejects with {@link TeardownCallbackError} on failure. */
	post: (issueKey: string, idempotencyKey: string) => Promise<void>;
	logger: {
		info(msg: string): void;
		warn(msg: string): void;
	};
	/** First retry delay; doubles up to {@link retryCapMs} (default 2s). */
	retryBaseMs?: number;
	/** Ceiling for the exponential retry delay (default 30s). */
	retryCapMs?: number;
	/**
	 * Attempts per flush before giving up and leaving the entry on disk
	 * (default 6 → ~1 minute of retrying with the default base/cap). The
	 * router's teardown grace deadline is the backstop beyond that.
	 */
	maxAttemptsPerFlush?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Durable, retrying queue for the container teardown callback
 * (`POST /containers/issues/:issueKey/teardown-complete`).
 *
 * ── WHY THIS EXISTS ──
 * The callback is the only thing that lets the router destroy an issue's
 * sandbox (and its snapshots) *promptly*. Without it the router falls back to
 * its 10-minute grace deadline — which is safe (nothing leaks) but slow, and
 * the sandbox is billed for the whole grace window. Observed live: a Linear
 * "Done" webhook woke an idle-stopped sandbox, the worker ran its cleanup, and
 * the callback never arrived; teardown waited out the full grace.
 *
 * A single fire-and-forget `fetch` at the end of cleanup has two holes, and
 * this class closes both:
 *
 *  1. **Process death.** `RouterConnection` marks its durable inbox entry
 *     processed the instant its `"event"` emit returns — which is long before
 *     the *asynchronous* cleanup that emit kicked off has finished. Anything
 *     the worker still owed the router after that point died with the process.
 *     So {@link record} persists the intent (with its idempotency key)
 *     synchronously, inside that emit window and BEFORE any cleanup work
 *     begins, and {@link resume} replays whatever is left on disk on the next
 *     start. The record therefore outlives a kill at any point in the
 *     sequence — including the gap between the floor flush and the callback.
 *
 *  2. **A transient router outage.** A worker that just woke from an ACA
 *     memory suspend may reach the router's HTTP surface only after its
 *     WebSocket has redialed. {@link flush} retries the same idempotency key
 *     with exponential backoff instead of dropping the callback on the first
 *     `ECONNREFUSED`.
 *
 * Retries are bounded per flush; an entry that still can't be delivered stays
 * on disk for the next start, and the router's grace deadline remains the final
 * backstop. A callback the router positively REJECTS (bad token, wrong issue —
 * `TeardownCallbackError.retryable === false`) is dropped immediately: replaying
 * it can never succeed.
 */
export class TeardownCallbackQueue {
	private readonly file: string;
	private readonly post: TeardownCallbackQueueOptions["post"];
	private readonly logger: TeardownCallbackQueueOptions["logger"];
	private readonly retryBaseMs: number;
	private readonly retryCapMs: number;
	private readonly maxAttemptsPerFlush: number;
	private readonly now: () => number;
	private readonly sleep: (ms: number) => Promise<void>;

	private entries: TeardownCallbackEntry[];
	private stopped = false;
	/** Serialises flushes so a resume and a live teardown can't interleave. */
	private inFlight: Promise<void> = Promise.resolve();

	constructor(opts: TeardownCallbackQueueOptions) {
		mkdirSync(opts.stateDir, { recursive: true });
		this.file = join(opts.stateDir, "teardown-callbacks.jsonl");
		this.post = opts.post;
		this.logger = opts.logger;
		this.retryBaseMs = opts.retryBaseMs ?? 2_000;
		this.retryCapMs = opts.retryCapMs ?? 30_000;
		this.maxAttemptsPerFlush = opts.maxAttemptsPerFlush ?? 6;
		this.now = opts.now ?? Date.now;
		this.sleep =
			opts.sleep ??
			((ms) =>
				new Promise((resolve) => {
					setTimeout(resolve, ms).unref?.();
				}));
		this.entries = this.load();
	}

	/** Issue keys with a callback still owed to the router. */
	pending(): string[] {
		return this.entries.map((entry) => entry.issueKey);
	}

	/**
	 * Durably record that this issue owes the router a teardown callback.
	 *
	 * MUST be called **synchronously**, before the first `await` of the terminal
	 * cleanup — that is what puts the write inside `RouterConnection`'s
	 * still-unprocessed inbox window, so a crash anywhere in the cleanup replays
	 * rather than losing the callback. Idempotent per issue: re-recording an
	 * already-pending issue keeps the original key so the router still sees one
	 * logical callback.
	 */
	record(issueKey: string): string {
		const existing = this.entries.find((entry) => entry.issueKey === issueKey);
		if (existing) return existing.idempotencyKey;
		const entry: TeardownCallbackEntry = {
			issueKey,
			idempotencyKey: randomUUID(),
			recordedMs: this.now(),
			attempts: 0,
		};
		this.entries.push(entry);
		this.persist();
		return entry.idempotencyKey;
	}

	/**
	 * Deliver every recorded callback, retrying with backoff. Never rejects:
	 * teardown must not fail because the router is briefly unreachable.
	 */
	async flush(): Promise<void> {
		const run = this.inFlight.then(() => this.flushNow());
		this.inFlight = run.catch(() => {});
		return run;
	}

	/**
	 * Replay callbacks left behind by a previous process.
	 *
	 * Call this only once the router connection is back up: the callback rides
	 * the router's HTTP surface, and a worker that has just reconnected its
	 * WebSocket is the first moment we know the router is actually reachable.
	 */
	async resume(): Promise<void> {
		if (this.entries.length === 0) return;
		this.logger.info(
			`Replaying ${this.entries.length} teardown callback(s) recorded before this process started: ${this.pending().join(", ")}`,
		);
		await this.flush();
	}

	stop(): void {
		this.stopped = true;
	}

	private async flushNow(): Promise<void> {
		for (const entry of [...this.entries]) {
			await this.deliver(entry);
			if (this.stopped) return;
		}
	}

	private async deliver(entry: TeardownCallbackEntry): Promise<void> {
		for (let attempt = 1; attempt <= this.maxAttemptsPerFlush; attempt++) {
			if (this.stopped) return;
			entry.attempts += 1;
			try {
				await this.post(entry.issueKey, entry.idempotencyKey);
				this.remove(entry.issueKey);
				this.logger.info(
					`Reported teardown completion for ${entry.issueKey} to the router (callback ${entry.idempotencyKey}, attempt ${entry.attempts})`,
				);
				return;
			} catch (error) {
				if (error instanceof TeardownCallbackError && !error.retryable) {
					this.remove(entry.issueKey);
					this.logger.warn(
						`Router rejected the teardown callback for ${entry.issueKey} (${error.message}); dropping it and leaving destruction to the router's grace deadline`,
					);
					return;
				}
				this.persist();
				if (attempt === this.maxAttemptsPerFlush) {
					this.logger.warn(
						`Teardown callback for ${entry.issueKey} still undelivered after ${entry.attempts} attempt(s) (${String(error)}); keeping it queued for the next start — the router's grace deadline remains the backstop`,
					);
					return;
				}
				const delay = Math.min(
					this.retryBaseMs * 2 ** (attempt - 1),
					this.retryCapMs,
				);
				this.logger.warn(
					`Teardown callback attempt ${entry.attempts} for ${entry.issueKey} failed (${String(error)}); retrying the same callback id in ${delay}ms`,
				);
				await this.sleep(delay);
			}
		}
	}

	private remove(issueKey: string): void {
		this.entries = this.entries.filter((entry) => entry.issueKey !== issueKey);
		this.persist();
	}

	private load(): TeardownCallbackEntry[] {
		let raw: string;
		try {
			raw = readFileSync(this.file, "utf8");
		} catch {
			return [];
		}
		const out: TeardownCallbackEntry[] = [];
		for (const line of raw.split("\n")) {
			if (line.trim().length === 0) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(line);
			} catch {
				// Tolerate a partially-written trailing line.
				continue;
			}
			if (typeof parsed !== "object" || parsed === null) continue;
			const value = parsed as Record<string, unknown>;
			if (
				typeof value.issueKey !== "string" ||
				typeof value.idempotencyKey !== "string"
			) {
				continue;
			}
			out.push({
				issueKey: value.issueKey,
				idempotencyKey: value.idempotencyKey,
				recordedMs:
					typeof value.recordedMs === "number" ? value.recordedMs : this.now(),
				attempts: typeof value.attempts === "number" ? value.attempts : 0,
			});
		}
		return out;
	}

	/**
	 * Rewrite-and-rename so a crash mid-write can never leave a truncated queue.
	 * A write failure is logged, never thrown: losing the callback record is a
	 * slow teardown, whereas failing the caller would abort real cleanup.
	 */
	private persist(): void {
		const body =
			this.entries.length === 0
				? ""
				: `${this.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
		const tmp = `${this.file}.${randomUUID()}.tmp`;
		try {
			writeFileSync(tmp, body);
			renameSync(tmp, this.file);
		} catch (error) {
			this.logger.warn(
				`Failed to persist the teardown callback queue at ${this.file}: ${String(error)}`,
			);
		}
	}
}
