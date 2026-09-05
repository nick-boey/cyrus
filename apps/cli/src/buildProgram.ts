import { homedir } from "node:os";
import { resolve } from "node:path";
import { Command } from "commander";
import type { ErrorReporter } from "cyrus-core";
import { Application } from "./Application.js";
import { AuthCommand } from "./commands/AuthCommand.js";
import { CheckTokensCommand } from "./commands/CheckTokensCommand.js";
import { ConnectCommand } from "./commands/ConnectCommand.js";
import { ConnectionCommand } from "./commands/ConnectionCommand.js";
import { ContainerBootCommand } from "./commands/ContainerBootCommand.js";
import { RefreshTokenCommand } from "./commands/RefreshTokenCommand.js";
import { RouterCommand } from "./commands/RouterCommand.js";
import { RunsCommand } from "./commands/RunsCommand.js";
import { SelfAddRepoCommand } from "./commands/SelfAddRepoCommand.js";
import { SelfAuthCommand } from "./commands/SelfAuthCommand.js";
import { StartCommand } from "./commands/StartCommand.js";
import { UsageError } from "./remote/errors.js";

/**
 * Builds the Commander program that the shipped `cyrus` binary parses.
 *
 * Extracted out of `app.ts` (which also does process-level bootstrap: env
 * preloading, Sentry init, `program.parseAsync(process.argv)`) so tests can
 * drive the *real* command tree — `program.parseAsync([...])` — instead of
 * calling a command's `execute()` method directly. Calling `execute()`
 * bypasses Commander's own argument parsing and subcommand registration, so
 * a subcommand that exists on `RouterCommand` but was never registered here
 * (e.g. `router users set-executor`, `router secrets set/unset`, `router
 * containers list/destroy`) would still pass such tests while being
 * completely unreachable from the shipped binary. See CYPACK task 9 finding 1.
 */
/**
 * Commander option accumulator for repeatable flags (`--role a --role b`).
 * Without one, Commander keeps only the LAST occurrence — which for `--role`
 * would silently drop half of a two-role grant, and for `--workspace` would
 * narrow a grant the operator believed they had widened.
 */
function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

/**
 * Which command surface the binary exposes (ADR 0011).
 *
 * `full` keeps the complete worker and router surface; `remote` registers only
 * the commands an orchestrator uses to observe and recover work through a
 * remote router.
 */
export type CommandProfile = "full" | "remote";

export const COMMAND_PROFILES: readonly CommandProfile[] = ["full", "remote"];

/** Environment variable an orchestrator installation sets as its default. */
export const COMMAND_PROFILE_ENV = "CYRUS_COMMAND_PROFILE";

/**
 * The one top-level remote vocabulary, shared by both profiles.
 *
 * There is deliberately no `cyrus remote` namespace: the same words mean the
 * same thing whichever profile is active, so a skill written against an
 * orchestrator installation runs unchanged on a full one.
 *
 * This list is LOAD-BEARING, not documentation: `buildProgram` registers a
 * command into the remote profile only if its name appears here, so membership
 * cannot be granted by where a `register*` call happens to sit relative to a
 * branch. Adding a command to the remote surface is an edit to this array.
 *
 * `logs`, `recover`, and `skills` are named but not yet implemented — they
 * arrive with CYR-73, CYR-76, and CYR-77.
 */
export const REMOTE_PROFILE_COMMANDS: readonly string[] = [
	"connection",
	"runs",
	"logs",
	"recover",
	"skills",
];

/**
 * The subset of {@link REMOTE_PROFILE_COMMANDS} that exists and works today.
 *
 * Separate from the vocabulary above so that "approved for this profile" and
 * "actually usable in this profile" are two decisions rather than one — a
 * command may be approved long before it can function unattended.
 */
export const REMOTE_PROFILE_REGISTERED: readonly string[] = [
	"connection",
	"runs",
];

/**
 * Adds the two selection flags every fleet command accepts: which stored
 * connection to talk to, and which authorized workspace to act on.
 *
 * Attached to each fleet command rather than declared once on the program, and
 * that is NOT a stylistic choice. Commander resolves an option a parent and a
 * child both declare in favour of the PARENT: with `--workspace` on the
 * program, `cyrus router operators create-token --workspace a --workspace b`
 * parses both values into the program's single-valued option and hands the
 * subcommand an empty array — silently minting a token authorized over no
 * workspaces. `enablePositionalOptions()` fixes that collision but breaks
 * `cyrus start --cyrus-home /x`, which works today. So the flags live on the
 * commands that consume them, and every new fleet command must call this to
 * keep the vocabulary uniform.
 */
