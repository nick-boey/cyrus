import { dirname, join } from "node:path";
import { LinearClient } from "@linear/sdk";
import type {
	AgentEvent,
	IAgentEventTransport,
	IIssueTrackerService,
} from "cyrus-core";
import {
	LinearIssueTrackerService,
	type LinearOAuthConfig,
} from "cyrus-linear-event-transport";
import type { RpcRequestFrame, SessionStateFrame } from "cyrus-router-protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { registerArtifactsRoute } from "./artifacts.js";
import type { ContainerLifecycle } from "./ContainerLifecycle.js";
import { DeviceGateway } from "./DeviceGateway.js";
import { EventRouter } from "./EventRouter.js";
import { registerEnrollmentRoute } from "./enrollment.js";
import { LinearExecutor } from "./LinearExecutor.js";
import { RouterStore } from "./RouterStore.js";
import { registerWorkspacesRoute } from "./workspaces.js";

/** 48 hours — default TTL for queued offline events. */
const DEFAULT_EVENT_TTL_MS = 48 * 60 * 60 * 1000;
/** How often {@link EventRouter.sweepExpired} runs. */
const SWEEP_INTERVAL_MS = 60_000;

/** Per-workspace Linear credentials as stored in `router-config.json`. */
export interface RouterWorkspaceConfig {
	linearToken: string;
	/**
	 * Needed to re-mint `linearToken`, which Linear expires after ~24h. Omit it
	 * and the router keeps a token that dies a day later — see
	 * {@link RouterServer.buildOAuthConfig}.
	 */
	linearRefreshToken?: string;
}

export interface RouterServerConfig {
	port: number;
	dbPath: string;
	/** workspaceId → per-workspace Linear credentials. */
	workspaces: Record<string, RouterWorkspaceConfig>;
	webhook: { verificationMode: "direct" | "proxy"; secret: string };
	/**
	 * Linear OAuth application credentials, used together with a workspace's
	 * `linearRefreshToken` to refresh an expired access token. Supplied by the
	 * caller (the CLI reads them from the environment) so this package stays
	 * free of `process.env` reads. Omit to disable refresh.
	 */
	oauth?: { clientId: string; clientSecret: string };
	/**
	 * Called after a workspace's access token is refreshed, so the caller can
	 * persist the rotated pair. Linear rotates the refresh token on every
	 * refresh, so failing to persist this leaves the *old* refresh token on
	 * disk — still usable today, but a restart replays a stale pair.
	 */
	onTokenRefresh?: (
		workspaceId: string,
		tokens: { accessToken: string; refreshToken: string },
	) => void | Promise<void>;
	/** Default 48h. */
	eventTtlMs?: number;
	/** Default true. */
	issueLock?: boolean;
	/** Default true. */
	creatorOnlyPrompting?: boolean;
	/**
	 * Test seam; defaults to a Linear-backed tracker per workspace. Receives the
	 * resolved OAuth config (`undefined` when refresh is disabled) so tests can
	 * assert on how refresh was wired.
	 */
	trackerFactory?: (
		workspaceId: string,
		cfg: RouterWorkspaceConfig,
		oauthConfig: LinearOAuthConfig | undefined,
	) => IIssueTrackerService;
	logger?: { info(msg: string): void; warn(msg: string): void };
	/** Forwarded to {@link DeviceGateway} for heartbeat tuning in tests. */
	heartbeatMs?: number;
	/** Host to bind; defaults to 127.0.0.1. */
	host?: string;
	/**
	 * Ephemeral container executor settings. `artifactsDir` is fully wired in a
	 * later task; until then {@link RouterServer} falls back to a directory next
	 * to `dbPath`.
	 */
	containers?: { artifactsDir?: string };
}

/**
 * Fastify composition root for the router server: wires the webhook transport,
 * device gateway, event router, and RPC executor around a single
 * {@link RouterStore}. Owns the process lifecycle via {@link start}/{@link stop}.
 */
export class RouterServer {
	readonly store: RouterStore;
	/**
	 * Exposed read-only as an integration-test seam: the e2e suite feeds
	 * webhook fixtures straight into {@link EventRouter.route} to exercise the
	 * routing/queueing/lock/prompt-gate paths without standing up a real Linear
	 * webhook source. Not part of the runtime wiring surface.
	 */
	readonly eventRouter: EventRouter;
	/**
	 * Idle-stop / stale-destroy / orphan-GC sweep for ephemeral containers.
	 * Optional and unset today — Task 8 constructs it (it needs the executor
	 * registry, which isn't wired up yet) and assigns it here. Left optional
	 * rather than required so this file compiles ahead of that wiring.
	 */
	containerLifecycle?: ContainerLifecycle;
	private readonly config: RouterServerConfig;
	private readonly fastify: FastifyInstance;
	private readonly gateway: DeviceGateway;
	private readonly executor: LinearExecutor;
	private readonly trackers: Map<string, IIssueTrackerService>;
	private readonly logger: { info(msg: string): void; warn(msg: string): void };
	private transport: IAgentEventTransport | undefined;
	private sweepInterval: NodeJS.Timeout | undefined;

