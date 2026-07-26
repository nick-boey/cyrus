import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

	describe("containers gc-snapshots", () => {
		it("prints the full plan and remains a dry run without --yes", async () => {
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
});