export function addFleetSelectionOptions(command: Command): Command {
	return command
		.option(
			"--connection <name>",
			"Named router connection to use (see `cyrus connection list`). Optional when exactly one is stored.",
		)
		.option(
			"--workspace <id>",
			"Linear workspace to act on. Required when the connection authorizes more than one.",
		);
}

/**
 * Resolves the profile BEFORE the program is built, because the profile decides
 * which commands exist and Commander cannot report an option it has not parsed
 * yet. Explicit `--profile` beats the environment default, so one installation
 * can still perform both roles deliberately.
 */
export function resolveCommandProfile(
	argv: readonly string[] = process.argv,
	env: NodeJS.ProcessEnv = process.env,
): CommandProfile {
	let raw: string | undefined = env[COMMAND_PROFILE_ENV]?.trim() || undefined;
	let origin = `${COMMAND_PROFILE_ENV}`;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--profile" && argv[i + 1]) {
			// Last occurrence wins, matching Commander's own behaviour for a
			// non-accumulating option.
			raw = argv[++i];
			origin = "--profile";
		} else if (arg?.startsWith("--profile=")) {
			raw = arg.slice("--profile=".length);
			origin = "--profile";
		}
	}

	if (raw === undefined) return "full";
	if ((COMMAND_PROFILES as readonly string[]).includes(raw)) {
		return raw as CommandProfile;
	}
	throw new UsageError(
		`Unknown command profile "${raw}" from ${origin}. Valid profiles: ${COMMAND_PROFILES.join(", ")}.`,
	);
}

export interface BuildProgramOptions {
	/** Argv to resolve `--profile` from; defaults to `process.argv`. */
	argv?: readonly string[];
	/** Environment to resolve `CYRUS_COMMAND_PROFILE` from. */
	env?: NodeJS.ProcessEnv;
}

