import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	AgentSessionStatus,
	AgentSessionType,
	CLIIssueTrackerService,
	type SerializableEdgeWorkerState,
} from "cyrus-core";
import { LocalDockerProvider } from "cyrus-router-executors";
import {
	buildBundle,
	sanitizeCwdForClaudeProjects,
	uploadBundle,
} from "cyrus-workspace-sync";
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

/**
 * A SEPARATE describe block, deliberately: the block above's closure locals
 * (`server`, `dir`, `port`, `tracker`) are private to that `beforeAll`/`it`
 * closure and are NOT visible here. This block stands up its own
 * `RouterServer` (own tmp dir, own fixed port distinct from the block
 * above's 3456) so it can run independently of, and without interference
 * from, the container-lifecycle suite above.
 */
describe.skipIf(!dockerAvailable() || !dedicatedDaemonOptIn())(
	"floor upload round-trip",
	() => {
		let server: RouterServer;
		let dir: string;
		let port: number;
		let userId: number;
		const issueKey = runScopedIssueKey("CYFLOOR");
		const containerName = `cyrus-issue-${issueKey}`;

		beforeAll(async () => {
			// Build the worker image (cached; same pattern as the suite above).
			execFileSync(
				"docker",
				["build", "-f", "docker/worker/Dockerfile", "-t", IMAGE, "."],
				{
					cwd: join(__dirname, "..", "..", ".."),
					stdio: "inherit",
				},
			);

			dir = mkdtempSync(join(tmpdir(), "router-floor-upload-"));
			const secrets = new SecretStore(join(dir, "secrets.json"));
			port = 3457; // distinct from the lifecycle suite's fixed 3456

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
				workspaces: {},
				webhook: { verificationMode: "direct", secret: "s" },
				logger: { info: () => {}, warn: () => {} },
				containers,
				// Scoped so BOTH the artifact-upload path AND RouterServer's own
				// internal periodic sweep are bounded to this run's container — see
				// the identical rationale on the suite above.
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
			const added = server.store.addUser({
				email: "floor-e2e@example.com",
				linearId: "lin-floor-e2e",
			});
			userId = added.userId;
			server.store.setUserExecutor(
				"floor-e2e@example.com",
				JSON.stringify({ type: "docker" }),
			);
			secrets.set(
				"floor-e2e@example.com",
				"claudeOauthToken",
				"fake-oauth-not-used-for-boot",
			);
		}, 300_000);

		afterAll(async () => {
			removeContainerAndVolume(containerName);
			await server?.stop();
			rmSync(dir, { recursive: true, force: true });
		});

		it("a bundle PUT to /artifacts lands, and a fresh container restores it (rung 2)", async () => {
			// 1. Build a minimal but valid bundle from a synthetic state + transcript.
			const workDir = mkdtempSync(join(tmpdir(), "floor-src-"));
			const claudeProjects = join(workDir, "claude-projects");
			const wsPath = `/workspaces/${issueKey}`;
			// A transcript dir keyed to the sanitized workspace cwd — mirrors
			// exactly how ContainerBootCommand/buildBundle locate it.
			const transcriptDir = join(
				claudeProjects,
				sanitizeCwdForClaudeProjects(wsPath),
			);
			mkdirSync(transcriptDir, { recursive: true });
			writeFileSync(join(transcriptDir, "abc.jsonl"), '{"type":"summary"}\n');

			const state: SerializableEdgeWorkerState = {
				agentSessions: {
					"sess-floor": {
						id: "sess-floor",
						type: AgentSessionType.CommentThread,
						status: AgentSessionStatus.Active,
						context: AgentSessionType.CommentThread,
						createdAt: Date.now(),
						updatedAt: Date.now(),
						issue: {
							id: "issue-floor",
							identifier: issueKey,
							title: "floor upload round-trip",
							branchName: issueKey,
						},
						repositories: [],
						workspace: { path: wsPath, isGitWorktree: true },
						claudeSessionId: "abc",
					},
				},
				agentSessionEntries: { "sess-floor": [] },
			};

			const outFile = join(workDir, "bundle.tar.gz");
			const built = await buildBundle({
				issueKey,
				state,
				claudeProjectsDir: claudeProjects,
				outFile,
			});
			expect(built).toBe(true);

			// 2. Mint a container device token for this issue and PUT the bundle.
			const { deviceToken } = server.store.createContainerDevice(
				userId,
				issueKey,
				"docker",
			);
			await uploadBundle(
				`http://127.0.0.1:${port}`,
				deviceToken,
				issueKey,
				outFile,
			);

			// 3. Assert it landed on the artifact store — stat the host fs directly.
			expect(
				existsSync(join(dir, "artifacts", issueKey, "bundle.tar.gz")),
			).toBe(true);

			// 4. Boot a FRESH container (fresh volume) and assert rung-2 restore:
			//    `container-boot --restore-only` runs the restore ladder and returns
			//    without launching `cyrus start`, so its stdout is exactly the
			//    restore log line we assert on.
			const logs = execFileSync(
				"docker",
				[
					"run",
					"--rm",
					"--name",
					containerName,
					"-e",
					`CYRUS_ROUTER_URL=http://host.docker.internal:${port}`,
					"-e",
					`CYRUS_DEVICE_TOKEN=${deviceToken}`,
					"-e",
					`CYRUS_ISSUE_KEY=${issueKey}`,
					"-e",
					"CYRUS_REPOS_JSON=[]",
					"-e",
					"CLAUDE_CODE_OAUTH_TOKEN=unused",
					"--entrypoint",
					"node",
					IMAGE,
					"/app/dist/src/app.js",
					"container-boot",
					"--restore-only",
				],
				{ encoding: "utf-8" },
			);
			expect(logs).toContain("Restored");
		}, 180_000);
	},
);
