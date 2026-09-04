import { NoopErrorReporter } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These tests drive the *real* Commander program the shipped `cyrus` binary
 * parses — `program.parseAsync([...])` — rather than calling a command's
 * `execute()` method directly. Calling `execute()` bypasses Commander's own
 * subcommand registration, so a subcommand that exists on `RouterCommand` but
 * was never wired up in `buildProgram.ts` would still pass an `execute()`
 * based test while being completely unreachable from the real binary. That
 * exact gap shipped for `router users set-executor`, `router secrets
 * set/unset`, and `router containers list/destroy` (CYPACK task 9 finding 1),
 * and then again for `router linear status` — whose own tests called
 * `RouterCommand.linear([...])` directly, so a command Commander rejected with
 * `unknown command 'linear'` looked fully covered. These tests are the
 * regression guard for that class of bug; every router subcommand belongs here.
 *
 * `Application` and `RouterCommand` are mocked so these tests only assert
 * Commander's parsing/dispatch, not `RouterCommand`'s business logic (already
 * covered by `RouterCommand.test.ts`).
 */

const routerExecute = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const runsExecute = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const applicationDisposeWatchers = vi.hoisted(() => vi.fn());
const containerBootExecute = vi.hoisted(() =>
	vi.fn().mockResolvedValue(undefined),
);

// Plain `function`s (not arrows) so they're usable as constructors via `new`
// — `buildProgram.ts` does `new Application(...)` / `new RouterCommand(...)`.
vi.mock("./Application.js", () => ({
	Application: vi.fn().mockImplementation(function FakeApplication() {
		return { disposeWatchers: applicationDisposeWatchers };
	}),
}));

vi.mock("./commands/RouterCommand.js", () => ({
	RouterCommand: vi.fn().mockImplementation(function FakeRouterCommand() {
		return { execute: routerExecute };
	}),
}));

vi.mock("./commands/ContainerBootCommand.js", () => ({
	ContainerBootCommand: vi
		.fn()
		.mockImplementation(function FakeContainerBootCommand() {
			return { execute: containerBootExecute };
		}),
}));

vi.mock("./commands/RunsCommand.js", () => ({
	RunsCommand: vi.fn().mockImplementation(function FakeRunsCommand() {
		return { execute: runsExecute };
	}),
}));

const connectionExecute = vi.hoisted(() =>
	vi.fn().mockResolvedValue(undefined),
);

vi.mock("./commands/ConnectionCommand.js", () => ({
	ConnectionCommand: vi
		.fn()
		.mockImplementation(function FakeConnectionCommand() {
			return { execute: connectionExecute };
		}),
}));

const { buildProgram, REMOTE_PROFILE_COMMANDS, resolveCommandProfile } =
	await import("./buildProgram.js");
const { UsageError } = await import("./remote/errors.js");

function newProgram(options?: {
	argv?: readonly string[];
	env?: NodeJS.ProcessEnv;
}) {
	return buildProgram(
		{ version: "0.0.0-test" },
		new NoopErrorReporter(),
		// Default to an empty environment so an ambient CYRUS_COMMAND_PROFILE on
		// the machine running the suite cannot change which tree is under test.
		{ env: {}, argv: [], ...options },
	);
}

async function run(argv: string[]) {
	await newProgram().parseAsync(["node", "cyrus", ...argv]);
}

/** Top-level command names Commander would actually dispatch. */
function topLevelCommands(program: import("commander").Command): string[] {
	return program.commands.map((command) => command.name()).sort();
}

