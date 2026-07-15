// apps/f1/src/router/RouterRig.ts
import { CLIIssueTrackerService } from "cyrus-core";
import { RouterServer, SecretStore } from "cyrus-router";
import type { ContainerExecutor } from "cyrus-router-executors";
import { allocatePort } from "./allocatePort.js";
import { WORKSPACE } from "./fixtures.js";

export interface RouterRig {
	server: RouterServer;
	tracker: CLIIssueTrackerService;
	port: number;
	seedUser(opts: {
		email: string;
		linearId: string;
		provider: string;
		claudeOauthToken: string;
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
	logger?: { info(m: string): void; warn(m: string): void };
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
		trackerFactory: () => tracker,
		logger,
		containers: {
			image: opts.image ?? "cyrus-worker:test",
			// Reachable from inside a Docker container on Docker Desktop / colima.
			routerUrlForContainers: `ws://host.docker.internal:${port}`,
			repositories: [
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
		},
		...(executors ? { executorRegistryFactory: () => executors } : {}),
	});
	await server.start();

	return {
		server,
		tracker,
		port,
		seedUser({ email, linearId, provider, claudeOauthToken }) {
			server.store.addUser({ email, linearId });
			server.store.setUserExecutor(email, JSON.stringify({ type: provider }));
			secrets.set(email, "claudeOauthToken", claudeOauthToken);
		},
		async stop() {
			await server.stop();
		},
	};
}
