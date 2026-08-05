import {
	AgentActivitySignal,
	type AgentSessionCreatedWebhook,
	type AgentSessionPromptedWebhook,
	type RoutingMethod as CoreRoutingMethod,
	createLogger,
	type IIssueTrackerService,
	type ILogger,
	type IssueFacts,
	matchRepositories,
	parseRepoTags,
	type RepositoryConfig,
	type Webhook,
} from "cyrus-core";

/**
 * Repository routing result types
 */
export type RepositoryRoutingResult =
	| {
			type: "selected";
			repositories: RepositoryConfig[];
			/** Per-repo base branch overrides from [repo=name#branch] syntax */
			baseBranchOverrides?: Map<string, string>;
			routingMethod:
				| CoreRoutingMethod
				| "team-prefix"
				| "catch-all"
				| "workspace-fallback";
	  }
	| { type: "needs_selection"; workspaceRepos: RepositoryConfig[] }
	| { type: "none" };

/**
 * Pending repository selection data
 */
export interface PendingRepositorySelection {
	issueId: string;
	workspaceRepos: RepositoryConfig[];
}

/**
 * Repository router dependencies
 */
export interface RepositoryRouterDeps {
	/** Fetch issue labels for label-based routing */
	fetchIssueLabels: (issueId: string, workspaceId: string) => Promise<string[]>;

	/** Fetch issue description for description-tag routing */
	fetchIssueDescription: (
		issueId: string,
		workspaceId: string,
	) => Promise<string | undefined>;

	/** Check if an issue has active sessions in a repository */
	hasActiveSession: (issueId: string, repositoryId: string) => boolean;

	/** Get issue tracker service for a workspace */
	getIssueTracker: (workspaceId: string) => IIssueTrackerService | undefined;

	/**
	 * Called once a repository-selection elicitation has been posted and the
	 * session is genuinely waiting on the user.
	 *
	 * In router mode this releases the session's device so the container can be
	 * idle-suspended while it waits. There is no runner at this point — the
	 * session has not been initialised yet — so unlike the AskUserQuestion path
	 * there is no pending work to check first.
	 */
	onSessionParked?: (agentSessionId: string) => void;

	/** Called when a parked selection is answered, so the park can be undone. */
	onSessionUnparked?: (agentSessionId: string) => void;
}

/**
 * RepositoryRouter handles all repository routing logic including:
 * - Multi-priority routing (labels, projects, teams)
 * - Issue-to-repository caching
 * - Repository selection UI via Linear elicitation
 * - Selection response handling
 *
 * This class was extracted from EdgeWorker to improve modularity and testability.
 */
export class RepositoryRouter {
	/** Cache mapping issue IDs to selected repository IDs (array for multi-repo) */
	private issueRepositoryCache = new Map<string, string[]>();

	/** Pending repository selections awaiting user response */
	private pendingSelections = new Map<string, PendingRepositorySelection>();

	private logger: ILogger;

	constructor(
		private deps: RepositoryRouterDeps,
		logger?: ILogger,
	) {
		this.logger = logger ?? createLogger({ component: "RepositoryRouter" });
	}