describe("buildProgram — Commander wiring for the container subcommands", () => {
	beforeEach(() => {
		routerExecute.mockClear();
		runsExecute.mockClear();
		applicationDisposeWatchers.mockClear();
		containerBootExecute.mockClear();
		connectionExecute.mockClear();
	});

	it("registers `router users set-executor <email> <type>`", async () => {
		await run([
			"router",
			"users",
			"set-executor",
			"alice@example.com",
			"docker",
		]);

		expect(routerExecute).toHaveBeenCalledWith([
			"users",
			"set-executor",
			"alice@example.com",
			"docker",
		]);
		expect(applicationDisposeWatchers).toHaveBeenCalledTimes(1);
	});

	it("registers `router secrets set <email> <key> <value>`", async () => {
		await run([
			"router",
			"secrets",
			"set",
			"alice@example.com",
			"githubPat",
			"ghp_xxx",
		]);

		expect(routerExecute).toHaveBeenCalledWith([
			"secrets",
			"set",
			"alice@example.com",
			"githubPat",
			"ghp_xxx",
		]);
	});

	it("registers `router secrets unset <email> <key>`", async () => {
		await run(["router", "secrets", "unset", "alice@example.com", "githubPat"]);

		expect(routerExecute).toHaveBeenCalledWith([
			"secrets",
			"unset",
			"alice@example.com",
			"githubPat",
		]);
	});

	it("registers `router secrets list <email>`", async () => {
		await run(["router", "secrets", "list", "alice@example.com"]);

		expect(routerExecute).toHaveBeenCalledWith([
			"secrets",
			"list",
			"alice@example.com",
		]);
	});

	it("forwards `router secrets list --check-scopes` as a string arg", async () => {
		await run([
			"router",
			"secrets",
			"list",
			"alice@example.com",
			"--check-scopes",
		]);

		expect(routerExecute).toHaveBeenCalledWith([
			"secrets",
			"list",
			"alice@example.com",
			"--check-scopes",
		]);
	});

	it("registers `router secrets migrate` and forwards its flags as string args", async () => {
		await run([
			"router",
			"secrets",
			"migrate",
			"--from",
			"keyvault",
			"--to",
			"table",
		]);

		expect(routerExecute).toHaveBeenCalledWith([
			"secrets",
			"migrate",
			"--from",
			"keyvault",
			"--to",
			"table",
		]);
	});

	it("forwards `router secrets migrate` target overrides and --dry-run", async () => {
		await run([
			"router",
			"secrets",
			"migrate",
			"--from",
			"keyvault",
			"--to",
			"table",
			"--to-endpoint",
			"https://stexample.table.core.windows.net/",
			"--to-key-id",
			"https://kv.vault.azure.net/keys/kek/abc123",
			"--to-table",
			"cyrussetup",
			"--dry-run",
		]);

		expect(routerExecute).toHaveBeenCalledWith([
			"secrets",
			"migrate",
			"--from",
			"keyvault",
			"--to",
			"table",
			"--to-endpoint",
			"https://stexample.table.core.windows.net/",
			"--to-key-id",
			"https://kv.vault.azure.net/keys/kek/abc123",
			"--to-table",
			"cyrussetup",
			"--dry-run",
		]);
	});

	it("registers `router devices list`", async () => {
		await run(["router", "devices", "list"]);

		expect(routerExecute).toHaveBeenCalledWith(["devices", "list"]);
	});

	it("registers `router sessions list`", async () => {
		await run(["router", "sessions", "list"]);

		expect(routerExecute).toHaveBeenCalledWith(["sessions", "list"]);
	});

	it("registers `router operators create-token` and forwards its flags as string args", async () => {
		await run([
			"router",
			"operators",
			"create-token",
			"--label",
			"oncall-laptop",
			"--role",
			"fleet.read",
			"--workspace",
			"workspace-a",
		]);

		expect(routerExecute).toHaveBeenCalledWith([
			"operators",
			"create-token",
			"--label",
			"oncall-laptop",
			"--role",
			"fleet.read",
			"--workspace",
			"workspace-a",
		]);
	});

	it("accumulates repeated `--role` and `--workspace` rather than keeping the last", async () => {
		// Commander keeps only the LAST occurrence without an accumulator, which
		// would silently halve a two-role grant and narrow a two-workspace one.
		await run([
			"router",
			"operators",
			"create-token",
			"--label",
			"sre",
			"--role",
			"fleet.read",
			"--role",
			"fleet.recover",
			"--workspace",
			"workspace-a",
			"--workspace",
			"workspace-b",
		]);

		expect(routerExecute).toHaveBeenCalledWith([
			"operators",
			"create-token",
			"--label",
			"sre",
			"--role",
			"fleet.read",
			"--role",
			"fleet.recover",
			"--workspace",
			"workspace-a",
			"--workspace",
			"workspace-b",
		]);
	});

	it("registers `router operators list`", async () => {
		await run(["router", "operators", "list"]);

		expect(routerExecute).toHaveBeenCalledWith(["operators", "list"]);
	});

	it("registers `router operators revoke <tokenId>`", async () => {
		await run(["router", "operators", "revoke", "3"]);

		expect(routerExecute).toHaveBeenCalledWith(["operators", "revoke", "3"]);
	});

	it("registers `router containers list`", async () => {
		await run(["router", "containers", "list"]);

		expect(routerExecute).toHaveBeenCalledWith(["containers", "list"]);
	});

	it("registers `router containers destroy <issueKey>`", async () => {
		await run(["router", "containers", "destroy", "CYPACK-1"]);

		expect(routerExecute).toHaveBeenCalledWith([
			"containers",
			"destroy",
			"CYPACK-1",
		]);
	});

	it("registers `router containers gc-snapshots --yes`", async () => {
		await run(["router", "containers", "gc-snapshots", "--yes"]);

		expect(routerExecute).toHaveBeenCalledWith([
			"containers",
			"gc-snapshots",
			"--yes",
		]);
	});

	it("registers `router linear status`", async () => {
		await run(["router", "linear", "status"]);

		expect(routerExecute).toHaveBeenCalledWith(["linear", "status"]);
		expect(applicationDisposeWatchers).toHaveBeenCalledTimes(1);
	});

	it("registers `router unlock <issue>`", async () => {
		await run(["router", "unlock", "PAR-169"]);

		expect(routerExecute).toHaveBeenCalledWith(["unlock", "PAR-169"]);
	});

	it("registers `container-boot`", async () => {
		await run(["container-boot"]);

		expect(containerBootExecute).toHaveBeenCalledWith([]);
	});

	it("registers `container-boot --restore-only`", async () => {
		await run(["container-boot", "--restore-only"]);

		expect(containerBootExecute).toHaveBeenCalledWith(["--restore-only"]);
	});

	it("registers `runs` beside `connect` and forwards its filters", async () => {
		await run([
			"runs",
			"NOR-402",
			"--comment",
			"comment-1",
			"--after",
			"2026-09-02T00:00:00.000Z",
			"--watch",
			"--timeout",
			"600",
			"--json",
		]);

		expect(runsExecute).toHaveBeenCalledWith([
			"NOR-402",
			"--comment",
			"comment-1",
			"--after",
			"2026-09-02T00:00:00.000Z",
			"--watch",
			"--timeout",
			"600",
			"--json",
		]);
		expect(applicationDisposeWatchers).toHaveBeenCalledTimes(1);
	});

	it("still rejects a genuinely unregistered router subcommand", async () => {
		// Sanity check for every test above: confirms Commander actually
		// errors on a command that was never registered, so the passing tests
		// aren't passing vacuously (e.g. because unknown subcommands are
		// silently swallowed). exitOverride() replaces Commander's default
		// process.exit(1) with a thrown error so this doesn't kill the test
		// worker; the "does-not-exist" subcommand's error is raised by the
		// `router` subcommand itself, so both it and the top-level program need
		// the override/silenced output.
		const program = newProgram();
		const silence = (cmd: import("commander").Command): void => {
			cmd.exitOverride();
			cmd.configureOutput({ writeErr: () => {}, writeOut: () => {} });
			cmd.commands.forEach(silence);
		};
		silence(program);

		await expect(
			program.parseAsync(["node", "cyrus", "router", "does-not-exist"]),
		).rejects.toThrow();
		expect(routerExecute).not.toHaveBeenCalled();
	});
});

