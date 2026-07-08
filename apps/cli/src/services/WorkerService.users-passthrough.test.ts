import { describe, expect, it, vi } from "vitest";

/**
 * Guard against the explicit-whitelist trap: WorkerService constructs
 * EdgeWorkerConfig from a hardcoded field list, so a new top-level config
 * field (here: `users` / `gitCommitAuthor`) is silently dropped at boot
 * unless it is added to that list. Multi-user mode would then be off until
 * the first hot-reload — a fail-open credential bug.
 */
vi.mock("cyrus-edge-worker", () => ({
	EdgeWorker: vi.fn(function mockEdgeWorker() {
		return {
			setConfigPath: vi.fn(),
			start: vi.fn().mockResolvedValue(undefined),
			on: vi.fn(),
		};
	}),
}));
vi.mock("cyrus-slack-event-transport", () => ({
	SlackEventTransport: vi.fn(),
}));
vi.mock("cyrus-cloudflare-tunnel-client", () => ({
	getCyrusAppUrl: () => "https://app.example.com",
}));

import { EdgeWorker } from "cyrus-edge-worker";
import { WorkerService } from "./WorkerService.js";

describe("WorkerService EdgeWorkerConfig pass-through", () => {
	it("forwards users and gitCommitAuthor from config.json to EdgeWorker", async () => {
		const users = [
			{
				linearUser: { email: "alice@org.com" },
				credentialsDir: "/tmp/users/alice",
			},
		];
		const gitCommitAuthor = { mode: "shared" as const };

		const configService = {
			load: () => ({ repositories: [], users, gitCommitAuthor }),
			getConfigPath: () => "/tmp/cyrus/config.json",
		};
		const logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
			success: vi.fn(),
		};

		const service = new WorkerService(
			configService as any,
			{} as any,
			"/tmp/cyrus",
			logger as any,
		);
		await service.startEdgeWorker({ repositories: [] });

		expect(EdgeWorker).toHaveBeenCalledTimes(1);
		const config = vi.mocked(EdgeWorker).mock.calls[0]![0] as Record<
			string,
			unknown
		>;
		expect(config.users).toEqual(users);
		expect(config.gitCommitAuthor).toEqual(gitCommitAuthor);
	});
});
