import type { AgentEvent } from "cyrus-core";
import type {
	ContainerExecutor,
	IssueExecutionContext,
} from "cyrus-router-executors";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { ContainerTargetService } from "../src/ContainerTargets.js";
import { EventRouter, type EventRouterOptions } from "../src/EventRouter.js";
import {
	PROMPT_REJECTION_MESSAGE,
	REPOSITORY_SELECTION_EXPIRED_MESSAGE,
} from "../src/messages.js";
import type { RegisteredRepository } from "../src/RepositoryRegistry.js";
import { RepositoryResolver } from "../src/RepositoryResolver.js";
import { RouterStore } from "../src/RouterStore.js";
import type { SecretStoreBackend } from "../src/SecretStore.js";

/**
 * This file follows the conventions established in `EventRouter.test.ts`:
 * a `RouterStore(":memory:")` per test, a minimal fake `Gateway`, a fake
 * `ContainerExecutor`, and small webhook-builder functions rather than
 * inline literals repeated across cases. It adds only what those existing
 * helpers don't cover — a repository-selection resolver/store harness and a
 * `prompted` builder that carries a body, needed to answer an elicitation.
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

interface Creator {
	id: string;
	email: string;
	name: string;
}

const ALICE: Creator = {
	id: "user-1",
	email: "alice@example.com",
	name: "Alice",
};

/** Minimal object that satisfies isAgentSessionCreatedWebhook + fields we read. */
function createdEvent(opts: {
	sessionId: string;
	issueId: string;
	identifier: string;
	creator: Creator;
	organizationId?: string;
}): AgentEvent {
	const org = opts.organizationId ?? "ws-1";
	return {
		type: "AgentSessionEvent",
		action: "created",
		organizationId: org,
		agentSession: {
			id: opts.sessionId,
			organizationId: org,
			issueId: opts.issueId,
			issue: { id: opts.issueId, identifier: opts.identifier },
			creator: opts.creator,
		},
	} as unknown as AgentEvent;
}

/**
 * Minimal object that satisfies isAgentSessionPromptedWebhook, carrying a body.
 * Mirrors the sibling `EventRouter.test.ts`'s `promptedEvent` shape (issue/
 * issueId included, so it resolves via `ensureDevice` like a real prompt would)
 * plus what this file additionally needs: a body, an optional `signal`, and an
 * `actorId` distinct from the session's creator (real Linear webhooks always
 * carry the ORIGINAL creator on `agentSession.creator`, regardless of who is
 * actually sending this particular activity).
 */
function promptedEvent(opts: {
	sessionId: string;
	body: string;
	creator?: Creator;
	/** `agentActivity.userId` — who is actually sending this. Defaults to `creator.id`. */
	actorId?: string;
	signal?: string;
	issueId?: string;
	identifier?: string;
	organizationId?: string;
}): AgentEvent {
	const org = opts.organizationId ?? "ws-1";
	return {
		type: "AgentSessionEvent",
		action: "prompted",
		organizationId: org,
		agentActivity: {
			id: "act-1",
			userId: opts.actorId ?? opts.creator?.id,
			content: { body: opts.body },
			...(opts.signal ? { signal: opts.signal } : {}),
		},
		agentSession: {
			id: opts.sessionId,
			organizationId: org,
			issueId: opts.issueId,
			issue: opts.issueId
				? { id: opts.issueId, identifier: opts.identifier }
				: undefined,
			creator: opts.creator,
		},
	} as unknown as AgentEvent;
}

/** Minimal fake ContainerExecutor whose ensureRunning is an inspectable mock. */
function fakeExecutor(
	provider: string,
): ContainerExecutor & { ensureRunning: Mock } {
	return {
		provider,
		ensureRunning: vi.fn<(ctx: IssueExecutionContext) => Promise<void>>(
			async () => {},
		),
		destroy: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		status: vi.fn(async () => "running" as const),
		listManaged: vi.fn(async () => []),
	};
}

