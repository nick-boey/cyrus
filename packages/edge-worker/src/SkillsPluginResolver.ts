import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SdkPluginConfig } from "cyrus-claude-runner";
import type { ILogger } from "cyrus-core";

/**
 * Session context used to evaluate per-skill scope restrictions. Each dimension
 * is optional — when omitted, scopes that depend on that dimension cannot match
 * (e.g. a session with no `linearTeamId` will not see skills scoped to a team).
 */
export interface SkillSessionContext {
	repositoryId?: string;
	linearTeamId?: string;
	linearLabelIds?: string[];
	/**
	 * Working-tree paths of the repositories participating in this session.
	 * Each repo's `<repoPath>/.claude/skills/*` directory names are unioned into
	 * the resolved skill whitelist so a repo can ship its own skills. Carries one
	 * path for single-repo / GitHub-mention sessions and every participating
	 * worktree for multi-repo sessions.
	 */
	repoPaths?: string[];
}

/**
 * Scope persisted alongside a user skill as `scope.json`. Mirrors the optional
 * fields on `UpdateSkillPayload` in `cyrus-config-updater`.
 */
interface SkillScope {
	repositoryIds?: string[];
	linearTeamIds?: string[];
	linearLabelIds?: string[];
}

/** Optional collaborators/knobs. Both default to the production behaviour. */
export interface SkillsPluginResolverOptions {
	/**
	 * Raw `CYRUS_DEFAULT_SKILLS` value — a per-user switch over the *bundled
	 * Cyrus* skills only (the internal `cyrus-skills` plugin). User skills,
	 * repo-local skills and `~/.claude/skills` are never affected.
	 *
	 * - unset / `"all"` — every bundled skill (default)
	 * - `"none"` — the internal plugin contributes nothing
	 * - comma-separated list — only the named bundled skills, e.g.
	 *   `"summarize,verify-and-ship"`
	 *
	 * Injected rather than read from `process.env` here so it is testable and
	 * consistent with how `cyrusHome`/`logger` arrive. Deliberately NOT added
	 * to `RESERVED_ENV_KEYS` in `cyrus-router` — users must be able to set it.
	 */
	defaultSkills?: string;
	/**
	 * `$HOME`, whose `.claude/skills` directory is unioned into discovery.
	 * Defaults to `os.homedir()`.
	 *
	 * This is NOT `cyrusHome`: in a worker container the two differ
	 * (`cyrusHome` is `/workspaces/.cyrus`, `$HOME` is `/home/cyrus`), and it
	 * is `$HOME` that a dotfiles `install.sh` writes skills into. Only tests
	 * should pass this.
	 */
	homeDir?: string;
}

/** Resolved form of {@link SkillsPluginResolverOptions.defaultSkills}. */
type DefaultSkillsSelection =
	| { mode: "all" }
	| { mode: "none" }
	| { mode: "list"; names: Set<string> };

function parseDefaultSkills(raw: string | undefined): DefaultSkillsSelection {
	const value = raw?.trim();
	if (!value) return { mode: "all" };
	const lowered = value.toLowerCase();
	if (lowered === "all") return { mode: "all" };
	if (lowered === "none") return { mode: "none" };
	const names = value
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name.length > 0);
	// A value of only separators (e.g. `",,"`) is meaningless; treat it as
	// unset rather than as "hide everything", which would be a surprising
	// reading of a typo.
	if (names.length === 0) return { mode: "all" };
	return { mode: "list", names: new Set(names) };
}

/**
 * A discovered skill: its directory name (what the SDK allowlist and the
 * guidance block use) plus the directory itself, so the skill's `SKILL.md`
 * frontmatter can be read without re-deriving the path.
 */
interface SkillEntry {
	name: string;
	dir: string;
}

/**
 * True when a `SKILL.md` declares `disable-model-invocation: true` in its
 * YAML frontmatter — meaning the SDK will refuse to run it via the Skill
 * tool, and it is reachable only as a user-typed `/slash-command`.
 *
 * Deliberately a targeted scan rather than a YAML parse: this is the only
 * frontmatter key we need, and pulling in a YAML dependency to read one
 * boolean would be a poor trade.
 */
