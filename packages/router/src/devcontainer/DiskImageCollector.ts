import { cyrusAttributes, type ILogger } from "cyrus-core";
import type { AcaDiskImage, AcaSandboxClient } from "cyrus-router-executors";
import type { RouterStore } from "../RouterStore.js";
import {
	SANDBOX_EVENTS,
	type SandboxImageKeepReason,
} from "../SandboxTelemetry.js";

/**
 * CYR-84: reference-counted garbage collection of the ACA disk images a
 * deployment has registered.
 *
 * It lives beside {@link DevcontainerImageService} and not inside it because
 * the two answer to different configuration. The service exists only when a
 * deployment builds per-repository images; this has to run wherever ACA is
 * configured at all, since the images that actually accumulate are the
 * DEPLOYMENT worker images that `scripts/deploy-worker-image.sh` registers out
 * of band — one per build, forever, with nothing that ever looks at them. The
 * 2026-09-08 audit found fourteen registered images totalling 68 GB, eight of
 * them old, ready and referenced by nothing.
 *
 * The service still owns the entry point (`collectGarbage()` delegates here),
 * so a deployment that does build per-repository images gets exactly one
 * collector rather than two racing over the same inventory.
 */

/**
 * 7 days — default {@link DiskImageCollectorDeps.imageRetentionMs}.
 *
 * A worker image is registered as a disk BEFORE anything boots from it, and a
 * rollback repins an image that by then has no sandbox, no snapshot and no pin.
 * Both look exactly like garbage to a reference count, so the reference count
 * alone would delete the deployment that is about to happen and the one you
 * would roll back to. This window is the difference.
 *
 * Sized in deployments, not in bytes: it has to cover enough of them that the
 * image an operator would reach for under pressure is still there. A week is
 * several at the observed cadence, and the audit that prompted this kept the
 * three newest by hand for the same reason. Erring long costs disk — the eight
 * images reclaimed in that audit were 32.5 GiB — while erring short costs a
 * rollback at the moment it is needed, which is not a trade a GC should make on
 * its own.
 */
export const DEFAULT_IMAGE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The disk-name prefix Cyrus registers under, and therefore the only images it
 * will ever delete.
 *
 * Both producers agree on it: `diskNameFor` emits `cyrus-<repo>-<hash>` for a
 * per-repository image and `scripts/deploy-worker-image.sh` emits
 * `cyrus-worker-<build>` (its `DISK_PREFIX`) for a deployment image. Anything
 * else in the sandbox group was put there by somebody for a reason this process
 * does not know, and reclaiming disk is not worth guessing about it.
 *
 * A floor, not the protection: an operator who overrides the name with
 * `--disk-name` gets an image this GC ignores entirely — the safe direction —
 * and such an image is protected by every other rule anyway the moment it is the
 * deployment disk or has a sandbox on it.
 */
export const MANAGED_DISK_PREFIX = "cyrus-";

/**
 * 3 — default {@link DiskImageCollectorDeps.imageRetentionCount}.
 *
 * How many unreferenced images are kept regardless of age, newest first.
 *
 * The age floor alone is cadence-dependent, and that dependency is invisible
 * until it bites: a deployment that ships weekly keeps several rollback
 * candidates inside a 7-day window, while one that ships monthly keeps ZERO —
 * seven days after each deploy the group holds exactly the current deployment
 * disk and nothing to fall back to. A count floor makes rollback depth a
 * property of the policy rather than of how often anyone happens to deploy.
 *
 * 3 is what the 2026-09-08 audit kept by hand, for the same reason.
 */
export const DEFAULT_IMAGE_RETENTION_COUNT = 3;

/**
 * The earliest instant a disk-image creation timestamp may plausibly claim.
 *
 * See {@link providerCreatedMs}. The field this bounds is undeclared on the
 * preview API and has never been observed; a zero/unset value serialised as
 * .NET's `DateTime.MinValue` (`0001-01-01T00:00:00Z`) parses cleanly and would
 * date every image as ancient, which deletes the whole unreferenced set in one
 * cycle. Anything before Cyrus existed is a sentinel, not a date.
 */
const EARLIEST_PLAUSIBLE_CREATED_MS = Date.UTC(2020, 0, 1);