describe("EventRouter repository selection", () => {
	let store: RouterStore;
	let postRepositorySelection: ReturnType<typeof vi.fn>;
	let enqueued: string[];
	/** Injectable clock, mutated by the TTL-sweep test. */
	const clock = { value: 1000 };

	beforeEach(() => {
		store = new RouterStore(":memory:");
		postRepositorySelection = vi.fn(async () => {});
		enqueued = [];
		clock.value = 1000;
	});

	it("persists an unambiguous decision and delivers the created event", async () => {
		const { router, created } = harness([API], { teamKey: "NOR" });
		await router.route(created);

		expect(store.getIssueRepositories("NOR-1")).toMatchObject({
			repoNames: ["cyrus-api"],
			method: "team-based",
		});
		expect(enqueued).toHaveLength(1);
		expect(postRepositorySelection).not.toHaveBeenCalled();
	});

	it("holds the created event and elicits when two repositories tie", async () => {
		const { router, created } = harness([API, WEB], { teamKey: "NOR" });
		await router.route(created);

		expect(postRepositorySelection).toHaveBeenCalledWith(
			"ws-1",
			"sess-1",
			"Which repository should I work in for this issue?",
			["cyrus-api", "cyrus-web"],
		);
		// Nothing is delivered and NO container device is created while waiting.
		expect(enqueued).toEqual([]);
		expect(store.getContainerDeviceForIssue("NOR-1")).toBeUndefined();
		expect(store.getPendingRepoSelection("sess-1")).toMatchObject({
			issueKey: "NOR-1",
			options: ["cyrus-api", "cyrus-web"],
		});
	});

	it("does not post a second elicitation for a repeated created event", async () => {
		const { router, created } = harness([API, WEB], { teamKey: "NOR" });
		await router.route(created);
		await router.route({
			...created,
			agentSession: { ...created.agentSession },
		});
		expect(postRepositorySelection).toHaveBeenCalledTimes(1);
	});

	it("answering the elicitation resolves, replays the created event, and boots", async () => {
		const { router, created, prompted } = harness([API, WEB], {
			teamKey: "NOR",
		});
		await router.route(created);
		enqueued.length = 0;

		await router.route(prompted("cyrus-web"));

		expect(store.getIssueRepositories("NOR-1")).toMatchObject({
			repoNames: ["cyrus-web"],
			method: "user-selected",
		});
		expect(store.getPendingRepoSelection("sess-1")).toBeUndefined();
		// The held `created` event is delivered; the answer itself is consumed.
		expect(enqueued).toHaveLength(1);
		expect(JSON.parse(enqueued[0] as string).action).toBe("created");
	});

	it("an unrelated reply falls back and delivers BOTH the created event and the prompt", async () => {
		const { router, created, prompted } = harness([API, WEB], {
			teamKey: "NOR",
		});
		await router.route(created);
		enqueued.length = 0;

		await router.route(prompted("actually just fix the typo"));

		expect(store.getIssueRepositories("NOR-1")).toMatchObject({
			repoNames: ["cyrus-api"],
			method: "fallback-first",
		});
		expect(enqueued.map((raw) => JSON.parse(raw).action)).toEqual([
			"created",
			"prompted",
		]);
	});

	it("reuses a stored decision without re-resolving or re-asking", async () => {
		const { router, created, resolveSpy } = harness([API], { teamKey: "NOR" });
		await router.route(created);
		resolveSpy.mockClear();

		await router.route({
			...created,
			agentSession: { ...created.agentSession, id: "sess-2" },
		});
		expect(resolveSpy).not.toHaveBeenCalled();
	});

	it("posts an actionable notice when no repositories are registered", async () => {
		const { router, created, postActivity } = harness([], { teamKey: "NOR" });
		await router.route(created);

		expect(postActivity).toHaveBeenCalledWith(
			"ws-1",
			"sess-1",
			expect.stringContaining("No repositories are registered"),
		);
		expect(enqueued).toEqual([]);
	});

	it("reports a distinct message when the registry read fails, not just an empty registry", async () => {
		// `resolve()` is total and reports "unavailable" for two different
		// reasons (empty registry vs. a read failure) with distinguishable
		// text. Routing never reaches `containerTargets` on this path, so this
		// test builds its own router without one.
		const registry = {
			list: vi.fn(async () => {
				throw new Error("Azure Table request failed: 503");
			}),
			put: vi.fn(async () => ({ version: "1" })),
		};
		const resolver = new RepositoryResolver({
			registry,
			fetchIssueFacts: vi.fn(async () => undefined),
			logger: { info: vi.fn(), warn: vi.fn() },
		});
		const postActivity = vi.fn(async () => {});
		const router = new EventRouter({
			store,
			gateway: { isOnline: () => false, deliverPending: vi.fn() },
			postActivity,
			repositoryResolver: resolver,
			postRepositorySelection,
			config: {
				eventTtlMs: 60_000,
				issueLock: false,
				creatorOnlyPrompting: false,
				affinityGraceMs: 600_000,
			},
			logger: { info: vi.fn(), warn: vi.fn() },
			now: () => clock.value,
		});
		vi.spyOn(store, "enqueueEvent").mockImplementation((_deviceId, payload) => {
			enqueued.push(payload);
			return 1;
		});

		await router.route(
			createdEvent({
				sessionId: "sess-1",
				issueId: "issue-1",
				identifier: "NOR-1",
				creator: ALICE,
			}),
		);

		expect(postActivity).toHaveBeenCalledWith(
			"ws-1",
			"sess-1",
			expect.stringContaining("Try again shortly"),
		);
		expect(postActivity).not.toHaveBeenCalledWith(
			"ws-1",
			"sess-1",
			expect.stringContaining("No repositories are registered"),
		);
		expect(enqueued).toEqual([]);
	});

	it("routes a second prompt normally once the selection has already been answered (no pending row left)", async () => {
		const { router, created, prompted } = harness([API, WEB], {
			teamKey: "NOR",
		});
		await router.route(created);
		await router.route(prompted("cyrus-web"));
		enqueued.length = 0;
		postRepositorySelection.mockClear();

		await router.route(prompted("what's the status?"));

		// No pending row remains, so this is an ordinary prompt: no re-elicitation,
		// and the earlier decision is left untouched.
		expect(postRepositorySelection).not.toHaveBeenCalled();
		expect(store.getIssueRepositories("NOR-1")).toMatchObject({
			method: "user-selected",
		});
		expect(enqueued).toHaveLength(1);
		expect(JSON.parse(enqueued[0] as string).action).toBe("prompted");
	});

	it("recovers instead of losing the held event forever when the pending row's options are corrupted", async () => {
		// `RouterStore.getPendingRepoSelection` degrades a corrupt `options_json`
		// column to `options: []` rather than throwing (see its doc comment) --
		// a real, reachable state, not a hypothetical. The router must not
		// silently strand the delegation in that case.
		const repositories = [API, WEB];
		const { router, created, prompted } = harness(repositories, {
			teamKey: "NOR",
		});
		await router.route(created);
		expect(store.getPendingRepoSelection("sess-1")).toBeDefined();

		store
			.rawDbForTests()
			.prepare(
				"UPDATE pending_repo_selections SET options_json = ? WHERE agent_session_id = ?",
			)
			.run("not-json", "sess-1");
		expect(store.getPendingRepoSelection("sess-1")?.options).toEqual([]);

		// The registry has since been narrowed to one repository (e.g. an
		// operator resolved the ambiguity) by the time the user's answer arrives.
		repositories.length = 1;

		await router.route(prompted("cyrus-web"));

		// The corrupt row is cleared, and the held delegation is delivered via
		// normal re-resolution rather than the answer being dropped with no path
		// back to a running session. Since the router can no longer tell whether
		// "cyrus-web" was meant as an answer, it falls through to the same
		// deliver-both semantics as an unrelated reply.
		expect(store.getPendingRepoSelection("sess-1")).toBeUndefined();
		expect(store.getIssueRepositories("NOR-1")).toMatchObject({
			repoNames: ["cyrus-api"],
			method: "team-based",
		});
		expect(enqueued.map((raw) => JSON.parse(raw).action)).toEqual([
			"created",
			"prompted",
		]);
	});

	it("expires an unanswered pending selection past the event TTL, posting an expiry notice", async () => {
		const { router, created, postActivity } = harness([API, WEB], {
			teamKey: "NOR",
		});
		await router.route(created);
		expect(store.getPendingRepoSelection("sess-1")).toBeDefined();
		postActivity.mockClear();

		clock.value = 1000 + 60_000 + 1;
		await router.sweepExpired();

		expect(store.getPendingRepoSelection("sess-1")).toBeUndefined();
		// Mirrors pass 1's existing expiry notice (`expiredMessage`) instead of
		// silently discarding a held delegation nobody ever answered.
		expect(postActivity).toHaveBeenCalledWith(
			"ws-1",
			"sess-1",
			REPOSITORY_SELECTION_EXPIRED_MESSAGE,
		);
	});

	it("does not fall through to routing when a corrupt-row replay lands back in a held state", async () => {
		// Regression for a review finding: unlike the "recovers instead of
		// losing..." test above (which narrows the registry to one repo so the
		// replay resolves outright), this one leaves the registry AMBIGUOUS, so
		// `routeCreated(held)` re-ties and re-holds. The current prompt must be
		// consumed rather than falling through to normal routing -- which would
		// otherwise resolve a target and boot a container while a FRESH
		// elicitation is sitting unanswered.
		const { router, created, prompted } = harness([API, WEB], {
			teamKey: "NOR",
		});
		await router.route(created);
		postRepositorySelection.mockClear();

		store
			.rawDbForTests()
			.prepare(
				"UPDATE pending_repo_selections SET options_json = ? WHERE agent_session_id = ?",
			)
			.run("not-json", "sess-1");
		expect(store.getPendingRepoSelection("sess-1")?.options).toEqual([]);

		await router.route(prompted("cyrus-web"));

		// A fresh elicitation was posted for the re-tied selection...
		expect(postRepositorySelection).toHaveBeenCalledTimes(1);
		expect(store.getPendingRepoSelection("sess-1")).toMatchObject({
			issueKey: "NOR-1",
			options: ["cyrus-api", "cyrus-web"],
		});
		// ...and nothing was delivered or minted while it sits unanswered.
		expect(store.getIssueRepositories("NOR-1")).toBeUndefined();
		expect(store.getContainerDeviceForIssue("NOR-1")).toBeUndefined();
		expect(enqueued).toEqual([]);
	});

	it("creator-only prompting: the creator's own answer still resolves the selection", async () => {
		const { router, created, prompted } = harness(
			[API, WEB],
			{ teamKey: "NOR" },
			{ creatorOnlyPrompting: true },
		);
		await router.route(created);

		await router.route(prompted("cyrus-web", { actorId: ALICE.id }));

		expect(store.getIssueRepositories("NOR-1")).toMatchObject({
			repoNames: ["cyrus-web"],
			method: "user-selected",
		});
		expect(store.getPendingRepoSelection("sess-1")).toBeUndefined();
		expect(enqueued).toHaveLength(1);
	});

	it("creator-only prompting: a non-creator's answer is rejected, leaving the pending selection intact and minting no device", async () => {
		const { router, created, prompted, postActivity } = harness(
			[API, WEB],
			{ teamKey: "NOR" },
			{ creatorOnlyPrompting: true },
		);
		await router.route(created);
		postActivity.mockClear();

		await router.route(prompted("cyrus-web", { actorId: "user-bob" }));

		expect(postActivity).toHaveBeenCalledWith(
			"ws-1",
			"sess-1",
			PROMPT_REJECTION_MESSAGE,
		);
		expect(store.getIssueRepositories("NOR-1")).toBeUndefined();
		expect(store.getPendingRepoSelection("sess-1")).toMatchObject({
			issueKey: "NOR-1",
			options: ["cyrus-api", "cyrus-web"],
		});
		expect(store.getContainerDeviceForIssue("NOR-1")).toBeUndefined();
		expect(enqueued).toEqual([]);
	});

	it("abandons a pending selection on a stop signal instead of booting the session it would have started", async () => {
		const { router, created, prompted } = harness([API, WEB], {
			teamKey: "NOR",
		});
		await router.route(created);

		await router.route(prompted("stop", { signal: "stop" }));

		expect(store.getPendingRepoSelection("sess-1")).toBeUndefined();
		expect(store.getIssueRepositories("NOR-1")).toBeUndefined();
		expect(store.getContainerDeviceForIssue("NOR-1")).toBeUndefined();
		expect(enqueued).toEqual([]);
	});

	it("abandons a pending selection on a stop-shaped body even without an explicit signal", async () => {
		// The device itself treats a literal "stop"/"stop working" body the same
		// as a signal (EdgeWorker's `isTextStopRequest`); the router must too.
		const { router, created, prompted } = harness([API, WEB], {
			teamKey: "NOR",
		});
		await router.route(created);

		await router.route(prompted("stop working"));

		expect(store.getPendingRepoSelection("sess-1")).toBeUndefined();
		expect(enqueued).toEqual([]);
	});

	it("persists a fallback decision and proceeds to route when no elicitation transport is configured", async () => {
		const { router, created } = harness(
			[API, WEB],
			{ teamKey: "NOR" },
			{ omitPostRepositorySelection: true },
		);
		await router.route(created);

		expect(store.getIssueRepositories("NOR-1")).toMatchObject({
			repoNames: ["cyrus-api"],
			method: "fallback-first",
		});
		expect(enqueued).toHaveLength(1);
		expect(postRepositorySelection).not.toHaveBeenCalled();
	});

	it("persists a fallback decision and proceeds to route when posting the elicitation throws", async () => {
		const { router, created } = harness(
			[API, WEB],
			{ teamKey: "NOR" },
			{
				postRepositorySelectionImpl: async () => {
					throw new Error("Linear 5xx");
				},
			},
		);
		await router.route(created);

		expect(store.getIssueRepositories("NOR-1")).toMatchObject({
			repoNames: ["cyrus-api"],
			method: "fallback-first",
		});
		expect(enqueued).toHaveLength(1);
	});

	function harness(
		repositories: RegisteredRepository[],
		facts: Record<string, unknown> | undefined,
		opts?: {
			creatorOnlyPrompting?: boolean;
			/** Omit `postRepositorySelection` entirely (no elicitation transport configured). */
			omitPostRepositorySelection?: boolean;
			/** Override the default resolved-void mock (e.g. to make it throw). */
			postRepositorySelectionImpl?: EventRouterOptions["postRepositorySelection"];
		},
	) {
		store.addUser({ email: "alice@example.com" });
		store.setUserExecutor("alice@example.com", JSON.stringify({ type: "aca" }));

		const registry = {
			list: vi.fn(async () => ({ repositories })),
			put: vi.fn(async () => ({ version: "1" })),
		};
		const resolver = new RepositoryResolver({
			registry,
			fetchIssueFacts: vi.fn(async () => facts as never),
			logger: { info: vi.fn(), warn: vi.fn() },
		});
		const resolveSpy = vi.spyOn(resolver, "resolve");

		const secrets: SecretStoreBackend = {
			get: async () => ({}),
			set: async () => {},
			isFullyAuthenticated: async () => ({ ok: true, missing: [] }),
		};
		const containerTargets = new ContainerTargetService({
			store,
			secrets,
			executors: new Map([["aca", fakeExecutor("aca")]]),
			containersConfig: {
				routerUrlForContainers: "wss://router.example.com",
				repositories: [],
			},
			postActivity: async () => {},
			logger: { info: vi.fn(), warn: vi.fn() },
		});

		if (opts?.postRepositorySelectionImpl) {
			postRepositorySelection = vi.fn(opts.postRepositorySelectionImpl);
		}

		const postActivity = vi.fn(async () => {});
		const router = new EventRouter({
			store,
			gateway: { isOnline: () => false, deliverPending: vi.fn() },
			postActivity,
			containerTargets,
			repositoryResolver: resolver,
			...(opts?.omitPostRepositorySelection ? {} : { postRepositorySelection }),
			config: {
				eventTtlMs: 60_000,
				issueLock: false,
				creatorOnlyPrompting: opts?.creatorOnlyPrompting ?? false,
				affinityGraceMs: 600_000,
			},
			logger: { info: vi.fn(), warn: vi.fn() },
			now: () => clock.value,
		});

		// Capture what reaches the queue without reaching into the store's schema.
		vi.spyOn(store, "enqueueEvent").mockImplementation((_deviceId, payload) => {
			enqueued.push(payload);
			return 1;
		});

		const created = createdEvent({
			sessionId: "sess-1",
			issueId: "issue-1",
			identifier: "NOR-1",
			creator: ALICE,
		});
		const prompted = (
			body: string,
			promptOpts?: { actorId?: string; signal?: string },
		) =>
			promptedEvent({
				sessionId: "sess-1",
				body,
				creator: ALICE,
				issueId: "issue-1",
				identifier: "NOR-1",
				actorId: promptOpts?.actorId,
				signal: promptOpts?.signal,
			});

		return { router, created, prompted, postActivity, resolveSpy };
	}
});
