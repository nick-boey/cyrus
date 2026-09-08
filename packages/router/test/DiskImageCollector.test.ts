import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AcaDiskImage,
	AcaSandbox,
	AcaSandboxClient,
	AcaSnapshot,
} from "cyrus-router-executors";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DiskImageCollector } from "../src/devcontainer/DiskImageCollector.js";
import { RouterStore } from "../src/RouterStore.js";
import { eventsNamed, type TestLogger, testLogger } from "./helpers/logger.js";

/**
 * CYR-84. The GC these cover reconciles the PROVIDER'S disk-image inventory, not
 * the devcontainer cache table, so the case that matters most is the one the old
 * rule could not express at all: a deployment worker image registered out of
 * band by `scripts/deploy-worker-image.sh`, which has no cache row and therefore
 * was never a candidate. The 2026-09-08 audit found eight of them.
 */

const DEPLOYMENT_DISK = "cyrus-worker-sha-current";
const HOUR = 3_600_000;

let dir: string;
let store: RouterStore;
let logger: TestLogger;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cyrus-diskgc-"));
	store = new RouterStore(join(dir, "router.db"));
	logger = testLogger();
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

interface AcaFake {
	client: AcaSandboxClient;
	deleted: string[];
	calls: { disks: number; snapshots: number; sandboxes: number };
	deleteDiskImage: ReturnType<typeof vi.fn>;
}

function disk(
	name: string,
	overrides: Partial<AcaDiskImage> = {},
): AcaDiskImage {
	return {
		id: `id-${name}`,
		name: `guid-${name}`,
		labels: { name },
		status: "Ready",
		sizeInMB: 100,
		...overrides,
	};
}

function acaFake(opts: {
	disks?: AcaDiskImage[];
	snapshots?: AcaSnapshot[];
	sandboxes?: AcaSandbox[];
	/** Runs before each delete resolves, so a test can mutate the store mid-cycle. */
	onDelete?: (id: string) => void;
	failListing?: "disks" | "snapshots" | "sandboxes";
}): AcaFake {
	const deleted: string[] = [];
	const calls = { disks: 0, snapshots: 0, sandboxes: 0 };
	const deleteDiskImage = vi.fn(async (id: string) => {
		opts.onDelete?.(id);
		deleted.push(id);
	});
	const client = {
		listDiskImages: async () => {
			calls.disks += 1;
			if (opts.failListing === "disks") throw new Error("throttled");
			return opts.disks ?? [];
		},
		listSnapshots: async () => {
			calls.snapshots += 1;
			if (opts.failListing === "snapshots") throw new Error("throttled");
			return opts.snapshots ?? [];
		},
		listSandboxes: async () => {
			calls.sandboxes += 1;
			if (opts.failListing === "sandboxes") throw new Error("throttled");
			return opts.sandboxes ?? [];
		},
		deleteDiskImage,
	} as unknown as AcaSandboxClient;
	return { client, deleted, calls, deleteDiskImage };
}

/**
 * `imageRetentionCount` defaults to **0** here, not to the production 3.
 *
 * The two floors are independent and every test should say which one it is
 * about. Left at the production default, the count floor would spare the single
 * unreferenced image in almost every case below and each of those tests would
 * pass for a reason it never states.
 */
function collector(
	aca: AcaFake,
	opts: {
		now?: () => number;
		imageRetentionMs?: number;
		imageRetentionCount?: number;
		dryRun?: boolean;
	} = {},
): DiskImageCollector {
	return new DiskImageCollector({
		store,
		logger,
		aca: aca.client,
		deploymentDisk: DEPLOYMENT_DISK,
		imageRetentionMs: opts.imageRetentionMs ?? HOUR,
		imageRetentionCount: opts.imageRetentionCount ?? 0,
		...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
		now: opts.now ?? (() => 0),
	});
}

/**
 * Registers `names` as first seen at time 0, so a later cycle can run past the
 * retention window without a real clock. A disk the router has never seen is
 * treated as brand new — that is the safe default, and the reason it has to be
 * arranged away explicitly here.
 */
function seenAtZero(names: string[]): void {
	store.recordDiskImageSightings(names, 0);
}

