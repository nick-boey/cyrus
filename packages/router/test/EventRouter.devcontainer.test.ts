import type { AgentEvent } from "cyrus-core";
import type {
	ContainerExecutor,
	IssueExecutionContext,
} from "cyrus-router-executors";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { ContainerTargetService } from "../src/ContainerTargets.js";
import type { EnsureOutcome } from "../src/devcontainer/DevcontainerImageService.js";
import { EventRouter } from "../src/EventRouter.js";
import type { RegisteredRepository } from "../src/RepositoryRegistry.js";
import { RepositoryResolver } from "../src/RepositoryResolver.js";
import { RouterStore } from "../src/RouterStore.js";
import type { SecretStoreBackend } from "../src/SecretStore.js";
import { testLogger } from "./helpers/logger.js";

/**
 * NOR-309 Task 7: the environment gate holds the `created` webhook while an
 * image builds, and releases it when the build finishes.
 *
 * The hold is the point. A build is minutes of ACR compute, and paying them
 * with the webhook held is strictly better than creating a device row and a
 * sandbox for an issue whose image does not exist yet.
 */

const API: RegisteredRepository = {
	name: "cyrus-api",
	githubSlug: "acme/cyrus-api",
	linearWorkspaceId: "ws-1",
	teamKeys: ["NOR"],
};
const WEB: RegisteredRepository = {
	name: "cyrus-web",
	githubSlug: "acme/cyrus-web",
	linearWorkspaceId: "ws-1",
	teamKeys: ["NOR"],
};

const ALICE = { id: "user-1", email: "alice@example.com", name: "Alice" };

function createdEvent(): AgentEvent {
	return {
		type: "AgentSessionEvent",
		action: "created",
		organizationId: "ws-1",
		agentSession: {
			id: "sess-1",
			organizationId: "ws-1",
			issueId: "issue-1",
			issue: { id: "issue-1", identifier: "NOR-1" },
			creator: ALICE,
		},
	} as unknown as AgentEvent;
}

function fakeExecutor(): ContainerExecutor & { ensureRunning: Mock } {
	return {
		provider: "aca",
		ensureRunning: vi.fn<(ctx: IssueExecutionContext) => Promise<void>>(
			async () => {},
		),
		destroy: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		status: vi.fn(async () => "running" as const),
		listManaged: vi.fn(async () => []),
	};
}

