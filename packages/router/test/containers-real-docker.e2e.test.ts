import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLIIssueTrackerService } from "cyrus-core";
import { LocalDockerProvider } from "cyrus-router-executors";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ContainerLifecycle } from "../src/ContainerLifecycle.js";
import { RouterServer } from "../src/RouterServer.js";
import { SecretStore } from "../src/SecretStore.js";
import {
	containerState,
	dedicatedDaemonOptIn,
	dockerAvailable,
	removeContainerAndVolume,
	runScopedIssueKey,
	scopedProvider,
} from "./helpers/dockerDaemon.js";
// Local fixtures — same shape as apps/f1/src/router/fixtures.ts.
import { createdFixture, seedSession, WORKSPACE } from "./helpers/fixtures.js";

// ESM has no `__dirname`; derive it the same way the rest of the monorepo
// does (see e.g. packages/core/test/json-schema-export.test.ts).
const __dirname = dirname(fileURLToPath(import.meta.url));

const IMAGE = "cyrus-worker:test";
const IDLE_STOP_MS = 60_000;
const STALE_DESTROY_MS = 14 * 24 * 60 * 60_000;

// Whole-suite gate: sweep() runs orphan GC host-wide, so ALL of these tests
// require the dedicated-daemon opt-in, not just the orphan-GC scenario.
describe.skipIf(!dockerAvailable() || !dedicatedDaemonOptIn())(
	"real-Docker container lifecycle",
	() => {
		let server: RouterServer;
		let tracker: CLIIssueTrackerService;
		let dir: string;
		let port: number;
		const issueKey = runScopedIssueKey("CYE2E");
		const containerName = `cyrus-issue-${issueKey}`;

		beforeAll(async () => {
			// Build the worker image (skip suite on failure).
			execFileSync(
				"docker",
				["build", "-f", "docker/worker/Dockerfile", "-t", IMAGE, "."],
				{
					cwd: join(__dirname, "..", "..", ".."),
					stdio: "inherit",
				},
			);

			tracker = new CLIIssueTrackerService();
			tracker.seedDefaultData();
			dir = mkdtempSync(join(tmpdir(), "router-real-docker-"));
			const secrets = new SecretStore(join(dir, "secrets.json"));
			port = 3456; // fixed so host.docker.internal:3456 resolves from the container

			const containers = {
				image: IMAGE,
				routerUrlForContainers: `ws://host.docker.internal:${port}`,
				repositories: [
					{
						name: "hello",
						githubSlug: "octocat/Hello-World",
						linearWorkspaceId: WORKSPACE,
						baseBranch: "master",
					},
				],
				secretsPath: join(dir, "secrets.json"),
				artifactsDir: join(dir, "artifacts"),
				idleStopMs: IDLE_STOP_MS,
				staleDestroyMs: STALE_DESTROY_MS,
			};
			server = new RouterServer({
				port,
				host: "0.0.0.0", // container-facing: reachable from host.docker.internal
				dbPath: ":memory:",
				workspaces: { [WORKSPACE]: { linearToken: "unused" } },
				webhook: { verificationMode: "direct", secret: "s" },
				trackerFactory: () => tracker,
				logger: { info: () => {}, warn: () => {} },
				containers,
				// Scoped so BOTH the container-targets executor AND RouterServer's own
				// internal periodic sweep (the `setInterval` in `start()` that calls
				// `this.containerLifecycle?.sweep()` every 60s) are bounded to this
				// run's container. An unscoped provider here would let that internal
				// sweep's host-wide orphan GC destroy foreign `cyrus.issue`-labelled
				// containers on a shared/dedicated daemon while the server is alive.
				executorRegistryFactory: () =>
					new Map([
						[
							"docker",
							scopedProvider(
								new LocalDockerProvider({ image: IMAGE }),
								new Set([issueKey]),
							),
						],
					]),
			});
			await server.start();
			server.store.addUser({ email: "e2e@example.com", linearId: "lin-e2e" });
			server.store.setUserExecutor(
				"e2e@example.com",
				JSON.stringify({ type: "docker" }),
			);
			secrets.set(
				"e2e@example.com",
				"claudeOauthToken",
				"fake-oauth-not-used-for-boot",
			);
		}, 300_000);

		afterAll(async () => {
			removeContainerAndVolume(containerName);
			await server?.stop();
			rmSync(dir, { recursive: true, force: true });
		});

		it("cold boot creates a real container, then idle-stop stops it (volume retained)", async () => {
			seedSession(tracker, "sess-e2e", "issue-e2e");
			await server.eventRouter.route(
				createdFixture({
					sessionId: "sess-e2e",
					issue: { id: "issue-e2e", identifier: issueKey, title: "e2e" },
					creator: { id: "lin-e2e", email: "e2e@example.com", name: "E2E" },
				}),
			);
			await vi.waitFor(
				() => expect(containerState(containerName)).toBe("running"),
				{ timeout: 60_000 },
			);

			// In a real run the container clears this via a terminal session_state
			// frame; clear it deterministically here so the injected-clock sweep
			// reaches the idle-stop branch (sweep() skips rows whose session
			// affinity is still active, and affinity is still active here — the
			// container only just reported "running").
			server.store.clearSessionAffinity("sess-e2e");

			// Idle-stop via a second lifecycle sharing the store, with an injected clock.
			// Scope the provider so this sweep()'s orphan GC can only see OUR container.
			const allowed = new Set([issueKey]);
			const lifecycle = new ContainerLifecycle({
				store: server.store,
				executors: new Map([
					[
						"docker",
						scopedProvider(new LocalDockerProvider({ image: IMAGE }), allowed),
					],
				]),
				idleStopMs: IDLE_STOP_MS,
				staleDestroyMs: STALE_DESTROY_MS,
				logger: { info: () => {}, warn: () => {} },
				now: () => Date.now() + IDLE_STOP_MS + 5_000,
			});
			await lifecycle.sweep();
			await vi.waitFor(
				() => expect(containerState(containerName)).toBe("stopped"),
				{ timeout: 40_000 },
			);
			// Volume must still exist (warm restart path depends on it).
			const vols = execFileSync(
				"docker",
				["volume", "ls", "-q", "-f", `name=${containerName}`],
				{ encoding: "utf-8" },
			);
			expect(vols).toContain(containerName);
		}, 120_000);

		it("stale-destroy removes the container AND its volume", async () => {
			// Reuses the container booted in the previous test (or re-boots one).
			// Scoped provider — this sweep()'s orphan GC must not reach beyond our key.
			const lifecycle = new ContainerLifecycle({
				store: server.store,
				executors: new Map([
					[
						"docker",
						scopedProvider(
							new LocalDockerProvider({ image: IMAGE }),
							new Set([issueKey]),
						),
					],
				]),
				idleStopMs: IDLE_STOP_MS,
				staleDestroyMs: STALE_DESTROY_MS,
				logger: { info: () => {}, warn: () => {} },
				now: () => Date.now() + STALE_DESTROY_MS + 5_000,
			});
			await lifecycle.sweep();
			await vi.waitFor(
				() => expect(containerState(containerName)).toBe("absent"),
				{ timeout: 40_000 },
			);
			const vols = execFileSync(
				"docker",
				["volume", "ls", "-q", "-f", `name=${containerName}`],
				{ encoding: "utf-8" },
			);
			expect(vols.trim()).toBe("");
		}, 120_000);

		it.skipIf(!dedicatedDaemonOptIn())(
			"orphan GC destroys a labelled container with no device row (DEDICATED DAEMON ONLY)",
			async () => {
				// Create a container carrying the cyrus.issue label but NO store device row.
				const orphanKey = runScopedIssueKey("CYORPH");
				const orphanName = `cyrus-issue-${orphanKey}`;
				execFileSync("docker", [
					"run",
					"-d",
					"--name",
					orphanName,
					"--label",
					`cyrus.issue=${orphanKey}`,
					IMAGE,
					"sleep",
					"600",
				]);
				try {
					const lifecycle = new ContainerLifecycle({
						store: server.store,
						executors: new Map([
							["docker", new LocalDockerProvider({ image: IMAGE })],
						]),
						idleStopMs: IDLE_STOP_MS,
						staleDestroyMs: STALE_DESTROY_MS,
						logger: { info: () => {}, warn: () => {} },
						now: () => Date.now(),
					});
					await lifecycle.sweep();
					await vi.waitFor(
						() => expect(containerState(orphanName)).toBe("absent"),
						{ timeout: 40_000 },
					);
				} finally {
					removeContainerAndVolume(orphanName);
				}
			},
			120_000,
		);
	},
);
