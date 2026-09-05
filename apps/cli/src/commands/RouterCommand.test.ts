import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KeyVaultSecretStore, RouterStore, SecretStore } from "cyrus-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RouterCommand } from "./RouterCommand.js";

// process.exit is called by BaseCommand.exitWithError on any usage error. If a
// happy-path test accidentally takes an error branch, this makes the failure
// surface as a thrown error instead of silently killing the test worker.
vi.spyOn(process, "exit").mockImplementation((code?: number) => {
	throw new Error(`process.exit called with ${code}`);
});

// `secrets migrate` runs past argument validation into a real Key Vault call,
// and RouterCommand exposes no seam to inject the store. Without this the test
// depends on how fast the ambient environment fails to reach Azure: on a dev
// laptop DefaultAzureCredential gives up almost immediately, but on a CI runner
// it probes the IMDS endpoint with retries and blew the 5s test timeout.
//
// Mocked at `cyrus-router` rather than at `@azure/identity`: the credential is
// pulled in by a dynamic import inside cyrus-router, which resolves from
// node_modules and is therefore never transformed by vitest, so mocking it
// there has no effect. RouterCommand.ts *is* transformed, so intercepting its
// import is what actually swaps the store out. Everything else is passed
// through untouched. Mirrors the "never make a live Linear call" stub above.
vi.mock("cyrus-router", async (importOriginal) => {
	const actual = await importOriginal<typeof import("cyrus-router")>();
	return {
		...actual,
		KeyVaultSecretStore: class {
			async listEmails(): Promise<string[]> {
				throw new Error("Key Vault unreachable (stubbed in tests)");
			}
		},
	};
});

/**
 * RouterCommand with `resolveIssueGuid` stubbed so `unlock <identifier>` tests
 * never make a live Linear call. Set `resolveResult` to the mapping the stub
 * should return (or leave undefined to simulate an unresolvable identifier);
 * `resolveCalledWith` records whether — and with what — resolution ran.
 */
class StubResolveRouterCommand extends RouterCommand {
	public resolveResult: { id: string; identifier: string } | undefined;
	public resolveCalledWith: string | undefined;
	protected async resolveIssueGuid(
		identifier: string,
	): Promise<{ id: string; identifier: string } | undefined> {
		this.resolveCalledWith = identifier;
		return this.resolveResult;
	}
}

