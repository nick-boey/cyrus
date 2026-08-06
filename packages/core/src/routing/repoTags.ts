/**
 * `[repo=…]` description-tag parsing. Moved out of `RepositoryRouter` so the
 * router and the edge worker share one implementation; the behaviour is
 * unchanged and is pinned by the existing `RepositoryRouter` test suite.
 */

/** One parsed tag: a repository reference and an optional base-branch override. */
export interface RepoTag {
	repo: string;
	branch?: string;
}

/**
 * A repo value may name several repositories and end in `#branch`. The branch
 * applies to every repository in the comma-separated list.
 */
function parseRepoValue(value: string): RepoTag[] {
	const hashIndex = value.indexOf("#");
	let reposPart: string;
	let branch: string | undefined;

	if (hashIndex !== -1) {
		reposPart = value.slice(0, hashIndex);
		branch = value.slice(hashIndex + 1);
		if (!branch) branch = undefined;
	} else {
		reposPart = value;
	}

	return reposPart
		.split(",")
		.map((repo) => repo.trim())
		.filter((repo) => repo.length > 0)
		.map((repo) => (branch ? { repo, branch } : { repo }));
}

/**
 * Supported syntaxes:
 * - `[repo=name]` / `[repo=name#branch]` — bracketed, one repository per tag
 * - `repo=name,name2#branch` — unbracketed, comma-separated
 * - `repos=name,name2#branch` — the same with a plural key
 *
 * Escaped brackets (`\[repo=…\]`), which Linear sometimes produces, are handled.
 * Duplicates are removed, keeping the first occurrence.
 */
export function parseRepoTags(description: string): RepoTag[] {
	const tags: RepoTag[] = [];

	// Pattern 1: bracketed [repo=...]
	const bracketRegex = /\\?\[repo=([a-zA-Z0-9_\-/.#]+)\\?\]/g;
	for (const match of description.matchAll(bracketRegex)) {
		if (match[1]) tags.push(...parseRepoValue(match[1]));
	}

	// Pattern 2: unbracketed repos?=... — anchored to a line start or whitespace
	// so it cannot fire inside a URL or a filesystem path.
	const unbracketedRegex = /(?:^|[\s\n])repos?=([a-zA-Z0-9_\-/.#,]+)/gm;
	for (const match of description.matchAll(unbracketedRegex)) {
		if (match[1]) tags.push(...parseRepoValue(match[1]));
	}

	const seen = new Set<string>();
	return tags.filter((tag) => {
		if (seen.has(tag.repo)) return false;
		seen.add(tag.repo);
		return true;
	});
}
