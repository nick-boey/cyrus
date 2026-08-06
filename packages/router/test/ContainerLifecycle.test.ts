import type {
	ContainerExecutor,
	ContainerStatus,
} from "cyrus-router-executors";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { ContainerLifecycle } from "../src/ContainerLifecycle.js";
import { RouterStore } from "../src/RouterStore.js";
import { type TestLogger, testLogger } from "./helpers/logger.js";

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
	let logger: TestLogger;
	let userId: number;

	beforeEach(() => {
		store = new RouterStore(":memory:");
		logger = testLogger();
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
			offlineAgeOutMs: 3_600_000,
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

	it("logs the inputs behind an idle-stop decision", async () => {
		// PAR-166 (2026-07-27): a live session was parked mid-task and the only
		// evidence left was `Idle-stopped container for PAR-166` — which records
		// none of the values the decision was made from. Reconstructing it after
		// the fact was impossible because the store had since been rewritten.
		// Every stop must be self-explanatory from its own log line.
		const { createdMs, deviceId } = makeContainerDevice("CYPACK-LOG", "docker");
		const docker = fakeExecutor("docker", { status: "running" });
		const idleStopMs = 900_000;
		const now = createdMs + idleStopMs + 1;
		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["docker", docker]]),
			idleStopMs,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			offlineAgeOutMs: 3_600_000,
			logger,
			now: () => now,
		});

		await lifecycle.sweep();

		const line = String(logger.info.mock.calls.at(-1)?.[0]);
		expect(line).toContain("CYPACK-LOG");
		expect(line).toContain(`device=${deviceId}`);
		expect(line).toContain("affinity=0");
		expect(line).toContain(`idleForMs=${idleStopMs + 1}`);
		expect(line).toContain(`idleStopMs=${idleStopMs}`);
		expect(line).toContain("status=running");
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
			offlineAgeOutMs: 3_600_000,
			logger,
			// Far past idleStopMs — would trigger idle-stop if affinity were ignored.
			now: () => createdMs + idleStopMs * 10,
		});

		await lifecycle.sweep();

		expect(docker.stop).not.toHaveBeenCalled();
		expect(docker.destroy).not.toHaveBeenCalled();
	});

	// ── parked devices ─────────────────────────────────────────────────────
	// A parked session releases affinity but is NOT finished. The idle clock
	// must therefore run from when it parked, not from the last route.

	it("does not idle-stop a device that parked recently, however old the last route", async () => {
		// The PAR-146 shape inverted: the agent worked for a long time and only
		// then asked its question. Clocking from lastRoutedMs would suspend it on
		// the very next sweep, the clock having expired while it was busy.
		const { createdMs, deviceId } = makeContainerDevice("PAR-146", "docker");
		const docker = fakeExecutor("docker", { status: "running" });
		const idleStopMs = 300_000;
		// No route since creation, so `createdMs` — 20 minutes stale — is the
		// timestamp the old clock would have used.
		const now = createdMs + 20 * 60_000;
		store.setDeviceParkedAt(deviceId, now - 120_000); // parked 2 minutes ago
		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["docker", docker]]),
			idleStopMs,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			offlineAgeOutMs: 3_600_000,
			logger,
			now: () => now,
		});

		await lifecycle.sweep();

		expect(docker.stop).not.toHaveBeenCalled();
	});

	it("idle-stops a device parked longer than idleStopMs", async () => {
		const { createdMs, deviceId } = makeContainerDevice("PAR-146", "docker");
		const docker = fakeExecutor("docker", { status: "running" });
		const idleStopMs = 300_000;
		const now = createdMs + 20 * 60_000;
		store.setDeviceParkedAt(deviceId, now - idleStopMs - 1);
		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["docker", docker]]),
			idleStopMs,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			offlineAgeOutMs: 3_600_000,
			logger,
			now: () => now,
		});

		await lifecycle.sweep();

		expect(docker.stop).toHaveBeenCalledWith("PAR-146");
	});

	it("never idle-stops a parked device that still holds affinity", async () => {
		// Belt and braces: the affinity gate is unchanged by the parked work, and
		// a device with any live session must survive however stale its stamps.
		const { createdMs, deviceId } = makeContainerDevice("PAR-146", "docker");
		store.setDeviceParkedAt(deviceId, createdMs);
		store.setSessionAffinity("sess-other", deviceId);
		const docker = fakeExecutor("docker", { status: "running" });
		const idleStopMs = 300_000;
		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["docker", docker]]),
			idleStopMs,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			offlineAgeOutMs: 3_600_000,
			logger,
			now: () => createdMs + idleStopMs * 10,
		});

		await lifecycle.sweep();

		expect(docker.stop).not.toHaveBeenCalled();
	});

	it("logs parkedAtMs alongside the other idle-stop inputs", async () => {
		const { createdMs, deviceId } = makeContainerDevice("PAR-LOG", "docker");
		const docker = fakeExecutor("docker", { status: "running" });
		const idleStopMs = 300_000;
		const now = createdMs + 20 * 60_000;
		const parkedAt = now - idleStopMs - 1;
		store.setDeviceParkedAt(deviceId, parkedAt);
		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["docker", docker]]),
			idleStopMs,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			offlineAgeOutMs: 3_600_000,
			logger,
			now: () => now,
		});

		await lifecycle.sweep();

		const line = String(logger.info.mock.calls.at(-1)?.[0]);
		expect(line).toContain(`parkedAtMs=${parkedAt}`);
		expect(line).toContain(`idleForMs=${idleStopMs + 1}`);
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
			offlineAgeOutMs: 3_600_000,
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
			offlineAgeOutMs: 3_600_000,
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
			offlineAgeOutMs: 3_600_000,
			logger,
			// Anchor to the good device's clock (broken device's createdMs is close
			// enough in wall-clock terms that it also qualifies as idle).
			now: () => goodCreatedMs + idleStopMs + 1,
		});

		await expect(lifecycle.sweep()).resolves.toBeUndefined();

		expect(goodDocker.stop).toHaveBeenCalledWith("CYPACK-GOOD");
		expect(brokenDocker.stop).not.toHaveBeenCalled();
		expect(logger.error).toHaveBeenCalled();
		expect(String(logger.error.mock.calls[0]?.[0])).toContain("CYPACK-BROKEN");
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
			offlineAgeOutMs: 3_600_000,
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
			offlineAgeOutMs: 3_600_000,
			logger,
			now: () => 1_000_000,
		});
		vi.spyOn(store, "listContainerDevices").mockImplementation(() => {
			throw new Error("SQLITE_BUSY");
		});

		await expect(lifecycle.sweep()).resolves.toBeUndefined();

		// The cause is now passed through as an Error arg rather than interpolated.
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("failed to list container devices"),
			expect.objectContaining({ message: "SQLITE_BUSY" }),
		);
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
			offlineAgeOutMs: 3_600_000,
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
			offlineAgeOutMs: 3_600_000,
			logger,
			now: () => 1_000_000,
		});

		await expect(lifecycle.sweep()).resolves.toBeUndefined();

		expect(goodDocker.destroy).toHaveBeenCalledWith("CYPACK-ORPHAN");
		expect(logger.error).toHaveBeenCalled();
	});

	// ── affinity reconciliation ────────────────────────────────────────────
	// Affinity clears only on a terminal frame the worker may never send, so a
	// leaked row pins its device out of idle-stop forever. The sweep therefore
	// re-derives the set from the device before applying its gate.

	it("idle-stops a parked device pinned only by a leaked affinity row", async () => {
		// PAR-146 (2026-08-02). Session A completed; a later prompt re-established
		// its affinity via routePrompted (affinity without an issue lock, logged
		// nowhere). Session B then parked. The sweep's affinity gate skipped the
		// device forever and it ran 28+ minutes at 4 vCPU / 8 GiB.
		const { deviceId, createdMs } = makeContainerDevice("PAR-146", "aca");
		const aca = fakeExecutor("aca", { status: "running" });
		const idleStopMs = 300_000;
		const now = createdMs + idleStopMs + 60_000;

		store.setSessionAffinity(
			"session-a-complete",
			deviceId,
			undefined,
			createdMs,
		);
		store.setDeviceParkedAt(deviceId, createdMs + 1_000);

		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["aca", aca]]),
			idleStopMs,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			offlineAgeOutMs: 3_600_000,
			logger,
			now: () => now,
			sessionReconciler: {
				isOnline: () => true,
				// The worker is up and reports it is running nothing.
				reconcile: async (id: number) => {
					store.clearSessionAffinity("session-a-complete");
					expect(id).toBe(deviceId);
					return 0;
				},
			},
		});

		await lifecycle.sweep();

		expect(aca.stop).toHaveBeenCalledWith("PAR-146");
	});

	it("never stops a device whose worker still declares a session", async () => {
		const { deviceId, createdMs } = makeContainerDevice("PAR-200", "aca");
		const aca = fakeExecutor("aca", { status: "running" });
		const idleStopMs = 300_000;

		store.setSessionAffinity("live", deviceId, undefined, createdMs);

		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["aca", aca]]),
			idleStopMs,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			offlineAgeOutMs: 3_600_000,
			logger,
			now: () => createdMs + idleStopMs * 100,
			sessionReconciler: { isOnline: () => true, reconcile: async () => 1 },
		});

		await lifecycle.sweep();

		expect(aca.stop).not.toHaveBeenCalled();
	});

	it("does not reconcile a device that has no affinity at all", async () => {
		const { createdMs } = makeContainerDevice("PAR-201", "aca");
		const aca = fakeExecutor("aca", { status: "running" });
		const reconcile = vi.fn(async () => 0);

		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["aca", aca]]),
			idleStopMs: 300_000,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			offlineAgeOutMs: 3_600_000,
			logger,
			now: () => createdMs + 300_001,
			sessionReconciler: { isOnline: () => true, reconcile },
		});

		await lifecycle.sweep();

		expect(reconcile).not.toHaveBeenCalled();
		expect(aca.stop).toHaveBeenCalledWith("PAR-201");
	});

	it("ages out affinity on an offline device so stale-destroy can proceed", async () => {
		const { deviceId, createdMs } = makeContainerDevice("PAR-202", "aca");
		const aca = fakeExecutor("aca", { status: "running" });
		const offlineAgeOutMs = 3_600_000;
		const reconcile = vi.fn(async () => 1);

		store.setSessionAffinity("orphan", deviceId, undefined, createdMs);

		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["aca", aca]]),
			idleStopMs: 300_000,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			offlineAgeOutMs,
			logger,
			now: () => createdMs + offlineAgeOutMs + 1,
			sessionReconciler: { isOnline: () => false, reconcile },
		});

		await lifecycle.sweep();

		// Never asked — the device is offline.
		expect(reconcile).not.toHaveBeenCalled();
		expect(aca.stop).toHaveBeenCalledWith("PAR-202");
		// The row itself survives; it carries creator_json for a session that may
		// still be legitimately re-prompted.
		expect(store.countSessionAffinityForDevice(deviceId)).toBe(1);
	});

	it("keeps an offline device pinned while its affinity is still fresh", async () => {
		const { deviceId, createdMs } = makeContainerDevice("PAR-203", "aca");
		const aca = fakeExecutor("aca", { status: "running" });
		const offlineAgeOutMs = 3_600_000;

		store.setSessionAffinity("recent", deviceId, undefined, createdMs);

		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["aca", aca]]),
			idleStopMs: 300_000,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			offlineAgeOutMs,
			logger,
			now: () => createdMs + offlineAgeOutMs - 1,
			sessionReconciler: { isOnline: () => false, reconcile: async () => 1 },
		});

		await lifecycle.sweep();

		expect(aca.stop).not.toHaveBeenCalled();
	});

	it("logs once when a device becomes pinned and once when it clears", async () => {
		const { deviceId, createdMs } = makeContainerDevice("PAR-204", "aca");
		const aca = fakeExecutor("aca", { status: "running" });
		let remaining = 1;

		store.setSessionAffinity("held", deviceId, undefined, createdMs);

		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["aca", aca]]),
			idleStopMs: 300_000,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			offlineAgeOutMs: 3_600_000,
			logger,
			now: () => createdMs + 300_001,
			sessionReconciler: {
				isOnline: () => true,
				reconcile: async () => remaining,
			},
		});

		await lifecycle.sweep();
		await lifecycle.sweep(); // still pinned — must NOT log again

		const pinnedLogs = logger.info.mock.calls.filter(([m]) =>
			String(m).includes("pinned out of idle-stop"),
		);
		expect(pinnedLogs).toHaveLength(1);
		expect(String(pinnedLogs[0]?.[0])).toContain("held");

		remaining = 0;
		store.clearSessionAffinity("held");
		await lifecycle.sweep();

		expect(
			logger.info.mock.calls.filter(([m]) =>
				String(m).includes("no longer pinned"),
			),
		).toHaveLength(1);
	});
});
