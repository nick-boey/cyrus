import { type ILogger, type IssueFacts, matchRepositories } from "cyrus-core";
import {
	type RegisteredRepository,
	type RepositoryRegistry,
	toRoutable,
} from "./RepositoryRegistry.js";

/** What the router decided, in a form `ContainerTargets` can persist and replay. */
export interface RepositoryDecision {
	repositories: RegisteredRepository[];
	/**
	 * A `RoutingMethod`, or `"user-selected"` / `"fallback-first"` /
	 * `"single-repository"` (the sole candidate in scope, with nothing to
	 * disambiguate — see `resolve`'s single-candidate shortcut).
	 */
	method: string;
	/** Repository name -> base branch. Empty when there are no overrides. */
	baseBranchOverrides: Record<string, string>;
}

export type ResolveOutcome =
	| { kind: "resolved"; decision: RepositoryDecision }
	| {
			kind: "needs_selection";
			candidates: RegisteredRepository[];
			reason: "ambiguous" | "unmatched";
	  }
	| { kind: "unavailable"; reason: string };

export interface RepositoryResolverDeps {
	registry: RepositoryRegistry;
	/** `LinearExecutor.fetchIssueFacts`. */
	fetchIssueFacts: (
		workspaceId: string,
		issueId: string,
	) => Promise<IssueFacts | undefined>;
	logger: ILogger;
}

/**
 * Decides which repositories an issue belongs to, on the router, before any
 * container exists.
 *
 * The router is the right place for this because it is the only party holding a
 * Linear token: it can read the issue's project — which a device cannot, since
 * `RouterIssueTrackerService` has no project data of its own — and because
 * deciding here means the sandbox receives only the repositories it needs and
 * clones one instead of all of them.
 */
export class RepositoryResolver {
	constructor(private readonly deps: RepositoryResolverDeps) {}

	async resolve(opts: {
		workspaceId: string;
		issueId: string | undefined;
	}): Promise<ResolveOutcome> {
		// The registry is a durable store the resolver depends on through the
		// `RepositoryRegistry` interface, not through one implementation: the
		// Table-backed production registry (`TableRepositoryRegistry.list()`)
		// throws on a transient 5xx, an auth failure, or exhausted retries, unlike
		// `fetchIssueFacts`, which is contractually guaranteed to resolve to
		// `undefined` rather than reject. Without this catch, a transient Table
		// hiccup would turn `resolve()` from a total function returning
		// `ResolveOutcome` into a rejected promise. `ResolveOutcome` already
		// models exactly this state, so the resolver — the layer that knows what
		// an unavailable registry means — reports it the same way as an empty
		// registry, just with a distinguishable reason.
		let repositories: RegisteredRepository[];
		try {
			({ repositories } = await this.deps.registry.list());
		} catch (error) {
			this.deps.logger.warn(
				`Could not read the repository registry for Linear workspace ${opts.workspaceId}: ${String(error)}`,
			);
			return {
				kind: "unavailable",
				reason: `The repository registry could not be read. Try again shortly, or check /setup/repositories.`,
			};
		}
		const scoped = repositories.filter(
			(repo) => repo.linearWorkspaceId === opts.workspaceId,
		);
		if (scoped.length === 0) {
			return {
				kind: "unavailable",
				reason: `No repositories are registered for Linear workspace ${opts.workspaceId}. Add one at /setup/repositories.`,
			};
		}

		// Facts are best-effort. A Linear failure here degrades to "route on the
		// registry alone", which still lands on the default repository — a far
		// better outcome than refusing to start work.
		let facts: IssueFacts = {};
		if (opts.issueId) {
			const fetched = await this.deps.fetchIssueFacts(
				opts.workspaceId,
				opts.issueId,
			);
			if (fetched) {
				facts = fetched;
			} else {
				this.deps.logger.warn(
					`No issue facts available for ${opts.issueId}; routing on the registry alone`,
				);
			}
		}

		const routable = scoped.map(toRoutable);
		const match = matchRepositories(facts, routable);

		if (match.kind === "matched") {
			const overrides: Record<string, string> = {};
			for (const [id, branch] of match.baseBranchOverrides ?? []) {
				overrides[id] = branch;
			}
			return {
				kind: "resolved",
				decision: {
					repositories: match.repositories.map((repo) => repo.source),
					method: match.method,
					baseBranchOverrides: overrides,
				},
			};
		}

		if (match.kind === "ambiguous") {
			return {
				kind: "needs_selection",
				candidates: match.candidates.map((repo) => repo.source),
				reason: "ambiguous",
			};
		}

		// `match.kind === "unmatched"`. A single repository in scope for this
		// workspace has nothing to disambiguate — asking "which repository?"
		// when there is only one possible answer would elicit on every new issue
		// for the (very common) single-repository deployment, contradicting the
		// design's rollout guarantee that a single registered repository behaves
		// identically to the pre-registry `containers.repositories` array
		// (design doc: "one repository in, one repository out, identical
		// behaviour"). Deliberately placed HERE, in the resolver, rather than as
		// a catch-all tier in `matchRepositories`: the global constraint forbids
		// widening that shared matcher, and doing it here also keeps the
		// guarantee holding when the registry is populated or pruned through the
		// setup UI without ever going through `containers.repositories` seeding.
		const only = scoped.length === 1 ? scoped[0] : undefined;
		if (only) {
			return {
				kind: "resolved",
				decision: {
					repositories: [only],
					method: "single-repository",
					baseBranchOverrides: {},
				},
			};
		}

		return { kind: "needs_selection", candidates: scoped, reason: "unmatched" };
	}

	/**
	 * Maps a user's answer back to the repository it named.
	 *
	 * Compared case-insensitively and whitespace-trimmed: Linear echoes the
	 * option value back verbatim, but a user may also type the name by hand,
	 * and a near-miss on case would otherwise be indistinguishable from someone
	 * ignoring the question entirely.
	 */
	selectByOptionValue(
		value: string,
		candidates: RegisteredRepository[],
	): RepositoryDecision | undefined {
		const folded = value.trim().toLowerCase();
		const chosen = candidates.find(
			(repo) => repo.name.toLowerCase() === folded,
		);
		if (!chosen) return undefined;
		return {
			repositories: [chosen],
			method: "user-selected",
			baseBranchOverrides: {},
		};
	}

	/**
	 * The decision to use when a posted elicitation was ignored — the user typed
	 * a real prompt instead of picking. Prefers the configured default; if there
	 * is none, the first registered repository, because at this point the
	 * question has already been asked once and asking again would strand the
	 * session.
	 */
	fallbackDecision(
		repositories: RegisteredRepository[],
	): RepositoryDecision | undefined {
		const preferred =
			repositories.find((repo) => repo.isDefault === true) ?? repositories[0];
		if (!preferred) return undefined;
		return {
			repositories: [preferred],
			method: preferred.isDefault === true ? "default" : "fallback-first",
			baseBranchOverrides: {},
		};
	}
}