	constructor(config: RouterServerConfig) {
		this.config = config;
		this.logger = config.logger ?? { info: () => {}, warn: () => {} };
		this.store = new RouterStore(config.dbPath);
		this.fastify = Fastify();

		// Shared by reference with LinearExecutor, so a refresh that writes here is
		// immediately visible to the attachment-download path.
		const workspaceTokens = new Map<string, string>();

		const factory =
			config.trackerFactory ??
			((_id, cfg, oauthConfig): IIssueTrackerService =>
				new LinearIssueTrackerService(
					new LinearClient({ accessToken: cfg.linearToken }),
					oauthConfig,
				));

		this.trackers = new Map();
		for (const [workspaceId, cfg] of Object.entries(config.workspaces)) {
			workspaceTokens.set(workspaceId, cfg.linearToken);
			const oauthConfig = this.buildOAuthConfig(
				workspaceId,
				cfg,
				workspaceTokens,
			);
			this.trackers.set(workspaceId, factory(workspaceId, cfg, oauthConfig));
		}

		this.executor = new LinearExecutor({
			trackers: this.trackers,
			store: this.store,
			workspaceTokens,
		});

		this.gateway = new DeviceGateway(this.store, {
			heartbeatMs: config.heartbeatMs,
		});

		this.eventRouter = new EventRouter({
			store: this.store,
			gateway: this.gateway,
			postActivity: (workspaceId, agentSessionId, body) =>
				this.executor.postActivity(workspaceId, agentSessionId, body),
			moveIssueToStartedState: (workspaceId, issueId) =>
				this.executor.moveIssueToStartedState(workspaceId, issueId),
			config: {
				eventTtlMs: config.eventTtlMs ?? DEFAULT_EVENT_TTL_MS,
				issueLock: config.issueLock ?? true,
				creatorOnlyPrompting: config.creatorOnlyPrompting ?? true,
			},
			logger: this.logger,
		});

		registerEnrollmentRoute(this.fastify, this.store);
		registerWorkspacesRoute(
			this.fastify,
			this.store,
			Object.keys(config.workspaces),
		);
		registerArtifactsRoute(
			this.fastify,
			this.store,
			config.containers?.artifactsDir ??
				join(dirname(config.dbPath), "artifacts"),
		);

		// Liveness probe for container orchestrators (Docker HEALTHCHECK,
		// serverless platforms). Registered in the constructor because Fastify
		// v5 forbids adding routes once the server is listening.
		this.fastify.get("/healthz", async () => ({ status: "ok" }));

		this.gateway.on("rpc", (deviceId: number, frame: RpcRequestFrame) => {
			void this.executor
				.dispatch(deviceId, frame)
				.then((response) => this.gateway.sendRpcResponse(deviceId, response))
				.catch((err: unknown) => {
					// dispatch() is designed never to reject, but guarantee a response
					// frame even if it somehow does — never leave a device RPC hanging.
					this.gateway.sendRpcResponse(deviceId, {
						type: "rpc_response",
						id: frame.id,
						ok: false,
						error: String(err),
					});
				});
		});
		this.gateway.on(
			"sessionState",
			(deviceId: number, frame: SessionStateFrame) => {
				// Apply the release BEFORE acking: if the process dies in between,
				// the device never sees an ack and replays the frame on reconnect.
				// handleSessionState is idempotent, so a replay of an already-applied
				// release is a no-op.
				this.eventRouter.handleSessionState(deviceId, frame);
				this.gateway.sendSessionStateAck(deviceId, frame.id);
			},
		);
		// NOTE: no "deviceConnected" → deliverPending wiring here. DeviceGateway
		// already calls this.deliverPending() internally at the end of handleHello
		// (right after emitting "deviceConnected"), so adding it here would deliver
		// every queued event twice on reconnect. The gateway owns hello-time
		// delivery — do not re-add.
	}

	/**
	 * Test seam: reports whether a device currently holds an open WebSocket to
	 * the gateway. Lets the e2e suite wait deterministically for the server to
	 * observe a disconnect (so a subsequent routed event takes the offline
	 * queue-and-notice path) instead of racing a fixed sleep.
	 */
	isDeviceOnline(deviceId: number): boolean {
		return this.gateway.isOnline(deviceId);
	}

