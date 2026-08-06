// apps/f1/src/router/RouterRig.ts
import { CLIIssueTrackerService, type IIssueTrackerService } from "cyrus-core";
import { RouterServer, SecretStore, type SetupUiConfig } from "cyrus-router";
import type { ContainerExecutor } from "cyrus-router-executors";
import { allocatePort } from "./allocatePort.js";
import { WORKSPACE } from "./fixtures.js";

/** Mirrors `RouterContainersConfig["repositories"][number]` (not exported from `cyrus-router`). */
export interface RigRepositoryConfig {
	name: string;
	githubSlug: string;
	linearWorkspaceId: string;
	baseBranch?: string;
	teamKeys?: string[];
	projectKeys?: string[];
	routingLabels?: string[];
	isDefault?: boolean;
}

export interface RouterRig {
	server: RouterServer;
	tracker: CLIIssueTrackerService;
	port: number;
	seedUser(opts: {
		email: string;
		linearId: string;
		provider: string;
		claudeOauthToken: string;
		env?: Record<string, string>;
	}): void;
	stop(): Promise<void>;
}

export interface RouterRigOptions {
	dbPath: string;
	secretsPath: string;
	artifactsDir: string;
	host?: string;
	image?: string;
	executors?: Map<string, ContainerExecutor>;
	idleStopMs?: number;
	staleDestroyMs?: number;
	/**
	 * Extra env-var names a user must have seeded before their containers
	 * boot, on top of the always-required Claude token (forwarded to
	 * `containers.requiredSecretKeys` on the RouterServer).
	 */
	requiredSecretKeys?: string[];
	logger?: { info(m: string): void; warn(m: string): void };
	/**
	 * Overrides the rig's default single hardcoded "cyrus" repository. Lets a
	 * drive seed a multi-repository registry (e.g. to exercise routing-priority
	 * or ambiguity-elicitation scenarios) without hand-rolling a `RouterServer`.
	 */
	repositories?: RigRepositoryConfig[];
	/**
	 * Enables the authenticated `/setup*` management UI (off by default, as
	 * `RouterServer` itself defaults). Forwarded verbatim to `RouterServerConfig.setupUi`.
	 */
	setupUi?: SetupUiConfig;
	/**
	 * Wraps the rig's real `CLIIssueTrackerService` before it is handed to
	 * `RouterServer` as the tracker `RepositoryResolver`/`LinearExecutor`
	 * actually read from. `rig.tracker` (used by callers to seed sessions
	 * directly via `getState()`) stays the unwrapped instance either way.
	 *
	 * Exists because `CLIIssueTrackerService.fetchIssue()`'s returned `Issue`
	 * always resolves `.team`/`.project` to `undefined` (there is no F1
	 * project data store, and team resolution was never wired to fact-gathering)
	 * — so team- or project-based repository routing cannot be driven through
	 * the stock CLI tracker. A drive that needs real `IssueFacts` should wrap
	 * `fetchIssue` here to attach the team/project it wants a given synthetic
	 * issue to carry.
	 */
	wrapTracker?: (base: CLIIssueTrackerService) => IIssueTrackerService;
}

export async function createRouterRig(
	opts: RouterRigOptions,
): Promise<RouterRig> {
	const port = await allocatePort();
	const logger = opts.logger ?? { info: () => {}, warn: () => {} };
	const tracker = new CLIIssueTrackerService();
	tracker.seedDefaultData();
	const secrets = new SecretStore(opts.secretsPath);
	const executors = opts.executors;

	const server = new RouterServer({
		port,
		// Container-facing: must bind all interfaces so a container reaching
		// host.docker.internal:<port> can connect (loopback is unreachable from
		// the container on Linux). Only the F1 control plane binds 127.0.0.1.
		host: opts.host ?? "0.0.0.0",
		dbPath: opts.dbPath,
		workspaces: { [WORKSPACE]: { linearToken: "unused" } },
		webhook: { verificationMode: "direct", secret: "f1-router-secret" },
		trackerFactory: () =>
			opts.wrapTracker ? opts.wrapTracker(tracker) : tracker,
		logger,
		containers: {
			image: opts.image ?? "cyrus-worker:test",
			// Reachable from inside a Docker container on Docker Desktop / colima.
			routerUrlForContainers: `ws://host.docker.internal:${port}`,
			repositories: opts.repositories ?? [
				{
					name: "cyrus",
					githubSlug: "octocat/Hello-World",
					linearWorkspaceId: WORKSPACE,
					baseBranch: "master",
				},
			],
			secretsPath: opts.secretsPath,
			artifactsDir: opts.artifactsDir,
			idleStopMs: opts.idleStopMs,
			staleDestroyMs: opts.staleDestroyMs,
			requiredSecretKeys: opts.requiredSecretKeys,
		},
		...(opts.setupUi ? { setupUi: opts.setupUi } : {}),
		...(executors ? { executorRegistryFactory: () => executors } : {}),
	});
	await server.start();

	return {
		server,
		tracker,
		port,
		seedUser({ email, linearId, provider, claudeOauthToken, env }) {
			// Idempotent: re-seeding an existing user updates their executor and
			// secrets (the natural "blocked on a missing key → seed it → re-route"
			// drive flow) instead of crashing on the users.email UNIQUE constraint.
			const exists = server.store
				.listUsers()
				.some((u) => u.email.toLowerCase() === email.toLowerCase());
			if (!exists) {
				server.store.addUser({ email, linearId });
			}
			server.store.setUserExecutor(email, JSON.stringify({ type: provider }));
			secrets.set(email, "CLAUDE_CODE_OAUTH_TOKEN", claudeOauthToken);
			for (const [key, value] of Object.entries(env ?? {})) {
				secrets.set(email, key, value);
			}
		},
		async stop() {
			await server.stop();
		},
	};
}
