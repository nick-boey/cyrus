import type { IIssueTrackerService } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { WorkspaceSyncService } from "../src/WorkspaceSyncService.js";

/**
 * Task 12 — construction wiring for the `"router"` platform mode.
 *
 * A device running in router mode holds NO Linear tokens (so no
 * `linearWorkspaces` block); it builds one `RouterIssueTrackerService` per
 * repo workspace id, backed by a single shared `RouterConnection`. This test
 * only asserts the synchronous construction wiring — it never calls `start()`,
 * so no WebSocket dial happens.
 */
describe("router platform", () => {
	it("constructs router-backed issue trackers for repo workspaces", () => {
		const worker = new EdgeWorker({
			platform: "router",
			router: { url: "ws://127.0.0.1:9", deviceToken: "tok" },
			cyrusHome: "/tmp/cyrus-router-test",
			repositories: [
				{
					id: "repo-1",
					name: "repo-1",
					repositoryPath: "/tmp/repo-1",
					baseBranch: "main",
					workspaceBaseDir: "/tmp/ws",
					linearWorkspaceId: "ws-1",
				},
			],
		} as never);

		const tracker = (
			worker as unknown as {
				issueTrackers: Map<string, IIssueTrackerService>;
			}
		).issueTrackers.get("ws-1");

		expect(tracker?.getPlatformType()).toBe("linear");
		expect(tracker?.getPlatformMetadata().transport).toBe("router");
	});
});

/**
 * Task 10 — `WorkspaceSyncService` (the persistence-floor sync) must only be
 * constructed for router-platform devices, and only when the operator has
 * explicitly opted IN via `router.floorSync: true`. This is opt-in (not
 * opt-out) so that every EXISTING router+physical-device deployment sees zero
 * behavior change: before this feature, a WIP push only ran on worktree
 * teardown, so defaulting this service on for everyone would have started
 * pushing `wip: auto-saved by cyrus…` commits onto every teammate's issue
 * branches (including open PRs) on every session end and every 5-minute tick
 * — with nobody having asked for it. Only ephemeral containers (via
 * `ContainerBootCommand.writeConfig`, which always sets `floorSync: true`)
 * and any physical device that deliberately opts in (e.g. to enable device ->
 * container migration) get the floor. Every other platform must see zero
 * behavior change — no field is even set.
 */
describe("router platform floor sync wiring", () => {
	function getWorkspaceSync(
		worker: EdgeWorker,
	): WorkspaceSyncService | undefined {
		return (worker as unknown as { workspaceSync?: WorkspaceSyncService })
			.workspaceSync;
	}

	it("does NOT construct WorkspaceSyncService by default for platform 'router' (opt-in, not opt-out)", () => {
		const worker = new EdgeWorker({
			platform: "router",
			router: { url: "ws://127.0.0.1:9", deviceToken: "tok" },
			cyrusHome: "/tmp/cyrus-router-test",
			repositories: [],
		} as never);

		expect(getWorkspaceSync(worker)).toBeUndefined();
	});

	it("constructs and starts WorkspaceSyncService when router.floorSync is true", () => {
		const worker = new EdgeWorker({
			platform: "router",
			router: { url: "ws://127.0.0.1:9", deviceToken: "tok", floorSync: true },
			cyrusHome: "/tmp/cyrus-router-test",
			repositories: [],
		} as never);

		expect(getWorkspaceSync(worker)).toBeDefined();
	});

	it("does NOT construct WorkspaceSyncService when router.floorSync is explicitly false", () => {
		const worker = new EdgeWorker({
			platform: "router",
			router: { url: "ws://127.0.0.1:9", deviceToken: "tok", floorSync: false },
			cyrusHome: "/tmp/cyrus-router-test",
			repositories: [],
		} as never);

		expect(getWorkspaceSync(worker)).toBeUndefined();
	});

	it("does NOT construct WorkspaceSyncService for platform 'cli'", () => {
		const worker = new EdgeWorker({
			platform: "cli",
			cyrusHome: "/tmp/cyrus-cli-test",
			repositories: [],
		} as never);

		expect(getWorkspaceSync(worker)).toBeUndefined();
	});

	it("does NOT construct WorkspaceSyncService for platform 'linear'", () => {
		const worker = new EdgeWorker({
			platform: "linear",
			cyrusHome: "/tmp/cyrus-linear-test",
			repositories: [],
		} as never);

		expect(getWorkspaceSync(worker)).toBeUndefined();
	});
});
