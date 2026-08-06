import { execFile, execFileSync, spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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
	countingProvider,
	dedicatedDaemonOptIn,
	dockerAvailable,
	removeContainerAndVolume,
	routerHostForContainers,
	runScopedIssueKey,
	scopedProvider,
} from "./helpers/dockerDaemon.js";
// Local fixtures — same shape as apps/f1/src/router/fixtures.ts.
import {
	createdFixture,
	promptedFixture,
	seedIssue,
	seedSession,
	WORKSPACE,
} from "./helpers/fixtures.js";
import { silentLogger } from "./helpers/logger.js";

// ESM has no `__dirname`; derive it the same way the rest of the monorepo
// does (see e.g. packages/core/test/json-schema-export.test.ts).
const __dirname = dirname(fileURLToPath(import.meta.url));
// Async child-process runner: the floor round-trip boots a container that
// downloads its bundle from the SAME in-process RouterServer, so the boot MUST
// NOT block the event loop (a synchronous execFileSync would deadlock — the
// router could never serve the container's download while the call blocks).
const execFileAsync = promisify(execFile);

const IMAGE = "cyrus-worker:test";
// The host address a container uses to reach this process's RouterServer.
// Daemon-dependent (`host.docker.internal` on Docker Desktop/colima, the bridge
// gateway on plain Linux Engine), so it is resolved by each suite's `beforeAll`
// once the image it probes with exists — see `routerHostForContainers`.
let routerHost = "host.docker.internal";
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
			routerHost = routerHostForContainers(IMAGE);

			tracker = new CLIIssueTrackerService();
			tracker.seedDefaultData();
			dir = mkdtempSync(join(tmpdir(), "router-real-docker-"));
			const secrets = new SecretStore(join(dir, "secrets.json"));
			port = 3456; // fixed so the container's router URL is stable across boots

			const containers = {
				image: IMAGE,
				routerUrlForContainers: `ws://${routerHost}:${port}`,
				repositories: [
					{
						name: "hello",
						githubSlug: "octocat/Hello-World",
						linearWorkspaceId: WORKSPACE,
						baseBranch: "master",
					},
				],
				secretsPath: join(dir, "secrets.json"),
				// dbPath below is ":memory:" (dirname "."); without this override,
				// seeding the registry at construction would write into the package
				// directory instead of `dir`.
				repositoriesPath: join(dir, "repositories.json"),
				artifactsDir: join(dir, "artifacts"),
				idleStopMs: IDLE_STOP_MS,
				staleDestroyMs: STALE_DESTROY_MS,
				offlineAgeOutMs: 3_600_000,
			};
			server = new RouterServer({
				port,
				host: "0.0.0.0", // container-facing: loopback is unreachable from a container
				dbPath: ":memory:",
				workspaces: { [WORKSPACE]: { linearToken: "unused" } },
				webhook: { verificationMode: "direct", secret: "s" },
				trackerFactory: () => tracker,
				logger: silentLogger(),
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
				offlineAgeOutMs: 3_600_000,
				logger: silentLogger(),
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
				offlineAgeOutMs: 3_600_000,
				logger: silentLogger(),
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
						offlineAgeOutMs: 3_600_000,
						logger: silentLogger(),
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
			routerHost = routerHostForContainers(IMAGE);

			dir = mkdtempSync(join(tmpdir(), "router-floor-upload-"));
			const secrets = new SecretStore(join(dir, "secrets.json"));
			port = 3457; // distinct from the lifecycle suite's fixed 3456

			const containers = {
				image: IMAGE,
				routerUrlForContainers: `ws://${routerHost}:${port}`,
				repositories: [
					{
						name: "hello",
						githubSlug: "octocat/Hello-World",
						linearWorkspaceId: WORKSPACE,
						baseBranch: "master",
					},
				],
				secretsPath: join(dir, "secrets.json"),
				// dbPath below is ":memory:" (dirname "."); without this override,
				// seeding the registry at construction would write into the package
				// directory instead of `dir`.
				repositoriesPath: join(dir, "repositories.json"),
				artifactsDir: join(dir, "artifacts"),
				idleStopMs: IDLE_STOP_MS,
				staleDestroyMs: STALE_DESTROY_MS,
				offlineAgeOutMs: 3_600_000,
			};
			server = new RouterServer({
				port,
				host: "0.0.0.0", // container-facing: loopback is unreachable from a container
				dbPath: ":memory:",
				workspaces: {},
				webhook: { verificationMode: "direct", secret: "s" },
				logger: silentLogger(),
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
			const { stdout: logs } = await execFileAsync(
				"docker",
				[
					"run",
					"--rm",
					"--name",
					containerName,
					"-e",
					`CYRUS_ROUTER_URL=http://${routerHost}:${port}`,
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

// Task 11 finding (A4 worktree-reachability, recorded 2026-07-15,
// see .superpowers/sdd/vh-task-11-report.md):
//
// Code trace of packages/edge-worker/src/EdgeWorker.ts confirms
// createGitWorktree (called at L4419, inside createCyrusAgentSession,
// which is awaited at L4797) fully resolves and returns BEFORE the
// runner is constructed/started (createRunnerForType at L4918;
// runner.startStreaming/runner.start at L4954/L4958) — all within the
// single linear control flow of initializeAgentRunner(). X < Y holds
// structurally: there is no path through this handler that starts the
// runner without first having created the worktree.
//
// Trace of the router-mode prerequisites (EdgeWorker.ts +
// packages/router-client/src/RouterIssueTrackerService.ts) shows
// reaching createGitWorktree needs only:
//   (a) repository routing to resolve to "selected" (not
//       needs_selection/pendingSelection) — deterministic for a
//       single, unconfigured (catch-all) repo, as configured here; and
//   (b) a successful device->router fetchIssue RPC — the ROUTER holds
//       the real Linear OAuth tokens, not the device, so a
//       CLI-tracker-backed router serving seeded data (seedSession /
//       createdFixture, as used below) satisfies this with no real
//       Linear credentials.
// Neither depends on Claude Code OAuth token validity: the Claude
// runner is only touched at L4918/L4954-4958, strictly AFTER
// createGitWorktree returns, and ContainerBootCommand
// (apps/cli/src/commands/ContainerBootCommand.ts) only checks that
// CLAUDE_CODE_OAUTH_TOKEN is *present*, never that it's valid, before
// spawning `cyrus start`.
//
// However, per Task 11's brief, "assertion as written" requires BOTH
// this code trace AND an empirical container boot to confirm
// reachability. The empirical boot was explicitly NOT run during
// Task 11 (no docker on that machine), so this `it` was conservatively
// `it.skip`'d at the time. That empirical confirmation has since
// happened: the 2026-07-17 manual real-Claude router-mode drive
// (apps/f1/test-drives/2026-07-17-router-mode-container-drive.md)
// observed a live cyrus-issue-DEF-1 container where
// `test ! -L /workspaces/DEF-1` exited 0, `realpath` resolved to
// itself, and `stat` reported a plain directory — so the skip was
// removed per the Task 11/12 recommendation.
//
// A SEPARATE describe block, deliberately: this block's closure locals
// (`server`, `tracker`, `dir`, `port`) are private to its own
// `beforeAll`/`it` closure and are NOT visible to, or shared with, the
// suites above. It stands up its own `RouterServer` (own tmp dir, own
// fixed port distinct from the suites above's 3456/3457) so it can run
// independently of, and without interference from, those suites.
describe.skipIf(!dockerAvailable() || !dedicatedDaemonOptIn())(
	"/workspaces/<ISSUE-KEY> invariant",
	() => {
		let server: RouterServer;
		let tracker: CLIIssueTrackerService;
		let dir: string;
		let port: number;
		const issueKey = runScopedIssueKey("CYDIR");
		const containerName = `cyrus-issue-${issueKey}`;

		beforeAll(async () => {
			// Build the worker image (cached; same pattern as the suites above).
			execFileSync(
				"docker",
				["build", "-f", "docker/worker/Dockerfile", "-t", IMAGE, "."],
				{
					cwd: join(__dirname, "..", "..", ".."),
					stdio: "inherit",
				},
			);
			routerHost = routerHostForContainers(IMAGE);

			tracker = new CLIIssueTrackerService();
			tracker.seedDefaultData();
			dir = mkdtempSync(join(tmpdir(), "router-workspaces-dir-"));
			const secrets = new SecretStore(join(dir, "secrets.json"));
			port = 3458; // fixed; distinct from the lifecycle suite's 3456 and the floor-upload suite's 3457

			const containers = {
				image: IMAGE,
				routerUrlForContainers: `ws://${routerHost}:${port}`,
				repositories: [
					{
						name: "hello",
						githubSlug: "octocat/Hello-World",
						linearWorkspaceId: WORKSPACE,
						baseBranch: "master",
					},
				],
				secretsPath: join(dir, "secrets.json"),
				// dbPath below is ":memory:" (dirname "."); without this override,
				// seeding the registry at construction would write into the package
				// directory instead of `dir`.
				repositoriesPath: join(dir, "repositories.json"),
				artifactsDir: join(dir, "artifacts"),
				idleStopMs: IDLE_STOP_MS,
				staleDestroyMs: STALE_DESTROY_MS,
				offlineAgeOutMs: 3_600_000,
			};
			server = new RouterServer({
				port,
				host: "0.0.0.0", // container-facing: loopback is unreachable from a container
				dbPath: ":memory:",
				workspaces: { [WORKSPACE]: { linearToken: "unused" } },
				webhook: { verificationMode: "direct", secret: "s" },
				trackerFactory: () => tracker,
				logger: silentLogger(),
				containers,
				// Scoped so BOTH the container-targets executor AND RouterServer's
				// own internal periodic sweep are bounded to this run's container —
				// see the identical rationale on the suites above.
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

		it("is a real directory, not a symlink, and realpath-stable", async () => {
			seedSession(tracker, "sess-dir", "issue-dir");
			// The in-container EdgeWorker fetches the full issue before creating
			// the worktree — without this the webhook 404s and /workspaces/<KEY>
			// never appears (see seedIssue's doc comment).
			seedIssue(tracker, {
				id: "issue-dir",
				identifier: issueKey,
				title: "dir",
			});
			await server.eventRouter.route(
				createdFixture({
					sessionId: "sess-dir",
					issue: { id: "issue-dir", identifier: issueKey, title: "dir" },
					creator: { id: "lin-e2e", email: "e2e@example.com", name: "E2E" },
				}),
			);
			// Wait until the worktree exists inside the container.
			await vi.waitFor(
				() => {
					const r = execFileSync(
						"docker",
						["exec", containerName, "test", "-d", `/workspaces/${issueKey}`],
						{ stdio: "ignore" },
					);
					return r;
				},
				{ timeout: 90_000 },
			);
			// Assert: directory, NOT a symlink, realpath resolves to itself.
			execFileSync("docker", [
				"exec",
				containerName,
				"test",
				"!",
				"-L",
				`/workspaces/${issueKey}`,
			]);
			// `stat` uses lstat(2) by default (only `stat -L` dereferences), so
			// this is the direct lstat assertion the invariant is stated in
			// terms of: a symlink here would report "symbolic link", and the
			// `test -d` above (which DOES follow links) would have passed
			// anyway. Together with `test ! -L` that pins the file type at the
			// path itself, not at whatever it might point to.
			const fileType = execFileSync(
				"docker",
				["exec", containerName, "stat", "-c", "%F", `/workspaces/${issueKey}`],
				{ encoding: "utf-8" },
			).trim();
			expect(fileType).toBe("directory");
			const real = execFileSync(
				"docker",
				["exec", containerName, "realpath", `/workspaces/${issueKey}`],
				{ encoding: "utf-8" },
			).trim();
			expect(real).toBe(`/workspaces/${issueKey}`);
			removeContainerAndVolume(containerName);
		}, 180_000);
	},
);

/**
 * A SEPARATE describe block, deliberately (same rationale as the blocks above:
 * their closure locals are private to their own `beforeAll`/`it`). Own tmp dir,
 * own fixed port distinct from 3456/3457/3458.
 *
 * Boot serialization / dedup — the fourth lifecycle behaviour spec A2 asks for,
 * and the only one that had no real-daemon coverage: `containers-e2e.test.ts`
 * scenario 5 proves it against a `FakeBootExecutor` whose `ensureRunning` parks
 * on a hand-held gate. Against the real provider the "still cold-booting"
 * window is a genuine `docker run`/`docker start` round-trip, so this also
 * proves the window is real (not an artifact of the fake's gate) and that the
 * dedup holds across the whole of it.
 */
describe.skipIf(!dockerAvailable() || !dedicatedDaemonOptIn())(
	"real-Docker boot serialization",
	() => {
		let server: RouterServer;
		let tracker: CLIIssueTrackerService;
		let dir: string;
		let port: number;
		let docker: ReturnType<typeof countingProvider>;
		const issueKey = runScopedIssueKey("CYSER");
		const containerName = `cyrus-issue-${issueKey}`;

		beforeAll(async () => {
			// Build the worker image (cached; same pattern as the suites above).
			execFileSync(
				"docker",
				["build", "-f", "docker/worker/Dockerfile", "-t", IMAGE, "."],
				{
					cwd: join(__dirname, "..", "..", ".."),
					stdio: "inherit",
				},
			);
			routerHost = routerHostForContainers(IMAGE);

			tracker = new CLIIssueTrackerService();
			tracker.seedDefaultData();
			dir = mkdtempSync(join(tmpdir(), "router-boot-serialization-"));
			const secrets = new SecretStore(join(dir, "secrets.json"));
			port = 3459; // fixed; distinct from 3456 / 3457 / 3458 above

			// Counting AND scoped: the count is the observable under test, the
			// scope keeps this suite's `sweep()`s (RouterServer's own 60s
			// interval included) from GC'ing anything outside this run — see the
			// identical rationale on the suites above.
			docker = countingProvider(
				scopedProvider(
					new LocalDockerProvider({ image: IMAGE }),
					new Set([issueKey]),
				),
			);
			server = new RouterServer({
				port,
				host: "0.0.0.0", // container-facing: loopback is unreachable from a container
				dbPath: ":memory:",
				workspaces: { [WORKSPACE]: { linearToken: "unused" } },
				webhook: { verificationMode: "direct", secret: "s" },
				trackerFactory: () => tracker,
				logger: silentLogger(),
				containers: {
					image: IMAGE,
					routerUrlForContainers: `ws://${routerHost}:${port}`,
					repositories: [
						{
							name: "hello",
							githubSlug: "octocat/Hello-World",
							linearWorkspaceId: WORKSPACE,
							baseBranch: "master",
						},
					],
					secretsPath: join(dir, "secrets.json"),
					// dbPath below is ":memory:" (dirname "."); without this override,
					// seeding the registry at construction would write into the package
					// directory instead of `dir`.
					repositoriesPath: join(dir, "repositories.json"),
					artifactsDir: join(dir, "artifacts"),
					idleStopMs: IDLE_STOP_MS,
					staleDestroyMs: STALE_DESTROY_MS,
					offlineAgeOutMs: 3_600_000,
				},
				executorRegistryFactory: () => new Map([["docker", docker]]),
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

		it("created then prompted for the same still-cold-booting issue coalesce into one real docker run", async () => {
			const creator = {
				id: "lin-e2e",
				email: "e2e@example.com",
				name: "E2E",
			};
			const issue = { id: "issue-ser", identifier: issueKey, title: "ser" };
			seedSession(tracker, "sess-ser", "issue-ser");
			seedIssue(tracker, issue);

			await server.eventRouter.route(
				createdFixture({ sessionId: "sess-ser", issue, creator }),
			);
			// `ContainerTargetService.boot` never awaits `ensureRunning`, but its
			// synchronous prefix (resolve device → check `inFlightBoots` → call
			// `ensureRunning` down to the wrapper's push) runs inside `route()`'s
			// own call stack. So the first boot is recorded, and genuinely still
			// in flight (a real `docker run` against the daemon), by the time
			// `route()` settles.
			expect(docker.ensureRunningCalls).toEqual([issueKey]);
			expect(docker.resolvedCount).toBe(0);

			// The follow-up prompt Linear sends seconds after `created`, arriving
			// while `docker run` is still going. Resolves via session affinity
			// rather than ensureDevice, but hits the same `deliverOrNotify` choke
			// point and calls `boot()` again for the SAME device id — the exact
			// race `inFlightBoots` exists to dedupe.
			await server.eventRouter.route(
				promptedFixture({
					sessionId: "sess-ser",
					actorUserId: creator.id,
					creator,
					issue,
					body: "already going?",
				}),
			);
			expect(docker.ensureRunningCalls).toEqual([issueKey]);

			// Let the single in-flight boot settle, then check the daemon: one
			// container, and exactly one container device row (a broken dedup
			// mints a second token and starts a second boot, orphaning the
			// container that actually won).
			await vi.waitFor(() => expect(docker.resolvedCount).toBe(1), {
				timeout: 60_000,
			});
			await vi.waitFor(
				() => expect(containerState(containerName)).toBe("running"),
				{ timeout: 60_000 },
			);
			expect(docker.ensureRunningCalls).toEqual([issueKey]);
			const names = execFileSync(
				"docker",
				[
					"ps",
					"-a",
					"--filter",
					`label=cyrus.issue=${issueKey}`,
					"--format",
					"{{.Names}}",
				],
				{ encoding: "utf-8" },
			)
				.split("\n")
				.filter(Boolean);
			expect(names).toEqual([containerName]);
			expect(
				server.store
					.listContainerDevices()
					.filter((d) => d.issueKey === issueKey),
			).toHaveLength(1);
		}, 180_000);
	},
);

/**
 * A SEPARATE describe block, deliberately (same rationale as the blocks above).
 * Own tmp dir, own fixed port distinct from 3456/3457/3458/3459.
 *
 * The floor's UPLOAD half, fired by the container's OWN production trigger.
 * The "floor upload round-trip" block above proves the transport and the
 * artifact endpoint, but it builds and PUTs the bundle from the test process:
 * nothing in it runs `WorkspaceSyncService` inside a container, so the
 * trigger → `pushWipIfDirty` → `buildBundle` → `uploadBundle` chain is not what
 * it exercises. Here the bundle that lands at `/artifacts` is produced by the
 * in-container EdgeWorker's own floor, from a real worktree it created itself,
 * and the fresh-container restore reads back that container-produced bundle.
 *
 * No Claude token is needed: `WorkspaceSyncService` is constructed and
 * `touch()`ed at the top of `initializeAgentRunner` (EdgeWorker.ts) — i.e.
 * before the runner is ever built — and the WIP push's failure (no GitHub
 * credential for octocat/Hello-World) is swallowed and logged by design so the
 * bundle upload still proceeds; see `pushWipSafely` in
 * packages/edge-worker/src/WorkspaceSyncService.ts.
 *
 * WHICH trigger fires is deliberately not pinned, because with a deliberately
 * invalid Claude token it is not ours to choose. Observed across repeated real
 * runs, the Agent SDK either returns its 401 as an error *result* — the session
 * reaches a terminal state within seconds and the floor's session-end hook
 * (`syncIssueOnTermination`, wired at EdgeWorker.ts's terminal-state listener)
 * uploads — or never produces a result at all, leaving the session live, the
 * issue in the floor's touched set, and the upload to the periodic tick
 * (`DEFAULT_INTERVAL_MS`, 5 minutes). Both are production triggers on the same
 * `syncIssue` path, so the wait below spans both and the assertion is the union:
 * a real bundle, built by a real in-container floor, lands at the artifact
 * endpoint. The third trigger — the stop-time flush
 * (`WorkspaceSyncService.stop()`) — cannot be forced from here (by the time the
 * container can be stopped the floor has usually converged and deliberately
 * stopped protecting the issue), so what this suite pins about idle-stop is the
 * container-level precondition that flush depends on: SIGTERM is delivered and
 * handled rather than the container being SIGKILLed. The flush itself is
 * covered by packages/edge-worker/test/WorkspaceSyncService.test.ts ("flushes a
 * live (un-ended) session's work on stop()").
 */
describe.skipIf(!dockerAvailable() || !dedicatedDaemonOptIn())(
	"floor upload fired by a real in-container session",
	() => {
		let server: RouterServer;
		let tracker: CLIIssueTrackerService;
		let dir: string;
		let port: number;
		let userId: number;
		/**
		 * Set when the booted container stopped/vanished before its floor ever
		 * flushed. That is an environment failure, not a floor failure (the
		 * container never got the chance the assertion is about), so the tests
		 * below skip on it rather than reporting a red that says nothing about
		 * the code under test. A container that is still RUNNING and has not
		 * uploaded is the opposite — a genuine floor regression — and fails.
		 */
		let containerDiedEarly: string | undefined;
		const issueKey = runScopedIssueKey("CYFLIVE");
		const containerName = `cyrus-issue-${issueKey}`;
		const bundleFile = () => join(dir, "artifacts", issueKey, "bundle.tar.gz");
		// Both streams, concatenated: the container's logger splits info to
		// stdout and warn/error to stderr, and the lines asserted on below span
		// both, so a stdout-only read would be a flaky oracle.
		const containerLogs = (): string => {
			const r = spawnSync("docker", ["logs", containerName], {
				encoding: "utf-8",
				maxBuffer: 64 * 1024 * 1024,
			});
			return `${r.stdout ?? ""}${r.stderr ?? ""}`;
		};
		/**
		 * Polls for the session's worktree, bailing out (and recording why in
		 * {@link containerDiedEarly}) the moment the container stops running.
		 * Resolves `true` once `/workspaces/<KEY>` exists.
		 */
		const waitForWorktree = async (): Promise<boolean> => {
			const deadline = Date.now() + 120_000;
			while (Date.now() < deadline) {
				const probe = spawnSync(
					"docker",
					["exec", containerName, "test", "-d", `/workspaces/${issueKey}`],
					{ stdio: "ignore" },
				);
				if (probe.status === 0) return true;
				const state = containerState(containerName);
				if (state !== "running") {
					containerDiedEarly = state;
					return false;
				}
				await new Promise((resolve) => setTimeout(resolve, 1_000));
			}
			return false;
		};

		beforeAll(async () => {
			// Build the worker image (cached; same pattern as the suites above).
			execFileSync(
				"docker",
				["build", "-f", "docker/worker/Dockerfile", "-t", IMAGE, "."],
				{
					cwd: join(__dirname, "..", "..", ".."),
					stdio: "inherit",
				},
			);
			routerHost = routerHostForContainers(IMAGE);

			tracker = new CLIIssueTrackerService();
			tracker.seedDefaultData();
			dir = mkdtempSync(join(tmpdir(), "router-floor-live-"));
			const secrets = new SecretStore(join(dir, "secrets.json"));
			port = 3460; // fixed; distinct from 3456 / 3457 / 3458 / 3459 above

			server = new RouterServer({
				port,
				host: "0.0.0.0", // container-facing: loopback is unreachable from a container
				dbPath: ":memory:",
				workspaces: { [WORKSPACE]: { linearToken: "unused" } },
				webhook: { verificationMode: "direct", secret: "s" },
				trackerFactory: () => tracker,
				logger: silentLogger(),
				containers: {
					image: IMAGE,
					routerUrlForContainers: `ws://${routerHost}:${port}`,
					repositories: [
						{
							name: "hello",
							githubSlug: "octocat/Hello-World",
							linearWorkspaceId: WORKSPACE,
							baseBranch: "master",
						},
					],
					secretsPath: join(dir, "secrets.json"),
					// dbPath below is ":memory:" (dirname "."); without this override,
					// seeding the registry at construction would write into the package
					// directory instead of `dir`.
					repositoriesPath: join(dir, "repositories.json"),
					artifactsDir: join(dir, "artifacts"),
					// Deliberately huge: this suite drives idle-stop itself, with an
					// injected clock, at the exact point it wants it. RouterServer's
					// own 60s internal sweep must not idle-stop the container out
					// from under the session mid-test.
					idleStopMs: STALE_DESTROY_MS,
					staleDestroyMs: STALE_DESTROY_MS,
					offlineAgeOutMs: 3_600_000,
				},
				// Scoped so BOTH the container-targets executor AND RouterServer's
				// own internal periodic sweep are bounded to this run's container —
				// see the identical rationale on the suites above.
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
				email: "e2e@example.com",
				linearId: "lin-e2e",
			});
			userId = added.userId;
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

		it("PUTs a bundle built by the container's own floor to the router artifact endpoint", async (ctx) => {
			const issue = { id: "issue-live", identifier: issueKey, title: "live" };
			seedSession(tracker, "sess-live", "issue-live");
			// The in-container EdgeWorker fetches the full issue over router RPC
			// before creating the worktree — without this the webhook 404s and no
			// workspace (hence nothing for the floor to protect) ever exists.
			seedIssue(tracker, issue);
			await server.eventRouter.route(
				createdFixture({
					sessionId: "sess-live",
					issue,
					creator: { id: "lin-e2e", email: "e2e@example.com", name: "E2E" },
				}),
			);
			await vi.waitFor(
				() => expect(containerState(containerName)).toBe("running"),
				{ timeout: 60_000 },
			);
			// Wait for the worktree the session created — the workspace path the
			// floor will WIP-push and bundle. Same running-container guard as the
			// bundle wait below: a container that has gone away can neither create
			// a worktree nor flush, and calling that a floor failure would be a
			// lie about what was observed.
			if (!(await waitForWorktree())) {
				// Still running but no worktree is a real failure (the session
				// never reached GitService); gone is an environment failure.
				if (!containerDiedEarly) {
					throw new Error(
						`container is still running but never created /workspaces/${issueKey}`,
					);
				}
				ctx.skip(
					`container went ${containerDiedEarly} before creating its worktree — nothing to assert about the upload path on this daemon`,
				);
				return;
			}
			// Dirty it, so the floor's WIP-push leg has real work to do (the push
			// itself fails — no GitHub credential — which is logged and swallowed;
			// the bundle upload proceeds regardless, which is the leg under test).
			execFileSync("docker", [
				"exec",
				containerName,
				"sh",
				"-c",
				`echo floor-upload-e2e > /workspaces/${issueKey}/FLOOR.txt`,
			]);

			// Wide enough to span both reachable triggers (see the block comment):
			// session end lands in ~5s, the periodic tick at 5 minutes. Bails out
			// early — rather than burning the whole window — the moment the
			// container is no longer running, since a container that is gone can
			// never flush and the distinction between "died" and "did not upload"
			// is what makes the outcome meaningful.
			const deadline = Date.now() + 6.5 * 60_000;
			while (!existsSync(bundleFile()) && Date.now() < deadline) {
				const state = containerState(containerName);
				if (state !== "running") {
					containerDiedEarly = state;
					break;
				}
				await new Promise((resolve) => setTimeout(resolve, 1_000));
			}
			if (containerDiedEarly && !existsSync(bundleFile())) {
				ctx.skip(
					`container went ${containerDiedEarly} before its floor flushed — nothing to assert about the upload path on this daemon`,
				);
				return;
			}

			expect(existsSync(bundleFile())).toBe(true);
			expect(statSync(bundleFile()).size).toBeGreaterThan(0);
			// Attribute the bundle to the container's own floor rather than
			// inferring it from the file's existence, and pin that the WIP-push
			// leg ran over exactly the one workspace this session created.
			expect(containerLogs()).toContain(
				`WorkspaceSyncService: synced issue ${issueKey} (1 workspace(s), bundle uploaded)`,
			);
		}, 480_000);

		it("idle-stop parks the container through its graceful shutdown path", async (ctx) => {
			if (containerDiedEarly) {
				ctx.skip(`container went ${containerDiedEarly} during the boot above`);
				return;
			}
			// The container-level risk the floor's stop-time flush runs into is
			// being SIGKILLed before it can finish; `docker stop -t 30` exists to
			// buy it room (see DOCKER_STOP_TIMEOUT_SECONDS in LocalDockerProvider).
			// So drive the REAL idle-stop path — sweep() with an injected clock past
			// idleStopMs → provider.stop() → `docker stop -t 30` → SIGTERM →
			// container-boot forwards it to `cyrus start` → EdgeWorker.stop() →
			// WorkspaceSyncService.stop() — and assert the container reached its
			// SIGTERM handler and parked, rather than dying on the grace timer.
			// Affinity must be cleared first: sweep() never touches a device with a
			// live session, and that safety invariant is what a terminal
			// session_state frame releases in a real run.
			server.store.clearSessionAffinity("sess-live");
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
				offlineAgeOutMs: 3_600_000,
				logger: silentLogger(),
				now: () => Date.now() + IDLE_STOP_MS + 5_000,
			});
			await lifecycle.sweep();
			await vi.waitFor(
				() => expect(containerState(containerName)).toBe("stopped"),
				{ timeout: 60_000 },
			);
			expect(containerLogs()).toContain("shutting down gracefully");
			// The bundle the floor uploaded must survive the stop — it is the only
			// copy of this session's state once the volume goes away below.
			expect(existsSync(bundleFile())).toBe(true);
		}, 120_000);

		it("a fresh container restores from that container-produced bundle (rung 2)", async (ctx) => {
			if (containerDiedEarly) {
				ctx.skip(`container went ${containerDiedEarly} during the boot above`);
				return;
			}
			expect(existsSync(bundleFile())).toBe(true);
			// Destroy the container AND its volume: rung 2 (download + restore the
			// bundle) is only reachable with no warm volume to resume from.
			removeContainerAndVolume(containerName);

			// `devices.issue_key` is UNIQUE for container rows, and the router
			// already minted one for the container booted above — so drop it first,
			// exactly as `router containers destroy <issueKey>` does, before minting
			// the fresh device the replacement container authenticates with. (The
			// synthetic "floor upload round-trip" suite never boots a
			// router-managed container for its key, so it can mint straight away.)
			const stale = server.store.getContainerDeviceForIssue(issueKey);
			if (stale) server.store.deleteContainerDevice(stale.deviceId);
			const { deviceToken } = server.store.createContainerDevice(
				userId,
				issueKey,
				"docker",
			);
			// `container-boot --restore-only` runs the restore ladder and returns
			// without launching `cyrus start`, so its stdout is exactly the restore
			// log line asserted on.
			const { stdout: logs } = await execFileAsync(
				"docker",
				[
					"run",
					"--rm",
					"--name",
					containerName,
					"-e",
					`CYRUS_ROUTER_URL=http://${routerHost}:${port}`,
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
