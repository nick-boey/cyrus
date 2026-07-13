import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ContainerExecutor,
	ExecutorRegistry,
	IssueExecutionContext,
} from "cyrus-router-executors";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	type ContainerRoutingDeps,
	ContainerTargetService,
} from "../src/ContainerTargets.js";
import { containerBootFailedMessage } from "../src/messages.js";
import { RouterStore } from "../src/RouterStore.js";
import { SecretStore } from "../src/SecretStore.js";

/** Minimal fake ContainerExecutor whose ensureRunning/destroy are inspectable mocks. */
function fakeExecutor(
	provider: string,
	overrides?: { ensureRunning?: Mock; destroy?: Mock },
): ContainerExecutor & { ensureRunning: Mock; destroy: Mock } {
	return {
		provider,
		ensureRunning:
			overrides?.ensureRunning ??
			vi.fn<(ctx: IssueExecutionContext) => Promise<void>>(async () => {}),
		destroy:
			overrides?.destroy ??
			vi.fn<(issueKey: string) => Promise<void>>(async () => {}),
		stop: vi.fn(async () => {}),
		status: vi.fn(async () => "running" as const),
		listManaged: vi.fn(async () => []),
	};
}

function freshSecretsPath(): string {
	return join(
		mkdtempSync(join(tmpdir(), "container-targets-secrets-")),
		"secrets.json",
	);
}

const CONTAINERS_CONFIG: ContainerRoutingDeps["containersConfig"] = {
	routerUrlForContainers: "wss://router.example.com",
	repositories: [
		{
			name: "cyrus",
			githubSlug: "ceedaragents/cyrus",
			linearWorkspaceId: "ws-1",
			baseBranch: "main",
		},
	],
};

