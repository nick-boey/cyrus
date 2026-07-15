// apps/f1/test/router/router-rig.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SecretStore } from "cyrus-router";
import type {
	ContainerExecutor,
	ContainerStatus,
	IssueExecutionContext,
} from "cyrus-router-executors";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createdFixture, seedSession } from "../../src/router/fixtures.js";
import { createRouterRig, type RouterRig } from "../../src/router/RouterRig.js";

/** Minimal fake executor: records ensureRunning, never touches Docker. */
class RecordingExecutor implements ContainerExecutor {
	readonly provider = "docker";
	readonly calls: string[] = [];
	async ensureRunning(ctx: IssueExecutionContext): Promise<void> {
		ctx.mintDeviceToken();
		this.calls.push(ctx.issueKey);
	}
	async stop(): Promise<void> {}
	async destroy(): Promise<void> {}
	async status(): Promise<ContainerStatus> {
		return "absent";
	}
	async listManaged(): Promise<string[]> {
		return [];
	}
}

describe("createRouterRig (fake executor, no Docker)", () => {
	let rig: RouterRig;
	let dir: string;
	let secretsPath: string;
	const exec = new RecordingExecutor();

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "f1-router-rig-"));
		secretsPath = join(dir, "secrets.json");
		rig = await createRouterRig({
			dbPath: ":memory:",
			secretsPath,
			artifactsDir: join(dir, "artifacts"),
			executors: new Map([["docker", exec]]),
			logger: { info: () => {}, warn: () => {} },
		});
		rig.seedUser({
			email: "cold@example.com",
			linearId: "lin-cold",
			provider: "docker",
			claudeOauthToken: "tok",
		});
	});

	afterAll(async () => {
		await rig.stop();
		rmSync(dir, { recursive: true, force: true });
	});

	it("routes a created webhook to the container executor", async () => {
		seedSession(rig.tracker, "sess-1", "issue-1");
		await rig.server.eventRouter.route(
			createdFixture({
				sessionId: "sess-1",
				issue: { id: "issue-1", identifier: "CYPACK-1", title: "Cold" },
				creator: { id: "lin-cold", email: "cold@example.com", name: "Cold" },
			}),
		);
		await vi.waitFor(() => expect(exec.calls).toContain("CYPACK-1"));
		expect(rig.port).toBeGreaterThan(0);
	});

	it("seeds the Claude token under CLAUDE_CODE_OAUTH_TOKEN and stores extra env under raw keys", () => {
		rig.seedUser({
			email: "drive@example.com",
			linearId: "lin-1",
			provider: "docker",
			claudeOauthToken: "claude-tok",
			env: { LINEAR_API_TOKEN: "lin_api_1" },
		});
		const stored = new SecretStore(secretsPath).get("drive@example.com");
		expect(stored.CLAUDE_CODE_OAUTH_TOKEN).toBe("claude-tok");
		expect(stored.LINEAR_API_TOKEN).toBe("lin_api_1");
	});
});
