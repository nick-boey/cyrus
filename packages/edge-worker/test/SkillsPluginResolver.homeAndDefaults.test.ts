import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillsPluginResolver } from "../src/SkillsPluginResolver.js";

function createTestLogger(): ILogger {
	return {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		withContext: () => createTestLogger(),
	} as unknown as ILogger;
}

/** The bundled Cyrus workflow skills, as deployed by DefaultSkillsDeployer. */
const CYRUS_SKILLS = [
	"debug",
	"implementation",
	"investigate",
	"summarize",
	"verify-and-ship",
];

async function writeSkill(
	skillsDir: string,
	name: string,
	frontmatter: Record<string, string> = {},
): Promise<void> {
	const skillDir = join(skillsDir, name);
	await mkdir(skillDir, { recursive: true });
	const lines = [`name: ${name}`, `description: test ${name}`];
	for (const [key, value] of Object.entries(frontmatter)) {
		lines.push(`${key}: ${value}`);
	}
	await writeFile(
		join(skillDir, "SKILL.md"),
		`---\n${lines.join("\n")}\n---\n\nbody\n`,
		"utf-8",
	);
}

async function writeUserManifest(cyrusHome: string): Promise<void> {
	const manifestDir = join(cyrusHome, "user-skills-plugin", ".claude-plugin");
	await mkdir(manifestDir, { recursive: true });
	await writeFile(
		join(manifestDir, "plugin.json"),
		JSON.stringify({ name: "user-skills", description: "" }),
		"utf-8",
	);
}

