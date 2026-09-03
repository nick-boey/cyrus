import {
	isIssueStateIdUpdateWebhook,
	isIssueTitleOrDescriptionUpdateWebhook,
} from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

describe("isIssueStateIdUpdateWebhook type guard", () => {
	it("returns true for an Issue update webhook with stateId in updatedFrom", () => {
		const webhook = {
			type: "Issue",
			action: "update",
			data: {
				id: "issue-1",
				identifier: "TEST-1",
				title: "Test Issue",
				stateId: "state-new",
			},
			updatedFrom: {
				stateId: "state-old",
			},
			organizationId: "org-1",
			createdAt: "2025-01-01T00:00:00Z",
		};

		expect(isIssueStateIdUpdateWebhook(webhook as any)).toBe(true);
	});

	it("returns false for an Issue update webhook without stateId in updatedFrom", () => {
		const webhook = {
			type: "Issue",
			action: "update",
			data: {
				id: "issue-1",
				identifier: "TEST-1",
				title: "Test Issue",
			},
			updatedFrom: {
				title: "Old Title",
			},
			organizationId: "org-1",
			createdAt: "2025-01-01T00:00:00Z",
		};

		expect(isIssueStateIdUpdateWebhook(webhook as any)).toBe(false);
	});

	it("returns false for non-Issue webhook types", () => {
		const webhook = {
			type: "AgentSessionEvent",
			action: "created",
		};

		expect(isIssueStateIdUpdateWebhook(webhook as any)).toBe(false);
	});

	it("returns false for Issue webhook without updatedFrom", () => {
		const webhook = {
			type: "Issue",
			action: "update",
			data: {
				id: "issue-1",
			},
		};

		expect(isIssueStateIdUpdateWebhook(webhook as any)).toBe(false);
	});

	it("returns false for Issue create/remove actions", () => {
		const webhook = {
			type: "Issue",
			action: "create",
			data: {
				id: "issue-1",
			},
			updatedFrom: {
				stateId: "state-old",
			},
		};

		expect(isIssueStateIdUpdateWebhook(webhook as any)).toBe(false);
	});

	it("does not conflict with isIssueTitleOrDescriptionUpdateWebhook", () => {
		// A webhook with BOTH stateId and title changes should match both guards
		const webhook = {
			type: "Issue",
			action: "update",
			data: {
				id: "issue-1",
				identifier: "TEST-1",
				title: "New Title",
				stateId: "state-new",
			},
			updatedFrom: {
				title: "Old Title",
				stateId: "state-old",
			},
			organizationId: "org-1",
			createdAt: "2025-01-01T00:00:00Z",
		};

		expect(isIssueStateIdUpdateWebhook(webhook as any)).toBe(true);
		expect(isIssueTitleOrDescriptionUpdateWebhook(webhook as any)).toBe(true);
	});

	it("handles stateId-only changes (not title/description)", () => {
		const webhook = {
			type: "Issue",
			action: "update",
			data: {
				id: "issue-1",
				identifier: "TEST-1",
				title: "Test Issue",
				stateId: "state-completed",
			},
			updatedFrom: {
				stateId: "state-started",
			},
			organizationId: "org-1",
			createdAt: "2025-01-01T00:00:00Z",
		};

		// Should match state change but NOT title/description
		expect(isIssueStateIdUpdateWebhook(webhook as any)).toBe(true);
		expect(isIssueTitleOrDescriptionUpdateWebhook(webhook as any)).toBe(false);
	});
});

