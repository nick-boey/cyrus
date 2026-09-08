import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../..");
const skill = readFileSync(
	resolve(root, "skills/cyrus-fleet-operator/SKILL.md"),
	"utf8",
);
const references = ["connections", "runs", "logs", "recovery", "safety"].map(
	(name) =>
		readFileSync(
			resolve(root, `skills/cyrus-fleet-operator/references/${name}.md`),
			"utf8",
		),
);

describe("cyrus-fleet-operator skill structure", () => {
	it("has concise frontmatter and progressive disclosure", () => {
		expect(skill).toMatch(
			/^---\nname: cyrus-fleet-operator\ndescription: .+\n---/,
		);
		expect(skill.split("\n").length).toBeLessThan(30);
		for (const name of ["connections", "runs", "logs", "recovery", "safety"])
			expect(skill).toContain(`references/${name}.md`);
	});

	it("composes exact remote commands and every stop condition", () => {
		const all = [skill, ...references].join("\n");
		for (const command of [
			"cyrus connection show",
			"cyrus runs list",
			"cyrus runs watch",
			"cyrus runs wait",
			"cyrus logs query",
			"cyrus logs follow",
			"cyrus recover",
			"cyrus recover status",
		])
			expect(all).toContain(command);
		for (const stop of [
			"needs_input",
			"refusal",
			"stale",
			"unsupported capability",
			"break-glass",
		])
			expect(all.toLowerCase()).toContain(stop);
		expect(all).not.toContain("cyrus diagnose");
		expect(all).not.toMatch(/cyrus router (?:unlock|containers destroy)/);
		expect(all).not.toMatch(/dump .*raw logs/i);
		expect(all).toContain(
			"cyrus logs follow --run <id> --since <duration> --timeout <seconds>",
		);
	});
});
