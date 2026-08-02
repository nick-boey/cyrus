import { describe, expect, it, vi } from "vitest";

/**
 * Task 12 / Codex finding 5 — guard against the explicit-whitelist trap:
 * WorkerService builds EdgeWorkerConfig from a hardcoded field list, so the new
 * top-level `platform` / `router` fields are silently dropped at boot unless
 * they are forwarded. Without this, `cyrus connect` would write a config that
 * `cyrus start` drops — router mode would never engage.
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
	it("forwards platform and router from config.json to EdgeWorker", async () => {
		const platform = "router" as const;
		const router = { url: "ws://router.example.com", deviceToken: "dev-tok" };

		const configService = {
			load: () => ({ repositories: [], platform, router }),
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
			configService as never,
			{} as never,
			"/tmp/cyrus",
			logger as never,
		);
		await service.startEdgeWorker({ repositories: [] });

		expect(EdgeWorker).toHaveBeenCalledTimes(1);
		const config = vi.mocked(EdgeWorker).mock.calls[0]![0] as Record<
			string,
			unknown
		>;
		expect(config.platform).toBe("router");
		expect(config.router).toEqual(router);
	});
});
