import type { IIssueTrackerService } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

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
