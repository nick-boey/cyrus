import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TeardownCallbackError } from "cyrus-workspace-sync";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeardownCallbackQueue } from "../src/TeardownCallbackQueue.js";

/**
 * The durability contract behind "the Done webhook must not have to wait out the
 * router's 10-minute teardown grace".
 *
 * The observed live failure was a worker that woke from an idle stop, ran its
 * cleanup, and never delivered the teardown callback — so nothing leaked, but
 * the sandbox was billed until grace expiry. These tests pin the two properties
 * that fix it: the intent is on disk before any cleanup work starts, and the
 * same idempotency key is replayed until the router accepts it.
 */
describe("TeardownCallbackQueue", () => {
	let stateDir: string;
	let logger: {
		info: ReturnType<typeof vi.fn>;
		warn: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "teardown-callbacks-"));
		logger = { info: vi.fn(), warn: vi.fn() };
	});

	function queue(
		post: (issueKey: string, idempotencyKey: string) => Promise<void>,
	) {
		return new TeardownCallbackQueue({
			stateDir,
			post,
			logger,
			// No real waiting: the retry backoff is consumed by a no-op sleep.
			sleep: async () => {},
			retryBaseMs: 1,
			retryCapMs: 1,
		});
	}

	const queueFile = () => join(stateDir, "teardown-callbacks.jsonl");

	it("records the intent to disk before any callback is attempted", () => {
		const post = vi.fn(async () => {});
		const q = queue(post);

		const key = q.record("CYPACK-1");

		expect(key).toMatch(/[0-9a-f-]{36}/);
		expect(post).not.toHaveBeenCalled();
		expect(q.pending()).toEqual(["CYPACK-1"]);
		expect(readFileSync(queueFile(), "utf8")).toContain(key);
	});

	it("delivers on flush and clears the durable record", async () => {
		const post = vi.fn(async () => {});
		const q = queue(post);
		const key = q.record("CYPACK-1");

		await q.flush();

		expect(post).toHaveBeenCalledExactlyOnceWith("CYPACK-1", key);
		expect(q.pending()).toEqual([]);
		expect(readFileSync(queueFile(), "utf8")).toBe("");
	});

	it("replays the callback on restart when the worker dies between the floor flush and the callback", async () => {
		// ── First process ──
		// This mirrors EdgeWorker.handleIssueStateChangeMessage: the intent is
		// recorded synchronously, THEN the slow cleanup runs.
		const firstPost = vi.fn(async () => {});
		const first = queue(firstPost);
		const key = first.record("CYPACK-1");
		const floorFlushed: string[] = [];
		floorFlushed.push("wip-push+bundle-upload");

		// …and the process is killed right here — after the floor flush, before
		// the callback. Nothing was ever posted.
		first.stop();
		expect(firstPost).not.toHaveBeenCalled();
		expect(floorFlushed).toEqual(["wip-push+bundle-upload"]);

		// ── Restart, same state directory ──
		const secondPost = vi.fn(async () => {});
		const second = queue(secondPost);
		expect(second.pending()).toEqual(["CYPACK-1"]);

		await second.resume();

		// Replayed with the SAME idempotency key the dead process minted, so the
		// router recognises it as one logical callback.
		expect(secondPost).toHaveBeenCalledExactlyOnceWith("CYPACK-1", key);
		expect(second.pending()).toEqual([]);
		expect(logger.info).toHaveBeenCalledWith(
			expect.stringContaining("Replaying 1 teardown callback(s)"),
		);
	});

	it("retries a transient failure with the same key until the router accepts it", async () => {
		const post = vi
			.fn<(issueKey: string, key: string) => Promise<void>>()
			.mockRejectedValueOnce(
				new TeardownCallbackError("router down", 503, true),
			)
			.mockRejectedValueOnce(
				new TeardownCallbackError("router down", undefined, true),
			)
			.mockResolvedValueOnce(undefined);
		const q = queue(post);
		const key = q.record("CYPACK-1");

		await q.flush();

		expect(post).toHaveBeenCalledTimes(3);
		expect(post.mock.calls.map(([, k]) => k)).toEqual([key, key, key]);
		expect(q.pending()).toEqual([]);
	});

	it("keeps an undeliverable callback queued for the next start", async () => {
		const post = vi.fn(async () => {
			throw new TeardownCallbackError("router down", 503, true);
		});
		const q = new TeardownCallbackQueue({
			stateDir,
			post,
			logger,
			sleep: async () => {},
			maxAttemptsPerFlush: 3,
		});
		q.record("CYPACK-1");

		await q.flush();

		expect(post).toHaveBeenCalledTimes(3);
		expect(q.pending()).toEqual(["CYPACK-1"]);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("keeping it queued for the next start"),
		);
		// Still on disk, so a later start replays it.
		expect(
			new TeardownCallbackQueue({ stateDir, post, logger }).pending(),
		).toEqual(["CYPACK-1"]);
	});

	it("drops a callback the router positively rejected instead of retrying forever", async () => {
		const post = vi.fn(async () => {
			throw new TeardownCallbackError("HTTP 403", 403, false);
		});
		const q = queue(post);
		q.record("CYPACK-1");

		await q.flush();

		expect(post).toHaveBeenCalledTimes(1);
		expect(q.pending()).toEqual([]);
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("Router rejected the teardown callback"),
		);
	});

	it("keeps one key per issue when the same terminal webhook is seen twice", () => {
		const q = queue(vi.fn(async () => {}));
		expect(q.record("CYPACK-1")).toBe(q.record("CYPACK-1"));
		expect(q.pending()).toEqual(["CYPACK-1"]);
	});

	it("survives a corrupt trailing line in the queue file", async () => {
		const post = vi.fn(async () => {});
		const first = queue(post);
		first.record("CYPACK-1");
		// Simulate a crash mid-append by tacking on a partial record.
		const { appendFileSync } = await import("node:fs");
		appendFileSync(queueFile(), '{"issueKey":"CYPACK-2","idem');

		expect(queue(post).pending()).toEqual(["CYPACK-1"]);
		expect(existsSync(queueFile())).toBe(true);
	});
});
