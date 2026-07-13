import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EdgeConfigSchema, RepositoryConfigSchema } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ContainerBootCommand,
	defaultExec,
	type ExecFn,
	findMissingEnvVars,
	isValidIssueKey,
	parseReposJson,
	REQUIRED_ENV_VARS,
	type SpawnedChild,
} from "./ContainerBootCommand.js";

// process.exit is called on any fatal validation error. If a happy-path test
// accidentally takes an error branch, this makes the failure surface as a
// thrown error instead of silently killing the test worker — matching the
// convention in ConnectCommand.test.ts.
vi.spyOn(process, "exit").mockImplementation((code?: number) => {
	throw new Error(`process.exit called with ${code}`);
});

function baseEnv(
	overrides: Partial<NodeJS.ProcessEnv> = {},
): NodeJS.ProcessEnv {
	return {
		CYRUS_ROUTER_URL: "https://router.example.com",
		CYRUS_DEVICE_TOKEN: "device-token-abc",
		CYRUS_ISSUE_KEY: "CYPACK-11",
		CYRUS_REPOS_JSON: JSON.stringify([
			{ name: "repo1", githubSlug: "org/repo1", linearWorkspaceId: "ws-1" },
		]),
		CLAUDE_CODE_OAUTH_TOKEN: "claude-oauth-tok",
		...overrides,
	};
}

function makeFakeExec(
	handler?: (
		cmd: string,
		args: string[],
	) => { stdout?: string; stderr?: string; exitCode?: number } | undefined,
) {
	const calls: Array<{ cmd: string; args: string[] }> = [];
	const exec: ExecFn = async (cmd, args) => {
		calls.push({ cmd, args });
		const result = handler?.(cmd, args) ?? {};
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			exitCode: result.exitCode ?? 0,
		};
	};
	return { exec, calls };
}