class StubSnapshotGcRouterCommand extends RouterCommand {
	public containersConfig: any;
	public readonly plan = vi.fn(async (_activeIssueKeys: string[]) => [
		{
			id: "snap-orphan",
			issueKey: "OLD-1",
			deviceId: "device-old",
			createdAtUtc: "2026-01-01T00:00:00Z",
		},
	]);
	public readonly gc = vi.fn(
		async (_activeIssueKeys: string[], _plan?: unknown[]) => [
			{ id: "snap-orphan", issueKey: "OLD-1", deviceId: "device-old" },
		],
	);
	protected createAcaSnapshotGcProvider(containers: unknown) {
		this.containersConfig = containers;
		return {
			planOrphanSnapshots: this.plan,
			gcOrphanSnapshots: this.gc,
		};
	}
}

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

	/**
	 * Creates the router db with no rows. Inspection subcommands refuse to run
	 * against a MISSING db (that silently-create-an-empty-db behaviour is what
	 * made `containers list` lie about the live router), so tests covering
	 * genuine empty-state output must bootstrap the file first.
	 */
	function seedEmptyDb(): void {
		mkdirSync(dirname(dbPath()), { recursive: true });
		new RouterStore(dbPath()).close();
	}

	function printedStdout(): string {
		return consoleLogSpy.mock.calls.map((call) => String(call[0])).join("\n");
	}

	function writeAcaRouterConfig(): void {
		writeFileSync(
			join(cyrusHome, "router-config.json"),
			JSON.stringify({
				port: 8787,
				workspaces: { workspace: { linearToken: "token" } },
				webhook: { verificationMode: "direct", secret: "secret" },
				containers: {
					image: "worker:latest",
					routerUrlForContainers: "wss://router.example.com",
					repositories: [],
					aca: {
						subscriptionId: "subscription",
						resourceGroup: "resource-group",
						sandboxGroup: "sandbox-group",
						region: "australiaeast",
						disk: "worker-disk",
					},
				},
			}),
		);
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

		it("shows per-user running and locked session counts", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute(["users", "add", "bob@example.com"]);

			const seedStore = new RouterStore(dbPath());
			const code = seedStore.mintEnrollmentCode("bob@example.com", Date.now());
			const redeemed = seedStore.redeemEnrollmentCode(code, Date.now());
			expect(redeemed).toBeDefined();
			const deviceId = redeemed!.deviceId;
			seedStore.setSessionAffinity(
				"bob-session-1",
				deviceId,
				JSON.stringify({ email: "bob@example.com" }),
			);
			seedStore.setSessionAffinity("bob-session-2", deviceId);
			seedStore.acquireIssueLock("bob-issue-1", "bob-session-1", deviceId);
			seedStore.close();

			consoleLogSpy.mockClear();
			await command.execute(["users", "list"]);

			const printed = printedStdout();
			expect(printed).toContain("RUNNING");
			expect(printed).toContain("LOCKED");
			// bob has 2 running sessions and 1 lock — assert the data row.
			const dataRow = printed
				.split("\n")
				.find((line) => line.includes("bob@example.com"));
			expect(dataRow).toBeDefined();
			expect(dataRow).toMatch(/\byes\b/);
			// ...RUNNING(2)  LOCKED(1) at the end of the row.
			expect(dataRow?.trimEnd()).toMatch(/\s2\s+1$/);
		});

		it("reports when no users are registered", async () => {
			seedEmptyDb();
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

	describe("devices list", () => {
		it("reports when no devices are enrolled", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute(["users", "add", "frank@example.com"]);
			consoleLogSpy.mockClear();

			await command.execute(["devices", "list"]);

			expect(app.logger.info).toHaveBeenCalledWith("No devices enrolled.");
		});

		it("lists enrolled physical and container devices with their owner", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute(["users", "add", "grace@example.com"]);

			const seedStore = new RouterStore(dbPath());
			const code = seedStore.mintEnrollmentCode(
				"grace@example.com",
				Date.now(),
			);
			const redeemed = seedStore.redeemEnrollmentCode(code, Date.now());
			expect(redeemed).toBeDefined();
			const user = seedStore
				.listUsers()
				.find((u) => u.email === "grace@example.com");
			seedStore.createContainerDevice(user!.userId, "GRACE-1", "docker");
			seedStore.close();

			consoleLogSpy.mockClear();
			await command.execute(["devices", "list"]);

			const printed = printedStdout();
			expect(printed).toContain("grace@example.com");
			expect(printed).toContain("device");
			expect(printed).toContain("container");
			expect(printed).toContain("GRACE-1");
			expect(printed).toContain("docker");
		});
	});

	describe("sessions list", () => {
		it("reports when there are no sessions", async () => {
			seedEmptyDb();
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await command.execute(["sessions", "list"]);

			expect(app.logger.info).toHaveBeenCalledWith(
				"No active or locked sessions.",
			);
		});

		it("lists locked, running, and stranded sessions with issue + session ids", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute(["users", "add", "heidi@example.com"]);

			const seedStore = new RouterStore(dbPath());
			const code = seedStore.mintEnrollmentCode(
				"heidi@example.com",
				Date.now(),
			);
			const redeemed = seedStore.redeemEnrollmentCode(code, Date.now());
			expect(redeemed).toBeDefined();
			const deviceId = redeemed!.deviceId;
			// Locked + running session.
			seedStore.setSessionAffinity(
				"session-locked-guid",
				deviceId,
				JSON.stringify({ email: "heidi@example.com" }),
			);
			seedStore.acquireIssueLock(
				"issue-locked-guid",
				"session-locked-guid",
				deviceId,
			);
			// Stranded lock: no matching affinity row.
			seedStore.acquireIssueLock(
				"issue-stranded-guid",
				"session-stranded-guid",
				deviceId,
			);
			seedStore.close();

			consoleLogSpy.mockClear();
			await command.execute(["sessions", "list"]);

			const printed = printedStdout();
			expect(printed).toContain("session-locked-guid");
			expect(printed).toContain("issue-locked-guid");
			expect(printed).toContain("locked");
			expect(printed).toContain("session-stranded-guid");
			expect(printed).toContain("issue-stranded-guid");
			expect(printed).toContain("stranded");
			expect(printed).toContain("heidi@example.com");
			// The unlock hint uses the issue id, the value operators copy.
			expect(printed).toContain("cyrus router unlock");
		});
	});

	describe("operators", () => {
		it("mints a token, prints it exactly once, and stores only its hash", async () => {
			seedEmptyDb();
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await command.execute([
				"operators",
				"create-token",
				"--label",
				"oncall-laptop",
				"--role",
				"fleet.read",
				"--role",
				"fleet.recover",
				"--workspace",
				"workspace-a",
			]);

			const printed = printedStdout();
			const match = printed.match(/Token: (cyop_[0-9a-f]+)/);
			expect(match).not.toBeNull();
			const token = match?.[1] as string;
			expect(printed.split(token).length - 1).toBe(1);

			// The raw token authenticates, and the database holds only its hash.
			const store = new RouterStore(dbPath());
			try {
				const grant = store.getOperatorTokenByToken(token);
				expect(grant?.label).toBe("oncall-laptop");
				expect(grant?.roles.sort()).toEqual(["fleet.read", "fleet.recover"]);
				expect(grant?.workspaceIds).toEqual(["workspace-a"]);
				expect(JSON.stringify(store.listOperatorTokens())).not.toContain(token);
			} finally {
				store.close();
			}
			expect(readFileSync(dbPath()).toString("latin1")).not.toContain(token);
		});

		it("rejects an unknown role rather than storing an unusable grant", async () => {
			seedEmptyDb();
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await expect(
				command.execute([
					"operators",
					"create-token",
					"--label",
					"typo",
					"--role",
					"fleet.admin",
					"--workspace",
					"workspace-a",
				]),
			).rejects.toThrow(/process\.exit/);

			expect(app.logger.error).toHaveBeenCalledWith(
				expect.stringContaining("fleet.admin"),
			);
			const store = new RouterStore(dbPath());
			try {
				expect(store.listOperatorTokens()).toEqual([]);
			} finally {
				store.close();
			}
		});

		it.each([
			["no --role", ["--label", "x", "--workspace", "workspace-a"]],
			["no --workspace", ["--label", "x", "--role", "fleet.read"]],
			["no --label", ["--role", "fleet.read", "--workspace", "workspace-a"]],
		])("rejects create-token with %s", async (_label, args) => {
			// Commander cannot enforce these: `--role`/`--workspace` need a default
			// array for their accumulator, and an option with a default is treated
			// as already satisfied. The check has to live here.
			seedEmptyDb();
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await expect(
				command.execute(["operators", "create-token", ...args]),
			).rejects.toThrow(/process\.exit/);

			const store = new RouterStore(dbPath());
			try {
				expect(store.listOperatorTokens()).toEqual([]);
			} finally {
				store.close();
			}
		});

		it("warns when a token names a workspace this router does not serve", async () => {
			// The authorizer narrows unknown workspaces away, so such a token is
			// 403 on every request — indistinguishable at the point of use from a
			// revoked one, long after the typo.
			seedEmptyDb();
			writeFileSync(
				join(cyrusHome, "router-config.json"),
				JSON.stringify({
					port: 8787,
					workspaces: { "workspace-real": { linearToken: "token" } },
					webhook: { verificationMode: "direct", secret: "secret" },
				}),
			);
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await command.execute([
				"operators",
				"create-token",
				"--label",
				"typo",
				"--role",
				"fleet.read",
				"--workspace",
				"workspace-typo",
			]);

			expect(app.logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("workspace-typo"),
			);
		});

		it("lists grants without ever revealing a token, revoked rows included", async () => {
			seedEmptyDb();
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute([
				"operators",
				"create-token",
				"--label",
				"reader",
				"--role",
				"fleet.read",
				"--workspace",
				"workspace-a",
			]);
			const token = printedStdout().match(/Token: (cyop_[0-9a-f]+)/)?.[1];
			expect(token).toBeDefined();

			consoleLogSpy.mockClear();
			await command.execute(["operators", "list"]);

			const listed = printedStdout();
			expect(listed).toContain("reader");
			expect(listed).toContain("fleet.read");
			expect(listed).toContain("workspace-a");
			expect(listed).not.toContain(token as string);

			await command.execute(["operators", "revoke", "1"]);
			consoleLogSpy.mockClear();
			await command.execute(["operators", "list"]);
			// Revoked rows stay listed: "did my revocation take" is the question
			// this command is opened for.
			expect(printedStdout()).toContain("reader");

			const store = new RouterStore(dbPath());
			try {
				expect(store.getOperatorTokenByToken(token as string)).toBeUndefined();
			} finally {
				store.close();
			}
		});

		it("refuses to revoke a token that is already revoked", async () => {
			seedEmptyDb();
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute([
				"operators",
				"create-token",
				"--label",
				"reader",
				"--role",
				"fleet.read",
				"--workspace",
				"workspace-a",
			]);
			await command.execute(["operators", "revoke", "1"]);

			await expect(
				command.execute(["operators", "revoke", "1"]),
			).rejects.toThrow(/process\.exit/);
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

		it("uses a GUID directly without any Linear resolution when the lock exists", async () => {
			const app = createMockApp(cyrusHome);
			const command = new StubResolveRouterCommand(app as any);
			await command.execute(["users", "add", "ivan@example.com"]);

			const guid = "aaaaaaaa-1111-4222-8333-444444444444";
			const seedStore = new RouterStore(dbPath());
			const code = seedStore.mintEnrollmentCode("ivan@example.com", Date.now());
			const redeemed = seedStore.redeemEnrollmentCode(code, Date.now());
			seedStore.acquireIssueLock(guid, "session-ivan", redeemed!.deviceId);
			seedStore.close();

			// If resolution were (wrongly) attempted, this would send it down a
			// no-result path; asserting resolveCalledWith stays undefined proves the
			// direct GUID path short-circuited before any network call.
			await command.execute(["unlock", guid]);

			expect(command.resolveCalledWith).toBeUndefined();
			const verifyStore = new RouterStore(dbPath());
			try {
				expect(verifyStore.getIssueLock(guid)).toBeUndefined();
			} finally {
				verifyStore.close();
			}
		});

		it("resolves a Linear identifier to its GUID and releases that lock", async () => {
			const app = createMockApp(cyrusHome);
			const command = new StubResolveRouterCommand(app as any);
			await command.execute(["users", "add", "judy@example.com"]);

			const guid = "bbbbbbbb-5555-4666-8777-888888888888";
			const seedStore = new RouterStore(dbPath());
			const code = seedStore.mintEnrollmentCode("judy@example.com", Date.now());
			const redeemed = seedStore.redeemEnrollmentCode(code, Date.now());
			seedStore.acquireIssueLock(guid, "session-judy", redeemed!.deviceId);
			seedStore.close();

			command.resolveResult = { id: guid, identifier: "PAR-169" };
			await command.execute(["unlock", "PAR-169"]);

			expect(command.resolveCalledWith).toBe("PAR-169");
			const verifyStore = new RouterStore(dbPath());
			try {
				expect(verifyStore.getIssueLock(guid)).toBeUndefined();
			} finally {
				verifyStore.close();
			}
			expect(app.logger.success).toHaveBeenCalledWith(
				expect.stringContaining(
					"PAR-169 → bbbbbbbb-5555-4666-8777-888888888888",
				),
			);
		});

		it("reports no lock when the identifier resolves but nothing is locked", async () => {
			seedEmptyDb();
			const app = createMockApp(cyrusHome);
			const command = new StubResolveRouterCommand(app as any);

			command.resolveResult = {
				id: "cccccccc-9999-4000-8111-222222222222",
				identifier: "PAR-404",
			};
			await command.execute(["unlock", "PAR-404"]);

			expect(app.logger.info).toHaveBeenCalledWith(
				"No lock found for issue PAR-404 (resolved to cccccccc-9999-4000-8111-222222222222).",
			);
		});

		it("errors clearly when a Linear identifier cannot be resolved", async () => {
			seedEmptyDb();
			const app = createMockApp(cyrusHome);
			const command = new StubResolveRouterCommand(app as any);

			command.resolveResult = undefined;
			// exitWithError calls process.exit, mocked at the top to throw.
			await expect(command.execute(["unlock", "PAR-999"])).rejects.toThrow();

			expect(app.logger.error).toHaveBeenCalledWith(
				expect.stringContaining('Could not resolve Linear issue "PAR-999"'),
			);
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
			seedEmptyDb();
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

		/**
		 * Writes a minimal, schema-valid `router-config.json` to `cyrusHome`.
		 * Pass `containers` to include an (also schema-valid) `containers` block,
		 * optionally overriding `secretsPath`.
		 */
		function writeRouterConfig(containers?: {
			secretsPath?: string;
			keyVaultUrl?: string;
		}): void {
			const config: Record<string, unknown> = {
				port: 8787,
				workspaces: {},
				webhook: { verificationMode: "direct", secret: "shh" },
			};
			if (containers) {
				config.containers = {
					image: "ghcr.io/example/cyrus-worker:latest",
					routerUrlForContainers: "ws://host.docker.internal:8787",
					repositories: [],
					...containers,
				};
			}
			writeFileSync(
				join(cyrusHome, "router-config.json"),
				JSON.stringify(config, null, 2),
			);
		}

		it("writes the secret to the router's secrets file without echoing the value", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await command.execute([
				"secrets",
				"set",
				"henry@example.com",
				"GIT_TOKEN",
				"ghp_supersecretvalue",
			]);

			expect(app.logger.success).toHaveBeenCalledWith(
				expect.stringContaining("GIT_TOKEN"),
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
			expect(secretStore.get("henry@example.com").GIT_TOKEN).toBe(
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
				"GIT_USER_NAME",
				"Liam",
			]);

			// dbPath() here mirrors RouterCommand.resolveDbPath(); RouterServer
			// derives its default secretsPath as dirname(dbPath)/user-secrets.json
			// (see RouterServer.buildContainerTargets), so the CLI must match
			// exactly or secrets written here would never be seen by the router.
			expect(secretsPath()).toBe(join(dirname(dbPath()), "user-secrets.json"));
			expect(existsSync(secretsPath())).toBe(true);
		});

		it("honors containers.secretsPath from router-config.json instead of the default", async () => {
			const overridePath = join(cyrusHome, "custom-secrets.json");
			writeRouterConfig({ secretsPath: overridePath });

			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await command.execute([
				"secrets",
				"set",
				"maya@example.com",
				"GIT_TOKEN",
				"ghp_overridevalue",
			]);

			// Written to the configured override, not the default path — this is
			// the exact path RouterServer.buildContainerTargets will read from
			// (`containers.secretsPath ?? <default>`), so the CLI and the running
			// router must agree on it.
			expect(existsSync(overridePath)).toBe(true);
			expect(existsSync(secretsPath())).toBe(false);

			const secretStore = new SecretStore(overridePath);
			expect(secretStore.get("maya@example.com").GIT_TOKEN).toBe(
				"ghp_overridevalue",
			);
		});

		it("selects the Key Vault backend when containers.keyVaultUrl is configured", () => {
			writeRouterConfig({ keyVaultUrl: "https://example.vault.azure.net" });
			const command = new RouterCommand(createMockApp(cyrusHome) as any);
			const store = (command as any).openSecretStore();
			expect(store).toBeInstanceOf(KeyVaultSecretStore);
		});

		it("fails instead of falling back to a local success for malformed router config", async () => {
			writeFileSync(join(cyrusHome, "router-config.json"), "{ invalid azure");
			const app = createMockApp(cyrusHome);

			await expect(
				new RouterCommand(app as any).execute([
					"secrets",
					"set",
					"azure@example.com",
					"GIT_TOKEN",
					"must-not-be-local",
				]),
			).rejects.toThrow("Failed to parse");
			expect(existsSync(secretsPath())).toBe(false);
			expect(app.logger.success).not.toHaveBeenCalled();
		});

		it("refuses to migrate without both endpoints configured", async () => {
			// The documented cutover keeps tableStore out of config until after
			// migration, which is exactly why source and target are named
			// explicitly rather than inferred — but the target block still has to
			// be present in the file for the command to have somewhere to write.
			writeFileSync(
				join(cyrusHome, "router-config.json"),
				JSON.stringify({
					port: 8787,
					workspaces: {},
					webhook: { verificationMode: "direct", secret: "shh" },
					containers: {
						image: "worker:latest",
						routerUrlForContainers: "wss://router.example.com",
						repositories: [],
						keyVaultUrl: "https://vault.vault.azure.net",
					},
				}),
			);
			const app = createMockApp(cyrusHome);
			await expect(
				new RouterCommand(app as any).execute([
					"secrets",
					"migrate",
					"--from",
					"keyvault",
					"--to",
					"table",
				]),
			).rejects.toThrow(/process\.exit/);
			expect(app.logger.error).toHaveBeenCalledWith(
				expect.stringMatching(/containers\.tableStore/),
			);
		});

		it("accepts an explicit target so migration can precede the config flip", async () => {
			// R2-04: the documented cutover migrates BEFORE containers.tableStore
			// is added, so requiring it in config made the runbook unrunnable.
			writeFileSync(
				join(cyrusHome, "router-config.json"),
				JSON.stringify({
					port: 8787,
					workspaces: {},
					webhook: { verificationMode: "direct", secret: "shh" },
					containers: {
						image: "worker:latest",
						routerUrlForContainers: "wss://router.example.com",
						repositories: [],
						keyVaultUrl: "https://vault.vault.azure.net",
					},
				}),
			);
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			// Reaches the Azure call and fails there, not on argument validation —
			// which is what proves the target was accepted without config.
			await expect(
				command.execute([
					"secrets",
					"migrate",
					"--from",
					"keyvault",
					"--to",
					"table",
					"--dry-run",
					"--to-endpoint",
					"https://stexample.table.core.windows.net",
					"--to-key-id",
					`https://vault.vault.azure.net/keys/kek/${"a".repeat(32)}`,
				]),
				// Asserting the STUB's message, not just "it threw": that is what
				// proves execution reached the Key Vault call rather than bailing
				// out earlier for an unrelated reason.
			).rejects.toThrow(/Key Vault unreachable \(stubbed in tests\)/);
			expect(app.logger.error).not.toHaveBeenCalledWith(
				expect.stringMatching(/Migration target is not configured/),
			);
		});

		it("rejects an unsupported migration direction", async () => {
			const app = createMockApp(cyrusHome);
			await expect(
				new RouterCommand(app as any).execute([
					"secrets",
					"migrate",
					"--from",
					"table",
					"--to",
					"keyvault",
				]),
			).rejects.toThrow(/process\.exit/);
			expect(app.logger.error).toHaveBeenCalledWith(
				expect.stringMatching(/Usage/),
			);
		});

		it("selects the Table backend over Key Vault, and survives the schema", async () => {
			// tableStore is stripped on EVERY `router start` if it is not modelled
			// in RouterConfigFileSchema, so this asserts the field both parses and
			// wins the precedence contest against keyVaultUrl.
			writeFileSync(
				join(cyrusHome, "router-config.json"),
				JSON.stringify({
					port: 8787,
					workspaces: {},
					webhook: { verificationMode: "direct", secret: "shh" },
					containers: {
						image: "worker:latest",
						routerUrlForContainers: "wss://router.example.com",
						repositories: [],
						keyVaultUrl: "https://vault.vault.azure.net",
						tableStore: {
							endpoint: "https://stexample.table.core.windows.net",
							keyId: `https://vault.vault.azure.net/keys/kek/${"a".repeat(32)}`,
						},
					},
				}),
			);
			const command = new RouterCommand(createMockApp(cyrusHome) as any);
			const store = (command as any).openSecretStore();
			expect(store.constructor.name).toBe("TableSecretStore");
		});

		it("keeps Codex credential-store config through the schema", () => {
			const codex = {
				clientId: "codex-client-id",
				keyId: `https://vault.vault.azure.net/keys/codex/${"b".repeat(32)}`,
				localKeyPath: join(cyrusHome, "codex-kek.key"),
			};
			writeFileSync(
				join(cyrusHome, "router-config.json"),
				JSON.stringify({
					port: 8787,
					workspaces: {},
					webhook: { verificationMode: "direct", secret: "shh" },
					containers: {
						image: "worker:latest",
						routerUrlForContainers: "wss://router.example.com",
						repositories: [],
						codex,
					},
				}),
			);

			const command = new RouterCommand(createMockApp(cyrusHome) as any);
			const config = (command as any).readRouterConfig();
			expect(config.containers.codex).toEqual(codex);
		});

		it("keeps setupUi through the config schema", async () => {
			writeFileSync(
				join(cyrusHome, "router-config.json"),
				JSON.stringify({
					port: 8787,
					workspaces: {},
					webhook: { verificationMode: "direct", secret: "shh" },
					setupUi: {
						enabled: true,
						auth: { mode: "entra-token", idTokenAudience: "client-guid" },
					},
				}),
			);
			const command = new RouterCommand(createMockApp(cyrusHome) as any);
			const config = (command as any).readRouterConfig();
			expect(config.setupUi).toEqual({
				enabled: true,
				auth: { mode: "entra-token", idTokenAudience: "client-guid" },
			});
		});

		it("fails all secret operations for schema-invalid router config", async () => {
			writeFileSync(
				join(cyrusHome, "router-config.json"),
				JSON.stringify({ containers: { keyVaultUrl: "https://vault" } }),
			);
			for (const args of [
				["secrets", "set", "a@example.com", "GIT_TOKEN", "x"],
				["secrets", "unset", "a@example.com", "GIT_TOKEN"],
				["secrets", "list", "a@example.com"],
			]) {
				await expect(
					new RouterCommand(createMockApp(cyrusHome) as any).execute(args),
				).rejects.toThrow("Invalid router config");
			}
		});

		it.each([
			["autoSuspendSeconds", -1],
			["keepSnapshots", -1],
			["keepSnapshots", 1.5],
			["disconnectedRecreateMs", -1],
			[
				"egress",
				{
					defaultAction: "Deny",
					trafficInspection: "Full",
					hostRules: [{ pattern: " ", action: "Allow" }],
				},
			],
		])("rejects invalid ACA config %s=%s", async (field, value) => {
			writeFileSync(
				join(cyrusHome, "router-config.json"),
				JSON.stringify({
					port: 8787,
					workspaces: {},
					webhook: { verificationMode: "direct", secret: "shh" },
					containers: {
						image: "worker:latest",
						routerUrlForContainers: "wss://router.example.com",
						repositories: [],
						aca: {
							subscriptionId: "sub",
							resourceGroup: "rg",
							sandboxGroup: "sg",
							region: "eastus",
							disk: "disk",
							[field]: value,
						},
					},
				}),
			);

			await expect(
				new RouterCommand(createMockApp(cyrusHome) as any).execute([
					"secrets",
					"list",
					"a@example.com",
				]),
			).rejects.toThrow("Invalid router config");
		});

		it("falls back to the default secrets path when router-config.json has no containers block", async () => {
			writeRouterConfig();

			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await command.execute([
				"secrets",
				"set",
				"noah@example.com",
				"GIT_TOKEN",
				"ghp_defaultvalue",
			]);

			expect(existsSync(secretsPath())).toBe(true);
			const secretStore = new SecretStore(secretsPath());
			expect(secretStore.get("noah@example.com").GIT_TOKEN).toBe(
				"ghp_defaultvalue",
			);
		});

		it("rejects a reserved env key on set", async () => {
			const app = createMockApp(cyrusHome);
			await expect(
				new RouterCommand(app as any).execute([
					"secrets",
					"set",
					"henry@example.com",
					"CYRUS_ROUTER_URL",
					"http://evil",
				]),
			).rejects.toThrow(/process\.exit called with 1/);
			const msg = String(
				(app.logger.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
			);
			expect(msg).toContain("reserved env var");
			expect(msg).toContain("CYRUS_ROUTER_URL");
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
				"DOTFILES_REPO",
				"git@github.com:ivy/dotfiles.git",
			]);

			await command.execute([
				"secrets",
				"unset",
				"ivy@example.com",
				"DOTFILES_REPO",
			]);

			const secretStore = new SecretStore(
				join(cyrusHome, "router", "user-secrets.json"),
			);
			expect(secretStore.get("ivy@example.com").DOTFILES_REPO).toBeUndefined();
		});

		it("rejects a reserved env key on unset", async () => {
			const app = createMockApp(cyrusHome);
			await expect(
				new RouterCommand(app as any).execute([
					"secrets",
					"unset",
					"ivy@example.com",
					"NODE_OPTIONS",
				]),
			).rejects.toThrow(/process\.exit called with 1/);
			const msg = String(
				(app.logger.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[0],
			);
			expect(msg).toContain("reserved env var");
			expect(msg).toContain("NODE_OPTIONS");
		});
	});

	describe("secrets list", () => {
		it("lists stored keys masked and reports fully authenticated (default set)", async () => {
			const app = createMockApp(cyrusHome);
			await new RouterCommand(app as any).execute([
				"secrets",
				"set",
				"ivy@example.com",
				"CLAUDE_CODE_OAUTH_TOKEN",
				"claude-secret-value",
			]);
			const app2 = createMockApp(cyrusHome);
			await new RouterCommand(app2 as any).execute([
				"secrets",
				"list",
				"ivy@example.com",
			]);
			const raw = (app2.logger.raw as ReturnType<typeof vi.fn>).mock.calls
				.map((c) => String(c[0]))
				.join("\n");
			expect(raw).toContain("CLAUDE_CODE_OAUTH_TOKEN = ****");
			expect(raw).not.toContain("claude-secret-value");
			expect(app2.logger.success).toHaveBeenCalledWith(
				expect.stringContaining("fully authenticated"),
			);
		});

		it("flags a required key missing per containers.requiredSecretKeys", async () => {
			writeFileSync(
				join(cyrusHome, "router-config.json"),
				JSON.stringify({
					port: 8787,
					workspaces: {},
					webhook: { verificationMode: "direct", secret: "shh" },
					containers: {
						image: "ghcr.io/example/cyrus-worker:latest",
						routerUrlForContainers: "ws://host.docker.internal:8787",
						repositories: [],
						requiredSecretKeys: ["GIT_TOKEN"],
					},
				}),
			);
			const app = createMockApp(cyrusHome);
			await new RouterCommand(app as any).execute([
				"secrets",
				"set",
				"kai@example.com",
				"CLAUDE_CODE_OAUTH_TOKEN",
				"claude-tok",
			]);
			const app2 = createMockApp(cyrusHome);
			await new RouterCommand(app2 as any).execute([
				"secrets",
				"list",
				"kai@example.com",
			]);
			expect(app2.logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("missing GIT_TOKEN"),
			);
		});
	});

	describe("secrets list --check-scopes", () => {
		const GH_SECRET = "ghp_tokenvalue_must_never_be_printed";

		/** Stubs global fetch (what probeGitHubTokenScopes falls back to). */
		const stubGitHubScopes = (scopes: string | null) =>
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => ({
					ok: true,
					status: 200,
					headers: new Headers(
						scopes === null ? {} : { "x-oauth-scopes": scopes },
					),
				})),
			);

		const seedGhToken = async (email: string) => {
			const app = createMockApp(cyrusHome);
			await new RouterCommand(app as any).execute([
				"secrets",
				"set",
				email,
				"GH_TOKEN",
				GH_SECRET,
			]);
		};

		afterEach(() => {
			vi.unstubAllGlobals();
		});

		it("accepts a token missing only read:org: warns, still fully authenticated", async () => {
			stubGitHubScopes("repo");
			await seedGhToken("nia@example.com");
			const app = createMockApp(cyrusHome);
			await new RouterCommand(app as any).execute([
				"secrets",
				"set",
				"nia@example.com",
				"CLAUDE_CODE_OAUTH_TOKEN",
				"claude-tok",
			]);

			const app2 = createMockApp(cyrusHome);
			await new RouterCommand(app2 as any).execute([
				"secrets",
				"list",
				"nia@example.com",
				"--check-scopes",
			]);

			const warnings = (app2.logger.warn as ReturnType<typeof vi.fn>).mock.calls
				.map((c) => String(c[0]))
				.join("\n");
			expect(warnings).toContain("read:org");
			// Missing read:org must NOT change the authentication verdict.
			expect(app2.logger.success).toHaveBeenCalledWith(
				expect.stringContaining("fully authenticated"),
			);
		});

		it("accepts a token with no scopes at all: warns without failing", async () => {
			stubGitHubScopes("");
			await seedGhToken("omar@example.com");
			const app = createMockApp(cyrusHome);
			await new RouterCommand(app as any).execute([
				"secrets",
				"set",
				"omar@example.com",
				"CLAUDE_CODE_OAUTH_TOKEN",
				"claude-tok",
			]);

			const app2 = createMockApp(cyrusHome);
			await new RouterCommand(app2 as any).execute([
				"secrets",
				"list",
				"omar@example.com",
				"--check-scopes",
			]);

			const warnings = (app2.logger.warn as ReturnType<typeof vi.fn>).mock.calls
				.map((c) => String(c[0]))
				.join("\n");
			expect(warnings).toContain('missing "repo"');
			expect(app2.logger.error).not.toHaveBeenCalled();
			expect(app2.logger.success).toHaveBeenCalledWith(
				expect.stringContaining("fully authenticated"),
			);
		});

		it("never prints the token value in any diagnostic output", async () => {
			stubGitHubScopes("repo, read:org");
			await seedGhToken("pia@example.com");

			const app2 = createMockApp(cyrusHome);
			await new RouterCommand(app2 as any).execute([
				"secrets",
				"list",
				"pia@example.com",
				"--check-scopes",
			]);

			const everything = (
				["raw", "info", "warn", "success", "error"] as const
			).flatMap((channel) =>
				(app2.logger[channel] as ReturnType<typeof vi.fn>).mock.calls.map((c) =>
					String(c[0]),
				),
			);
			const output = everything.join("\n");
			expect(output).not.toContain(GH_SECRET);
			expect(output).toContain("GH_TOKEN = ****");
			expect(output).toContain("scopes = repo, read:org");
		});

		it("skips the probe (no network call) when no GitHub token is stored", async () => {
			const fetchSpy = vi.fn();
			vi.stubGlobal("fetch", fetchSpy);
			const app = createMockApp(cyrusHome);
			await new RouterCommand(app as any).execute([
				"secrets",
				"set",
				"quinn@example.com",
				"CLAUDE_CODE_OAUTH_TOKEN",
				"claude-tok",
			]);

			const app2 = createMockApp(cyrusHome);
			await new RouterCommand(app2 as any).execute([
				"secrets",
				"list",
				"quinn@example.com",
				"--check-scopes",
			]);

			expect(fetchSpy).not.toHaveBeenCalled();
			expect(app2.logger.info).toHaveBeenCalledWith(
				expect.stringContaining("No GitHub token stored"),
			);
		});

		it("does not probe at all without the flag", async () => {
			const fetchSpy = vi.fn();
			vi.stubGlobal("fetch", fetchSpy);
			await seedGhToken("ravi@example.com");

			const app2 = createMockApp(cyrusHome);
			await new RouterCommand(app2 as any).execute([
				"secrets",
				"list",
				"ravi@example.com",
			]);

			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("still completes when the GitHub probe fails outright", async () => {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => {
					throw new Error(`ECONNREFUSED ${GH_SECRET}`);
				}),
			);
			await seedGhToken("sana@example.com");

			const app2 = createMockApp(cyrusHome);
			await new RouterCommand(app2 as any).execute([
				"secrets",
				"list",
				"sana@example.com",
				"--check-scopes",
			]);

			const warnings = (app2.logger.warn as ReturnType<typeof vi.fn>).mock.calls
				.map((c) => String(c[0]))
				.join("\n");
			expect(warnings).toContain("could not verify scopes");
			expect(warnings).not.toContain(GH_SECRET);
			expect(app2.logger.error).not.toHaveBeenCalled();
		});
	});

	describe("observability.logSource", () => {
		const WORKSPACE_GUID = "99999999-9999-9999-9999-999999999999";
		const RESOURCE_ID = `/subscriptions/${WORKSPACE_GUID}/resourceGroups/cyrus/providers/Microsoft.OperationalInsights/workspaces/cyrus-logs`;

		/** Writes a minimal router config with `observability` folded in. */
		function writeObservabilityConfig(observability: unknown): void {
			writeFileSync(
				join(cyrusHome, "router-config.json"),
				JSON.stringify({
					port: 8787,
					workspaces: {},
					webhook: { verificationMode: "direct", secret: "shh" },
					...(observability === undefined ? {} : { observability }),
				}),
			);
		}

		function readConfig(): any {
			return (
				new RouterCommand(createMockApp(cyrusHome) as any) as any
			).readRouterConfig();
		}

		function expectRejected(observability: unknown): void {
			writeObservabilityConfig(observability);
			expect(() => readConfig()).toThrow("Invalid router config");
		}

		it("leaves the router unconfigured when no log source is declared", () => {
			writeObservabilityConfig(undefined);

			const config = readConfig();

			// The acceptance criterion is "starts unchanged": no `fleetOperations`
			// invented, so `RouterServer.servedOperatorCapabilities` never advertises
			// `logs.query` and the context document carries no descriptor.
			expect(config.observability).toBeUndefined();
			expect(config.fleetOperations).toBeUndefined();
		});

		it("normalizes an Azure source into the credential-free wire descriptor", () => {
			writeObservabilityConfig({
				logSource: {
					kind: "azure-log-analytics",
					displayName: "cyrus-prod",
					workspaceId: WORKSPACE_GUID,
					resourceId: RESOURCE_ID,
					cloud: "AzureGovernment",
					defaults: {
						lookbackMinutes: 30,
						maximumRangeHours: 12,
						maximumRecords: 2500,
						followPollSeconds: 20,
					},
				},
			});

			const config = readConfig();

			// The friendly alias is CONSUMED: what reaches RouterServerConfig is the
			// v1 descriptor and nothing else, so there is one shape downstream.
			expect(config.observability).toBeUndefined();
			expect(config.fleetOperations?.logSource).toEqual({
				schemaVersion: 1,
				kind: "azure-log-analytics",
				displayName: "cyrus-prod",
				azure: {
					workspaceId: WORKSPACE_GUID,
					// Owned by the adapter, never by router configuration — an operator
					// cannot name a table and the config has no field to name one in.
					table: "ContainerAppConsoleLogs_CL",
					cloud: "AzureUSGovernment",
					resourceId: RESOURCE_ID,
				},
				budgets: {
					defaultLookbackSeconds: 1800,
					maxRangeSeconds: 43_200,
					maxRecords: 2500,
					minFollowIntervalSeconds: 20,
				},
			});
		});

		it("applies the documented budget defaults when none are declared", () => {
			writeObservabilityConfig({
				logSource: { kind: "azure-log-analytics", workspaceId: WORKSPACE_GUID },
			});

			expect(readConfig().fleetOperations?.logSource).toEqual({
				schemaVersion: 1,
				kind: "azure-log-analytics",
				azure: {
					workspaceId: WORKSPACE_GUID,
					table: "ContainerAppConsoleLogs_CL",
				},
				budgets: {
					defaultLookbackSeconds: 900,
					maxRangeSeconds: 86_400,
					maxRecords: 5000,
					minFollowIntervalSeconds: 15,
				},
			});
		});

		it("merges partial defaults over the documented ones rather than dropping the rest", () => {
			writeObservabilityConfig({
				logSource: {
					kind: "azure-log-analytics",
					workspaceId: WORKSPACE_GUID,
					defaults: { maximumRecords: 100 },
				},
			});

			expect(readConfig().fleetOperations?.logSource.budgets).toEqual({
				defaultLookbackSeconds: 900,
				maxRangeSeconds: 86_400,
				maxRecords: 100,
				minFollowIntervalSeconds: 15,
			});
		});

		it.each([
			["not a GUID", "cyrus-prod-logs"],
			["a GUID with surrounding whitespace", ` ${WORKSPACE_GUID} `],
			["empty", ""],
			["braced", `{${WORKSPACE_GUID}}`],
		])("rejects a workspace ID that is %s", (_label, workspaceId) => {
			// A Log Analytics workspace is addressed by its customer ID. Accepting
			// anything else defers the failure to the operator's own client, which
			// fails against Azure with a 404 that reads as a permissions problem.
			expectRejected({
				logSource: { kind: "azure-log-analytics", workspaceId },
			});
		});

		it.each([
			// The descriptor's whole safety property is that it cannot carry a way to
			// reach a backend other than the one the deployment provisioned. A strict
			// schema is what keeps an endpoint, an authority host, or a credential
			// from being smuggled in beside the workspace ID.
			["an endpoint override", { endpoint: "https://attacker.example" }],
			[
				"an authority host override",
				{ authorityHost: "https://attacker.example" },
			],
			["a shared key", { sharedKey: "c2VjcmV0" }],
			["a connection string", { connectionString: "InstrumentationKey=abc" }],
			["a table override", { table: "Attacker_CL" }],
			["a raw KQL query", { query: "ContainerAppConsoleLogs_CL | take 1" }],
		])("refuses %s beside the workspace ID", (_label, extra) => {
			expectRejected({
				logSource: {
					kind: "azure-log-analytics",
					workspaceId: WORKSPACE_GUID,
					...extra,
				},
			});
		});

		it.each([
			["a URL", "https://attacker.example/logs"],
			["a bare hostname", "attacker.example"],
			[
				"another resource provider",
				`/subscriptions/${WORKSPACE_GUID}/resourceGroups/cyrus/providers/Microsoft.Storage/storageAccounts/exfil`,
			],
			["a relative path", "../../attacker"],
		])("refuses a resource ID that is %s", (_label, resourceId) => {
			// `resourceId` is the one free-form Azure field, so it is the one place an
			// endpoint could hide. Pinned to an Operational Insights workspace ARM id.
			expectRejected({
				logSource: {
					kind: "azure-log-analytics",
					workspaceId: WORKSPACE_GUID,
					resourceId,
				},
			});
		});

		it("refuses a cloud this adapter does not know", () => {
			expectRejected({
				logSource: {
					kind: "azure-log-analytics",
					workspaceId: WORKSPACE_GUID,
					cloud: "https://attacker.example",
				},
			});
		});

		it("refuses a source kind the router cannot describe", () => {
			expectRejected({
				logSource: { kind: "splunk", workspaceId: WORKSPACE_GUID },
			});
		});

		it.each([
			["lookbackMinutes", 0],
			["lookbackMinutes", -1],
			["lookbackMinutes", 1.5],
			["lookbackMinutes", 525_601],
			["maximumRangeHours", 0],
			["maximumRangeHours", -1],
			["maximumRangeHours", 0.5],
			["maximumRangeHours", 8761],
			["maximumRecords", 0],
			["maximumRecords", -1],
			["maximumRecords", 10.5],
			["maximumRecords", 1_000_001],
			["followPollSeconds", 0],
			["followPollSeconds", -1],
			["followPollSeconds", 2.5],
			["followPollSeconds", 86_401],
		])("rejects the budget %s=%s", (field, value) => {
			expectRejected({
				logSource: {
					kind: "azure-log-analytics",
					workspaceId: WORKSPACE_GUID,
					defaults: { [field]: value },
				},
			});
		});

		it("rejects a default lookback longer than the maximum range", () => {
			// The wire schema refuses this too, but there it surfaces as a router that
			// starts cleanly and 500s the one authenticated operator route. Caught at
			// config-parse time it is a startup error naming the field.
			expectRejected({
				logSource: {
					kind: "azure-log-analytics",
					workspaceId: WORKSPACE_GUID,
					defaults: { lookbackMinutes: 120, maximumRangeHours: 1 },
				},
			});
		});

		it("accepts a default lookback exactly equal to the maximum range", () => {
			writeObservabilityConfig({
				logSource: {
					kind: "azure-log-analytics",
					workspaceId: WORKSPACE_GUID,
					defaults: { lookbackMinutes: 60, maximumRangeHours: 1 },
				},
			});

			expect(readConfig().fleetOperations?.logSource.budgets).toMatchObject({
				defaultLookbackSeconds: 3600,
				maxRangeSeconds: 3600,
			});
		});

		it("refuses a config that declares the log source twice", () => {
			// Two spellings of one setting is a silent-precedence bug waiting to
			// happen: whichever lost would be edited for hours with no effect.
			writeFileSync(
				join(cyrusHome, "router-config.json"),
				JSON.stringify({
					port: 8787,
					workspaces: {},
					webhook: { verificationMode: "direct", secret: "shh" },
					observability: {
						logSource: {
							kind: "azure-log-analytics",
							workspaceId: WORKSPACE_GUID,
						},
					},
					fleetOperations: {
						logSource: {
							schemaVersion: 1,
							kind: "azure-log-analytics",
							azure: {
								workspaceId: WORKSPACE_GUID,
								table: "ContainerAppConsoleLogs_CL",
							},
							budgets: {
								defaultLookbackSeconds: 900,
								maxRangeSeconds: 86_400,
								maxRecords: 5000,
								minFollowIntervalSeconds: 15,
							},
						},
					},
				}),
			);

			expect(() => readConfig()).toThrow("Invalid router config");
		});

		it("keeps the descriptor form for a deployment that renders it whole", () => {
			// `main.bicep` renders the v1 descriptor directly into
			// CYRUS_ROUTER_FLEET_OPERATIONS_JSON, so the alias must not displace it.
			const logSource = {
				schemaVersion: 1,
				kind: "azure-log-analytics",
				azure: {
					workspaceId: WORKSPACE_GUID,
					table: "ContainerAppConsoleLogs_CL",
					resourceId: RESOURCE_ID,
				},
				budgets: {
					defaultLookbackSeconds: 900,
					maxRangeSeconds: 86_400,
					maxRecords: 5000,
					minFollowIntervalSeconds: 15,
				},
			};
			writeFileSync(
				join(cyrusHome, "router-config.json"),
				JSON.stringify({
					port: 8787,
					workspaces: {},
					webhook: { verificationMode: "direct", secret: "shh" },
					fleetOperations: { logSource },
				}),
			);

			expect(readConfig().fleetOperations?.logSource).toEqual(logSource);
		});

		it("refuses a rendered descriptor whose default lookback exceeds its range", () => {
			// The hand-written form gets the wire schema's cross-field rules too,
			// rather than only the field-by-field shape it used to be checked against.
			writeFileSync(
				join(cyrusHome, "router-config.json"),
				JSON.stringify({
					port: 8787,
					workspaces: {},
					webhook: { verificationMode: "direct", secret: "shh" },
					fleetOperations: {
						logSource: {
							schemaVersion: 1,
							kind: "azure-log-analytics",
							azure: {
								workspaceId: WORKSPACE_GUID,
								table: "ContainerAppConsoleLogs_CL",
							},
							budgets: {
								defaultLookbackSeconds: 999_999,
								maxRangeSeconds: 86_400,
								maxRecords: 5000,
								minFollowIntervalSeconds: 15,
							},
						},
					},
				}),
			);

			expect(() => readConfig()).toThrow("Invalid router config");
		});
	});

	describe("missing router database", () => {
		it.each([
			[["users", "list"]],
			[["devices", "list"]],
			[["sessions", "list"]],
			[["operators", "list"]],
			[
				[
					"operators",
					"create-token",
					"--label",
					"x",
					"--role",
					"fleet.read",
					"--workspace",
					"workspace-a",
				],
			],
		])("errors without creating a db for %j", async (args) => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await expect(command.execute(args)).rejects.toThrow(/process\.exit/);

			expect(app.logger.error).toHaveBeenCalledWith(
				expect.stringContaining(dbPath()),
			);
			expect(existsSync(dbPath())).toBe(false);
		});
	});

	describe("containers list", () => {
		it("errors naming the expected path when the router db does not exist, instead of creating an empty one", async () => {
			// Regression (PAR-166 investigation, 2026-07-27): run inside the ACA
			// router container without `--cyrus-home /data`, `containers list`
			// created a fresh db under the default home and reported "No container
			// devices" — the exact opposite of the truth, while the live db sat at
			// /data/router/router.db. An inspection command must never conjure the
			// state it is meant to inspect.
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);

			await expect(command.execute(["containers", "list"])).rejects.toThrow(
				/process\.exit/,
			);

			expect(app.logger.error).toHaveBeenCalledWith(
				expect.stringContaining(dbPath()),
			);
			expect(app.logger.info).not.toHaveBeenCalledWith("No container devices.");
			// The failed inspection must not have created the db it looked for.
			expect(existsSync(dbPath())).toBe(false);
		});

		it("reports when the router db exists but holds no container devices", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			// `users add` legitimately bootstraps the db on a fresh install.
			await command.execute(["users", "add", "jack@example.com"]);

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

		it("aligns the header with each data column", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute(["users", "add", "mia@example.com"]);

			const seedStore = new RouterStore(dbPath());
			const user = seedStore.findUserForCreator({ email: "mia@example.com" });
			seedStore.createContainerDevice(user!.userId, "CYPACK-11", "docker");
			seedStore.close();
			consoleLogSpy.mockClear();

			await command.execute(["containers", "list"]);

			const [header, row] = printedStdout().split("\n");
			expect(header).toBeDefined();
			expect(row).toBeDefined();

			// Regression guard for the off-by-one header (task 9 finding 3): each
			// header label must start at the exact same column as the data it
			// labels, which only holds if the header and
			// formatContainerDeviceRow() share the same column-width constants.
			expect(header!.indexOf("PROVIDER")).toBe(row!.indexOf("docker"));
			expect(header!.indexOf("USER")).toBe(row!.indexOf("mia@example.com"));

			const lastRoutedCol = header!.indexOf("LAST ROUTED");
			const lastSeenCol = header!.indexOf("LAST SEEN");
			// Neither timestamp is set on a freshly-created device, so both
			// render as "-"; asserting the character at each header's column
			// offset confirms the row's field boundaries line up too.
			expect(row!.charAt(lastRoutedCol)).toBe("-");
			expect(row!.charAt(lastSeenCol)).toBe("-");
			expect(row!.charAt(header!.indexOf("TEARDOWN"))).toBe("-");
			// A brand-new device has never run and is not parked.
			expect(row!.charAt(header!.indexOf("UPTIME"))).toBe("-");
			expect(row!.charAt(header!.indexOf("PARKED"))).toBe("-");
		});

		/**
		 * `created_ms`, `running_since_ms` and `parked_at_ms` were all already
		 * selected into `ContainerDeviceInfo` but never rendered, so the two
		 * questions this table gets opened for — "how long has that been up?" and
		 * "is it stuck waiting on someone?" — needed a sqlite3 shell to answer.
		 *
		 * AGE and UPTIME are separate columns because they measure different
		 * things: AGE is the device ROW, which survives every stop/resume cycle,
		 * while UPTIME is the current continuous run. This test pins that
		 * distinction — an old row that has only just come up must read as old and
		 * freshly-started, not one or the other.
		 */
		it("renders age, continuous uptime and park duration as elapsed times", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute(["users", "add", "omar@example.com"]);

			const seedStore = new RouterStore(dbPath());
			const user = seedStore.findUserForCreator({ email: "omar@example.com" });
			const { deviceId } = seedStore.createContainerDevice(
				user!.userId,
				"CYPACK-30",
				"aca",
			);
			const now = Date.now();
			// Row created three days ago, but the current run started 6h13m ago and
			// a session parked 45 minutes ago.
			seedStore.markDeviceRunning(deviceId, now - (6 * 3600_000 + 13 * 60_000));
			seedStore.setDeviceParkedAt(deviceId, now - 45 * 60_000);
			seedStore.close();
			consoleLogSpy.mockClear();

			await command.execute(["containers", "list"]);

			const [header, row] = printedStdout().split("\n");
			expect(header).toContain("AGE");
			expect(header).toContain("UPTIME");
			expect(header).toContain("PARKED");
			// Hours keep their minutes: telling 5h58m from 6h02m is the whole point
			// of the column, since 6h is where the long-running alert fires.
			expect(row).toMatch(/\b6h1[23]m\b/);
			expect(row).toMatch(/\b4[45]m\b/);
			// Columns still line up after the three additions.
			expect(header!.indexOf("USER")).toBe(row!.indexOf("omar@example.com"));
		});

		/**
		 * The router process holds its pending teardowns in memory, so this CLI —
		 * a separate process — reads the mirrored `container_teardowns` rows. An
		 * operator uses this column to tell "the worker never called back, we're
		 * burning the grace window" apart from "the callback landed and the
		 * provider destroy is retrying".
		 */
		it("shows callback-pending teardown state and the received-callback state", async () => {
			const app = createMockApp(cyrusHome);
			const command = new RouterCommand(app as any);
			await command.execute(["users", "add", "nina@example.com"]);

			const seedStore = new RouterStore(dbPath());
			const user = seedStore.findUserForCreator({ email: "nina@example.com" });
			const pendingDevice = seedStore.createContainerDevice(
				user!.userId,
				"CYPACK-20",
				"aca",
			);
			const reportedDevice = seedStore.createContainerDevice(
				user!.userId,
				"CYPACK-21",
				"aca",
			);
			seedStore.upsertPendingTeardown({
				issueKey: "CYPACK-20",
				deviceId: pendingDevice.deviceId,
				action: "closed",
				registeredMs: Date.now(),
				deadlineMs: Date.now() + 600_000,
			});
			seedStore.upsertPendingTeardown({
				issueKey: "CYPACK-21",
				deviceId: reportedDevice.deviceId,
				action: "deleted",
				registeredMs: Date.now(),
				deadlineMs: Date.now() + 600_000,
			});
			seedStore.recordTeardownCallback("CYPACK-21", "cb-1", Date.now());
			seedStore.close();
			consoleLogSpy.mockClear();

			await command.execute(["containers", "list"]);

			const printed = printedStdout();
			expect(printed).toContain("TEARDOWN");
			expect(printed).toMatch(
				/CYPACK-20.*callback-pending\(closed, grace \d+s\)/,
			);
			expect(printed).toMatch(/CYPACK-21.*destroying\(deleted, callbacks 1\)/);
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
			seedEmptyDb();
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

	describe("containers gc-snapshots", () => {
		it("prints the full plan and remains a dry run without --yes", async () => {
			seedEmptyDb();
			writeAcaRouterConfig();
			const app = createMockApp(cyrusHome);
			const command = new StubSnapshotGcRouterCommand(app as any);

			await command.execute(["containers", "gc-snapshots"]);

			expect(printedStdout()).toContain(
				"snap-orphan issue=OLD-1 device=device-old created=2026-01-01T00:00:00Z",
			);
			expect(printedStdout()).toContain("Re-run with --yes");
			expect(command.gc).not.toHaveBeenCalled();
			expect(command.containersConfig.aca.disconnectedRecreateMs).toBe(120_000);
		});

		it("passes active ACA device rows and executes only with --yes", async () => {
			writeAcaRouterConfig();
			const app = createMockApp(cyrusHome);
			await new RouterCommand(app as any).execute([
				"users",
				"add",
				"aca@example.com",
			]);
			const store = new RouterStore(dbPath());
			const user = store.findUserForCreator({ email: "aca@example.com" })!;
			store.createContainerDevice(user.userId, "LIVE-ACA", "aca");
			store.createContainerDevice(user.userId, "LIVE-DOCKER", "docker");
			store.close();
			const command = new StubSnapshotGcRouterCommand(app as any);

			await command.execute(["containers", "gc-snapshots", "--yes"]);

			expect(command.plan).toHaveBeenCalledWith(["LIVE-ACA"]);
			expect(command.gc).toHaveBeenCalledWith(
				["LIVE-ACA"],
				expect.arrayContaining([
					expect.objectContaining({ id: "snap-orphan" }),
				]),
			);
			expect(app.logger.success).toHaveBeenCalledWith(
				"Deleted 1 orphan ACA snapshot(s).",
			);
		});
	});

	describe("persistRefreshedTokens", () => {
		let configPath: string;

		beforeEach(() => {
			configPath = join(cyrusHome, "router-config.json");
			writeFileSync(
				configPath,
				JSON.stringify(
					{
						port: 8787,
						workspaces: {
							"ws-1": { linearToken: "at-1", linearRefreshToken: "rt-1" },
						},
						webhook: { verificationMode: "direct", secret: "shh" },
					},
					null,
					2,
				),
			);
		});

		function makeRouterCommand(): RouterCommand {
			return new RouterCommand(createMockApp(cyrusHome) as any);
		}

		it("writes the rotated pair to Key Vault with the recorded seed", async () => {
			const set = vi.fn(async () => {});
			const command = makeRouterCommand();
			(command as any).linearTokenStore = { set };
			(command as any).linearTokenSeeds = new Map([["ws-1", "rt-seed"]]);

			await (command as any).persistRefreshedTokens(configPath, "ws-1", {
				accessToken: "at-2",
				refreshToken: "rt-2",
			});

			expect(set).toHaveBeenCalledWith(
				"ws-1",
				expect.objectContaining({
					refreshToken: "rt-2",
					accessToken: "at-2",
					seedRefreshToken: "rt-seed",
				}),
			);
		});

		it("still writes the config file when the Key Vault write fails", async () => {
			const command = makeRouterCommand();
			(command as any).linearTokenStore = {
				set: vi.fn(async () => {
					throw new Error("kv down");
				}),
			};
			(command as any).linearTokenSeeds = new Map([["ws-1", "rt-seed"]]);

			await (command as any).persistRefreshedTokens(configPath, "ws-1", {
				accessToken: "at-2",
				refreshToken: "rt-2",
			});

			const written = JSON.parse(readFileSync(configPath, "utf-8"));
			expect(written.workspaces["ws-1"].linearRefreshToken).toBe("rt-2");
		});
	});

	describe("resolveWorkspaceTokens", () => {
		const configWorkspaces = {
			"ws-1": { linearToken: "at-cfg", linearRefreshToken: "rt-seed" },
		};

		function makeRouterCommand(): RouterCommand {
			return new RouterCommand(createMockApp(cyrusHome) as any);
		}

		function commandWithStore(get: () => Promise<unknown>) {
			const command = makeRouterCommand();
			(command as any).linearTokenStore = { get };
			(command as any).linearTokenSeeds = new Map([["ws-1", "rt-seed"]]);
			return command;
		}

		it("uses the config value when no envelope is stored", async () => {
			const command = commandWithStore(async () => undefined);
			const out = await (command as any).resolveWorkspaceTokens(
				configWorkspaces,
			);
			expect(out["ws-1"].linearRefreshToken).toBe("rt-seed");
			expect((command as any).linearTokenSources.get("ws-1")).toBe("config");
		});

		it("prefers the stored envelope when the seed still matches", async () => {
			const command = commandWithStore(async () => ({
				refreshToken: "rt-9",
				accessToken: "at-9",
				seedRefreshToken: "rt-seed",
				updatedMs: 123,
			}));
			const out = await (command as any).resolveWorkspaceTokens(
				configWorkspaces,
			);
			expect(out["ws-1"].linearRefreshToken).toBe("rt-9");
			expect(out["ws-1"].linearToken).toBe("at-9");
			expect((command as any).linearTokenSources.get("ws-1")).toBe("keyvault");
		});

		it("abandons the stored chain when the operator seeded a new token", async () => {
			const command = commandWithStore(async () => ({
				refreshToken: "rt-9",
				accessToken: "at-9",
				seedRefreshToken: "rt-OLD-seed",
				updatedMs: 123,
			}));
			const out = await (command as any).resolveWorkspaceTokens(
				configWorkspaces,
			);
			expect(out["ws-1"].linearRefreshToken).toBe("rt-seed");
			expect(out["ws-1"].linearToken).toBe("at-cfg");
			expect((command as any).linearTokenSources.get("ws-1")).toBe("config");
		});

		it("falls back to config rather than failing to boot when Key Vault errors", async () => {
			const command = commandWithStore(async () => {
				throw new Error("kv unreachable");
			});
			const out = await (command as any).resolveWorkspaceTokens(
				configWorkspaces,
			);
			expect(out["ws-1"].linearRefreshToken).toBe("rt-seed");
			expect((command as any).linearTokenSources.get("ws-1")).toBe("config");
		});

		/**
		 * Bind-mounted config (docs/ROUTER.md "Running the router in Docker"):
		 * `persistRefreshedTokensToFile` writes each rotated token back into the
		 * mounted file, so by the next start the config value has advanced past the
		 * seed to the envelope's CURRENT head. Comparing against the seed alone
		 * discarded a perfectly healthy chain there, logged "treating it as a fresh
		 * re-authorization" on every restart forever, and left the Key Vault path
		 * silently inert on exactly the deployments that mount their config.
		 */
		it("keeps the chain when a bind-mounted config already holds the rotated token", async () => {
			const command = makeRouterCommand();
			(command as any).linearTokenStore = {
				get: async () => ({
					refreshToken: "rt-rotated",
					accessToken: "at-rotated",
					seedRefreshToken: "rt-original-seed",
					updatedMs: 456,
				}),
			};

			const out = await (command as any).resolveWorkspaceTokens({
				// What the mounted file looks like after one rotation: the head, not
				// the seed the envelope was created with.
				"ws-1": { linearToken: "at-rotated", linearRefreshToken: "rt-rotated" },
			});

			expect(out["ws-1"].linearRefreshToken).toBe("rt-rotated");
			expect(out["ws-1"].linearToken).toBe("at-rotated");
			expect((command as any).linearTokenSources.get("ws-1")).toBe("keyvault");
		});

		/**
		 * The opt-in guarantee: with no `linearTokenStore` configured the resolver
		 * must hand back the config values untouched and never reach for Key Vault.
		 * This is the constraint the whole feature is built around, and nothing
		 * else pins it.
		 */
		it("returns the config values byte-for-byte when no Key Vault is configured", async () => {
			const command = makeRouterCommand();
			expect((command as any).linearTokenStore).toBeUndefined();

			const workspaces = {
				"ws-1": { linearToken: "at-cfg", linearRefreshToken: "rt-seed" },
				"ws-2": { linearToken: "at-cfg-2" },
			};
			const out = await (command as any).resolveWorkspaceTokens(workspaces);

			expect(out).toEqual(workspaces);
			expect((command as any).linearTokenSources.get("ws-1")).toBe("config");
			expect((command as any).linearTokenSources.get("ws-2")).toBe("config");
			expect((command as any).linearTokenUpdatedMs.size).toBe(0);
		});

		/**
		 * Same guarantee one level up: a config with no `linearTokenStore` must not
		 * construct a Key Vault client at all. `configureLinearTokenStore` is the
		 * single place both `start` and `linear status` go through, so this is the
		 * gate that keeps non-Azure deployments on the original codepath.
		 */
		it("configureLinearTokenStore builds no store when the config omits one", () => {
			const command = makeRouterCommand();

			(command as any).configureLinearTokenStore({
				workspaces: {
					"ws-1": { linearToken: "at-cfg", linearRefreshToken: "rt-seed" },
				},
			});

			expect((command as any).linearTokenStore).toBeUndefined();
			// Seeds are still recorded — they cost nothing and are only ever read
			// when a store exists.
			expect((command as any).linearTokenSeeds.get("ws-1")).toBe("rt-seed");
		});
	});

	describe("router linear status", () => {
		function makeRouterCommand(
			workspace: { linearToken: string; linearRefreshToken?: string } = {
				linearToken: "at-1",
				linearRefreshToken: "rt-1",
			},
		): RouterCommand {
			writeFileSync(
				join(cyrusHome, "router-config.json"),
				JSON.stringify({
					port: 8787,
					workspaces: { "ws-1": workspace },
					webhook: { verificationMode: "direct", secret: "shh" },
				}),
			);
			return new RouterCommand(createMockApp(cyrusHome) as any);
		}

		function captureStatus(
			fetchImpl: () => Promise<Response>,
			workspace?: { linearToken: string; linearRefreshToken?: string },
		) {
			const command = makeRouterCommand(workspace);
			(command as any).linearTokenStore = undefined;
			const lines: string[] = [];
			vi.spyOn(console, "log").mockImplementation((m) => lines.push(String(m)));
			vi.stubGlobal("fetch", vi.fn(fetchImpl));
			return { command, lines };
		}

		/** A workspace whose access token is dead and has nothing to recover with. */
		const noRefreshChain = { linearToken: "at-1" };

		const authErrorResponse = () =>
			Promise.resolve(
				new Response(
					JSON.stringify({ errors: [{ message: "Authentication required" }] }),
					{ status: 200 },
				),
			);

		afterEach(() => {
			vi.unstubAllGlobals();
			vi.restoreAllMocks();
		});

		it("names the probed column ACCESS TOKEN, not STATUS", async () => {
			// The column header is load-bearing: `STATUS` invited reading a rejected
			// 25-hour-old access token as "this workspace's Linear auth is broken",
			// which in the re-auth runbook means burning a working refresh chain.
			const { command, lines } = captureStatus(
				async () =>
					new Response(JSON.stringify({ data: { viewer: { id: "u1" } } }), {
						status: 200,
					}),
			);

			await (command as any).linear(["status"]);

			expect(lines[0]).toContain("ACCESS TOKEN");
			expect(lines[0]).not.toContain("STATUS");
		});

		it("reports ok for a working token", async () => {
			const { command, lines } = captureStatus(
				async () =>
					new Response(JSON.stringify({ data: { viewer: { id: "u1" } } }), {
						status: 200,
					}),
			);

			await (command as any).linear(["status"]);

			expect(lines.join("\n")).toMatch(/ws-1/);
			expect(lines.join("\n")).toMatch(/\bok\b/);
		});

		it("reports expired (refresh available) when a refresh token is on file", async () => {
			// Linear expires access tokens after 24h, so a rejected one on a
			// workspace that still holds a refresh token is the NORMAL first-deploy
			// state — the router mints a fresh access token on its first 401. Calling
			// that "rejected" sends an operator to re-authorize a healthy credential,
			// the exact opposite of what this command is for.
			const { command, lines } = captureStatus(authErrorResponse);

			await (command as any).linear(["status"]);

			const printed = lines.join("\n");
			expect(printed).toMatch(/expired \(refresh available, auth error\)/);
			expect(printed).not.toMatch(/\brejected\b/);
		});

		it("reports rejected when Linear returns an auth error and there is no refresh token", async () => {
			const { command, lines } = captureStatus(
				authErrorResponse,
				noRefreshChain,
			);

			await (command as any).linear(["status"]);

			expect(lines.join("\n")).toMatch(/rejected \(auth error\)/);
		});

		it("reports rejected on a non-200 response", async () => {
			const { command, lines } = captureStatus(
				async () => new Response("nope", { status: 401 }),
				noRefreshChain,
			);

			await (command as any).linear(["status"]);

			expect(lines.join("\n")).toMatch(/rejected \(HTTP 401\)/);
		});

		it("reports unknown (never ok) when the network probe itself fails", async () => {
			// The safety property this command exists for: a dead network path must
			// never read as healthy. If a future change collapsed probeLinearToken's
			// catch into returning "ok", this is the test that would catch it.
			// It must also not be softened into "expired (refresh available)" — a
			// probe that never reached Linear says nothing about the credential,
			// whether or not a refresh token happens to be on file (this workspace
			// has one).
			const { command, lines } = captureStatus(async () => {
				throw new Error("ECONNREFUSED");
			});

			await (command as any).linear(["status"]);

			const printed = lines.join("\n");
			expect(printed).toMatch(/unknown \(ECONNREFUSED\)/);
			expect(printed).not.toMatch(/\bok\b/);
			expect(printed).not.toMatch(/expired/);
		});

		it("reports the keyvault source when the stored envelope's seed matches config", async () => {
			const command = makeRouterCommand();
			(command as any).linearTokenStore = {
				get: vi.fn(async () => ({
					accessToken: "at-kv",
					refreshToken: "rt-kv",
					// Must equal the config's linearRefreshToken ("rt-1", set in
					// makeRouterCommand) for resolveWorkspaceTokens to trust this
					// envelope instead of falling back to the config value.
					seedRefreshToken: "rt-1",
					updatedMs: Date.UTC(2026, 0, 1),
				})),
			};
			const lines: string[] = [];
			vi.spyOn(console, "log").mockImplementation((m) => lines.push(String(m)));
			vi.stubGlobal(
				"fetch",
				vi.fn(
					async () =>
						new Response(JSON.stringify({ data: { viewer: { id: "u1" } } }), {
							status: 200,
						}),
				),
			);

			await (command as any).linear(["status"]);

			const dataRow = lines.find((line) => line.includes("ws-1"));
			expect(dataRow).toBeDefined();
			expect(dataRow).toMatch(/\bkeyvault\b/);
		});

		it("rejects an unknown subcommand", async () => {
			const command = makeRouterCommand();
			const exit = vi
				.spyOn(command as any, "exitWithError")
				.mockImplementation(() => {});
			await (command as any).linear(["bogus"]);
			expect(exit).toHaveBeenCalled();
		});
	});
});