export function buildProgram(
	packageJson: { version: string },
	errorReporter: ErrorReporter,
	options: BuildProgramOptions = {},
): Command {
	const profile = resolveCommandProfile(options.argv, options.env);
	const program = new Command();

	program
		.name("cyrus")
		.description("AI-powered Linear issue automation using Claude")
		.version(packageJson.version)
		.option(
			"--cyrus-home <path>",
			"Specify custom Cyrus config directory",
			resolve(homedir(), ".cyrus"),
		)
		.option("--env-file <path>", "Path to environment variables file")
		// Registered so `--profile` parses and appears in help. The VALUE is
		// resolved above, before any command exists; this declaration is not
		// where the decision is made.
		.option(
			`--profile <${COMMAND_PROFILES.join("|")}>`,
			"Command surface to expose: full (default) or remote for a fleet orchestrator",
		);

	// --- The shared remote vocabulary. The same words mean the same thing in
	// both profiles: a command profile is a product and discoverability
	// boundary, not an authorization boundary (ADR 0011) — the router
	// authorizes every remote read and mutation regardless of which profile
	// invoked it.
	//
	// Driven off REMOTE_PROFILE_REGISTERED so the allowlist is the mechanism
	// rather than a description a future edit can silently diverge from.
	const remoteVocabulary: Record<string, () => void> = {
		connection: () =>
			registerConnectionCommand(program, packageJson, errorReporter),
		runs: () => registerRunsCommand(program, packageJson, errorReporter),
	};

	for (const [name, register] of Object.entries(remoteVocabulary)) {
		if (profile === "remote" && !REMOTE_PROFILE_REGISTERED.includes(name)) {
			continue;
		}
		register();
	}

	if (profile === "remote") {
		// Returning here — with NO program-level action handler — is deliberate.
		// This profile has no default command (`start` is not registered), and
		// Commander's behaviour without an action is exactly what is wanted: a
		// bare `cyrus` prints help, and `cyrus router unlock X` is rejected as
		// `unknown command 'router'`. Adding an action to print help instead
		// makes Commander treat `router unlock X` as excess PROGRAM arguments and
		// report "too many arguments. Expected 0 arguments but got 3" — which
		// tells an operator nothing about why the command is unavailable.
		return program;
	}

	// Start command (default)
	program
		.command("start", { isDefault: true })
		.description("Start the edge worker")
		.action(async () => {
			const opts = program.opts();
			const app = new Application(
				opts.cyrusHome,
				opts.envFile,
				packageJson.version,
				errorReporter,
			);
			await new StartCommand(app).execute([]);
		});

	// Auth command
	program
		.command("auth <auth-key>")
		.description("Authenticate with Cyrus using auth key")
		.action(async (authKey: string) => {
			const opts = program.opts();
			const app = new Application(
				opts.cyrusHome,
				opts.envFile,
				packageJson.version,
				errorReporter,
			);
			try {
				await new AuthCommand(app).execute([authKey]);
			} finally {
				app.disposeWatchers();
			}
		});

	// Check tokens command
	program
		.command("check-tokens")
		.description("Check the status of all Linear tokens")
		.action(async () => {
			const opts = program.opts();
			const app = new Application(
				opts.cyrusHome,
				opts.envFile,
				packageJson.version,
				errorReporter,
			);
			try {
				await new CheckTokensCommand(app).execute([]);
			} finally {
				app.disposeWatchers();
			}
		});

	// Refresh token command
	program
		.command("refresh-token")
		.description("Refresh a specific Linear token")
		.action(async () => {
			const opts = program.opts();
			const app = new Application(
				opts.cyrusHome,
				opts.envFile,
				packageJson.version,
				errorReporter,
			);
			try {
				await new RefreshTokenCommand(app).execute([]);
			} finally {
				app.disposeWatchers();
			}
		});

	// Self-auth-linear command - Linear OAuth directly from CLI
	program
		.command("self-auth-linear")
		.description("Authenticate with Linear OAuth directly")
		.action(async () => {
			const opts = program.opts();
			const app = new Application(
				opts.cyrusHome,
				opts.envFile,
				packageJson.version,
				errorReporter,
			);
			await new SelfAuthCommand(app).execute([]);
		});

	// Self-add-repo command - Clone and add repository
	program
		.command("self-add-repo [url] [workspace]")
		.description(
			'Clone a repo and add it to config. URL accepts any valid git clone address (e.g., "https://github.com/org/repo.git"). Workspace is the display name of the Linear workspace (e.g., "My Workspace"). If URL is omitted, prompts interactively.',
		)
		.option(
			"-l, --label <labels>",
			"Comma-separated routing labels (defaults to repo name)",
		)
		.option(
			"-b, --base-branch <branch>",
			"Base branch name (auto-detected from remote if not specified)",
		)
		.action(
			async (
				url: string | undefined,
				workspace: string | undefined,
				cmdOpts: { label?: string; baseBranch?: string },
			) => {
				const opts = program.opts();
				const app = new Application(
					opts.cyrusHome,
					opts.envFile,
					packageJson.version,
				);
				const args = [url, workspace].filter(Boolean) as string[];
				if (cmdOpts.label) {
					args.push("-l", cmdOpts.label);
				}
				if (cmdOpts.baseBranch) {
					args.push("-b", cmdOpts.baseBranch);
				}
				await new SelfAddRepoCommand(app).execute(args);
			},
		);

	// Router command - administer a Cyrus Router server (multi-user device routing)
	const routerCommand = program
		.command("router")
		.description(
			"Manage a Cyrus Router server: registered users, enrolled devices, and stuck issue locks.",
		);

	/**
	 * Action for the one-shot `router` admin subcommands. Disposes the
	 * Application's file watchers once the command is done so the process exits
	 * instead of idling on live `fs.watch` handles.
	 */
	const makeRouterAction =
		(...prefix: string[]) =>
		async (...actionArgs: unknown[]) => {
			const opts = program.opts();
			const app = new Application(
				opts.cyrusHome,
				opts.envFile,
				packageJson.version,
				errorReporter,
			);
			const positional = actionArgs.filter(
				(a): a is string => typeof a === "string",
			);
			try {
				await new RouterCommand(app).execute([...prefix, ...positional]);
			} finally {
				app.disposeWatchers();
			}
		};

	routerCommand
		.command("start")
		.description(
			"Start the router server (reads <cyrus-home>/router-config.json)",
		)
		.action(async () => {
			const opts = program.opts();
			const app = new Application(
				opts.cyrusHome,
				opts.envFile,
				packageJson.version,
				errorReporter,
			);
			// No disposeWatchers(): the server is long-running and relies on the
			// .env watcher for hot-reload.
			await new RouterCommand(app).execute(["start"]);
		});

	const routerUsersCommand = routerCommand
		.command("users")
		.description("Manage router-registered users");

	routerUsersCommand
		.command("add <email>")
		.description(
			"Register a user and mint a one-time, 15-minute enrollment code for `cyrus connect`",
		)
		.option("--name <name>", "Display name for the user")
		.action(async (email: string, cmdOpts: { name?: string }) => {
			const args = ["add", email];
			if (cmdOpts.name) {
				args.push("--name", cmdOpts.name);
			}
			const opts = program.opts();
			const app = new Application(
				opts.cyrusHome,
				opts.envFile,
				packageJson.version,
				errorReporter,
			);
			try {
				await new RouterCommand(app).execute(["users", ...args]);
			} finally {
				app.disposeWatchers();
			}
		});

	routerUsersCommand
		.command("list")
		.description("List registered users")
		.action(makeRouterAction("users", "list"));

	routerUsersCommand
		.command("remove <email>")
		.description("Remove a registered user")
		.action(makeRouterAction("users", "remove"));

	routerUsersCommand
		.command("set-executor <email> <type>")
		.description(
			"Choose where a user's future sessions run: device, docker, fly, or codespaces",
		)
		.action(makeRouterAction("users", "set-executor"));

	const routerDevicesCommand = routerCommand
		.command("devices")
		.description("Manage enrolled devices");

	routerDevicesCommand
		.command("list")
		.description("List enrolled devices and the users they belong to")
		.action(makeRouterAction("devices", "list"));

	routerDevicesCommand
		.command("revoke <email>")
		.description(
			"Revoke a user's enrolled device, releasing any issue locks it held",
		)
		.action(makeRouterAction("devices", "revoke"));

	const routerSessionsCommand = routerCommand
		.command("sessions")
		.description("Inspect running and locked sessions");

	routerSessionsCommand
		.command("list")
		.description(
			"List running and locked sessions with their Linear issue id and session GUID",
		)
		.action(makeRouterAction("sessions", "list"));

	// Local operator credentials for the Fleet Operations API. Local-only on
	// purpose: these mint and revoke the credentials that API authenticates, so
	// serving them over it would let a token mint another, and revoking a
	// compromised token would depend on that token still working.
	const routerOperatorsCommand = routerCommand
		.command("operators")
		.description("Manage local Fleet Operations operator credentials");

	routerOperatorsCommand
		.command("create-token")
		.description(
			"Mint a local operator token and print it once (only its hash is stored)",
		)
		.requiredOption("--label <label>", "Human label recorded with the grant")
		// `option`, not `requiredOption`: Commander treats an option with a
		// default value as satisfied, so `requiredOption(..., collect, [])` never
		// enforces anything — the empty array IS the default. The repeatable
		// flags need a default for `collect` to accumulate onto, so the "at least
		// one" check belongs to RouterCommand, which reports it with the role and
		// workspace context Commander has no idea about.
		.option(
			"--role <role>",
			"fleet.read or fleet.recover; repeat for both (fleet.read does not imply fleet.recover)",
			collect,
			[],
		)
		.option(
			"--workspace <workspaceId>",
			"Linear workspace id this token is authorized over; repeatable",
			collect,
			[],
		)
		.action(
			async (cmdOpts: {
				label: string;
				role: string[];
				workspace: string[];
			}) => {
				// makeRouterAction forwards only positional strings, so translate
				// the parsed options back into the flag form the command parses.
				const argv = ["--label", cmdOpts.label];
				for (const role of cmdOpts.role) argv.push("--role", role);
				for (const workspace of cmdOpts.workspace) {
					argv.push("--workspace", workspace);
				}
				await makeRouterAction("operators", "create-token")(...argv);
			},
		);

	routerOperatorsCommand
		.command("list")
		.description(
			"List operator tokens and their grants (never the token itself)",
		)
		.action(makeRouterAction("operators", "list"));

	routerOperatorsCommand
		.command("revoke <tokenId>")
		.description("Revoke a local operator token by its numeric ID")
		.action(makeRouterAction("operators", "revoke"));

	const routerSecretsCommand = routerCommand
		.command("secrets")
		.description("Manage per-user container secrets");

	routerSecretsCommand
		.command("set <email> <key> <value>")
		.description("Store a per-user container secret")
		.action(makeRouterAction("secrets", "set"));

	routerSecretsCommand
		.command("unset <email> <key>")
		.description("Remove a per-user container secret")
		.action(makeRouterAction("secrets", "unset"));

	routerSecretsCommand
		.command("list <email>")
		.description("List a user's stored secret keys (values masked)")
		.option(
			"--check-scopes",
			"Also query GitHub for the stored GH_TOKEN/GIT_TOKEN scopes and report what is missing. Informational only — never rejects a usable token, and never prints token values.",
		)
		.action(async (email: string, options: { checkScopes?: boolean }) => {
			// makeRouterAction forwards only string args, so translate the
			// boolean flag back into the string form RouterCommand parses.
			await makeRouterAction("secrets", "list")(
				email,
				...(options.checkScopes ? ["--check-scopes"] : []),
			);
		});

	routerSecretsCommand
		.command("migrate")
		.description(
			"Migrate per-user secrets between backends (Key Vault -> Azure Table)",
		)
		.option("--from <backend>", "Source backend. Only 'keyvault' is supported.")
		.option("--to <backend>", "Target backend. Only 'table' is supported.")
		.option(
			"--to-endpoint <url>",
			"Target table endpoint, e.g. https://<account>.table.core.windows.net. Defaults to containers.tableStore.endpoint. Pass explicitly to migrate BEFORE that config block exists — the documented order.",
		)
		.option(
			"--to-key-id <id>",
			"Versioned Key Vault key id of the envelope-encryption KEK. Defaults to containers.tableStore.keyId.",
		)
		.option(
			"--to-table <name>",
			"Target table name. Defaults to containers.tableStore.tableName.",
		)
		.option(
			"--dry-run",
			"List what would be migrated without writing. Values are never printed.",
		)
		.action(
			async (options: {
				from?: string;
				to?: string;
				toEndpoint?: string;
				toKeyId?: string;
				toTable?: string;
				dryRun?: boolean;
			}) => {
				// makeRouterAction forwards only string args, so translate the parsed
				// options back into the flag form RouterCommand.secretsMigrate parses.
				// Absent options are omitted rather than passed as undefined, so the
				// handler's own fallbacks to containers.tableStore still apply.
				const argv: string[] = [];
				if (options.from !== undefined) argv.push("--from", options.from);
				if (options.to !== undefined) argv.push("--to", options.to);
				if (options.toEndpoint !== undefined)
					argv.push("--to-endpoint", options.toEndpoint);
				if (options.toKeyId !== undefined)
					argv.push("--to-key-id", options.toKeyId);
				if (options.toTable !== undefined)
					argv.push("--to-table", options.toTable);
				if (options.dryRun) argv.push("--dry-run");
				await makeRouterAction("secrets", "migrate")(...argv);
			},
		);

	const routerContainersCommand = routerCommand
		.command("containers")
		.description("Manage ephemeral container devices");

	routerContainersCommand
		.command("list")
		.description("List running ephemeral container devices")
		.action(makeRouterAction("containers", "list"));

	routerContainersCommand
		.command("destroy <issueKey>")
		.description(
			"Drop a container device's row (provider resources are garbage-collected separately)",
		)
		.action(makeRouterAction("containers", "destroy"));

	routerContainersCommand
		.command("gc-snapshots")
		.description("Plan orphan ACA snapshot deletion; pass --yes to execute")
		.option("--yes", "Delete the planned snapshots")
		.action(async (options: { yes?: boolean }) => {
			const action = makeRouterAction("containers", "gc-snapshots");
			await action(...(options.yes ? ["--yes"] : []));
		});

	const routerLinearCommand = routerCommand
		.command("linear")
		.description("Inspect Linear authentication health");

	routerLinearCommand
		.command("status")
		.description(
			"Probe Linear with each workspace's resolved access token and report where the token came from",
		)
		.action(makeRouterAction("linear", "status"));

	routerCommand
		.command("unlock <issue>")
		.description(
			"Release a stuck issue lock, by Linear issue GUID or human identifier (e.g. PAR-169)",
		)
		.action(makeRouterAction("unlock"));

	// Container-boot command - entrypoint for ephemeral worker containers (see
	// docker/worker/). Driven entirely by environment variables; not intended
	// for interactive use.
	program
		.command("container-boot")
		.description(
			"Internal: boots an ephemeral worker container (restore ladder + launch `cyrus start`). Used as the worker image's ENTRYPOINT.",
		)
		.option(
			"--restore-only",
			"Run only the restore ladder (through restoreState) and exit, without launching `cyrus start`",
		)
		.action(async (opts: { restoreOnly?: boolean }) => {
			await new ContainerBootCommand().execute(
				opts.restoreOnly ? ["--restore-only"] : [],
			);
		});

	// Connect command - enroll this device with a running Cyrus Router server
	program
		.command("connect <url>")
		.description(
			"Enroll this device with a Cyrus Router server using a one-time code from `cyrus router users add`",
		)
		.requiredOption("--code <code>", "One-time enrollment code")
		.option(
			"--entra <audience>",
			"Authenticate enrollment with Azure CLI for the router Application ID URI",
		)
		.action(async (url: string, cmdOpts: { code: string; entra?: string }) => {
			const opts = program.opts();
			const app = new Application(
				opts.cyrusHome,
				opts.envFile,
				packageJson.version,
				errorReporter,
			);
			try {
				await new ConnectCommand(app).execute([
					url,
					"--code",
					cmdOpts.code,
					...(cmdOpts.entra ? ["--entra", cmdOpts.entra] : []),
				]);
			} finally {
				app.disposeWatchers();
			}
		});

	return program;
}

