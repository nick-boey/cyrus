import { describe, expect, it } from "vitest";
import {
	matchRepositories,
	type RoutableRepository,
} from "../../src/routing/matchRepositories.js";

function repo(
	id: string,
	overrides: Partial<RoutableRepository> = {},
): RoutableRepository {
	return {
		id,
		name: id,
		githubUrl: `https://github.com/acme/${id}`,
		...overrides,
	};
}

const API = repo("cyrus-api", { projectKeys: ["Platform"], teamKeys: ["NOR"] });
const WEB = repo("cyrus-web", { teamKeys: ["WEB"] });
const INFRA = repo("cyrus-infra", { isDefault: true });
const ALL = [API, WEB, INFRA];

describe("matchRepositories", () => {
	it("returns unmatched for an empty registry", () => {
		expect(matchRepositories({ teamKey: "NOR" }, [])).toEqual({
			kind: "unmatched",
		});
	});

	it("matches a description tag by repository name", () => {
		const result = matchRepositories({ description: "[repo=cyrus-web]" }, ALL);
		expect(result).toMatchObject({
			kind: "matched",
			method: "description-tag",
		});
		expect(result.kind === "matched" && result.repositories).toEqual([WEB]);
	});

	it("matches a description tag by hosting URL suffix without substring bleed", () => {
		const hosted = repo("cyrus", {
			githubUrl: "https://github.com/acme/cyrus",
		});
		const hostedLong = repo("cyrus-hosted", {
			githubUrl: "https://github.com/acme/cyrus-hosted",
		});
		const result = matchRepositories({ description: "[repo=cyrus]" }, [
			hostedLong,
			hosted,
		]);
		expect(result.kind === "matched" && result.repositories).toEqual([hosted]);
	});

	it("carries per-repository base branch overrides from a tag", () => {
		const result = matchRepositories(
			{ description: "repo=cyrus-api,cyrus-web#release" },
			ALL,
		);
		expect(result.kind === "matched" && result.baseBranchOverrides).toEqual(
			new Map([
				["cyrus-api", "release"],
				["cyrus-web", "release"],
			]),
		);
	});

	it("prefers a description tag over labels, project, and team", () => {
		const labelled = repo("cyrus-web", {
			teamKeys: ["WEB"],
			routingLabels: ["frontend"],
		});
		const result = matchRepositories(
			{
				description: "[repo=cyrus-api]",
				labels: ["frontend"],
				projectKeys: undefined,
				teamKey: "WEB",
			} as never,
			[API, labelled],
		);
		expect(result).toMatchObject({ method: "description-tag" });
	});

	it("falls through to labels when no tag matches any repository", () => {
		const labelled = repo("cyrus-web", { routingLabels: ["frontend"] });
		const result = matchRepositories(
			{ description: "[repo=nonexistent]", labels: ["frontend"] },
			[API, labelled],
		);
		expect(result).toMatchObject({ kind: "matched", method: "label-based" });
		expect(result.kind === "matched" && result.repositories).toEqual([
			labelled,
		]);
	});

	it("returns every repository whose routing labels match", () => {
		const a = repo("a", { routingLabels: ["shared"] });
		const b = repo("b", { routingLabels: ["shared"] });
		const result = matchRepositories({ labels: ["shared"] }, [a, b]);
		expect(result.kind === "matched" && result.repositories).toEqual([a, b]);
	});

	it("matches a project name case-insensitively", () => {
		const result = matchRepositories({ projectName: "pLaTfOrM" }, ALL);
		expect(result).toMatchObject({ kind: "matched", method: "project-based" });
		expect(result.kind === "matched" && result.repositories).toEqual([API]);
	});

	it("does not match a project name by substring", () => {
		const result = matchRepositories({ projectName: "Platform Migration" }, [
			API,
		]);
		expect(result).toEqual({ kind: "unmatched" });
	});

	it("matches a team key case-insensitively", () => {
		const result = matchRepositories({ teamKey: "web" }, ALL);
		expect(result).toMatchObject({ kind: "matched", method: "team-based" });
		expect(result.kind === "matched" && result.repositories).toEqual([WEB]);
	});

	it("prefers a project match over a team match on a different repository", () => {
		const result = matchRepositories(
			{ projectName: "Platform", teamKey: "WEB" },
			ALL,
		);
		expect(result).toMatchObject({ method: "project-based" });
		expect(result.kind === "matched" && result.repositories).toEqual([API]);
	});

	it("reports ambiguity when two repositories claim the same project", () => {
		const a = repo("a", { projectKeys: ["Platform"] });
		const b = repo("b", { projectKeys: ["platform"] });
		const result = matchRepositories({ projectName: "Platform" }, [a, b]);
		expect(result).toEqual({
			kind: "ambiguous",
			tier: "project",
			candidates: [a, b],
		});
	});

	it("reports ambiguity when two repositories claim the same team", () => {
		const a = repo("a", { teamKeys: ["NOR"] });
		const b = repo("b", { teamKeys: ["NOR"] });
		const result = matchRepositories({ teamKey: "NOR" }, [a, b]);
		expect(result).toEqual({
			kind: "ambiguous",
			tier: "team",
			candidates: [a, b],
		});
	});

	it("does not treat a cross-tier match as ambiguous", () => {
		const projectOnly = repo("a", { projectKeys: ["Platform"] });
		const teamOnly = repo("b", { teamKeys: ["NOR"] });
		const result = matchRepositories(
			{ projectName: "Platform", teamKey: "NOR" },
			[projectOnly, teamOnly],
		);
		expect(result).toMatchObject({ kind: "matched", method: "project-based" });
	});

	it("falls back to the default repository when nothing else matches", () => {
		const result = matchRepositories({ teamKey: "UNKNOWN" }, ALL);
		expect(result).toMatchObject({ kind: "matched", method: "default" });
		expect(result.kind === "matched" && result.repositories).toEqual([INFRA]);
	});

	it("reports ambiguity when two repositories are marked default", () => {
		const a = repo("a", { isDefault: true });
		const b = repo("b", { isDefault: true });
		const result = matchRepositories({}, [a, b]);
		expect(result).toEqual({
			kind: "ambiguous",
			tier: "default",
			candidates: [a, b],
		});
	});

	it("returns unmatched when nothing matches and no default is set", () => {
		expect(matchRepositories({ teamKey: "UNKNOWN" }, [API, WEB])).toEqual({
			kind: "unmatched",
		});
	});
});
