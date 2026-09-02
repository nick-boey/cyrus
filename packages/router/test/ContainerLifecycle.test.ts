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
});
