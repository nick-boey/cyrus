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
import type {
	ContainerExecutor,
	ExecutorRegistry,
} from "cyrus-router-executors";
import {
	type AcaEgressPolicy,
	LocalDockerProvider,
} from "cyrus-router-executors";
import type { RpcRequestFrame, SessionStateFrame } from "cyrus-router-protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { createAcaSandboxesProvider } from "./AcaProviderFactory.js";
import { registerArtifactsRoute } from "./artifacts.js";
import { ContainerLifecycle } from "./ContainerLifecycle.js";
import { ContainerTargetService } from "./ContainerTargets.js";
import { DeviceGateway } from "./DeviceGateway.js";
import { EventRouter } from "./EventRouter.js";
import {
	type EntraTokenVerifier,
	registerEnrollmentRoute,
} from "./enrollment.js";
import { KeyVaultSecretStore } from "./KeyVaultSecretStore.js";
import { LinearExecutor } from "./LinearExecutor.js";
import { RouterStore } from "./RouterStore.js";
import { SecretStore, type SecretStoreBackend } from "./SecretStore.js";
import { StateBackup } from "./StateBackup.js";
import {
	type SetupUiConfig,
	validateSetupAuthConfig,
} from "./setup/principal.js";
import { TableSecretStore } from "./TableSecretStore.js";
import {
	registerTerminalTeardownRoute,
	TerminalTeardown,
} from "./TerminalTeardown.js";
import { registerWorkspacesRoute } from "./workspaces.js";

/** 48 hours — default TTL for queued offline events. */
const DEFAULT_EVENT_TTL_MS = 48 * 60 * 60 * 1000;
/** How often {@link EventRouter.sweepExpired} runs. */
const SWEEP_INTERVAL_MS = 60_000;
/** 15 minutes — default {@link RouterContainersConfig.idleStopMs}. */
const DEFAULT_IDLE_STOP_MS = 900_000;
/** 14 days — default {@link RouterContainersConfig.staleDestroyMs}. */
const DEFAULT_STALE_DESTROY_MS = 1_209_600_000;
/** 10 minutes — default terminal cleanup grace before forced destruction. */
const DEFAULT_TEARDOWN_GRACE_MS = 600_000;

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

/**
 * Opt-in ephemeral container executor settings. Omitting {@link RouterServerConfig.containers}
 * entirely (the default) leaves every container field unset and the router
 * routes every user to their enrolled physical device — today's behavior,
 * unchanged.
 */
