import { parseRepoTags } from "./repoTags.js";

/**
 * The minimum a repository must expose to be routed to. `RepositoryConfig`
 * satisfies this structurally; the router adapts its own registry entries onto
 * it. Deliberately narrower than `RepositoryConfig` so this module never
 * depends on the persistence schema.
 */
export interface RoutableRepository {
	id: string;
	name: string;
	githubUrl?: string;
	gitlabUrl?: string;
	teamKeys?: string[];
	routingLabels?: string[];
	projectKeys?: string[];
	isDefault?: boolean;
}

/** Everything about an issue that can influence routing. */
export interface IssueFacts {
	teamKey?: string;
	projectName?: string;
	labels?: string[];
	description?: string;
}

export type RoutingMethod =
	| "description-tag"
	| "label-based"
	| "project-based"
	| "team-based"
	| "default";

/** Tiers that can be ambiguous. Labels never are — every label match is used. */
export type AmbiguousTier = "project" | "team" | "default";

export type MatchResult<T extends RoutableRepository = RoutableRepository> =
	| {
			kind: "matched";
			repositories: T[];
			method: RoutingMethod;
			/** Repository id -> base branch, from `#branch` in a description tag. */
			baseBranchOverrides?: Map<string, string>;
	  }
	| { kind: "ambiguous"; candidates: T[]; tier: AmbiguousTier }
	| { kind: "unmatched" };

/** Case-insensitive whole-name membership. Never substring — see the spec. */
function includesFolded(
	haystack: readonly string[] | undefined,
	needle: string,
): boolean {
	if (!haystack) return false;
	const folded = needle.toLowerCase();
	return haystack.some((entry) => entry.toLowerCase() === folded);
}

/** Does a `[repo=x]` tag name this repository, by URL, name, or id? */
function tagMatches<T extends RoutableRepository>(
	repo: T,
	tag: string,
): boolean {
	// endsWith on the URL path segment, so "cyrus" cannot match "cyrus-hosted".
	if (
		repo.githubUrl?.endsWith(`/${tag}`) ||
		repo.githubUrl?.endsWith(`/${tag}.git`) ||
		repo.gitlabUrl?.endsWith(`/${tag}`) ||
		repo.gitlabUrl?.endsWith(`/${tag}.git`)
	) {
		return true;
	}
	if (repo.name.toLowerCase() === tag.toLowerCase()) return true;
	return repo.id === tag;
}

/**
 * Picks the repositories an issue belongs to, in priority order:
 *
 *   1. description tag   `[repo=…]`, explicit and always wins
 *   2. routing labels    every matching repository is returned
 *   3. project name      case-insensitive whole-name
 *   4. team key           case-insensitive whole-name
 *   5. isDefault         the configured fallback
 *
 * Two or more repositories matching within the SAME tier is `ambiguous` — the
 * caller decides whether to ask the user. Matches in DIFFERENT tiers are not
 * ambiguous: the higher tier wins outright.
 *
 * Pure: no I/O, no clock, no logging. Fact-gathering belongs to the caller.
 */
export function matchRepositories<T extends RoutableRepository>(
	facts: IssueFacts,
	repositories: readonly T[],
): MatchResult<T> {
	if (repositories.length === 0) return { kind: "unmatched" };

	// 1. Description tags.
	if (facts.description) {
		const tags = parseRepoTags(facts.description);
		const matched: T[] = [];
		const matchedIds = new Set<string>();
		const baseBranchOverrides = new Map<string, string>();
		for (const tag of tags) {
			for (const repo of repositories) {
				if (matchedIds.has(repo.id)) continue;
				if (!tagMatches(repo, tag.repo)) continue;
				matched.push(repo);
				matchedIds.add(repo.id);
				if (tag.branch) baseBranchOverrides.set(repo.id, tag.branch);
			}
		}
		if (matched.length > 0) {
			return {
				kind: "matched",
				repositories: matched,
				method: "description-tag",
				...(baseBranchOverrides.size > 0 ? { baseBranchOverrides } : {}),
			};
		}
	}

	// 2. Routing labels. Multiple matches are intentional, not ambiguous: a
	//    label deliberately fans an issue out across repositories.
	if (facts.labels && facts.labels.length > 0) {
		const matched = repositories.filter((repo) =>
			facts.labels?.some((label) => includesFolded(repo.routingLabels, label)),
		);
		if (matched.length > 0) {
			return { kind: "matched", repositories: matched, method: "label-based" };
		}
	}

	// 3. Project name.
	if (facts.projectName) {
		const matched = repositories.filter((repo) =>
			includesFolded(repo.projectKeys, facts.projectName as string),
		);
		if (matched.length === 1) {
			return {
				kind: "matched",
				repositories: matched,
				method: "project-based",
			};
		}
		if (matched.length > 1) {
			return { kind: "ambiguous", candidates: matched, tier: "project" };
		}
	}

	// 4. Team key.
	if (facts.teamKey) {
		const matched = repositories.filter((repo) =>
			includesFolded(repo.teamKeys, facts.teamKey as string),
		);
		if (matched.length === 1) {
			return { kind: "matched", repositories: matched, method: "team-based" };
		}
		if (matched.length > 1) {
			return { kind: "ambiguous", candidates: matched, tier: "team" };
		}
	}

	// 5. The configured default.
	const defaults = repositories.filter((repo) => repo.isDefault === true);
	if (defaults.length === 1) {
		return { kind: "matched", repositories: defaults, method: "default" };
	}
	if (defaults.length > 1) {
		return { kind: "ambiguous", candidates: defaults, tier: "default" };
	}

	return { kind: "unmatched" };
}