describe("EventRouter devcontainer gate", () => {
	let store: RouterStore;
	let enqueued: string[];
	let postActivity: Mock;

	beforeEach(() => {
		store = new RouterStore(":memory:");
		enqueued = [];
		postActivity = vi.fn(async () => {});
	});

	function harness(
		repositories: RegisteredRepository[],
		outcomes: EnsureOutcome[],
	) {
		store.addUser({ email: "alice@example.com" });
		store.setUserExecutor("alice@example.com", JSON.stringify({ type: "aca" }));

		const registry = {
			list: vi.fn(async () => ({ repositories })),
			put: vi.fn(async () => ({ version: "1" })),
		};
		const resolver = new RepositoryResolver({
			registry,
			fetchIssueFacts: vi.fn(async () => ({ teamKey: "NOR" }) as never),
			logger: testLogger(),
		});
		const secrets: SecretStoreBackend = {
			get: async () => ({}),
			set: async () => {},
			isFullyAuthenticated: async () => ({ ok: true, missing: [] }),
		};
		let release: ((cacheKey: string) => void) | undefined;
		let call = 0;
		const devcontainers = {
			ensureForIssue: vi.fn(
				async () =>
					outcomes[Math.min(call++, outcomes.length - 1)] as EnsureOutcome,
			),
			diskForIssue: () => undefined,
			setOnBuildFinished: (fn: (cacheKey: string) => void) => {
				release = fn;
			},
			statusFor: () => undefined,
			warmBuild: () => {},
		};
		const router = new EventRouter({
			store,
			gateway: { isOnline: () => false, deliverPending: vi.fn() },
			postActivity,
			containerTargets: new ContainerTargetService({
				store,
				secrets,
				executors: new Map([["aca", fakeExecutor()]]),
				registry: {
					list: vi.fn(async () => ({ repositories: [] })),
					put: vi.fn(async () => ({ version: "1" })),
				},
				containersConfig: {
					routerUrlForContainers: "wss://router.example.com",
				},
				postActivity: async () => {},
				logger: testLogger(),
			}),
			repositoryResolver: resolver,
			postRepositorySelection: vi.fn(async () => {}),
			devcontainers: devcontainers as any,
			registry,
			config: {
				eventTtlMs: 60_000,
				issueLock: false,
				creatorOnlyPrompting: false,
				affinityGraceMs: 600_000,
			},
			logger: testLogger(),
		});
		vi.spyOn(store, "enqueueEvent").mockImplementation((_deviceId, payload) => {
			enqueued.push(payload);
			return 1;
		});
		return { router, devcontainers, releaseBuild: () => release?.("k1") };
	}

	it("delivers immediately when the repository declares no devcontainer", async () => {
		const { router } = harness([API], [{ kind: "default" }]);
		await router.route(createdEvent());
		expect(enqueued).toHaveLength(1);
		expect(store.getPendingDevcontainerBuild("sess-1")).toBeUndefined();
	});

	it("holds the created event while the image builds, and says so once", async () => {
		const { router } = harness(
			[API],
			[{ kind: "building", cacheKey: "k1", repositoryName: "cyrus-api" }],
		);
		await router.route(createdEvent());
		expect(enqueued).toHaveLength(0);
		const held = store.getPendingDevcontainerBuild("sess-1");
		expect(held).toMatchObject({ issueKey: "NOR-1", cacheKey: "k1" });
		expect(postActivity).toHaveBeenCalledTimes(1);
		expect(postActivity.mock.calls[0]?.[2]).toMatch(
			/Building the workspace image/,
		);

		// A repeated `created` delivery for a session already waiting must not
		// post a second notice or overwrite the held event.
		await router.route(createdEvent());
		expect(postActivity).toHaveBeenCalledTimes(1);
		expect(enqueued).toHaveLength(0);
	});

	it("replays the held event when the build finishes", async () => {
		const { router, releaseBuild } = harness(
			[API],
			[
				{ kind: "building", cacheKey: "k1", repositoryName: "cyrus-api" },
				{ kind: "ready", diskName: "d", repositoryName: "cyrus-api" },
			],
		);
		await router.route(createdEvent());
		expect(enqueued).toHaveLength(0);

		releaseBuild();
		await new Promise((r) => setTimeout(r, 0));
		expect(enqueued).toHaveLength(1);
		// Taken in one transaction, so a build finishing can never replay twice.
		expect(store.getPendingDevcontainerBuild("sess-1")).toBeUndefined();
	});

	it("falls back to the default image on a failed build rather than holding forever", async () => {
		const { router } = harness(
			[API],
			[{ kind: "failed", reason: "boom", runId: "ca9" }],
		);
		await router.route(createdEvent());
		expect(enqueued).toHaveLength(1);
		expect(postActivity.mock.calls[0]?.[2]).toMatch(/ca9/);
		expect(postActivity.mock.calls[0]?.[2]).toMatch(/default environment/);
	});

	it("uses the default image for a multi-repository issue, and names what that costs", async () => {
		// Task 8 is blocked on an open question; the default worker image is the
		// plan's own recommended answer, and the only one that is safe without
		// asking.
		const { router, devcontainers } = harness(
			[API, WEB],
			[{ kind: "default" }],
		);
		store.setIssueRepositories(
			"NOR-1",
			{
				repoNames: ["cyrus-api", "cyrus-web"],
				baseBranchOverrides: {},
				method: "description-tag",
			},
			1000,
		);
		await router.route(createdEvent());
		expect(devcontainers.ensureForIssue).not.toHaveBeenCalled();
		expect(enqueued).toHaveLength(1);
		expect(postActivity.mock.calls[0]?.[2]).toMatch(
			/spans several repositories/,
		);
	});
});
