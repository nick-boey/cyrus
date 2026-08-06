import { describe, expect, it, vi } from "vitest";
import type {
	RegisteredRepository,
	RepositoryRegistry,
} from "../src/RepositoryRegistry.js";
import { RepositoryResolver } from "../src/RepositoryResolver.js";

const API: RegisteredRepository = {
	name: "cyrus-api",
	githubSlug: "acme/cyrus-api",
	linearWorkspaceId: "ws-1",
	projectKeys: ["Platform"],
	teamKeys: ["NOR"],
};
const WEB: RegisteredRepository = {
	name: "cyrus-web",
	githubSlug: "acme/cyrus-web",
	linearWorkspaceId: "ws-1",
	teamKeys: ["WEB"],
};
const INFRA: RegisteredRepository = {
	name: "cyrus-infra",
	githubSlug: "acme/cyrus-infra",
	linearWorkspaceId: "ws-1",
	isDefault: true,
};

function resolver(
	repositories: RegisteredRepository[],
	facts: Record<string, unknown> | undefined,
) {
	const registry: RepositoryRegistry = {
		list: vi.fn(async () => ({ repositories })),
		put: vi.fn(async () => ({ version: "1" })),
	};
	return new RepositoryResolver({
		registry,
		fetchIssueFacts: vi.fn(async () => facts as never),
		logger: { info: vi.fn(), warn: vi.fn() },
	});
}

describe("RepositoryResolver.resolve", () => {
	it("resolves a team match to a single repository", async () => {
		const outcome = await resolver([API, WEB, INFRA], {
			teamKey: "WEB",
		}).resolve({
			workspaceId: "ws-1",
			issueId: "issue-1",
		});
		expect(outcome).toEqual({
			kind: "resolved",
			decision: {
				repositories: [WEB],
				method: "team-based",
				baseBranchOverrides: {},
			},
		});
	});

	it("prefers a project match over a team match", async () => {
		const outcome = await resolver([API, WEB, INFRA], {
			projectName: "Platform",
			teamKey: "WEB",
		}).resolve({ workspaceId: "ws-1", issueId: "issue-1" });
		expect(outcome).toMatchObject({
			kind: "resolved",
			decision: { method: "project-based" },
		});
	});

	it("carries base-branch overrides from a description tag", async () => {
		const outcome = await resolver([API, WEB], {
			description: "repo=cyrus-api,cyrus-web#release",
		}).resolve({ workspaceId: "ws-1", issueId: "issue-1" });
		expect(outcome).toMatchObject({
			kind: "resolved",
			decision: {
				method: "description-tag",
				baseBranchOverrides: {
					"cyrus-api": "release",
					"cyrus-web": "release",
				},
			},
		});
	});

	it("falls back to the default repository when nothing matches", async () => {
		const outcome = await resolver([API, WEB, INFRA], {
			teamKey: "UNKNOWN",
		}).resolve({ workspaceId: "ws-1", issueId: "issue-1" });
		expect(outcome).toMatchObject({
			kind: "resolved",
			decision: { repositories: [INFRA], method: "default" },
		});
	});

	it("asks for a selection when two repositories tie on a team", async () => {
		const a = { ...API, name: "a", teamKeys: ["NOR"] };
		const b = { ...WEB, name: "b", teamKeys: ["NOR"] };
		const outcome = await resolver([a, b], { teamKey: "NOR" }).resolve({
			workspaceId: "ws-1",
			issueId: "issue-1",
		});
		expect(outcome).toEqual({
			kind: "needs_selection",
			candidates: [a, b],
			reason: "ambiguous",
		});
	});

	it("asks over every repository when nothing matches and no default is set", async () => {
		const outcome = await resolver([API, WEB], { teamKey: "UNKNOWN" }).resolve({
			workspaceId: "ws-1",
			issueId: "issue-1",
		});
		expect(outcome).toEqual({
			kind: "needs_selection",
			candidates: [API, WEB],
			reason: "unmatched",
		});
	});

	/**
	 * Regression for a Critical review finding: a single-repository deployment
	 * (the common case) must never be asked to disambiguate, even when nothing
	 * about the issue matches the repository's own criteria and it carries no
	 * `isDefault`. The design doc's rollout guarantee is that one repository in
	 * the registry behaves identically to the pre-registry
	 * `containers.repositories` array — "one repository in, one repository
	 * out, identical behaviour" — which `needs_selection` with a single
	 * candidate would silently violate on every new issue.
	 */
	it("resolves the sole registered repository outright, without asking, when nothing matches", async () => {
		const lonely: RegisteredRepository = {
			name: "cyrus",
			githubSlug: "acme/cyrus",
			linearWorkspaceId: "ws-1",
			// Deliberately no isDefault/teamKeys/projectKeys/routingLabels: this
			// repository cannot win any tier of matchRepositories on its own
			// criteria, so it is `matchRepositories`'s "unmatched" case that this
			// test targets.
		};
		const outcome = await resolver([lonely], { teamKey: "UNRELATED" }).resolve({
			workspaceId: "ws-1",
			issueId: "issue-1",
		});
		expect(outcome).toEqual({
			kind: "resolved",
			decision: {
				repositories: [lonely],
				method: "single-repository",
				baseBranchOverrides: {},
			},
		});
	});

	it("resolves the shortcut off the workspace-scoped candidate count, not the whole registry", async () => {
		// Guards against the shortcut accidentally keying off `repositories.length`
		// (the full registry, 2 here) instead of `scoped.length` (this
		// workspace's slice, 1 here) — a registry with repositories from other
		// workspaces must not disable the single-candidate shortcut for this one.
		const lonely: RegisteredRepository = {
			name: "cyrus",
			githubSlug: "acme/cyrus",
			linearWorkspaceId: "ws-1",
		};
		const otherWorkspace: RegisteredRepository = {
			name: "cyrus-other",
			githubSlug: "acme/cyrus-other",
			linearWorkspaceId: "ws-2",
		};
		const outcome = await resolver([lonely, otherWorkspace], {
			teamKey: "UNRELATED",
		}).resolve({ workspaceId: "ws-1", issueId: "issue-1" });
		expect(outcome).toEqual({
			kind: "resolved",
			decision: {
				repositories: [lonely],
				method: "single-repository",
				baseBranchOverrides: {},
			},
		});
	});

	it("reports unavailable when the registry is empty", async () => {
		const outcome = await resolver([], { teamKey: "NOR" }).resolve({
			workspaceId: "ws-1",
			issueId: "issue-1",
		});
		expect(outcome).toMatchObject({ kind: "unavailable" });
		expect(outcome.kind === "unavailable" && outcome.reason).toContain(
			"No repositories are registered",
		);
	});

	it("reports unavailable, distinctly from an empty registry, when the registry rejects", async () => {
		const warn = vi.fn();
		const registry: RepositoryRegistry = {
			list: vi.fn(async () => {
				throw new Error("Azure Table request failed: 503");
			}),
			put: vi.fn(async () => ({ version: "1" })),
		};
		const instance = new RepositoryResolver({
			registry,
			fetchIssueFacts: vi.fn(async () => undefined),
			logger: { info: vi.fn(), warn },
		});

		const outcome = await instance.resolve({
			workspaceId: "ws-1",
			issueId: "issue-1",
		});

		expect(outcome).toMatchObject({ kind: "unavailable" });
		expect(outcome.kind === "unavailable" && outcome.reason).not.toContain(
			"No repositories are registered",
		);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("Azure Table request failed: 503"),
		);
	});

	it("routes on the registry alone when the issue has no id", async () => {
		const outcome = await resolver([API, INFRA], undefined).resolve({
			workspaceId: "ws-1",
			issueId: undefined,
		});
		expect(outcome).toMatchObject({
			kind: "resolved",
			decision: { repositories: [INFRA], method: "default" },
		});
	});

	it("still routes on the default when facts could not be fetched", async () => {
		const outcome = await resolver([API, INFRA], undefined).resolve({
			workspaceId: "ws-1",
			issueId: "issue-1",
		});
		expect(outcome).toMatchObject({
			kind: "resolved",
			decision: { method: "default" },
		});
	});

	it("only considers repositories belonging to the event's workspace", async () => {
		const otherWorkspace = { ...WEB, name: "other", linearWorkspaceId: "ws-2" };
		const outcome = await resolver([otherWorkspace, INFRA], {
			teamKey: "WEB",
		}).resolve({ workspaceId: "ws-1", issueId: "issue-1" });
		expect(outcome).toMatchObject({
			kind: "resolved",
			decision: { repositories: [INFRA] },
		});
	});
});

