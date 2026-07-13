import { homedir } from "node:os";
import { resolve } from "node:path";
import { Command } from "commander";
import type { ErrorReporter } from "cyrus-core";
import { Application } from "./Application.js";
import { AuthCommand } from "./commands/AuthCommand.js";
import { CheckTokensCommand } from "./commands/CheckTokensCommand.js";
import { ConnectCommand } from "./commands/ConnectCommand.js";
import { ContainerBootCommand } from "./commands/ContainerBootCommand.js";
import { RefreshTokenCommand } from "./commands/RefreshTokenCommand.js";
import { RouterCommand } from "./commands/RouterCommand.js";
import { SelfAddRepoCommand } from "./commands/SelfAddRepoCommand.js";
import { SelfAuthCommand } from "./commands/SelfAuthCommand.js";
import { StartCommand } from "./commands/StartCommand.js";

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
export function buildProgram(
	packageJson: { version: string },
	errorReporter: ErrorReporter,
): Command {
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
		.option("--env-file <path>", "Path to environment variables file");

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
		.command("revoke <email>")
		.description(
			"Revoke a user's enrolled device, releasing any issue locks it held",
		)
		.action(makeRouterAction("devices", "revoke"));

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

	routerCommand
		.command("unlock <issueId>")
		.description("Release a stuck issue lock")
		.action(makeRouterAction("unlock"));

	// Container-boot command - entrypoint for ephemeral worker containers (see
	// docker/worker/). Driven entirely by environment variables; not intended
	// for interactive use.
	program
		.command("container-boot")
		.description(
			"Internal: boots an ephemeral worker container (restore ladder + launch `cyrus start`). Used as the worker image's ENTRYPOINT.",
		)
		.action(async () => {
			await new ContainerBootCommand().execute([]);
		});

	// Connect command - enroll this device with a running Cyrus Router server
	program
		.command("connect <url>")
		.description(
			"Enroll this device with a Cyrus Router server using a one-time code from `cyrus router users add`",
		)
		.requiredOption("--code <code>", "One-time enrollment code")
		.action(async (url: string, cmdOpts: { code: string }) => {
			const opts = program.opts();
			const app = new Application(
				opts.cyrusHome,
				opts.envFile,
				packageJson.version,
				errorReporter,
			);
			try {
				await new ConnectCommand(app).execute([url, "--code", cmdOpts.code]);
			} finally {
				app.disposeWatchers();
			}
		});

	return program;
}