/**
 * `cyrus connection …` — named connections to remote routers' operator APIs.
 *
 * Distinct from `cyrus connect`, which enrolls THIS DEVICE and is unchanged.
 * The two are one letter apart, so keep their descriptions explicit about which
 * is which.
 */
function registerConnectionCommand(
	program: Command,
	packageJson: { version: string },
	errorReporter: ErrorReporter,
): void {
	const connectionCommand = program
		.command("connection")
		.description(
			"Manage named connections to remote Cyrus routers' fleet-operations API (not device enrollment — see `cyrus connect`)",
		);

	/**
	 * Builds the Application and disposes its watchers so a one-shot connection
	 * command exits instead of idling on live `fs.watch` handles.
	 */
	const runConnection = async (
		argv: string[],
		selection: { connection?: string; workspace?: string } = {},
	): Promise<void> => {
		const opts = program.opts();
		const app = new Application(
			opts.cyrusHome,
			opts.envFile,
			packageJson.version,
			errorReporter,
		);
		try {
			await new ConnectionCommand(app).execute(argv, selection);
		} finally {
			app.disposeWatchers();
		}
	};

	connectionCommand
		.command("add <name> <url>")
		.description(
			"Verify a router's operator API and store it under <name>. The router's discovery document supplies the Entra tenant and audience.",
		)
		.requiredOption(
			"--auth <entra|local>",
			"How to authenticate: entra (non-interactive Azure chain) or local (operator token from an environment variable)",
		)
		.option(
			"--token-env <ENV_NAME>",
			"With --auth local: the environment variable holding the token from `cyrus router operators create-token`. The value is read at request time and never stored.",
		)
		.action(
			async (
				name: string,
				url: string,
				cmdOpts: { auth: string; tokenEnv?: string },
			) => {
				const argv = ["add", name, url, "--auth", cmdOpts.auth];
				if (cmdOpts.tokenEnv) argv.push("--token-env", cmdOpts.tokenEnv);
				await runConnection(argv);
			},
		);

	connectionCommand
		.command("list")
		.description("List stored connections (no network access)")
		.action(async () => {
			await runConnection(["list"]);
		});

	addFleetSelectionOptions(
		connectionCommand
			.command("show [name]")
			.description(
				"Report a connection's router identity, roles, capabilities, authorized workspaces, log source, and operator skill, as the router reports them now",
			),
	).action(
		async (
			name: string | undefined,
			cmdOpts: { connection?: string; workspace?: string },
		) => {
			await runConnection(name ? ["show", name] : ["show"], {
				connection: cmdOpts.connection,
				workspace: cmdOpts.workspace,
			});
		},
	);

	connectionCommand
		.command("remove <name>")
		.description("Forget a stored connection")
		.action(async (name: string) => {
			await runConnection(["remove", name]);
		});
}

