import { afterEach, describe, expect, it } from "vitest";
import { resolveIssueWorkspacePath } from "../src/constants.js";

describe("resolveIssueWorkspacePath", () => {
	afterEach(() => {
		delete process.env.CYRUS_WORKTREES_DIR;
	});

	it("prefers the first repository's workspaceBaseDir over the cyrusHome default", () => {
		// The container sandbox shape that NOR-411 was about: worktrees are
		// created under /workspaces while <cyrusHome>/worktrees is a directory
		// that has never existed.
		expect(
			resolveIssueWorkspacePath({
				issueIdentifier: "CAN-129",
				cyrusHome: "/workspaces/.cyrus",
				repositories: [{ workspaceBaseDir: "/workspaces" }],
			}),
		).toEqual({
			path: "/workspaces/CAN-129",
			baseDir: "/workspaces",
			source: "repository",
		});
	});

	it("prefers an explicit override over every repository", () => {
		expect(
			resolveIssueWorkspacePath({
				issueIdentifier: "CAN-129",
				cyrusHome: "/home/user/.cyrus",
				repositories: [{ workspaceBaseDir: "/workspaces" }],
				overrideBaseDir: "/tmp/elsewhere",
			}),
		).toEqual({
			path: "/tmp/elsewhere/CAN-129",
			baseDir: "/tmp/elsewhere",
			source: "override",
		});
	});

	it("falls back to <cyrusHome>/worktrees, and reports that it did", () => {
		// `source` is what lets a caller distinguish "the workspace is already
		// gone" from "we had nothing to resolve from and guessed".
		expect(
			resolveIssueWorkspacePath({
				issueIdentifier: "CAN-129",
				cyrusHome: "/home/user/.cyrus",
			}),
		).toEqual({
			path: "/home/user/.cyrus/worktrees/CAN-129",
			baseDir: "/home/user/.cyrus/worktrees",
			source: "default",
		});
	});

	it("ignores repositories with no workspaceBaseDir rather than resolving to <issue> alone", () => {
		expect(
			resolveIssueWorkspacePath({
				issueIdentifier: "CAN-129",
				cyrusHome: "/home/user/.cyrus",
				repositories: [{}, { workspaceBaseDir: "/workspaces" }],
			}).path,
		).toBe("/workspaces/CAN-129");
	});

	it("honours CYRUS_WORKTREES_DIR only on the default path", () => {
		process.env.CYRUS_WORKTREES_DIR = "/env/worktrees";

		expect(
			resolveIssueWorkspacePath({
				issueIdentifier: "CAN-129",
				cyrusHome: "/home/user/.cyrus",
			}).path,
		).toBe("/env/worktrees/CAN-129");

		// A repository that says where its worktrees go still wins: the env var
		// is a default, not an override.
		expect(
			resolveIssueWorkspacePath({
				issueIdentifier: "CAN-129",
				cyrusHome: "/home/user/.cyrus",
				repositories: [{ workspaceBaseDir: "/workspaces" }],
			}).path,
		).toBe("/workspaces/CAN-129");
	});
});
