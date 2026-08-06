import { describe, expect, it, vi } from "vitest";
import type { RouterConnection } from "../src/RouterConnection.js";
import { RouterIssueTrackerService } from "../src/RouterIssueTrackerService.js";

/**
 * The brief's `service()` helper passes a single `{ rpc }` argument, but the
 * real constructor is `(connection, workspaceId)` and every RPC call
 * prepends `workspaceId` as the first positional param (see `fetchTeam`,
 * `fetchIssue`, etc., and `LinearExecutor.dispatch`'s
 * `const [workspaceId, ...rest] = params`). Adapted accordingly.
 */
function service(rpc: ReturnType<typeof vi.fn>) {
	return new RouterIssueTrackerService(
		{ rpc } as unknown as RouterConnection,
		"ws-1",
	);
}

describe("RouterIssueTrackerService project", () => {
	it("resolves the project through the fetchProject RPC", async () => {
		const rpc = vi.fn(async (method: string) => {
			if (method === "fetchIssue") {
				return { id: "issue-1", identifier: "NOR-1", projectId: "proj-1" };
			}
			if (method === "fetchProject") return { id: "proj-1", name: "Platform" };
			throw new Error(`unexpected ${method}`);
		});

		const issue = await service(rpc).fetchIssue("issue-1");
		const project = await issue.project;

		expect(project?.name).toBe("Platform");
		expect(rpc).toHaveBeenCalledWith("fetchProject", ["ws-1", "proj-1"]);
	});

	it("is undefined when the issue has no project, without any RPC", async () => {
		const rpc = vi.fn(async () => ({ id: "issue-1", identifier: "NOR-1" }));
		const issue = await service(rpc).fetchIssue("issue-1");
		expect(await issue.project).toBeUndefined();
		expect(rpc).toHaveBeenCalledTimes(1);
	});

	it("fetches the project at most once per issue", async () => {
		const rpc = vi.fn(async (method: string) =>
			method === "fetchIssue"
				? { id: "issue-1", projectId: "proj-1" }
				: { id: "proj-1", name: "Platform" },
		);
		const issue = await service(rpc).fetchIssue("issue-1");
		await issue.project;
		await issue.project;
		expect(
			rpc.mock.calls.filter(([method]) => method === "fetchProject"),
		).toHaveLength(1);
	});

	it("propagates a fetchProject RPC failure instead of swallowing it", async () => {
		// Simulates talking to an older router that doesn't implement
		// "fetchProject" — LinearExecutor.dispatch rejects with
		// `fail(id, "method not allowed")` for any method outside its
		// RPC_METHODS allowlist. RouterIssueTrackerService must not mask that
		// as a false "no project"; it propagates the rejection so callers that
		// already isolate per-source failures (RepositoryRouter.gatherFacts's
		// Promise.allSettled) can degrade to "no project fact" instead of
		// crashing, while callers that don't guard still fail loudly rather
		// than silently mis-routing.
		const rpc = vi.fn(async (method: string) => {
			if (method === "fetchIssue") {
				return { id: "issue-1", identifier: "NOR-1", projectId: "proj-1" };
			}
			throw new Error("method not allowed");
		});
		const issue = await service(rpc).fetchIssue("issue-1");
		await expect(issue.project).rejects.toThrow("method not allowed");
	});
});