function declaresDisableModelInvocation(source: string): boolean {
	const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
	if (!frontmatter?.[1]) return false;
	const flag = /^disable-model-invocation[ \t]*:[ \t]*(.+?)[ \t]*$/m.exec(
		frontmatter[1],
	);
	if (!flag?.[1]) return false;
	const value = flag[1].replace(/^["']|["']$/g, "").toLowerCase();
	return value === "true" || value === "yes";
}

/** One step of a routing rule in the guidance block. */
interface RoutingStep {
	skill: string;
	/** Rendered fragment, e.g. "`summarize` to narrate results". */
	phrase: string;
}

interface RoutingRule {
	/** Rendered situation, e.g. "**Bug report or error**". */
	context: string;
	/**
	 * Ordered steps. The FIRST step is the rule's primary skill — when it is
	 * unavailable the whole rule is dropped, since a rule that opens with
	 * "then …" describes no entry point.
	 */
	steps: RoutingStep[];
}

/**
 * Routing rules for the bundled Cyrus skills. Emitted conditionally: a rule
 * appears only when its primary skill survived resolution, and each rule drops
 * the steps whose skills did not.
 *
 * This has to be generated rather than emitted as a fixed block because
 * `CYRUS_DEFAULT_SKILLS` makes every one of these skills optional — a hard-coded
 * block would instruct the model to use skills that do not exist for that user.
 */
const ROUTING_RULES: readonly RoutingRule[] = [
	{
		context: "**Code changes requested** (feature, bug fix, refactor)",
		steps: [
			{ skill: "implementation", phrase: "`implementation` to write code" },
			{
				skill: "verify-and-ship",
				phrase: "`verify-and-ship` to run checks and create a PR",
			},
			{ skill: "summarize", phrase: "`summarize` to narrate results" },
		],
	},
	{
		context: "**Bug report or error**",
		steps: [
			{ skill: "debug", phrase: "`debug` to reproduce, root-cause, and fix" },
			{ skill: "verify-and-ship", phrase: "`verify-and-ship`" },
			{ skill: "summarize", phrase: "`summarize`" },
		],
	},
	{
		context: "**Question or research request**",
		steps: [
			{
				skill: "investigate",
				phrase: "`investigate` to search the codebase and provide an answer",
			},
			{ skill: "summarize", phrase: "`summarize`" },
		],
	},
	{
		context: "**PR review feedback** (changes requested)",
		steps: [
			{
				skill: "implementation",
				phrase: "`implementation` to address review comments",
			},
			{ skill: "verify-and-ship", phrase: "`verify-and-ship`" },
		],
	},
];

/**
 * Resolves skills plugins for agent sessions.
 *
 * Two plugin sources are supported:
 * 1. Internal plugin — default Cyrus workflow skills deployed to ~/.cyrus/cyrus-skills-plugin/
 *    (editable by the user)
 * 2. User skills plugin — custom skills managed by the CYHOST UI at ~/.cyrus/user-skills-plugin/
 *
 * Both live outside the repository so they are never committed to the user's repo.
 *
 * Plugin ordering: user plugin is loaded before internal plugin so that
 * user-defined skills take precedence over internal skills with the same name.
 */
export class SkillsPluginResolver {
	private readonly internalPluginPath: string;
	private readonly userPluginPath: string;
	private readonly userSkillsDir: string;
	private readonly homeSkillsDir: string;
	private readonly defaultSkills: DefaultSkillsSelection;

	constructor(
		private readonly cyrusHome: string,
		private readonly logger: ILogger,
		options: SkillsPluginResolverOptions = {},
	) {
		this.internalPluginPath = join(this.cyrusHome, "cyrus-skills-plugin");
		this.userPluginPath = join(this.cyrusHome, "user-skills-plugin");
		this.userSkillsDir = join(this.userPluginPath, "skills");
		this.homeSkillsDir = join(
			options.homeDir ?? homedir(),
			".claude",
			"skills",
		);
		this.defaultSkills = parseDefaultSkills(options.defaultSkills);
	}

	/**
	 * Ensure the user-skills plugin layout exists on disk.
	 *
	 * Called from EdgeWorker startup — idempotent check-and-create so the
	 * plugin is always ready before the first skill is synced, mirroring the
	 * pattern used for other Cyrus-managed directories (repos, worktrees,
	 * mcp-configs in `Application.ensureRequiredDirectories()`).
	 *
	 * Creates, if missing:
	 *   ~/.cyrus/user-skills-plugin/
	 *   ~/.cyrus/user-skills-plugin/skills/
	 *   ~/.cyrus/user-skills-plugin/.claude-plugin/plugin.json
	 *
	 * The manifest file is what the Claude Agent SDK uses to identify the
	 * directory as a plugin — without it, even a populated `skills/` tree is
	 * silently ignored by the SDK's plugin loader.
	 *
	 * Separated from resolve() to maintain Command-Query Separation:
	 * this method writes to the filesystem, resolve() only reads.
	 */
	async ensureUserPluginScaffolded(): Promise<void> {
		// Always ensure the skills directory exists — handlers/skills.ts also
		// mkdir's it recursively per-skill, but creating it eagerly here means
		// the layout is consistent even before the first sync.
		await mkdir(this.userSkillsDir, { recursive: true });

		const manifestDir = join(this.userPluginPath, ".claude-plugin");
		const manifestPath = join(manifestDir, "plugin.json");
		if (await this.exists(manifestPath)) {
			return;
		}

		await mkdir(manifestDir, { recursive: true });
		await writeFile(
			manifestPath,
			JSON.stringify(
				{
					name: "user-skills",
					description: "User-created skills managed by Cyrus",
				},
				null,
				"\t",
			),
		);
		this.logger.info(
			`Scaffolded user-skills plugin manifest at ${manifestPath}`,
		);
	}

	/**
	 * Resolve all available skills plugins (user + internal).
	 *
	 * User plugin is listed first so user-defined skills take precedence
	 * over internal skills with the same name.
	 *
	 * Pure query — no filesystem side effects.
	 */
	async resolve(): Promise<SdkPluginConfig[]> {
		const plugins: SdkPluginConfig[] = [];

		// User plugin first — user skills override internal skills
		const user = await this.resolveUserPlugin();
		if (user) {
			plugins.push(user);
		}

		// `CYRUS_DEFAULT_SKILLS=none` drops the bundled plugin outright rather
		// than resolving it and filtering every entry away — cheaper, and it
		// keeps the SDK from being handed a plugin that contributes nothing.
		if (this.defaultSkills.mode === "none") {
			this.logger.debug(
				"CYRUS_DEFAULT_SKILLS=none — skipping the internal Cyrus skills plugin",
			);
		} else {
			const internal = await this.resolveInternalPlugin();
			if (internal) {
				plugins.push(internal);
			}
		}

		await this.logConflicts(plugins);

		return plugins;
	}

	/**
	 * Discover all available skill names from the given plugin configs,
	 * optionally filtered by per-skill scope sidecars (scope.json) using the
	 * provided session context.
	 *
	 * Reads the `skills/` subdirectory of each plugin path and returns
	 * deduplicated skill names (user skills shadow internal ones due to
	 * insertion order of the Set).
	 *
	 * Filtering rules:
	 * - A skill with no `scope.json` (or an empty scope) is always available.
	 * - A skill with a populated scope is available only when every populated
	 *   dimension matches the session context (AND across dimensions, OR
	 *   within each list).
	 * - When `context` is omitted, no filtering is applied (all skills returned).
	 *
	 * Repo-local skills: when `context.repoPaths` is provided, each
	 * `<repoPath>/.claude/skills/*` directory name is also unioned in. These are
	 * implicitly scoped to the repository by virtue of living in it, so the
	 * `scope.json` filter is NOT applied to them. They are appended after the
	 * plugin skills, so a plugin skill of the same name takes precedence in the
	 * (display-order-sensitive) dedup.
	 *
	 * Home-directory skills: `$HOME/.claude/skills/*` is unioned in last, on the
	 * same no-scope-filter terms. This is how a per-user dotfiles repo delivers
	 * skills — `ContainerBootCommand.applyDotfiles()` runs the repo's
	 * `install.sh`, which copies skill directories there. Without this union the
	 * SDK allowlist would omit them and the model would see none of them, with
	 * the files sitting on disk and no error anywhere.
	 */
	async discoverSkillNames(
		plugins: SdkPluginConfig[],
		context?: SkillSessionContext,
	): Promise<string[]> {
		const entries = await this.discoverSkillEntries(plugins, context);
		return entries.map((entry) => entry.name);
	}

	/**
	 * Discovery proper — see {@link discoverSkillNames} for the rules. Returns
	 * each skill's directory alongside its name so callers that need the
	 * skill's `SKILL.md` (currently only {@link buildSkillsGuidance}, for the
	 * `disable-model-invocation` frontmatter flag) do not have to re-derive it.
	 *
	 * Deduplicated first-wins, preserving source precedence:
	 * plugin skills → repo-local skills → home-directory skills.
	 */
	private async discoverSkillEntries(
		plugins: SdkPluginConfig[],
		context?: SkillSessionContext,
	): Promise<SkillEntry[]> {
		const entries: SkillEntry[] = [];
		const seen = new Set<string>();
		const add = (name: string, skillsDir: string): void => {
			if (seen.has(name)) return;
			seen.add(name);
			entries.push({ name, dir: join(skillsDir, name) });
		};

		for (const plugin of plugins) {
			const isInternal = plugin.path === this.internalPluginPath;
			// Defensive: resolve() already withholds the internal plugin on
			// "none", but discoverSkillNames also runs against caller-supplied
			// plugin lists.
			if (isInternal && this.defaultSkills.mode === "none") {
				continue;
			}
			const skillsDir = join(plugin.path, "skills");
			const names = await this.readSkillDirEntries(skillsDir);

			for (const entry of names) {
				if (
					isInternal &&
					this.defaultSkills.mode === "list" &&
					!this.defaultSkills.names.has(entry)
				) {
					this.logger.debug(
						`Bundled Cyrus skill "${entry}" excluded by CYRUS_DEFAULT_SKILLS`,
					);
					continue;
				}

				if (context) {
					const scope = await this.loadSkillScope(skillsDir, entry);
					if (!this.scopeMatches(scope, context)) {
						this.logger.debug(
							`Skill "${entry}" excluded by scope filter for current session`,
						);
						continue;
					}
				}

				add(entry, skillsDir);
			}
		}

		// Union repo-local skills shipped in each participating repo's working
		// tree. No scope.json filtering — presence in the repo is the scope.
		for (const repoPath of context?.repoPaths ?? []) {
			const skillsDir = join(repoPath, ".claude", "skills");
			for (const entry of await this.readSkillDirEntries(skillsDir)) {
				add(entry, skillsDir);
			}
		}

		// Union skills installed into $HOME by a dotfiles repo. Same terms as
		// repo-local skills: no scope.json filtering, absent-tolerant.
		for (const entry of await this.readSkillDirEntries(this.homeSkillsDir)) {
			add(entry, this.homeSkillsDir);
		}

		return entries;
	}

	/**
	 * Read the immediate subdirectory (and symlink) names of a `skills/`
	 * directory. Returns an empty array when the directory is missing or
	 * unreadable, so callers can treat "no skills dir" as a no-op.
	 */
	private async readSkillDirEntries(skillsDir: string): Promise<string[]> {
		try {
			const entries = await readdir(skillsDir, { withFileTypes: true });
			return entries
				.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
				.map((entry) => entry.name);
		} catch {
			// Directory doesn't exist or isn't readable — skip
			return [];
		}
	}

	/**
	 * Read a skill's `scope.json` sidecar if present. Returns `null` when the
	 * sidecar is absent, empty, or unparseable — all of which mean "no scope
	 * restriction" (global skill).
	 */
	private async loadSkillScope(
		skillsDir: string,
		skillName: string,
	): Promise<SkillScope | null> {
		const scopePath = join(skillsDir, skillName, "scope.json");
		let raw: string;
		try {
			raw = await readFile(scopePath, "utf-8");
		} catch {
			return null;
		}

		try {
			const parsed = JSON.parse(raw) as unknown;
			if (!parsed || typeof parsed !== "object") {
				return null;
			}
			const obj = parsed as Record<string, unknown>;
			const cleanList = (value: unknown): string[] | undefined => {
				if (!Array.isArray(value)) return undefined;
				const filtered = value.filter(
					(v): v is string => typeof v === "string" && v.length > 0,
				);
				return filtered.length > 0 ? filtered : undefined;
			};
			const scope: SkillScope = {};
			const repos = cleanList(obj.repositoryIds);
			const teams = cleanList(obj.linearTeamIds);
			const labels = cleanList(obj.linearLabelIds);
			if (repos) scope.repositoryIds = repos;
			if (teams) scope.linearTeamIds = teams;
			if (labels) scope.linearLabelIds = labels;
			if (
				!scope.repositoryIds &&
				!scope.linearTeamIds &&
				!scope.linearLabelIds
			) {
				return null;
			}
			return scope;
		} catch (error) {
			this.logger.warn(
				`Failed to parse scope.json for skill "${skillName}" — treating as global`,
				{ error: error instanceof Error ? error.message : String(error) },
			);
			return null;
		}
	}

	/**
	 * Evaluate scope against session context.
	 *
	 * A null/empty scope always matches. Otherwise every populated dimension
	 * on the scope must be satisfied by the session context (AND), where each
	 * dimension is satisfied when the context value is included in the
	 * configured list (OR within the dimension).
	 */
	private scopeMatches(
		scope: SkillScope | null,
		context: SkillSessionContext,
	): boolean {
		if (!scope) return true;

		if (scope.repositoryIds) {
			if (
				!context.repositoryId ||
				!scope.repositoryIds.includes(context.repositoryId)
			) {
				return false;
			}
		}

		if (scope.linearTeamIds) {
			if (
				!context.linearTeamId ||
				!scope.linearTeamIds.includes(context.linearTeamId)
			) {
				return false;
			}
		}

		if (scope.linearLabelIds) {
			const sessionLabels = context.linearLabelIds ?? [];
			if (
				sessionLabels.length === 0 ||
				!scope.linearLabelIds.some((id) => sessionLabels.includes(id))
			) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Build the skills guidance block appended to system prompts.
	 *
	 * Dynamically lists all available skills so that user-added custom
	 * skills appear in the guidance without code changes (OCP).
	 *
	 * Accepts pre-resolved plugins to avoid redundant filesystem access
	 * when resolve() is also called separately for the runner config.
	 *
	 * Two filters are applied on top of plain discovery:
	 *
	 * 1. Skills whose `SKILL.md` sets `disable-model-invocation: true` are
	 *    omitted from the listing. They stay in the SDK allowlist — the user can
	 *    still invoke them as `/slash-commands` — but the SDK refuses to run
	 *    them via the Skill tool, so advertising them here would be telling the
	 *    model to reach for something it cannot use.
	 * 2. The routing rules below are generated from the surviving set, so a user
	 *    who trimmed the bundled skills with `CYRUS_DEFAULT_SKILLS` is not
	 *    instructed to use skills they no longer have.
	 */
	async buildSkillsGuidance(
		plugins?: SdkPluginConfig[],
		context?: SkillSessionContext,
	): Promise<string> {
		const resolvedPlugins = plugins ?? (await this.resolve());
		const entries = await this.discoverSkillEntries(resolvedPlugins, context);

		const availableSkills: string[] = [];
		for (const entry of entries) {
			if (await this.isModelInvocable(entry)) {
				availableSkills.push(entry.name);
			}
		}

		if (availableSkills.length === 0) {
			return "";
		}

		const available = new Set(availableSkills);
		const skillsList = availableSkills.map((s) => `\`${s}\``).join(", ");

		let guidance =
			"\n\n## Skills\n\n" +
			`You have skills available via the Skill tool: ${skillsList}\n\n`;

		const renderedRules = ROUTING_RULES.filter(
			(rule) => rule.steps[0] && available.has(rule.steps[0].skill),
		).map((rule) => {
			const phrases = rule.steps
				.filter((step) => available.has(step.skill))
				.map((step) => step.phrase);
			return `- ${rule.context}: Use ${phrases.join(", then ")}.\n`;
		});

		if (renderedRules.length > 0) {
			guidance += `Choose the appropriate skill based on the context:\n\n${renderedRules.join("")}\n`;
			guidance +=
				"Analyze the issue description, labels, and any user comments to determine which workflow fits.";
			if (available.has("verify-and-ship")) {
				guidance +=
					" Do NOT skip the verify-and-ship step if you made code changes — it ensures quality checks pass and a PR is created.";
			}
		} else {
			// No rule survived — every entry-point skill was trimmed, so this user
			// is running their own workflow and there is nothing to route. But
			// `verify-and-ship` and `summarize` are product plumbing rather than
			// workflow opinion (they open the pull request and post the session's
			// final message), so when they survive they still have to be asked
			// for. Otherwise the documented `CYRUS_DEFAULT_SKILLS=summarize,
			// verify-and-ship` — keep exactly the plumbing, replace the workflow —
			// would name them in the listing and then never mention them again,
			// which is the silent no-PR/no-summary failure this whole block exists
			// to prevent.
			const plumbing: string[] = [];
			if (available.has("verify-and-ship")) {
				plumbing.push(
					"Use `verify-and-ship` whenever you have made code changes — it runs the quality checks and opens the pull request.",
				);
			}
			if (available.has("summarize")) {
				plumbing.push(
					"Use `summarize` to produce the session's final message.",
				);
			}
			guidance += plumbing.join(" ");
		}

		// `implement` and `implementation` are different skills from different
		// sets, and the names are one character apart. Picking `implement` skips
		// verification and opens no PR — which reads downstream as the agent
		// simply having chosen not to ship. Only worth saying when both exist.
		if (available.has("implement") && available.has("implementation")) {
			guidance +=
				"\n\nNote: `implementation` and `implement` are different skills. " +
				"Use `implementation` for the workflows above — `implement` neither runs verification nor opens a pull request.";
		}

		// The skills list ends in a blank line that only makes sense when a
		// routing block follows it. A no-op when one does.
		return guidance.trimEnd();
	}

	/**
	 * Whether the model may invoke this skill via the Skill tool, i.e. its
	 * `SKILL.md` does not set `disable-model-invocation: true`.
	 *
	 * A missing or unreadable `SKILL.md` counts as invocable — the same
	 * permissive default the rest of this class uses for absent sidecars, and
	 * the conservative choice here is to keep listing a skill rather than
	 * silently hide it over a read error.
	 */
	private async isModelInvocable(entry: SkillEntry): Promise<boolean> {
		let raw: string;
		try {
			raw = await readFile(join(entry.dir, "SKILL.md"), "utf-8");
		} catch {
			return true;
		}
		return !declaresDisableModelInvocation(raw);
	}

	private async resolveInternalPlugin(): Promise<SdkPluginConfig | null> {
		if (await this.exists(this.internalPluginPath)) {
			this.logger.debug(
				`Using internal skills plugin at ${this.internalPluginPath}`,
			);
			return { type: "local", path: this.internalPluginPath };
		}
		this.logger.warn(
			`No internal skills plugin found at ${this.internalPluginPath}`,
		);
		return null;
	}

	private async resolveUserPlugin(): Promise<SdkPluginConfig | null> {
		const manifestPath = join(
			this.userPluginPath,
			".claude-plugin",
			"plugin.json",
		);
		if (!(await this.exists(manifestPath))) {
			return null;
		}

		this.logger.debug(`Using user skills plugin at ${this.userPluginPath}`);
		return { type: "local", path: this.userPluginPath };
	}

	/**
	 * Detect and log skill name conflicts between user and internal plugins.
	 */
	private async logConflicts(plugins: SdkPluginConfig[]): Promise<void> {
		if (plugins.length < 2) {
			return;
		}

		const skillSets: string[][] = [];
		for (const plugin of plugins) {
			const skillsDir = join(plugin.path, "skills");
			try {
				const entries = await readdir(skillsDir, { withFileTypes: true });
				skillSets.push(
					entries
						.filter((e) => e.isDirectory() || e.isSymbolicLink())
						.map((e) => e.name),
				);
			} catch {
				skillSets.push([]);
			}
		}

		// First set is user, second is internal — find overlap
		if (skillSets.length >= 2 && skillSets[0] && skillSets[1]) {
			const userSkills = new Set(skillSets[0]);
			const conflicts = skillSets[1].filter((s) => userSkills.has(s));
			if (conflicts.length > 0) {
				this.logger.info(
					`User skills override internal skills: ${conflicts.join(", ")}`,
				);
			}
		}
	}

	private async exists(path: string): Promise<boolean> {
		try {
			await access(path);
			return true;
		} catch {
			return false;
		}
	}
}
