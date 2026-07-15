import type {
	ContainerExecutor,
	ContainerStatus,
} from "cyrus-router-executors";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { ContainerLifecycle } from "../src/ContainerLifecycle.js";
import { RouterStore } from "../src/RouterStore.js";

/**
 * Fake ContainerExecutor with vi.fn() methods and a scripted `status`. When
 * `statusOverride` is a function it's invoked per issueKey; otherwise the
 * same status is returned for every call.
 */
function fakeExecutor(
	provider: string,
	opts?: {
		status?: ContainerStatus | ((issueKey: string) => ContainerStatus);
		listManaged?: string[] | (() => string[]);
		stopImpl?: Mock;
		destroyImpl?: Mock;
		listManagedImpl?: Mock;
	},
): ContainerExecutor & {
	stop: Mock;
	destroy: Mock;
	status: Mock;
	listManaged: Mock;
} {
	return {
		provider,
		ensureRunning: vi.fn(async () => {}),
		stop: opts?.stopImpl ?? vi.fn(async () => {}),
		destroy: opts?.destroyImpl ?? vi.fn(async () => {}),
		status: vi.fn(async (issueKey: string): Promise<ContainerStatus> => {
			if (typeof opts?.status === "function") return opts.status(issueKey);
			return opts?.status ?? "running";
		}),
		listManaged:
			opts?.listManagedImpl ??
			vi.fn(async () => {
				const managed = opts?.listManaged ?? [];
				return typeof managed === "function" ? managed() : managed;
			}),
	};
}