describe("EdgeWorker terminal teardown ordering", () => {
	it("records the callback intent first, forces floor sync before response/removal, and flushes the callback after worktree deletion", async () => {
		const order: string[] = [];
		const session = {
			id: "sess-1",
			agentRunner: { stop: () => order.push("runner-stop") },
		};
		const fakeWorker = {
			logger: { info: vi.fn(), warn: vi.fn() },
			agentSessionManager: {
				getSessionsByIssueId: () => [session],
				requestSessionStop: () => order.push("request-stop"),
				createResponseActivity: async () => {
					order.push("response");
				},
				removeSession: () => order.push("remove-session"),
			},
			workspaceSync: {
				syncIssue: async (_key: string, options: unknown) => {
					expect(options).toEqual({ force: true });
					order.push("force-sync");
				},
				// Must land immediately after the forced sync and before the reap:
				// after this point a capture would re-push the ref the reaper is
				// about to delete, because deleteWipSnapshot drops the local ref
				// that captureWipSnapshot uses as its "already current" check.
				abandonIssue: async () => {
					order.push("abandon-sync");
				},
			},
			wipSnapshotReaper: { reap: vi.fn(), sweep: vi.fn() },
			sessionRepositories: new Map(),
			getCachedRepositories: () => null,
			repositories: new Map(),
			gitService: {
				deleteWorktree: async () => {
					order.push("delete-worktree");
				},
			},
			// The durable callback queue. `record` MUST land before any await in
			// the handler (see TeardownCallbackQueue's doc comment): that is what
			// puts the intent on disk while RouterConnection's inbox entry for
			// this webhook is still unprocessed, so a kill anywhere in the
			// sequence below replays instead of losing the callback.
			teardownCallbacks: {
				record: (issueKey: string) => {
					order.push(`record:${issueKey}`);
					return "callback-key";
				},
				flush: async () => {
					order.push("callback-flush");
				},
			},
			config: {
				platform: "router",
				router: { url: "ws://router.example.com", deviceToken: "token" },
			},
		};
		const handler = (
			EdgeWorker.prototype as unknown as {
				handleIssueStateChangeMessage(message: {
					workItemId: string;
					workItemIdentifier: string;
				}): Promise<void>;
			}
		).handleIssueStateChangeMessage;
		await handler.call(fakeWorker, {
			workItemId: "issue-1",
			workItemIdentifier: "CYPACK-1",
		});

		expect(order).toEqual([
			"record:CYPACK-1",
			"request-stop",
			"runner-stop",
			"force-sync",
			"abandon-sync",
			"response",
			"remove-session",
			"delete-worktree",
			"callback-flush",
		]);
	});

	// A container sandbox: clones live under the shared workspaces root,
	// nowhere near `<cyrusHome>/worktrees`.
	const REPO_A = {
		id: "repo-a",
		name: "repo-a",
		repositoryPath: "/workspaces/repos/repo-a",
		workspaceBaseDir: "/workspaces",
	};
	const REPO_B = {
		id: "repo-b",
		name: "repo-b",
		repositoryPath: "/workspaces/repos/repo-b",
		workspaceBaseDir: "/workspaces",
	};

	const makeTeardownWorker = (opts: {
		sessions: unknown[];
		sessionRepositories?: Map<string, string>;
		cachedRepositories?: unknown[];
		reaped: Array<[string, string]>;
	}) => ({
		logger: { info: vi.fn(), warn: vi.fn() },
		cyrusHome: "/workspaces/.cyrus",
		agentSessionManager: {
			getSessionsByIssueId: () => opts.sessions,
			requestSessionStop: vi.fn(),
			createResponseActivity: vi.fn(),
			removeSession: vi.fn(),
		},
		sessionRepositories: opts.sessionRepositories ?? new Map(),
		repositories: new Map([
			["repo-a", REPO_A],
			["repo-b", REPO_B],
		]),
		getCachedRepositories: () => opts.cachedRepositories ?? null,
		deriveWorktreeBranchName: (issue: { branchName: string }) =>
			issue.branchName,
		wipSnapshotReaper: {
			reap: async (repoPath: string, branch: string) => {
				opts.reaped.push([repoPath, branch]);
			},
			sweep: vi.fn(),
		},
		gitService: { deleteWorktree: vi.fn() },
		config: { platform: "cli" },
	});

	const runTeardown = (worker: unknown) =>
		(
			EdgeWorker.prototype as unknown as {
				handleIssueStateChangeMessage(message: {
					workItemId: string;
					workItemIdentifier: string;
				}): Promise<void>;
			}
		).handleIssueStateChangeMessage.call(worker, {
			workItemId: "issue-1",
			workItemIdentifier: "CAN-129",
		});

	/**
	 * NOR-411: the WIP snapshot was reaped from a worktree path reconstructed
	 * as `<cyrusHome>/worktrees/<ISSUE>`, which is not where a container
	 * sandbox's worktrees live — so the reaper spawned git in a directory that
	 * had never existed and the ref was never deleted from the remote.
	 * Deleting the ref only needs a checkout whose `origin` carries it, and the
	 * repository's main checkout is both the one we can name without guessing
	 * and the one that outlives this teardown.
	 */
	it("reaps WIP snapshots from each repository's main checkout, not a reconstructed worktree path", async () => {
		const reaped: Array<[string, string]> = [];
		const fakeWorker = makeTeardownWorker({
			sessions: [
				{
					id: "sess-1",
					issue: { identifier: "CAN-129", branchName: "cyrus1/can-129-do-it" },
					agentRunner: { stop: vi.fn() },
					workspace: { path: "/workspaces/CAN-129", isGitWorktree: true },
				},
			],
			sessionRepositories: new Map([["sess-1", "repo-a"]]),
			cachedRepositories: [REPO_A],
			reaped,
		});

		await runTeardown(fakeWorker);

		expect(reaped).toEqual([
			["/workspaces/repos/repo-a", "cyrus1/can-129-do-it"],
		]);
		expect(fakeWorker.gitService.deleteWorktree).toHaveBeenCalledWith(
			"CAN-129",
			{
				repositories: [REPO_A],
				// The path creation actually returned, carried through from the
				// session rather than re-derived from configuration.
				recordedWorkspacePaths: ["/workspaces/CAN-129"],
			},
		);
	});

	/**
	 * A session records only its PRIMARY repository, but `WorkspaceSyncService`
	 * pushes a snapshot to every repository in the workspace. Reaping only the
	 * repositories the sessions name leaves every secondary repository's ref on
	 * its remote forever, with nothing recorded that would ever retry it.
	 */
	it("reaps every repository the issue was routed to, not just the session's primary", async () => {
		const reaped: Array<[string, string]> = [];
		const fakeWorker = makeTeardownWorker({
			sessions: [
				{
					id: "sess-1",
					issue: { identifier: "CAN-129", branchName: "cyrus1/can-129-do-it" },
					agentRunner: { stop: vi.fn() },
				},
			],
			sessionRepositories: new Map([["sess-1", "repo-a"]]),
			cachedRepositories: [REPO_A, REPO_B],
			reaped,
		});

		await runTeardown(fakeWorker);

		expect(reaped).toEqual([
			["/workspaces/repos/repo-a", "cyrus1/can-129-do-it"],
			["/workspaces/repos/repo-b", "cyrus1/can-129-do-it"],
		]);
	});

	/**
	 * The router replays unacked terminal webhooks on purpose, and the first
	 * delivery removed the sessions — so the second has nothing to derive
	 * repositories from. Without the issue's own routing decision the workspace
	 * would resolve to `<cyrusHome>/worktrees`, which in a container sandbox is
	 * a directory that has never existed: NOR-411 all over again, on the path
	 * whose whole purpose is to be a safe retry.
	 */
	it("still resolves the workspace on a redelivered webhook, when no sessions remain", async () => {
		const reaped: Array<[string, string]> = [];
		const fakeWorker = makeTeardownWorker({
			sessions: [],
			cachedRepositories: [REPO_A],
			reaped,
		});

		await runTeardown(fakeWorker);

		expect(fakeWorker.gitService.deleteWorktree).toHaveBeenCalledWith(
			"CAN-129",
			{ repositories: [REPO_A], recordedWorkspacePaths: [] },
		);
		// Nothing left to derive a branch name from, so nothing is reaped on
		// this delivery. That is reported at `warn` naming the manual remedy,
		// NOT as a reassuring "already reaped earlier" — nothing records that a
		// reap ever succeeded (the reaper's durable file records only failures),
		// so the reassurance would have been an assumption stated as fact.
		expect(reaped).toEqual([]);
		expect(fakeWorker.logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("cannot be reaped on this delivery"),
		);
		// The retry of PREVIOUSLY-failed deletions is unrelated to whether this
		// issue reached its own reap, so it still runs on the redelivery path.
		expect(fakeWorker.wipSnapshotReaper.sweep).toHaveBeenCalledTimes(1);
	});

	it("skips the callback queue entirely outside router platform mode", async () => {
		const order: string[] = [];
		const fakeWorker = {
			logger: { info: vi.fn(), warn: vi.fn() },
			agentSessionManager: {
				getSessionsByIssueId: () => [],
				requestSessionStop: vi.fn(),
				createResponseActivity: vi.fn(),
				removeSession: vi.fn(),
			},
			sessionRepositories: new Map(),
			getCachedRepositories: () => null,
			repositories: new Map(),
			wipSnapshotReaper: { reap: vi.fn(), sweep: vi.fn() },
			gitService: {
				deleteWorktree: async () => {
					order.push("delete-worktree");
				},
			},
			teardownCallbacks: {
				record: () => {
					throw new Error("must not record outside router mode");
				},
				flush: async () => {
					throw new Error("must not flush outside router mode");
				},
			},
			config: { platform: "cli" },
		};
		const handler = (
			EdgeWorker.prototype as unknown as {
				handleIssueStateChangeMessage(message: {
					workItemId: string;
					workItemIdentifier: string;
				}): Promise<void>;
			}
		).handleIssueStateChangeMessage;

		await handler.call(fakeWorker, {
			workItemId: "issue-1",
			workItemIdentifier: "CYPACK-2",
		});

		expect(order).toEqual(["delete-worktree"]);
	});
});
