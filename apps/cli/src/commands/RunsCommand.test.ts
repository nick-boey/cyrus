import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRunsResponse } from "cyrus-operator-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "../services/ConfigService.js";
import { Logger } from "../services/Logger.js";
import { deriveHttpUrl, RunsCommand } from "./RunsCommand.js";

vi.spyOn(process, "exit").mockImplementation((code?: number) => {
	throw new Error(`process.exit called with ${code}`);
});

function response(state: "routed" | "complete" | "unknown"): AgentRunsResponse {
	return {
		observedAt: "2026-09-02T00:00:10.000Z",
		runs: [
			{
				runId: "run-1",
				issueKey: "NOR-402",
				sessionId: "session-1",
				state,
				startedAt: "2026-09-02T00:00:00.000Z",
				lastRoutedAt: "2026-09-02T00:00:00.000Z",
				...(state === "complete" || state === "unknown"
					? { endedAt: "2026-09-02T00:00:10.000Z" }
					: {}),
				inputs: [
					{
						activityId: "activity-1",
						commentId: "comment-1",
						routedAt: "2026-09-02T00:00:00.000Z",
					},
				],
				executorKind: "container",
				provider: "aca",
				workerOnline: true,
				sandboxState: "running",
				sandboxStateObservedAt: "2026-09-02T00:00:05.000Z",
			},
		],
	};
}

describe("deriveHttpUrl", () => {
	it("reuses the connection URL for router HTTP queries", () => {
		expect(deriveHttpUrl("wss://router.example.com/")).toBe(
			"https://router.example.com",
		);
		expect(deriveHttpUrl("ws://localhost:8787")).toBe("http://localhost:8787");
	});
});

describe("RunsCommand", () => {
	let cyrusHome: string;
	let logger: Logger;
	let config: ConfigService;

	beforeEach(() => {
		cyrusHome = mkdtempSync(join(tmpdir(), "cyrus-runs-cmd-"));
		logger = new Logger();
		config = new ConfigService(cyrusHome, logger);
		config.save({
			repositories: [],
			platform: "router",
			router: { url: "wss://router.example.com", deviceToken: "device-token" },
		});
		process.exitCode = undefined;
	});

	afterEach(() => {
		rmSync(cyrusHome, { recursive: true, force: true });
		process.exitCode = undefined;
	});

	function app() {
		return { cyrusHome, logger, config } as any;
	}

	it("queries the connected router with issue, comment, and timestamp filters", async () => {
		const fetchFn = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => response("routed"),
		})) as unknown as typeof fetch;
		const raw = vi.spyOn(logger, "raw").mockImplementation(() => {});

		await new RunsCommand(app(), fetchFn).execute([
			"NOR-402",
			"--comment",
			"comment-1",
			"--after",
			"2026-09-02T00:00:00.000Z",
			"--json",
		]);

		const [url, init] = vi.mocked(fetchFn).mock.calls[0] ?? [];
		expect(String(url)).toBe(
			"https://router.example.com/runs?issueKey=NOR-402&commentId=comment-1&since=2026-09-02T00%3A00%3A00.000Z",
		);
		expect(init).toMatchObject({
			headers: { authorization: "Bearer device-token" },
		});
		expect(raw).toHaveBeenCalledWith(JSON.stringify(response("routed")));
	});

	it("watches until completion and emits NDJSON observations", async () => {
		const states = [response("routed"), response("complete")];
		const fetchFn = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => states.shift(),
		})) as unknown as typeof fetch;
		const raw = vi.spyOn(logger, "raw").mockImplementation(() => {});
		const sleep = vi.fn(async () => {});

		await new RunsCommand(app(), fetchFn, Date.now, sleep).execute([
			"--comment",
			"comment-1",
			"--watch",
			"--json",
		]);

		expect(fetchFn).toHaveBeenCalledTimes(2);
		expect(sleep).toHaveBeenCalledWith(5_000);
		expect(raw).toHaveBeenCalledTimes(2);
		expect(process.exitCode).toBeUndefined();
	});

	it("returns a nonzero status for an unknown terminal outcome", async () => {
		const fetchFn = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => response("unknown"),
		})) as unknown as typeof fetch;
		vi.spyOn(logger, "raw").mockImplementation(() => {});

		await new RunsCommand(app(), fetchFn).execute(["NOR-402", "--watch"]);

		expect(process.exitCode).toBe(1);
	});
});
