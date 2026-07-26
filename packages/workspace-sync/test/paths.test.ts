import { describe, expect, it } from "vitest";
import { sanitizeCwdForClaudeProjects, toHttpBase } from "../src/paths.js";

describe("toHttpBase", () => {
	it.each([
		["ws://localhost:3456", "http://localhost:3456"],
		["wss://router.example.com/", "https://router.example.com"],
		["https://router.example.com", "https://router.example.com"],
	])("%s -> %s", (input, expected) => {
		expect(toHttpBase(input)).toBe(expected);
	});
});

describe("sanitizeCwdForClaudeProjects", () => {
	it("matches the Claude SDK project-dir munging", () => {
		expect(sanitizeCwdForClaudeProjects("/workspaces/CYPACK-123")).toBe(
			"-workspaces-CYPACK-123",
		);
	});
});