	/**
	 * Get cached repositories for an issue
	 *
	 * This is a simple cache lookup used by agentSessionPrompted webhooks (Branch 3).
	 * Per CLAUDE.md: "The repository will be retrieved from the issue-to-repository
	 * cache - no new routing logic is performed."
	 *
	 * @param issueId The Linear issue ID
	 * @param repositoriesMap Map of repository IDs to configurations
	 * @returns The cached repositories array, or null if not found
	 */
	getCachedRepositories(
		issueId: string,
		repositoriesMap: Map<string, RepositoryConfig>,
	): RepositoryConfig[] | null {
		const cachedRepositoryIds = this.issueRepositoryCache.get(issueId);
		if (!cachedRepositoryIds || cachedRepositoryIds.length === 0) {
			this.logger.debug(`No cached repository found for issue ${issueId}`);
			return null;
		}

		const resolvedRepos: RepositoryConfig[] = [];
		const invalidIds: string[] = [];

		for (const repoId of cachedRepositoryIds) {
			const repo = repositoriesMap.get(repoId);
			if (repo) {
				resolvedRepos.push(repo);
			} else {
				invalidIds.push(repoId);
			}
		}

		if (invalidIds.length > 0) {
			this.logger.warn(
				`Cached repositories [${invalidIds.join(", ")}] no longer exist, cleaning cache`,
			);
			if (resolvedRepos.length === 0) {
				this.issueRepositoryCache.delete(issueId);
				return null;
			}
			// Update cache to only contain valid IDs
			this.issueRepositoryCache.set(
				issueId,
				resolvedRepos.map((r) => r.id),
			);
		}

		this.logger.debug(
			`Using cached repositories [${resolvedRepos.map((r) => r.name).join(", ")}] for issue ${issueId}`,
		);
		return resolvedRepos;
	}

	/**
	 * Determine repositories for webhook using multi-priority routing:
	 * Priority 0: Existing active sessions
	 * Priority 1: Description tag (explicit [repo=...] in issue description)
	 * Priority 2: Routing labels
	 * Priority 3: Project-based routing
	 * Priority 4: Team-based routing
	 * Priority 5: The configured isDefault repository
	 * Priority 6: Deprecated implicit catch-all / team-prefix fallbacks
	 *
	 * Priorities 1-5 are delegated to the shared `matchRepositories` matcher in
	 * `cyrus-core` so the router and edge worker can never disagree about which
	 * repository an issue belongs to. Description-tag and label-based routing,
	 * when matched, skip lower-priority routing. If no routing matches, returns
	 * needs_selection (no default assignment).
	 */
	async determineRepositoryForWebhook(
		webhook: AgentSessionCreatedWebhook | AgentSessionPromptedWebhook,
		repos: RepositoryConfig[],
	): Promise<RepositoryRoutingResult> {
		const workspaceId = webhook.organizationId;
		if (!workspaceId) {
			return repos[0]
				? {
						type: "selected",
						repositories: [repos[0]],
						routingMethod: "workspace-fallback",
					}
				: { type: "none" };
		}

		// Extract issue information
		const { issueId, teamKey, issueIdentifier } =
			this.extractIssueInfo(webhook);

		// Priority 0: Check for existing active sessions
		// TODO: Remove this priority check - existing session detection should not be a routing method
		if (issueId) {
			const activeRepos: RepositoryConfig[] = [];
			for (const repo of repos) {
				if (this.deps.hasActiveSession(issueId, repo.id)) {
					activeRepos.push(repo);
				}
			}
			if (activeRepos.length > 0) {
				this.logger.info(
					`Repositories selected: [${activeRepos.map((r) => r.name).join(", ")}] (existing active session)`,
				);
				return {
					type: "selected",
					repositories: activeRepos,
					routingMethod: "workspace-fallback",
				};
			}
		}

		// Filter repos by workspace
		const workspaceRepos = repos.filter(
			(repo) => repo.linearWorkspaceId === workspaceId,
		);
		if (workspaceRepos.length === 0) return { type: "none" };

		const facts = await this.gatherFacts(issueId, workspaceId, teamKey);
		const match = matchRepositories(facts, workspaceRepos);

		if (match.kind === "matched") {
			this.logger.info(
				`Repositories selected: [${match.repositories.map((r) => r.name).join(", ")}] (${match.method} routing)`,
			);
			if (match.baseBranchOverrides && match.baseBranchOverrides.size > 0) {
				const overrideEntries = Array.from(match.baseBranchOverrides.entries())
					.map(([id, branch]) => `${id}→${branch}`)
					.join(", ");
				this.logger.info(
					`Base branch overrides from description tags: ${overrideEntries}`,
				);
			}
			return {
				type: "selected",
				repositories: match.repositories,
				...(match.baseBranchOverrides && match.baseBranchOverrides.size > 0
					? { baseBranchOverrides: match.baseBranchOverrides }
					: {}),
				routingMethod: match.method,
			};
		}

		if (match.kind === "ambiguous") {
			this.logger.info(
				`Ambiguous ${match.tier} routing across [${match.candidates
					.map((r) => r.name)
					.join(", ")}] - requesting user selection`,
			);
			return { type: "needs_selection", workspaceRepos: match.candidates };
		}

		// Try parsing issue identifier as fallback for team routing
		// TODO: Remove team prefix routing - should rely on explicit team-based routing only
		if (issueIdentifier?.includes("-")) {
			const prefix = issueIdentifier.split("-")[0];
			if (prefix) {
				const repo = workspaceRepos.find((r) => r.teamKeys?.includes(prefix));
				if (repo) {
					this.logger.info(
						`Repository selected: ${repo.name} (team prefix routing)`,
					);
					return {
						type: "selected",
						repositories: [repo],
						routingMethod: "team-prefix",
					};
				}
			}
		}

		// Deprecated implicit catch-all, kept so an existing self-hosted
		// config.json that predates `isDefault` keeps working. Sits BELOW the
		// matcher's `default` tier AND below team-prefix routing (this ordering
		// is pre-refactor behaviour, not a design choice made here): an explicit
		// isDefault or a team-prefix match always wins over an unconfigured repo.
		// TODO(CYPACK): remove once self-hosted configs have migrated to isDefault.
		const catchAllRepo = workspaceRepos.find(
			(repo) =>
				(!repo.teamKeys || repo.teamKeys.length === 0) &&
				(!repo.routingLabels || repo.routingLabels.length === 0) &&
				(!repo.projectKeys || repo.projectKeys.length === 0),
		);
		if (catchAllRepo) {
			this.logger.info(
				`Repository selected: ${catchAllRepo.name} (workspace catch-all)`,
			);
			return {
				type: "selected",
				repositories: [catchAllRepo],
				routingMethod: "catch-all",
			};
		}

		this.logger.info(
			`No routing match for ${workspaceRepos.length} workspace repositories - requesting user selection`,
		);
		return { type: "needs_selection", workspaceRepos };
	}

