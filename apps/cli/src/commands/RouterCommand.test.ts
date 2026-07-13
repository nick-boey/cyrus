import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { RouterStore, SecretStore, USER_SECRET_KEYS } from "cyrus-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouterCommand } from "./RouterCommand.js";

// process.exit is called by BaseCommand.exitWithError on any usage error. If a
// happy-path test accidentally takes an error branch, this makes the failure
// surface as a thrown error instead of silently killing the test worker.
vi.spyOn(process, "exit").mockImplementation((code?: number) => {
	throw new Error(`process.exit called with ${code}`);
});

function createMockApp(cyrusHome: string) {
	return {
		cyrusHome,
		logger: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			success: vi.fn(),
			raw: vi.fn((msg: string) => console.log(msg)),
			divider: vi.fn(),
		},
	};
}

describe("RouterCommand", () => {
	let cyrusHome: string;
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		cyrusHome = mkdtempSync(join(tmpdir(), "cyrus-router-cmd-"));
		consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
	});

	afterEach(() => {
		consoleLogSpy.mockRestore();
		rmSync(cyrusHome, { recursive: true, force: true });
	});

	function dbPath(): string {
		return join(cyrusHome, "router", "router.db");
	}

	function printedStdout(): string {
		return consoleLogSpy.mock.calls.map((call) => String(call[0])).join("\n");
	}

	describe("users add", () => {
		it("registers a user, prints an enrollment code + expiry to stdout, and persists to the store", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await command.execute([
				"users",
				"add",
				"alice@example.com",
				"--name",
				"Alice",
			]);

			const printed = printedStdout();
			expect(printed).toMatch(/Enrollment code: [0-9a-f]{64}/);
			expect(printed).toMatch(/Expires: .*\(15 minutes\)/);

			const store = new RouterStore(dbPath());
			try {
				const users = store.listUsers();
				expect(users).toHaveLength(1);
				expect(users[0]?.email).toBe("alice@example.com");
				expect(users[0]?.name).toBe("Alice");
				expect(users[0]?.deviceEnrolled).toBe(false);
			} finally {
				store.close();
			}
		});
	});

	describe("users list", () => {
		it("prints registered users", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute(["users", "add", "bob@example.com"]);
			consoleLogSpy.mockClear();

			await command.execute(["users", "list"]);

			expect(printedStdout()).toContain("bob@example.com");
		});

		it("reports when no users are registered", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await command.execute(["users", "list"]);

			expect(app.logger.info).toHaveBeenCalledWith("No users registered.");
		});
	});

	describe("users remove", () => {
		it("removes a registered user", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute(["users", "add", "carol@example.com"]);

			await command.execute(["users", "remove", "carol@example.com"]);

			const store = new RouterStore(dbPath());
			try {
				expect(store.listUsers()).toHaveLength(0);
			} finally {
				store.close();
			}
		});
	});

	describe("devices revoke", () => {
		it("releases the device's issue locks before revoking the device", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute(["users", "add", "dave@example.com"]);

			// Seed a device + an issue lock directly against the store (the real
			// enrollment path is `cyrus connect`, but redeeming the code is the
			// only way to get a device_id to lock against).
			const seedStore = new RouterStore(dbPath());
			const code = seedStore.mintEnrollmentCode("dave@example.com", Date.now());
			const redeemed = seedStore.redeemEnrollmentCode(code, Date.now());
			expect(redeemed).toBeDefined();
			seedStore.acquireIssueLock("DAVE-1", "session-1", redeemed!.deviceId);
			seedStore.close();

			await command.execute(["devices", "revoke", "dave@example.com"]);

			const verifyStore = new RouterStore(dbPath());
			try {
				expect(verifyStore.getIssueLock("DAVE-1")).toBeUndefined();
				const user = verifyStore
					.listUsers()
					.find((u) => u.email === "dave@example.com");
				expect(user?.deviceEnrolled).toBe(false);
			} finally {
				verifyStore.close();
			}
		});
	});

	describe("unlock", () => {
		it("releases a stuck issue lock by session id", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute(["users", "add", "erin@example.com"]);

			const seedStore = new RouterStore(dbPath());
			const code = seedStore.mintEnrollmentCode("erin@example.com", Date.now());
			const redeemed = seedStore.redeemEnrollmentCode(code, Date.now());
			seedStore.acquireIssueLock("ERIN-2", "session-2", redeemed!.deviceId);
			seedStore.close();

			await command.execute(["unlock", "ERIN-2"]);

			const verifyStore = new RouterStore(dbPath());
			try {
				expect(verifyStore.getIssueLock("ERIN-2")).toBeUndefined();
			} finally {
				verifyStore.close();
			}
		});
	});

	describe("users set-executor", () => {
		it("sets a container executor for a registered user and prints the containers reminder", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute(["users", "add", "frank@example.com"]);
			consoleLogSpy.mockClear();

			await command.execute([
				"users",
				"set-executor",
				"frank@example.com",
				"docker",
			]);

			expect(printedStdout()).toContain(
				"Existing containers for this user will be replaced on their next routed event; idle ones are stopped by the lifecycle sweep.",
			);

			const store = new RouterStore(dbPath());
			try {
				const user = store.findUserForCreator({ email: "frank@example.com" });
				expect(user).toBeDefined();
				expect(store.getUserExecutor(user!.userId)).toBe(
					JSON.stringify({ type: "docker" }),
				);
			} finally {
				store.close();
			}
		});

		it("clears the executor back to device (null)", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute(["users", "add", "flora@example.com"]);
			await command.execute([
				"users",
				"set-executor",
				"flora@example.com",
				"docker",
			]);

			await command.execute([
				"users",
				"set-executor",
				"flora@example.com",
				"device",
			]);

			const store = new RouterStore(dbPath());
			try {
				const user = store.findUserForCreator({ email: "flora@example.com" });
				expect(store.getUserExecutor(user!.userId)).toBeUndefined();
			} finally {
				store.close();
			}
		});

		it("errors clearly for an unknown user", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await expect(
				command.execute([
					"users",
					"set-executor",
					"ghost@example.com",
					"docker",
				]),
			).rejects.toThrow(/process\.exit called with 1/);

			expect(app.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("ghost@example.com"),
			);
		});

		it("errors clearly for an unknown executor type", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute(["users", "add", "gina@example.com"]);

			await expect(
				command.execute([
					"users",
					"set-executor",
					"gina@example.com",
					"potato",
				]),
			).rejects.toThrow(/process\.exit called with 1/);

			expect(app.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("potato"),
			);
		});
	});

	describe("secrets set", () => {
		function secretsPath(): string {
			return join(cyrusHome, "router", "user-secrets.json");
		}

		it("writes the secret to the router's secrets file without echoing the value", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await command.execute([
				"secrets",
				"set",
				"henry@example.com",
				"githubPat",
				"ghp_supersecretvalue",
			]);

			expect(app.logger.success).toHaveBeenCalledWith(
				expect.stringContaining("githubPat"),
			);

			const successCalls = (app.logger.success as ReturnType<typeof vi.fn>).mock
				.calls;
			const errorCalls = (app.logger.error as ReturnType<typeof vi.fn>).mock
				.calls;
			const warnCalls = (app.logger.warn as ReturnType<typeof vi.fn>).mock
				.calls;
			const rawCalls = (app.logger.raw as ReturnType<typeof vi.fn>).mock.calls;
			for (const call of [
				...successCalls,
				...errorCalls,
				...warnCalls,
				...rawCalls,
			]) {
				expect(String(call[0])).not.toContain("ghp_supersecretvalue");
			}

			const secretStore = new SecretStore(secretsPath());
			expect(secretStore.get("henry@example.com").githubPat).toBe(
				"ghp_supersecretvalue",
			);
		});

		it("matches RouterServer's default secrets path (<dirname(dbPath)>/user-secrets.json)", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await command.execute([
				"secrets",
				"set",
				"liam@example.com",
				"gitUserName",
				"Liam",
			]);

			// dbPath() here mirrors RouterCommand.resolveDbPath(); RouterServer
			// derives its default secretsPath as dirname(dbPath)/user-secrets.json
			// (see RouterServer.buildContainerTargets), so the CLI must match
			// exactly or secrets written here would never be seen by the router.
			expect(secretsPath()).toBe(join(dirname(dbPath()), "user-secrets.json"));
			expect(existsSync(secretsPath())).toBe(true);
		});

		it("rejects an unknown secret key and lists the valid ones", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await expect(
				command.execute([
					"secrets",
					"set",
					"henry@example.com",
					"sudoPassword",
					"x",
				]),
			).rejects.toThrow(/process\.exit called with 1/);

			const errorMessage = String(
				(app.logger.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
			);
			for (const key of USER_SECRET_KEYS) {
				expect(errorMessage).toContain(key);
			}
		});
	});

	describe("secrets unset", () => {
		it("removes a previously set secret", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute([
				"secrets",
				"set",
				"ivy@example.com",
				"dotfilesRepo",
				"git@github.com:ivy/dotfiles.git",
			]);

			await command.execute([
				"secrets",
				"unset",
				"ivy@example.com",
				"dotfilesRepo",
			]);

			const secretStore = new SecretStore(
				join(cyrusHome, "router", "user-secrets.json"),
			);
			expect(secretStore.get("ivy@example.com").dotfilesRepo).toBeUndefined();
		});

		it("rejects an unknown secret key", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await expect(
				command.execute(["secrets", "unset", "ivy@example.com", "sshKey"]),
			).rejects.toThrow(/process\.exit called with 1/);
		});
	});

	describe("containers list", () => {
		it("reports when there are no container devices", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await command.execute(["containers", "list"]);

			expect(app.logger.info).toHaveBeenCalledWith("No container devices.");
		});

		it("prints a table with issue key, provider, and user email", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute(["users", "add", "jack@example.com"]);

			const seedStore = new RouterStore(dbPath());
			const user = seedStore.findUserForCreator({ email: "jack@example.com" });
			seedStore.createContainerDevice(user!.userId, "CYPACK-9", "docker");
			seedStore.close();
			consoleLogSpy.mockClear();

			await command.execute(["containers", "list"]);

			const printed = printedStdout();
			expect(printed).toContain("CYPACK-9");
			expect(printed).toContain("docker");
			expect(printed).toContain("jack@example.com");
		});
	});

	describe("containers destroy", () => {
		it("deletes the device row and prints the orphan-GC reminder", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute(["users", "add", "kate@example.com"]);

			const seedStore = new RouterStore(dbPath());
			const user = seedStore.findUserForCreator({ email: "kate@example.com" });
			seedStore.createContainerDevice(user!.userId, "CYPACK-10", "docker");
			seedStore.close();

			await command.execute(["containers", "destroy", "CYPACK-10"]);

			expect(printedStdout()).toContain(
				"Provider resources will be garbage-collected as orphans on the router's next sweep.",
			);

			const verifyStore = new RouterStore(dbPath());
			try {
				expect(
					verifyStore.getContainerDeviceForIssue("CYPACK-10"),
				).toBeUndefined();
			} finally {
				verifyStore.close();
			}
		});

		it("errors clearly when there is no container for the issue", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await expect(
				command.execute(["containers", "destroy", "NOPE-1"]),
			).rejects.toThrow(/process\.exit called with 1/);

			expect(app.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("NOPE-1"),
			);
		});
	});
});
