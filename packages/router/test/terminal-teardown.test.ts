import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContainerExecutor } from "cyrus-router-executors";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RouterStore } from "../src/RouterStore.js";
import {
	registerTerminalTeardownRoute,
	TerminalTeardown,
} from "../src/TerminalTeardown.js";
import { type TestLogger, testLogger } from "./helpers/logger.js";

function executor(destroy = vi.fn(async () => {})): ContainerExecutor {
	return {
		provider: "docker",
		ensureRunning: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		destroy,
		status: vi.fn(async () => "running" as const),
		listManaged: vi.fn(async () => []),
	};
}

describe("TerminalTeardown", () => {
	let store: RouterStore;
	let artifactsDir: string;
	let logger: TestLogger;

	beforeEach(() => {
		store = new RouterStore(":memory:");
		artifactsDir = mkdtempSync(join(tmpdir(), "terminal-artifacts-"));
		logger = testLogger();
	});

	function container(issueKey = "CYPACK-1") {
		const { userId } = store.addUser({ email: `${issueKey}@example.com` });
		return store.createContainerDevice(userId, issueKey, "docker");
	}

	function coordinator(
		exec: ContainerExecutor,
		timers?: { callbacks: Array<() => void>; delays: number[] },
	) {
		return new TerminalTeardown({
			store,
			executors: new Map([["docker", exec]]),
			artifactsDir,
			graceMs: 600_000,
			retryMs: 60_000,
			logger,
			now: () => 1_000,
			setTimeout: timers
				? (callback, delay) => {
						timers.callbacks.push(callback);
						timers.delays.push(delay);
						return timers.callbacks.length;
					}
				: () => 1,
			clearTimeout: vi.fn(),
		});
	}

	describe("sandbox telemetry", () => {
		const eventsNamed = (name: string) =>
			logger.event.mock.calls
				.filter(([emitted]) => emitted === name)
				.map(([, attributes]) => (attributes ?? {}) as Record<string, unknown>);

		/**
		 * Two events, not one. `sandbox_destroyed` is what closes an issue out of
		 * the sandbox-count series regardless of why it went away, while
		 * `sandbox_teardown_completed` carries the teardown-specific dimensions.
		 * Collapsing them would force every "how many sandboxes are open" query to
		 * special-case teardowns.
		 */
		it("emits both a destroy and a teardown event when a teardown completes", async () => {
			const { deviceId } = container();
			const teardown = coordinator(executor());
			teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" });

			await teardown.handleCallback("CYPACK-1", deviceId, "cb-1");

			expect(eventsNamed("sandbox_destroyed")[0]).toMatchObject({
				issue_key: "CYPACK-1",
				device_id: deviceId,
				provider: "docker",
				reason: "terminal_teardown",
			});
			expect(eventsNamed("sandbox_teardown_completed")[0]).toMatchObject({
				issue_key: "CYPACK-1",
				device_id: deviceId,
				action: "closed",
				trigger: "callback",
			});
		});

		/**
		 * The trigger distinguishes "the worker cleaned up and reported in" from
		 * "no worker ever came back and the grace deadline forced the destroy" —
		 * the same distinction the log lines already make, but queryable.
		 */
		it("names the grace deadline as the trigger when no worker reported in", async () => {
			const { deviceId } = container();
			const timers = {
				callbacks: [] as Array<() => void>,
				delays: [] as number[],
			};
			const teardown = coordinator(executor(), timers);
			teardown.register({ issueKey: "CYPACK-1", deviceId, action: "deleted" });

			timers.callbacks[0]?.();
			await vi.waitFor(() =>
				expect(eventsNamed("sandbox_teardown_completed")).toHaveLength(1),
			);

			expect(eventsNamed("sandbox_teardown_completed")[0]).toMatchObject({
				action: "deleted",
				trigger: "grace expiry",
			});
		});

		it("emits nothing when the destroy fails, so a retry is not counted as a completion", async () => {
			const { deviceId } = container();
			const destroy = vi.fn(async () => {
				throw new Error("azure unavailable");
			});
			const teardown = coordinator(executor(destroy));
			teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" });

			await expect(
				teardown.handleCallback("CYPACK-1", deviceId, "cb-1"),
			).rejects.toThrow("azure unavailable");

			expect(eventsNamed("sandbox_destroyed")).toHaveLength(0);
			expect(eventsNamed("sandbox_teardown_completed")).toHaveLength(0);
		});
	});

	it("upgrades close to delete while otherwise keeping first-registration-wins", async () => {
		const { deviceId } = container();
		const bundle = join(artifactsDir, "CYPACK-1", "bundle.tar.gz");
		mkdirSync(join(artifactsDir, "CYPACK-1"), { recursive: true });
		writeFileSync(bundle, "bundle");
		const destroy = vi.fn(async () => {});
		const timers = {
			callbacks: [] as Array<() => void>,
			delays: [] as number[],
		};
		const teardown = coordinator(executor(destroy), timers);

		expect(
			teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" }),
		).toBe(true);
		expect(
			teardown.register({ issueKey: "CYPACK-1", deviceId, action: "deleted" }),
		).toBe(true);
		expect(
			teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" }),
		).toBe(false);
		expect(timers.delays).toEqual([600_000]);
		await teardown.handleCallback("CYPACK-1", deviceId);

		expect(destroy).toHaveBeenCalledTimes(1);
		expect(destroy).toHaveBeenCalledWith("CYPACK-1");
		expect(store.getDeviceInfo(deviceId)).toBeUndefined();
		expect(existsSync(bundle)).toBe(false);
	});

	it("removes a deleted issue bundle but retains a closed issue bundle", async () => {
		for (const [issueKey, action] of [
			["CYPACK-1", "deleted"],
			["CYPACK-2", "closed"],
		] as const) {
			const { deviceId } = container(issueKey);
			const bundle = join(artifactsDir, issueKey, "bundle.tar.gz");
			mkdirSync(join(artifactsDir, issueKey), { recursive: true });
			writeFileSync(bundle, "bundle");
			const teardown = coordinator(executor());
			teardown.register({ issueKey, deviceId, action });
			await teardown.handleCallback(issueKey, deviceId);
			expect(existsSync(bundle)).toBe(action === "closed");
		}
	});

	it("deletes a close-retained bundle later without recreating device state", async () => {
		const { deviceId } = container();
		const bundle = join(artifactsDir, "CYPACK-1", "bundle.tar.gz");
		mkdirSync(join(artifactsDir, "CYPACK-1"), { recursive: true });
		writeFileSync(bundle, "bundle");
		const teardown = coordinator(executor());
		teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" });
		await teardown.handleCallback("CYPACK-1", deviceId);
		expect(existsSync(bundle)).toBe(true);
		expect(store.getContainerDeviceForIssue("CYPACK-1")).toBeUndefined();

		await teardown.deleteRetainedBundle("CYPACK-1");
		expect(existsSync(bundle)).toBe(false);
		expect(store.getContainerDeviceForIssue("CYPACK-1")).toBeUndefined();
		await expect(teardown.deleteRetainedBundle("../other")).rejects.toThrow(
			"invalid issue key",
		);
	});

	it("retains the pending device row and retries promptly after destroy failure", async () => {
		const { deviceId } = container();
		const timers = {
			callbacks: [] as Array<() => void>,
			delays: [] as number[],
		};
		const destroy = vi
			.fn()
			.mockRejectedValueOnce(new Error("provider unavailable"))
			.mockResolvedValueOnce(undefined);
		const teardown = coordinator(executor(destroy), timers);
		teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" });

		await expect(teardown.handleCallback("CYPACK-1", deviceId)).rejects.toThrow(
			"provider unavailable",
		);

		expect(store.getDeviceInfo(deviceId)).toBeDefined();
		expect(teardown.has("CYPACK-1")).toBe(true);
		expect(timers.delays).toEqual([600_000, 60_000]);
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("retrying in 60000ms"),
			expect.anything(),
		);
		timers.callbacks[1]?.();
		await vi.waitFor(() => expect(destroy).toHaveBeenCalledTimes(2));
		expect(store.getDeviceInfo(deviceId)).toBeUndefined();
		expect(teardown.has("CYPACK-1")).toBe(false);
	});

	it("uses the same destroy flow when the deterministic grace timer expires", async () => {
		const { deviceId } = container();
		const timers = {
			callbacks: [] as Array<() => void>,
			delays: [] as number[],
		};
		const destroy = vi.fn(async () => {});
		const teardown = coordinator(executor(destroy), timers);
		teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" });

		timers.callbacks[0]?.();
		await vi.waitFor(() => expect(destroy).toHaveBeenCalledWith("CYPACK-1"));
		expect(store.getDeviceInfo(deviceId)).toBeUndefined();
	});

	it("does not overlap callback and timer destroy attempts", async () => {
		const { deviceId } = container();
		let release!: () => void;
		const destroy = vi.fn(
			() => new Promise<void>((resolve) => (release = resolve)),
		);
		const teardown = coordinator(executor(destroy));
		teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" });

		const first = teardown.handleCallback("CYPACK-1", deviceId);
		const second = teardown.handleCallback("CYPACK-1", deviceId);
		expect(destroy).toHaveBeenCalledTimes(1);
		release();
		await Promise.all([first, second]);
		expect(destroy).toHaveBeenCalledTimes(1);
	});

	it("consumes a retry without touching a replacement device generation", async () => {
		const original = container();
		const timers = {
			callbacks: [] as Array<() => void>,
			delays: [] as number[],
		};
		const destroy = vi.fn(async () => {
			throw new Error("temporary");
		});
		const teardown = coordinator(executor(destroy), timers);
		teardown.register({
			issueKey: "CYPACK-1",
			deviceId: original.deviceId,
			action: "closed",
		});
		await expect(
			teardown.handleCallback("CYPACK-1", original.deviceId),
		).rejects.toThrow("temporary");
		store.deleteContainerDevice(original.deviceId);
		const replacementUser = store.addUser({ email: "replacement@example.com" });
		const replacement = store.createContainerDevice(
			replacementUser.userId,
			"CYPACK-1",
			"docker",
		);

		timers.callbacks[1]?.();
		await vi.waitFor(() => expect(teardown.has("CYPACK-1")).toBe(false));
		expect(destroy).toHaveBeenCalledTimes(1);
		expect(store.getDeviceInfo(replacement.deviceId)).toBeDefined();
	});

	it("is a no-op if the device was manually destroyed during the grace window", async () => {
		const { deviceId } = container();
		const destroy = vi.fn(async () => {});
		const teardown = coordinator(executor(destroy));
		teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" });
		store.deleteContainerDevice(deviceId);

		await teardown.handleCallback("CYPACK-1", deviceId);
		expect(destroy).not.toHaveBeenCalled();
	});

	it("authenticates callbacks, scopes containers, and makes physical callbacks a 200 no-op", async () => {
		const { deviceId, deviceToken } = container();
		const destroy = vi.fn(async () => {});
		const teardown = coordinator(executor(destroy));
		teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" });
		const app = Fastify();
		registerTerminalTeardownRoute(app, store, teardown);
		await app.ready();

		expect(
			(
				await app.inject({
					method: "POST",
					url: "/containers/issues/CYPACK-1/teardown-complete",
					headers: { authorization: "Bearer stale" },
				})
			).statusCode,
		).toBe(401);
		expect(
			(
				await app.inject({
					method: "POST",
					url: "/containers/issues/OTHER-1/teardown-complete",
					headers: { authorization: `Bearer ${deviceToken}` },
				})
			).statusCode,
		).toBe(403);

		const physicalUser = store.addUser({ email: "physical@example.com" });
		const code = store.mintEnrollmentCode("physical@example.com", Date.now());
		const physical = store.redeemEnrollmentCode(code, Date.now());
		expect(physicalUser.userId).toBeGreaterThan(0);
		const physicalRes = await app.inject({
			method: "POST",
			url: "/containers/issues/CYPACK-1/teardown-complete",
			headers: { authorization: `Bearer ${physical?.deviceToken}` },
		});
		expect(physicalRes.statusCode).toBe(200);
		expect(destroy).not.toHaveBeenCalled();

		const callback = await app.inject({
			method: "POST",
			url: "/containers/issues/CYPACK-1/teardown-complete",
			headers: { authorization: `Bearer ${deviceToken}` },
		});
		expect(callback.statusCode).toBe(200);
		expect(destroy).toHaveBeenCalledTimes(1);
		await app.close();
	});

	it("returns 503 on immediate destroy failure while retaining the retry", async () => {
		const { deviceId, deviceToken } = container();
		const timers = {
			callbacks: [] as Array<() => void>,
			delays: [] as number[],
		};
		const teardown = coordinator(
			executor(
				vi.fn(async () => Promise.reject(new Error("azure unavailable"))),
			),
			timers,
		);
		teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" });
		const app = Fastify();
		registerTerminalTeardownRoute(app, store, teardown);

		const response = await app.inject({
			method: "POST",
			url: "/containers/issues/CYPACK-1/teardown-complete",
			headers: { authorization: `Bearer ${deviceToken}` },
		});
		expect(response.statusCode).toBe(503);
		expect(timers.delays).toEqual([600_000, 60_000]);
		expect(teardown.has("CYPACK-1")).toBe(true);
		await app.close();
	});

	it("clears a scheduled retry when stopped", async () => {
		const { deviceId } = container();
		const clearTimeout = vi.fn();
		const teardown = new TerminalTeardown({
			store,
			executors: new Map([
				[
					"docker",
					executor(vi.fn(async () => Promise.reject(new Error("offline")))),
				],
			]),
			artifactsDir,
			graceMs: 600_000,
			retryMs: 60_000,
			logger,
			setTimeout: (_callback, delay) => delay,
			clearTimeout,
		});
		teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" });
		await expect(teardown.handleCallback("CYPACK-1", deviceId)).rejects.toThrow(
			"offline",
		);

		teardown.stop();
		expect(clearTimeout).toHaveBeenCalledWith(600_000);
		expect(clearTimeout).toHaveBeenCalledWith(60_000);
		expect(teardown.has("CYPACK-1")).toBe(false);
	});

	/**
	 * The pending-teardown mirror exists for the out-of-process
	 * `cyrus router containers list`, which cannot see this object's in-memory
	 * map, and for telling a re-delivered worker callback apart from grace
	 * expiry in the router log.
	 */
	describe("persisted callback-pending state", () => {
		it("exposes callback-pending state, then flips to callback-received", async () => {
			const { deviceId, deviceToken } = container();
			const timers = {
				callbacks: [] as Array<() => void>,
				delays: [] as number[],
			};
			const destroy = vi
				.fn()
				.mockRejectedValueOnce(new Error("azure unavailable"));
			const teardown = coordinator(executor(destroy), timers);
			teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" });

			// Registered, worker has not reported in: the grace deadline is what
			// will force destruction.
			const registered = store.getPendingTeardown("CYPACK-1");
			expect(registered).toMatchObject({
				issueKey: "CYPACK-1",
				deviceId,
				action: "closed",
				deadlineMs: 601_000,
				callbackAttempts: 0,
			});
			expect(registered?.callbackReceivedMs).toBeUndefined();
			expect(store.listPendingTeardowns()).toHaveLength(1);

			const app = Fastify();
			registerTerminalTeardownRoute(app, store, teardown);
			const first = await app.inject({
				method: "POST",
				url: "/containers/issues/CYPACK-1/teardown-complete",
				headers: {
					authorization: `Bearer ${deviceToken}`,
					"x-cyrus-teardown-id": "cb-1",
				},
			});
			// The destroy failed, so the router keeps retrying — but the callback
			// itself was received and recorded.
			expect(first.statusCode).toBe(503);
			expect(store.getPendingTeardown("CYPACK-1")).toMatchObject({
				callbackId: "cb-1",
				callbackAttempts: 1,
			});
			expect(
				store.getPendingTeardown("CYPACK-1")?.callbackReceivedMs,
			).toBeDefined();
			await app.close();
		});

		it("logs a re-delivered callback as a retry, distinctly from grace expiry", async () => {
			const { deviceId } = container();
			const timers = {
				callbacks: [] as Array<() => void>,
				delays: [] as number[],
			};
			const destroy = vi.fn(async () => {
				throw new Error("azure unavailable");
			});
			const teardown = coordinator(executor(destroy), timers);
			teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" });

			await expect(
				teardown.handleCallback("CYPACK-1", deviceId, "cb-1"),
			).rejects.toThrow("azure unavailable");
			await expect(
				teardown.handleCallback("CYPACK-1", deviceId, "cb-1"),
			).rejects.toThrow("azure unavailable");

			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining("is a retry of callback cb-1 (delivery #2)"),
			);
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining("after callback retry"),
				expect.anything(),
			);
			// Grace expiry says something different: no worker ever reported in.
			expect(logger.error).not.toHaveBeenCalledWith(
				expect.stringContaining("Terminal teardown grace expired"),
				expect.anything(),
			);
			expect(store.getPendingTeardown("CYPACK-1")?.callbackAttempts).toBe(2);
		});

		it("clears the mirrored row once teardown completes", async () => {
			const { deviceId } = container();
			const teardown = coordinator(executor());
			teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" });
			expect(store.getPendingTeardown("CYPACK-1")).toBeDefined();

			await teardown.handleCallback("CYPACK-1", deviceId, "cb-1");

			expect(store.getPendingTeardown("CYPACK-1")).toBeUndefined();
			expect(store.listPendingTeardowns()).toEqual([]);
		});

		it("records an upgraded close→delete against the same row", () => {
			const { deviceId } = container();
			const teardown = coordinator(executor());
			teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" });
			teardown.register({ issueKey: "CYPACK-1", deviceId, action: "deleted" });
			expect(store.listPendingTeardowns()).toHaveLength(1);
			expect(store.getPendingTeardown("CYPACK-1")?.action).toBe("deleted");
		});

		it("rejects a malformed idempotency key rather than logging it", async () => {
			const { deviceId, deviceToken } = container();
			const teardown = coordinator(executor());
			teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" });
			const app = Fastify();
			registerTerminalTeardownRoute(app, store, teardown);

			const response = await app.inject({
				method: "POST",
				url: "/containers/issues/CYPACK-1/teardown-complete",
				headers: {
					authorization: `Bearer ${deviceToken}`,
					"x-cyrus-teardown-id": "not a key",
				},
			});
			expect(response.statusCode).toBe(400);
			expect(teardown.has("CYPACK-1")).toBe(true);
			await app.close();
		});

		it("clears ghost rows from a previous router process on construction", () => {
			const { deviceId } = container();
			store.upsertPendingTeardown({
				issueKey: "CYPACK-1",
				deviceId,
				action: "closed",
				registeredMs: 1,
				deadlineMs: 2,
			});
			// A fresh coordinator starts with no in-memory entries and no armed
			// grace timers, so a surviving row would misreport forever.
			coordinator(executor());
			expect(store.listPendingTeardowns()).toEqual([]);
			expect(logger.info).toHaveBeenCalledWith(
				expect.stringContaining(
					"Cleared 1 terminal teardown row(s) left by a previous router process",
				),
			);
		});

		it("drops the mirrored row when the container device row is deleted", () => {
			const { deviceId } = container();
			const teardown = coordinator(executor());
			teardown.register({ issueKey: "CYPACK-1", deviceId, action: "closed" });
			store.deleteContainerDevice(deviceId);
			expect(store.getPendingTeardown("CYPACK-1")).toBeUndefined();
		});
	});
});