export interface DiskImageCollectorDeps {
	store: RouterStore;
	logger: ILogger;
	/** ACA data-plane client, for listing and deleting disk images. */
	aca: AcaSandboxClient;
	/** The deployment's default disk. Never collected. */
	deploymentDisk: string;
	/** Default {@link DEFAULT_IMAGE_RETENTION_MS}. */
	imageRetentionMs?: number;
	/** Default {@link DEFAULT_IMAGE_RETENTION_COUNT}. */
	imageRetentionCount?: number;
	/**
	 * Report every decision and delete nothing. The way to watch a cycle before
	 * trusting it with a deployment's images; see {@link DiskImageGcSummary}.
	 */
	dryRun?: boolean;
	now?: () => number;
}

/** What one {@link DiskImageCollector.collect} cycle did. */
export interface DiskImageGcSummary {
	/** Registered disk images the provider reported this cycle. */
	inspected: number;
	/** Names of the images deleted — or, under `dryRun`, that would have been. */
	deleted: string[];
	/** Storage reclaimed, summed from the provider's own `sizeInMB`. */
	reclaimedMb: number;
	/** Every image that was spared, and the protection that spared it. */
	kept: Array<{ diskName: string; reason: SandboxImageKeepReason }>;
	/** True when nothing was actually deleted because `dryRun` is set. */
	dryRun?: boolean;
	/**
	 * Set when the cycle did no work. `in_flight` means a previous cycle was
	 * still running; `inventory_unreadable` means a provider listing failed and
	 * the reference count would therefore have been a guess.
	 */
	skipped?: "in_flight" | "inventory_unreadable";
}

export class DiskImageCollector {
	/** Non-undefined while a cycle is running; see {@link collect}. */
	private inFlight: Promise<DiskImageGcSummary> | undefined;

	constructor(private readonly deps: DiskImageCollectorDeps) {}

