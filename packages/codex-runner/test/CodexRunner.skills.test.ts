import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSkillStager } from "../src/CodexSkillStager.js";

function writeSkill(root: string, name: string): string {
	const skillDir = join(root, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name} description\n---\n\nbody\n`,
	);
	return skillDir;
}

describe("CodexSkillStager", () => {
	let tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tempDirs = [];
	});

	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "codex-skills-test-"));
		tempDirs.push(dir);
		return dir;
	}

	it("stages allowed managed and repo-local skills as Codex repo skill symlinks, and cleans them up", () => {
		const root = makeTempDir();
		const worktree = join(root, "worktree");
		const userPlugin = join(root, "user-plugin");
		const internalPlugin = join(root, "internal-plugin");
		mkdirSync(worktree, { recursive: true });
		writeSkill(join(userPlugin, "skills"), "custom-user");
		writeSkill(join(internalPlugin, "skills"), "implementation");
		writeSkill(join(worktree, ".claude", "skills"), "repo-local");

		const stager = new CodexSkillStager({
			workingDirectory: worktree,
			homeDir: root,
			plugins: [
				{ type: "local", path: userPlugin },
				{ type: "local", path: internalPlugin },
			],
			skills: ["custom-user", "repo-local"],
		});
		stager.stage();

		const stagedUserSkill = join(worktree, ".agents", "skills", "custom-user");
		const stagedRepoSkill = join(worktree, ".agents", "skills", "repo-local");
		expect(lstatSync(stagedUserSkill).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(stagedUserSkill, "SKILL.md"), "utf-8")).toContain(
			"name: custom-user",
		);
		expect(lstatSync(stagedRepoSkill).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(stagedRepoSkill, "SKILL.md"), "utf-8")).toContain(
			"name: repo-local",
		);
		// Skills not in the allow-list are not staged.
		expect(
			existsSync(join(worktree, ".agents", "skills", "implementation")),
		).toBe(false);
		expect(stager.getStagedSkillNames().sort()).toEqual([
			"custom-user",
			"repo-local",
		]);

		stager.cleanup();
		expect(existsSync(stagedUserSkill)).toBe(false);
		expect(existsSync(stagedRepoSkill)).toBe(false);
		expect(stager.getStagedSkillNames()).toEqual([]);
	});

	it("stages skills a dotfiles install put in $HOME/.claude/skills", () => {
		// Codex has no user-level skill discovery of its own, so a home skill is
		// reachable only if it is staged here. Cyrus's allow-list already
		// contains it, so skipping it would advertise a skill that exists
		// nowhere Codex looks.
		const root = makeTempDir();
		const worktree = join(root, "worktree");
		const home = join(root, "home");
		mkdirSync(worktree, { recursive: true });
		writeSkill(join(home, ".claude", "skills"), "ask-matt");

		const stager = new CodexSkillStager({
			workingDirectory: worktree,
			homeDir: home,
			skills: ["ask-matt"],
		});
		stager.stage();

		const staged = join(worktree, ".agents", "skills", "ask-matt");
		expect(lstatSync(staged).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(staged, "SKILL.md"), "utf-8")).toContain(
			"name: ask-matt",
		);
		expect(stager.getStagedSkillNames()).toEqual(["ask-matt"]);
	});

	it("prefers a plugin skill over a home skill of the same name", () => {
		const root = makeTempDir();
		const worktree = join(root, "worktree");
		const home = join(root, "home");
		const userPlugin = join(root, "user-plugin");
		mkdirSync(worktree, { recursive: true });
		writeSkill(join(userPlugin, "skills"), "shared");
		writeSkill(join(home, ".claude", "skills"), "shared");
		// Distinguish the two copies by body, not name.
		writeFileSync(
			join(home, ".claude", "skills", "shared", "SKILL.md"),
			"---\nname: shared\ndescription: home copy\n---\n\nhome body\n",
		);

		new CodexSkillStager({
			workingDirectory: worktree,
			homeDir: home,
			plugins: [{ type: "local", path: userPlugin }],
			skills: ["shared"],
		}).stage();

		const staged = join(worktree, ".agents", "skills", "shared");
		expect(readFileSync(join(staged, "SKILL.md"), "utf-8")).toContain(
			"description: shared description",
		);
	});

	it("does not overwrite an existing Codex skill with the same name", () => {
		const root = makeTempDir();
		const worktree = join(root, "worktree");
		const userPlugin = join(root, "user-plugin");
		mkdirSync(join(worktree, ".agents", "skills", "custom-user"), {
			recursive: true,
		});
		writeSkill(join(userPlugin, "skills"), "custom-user");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		new CodexSkillStager({
			workingDirectory: worktree,
			homeDir: root,
			plugins: [{ type: "local", path: userPlugin }],
			skills: ["custom-user"],
		}).stage();

		const existingSkill = join(worktree, ".agents", "skills", "custom-user");
		expect(lstatSync(existingSkill).isDirectory()).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("Skipping managed skill 'custom-user'"),
		);
	});

	it("adds the staged .agents directory to local git exclude", () => {
		const root = makeTempDir();
		const worktree = join(root, "worktree");
		const userPlugin = join(root, "user-plugin");
		mkdirSync(worktree, { recursive: true });
		execFileSync("git", ["init"], { cwd: worktree, stdio: "ignore" });
		writeSkill(join(userPlugin, "skills"), "custom-user");

		new CodexSkillStager({
			workingDirectory: worktree,
			homeDir: root,
			plugins: [{ type: "local", path: userPlugin }],
			skills: ["custom-user"],
		}).stage();

		const exclude = readFileSync(join(worktree, ".git", "info", "exclude"), {
			encoding: "utf-8",
		});
		expect(exclude.split(/\r?\n/)).toContain(".agents/");

		const status = execFileSync("git", ["status", "--short"], {
			cwd: worktree,
			encoding: "utf-8",
		});
		expect(status).not.toContain(".agents");
	});
});