	/**
	 * Collects everything the matcher needs, tolerating a failure in any single
	 * lookup. A failed description fetch must not suppress label routing (and
	 * vice versa), which is why the three sources are fetched concurrently via
	 * `Promise.allSettled` rather than sequential awaits: each source is still
	 * isolated from the others' failures, but the three round-trips overlap
	 * instead of stacking their latency.
	 */
	private async gatherFacts(
		issueId: string | undefined,
		workspaceId: string,
		teamKey: string | undefined,
	): Promise<IssueFacts> {
		const facts: IssueFacts = {};
		if (teamKey) facts.teamKey = teamKey;
		if (!issueId) return facts;

		const [descriptionResult, labelsResult, projectResult] =
			await Promise.allSettled([
				this.deps.fetchIssueDescription(issueId, workspaceId),
				this.deps.fetchIssueLabels(issueId, workspaceId),
				this.fetchProjectName(issueId, workspaceId),
			]);

		if (descriptionResult.status === "fulfilled") {
			if (descriptionResult.value) facts.description = descriptionResult.value;
		} else {
			this.logger.error(
				`Failed to fetch description for routing:`,
				descriptionResult.reason,
			);
		}

		if (labelsResult.status === "fulfilled") {
			facts.labels = labelsResult.value;
		} else {
			this.logger.error(
				`Failed to fetch labels for routing:`,
				labelsResult.reason,
			);
		}

		if (projectResult.status === "fulfilled") {
			if (projectResult.value) facts.projectName = projectResult.value;
		} else {
			this.logger.debug(
				`Failed to fetch project for issue ${issueId}:`,
				projectResult.reason,
			);
		}

		return facts;
	}

