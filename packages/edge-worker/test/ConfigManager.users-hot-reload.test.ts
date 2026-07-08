import { readFile } from "node:fs/promises";
import type { EdgeWorkerConfig, ILogger } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "../src/ConfigManager.js";

vi.mock("node:fs/promises");

/**
 * Ensure the multi-user fields participate in config hot-reload — both the
 * merge in loadConfigSafely() and detectGlobalConfigChanges(). Without these,
 * `users` written to config.json while Cyrus runs would be silently dropped
 * (see CLAUDE.md note #9).
 */
describe("ConfigManager - users/gitCommitAuthor hot-reload", () => {
	let logger: ILogger;

	const users = [
		{
			linearUser: { email: "alice@org.com" },
			credentialsDir: "/home/x/.cyrus/users/alice",
		},
	];

	const baseConfig: EdgeWorkerConfig = {
		proxyUrl: "http://localhost:3000",
		cyrusHome: "/tmp/cyrus-home",
		repositories: [
			{
				id: "repo-1",
				name: "Repo 1",
				repositoryPath: "/test/repo",
				baseBranch: "main",
				workspaceBaseDir: "/test/workspaces",
			},
		],
	} as unknown as EdgeWorkerConfig;

	function makeManager(config: EdgeWorkerConfig): ConfigManager {
		return new ConfigManager(
			config,
			logger,
			"/tmp/cyrus-home/config.json",
			new Map(config.repositories.map((r) => [r.id, r])),
		);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		} as unknown as ILogger;
	});

	it("merges users and gitCommitAuthor from the reloaded config file", async () => {
		const manager = makeManager(baseConfig);
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				repositories: baseConfig.repositories,
				users,
				gitCommitAuthor: {
					mode: "shared",
					shared: { name: "Cyrus", email: "c@o.com" },
				},
			}) as any,
		);

		const newConfig = await (manager as any).loadConfigSafely();
		expect(newConfig.users).toEqual(users);
		expect(newConfig.gitCommitAuthor?.mode).toBe("shared");
	});

	it("keeps in-memory users when the file omits them", async () => {
		const manager = makeManager({
			...baseConfig,
			users,
		} as unknown as EdgeWorkerConfig);
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({ repositories: baseConfig.repositories }) as any,
		);

		const newConfig = await (manager as any).loadConfigSafely();
		expect(newConfig.users).toEqual(users);
	});

	it("detects users changes as global config changes", () => {
		const manager = makeManager(baseConfig);
		const changed = (manager as any).detectGlobalConfigChanges({
			...baseConfig,
			users,
		});
		expect(changed).toBe(true);
	});

	it("detects gitCommitAuthor changes as global config changes", () => {
		const manager = makeManager(baseConfig);
		const changed = (manager as any).detectGlobalConfigChanges({
			...baseConfig,
			gitCommitAuthor: { mode: "shared" },
		});
		expect(changed).toBe(true);
	});
});
