import { describe, expect, it, vi } from "vitest";
import type {
	AcaDiskImage,
	AcaEgressPolicy,
	AcaSandbox,
	AcaSandboxClient,
	AcaSnapshot,
} from "../src/aca/AcaSandboxClient.js";
import { AcaSandboxesProvider } from "../src/aca/AcaSandboxesProvider.js";

/**
 * A typed fake client. Captures every call so tests can assert on bodies,
 * labels, call counts, etc. Cast to `AcaSandboxClient` so the provider's
 * `client` field typechecks without the full method surface.
 */
type FakeClientCalls = {
	listSandboxes: Array<Record<string, string> | undefined>;
	createSandbox: Array<{
		diskImageName?: string;
		diskImageId?: string;
		snapshotId?: string;
		environment?: Record<string, string>;
		resources?: Record<string, string>;
		lifecycle?: {
			autoSuspendPolicy?: { enabled: boolean; interval: number; mode: string };
		};
		labels?: Record<string, string>;
		egressPolicy?: AcaEgressPolicy;
	}>;
	stopSandbox: string[];
	createSnapshot: Array<{ sandboxId: string; labels?: Record<string, string> }>;
	resumeSandbox: string[];
	deleteSandbox: string[];
	listSnapshots: Array<Record<string, string> | undefined>;
	deleteSnapshot: string[];
	listDiskImages: number;
	createDiskImage: Array<{ name: string; image: string }>;
};

function fakeClient(script: {
	sandboxByIssue?: Map<string, AcaSandbox>;
	snapshotsByLabels?: AcaSnapshot[];
	listSandboxesResult?: AcaSandbox[];
	diskImages?: AcaDiskImage[];
	createDiskImageError?: unknown;
	diskImagesAfterCreateError?: AcaDiskImage[];
	failCreateSnapshot?: boolean;
	beforeCreateSnapshot?: () => Promise<void>;
	/** When this predicate returns true for a given id, deleteSandbox throws AFTER recording. */
	failDeleteSandbox?: (id: string) => boolean;
	/** When this predicate returns true for a given id, deleteSnapshot throws AFTER recording. */
	failDeleteSnapshot?: (id: string) => boolean;
	/** Simulate a backend returning foreign rows despite a labels query. */
	ignoreSnapshotFilters?: boolean;
}): {
	client: AcaSandboxClient;
	calls: FakeClientCalls;
} {
	const sandboxStore = script.sandboxByIssue ?? new Map<string, AcaSandbox>();
	const calls: FakeClientCalls = {
		listSandboxes: [],
		createSandbox: [],
		stopSandbox: [],
		createSnapshot: [],
		resumeSandbox: [],
		deleteSandbox: [],
		listSnapshots: [],
		deleteSnapshot: [],
		listDiskImages: 0,
		createDiskImage: [],
	};

	const matchesLabels = (
		labels: Record<string, string> | undefined,
		filter: Record<string, string> | undefined,
	): boolean => {
		if (!filter) return true;
		if (!labels) return false;
		for (const [k, v] of Object.entries(filter)) {
			if (labels[k] !== v) return false;
		}
		return true;
	};

	const client = {
		async listSandboxes(
			labels?: Record<string, string>,
		): Promise<AcaSandbox[]> {
			calls.listSandboxes.push(labels);
			if (script.listSandboxesResult !== undefined) {
				return script.listSandboxesResult.filter((s) =>
					matchesLabels(s.labels, labels),
				);
			}
			const out: AcaSandbox[] = [];
			for (const sb of sandboxStore.values()) {
				if (matchesLabels(sb.labels, labels)) out.push(sb);
			}
			return out;
		},
		async createSandbox(b: {
			diskImageName?: string;
			snapshotId?: string;
			environment?: Record<string, string>;
			resources?: Record<string, string>;
			lifecycle?: {
				autoSuspendPolicy?: {
					enabled: boolean;
					interval: number;
					mode: string;
				};
			};
			labels?: Record<string, string>;
			egressPolicy?: AcaEgressPolicy;
		}): Promise<AcaSandbox> {
			calls.createSandbox.push(b);
			const id = `sb-${calls.createSandbox.length}`;
			const sb: AcaSandbox = {
				id,
				state: "Running",
				labels: b.labels ?? {},
			};
			sandboxStore.set(sb.labels?.["cyrus.issue"] ?? id, sb);
			return sb;
		},
		async stopSandbox(id: string): Promise<void> {
			calls.stopSandbox.push(id);
			const sb = findSandbox(sandboxStore, id);
			if (sb) sb.state = "Stopped";
		},
		async createSnapshot(
			sandboxId: string,
			labels?: Record<string, string>,
		): Promise<AcaSnapshot> {
			calls.createSnapshot.push({ sandboxId, labels });
			await script.beforeCreateSnapshot?.();
			if (script.failCreateSnapshot) throw new Error("snapshot failed");
			const snapshot: AcaSnapshot = {
				id: `stop-snap-${calls.createSnapshot.length}`,
				sandboxId,
				labels,
				createdAtUtc: `2026-07-26T00:00:0${calls.createSnapshot.length}Z`,
			};
			if (!script.snapshotsByLabels) script.snapshotsByLabels = [];
			script.snapshotsByLabels.push(snapshot);
			return snapshot;
		},
		async resumeSandbox(id: string): Promise<void> {
			calls.resumeSandbox.push(id);
			const sb = findSandbox(sandboxStore, id);
			if (sb) sb.state = "Running";
		},
		async deleteSandbox(id: string): Promise<void> {
			calls.deleteSandbox.push(id);
			if (script.failDeleteSandbox?.(id)) throw new Error("detach failed");
			for (const [k, sb] of sandboxStore.entries()) {
				if (sb.id === id) {
					sandboxStore.delete(k);
					return;
				}
			}
		},
		async listSnapshots(
			labels?: Record<string, string>,
		): Promise<AcaSnapshot[]> {
			calls.listSnapshots.push(labels);
			return (script.snapshotsByLabels ?? []).filter(
				(s) => script.ignoreSnapshotFilters || matchesLabels(s.labels, labels),
			);
		},
		async deleteSnapshot(id: string): Promise<void> {
			calls.deleteSnapshot.push(id);
			if (script.failDeleteSnapshot?.(id)) throw new Error("boom");
			if (script.snapshotsByLabels) {
				script.snapshotsByLabels = script.snapshotsByLabels.filter(
					(s) => s.id !== id,
				);
			}
		},
		async listDiskImages(): Promise<AcaDiskImage[]> {
			calls.listDiskImages++;
			return script.diskImages ?? [];
		},
		async createDiskImage(
			name: string,
			image: string,
		): Promise<{ name: string }> {
			calls.createDiskImage.push({ name, image });
			if (script.createDiskImageError) {
				script.diskImages = script.diskImagesAfterCreateError;
				throw script.createDiskImageError;
			}
			if (!script.diskImages) script.diskImages = [];
			script.diskImages.push({ name, image });
			return { name };
		},
	} as unknown as AcaSandboxClient;

	return { client, calls };
}

