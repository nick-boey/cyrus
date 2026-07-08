import { LinearClient } from "@linear/sdk";
import type {
	AgentEvent,
	IAgentEventTransport,
	IIssueTrackerService,
} from "cyrus-core";
import { LinearIssueTrackerService } from "cyrus-linear-event-transport";
import type { RpcRequestFrame, SessionStateFrame } from "cyrus-router-protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { DeviceGateway } from "./DeviceGateway.js";
import { EventRouter } from "./EventRouter.js";
import { registerEnrollmentRoute } from "./enrollment.js";
import { LinearExecutor } from "./LinearExecutor.js";
import { RouterStore } from "./RouterStore.js";

/** 48 hours — default TTL for queued offline events. */
const DEFAULT_EVENT_TTL_MS = 48 * 60 * 60 * 1000;
/** How often {@link EventRouter.sweepExpired} runs. */
const SWEEP_INTERVAL_MS = 60_000;

export interface RouterServerConfig {
	port: number;
	dbPath: string;
	/** workspaceId → per-workspace Linear credentials. */
	workspaces: Record<string, { linearToken: string }>;
	webhook: { verificationMode: "direct" | "proxy"; secret: string };
	/** Default 48h. */
	eventTtlMs?: number;
	/** Default true. */
	issueLock?: boolean;
	/** Default true. */
	creatorOnlyPrompting?: boolean;
	/** Test seam; defaults to a Linear-backed tracker per workspace. */
	trackerFactory?: (
		workspaceId: string,
		cfg: { linearToken: string },
	) => IIssueTrackerService;
	logger?: { info(msg: string): void; warn(msg: string): void };
	/** Forwarded to {@link DeviceGateway} for heartbeat tuning in tests. */
	heartbeatMs?: number;
	/** Host to bind; defaults to 127.0.0.1. */
	host?: string;
}

/**
 * Fastify composition root for the router server: wires the webhook transport,
 * device gateway, event router, and RPC executor around a single
 * {@link RouterStore}. Owns the process lifecycle via {@link start}/{@link stop}.
 */
export class RouterServer {
	readonly store: RouterStore;
	private readonly config: RouterServerConfig;
	private readonly fastify: FastifyInstance;
	private readonly gateway: DeviceGateway;
	private readonly eventRouter: EventRouter;
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

		const factory =
			config.trackerFactory ??
			((_id, cfg): IIssueTrackerService =>
				new LinearIssueTrackerService(
					new LinearClient({ accessToken: cfg.linearToken }),
				));

		this.trackers = new Map();
		const workspaceTokens = new Map<string, string>();
		for (const [workspaceId, cfg] of Object.entries(config.workspaces)) {
			this.trackers.set(workspaceId, factory(workspaceId, cfg));
			workspaceTokens.set(workspaceId, cfg.linearToken);
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
			config: {
				eventTtlMs: config.eventTtlMs ?? DEFAULT_EVENT_TTL_MS,
				issueLock: config.issueLock ?? true,
				creatorOnlyPrompting: config.creatorOnlyPrompting ?? true,
			},
			logger: this.logger,
		});

		registerEnrollmentRoute(this.fastify, this.store);

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
				this.eventRouter.handleSessionState(deviceId, frame);
			},
		);
		// NOTE: no "deviceConnected" → deliverPending wiring here. DeviceGateway
		// already calls this.deliverPending() internally at the end of handleHello
		// (right after emitting "deviceConnected"), so adding it here would deliver
		// every queued event twice on reconnect. The gateway owns hello-time
		// delivery — do not re-add.
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
			void this.eventRouter.sweepExpired();
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