/**
 * The filters every `runs` subcommand accepts, in the order they are forwarded.
 *
 * Declared once and applied to each subcommand so the vocabulary cannot drift
 * between `list` and `watch` — a filter that exists on one and not the other is
 * a difference an operator discovers only by having their query silently
 * answered with a superset.
 *
 * `--workspace` is NOT here: it arrives through {@link addFleetSelectionOptions}
 * as the fleet selection, and `RunsCommand` treats the selected workspace as the
 * scope of every query.
 */
const RUN_FILTER_OPTIONS = [
	["--run <id>", "Filter by run id"],
	["--session <id>", "Filter by agent session id"],
	[
		"--issue <key>",
		"Filter by Linear issue identifier (e.g. NOR-402) or issue id",
	],
	["--owner <idOrName>", "Filter by the Cyrus user who owns the run"],
	["--team <idOrName>", "Filter by the Linear team captured when input routed"],
	[
		"--project <idOrName>",
		"Filter by the Linear project captured when input routed",
	],
	[
		"--state <state>",
		"Filter by run lifecycle: routed, active, waiting, complete, error, stopped, unknown",
	],
	["--runner <name>", "Filter by the agent runner that executed the run"],
	["--model <name>", "Filter by model"],
	[
		"--comment <id>",
		"Filter by the Linear comment that started or joined a run",
	],
	[
		"--routed-after <timestamp>",
		"Only include runs routed at or after this ISO-8601 instant",
	],
] as const;