export interface RouterContainersConfig {
	/** Worker image, e.g. "ghcr.io/org/cyrus-worker:0.2.66". */
	image: string;
	/**
	 * Router URL reachable FROM inside a container, e.g.
	 * "ws://host.docker.internal:3456" on Docker Desktop, or a public `wss://`
	 * URL for cloud providers. NOT the same as the router's own listen
	 * address/port — that's only reachable from the router's own host.
	 */
	routerUrlForContainers: string;
	repositories: Array<{
		name: string;
		githubSlug: string;
		linearWorkspaceId: string;
		baseBranch?: string;
	}>;
	/** Default `<dirname(dbPath)>/artifacts`. */
	artifactsDir?: string;
	/** Default `<dirname(dbPath)>/user-secrets.json`. */
	secretsPath?: string;
	/** Selects Azure Key Vault instead of the local secrets file. */
	keyVaultUrl?: string;
	/**
	 * Selects the Azure Table backend, which stores one envelope-encrypted
	 * entity per user. Highest precedence: `tableStore`, then
	 * {@link keyVaultUrl}, then the 0600 file store.
	 *
	 * Per D6′ the Table, KEK, and role assignments are create-once; rollback is
	 * expressed by removing this field, never by destroying the infrastructure.
	 */
	tableStore?: {
		/** Bare https origin, e.g. "https://stexample.table.core.windows.net". */
		endpoint: string;
		/** Default "cyrussetup". */
		tableName?: string;
		/**
		 * Versioned Key Vault key id used as the KEK, e.g.
		 * `https://<vault>/keys/<name>/<32-hex-version>`. Parsed once at
		 * construction; every request URL is rebuilt from it, and no stored
		 * value ever contributes a host or path (D4′).
		 */
		keyId: string;
	};
	/** Default 900_000 (15 minutes). */
	idleStopMs?: number;
	/** Default 1_209_600_000 (14 days). */
	staleDestroyMs?: number;
	/** Default 600_000 (10 minutes). */
	teardownGraceMs?: number;
	/**
	 * Extra env-var names a user must have stored before any container boots
	 * for them, on top of the always-required Claude token. Each entry must be
	 * a valid, non-reserved env-var name (validated at config load). e.g.
	 * ["GIT_TOKEN", "LINEAR_API_TOKEN"].
	 */
	requiredSecretKeys?: string[];
	/**
	 * Provider users inherit when their stored executor is the explicit
	 * `{"type":"default"}` sentinel. A NULL/absent executor keeps meaning
	 * "physical device" and is deliberately NOT captured — see F11 on NOR-270.
	 */
	defaultExecutor?: string;
	docker?: { memoryLimit?: string; network?: string };
	/**
	 * Azure Container Apps (ACA) Sandboxes provider settings. When present,
	 * the registry factory also builds an `"aca"` {@link AcaSandboxesProvider}
	 * alongside the default `"docker"` one. When absent (the default), no
	 * ACA work happens and non-Azure deployments are byte-for-byte unchanged.
	 */
	aca?: {
		subscriptionId: string;
		resourceGroup: string;
		sandboxGroup: string;
		region: string;
		/** Pre-registered group disk image NAME (staleness key). */
		disk: string;
		cpu?: string;
		memory?: string;
		/** Default 0 = DISABLED (N5). */
		autoSuspendSeconds?: number;
		/** Override the D7 default egress allowlist. */
		egress?: AcaEgressPolicy;
		/** Default 2 — retention for EXPLICIT labeled snapshots. */
		keepSnapshots?: number;
		/** Default 120_000 — grace before replacing Running but WSS-disconnected ACA workers. */
		disconnectedRecreateMs?: number;
		/** Default 90_000 — how long a resumed sandbox may take to rejoin the router's WSS before it is replaced. */
		resumeConnectTimeoutMs?: number;
		/** Default 2_000 — poll cadence while confirming a resumed worker reconnected. */
		resumeConnectPollMs?: number;
		/** Override the pinned `2026-02-01-preview` data-plane api-version. */
		apiVersion?: string;
		/** Override the per-region `management.{region}.azuredevcompute.io` base. */
		managementEndpoint?: string;
	};
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
	/**
	 * Test seam; defaults to a registry containing a single real
	 * {@link LocalDockerProvider} built from `containers.image` +
	 * `containers.docker`, keyed "docker" — today's behavior, unchanged. Lets
	 * tests (and later phases adding "fly"/"codespaces" providers) inject fake
	 * {@link ContainerExecutor}s instead, so the router test suite never has to
	 * shell out to a real Docker daemon. Only consulted when `containers` is set;
	 * see {@link RouterServer.buildContainerTargets}.
	 */
	executorRegistryFactory?: (
		containers: RouterContainersConfig,
	) => ExecutorRegistry;
	logger?: { info(msg: string): void; warn(msg: string): void };
	/** Forwarded to {@link DeviceGateway} for heartbeat tuning in tests. */
	heartbeatMs?: number;
	/** Host to bind; defaults to 127.0.0.1. */
	host?: string;
	/**
	 * Ephemeral container executor settings. Opt-in: omitting this field is the
	 * default and leaves every container field undefined — see
	 * {@link RouterContainersConfig}.
	 */
	containers?: RouterContainersConfig;
	backup?: { blobContainerUrl: string; intervalMs?: number };
	entra?: {
		tenantId: string;
		audience: string;
		allowedDomain?: string;
		/** Retained from the Task 3 passthrough surface. */
		jwksUrl?: string;
		/** Retained from the Task 3 passthrough surface. */
		certificateIssuerId?: string;
	};
	/** Test seam for deterministic verification without a remote JWKS. */
	entraTokenVerifier?: EntraTokenVerifier;
	/**
	 * Authenticated `/setup*` management UI. Opt-in and off by default.
	 *
	 * `setupUi.auth` is deliberately required when enabled: how identity is
	 * established is an explicit operator choice, never inferred from `entra`
	 * above (which governs enrollment bearer tokens for `/enroll` and says
	 * nothing about what sits in front of this process). See
	 * {@link validateSetupAuthConfig}.
	 */
	setupUi?: SetupUiConfig;
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
	 * Which per-user secret backend the container path resolved to. A
	 * diagnostic seam — it is logged at startup and asserted in tests, because
	 * "why is my secret not there" is otherwise invisible. `"none"` when
	 * `config.containers` is absent and no backend was built.
	 */
	readonly secretBackendKind: "none" | "file" | "keyvault" | "table";
	/**
	 * Idle-stop / stale-destroy / orphan-GC sweep for ephemeral containers.
	 * Constructed in {@link buildContainerTargets} only when
	 * `config.containers` is set; otherwise stays `undefined` and the sweep
	 * interval's `this.containerLifecycle?.sweep()` call is a no-op.
	 */
	containerLifecycle?: ContainerLifecycle;
	private terminalTeardown?: TerminalTeardown;
	private readonly config: RouterServerConfig;
	private readonly fastify: FastifyInstance;
	private readonly gateway: DeviceGateway;
	private readonly executor: LinearExecutor;
	private readonly trackers: Map<string, IIssueTrackerService>;
	private readonly logger: { info(msg: string): void; warn(msg: string): void };
	private transport: IAgentEventTransport | undefined;
	private sweepInterval: NodeJS.Timeout | undefined;
	private stateBackup: StateBackup | undefined;
	private constructedAfterRestore = false;

