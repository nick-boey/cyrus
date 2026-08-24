import { readFile } from "node:fs/promises";
import { installRecordingLogSink, LogLevel } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { EdgeWorkerConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

// Mock fs/promises
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
}));

// Mock other dependencies
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-codex-runner");
vi.mock("@linear/sdk", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@linear/sdk")>();
	return {
		...actual,
		LinearClient: vi.fn().mockImplementation(function () {
			return {
				issue: vi.fn(),
				viewer: Promise.resolve({
					organization: Promise.resolve({ id: "ws-123", name: "Test" }),
				}),
				client: {
					request: vi.fn(),
					setHeader: vi.fn(),
				},
			};
		}),
	};
});
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("cyrus-core")>();
	return {
		...actual,
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});
vi.mock("file-type");

describe("EdgeWorker - Version Tag Extraction", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;

	beforeEach(() => {
		// Clear all mocks
		vi.clearAllMocks();

		// Mock console methods
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			webhookPort: 3456,
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [
				{
					id: "test-repo",
					name: "Test Repo",
					repositoryPath: "/test/repo",
					workspaceBaseDir: "/test/workspaces",
					baseBranch: "main",
					linearWorkspaceId: "test-workspace",
					isActive: true,
					allowedTools: ["Read", "Edit"],
					promptTemplatePath: "/test/template.md",
				},
			],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
		};

		edgeWorker = new EdgeWorker(mockConfig);
	});

	afterEach(() => {
		// Only clear mocks, don't restore them (restoreAllMocks would undo module mocks)
		vi.clearAllMocks();
	});

	it("should extract version from prompt template", async () => {
		const templateWithVersion = `<version-tag value="builder-v1.0.0" />

# Issue Summary

Repository: {{repository_name}}
Issue: {{issue_identifier}} - {{issue_title}}

## Description
{{issue_description}}`;

		vi.mocked(readFile).mockResolvedValue(templateWithVersion);

		// Use reflection to test private method
		const extractVersionTag = (
			edgeWorker as any
		).promptBuilder.extractVersionTag.bind(edgeWorker);
		const version = extractVersionTag(templateWithVersion);

		expect(version).toBe("builder-v1.0.0");
	});

	it("should handle templates without version tags", async () => {
		const templateWithoutVersion = `# Issue Summary

Repository: {{repository_name}}
Issue: {{issue_identifier}} - {{issue_title}}

## Description
{{issue_description}}`;

		vi.mocked(readFile).mockResolvedValue(templateWithoutVersion);

		// Use reflection to test private method
		const extractVersionTag = (
			edgeWorker as any
		).promptBuilder.extractVersionTag.bind(edgeWorker);
		const version = extractVersionTag(templateWithoutVersion);

		expect(version).toBeUndefined();
	});

	it("should log version when present in prompt template", async () => {
		const templateWithVersion = `<version-tag value="debugger-v2.1.0" />

# Debug Issue

Repository: {{repository_name}}`;

		vi.mocked(readFile).mockResolvedValue(templateWithVersion);

		// Set log level to DEBUG so version logging (a debug message) is visible
		const originalLogLevel = process.env.CYRUS_LOG_LEVEL;
		process.env.CYRUS_LOG_LEVEL = "DEBUG";
		// Recreate EdgeWorker with DEBUG log level
		edgeWorker = new EdgeWorker(mockConfig);
		process.env.CYRUS_LOG_LEVEL = originalLogLevel;

		// Record structured log records rather than console lines: the claim is
		// "the resolved template version was logged at DEBUG", which does not
		// depend on how the line is rendered.
		const recorder = installRecordingLogSink();

		// Use reflection to test the promptBuilder.buildIssueContextPrompt method
		const promptBuilder = (edgeWorker as any).promptBuilder;
		const buildIssueContextPrompt =
			promptBuilder.buildIssueContextPrompt.bind(promptBuilder);

		const mockIssue = {
			id: "issue-123",
			identifier: "TEST-123",
			title: "Test Issue",
			description: "Test description",
			state: { name: "Todo" },
			priority: 1,
			url: "http://test.com",
			branchName: "test-branch",
		};

		await buildIssueContextPrompt(mockIssue, [mockConfig.repositories[0]]);

		// Check that version was logged (at DEBUG level)
		try {
			expect(
				recorder.sink.find({
					message: "Prompt template version: debugger-v2.1.0",
					level: LogLevel.DEBUG,
				}),
			).toBeDefined();
		} finally {
			recorder.restore();
		}
	});

	it("should not log version when template has no version tag", async () => {
		const templateWithoutVersion = `# Issue Summary

Repository: {{repository_name}}`;

		vi.mocked(readFile).mockResolvedValue(templateWithoutVersion);

		const recorder = installRecordingLogSink();

		// Use reflection to test the promptBuilder.buildIssueContextPrompt method
		const promptBuilder = (edgeWorker as any).promptBuilder;
		const buildIssueContextPrompt =
			promptBuilder.buildIssueContextPrompt.bind(promptBuilder);

		const mockIssue = {
			id: "issue-123",
			identifier: "TEST-123",
			title: "Test Issue",
			description: "Test description",
			state: { name: "Todo" },
			priority: 1,
			url: "http://test.com",
			branchName: "test-branch",
		};

		await buildIssueContextPrompt(mockIssue, [mockConfig.repositories[0]]);

		// Check that version was NOT logged
		try {
			expect(
				recorder.sink.findAll({ message: "Prompt template version:" }),
			).toHaveLength(0);
		} finally {
			recorder.restore();
		}
	});
});