function silentLogger() {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("findMissingEnvVars", () => {
	it("returns an empty array when every required var is present", () => {
		expect(findMissingEnvVars(baseEnv())).toEqual([]);
	});

	it("returns exactly the missing ones", () => {
		const env = baseEnv();
		delete env.CYRUS_DEVICE_TOKEN;
		delete env.CLAUDE_CODE_OAUTH_TOKEN;
		expect(findMissingEnvVars(env)).toEqual([
			"CYRUS_DEVICE_TOKEN",
			"CLAUDE_CODE_OAUTH_TOKEN",
		]);
	});

	it("treats an empty string as missing", () => {
		const env = baseEnv({ CYRUS_ISSUE_KEY: "" });
		expect(findMissingEnvVars(env)).toEqual(["CYRUS_ISSUE_KEY"]);
	});

	it("covers all five required vars from the brief", () => {
		expect([...REQUIRED_ENV_VARS].sort()).toEqual(
			[
				"CYRUS_ROUTER_URL",
				"CYRUS_DEVICE_TOKEN",
				"CYRUS_ISSUE_KEY",
				"CYRUS_REPOS_JSON",
				"CLAUDE_CODE_OAUTH_TOKEN",
			].sort(),
		);
	});
});

describe("isValidIssueKey", () => {
	it("accepts typical Linear-style issue keys", () => {
		expect(isValidIssueKey("CYPACK-11")).toBe(true);
		expect(isValidIssueKey("a")).toBe(true);
		expect(isValidIssueKey("A0")).toBe(true);
	});

	it("rejects empty strings, path separators, and other unsafe characters", () => {
		expect(isValidIssueKey("")).toBe(false);
		expect(isValidIssueKey("../../etc")).toBe(false);
		expect(isValidIssueKey("has space")).toBe(false);
		expect(isValidIssueKey("has/slash")).toBe(false);
		expect(isValidIssueKey("-leading-dash")).toBe(false);
	});

	it("rejects keys longer than 64 characters", () => {
		expect(isValidIssueKey("a".repeat(64))).toBe(true);
		expect(isValidIssueKey("a".repeat(65))).toBe(false);
	});
});

describe("parseReposJson", () => {
	it("parses a valid array", () => {
		const repos = parseReposJson(
			JSON.stringify([
				{ name: "a", githubSlug: "org/a", linearWorkspaceId: "ws-1" },
				{
					name: "b",
					githubSlug: "org/b",
					linearWorkspaceId: "ws-2",
					baseBranch: "develop",
				},
			]),
		);
		expect(repos).toHaveLength(2);
		expect(repos[1]?.baseBranch).toBe("develop");
	});

	it("throws on invalid JSON", () => {
		expect(() => parseReposJson("{not json")).toThrow(/not valid JSON/);
	});

	it("throws when an entry is missing a required field", () => {
		expect(() =>
			parseReposJson(
				JSON.stringify([{ name: "a", linearWorkspaceId: "ws-1" }]),
			),
		).toThrow(/does not match the expected shape/);
	});
});

describe("defaultExec", () => {
	it("folds the underlying spawn error's message into stderr when the binary itself is missing (ENOENT)", async () => {
		const result = await defaultExec(
			"cyrus-definitely-not-a-real-binary-xyz",
			[],
		);

		expect(result.exitCode).not.toBe(0);
		// Node's stderr for a spawn-level ENOENT is empty; without folding in
		// err.message, callers (e.g. cloneRepos) are left with no cause at
		// all — just "git clone failed for repo1: " and nothing after it.
		expect(result.stderr.length).toBeGreaterThan(0);
		expect(result.stderr).toMatch(/ENOENT|not found|no such file/i);
	});
});

describe("ContainerBootCommand.execute — env validation", () => {
	it("exits 1 naming every missing required env var, without touching the fs", async () => {
		const logger = silentLogger();
		const env = baseEnv();
		delete env.CYRUS_DEVICE_TOKEN;
		delete env.GIT_TOKEN;
		const cmd = new ContainerBootCommand({ env, logger });

		await expect(cmd.execute([])).rejects.toThrow(/process.exit called with 1/);

		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("CYRUS_DEVICE_TOKEN"),
		);
	});

	it("exits 1 when CYRUS_REPOS_JSON is malformed", async () => {
		const logger = silentLogger();
		const cmd = new ContainerBootCommand({
			env: baseEnv({ CYRUS_REPOS_JSON: "not json" }),
			logger,
		});

		await expect(cmd.execute([])).rejects.toThrow(/process.exit called with 1/);
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("CYRUS_REPOS_JSON"),
		);
	});

	it("exits 1 when CYRUS_ISSUE_KEY doesn't match the required pattern", async () => {
		const logger = silentLogger();
		const cmd = new ContainerBootCommand({
			env: baseEnv({ CYRUS_ISSUE_KEY: "not a valid key!" }),
			logger,
		});

		await expect(cmd.execute([])).rejects.toThrow(/process.exit called with 1/);
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining("CYRUS_ISSUE_KEY"),
		);
	});
});

