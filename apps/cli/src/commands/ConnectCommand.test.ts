import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigService } from "../services/ConfigService.js";
import { Logger } from "../services/Logger.js";
import { ConnectCommand, deriveWebSocketUrl } from "./ConnectCommand.js";

// process.exit is called by BaseCommand.exitWithError on any usage/enrollment
// error. If a happy-path test accidentally takes an error branch, this makes
// the failure surface as a thrown error instead of silently killing the test
// worker.
vi.spyOn(process, "exit").mockImplementation((code?: number) => {
	throw new Error(`process.exit called with ${code}`);
});

describe("deriveWebSocketUrl", () => {
	it("derives wss:// from an https:// origin", () => {
		expect(deriveWebSocketUrl("https://x")).toBe("wss://x");
	});

	it("derives ws:// from an http:// origin (local/dev router)", () => {
		expect(deriveWebSocketUrl("http://localhost:8787")).toBe(
			"ws://localhost:8787",
		);
	});

	it("returns undefined for an unsupported scheme", () => {
		expect(deriveWebSocketUrl("ftp://x")).toBeUndefined();
	});
});

describe("ConnectCommand", () => {
	let cyrusHome: string;

	beforeEach(() => {
		cyrusHome = mkdtempSync(join(tmpdir(), "cyrus-connect-cmd-"));
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		rmSync(cyrusHome, { recursive: true, force: true });
	});

	function createApp() {
		const logger = new Logger();
		return {
			cyrusHome,
			logger,
			config: new ConfigService(cyrusHome, logger),
		};
	}

	function stubFetch(body: unknown, init?: { ok?: boolean; status?: number }) {
		const fetchMock = vi.fn().mockResolvedValue({
			ok: init?.ok ?? true,
			status: init?.status ?? 200,
			statusText: "OK",
			json: async () => body,
			text: async () => JSON.stringify(body),
		});
		vi.stubGlobal("fetch", fetchMock);
		return fetchMock;
	}

	it("POSTs the code to <url>/enroll and writes platform/router config at mode 0600", async () => {
		const fetchMock = stubFetch({ deviceToken: "tok" });
		const app = createApp();
		const command = new ConnectCommand(app as any);

		await command.execute(["https://x", "--code", "the-code"]);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://x/enroll",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ code: "the-code" }),
			}),
		);

		const configPath = app.config.getConfigPath();
		const written = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(written.platform).toBe("router");
		expect(written.router).toEqual({ url: "wss://x", deviceToken: "tok" });

		const mode = statSync(configPath).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("derives wss:// for the config's router.url while POSTing to the https origin", async () => {
		stubFetch({ deviceToken: "tok2" });
		const app = createApp();
		const command = new ConnectCommand(app as any);

		await command.execute(["https://x", "--code", "the-code"]);

		const written = JSON.parse(
			readFileSync(app.config.getConfigPath(), "utf-8"),
		);
		expect(written.router.url).toBe("wss://x");
	});

	it("preserves existing config fields (e.g. repositories) when merging", async () => {
		stubFetch({ deviceToken: "tok3" });
		const app = createApp();
		app.config.save({
			repositories: [
				{
					id: "repo-1",
					name: "repo",
					repositoryPath: "/tmp/repo",
					workspaceBaseDir: "/tmp/repo/workspaces",
					baseBranch: "main",
					linearWorkspaceId: "ws-1",
					linearToken: "token",
				} as any,
			],
		});
		const command = new ConnectCommand(app as any);

		await command.execute(["https://x", "--code", "the-code"]);

		const written = JSON.parse(
			readFileSync(app.config.getConfigPath(), "utf-8"),
		);
		expect(written.repositories).toHaveLength(1);
		expect(written.repositories[0].id).toBe("repo-1");
		expect(written.platform).toBe("router");
	});

	it("exits with an error when the enrollment code is rejected", async () => {
		stubFetch({ error: "invalid or expired code" }, { ok: false, status: 401 });
		const app = createApp();
		const command = new ConnectCommand(app as any);

		await expect(
			command.execute(["https://x", "--code", "bad-code"]),
		).rejects.toThrow(/process.exit called/);
	});
});
