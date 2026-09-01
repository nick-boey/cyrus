import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	AcrDevcontainerBuilder,
	DevcontainerBuildResult,
} from "../src/devcontainer/AcrDevcontainerBuilder.js";
import { DevcontainerImageService } from "../src/devcontainer/DevcontainerImageService.js";
import type { RegisteredRepository } from "../src/RepositoryRegistry.js";
import { RouterStore } from "../src/RouterStore.js";

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as unknown as ILogger;

const REPO: RegisteredRepository = {
	name: "api",
	githubSlug: "acme/api",
	linearWorkspaceId: "ws",
	baseBranch: "main",
};

let dir: string;
let store: RouterStore;

/** The tenant is read from the ARM token's own `tid` claim, so it must be a JWT. */
function fakeArmJwt(): string {
	const payload = Buffer.from(JSON.stringify({ tid: "tenant-1" })).toString(
		"base64url",
	);
	return `header.${payload}.sig`;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "cyrus-devc-"));
	store = new RouterStore(join(dir, "router.db"));
});

afterEach(() => {
	vi.unstubAllGlobals();
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

interface Harness {
	service: DevcontainerImageService;
	builds: string[];
	diskImages: Array<{ id: string; labels: { name: string }; status: string }>;
	deletedDisks: string[];
	settle: () => Promise<void>;
}

function harness(
	opts: {
		devcontainer?: string | undefined;
		buildResult?: DevcontainerBuildResult;
		snapshots?: Array<{ labels: Record<string, string> }>;
		deploymentDisk?: string;
	} = {},
): Harness {
	const builds: string[] = [];
	const deletedDisks: string[] = [];
	const diskImages: Array<{
		id: string;
		labels: { name: string };
		status: string;
	}> = [];
	let resolveBuild: (() => void) | undefined;

	const fetchFn = (async (url: string) => {
		if (
			opts.devcontainer !== undefined &&
			url.includes("contents/.devcontainer/devcontainer.json?")
		) {
			return { status: 200, ok: true, text: async () => opts.devcontainer };
		}
		if (url.includes("/oauth2/exchange")) {
			// The ACR refresh-token exchange `az acr login --expose-token` performs.
			return {
				status: 200,
				ok: true,
				json: async () => ({ refresh_token: "acr-refresh" }),
				text: async () => "",
			};
		}
		return { status: 404, ok: false, text: async () => "" };
	}) as unknown as typeof fetch;
	// The service builds its own fetch through `fetchDevcontainer`; inject by
	// patching the global for the duration of the test.
	vi.stubGlobal("fetch", fetchFn);

	const builder = {
		imageRef: (tag: string) => `acr.azurecr.io/cyrus/devcontainers:${tag}`,
		build: async (req: { repositoryName: string }) => {
			builds.push(req.repositoryName);
			await new Promise<void>((r) => {
				resolveBuild = r;
			});
			const result = opts.buildResult ?? {
				runId: "ca1",
				status: "Succeeded" as const,
				image: "acr.azurecr.io/cyrus/devcontainers:x",
			};
			return result;
		},
	} as unknown as AcrDevcontainerBuilder;

	const aca = {
		listDiskImages: async () => diskImages,
		createDiskImage: async (name: string) => {
			const row = { id: `id-${name}`, labels: { name }, status: "Ready" };
			diskImages.push(row);
			return row;
		},
		waitForDiskImageReady: async (name: string) => ({
			id: `id-${name}`,
			labels: { name },
		}),
		deleteDiskImage: async (id: string) => {
			deletedDisks.push(id);
		},
		listSnapshots: async () => opts.snapshots ?? [],
	} as unknown as Parameters<typeof DevcontainerImageService> extends never
		? never
		: never;

	const service = new DevcontainerImageService({
		store,
		logger,
		builder,
		aca: aca as any,
		getArmToken: async () => fakeArmJwt(),
		githubToken: "gh",
		deploymentDisk: opts.deploymentDisk ?? "cyrus-worker-v1",
		workerFeatureRef: "ghcr.io/x/cyrus-worker:0.1.0",
		workerFeatureVersion: "0.1.0",
		workerPayloadTarball: "https://example/worker.tgz",
		registryLoginServer: "acr.azurecr.io",
		diskReadyTimeoutMs: 1000,
		diskReadyPollMs: 0,
	});

	return {
		service,
		builds,
		diskImages,
		deletedDisks,
		settle: async () => {
			resolveBuild?.();
			// Two macrotask turns: one for the build promise, one for the
			// finally-block bookkeeping and the completion callback.
			await new Promise((r) => setTimeout(r, 0));
			await new Promise((r) => setTimeout(r, 0));
		},
	};
}

describe("ensureForIssue", () => {
	it("reports `default` for a repository declaring no devcontainer", async () => {
		const h = harness({ devcontainer: undefined });
		await expect(h.service.ensureForIssue("NOR-1", REPO)).resolves.toEqual({
			kind: "default",
		});
		expect(h.builds).toEqual([]);
	});

	it("starts one build and holds, then reports ready once it finishes", async () => {
		const h = harness({ devcontainer: '{"image":"node:22-slim"}' });
		const first = await h.service.ensureForIssue("NOR-1", REPO);
		expect(first.kind).toBe("building");
		await h.settle();
		const second = await h.service.ensureForIssue("NOR-1", REPO);
		if (second.kind === "failed") throw new Error(second.reason);
		expect(second).toMatchObject({ kind: "ready", repositoryName: "api" });
	});

	it("is single-flight: a second issue joins the running build", async () => {
		const h = harness({ devcontainer: '{"image":"node:22-slim"}' });
		await h.service.ensureForIssue("NOR-1", REPO);
		await h.service.ensureForIssue("NOR-2", REPO);
		// A build is minutes of ACR agent compute; a second one would push the
		// same tag from a second checkout of the same ref.
		expect(h.builds).toEqual(["api"]);
		await h.settle();
	});

	it("reports `failed` with the run id rather than holding forever", async () => {
		const h = harness({
			devcontainer: '{"image":"node:22-slim"}',
			buildResult: { runId: "ca9", status: "Failed", logTail: "boom" },
		});
		await h.service.ensureForIssue("NOR-1", REPO);
		await h.settle();
		const outcome = await h.service.ensureForIssue("NOR-1", REPO);
		expect(outcome.kind).toBe("failed");
		if (outcome.kind === "failed") expect(outcome.runId).toBe("ca9");
	});

	it("surfaces an unusable devcontainer instead of silently defaulting", async () => {
		const h = harness({
			devcontainer: '{"dockerComposeFile":"docker-compose.yml"}',
		});
		const outcome = await h.service.ensureForIssue("NOR-1", REPO);
		expect(outcome.kind).toBe("failed");
		if (outcome.kind === "failed") {
			expect(outcome.reason).toMatch(/dockerComposeFile/);
		}
	});
});

describe("the pin, and the staleness split it encodes", () => {
	it("is decided ONCE: a devcontainer edit does not move a live issue", async () => {
		const h = harness({ devcontainer: '{"image":"node:22-slim"}' });
		await h.service.ensureForIssue("NOR-1", REPO);
		await h.settle();
		await h.service.ensureForIssue("NOR-1", REPO);
		const pinned = h.service.diskForIssue("NOR-1");
		expect(pinned).toBeDefined();

		// The repository author edits their devcontainer. Treating that like a
		// worker-image bump would cold-restart every in-flight issue on this
		// repository AND delete the snapshots that would have made the restore
		// warm — see the `cyrus.disk` replace-on-mismatch rule.
		const edited = harness({ devcontainer: '{"image":"node:24-slim"}' });
		// Same store, so the pin is visible to the second service.
		expect(edited.service.diskForIssue("NOR-1")).toBe(pinned);
	});

	it("goes stale when the DEPLOYMENT's own worker image moves", async () => {
		const h = harness({ devcontainer: '{"image":"node:22-slim"}' });
		await h.service.ensureForIssue("NOR-1", REPO);
		await h.settle();
		await h.service.ensureForIssue("NOR-1", REPO);
		expect(h.service.diskForIssue("NOR-1")).toBeDefined();

		// A new deployment disk means a new worker feature underneath every
		// repository image, so every pin made under the old one is void.
		const bumped = harness({
			devcontainer: '{"image":"node:22-slim"}',
			deploymentDisk: "cyrus-worker-v2",
		});
		expect(bumped.service.diskForIssue("NOR-1")).toBeUndefined();
	});

	it("reports no pin for an issue that never had one", () => {
		const h = harness();
		expect(h.service.diskForIssue("NOR-404")).toBeUndefined();
	});
});

describe("collectGarbage", () => {
	it("never deletes a disk a live issue is pinned to", async () => {
		const h = harness({ devcontainer: '{"image":"node:22-slim"}' });
		await h.service.ensureForIssue("NOR-1", REPO);
		await h.settle();
		await h.service.ensureForIssue("NOR-1", REPO);
		await h.service.collectGarbage();
		expect(h.deletedDisks).toEqual([]);
	});

	it("keeps the newest ready image per repository even with no pin", async () => {
		const h = harness({ devcontainer: '{"image":"node:22-slim"}' });
		await h.service.ensureForIssue("NOR-1", REPO);
		await h.settle();
		await h.service.ensureForIssue("NOR-1", REPO);
		store.deleteIssueDiskImage("NOR-1");
		await h.service.collectGarbage();
		// Deleting it would make the next issue on this repository rebuild what
		// we just threw away.
		expect(h.deletedDisks).toEqual([]);
	});

	it("collects a superseded image once nothing references it", async () => {
		const h = harness({ devcontainer: '{"image":"node:22-slim"}' });
		await h.service.ensureForIssue("NOR-1", REPO);
		await h.settle();
		await h.service.ensureForIssue("NOR-1", REPO);
		store.deleteIssueDiskImage("NOR-1");

		// A newer build for the same repository takes over as "newest ready".
		const newer = harness({ devcontainer: '{"image":"node:24-slim"}' });
		newer.diskImages.push(...h.diskImages.map((d) => ({ ...d })));
		await newer.service.ensureForIssue("NOR-2", REPO);
		await newer.settle();
		await newer.service.ensureForIssue("NOR-2", REPO);
		store.deleteIssueDiskImage("NOR-2");
		await newer.service.collectGarbage();
		expect(newer.deletedDisks.length).toBe(1);
	});

	it("skips the sweep entirely when the snapshot listing cannot be read", async () => {
		const h = harness({ devcontainer: '{"image":"node:22-slim"}' });
		await h.service.ensureForIssue("NOR-1", REPO);
		await h.settle();
		await h.service.ensureForIssue("NOR-1", REPO);
		store.deleteIssueDiskImage("NOR-1");
		// A listing we could not read is not evidence that nothing references
		// these disks; guessing costs a resurrected sandbox that cannot restore.
		(h.service as any).deps.aca.listSnapshots = async () => {
			throw new Error("throttled");
		};
		await h.service.collectGarbage();
		expect(h.deletedDisks).toEqual([]);
	});
});