/**
 * The command profile is a PRODUCT and DISCOVERABILITY boundary, not an
 * authorization boundary (ADR 0011). These tests pin what each profile
 * registers; the security proof that a remote operator cannot reach router
 * administration lives server-side, in `OperatorAuthorizer`.
 */
describe("buildProgram — command profiles", () => {
	/**
	 * Commands the remote profile must NOT register: router-server
	 * administration, worker operation, device enrollment, secrets, containers,
	 * and unlock. Naming them explicitly (rather than only asserting the
	 * allowlist) is what makes the acceptance criterion legible in the failure
	 * message when one of them leaks in.
	 */
	const FORBIDDEN_IN_REMOTE = [
		"router",
		"start",
		"connect",
		"container-boot",
		"auth",
		"check-tokens",
		"refresh-token",
		"self-auth-linear",
		"self-add-repo",
	];

	beforeEach(() => {
		connectionExecute.mockClear();
	});

	it("keeps every existing command in the full profile and adds the remote surface", () => {
		const names = topLevelCommands(newProgram());

		for (const existing of FORBIDDEN_IN_REMOTE) {
			expect(names, `full profile dropped "${existing}"`).toContain(existing);
		}
		expect(names).toContain("connection");
		expect(names).toContain("runs");
	});

	it("registers only the approved remote vocabulary under --profile remote", () => {
		const names = topLevelCommands(
			newProgram({ argv: ["node", "cyrus", "--profile", "remote"] }),
		);

		// Subset of the allowlist, not equal to it: `logs`, `recover`, and
		// `skills` are named in the vocabulary but land with CYR-73/76/77. What
		// must hold today is that NOTHING outside the list reaches this profile.
		for (const name of names) {
			expect(
				REMOTE_PROFILE_COMMANDS,
				`"${name}" is registered in the remote profile but is not part of the approved vocabulary`,
			).toContain(name);
		}
		expect(names).toContain("connection");
		expect(names).toContain("runs");
	});

	it("cannot invoke router, worker, enrollment, secret, container, or unlock commands in the remote profile", () => {
		const names = topLevelCommands(
			newProgram({ argv: ["node", "cyrus", "--profile", "remote"] }),
		);

		for (const forbidden of FORBIDDEN_IN_REMOTE) {
			expect(names).not.toContain(forbidden);
		}
	});

	it("rejects a router subcommand at parse time in the remote profile", () => {
		// The allowlist assertion above proves the command was not registered;
		// this proves Commander actually refuses to dispatch it.
		const program = newProgram({
			argv: ["node", "cyrus", "--profile", "remote"],
		});
		const silence = (cmd: import("commander").Command): void => {
			cmd.exitOverride();
			cmd.configureOutput({ writeErr: () => {}, writeOut: () => {} });
			cmd.commands.forEach(silence);
		};
		silence(program);

		return Promise.all([
			// The message must say the COMMAND is unknown. Registering a
			// program-level action to print help instead makes Commander read
			// `router unlock PAR-1` as excess program arguments and report "too
			// many arguments. Expected 0 arguments but got 3", which tells an
			// operator nothing about why the command is unavailable.
			expect(
				program.parseAsync(["node", "cyrus", "router", "unlock", "PAR-1"]),
			).rejects.toThrow(/unknown command 'router'/),
			expect(
				program.parseAsync(["node", "cyrus", "container-boot"]),
			).rejects.toThrow(/unknown command 'container-boot'/),
		]).then(() => {
			expect(routerExecute).not.toHaveBeenCalled();
			expect(containerBootExecute).not.toHaveBeenCalled();
		});
	});

	it("prints help for a bare `cyrus` in the remote profile", async () => {
		// There is no default command in this profile (`start` is not
		// registered), so without help here the binary would exit silently.
		const program = newProgram({
			argv: ["node", "cyrus", "--profile", "remote"],
		});
		const out: string[] = [];
		program.exitOverride();
		program.configureOutput({
			writeErr: (s) => out.push(s),
			writeOut: (s) => out.push(s),
		});

		await expect(program.parseAsync(["node", "cyrus"])).rejects.toMatchObject({
			code: "commander.help",
		});
		expect(out.join("")).toContain("connection");
	});

	it("selects the remote profile from CYRUS_COMMAND_PROFILE", () => {
		const names = topLevelCommands(
			newProgram({ env: { CYRUS_COMMAND_PROFILE: "remote" } }),
		);

		expect(names).toContain("connection");
		expect(names).not.toContain("router");
	});

	it("lets an explicit --profile override the environment default", () => {
		// The same installation must still be able to perform both roles
		// deliberately (ADR 0011).
		const names = topLevelCommands(
			newProgram({
				argv: ["node", "cyrus", "--profile", "full"],
				env: { CYRUS_COMMAND_PROFILE: "remote" },
			}),
		);

		expect(names).toContain("router");
		expect(names).toContain("connection");
	});

	it("defaults to the full profile", () => {
		expect(topLevelCommands(newProgram())).toContain("router");
	});

	it("accepts --profile=remote as well as --profile remote", () => {
		expect(
			topLevelCommands(
				newProgram({ argv: ["node", "cyrus", "--profile=remote"] }),
			),
		).not.toContain("router");
	});

	it("rejects an unknown profile as an invalid invocation", () => {
		// Exit code 2, not the generic 1: an orchestrator branches on the code.
		expect(() =>
			newProgram({ argv: ["node", "cyrus", "--profile", "readonly"] }),
		).toThrow(UsageError);
		expect(() =>
			newProgram({ env: { CYRUS_COMMAND_PROFILE: "readonly" } }),
		).toThrow(UsageError);

		try {
			newProgram({ argv: ["node", "cyrus", "--profile", "readonly"] });
		} catch (error) {
			expect((error as { exitCode: number }).exitCode).toBe(2);
		}
	});

	it("ignores an empty CYRUS_COMMAND_PROFILE rather than failing", () => {
		// An exported-but-empty variable is a very common shell accident, and
		// failing every command on it would be worse than defaulting.
		expect(resolveCommandProfile([], { CYRUS_COMMAND_PROFILE: "" })).toBe(
			"full",
		);
		expect(resolveCommandProfile([], { CYRUS_COMMAND_PROFILE: "  " })).toBe(
			"full",
		);
	});
});