describe("ContainerBootCommand — steps 1-6 (fs/env logic)", () => {
	let workspacesDir: string;
	let homeDir: string;
	let repoCacheDir: string;

	beforeEach(() => {
		workspacesDir = mkdtempSync(join(tmpdir(), "cyrus-boot-ws-"));
		homeDir = mkdtempSync(join(tmpdir(), "cyrus-boot-home-"));
		repoCacheDir = mkdtempSync(join(tmpdir(), "cyrus-boot-cache-"));
	});

	afterEach(() => {
		rmSync(workspacesDir, { recursive: true, force: true });
		rmSync(homeDir, { recursive: true, force: true });
		rmSync(repoCacheDir, { recursive: true, force: true });
	});

	function newCommand(
		overrides: ConstructorParameters<typeof ContainerBootCommand>[0] = {},
	) {
		return new ContainerBootCommand({
			env: baseEnv(),
			homeDir,
			logger: silentLogger(),
			...overrides,
		});
	}

	describe("linkClaudeProjects (step 1)", () => {
		it("symlinks ~/.claude/projects to $WORKSPACES/.claude-projects", () => {
			const cmd = newCommand();

			cmd.linkClaudeProjects(workspacesDir);

			const linkPath = join(homeDir, ".claude", "projects");
			const stat = lstatSync(linkPath);
			expect(stat.isSymbolicLink()).toBe(true);
			expect(readlinkSync(linkPath)).toBe(
				join(workspacesDir, ".claude-projects"),
			);
		});

		it("is idempotent: re-running on a warm volume leaves the same symlink", () => {
			const cmd = newCommand();

			cmd.linkClaudeProjects(workspacesDir);
			cmd.linkClaudeProjects(workspacesDir);

			const linkPath = join(homeDir, ".claude", "projects");
			expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
			expect(readlinkSync(linkPath)).toBe(
				join(workspacesDir, ".claude-projects"),
			);
		});

		it("renames a pre-existing real directory aside instead of deleting it", () => {
			const cmd = newCommand();
			const linkPath = join(homeDir, ".claude", "projects");
			mkdirSync(linkPath, { recursive: true });
			writeFileSync(join(linkPath, "precious.jsonl"), "data");

			cmd.linkClaudeProjects(workspacesDir);

			expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
			// The old real directory must still exist somewhere under ~/.claude,
			// just not at the link path itself (nothing is silently deleted).
			const claudeDir = join(homeDir, ".claude");
			const backupEntry = readdirSync(claudeDir).find((name) =>
				name.startsWith("projects.bak-"),
			);
			expect(backupEntry).toBeDefined();
			expect(
				readFileSync(
					join(claudeDir, backupEntry as string, "precious.jsonl"),
					"utf-8",
				),
			).toBe("data");
		});
	});

	describe("restoreState (step 2)", () => {
		it("warm volume fast path: skips entirely when the state file already exists", async () => {
			const stateFile = join(
				workspacesDir,
				".cyrus",
				"state",
				"edge-worker-state.json",
			);
			mkdirSync(join(workspacesDir, ".cyrus", "state"), { recursive: true });
			writeFileSync(stateFile, "{}");
			const downloadBundleFn = vi.fn();
			const restoreBundleFn = vi.fn();
			const cmd = newCommand({ downloadBundleFn, restoreBundleFn });

			const result = await cmd.restoreState({
				workspacesDir,
				routerUrl: "https://router.example.com",
				deviceToken: "tok",
				issueKey: "CYPACK-11",
			});

			expect(result).toBe("warm");
			expect(downloadBundleFn).not.toHaveBeenCalled();
			expect(restoreBundleFn).not.toHaveBeenCalled();
		});

		it("404 (no bundle yet) -> fresh start, without calling restoreBundle", async () => {
			const downloadBundleFn = vi.fn().mockResolvedValue(false);
			const restoreBundleFn = vi.fn();
			const cmd = newCommand({ downloadBundleFn, restoreBundleFn });

			const result = await cmd.restoreState({
				workspacesDir,
				routerUrl: "https://router.example.com",
				deviceToken: "tok",
				issueKey: "CYPACK-11",
			});

			expect(result).toBe("fresh");
			expect(downloadBundleFn).toHaveBeenCalledWith(
				"https://router.example.com",
				"tok",
				"CYPACK-11",
				expect.any(String),
			);
			expect(restoreBundleFn).not.toHaveBeenCalled();
		});

		it("a found bundle is restored via restoreBundle with the right dirs", async () => {
			const downloadBundleFn = vi.fn().mockResolvedValue(true);
			const restoreBundleFn = vi
				.fn()
				.mockResolvedValue({ restoredSessions: 2 });
			const cmd = newCommand({ downloadBundleFn, restoreBundleFn });

			const result = await cmd.restoreState({
				workspacesDir,
				routerUrl: "https://router.example.com",
				deviceToken: "tok",
				issueKey: "CYPACK-11",
			});

			expect(result).toBe("restored");
			expect(restoreBundleFn).toHaveBeenCalledWith({
				bundleFile: expect.any(String),
				claudeProjectsDir: join(workspacesDir, ".claude-projects"),
				stateFile: join(
					workspacesDir,
					".cyrus",
					"state",
					"edge-worker-state.json",
				),
			});
		});
	});

	describe("cloneRepos (step 4)", () => {
		it("clones from the clean (tokenless) URL and heals remote.origin.url after — never embeds GIT_TOKEN, even when it's set", async () => {
			const { exec, calls } = makeFakeExec();
			const cmd = newCommand({ exec });

			await cmd.cloneRepos({
				workspacesDir,
				repoCacheDir,
				repos: [
					{ name: "repo1", githubSlug: "org/repo1", linearWorkspaceId: "ws-1" },
				],
				gitToken: "tok-xyz",
			});

			// Deep-equality on every exec call: this is the exec-seam guarantee
			// that no git invocation is ever passed a token-bearing URL/argument.
			expect(calls).toEqual([
				{
					cmd: "git",
					args: [
						"clone",
						"--reference-if-able",
						join(repoCacheDir, "repo1.git"),
						"https://github.com/org/repo1.git",
						join(workspacesDir, "repos", "repo1"),
					],
				},
				{
					cmd: "git",
					args: [
						"-C",
						join(workspacesDir, "repos", "repo1"),
						"remote",
						"set-url",
						"origin",
						"https://github.com/org/repo1.git",
					],
				},
			]);
			for (const call of calls) {
				for (const arg of call.args) {
					expect(arg).not.toContain("tok-xyz");
				}
			}
		});

		it("clones the same clean URL when GIT_TOKEN is absent", async () => {
			const { exec, calls } = makeFakeExec();
			const cmd = newCommand({ exec });

			await cmd.cloneRepos({
				workspacesDir,
				repoCacheDir,
				repos: [
					{ name: "repo1", githubSlug: "org/repo1", linearWorkspaceId: "ws-1" },
				],
			});

			expect(calls[0]?.args).toContain("https://github.com/org/repo1.git");
		});

		it("is idempotent: skips a repo whose existing clone has a resolvable HEAD, but still heals its remote URL", async () => {
			mkdirSync(join(workspacesDir, "repos", "repo1", ".git"), {
				recursive: true,
			});
			const { exec, calls } = makeFakeExec((_cmd, args) =>
				args.includes("rev-parse") ? { exitCode: 0 } : undefined,
			);
			const cmd = newCommand({ exec });

			await cmd.cloneRepos({
				workspacesDir,
				repoCacheDir,
				repos: [
					{ name: "repo1", githubSlug: "org/repo1", linearWorkspaceId: "ws-1" },
				],
				gitToken: "tok-xyz",
			});

			expect(calls.some((c) => c.args[0] === "clone")).toBe(false);
			expect(calls).toContainEqual({
				cmd: "git",
				args: [
					"-C",
					join(workspacesDir, "repos", "repo1"),
					"remote",
					"set-url",
					"origin",
					"https://github.com/org/repo1.git",
				],
			});
		});

		it("re-clones when an existing .git dir has no resolvable HEAD (an interrupted/partial clone)", async () => {
			const repoDir = join(workspacesDir, "repos", "repo1");
			mkdirSync(join(repoDir, ".git"), { recursive: true });
			writeFileSync(
				join(repoDir, "leftover.txt"),
				"debris from an interrupted clone",
			);

			const { exec, calls } = makeFakeExec((_cmd, args) => {
				if (args.includes("rev-parse")) {
					return {
						exitCode: 128,
						stderr: "fatal: not a valid object name HEAD",
					};
				}
				if (args[0] === "clone") {
					// A real `git clone` would recreate the directory cleanly;
					// simulate that so we can assert the debris is gone.
					rmSync(repoDir, { recursive: true, force: true });
					mkdirSync(join(repoDir, ".git"), { recursive: true });
				}
				return undefined;
			});
			const cmd = newCommand({ exec });

			await cmd.cloneRepos({
				workspacesDir,
				repoCacheDir,
				repos: [
					{ name: "repo1", githubSlug: "org/repo1", linearWorkspaceId: "ws-1" },
				],
			});

			expect(calls.some((c) => c.args[0] === "clone")).toBe(true);
			expect(existsSync(join(repoDir, "leftover.txt"))).toBe(false);
		});

		it("never leaks GIT_TOKEN into a thrown error message on clone failure", async () => {
			const { exec } = makeFakeExec(() => ({
				exitCode: 128,
				stderr:
					"fatal: unable to access 'https://x-access-token:tok-xyz@github.com/org/repo1.git/': fake failure",
			}));
			const cmd = newCommand({ exec });

			await expect(
				cmd.cloneRepos({
					workspacesDir,
					repoCacheDir,
					repos: [
						{
							name: "repo1",
							githubSlug: "org/repo1",
							linearWorkspaceId: "ws-1",
						},
					],
					gitToken: "tok-xyz",
				}),
			).rejects.toThrow(/\*\*\*/);

			try {
				await cmd.cloneRepos({
					workspacesDir,
					repoCacheDir,
					repos: [
						{
							name: "repo1",
							githubSlug: "org/repo1",
							linearWorkspaceId: "ws-1",
						},
					],
					gitToken: "tok-xyz",
				});
				expect.unreachable("expected cloneRepos to throw");
			} catch (error) {
				expect((error as Error).message).not.toContain("tok-xyz");
			}
		});
	});

	describe("writeConfig (step 5)", () => {
		const repos = [
			{ name: "repo1", githubSlug: "org/repo1", linearWorkspaceId: "ws-1" },
			{
				name: "repo2",
				githubSlug: "org/repo2",
				linearWorkspaceId: "ws-2",
				baseBranch: "develop",
			},
		];

		it("writes a config.json that validates against the real EdgeConfigSchema/RepositoryConfigSchema", () => {
			const cmd = newCommand();

			cmd.writeConfig({
				workspacesDir,
				routerUrl: "https://router.example.com",
				deviceToken: "device-tok",
				repos,
			});

			const configPath = join(workspacesDir, ".cyrus", "config.json");
			const written = JSON.parse(readFileSync(configPath, "utf-8"));

			const edgeConfigResult = EdgeConfigSchema.safeParse(written);
			expect(edgeConfigResult.success).toBe(true);
			for (const repo of written.repositories) {
				expect(RepositoryConfigSchema.safeParse(repo).success).toBe(true);
			}

			expect(written.platform).toBe("router");
			expect(written.router).toEqual({
				url: "https://router.example.com",
				deviceToken: "device-tok",
				floorSync: true,
			});
			expect(written.repositories).toEqual([
				{
					id: "repo1",
					name: "repo1",
					repositoryPath: join(workspacesDir, "repos", "repo1"),
					workspaceBaseDir: workspacesDir,
					baseBranch: "main",
					linearWorkspaceId: "ws-1",
					isActive: true,
				},
				{
					id: "repo2",
					name: "repo2",
					repositoryPath: join(workspacesDir, "repos", "repo2"),
					workspaceBaseDir: workspacesDir,
					baseBranch: "develop",
					linearWorkspaceId: "ws-2",
					isActive: true,
				},
			]);
		});

		it("writes config.json at mode 0600", () => {
			const cmd = newCommand();

			cmd.writeConfig({
				workspacesDir,
				routerUrl: "https://router.example.com",
				deviceToken: "device-tok",
				repos,
			});

			const configPath = join(workspacesDir, ".cyrus", "config.json");
			const mode = statSync(configPath).mode & 0o777;
			expect(mode).toBe(0o600);
		});

		it("is idempotent: writing twice produces identical content", () => {
			const cmd = newCommand();
			const configPath = join(workspacesDir, ".cyrus", "config.json");

			cmd.writeConfig({
				workspacesDir,
				routerUrl: "https://router.example.com",
				deviceToken: "device-tok",
				repos,
			});
			const first = readFileSync(configPath, "utf-8");

			cmd.writeConfig({
				workspacesDir,
				routerUrl: "https://router.example.com",
				deviceToken: "device-tok",
				repos,
			});
			const second = readFileSync(configPath, "utf-8");

			expect(second).toBe(first);
		});
	});

	describe("configureGit (step 3)", () => {
		it("sets git user.name/user.email (defaults)", async () => {
			const { exec, calls } = makeFakeExec();
			const cmd = newCommand({ exec });

			await cmd.configureGit({
				gitUserName: "Cyrus",
				gitUserEmail: "cyrus@localhost",
			});

			expect(calls).toEqual(
				expect.arrayContaining([
					{ cmd: "git", args: ["config", "--global", "user.name", "Cyrus"] },
					{
						cmd: "git",
						args: ["config", "--global", "user.email", "cyrus@localhost"],
					},
				]),
			);
		});

		it("honors custom GIT_USER_NAME/GIT_USER_EMAIL", async () => {
			const { exec, calls } = makeFakeExec();
			const cmd = newCommand({ exec });

			await cmd.configureGit({
				gitUserName: "Alice",
				gitUserEmail: "alice@example.com",
			});

			expect(calls).toEqual(
				expect.arrayContaining([
					{ cmd: "git", args: ["config", "--global", "user.name", "Alice"] },
					{
						cmd: "git",
						args: ["config", "--global", "user.email", "alice@example.com"],
					},
				]),
			);
		});

		it("writes ~/.git-credentials at 0600 and configures the store helper when GIT_TOKEN is set", async () => {
			const { exec, calls } = makeFakeExec();
			const cmd = newCommand({ exec });

			await cmd.configureGit({
				gitUserName: "Cyrus",
				gitUserEmail: "cyrus@localhost",
				gitToken: "tok-xyz",
			});

			const credsPath = join(homeDir, ".git-credentials");
			expect(readFileSync(credsPath, "utf-8")).toBe(
				"https://x-access-token:tok-xyz@github.com\n",
			);
			const mode = statSync(credsPath).mode & 0o777;
			expect(mode).toBe(0o600);
			expect(calls).toEqual(
				expect.arrayContaining([
					{
						cmd: "git",
						args: ["config", "--global", "credential.helper", "store"],
					},
				]),
			);
		});

		it("does not write ~/.git-credentials when GIT_TOKEN is absent", async () => {
			const { exec, calls } = makeFakeExec();
			const cmd = newCommand({ exec });

			await cmd.configureGit({
				gitUserName: "Cyrus",
				gitUserEmail: "cyrus@localhost",
			});

			const credsPath = join(homeDir, ".git-credentials");
			expect(() => statSync(credsPath)).toThrow();
			expect(calls.some((c) => c.args.includes("credential.helper"))).toBe(
				false,
			);
		});
	});

	describe("applyDotfiles (step 6)", () => {
		it("is a no-op when DOTFILES_REPO is unset", async () => {
			const { exec, calls } = makeFakeExec();
			const cmd = newCommand({ exec });

			await cmd.applyDotfiles({});

			expect(calls).toEqual([]);
		});

		it("clones the dotfiles repo and runs install.sh when present", async () => {
			const { exec, calls } = makeFakeExec((cmd) => {
				if (cmd === "git") {
					// Simulate the clone actually creating the dir + install.sh.
					mkdirSync(join(homeDir, "dotfiles", ".git"), { recursive: true });
					writeFileSync(join(homeDir, "dotfiles", "install.sh"), "#!/bin/sh\n");
				}
				return undefined;
			});
			const cmd = newCommand({ exec });

			await cmd.applyDotfiles({
				dotfilesRepo: "https://github.com/org/dotfiles.git",
			});

			expect(calls[0]).toEqual({
				cmd: "git",
				args: [
					"clone",
					"https://github.com/org/dotfiles.git",
					join(homeDir, "dotfiles"),
				],
			});
			expect(calls[1]).toEqual({
				cmd: "sh",
				args: [join(homeDir, "dotfiles", "install.sh")],
			});
		});

		it("is idempotent: skips re-cloning when ~/dotfiles/.git already exists", async () => {
			mkdirSync(join(homeDir, "dotfiles", ".git"), { recursive: true });
			const { exec, calls } = makeFakeExec();
			const cmd = newCommand({ exec });

			await cmd.applyDotfiles({
				dotfilesRepo: "https://github.com/org/dotfiles.git",
			});

			expect(calls.some((c) => c.args[0] === "clone")).toBe(false);
		});

		it("logs a warning and continues (does not throw) when the clone fails", async () => {
			const { exec } = makeFakeExec(() => ({
				exitCode: 1,
				stderr: "network unreachable",
			}));
			const logger = silentLogger();
			const cmd = newCommand({ exec, logger });

			await expect(
				cmd.applyDotfiles({
					dotfilesRepo: "https://github.com/org/dotfiles.git",
				}),
			).resolves.toBeUndefined();
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("applyDotfiles failed"),
			);
		});

		it("redacts a PAT embedded in DOTFILES_REPO from the warning log on clone failure", async () => {
			const { exec } = makeFakeExec(() => ({
				exitCode: 128,
				stderr:
					"fatal: unable to access 'https://ghp_secretpat123@github.com/me/dotfiles/': The requested URL returned error: 403",
			}));
			const logger = silentLogger();
			const cmd = newCommand({ exec, logger });

			await cmd.applyDotfiles({
				dotfilesRepo: "https://ghp_secretpat123@github.com/me/dotfiles",
			});

			expect(logger.warn).toHaveBeenCalledTimes(1);
			const warnedMessage = (logger.warn as ReturnType<typeof vi.fn>).mock
				.calls[0]?.[0] as string;
			expect(warnedMessage).not.toContain("ghp_secretpat123");
			expect(warnedMessage).toContain("***");
		});
	});
});