	/** Restores Azure-backed state before constructing/opening RouterStore. */
	static async create(config: RouterServerConfig): Promise<RouterServer> {
		let stateBackup: StateBackup | undefined;
		if (config.backup) {
			stateBackup = new StateBackup({
				dbPath: config.dbPath,
				...config.backup,
				logger: config.logger,
			});
			await stateBackup.restoreIfNeeded();
		}
		const server = new RouterServer(config);
		server.stateBackup = stateBackup;
		server.constructedAfterRestore = true;
		return server;
	}

	constructor(config: RouterServerConfig) {
		// Before anything else: an ambiguous or unsafe setup-auth strategy must
		// refuse to start rather than serve /setup with no enforceable trust
		// boundary. `config.host ?? "127.0.0.1"` mirrors the default applied at
		// listen() below, so the validator sees the host Fastify will really bind
		// — the Docker entrypoint defaults it to 0.0.0.0, which is exactly the
		// case `dev-insecure-headers` must refuse.
		if (config.setupUi) {
			validateSetupAuthConfig(config.setupUi, {
				bindHost: config.host ?? "127.0.0.1",
			});
		}
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

		const artifactsDir =
			config.containers?.artifactsDir ??
			join(dirname(config.dbPath), "artifacts");
		const built = this.buildContainerTargets(config.containers, artifactsDir);
		const containerTargets = built?.service;
		// Assigned here rather than inside buildContainerTargets because a
		// `readonly` field may only be written from the constructor, and the
		// method early-returns when `containers` is absent.
		this.secretBackendKind = built?.kind ?? "none";
		if (built) {
			this.logger.info(`Per-user secret backend: ${this.secretBackendKind}`);
		}

		this.eventRouter = new EventRouter({
			store: this.store,
			gateway: this.gateway,
			postActivity: (workspaceId, agentSessionId, body) =>
				this.executor.postActivity(workspaceId, agentSessionId, body),
			moveIssueToStartedState: (workspaceId, issueId) =>
				this.executor.moveIssueToStartedState(workspaceId, issueId),
			containerTargets,
			terminalTeardown: this.terminalTeardown,
			config: {
				eventTtlMs: config.eventTtlMs ?? DEFAULT_EVENT_TTL_MS,
				issueLock: config.issueLock ?? true,
				creatorOnlyPrompting: config.creatorOnlyPrompting ?? true,
			},
			logger: this.logger,
		});

		registerEnrollmentRoute(
			this.fastify,
			this.store,
			config.entra,
			config.entraTokenVerifier,
		);
		registerWorkspacesRoute(
			this.fastify,
			this.store,
			Object.keys(config.workspaces),
		);
		registerArtifactsRoute(this.fastify, this.store, artifactsDir);

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
		//
		// We DO use deviceConnected to reconcile stale issue locks: a device
		// that reconnects without a session it once held (e.g. lost state to a
		// corrupt file) can never send that session's terminal frame, so the
		// router reclaims the lock here. Fire-and-forget, mirroring the other
		// gateway handlers; reconcileDeviceLocks never rejects on its own but
		// guard anyway so a post failure can't crash the process.
		this.gateway.on(
			"deviceConnected",
			(deviceId: number, activeSessions?: string[]) => {
				void this.eventRouter
					.reconcileDeviceLocks(deviceId, activeSessions)
					.catch((err: unknown) => {
						this.logger.warn(
							`reconcileDeviceLocks failed for device ${deviceId}: ${String(err)}`,
						);
					});
			},
		);
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
		if (this.config.backup && !this.constructedAfterRestore) {
			throw new Error(
				"RouterServer with backup config must be created with RouterServer.create()",
			);
		}
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
		this.stateBackup?.start();
	}

	async stop(): Promise<void> {
		if (this.sweepInterval) {
			clearInterval(this.sweepInterval);
			this.sweepInterval = undefined;
		}
		this.terminalTeardown?.stop();
		this.gateway.close();
		this.transport?.removeAllListeners();
		this.transport = undefined;
		await this.fastify.close();
		await this.stateBackup?.stop();
		this.store.close();
	}