	/** Isolated so a missing issue tracker only affects the project fact. */
	private async fetchProjectName(
		issueId: string,
		workspaceId: string,
	): Promise<string | undefined> {
		const issueTracker = this.deps.getIssueTracker(workspaceId);
		if (!issueTracker) {
			this.logger.warn(`No issue tracker found for workspace ${workspaceId}`);
			return undefined;
		}
		const fullIssue = await issueTracker.fetchIssue(issueId);
		const project = await fullIssue?.project;
		return project?.name;
	}

	/**
	 * @deprecated Use `parseRepoTags` from `cyrus-core`. Retained as a thin
	 * delegate because it is public API with an extensive test suite.
	 */
	parseRepoTagsFromDescription(
		description: string,
	): { repo: string; branch?: string }[] {
		return parseRepoTags(description);
	}

	/**
	 * Elicit user repository selection - post elicitation to Linear
	 */
	async elicitUserRepositorySelection(
		webhook: AgentSessionCreatedWebhook,
		workspaceRepos: RepositoryConfig[],
	): Promise<void> {
		const { agentSession } = webhook;
		const agentSessionId = agentSession.id;
		const { issue } = agentSession;

		if (!issue) {
			this.logger.error("Cannot elicit repository selection without issue");
			return;
		}

		this.logger.info(
			`Posting repository selection elicitation for issue ${issue.identifier}`,
		);

		// Store pending selection
		this.pendingSelections.set(agentSessionId, {
			issueId: issue.id,
			workspaceRepos,
		});

		// Validate we have repositories to offer
		const firstRepo = workspaceRepos[0];
		if (!firstRepo) {
			this.logger.error("No repositories available for selection elicitation");
			return;
		}

		// Get issue tracker for the workspace
		const issueTracker = this.deps.getIssueTracker(webhook.organizationId);
		if (!issueTracker) {
			this.logger.error(
				`No issue tracker found for workspace ${webhook.organizationId}`,
			);
			return;
		}

		// Create repository options
		const options = workspaceRepos.map((repo) => ({
			value: repo.githubUrl || repo.gitlabUrl || repo.name,
		}));

		// Post elicitation activity
		try {
			await issueTracker.createAgentActivity({
				agentSessionId,
				content: {
					type: "elicitation",
					body: "Which repository should I work in for this issue?",
				},
				signal: AgentActivitySignal.Select,
				signalMetadata: { options },
			});

			this.logger.info(
				`Posted repository selection elicitation with ${options.length} options`,
			);

			// Only after a successful post: parking on a failed post would release
			// the device with nothing for the user to answer, so nothing would ever
			// wake the session.
			this.deps.onSessionParked?.(agentSessionId);
		} catch (error) {
			this.logger.error(
				`Failed to post repository selection elicitation:`,
				error,
			);

			await this.postRepositorySelectionError(
				agentSessionId,
				issueTracker,
				error,
			);

			this.pendingSelections.delete(agentSessionId);
		}
	}

	/**
	 * Post error activity when repository selection fails
	 */
	private async postRepositorySelectionError(
		agentSessionId: string,
		issueTracker: IIssueTrackerService,
		error: unknown,
	): Promise<void> {
		const errorObj = error as Error;
		const errorMessage = errorObj?.message || String(error);

		try {
			await issueTracker.createAgentActivity({
				agentSessionId,
				content: {
					type: "error",
					body: `Failed to display repository selection: ${errorMessage}`,
				},
			});
			this.logger.info(
				`Posted error activity for repository selection failure`,
			);
		} catch (postError) {
			this.logger.error(
				`Failed to post error activity (may be due to same underlying issue):`,
				postError,
			);
		}
	}

