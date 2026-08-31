/**
 * Prompt Assembly Tests - Home-Directory Skills
 *
 * The resolver-level rules for `$HOME/.claude/skills` are covered in
 * `SkillsPluginResolver.homeAndDefaults.test.ts` with an injected `homeDir`.
 * These tests exercise the same behaviour through the *real* EdgeWorker path —
 * `assemblePrompt` → `buildSkillsGuidance` → `os.homedir()` — which is the only
 * place the production default (no injected `homeDir`) is actually used. That
 * default is easy to get wrong (`cyrusHome` and `$HOME` differ in a container),
 * and a mistake there is silent: the files sit on disk and the model sees
 * nothing.
 *
 * `$HOME` is an empty per-run temp directory (see `test/setup.ts`), so planting
 * a skill here is safe and does not read the developer's real home.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "vitest";
import { createTestWorker, scenario } from "./prompt-assembly-utils.js";

const HOME_SKILLS_DIR = join(process.env.HOME!, ".claude", "skills");

/** The shared-instructions block every fallback system prompt opens with. */
const TASK_MANAGEMENT_INSTRUCTIONS = `<task_management_instructions>
CRITICAL: You MUST use the Task tools (TaskCreate, TaskUpdate, TaskGet, TaskList) extensively:
- IMMEDIATELY create a comprehensive task list at the beginning of your work using TaskCreate
- Break down complex tasks into smaller, actionable items
- Update tasks to 'in_progress' when you start them using TaskUpdate
- Update tasks to 'completed' immediately after finishing them using TaskUpdate
- Only have ONE task 'in_progress' at a time
- Add new tasks as you discover them during your work using TaskCreate
- Your first response should focus on creating a thorough task breakdown

Remember: Your first message is internal planning. Use this time to:
1. Thoroughly analyze the issue and requirements
2. Create detailed tasks using TaskCreate
3. Plan your approach systematically
</task_management_instructions>`;

/** The routing block emitted when all five bundled Cyrus skills are present. */
const FULL_ROUTING_BLOCK = `Choose the appropriate skill based on the context:

- **Code changes requested** (feature, bug fix, refactor): Use \`implementation\` to write code, then \`verify-and-ship\` to run checks and create a PR, then \`summarize\` to narrate results.
- **Bug report or error**: Use \`debug\` to reproduce, root-cause, and fix, then \`verify-and-ship\`, then \`summarize\`.
- **Question or research request**: Use \`investigate\` to search the codebase and provide an answer, then \`summarize\`.
- **PR review feedback** (changes requested): Use \`implementation\` to address review comments, then \`verify-and-ship\`.

Analyze the issue description, labels, and any user comments to determine which workflow fits. Do NOT skip the verify-and-ship step if you made code changes — it ensures quality checks pass and a PR is created.`;

async function plantHomeSkill(
	name: string,
	frontmatter: Record<string, string> = {},
): Promise<void> {
	const dir = join(HOME_SKILLS_DIR, name);
	await mkdir(dir, { recursive: true });
	const fields = Object.entries({
		name,
		description: `${name} test skill`,
		...frontmatter,
	})
		.map(([key, value]) => `${key}: ${value}`)
		.join("\n");
	await writeFile(join(dir, "SKILL.md"), `---\n${fields}\n---\n\nBody.\n`);
}

/** A minimal fallback-prompt scenario; only the system prompt is asserted. */
function promptScenario(systemPrompt: string) {
	return scenario(createTestWorker())
		.newSession()
		.assignmentBased()
		.withSession({
			issueId: "c3d4e5f6-a7b8-9012-cdef-123456789012",
			workspace: { path: "/test/repo" },
			metadata: {},
		})
		.withIssue({
			id: "c3d4e5f6-a7b8-9012-cdef-123456789012",
			identifier: "CEE-789",
			title: "Build new feature",
		})
		.withRepository({
			id: "repo-uuid-3456-7890-12cd-ef1234567890",
			path: "/test/repo",
		})
		.withUserComment("Add user authentication")
		.withLabels()
		.expectSystemPrompt(systemPrompt);
}

describe("Prompt Assembly - Home-Directory Skills", () => {
	afterEach(async () => {
		await rm(HOME_SKILLS_DIR, { recursive: true, force: true });
		delete process.env.CYRUS_DEFAULT_SKILLS;
	});

	it("offers a skill installed into $HOME/.claude/skills to the model", async () => {
		await plantHomeSkill("ask-matt");

		await promptScenario(`${TASK_MANAGEMENT_INSTRUCTIONS}

## Skills

You have skills available via the Skill tool: \`debug\`, \`implementation\`, \`investigate\`, \`summarize\`, \`verify-and-ship\`, \`ask-matt\`

${FULL_ROUTING_BLOCK}`).verify();
	});

	it("does not advertise a home skill that disables model invocation", async () => {
		await plantHomeSkill("slash-only", { "disable-model-invocation": "true" });

		await promptScenario(`${TASK_MANAGEMENT_INSTRUCTIONS}

## Skills

You have skills available via the Skill tool: \`debug\`, \`implementation\`, \`investigate\`, \`summarize\`, \`verify-and-ship\`

${FULL_ROUTING_BLOCK}`).verify();
	});

	it("keeps home skills but drops the bundled ones under CYRUS_DEFAULT_SKILLS=none", async () => {
		await plantHomeSkill("ask-matt");
		// Read by EdgeWorker's constructor, so it must be set before the worker
		// is built — which `promptScenario` does.
		process.env.CYRUS_DEFAULT_SKILLS = "none";

		await promptScenario(`${TASK_MANAGEMENT_INSTRUCTIONS}

## Skills

You have skills available via the Skill tool: \`ask-matt\``).verify();
	});

	it("keeps only the named bundled skills under a CYRUS_DEFAULT_SKILLS list", async () => {
		process.env.CYRUS_DEFAULT_SKILLS = "summarize,verify-and-ship";

		await promptScenario(`${TASK_MANAGEMENT_INSTRUCTIONS}

## Skills

You have skills available via the Skill tool: \`summarize\`, \`verify-and-ship\`

Use \`verify-and-ship\` whenever you have made code changes — it runs the quality checks and opens the pull request. Use \`summarize\` to produce the session's final message.`).verify();
	});
});