	/**
	 * Builds the container-executor wiring — {@link SecretStore},
	 * {@link ExecutorRegistry}, {@link ContainerTargetService} — and assigns
	 * {@link containerLifecycle}, when `containers` is configured.
	 *
	 * Returns `undefined` (and never touches {@link containerLifecycle}) when
	 * `containers` is absent, so {@link EventRouter} keeps every user on the
	 * physical-device path and the sweep interval's
	 * `this.containerLifecycle?.sweep()` stays a no-op — today's behavior,
	 * unchanged.
	 *
	 * The `postActivity` closure below is bound the same way EventRouter's own
	 * `postActivity` is (see the constructor): both route through
	 * `this.executor.postActivity`, which is already assigned by the time this
	 * runs.
	 */
	private buildContainerTargets(
		containers: RouterContainersConfig | undefined,
		artifactsDir: string,
	):
		| {
				service: ContainerTargetService;
				secrets: SecretStoreBackend;
				kind: "file" | "keyvault" | "table";
		  }
		| undefined {
		if (!containers) return undefined;

		const secretsPath =
			containers.secretsPath ??
			join(dirname(this.config.dbPath), "user-secrets.json");
		// Precedence: Table, then Key Vault, then the 0600 file store. A
		// deployment with none of these fields set is byte-identical to today.
		let secrets: SecretStoreBackend;
		let kind: "file" | "keyvault" | "table";
		if (containers.tableStore) {
			secrets = new TableSecretStore({
				tableEndpoint: containers.tableStore.endpoint,
				tableName: containers.tableStore.tableName,
				keyId: containers.tableStore.keyId,
				logger: this.logger,
			});
			kind = "table";
		} else if (containers.keyVaultUrl) {
			secrets = new KeyVaultSecretStore({
				vaultUrl: containers.keyVaultUrl,
				logger: this.logger,
			});
			kind = "keyvault";
		} else {
			secrets = new SecretStore(secretsPath);
			kind = "file";
		}

		const executorRegistryFactory =
			this.config.executorRegistryFactory ??
			((cfg: RouterContainersConfig): ExecutorRegistry => {
				const map = new Map<string, ContainerExecutor>([
					[
						"docker",
						new LocalDockerProvider({
							image: cfg.image,
							...cfg.docker,
							logger: this.logger,
						}),
					],
				]);
				if (cfg.aca) {
					// `routerUrlForContainers` is forwarded so the D7 default
					// egress allowlist includes the router host (WSS through
					// Full inspection works, per spike S4).
					map.set(
						"aca",
						createAcaSandboxesProvider(cfg, this.logger, (rawDeviceId) => {
							const deviceId = Number(rawDeviceId);
							const device = Number.isInteger(deviceId)
								? this.store.getDeviceInfo(deviceId)
								: undefined;
							const info = device?.issueKey
								? this.store.getContainerDeviceForIssue(device.issueKey)
								: undefined;
							return {
								connected:
									info?.deviceId === deviceId &&
									this.gateway.isOnline(deviceId),
								disconnectedSinceMs:
									info?.lastSeenMs ?? info?.createdMs ?? Date.now(),
							};
						})!,
					);
				}
				return map;
			});
		const executors = executorRegistryFactory(containers);

		const containerTargets = new ContainerTargetService({
			store: this.store,
			secrets,
			executors,
			containersConfig: {
				routerUrlForContainers: containers.routerUrlForContainers,
				repositories: containers.repositories,
				requiredSecretKeys: containers.requiredSecretKeys,
				defaultExecutor: containers.defaultExecutor,
			},
			postActivity: (workspaceId, agentSessionId, body) =>
				this.executor.postActivity(workspaceId, agentSessionId, body),
			logger: this.logger,
		});

		this.containerLifecycle = new ContainerLifecycle({
			store: this.store,
			executors,
			idleStopMs: containers.idleStopMs ?? DEFAULT_IDLE_STOP_MS,
			staleDestroyMs: containers.staleDestroyMs ?? DEFAULT_STALE_DESTROY_MS,
			logger: this.logger,
		});
		this.terminalTeardown = new TerminalTeardown({
			store: this.store,
			executors,
			artifactsDir,
			graceMs: containers.teardownGraceMs ?? DEFAULT_TEARDOWN_GRACE_MS,
			logger: this.logger,
		});
		registerTerminalTeardownRoute(
			this.fastify,
			this.store,
			this.terminalTeardown,
		);

		return { service: containerTargets, secrets, kind };
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