function findSandbox(
	store: Map<string, AcaSandbox>,
	id: string,
): AcaSandbox | undefined {
	for (const sb of store.values()) {
		if (sb.id === id) return sb;
	}
	return undefined;
}

function ctx(
	overrides: Partial<{
		issueKey: string;
		env: Record<string, string>;
		mintDeviceToken: () => string;
		deviceId: string | undefined;
	}> = {},
): {
	issueKey: string;
	env: Record<string, string>;
	mintDeviceToken: () => string;
	deviceId?: string;
} {
	let mintCount = 0;
	return {
		issueKey: overrides.issueKey ?? "CYPACK-1",
		env: overrides.env ?? { CYRUS_ROUTER_URL: "wss://router.example.com" },
		mintDeviceToken:
			overrides.mintDeviceToken ??
			(() => {
				mintCount++;
				return `tok-${mintCount}`;
			}),
		deviceId: overrides.deviceId,
	};
}

function sb(
	issueKey: string,
	over: Partial<AcaSandbox> & { labels?: Record<string, string> } = {},
): AcaSandbox {
	const { labels: overLabels, ...rest } = over;
	return {
		id: rest.id ?? `sb-${issueKey}`,
		state: rest.state ?? "Running",
		labels: {
			"cyrus.managed": "true",
			"cyrus.issue": issueKey,
			"cyrus.disk": "disk-v1",
			...(overLabels ?? {}),
		},
		...rest,
	};
}

function snap(
	over: Partial<AcaSnapshot> & { labels?: Record<string, string> } = {},
): AcaSnapshot {
	const { labels: overLabels, ...rest } = over;
	return {
		id: rest.id ?? `snap-1`,
		labels: {
			"cyrus.managed": "true",
			"cyrus.issue": "CYPACK-1",
			"cyrus.disk": "disk-v1",
			"cyrus.device-id": "dev-1",
			...(overLabels ?? {}),
		},
		createdAtUtc: rest.createdAtUtc ?? "2026-01-01T00:00:00Z",
		...rest,
	};
}