/** Parsed filter values, keyed by Commander's camelCase option names. */
interface RunFilterOptionValues {
	run?: string;
	session?: string;
	issue?: string;
	owner?: string;
	team?: string;
	project?: string;
	state?: string;
	runner?: string;
	model?: string;
	comment?: string;
	routedAfter?: string;
}

function addRunFilterOptions(command: Command): Command {
	for (const [flags, description] of RUN_FILTER_OPTIONS) {
		command.option(flags, description);
	}
	return command;
}

/**
 * Translates parsed filter options back into the argv form `RunsCommand`
 * parses.
 *
 * The command owns its own parser so it stays drivable without Commander (and
 * so the legacy shim can re-enter `list`/`wait` by argv), which means this
 * function is the one place the two representations meet.
 */
function runFilterArgs(cmdOpts: RunFilterOptionValues): string[] {
	const args: string[] = [];
	const forward = (flag: string, value?: string): void => {
		if (value !== undefined) args.push(flag, value);
	};
	forward("--run", cmdOpts.run);
	forward("--session", cmdOpts.session);
	forward("--issue", cmdOpts.issue);
	forward("--owner", cmdOpts.owner);
	forward("--team", cmdOpts.team);
	forward("--project", cmdOpts.project);
	forward("--state", cmdOpts.state);
	forward("--runner", cmdOpts.runner);
	forward("--model", cmdOpts.model);
	forward("--comment", cmdOpts.comment);
	forward("--routed-after", cmdOpts.routedAfter);
	return args;
}

