import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
	let secretsFile: string;
	let postActivity: Mock<
		(workspaceId: string, sessionId: string, body: string) => Promise<void>
	>;
	let logger: { info: Mock; warn: Mock };

	beforeEach(() => {
		store = new RouterStore(":memory:");
		secretsFile = freshSecretsPath();
		secrets = new SecretStore(secretsFile);
		postActivity = vi.fn(async () => {});
		logger = { info: vi.fn(), warn: vi.fn() };
	});

	function makeService(
		executors: ExecutorRegistry,
		now?: () => number,
	): ContainerTargetService {
		return new ContainerTargetService({
			store,
			secrets,
			executors,
			containersConfig: CONTAINERS_CONFIG,
			postActivity,
			logger,
			...(now ? { now } : {}),
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
		secrets.set("a@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "claude-tok");
		secrets.set("a@example.com", "GIT_TOKEN", "gh-pat");
		secrets.set("a@example.com", "GIT_USER_NAME", "A Example");
		secrets.set("a@example.com", "LINEAR_API_TOKEN", "lin_api_1");
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
			LINEAR_API_TOKEN: "lin_api_1",
		});
		expect(ctx.env.CYRUS_DEVICE_TOKEN).toBeUndefined();

		const minted = ctx.mintDeviceToken();
		expect(store.getDeviceByToken(minted)).toEqual({ deviceId, userId });
	});

	it("posts a boot-failure activity once when ensureRunning rejects", async () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		secrets.set("a@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "claude-tok");
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

	it("bootForTeardown uses normal env/token booting but only logs failures", async () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		secrets.set("a@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "claude-tok");
		const ensureRunning = vi.fn(async () => {
			throw new Error("wake failed");
		});
		const service = makeService(
			new Map([["docker", fakeExecutor("docker", { ensureRunning })]]),
		);
		const { deviceId } = service.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);

		service.bootForTeardown(deviceId);
		await vi.waitFor(() =>
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("wake failed"),
			),
		);
		expect(ensureRunning).toHaveBeenCalledTimes(1);
		expect(postActivity).not.toHaveBeenCalled();
	});

	it("no Claude token means immediate failure without calling the executor", async () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		// Deliberately no secrets.set(...) — CLAUDE_CODE_OAUTH_TOKEN is absent.
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
			"is not fully authenticated for containers: missing CLAUDE_CODE_OAUTH_TOKEN",
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

	it("serializes concurrent boots for the same issue: a second boot() while the first is still cold-booting joins it instead of racing ensureRunning/mintDeviceToken", async () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		secrets.set("a@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "claude-tok");

		let resolveFirst: () => void = () => {};
		const firstAttempt = new Promise<void>((resolve) => {
			resolveFirst = resolve;
		});
		const ensureRunning = vi.fn(async (ctx: IssueExecutionContext) => {
			// Mirrors what LocalDockerProvider actually does: mint the device
			// token as part of the call that launches the container, before
			// the (slow) docker run itself resolves.
			ctx.mintDeviceToken();
			await firstAttempt;
		});
		const docker = fakeExecutor("docker", { ensureRunning });
		const service = makeService(new Map([["docker", docker]]));
		const { deviceId } = service.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);
		const rotateSpy = vi.spyOn(store, "rotateContainerDeviceToken");

		// Both calls land synchronously back-to-back, mirroring `created` then
		// `prompted` webhooks arriving while the container is still booting.
		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-2" });

		await vi.waitFor(() => expect(ensureRunning).toHaveBeenCalledTimes(1));
		expect(rotateSpy).toHaveBeenCalledTimes(1);

		resolveFirst();
		// Flush the microtask queue (ensureRunning's continuation, bootInner's
		// completion, and the in-flight-map cleanup) before booting again.
		await new Promise((resolve) => setTimeout(resolve, 0));

		// The first attempt has settled, so a later boot for the same issue
		// starts a genuinely new attempt.
		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-3" });
		await vi.waitFor(() => expect(ensureRunning).toHaveBeenCalledTimes(2));
		expect(rotateSpy).toHaveBeenCalledTimes(2);
	});

	it("resets the boot-failed latch on success, so a later failure posts a fresh notice", async () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		secrets.set("a@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "claude-tok");
		let shouldFail = true;
		const ensureRunning = vi.fn(async () => {
			if (shouldFail) throw new Error("docker daemon unreachable");
		});
		const docker = fakeExecutor("docker", { ensureRunning });
		const service = makeService(new Map([["docker", docker]]));
		const { deviceId } = service.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);
		// `ensureRunning`'s rejection is synchronous (no internal await), so
		// `vi.waitFor`'s condition can already be true on its very first,
		// synchronous check — which resolves without ever going through a
		// macrotask, so it does NOT guarantee the in-flight boot's `finally`
		// cleanup (another few microtask hops away) has run yet. Flush an
		// explicit macrotask boundary between calls instead, so each `boot()`
		// call below only ever sees a fully-settled (or fully in-flight)
		// prior attempt, matching real production timing.
		const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

		// First failure: posts the boot-failed notice.
		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
		await flush();
		expect(ensureRunning).toHaveBeenCalledTimes(1);
		expect(postActivity).toHaveBeenCalledTimes(1);

		// Second failure while still failing: the once-per-issue latch
		// suppresses a second notice.
		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
		await flush();
		expect(ensureRunning).toHaveBeenCalledTimes(2);
		expect(postActivity).toHaveBeenCalledTimes(1);

		// Boot succeeds: the latch (`bootFailedNotified.delete`) is cleared.
		shouldFail = false;
		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
		await flush();
		expect(ensureRunning).toHaveBeenCalledTimes(3);
		expect(postActivity).toHaveBeenCalledTimes(1);

		// A fresh failure after that success posts a NEW notice — the "...
		// until a boot succeeds" half of the once-per-issue requirement.
		shouldFail = true;
		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
		await flush();
		expect(ensureRunning).toHaveBeenCalledTimes(4);
		expect(postActivity).toHaveBeenCalledTimes(2);
	});

	it("logs a warning instead of silently leaking when the old provider is no longer registered", () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		const docker = fakeExecutor("docker");
		const service = makeService(new Map([["docker", docker]]));
		const original = service.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);

		// Operator migrates the user to "fly" and removes "docker" from the
		// registry entirely (e.g. restarted the router with a new executor
		// config) — "docker" is no longer resolvable at all.
		store.setUserExecutor("a@example.com", '{"type":"fly"}');
		const fly = fakeExecutor("fly");
		const service2 = new ContainerTargetService({
			store,
			secrets,
			executors: new Map([["fly", fly]]),
			containersConfig: CONTAINERS_CONFIG,
			postActivity,
			logger,
		});

		const replaced = service2.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);

		expect(replaced.deviceId).not.toBe(original.deviceId);
		expect(store.getDeviceInfo(original.deviceId)).toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining("no executor registered for provider 'docker'"),
		);
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

	it("skips reserved env keys found in stored secrets, with a warning", async () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		secrets.set("a@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "claude-tok");
		const raw = JSON.parse(readFileSync(secretsFile, "utf-8"));
		raw["a@example.com"].CYRUS_ROUTER_URL = "http://evil";
		writeFileSync(secretsFile, JSON.stringify(raw));

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
		expect(ctx.env.CYRUS_ROUTER_URL).toBe("wss://router.example.com");
		expect(logger.warn).toHaveBeenCalledWith(
			expect.stringContaining('skipping reserved env key "CYRUS_ROUTER_URL"'),
		);
	});

	it("always requires the Claude token even when requiredSecretKeys omits it", async () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		secrets.set("a@example.com", "GIT_TOKEN", "gh"); // no Claude token
		const docker = fakeExecutor("docker");
		const service = new ContainerTargetService({
			store,
			secrets,
			executors: new Map([["docker", docker]]),
			containersConfig: {
				...CONTAINERS_CONFIG,
				requiredSecretKeys: ["GIT_TOKEN"],
			},
			postActivity,
			logger,
		});
		const { deviceId } = service.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);
		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
		await vi.waitFor(() => expect(postActivity).toHaveBeenCalledTimes(1));
		expect(docker.ensureRunning).not.toHaveBeenCalled();
		expect(postActivity.mock.calls[0]?.[2]).toContain(
			"missing CLAUDE_CODE_OAUTH_TOKEN",
		);
	});

	it("blocks boot naming every missing required key", async () => {
		const { userId } = store.addUser({ email: "a@example.com" });
		store.setUserExecutor("a@example.com", '{"type":"docker"}');
		secrets.set("a@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "claude-tok");
		const docker = fakeExecutor("docker");
		const service = new ContainerTargetService({
			store,
			secrets,
			executors: new Map([["docker", docker]]),
			containersConfig: {
				...CONTAINERS_CONFIG,
				requiredSecretKeys: ["GIT_TOKEN", "LINEAR_API_TOKEN"],
			},
			postActivity,
			logger,
		});
		const { deviceId } = service.ensureDevice(
			{ userId, email: "a@example.com" },
			"CYPACK-1",
		);
		service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
		await vi.waitFor(() => expect(postActivity).toHaveBeenCalledTimes(1));
		expect(docker.ensureRunning).not.toHaveBeenCalled();
		expect(postActivity.mock.calls[0]?.[2]).toContain(
			"missing GIT_TOKEN, LINEAR_API_TOKEN",
		);
	});
	/**
	 * Joining an in-flight boot is a dedup of concurrent work, never proof that
	 * the container ended up running. These pin the two ways that assumption
	 * broke a terminal-teardown wake on the live drive: the joined attempt
	 * finished with the container stopped, and the joined attempt never
	 * finished at all.
	 */
	describe("joining an in-flight boot", () => {
		function seed(ensureRunning: Mock, status: Mock, now?: () => number) {
			const { userId } = store.addUser({ email: "a@example.com" });
			store.setUserExecutor("a@example.com", '{"type":"docker"}');
			secrets.set("a@example.com", "CLAUDE_CODE_OAUTH_TOKEN", "claude-tok");
			const docker = fakeExecutor("docker", { ensureRunning });
			docker.status = status;
			const service = makeService(new Map([["docker", docker]]), now);
			const { deviceId } = service.ensureDevice(
				{ userId, email: "a@example.com" },
				"CYPACK-1",
			);
			return { service, deviceId, docker };
		}

		it("still boots when the joined attempt left the container stopped", async () => {
			// The exact live shape: a resume is in flight when the idle sweep parks
			// the container, so the boot settles having achieved nothing. A
			// terminal-teardown wake arriving in that window must NOT conclude the
			// container is up - otherwise nothing ever starts it and only the grace
			// deadline reclaims it.
			let releaseFirst!: () => void;
			const firstBoot = new Promise<void>((r) => {
				releaseFirst = r;
			});
			const ensureRunning = vi
				.fn<() => Promise<void>>()
				.mockReturnValueOnce(firstBoot)
				.mockResolvedValue(undefined);
			const status = vi.fn(async () => "stopped" as const);
			const { service, deviceId } = seed(ensureRunning, status);

			service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
			await vi.waitFor(() => expect(ensureRunning).toHaveBeenCalledTimes(1));

			// The teardown wake lands while the first boot is still in flight.
			service.bootForTeardown(deviceId);
			releaseFirst();

			await vi.waitFor(() => expect(ensureRunning).toHaveBeenCalledTimes(2));
			expect(status).toHaveBeenCalledWith("CYPACK-1");
		});

		it("does not re-boot when the joined attempt did leave it running", async () => {
			// The dedup this join exists for: two webhooks seconds apart must not
			// drive two ensureRunning calls (the second would re-mint the device
			// token and orphan the container the first just started).
			let releaseFirst!: () => void;
			const firstBoot = new Promise<void>((r) => {
				releaseFirst = r;
			});
			const ensureRunning = vi
				.fn<() => Promise<void>>()
				.mockReturnValueOnce(firstBoot)
				.mockResolvedValue(undefined);
			const status = vi.fn(async () => "running" as const);
			const { service, deviceId } = seed(ensureRunning, status);

			service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
			await vi.waitFor(() => expect(ensureRunning).toHaveBeenCalledTimes(1));
			service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-2" });
			releaseFirst();

			await vi.waitFor(() => expect(status).toHaveBeenCalled());
			expect(ensureRunning).toHaveBeenCalledTimes(1);
		});

		it("abandons a boot that has hung past the join window and starts a fresh one", async () => {
			// A provider call that never settles must not disable booting for the
			// device forever - the teardown wake has to be able to get through.
			const ensureRunning = vi
				.fn<() => Promise<void>>()
				.mockReturnValueOnce(new Promise<void>(() => {})) // never settles
				.mockResolvedValue(undefined);
			const status = vi.fn(async () => "stopped" as const);
			let clock = 0;
			const { service, deviceId } = seed(ensureRunning, status, () => clock);

			service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
			await vi.waitFor(() => expect(ensureRunning).toHaveBeenCalledTimes(1));

			// Past the 10-minute join window.
			clock = 11 * 60_000;
			service.bootForTeardown(deviceId);

			await vi.waitFor(() => expect(ensureRunning).toHaveBeenCalledTimes(2));
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("abandoning the join"),
			);
		});

		it("boots for real when the provider cannot report status after a join", async () => {
			let releaseFirst!: () => void;
			const firstBoot = new Promise<void>((r) => {
				releaseFirst = r;
			});
			const ensureRunning = vi
				.fn<() => Promise<void>>()
				.mockReturnValueOnce(firstBoot)
				.mockResolvedValue(undefined);
			const status = vi.fn(async () => {
				throw new Error("provider unreachable");
			});
			const { service, deviceId } = seed(ensureRunning, status);

			service.boot(deviceId, { workspaceId: "ws-1", sessionId: "sess-1" });
			await vi.waitFor(() => expect(ensureRunning).toHaveBeenCalledTimes(1));
			service.bootForTeardown(deviceId);
			releaseFirst();

			await vi.waitFor(() => expect(ensureRunning).toHaveBeenCalledTimes(2));
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("could not read container status"),
			);
		});
	});
});
