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
			},
			sessionRepositories: new Map(),
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
			"response",
			"remove-session",
			"delete-worktree",
			"callback-flush",
		]);
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
		const session = {
			id: "sess-1",
			issue: { identifier: "CAN-129", branchName: "cyrus1/can-129-do-it" },
			agentRunner: { stop: vi.fn() },
		};
		const repository = {
			id: "repo-a",
			name: "repo-a",
			// A container sandbox: the clone lives under the shared workspaces
			// root, nowhere near `<cyrusHome>/worktrees`.
			repositoryPath: "/workspaces/repos/repo-a",
			workspaceBaseDir: "/workspaces",
		};
		const fakeWorker = {
			logger: { info: vi.fn(), warn: vi.fn() },
			cyrusHome: "/workspaces/.cyrus",
			agentSessionManager: {
				getSessionsByIssueId: () => [session],
				requestSessionStop: vi.fn(),
				createResponseActivity: vi.fn(),
				removeSession: vi.fn(),
			},
			sessionRepositories: new Map([["sess-1", "repo-a"]]),
			repositories: new Map([["repo-a", repository]]),
			deriveWorktreeBranchName: (issue: { branchName: string }) =>
				issue.branchName,
			wipSnapshotReaper: {
				reap: async (repoPath: string, branch: string) => {
					reaped.push([repoPath, branch]);
				},
				sweep: vi.fn(),
			},
			gitService: { deleteWorktree: vi.fn() },
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
			workItemIdentifier: "CAN-129",
		});

		expect(reaped).toEqual([
			["/workspaces/repos/repo-a", "cyrus1/can-129-do-it"],
		]);
		// Teardown gets the repository so it can resolve the same workspace
		// path creation used.
		expect(fakeWorker.gitService.deleteWorktree).toHaveBeenCalledWith(
			"CAN-129",
			{ repositories: [repository] },
		);
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
			repositories: new Map(),
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