describe("ContainerBootCommand.launch (step 7)", () => {
	function newCommand(spawnFn: (...args: unknown[]) => SpawnedChild) {
		return new ContainerBootCommand({
			env: baseEnv(),
			spawnFn: spawnFn as never,
			appPath: "/app/dist/src/app.js",
			logger: silentLogger(),
		});
	}

	it("spawns `<node> <appPath> --cyrus-home <cyrusHome> start` with inherited stdio", () => {
		const fakeChild: SpawnedChild = { on: vi.fn(), kill: vi.fn() };
		const spawnFn = vi.fn().mockReturnValue(fakeChild);
		const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
		const cmd = newCommand(spawnFn);

		cmd.launch({ cyrusHome: "/workspaces/.cyrus" });

		expect(spawnFn).toHaveBeenCalledWith(
			process.execPath,
			["/app/dist/src/app.js", "--cyrus-home", "/workspaces/.cyrus", "start"],
			{ stdio: "inherit" },
		);

		onSpy.mockRestore();
	});

	it("forwards SIGTERM/SIGINT to the child", () => {
		const fakeChild: SpawnedChild = { on: vi.fn(), kill: vi.fn() };
		const spawnFn = vi.fn().mockReturnValue(fakeChild);
		const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
		const cmd = newCommand(spawnFn);

		cmd.launch({ cyrusHome: "/workspaces/.cyrus" });

		const sigtermHandler = onSpy.mock.calls.find(
			([sig]) => sig === "SIGTERM",
		)?.[1] as (() => void) | undefined;
		const sigintHandler = onSpy.mock.calls.find(
			([sig]) => sig === "SIGINT",
		)?.[1] as (() => void) | undefined;
		expect(sigtermHandler).toBeDefined();
		expect(sigintHandler).toBeDefined();

		sigtermHandler?.();
		expect(fakeChild.kill).toHaveBeenCalledWith("SIGTERM");

		sigintHandler?.();
		expect(fakeChild.kill).toHaveBeenCalledWith("SIGINT");

		onSpy.mockRestore();
	});

	it("exits the process with the child's exit code", () => {
		let exitListener:
			| ((code: number | null, signal: NodeJS.Signals | null) => void)
			| undefined;
		const fakeChild: SpawnedChild = {
			on: vi.fn((event, listener) => {
				if (event === "exit") exitListener = listener;
			}),
			kill: vi.fn(),
		};
		const spawnFn = vi.fn().mockReturnValue(fakeChild);
		const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
		const cmd = newCommand(spawnFn);

		cmd.launch({ cyrusHome: "/workspaces/.cyrus" });

		expect(() => exitListener?.(3, null)).toThrow(/process.exit called with 3/);

		onSpy.mockRestore();
	});
});

