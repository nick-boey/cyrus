import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { LinearClient } from "@linear/sdk";
import {
	type AgentEvent,
	createNoopLogger,
	type IAgentEventTransport,
	type IIssueTrackerService,
	type ILogger,
} from "cyrus-core";
import {
	LinearIssueTrackerService,
	type LinearOAuthConfig,
} from "cyrus-linear-event-transport";
import type { OperatorCapabilityV1 } from "cyrus-operator-protocol";
import type { SpanExporter } from "cyrus-otel-traces";
import type {
	ContainerExecutor,
	ExecutorRegistry,
} from "cyrus-router-executors";
import {
	type AcaEgressPolicy,
	AcaSandboxClient,
	createDefaultTokenProvider,
	LocalDockerProvider,
} from "cyrus-router-executors";
import type {
	LogFrame,
	RpcRequestFrame,
	SessionStateFrame,
	SpanFrame,
} from "cyrus-router-protocol";
import Fastify, { type FastifyInstance } from "fastify";
import { createAcaSandboxesProvider } from "./AcaProviderFactory.js";
import { registerArtifactsRoute } from "./artifacts.js";
import { CodexTokenStore } from "./CodexTokenStore.js";
import { ContainerLifecycle } from "./ContainerLifecycle.js";
import { ContainerTargetService } from "./ContainerTargets.js";
import { DeviceGateway } from "./DeviceGateway.js";
import {
	AcrDevcontainerBuilder,
	createArmRequestFn,
	createArmTokenProvider,
} from "./devcontainer/AcrDevcontainerBuilder.js";
import { DevcontainerImageService } from "./devcontainer/DevcontainerImageService.js";
import { EventRouter } from "./EventRouter.js";
import {
	type EntraTokenVerifier,
	registerEnrollmentRoute,
} from "./enrollment.js";
import { FleetOperations } from "./fleet-operations/FleetOperations.js";
import {
	createEntraOperatorTokenVerifier,
	type EntraOperatorTokenVerifier,
	OperatorAuthorizer,
} from "./fleet-operations/OperatorAuthorizer.js";
import { registerFleetOperationsRoutes } from "./fleet-operations/routes.js";
import type { FleetOperationsConfig } from "./fleet-operations/types.js";
import { KeyVaultSecretStore } from "./KeyVaultSecretStore.js";
import { LinearExecutor } from "./LinearExecutor.js";
import {
	createRepositoryRegistry,
	type RepositoryRegistry,
	seedRepositoryRegistry,
} from "./RepositoryRegistry.js";
import { RepositoryResolver } from "./RepositoryResolver.js";
import { RouterStore } from "./RouterStore.js";
import { registerRunsRoute } from "./runs.js";
import { SandboxLogRelay } from "./SandboxLogRelay.js";
import { SandboxSpanRelay } from "./SandboxSpanRelay.js";
import {
	requiredSecretKeysFor,
	SecretStore,
	type SecretStoreBackend,
} from "./SecretStore.js";
import { StateBackup } from "./StateBackup.js";
import { EXECUTOR_TYPE_DEVICE, SetupBootstrap } from "./setup/bootstrap.js";
import { createCsrfTokens } from "./setup/csrf.js";
import { KeyVaultKeyWrapper } from "./setup/envelope.js";
import { LocalKeyWrapper } from "./setup/localKeyWrapper.js";
import {
	type SetupAuthConfig,
	type SetupAuthMode,
	type SetupIdTokenVerifier,
	type SetupUiConfig,
	validateSetupAuthConfig,
} from "./setup/principal.js";
import { registerRepositoryRoutes } from "./setup/repositoryRoutes.js";
import { registerSetupRoutes } from "./setup/routes.js";
import { resolveDefaultRunner } from "./setup/runnerDefaults.js";
import { TableSecretStore } from "./TableSecretStore.js";
import {
	registerTerminalTeardownRoute,
	TerminalTeardown,
} from "./TerminalTeardown.js";
import { registerHttpTracing } from "./telemetry/httpTracing.js";
import { registerWorkspacesRoute } from "./workspaces.js";

/** 48 hours — default TTL for queued offline events. */
const DEFAULT_EVENT_TTL_MS = 48 * 60 * 60 * 1000;
/** How often {@link EventRouter.sweepExpired} runs. */
const SWEEP_INTERVAL_MS = 60_000;
/** 5 minutes — default {@link RouterContainersConfig.idleStopMs}. */
const DEFAULT_IDLE_STOP_MS = 300_000;
/** 14 days — default {@link RouterContainersConfig.staleDestroyMs}. */
const DEFAULT_STALE_DESTROY_MS = 1_209_600_000;
/** 10 minutes — default terminal cleanup grace before forced destruction. */
const DEFAULT_TEARDOWN_GRACE_MS = 600_000;
/** 10 minutes — default {@link RouterContainersConfig.affinityGraceMs}. Must
 *  exceed the worst-case gap between routing a session and the worker starting
 *  to track it (a cold ACA boot is ~60s). */
