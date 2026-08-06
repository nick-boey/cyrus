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
/** An enrolled PHYSICAL-device creator, distinct from ALICE's container executor. */
const BOB: Creator = {
	id: "user-2",
	email: "bob@example.com",
	name: "Bob",
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

	/**
	 * Regression for Important review finding I-2: `baseBranchOverrides`
	 * originates in an issue description's `[repo=name#branch]` tag
	 * (`parseRepoTags`), never passes through `validateRegisteredRepository`
	 * (the gate added for exactly this shell sink), and is persisted verbatim
	 * into `RepositoryConfig.baseBranch`, which reaches a double-quoted shell
	 * interpolation in `GitService.ts` inside a worker container.
	 * `parseRepoTags`' charset allows both a leading `-` (git treats a
	 * ref-shaped argument starting with `-` as an option) and `..`
	 * (path-traversal-flavoured ref), which is exactly what `BASE_BRANCH_RE`
	 * exists to exclude. `persistDecision` must drop an override that fails
	 * that pattern rather than storing it, so nothing invalid ever reaches
	 * `CYRUS_REPOS_JSON`.
	 */
	it("drops a base branch override from a [repo=...] tag that fails BASE_BRANCH_RE instead of persisting it", async () => {
		const { router, created } = harness([API], {
			description: "[repo=cyrus-api#-bad]",
		});
		await router.route(created);

		const decision = store.getIssueRepositories("NOR-1");
		expect(decision).toMatchObject({
			repoNames: ["cyrus-api"],
			method: "description-tag",
		});
		expect(decision?.baseBranchOverrides).toEqual({});
	});

	it("keeps a base branch override from a [repo=...] tag that passes BASE_BRANCH_RE", async () => {
		const { router, created } = harness([API], {
			description: "[repo=cyrus-api#release/1.2.x]",
		});
		await router.route(created);

		const decision = store.getIssueRepositories("NOR-1");
		expect(decision).toMatchObject({
			repoNames: ["cyrus-api"],
			method: "description-tag",
		});
		expect(decision?.baseBranchOverrides).toEqual({
			"cyrus-api": "release/1.2.x",
		});
	});

	/**
	 * Regression for a Critical review finding: gating router-side repository
	 * pre-selection on `containers` being configured only rules out
	 * deployments with NO container path at all. A router WITH `containers`
	 * configured still hosts physical-device users (a NULL/absent
	 * `executor_json`, per `ContainerRoutingDeps`'s own doc comment), and
	 * `resolveTarget` routes them to their enrolled physical device exactly as
	 * it always has. Before this fix, `ensureRepositoryDecision` ran for EVERY
	 * creator on such a router, so a physical-device user got elicited by the
	 * router AND (redundantly) by their own EdgeWorker's `RepositoryRouter` for
	 * the same issue.
	 */
	it("gates router-side repository selection per creator: a container-backed creator still resolves, a physical-device creator on the same router is routed as before with no elicitation", async () => {
		// A single repository (matching the "persists an unambiguous decision"
		// test above) so ALICE's routing resolves outright rather than tying —
		// this test is about the per-creator gate, not ambiguity handling.
		const { router, created, resolveSpy } = harness([API], {
			teamKey: "NOR",
		});

		// ALICE (from the harness) is a container-executor ("aca") user: the
		// router resolves her repository as it always has.
		await router.route(created);
		expect(store.getIssueRepositories("NOR-1")).toMatchObject({
			repoNames: ["cyrus-api"],
			method: "team-based",
		});
		resolveSpy.mockClear();
		postRepositorySelection.mockClear();
		enqueued.length = 0;

		// BOB is enrolled on the SAME router/store, but with NO container
		// executor configured — the historical, unconditional meaning of
		// "physical device" (see ContainerRoutingDeps's doc comment).
		store.addUser({ email: BOB.email });
		const code = store.mintEnrollmentCode(BOB.email, 1);
		const bobDevice = store.redeemEnrollmentCode(code, 1);
		if (!bobDevice) throw new Error("enrolling Bob's physical device failed");

		const bobCreated = createdEvent({
			sessionId: "sess-bob-1",
			issueId: "issue-bob-1",
			identifier: "NOR-2",
			creator: BOB,
		});
		await router.route(bobCreated);

		// Never gated: the resolver is not even consulted for Bob's creation.
		expect(resolveSpy).not.toHaveBeenCalled();
		expect(postRepositorySelection).not.toHaveBeenCalled();
		expect(store.getIssueRepositories("NOR-2")).toBeUndefined();
		expect(store.getPendingRepoSelection("sess-bob-1")).toBeUndefined();
		// Routed to his physical device exactly as pre-Task-9/10/11 behaviour:
		// no container device was minted for him.
		expect(store.getContainerDeviceForIssue("NOR-2")).toBeUndefined();
		expect(enqueued).toHaveLength(1);
		expect(JSON.parse(enqueued[0] as string).action).toBe("created");
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

	/**
	 * Regression for Important review finding I-1: `route()` is invoked as
	 * `void this.eventRouter.route(event)` with no per-session serialization
	 * (`RouterServer`), and `claimWebhook` only dedups byte-identical
	 * deliveries — these two prompts carry no `createdAt`, so they aren't
	 * deduped that way either. Before the fix, `resumeHeldSelection`'s
	 * non-empty-options branch read the pending row, then awaited
	 * `resolver.resolve(...)` before ever deleting it, so two prompts
	 * "arriving" close together both saw the same pending row, both
	 * `persistDecision`d, and both replayed the held `created` event —
	 * `routeCreated` is called directly, bypassing `claimWebhook`, so nothing
	 * else stood in the way of delivering the delegation twice (and, in
	 * production, booting a container twice). The fix deletes the row
	 * synchronously before the first `await`, so only the first of the two
	 * concurrent calls still finds it.
	 */
	it("concurrent prompts answering the same held selection replay the held created event only once", async () => {
		const { router, created, prompted } = harness([API, WEB], {
			teamKey: "NOR",
		});
		await router.route(created);
		enqueued.length = 0;

		// Two distinct prompts, "arriving" concurrently — i.e. neither is
		// awaited before the other starts, mirroring how RouterServer fires
		// `route()` for each inbound webhook with no serialization between them.
		// Neither call may reject: `route()` is invoked as `void route(event)`
		// with no catch in production, so a rejection here would mean the fix
		// could take the whole router process down.
		await Promise.all([
			router.route(prompted("cyrus-web")),
			router.route(prompted("cyrus-web")),
		]);

		// The decision was persisted exactly once (persisting is idempotent so
		// this alone wouldn't catch a double-run, but combined with the enqueue
		// count below it demonstrates the replay itself only happened once).
		expect(store.getIssueRepositories("NOR-1")).toMatchObject({
			repoNames: ["cyrus-web"],
			method: "user-selected",
		});
		expect(store.getPendingRepoSelection("sess-1")).toBeUndefined();
		// The held `created` event was replayed exactly once, not twice.
		const actions = enqueued.map((raw) => JSON.parse(raw).action);
		expect(actions.filter((action) => action === "created")).toHaveLength(1);
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

	/**
	 * Important review finding: an "unavailable" outcome (empty registry, or a
	 * registry read failure — a first-boot Table race being the concrete
	 * case) posted a notice and returned "held" WITHOUT stashing the event or
	 * creating a `pending_repo_selections` row, unlike the elicit path a few
	 * lines below. Nothing then replayed it and the expiry sweep never saw it
	 * — the delegation was lost outright. Chosen fix: stash the ORIGINAL
	 * `created` webhook (not just tell the user to redo it) by reusing
	 * `pending_repo_selections` with an empty `options` array, which puts it
	 * on the exact same recovery path `resumeHeldSelection` already has for a
	 * corrupt pending row.
	 */
	it("stashes the created event when nothing is registered yet, and a later prompt replays and resolves it once a repository exists", async () => {
		const repositories: RegisteredRepository[] = [];
		const { router, created, prompted, resolveSpy } = harness(repositories, {
			teamKey: "NOR",
		});

		await router.route(created);

		// Stashed, not dropped: a pending row exists with nothing to select
		// from (distinct from the ambiguous/unmatched case, which offers real
		// options).
		expect(store.getPendingRepoSelection("sess-1")).toMatchObject({
			issueKey: "NOR-1",
			options: [],
		});
		expect(store.getIssueRepositories("NOR-1")).toBeUndefined();
		expect(enqueued).toEqual([]);
		resolveSpy.mockClear();

		// An operator registers a repository (equally models a transient
		// registry read recovering) before the user's next message.
		repositories.push(API);

		await router.route(prompted("let's get started"));

		// Replayed through normal resolution: the pending row is gone, a real
		// decision now exists, and the ORIGINAL created event — not just the
		// prompt — was delivered, in order.
		expect(store.getPendingRepoSelection("sess-1")).toBeUndefined();
		expect(store.getIssueRepositories("NOR-1")).toMatchObject({
			repoNames: ["cyrus-api"],
		});
		expect(enqueued.map((raw) => JSON.parse(raw).action)).toEqual([
			"created",
			"prompted",
		]);
	});

	it("expires a stashed created event past the TTL when the registry never recovers, posting an explicit re-delegate notice", async () => {
		const { router, created, postActivity } = harness([], { teamKey: "NOR" });
		await router.route(created);
		expect(store.getPendingRepoSelection("sess-1")).toBeDefined();
		postActivity.mockClear();

		clock.value = 1000 + 60_000 + 1;
		await router.sweepExpired();

		expect(store.getPendingRepoSelection("sess-1")).toBeUndefined();
		expect(postActivity).toHaveBeenCalledWith(
			"ws-1",
			"sess-1",
			REPOSITORY_SELECTION_EXPIRED_MESSAGE,
		);
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
			// A separate stub from `registry` above. This file's assertions are
			// all about EventRouter's repository-selection gate (via `resolver`) —
			// but this registry is NOT unreachable: `routeCreated` can still boot
			// a container as a fire-and-forget side effect (`deliverOrNotify`'s
			// `containerTargets.boot(...)`, never awaited), and `bootInner` reads
			// this registry to build the container's `CYRUS_REPOS_JSON`. An
			// earlier version of this stub threw here on the theory that would
			// turn an accidental read into a visible test failure; it does not —
			// `bootInner` has its own try/catch around exactly this read and only
			// logs a warning, so a throwing stub is silently swallowed and proves
			// nothing either way. Kept empty and non-throwing: it only needs to
			// satisfy `ContainerTargetService`'s required `registry` dependency,
			// and its content is irrelevant to what this file actually asserts.
			registry: {
				list: vi.fn(async () => ({ repositories: [] })),
				put: vi.fn(async () => ({ version: "1" })),
			},
			containersConfig: {
				routerUrlForContainers: "wss://router.example.com",
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