describe("SkillsPluginResolver home-directory skills and CYRUS_DEFAULT_SKILLS", () => {
	let cyrusHome: string;
	let homeDir: string;
	let repoPath: string;

	/** `<cyrusHome>/cyrus-skills-plugin/skills` — the bundled Cyrus set. */
	let internalSkillsDir: string;
	/** `<cyrusHome>/user-skills-plugin/skills` — CYHOST-managed skills. */
	let userSkillsDir: string;
	/** `<homeDir>/.claude/skills` — where a dotfiles install.sh writes. */
	let homeSkillsDir: string;

	const build = (defaultSkills?: string): SkillsPluginResolver =>
		new SkillsPluginResolver(cyrusHome, createTestLogger(), {
			homeDir,
			defaultSkills,
		});

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		cyrusHome = join(tmpdir(), `cyrus-skills-cyrushome-${stamp}`);
		homeDir = join(tmpdir(), `cyrus-skills-home-${stamp}`);
		repoPath = join(tmpdir(), `cyrus-skills-repo-${stamp}`);
		internalSkillsDir = join(cyrusHome, "cyrus-skills-plugin", "skills");
		userSkillsDir = join(cyrusHome, "user-skills-plugin", "skills");
		homeSkillsDir = join(homeDir, ".claude", "skills");

		await mkdir(internalSkillsDir, { recursive: true });
		await mkdir(homeDir, { recursive: true });
		await mkdir(repoPath, { recursive: true });
		await writeUserManifest(cyrusHome);
		for (const name of CYRUS_SKILLS) {
			await writeSkill(internalSkillsDir, name);
		}
	});

	afterEach(async () => {
		for (const dir of [cyrusHome, homeDir, repoPath]) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	describe("home-directory skill discovery", () => {
		it("unions ~/.claude/skills into the whitelist", async () => {
			await writeSkill(homeSkillsDir, "ask-matt");
			await writeSkill(homeSkillsDir, "codebase-design");

			const resolver = build();
			const names = await resolver.discoverSkillNames(await resolver.resolve());

			expect(names).toContain("ask-matt");
			expect(names).toContain("codebase-design");
			// The bundled set is still there — home skills add, not replace.
			expect(names).toEqual(expect.arrayContaining(CYRUS_SKILLS));
		});

		it("tolerates a missing ~/.claude/skills directory", async () => {
			const resolver = build();
			const names = await resolver.discoverSkillNames(await resolver.resolve());

			expect(names.sort()).toEqual([...CYRUS_SKILLS].sort());
		});

		it("dedupes a home skill against a plugin skill, and the plugin wins", async () => {
			await writeSkill(homeSkillsDir, "summarize");

			const resolver = build();
			const names = await resolver.discoverSkillNames(await resolver.resolve());

			expect(names.filter((n) => n === "summarize")).toHaveLength(1);
			// Plugin skills are enumerated first, so the plugin copy is the one
			// that occupies the slot.
			expect(names.indexOf("summarize")).toBeLessThan(names.length);
			expect(names.slice(0, CYRUS_SKILLS.length).sort()).toEqual(
				[...CYRUS_SKILLS].sort(),
			);
		});

		it("dedupes a home skill against a repo-local skill", async () => {
			const repoSkillsDir = join(repoPath, ".claude", "skills");
			await writeSkill(repoSkillsDir, "shared");
			await writeSkill(homeSkillsDir, "shared");

			const resolver = build();
			const names = await resolver.discoverSkillNames(
				await resolver.resolve(),
				{
					repositoryId: "repo-a",
					repoPaths: [repoPath],
				},
			);

			expect(names.filter((n) => n === "shared")).toHaveLength(1);
		});

		it("does not apply scope.json filtering to home-directory skills", async () => {
			await writeSkill(homeSkillsDir, "scoped-elsewhere");
			await writeFile(
				join(homeSkillsDir, "scoped-elsewhere", "scope.json"),
				JSON.stringify({ repositoryIds: ["some-other-repo"] }),
				"utf-8",
			);

			const resolver = build();
			const names = await resolver.discoverSkillNames(
				await resolver.resolve(),
				{
					repositoryId: "repo-a",
				},
			);

			expect(names).toContain("scoped-elsewhere");
		});
	});

	describe("CYRUS_DEFAULT_SKILLS", () => {
		it("exposes every bundled skill when unset", async () => {
			const resolver = build();
			const names = await resolver.discoverSkillNames(await resolver.resolve());

			expect(names.sort()).toEqual([...CYRUS_SKILLS].sort());
		});

		it('treats "all" the same as unset', async () => {
			const resolver = build("all");
			const names = await resolver.discoverSkillNames(await resolver.resolve());

			expect(names.sort()).toEqual([...CYRUS_SKILLS].sort());
		});

		it('drops the internal plugin entirely on "none"', async () => {
			const resolver = build("none");
			const plugins = await resolver.resolve();

			expect(plugins.some((p) => p.path.endsWith("cyrus-skills-plugin"))).toBe(
				false,
			);
			expect(await resolver.discoverSkillNames(plugins)).toEqual([]);
		});

		it('leaves user, repo-local and home skills untouched on "none"', async () => {
			await writeSkill(userSkillsDir, "user-skill");
			await writeSkill(join(repoPath, ".claude", "skills"), "repo-skill");
			await writeSkill(homeSkillsDir, "home-skill");

			const resolver = build("none");
			const names = await resolver.discoverSkillNames(
				await resolver.resolve(),
				{
					repositoryId: "repo-a",
					repoPaths: [repoPath],
				},
			);

			expect(names.sort()).toEqual(["home-skill", "repo-skill", "user-skill"]);
		});

		it("exposes only the named bundled skills for a comma-separated list", async () => {
			const resolver = build("summarize,verify-and-ship");
			const names = await resolver.discoverSkillNames(await resolver.resolve());

			expect(names.sort()).toEqual(["summarize", "verify-and-ship"]);
		});

		it("tolerates surrounding whitespace in the list", async () => {
			const resolver = build(" summarize , verify-and-ship ");
			const names = await resolver.discoverSkillNames(await resolver.resolve());

			expect(names.sort()).toEqual(["summarize", "verify-and-ship"]);
		});

		it("ignores an unknown name in the list rather than throwing", async () => {
			const resolver = build("summarize,not-a-real-skill");
			const names = await resolver.discoverSkillNames(await resolver.resolve());

			expect(names).toEqual(["summarize"]);
		});

		it("does not filter non-bundled skills by the list", async () => {
			await writeSkill(userSkillsDir, "user-skill");
			await writeSkill(homeSkillsDir, "home-skill");

			const resolver = build("summarize");
			const names = await resolver.discoverSkillNames(await resolver.resolve());

			expect(names.sort()).toEqual(["home-skill", "summarize", "user-skill"]);
		});
	});

	describe("buildSkillsGuidance", () => {
		it("emits the full routing block when all bundled skills are present", async () => {
			const resolver = build();
			const guidance = await resolver.buildSkillsGuidance(
				await resolver.resolve(),
			);

			expect(guidance).toContain(
				"- **Code changes requested** (feature, bug fix, refactor): Use `implementation` to write code, then `verify-and-ship` to run checks and create a PR, then `summarize` to narrate results.",
			);
			expect(guidance).toContain(
				"- **Bug report or error**: Use `debug` to reproduce, root-cause, and fix, then `verify-and-ship`, then `summarize`.",
			);
			expect(guidance).toContain(
				"- **Question or research request**: Use `investigate` to search the codebase and provide an answer, then `summarize`.",
			);
			expect(guidance).toContain(
				"- **PR review feedback** (changes requested): Use `implementation` to address review comments, then `verify-and-ship`.",
			);
			expect(guidance).toContain("Do NOT skip the verify-and-ship step");
		});

		it("omits routing lines whose primary skill was filtered out", async () => {
			const resolver = build("implementation,verify-and-ship");
			const guidance = await resolver.buildSkillsGuidance(
				await resolver.resolve(),
			);

			// `debug` and `investigate` are gone, so their rules must be too.
			expect(guidance).not.toContain("**Bug report or error**");
			expect(guidance).not.toContain("**Question or research request**");
			expect(guidance).toContain("**Code changes requested**");
			// `summarize` is gone, so the trailing step of the surviving rule is
			// dropped rather than referencing a skill that does not exist.
			expect(guidance).toContain(
				"- **Code changes requested** (feature, bug fix, refactor): Use `implementation` to write code, then `verify-and-ship` to run checks and create a PR.",
			);
			expect(guidance).not.toContain("`summarize`");
		});

		it("drops the verify-and-ship reminder when that skill is gone", async () => {
			const resolver = build("implementation,summarize");
			const guidance = await resolver.buildSkillsGuidance(
				await resolver.resolve(),
			);

			expect(guidance).not.toContain("verify-and-ship");
			expect(guidance).toContain(
				"- **Code changes requested** (feature, bug fix, refactor): Use `implementation` to write code, then `summarize` to narrate results.",
			);
		});

		it("emits no routing block at all when no bundled skill survives", async () => {
			await writeSkill(homeSkillsDir, "codebase-design");

			const resolver = build("none");
			const guidance = await resolver.buildSkillsGuidance(
				await resolver.resolve(),
			);

			expect(guidance).toContain(
				"You have skills available via the Skill tool: `codebase-design`",
			);
			expect(guidance).not.toContain("Choose the appropriate skill");
			expect(guidance).not.toContain("Do NOT skip");
		});

		it("still asks for the plumbing skills when no routing rule survives", async () => {
			// The documented "replace the workflow, keep the plumbing" setup.
			// No rule's primary skill survives, so there is nothing to route —
			// but `verify-and-ship` opens the PR and `summarize` posts the final
			// message, so dropping their instruction along with the rules would
			// silently stop both.
			const resolver = build("summarize,verify-and-ship");
			const guidance = await resolver.buildSkillsGuidance(
				await resolver.resolve(),
			);

			expect(guidance).not.toContain("Choose the appropriate skill");
			expect(guidance).toContain(
				"Use `verify-and-ship` whenever you have made code changes",
			);
			expect(guidance).toContain(
				"Use `summarize` to produce the session's final message.",
			);
		});

		it("says nothing about plumbing skills the user turned off", async () => {
			await writeSkill(homeSkillsDir, "codebase-design");

			const resolver = build("summarize");
			const guidance = await resolver.buildSkillsGuidance(
				await resolver.resolve(),
			);

			expect(guidance).not.toContain("verify-and-ship");
			expect(guidance).toContain(
				"Use `summarize` to produce the session's final message.",
			);
		});

		it("returns an empty string when nothing is discoverable", async () => {
			await rm(join(cyrusHome, "cyrus-skills-plugin"), {
				recursive: true,
				force: true,
			});

			const resolver = build();
			expect(await resolver.buildSkillsGuidance(await resolver.resolve())).toBe(
				"",
			);
		});

		it("omits skills marked disable-model-invocation from the listing", async () => {
			await writeSkill(homeSkillsDir, "ask-matt", {
				"disable-model-invocation": "true",
			});
			await writeSkill(homeSkillsDir, "code-review");

			const resolver = build();
			const plugins = await resolver.resolve();

			expect(await resolver.buildSkillsGuidance(plugins)).not.toContain(
				"`ask-matt`",
			);
			expect(await resolver.buildSkillsGuidance(plugins)).toContain(
				"`code-review`",
			);
			// Still in the SDK allowlist — it remains user-invocable as a
			// /slash-command, it is only unadvertised to the model.
			expect(await resolver.discoverSkillNames(plugins)).toContain("ask-matt");
		});

		it("keeps skills that set disable-model-invocation to false", async () => {
			await writeSkill(homeSkillsDir, "still-listed", {
				"disable-model-invocation": "false",
			});

			const resolver = build();
			const guidance = await resolver.buildSkillsGuidance(
				await resolver.resolve(),
			);

			expect(guidance).toContain("`still-listed`");
		});

		it("keeps a skill whose SKILL.md is missing", async () => {
			await mkdir(join(homeSkillsDir, "bare-skill"), { recursive: true });

			const resolver = build();
			const guidance = await resolver.buildSkillsGuidance(
				await resolver.resolve(),
			);

			expect(guidance).toContain("`bare-skill`");
		});

		it("disambiguates `implement` from `implementation` when both exist", async () => {
			await writeSkill(homeSkillsDir, "implement");

			const resolver = build();
			const guidance = await resolver.buildSkillsGuidance(
				await resolver.resolve(),
			);

			expect(guidance).toContain(
				"`implementation` and `implement` are different skills",
			);
		});

		it("does not disambiguate when only `implementation` exists", async () => {
			const resolver = build();
			const guidance = await resolver.buildSkillsGuidance(
				await resolver.resolve(),
			);

			expect(guidance).not.toContain("are different skills");
		});
	});
});