describe("ContainerLifecycle", () => {
	let store: RouterStore;
	let logger: { info: Mock; warn: Mock };
	let userId: number;

	beforeEach(() => {
		store = new RouterStore(":memory:");
		logger = { info: vi.fn(), warn: vi.fn() };
		({ userId } = store.addUser({ email: "a@example.com" }));
	});

	/** Creates a container device row and returns its id + the real createdMs the store assigned it. */
	function makeContainerDevice(
		issueKey: string,
		provider: string,
	): { deviceId: number; createdMs: number } {
		const { deviceId } = store.createContainerDevice(
			userId,
			issueKey,
			provider,
		);
		const createdMs = store.getContainerDeviceForIssue(issueKey)?.createdMs;
		if (createdMs === undefined)
			throw new Error("device row missing after create");
		return { deviceId, createdMs };
	}

	it("idle-stops a container with no active affinity once past idleStopMs", async () => {
		const { createdMs, deviceId } = makeContainerDevice("CYPACK-1", "docker");
		const docker = fakeExecutor("docker", { status: "running" });
		const idleStopMs = 900_000;
		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["docker", docker]]),
			idleStopMs,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			logger,
			now: () => createdMs + idleStopMs + 1,
		});

		await lifecycle.sweep();

		expect(docker.stop).toHaveBeenCalledWith("CYPACK-1");
		expect(docker.destroy).not.toHaveBeenCalled();
		// Idle-stop parks the container — the device row is retained.
		expect(store.getContainerDeviceForIssue("CYPACK-1")?.deviceId).toBe(
			deviceId,
		);
	});

	it("never idle-stops a device with active session affinity, regardless of timestamps", async () => {
		const { createdMs } = makeContainerDevice("CYPACK-1", "docker");
		store.setSessionAffinity(
			"sess-1",
			store.getContainerDeviceForIssue("CYPACK-1")!.deviceId,
		);
		const docker = fakeExecutor("docker", { status: "running" });
		const idleStopMs = 900_000;
		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["docker", docker]]),
			idleStopMs,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			logger,
			// Far past idleStopMs — would trigger idle-stop if affinity were ignored.
			now: () => createdMs + idleStopMs * 10,
		});

		await lifecycle.sweep();

		expect(docker.stop).not.toHaveBeenCalled();
		expect(docker.destroy).not.toHaveBeenCalled();
	});

	it("stale-destroys a container past staleDestroyMs: destroy() + delete device row", async () => {
		const { createdMs } = makeContainerDevice("CYPACK-2", "docker");
		const docker = fakeExecutor("docker", { status: "stopped" });
		const staleDestroyMs = 5_000;
		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["docker", docker]]),
			idleStopMs: 900_000,
			staleDestroyMs,
			logger,
			now: () => createdMs + staleDestroyMs + 1,
		});

		await lifecycle.sweep();

		expect(docker.destroy).toHaveBeenCalledWith("CYPACK-2");
		expect(docker.stop).not.toHaveBeenCalled();
		expect(store.getContainerDeviceForIssue("CYPACK-2")).toBeUndefined();
	});

	it("never stale-destroys a device with active session affinity, regardless of timestamps", async () => {
		const { createdMs, deviceId } = makeContainerDevice("CYPACK-2", "docker");
		store.setSessionAffinity("sess-1", deviceId);
		const docker = fakeExecutor("docker", { status: "stopped" });
		const staleDestroyMs = 5_000;
		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["docker", docker]]),
			idleStopMs: 900_000,
			staleDestroyMs,
			logger,
			// Far past staleDestroyMs — would trigger stale-destroy if affinity were ignored.
			now: () => createdMs + staleDestroyMs * 10,
		});

		await lifecycle.sweep();

		expect(docker.destroy).not.toHaveBeenCalled();
		expect(docker.stop).not.toHaveBeenCalled();
		expect(store.getContainerDeviceForIssue("CYPACK-2")?.deviceId).toBe(
			deviceId,
		);
	});

	it("orphan-GCs a provider-managed container with no matching device row", async () => {
		// No device rows in the store at all — "CYPACK-9" is a container the
		// provider still owns (e.g. its device row was manually destroyed via
		// the CLI, or the owning user was revokeDevice'd).
		const docker = fakeExecutor("docker", { listManaged: ["CYPACK-9"] });
		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["docker", docker]]),
			idleStopMs: 900_000,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			logger,
			now: () => 1_000_000,
		});

		await lifecycle.sweep();

		expect(docker.destroy).toHaveBeenCalledWith("CYPACK-9");
	});

	it("does not orphan-GC a managed container that still has a device row", async () => {
		makeContainerDevice("CYPACK-3", "docker");
		const docker = fakeExecutor("docker", {
			status: "stopped",
			listManaged: ["CYPACK-3"],
		});
		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["docker", docker]]),
			idleStopMs: 14 * 24 * 60 * 60_000, // far in the future — no idle/stale firing
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			logger,
			now: () => 1_000_000,
		});

		await lifecycle.sweep();

		expect(docker.destroy).not.toHaveBeenCalled();
	});

	it("logs and skips a throwing executor during the per-device sweep, without aborting other devices", async () => {
		const brokenDevice = makeContainerDevice("CYPACK-BROKEN", "brokenDocker");
		const { createdMs: goodCreatedMs } = makeContainerDevice(
			"CYPACK-GOOD",
			"goodDocker",
		);
		const idleStopMs = 900_000;

		const brokenDocker = fakeExecutor("brokenDocker", {
			status: () => {
				throw new Error("daemon unreachable");
			},
		});
		const goodDocker = fakeExecutor("goodDocker", { status: "running" });

		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([
				["brokenDocker", brokenDocker],
				["goodDocker", goodDocker],
			]),
			idleStopMs,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			logger,
			// Anchor to the good device's clock (broken device's createdMs is close
			// enough in wall-clock terms that it also qualifies as idle).
			now: () => goodCreatedMs + idleStopMs + 1,
		});

		await expect(lifecycle.sweep()).resolves.toBeUndefined();

		expect(goodDocker.stop).toHaveBeenCalledWith("CYPACK-GOOD");
		expect(brokenDocker.stop).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalled();
		expect(String(logger.warn.mock.calls[0]?.[0])).toContain("CYPACK-BROKEN");
		// The broken device's row survives — the error was skipped, not applied.
		expect(store.getContainerDeviceForIssue("CYPACK-BROKEN")?.deviceId).toBe(
			brokenDevice.deviceId,
		);
	});

	it("does not destroy an orphan whose device row was created concurrently mid-sweep (TOCTOU race)", async () => {
		// Simulates the real race: sweep() snapshots `knownKeys` at the top
		// (empty here — no device rows exist yet), then while the orphan-GC
		// loop is awaiting listManaged(), a concurrent route for the same
		// issue lands (ContainerTargetService.ensureDevice() writes the device
		// row, boot() starts ensureRunning()) and the new container becomes
		// visible to listManaged() before it ever existed in the stale
		// snapshot. The store must have the final say, not the snapshot.
		const docker = fakeExecutor("docker", {
			listManagedImpl: vi.fn(async () => {
				// Side effect standing in for the concurrent route landing
				// mid-sweep, after knownKeys was already captured.
				store.createContainerDevice(userId, "CYPACK-RACE", "docker");
				return ["CYPACK-RACE"];
			}),
		});
		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["docker", docker]]),
			idleStopMs: 900_000,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			logger,
			now: () => 1_000_000,
		});

		await lifecycle.sweep();

		expect(docker.destroy).not.toHaveBeenCalled();
		// The concurrently-created device row must survive untouched.
		expect(store.getContainerDeviceForIssue("CYPACK-RACE")).toBeDefined();
	});

	it("logs and returns cleanly when listContainerDevices throws, instead of rejecting the sweep", async () => {
		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>(),
			idleStopMs: 900_000,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			logger,
			now: () => 1_000_000,
		});
		vi.spyOn(store, "listContainerDevices").mockImplementation(() => {
			throw new Error("SQLITE_BUSY");
		});

		await expect(lifecycle.sweep()).resolves.toBeUndefined();

		expect(logger.warn).toHaveBeenCalled();
		expect(String(logger.warn.mock.calls[0]?.[0])).toContain("SQLITE_BUSY");
	});

	it("idle-stops off a stale lastRoutedMs even when lastSeenMs is fresh (idle-stop deliberately ignores lastSeenMs)", async () => {
		// Locks in the documented asymmetry: idle-stop uses
		// `lastRoutedMs ?? createdMs` only. A container that is merely
		// connected (fresh lastSeenMs, e.g. a heartbeat) but hasn't been
		// routed anything recently must still be idle-stopped — a future
		// "fix" that folds lastSeenMs into idle-stop would silently keep
		// idle-but-connected containers running forever.
		const { createdMs, deviceId } = makeContainerDevice("CYPACK-5", "docker");
		const idleStopMs = 900_000;

		// Routed once, shortly after creation — stale relative to `now` below.
		store.enqueueEvent(deviceId, "{}", createdMs + 1_000, 48 * 60 * 60_000);
		const now = createdMs + idleStopMs * 5;
		// Seen (connected/heartbeated) moments before `now` — fresh.
		store.touchDevice(deviceId, now - 1_000);

		const docker = fakeExecutor("docker", { status: "running" });
		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["docker", docker]]),
			idleStopMs,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			logger,
			now: () => now,
		});

		await lifecycle.sweep();

		expect(docker.stop).toHaveBeenCalledWith("CYPACK-5");
		expect(docker.destroy).not.toHaveBeenCalled();
	});

	it("does not sweep a brand-new container (no lastRoutedMs/lastSeenMs) under a realistic post-creation clock", async () => {
		const { createdMs, deviceId } = makeContainerDevice("CYPACK-6", "docker");
		const idleStopMs = 900_000;
		const staleDestroyMs = 14 * 24 * 60 * 60_000;
		const docker = fakeExecutor("docker", { status: "running" });
		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["docker", docker]]),
			idleStopMs,
			staleDestroyMs,
			logger,
			// A realistic clock: a few seconds after creation, not artificially
			// advanced — well within both idleStopMs and staleDestroyMs.
			now: () => createdMs + 5_000,
		});

		await lifecycle.sweep();

		expect(docker.stop).not.toHaveBeenCalled();
		expect(docker.destroy).not.toHaveBeenCalled();
		expect(store.getContainerDeviceForIssue("CYPACK-6")?.deviceId).toBe(
			deviceId,
		);
	});

	it("logs and skips a throwing executor during orphan GC, without aborting GC for other providers", async () => {
		const brokenDocker = fakeExecutor("brokenDocker", {
			listManagedImpl: vi.fn(async () => {
				throw new Error("daemon unreachable");
			}),
		});
		const goodDocker = fakeExecutor("goodDocker", {
			listManaged: ["CYPACK-ORPHAN"],
		});

		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([
				["brokenDocker", brokenDocker],
				["goodDocker", goodDocker],
			]),
			idleStopMs: 900_000,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			logger,
			now: () => 1_000_000,
		});

		await expect(lifecycle.sweep()).resolves.toBeUndefined();

		expect(goodDocker.destroy).toHaveBeenCalledWith("CYPACK-ORPHAN");
		expect(logger.warn).toHaveBeenCalled();
	});
});
