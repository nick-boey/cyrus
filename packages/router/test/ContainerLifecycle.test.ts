import type {
	ContainerExecutor,
	ContainerStatus,
	ManagedContainerState,
} from "cyrus-router-executors";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { ContainerLifecycle } from "../src/ContainerLifecycle.js";
import { RouterStore } from "../src/RouterStore.js";
import { eventsNamed, type TestLogger, testLogger } from "./helpers/logger.js";

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
		/** Omitted leaves the executor WITHOUT the optional bulk-state seam, so
		 *  the sweep falls back to `listManaged` and reports state as unknown. */
		listStates?: ManagedContainerState[] | (() => ManagedContainerState[]);
		listStatesImpl?: Mock;
	},
): ContainerExecutor & {
	stop: Mock;
	destroy: Mock;
	status: Mock;
	listManaged: Mock;
	listStates?: Mock;
} {
	const listStatesImpl =
		opts?.listStatesImpl ??
		(opts?.listStates
			? vi.fn(async () => {
					const states = opts.listStates ?? [];
					return typeof states === "function" ? states() : states;
				})
			: undefined);
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
		...(listStatesImpl ? { listStates: listStatesImpl } : {}),
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

	it("skips a tick while the previous sweep is still running", async () => {
		// WAG-10 (2026-08-06): a single stop() blocked on the ACA provider's
		// per-issue lock for longer than the 60s sweep interval, so ticks
		// overlapped and each one queued ANOTHER stop() behind that same lock.
		// The queue then grew faster than it drained and TerminalTeardown's
		// destroy() — which takes the same lock — never reached the front, leaving
		// a 4 vCPU sandbox Running for hours after its issue went Done.
		const { createdMs } = makeContainerDevice("CYPACK-SLOW", "docker");
		const idleStopMs = 900_000;
		let releaseStop!: () => void;
		let firstStopSeen = false;
		// Only the FIRST stop() blocks — that is the slow provider call. Later
		// ones resolve so the "sweeping resumes" assertion below can be awaited.
		const stopImpl = vi.fn(() => {
			if (firstStopSeen) return Promise.resolve();
			firstStopSeen = true;
			return new Promise<void>((resolve) => {
				releaseStop = resolve;
			});
		});
		const docker = fakeExecutor("docker", { status: "running", stopImpl });
		const lifecycle = new ContainerLifecycle({
			store,
			executors: new Map<string, ContainerExecutor>([["docker", docker]]),
			idleStopMs,
			staleDestroyMs: 14 * 24 * 60 * 60_000,
			offlineAgeOutMs: 3_600_000,
			logger,
			now: () => createdMs + idleStopMs + 1,
		});

		const first = lifecycle.sweep();
		// Let the first tick get as far as the (never-resolving) stop().
		await vi.waitFor(() => expect(stopImpl).toHaveBeenCalledTimes(1));

		// Two more interval ticks land while the first is still blocked.
		await lifecycle.sweep();
		await lifecycle.sweep();
		expect(stopImpl).toHaveBeenCalledTimes(1);
		expect(
			logger.warn.mock.calls.map((call) => String(call[0])).join("\n"),
		).toContain("skipping this tick");

		releaseStop();
		await first;

		// Once the slow tick finishes, sweeping resumes normally.
		await lifecycle.sweep();
		expect(stopImpl).toHaveBeenCalledTimes(2);
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

	describe("sandbox telemetry", () => {
		/**
		 * The gauge exists to answer "how many sandboxes are open, for which
		 * issues, holding how many sessions". It must therefore sample EVERY
		 * device row — including the pinned ones, which are precisely the
		 * sandboxes actively burning 4 vCPU. An early `continue` on the pinned
		 * branch would leave the gauge counting only idle sandboxes.
		 */
		it("emits one gauge sample per sandbox, including sandboxes pinned by a live session", async () => {
			const pinned = makeContainerDevice("NOR-1", "aca");
			const idle = makeContainerDevice("NOR-2", "aca");
			store.setSessionAffinity(
				"s-1",
				pinned.deviceId,
				undefined,
				pinned.createdMs,
			);

			const aca = fakeExecutor("aca", {
				listStates: [
					{ issueKey: "NOR-1", status: "running", providerState: "Running" },
					{ issueKey: "NOR-2", status: "stopped", providerState: "Suspended" },
				],
			});
			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs: 300_000,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => pinned.createdMs + 60_000,
				sessionReconciler: { isOnline: () => true, reconcile: async () => 1 },
			});

			await lifecycle.sweep();

			const samples = eventsNamed(logger, "sandbox.gauge");
			expect(samples).toHaveLength(2);
			expect(samples.find((s) => s.issue_key === "NOR-1")).toMatchObject({
				device_id: pinned.deviceId,
				provider: "aca",
				state: "running",
				sessions: 1,
				online: true,
			});
			expect(samples.find((s) => s.issue_key === "NOR-2")).toMatchObject({
				device_id: idle.deviceId,
				state: "stopped",
				sessions: 0,
			});
			expect(lifecycle.getSandboxObservation(pinned.deviceId)).toEqual({
				state: "running",
				observedMs: pinned.createdMs + 60_000,
			});
			expect(lifecycle.getSandboxObservation(idle.deviceId)).toEqual({
				state: "stopped",
				observedMs: pinned.createdMs + 60_000,
			});
		});

		/**
		 * The cost constraint the gauge was designed around: one bulk provider
		 * call per tick, not one `status()` per sandbox. At ARM request rates a
		 * per-row fan-out would throttle exactly when the fleet is largest.
		 */
		it("reads provider state with ONE bulk call for the whole fleet, not one status() per sandbox", async () => {
			for (const key of ["NOR-1", "NOR-2", "NOR-3"]) {
				makeContainerDevice(key, "aca");
			}
			const aca = fakeExecutor("aca", {
				listStates: [
					{ issueKey: "NOR-1", status: "running" },
					{ issueKey: "NOR-2", status: "running" },
					{ issueKey: "NOR-3", status: "running" },
				],
			});
			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs: 300_000,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => Date.now(),
			});

			await lifecycle.sweep();

			expect(aca.listStates).toHaveBeenCalledTimes(1);
			expect(aca.status).not.toHaveBeenCalled();
			// The same response feeds orphan GC, so the sweep does not list twice.
			expect(aca.listManaged).not.toHaveBeenCalled();
		});

		it("starts the uptime clock when the provider reports a sandbox running", async () => {
			const { createdMs } = makeContainerDevice("NOR-1", "aca");
			const aca = fakeExecutor("aca", {
				listStates: [{ issueKey: "NOR-1", status: "running" }],
			});
			const now = createdMs + 60_000;
			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs: 300_000,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => now,
			});

			await lifecycle.sweep();

			expect(store.getContainerDeviceForIssue("NOR-1")?.runningSinceMs).toBe(
				now,
			);
		});

		/**
		 * Uptime is CONTINUOUS running time, so the clock must survive repeated
		 * sweeps. Re-stamping it every tick would cap every reported uptime at one
		 * sweep interval and the 6-hour alert could never fire.
		 */
		it("does not restart the uptime clock on subsequent sweeps", async () => {
			const { createdMs } = makeContainerDevice("NOR-1", "aca");
			const aca = fakeExecutor("aca", {
				listStates: [{ issueKey: "NOR-1", status: "running" }],
			});
			let now = createdMs + 60_000;
			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs: 24 * 60 * 60_000,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => now,
			});

			await lifecycle.sweep();
			const startedAt =
				store.getContainerDeviceForIssue("NOR-1")?.runningSinceMs;
			now = createdMs + 6 * 60 * 60_000;
			await lifecycle.sweep();

			expect(store.getContainerDeviceForIssue("NOR-1")?.runningSinceMs).toBe(
				startedAt,
			);
			const latest = eventsNamed(logger, "sandbox.gauge").at(-1);
			expect(latest?.uptime_ms).toBe(now - (startedAt ?? 0));
		});

		it("stops the uptime clock when the provider reports the sandbox no longer running", async () => {
			const { createdMs } = makeContainerDevice("NOR-1", "aca");
			let running = true;
			const aca = fakeExecutor("aca", {
				listStates: () => [
					{ issueKey: "NOR-1", status: running ? "running" : "stopped" },
				],
			});
			let now = createdMs + 60_000;
			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs: 24 * 60 * 60_000,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => now,
			});

			await lifecycle.sweep();
			running = false;
			now += 60_000;
			await lifecycle.sweep();

			expect(
				store.getContainerDeviceForIssue("NOR-1")?.runningSinceMs,
			).toBeUndefined();
			expect(eventsNamed(logger, "sandbox.gauge").at(-1)?.uptime_ms).toBeNull();
		});

		/**
		 * One throttled ARM call must not be able to silently reset every uptime
		 * in the fleet — which is what would happen if an unreadable provider were
		 * treated as "nothing is running".
		 */
		it("reports state as unknown and preserves the uptime clock when the provider cannot be listed", async () => {
			const { createdMs } = makeContainerDevice("NOR-1", "aca");
			let fail = false;
			const aca = fakeExecutor("aca", {
				listStatesImpl: vi.fn(async () => {
					if (fail) throw new Error("ARM 429");
					return [{ issueKey: "NOR-1", status: "running" as const }];
				}),
			});
			let now = createdMs + 60_000;
			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs: 24 * 60 * 60_000,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => now,
			});

			await lifecycle.sweep();
			const startedAt =
				store.getContainerDeviceForIssue("NOR-1")?.runningSinceMs;
			fail = true;
			now += 60_000;
			await lifecycle.sweep();

			expect(store.getContainerDeviceForIssue("NOR-1")?.runningSinceMs).toBe(
				startedAt,
			);
			expect(eventsNamed(logger, "sandbox.gauge").at(-1)?.state).toBe(
				"unknown",
			);
		});

		it("reports state as unknown for a provider with no bulk-state seam rather than guessing", async () => {
			makeContainerDevice("NOR-1", "legacy");
			const legacy = fakeExecutor("legacy", { listManaged: ["NOR-1"] });
			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["legacy", legacy]]),
				idleStopMs: 24 * 60 * 60_000,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => Date.now(),
			});

			await lifecycle.sweep();

			expect(legacy.listManaged).toHaveBeenCalledTimes(1);
			expect(eventsNamed(logger, "sandbox.gauge").at(-1)?.state).toBe(
				"unknown",
			);
		});

		it("reports a device row whose provider no longer has the container as absent", async () => {
			makeContainerDevice("NOR-1", "aca");
			const aca = fakeExecutor("aca", { listStates: [] });
			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs: 24 * 60 * 60_000,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => Date.now(),
			});

			await lifecycle.sweep();

			expect(eventsNamed(logger, "sandbox.gauge").at(-1)?.state).toBe("absent");
		});

		/**
		 * The rollup the "sweep stalled" alert keys on. It must be emitted on
		 * EVERY tick, including a tick with no sandboxes at all — otherwise a
		 * quiet fleet is indistinguishable from a router that stopped sweeping,
		 * and every other sandbox alert is silently blind.
		 */
		it("emits the per-tick rollup even when no sandboxes exist", async () => {
			const aca = fakeExecutor("aca", { listStates: [] });
			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs: 300_000,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => Date.now(),
			});

			await lifecycle.sweep();

			const rollups = eventsNamed(logger, "sandbox.sweep_completed");
			expect(rollups).toHaveLength(1);
			expect(rollups[0]).toMatchObject({
				sandboxes: 0,
				running: 0,
				pinned: 0,
			});
		});

		it("counts sandboxes by state and pinned-ness in the rollup", async () => {
			const pinned = makeContainerDevice("NOR-1", "aca");
			makeContainerDevice("NOR-2", "aca");
			store.setSessionAffinity(
				"s-1",
				pinned.deviceId,
				undefined,
				pinned.createdMs,
			);
			const aca = fakeExecutor("aca", {
				listStates: [
					{ issueKey: "NOR-1", status: "running" },
					{ issueKey: "NOR-2", status: "stopped" },
				],
			});
			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs: 300_000,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => pinned.createdMs + 60_000,
				sessionReconciler: { isOnline: () => true, reconcile: async () => 1 },
			});

			await lifecycle.sweep();

			expect(eventsNamed(logger, "sandbox.sweep_completed")[0]).toMatchObject({
				sandboxes: 2,
				running: 1,
				stopped: 1,
				pinned: 1,
			});
		});

		it("emits an idle-stop event carrying the uptime of the run it ends, and stops the clock", async () => {
			const { createdMs } = makeContainerDevice("NOR-1", "aca");
			const aca = fakeExecutor("aca", {
				status: "running",
				listStates: [{ issueKey: "NOR-1", status: "running" }],
			});
			const idleStopMs = 300_000;
			let now = createdMs + 1_000;
			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => now,
			});

			// First tick starts the clock while the container is still young.
			await lifecycle.sweep();
			now = createdMs + idleStopMs + 1_000;
			await lifecycle.sweep();

			expect(aca.stop).toHaveBeenCalledWith("NOR-1");
			const [idleStop] = eventsNamed(logger, "sandbox.idle_stopped");
			expect(idleStop).toMatchObject({
				issue_key: "NOR-1",
				provider: "aca",
				idle_stop_ms: idleStopMs,
				uptime_ms: idleStopMs,
			});
			expect(
				store.getContainerDeviceForIssue("NOR-1")?.runningSinceMs,
			).toBeUndefined();
		});

		it("emits a destroy event naming why the container was reclaimed", async () => {
			const { createdMs } = makeContainerDevice("NOR-1", "aca");
			const aca = fakeExecutor("aca", {
				listStates: [{ issueKey: "NOR-1", status: "stopped" }],
			});
			const staleDestroyMs = 14 * 24 * 60 * 60_000;
			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs: 300_000,
				staleDestroyMs,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => createdMs + staleDestroyMs + 1_000,
			});

			await lifecycle.sweep();

			expect(eventsNamed(logger, "sandbox.destroyed")[0]).toMatchObject({
				issue_key: "NOR-1",
				reason: "stale",
			});
		});

		it("emits a destroy event with a null device id for an orphan container", async () => {
			const aca = fakeExecutor("aca", {
				listStates: [{ issueKey: "GHOST-1", status: "running" }],
			});
			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs: 300_000,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => Date.now(),
			});

			await lifecycle.sweep();

			expect(aca.destroy).toHaveBeenCalledWith("GHOST-1");
			expect(eventsNamed(logger, "sandbox.destroyed")[0]).toMatchObject({
				issue_key: "GHOST-1",
				device_id: null,
				reason: "orphan",
			});
		});
	});

	// ── NOR-366: the implement -> review handoff ───────────────────────────
	// A follow-up session started moments after the previous one on the same
	// issue ended was reliably killed within seconds. Two independent causes,
	// each sufficient on its own, so each gets its own tests.

	describe("idle clock resets on session activity", () => {
		it("does not idle-stop a container that was busy on the previous tick, however old it is", async () => {
			// THE defect. The router stamps `last_routed_ms` when it hands a device
			// an event and nothing thereafter, so an agent that works for 30 minutes
			// without a new prompt leaves every clock frozen at its start: in every
			// observed kill, `idle_for_ms` equalled `age_ms` to the millisecond. The
			// container was past `idleStopMs` the entire time it was busy, and only
			// the affinity pin stood between it and a stop.
			const { deviceId, createdMs } = makeContainerDevice("CAN-69", "aca");
			const aca = fakeExecutor("aca", { status: "running" });
			const idleStopMs = 300_000;
			let now = createdMs + 1_000;

			store.setSessionAffinity("implement", deviceId, undefined, createdMs);

			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => now,
				sessionReconciler: { isOnline: () => true, reconcile: async () => 1 },
			});

			// 30 minutes of continuous work, six times longer than idleStopMs.
			for (let tick = 0; tick < 30; tick++) {
				now = createdMs + tick * 60_000;
				await lifecycle.sweep();
			}
			expect(aca.stop).not.toHaveBeenCalled();

			// The implementation session ends. The very next tick is the one that
			// used to stop the container, because its clock had expired 25 minutes
			// earlier. It must not: the container was working one tick ago.
			store.clearSessionAffinity("implement");
			now = createdMs + 30 * 60_000;
			await lifecycle.sweep();

			expect(aca.stop).not.toHaveBeenCalled();
			// And the window it gets is the FULL threshold, not whatever was left.
			now = createdMs + 29 * 60_000 + idleStopMs;
			await lifecycle.sweep();
			expect(aca.stop).not.toHaveBeenCalled();
		});

		it("still idle-stops once a full idleStopMs passes with no session", async () => {
			// The other half of the contract: `idle_stopped` is NOT always a fault.
			// A sandbox whose session legitimately completed must still be parked,
			// or the fix above trades a correctness bug for a cost one.
			const { deviceId, createdMs } = makeContainerDevice("CAN-70", "aca");
			const aca = fakeExecutor("aca", { status: "running" });
			const idleStopMs = 300_000;
			let now = createdMs + 1_000;

			store.setSessionAffinity("done", deviceId, undefined, createdMs);

			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => now,
				sessionReconciler: { isOnline: () => true, reconcile: async () => 1 },
			});

			await lifecycle.sweep();
			const lastBusyMs = now;
			store.clearSessionAffinity("done");

			now = lastBusyMs + idleStopMs + 1;
			await lifecycle.sweep();

			expect(aca.stop).toHaveBeenCalledWith("CAN-70");
		});

		it("resets the idle clock the moment a session claims the device, before any sweep sees it", async () => {
			// The pin is only ever OBSERVED on the next tick, so the store write has
			// to carry the reset on its own — otherwise there is a whole sweep
			// interval in which the container is unpinned and already expired.
			const { deviceId, createdMs } = makeContainerDevice("CAN-94", "aca");
			const claimedMs = createdMs + 30 * 60_000;

			expect(
				store.getContainerDeviceForIssue("CAN-94")?.lastActiveMs,
			).toBeUndefined();

			store.setSessionAffinity("review", deviceId, undefined, claimedMs);

			expect(store.getContainerDeviceForIssue("CAN-94")?.lastActiveMs).toBe(
				claimedMs,
			);
		});
	});

	describe("sessions claimed while the sweep is deciding", () => {
		it("abandons an idle-stop when a session claims the device mid-sweep", async () => {
			// CAN-98: created 02:32:28, idle-stopped 02:32:31, pinned 02:32:33. The
			// affinity gate runs before two awaits — the reconciler's round trip to
			// the device, then status() — and a session claimed during them is
			// invisible to it.
			const { deviceId, createdMs } = makeContainerDevice("CAN-98", "aca");
			const idleStopMs = 300_000;
			const now = createdMs + idleStopMs + 1;

			// The review session lands while the provider is answering status().
			const aca = fakeExecutor("aca", { status: "running" });
			aca.status.mockImplementation(async () => {
				store.setSessionAffinity("review", deviceId, undefined, now);
				return "running";
			});

			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => now,
			});

			await lifecycle.sweep();

			expect(aca.stop).not.toHaveBeenCalled();
			expect(
				logger.info.mock.calls.filter(([m]) =>
					String(m).includes("Skipped idle-stop of CAN-98"),
				),
			).toHaveLength(1);
		});

		it("still ages out an offline device's affinity rather than treating them as a mid-sweep claim", async () => {
			// The re-check must key on sessions MISSING from the pre-decision
			// snapshot, not on "any affinity at all". Both the offline age-out and
			// the reconciler's leaked-row reclaim reach the stop with rows still in
			// the table on purpose, and a blanket re-check would restore the exact
			// permanent pin those mechanisms exist to break (PAR-146).
			const { deviceId, createdMs } = makeContainerDevice("PAR-146b", "aca");
			const aca = fakeExecutor("aca", { status: "running" });
			const offlineAgeOutMs = 3_600_000;

			store.setSessionAffinity("aged-out", deviceId, undefined, createdMs);

			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs: 300_000,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs,
				logger,
				now: () => createdMs + offlineAgeOutMs + 1,
				sessionReconciler: { isOnline: () => false, reconcile: async () => 1 },
			});

			await lifecycle.sweep();

			expect(aca.stop).toHaveBeenCalledWith("PAR-146b");
			expect(store.countSessionAffinityForDevice(deviceId)).toBe(1);
		});
	});

	describe("stranded sessions", () => {
		/**
		 * A clock comfortably past the 10-minute stranded grace but still WELL
		 * inside `offlineAgeOutMs` (1 hour). These devices are offline by
		 * construction, so a clock past the age-out would resolve their affinity to
		 * zero and the assertions would pass for the wrong reason — never reaching
		 * the branch under test at all.
		 */
		const PAST_GRACE_MS = 700_000;

		/** A device holding affinity for a sandbox its provider reports stopped. */
		function strandedFixture(issueKey: string, state: "stopped" | "absent") {
			const { deviceId, createdMs } = makeContainerDevice(issueKey, "aca");
			const aca = fakeExecutor("aca", {
				status: "stopped",
				listStates: state === "stopped" ? [{ issueKey, status: state }] : [],
			});
			store.setSessionAffinity("orphaned", deviceId, undefined, createdMs);
			return { deviceId, createdMs, aca };
		}

		function strandedLifecycle(
			aca: ContainerExecutor,
			now: () => number,
			graceMs = 600_000,
		) {
			return new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs: 300_000,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				strandedSessionGraceMs: graceMs,
				logger,
				now,
				sessionReconciler: { isOnline: () => false, reconcile: async () => 1 },
			});
		}

		it("reports a stopped, offline sandbox that still holds session affinity", async () => {
			// The state CAN-95 sat in across four consecutive sweeps with no signal
			// of any kind: `state=stopped sessions=1 online=false`. Linear renders a
			// normal in-progress agent session throughout.
			const { deviceId, createdMs, aca } = strandedFixture("CAN-95", "stopped");
			const graceMs = 600_000;
			const now = createdMs + graceMs + 1;

			await strandedLifecycle(aca, () => now, graceMs).sweep();

			expect(eventsNamed(logger, "sandbox.stranded_session")[0]).toMatchObject({
				issue_key: "CAN-95",
				device_id: deviceId,
				provider: "aca",
				state: "stopped",
				sessions: 1,
				stranded_for_ms: graceMs + 1,
			});
			expect(
				logger.error.mock.calls.filter(([m]) =>
					String(m).includes("still holds 1 session affinity row(s)"),
				),
			).toHaveLength(1);
		});

		it("reports it every tick but only logs the error once", async () => {
			// The event feeds an alert rule, which needs a non-zero count in its
			// window; the ERROR line is for a human reading the console and must not
			// repeat every 60 seconds for hours.
			const { createdMs, aca } = strandedFixture("CAN-95", "stopped");
			const graceMs = 600_000;
			let now = createdMs + graceMs + 1;
			const lifecycle = strandedLifecycle(aca, () => now, graceMs);

			await lifecycle.sweep();
			now += 60_000;
			await lifecycle.sweep();
			now += 60_000;
			await lifecycle.sweep();

			expect(eventsNamed(logger, "sandbox.stranded_session")).toHaveLength(3);
			expect(
				logger.error.mock.calls.filter(([m]) =>
					String(m).includes("still holds"),
				),
			).toHaveLength(1);
		});

		it("reports a sandbox the provider no longer has at all", async () => {
			const { createdMs, aca } = strandedFixture("CAN-96", "absent");
			const graceMs = 600_000;

			await strandedLifecycle(
				aca,
				() => createdMs + graceMs + 1,
				graceMs,
			).sweep();

			expect(eventsNamed(logger, "sandbox.stranded_session")[0]).toMatchObject({
				issue_key: "CAN-96",
				state: "absent",
			});
		});

		it("stays silent during the cold-boot window, when the same three facts are expected", async () => {
			// A container that was just routed to is absent/stopped, holds affinity,
			// and has no socket — identical to the fault — until its worker dials
			// back, which for a first ACA boot with an image pull is minutes. Firing
			// here would make the rule useless.
			const { createdMs, aca } = strandedFixture("CAN-97", "absent");
			const graceMs = 600_000;

			await strandedLifecycle(
				aca,
				() => createdMs + graceMs - 1,
				graceMs,
			).sweep();

			expect(eventsNamed(logger, "sandbox.stranded_session")).toHaveLength(0);
			expect(logger.error).not.toHaveBeenCalled();
		});

		it("stays silent for a container whose provider could not be read this tick", async () => {
			// `unknown` is not `stopped`. One throttled ARM call must not report the
			// entire fleet as stranded.
			const { createdMs } = makeContainerDevice("CAN-99", "aca");
			const aca = fakeExecutor("aca", { status: "stopped" });
			aca.listStates = vi.fn(async () => {
				throw new Error("ARM throttled");
			});
			store.setSessionAffinity(
				"orphaned",
				store.getContainerDeviceForIssue("CAN-99")!.deviceId,
				undefined,
				createdMs,
			);

			await strandedLifecycle(aca, () => createdMs + PAST_GRACE_MS).sweep();

			expect(eventsNamed(logger, "sandbox.stranded_session")).toHaveLength(0);
		});

		it("stays silent for a container with a terminal teardown pending", async () => {
			// That container is supposed to be going away, and TerminalTeardown's own
			// grace deadline is what covers it.
			const { deviceId, createdMs, aca } = strandedFixture(
				"CAN-100",
				"stopped",
			);
			store.upsertPendingTeardown({
				issueKey: "CAN-100",
				deviceId,
				action: "closed",
				registeredMs: createdMs,
				deadlineMs: createdMs + 600_000,
			});

			await strandedLifecycle(aca, () => createdMs + PAST_GRACE_MS).sweep();

			expect(eventsNamed(logger, "sandbox.stranded_session")).toHaveLength(0);
		});

		it("stays silent for a running sandbox, and for one whose worker is connected", async () => {
			const { createdMs } = makeContainerDevice("CAN-101", "aca");
			const aca = fakeExecutor("aca", {
				status: "running",
				listStates: [{ issueKey: "CAN-101", status: "running" }],
			});
			store.setSessionAffinity(
				"live",
				store.getContainerDeviceForIssue("CAN-101")!.deviceId,
				undefined,
				createdMs,
			);

			await strandedLifecycle(aca, () => createdMs + PAST_GRACE_MS).sweep();

			expect(eventsNamed(logger, "sandbox.stranded_session")).toHaveLength(0);
		});

		it("clears its once-only error latch when the sandbox recovers, so a recurrence is reported again", async () => {
			const { deviceId, createdMs } = makeContainerDevice("CAN-102", "aca");
			let state: "running" | "stopped" = "stopped";
			const aca = fakeExecutor("aca", {
				status: "stopped",
				listStates: () => [{ issueKey: "CAN-102", status: state }],
			});
			store.setSessionAffinity("orphaned", deviceId, undefined, createdMs);
			let now = createdMs + PAST_GRACE_MS;
			const lifecycle = strandedLifecycle(aca, () => now);

			await lifecycle.sweep();
			state = "running";
			now += 60_000;
			await lifecycle.sweep();
			state = "stopped";
			now += 60_000;
			await lifecycle.sweep();

			expect(eventsNamed(logger, "sandbox.stranded_session")).toHaveLength(2);
			expect(
				logger.error.mock.calls.filter(([m]) =>
					String(m).includes("still holds"),
				),
			).toHaveLength(2);
		});
	});

	// ── NOR-406: the tick decides from a snapshot minutes stale ─────────────
	// A sweep tick that began at 07:45:22 reached one row at 07:51:54 — 392
	// seconds in — and idle-stopped it using 07:45:22's clock and 07:45:22's
	// row. The session routed to that container at 07:51:39 and running at
	// 07:51:45 was invisible to every check, including NOR-366's mid-sweep
	// guard, which compares affinity against a snapshot taken AFTER the claim.
	describe("a tick that outlives its own snapshot", () => {
		/**
		 * A slow tick, built the way the issue asks for: the row loop is
		 * genuinely slowed (an earlier row's provider call blocks and advances
		 * the clock) rather than a fixture that returns instantly. `delay`
		 * runs while the sweep is inside the decoy row, i.e. mid-loop.
		 */
		function slowTickFixture(delay: (elapsedMs: number) => void) {
			const decoy = makeContainerDevice("CAN-133", "aca");
			const victim = makeContainerDevice("CAN-134", "aca");
			const aca = fakeExecutor("aca", { status: "stopped" });
			// The decoy is `stopped`, so its own branch stops nothing; all it does
			// is make the tick take six and a half minutes to reach CAN-134.
			aca.status.mockImplementation(async (issueKey: string) => {
				if (issueKey === "CAN-133") delay(392_000);
				return issueKey === "CAN-133" ? "stopped" : "running";
			});
			return { decoy, victim, aca };
		}

		it("does not idle-stop a container routed to while the tick was still running", async () => {
			// THE defect. `now` and `rows` were taken once at the top of the tick,
			// so `idleForMs = now - lastRoutedMs` was computed from a clock six
			// minutes behind and a row that predated the route entirely. The
			// logged arithmetic proved it: idleForMs=339408 with idleStopMs=300000,
			// against a route stamped 15 seconds earlier.
			const idleStopMs = 300_000;
			let now = 0;
			let routedMs = 0;
			const { victim, aca } = slowTickFixture((elapsedMs) => {
				now += elapsedMs;
				// The route lands 15 seconds before the loop reaches CAN-134 —
				// deliberately WITHOUT taking affinity, exactly as the incident had
				// it: the device was online and correctly reported no live session,
				// so `resolveAffinity` returned 0 and the pin never engaged.
				routedMs = now - 15_000;
				store.enqueueEvent(victim.deviceId, "{}", routedMs, 48 * 3_600_000);
			});
			now = victim.createdMs + idleStopMs + 1;

			await new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => now,
			}).sweep();

			expect(aca.stop).not.toHaveBeenCalled();
			expect(eventsNamed(logger, "sandbox.idle_stopped")).toHaveLength(0);
			// And the route the old code could not see really was the reason: the
			// row says the container was touched 15 seconds before the decision.
			expect(store.getContainerDevice(victim.deviceId)?.lastRoutedMs).toBe(
				routedMs,
			);
			expect(now - routedMs).toBeLessThan(idleStopMs);
		});

		it("still idle-stops a container nothing touched during the slow tick", async () => {
			// The other half of the contract: re-reading must not turn every long
			// tick into a no-op, or the fix trades a correctness bug for a cost one.
			const idleStopMs = 300_000;
			let now = 0;
			const { aca, victim } = slowTickFixture((elapsedMs) => {
				now += elapsedMs;
			});
			now = victim.createdMs + idleStopMs + 1;

			await new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => now,
			}).sweep();

			expect(aca.stop).toHaveBeenCalledWith("CAN-134");
		});

		it("abandons the stop when a route lands during the status() round trip", async () => {
			// `claimedMidSweep` only sees a session that took AFFINITY during the
			// round trip. A route that merely moves `lastRoutedMs` adds no row, so
			// the pre-stop re-check has to re-derive the clock, not just re-count
			// sessions.
			const { deviceId, createdMs } = makeContainerDevice("CAN-135", "aca");
			const idleStopMs = 300_000;
			const now = createdMs + idleStopMs + 1;
			const aca = fakeExecutor("aca", { status: "running" });
			aca.status.mockImplementation(async () => {
				store.enqueueEvent(deviceId, "{}", now, 48 * 3_600_000);
				return "running";
			});

			await new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => now,
			}).sweep();

			expect(aca.stop).not.toHaveBeenCalled();
			expect(
				logger.info.mock.calls.filter(([m]) =>
					String(m).includes("its idle clock moved"),
				),
			).toHaveLength(1);
		});

		it("does not act on a device row destroyed since the tick began", async () => {
			// A terminal teardown mid-tick deletes the row. Acting on the snapshot
			// then means acting on a container that no longer exists — or, once the
			// issue is prompted again, on its replacement.
			const decoy = makeContainerDevice("CAN-136", "aca");
			const victim = makeContainerDevice("CAN-137", "aca");
			const idleStopMs = 300_000;
			const now = victim.createdMs + idleStopMs + 1;
			const aca = fakeExecutor("aca", {
				status: "running",
				listStates: [
					{ issueKey: "CAN-136", status: "running" },
					{ issueKey: "CAN-137", status: "running" },
				],
			});
			aca.status.mockImplementation(async (issueKey: string) => {
				if (issueKey === "CAN-136")
					store.deleteContainerDevice(victim.deviceId);
				return "running";
			});

			await new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => now,
			}).sweep();

			expect(aca.stop).toHaveBeenCalledTimes(1);
			expect(aca.stop).toHaveBeenCalledWith("CAN-136");
			expect(decoy.deviceId).not.toBe(victim.deviceId);
		});

		it("still counts and unlatches a row it skips, so the rollup keeps summing", async () => {
			// Skipping the DECISIONS for a vanished row is the point; skipping the
			// BOOKKEEPING is a different bug. The rollup reports `sandboxes` as the
			// size of the opening snapshot, so a bucket that stops summing to it
			// under-reports on exactly the ticks where something was destroyed —
			// and a device torn down while pinned would never log its unpin.
			const idleStopMs = 300_000;
			const alive = makeContainerDevice("CAN-143", "aca");
			const doomed = makeContainerDevice("CAN-144", "aca");
			let now = alive.createdMs + 1_000;
			const aca = fakeExecutor("aca", {
				status: "running",
				listStates: [
					{ issueKey: "CAN-143", status: "running" },
					{ issueKey: "CAN-144", status: "running" },
				],
			});
			// CAN-144 is pinned, so it is latched into `pinnedDevices` on tick one.
			store.setSessionAffinity("held", doomed.deviceId, undefined, now);
			const lifecycle = new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => now,
				sessionReconciler: { isOnline: () => true, reconcile: async () => 1 },
			});

			await lifecycle.sweep();
			expect(
				logger.info.mock.calls.filter(([m]) =>
					String(m).includes("is pinned out of idle-stop"),
				),
			).toHaveLength(1);

			// Tick two: a terminal teardown removes CAN-144 mid-tick, while the
			// sweep is inside CAN-143's provider call — so the doomed row IS in
			// this tick's opening snapshot and the skip path is genuinely reached.
			now = alive.createdMs + idleStopMs + 1;
			aca.status.mockImplementation(async (issueKey: string) => {
				if (issueKey === "CAN-143")
					store.deleteContainerDevice(doomed.deviceId);
				return "running";
			});
			await lifecycle.sweep();

			const rollup = eventsNamed(logger, "sandbox.sweep_completed").at(-1) as
				| Record<string, number>
				| undefined;
			if (!rollup) throw new Error("expected a rollup");
			expect(
				rollup.running + rollup.stopped + rollup.absent + rollup.unknown,
			).toBe(rollup.sandboxes);
			expect(rollup.absent).toBe(1);
			// And the latch was released, so the transition is not lost.
			expect(
				logger.info.mock.calls.filter(([m]) =>
					String(m).includes(
						`Container device ${doomed.deviceId} is no longer pinned`,
					),
				),
			).toHaveLength(1);
			expect(alive.deviceId).not.toBe(doomed.deviceId);
		});
	});

	describe("a stop that races the worker's terminal frame", () => {
		/**
		 * A container with one agent run on it, still open. The caller ends it —
		 * once, since `finishAgentRun` is a no-op against an already-terminal run.
		 */
		function runningRunFixture(issueKey: string) {
			const device = makeContainerDevice(issueKey, "aca");
			store.recordAgentRunRouted({
				deviceId: device.deviceId,
				issueKey,
				sessionId: "s-1",
				routedMs: device.createdMs,
			});
			return device;
		}

		function lifecycleFor(
			aca: ContainerExecutor,
			now: () => number,
			idleStopMs: number,
			terminalSettleMs?: number,
		) {
			return new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				...(terminalSettleMs !== undefined ? { terminalSettleMs } : {}),
				logger,
				now,
			});
		}

		it("fires in the 392-second-tick regime, driven through the real route -> work -> completion sequence", async () => {
			// The regime this veto exists for, and the only one it is reachable in.
			// Every write below is the one the router itself makes: `enqueueEvent`
			// stamps `last_routed_ms`, `setSessionAffinity` stamps `last_active_ms`,
			// the sweep re-stamps it on each pinned tick, and the terminal frame
			// clears affinity and ends the run.
			//
			// With ticks 392s apart, `last_active_ms` is up to a full tick stale
			// through no fault of the read that fetched it, and a session can begin
			// and end entirely between two visits to the same row. That is the
			// residue the fresh per-row read cannot cover.
			const idleStopMs = 300_000;
			const terminalSettleMs = 120_000;
			const tickMs = 392_000;
			const { deviceId, createdMs } = makeContainerDevice("CAN-134b", "aca");
			const aca = fakeExecutor("aca", { status: "running" });
			let now = createdMs;
			const lifecycle = lifecycleFor(
				aca,
				() => now,
				idleStopMs,
				terminalSettleMs,
			);

			// A session is routed and claims the device.
			store.enqueueEvent(deviceId, "{}", now, 48 * 3_600_000);
			store.setSessionAffinity("s-live", deviceId, undefined, now);
			store.recordAgentRunRouted({
				deviceId,
				issueKey: "CAN-134b",
				sessionId: "s-live",
				routedMs: now,
			});

			// One slow tick sees it pinned and re-stamps the idle clock.
			now += 10_000;
			await lifecycle.sweep();
			expect(store.getContainerDevice(deviceId)?.lastActiveMs).toBe(now);
			const lastPinnedTickMs = now;

			// The session completes 300s later — five minutes before this row is
			// looked at again. Its terminal frame arrives; the worker is still
			// flushing its artifact bundle.
			now = lastPinnedTickMs + 300_000;
			store.clearSessionAffinity("s-live");
			store.finishAgentRun("s-live", "complete", now);

			// The next visit to the row: one tick later, so the idle clock reads
			// 392s — genuinely past idleStopMs, and not because anything is stale.
			now = lastPinnedTickMs + tickMs;
			await lifecycle.sweep();

			expect(aca.stop).not.toHaveBeenCalled();
			expect(
				logger.info.mock.calls.filter(([m]) =>
					String(m).includes("may still be flushing"),
				),
			).toHaveLength(1);

			// And still bounded: the tick after that parks it.
			now += tickMs;
			await lifecycle.sweep();
			expect(aca.stop).toHaveBeenCalledWith("CAN-134b");
		});

		it("defers the stop while the worker may still be flushing its terminal frame", async () => {
			// The incident: session completed 07:51:50, container stopped 07:51:54.
			// The `session_state` frame is durably buffered and replayed until the
			// router acks it — but the process that would replay it had been
			// stopped, so the affinity row and the issue lock survived for 37
			// minutes while Linear rendered a live agent session.
			const idleStopMs = 300_000;
			const aca = fakeExecutor("aca", { status: "running" });
			const device = runningRunFixture("CAN-138");
			const now = device.createdMs + idleStopMs + 1;
			// The run ended 3.8 seconds ago, as in the incident.
			store.finishAgentRun("s-1", "complete", now - 3_800);

			await lifecycleFor(aca, () => now, idleStopMs, 120_000).sweep();

			expect(aca.stop).not.toHaveBeenCalled();
			expect(
				logger.info.mock.calls.filter(([m]) =>
					String(m).includes("may still be flushing"),
				),
			).toHaveLength(1);
		});

		it("is a deferral, not a pin: the stop happens once the settle window passes", async () => {
			// Bounded on purpose. A veto that could outlive its window would be
			// PAR-146's permanent pin wearing a different hat.
			const idleStopMs = 300_000;
			const terminalSettleMs = 120_000;
			const aca = fakeExecutor("aca", { status: "running" });
			const device = runningRunFixture("CAN-139");
			let now = device.createdMs + idleStopMs + 1;
			store.finishAgentRun("s-1", "complete", now - 3_800);
			const lifecycle = lifecycleFor(
				aca,
				() => now,
				idleStopMs,
				terminalSettleMs,
			);

			await lifecycle.sweep();
			expect(aca.stop).not.toHaveBeenCalled();

			now += terminalSettleMs;
			await lifecycle.sweep();

			expect(aca.stop).toHaveBeenCalledWith("CAN-139");
		});

		it("covers an affinity row the reconciler reclaimed, which is the router never having seen the frame at all", async () => {
			// `reconcileDeviceAffinity` calls `markAgentRunUnknown`, which stamps
			// `ended_ms` too. That path is precisely "the device says it is not
			// running this session, and no terminal frame ever arrived" — the
			// state the settle window exists for.
			const idleStopMs = 300_000;
			const aca = fakeExecutor("aca", { status: "running" });
			const device = runningRunFixture("CAN-140");
			const now = device.createdMs + idleStopMs + 1;
			store.markAgentRunUnknown("s-1", now - 1_000);

			await lifecycleFor(aca, () => now, idleStopMs, 120_000).sweep();

			expect(aca.stop).not.toHaveBeenCalled();
		});

		it("clamps the veto's lookback to one idle window, so a long terminalSettleMs cannot pin", async () => {
			// What the clamp bounds is each veto's LOOKBACK — how old a run stamp
			// may be and still veto — not the cumulative deferral, which is bounded
			// instead by the veto's reference point (`lastRunMs`) being frozen once
			// a run goes terminal. Named for the former because that is what this
			// test drives.
			//
			// The veto covers the SECONDS between a run ending and its worker
			// finishing saying so. Unclamped, a deployment with a short
			// `idleStopMs` would have its parking policy quietly replaced by the
			// settle constant — the veto becoming the dominant term is exactly the
			// permanent-pin shape PAR-146 removed.
			const idleStopMs = 60_000;
			const aca = fakeExecutor("aca", { status: "running" });
			const device = runningRunFixture("CAN-142");
			const now = device.createdMs + idleStopMs + 5_000;
			store.finishAgentRun("s-1", "complete", device.createdMs + 100);

			await lifecycleFor(aca, () => now, idleStopMs, 600_000).sweep();

			expect(aca.stop).toHaveBeenCalledWith("CAN-142");
		});

		it("leaves a container whose last run ended long ago alone", async () => {
			// The common case, and the one that must keep costing nothing: a
			// sandbox whose session finished half an hour ago still gets parked.
			const idleStopMs = 300_000;
			const aca = fakeExecutor("aca", { status: "running" });
			const device = runningRunFixture("CAN-141");
			const now = device.createdMs + idleStopMs + 1;
			store.finishAgentRun("s-1", "complete", device.createdMs);

			await lifecycleFor(aca, () => now, idleStopMs, 120_000).sweep();

			expect(aca.stop).toHaveBeenCalledWith("CAN-141");
		});

		it("warns when the clamp actually binds, rather than silently reducing the configured value", async () => {
			// Silently applying something other than what the config file says
			// leaves an operator with no way to discover it short of reading the
			// constructor.
			const aca = fakeExecutor("aca", { status: "running" });
			lifecycleFor(aca, () => 0, 300_000, 600_000);

			expect(
				logger.warn.mock.calls.filter(([m]) =>
					String(m).includes("exceeds idleStopMs"),
				),
			).toHaveLength(1);
		});

		it("says nothing when the configured value fits inside the idle window", async () => {
			const aca = fakeExecutor("aca", { status: "running" });
			lifecycleFor(aca, () => 0, 300_000, 120_000);

			expect(logger.warn).not.toHaveBeenCalled();
		});
	});

	// ── Every abandoned idle-stop has to be queryable ───────────────────────
	// Reported only in prose, a skipped stop is invisible to every saved search
	// and alert rule, all of which key on the structured `event` field. That
	// makes the success signal for the whole NOR-406 fix an ABSENCE of
	// `sandbox.idle_stopped` — indistinguishable from a sweep that has stalled —
	// and leaves a container held out of parking indefinitely bucketed as an
	// unremarkable `running`, which is the three-plain-fields silence that let
	// NOR-366 run for nine hours.
	describe("skipped idle-stops are reported as events, not only as log lines", () => {
		function lifecycleFor(
			aca: ContainerExecutor,
			now: () => number,
			idleStopMs: number,
			terminalSettleMs?: number,
		) {
			return new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				...(terminalSettleMs !== undefined ? { terminalSettleMs } : {}),
				logger,
				now,
			});
		}

		it("names the guard that fired with a closed-set reason: clock_moved", async () => {
			const { deviceId, createdMs } = makeContainerDevice("CAN-145", "aca");
			const idleStopMs = 300_000;
			const now = createdMs + idleStopMs + 1;
			const aca = fakeExecutor("aca", { status: "running" });
			aca.status.mockImplementation(async () => {
				store.enqueueEvent(deviceId, "{}", now, 48 * 3_600_000);
				return "running";
			});

			await lifecycleFor(aca, () => now, idleStopMs).sweep();

			expect(aca.stop).not.toHaveBeenCalled();
			expect(eventsNamed(logger, "sandbox.idle_stop_skipped")[0]).toMatchObject(
				{
					issue_key: "CAN-145",
					device_id: deviceId,
					provider: "aca",
					reason: "clock_moved",
					idle_stop_ms: idleStopMs,
				},
			);
		});

		it("names the guard that fired with a closed-set reason: claimed_mid_sweep", async () => {
			const { deviceId, createdMs } = makeContainerDevice("CAN-146", "aca");
			const idleStopMs = 300_000;
			const now = createdMs + idleStopMs + 1;
			const aca = fakeExecutor("aca", { status: "running" });
			aca.status.mockImplementation(async () => {
				store.setSessionAffinity("review", deviceId, undefined, now);
				return "running";
			});

			await lifecycleFor(aca, () => now, idleStopMs).sweep();

			expect(eventsNamed(logger, "sandbox.idle_stop_skipped")[0]).toMatchObject(
				{
					issue_key: "CAN-146",
					reason: "claimed_mid_sweep",
					claimed_sessions: 1,
					idle_for_ms: idleStopMs + 1,
				},
			);
		});

		it("names the guard that fired with a closed-set reason: terminal_settle", async () => {
			const idleStopMs = 300_000;
			const { deviceId, createdMs } = makeContainerDevice("CAN-147", "aca");
			store.recordAgentRunRouted({
				deviceId,
				issueKey: "CAN-147",
				sessionId: "s-1",
				routedMs: createdMs,
			});
			const now = createdMs + idleStopMs + 1;
			store.finishAgentRun("s-1", "complete", now - 3_800);
			const aca = fakeExecutor("aca", { status: "running" });

			await lifecycleFor(aca, () => now, idleStopMs, 120_000).sweep();

			expect(eventsNamed(logger, "sandbox.idle_stop_skipped")[0]).toMatchObject(
				{
					issue_key: "CAN-147",
					reason: "terminal_settle",
					run_ended_ago_ms: 3_800,
					terminal_settle_ms: 120_000,
				},
			);
		});

		it("names the guard that fired with a closed-set reason: row_deleted", async () => {
			// Only reachable at the PRE-STOP check: the loop's own re-read already
			// skips a row that vanished before the decision, so this is a teardown
			// that landed during the `status()` round trip.
			const idleStopMs = 300_000;
			const { deviceId, createdMs } = makeContainerDevice("CAN-148", "aca");
			const now = createdMs + idleStopMs + 1;
			const aca = fakeExecutor("aca", { status: "running" });
			aca.status.mockImplementation(async () => {
				store.deleteContainerDevice(deviceId);
				return "running";
			});

			await lifecycleFor(aca, () => now, idleStopMs).sweep();

			expect(aca.stop).not.toHaveBeenCalled();
			expect(eventsNamed(logger, "sandbox.idle_stop_skipped")[0]).toMatchObject(
				{ issue_key: "CAN-148", reason: "row_deleted" },
			);
		});

		it("counts deferrals in the per-tick rollup, so a deferral wave shows up fleet-wide", async () => {
			// Without this the only way to notice is to already suspect a
			// particular issue and open its timeline.
			const idleStopMs = 300_000;
			const { deviceId, createdMs } = makeContainerDevice("CAN-149", "aca");
			const now = createdMs + idleStopMs + 1;
			const aca = fakeExecutor("aca", {
				status: "running",
				listStates: [{ issueKey: "CAN-149", status: "running" }],
			});
			aca.status.mockImplementation(async () => {
				store.enqueueEvent(deviceId, "{}", now, 48 * 3_600_000);
				return "running";
			});

			await lifecycleFor(aca, () => now, idleStopMs).sweep();

			expect(eventsNamed(logger, "sandbox.sweep_completed")[0]).toMatchObject({
				sandboxes: 1,
				deferred: 1,
			});
		});

		it("reports nothing when the stop actually happens", async () => {
			// The guard against reporting a deferral on every ordinary park, which
			// would make the alert on sustained deferral useless.
			const idleStopMs = 300_000;
			const { createdMs } = makeContainerDevice("CAN-150", "aca");
			const aca = fakeExecutor("aca", { status: "running" });

			await lifecycleFor(
				aca,
				() => createdMs + idleStopMs + 1,
				idleStopMs,
			).sweep();

			expect(aca.stop).toHaveBeenCalledWith("CAN-150");
			expect(eventsNamed(logger, "sandbox.idle_stop_skipped")).toHaveLength(0);
			expect(eventsNamed(logger, "sandbox.sweep_completed")[0]).toMatchObject({
				deferred: 0,
			});
		});
	});

	// ── The provider listing is tick-level, and it drives WRITES ────────────
	// One listing per provider per tick is the gauge's whole cost model, so it
	// is the one input the per-row re-read deliberately does not cover. That is
	// fine while it only feeds a gauge reading; it is not fine when it decides
	// whether to erase `running_since_ms`, the sole input to the 6-hour
	// long-running-sandbox alert.
	describe("a stale provider listing must not erase a newer running clock", () => {
		it("keeps a running clock stamped after the listing was taken", async () => {
			// The shape: absent when the tick's listing was read, booted by a route
			// while the tick was still grinding through earlier rows, and reached
			// minutes later. The boot's `running_since_ms` is a fact the listing
			// cannot speak to.
			const decoy = makeContainerDevice("CAN-151", "aca");
			const victim = makeContainerDevice("CAN-152", "aca");
			const idleStopMs = 300_000;
			let now = victim.createdMs + idleStopMs + 1;
			// Neither issue is in the listing, so both read as `absent` — the
			// state that clears a running clock.
			const aca = fakeExecutor("aca", { listStates: [] });
			aca.status.mockImplementation(async (issueKey: string) => {
				if (issueKey === "CAN-151") {
					// Six and a half minutes pass inside the decoy's provider call,
					// and a route boots CAN-152 during them.
					now += 392_000;
					store.markDeviceRunning(victim.deviceId, now);
				}
				return "running";
			});
			// The victim is pinned, so the sweep samples it and parks nothing: this
			// test is about the gauge's WRITE, not about the stop decision. The
			// decoy holds no affinity, which is what carries it into `status()`.
			store.setSessionAffinity("s-2", victim.deviceId, undefined, now);

			await new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => now,
				sessionReconciler: { isOnline: () => true, reconcile: async () => 1 },
			}).sweep();

			expect(decoy.deviceId).not.toBe(victim.deviceId);

			expect(
				store.getContainerDevice(victim.deviceId)?.runningSinceMs,
			).toBeDefined();
		});

		it("still clears a running clock the listing is genuinely newer than", async () => {
			// The other half: a sandbox that really did stop must not keep
			// accumulating uptime, or the 6-hour alert fires on a stopped sandbox.
			const { deviceId, createdMs } = makeContainerDevice("CAN-153", "aca");
			store.markDeviceRunning(deviceId, createdMs);
			const aca = fakeExecutor("aca", {
				status: "stopped",
				listStates: [{ issueKey: "CAN-153", status: "stopped" }],
			});
			store.setSessionAffinity("s-1", deviceId, undefined, createdMs);

			await new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs: 300_000,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => createdMs + 60_000,
				sessionReconciler: { isOnline: () => true, reconcile: async () => 1 },
			}).sweep();

			expect(
				store.getContainerDevice(deviceId)?.runningSinceMs,
			).toBeUndefined();
		});

		it("reports how stale the state it sampled was, so the number is not an assumption", async () => {
			// Every other field on a gauge sample is read per-row; `state` is not.
			// A reader who does not know that will trust a `stopped` reading taken
			// six minutes before the row was reached.
			const decoy = makeContainerDevice("CAN-154", "aca");
			makeContainerDevice("CAN-155", "aca");
			const idleStopMs = 300_000;
			let now = decoy.createdMs + idleStopMs + 1;
			const aca = fakeExecutor("aca", {
				listStates: [
					{ issueKey: "CAN-154", status: "stopped" },
					{ issueKey: "CAN-155", status: "stopped" },
				],
			});
			// The decoy's provider call is what makes the tick outlive its interval.
			aca.status.mockImplementation(async (issueKey: string) => {
				if (issueKey === "CAN-154") now += 392_000;
				return "stopped";
			});

			await new ContainerLifecycle({
				store,
				executors: new Map<string, ContainerExecutor>([["aca", aca]]),
				idleStopMs,
				staleDestroyMs: 14 * 24 * 60 * 60_000,
				offlineAgeOutMs: 3_600_000,
				logger,
				now: () => now,
			}).sweep();

			const samples = eventsNamed(logger, "sandbox.gauge");
			// Sampled first, off a listing read moments earlier.
			expect(samples.find((s) => s.issue_key === "CAN-154")).toMatchObject({
				listing_age_ms: 0,
			});
			// Sampled after the slow call, off the SAME listing.
			expect(samples.find((s) => s.issue_key === "CAN-155")).toMatchObject({
				listing_age_ms: 392_000,
			});
		});
	});
});