	/**
	 * One GC cycle: delete every registered disk image that nothing references
	 * and that is past the retention window.
	 *
	 * The inventory reconciled is the PROVIDER'S, not the devcontainer cache
	 * table's, and that is the whole point. Iterating `repo_devcontainer_images`
	 * meant an image could only be collected if the router had built it, so the
	 * deployment worker images accumulated with no candidate rule that could ever
	 * reach them. A GC that cannot see a resource cannot even report that it is
	 * leaking it.
	 *
	 * Protections, in the precedence they are reported in. The first five are
	 * reference counts, not heuristics:
	 *  - not a Cyrus-registered disk name at all ({@link MANAGED_DISK_PREFIX});
	 *  - the deployment's own default disk, always;
	 *  - any disk a live sandbox was created from, by `cyrus.disk` label and by
	 *    `sourcesRef.diskImage` (name or id) — a sandbox may predate the label;
	 *  - any disk a snapshot's lineage names, since a snapshot restores the image
	 *    it came from and would resurrect a deleted one;
	 *  - any disk an issue is pinned to, or that a devcontainer cache row still
	 *    names — a build in flight, or the newest ready build for a repository so
	 *    the next issue on it does not rebuild what we just deleted;
	 *  - anything whose import is still in progress, which is what a deployment in
	 *    flight looks like (a FAILED import is not covered — it will never become
	 *    ready, and protecting it forever leaks its storage);
	 *  - the newest {@link DiskImageCollectorDeps.imageRetentionCount}
	 *    unreferenced images, whatever their age;
	 *  - and anything inside {@link DiskImageCollectorDeps.imageRetentionMs},
	 *    because a staged or rollback image is by definition referenced by
	 *    nothing yet.
	 *
	 * The last two are both needed and neither subsumes the other: the age floor
	 * covers a burst of deploys inside one window, and the count floor is what
	 * stops rollback depth from silently becoming zero on a deployment that ships
	 * less often than the window is long.
	 *
	 * Exactly one provider read per resource type per cycle — disks, snapshots,
	 * sandboxes — because each is an ARM call and the previous implementation made
	 * one per row. Any of the three failing skips the cycle entirely: a listing we
	 * could not read is not evidence that nothing references these disks, and one
	 * slow cycle is cheaper than a sandbox that cannot restore.
	 *
	 * Non-reentrant, for the same reason `ContainerLifecycle.sweep` is: it is
	 * fired by an interval and a cycle can outlive it, and two cycles would each
	 * decide from their own inventory while deleting against the other's.
	 */
	collect(): Promise<DiskImageGcSummary> {
		if (this.inFlight) {
			this.deps.logger.warn(
				"Disk-image GC is still running; skipping this cycle",
			);
			return Promise.resolve({
				inspected: 0,
				deleted: [],
				reclaimedMb: 0,
				kept: [],
				skipped: "in_flight",
			});
		}
		this.inFlight = this.collectOnce().finally(() => {
			this.inFlight = undefined;
		});
		return this.inFlight;
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	private get retentionMs(): number {
		return this.deps.imageRetentionMs ?? DEFAULT_IMAGE_RETENTION_MS;
	}

	private get retentionCount(): number {
		return this.deps.imageRetentionCount ?? DEFAULT_IMAGE_RETENTION_COUNT;
	}

	private async collectOnce(): Promise<DiskImageGcSummary> {
		const now = this.now();
		let disks: AcaDiskImage[];
		let byProvider: Map<string, SandboxImageKeepReason>;
		try {
			// One call per resource type, disks first: the sandbox pass resolves
			// `sourcesRef.diskImage.id` against this listing.
			disks = await this.deps.aca.listDiskImages();
			byProvider = await this.providerProtections(disks);
		} catch (error) {
			this.deps.logger.warn(
				"Skipping disk-image GC: the provider inventory could not be read",
				error,
			);
			return {
				inspected: 0,
				deleted: [],
				reclaimedMb: 0,
				kept: [],
				skipped: "inventory_unreadable",
			};
		}

		const named = disks.flatMap((disk) => {
			const diskName = diskNameOf(disk);
			if (diskName) return [{ disk, diskName }];
			// Unidentifiable is unprotectable: no rule above could ever exempt it,
			// so it must never be a delete candidate either.
			this.deps.logger.warn(
				`Registered disk image ${disk.id ?? "(no id)"} carries neither a name nor a name label; leaving it alone`,
			);
			return [];
		});
		const firstSeen = this.deps.store.recordDiskImageSightings(
			named.map((d) => d.diskName),
			now,
		);
		const createdMs = new Map(
			named.map(({ disk, diskName }) => [
				diskName,
				this.createdMsFor(disk, firstSeen.get(diskName) ?? now, now),
			]),
		);
		const rollbackFloor = this.rollbackFloor(named, byProvider, createdMs);

		const deleted: string[] = [];
		const kept: Array<{ diskName: string; reason: SandboxImageKeepReason }> =
			[];
		let reclaimedMb = 0;
		for (const { disk, diskName } of named) {
			const reason = this.keepReasonFor(
				disk,
				diskName,
				byProvider,
				rollbackFloor,
				createdMs.get(diskName) ?? now,
				now,
			);
			if (reason) {
				kept.push({ diskName, reason });
				this.noteDecision(disk, diskName, "kept", reason);
				continue;
			}
			// Re-read the STORE protections immediately before the delete. A route
			// pinning an issue, a build finishing, or a deployment repinning all land
			// here, and this cycle has been awaiting provider calls since the set
			// above was built. The provider-side protections are deliberately NOT
			// re-read: that would be a second inventory call per candidate, which is
			// the cost model this method exists to keep, and a sandbox or snapshot
			// created since is one created from a disk that a pin or the deployment
			// disk already protects.
			const late = this.storeProtections().get(diskName);
			if (late) {
				kept.push({ diskName, reason: late });
				this.noteDecision(disk, diskName, "kept", late);
				continue;
			}
			if (!disk.id) {
				this.deps.logger.warn(
					`Disk image ${diskName} is unreferenced but has no id to delete it by`,
				);
				continue;
			}
			if (!this.deps.dryRun) {
				try {
					await this.deps.aca.deleteDiskImage(disk.id);
				} catch (error) {
					this.deps.logger.warn(
						`could not delete disk image ${diskName}`,
						error,
					);
					continue;
				}
			}
			deleted.push(diskName);
			reclaimedMb += disk.sizeInMB ?? 0;
			this.noteDecision(disk, diskName, "deleted");
		}

		this.collectCacheRows(byProvider);

		this.deps.logger.event(
			SANDBOX_EVENTS.imageGcCompleted,
			cyrusAttributes({
				images: named.length,
				deleted: deleted.length,
				kept: kept.length,
				reclaimed_mb: reclaimedMb,
				retention_ms: this.retentionMs,
				retention_count: this.retentionCount,
				dry_run: this.deps.dryRun === true,
				duration_ms: this.now() - now,
			}),
		);
		this.deps.logger.info(
			`Disk-image GC ${this.deps.dryRun ? "would have reclaimed" : "reclaimed"} ` +
				`${deleted.length} of ${named.length} registered images ` +
				`(${reclaimedMb} MB)${
					deleted.length > 0 ? `: ${deleted.join(", ")}` : ""
				}`,
		);
		return {
			inspected: named.length,
			deleted,
			reclaimedMb,
			kept,
			...(this.deps.dryRun ? { dryRun: true } : {}),
		};
	}

	/**
	 * When this image came into existence, as well as we can establish it.
	 *
	 * The EARLIER of the provider's own timestamp and first sight, because first
	 * sight can only ever be later than creation — so trusting it where a real
	 * timestamp exists would keep an image past its window. The provider value is
	 * bounded first (see {@link providerCreatedMs}); an implausible one is
	 * discarded rather than allowed to date an image as ancient.
	 */
	private createdMsFor(
		disk: AcaDiskImage,
		firstSeenMs: number,
		nowMs: number,
	): number {
		const reported = providerCreatedMs(disk, nowMs, (raw) => {
			this.deps.logger.warn(
				`Disk image ${diskNameOf(disk) ?? disk.id} reports an implausible ` +
					`creation time (${raw}); dating it from when this router first saw ` +
					`it instead`,
			);
		});
		return Math.min(reported ?? firstSeenMs, firstSeenMs);
	}

	/**
	 * The newest {@link DiskImageCollectorDeps.imageRetentionCount} unreferenced
	 * images, kept regardless of age.
	 *
	 * The age floor alone makes rollback depth a function of DEPLOY CADENCE, and
	 * silently so: a deployment shipping weekly keeps several candidates inside a
	 * 7-day window, one shipping monthly keeps none at all — seven days after each
	 * deploy the group holds the current deployment disk and nothing to fall back
	 * to. Counting is what makes the depth a property of the policy.
	 *
	 * Only UNREFERENCED images are counted, because a referenced one is already
	 * protected and letting it consume a slot would shrink the rollback set for no
	 * benefit. Non-`Ready` images are excluded for the same reason.
	 */
	private rollbackFloor(
		named: ReadonlyArray<{ disk: AcaDiskImage; diskName: string }>,
		byProvider: ReadonlyMap<string, SandboxImageKeepReason>,
		createdMs: ReadonlyMap<string, number>,
	): Set<string> {
		if (this.retentionCount <= 0) return new Set();
		const byStore = this.storeProtections();
		return new Set(
			named
				.filter(
					({ disk, diskName }) =>
						diskName.startsWith(MANAGED_DISK_PREFIX) &&
						!byProvider.has(diskName) &&
						!byStore.has(diskName) &&
						diskImageState(disk) === "Ready",
				)
				.sort(
					(a, b) =>
						(createdMs.get(b.diskName) ?? 0) - (createdMs.get(a.diskName) ?? 0),
				)
				.slice(0, this.retentionCount)
				.map((d) => d.diskName),
		);
	}

	/**
	 * Why this image is being spared, or `undefined` if nothing spares it.
	 *
	 * Ordered so the reported reason is the STRONGEST protection rather than
	 * whichever happened to be checked first: "a sandbox is running on it" and
	 * "it is four days old" are very different answers to an operator asking why
	 * 68 GB has not gone anywhere.
	 */
	private keepReasonFor(
		disk: AcaDiskImage,
		diskName: string,
		byProvider: ReadonlyMap<string, SandboxImageKeepReason>,
		rollbackFloor: ReadonlySet<string>,
		createdMs: number,
		now: number,
	): SandboxImageKeepReason | undefined {
		if (!diskName.startsWith(MANAGED_DISK_PREFIX)) return "unmanaged";
		const referenced =
			byProvider.get(diskName) ?? this.storeProtections().get(diskName);
		if (referenced) return referenced;
		const state = diskImageState(disk);
		// A `Failed`/`Error` import is a dead resource that still occupies storage,
		// and it is never going to become `Ready`. Protecting every non-`Ready`
		// state indefinitely would leak exactly those forever, so the protection is
		// for imports that are still IN PROGRESS — which is what a deployment in
		// flight looks like. A failed one falls through to the age floors and is
		// collected on the same terms as any other unreferenced image.
		if (state !== "Ready" && state !== "Failed" && state !== "Error") {
			return "not_ready";
		}
		if (rollbackFloor.has(diskName)) return "rollback_floor";
		if (now - createdMs < this.retentionMs) return "retained";
		return undefined;
	}

	/**
	 * Protections that come from the PROVIDER: every disk a live sandbox boots
	 * from, and every disk a snapshot's lineage names.
	 *
	 * Sandboxes are read UNFILTERED — no `cyrus.managed` label filter — because
	 * the question here is "is anything at all running on this image", and a
	 * sandbox created outside the provider's labelling (by hand, by an older
	 * build) still makes its disk load-bearing.
	 */
	private async providerProtections(
		disks: readonly AcaDiskImage[],
	): Promise<Map<string, SandboxImageKeepReason>> {
		const nameById = new Map<string, string>();
		for (const disk of disks) {
			const diskName = diskNameOf(disk);
			if (disk.id && diskName) nameById.set(disk.id, diskName);
		}
		const found = new Map<string, SandboxImageKeepReason>();
		const protect = (
			name: string | undefined,
			reason: SandboxImageKeepReason,
		): void => {
			if (name && !found.has(name)) found.set(name, reason);
		};
		for (const sandbox of await this.deps.aca.listSandboxes()) {
			protect(sandbox.labels?.["cyrus.disk"], "sandbox_source");
			const source = sandbox.sourcesRef?.diskImage;
			if (typeof source?.name === "string") {
				protect(source.name, "sandbox_source");
			}
			if (typeof source?.id === "string") {
				protect(nameById.get(source.id), "sandbox_source");
			}
		}
		// UNFILTERED, for exactly the reason the sandbox listing is. Filtering on
		// `cyrus.managed` would miss a snapshot taken by hand — the documented
		// break-glass before a `router containers destroy` — whose source sandbox
		// is then destroyed and whose issue pin goes with the device row. Seven
		// days later the source image would be deleted and that snapshot could
		// never be restored. It is the same single ARM call either way.
		for (const snapshot of await this.deps.aca.listSnapshots()) {
			protect(snapshot.labels?.["cyrus.disk"], "snapshot_lineage");
		}
		return found;
	}

	/**
	 * Protections that come from the ROUTER'S OWN STORE: the deployment disk,
	 * live issue pins, and devcontainer cache rows.
	 *
	 * Cheap by construction (three small tables) precisely so it can be re-read
	 * immediately before every delete without the re-check becoming its own cost
	 * problem.
	 */
	private storeProtections(): Map<string, SandboxImageKeepReason> {
		const found = new Map<string, SandboxImageKeepReason>();
		found.set(this.deps.deploymentDisk, "deployment_disk");
		// The pins directly, not only via `referencedDevcontainerCacheKeys`: a pin
		// outlives its cache row, and resolving a key with no row yields nothing.
		for (const pin of this.deps.store.listIssueDiskImages()) {
			if (!found.has(pin.diskName)) found.set(pin.diskName, "issue_pin");
		}
		for (const key of this.deps.store.referencedDevcontainerCacheKeys()) {
			const row = this.deps.store.getDevcontainerImage(key);
			if (row && !found.has(row.diskName)) found.set(row.diskName, "issue_pin");
		}
		const newestPerRepository = new Set<string>();
		for (const row of this.deps.store.listDevcontainerImages()) {
			// A build in flight has no disk registered yet, but it is about to, and a
			// cycle that straddles the registration must not delete it.
			if (row.state === "building") {
				if (!found.has(row.diskName))
					found.set(row.diskName, "cache_reference");
				continue;
			}
			if (row.state !== "ready") continue;
			// `listDevcontainerImages` is ordered newest-first, so the first ready row
			// seen for a repository is the one to keep.
			if (newestPerRepository.has(row.repositoryName)) continue;
			newestPerRepository.add(row.repositoryName);
			if (!found.has(row.diskName)) found.set(row.diskName, "cache_reference");
		}
		return found;
	}

	/**
	 * Drops cache rows nothing references any more.
	 *
	 * Keyed on REFERENCES only — deliberately not on the age retention that
	 * spares the disk itself. A superseded image younger than the retention window
	 * keeps its disk (it may yet be rolled back to) but loses its cache row, which
	 * is what the previous behaviour did and what stops the table growing one row
	 * per build forever. The disk is then collected by name on a later cycle once
	 * it ages out; the inventory pass no longer needs a cache row to find it.
	 */
	private collectCacheRows(
		byProvider: ReadonlyMap<string, SandboxImageKeepReason>,
	): void {
		const protections = this.storeProtections();
		for (const row of this.deps.store.listDevcontainerImages()) {
			if (row.state === "building") continue;
			if (protections.has(row.diskName)) continue;
			if (byProvider.has(row.diskName)) continue;
			this.deps.store.deleteDevcontainerImage(row.cacheKey);
			this.deps.logger.info(
				`Dropped the cache row for unreferenced devcontainer image ${row.diskName} (${row.repositoryName})`,
			);
		}
	}

	/**
	 * One line and one event per image the GC looked at, keep or delete.
	 *
	 * A keep is as much of a record as a delete here, and the asymmetry is the
	 * reason: a wrongly-DELETED rollback image is invisible in any rollup and
	 * surfaces only as a boot that cannot find its disk, while a wrongly-KEPT one
	 * shows up as a bill. The only way to answer "why is this image still here"
	 * without re-deriving the whole reference count by hand is to have written
	 * down the protection that spared it.
	 */
	private noteDecision(
		disk: AcaDiskImage,
		diskName: string,
		action: "kept" | "deleted",
		reason?: SandboxImageKeepReason,
	): void {
		this.deps.logger.event(
			SANDBOX_EVENTS.imageDecision,
			cyrusAttributes({
				disk_name: diskName,
				action,
				reason: reason ?? "unreferenced",
				size_mb: disk.sizeInMB ?? null,
				state: diskImageState(disk) || null,
			}),
		);
		this.deps.logger.info(
			action === "deleted"
				? `Deleted unreferenced disk image ${diskName} (${disk.sizeInMB ?? "unknown"} MB)`
				: `Kept disk image ${diskName}: ${reason}`,
		);
	}
}

/**
 * The name a disk image is known by.
 *
 * `labels.name` first: the server assigns its own GUID as `name` and preserves
 * the requested name as a label, so for anything Cyrus registered the label is
 * the real identity and `name` is an opaque id. `name` is the fallback for a
 * disk registered some other way.
 */
export function diskNameOf(disk: AcaDiskImage): string | undefined {
	return disk.labels?.name ?? disk.name;
}

/** The import state, which the wire returns as either a string or `{state}`. */
function diskImageState(disk: AcaDiskImage): string {
	return typeof disk.status === "string"
		? disk.status
		: (disk.status?.state ?? "");
}

/**
 * The provider's own creation timestamp, when it reports a PLAUSIBLE one.
 *
 * Deliberately tolerant about the field name and about its absence: the ACA
 * spike recorded no timestamp on a disk image at all, and the retention policy
 * must not silently become a no-op — or, worse, delete everything — depending on
 * which of those the preview API happens to return this month. `undefined` sends
 * the caller to the router's own first-sight record instead.
 *
 * The bounds are the load-bearing part, because the caller takes the EARLIER of
 * this and first sight: an unsanitised value can only ever make an image look
 * OLDER, never younger, so first sight provides no protection in the dangerous
 * direction. The field is undeclared on the preview API and has never been
 * observed, so the realistic failure is not a wrong date but a SENTINEL —
 * .NET's `DateTime.MinValue` serialises as `0001-01-01T00:00:00+00:00`, which
 * `Date.parse` accepts happily and which would date every unreferenced image as
 * ancient and delete the entire set in one cycle. A future timestamp is rejected
 * for the mirror reason: it would pin an image open forever.
 *
 * A rejected value is reported, not swallowed: a preview API that starts
 * emitting one is something an operator wants to know about before the next
 * cycle, not after.
 */
function providerCreatedMs(
	disk: AcaDiskImage,
	nowMs: number,
	onRejected?: (raw: string) => void,
): number | undefined {
	const raw = disk.createdAtUtc ?? disk.createdAt;
	if (typeof raw !== "string") return undefined;
	const parsed = Date.parse(raw);
	if (Number.isNaN(parsed)) {
		onRejected?.(raw);
		return undefined;
	}
	if (parsed < EARLIEST_PLAUSIBLE_CREATED_MS || parsed > nowMs) {
		onRejected?.(raw);
		return undefined;
	}
	return parsed;
}
