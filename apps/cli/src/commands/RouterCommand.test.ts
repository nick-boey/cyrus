import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RouterStore } from "cyrus-router";
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
});