describe("buildProgram — Commander wiring for `connection`", () => {
	beforeEach(() => {
		connectionExecute.mockClear();
		applicationDisposeWatchers.mockClear();
	});

	it("registers `connection add <name> <url> --auth entra`", async () => {
		await run([
			"connection",
			"add",
			"prod",
			"https://router.example.com",
			"--auth",
			"entra",
		]);

		expect(connectionExecute).toHaveBeenCalledWith(
			["add", "prod", "https://router.example.com", "--auth", "entra"],
			{},
		);
		expect(applicationDisposeWatchers).toHaveBeenCalledTimes(1);
	});

	it("registers `connection add … --auth local --token-env <ENV>`", async () => {
		await run([
			"connection",
			"add",
			"dev",
			"http://localhost:8787",
			"--auth",
			"local",
			"--token-env",
			"CYRUS_OPERATOR_TOKEN",
		]);

		expect(connectionExecute).toHaveBeenCalledWith(
			[
				"add",
				"dev",
				"http://localhost:8787",
				"--auth",
				"local",
				"--token-env",
				"CYRUS_OPERATOR_TOKEN",
			],
			{},
		);
	});

	it("registers `connection list`", async () => {
		await run(["connection", "list"]);

		expect(connectionExecute).toHaveBeenCalledWith(["list"], {});
	});

	it("registers `connection show <name>`", async () => {
		await run(["connection", "show", "prod"]);

		expect(connectionExecute).toHaveBeenCalledWith(["show", "prod"], {
			connection: undefined,
			workspace: undefined,
		});
	});

	it("forwards --connection and --workspace to `connection show`", async () => {
		await run([
			"connection",
			"show",
			"--connection",
			"prod",
			"--workspace",
			"ws-1",
		]);

		expect(connectionExecute).toHaveBeenCalledWith(["show"], {
			connection: "prod",
			workspace: "ws-1",
		});
	});

	it("registers `connection remove <name>`", async () => {
		await run(["connection", "remove", "prod"]);

		expect(connectionExecute).toHaveBeenCalledWith(["remove", "prod"], {});
	});

	it("leaves `cyrus connect` device enrollment untouched", async () => {
		// `connect` and `connection` are one letter apart and mean entirely
		// different things: enrolling THIS DEVICE versus naming a remote router
		// to observe. Registering the second must not shadow the first.
		const program = newProgram();
		const names = program.commands.map((command) => command.name());

		expect(names).toContain("connect");
		expect(names).toContain("connection");
		const connect = program.commands.find((c) => c.name() === "connect");
		expect(connect?.description()).toContain("Enroll this device");
	});

	it("does not let `--workspace` on a router command be captured by a fleet flag", async () => {
		// Regression guard: declaring `--workspace` on the PROGRAM makes
		// Commander resolve the collision in the parent's favour, handing
		// `create-token` an empty workspace array — a token authorized over
		// nothing, minted silently.
		await run([
			"router",
			"operators",
			"create-token",
			"--label",
			"sre",
			"--workspace",
			"workspace-a",
			"--workspace",
			"workspace-b",
			"--role",
			"fleet.read",
		]);

		expect(routerExecute).toHaveBeenCalledWith([
			"operators",
			"create-token",
			"--label",
			"sre",
			"--role",
			"fleet.read",
			"--workspace",
			"workspace-a",
			"--workspace",
			"workspace-b",
		]);
	});
});