	/** Actual bound TCP port (useful after `start({ port: 0 })`). */
	get port(): number {
		const address = this.fastify.server.address();
		if (address && typeof address === "object") {
			return address.port;
		}
		throw new Error("RouterServer is not listening");
	}

	async start(): Promise<void> {
		// Build + register the webhook transport BEFORE listen: Fastify v5 forbids
		// adding routes once the server is listening (this reorders the brief,
		// which listed register() after listen()).
		const firstTracker = this.trackers.values().next().value;
		if (firstTracker) {
			this.transport = firstTracker.createEventTransport(
				this.buildTransportConfig(firstTracker),
			);
			this.transport.on("event", (event: AgentEvent) => {
				void this.eventRouter.route(event);
			});
			this.transport.register();
		}

		await this.fastify.listen({
			port: this.config.port,
			host: this.config.host ?? "127.0.0.1",
		});

		// Attach the WebSocket server to the underlying http.Server (an upgrade
		// listener — safe to add after listen()).
		this.gateway.attach(this.fastify.server, "/device");

		this.sweepInterval = setInterval(() => {
			// Both sweeps run detached from any caller that could catch a
			// rejection, so each needs its own .catch(): with none, a transient
			// failure (e.g. a store SQLITE_BUSY) becomes an unhandled promise
			// rejection at this setInterval callback boundary, which (Node >=15
			// default `--unhandled-rejections=throw`) crashes the whole router
			// process — every teammate's webhooks stop routing, not just the one
			// affected by the failure. Logging here lets the tick degrade to a
			// warning and the next interval retry.
			this.eventRouter.sweepExpired().catch((err: unknown) => {
				this.logger.warn(`event sweep failed: ${String(err)}`);
			});
			this.containerLifecycle?.sweep().catch((err: unknown) => {
				this.logger.warn(`container lifecycle sweep failed: ${String(err)}`);
			});
		}, SWEEP_INTERVAL_MS);
	}

	async stop(): Promise<void> {
		if (this.sweepInterval) {
			clearInterval(this.sweepInterval);
			this.sweepInterval = undefined;
		}
		this.gateway.close();
		this.transport?.removeAllListeners();
		this.transport = undefined;
		await this.fastify.close();
		this.store.close();
	}

	/**
	 * Builds the OAuth config that lets {@link LinearIssueTrackerService} refresh
	 * an expired access token in place. Returning `undefined` disables refresh:
	 * the tracker then leaves its SDK client unpatched and a 401 propagates to
	 * the caller.
	 *
	 * Both inputs are required. Without them the router runs on a token that
	 * Linear expires ~24h after it was minted, at which point every Linear call
	 * fails with `Authentication required, not authenticated` until an operator
	 * hand-edits `router-config.json`.
	 */
	private buildOAuthConfig(
		workspaceId: string,
		cfg: RouterWorkspaceConfig,
		workspaceTokens: Map<string, string>,
	): LinearOAuthConfig | undefined {
		const { oauth, onTokenRefresh } = this.config;
		if (!oauth) {
			this.logger.warn(
				`Linear OAuth client credentials not set; token refresh disabled for workspace ${workspaceId}. The access token will stop working when it expires.`,
			);
			return undefined;
		}
		if (!cfg.linearRefreshToken) {
			this.logger.warn(
				`No linearRefreshToken for workspace ${workspaceId}; token refresh disabled. The access token will stop working when it expires.`,
			);
			return undefined;
		}

		return {
			clientId: oauth.clientId,
			clientSecret: oauth.clientSecret,
			refreshToken: cfg.linearRefreshToken,
			workspaceId,
			onTokenRefresh: async (tokens) => {
				// The attachment path reads the raw token out of this map rather than
				// off the tracker, so it goes stale unless refreshed here too.
				workspaceTokens.set(workspaceId, tokens.accessToken);
				this.logger.info(`Refreshed Linear token for workspace ${workspaceId}`);
				await onTokenRefresh?.(workspaceId, tokens);
			},
		};
	}

	/**
	 * Selects the transport config shape for the tracker's platform. A CLI
	 * tracker (test seam) rejects a "linear" config, so it must receive a
	 * `{ platform: "cli" }` config instead.
	 */
	private buildTransportConfig(
		tracker: IIssueTrackerService,
	): Parameters<IIssueTrackerService["createEventTransport"]>[0] {
		if (tracker.getPlatformType() === "cli") {
			return { platform: "cli", fastifyServer: this.fastify };
		}
		return {
			platform: "linear",
			verificationMode: this.config.webhook.verificationMode,
			secret: this.config.webhook.secret,
			fastifyServer: this.fastify,
		};
	}
}