describe("AcaSandboxesProvider", () => {
	describe("ensureRunning — create-from-image", () => {
		it("creates a sandbox from the disk image with env+token, lifecycle, labels, and egress", async () => {
			const { client, calls } = fakeClient({
				diskImages: [{ name: "disk-v1" }],
			});
			let minted = 0;
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
				routerUrlForContainers: "wss://router.example.com",
			});
			await p.ensureRunning({
				...ctx({
					deviceId: "dev-1",
					mintDeviceToken: () => {
						minted++;
						return "tok-minted";
					},
				}),
			});
			expect(minted).toBe(1);
			expect(calls.createSandbox).toHaveLength(1);
			const b = calls.createSandbox[0];
			expect(b.diskImageName).toBe("disk-v1");
			expect(b.snapshotId).toBeUndefined();
			expect(b.environment?.CYRUS_DEVICE_TOKEN).toBe("tok-minted");
			expect(b.lifecycle?.autoSuspendPolicy?.enabled).toBe(false);
			expect(b.lifecycle?.autoSuspendPolicy?.interval).toBe(0);
			expect(b.labels).toMatchObject({
				"cyrus.managed": "true",
				"cyrus.issue": "CYPACK-1",
				"cyrus.disk": "disk-v1",
				"cyrus.device-id": "dev-1",
			});
			expect(b.egressPolicy?.defaultAction).toBe("Deny");
			// No existing snapshots → no pruning, but listSnapshots was called
			// once (post-create prune lookup, returned empty).
			expect(calls.deleteSnapshot).toHaveLength(0);
			expect(calls.createDiskImage).toHaveLength(0); // already registered
			expect(calls.listDiskImages).toBe(1);
		});

		it("enables ACA auto-suspend only when configured above zero", async () => {
			const { client, calls } = fakeClient({
				diskImages: [{ name: "disk-v1" }],
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
				autoSuspendSeconds: 600,
			});
			await p.ensureRunning(ctx({ deviceId: "dev-1" }));
			expect(calls.createSandbox[0]?.lifecycle?.autoSuspendPolicy).toEqual({
				enabled: true,
				interval: 600,
				mode: "Memory",
			});
		});

		it("registers the disk image when not present (best-effort ensureDisk)", async () => {
			const { client, calls } = fakeClient({ diskImages: [] });
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.ensureRunning(ctx({ deviceId: "dev-1" }));
			expect(calls.createDiskImage).toEqual([
				{ name: "disk-v1", image: "img:1" },
			]);
			expect(calls.createSandbox[0]?.diskImageName).toBe("disk-v1");
		});

		it("uses the id of a registered private disk whose name is a label", async () => {
			const { client, calls } = fakeClient({
				diskImages: [
					{
						id: "private-disk-id",
						labels: { name: "disk-v1" },
						image: { base: "registry.example/worker:sha" },
					},
				],
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "registry.example/worker:sha",
				disk: "disk-v1",
			});
			await p.ensureRunning(ctx({ deviceId: "dev-1" }));
			expect(calls.createDiskImage).toEqual([]);
			expect(calls.createSandbox[0]?.diskImageId).toBe("private-disk-id");
		});

		it("tolerates a concurrent createDiskImage error (logs and continues)", async () => {
			const { client, calls } = fakeClient({
				diskImages: [],
				createDiskImageError: new Error("already exists"),
				diskImagesAfterCreateError: [{ name: "disk-v1" }],
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await expect(
				p.ensureRunning(ctx({ deviceId: "dev-1" })),
			).resolves.toBeUndefined();
			expect(calls.createSandbox).toHaveLength(1);
		});

		it("surfaces a disk registration failure when the disk still does not exist", async () => {
			const { client, calls } = fakeClient({
				diskImages: [],
				createDiskImageError: new Error("registry auth failed"),
				diskImagesAfterCreateError: [],
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await expect(p.ensureRunning(ctx({ deviceId: "dev-1" }))).rejects.toThrow(
				"registry auth failed",
			);
			expect(calls.createSandbox).toHaveLength(0);
			expect(calls.listDiskImages).toBe(2);
		});
	});

	describe("ensureRunning — resume / no-op / transitional", () => {
		it("resumes a stopped (suspended) sandbox when the disk matches — NO create, NO mint", async () => {
			const sandboxByIssue = new Map<string, AcaSandbox>([
				["CYPACK-1", sb("CYPACK-1", { state: "Stopped" })],
			]);
			const { client, calls } = fakeClient({
				sandboxByIssue,
				diskImages: [{ name: "disk-v1" }],
			});
			let minted = 0;
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.ensureRunning({
				...ctx({
					issueKey: "CYPACK-1",
					mintDeviceToken: () => {
						minted++;
						return "tok";
					},
				}),
			});
			expect(minted).toBe(0);
			expect(calls.createSandbox).toHaveLength(0);
			expect(calls.resumeSandbox).toEqual(["sb-CYPACK-1"]);
			expect(calls.stopSandbox).toHaveLength(0);
		});

		it("does nothing when already Running with a matching disk", async () => {
			const sandboxByIssue = new Map<string, AcaSandbox>([
				["CYPACK-1", sb("CYPACK-1", { state: "Running" })],
			]);
			const { client, calls } = fakeClient({
				sandboxByIssue,
				diskImages: [{ name: "disk-v1" }],
			});
			let minted = 0;
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.ensureRunning({
				...ctx({
					issueKey: "CYPACK-1",
					mintDeviceToken: () => {
						minted++;
						return "tok";
					},
				}),
			});
			expect(minted).toBe(0);
			expect(calls.createSandbox).toHaveLength(0);
			expect(calls.resumeSandbox).toHaveLength(0);
			expect(calls.stopSandbox).toHaveLength(0);
			expect(calls.deleteSandbox).toHaveLength(0);
			// exactly one filtered list call, no snapshot calls
			expect(calls.listSandboxes).toHaveLength(1);
			expect(calls.listSnapshots).toHaveLength(0);
		});

		it("resumes a Suspended sandbox when the disk lineage matches", async () => {
			const { client, calls } = fakeClient({
				listSandboxesResult: [
					sb("CYPACK-1", {
						id: "suspended",
						state: "Suspended",
						labels: { "cyrus.device-id": "dev-1" },
					}),
				],
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.ensureRunning(ctx({ deviceId: "dev-1" }));
			expect(calls.resumeSandbox).toEqual(["suspended"]);
			expect(calls.createSandbox).toHaveLength(0);
		});

		it.each(["Resuming", "Stopping", "Creating", "Deleting"] as const)(
			"treats %s as transitional and no-ops (next sweep retries)",
			async (state) => {
				const sandboxByIssue = new Map<string, AcaSandbox>([
					["CYPACK-1", sb("CYPACK-1", { state })],
				]);
				const { client, calls } = fakeClient({
					sandboxByIssue,
					diskImages: [{ name: "disk-v1" }],
				});
				const p = new AcaSandboxesProvider({
					client,
					image: "img:1",
					disk: "disk-v1",
				});
				await p.ensureRunning(ctx({ issueKey: "CYPACK-1", deviceId: "dev-1" }));
				expect(calls.createSandbox).toHaveLength(0);
				expect(calls.resumeSandbox).toHaveLength(0);
				expect(calls.stopSandbox).toHaveLength(0);
			},
		);

		it("retains one deterministic current sandbox and deletes every duplicate", async () => {
			const { client, calls } = fakeClient({
				listSandboxesResult: [
					sb("CYPACK-1", { id: "stopped", state: "Stopped" }),
					sb("CYPACK-1", { id: "running-b", state: "Running" }),
					sb("CYPACK-1", { id: "running-a", state: "Running" }),
					sb("CYPACK-1", {
						id: "stale",
						labels: { "cyrus.disk": "disk-v0" },
					}),
				],
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.ensureRunning(ctx({ deviceId: "dev-1" }));
			expect(calls.deleteSandbox).toEqual(["stopped", "running-b", "stale"]);
			expect(calls.resumeSandbox).toHaveLength(0);
			expect(calls.createSandbox).toHaveLength(0);
		});
	});

	describe("ensureRunning — stale disk replacement", () => {
		it("deletes every stale duplicate before creating a replacement", async () => {
			const { client, calls } = fakeClient({
				listSandboxesResult: [
					sb("CYPACK-1", { id: "stale-a", labels: { "cyrus.disk": "v0" } }),
					sb("CYPACK-1", { id: "stale-b", labels: { "cyrus.disk": "v0" } }),
				],
				diskImages: [{ name: "disk-v1" }],
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.ensureRunning(ctx({ deviceId: "dev-1" }));
			expect(calls.deleteSandbox).toEqual(["stale-a", "stale-b"]);
			expect(calls.createSandbox).toHaveLength(1);
		});

		it("deletes a stale-disk sandbox + its snapshots, then creates from image (and re-mints)", async () => {
			const sandboxByIssue = new Map<string, AcaSandbox>([
				[
					"CYPACK-1",
					sb("CYPACK-1", {
						state: "Running",
						labels: { "cyrus.disk": "disk-v0" },
					}),
				],
			]);
			const snapshotsByLabels = [
				snap({
					id: "snap-old",
					labels: { "cyrus.disk": "disk-v0", "cyrus.device-id": "dev-1" },
				}),
			];
			const { client, calls } = fakeClient({
				sandboxByIssue,
				snapshotsByLabels,
				diskImages: [{ name: "disk-v1" }],
			});
			let minted = 0;
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.ensureRunning({
				...ctx({
					issueKey: "CYPACK-1",
					mintDeviceToken: () => {
						minted++;
						return "tok-new";
					},
					deviceId: "dev-1",
				}),
			});
			expect(calls.deleteSandbox).toEqual(["sb-CYPACK-1"]);
			expect(calls.deleteSnapshot).toEqual(["snap-old"]);
			expect(calls.createSandbox).toHaveLength(1);
			expect(calls.createSandbox[0]?.diskImageName).toBe("disk-v1");
			expect(calls.createSandbox[0]?.snapshotId).toBeUndefined();
			expect(calls.createSandbox[0]?.environment?.CYRUS_DEVICE_TOKEN).toBe(
				"tok-new",
			);
			expect(minted).toBe(1);
		});

		it("aborts replacement when stale sandbox deletion fails", async () => {
			const sandboxByIssue = new Map<string, AcaSandbox>([
				["CYPACK-1", sb("CYPACK-1", { labels: { "cyrus.disk": "disk-v0" } })],
			]);
			const { client, calls } = fakeClient({
				sandboxByIssue,
				diskImages: [{ name: "disk-v1" }],
				failDeleteSandbox: () => true,
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await expect(p.ensureRunning(ctx({ deviceId: "dev-1" }))).rejects.toThrow(
				"detach failed",
			);
			expect(calls.createSandbox).toHaveLength(0);
		});

		it("retains the stale sandbox when snapshot deletion fails", async () => {
			const sandboxByIssue = new Map<string, AcaSandbox>([
				["CYPACK-1", sb("CYPACK-1", { labels: { "cyrus.disk": "disk-v0" } })],
			]);
			const { client, calls } = fakeClient({
				sandboxByIssue,
				snapshotsByLabels: [snap({ id: "stale-snapshot" })],
				failDeleteSnapshot: () => true,
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await expect(
				p.ensureRunning(ctx({ deviceId: "dev-1" })),
			).rejects.toBeInstanceOf(AggregateError);
			expect(calls.deleteSandbox).toHaveLength(0);
			expect(calls.createSandbox).toHaveLength(0);
		});
	});

	describe("ensureRunning — WSS liveness", () => {
		function providerFor(connectivity: {
			connected: boolean;
			disconnectedSinceMs: number;
		}) {
			const sandboxByIssue = new Map<string, AcaSandbox>([
				[
					"CYPACK-1",
					sb("CYPACK-1", { labels: { "cyrus.device-id": "dev-1" } }),
				],
			]);
			const fake = fakeClient({
				sandboxByIssue,
				diskImages: [{ name: "disk-v1" }],
			});
			return {
				...fake,
				provider: new AcaSandboxesProvider({
					client: fake.client,
					image: "img:1",
					disk: "disk-v1",
					now: () => 200_000,
					disconnectedRecreateMs: 120_000,
					deviceConnectivity: () => connectivity,
				}),
			};
		}

		it("never recreates a connected Running worker", async () => {
			const { provider, calls } = providerFor({
				connected: true,
				disconnectedSinceMs: 0,
			});
			await provider.ensureRunning(ctx({ deviceId: "dev-1" }));
			expect(calls.deleteSandbox).toHaveLength(0);
			expect(calls.createSandbox).toHaveLength(0);
		});

		it("tolerates the first transient disconnect inside the grace interval", async () => {
			const { provider, calls } = providerFor({
				connected: false,
				disconnectedSinceMs: 100_000,
			});
			await provider.ensureRunning(ctx({ deviceId: "dev-1" }));
			expect(calls.deleteSandbox).toHaveLength(0);
		});

		it("recreates a Running worker disconnected beyond the bounded interval", async () => {
			const { provider, calls } = providerFor({
				connected: false,
				disconnectedSinceMs: 50_000,
			});
			await provider.ensureRunning(ctx({ deviceId: "dev-1" }));
			expect(calls.deleteSandbox).toEqual(["sb-CYPACK-1"]);
			expect(calls.createSandbox[0]?.diskImageName).toBe("disk-v1");
		});
	});

	describe("ensureRunning — lineage restore (B5)", () => {
		it("creates from a matching labeled snapshot WITHOUT re-minting, and lifecycle stays disabled (F2)", async () => {
			const snapshotsByLabels = [
				snap({
					id: "snap-good",
					createdAtUtc: "2026-07-01T00:00:00Z",
					labels: {
						"cyrus.disk": "disk-v1",
						"cyrus.device-id": "dev-1",
					},
				}),
				// older matching one — should NOT be picked; newest wins
				snap({
					id: "snap-older",
					createdAtUtc: "2026-06-01T00:00:00Z",
					labels: {
						"cyrus.disk": "disk-v1",
						"cyrus.device-id": "dev-1",
					},
				}),
			];
			const { client, calls } = fakeClient({
				snapshotsByLabels,
				diskImages: [{ name: "disk-v1" }],
			});
			let minted = 0;
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.ensureRunning({
				...ctx({
					issueKey: "CYPACK-1",
					mintDeviceToken: () => {
						minted++;
						return "tok";
					},
					deviceId: "dev-1",
				}),
			});
			expect(minted).toBe(0);
			expect(calls.createSandbox).toHaveLength(1);
			expect(calls.createSandbox[0]?.snapshotId).toBe("snap-good");
			expect(calls.createSandbox[0]?.diskImageName).toBeUndefined();
			// F2: lifecycle MUST be set even on create-from-snapshot
			expect(
				calls.createSandbox[0]?.lifecycle?.autoSuspendPolicy?.enabled,
			).toBe(false);
			expect(calls.createSandbox[0]?.labels?.["cyrus.device-id"]).toBe("dev-1");
			// ensureDisk NOT called on a snapshot restore
			expect(calls.listDiskImages).toBe(0);
		});

		it("falls back to create-from-image and re-mints when a DIFFERENT device-id is on the snapshot (lineage MISMATCH)", async () => {
			const snapshotsByLabels = [
				snap({
					id: "snap-wrong",
					labels: {
						"cyrus.disk": "disk-v1",
						"cyrus.device-id": "dev-old-gen",
					},
				}),
			];
			const { client, calls } = fakeClient({
				snapshotsByLabels,
				diskImages: [{ name: "disk-v1" }],
			});
			let minted = 0;
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.ensureRunning({
				...ctx({
					issueKey: "CYPACK-1",
					mintDeviceToken: () => {
						minted++;
						return "tok-fresh";
					},
					deviceId: "dev-new",
				}),
			});
			expect(minted).toBe(1);
			expect(calls.createSandbox).toHaveLength(1);
			expect(calls.createSandbox[0]?.snapshotId).toBeUndefined();
			expect(calls.createSandbox[0]?.diskImageName).toBe("disk-v1");
			expect(calls.createSandbox[0]?.environment?.CYRUS_DEVICE_TOKEN).toBe(
				"tok-fresh",
			);
			// Rotation makes every prior snapshot unsafe, even when the device id
			// happens to match, so deletion completes before minting.
			expect(calls.deleteSnapshot).toEqual(["snap-wrong"]);
		});

		it("aborts before mint/create when any pre-rotation snapshot deletion fails", async () => {
			const { client, calls } = fakeClient({
				snapshotsByLabels: [snap({ id: "unsafe" })],
				diskImages: [{ name: "disk-v1" }],
				failDeleteSnapshot: () => true,
			});
			let minted = 0;
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await expect(
				p.ensureRunning(
					ctx({ deviceId: "dev-new", mintDeviceToken: () => `${++minted}` }),
				),
			).rejects.toBeInstanceOf(AggregateError);
			expect(minted).toBe(0);
			expect(calls.createSandbox).toHaveLength(0);
		});
	});

	describe("ensureRunning — F2 guard (deviceId absent)", () => {
		it("skips the lineage lookup and always creates-from-image when ctx.deviceId is undefined", async () => {
			const snapshotsByLabels = [
				snap({
					id: "snap-legacy",
					labels: {
						"cyrus.disk": "disk-v1",
						"cyrus.device-id": "dev-1",
					},
				}),
			];
			const { client, calls } = fakeClient({
				snapshotsByLabels,
				diskImages: [{ name: "disk-v1" }],
			});
			let minted = 0;
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.ensureRunning({
				issueKey: "CYPACK-1",
				env: { CYRUS_ROUTER_URL: "wss://router.example.com" },
				mintDeviceToken: () => {
					minted++;
					return "tok";
				},
				// deviceId intentionally undefined
			});
			expect(minted).toBe(1);
			expect(calls.createSandbox[0]?.diskImageName).toBe("disk-v1");
			// lineage lookup did not query by device-id; only the post-create
			// prune lookup happened (labels carry no device-id when undefined).
			expect(
				calls.createSandbox[0]?.labels?.["cyrus.device-id"],
			).toBeUndefined();
		});
	});

	describe("ensureRunning — snapshot pruning", () => {
		it("prunes down to keepSnapshots newest after a successful create path", async () => {
			const snapshotsByLabels = [
				snap({ id: "s1", createdAtUtc: "2026-01-01T00:00:00Z" }),
				snap({ id: "s2", createdAtUtc: "2026-02-01T00:00:00Z" }),
				snap({ id: "s3", createdAtUtc: "2026-03-01T00:00:00Z" }),
				snap({ id: "s4", createdAtUtc: "2026-04-01T00:00:00Z" }),
			];
			const { client, calls } = fakeClient({
				snapshotsByLabels,
				diskImages: [{ name: "disk-v1" }],
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
				keepSnapshots: 2,
			});
			await p.ensureRunning(ctx({ issueKey: "CYPACK-1", deviceId: "dev-1" }));
			// keep newest 2 (Mar + Apr); delete the other 2.
			expect(calls.deleteSnapshot.sort()).toEqual(["s1", "s2"]);
		});

		it("never prunes foreign snapshots missing the full explicit label set", async () => {
			const snapshotsByLabels = [
				snap({ id: "new", createdAtUtc: "2026-04-01T00:00:00Z" }),
				snap({ id: "old", createdAtUtc: "2026-01-01T00:00:00Z" }),
				snap({
					id: "foreign",
					createdAtUtc: "2025-01-01T00:00:00Z",
					labels: { "cyrus.managed": "false" },
				}),
			];
			const { client, calls } = fakeClient({
				snapshotsByLabels,
				diskImages: [{ name: "disk-v1" }],
				ignoreSnapshotFilters: true,
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
				keepSnapshots: 1,
			});
			await p.ensureRunning(ctx({ deviceId: "dev-1" }));
			expect(calls.deleteSnapshot).toEqual(["old"]);
		});

		it("serializes a concurrent ensureRunning for the same issue — only ONE create", async () => {
			const { client, calls } = fakeClient({
				diskImages: [{ name: "disk-v1" }],
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			// Two concurrent calls: the second joins the first inside the lock.
			// On a brand-new issue both would otherwise observe absent and both
			// create + mint. The lock must collapse them.
			const c = ctx({ issueKey: "CYPACK-1", deviceId: "dev-1" });
			await Promise.all([p.ensureRunning(c), p.ensureRunning(c)]);
			expect(calls.createSandbox).toHaveLength(1);
		});
	});

	describe("snapshot orphan GC", () => {
		it("plans and deletes only true orphans while retaining rows, live sandboxes, in-use snapshots, and foreign snapshots", async () => {
			const snapshotsByLabels = [
				snap({ id: "active", labels: { "cyrus.issue": "LIVE-ROW" } }),
				snap({ id: "live-sandbox", labels: { "cyrus.issue": "LIVE-SB" } }),
				snap({
					id: "attached",
					sandboxId: "sb-unlabelled",
					labels: { "cyrus.issue": "OLD-ATTACHED" },
				}),
				snap({ id: "source", labels: { "cyrus.issue": "OLD-SOURCE" } }),
				snap({ id: "orphan", labels: { "cyrus.issue": "OLD-1" } }),
				snap({
					id: "foreign",
					labels: {
						"cyrus.managed": "false",
						"cyrus.issue": "OLD-FOREIGN",
					},
				}),
				{ id: "unlabeled" },
				{
					id: "partially-labeled",
					labels: { "cyrus.managed": "true", "cyrus.issue": "OLD-PARTIAL" },
				},
			];
			const { client, calls } = fakeClient({
				snapshotsByLabels,
				ignoreSnapshotFilters: true,
				listSandboxesResult: [
					sb("LIVE-SB"),
					{ id: "sb-unlabelled", state: "Running" },
					{
						id: "sb-from-source",
						state: "Running",
						sourcesRef: { snapshot: { id: "source" } },
					},
				],
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});

			await expect(p.planOrphanSnapshots(["LIVE-ROW"])).resolves.toEqual([
				expect.objectContaining({ id: "orphan", issueKey: "OLD-1" }),
			]);
			expect(calls.deleteSnapshot).toEqual([]);
			await expect(p.gcOrphanSnapshots(["LIVE-ROW"])).resolves.toEqual([
				expect.objectContaining({ id: "orphan" }),
			]);
			expect(calls.deleteSnapshot).toEqual(["orphan"]);
		});
	});

	describe("stop", () => {
		it("snapshots and stops every Running duplicate", async () => {
			const { client, calls } = fakeClient({
				listSandboxesResult: [
					sb("CYPACK-1", { id: "a", labels: { "cyrus.device-id": "dev-1" } }),
					sb("CYPACK-1", { id: "b", labels: { "cyrus.device-id": "dev-1" } }),
				],
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.stop("CYPACK-1");
			expect(calls.createSnapshot.map((call) => call.sandboxId)).toEqual([
				"a",
				"b",
			]);
			expect(calls.stopSandbox).toEqual(["a", "b"]);
		});

		it("creates a fully labeled explicit snapshot before stopping a Running sandbox", async () => {
			const sandboxByIssue = new Map<string, AcaSandbox>([
				[
					"CYPACK-1",
					sb("CYPACK-1", {
						state: "Running",
						labels: { "cyrus.device-id": "dev-1" },
					}),
				],
			]);
			const { client, calls } = fakeClient({ sandboxByIssue });
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.stop("CYPACK-1");
			expect(calls.createSnapshot).toEqual([
				{
					sandboxId: "sb-CYPACK-1",
					labels: {
						"cyrus.managed": "true",
						"cyrus.issue": "CYPACK-1",
						"cyrus.disk": "disk-v1",
						"cyrus.device-id": "dev-1",
					},
				},
			]);
			expect(calls.stopSandbox).toEqual(["sb-CYPACK-1"]);
		});

		it("does not stop when explicit snapshot creation fails", async () => {
			const sandboxByIssue = new Map<string, AcaSandbox>([
				[
					"CYPACK-1",
					sb("CYPACK-1", { labels: { "cyrus.device-id": "dev-1" } }),
				],
			]);
			const { client, calls } = fakeClient({
				sandboxByIssue,
				failCreateSnapshot: true,
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await expect(p.stop("CYPACK-1")).rejects.toThrow("snapshot failed");
			expect(calls.stopSandbox).toHaveLength(0);
		});

		it("restores a stop-created snapshot without rotating the token", async () => {
			const sandboxByIssue = new Map<string, AcaSandbox>([
				[
					"CYPACK-1",
					sb("CYPACK-1", { labels: { "cyrus.device-id": "dev-1" } }),
				],
			]);
			const script = { sandboxByIssue, snapshotsByLabels: [] as AcaSnapshot[] };
			const { client, calls } = fakeClient(script);
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.stop("CYPACK-1");
			sandboxByIssue.clear();
			let minted = 0;
			await p.ensureRunning(
				ctx({ deviceId: "dev-1", mintDeviceToken: () => `${++minted}` }),
			);
			expect(calls.createSandbox.at(-1)?.snapshotId).toBe("stop-snap-1");
			expect(minted).toBe(0);
		});

		it("serializes stop and ensureRunning so a concurrent boot resumes the completed stop", async () => {
			let releaseSnapshot!: () => void;
			let snapshotStarted!: () => void;
			const started = new Promise<void>((resolve) => {
				snapshotStarted = resolve;
			});
			const blocked = new Promise<void>((resolve) => {
				releaseSnapshot = resolve;
			});
			const sandboxByIssue = new Map<string, AcaSandbox>([
				[
					"CYPACK-1",
					sb("CYPACK-1", { labels: { "cyrus.device-id": "dev-1" } }),
				],
			]);
			const { client, calls } = fakeClient({
				sandboxByIssue,
				beforeCreateSnapshot: async () => {
					snapshotStarted();
					await blocked;
				},
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			const stopping = p.stop("CYPACK-1");
			await started;
			const booting = p.ensureRunning(ctx({ deviceId: "dev-1" }));
			expect(calls.resumeSandbox).toHaveLength(0);
			releaseSnapshot();
			await Promise.all([stopping, booting]);
			expect(calls.stopSandbox).toEqual(["sb-CYPACK-1"]);
			expect(calls.resumeSandbox).toEqual(["sb-CYPACK-1"]);
		});

		it("no-ops on a Stopped sandbox", async () => {
			const sandboxByIssue = new Map<string, AcaSandbox>([
				["CYPACK-1", sb("CYPACK-1", { state: "Stopped" })],
			]);
			const { client, calls } = fakeClient({ sandboxByIssue });
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.stop("CYPACK-1");
			expect(calls.stopSandbox).toHaveLength(0);
		});

		it("no-ops when absent", async () => {
			const { client, calls } = fakeClient({});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.stop("CYPACK-1");
			expect(calls.stopSandbox).toHaveLength(0);
		});
	});

	describe("destroy", () => {
		it("deletes every duplicate and aggregates partial sandbox and snapshot failures", async () => {
			const { client, calls } = fakeClient({
				listSandboxesResult: [
					sb("CYPACK-1", { id: "a" }),
					sb("CYPACK-1", { id: "b" }),
				],
				snapshotsByLabels: [snap({ id: "s1" }), snap({ id: "s2" })],
				failDeleteSandbox: (id) => id === "a",
				failDeleteSnapshot: (id) => id === "s1",
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			const error = await p.destroy("CYPACK-1").catch((caught) => caught);
			expect(error).toBeInstanceOf(AggregateError);
			expect((error as AggregateError).errors).toHaveLength(2);
			expect(calls.deleteSandbox).toEqual(["a", "b"]);
			expect(calls.deleteSnapshot).toEqual(["s1", "s2"]);
		});

		it("deletes the sandbox and ALL issue snapshots", async () => {
			const sandboxByIssue = new Map<string, AcaSandbox>([
				["CYPACK-1", sb("CYPACK-1", { state: "Running" })],
			]);
			const snapshotsByLabels = [
				snap({ id: "s1", labels: { "cyrus.device-id": "dev-1" } }),
				snap({ id: "s2", labels: { "cyrus.device-id": "dev-2" } }),
			];
			const { client, calls } = fakeClient({
				sandboxByIssue,
				snapshotsByLabels,
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.destroy("CYPACK-1");
			expect(calls.deleteSandbox).toEqual(["sb-CYPACK-1"]);
			expect(calls.deleteSnapshot.sort()).toEqual(["s1", "s2"]);
		});

		it("attempts every snapshot and throws on a partial snapshot-delete failure", async () => {
			const snapshotsByLabels = [snap({ id: "s1" }), snap({ id: "s2" })];
			const { client, calls } = fakeClient({
				snapshotsByLabels,
				failDeleteSnapshot: (id) => id === "s2",
			});
			const warn = vi.fn();
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
				logger: { info: () => {}, warn },
			});
			await expect(p.destroy("CYPACK-1")).rejects.toBeInstanceOf(
				AggregateError,
			);
			expect(calls.deleteSnapshot.sort()).toEqual(["s1", "s2"]);
		});

		it("tolerates an absent sandbox", async () => {
			const { client, calls } = fakeClient({});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await expect(p.destroy("CYPACK-1")).resolves.toBeUndefined();
			expect(calls.deleteSandbox).toHaveLength(0);
			expect(calls.deleteSnapshot).toHaveLength(0);
		});

		it("throws on a sandbox delete failure but still deletes every snapshot", async () => {
			const sandboxByIssue = new Map<string, AcaSandbox>([
				["CYPACK-1", sb("CYPACK-1", { state: "Running" })],
			]);
			const snapshotsByLabels = [snap({ id: "s1" })];
			const { client, calls } = fakeClient({
				sandboxByIssue,
				snapshotsByLabels,
				failDeleteSandbox: (id) => id === "sb-CYPACK-1",
			});
			const warn = vi.fn();
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
				logger: { info: () => {}, warn },
			});
			await expect(p.destroy("CYPACK-1")).rejects.toBeInstanceOf(
				AggregateError,
			);
			expect(calls.deleteSandbox).toEqual(["sb-CYPACK-1"]);
			expect(calls.deleteSnapshot).toEqual(["s1"]);
		});
	});

	describe("status", () => {
		it("reports running when any duplicate is Running", async () => {
			const { client } = fakeClient({
				listSandboxesResult: [
					sb("CYPACK-1", { id: "a", state: "Stopped" }),
					sb("CYPACK-1", { id: "b", state: "Running" }),
				],
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			expect(await p.status("CYPACK-1")).toBe("running");
		});

		it("maps absent → absent", async () => {
			const { client } = fakeClient({});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			expect(await p.status("CYPACK-1")).toBe("absent");
		});
		it("maps Running → running", async () => {
			const sandboxByIssue = new Map<string, AcaSandbox>([
				["CYPACK-1", sb("CYPACK-1", { state: "Running" })],
			]);
			const { client } = fakeClient({ sandboxByIssue });
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			expect(await p.status("CYPACK-1")).toBe("running");
		});
		it("maps Stopped → stopped (suspended case per spike)", async () => {
			const sandboxByIssue = new Map<string, AcaSandbox>([
				["CYPACK-1", sb("CYPACK-1", { state: "Stopped" })],
			]);
			const { client } = fakeClient({ sandboxByIssue });
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			expect(await p.status("CYPACK-1")).toBe("stopped");
		});
		it("maps any other present state → stopped", async () => {
			const sandboxByIssue = new Map<string, AcaSandbox>([
				["CYPACK-1", sb("CYPACK-1", { state: "Creating" })],
			]);
			const { client } = fakeClient({ sandboxByIssue });
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			expect(await p.status("CYPACK-1")).toBe("stopped");
		});
	});

	describe("listManaged", () => {
		it("makes exactly ONE listSandboxes call and returns issue keys from labels", async () => {
			const listSandboxesResult: AcaSandbox[] = [
				sb("CYR-1", { id: "a", labels: { "cyrus.issue": "CYR-1" } }),
				sb("CYR-1", { id: "a-duplicate", labels: { "cyrus.issue": "CYR-1" } }),
				sb("CYR-2", { id: "b", labels: { "cyrus.issue": "CYR-2" } }),
				sb("", { id: "c", labels: { "cyrus.managed": "true" } }), // no issue label
			];
			const { client, calls } = fakeClient({ listSandboxesResult });
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			const keys = await p.listManaged();
			expect(keys).toEqual(["CYR-1", "CYR-2"]);
			expect(calls.listSandboxes).toHaveLength(1);
			expect(calls.listSnapshots).toHaveLength(0);
		});
	});

	describe("D7 default egress allowlist", () => {
		it("includes GitHub, Anthropic (api+console), Linear (mcp+api), pypi, and the router host from routerUrlForContainers", async () => {
			const { client, calls } = fakeClient({
				diskImages: [{ name: "disk-v1" }],
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
				routerUrlForContainers: "wss://router.example.com",
			});
			await p.ensureRunning(ctx({ deviceId: "dev-1" }));
			const rules = calls.createSandbox[0]?.egressPolicy?.hostRules ?? [];
			const patterns = rules.map((r) => r.pattern);
			expect(calls.createSandbox[0]?.egressPolicy?.defaultAction).toBe("Deny");
			expect(calls.createSandbox[0]?.egressPolicy?.trafficInspection).toBe(
				"Full",
			);
			expect(patterns).toContain("*.github.com");
			expect(patterns).toContain("api.anthropic.com");
			expect(patterns).toContain("console.anthropic.com");
			expect(patterns).toContain("mcp.linear.app");
			expect(patterns).toContain("pypi.org");
			expect(rules).toContainEqual({
				pattern: "router.example.com",
				action: "Allow",
			});
		});

		it("omits the router host when routerUrlForContainers is absent", async () => {
			const { client, calls } = fakeClient({
				diskImages: [{ name: "disk-v1" }],
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.ensureRunning(ctx({ deviceId: "dev-1" }));
			const rules = calls.createSandbox[0]?.egressPolicy?.hostRules ?? [];
			expect(
				rules.find((r) => r.pattern === "router.example.com"),
			).toBeUndefined();
		});

		it("preserves default hosts when an egress policy omits hostRules", async () => {
			const { client, calls } = fakeClient({
				diskImages: [{ name: "disk-v1" }],
			});
			const egress: AcaEgressPolicy = {
				defaultAction: "Allow",
				trafficInspection: "None",
			};
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
				egress,
			});
			await p.ensureRunning(ctx({ deviceId: "dev-1" }));
			expect(calls.createSandbox[0]?.egressPolicy).toMatchObject(egress);
			expect(
				calls.createSandbox[0]?.egressPolicy?.hostRules?.map(
					(rule) => rule.pattern,
				),
			).toContain("api.github.com");
		});

		it("uses explicitly configured hostRules instead of the defaults", async () => {
			const { client, calls } = fakeClient({
				diskImages: [{ name: "disk-v1" }],
			});
			const egress: AcaEgressPolicy = {
				defaultAction: "Deny",
				trafficInspection: "Full",
				hostRules: [{ pattern: "example.com", action: "Allow" }],
			};
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
				egress,
			});
			await p.ensureRunning(ctx({ deviceId: "dev-1" }));
			expect(calls.createSandbox[0]?.egressPolicy).toEqual(egress);
		});
	});

	describe("label hygiene (S5)", () => {
		it("stores the EXACT issue key in the cyrus.issue label (no sanitization)", async () => {
			const { client, calls } = fakeClient({
				diskImages: [{ name: "disk-v1" }],
			});
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await p.ensureRunning(ctx({ issueKey: "PAR-169", deviceId: "dev-1" }));
			expect(calls.createSandbox[0]?.labels?.["cyrus.issue"]).toBe("PAR-169");
		});

		it("rejects label values longer than 63 chars before network calls", async () => {
			const { client, calls } = fakeClient({
				diskImages: [{ name: "disk-v1" }],
			});
			const longKey = "A".repeat(80);
			const p = new AcaSandboxesProvider({
				client,
				image: "img:1",
				disk: "disk-v1",
			});
			await expect(
				p.ensureRunning(ctx({ issueKey: longKey, deviceId: "dev-1" })),
			).rejects.toThrow("cyrus.issue must be at most 63 characters");
			expect(calls.listSandboxes).toHaveLength(0);
		});
	});
});
