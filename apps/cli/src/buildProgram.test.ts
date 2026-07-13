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
 * set/unset`, and `router containers list/destroy` (CYPACK task 9 finding 1) —
 * these tests are the regression guard for that class of bug.
 *
 * `Application` and `RouterCommand` are mocked so these tests only assert
 * Commander's parsing/dispatch, not `RouterCommand`'s business logic (already
 * covered by `RouterCommand.test.ts`).
 */

const routerExecute = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const applicationDisposeWatchers = vi.hoisted(() => vi.fn());

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

const { buildProgram } = await import("./buildProgram.js");

function newProgram() {
	return buildProgram({ version: "0.0.0-test" }, new NoopErrorReporter());
}

async function run(argv: string[]) {
	await newProgram().parseAsync(["node", "cyrus", ...argv]);
}

describe("buildProgram — Commander wiring for the container subcommands", () => {
	beforeEach(() => {
		routerExecute.mockClear();
		applicationDisposeWatchers.mockClear();
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

	it("still rejects a genuinely unregistered router subcommand", async () => {
		// Sanity check for the five tests above: confirms Commander actually
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