/**
 * `cyrus runs …` — list, watch, and wait on agent runs through a stored
 * connection.
 *
 * The three subcommands have distinct success semantics (see `RunsCommand`),
 * and a hidden DEFAULT subcommand preserves the previous
 * `cyrus runs [issue] [--watch]` syntax for one release. Commander dispatches a
 * default subcommand only when no named one matches, which is exactly the rule
 * needed here: `cyrus runs list` reaches `list`, and `cyrus runs NOR-402`
 * reaches the shim.
 */
function registerRunsCommand(
	program: Command,
	packageJson: { version: string },
	errorReporter: ErrorReporter,
): void {
	const runsCommand = program
		.command("runs")
		.description(
			"List, watch, and wait on agent runs through a stored router connection (see `cyrus connection add`)",
		);

	/**
	 * Builds the Application and disposes its watchers so a one-shot run command
	 * exits instead of idling on live `fs.watch` handles.
	 */
	const runRuns = async (
		argv: string[],
		selection: { connection?: string; workspace?: string },
	): Promise<void> => {
		const opts = program.opts();
		const app = new Application(
			opts.cyrusHome,
			opts.envFile,
			packageJson.version,
			errorReporter,
		);
		try {
			await new RunsCommand(app).execute(argv, selection);
		} finally {
			app.disposeWatchers();
		}
	};

	addFleetSelectionOptions(
		addRunFilterOptions(
			runsCommand
				.command("list")
				.description(
					"Print the current run of every agent session in one authorized workspace. Succeeds whatever states it reports.",
				),
		)
			.option(
				"--all-runs",
				"Show every turn's run instead of each session's current one",
			)
			.option("--json", "Emit one JSON document instead of a table"),
	).action(
		async (
			cmdOpts: RunFilterOptionValues & {
				allRuns?: boolean;
				json?: boolean;
				connection?: string;
				workspace?: string;
			},
		) => {
			await runRuns(
				[
					"list",
					...runFilterArgs(cmdOpts),
					...(cmdOpts.allRuns ? ["--all-runs"] : []),
					...(cmdOpts.json ? ["--json"] : []),
				],
				{ connection: cmdOpts.connection, workspace: cmdOpts.workspace },
			);
		},
	);

	addFleetSelectionOptions(
		addRunFilterOptions(
			runsCommand
				.command("watch")
				.description(
					"Follow material fleet changes until timeout or interruption. Run outcomes never fail this command.",
				),
		)
			.option(
				"--timeout <seconds>",
				"Stop watching after this many seconds (exit 0)",
			)
			.option("--json", "Emit newline-delimited JSON events instead of lines"),
	).action(
		async (
			cmdOpts: RunFilterOptionValues & {
				timeout?: string;
				json?: boolean;
				connection?: string;
				workspace?: string;
			},
		) => {
			await runRuns(
				[
					"watch",
					...runFilterArgs(cmdOpts),
					...(cmdOpts.timeout ? ["--timeout", cmdOpts.timeout] : []),
					...(cmdOpts.json ? ["--json"] : []),
				],
				{ connection: cmdOpts.connection, workspace: cmdOpts.workspace },
			);
		},
	);

	addFleetSelectionOptions(
		runsCommand
			.command("wait <runId>")
			.description(
				"Wait for one run to reach a terminal state or report that it is waiting on input",
			)
			.option(
				"--timeout <seconds>",
				"Give up after this many seconds (exit 4, distinct from a worker-reported waiting state)",
			)
			.option("--json", "Emit one JSON document instead of prose"),
	).action(
		async (
			runId: string,
			cmdOpts: {
				timeout?: string;
				json?: boolean;
				connection?: string;
				workspace?: string;
			},
		) => {
			await runRuns(
				[
					"wait",
					runId,
					...(cmdOpts.timeout ? ["--timeout", cmdOpts.timeout] : []),
					...(cmdOpts.json ? ["--json"] : []),
				],
				{ connection: cmdOpts.connection, workspace: cmdOpts.workspace },
			);
		},
	);

	// The deprecated pre-CYR-70 form, as a hidden DEFAULT subcommand: Commander
	// dispatches one only when no named subcommand matches, so `cyrus runs list`
	// reaches `list` while `cyrus runs NOR-402 --watch` and a bare `cyrus runs`
	// reach the shim — parsing, with an actionable notice on stderr, instead of
	// failing outright on upgrade.
	//
	// Hanging it off the PARENT command instead (`runsCommand.argument("[issue]")`
	// plus an action) reads better and would reserve no name, but it is the exact
	// collision `addFleetSelectionOptions` documents: the shim needs `--comment`
	// and `--json`, `list` and `watch` declare the same two, and Commander
	// resolves a parent/child option collision in the PARENT's favour — so
	// `cyrus runs list --comment c1 --json` silently hands `list` an empty option
	// set. `enablePositionalOptions()` does not change that. The cost of the
	// default-subcommand form is one hidden, reachable `cyrus runs __deprecated__`
	// — a name chosen because no Linear issue identifier can look like it, so it
	// reserves nothing an operator could otherwise have typed.
	addFleetSelectionOptions(
		runsCommand
			.command("__deprecated__ [issue]", { isDefault: true, hidden: true })
			.description("Deprecated: use `cyrus runs list|watch|wait`")
			.option("--comment <id>", "Deprecated: use `--comment` on `runs list`")
			.option("--after <timestamp>", "Deprecated: use `--routed-after`")
			.option("--watch", "Deprecated: use `cyrus runs wait <runId>`")
			.option(
				"--timeout <seconds>",
				"Deprecated: use `--timeout` on `runs wait`",
			)
			.option("--json", "Emit JSON"),
	).action(
		async (
			issue: string | undefined,
			cmdOpts: {
				comment?: string;
				after?: string;
				watch?: boolean;
				timeout?: string;
				json?: boolean;
				connection?: string;
				workspace?: string;
			},
		) => {
			const args: string[] = issue ? [issue] : [];
			if (cmdOpts.comment) args.push("--comment", cmdOpts.comment);
			if (cmdOpts.after) args.push("--after", cmdOpts.after);
			if (cmdOpts.watch) args.push("--watch");
			if (cmdOpts.timeout) args.push("--timeout", cmdOpts.timeout);
			if (cmdOpts.json) args.push("--json");
			await runRuns(args, {
				connection: cmdOpts.connection,
				workspace: cmdOpts.workspace,
			});
		},
	);
}