describe("RepositoryResolver.selectByOptionValue", () => {
	it("matches an offered option back to its repository", () => {
		const decision = resolver([], undefined).selectByOptionValue("cyrus-web", [
			API,
			WEB,
		]);
		expect(decision).toEqual({
			repositories: [WEB],
			method: "user-selected",
			baseBranchOverrides: {},
		});
	});

	it("returns undefined for a value that was never offered", () => {
		expect(
			resolver([], undefined).selectByOptionValue("do the thing", [API, WEB]),
		).toBeUndefined();
	});

	it("ignores surrounding whitespace and case", () => {
		expect(
			resolver([], undefined).selectByOptionValue("  CYRUS-WEB ", [API, WEB]),
		).toMatchObject({ repositories: [WEB] });
	});
});

describe("RepositoryResolver.fallbackDecision", () => {
	it("prefers the default repository", () => {
		expect(resolver([], undefined).fallbackDecision([API, WEB, INFRA])).toEqual(
			{
				repositories: [INFRA],
				method: "default",
				baseBranchOverrides: {},
			},
		);
	});

	it("uses the first registered repository when none is marked default", () => {
		expect(resolver([], undefined).fallbackDecision([API, WEB])).toMatchObject({
			repositories: [API],
			method: "fallback-first",
		});
	});

	it("returns undefined when there is nothing to fall back to", () => {
		expect(resolver([], undefined).fallbackDecision([])).toBeUndefined();
	});
});