describe("DiskImageCollector", () => {
	it("deletes an old, ready deployment image that has no devcontainer cache row", async () => {
		// The whole point of CYR-84: this image was registered by the deploy
		// script, so `repo_devcontainer_images` has never heard of it and the old
		// reference count had nothing to iterate that could reach it.
		const aca = acaFake({
			disks: [
				disk(DEPLOYMENT_DISK),
				disk("cyrus-worker-sha-old", { sizeInMB: 4_200 }),
			],
		});
		seenAtZero([DEPLOYMENT_DISK, "cyrus-worker-sha-old"]);

		const summary = await collector(aca, { now: () => HOUR + 1 }).collect();

		expect(aca.deleted).toEqual(["id-cyrus-worker-sha-old"]);
		expect(summary.deleted).toEqual(["cyrus-worker-sha-old"]);
		expect(summary.reclaimedMb).toBe(4_200);
		expect(summary.kept).toEqual([
			{ diskName: DEPLOYMENT_DISK, reason: "deployment_disk" },
		]);
	});

	it("never deletes the deployment image, however old and unreferenced", async () => {
		const aca = acaFake({ disks: [disk(DEPLOYMENT_DISK)] });
		seenAtZero([DEPLOYMENT_DISK]);
		await collector(aca, { now: () => 400 * 24 * HOUR }).collect();
		expect(aca.deleted).toEqual([]);
	});

	it("keeps an image a live sandbox boots from, by label or by sourcesRef", async () => {
		const aca = acaFake({
			disks: [
				disk(DEPLOYMENT_DISK),
				disk("cyrus-worker-sha-labelled"),
				disk("cyrus-worker-sha-by-name"),
				disk("cyrus-worker-sha-by-id"),
			],
			sandboxes: [
				{
					id: "sb-1",
					state: "Running",
					labels: { "cyrus.disk": "cyrus-worker-sha-labelled" },
				},
				{
					id: "sb-2",
					state: "Running",
					sourcesRef: { diskImage: { name: "cyrus-worker-sha-by-name" } },
				},
				{
					id: "sb-3",
					state: "Stopped",
					// A sandbox may name its source by id; the id has to be resolved
					// against the disk listing or the protection silently misses.
					sourcesRef: { diskImage: { id: "id-cyrus-worker-sha-by-id" } },
				},
			] as unknown as AcaSandbox[],
		});
		seenAtZero([
			DEPLOYMENT_DISK,
			"cyrus-worker-sha-labelled",
			"cyrus-worker-sha-by-name",
			"cyrus-worker-sha-by-id",
		]);

		const summary = await collector(aca, { now: () => 10 * HOUR }).collect();

		expect(aca.deleted).toEqual([]);
		expect(
			summary.kept
				.filter((k) => k.reason === "sandbox_source")
				.map((k) => k.diskName),
		).toEqual([
			"cyrus-worker-sha-labelled",
			"cyrus-worker-sha-by-name",
			"cyrus-worker-sha-by-id",
		]);
	});

	it("keeps an image a snapshot's lineage names", async () => {
		// A snapshot restores the image lineage it was taken from, so deleting the
		// image leaves a snapshot that resurrects nothing.
		const aca = acaFake({
			disks: [disk(DEPLOYMENT_DISK), disk("cyrus-worker-sha-lineage")],
			snapshots: [
				{
					id: "snap-1",
					labels: { "cyrus.disk": "cyrus-worker-sha-lineage" },
				},
			] as unknown as AcaSnapshot[],
		});
		seenAtZero([DEPLOYMENT_DISK, "cyrus-worker-sha-lineage"]);
		await collector(aca, { now: () => 10 * HOUR }).collect();
		expect(aca.deleted).toEqual([]);
	});

	it("keeps an image an issue is pinned to even when its cache row is gone", async () => {
		// The pin outlives the cache row, so resolving pins through
		// `referencedDevcontainerCacheKeys` alone leaves this image unprotected.
		store.setIssueDiskImage(
			{
				issueKey: "NOR-1",
				repositoryName: "api",
				cacheKey: "deleted-key",
				diskName: "cyrus-api-pinned",
				imageRef: "acr/x:1",
				deploymentDisk: DEPLOYMENT_DISK,
			},
			0,
		);
		const aca = acaFake({
			disks: [disk(DEPLOYMENT_DISK), disk("cyrus-api-pinned")],
		});
		seenAtZero([DEPLOYMENT_DISK, "cyrus-api-pinned"]);

		const summary = await collector(aca, { now: () => 10 * HOUR }).collect();

		expect(aca.deleted).toEqual([]);
		expect(summary.kept).toContainEqual({
			diskName: "cyrus-api-pinned",
			reason: "issue_pin",
		});
	});

	it("keeps a build in flight and the newest ready build per repository", async () => {
		store.claimDevcontainerBuild(
			{
				cacheKey: "k-building",
				repositoryName: "api",
				diskName: "cyrus-api-building",
				imageRef: "acr/x:building",
			},
			5,
		);
		store.claimDevcontainerBuild(
			{
				cacheKey: "k-ready",
				repositoryName: "web",
				diskName: "cyrus-web-ready",
				imageRef: "acr/x:ready",
			},
			1,
		);
		store.finishDevcontainerBuild("k-ready", { state: "ready" }, 1);
		const aca = acaFake({
			disks: [
				disk(DEPLOYMENT_DISK),
				disk("cyrus-api-building"),
				disk("cyrus-web-ready"),
			],
		});
		seenAtZero([DEPLOYMENT_DISK, "cyrus-api-building", "cyrus-web-ready"]);

		const summary = await collector(aca, { now: () => 10 * HOUR }).collect();

		expect(aca.deleted).toEqual([]);
		expect(
			summary.kept
				.filter((k) => k.reason === "cache_reference")
				.map((k) => k.diskName),
		).toEqual(["cyrus-api-building", "cyrus-web-ready"]);
	});

	it("leaves images it did not register alone", async () => {
		const aca = acaFake({
			disks: [disk(DEPLOYMENT_DISK), disk("someone-elses-base-image")],
		});
		seenAtZero([DEPLOYMENT_DISK, "someone-elses-base-image"]);

		const summary = await collector(aca, { now: () => 10 * HOUR }).collect();

		expect(aca.deleted).toEqual([]);
		expect(summary.kept).toContainEqual({
			diskName: "someone-elses-base-image",
			reason: "unmanaged",
		});
	});

	it("leaves an import still in flight alone — a deployment looks like this", async () => {
		const aca = acaFake({
			disks: [
				disk(DEPLOYMENT_DISK),
				disk("cyrus-worker-sha-importing", { status: { state: "Creating" } }),
			],
		});
		seenAtZero([DEPLOYMENT_DISK, "cyrus-worker-sha-importing"]);

		const summary = await collector(aca, { now: () => 10 * HOUR }).collect();

		expect(aca.deleted).toEqual([]);
		expect(summary.kept).toContainEqual({
			diskName: "cyrus-worker-sha-importing",
			reason: "not_ready",
		});
	});

	it("collects a FAILED import once it is past retention", async () => {
		// A failed import will never become Ready, so protecting every non-Ready
		// state indefinitely would leak its storage forever. The in-flight
		// protection is for imports that can still succeed.
		const aca = acaFake({
			disks: [
				disk(DEPLOYMENT_DISK),
				disk("cyrus-worker-sha-broken", {
					status: { state: "Failed", errorMessage: "pull denied" },
				}),
			],
		});
		seenAtZero([DEPLOYMENT_DISK, "cyrus-worker-sha-broken"]);

		await collector(aca, { now: () => 10 * HOUR }).collect();

		expect(aca.deleted).toEqual(["id-cyrus-worker-sha-broken"]);
	});

	it("deletes nothing under dryRun, but reports what it would have", async () => {
		// This is destructive work that runs unattended on a 6-hour timer, so a
		// deployment has to be able to watch a cycle before trusting it.
		const aca = acaFake({
			disks: [
				disk(DEPLOYMENT_DISK),
				disk("cyrus-worker-sha-old", { sizeInMB: 4_200 }),
			],
		});
		seenAtZero([DEPLOYMENT_DISK, "cyrus-worker-sha-old"]);

		const summary = await collector(aca, {
			now: () => 10 * HOUR,
			dryRun: true,
		}).collect();

		expect(aca.deleteDiskImage).not.toHaveBeenCalled();
		expect(summary.dryRun).toBe(true);
		expect(summary.deleted).toEqual(["cyrus-worker-sha-old"]);
		expect(summary.reclaimedMb).toBe(4_200);
	});

	describe("retention", () => {
		it("keeps an unreferenced image for the whole window and collects it once the window has elapsed", async () => {
			// The boundary is `age >= retention`: an image kept for the full window
			// has had its window, so the last instant inside it is `retention - 1`.
			const disks = [disk(DEPLOYMENT_DISK), disk("cyrus-worker-sha-staged")];
			seenAtZero([DEPLOYMENT_DISK, "cyrus-worker-sha-staged"]);

			const insideWindow = acaFake({ disks });
			const kept = await collector(insideWindow, {
				now: () => HOUR - 1,
			}).collect();
			expect(insideWindow.deleted).toEqual([]);
			expect(kept.kept).toContainEqual({
				diskName: "cyrus-worker-sha-staged",
				reason: "retained",
			});

			const atBoundary = acaFake({ disks });
			await collector(atBoundary, { now: () => HOUR }).collect();
			expect(atBoundary.deleted).toEqual(["id-cyrus-worker-sha-staged"]);
		});

		it("treats an image it has never seen as brand new", async () => {
			// A fresh database must not read as "everything is ancient" and empty the
			// sandbox group on the first cycle after a restore.
			const aca = acaFake({
				disks: [disk(DEPLOYMENT_DISK), disk("cyrus-worker-sha-unknown")],
			});
			await collector(aca, { now: () => 1_000 * HOUR }).collect();
			expect(aca.deleted).toEqual([]);
		});

		it("prefers the provider's own creation time when it reports a plausible one", async () => {
			// First sight can only ever be LATER than creation, so an image the
			// provider dates as old must not be kept alive by the router having only
			// just noticed it.
			const aca = acaFake({
				disks: [
					disk(DEPLOYMENT_DISK),
					disk("cyrus-worker-sha-dated", {
						createdAtUtc: "2026-01-01T00:00:00.000Z",
					}),
				],
			});
			await collector(aca, {
				now: () => Date.parse("2026-02-01T00:00:00.000Z"),
				imageRetentionMs: 7 * 24 * HOUR,
			}).collect();
			expect(aca.deleted).toEqual(["id-cyrus-worker-sha-dated"]);
		});

		it("refuses a sentinel creation time rather than dating every image as ancient", async () => {
			// The dangerous direction, and the one first-sight cannot cover on its
			// own: the caller takes the EARLIER of the two, so an unsanitised
			// provider value can only ever make an image look older. The field is
			// undeclared on the preview API and has never been observed, so the
			// realistic failure is not a wrong date but a sentinel — .NET's
			// `DateTime.MinValue` parses cleanly and would empty the sandbox group
			// in a single cycle.
			const aca = acaFake({
				disks: [
					disk(DEPLOYMENT_DISK, { createdAtUtc: "0001-01-01T00:00:00+00:00" }),
					disk("cyrus-worker-sha-a", {
						createdAtUtc: "0001-01-01T00:00:00+00:00",
					}),
					disk("cyrus-worker-sha-b", {
						createdAtUtc: "0001-01-01T00:00:00+00:00",
					}),
				],
			});
			// First seen just now, so first-sight alone would spare all of them.
			await collector(aca, { now: () => 10 * HOUR }).collect();
			expect(aca.deleted).toEqual([]);
			expect(
				logger.warn.mock.calls.filter(([m]) =>
					String(m).includes("implausible creation time"),
				).length,
			).toBeGreaterThan(0);
		});

		it("refuses a creation time in the future", async () => {
			// The mirror failure: a future timestamp would pin an image open forever.
			const aca = acaFake({
				disks: [
					disk(DEPLOYMENT_DISK),
					disk("cyrus-worker-sha-future", {
						createdAtUtc: "2099-01-01T00:00:00.000Z",
					}),
				],
			});
			seenAtZero([DEPLOYMENT_DISK, "cyrus-worker-sha-future"]);
			await collector(aca, { now: () => 10 * HOUR }).collect();
			expect(aca.deleted).toEqual(["id-cyrus-worker-sha-future"]);
		});

		it("keeps the newest N unreferenced images whatever their age", async () => {
			// The age floor alone makes rollback depth a function of deploy cadence:
			// a deployment shipping less often than the window is long ends up with
			// nothing to roll back to, silently. The 2026-09-08 audit kept the three
			// newest by hand for exactly this reason.
			const aca = acaFake({
				disks: [
					disk(DEPLOYMENT_DISK),
					disk("cyrus-worker-sha-1"),
					disk("cyrus-worker-sha-2"),
					disk("cyrus-worker-sha-3"),
					disk("cyrus-worker-sha-4"),
				],
			});
			// Built up cumulatively, oldest first: `first_seen_ms` is set on insert
			// only, and a name left out of a call has its sighting dropped. `sha-4`
			// is therefore the oldest and `sha-1` the newest — deliberately the
			// reverse of the listing order, so the floor has to sort by age rather
			// than take the first N it sees.
			const seen = [DEPLOYMENT_DISK, "cyrus-worker-sha-4"];
			store.recordDiskImageSightings(seen, 100);
			for (const [name, at] of [
				["cyrus-worker-sha-3", 200],
				["cyrus-worker-sha-2", 300],
				["cyrus-worker-sha-1", 400],
			] as Array<[string, number]>) {
				seen.push(name);
				store.recordDiskImageSightings(seen, at);
			}

			const summary = await collector(aca, {
				now: () => 10 * HOUR,
				imageRetentionCount: 2,
			}).collect();

			// All four are far past the age window; the two newest survive on the
			// count floor alone.
			expect(
				summary.kept
					.filter((k) => k.reason === "rollback_floor")
					.map((k) => k.diskName)
					.sort(),
			).toEqual(["cyrus-worker-sha-1", "cyrus-worker-sha-2"]);
			expect(aca.deleted.sort()).toEqual([
				"id-cyrus-worker-sha-3",
				"id-cyrus-worker-sha-4",
			]);
		});

		it("does not let a referenced image consume a rollback slot", async () => {
			// A referenced image is already protected; spending a slot on it would
			// shrink the rollback set for no benefit.
			const aca = acaFake({
				disks: [
					disk(DEPLOYMENT_DISK),
					disk("cyrus-worker-sha-live"),
					disk("cyrus-worker-sha-old"),
				],
				sandboxes: [
					{
						id: "sb-1",
						state: "Running",
						labels: { "cyrus.disk": "cyrus-worker-sha-live" },
					},
				] as unknown as AcaSandbox[],
			});
			seenAtZero([
				DEPLOYMENT_DISK,
				"cyrus-worker-sha-live",
				"cyrus-worker-sha-old",
			]);

			const summary = await collector(aca, {
				now: () => 10 * HOUR,
				imageRetentionCount: 1,
			}).collect();

			expect(aca.deleted).toEqual([]);
			expect(summary.kept).toContainEqual({
				diskName: "cyrus-worker-sha-old",
				reason: "rollback_floor",
			});
		});

		it("forgets a disk that disappears, so a re-registered name is new again", async () => {
			seenAtZero(["cyrus-worker-sha-recycled"]);
			// A cycle in which the disk is absent drops its sighting…
			store.recordDiskImageSightings([], HOUR);
			// …so when the name comes back it is dated from now, not from time 0.
			const aca = acaFake({
				disks: [disk(DEPLOYMENT_DISK), disk("cyrus-worker-sha-recycled")],
			});
			await collector(aca, { now: () => 2 * HOUR }).collect();
			expect(aca.deleted).toEqual([]);
		});
	});

	it("skips an image that gains a reference while the cycle is running", async () => {
		// The re-check immediately before the destructive call. Deleting the first
		// image is what gives the second one a pin here, but in production it is a
		// route or a build landing during the provider round trips this cycle spends
		// most of its time in.
		const aca = acaFake({
			disks: [
				disk(DEPLOYMENT_DISK),
				disk("cyrus-worker-sha-a"),
				disk("cyrus-worker-sha-b"),
			],
			onDelete: () => {
				store.setIssueDiskImage(
					{
						issueKey: "NOR-9",
						repositoryName: "api",
						cacheKey: "k9",
						diskName: "cyrus-worker-sha-b",
						imageRef: "acr/x:9",
						deploymentDisk: DEPLOYMENT_DISK,
					},
					0,
				);
			},
		});
		seenAtZero([DEPLOYMENT_DISK, "cyrus-worker-sha-a", "cyrus-worker-sha-b"]);

		const summary = await collector(aca, { now: () => 10 * HOUR }).collect();

		expect(aca.deleted).toEqual(["id-cyrus-worker-sha-a"]);
		expect(summary.kept).toContainEqual({
			diskName: "cyrus-worker-sha-b",
			reason: "issue_pin",
		});
	});

	it("reads each provider inventory exactly once per cycle", async () => {
		const aca = acaFake({
			disks: [
				disk(DEPLOYMENT_DISK),
				disk("cyrus-worker-sha-1"),
				disk("cyrus-worker-sha-2"),
				disk("cyrus-worker-sha-3"),
			],
		});
		seenAtZero([
			DEPLOYMENT_DISK,
			"cyrus-worker-sha-1",
			"cyrus-worker-sha-2",
			"cyrus-worker-sha-3",
		]);

		await collector(aca, { now: () => 10 * HOUR }).collect();

		// Each of these is an ARM call. One per row is how this became the most
		// expensive thing the router did.
		expect(aca.calls).toEqual({ disks: 1, snapshots: 1, sandboxes: 1 });
	});

	it("is non-reentrant: a second cycle started mid-flight does nothing", async () => {
		const aca = acaFake({
			disks: [disk(DEPLOYMENT_DISK), disk("cyrus-worker-sha-old")],
		});
		seenAtZero([DEPLOYMENT_DISK, "cyrus-worker-sha-old"]);
		const gc = collector(aca, { now: () => 10 * HOUR });

		const [first, second] = await Promise.all([gc.collect(), gc.collect()]);

		expect(second.skipped).toBe("in_flight");
		expect(first.deleted).toEqual(["cyrus-worker-sha-old"]);
		// Two cycles would each decide from their own inventory while deleting
		// against the other's.
		expect(aca.calls.disks).toBe(1);
		expect(aca.deleteDiskImage).toHaveBeenCalledTimes(1);
	});

	for (const failing of ["disks", "snapshots", "sandboxes"] as const) {
		it(`deletes nothing when the ${failing} listing cannot be read`, async () => {
			// A listing we could not read is not evidence that nothing references
			// these disks. One slow cycle is cheaper than a sandbox that cannot boot.
			const aca = acaFake({
				disks: [disk(DEPLOYMENT_DISK), disk("cyrus-worker-sha-old")],
				failListing: failing,
			});
			seenAtZero([DEPLOYMENT_DISK, "cyrus-worker-sha-old"]);

			const summary = await collector(aca, { now: () => 10 * HOUR }).collect();

			expect(summary.skipped).toBe("inventory_unreadable");
			expect(aca.deleted).toEqual([]);
		});
	}

	it("reports every keep and delete decision, and the storage reclaimed", async () => {
		const aca = acaFake({
			disks: [
				disk(DEPLOYMENT_DISK, { sizeInMB: 5_000 }),
				disk("cyrus-worker-sha-old", { sizeInMB: 4_000 }),
			],
		});
		seenAtZero([DEPLOYMENT_DISK, "cyrus-worker-sha-old"]);

		await collector(aca, { now: () => 10 * HOUR }).collect();

		expect(eventsNamed(logger, "sandbox.image_decision")).toEqual([
			{
				disk_name: DEPLOYMENT_DISK,
				action: "kept",
				reason: "deployment_disk",
				size_mb: 5_000,
				state: "Ready",
			},
			{
				disk_name: "cyrus-worker-sha-old",
				action: "deleted",
				reason: "unreferenced",
				size_mb: 4_000,
				state: "Ready",
			},
		]);
		expect(eventsNamed(logger, "sandbox.image_gc_completed")[0]).toMatchObject({
			images: 2,
			deleted: 1,
			kept: 1,
			reclaimed_mb: 4_000,
		});
	});

	it("keeps a disk whose delete fails, rather than reporting it reclaimed", async () => {
		const aca = acaFake({
			disks: [disk(DEPLOYMENT_DISK), disk("cyrus-worker-sha-old")],
		});
		aca.deleteDiskImage.mockRejectedValueOnce(new Error("conflict"));
		seenAtZero([DEPLOYMENT_DISK, "cyrus-worker-sha-old"]);

		const summary = await collector(aca, { now: () => 10 * HOUR }).collect();

		expect(summary.deleted).toEqual([]);
		expect(summary.reclaimedMb).toBe(0);
	});
});