const DEFAULT_AFFINITY_GRACE_MS = 600_000;
/** 1 hour — default {@link RouterContainersConfig.offlineAgeOutMs}. */
const DEFAULT_OFFLINE_AGE_OUT_MS = 3_600_000;
/** 5 seconds — default {@link RouterContainersConfig.sessionsQueryTimeoutMs},
 *  well inside the 60s sweep tick. */
const DEFAULT_SESSIONS_QUERY_TIMEOUT_MS = 5_000;

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
		teamKeys?: string[];
		projectKeys?: string[];
		routingLabels?: string[];
		isDefault?: boolean;
	}>;
	/** Default `<dirname(dbPath)>/artifacts`. */
	artifactsDir?: string;
	/** Default `<dirname(dbPath)>/user-secrets.json`. */
	secretsPath?: string;
	/**
	 * Default `<dirname(dbPath)>/repositories.json`. Only consulted for the
	 * file-backed registry — ignored once `tableStore` selects the Table
	 * backend. Overriding this is mainly for tests: it lets a suite using a
	 * non-path `dbPath` sentinel (e.g. `":memory:"`, whose `dirname` is `"."`)
	 * point the registry file at a temp directory instead of the package's
	 * working directory.
	 */
	repositoriesPath?: string;
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
	/** Default 600_000 (10 minutes). */
	affinityGraceMs?: number;
	/** Default 3_600_000 (1 hour). */
	offlineAgeOutMs?: number;
	/** Default 600_000 (10 minutes). How long a stopped-but-still-claimed sandbox
	 *  must stay that way before `sandbox.stranded_session` is reported. */
	strandedSessionGraceMs?: number;
	/**
	 * Default 14_400_000 (4 hours). How long a sandbox may hold session affinity
	 * with nothing routed to it and nothing posted by it before
	 * `sandbox.stranded_session` is reported with `cyrus.reason = no_progress`.
	 *
	 * Exposed because the detector knowingly cannot separate a strand from a
	 * session deliberately waiting (the deferral is recorded only on the device),
	 * so a deployment running a cron with a period above the threshold will be
	 * reported. This alert is severity 1: without a knob the only remedy for that
	 * false positive is muting the rule — which also mutes `offline_pinned`, and
	 * is the alert-fatigue failure NOR-402 is about. Raise it rather than mute.
	 *
	 * Do not LOWER it below `ScheduleWakeup`'s 1-hour clamp without first giving
	 * the router a way to see the deferral.
	 */
	sessionNoProgressMs?: number;
	/** Default 5_000 (5 seconds). */
	sessionsQueryTimeoutMs?: number;
	/** Default 120_000 (2 minutes). How long after an agent run on a container
	 *  ends the lifecycle sweep leaves that container alone, so its worker can
	 *  flush and get its terminal frame acked before being parked. */
	terminalSettleMs?: number;
	/**
	 * Per-repository devcontainer images (NOR-309). Omit it and every container
	 * boots {@link RouterContainersConfig.image} — today's behaviour, unchanged.
	 *
	 * Requires {@link RouterContainersConfig.aca}: the whole feature is a
	 * per-repository ACA disk image, and there is nothing for it to do on a
	 * provider with no concept of one.
	 */
	devcontainers?: {
		/**
		 * GitHub credential the ROUTER uses to read devcontainer files and that
		 * the ACR build uses to clone. Router-level rather than per-user because
		 * the repository registry is global: the environment a repository
		 * declares is a property of the repository, not of whoever delegated the
		 * issue.
		 */
		githubToken: string;
		/** Registry name, e.g. "cyrusacr" — not the login server. */
		registry: string;
		/** Login server, e.g. "cyrusacr.azurecr.io". */
		loginServer: string;
		/** Default "cyrus/devcontainers". Build identity is scoped to this path. */
		imageRepository?: string;
		/** OCI ref of the `cyrus-worker` Feature. */
		workerFeatureRef: string;
		/** Worker feature version. Part of every cache key — bump it to rebuild all. */
		workerFeatureVersion: string;
		/** URL of the worker payload tarball the feature extracts. */
		workerPayloadTarball: string;
		/** Non-root user the finalize stage drops to. Default "cyrus". */
		workerUser?: string;
		/** Seconds. Default 5400 (90 minutes); ACR's own ceiling is 6 hours. */
		buildTimeoutSeconds?: number;
		/**
		 * How often unreferenced disk images are collected. Default 6 hours —
		 * deliberately far away from the 60s lifecycle sweep, which is
		 * non-reentrant by contract.
		 */
		gcIntervalMs?: number;
	};
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
	/**
	 * Codex ChatGPT-subscription support (ADR 0005). Optional: without it the
	 * "Codex account" section of `/setup` is unavailable and a Codex user falls
	 * back to `OPENAI_API_KEY` from their own secret bundle.
	 */
	codex?: {
		/**
		 * Overrides the Codex CLI's OAuth client id. A refresh token can only be
		 * redeemed by the client it was issued to, so this must match whatever
		 * `codex login --device-auth` used. Exposed as config so a deployment can
		 * react to an upstream change without waiting for a release.
		 */
		clientId?: string;
		/**
		 * Versioned Key Vault key id to seal stored credentials with.
		 *
		 * Separate from `tableStore.keyId` on purpose. The KEK and the router's
		 * *Key Vault Crypto User* role are provisioned by one Azure flag
		 * (`enableSetupSecretStore`) while `tableStore` is rendered by a
		 * different one (`enableSetupTableBackend`, the staged migration of the
		 * secret backend). Reading the KEK only off `tableStore` therefore meant
		 * a deployment that had a perfectly good vault key still sealed Codex
		 * credentials with a local file — and made using a subscription
		 * conditional on an unrelated migration.
		 */
		keyId?: string;
		/**
		 * Where the local key-encryption key lives when no Key Vault KEK is
		 * configured. Defaults to `codex-kek.key` beside the router database.
		 * Ignored when a `keyId` (here or on `tableStore`) is set, which is the
		 * stronger option.
		 *
		 * **This file is not backed up by anything.** `StateBackup` uploads
		 * `router.db` alone, so on a host whose disk does not survive a restart
		 * the database comes back and the key does not — and every sealed
		 * credential in it becomes permanently unopenable while still *looking*
		 * connected. Point this at durable storage, or configure a `keyId`.
		 */
		localKeyPath?: string;
	};
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
	logger?: ILogger;
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
	 * Fleet Operations: the anonymous discovery document and the authenticated
	 * operator context route.
	 *
	 * Omitting it still registers both routes — discovery is how a client learns
	 * whether a router speaks the operator interface at all, and device tokens
	 * and locally minted operator tokens authenticate with no configuration —
	 * but no Entra grant exists, so a JWT is refused.
	 *
	 * `capabilities` on this object is IGNORED: what a router serves is decided
	 * by the routes it registers, not by its config file. See
	 * {@link RouterServer.servedOperatorCapabilities}.
	 */
	fleetOperations?: FleetOperationsConfig;
	/**
	 * Verifies operator Entra ACCESS tokens. Defaults to a JWKS-backed verifier
	 * built from `fleetOperations.access.entra`. A third verifier alongside
	 * `entraTokenVerifier` and `setupIdTokenVerifier` because each pins a
	 * different audience and needs a different projection of the payload — this
	 * one needs `oid` and `groups`.
	 */
	operatorTokenVerifier?: EntraOperatorTokenVerifier;
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
	/**
	 * Verifies the Entra ID token forwarded by the ACA token store. REQUIRED
	 * when `setupUi.auth.mode` is `"entra-token"`; without it every /setup
	 * request fails with a 500 rather than degrading to header trust.
	 *
	 * Injected rather than constructed here because it needs a DIFFERENT
	 * audience from `entra.audience` — that one is the `api://` Application ID
	 * URI carried by enrollment *access* tokens, whereas an ID token carries
	 * the bare client-id GUID (D2').
	 */
	setupIdTokenVerifier?: SetupIdTokenVerifier;
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
	/** Set only when `containers` is configured. Consumed by the setup UI. */
	repositoryRegistry: RepositoryRegistry | undefined;
	/**
	 * Per-user Codex subscription credentials. Set only when
	 * `containers.codex` is configured; the setup UI renders the "Codex account"
	 * section only when it exists, so a deployment without it never shows a
	 * control that could not work.
	 */
	codexTokens: CodexTokenStore | undefined;
	private terminalTeardown?: TerminalTeardown;
	private readonly config: RouterServerConfig;
	private readonly fastify: FastifyInstance;
	private readonly gateway: DeviceGateway;
	/** Re-emits sandbox worker logs into the router's own (collected) stdout. */
	private readonly sandboxLogRelay: SandboxLogRelay;
	/**
	 * Re-exports sandbox worker spans through the router's own span exporter.
	 *
	 * Undefined until {@link setSpanExporter} is called. It cannot be built in
	 * the constructor because it needs the exporter, and the exporter belongs to
	 * the tracing pipeline the CLI bootstrap starts — which must remain optional,
	 * so that a self-host router with no Azure connection string constructs and
	 * runs exactly as it does today.
	 */
	private sandboxSpanRelay: SandboxSpanRelay | undefined;
	private readonly executor: LinearExecutor;
	private readonly trackers: Map<string, IIssueTrackerService>;
	private readonly logger: ILogger;
	private transport: IAgentEventTransport | undefined;
	private sweepInterval: NodeJS.Timeout | undefined;
	/** Per-repository devcontainer images (NOR-309), when configured. */
	private devcontainerImages: DevcontainerImageService | undefined;
	private devcontainerGcInterval: NodeJS.Timeout | undefined;
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
		this.logger = config.logger ?? createNoopLogger();
		this.store = new RouterStore(config.dbPath);
		this.fastify = Fastify();
		// Registered FIRST, before any route: Fastify runs `onRequest` hooks in
		// registration order, and the server span has to be active before
		// anything a route does can attach to it. This is also the router's only
		// request logging — see the plugin's note on why Fastify's own pino
		// logger is deliberately left off.
		registerHttpTracing(this.fastify, { logger: this.logger });

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
			logger: this.logger,
		});

		this.gateway = new DeviceGateway(this.store, {
			heartbeatMs: config.heartbeatMs,
			logger: this.logger,
		});
		this.sandboxLogRelay = new SandboxLogRelay({ logger: this.logger });

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

		const repositoryResolver = built?.repositoryResolver;

		this.eventRouter = new EventRouter({
			store: this.store,
			gateway: this.gateway,
			postActivity: (workspaceId, agentSessionId, body) =>
				this.executor.postActivity(workspaceId, agentSessionId, body),
			moveIssueToStartedState: (workspaceId, issueId) =>
				this.executor.moveIssueToStartedState(workspaceId, issueId),
			// Only the router holds a Linear token, and the agent-session webhook
			// carries an issue's team but not its project — so this is the only way
			// the project dimension of a run's routing snapshot can be filled.
			fetchRoutingContext: (workspaceId, issueId) =>
				this.executor.fetchRoutingContext(workspaceId, issueId),
			containerTargets,
			terminalTeardown: this.terminalTeardown,
			...(built?.devcontainers
				? {
						devcontainers: built.devcontainers,
						registry: this.repositoryRegistry,
					}
				: {}),
			config: {
				eventTtlMs: config.eventTtlMs ?? DEFAULT_EVENT_TTL_MS,
				issueLock: config.issueLock ?? true,
				creatorOnlyPrompting: config.creatorOnlyPrompting ?? true,
				affinityGraceMs:
					config.containers?.affinityGraceMs ?? DEFAULT_AFFINITY_GRACE_MS,
			},
			logger: this.logger,
			...(repositoryResolver
				? {
						repositoryResolver,
						postRepositorySelection: (
							workspaceId: string,
							sessionId: string,
							body: string,
							options: string[],
						) =>
							this.executor.postRepositorySelection(
								workspaceId,
								sessionId,
								body,
								options,
							),
					}
				: {}),
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
		registerRunsRoute(this.fastify, this.store, {
			isDeviceOnline: (deviceId) => this.gateway.isOnline(deviceId),
			getSandboxObservation: (deviceId) =>
				this.containerLifecycle?.getSandboxObservation(deviceId),
		});
		this.registerFleetOperations();

		// Liveness probe for container orchestrators (Docker HEALTHCHECK,
		// serverless platforms). Registered in the constructor because Fastify
		// v5 forbids adding routes once the server is listening.
		this.fastify.get("/healthz", async () => ({ status: "ok" }));

		if (config.setupUi?.enabled) {
			if (!built) {
				throw new Error(
					"setupUi.enabled requires a `containers` block: the setup page edits the per-user secret bundle that container launches consume, and no secret backend is constructed without it.",
				);
			}
			// Exactly the expression ContainerTargets.buildEnv uses, so the page
			// and the boot gate can never disagree about what "required" means.
			//
			// It is a FUNCTION of the user rather than a fixed array because the
			// required set now depends on which runner they chose: a Codex user
			// needs no Anthropic credential, and demanding one made the picker a
			// lie for anyone without an Anthropic subscription. Parameterised, not
			// duplicated — there is still exactly one expression, evaluated here.
			const setupRequiredKeys = (email?: string): string[] => {
				const user = email ? this.store.getUserByEmail(email) : undefined;
				const selection = user
					? resolveDefaultRunner(
							this.store.getUserDefaultRunner(user.userId),
							this.logger,
						)
					: undefined;
				return requiredSecretKeysFor(
					selection?.runner,
					config.containers?.requiredSecretKeys,
				);
			};
			const setupAuthConfig: SetupAuthConfig = {
				// validateSetupAuthConfig ran at the top of this constructor and
				// throws when `auth` is unset, so this is proven non-null.
				auth: config.setupUi.auth as SetupAuthMode,
				...(config.setupUi.allowedDomain
					? { allowedDomain: config.setupUi.allowedDomain }
					: {}),
			};
			const setupBootstrap = new SetupBootstrap({
				store: this.store,
				secrets: built.secrets,
				requiredKeys: setupRequiredKeys,
				// Defaults TRUE. Self-registration is the intended posture for a
				// single-organisation deployment: signing in creates a user row
				// and an EMPTY secret record, nothing more. It grants no
				// credentials — the user still has to supply their own Claude
				// token — and nothing routes to them until they appear as the
				// creator or assignee of a Linear issue
				// (`EventRouter` → `RouterStore.findUserForCreator`), so Linear
				// membership is the effective gate.
				//
				// Set it false where the Entra tenant is materially larger than
				// the set of people who should be able to hold Cyrus
				// credentials; `setupUi.allowedDomain` is the cheaper control
				// for the common case of keeping guests out.
				autoProvisionUsers: config.setupUi.autoProvisionUsers ?? true,
				logger: this.logger,
			});
			// Per-process and in-memory on purpose. The router is single-replica,
			// so a restart just invalidates outstanding tokens and the next action
			// re-renders with a fresh one. Deliberately NOT sourced from config or
			// shared with the webhook secret: a file-backed value survives restarts
			// and would widen a config leak into CSRF forgery.
			const setupCsrf = createCsrfTokens(randomBytes(32).toString("base64url"));
			const setupIdTokenVerifier = config.setupIdTokenVerifier;

			registerSetupRoutes(this.fastify, {
				secrets: built.secrets,
				requiredKeys: setupRequiredKeys,
				auth: setupAuthConfig,
				bootstrap: setupBootstrap,
				csrf: setupCsrf,
				store: this.store,
				...(this.codexTokens ? { codexTokens: this.codexTokens } : {}),
				...(setupIdTokenVerifier
					? { verifyIdToken: setupIdTokenVerifier }
					: {}),
				logger: this.logger,
			});
			this.logger.info(
				`Setup UI enabled at /setup (auth: ${config.setupUi.auth?.mode})`,
			);

			// The registry only exists when `containers` is configured; a
			// device-only deployment has no repositories to register. Mounted on
			// the same Fastify instance as registerSetupRoutes, which
			// registerRepositoryRoutes relies on for its idempotent
			// content-type-parser guard.
			if (this.repositoryRegistry) {
				registerRepositoryRoutes(this.fastify, {
					registry: this.repositoryRegistry,
					workspaceIds: Object.keys(this.config.workspaces),
					auth: setupAuthConfig,
					bootstrap: setupBootstrap,
					csrf: setupCsrf,
					...(setupIdTokenVerifier
						? { verifyIdToken: setupIdTokenVerifier }
						: {}),
					...(this.devcontainerImages
						? { devcontainers: this.devcontainerImages }
						: {}),
					logger: this.logger,
				});
			}
		}

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
		// Sandbox worker logs. Re-emitted through this process's own logger so
		// they ride the router's existing path into Log Analytics — the ACA
		// sandboxGroups resource has no log collection of its own. Attribution
		// comes from the device row, never from the frame.
		this.gateway.on("log", (deviceId: number, frame: LogFrame) => {
			const info = this.store.getDeviceInfo(deviceId);
			this.sandboxLogRelay.relay(frame, {
				deviceId,
				...(info?.issueKey ? { issueKey: info.issueKey } : {}),
				...(info?.provider ? { provider: info.provider } : {}),
			});
		});
		// Sandbox worker spans. Handed straight to the router's own span exporter
		// — NOT re-created through a tracer, which would mint new span ids and
		// orphan every child the worker already recorded. Attribution comes from
		// the device row; the worker's `resource` is preserved so a relayed span
		// keeps saying it came from the worker.
		//
		// `sandboxSpanRelay` is undefined until `setSpanExporter` is called by the
		// bootstrap, which happens only when trace export is enabled. Until then
		// the frames are parsed, ignored, and cost nothing — a worker whose router
		// has tracing off never gets the capability advertised in the first place,
		// so in practice none arrive.
		this.gateway.on("span", (deviceId: number, frame: SpanFrame) => {
			if (!this.sandboxSpanRelay) return;
			const info = this.store.getDeviceInfo(deviceId);
			this.sandboxSpanRelay.relay(frame, {
				deviceId,
				...(info?.issueKey ? { issueKey: info.issueKey } : {}),
				...(info?.provider ? { provider: info.provider } : {}),
			});
		});
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
						this.logger.error(
							`reconcileDeviceLocks failed for device ${deviceId}`,
							err,
						);
					});
				// Affinity leaks independently of locks: routePrompted writes affinity
				// with NO issue lock, so reconcileDeviceLocks cannot see those rows.
				try {
					this.eventRouter.reconcileDeviceAffinity(
						deviceId,
						activeSessions,
						Date.now(),
					);
				} catch (err: unknown) {
					this.logger.error(
						`reconcileDeviceAffinity failed for device ${deviceId}`,
						err,
					);
				}
			},
		);
	}

	/**
	 * Test seam: reports whether a device currently holds an open WebSocket to
	 * the gateway. Lets the e2e suite wait deterministically for the server to
	 * observe a disconnect (so a subsequent routed event takes the offline
	 * queue-and-notice path) instead of racing a fixed sleep.
	 */
	/**
	 * Test seam: asks a device which sessions it is running, the same call the
	 * sweep's affinity reconciler makes. Exposed so the e2e suite can drive the
	 * real gateway/worker round trip with only the clock injected, rather than
	 * standing up a second gateway. Resolves `undefined` for "can't tell".
	 */
	queryDeviceSessions(
		deviceId: number,
		timeoutMs: number,
	): Promise<string[] | undefined> {
		return this.gateway.querySessions(deviceId, timeoutMs);
	}

	isDeviceOnline(deviceId: number): boolean {
		return this.gateway.isOnline(deviceId);
	}

	/**
	 * Point the sandbox span relay at the router's span exporter.
	 *
	 * Called by the CLI bootstrap after it starts trace export, and never when
	 * tracing is disabled. A setter rather than a constructor argument because
	 * `RouterServerConfig` is a plain, serialisable config object shared with the
	 * F1 rig and every test — threading an OTel exporter through it would make an
	 * optional telemetry dependency part of the router's construction contract.
	 *
	 * Safe to call before `start()` and safe never to call at all.
	 */
	setSpanExporter(exporter: SpanExporter): void {
		this.sandboxSpanRelay = new SandboxSpanRelay({
			exporter,
			logger: this.logger,
		});
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

		// A build in flight when the previous process exited left a durable
		// `building` row that nothing alive can now clear, and `created` webhooks
		// held behind it. Reschedule and release them; the router is
		// single-replica and restarts on every deploy, so this is routine.
		this.devcontainerImages?.recoverInterruptedBuilds();

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
				this.logger.error("Event sweep failed", err);
			});
			this.containerLifecycle?.sweep().catch((err: unknown) => {
				this.logger.error("Container lifecycle sweep failed", err);
			});
		}, SWEEP_INTERVAL_MS);
		this.stateBackup?.start();
	}

	async stop(): Promise<void> {
		if (this.devcontainerGcInterval) {
			clearInterval(this.devcontainerGcInterval);
			this.devcontainerGcInterval = undefined;
		}
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
	 * Registers the Fleet Operations discovery and operator-context routes.
	 *
	 * Called from the constructor, before {@link start}: Fastify v5 forbids
	 * adding routes once the server is listening. Registered unconditionally —
	 * see {@link RouterServerConfig.fleetOperations} on why an unconfigured
	 * router still serves discovery.
	 */
	private registerFleetOperations(): void {
		const fleetConfig = this.config.fleetOperations ?? {};
		const entra = fleetConfig.access?.entra;
		const workspaceIds = Object.keys(this.config.workspaces);
		const verifyEntraToken =
			this.config.operatorTokenVerifier ??
			(entra ? createEntraOperatorTokenVerifier(entra) : undefined);
		const authorizer = new OperatorAuthorizer({
			store: this.store,
			workspaceIds,
			...(fleetConfig.access ? { access: fleetConfig.access } : {}),
			...(verifyEntraToken ? { verifyEntraToken } : {}),
			logger: this.logger,
		});
		const fleet = new FleetOperations({
			config: {
				...fleetConfig,
				capabilities: this.servedOperatorCapabilities(fleetConfig),
			},
			workspaceIds,
		});
		registerFleetOperationsRoutes(this.fastify, {
			fleet,
			authorizer,
			logger: this.logger,
		});
		if (entra) {
			this.logger.info(
				`Fleet Operations Entra access enabled (tenant ${entra.tenantId}, audience ${entra.audience}, ${entra.grants.length} grant(s))`,
			);
		}
	}

	/**
	 * What this router ACTUALLY serves over the operator interface — derived
	 * from the routes registered above, never read from the config file.
	 *
	 * A client gates an optional command on a capability rather than on the
	 * router's Cyrus version, so a capability advertised without a route behind
	 * it presents to an orchestrating agent as a fleet problem rather than as a
	 * router older than its CLI. `logs.query` is servable today because the
	 * client queries the log backend DIRECTLY: the router only has to describe
	 * where it is, which is exactly what a configured `logSource` does. The run
	 * and recovery routes do not exist yet, so they are not advertised.
	 */
	private servedOperatorCapabilities(
		fleetConfig: FleetOperationsConfig,
	): OperatorCapabilityV1[] {
		return fleetConfig.logSource ? ["logs.query"] : [];
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
				repositoryResolver: RepositoryResolver;
				devcontainers?: DevcontainerImageService;
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

		// The registered-provider startup check specified in the /setup
		// management-UI plan and never implemented. Without it, a
		// `defaultExecutor` naming a provider that does not exist is accepted
		// silently and only surfaces per-issue, deep in `bootInnerTraced`, after
		// a device row has been created and the event queued onto it — an event
		// that will never be delivered because nothing will ever connect.
		if (
			containers.defaultExecutor &&
			containers.defaultExecutor !== EXECUTOR_TYPE_DEVICE &&
			!executors.has(containers.defaultExecutor)
		) {
			throw new Error(
				`containers.defaultExecutor is "${containers.defaultExecutor}", but no such container provider is registered (registered: ${
					[...executors.keys()].join(", ") || "none"
				}). Every user inheriting this default would create a device row, queue their event onto it, and then fail at boot with the event stranded.`,
			);
		}

		// Executor forcing (NOR-364). Where ACA is registered it is the only
		// executor that works, so there is no choice left to express and the
		// per-user `executor_json` picker becomes noise that can only be set
		// wrong. Forcing here rather than rewriting every `users` row keeps the
		// stored values intact, so removing `containers.aca` restores the previous
		// behaviour exactly.
		const forcedExecutor = executors.has("aca") ? "aca" : undefined;
		if (forcedExecutor) {
			this.logger.info(
				`ACA is registered, so every user's sessions run in an ACA container regardless of their stored executor. Physical-device enrollment is inactive on this router.`,
			);
		}

		// The Codex credential store needs a KEK. A Key Vault key is preferred —
		// `codex.keyId` first, then the one the secret bundle uses; without
		// either, a 0600 local key file keeps the credential out of the `.db`
		// that `StateBackup` uploads. Sealing is never skipped — see
		// `LocalKeyWrapper` for exactly what each buys.
		let codexTokens: CodexTokenStore | undefined;
		if (containers.codex) {
			const keyId = containers.codex.keyId ?? containers.tableStore?.keyId;
			const localKeyPath =
				containers.codex.localKeyPath ??
				join(dirname(this.config.dbPath), "codex-kek.key");
			if (!keyId) {
				// Loud, because the failure it precedes is silent and delayed:
				// nothing backs this file up (`StateBackup` uploads `router.db`
				// only), so on a host with an ephemeral disk the database returns
				// after a restart and the key does not. `openBundle` then fails,
				// `CodexTokenStore.get` reports the credential as absent, and the
				// user sees "no account connected" — indistinguishable from never
				// having connected one, days after they did.
				this.logger.warn(
					`Sealing Codex credentials with the local key at ${localKeyPath}. Nothing backs that file up, so every stored credential is lost — while still appearing connected — if this host's disk does not survive a restart. Configure containers.codex.keyId with a Key Vault key, or point containers.codex.localKeyPath at durable storage.`,
				);
			}
			const wrapper = keyId
				? new KeyVaultKeyWrapper({ keyId, logger: this.logger })
				: new LocalKeyWrapper(localKeyPath);
			codexTokens = new CodexTokenStore({
				store: this.store,
				wrapper,
				logger: this.logger,
				...(containers.codex.clientId
					? { clientId: containers.codex.clientId }
					: {}),
			});
		}
		this.codexTokens = codexTokens;

		const repositoryRegistry = createRepositoryRegistry({
			...(containers.tableStore
				? {
						tableStore: {
							endpoint: containers.tableStore.endpoint,
							...(containers.tableStore.tableName
								? { tableName: containers.tableStore.tableName }
								: {}),
						},
					}
				: {}),
			filePath:
				containers.repositoriesPath ??
				join(dirname(this.config.dbPath), "repositories.json"),
		});
		this.repositoryRegistry = repositoryRegistry;

		// Seeding is fire-and-forget: it must not delay the listen(), and a
		// transient Table error here is recoverable — the next start retries,
		// and the setup UI can populate the registry by hand meanwhile.
		void seedRepositoryRegistry(
			repositoryRegistry,
			containers.repositories,
			this.logger,
		).catch((error: unknown) => {
			this.logger.error("Could not seed the repository registry", error);
		});

		this.devcontainerImages = this.buildDevcontainerImages(containers);

		const containerTargets = new ContainerTargetService({
			store: this.store,
			secrets,
			executors,
			registry: repositoryRegistry,
			...(this.devcontainerImages
				? { devcontainers: this.devcontainerImages }
				: {}),
			containersConfig: {
				routerUrlForContainers: containers.routerUrlForContainers,
				requiredSecretKeys: containers.requiredSecretKeys,
				defaultExecutor: containers.defaultExecutor,
				...(forcedExecutor ? { forcedExecutor } : {}),
			},
			...(codexTokens ? { codexTokens } : {}),
			postActivity: (workspaceId, agentSessionId, body) =>
				this.executor.postActivity(workspaceId, agentSessionId, body),
			logger: this.logger,
		});

		// Router-side repository pre-selection (Task 9/10) covers container
		// targets only (design doc §5): a physical-device user's own EdgeWorker
		// already runs its own `RepositoryRouter` and pending-selection flow, so
		// this must never be wired for a deployment with no `containers` block —
		// returning it only from this containers-gated method is what guarantees
		// that.
		const repositoryResolver = new RepositoryResolver({
			registry: repositoryRegistry,
			fetchIssueFacts: (workspaceId, issueId) =>
				this.executor.fetchIssueFacts(workspaceId, issueId),
			logger: this.logger,
		});

		const sessionsQueryTimeoutMs =
			containers.sessionsQueryTimeoutMs ?? DEFAULT_SESSIONS_QUERY_TIMEOUT_MS;
		// A settle window shorter than the interval between the ticks that would
		// observe it cannot do its job: the veto reads a run-end stamp that is
		// itself up to one tick old, so anything under a tick is off in practice
		// while reading as configured. The overwhelmingly likely cause is units —
		// `terminalSettleMs: 120` meant as two minutes. Warn rather than reject:
		// this is the one knob a test rig legitimately turns right down.
		if (
			containers.terminalSettleMs !== undefined &&
			containers.terminalSettleMs < SWEEP_INTERVAL_MS
		) {
			this.logger.warn(
				`terminalSettleMs (${containers.terminalSettleMs}ms) is shorter than the ` +
					`${SWEEP_INTERVAL_MS}ms sweep interval, so it will effectively never ` +
					`defer a stop. This value is in MILLISECONDS — did you mean ` +
					`${containers.terminalSettleMs * 1000}?`,
			);
		}
		this.containerLifecycle = new ContainerLifecycle({
			store: this.store,
			executors,
			idleStopMs: containers.idleStopMs ?? DEFAULT_IDLE_STOP_MS,
			staleDestroyMs: containers.staleDestroyMs ?? DEFAULT_STALE_DESTROY_MS,
			offlineAgeOutMs: containers.offlineAgeOutMs ?? DEFAULT_OFFLINE_AGE_OUT_MS,
			...(containers.strandedSessionGraceMs !== undefined
				? { strandedSessionGraceMs: containers.strandedSessionGraceMs }
				: {}),
			...(containers.sessionNoProgressMs !== undefined
				? { sessionNoProgressMs: containers.sessionNoProgressMs }
				: {}),
			...(containers.terminalSettleMs !== undefined
				? { terminalSettleMs: containers.terminalSettleMs }
				: {}),
			logger: this.logger,
			sessionReconciler: {
				isOnline: (deviceId) => this.gateway.isOnline(deviceId),
				reconcile: async (deviceId) => {
					const declared = await this.gateway.querySessions(
						deviceId,
						sessionsQueryTimeoutMs,
					);
					// `undefined` (no answer) flows straight through: reconcileDeviceAffinity
					// treats it as "can't tell" and reclaims nothing.
					return this.eventRouter.reconcileDeviceAffinity(
						deviceId,
						declared,
						Date.now(),
					);
				},
			},
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

		return {
			service: containerTargets,
			secrets,
			kind,
			repositoryResolver,
			...(this.devcontainerImages
				? { devcontainers: this.devcontainerImages }
				: {}),
		};
	}

	/**
	 * Per-repository devcontainer images (NOR-309), when configured.
	 *
	 * Built inside {@link buildContainerTargets} rather than beside it because
	 * it needs the ACA client and the repository registry that method creates,
	 * and because it must not exist at all for a deployment with no `containers`
	 * block.
	 */
	private buildDevcontainerImages(
		containers: RouterContainersConfig,
	): DevcontainerImageService | undefined {
		const cfg = containers.devcontainers;
		if (!cfg) return undefined;
		if (!containers.aca) {
			// A per-repository image is a per-repository ACA DISK. Silently doing
			// nothing here would present as "my devcontainer is ignored" with no
			// line anywhere saying why.
			this.logger.warn(
				"containers.devcontainers is configured but containers.aca is not; per-repository images need an ACA sandbox group and will be ignored",
			);
			return undefined;
		}
		const client = new AcaSandboxClient({
			subscriptionId: containers.aca.subscriptionId,
			resourceGroup: containers.aca.resourceGroup,
			sandboxGroup: containers.aca.sandboxGroup,
			region: containers.aca.region,
			tokenProvider: createDefaultTokenProvider(),
			apiVersion: containers.aca.apiVersion,
			baseUrl: containers.aca.managementEndpoint,
		});
		const getArmToken = createArmTokenProvider();
		const builder = new AcrDevcontainerBuilder(
			{
				subscriptionId: containers.aca.subscriptionId,
				resourceGroup: containers.aca.resourceGroup,
				registry: cfg.registry,
				loginServer: cfg.loginServer,
				...(cfg.imageRepository
					? { imageRepository: cfg.imageRepository }
					: {}),
				...(cfg.buildTimeoutSeconds
					? { timeoutSeconds: cfg.buildTimeoutSeconds }
					: {}),
			},
			createArmRequestFn(this.logger, getArmToken),
			this.logger,
		);
		const service = new DevcontainerImageService({
			store: this.store,
			logger: this.logger,
			builder,
			aca: client,
			getArmToken,
			githubToken: cfg.githubToken,
			deploymentDisk: containers.aca.disk,
			workerFeatureRef: cfg.workerFeatureRef,
			workerFeatureVersion: cfg.workerFeatureVersion,
			workerPayloadTarball: cfg.workerPayloadTarball,
			...(cfg.workerUser ? { workerUser: cfg.workerUser } : {}),
			registryLoginServer: cfg.loginServer,
		});
		// Slow by design and well away from the 60s lifecycle sweep: a disk
		// deletion is cheap, but listing snapshots and disk images is not, and
		// getting a reference count wrong is expensive in exactly one direction.
		const gcIntervalMs = cfg.gcIntervalMs ?? 6 * 60 * 60 * 1000;
		this.devcontainerGcInterval = setInterval(() => {
			void service.collectGarbage().catch((error: unknown) => {
				this.logger.error("Devcontainer disk-image GC failed", error);
			});
		}, gcIntervalMs);
		this.devcontainerGcInterval.unref?.();
		this.logger.info(
			`Per-repository devcontainer images enabled (registry ${cfg.loginServer}, worker feature ${cfg.workerFeatureRef})`,
		);
		return service;
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