describe("ContainerTargetService", () => {
	let store: RouterStore;
	let secrets: SecretStore;
	let postActivity: Mock<
		(workspaceId: string, sessionId: string, body: string) => Promise<void>
	>;
	let logger: { info: Mock; warn: Mock };

	beforeEach(() => {
		store = new RouterStore(":memory:");
		secrets = new SecretStore(freshSecretsPath());
		postActivity = vi.fn(async () => {});
		logger = { info: vi.fn(), warn: vi.fn() };
	});

	function makeService(executors: ExecutorRegistry): ContainerTargetService {
		return new ContainerTargetService({
			store,
			secrets,
			executors,
			containersConfig: CONTAINERS_CONFIG,
			postActivity,
			logger,
		});
	}

	it("creates a device row on first ensure and reuses it after", () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		const docker = fakeExecutor("docker");
		const service = makeService(new Map([["docker", docker]]));

		const first = service.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);
		const second = service.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);

		expect(second.deviceId).toBe(first.deviceId);
		expect(store.getContainerDeviceForIssue("CYPACK-1")).toMatchObject({
			deviceId: first.deviceId,
			provider: "docker",
		});
	});

	it("replaces the device when the user's executor provider changed", () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		const docker = fakeExecutor("docker");
		const fake2 = fakeExecutor("fake2");
		const service = makeService(
			new Map<string, ContainerExecutor>([
				["docker", docker],
				["fake2", fake2],
			]),
		);

		const original = service.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);

		store.setUserExecutor("a@example.com", '{"type":"fake2"}');
		const replaced = service.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);

		expect(replaced.deviceId).not.toBe(original.deviceId);
		expect(docker.destroy).toHaveBeenCalledWith("CYPACK-1");
		expect(store.getDeviceInfo(original.deviceId)).toBeUndefined();
		expect(store.getContainerDeviceForIssue("CYPACK-1")).toMatchObject({
			deviceId: replaced.deviceId,
			provider: "fake2",
		});
	});

	it("boot passes env built from secrets and repo config, minus the device token", async () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		secrets.set("a@example.com", "claudeOauthToken", "claude-tok");
		secrets.set("a@example.com", "githubPat", "gh-pat");
		secrets.set("a@example.com", "gitUserName", "A Example");
		const docker = fakeExecutor("docker");
		const service = makeService(new Map([["docker", docker]]));
		const { deviceId } = service.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);

		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });

		await vi.waitFor(() =>
			expect(docker.ensureRunning).toHaveBeenCalledTimes(1),
		);
		const ctx = docker.ensureRunning.mock
			.calls[0]?.[0] as IssueExecutionContext;
		expect(ctx.env).toMatchObject({
			CYRUS_ROUTER_URL: "wss://router.example.com",
			CYRUS_ISSUE_KEY: "CYPACK-1",
			CYRUS_REPOS_JSON: JSON.stringify(CONTAINERS_CONFIG.repositories),
			CLAUDE_CODE_OAUTH_TOKEN: "claude-tok",
			GIT_TOKEN: "gh-pat",
			GIT_USER_NAME: "A Example",
		});
		expect(ctx.env.CYRUS_DEVICE_TOKEN).toBeUndefined();

		const minted = ctx.mintDeviceToken();
		expect(store.getDeviceByToken(minted)).toEqual({ deviceId, userId });
	});

	it("posts a boot-failure activity once when ensureRunning rejects", async () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		secrets.set("a@example.com", "claudeOauthToken", "claude-tok");
		const ensureRunning = vi.fn(async () => {
			throw new Error("docker daemon unreachable");
		});
		const docker = fakeExecutor("docker", { ensureRunning });
		const service = makeService(new Map([["docker", docker]]));
		const { deviceId } = service.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);

		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
		await vi.waitFor(() => expect(postActivity).toHaveBeenCalledTimes(1));
		expect(postActivity).toHaveBeenCalledWith(
			"ws-1",
			"sess-1",
			containerBootFailedMessage("CYPACK-1", "docker daemon unreachable"),
		);

		// A second failed boot for the SAME issue must not post a second notice.
		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
		await vi.waitFor(() => expect(ensureRunning).toHaveBeenCalledTimes(2));
		expect(postActivity).toHaveBeenCalledTimes(1);
	});

	it("no Claude token means immediate failure without calling the executor", async () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		// Deliberately no secrets.set(...) — claudeOauthToken is absent.
		const docker = fakeExecutor("docker");
		const service = makeService(new Map([["docker", docker]]));
		const { deviceId } = service.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);

		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });

		await vi.waitFor(() => expect(postActivity).toHaveBeenCalledTimes(1));
		expect(docker.ensureRunning).not.toHaveBeenCalled();
		expect(postActivity.mock.calls[0]?.[2]).toContain(
			"no Claude OAuth token stored",
		);
	});

	it("refuses to create a container device for an issue key that fails the format gate", () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		const docker = fakeExecutor("docker");
		const service = makeService(new Map([["docker", docker]]));

		expect(() =>
			service.ensureDevice(
				{ userId, email: "a@example.com" },
				"../../etc/passwd",
			),
		).toThrow();
		expect(() =>
			service.ensureDevice({ userId, email: "a@example.com" }, "CYPACK 1"),
		).toThrow();
		// Nothing was created for either rejected key.
		expect(
			store.getContainerDeviceForIssue("../../etc/passwd"),
		).toBeUndefined();
		expect(store.listContainerDevices()).toHaveLength(0);
	});

	it("isContainerDevice distinguishes container devices from physical ones", () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		const docker = fakeExecutor("docker");
		const service = makeService(new Map([["docker", docker]]));
		const { deviceId } = service.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);

		const code = store.mintEnrollmentCode("a@example.com", Date.now());
		const physical = store.redeemEnrollmentCode(code, Date.now());

		expect(service.isContainerDevice(deviceId)).toBe(true);
		expect(service.isContainerDevice(physical?.deviceId ?? -1)).toBe(false);
	});

	it("executorFor returns the provider type, undefined for device/corrupt/missing", () => {
		const { userId: dockerUser } = store.addUser({
			email: "docker@example.com",
		});
		store.setUserExecutor("docker@example.com", '{"type":"docker"}');
		const { userId: deviceUser } = store.addUser({
			email: "device@example.com",
		});
		store.setUserExecutor("device@example.com", '{"type":"device"}');
		const { userId: corruptUser } = store.addUser({
			email: "corrupt@example.com",
		});
		store.setUserExecutor("corrupt@example.com", "{ not json");
		const { userId: unsetUser } = store.addUser({ email: "unset@example.com" });

		const service = makeService(new Map());

		expect(service.executorFor(dockerUser)).toBe("docker");
		expect(service.executorFor(deviceUser)).toBeUndefined();
		expect(service.executorFor(corruptUser)).toBeUndefined();
		expect(service.executorFor(unsetUser)).toBeUndefined();
	});
});