	/**
	 * Select repository from user response
	 * Returns the selected repository or null if webhook should not be processed further
	 */
	async selectRepositoryFromResponse(
		agentSessionId: string,
		selectedRepositoryName: string,
	): Promise<RepositoryConfig | null> {
		const pendingData = this.pendingSelections.get(agentSessionId);
		if (!pendingData) {
			this.logger.debug(
				`No pending repository selection found for agent session ${agentSessionId}`,
			);
			return null;
		}

		// Remove from pending map
		this.pendingSelections.delete(agentSessionId);
		// The session is no longer waiting on the user, so drop any still-unacked
		// `parked` frame before the turn it is about to start posts anything.
		this.deps.onSessionUnparked?.(agentSessionId);

		// Find selected repository by GitHub/GitLab URL or name
		const selectedRepo = pendingData.workspaceRepos.find(
			(repo) =>
				repo.githubUrl === selectedRepositoryName ||
				repo.gitlabUrl === selectedRepositoryName ||
				repo.name === selectedRepositoryName,
		);

		// Fallback to first repository if not found
		const repository = selectedRepo || pendingData.workspaceRepos[0];
		if (!repository) {
			this.logger.error(
				`No repository found for selection: ${selectedRepositoryName}`,
			);
			return null;
		}

		if (!selectedRepo) {
			this.logger.info(
				`Repository "${selectedRepositoryName}" not found, falling back to ${repository.name}`,
			);
		} else {
			this.logger.info(`User selected repository: ${repository.name}`);
		}

		return repository;
	}

	/**
	 * Check if there's a pending repository selection for this agent session
	 */
	hasPendingSelection(agentSessionId: string): boolean {
		return this.pendingSelections.has(agentSessionId);
	}

	/**
	 * Extract issue information from webhook
	 */
	private extractIssueInfo(webhook: Webhook): {
		issueId?: string;
		teamKey?: string;
		issueIdentifier?: string;
	} {
		// Handle agent session webhooks
		if (
			this.isAgentSessionCreatedWebhook(webhook) ||
			this.isAgentSessionPromptedWebhook(webhook)
		) {
			return {
				issueId: webhook.agentSession?.issue?.id,
				teamKey: webhook.agentSession?.issue?.team?.key,
				issueIdentifier: webhook.agentSession?.issue?.identifier,
			};
		}

		// Handle entity webhooks (e.g., Issue updates)
		if (this.isEntityWebhook(webhook)) {
			// For Issue entity webhooks, data contains the issue payload
			if (webhook.type === "Issue") {
				const issueData = webhook.data as {
					id?: string;
					identifier?: string;
					team?: { key?: string };
				};
				return {
					issueId: issueData?.id,
					teamKey: issueData?.team?.key,
					issueIdentifier: issueData?.identifier,
				};
			}
			// Other entity types don't have issue info
			return {};
		}

		// Handle notification webhooks (AppUserNotification)
		if ("notification" in webhook && webhook.notification) {
			return {
				issueId: webhook.notification?.issue?.id,
				teamKey: webhook.notification?.issue?.team?.key,
				issueIdentifier: webhook.notification?.issue?.identifier,
			};
		}

		return {};
	}

	/**
	 * Type guard for entity webhooks (Issue, Comment, etc.)
	 */
	private isEntityWebhook(
		webhook: Webhook,
	): webhook is Webhook & { data: unknown } {
		return "data" in webhook && webhook.data !== undefined;
	}

	/**
	 * Type guards
	 */
	private isAgentSessionCreatedWebhook(
		webhook: Webhook,
	): webhook is AgentSessionCreatedWebhook {
		return webhook.action === "created";
	}

	private isAgentSessionPromptedWebhook(
		webhook: Webhook,
	): webhook is AgentSessionPromptedWebhook {
		return webhook.action === "prompted";
	}

	/**
	 * Get issue repository cache for serialization
	 */
	getIssueRepositoryCache(): Map<string, string[]> {
		return this.issueRepositoryCache;
	}

	/**
	 * Restore issue repository cache from serialization.
	 * Handles migration from old format (Map<string, string>) by wrapping values in arrays.
	 */
	restoreIssueRepositoryCache(cache: Map<string, string | string[]>): void {
		this.issueRepositoryCache = new Map();
		for (const [issueId, value] of cache.entries()) {
			if (Array.isArray(value)) {
				this.issueRepositoryCache.set(issueId, value);
			} else {
				// Migration: wrap old single-string format in array
				this.issueRepositoryCache.set(issueId, [value]);
			}
		}
	}
}