describe("ContainerBootCommand.execute — full fresh-start orchestration", () => {
	let workspacesDir: string;
	let homeDir: string;
	let repoCacheDir: string;

	beforeEach(() => {
		workspacesDir = mkdtempSync(join(tmpdir(), "cyrus-boot-e2e-ws-"));
		homeDir = mkdtempSync(join(tmpdir(), "cyrus-boot-e2e-home-"));
		repoCacheDir = mkdtempSync(join(tmpdir(), "cyrus-boot-e2e-cache-"));
	});

	afterEach(() => {
		rmSync(workspacesDir, { recursive: true, force: true });
		rmSync(homeDir, { recursive: true, force: true });
		rmSync(repoCacheDir, { recursive: true, force: true });
	});

	it("runs the whole restore ladder end-to-end and launches `cyrus start`", async () => {
		const { exec, calls } = makeFakeExec();
		const downloadBundleFn = vi.fn().mockResolvedValue(false);
		const restoreBundleFn = vi.fn();
		const fakeChild: SpawnedChild = { on: vi.fn(), kill: vi.fn() };
		const spawnFn = vi.fn().mockReturnValue(fakeChild);
		const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);

		const cmd = new ContainerBootCommand({
			env: baseEnv({
				CYRUS_WORKSPACES_DIR: workspacesDir,
				CYRUS_REPO_CACHE_DIR: repoCacheDir,
				GIT_TOKEN: "tok-xyz",
			}),
			exec,
			spawnFn,
			homeDir,
			downloadBundleFn,
			restoreBundleFn,
			appPath: "/app/dist/src/app.js",
			logger: silentLogger(),
		});

		await cmd.execute([]);

		// Step 1
		expect(
			lstatSync(join(homeDir, ".claude", "projects")).isSymbolicLink(),
		).toBe(true);
		// Step 2
		expect(downloadBundleFn).toHaveBeenCalled();
		expect(restoreBundleFn).not.toHaveBeenCalled();
		// Step 3 (configureGit) runs before step 4 (cloneRepos): the
		// credential helper is what authenticates the clone.
		const credentialHelperIndex = calls.findIndex(
			(c) => c.cmd === "git" && c.args.includes("credential.helper"),
		);
		const cloneIndex = calls.findIndex(
			(c) => c.cmd === "git" && c.args[0] === "clone",
		);
		expect(credentialHelperIndex).toBeGreaterThanOrEqual(0);
		expect(cloneIndex).toBeGreaterThan(credentialHelperIndex);
		expect(readFileSync(join(homeDir, ".git-credentials"), "utf-8")).toContain(
			"tok-xyz",
		);
		// Step 4: the clone itself is never passed a token-bearing URL — the
		// clean URL is used, and GIT_TOKEN never appears in any exec call
		// (the exec-seam guarantee that it never reaches `.git/config`).
		expect(
			calls.some(
				(c) =>
					c.cmd === "git" &&
					c.args.includes("https://github.com/org/repo1.git"),
			),
		).toBe(true);
		for (const call of calls) {
			for (const arg of call.args) {
				expect(arg).not.toContain("tok-xyz");
			}
		}
		// Step 5
		const configPath = join(workspacesDir, ".cyrus", "config.json");
		const written = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(EdgeConfigSchema.safeParse(written).success).toBe(true);
		// Step 7
		expect(spawnFn).toHaveBeenCalledWith(
			process.execPath,
			[
				"/app/dist/src/app.js",
				"--cyrus-home",
				join(workspacesDir, ".cyrus"),
				"start",
			],
			{ stdio: "inherit" },
		);

		onSpy.mockRestore();
	});
});
