import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { LinearClient } from "@linear/sdk";
import { resolvePath } from "cyrus-core";
import {
	buildGitHubTokenScopeReport,
	type ContainerDeviceInfo,
	createAcaSandboxesProvider,
	createSetupIdTokenVerifier,
	DEFAULT_REQUIRED_SECRET_KEYS,
	type DeviceInfo,
	GITHUB_TOKEN_SECRET_KEYS,
	isReservedEnvKey,
	isStorableSecretKey,
	KeyVaultSecretStore,
	KeyVaultTokenStore,
	type LinearTokenEnvelope,
	type PendingTeardownInfo,
	probeGitHubTokenScopes,
	RESERVED_ENV_KEYS,
	RouterServer,
	type RouterServerConfig,
	RouterStore,
	SecretStore,
	type SecretStoreBackend,
	type SessionInfo,
	TableSecretStore,
} from "cyrus-router";
import { z } from "zod";
import { BaseCommand } from "./ICommand.js";

/**
 * A Linear human issue identifier: a team key (letters/digits, starting with a
 * letter) then a hyphen then a number — e.g. `PAR-169`, `ENG-12`. Deliberately
 * NOT matched by issue GUIDs: a UUID's first hyphen is followed by more hex and
 * hyphens (`aaaa-1111-...`), so `-\d+$` (digits only to the end) fails. Used by
 * `unlock` to decide whether a value needs Linear resolution or is already a
 * GUID it can look up directly.
 */
const ISSUE_IDENTIFIER_RE = /^[A-Za-z][A-Za-z0-9]*-\d+$/;

/** Valid values for `cyrus router users set-executor <email> <type>`. */
const EXECUTOR_TYPES = [
	"device",
	"docker",
	"fly",
	"codespaces",
	"aca",
] as const;
type ExecutorType = (typeof EXECUTOR_TYPES)[number];

function isExecutorType(value: string): value is ExecutorType {
	return (EXECUTOR_TYPES as readonly string[]).includes(value);
}

/**
 * Render an elapsed duration in the most significant unit that fits the
 * column: `45s`, `12m`, `6h13m`, `3d4h`.
 *
 * Hours keep their minutes because the whole point of the UPTIME column is
 * telling `5h58m` from `6h02m` — the boundary the long-running-sandbox alert
 * fires on. Days keep their hours for the same reason at the stale-destroy
 * boundary. A negative input (a clock that moved backwards between the write
 * and this read) clamps to `0s` rather than printing a nonsense duration.
 */
function formatElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const totalMinutes = Math.floor(totalSeconds / 60);
	if (totalMinutes < 60) return `${totalMinutes}m`;
	const totalHours = Math.floor(totalMinutes / 60);
	if (totalHours < 24) return `${totalHours}h${totalMinutes % 60}m`;
	return `${Math.floor(totalHours / 24)}d${totalHours % 24}h`;
}

/**
 * Column widths for `containers list`'s table, shared between the header
 * (see {@link RouterCommand.formatContainerDeviceHeader}) and each data row
 * (see {@link RouterCommand.formatContainerDeviceRow}) so the two can never
 * drift out of alignment the way the previous hand-written header string did.
 */
const CONTAINERS_TABLE_COLUMN_WIDTHS = {
	issueKey: 21,
	provider: 10,
	email: 30,
	lastRouted: 25,
	lastSeen: 25,
	age: 8,
	uptime: 8,
	parked: 8,
} as const;

/**
 * Column widths for `devices list`'s table, shared between its header and data
 * rows so they can't drift apart. Mirrors {@link CONTAINERS_TABLE_COLUMN_WIDTHS}.
 */
const DEVICES_TABLE_COLUMN_WIDTHS = {
	email: 30,
	kind: 10,
	issueKey: 15,
	provider: 10,
	lastSeen: 25,
} as const;

/**
 * Column widths for `sessions list`'s table. The two GUID columns (session id
 * and the Linear issue id) are wide because those are the values an operator
 * copies into `cyrus router unlock <issueId>`.
 */
const SESSIONS_TABLE_COLUMN_WIDTHS = {
	sessionId: 38,
	issueId: 38,
	state: 8,
	email: 28,
} as const;

interface SnapshotGcItem {
	id: string;
	issueKey: string;
	deviceId: string;
	createdAtUtc?: string;
}

/**
 * The slice of the ACA provider the out-of-process CLI drives directly: snapshot
 * GC, and the real resource teardown behind `containers destroy`.
 *
 * `destroy` is optional so a test double supplying only the GC methods still
 * satisfies it; callers check for it before use, the same way
 * {@link RouterCommand.containersGcSnapshots} checks `gcOrphanSnapshots`.
 */
interface AcaMaintenanceProvider {
	planOrphanSnapshots(activeIssueKeys: string[]): Promise<SnapshotGcItem[]>;
	gcOrphanSnapshots(
		activeIssueKeys: string[],
		printedPlan?: SnapshotGcItem[],
	): Promise<SnapshotGcItem[]>;
	destroy?(issueKey: string): Promise<void>;
}

/**
 * JSON shape of `<cyrusHome>/router-config.json`: a {@link RouterServerConfig}
 * minus `dbPath` (always defaulted to `<cyrusHome>/router/router.db` — see
 * {@link RouterCommand.resolveDbPath}) and minus the runtime-only
 * `trackerFactory`/`logger` fields, which aren't JSON-serializable.
 */
const RouterConfigFileSchema = z.object({
	port: z.number(),
	workspaces: z.record(
		z.string(),
		z.object({
			linearToken: z.string(),
			// Optional for backward compatibility with configs written before token
			// refresh existed. Absent, the router warns at startup and the access
			// token stops working when Linear expires it (~24h).
			linearRefreshToken: z.string().optional(),
		}),
	),
	webhook: z.object({
		verificationMode: z.enum(["direct", "proxy"]),
		secret: z.string(),
	}),
	eventTtlMs: z.number().optional(),
	issueLock: z.boolean().optional(),
	creatorOnlyPrompting: z.boolean().optional(),
	heartbeatMs: z.number().optional(),
	host: z.string().optional(),
	backup: z
		.object({
			blobContainerUrl: z.string(),
			intervalMs: z.number().optional(),
		})
		.optional(),
	/**
	 * Durable store for rotated Linear OAuth tokens. Optional: without it the
	 * refresh token is written only to router-config.json, which is ephemeral on
	 * ACA and regenerated from env on every start — the exact combination that
	 * caused the 2026-07-30 outage. Self-host deployments with no Key Vault
	 * legitimately omit it.
	 */
	linearTokenStore: z
		.object({
			keyVaultUrl: z.string().min(1),
		})
		.optional(),
	entra: z
		.object({
			tenantId: z.string().min(1),
			audience: z.string().min(1),
			allowedDomain: z.string().optional(),
			jwksUrl: z.string().optional(),
			certificateIssuerId: z.string().optional(),
		})
		.optional(),
	// Opt-in ephemeral container executor settings — see
	// RouterContainersConfig in cyrus-router. Omitting this field entirely (the
	// default) leaves the router routing every user to their enrolled physical
	// device, identical to today's behavior.
	containers: z
		.object({
			image: z.string(),
			routerUrlForContainers: z.string(),
			repositories: z.array(
				z.object({
					name: z.string(),
					githubSlug: z.string(),
					linearWorkspaceId: z.string(),
					baseBranch: z.string().optional(),
					// Routing metadata. Only ever used to SEED the registry on first
					// start — after that the stored registry is authoritative and
					// these are ignored. See seedRepositoryRegistry.
					teamKeys: z.array(z.string()).optional(),
					projectKeys: z.array(z.string()).optional(),
					routingLabels: z.array(z.string()).optional(),
					isDefault: z.boolean().optional(),
				}),
			),
			artifactsDir: z.string().optional(),
			secretsPath: z.string().optional(),
			// Default `<dirname(dbPath)>/repositories.json`; only the file-backed
			// registry consults it — ignored once tableStore selects Table storage.
			repositoriesPath: z.string().optional(),
			keyVaultUrl: z.string().optional(),
			// Azure Table backend for per-user secrets. Takes precedence over
			// keyVaultUrl. Unmodelled fields are stripped on EVERY `router start`
			// (safeParse + spread below), not merely on rewrite — so omitting this
			// would make the field silently vanish in every deployment.
			tableStore: z
				.object({
					endpoint: z.string().min(1),
					tableName: z.string().optional(),
					keyId: z.string().min(1),
				})
				.optional(),
			/**
			 * Executor inherited by users whose stored executor is the explicit
			 * `{"type":"default"}` sentinel. A NULL/absent executor still means
			 * physical device and is deliberately NOT captured by this — see F11
			 * on NOR-270. Without that distinction, enabling this would silently
			 * move every deliberately-set-to-device user onto cloud sandboxes.
			 */
			defaultExecutor: z.string().min(1).optional(),
			idleStopMs: z.number().optional(),
			staleDestroyMs: z.number().optional(),
			teardownGraceMs: z.number().optional(),
			affinityGraceMs: z.number().optional(),
			offlineAgeOutMs: z.number().optional(),
			sessionsQueryTimeoutMs: z.number().optional(),
			requiredSecretKeys: z
				.array(
					z.string().refine(isStorableSecretKey, {
						error: (issue) =>
							`"${String(issue.input)}" is not a valid, non-reserved env-var name`,
					}),
				)
				.optional(),
			docker: z
				.object({
					memoryLimit: z.string().optional(),
					network: z.string().optional(),
				})
				.optional(),
			// Azure Container Apps (ACA) Sandboxes provider — opt-in, additive.
			// When present, the router's default executor registry also builds
			// an "aca" AcaSandboxesProvider alongside "docker". When absent,
			// non-Azure deployments are byte-for-byte unchanged.
			aca: z
				.object({
					subscriptionId: z.string(),
					resourceGroup: z.string(),
					sandboxGroup: z.string(),
					region: z.string(),
					disk: z.string(),
					cpu: z.string().optional(),
					memory: z.string().optional(),
					autoSuspendSeconds: z.number().nonnegative().optional(),
					egress: z
						.object({
							defaultAction: z.enum(["Allow", "Deny"]),
							trafficInspection: z.enum(["Legacy", "Full", "Partial", "None"]),
							hostRules: z
								.array(
									z.object({
										pattern: z
											.string()
											.refine((value) => value.trim().length > 0),
										action: z.enum(["Allow", "Deny"]),
									}),
								)
								.optional(),
						})
						.optional(),
					keepSnapshots: z.number().int().nonnegative().optional(),
					disconnectedRecreateMs: z.number().nonnegative().default(120_000),
					resumeConnectTimeoutMs: z.number().nonnegative().default(90_000),
					resumeConnectPollMs: z.number().positive().default(2_000),
					apiVersion: z.string().optional(),
					managementEndpoint: z.string().optional(),
				})
				.optional(),
		})
		.optional(),
	/**
	 * Authenticated `/setup*` management UI. Off by default.
	 *
	 * `auth` is intentionally a required discriminated union when enabled: how
	 * identity is established is an explicit operator choice, never inferred
	 * from `entra` above (which governs enrollment tokens for `/enroll`). The
	 * router refuses to start on an ambiguous strategy — see D1' on NOR-265.
	 */
	setupUi: z
		.object({
			enabled: z.boolean(),
			auth: z
				.discriminatedUnion("mode", [
					z.object({
						mode: z.literal("easyauth-headers"),
						verifiedHeaderStrip: z.literal(true),
					}),
					z.object({
						mode: z.literal("entra-token"),
						idTokenAudience: z.string().min(1),
					}),
					z.object({ mode: z.literal("dev-insecure-headers") }),
				])
				.optional(),
			allowedDomain: z.string().optional(),
			/** Default false — see F5 on NOR-265. */
			autoProvisionUsers: z.boolean().optional(),
		})
		.optional(),
});

/**
 * Result of a single `{ viewer { id } }` probe against Linear.
 *
 * `rejected` means Linear answered and refused the token; `unknown` means the
 * probe never got an answer. They must stay distinguishable: only the first says
 * anything about the credential.
 */
interface LinearTokenProbe {
	outcome: "ok" | "rejected" | "unknown";
	detail: string;
}

/**
 * Router server administration:
 *
 *   cyrus router start                          # start the router server
 *   cyrus router users add <email> [--name x]   # register a user + mint an enrollment code
 *   cyrus router users list                     # list registered users + their running session counts
 *   cyrus router users remove <email>           # remove a user
 *   cyrus router users set-executor <email> <device|docker|fly|codespaces|aca>
 *                                                # choose where a user's sessions run
 *   cyrus router devices list                   # list enrolled devices + who owns them
 *   cyrus router devices revoke <email>         # revoke a user's enrolled device
 *   cyrus router sessions list                  # list running + locked sessions (issue id + session GUID)
 *   cyrus router secrets set <email> <ENV_VAR_NAME> <value>
 *                                                # store a per-user container secret
 *   cyrus router secrets unset <email> <ENV_VAR_NAME>
 *                                                # remove a per-user container secret
 *   cyrus router secrets list <email> [--check-scopes]
 *                                                # list stored secret keys (masked) + missing required;
 *                                                # --check-scopes additionally reports the stored GitHub
 *                                                # token's OAuth scopes (advisory, never rejects)
 *   cyrus router containers list                # list running ephemeral container devices
 *   cyrus router containers destroy <issueKey>  # drop a container device's row
 *   cyrus router containers gc-snapshots [--yes] # plan/delete orphan ACA snapshots
 *   cyrus router linear status                  # probe each workspace's Linear access token + report its source
 *   cyrus router unlock <issueId|PAR-123>       # release a stuck issue lock (GUID or Linear identifier)
 *
 * Every subcommand except `start` opens a {@link RouterStore} directly on the
 * db file (rather than talking to a running server over HTTP). Task 6's WAL
 * pragma makes this safe to do concurrently with a running `router start`
 * process holding the same db open.
 */
export class RouterCommand extends BaseCommand {
	private linearTokenStore?: KeyVaultTokenStore;
	/**
	 * Per-workspace config/env refresh token in effect at startup. Written into
	 * every envelope as `seedRefreshToken` so a later start can tell whether an
	 * operator has re-seeded the chain.
	 */
	private linearTokenSeeds = new Map<string, string>();
	/**
	 * Where each workspace's tokens came from after the last
	 * {@link resolveWorkspaceTokens} call — `"keyvault"` when the stored
	 * envelope was trusted, `"config"` when the config/env value won (no
	 * store, no envelope, or a stale/mismatched one). Consumed by callers that
	 * report startup diagnostics.
	 */
	private linearTokenSources = new Map<string, "keyvault" | "config">();
	/** `updatedMs` of the Key Vault envelope actually adopted, per workspace. */
	private linearTokenUpdatedMs = new Map<string, number>();

	async execute(args: string[]): Promise<void> {
		const [subcommand, ...rest] = args;
		switch (subcommand) {
			case "start":
				return this.start();
			case "users":
				return this.users(rest);
			case "devices":
				return this.devices(rest);
			case "sessions":
				return this.sessions(rest);
			case "secrets":
				return this.secrets(rest);
			case "containers":
				return this.containers(rest);
			case "linear":
				return this.linear(rest);
			case "unlock":
				return this.unlock(rest[0]);
			default:
				this.exitWithError(
					"Usage: cyrus router <start|users add <email>|users list|users remove <email>|users set-executor <email> <device|docker|fly|codespaces|aca>|devices list|devices revoke <email>|sessions list|secrets set <email> <ENV_VAR_NAME> <value>|secrets unset <email> <ENV_VAR_NAME>|secrets list <email> [--check-scopes]|containers list|containers destroy <issueKey>|containers gc-snapshots [--yes]|linear status|unlock <issueId>>",
				);
		}
	}

	/**
	 * `<cyrusHome>/router/router.db` — the single shared db file used by both
	 * `router start` (via {@link RouterServer}) and every admin subcommand.
	 */
	private resolveDbPath(): string {
		return join(resolvePath(this.app.cyrusHome), "router", "router.db");
	}

	/**
	 * Single source for the router config path. `resolvePath` expands a
	 * `~`-prefixed `--cyrus-home`, matching {@link resolveDbPath}.
	 */
	private resolveConfigPath(): string {
		return join(resolvePath(this.app.cyrusHome), "router-config.json");
	}

	private openStore(): RouterStore {
		const dbPath = this.resolveDbPath();
		mkdirSync(dirname(dbPath), { recursive: true });
		return new RouterStore(dbPath);
	}

	/**
	 * Like {@link openStore}, but refuses to CREATE the database.
	 *
	 * Inspection subcommands must never conjure the state they exist to report
	 * on. Run inside the ACA router container without `--cyrus-home /data`,
	 * `containers list` used to create an empty db under the default home and
	 * print "No container devices." while the live db sat at
	 * `/data/router/router.db` — the opposite of the truth, produced by the very
	 * tool an operator reaches for when a container looks stuck. Anything that
	 * reads or mutates existing router state uses this; only `users add`
	 * (first-run bootstrap) and `router start` may create the file.
	 */
	private openExistingStore(): RouterStore {
		const dbPath = this.resolveDbPath();
		if (!existsSync(dbPath)) {
			this.exitWithError(
				`No router database at ${dbPath}. ` +
					`Pass --cyrus-home <path> pointing at the running router's home ` +
					`(inside the ACA router container that is --cyrus-home /data), ` +
					`or run 'cyrus router users add <email>' first if this is a new install.`,
			);
		}
		return new RouterStore(dbPath);
	}

	/**
	 * The secrets file the running router will actually read:
	 * `router-config.json`'s `containers.secretsPath` when set, otherwise
	 * `<dirname(dbPath)>/user-secrets.json` — MUST match
	 * {@link RouterServer.buildContainerTargets}'s own resolution exactly
	 * (`containers.secretsPath ?? join(dirname(config.dbPath),
	 * "user-secrets.json")`, where `config.dbPath` is this same
	 * {@link resolveDbPath} value passed in by {@link start}). A mismatch here
	 * means secrets written via `router secrets set` are silently invisible to
	 * the running router.
	 *
	 * The override value is used verbatim (not passed through
	 * {@link resolvePath}) because {@link RouterServer} itself uses it
	 * verbatim — resolving it here while the router doesn't would just trade
	 * one mismatch for another. `resolvePath` IS used to locate
	 * `router-config.json` itself under `cyrusHome`, mirroring
	 * {@link resolveDbPath}, so a `~`-prefixed `--cyrus-home` still works.
	 */
	private resolveSecretsPath(): string {
		const defaultPath = join(
			dirname(this.resolveDbPath()),
			"user-secrets.json",
		);

		return this.readRouterConfig()?.containers?.secretsPath ?? defaultPath;
	}

	/**
	 * Resolves the break-glass secret backend, matching the router's own
	 * precedence in `RouterServer.buildContainerTargets`: Table, then Key Vault,
	 * then the 0600 file store. Drift here would have the CLI reading a
	 * different store than the one a container boot reads.
	 */
	private openSecretStore(): SecretStoreBackend {
		const containers = this.readRouterConfig()?.containers;
		if (containers?.tableStore)
			return new TableSecretStore({
				tableEndpoint: containers.tableStore.endpoint,
				tableName: containers.tableStore.tableName,
				keyId: containers.tableStore.keyId,
				logger: this.logger,
			});
		if (containers?.keyVaultUrl)
			return new KeyVaultSecretStore({
				vaultUrl: containers.keyVaultUrl,
				logger: this.logger,
			});
		return new SecretStore(this.resolveSecretsPath());
	}

	private readRouterConfig():
		| z.infer<typeof RouterConfigFileSchema>
		| undefined {
		const configPath = this.resolveConfigPath();
		if (!existsSync(configPath)) return undefined;
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(configPath, "utf-8"));
		} catch (error) {
			throw new Error(
				`Failed to parse ${configPath}: ${(error as Error).message}`,
			);
		}
		const parsed = RouterConfigFileSchema.safeParse(raw);
		if (!parsed.success) {
			throw new Error(
				`Invalid router config at ${configPath}: ${parsed.error.message}`,
			);
		}
		return parsed.data;
	}

	/**
	 * The EFFECTIVE required set the running router enforces: the always-on
	 * Claude token plus `containers.requiredSecretKeys` from router-config.json.
	 * Read the same way `resolveSecretsPath` reads the config so `secrets list`
	 * matches what actually blocks boot.
	 */
	private resolveRequiredSecretKeys(): string[] {
		const configured =
			this.readRouterConfig()?.containers?.requiredSecretKeys ?? [];
		return [...new Set([...DEFAULT_REQUIRED_SECRET_KEYS, ...configured])];
	}

	private async start(): Promise<void> {
		const configPath = this.resolveConfigPath();
		if (!existsSync(configPath)) {
			this.exitWithError(`No router config found at ${configPath}`);
		}

		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(configPath, "utf-8"));
		} catch (error) {
			this.exitWithError(
				`Failed to parse ${configPath}: ${(error as Error).message}`,
			);
		}

		const parsed = RouterConfigFileSchema.safeParse(raw);
		if (!parsed.success) {
			this.exitWithError(
				`Invalid router config at ${configPath}: ${parsed.error.message}`,
			);
		}

		const dbPath = this.resolveDbPath();
		mkdirSync(dirname(dbPath), { recursive: true });

		this.configureLinearTokenStore(parsed.data);

		const resolvedWorkspaces = await this.resolveWorkspaceTokens(
			parsed.data.workspaces,
		);

		const config: RouterServerConfig = {
			...parsed.data,
			workspaces: resolvedWorkspaces,
			dbPath,
			oauth: this.resolveOAuthCredentials(),
			onTokenRefresh: (workspaceId, tokens) =>
				this.persistRefreshedTokens(configPath, workspaceId, tokens),
			logger: this.logger,
			// The recommended production mode for /setup verifies the ID token the
			// ACA token store forwards, rather than trusting proxy-injected headers.
			// It needs its own verifier: the enrollment one pins the `api://`
			// access-token audience and returns only an email (D2').
			...(parsed.data.setupUi?.enabled &&
			parsed.data.setupUi.auth?.mode === "entra-token"
				? {
						setupIdTokenVerifier: createSetupIdTokenVerifier({
							tenantId: this.requireEntraTenantForSetup(parsed.data),
							idTokenAudience: parsed.data.setupUi.auth.idTokenAudience,
						}),
					}
				: {}),
		};

		const server = await RouterServer.create(config);
		await server.start();
		this.logSuccess(`Router server listening on port ${server.port}`);

		let shuttingDown = false;
		const shutdown = async (): Promise<void> => {
			if (shuttingDown) return;
			shuttingDown = true;
			this.logger.info("Shutting down router server...");
			await server.stop();
			process.exit(0);
		};
		process.on("SIGINT", () => void shutdown());
		process.on("SIGTERM", () => void shutdown());
	}

	/**
	 * Wires up the durable Linear token store (when configured) and records this
	 * start's config/env refresh tokens as chain seeds.
	 *
	 * Shared by {@link start} and {@link linearStatus} so the diagnostic resolves
	 * tokens exactly the way the running router does. A second, drifting copy of
	 * this block is how a diagnostic starts lying about the thing it exists to
	 * report on.
	 *
	 * Opt-in: with no `linearTokenStore` in the config, `this.linearTokenStore`
	 * stays undefined and {@link resolveWorkspaceTokens} short-circuits to the
	 * config values — the pre-Key-Vault behavior, unchanged.
	 */
	private configureLinearTokenStore(
		config: z.infer<typeof RouterConfigFileSchema>,
	): void {
		if (config.linearTokenStore) {
			this.linearTokenStore = new KeyVaultTokenStore({
				vaultUrl: config.linearTokenStore.keyVaultUrl,
			});
		}
		for (const [workspaceId, ws] of Object.entries(config.workspaces)) {
			if (ws.linearRefreshToken) {
				this.linearTokenSeeds.set(workspaceId, ws.linearRefreshToken);
			}
		}
	}

	/**
	 * Chooses each workspace's tokens between the config/env values and the
	 * Key Vault envelope.
	 *
	 * The envelope wins only while its `seedRefreshToken` still equals the
	 * config value. When an operator re-authorizes they update the config/env
	 * seed, which no longer matches — and the stored chain, whose head is by
	 * then a dead token, must be abandoned. Without this comparison a re-auth
	 * would silently do nothing.
	 *
	 * Both tokens move together: the envelope is one unit, never merged
	 * field-by-field with the config.
	 */
	private async resolveWorkspaceTokens(
		workspaces: Record<
			string,
			{ linearToken: string; linearRefreshToken?: string }
		>,
	): Promise<
		Record<string, { linearToken: string; linearRefreshToken?: string }>
	> {
		const resolved: Record<
			string,
			{ linearToken: string; linearRefreshToken?: string }
		> = {};

		for (const [workspaceId, cfg] of Object.entries(workspaces)) {
			resolved[workspaceId] = { ...cfg };
			this.linearTokenSources.set(workspaceId, "config");

			if (!this.linearTokenStore || !cfg.linearRefreshToken) continue;

			let envelope: LinearTokenEnvelope | undefined;
			try {
				envelope = await this.linearTokenStore.get(workspaceId);
			} catch (error) {
				// Booting with a possibly-stale token beats not booting at all.
				this.logger.warn(
					`Could not read the stored Linear token for workspace ${workspaceId} from Key Vault; using the configured value: ${(error as Error).message}`,
				);
				continue;
			}

			if (!envelope) continue;
			// The chain is intact if the config value is either the seed we started
			// from OR the head this router last stored. The second case is the
			// bind-mounted config (docs/ROUTER.md): `persistRefreshedTokensToFile`
			// writes each rotated token back into the mounted file, so on the next
			// start the config value has already advanced past the seed. Comparing
			// against the seed alone would discard a perfectly good envelope — and
			// log "treating it as a fresh re-authorization" on every restart forever,
			// leaving the Key Vault path silently inert. A genuinely fresh seed from
			// Linear can never equal a token this router already rotated into, so a
			// real re-authorization is still detected.
			const chainIntact =
				envelope.seedRefreshToken === cfg.linearRefreshToken ||
				envelope.refreshToken === cfg.linearRefreshToken;
			if (!chainIntact) {
				this.logger.info(
					`Configured Linear refresh token for workspace ${workspaceId} matches neither the stored chain's seed nor its current token; treating it as a fresh re-authorization and discarding the stored token.`,
				);
				continue;
			}

			resolved[workspaceId] = {
				linearToken: envelope.accessToken,
				linearRefreshToken: envelope.refreshToken,
			};
			this.linearTokenSources.set(workspaceId, "keyvault");
			this.linearTokenUpdatedMs.set(workspaceId, envelope.updatedMs);
		}

		return resolved;
	}

	/**
	 * Linear OAuth app credentials, read from the environment (the CLI loads
	 * `<cyrusHome>/.env` at startup) rather than from `router-config.json`, so
	 * the client secret is never duplicated into a second file. Returning
	 * `undefined` disables token refresh; {@link RouterServer} warns about it.
	 */
	private resolveOAuthCredentials():
		| { clientId: string; clientSecret: string }
		| undefined {
		const clientId = process.env.LINEAR_CLIENT_ID;
		const clientSecret = process.env.LINEAR_CLIENT_SECRET;
		if (!clientId || !clientSecret) return undefined;
		return { clientId, clientSecret };
	}

	/**
	 * Persists a rotated pair to both sinks. Key Vault is authoritative across
	 * restarts; the config file remains a local cache so self-host deployments
	 * behave exactly as before.
	 *
	 * Neither failure is fatal: the in-memory Linear client already holds the new
	 * token, so the router keeps serving either way.
	 */
	private async persistRefreshedTokens(
		configPath: string,
		workspaceId: string,
		tokens: { accessToken: string; refreshToken: string },
	): Promise<void> {
		this.persistRefreshedTokensToFile(configPath, workspaceId, tokens);
		if (!this.linearTokenStore) return;
		try {
			await this.linearTokenStore.set(workspaceId, {
				refreshToken: tokens.refreshToken,
				accessToken: tokens.accessToken,
				seedRefreshToken:
					this.linearTokenSeeds.get(workspaceId) ?? tokens.refreshToken,
				updatedMs: Date.now(),
			});
		} catch (error) {
			this.logger.warn(
				`Failed to persist refreshed Linear token to Key Vault for workspace ${workspaceId}: ${(error as Error).message}`,
			);
		}
	}

	/**
	 * Writes a refreshed token pair back to `router-config.json`.
	 *
	 * Re-reads the file rather than mutating the parsed startup copy: an operator
	 * may have edited an unrelated field (ports, webhook secret) while the router
	 * was running, and a refresh must not revert it. The write is atomic
	 * (tmp + rename) so a crash mid-write cannot leave a truncated config that
	 * fails to parse on the next start — which would strand the router with no
	 * credentials at all.
	 */
	private persistRefreshedTokensToFile(
		configPath: string,
		workspaceId: string,
		tokens: { accessToken: string; refreshToken: string },
	): void {
		try {
			const current = JSON.parse(readFileSync(configPath, "utf-8")) as {
				workspaces?: Record<
					string,
					{ linearToken: string; linearRefreshToken?: string }
				>;
			};
			const workspace = current.workspaces?.[workspaceId];
			if (!workspace) {
				this.logger.warn(
					`Refreshed token for unknown workspace ${workspaceId}; not persisted`,
				);
				return;
			}
			workspace.linearToken = tokens.accessToken;
			workspace.linearRefreshToken = tokens.refreshToken;

			const tmpPath = `${configPath}.tmp`;
			writeFileSync(tmpPath, `${JSON.stringify(current, null, 2)}\n`, {
				mode: 0o600,
			});
			renameSync(tmpPath, configPath);
		} catch (error) {
			// Never fatal: the in-memory client already holds the new token, so the
			// router keeps working. Only a restart before the next refresh would
			// fall back to the stale pair on disk.
			this.logger.warn(
				`Failed to persist refreshed Linear token for workspace ${workspaceId}: ${(error as Error).message}`,
			);
		}
	}

	private async users(rest: string[]): Promise<void> {
		const [action, ...userRest] = rest;
		switch (action) {
			case "add":
				return this.usersAdd(userRest);
			case "list":
				return this.usersList();
			case "remove":
				return this.usersRemove(userRest[0]);
			case "set-executor":
				return this.usersSetExecutor(userRest[0], userRest[1]);
			default:
				this.exitWithError(
					"Usage: cyrus router users <add <email> [--name <name>]|list|remove <email>|set-executor <email> <device|docker|fly|codespaces|aca>>",
				);
		}
	}

	private usersAdd(args: string[]): void {
		let name: string | undefined;
		const positional: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (!arg) continue;
			if (arg === "--name" && args[i + 1]) {
				name = args[i + 1];
				i++;
			} else {
				positional.push(arg);
			}
		}
		const email = positional[0];
		if (!email) {
			this.exitWithError(
				"Usage: cyrus router users add <email> [--name <name>]",
			);
		}

		// `users add` is the first-run bootstrap: it is the one subcommand that
		// may legitimately create the database.
		const store = this.openStore();
		try {
			store.addUser({ email, name });
			const code = store.mintEnrollmentCode(email, Date.now());
			const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
			this.logSuccess(`Added ${email}.`);
			this.logger.raw(`Enrollment code: ${code}`);
			this.logger.raw(`Expires: ${expiresAt} (15 minutes)`);
		} finally {
			store.close();
		}
	}

	private usersList(): void {
		const store = this.openExistingStore();
		try {
			const users = store.listUsers();
			if (users.length === 0) {
				this.logger.info("No users registered.");
				return;
			}
			// Running/locked session counts per user, so `users list` answers "who
			// has work in flight" at a glance; `sessions list` has the per-session
			// detail. Keyed by lower-cased email since RouterStore emails are
			// case-insensitive (COLLATE NOCASE) and a session's owning email comes
			// from the same users table.
			const sessions = store.listSessions();
			const runningByEmail = new Map<string, number>();
			const lockedByEmail = new Map<string, number>();
			for (const session of sessions) {
				if (!session.email) continue;
				const key = session.email.toLowerCase();
				if (session.hasAffinity) {
					runningByEmail.set(key, (runningByEmail.get(key) ?? 0) + 1);
				}
				if (session.locked) {
					lockedByEmail.set(key, (lockedByEmail.get(key) ?? 0) + 1);
				}
			}
			this.logger.raw(
				`${"EMAIL".padEnd(30)} ${"NAME".padEnd(20)} ${"DEVICE".padEnd(6)} ${"RUNNING".padEnd(7)} LOCKED`,
			);
			for (const user of users) {
				const key = user.email.toLowerCase();
				this.logger.raw(
					`${user.email.padEnd(30)} ${(user.name ?? "").padEnd(20)} ${(user.deviceEnrolled ? "yes" : "no").padEnd(6)} ${String(runningByEmail.get(key) ?? 0).padEnd(7)} ${lockedByEmail.get(key) ?? 0}`,
				);
			}
		} finally {
			store.close();
		}
	}

	private usersRemove(email: string | undefined): void {
		if (!email) {
			this.exitWithError("Usage: cyrus router users remove <email>");
		}
		const store = this.openExistingStore();
		try {
			const removed = store.removeUser(email);
			if (removed) {
				this.logSuccess(`Removed ${email}.`);
				// Unlike `devices revoke` (scoped to the physical device only),
				// removing a user is total: RouterStore.removeUser cascades away
				// every device row they owned, physical AND per-issue container.
				// This command has no executor/Docker wiring of its own, so any
				// running containers are reaped the same deliberate way `cyrus
				// router containers destroy <issueKey>` already reaps one — by
				// ContainerLifecycle's orphan-GC sweep on its next tick, not
				// immediately.
				this.logger.raw(
					"Any running containers this user owned will be stopped and removed (container and volume) by the lifecycle sweep, not immediately.",
				);
			} else {
				this.exitWithError(`No registered user with email ${email}`);
			}
		} finally {
			store.close();
		}
	}

	/**
	 * Picks which executor a user's future sessions route to. `"device"`
	 * clears `executor_json` back to `null` (the physical-device default);
	 * anything else in {@link EXECUTOR_TYPES} stores `{"type":"<type>"}`,
	 * matched against by {@link ContainerTargetService} on the next routed
	 * event for that user.
	 */
	private usersSetExecutor(
		email: string | undefined,
		type: string | undefined,
	): void {
		if (!email || !type) {
			this.exitWithError(
				"Usage: cyrus router users set-executor <email> <device|docker|fly|codespaces|aca>",
			);
		}
		if (!isExecutorType(type)) {
			this.exitWithError(
				`Unknown executor type "${type}". Valid types: ${EXECUTOR_TYPES.join(", ")}`,
			);
		}
		const store = this.openExistingStore();
		try {
			const updated = store.setUserExecutor(
				email,
				type === "device" ? null : JSON.stringify({ type }),
			);
			if (!updated) {
				this.exitWithError(`No registered user with email ${email}`);
			}
			this.logSuccess(`Set executor for ${email} to ${type}.`);
			this.logger.raw(
				"Existing containers for this user will be replaced on their next routed event; idle ones are stopped by the lifecycle sweep.",
			);
		} finally {
			store.close();
		}
	}

	private async devices(rest: string[]): Promise<void> {
		const [action, ...deviceRest] = rest;
		switch (action) {
			case "list":
				return this.devicesList();
			case "revoke":
				return this.devicesRevoke(deviceRest[0]);
			default:
				this.exitWithError("Usage: cyrus router devices <list|revoke <email>>");
		}
	}

	private devicesList(): void {
		const store = this.openExistingStore();
		try {
			const devices = store.listDevices();
			if (devices.length === 0) {
				this.logger.info("No devices enrolled.");
				return;
			}
			this.logger.raw(this.formatDeviceHeader());
			for (const device of devices) {
				this.logger.raw(this.formatDeviceRow(device));
			}
		} finally {
			store.close();
		}
	}

	private formatDeviceHeader(): string {
		const w = DEVICES_TABLE_COLUMN_WIDTHS;
		return `${"USER".padEnd(w.email)} ${"KIND".padEnd(w.kind)} ${"ISSUE KEY".padEnd(w.issueKey)} ${"PROVIDER".padEnd(w.provider)} ${"LAST SEEN".padEnd(w.lastSeen)} DEVICE ID`;
	}

	private formatDeviceRow(device: DeviceInfo): string {
		const w = DEVICES_TABLE_COLUMN_WIDTHS;
		const email = device.email ?? "(unknown)";
		const issueKey = device.issueKey ?? "-";
		const provider = device.provider ?? "-";
		const lastSeen = device.lastSeenMs
			? new Date(device.lastSeenMs).toISOString()
			: "-";
		return `${email.padEnd(w.email)} ${device.kind.padEnd(w.kind)} ${issueKey.padEnd(w.issueKey)} ${provider.padEnd(w.provider)} ${lastSeen.padEnd(w.lastSeen)} ${device.deviceId}`;
	}

	private async sessions(rest: string[]): Promise<void> {
		const [action] = rest;
		switch (action) {
			case "list":
				return this.sessionsList();
			default:
				this.exitWithError("Usage: cyrus router sessions list");
		}
	}

	/**
	 * Lists every router-tracked session with both the Linear issue GUID (for
	 * locked sessions) and the session GUID, so an operator can find the
	 * `issueId` a stuck session holds and pass it to `cyrus router unlock`.
	 * Sorted locked-first so the rows most likely to need unlocking lead.
	 */
	private sessionsList(): void {
		const store = this.openExistingStore();
		try {
			const sessions = store.listSessions();
			if (sessions.length === 0) {
				this.logger.info("No active or locked sessions.");
				return;
			}
			sessions.sort((a, b) => {
				if (a.locked !== b.locked) return a.locked ? -1 : 1;
				return a.sessionId.localeCompare(b.sessionId);
			});
			this.logger.raw(this.formatSessionHeader());
			for (const session of sessions) {
				this.logger.raw(this.formatSessionRow(session));
			}
			this.logger.raw("");
			this.logger.raw("Release a lock with: cyrus router unlock <ISSUE ID>");
		} finally {
			store.close();
		}
	}

	private formatSessionHeader(): string {
		const w = SESSIONS_TABLE_COLUMN_WIDTHS;
		return `${"SESSION ID".padEnd(w.sessionId)} ${"ISSUE ID".padEnd(w.issueId)} ${"STATE".padEnd(w.state)} USER`;
	}

	/**
	 * `STATE` is one of `locked` (holds an issue lock, running), `running` (has
	 * device affinity, no lock), or `stranded` (an issue lock with no live
	 * session behind it — a leaked lock, the prime unlock candidate).
	 */
	private formatSessionRow(session: SessionInfo): string {
		const w = SESSIONS_TABLE_COLUMN_WIDTHS;
		const issueId = session.issueId ?? "-";
		const state = !session.hasAffinity
			? "stranded"
			: session.locked
				? "locked"
				: "running";
		const user = session.email ?? session.creatorEmail ?? "(unknown)";
		return `${session.sessionId.padEnd(w.sessionId)} ${issueId.padEnd(w.issueId)} ${state.padEnd(w.state)} ${user}`;
	}

	private devicesRevoke(email: string | undefined): void {
		if (!email) {
			this.exitWithError("Usage: cyrus router devices revoke <email>");
		}
		const store = this.openExistingStore();
		try {
			// Resolve the device id BEFORE revoking: revokeDevice() only deletes
			// the `devices` row, so the issue_locks/session_affinity rows tied to
			// that device_id must be released first while we can still find them.
			const user = store
				.listUsers()
				.find((u) => u.email.toLowerCase() === email.toLowerCase());
			if (!user) {
				this.exitWithError(`No registered user with email ${email}`);
			}

			const device = store.getDeviceForUser(user.userId);
			if (!device) {
				this.logger.info(`${email} has no enrolled device.`);
				return;
			}

			const released = store.releaseLocksAndAffinityForDevice(device.deviceId);
			const revoked = store.revokeDevice(email);
			if (revoked) {
				this.logSuccess(
					`Revoked device for ${email} (released ${released.length} issue lock(s)).`,
				);
			} else {
				this.exitWithError(`Failed to revoke device for ${email}`);
			}
		} finally {
			store.close();
		}
	}

	/**
	 * Releases a stuck issue lock. Accepts either the Linear issue GUID (the raw
	 * `issue_locks.issue_id`) or a human identifier like `PAR-169`.
	 *
	 * Locks are keyed by GUID, so a human identifier is resolved to its GUID via
	 * Linear (`resolveIssueGuid`) before the lookup. The direct GUID path runs
	 * first and needs no network, so passing a GUID still works with no Linear
	 * token configured — only the identifier path requires one.
	 */
	private async unlock(issue: string | undefined): Promise<void> {
		if (!issue) {
			this.exitWithError("Usage: cyrus router unlock <issueId|PAR-123>");
		}
		const store = this.openExistingStore();
		try {
			// 1. Direct: the value is already the locked issue's GUID.
			let lock = store.getIssueLock(issue);
			let resolvedGuid = issue;
			let resolvedIdentifier: string | undefined;

			// 2. Not directly locked, and it looks like a human identifier (e.g.
			//    "PAR-169") rather than a GUID — resolve it against Linear and
			//    retry the lookup with the resolved GUID.
			if (!lock && ISSUE_IDENTIFIER_RE.test(issue)) {
				const resolved = await this.resolveIssueGuid(issue);
				if (!resolved) {
					this.exitWithError(
						`Could not resolve Linear issue "${issue}" to an id. Check the identifier and that router-config.json has a Linear token for its workspace, or pass the issue GUID directly (find it with: cyrus router sessions list).`,
					);
				}
				resolvedGuid = resolved.id;
				resolvedIdentifier = resolved.identifier;
				lock = store.getIssueLock(resolvedGuid);
			}

			if (!lock) {
				const where = resolvedIdentifier
					? `${issue} (resolved to ${resolvedGuid})`
					: issue;
				this.logger.info(`No lock found for issue ${where}.`);
				return;
			}
			store.releaseIssueLockForSession(lock.sessionId);
			const released = resolvedIdentifier
				? `${resolvedIdentifier} → ${resolvedGuid}`
				: resolvedGuid;
			this.logSuccess(
				`Released lock on ${released} (session ${lock.sessionId}).`,
			);
		} finally {
			store.close();
		}
	}

	/**
	 * Linear access tokens for every workspace in `router-config.json`, used to
	 * resolve a human issue identifier to its GUID. An identifier belongs to one
	 * workspace, so {@link resolveIssueGuid} tries each token until one resolves.
	 * Read the same defensive way as {@link resolveRequiredSecretKeys}: a
	 * missing/unparseable config yields an empty list rather than throwing.
	 */
	private resolveLinearTokens(): string[] {
		const configPath = join(
			resolvePath(this.app.cyrusHome),
			"router-config.json",
		);
		if (!existsSync(configPath)) return [];
		try {
			const raw = JSON.parse(readFileSync(configPath, "utf-8"));
			const parsed = RouterConfigFileSchema.safeParse(raw);
			if (!parsed.success) return [];
			return Object.values(parsed.data.workspaces).map((w) => w.linearToken);
		} catch {
			return [];
		}
	}

	/**
	 * Resolves a human issue identifier (e.g. `PAR-169`) to its Linear issue
	 * GUID by trying each workspace token until one resolves it. `undefined`
	 * when no token can (wrong org, expired token, or none configured). Split
	 * into its own `protected` method so tests can override it without a live
	 * Linear call. Linear's `issue(id:)` accepts both the identifier and the
	 * GUID, so this is also a harmless no-op if handed a GUID.
	 */
	protected async resolveIssueGuid(
		identifier: string,
	): Promise<{ id: string; identifier: string } | undefined> {
		for (const token of this.resolveLinearTokens()) {
			try {
				const issue = await new LinearClient({ accessToken: token }).issue(
					identifier,
				);
				if (issue?.id) {
					return { id: issue.id, identifier: issue.identifier ?? identifier };
				}
			} catch {
				// Wrong workspace for this token, or an expired token — try the next.
			}
		}
		return undefined;
	}

	private async secrets(rest: string[]): Promise<void> {
		const [action, ...secretRest] = rest;
		switch (action) {
			case "set":
				return this.secretsSet(secretRest[0], secretRest[1], secretRest[2]);
			case "unset":
				return this.secretsUnset(secretRest[0], secretRest[1]);
			case "list":
				return this.secretsList(
					secretRest[0],
					secretRest.includes("--check-scopes"),
				);
			case "migrate":
				return this.secretsMigrate(secretRest);
			default:
				this.exitWithError(
					"Usage: cyrus router secrets <set <email> <ENV_VAR_NAME> <value>|unset <email> <ENV_VAR_NAME>|list <email> [--check-scopes]|migrate --from keyvault --to table [--dry-run]>",
				);
		}
	}

	/**
	 * Never logs `value` — the secret is provided on the command line and
	 * must not be echoed back into stdout/logs. Only the key name is
	 * confirmed.
	 */
	private async secretsSet(
		email: string | undefined,
		key: string | undefined,
		value: string | undefined,
	): Promise<void> {
		if (!email || !key || value === undefined) {
			this.exitWithError(
				"Usage: cyrus router secrets set <email> <ENV_VAR_NAME> <value>",
			);
		}
		if (isReservedEnvKey(key)) {
			this.exitWithError(
				`"${key}" is a reserved env var and cannot be set. Reserved: ${RESERVED_ENV_KEYS.join(", ")}`,
			);
		}
		if (!isStorableSecretKey(key)) {
			// Reserved was handled above, so this is specifically an invalid name.
			this.exitWithError(`"${key}" is not a valid environment variable name.`);
		}
		await this.openSecretStore().set(email, key, value);
		this.logSuccess(`Set ${key} for ${email}.`);
	}

	private async secretsUnset(
		email: string | undefined,
		key: string | undefined,
	): Promise<void> {
		if (!email || !key) {
			this.exitWithError(
				"Usage: cyrus router secrets unset <email> <ENV_VAR_NAME>",
			);
		}
		if (isReservedEnvKey(key)) {
			this.exitWithError(
				`"${key}" is a reserved env var. Reserved: ${RESERVED_ENV_KEYS.join(", ")}`,
			);
		}
		await this.openSecretStore().set(email, key, undefined);
		this.logSuccess(`Unset ${key} for ${email}.`);
	}

	/**
	 * Copies every per-user secret bundle from one backend to another.
	 *
	 * Source and target are named explicitly rather than inferred from the
	 * active config, because the documented cutover keeps `containers.tableStore`
	 * OUT of the config until after the migration has run and been verified —
	 * so at migration time the config describes only the source. Inferring
	 * would make the command unrunnable in exactly the state the runbook puts
	 * you in, and once `tableStore` IS set, precedence would hide the source.
	 *
	 * Both endpoints are read from `containers`, so the Table config must be
	 * present in the file; `--to table` selects it, it does not invent it.
	 */
	/**
	 * The tenant whose JWKS signs setup ID tokens. Reuses `entra.tenantId`
	 * because a router deployment has exactly one app registration and one
	 * tenant (a standing invariant); only the AUDIENCE differs between
	 * enrollment access tokens and setup ID tokens.
	 *
	 * Fails loudly rather than defaulting: a wrong tenant would mean every
	 * /setup request 500s at first use, which is a much worse failure than
	 * refusing to start.
	 */
	private requireEntraTenantForSetup(
		config: z.infer<typeof RouterConfigFileSchema>,
	): string {
		const tenantId = config.entra?.tenantId;
		if (!tenantId) {
			this.exitWithError(
				'setupUi.auth.mode "entra-token" requires entra.tenantId in router-config.json — it names the tenant whose JWKS signs the ID token. Set CYRUS_ROUTER_ENTRA_TENANT_ID, or use a different setup auth mode.',
			);
		}
		return tenantId as string;
	}

	private async secretsMigrate(args: string[]): Promise<void> {
		const flag = (name: string): string | undefined => {
			const index = args.indexOf(name);
			return index >= 0 ? args[index + 1] : undefined;
		};
		const from = flag("--from");
		const to = flag("--to");
		const dryRun = args.includes("--dry-run");
		if (from !== "keyvault" || to !== "table") {
			this.exitWithError(
				"Usage: cyrus router secrets migrate --from keyvault --to table [--to-endpoint <url> --to-key-id <versioned key id> [--to-table <name>]] [--dry-run]",
			);
			return;
		}

		const containers = this.readRouterConfig()?.containers;
		if (!containers?.keyVaultUrl) {
			this.exitWithError(
				"Migration source requires containers.keyVaultUrl in router-config.json.",
			);
			return;
		}

		// The target may be named on the command line so migration can run BEFORE
		// `containers.tableStore` is added to the config. That ordering is the
		// documented safe one — adding the block is what makes the router START
		// USING the Table, so it must come after the data is verified in place.
		// Requiring the block here would have made the documented sequence
		// impossible to follow (round-2 finding R2-04).
		const toEndpoint = flag("--to-endpoint") ?? containers.tableStore?.endpoint;
		const toKeyId = flag("--to-key-id") ?? containers.tableStore?.keyId;
		const toTable =
			flag("--to-table") ?? containers.tableStore?.tableName ?? undefined;
		if (!toEndpoint || !toKeyId) {
			this.exitWithError(
				"Migration target is not configured. Either pass --to-endpoint <https://<account>.table.core.windows.net> --to-key-id <versioned Key Vault key id>, or add containers.tableStore to router-config.json. Passing them explicitly is the documented order: migrate and verify first, then add the config block that makes the router read from the Table.",
			);
			return;
		}

		const source = new KeyVaultSecretStore({
			vaultUrl: containers.keyVaultUrl,
			logger: this.logger,
		});
		const target = new TableSecretStore({
			tableEndpoint: toEndpoint,
			...(toTable ? { tableName: toTable } : {}),
			keyId: toKeyId,
			logger: this.logger,
		});

		const emails = await source.listEmails();
		this.logger.info(
			`Found ${emails.length} user(s) with secrets in the Key Vault backend.`,
		);

		let migrated = 0;
		let skipped = 0;
		const failures: string[] = [];
		for (const email of emails) {
			const bundle = await source.get(email);
			const keys = Object.keys(bundle).sort();
			if (keys.length === 0) {
				skipped++;
				continue;
			}
			if (dryRun) {
				// Names only — never the values.
				this.logger.info(`[dry-run] ${email}: ${keys.join(", ")}`);
				migrated++;
				continue;
			}
			try {
				const existing = await target.getRecord(email);
				if (existing) {
					// Never clobber a record the target already holds: it may carry
					// writes made through the UI after an earlier migration pass.
					this.logger.warn(
						`${email}: target record already exists — skipping. Verify and remove it first if you intend to re-migrate.`,
					);
					skipped++;
					continue;
				}
				await target.putRecord(email, bundle);
				this.logger.info(`${email}: migrated ${keys.length} value(s).`);
				migrated++;
			} catch (error) {
				// Keep going: one unreadable user must not strand the rest, and the
				// summary has to name every failure rather than exiting on the first.
				failures.push(`${email}: ${(error as Error).message}`);
			}
		}

		this.logger.info(
			`Migration ${dryRun ? "(dry run) " : ""}complete: ${migrated} migrated, ${skipped} skipped, ${failures.length} failed.`,
		);
		if (failures.length > 0) {
			for (const failure of failures) this.logger.error(failure);
			this.exitWithError(
				`${failures.length} user(s) failed to migrate. The Key Vault source is untouched; re-run after resolving.`,
			);
			return;
		}
		if (!dryRun) {
			this.logSuccess(
				"Verify with `cyrus router secrets list <email>` against both backends before setting containers.tableStore at router start.",
			);
		}
	}

	private async secretsList(
		email: string | undefined,
		checkScopes = false,
	): Promise<void> {
		if (!email) {
			this.exitWithError(
				"Usage: cyrus router secrets list <email> [--check-scopes]",
			);
		}
		const store = this.openSecretStore();
		const bundle = await store.get(email);
		const keys = Object.keys(bundle).sort();
		if (keys.length === 0) {
			this.logger.info(`No secrets stored for ${email}.`);
		} else {
			this.logger.raw(`Stored secrets for ${email}:`);
			for (const key of keys) this.logger.raw(`  ${key} = ****`);
		}
		if (checkScopes) {
			await this.reportGitHubTokenScopes(bundle);
		}
		const requiredKeys = this.resolveRequiredSecretKeys();
		const { ok, missing } = await store.isFullyAuthenticated(
			email,
			requiredKeys,
		);
		if (ok) {
			this.logSuccess(`${email} is fully authenticated for containers.`);
		} else {
			this.logger.warn(
				`${email} is NOT fully authenticated: missing ${missing.join(", ")}. Set them with: cyrus router secrets set ${email} <KEY> <value>`,
			);
		}
	}

	/**
	 * `--check-scopes` diagnostics for a user's stored GitHub credential.
	 *
	 * Strictly informational: this makes one authenticated `GET
	 * https://api.github.com/` per GitHub secret to read its `X-OAuth-Scopes`
	 * header, then prints what the token has and what it lacks. It never fails
	 * the command and never changes the "fully authenticated" verdict — a token
	 * missing `read:org` (or one whose scopes cannot be introspected at all,
	 * like a fine-grained PAT) still works for clone/commit/push/query. Token
	 * values are never printed; only the env-var name is echoed.
	 */
	private async reportGitHubTokenScopes(
		bundle: Record<string, string>,
	): Promise<void> {
		const present = GITHUB_TOKEN_SECRET_KEYS.filter((key) => bundle[key]);
		if (present.length === 0) {
			this.logger.info(
				`No GitHub token stored (looked for ${GITHUB_TOKEN_SECRET_KEYS.join(", ")}); skipping scope check.`,
			);
			return;
		}
		for (const key of present) {
			const probe = await probeGitHubTokenScopes(bundle[key] as string);
			const report = buildGitHubTokenScopeReport(key, probe);
			for (const line of report.info) this.logger.raw(`  ${line}`);
			for (const warning of report.warnings) this.logger.warn(warning);
		}
	}

	private async containers(rest: string[]): Promise<void> {
		const [action, ...containerRest] = rest;
		switch (action) {
			case "list":
				return this.containersList();
			case "destroy":
				return this.containersDestroy(containerRest[0]);
			case "gc-snapshots":
				return this.containersGcSnapshots(containerRest.includes("--yes"));
			default:
				this.exitWithError(
					"Usage: cyrus router containers <list|destroy <issueKey>|gc-snapshots [--yes]>",
				);
		}
	}

	private containersList(): void {
		const store = this.openExistingStore();
		try {
			const devices = store.listContainerDevices();
			if (devices.length === 0) {
				this.logger.info("No container devices.");
				return;
			}
			this.logger.raw(this.formatContainerDeviceHeader());
			for (const device of devices) {
				this.logger.raw(this.formatContainerDeviceRow(store, device));
			}
		} finally {
			store.close();
		}
	}

	/**
	 * Name kept for the snapshot-GC path that first needed it; this is also the
	 * seam `containers destroy` uses to reach the real provider. Overridden in
	 * tests, so renaming it would silently send them at live Azure.
	 */
	protected createAcaSnapshotGcProvider(
		containers: RouterServerConfig["containers"],
	): AcaMaintenanceProvider | undefined {
		return containers
			? createAcaSandboxesProvider(containers, this.logger)
			: undefined;
	}

	private async containersGcSnapshots(yes: boolean): Promise<void> {
		const configPath = join(
			resolvePath(this.app.cyrusHome),
			"router-config.json",
		);
		if (!existsSync(configPath)) {
			this.exitWithError(`No router config found at ${configPath}`);
		}
		let parsed: z.infer<typeof RouterConfigFileSchema>;
		try {
			const result = RouterConfigFileSchema.safeParse(
				JSON.parse(readFileSync(configPath, "utf-8")),
			);
			if (!result.success) {
				this.exitWithError(
					`Invalid router config at ${configPath}: ${result.error.message}`,
				);
			}
			parsed = result.data;
		} catch (error) {
			this.exitWithError(
				`Failed to parse ${configPath}: ${(error as Error).message}`,
			);
		}

		const provider = this.createAcaSnapshotGcProvider(parsed.containers);
		if (!provider || typeof provider.gcOrphanSnapshots !== "function") {
			this.exitWithError(
				"Snapshot GC requires containers.aca in router-config.json.",
			);
		}

		const store = this.openExistingStore();
		let activeIssueKeys: string[];
		try {
			activeIssueKeys = store
				.listContainerDevices()
				.filter((device) => device.provider === "aca")
				.map((device) => device.issueKey);
		} finally {
			store.close();
		}
		const plan = await provider.planOrphanSnapshots(activeIssueKeys);
		if (plan.length === 0) {
			this.logger.info("No orphan ACA snapshots found.");
			return;
		}
		this.logger.raw("Orphan ACA snapshots planned for deletion:");
		for (const snapshot of plan) this.printSnapshotGcItem(snapshot);
		if (!yes) {
			this.logger.raw(
				"Dry run only. Re-run with --yes to delete these snapshots.",
			);
			return;
		}
		const deleted = await provider.gcOrphanSnapshots(activeIssueKeys, plan);
		this.logSuccess(`Deleted ${deleted.length} orphan ACA snapshot(s).`);
	}

	private printSnapshotGcItem(snapshot: SnapshotGcItem): void {
		this.logger.raw(
			`  ${snapshot.id} issue=${snapshot.issueKey} device=${snapshot.deviceId}${snapshot.createdAtUtc ? ` created=${snapshot.createdAtUtc}` : ""}`,
		);
	}

	/**
	 * Header row for `containers list`. Padded with the exact same
	 * {@link CONTAINERS_TABLE_COLUMN_WIDTHS} as {@link formatContainerDeviceRow}
	 * so column labels always line up with their data.
	 */
	private formatContainerDeviceHeader(): string {
		const w = CONTAINERS_TABLE_COLUMN_WIDTHS;
		return `${"ISSUE KEY".padEnd(w.issueKey)} ${"PROVIDER".padEnd(w.provider)} ${"USER".padEnd(w.email)} ${"LAST ROUTED".padEnd(w.lastRouted)} ${"LAST SEEN".padEnd(w.lastSeen)} ${"AGE".padEnd(w.age)} ${"UPTIME".padEnd(w.uptime)} ${"PARKED".padEnd(w.parked)} TEARDOWN`;
	}

	private formatContainerDeviceRow(
		store: RouterStore,
		device: ContainerDeviceInfo,
	): string {
		const w = CONTAINERS_TABLE_COLUMN_WIDTHS;
		const now = Date.now();
		const email = store.getUserEmail(device.userId) ?? "(unknown)";
		const lastRouted = device.lastRoutedMs
			? new Date(device.lastRoutedMs).toISOString()
			: "-";
		const lastSeen = device.lastSeenMs
			? new Date(device.lastSeenMs).toISOString()
			: "-";
		// `createdMs` / `runningSinceMs` / `parkedAtMs` have always been selected
		// into ContainerDeviceInfo but were never rendered, so the two questions
		// this table gets opened for — "how long has that been up?" and "is it
		// stuck waiting on someone?" — needed a sqlite3 shell to answer.
		//
		// Rendered as elapsed durations rather than ISO timestamps: three more
		// 25-character columns would push the row past any terminal, and the
		// answer is the elapsed time in every case anyway. AGE and UPTIME are
		// deliberately separate columns because they measure different things —
		// AGE is the device row (it survives every stop/resume), UPTIME is the
		// current continuous run, so `AGE 3d / UPTIME 4m` is a healthy sandbox
		// that has been idle-stopped and resumed many times.
		const age = formatElapsed(now - device.createdMs);
		const uptime = device.runningSinceMs
			? formatElapsed(now - device.runningSinceMs)
			: "-";
		const parked = device.parkedAtMs
			? formatElapsed(now - device.parkedAtMs)
			: "-";
		const teardown = this.formatTeardownState(
			store.getPendingTeardown(device.issueKey),
		);
		return `${device.issueKey.padEnd(w.issueKey)} ${device.provider.padEnd(w.provider)} ${email.padEnd(w.email)} ${lastRouted.padEnd(w.lastRouted)} ${lastSeen.padEnd(w.lastSeen)} ${age.padEnd(w.age)} ${uptime.padEnd(w.uptime)} ${parked.padEnd(w.parked)} ${teardown}`;
	}

	/**
	 * The TEARDOWN column. Distinguishes the three states an operator actually
	 * needs to tell apart while a container is being reclaimed:
	 *
	 *  - `-` — no terminal teardown registered; a normally-running container.
	 *  - `callback-pending(<action>, grace <Ns>)` — the worker was asked to clean
	 *    up and has NOT called back yet. The grace countdown is what will
	 *    eventually force destruction; if this sits here until it expires, the
	 *    worker never came back.
	 *  - `destroying(<action>, callbacks N)` — the worker DID report in (N
	 *    deliveries, retries included), so any remaining delay is the provider
	 *    destroy retrying, not a missing callback.
	 */
	protected formatTeardownState(
		pending: PendingTeardownInfo | undefined,
	): string {
		if (!pending) return "-";
		if (pending.callbackReceivedMs === undefined) {
			const graceSeconds = Math.max(
				0,
				Math.round((pending.deadlineMs - Date.now()) / 1000),
			);
			return `callback-pending(${pending.action}, grace ${graceSeconds}s)`;
		}
		return `destroying(${pending.action}, callbacks ${pending.callbackAttempts})`;
	}

	/**
	 * Deletes the container device row for an issue. This is only the router's
	 * bookkeeping row — the actual provider resource (e.g. a `docker rm`) is
	 * cleaned up by {@link ContainerLifecycle}'s orphan-GC sweep on the
	 * running router, the next time it runs, since this CLI process doesn't
	 * hold a reference to the executor that created it.
	 */
	/**
	 * Destroys the issue's container FOR REAL — provider resources first, then the
	 * device row.
	 *
	 * The ordering is load-bearing. This used to delete only the row and promise
	 * that "provider resources will be garbage-collected as orphans on the
	 * router's next sweep", which made it useless as the manual escape hatch it
	 * looks like: the sandbox survived, and because sandboxes are found by their
	 * `cyrus.issue` label rather than by device id, the next routed event adopted
	 * the orphan — still holding whatever credentials it was created with. That is
	 * the operator-facing half of the bug ADR 0002 fixes. Deleting the row only
	 * after the provider call succeeds keeps the row as the retry handle when the
	 * call fails, matching `AcaSandboxesProvider.destroy`'s own posture.
	 */
	private async containersDestroy(issueKey: string | undefined): Promise<void> {
		if (!issueKey) {
			this.exitWithError("Usage: cyrus router containers destroy <issueKey>");
		}
		const store = this.openExistingStore();
		try {
			const device = store.getContainerDeviceForIssue(issueKey);
			if (!device) {
				this.exitWithError(`No container device for issue ${issueKey}`);
			}
			if (device.provider === "aca") {
				const provider = this.createAcaSnapshotGcProvider(
					this.readRouterConfig()?.containers,
				);
				if (!provider || typeof provider.destroy !== "function") {
					this.exitWithError(
						`Cannot destroy ${issueKey}'s sandbox: containers.aca is missing from router-config.json. Add it, or delete the sandbox and its snapshots in Azure before removing the device row.`,
					);
				}
				await provider.destroy(issueKey);
				this.logSuccess(
					`Destroyed the ACA sandbox and its snapshots for ${issueKey}.`,
				);
			} else {
				// Docker/Fly are not reachable from this process; be explicit rather
				// than implying the row deletion cleaned them up.
				this.logger.warn(
					`Provider '${device.provider}' resources are not destroyed by this command. The router's lifecycle sweep will reap them as orphans once the device row is gone.`,
				);
			}
			store.deleteContainerDevice(device.deviceId);
			this.logSuccess(`Destroyed container device for ${issueKey}.`);
		} finally {
			store.close();
		}
	}

	private async linear(rest: string[]): Promise<void> {
		const [action] = rest;
		if (action !== "status") {
			return this.exitWithError("Usage: cyrus router linear status");
		}
		return this.linearStatus();
	}

	/**
	 * Reports each workspace's Linear auth health.
	 *
	 * Probes Linear with the resolved access token rather than reading mirrored
	 * state: this command runs out of process and cannot see the running
	 * router's in-memory rejection map. A `viewer` query is the cheapest
	 * definitive answer, and it still works when auth is dead — that is exactly
	 * the case it needs to report.
	 */
	private async linearStatus(): Promise<void> {
		const configPath = this.resolveConfigPath();
		if (!existsSync(configPath)) {
			return this.exitWithError(`No router config found at ${configPath}`);
		}

		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(configPath, "utf-8"));
		} catch (error) {
			return this.exitWithError(
				`Failed to parse ${configPath}: ${(error as Error).message}`,
			);
		}

		const parsed = RouterConfigFileSchema.safeParse(raw);
		if (!parsed.success) {
			return this.exitWithError(
				`Invalid router config at ${configPath}: ${parsed.error.message}`,
			);
		}

		this.configureLinearTokenStore(parsed.data);
		const resolved = await this.resolveWorkspaceTokens(parsed.data.workspaces);

		// The last column is named for what is actually probed. Calling it
		// "STATUS" invited reading a rejected 25-hour-old access token as "this
		// workspace's Linear auth is broken", which in a re-auth runbook pushes an
		// operator to re-authorize and burn a working refresh chain.
		console.log(
			`${"WORKSPACE".padEnd(38)} ${"SOURCE".padEnd(9)} ${"LAST REFRESH".padEnd(25)} ACCESS TOKEN`,
		);
		for (const [workspaceId, ws] of Object.entries(resolved)) {
			const source = this.linearTokenSources.get(workspaceId) ?? "config";
			const updatedMs = this.linearTokenUpdatedMs.get(workspaceId);
			const lastRefresh = updatedMs ? new Date(updatedMs).toISOString() : "—";
			const probe = await this.probeLinearToken(ws.linearToken);
			const status = this.formatAccessTokenStatus(
				probe,
				Boolean(ws.linearRefreshToken),
			);
			console.log(
				`${workspaceId.padEnd(38)} ${source.padEnd(9)} ${lastRefresh.padEnd(25)} ${status}`,
			);
		}
	}

	/**
	 * Renders a probe result for the `ACCESS TOKEN` column.
	 *
	 * Linear expires access tokens after 24 hours, so a rejected one is the
	 * *expected* steady state on a first deploy — the seeded value was minted
	 * whenever `self-auth-linear` last ran, and the router mints a fresh one from
	 * the refresh chain on its first 401. That is a healthy workspace, and it must
	 * not read as a dead credential. Only a rejection with no refresh token left
	 * to recover with is genuinely terminal.
	 *
	 * A probe that never reached Linear stays `unknown` either way: an unreachable
	 * network says nothing about the credential, and must never read as healthy.
	 */
	private formatAccessTokenStatus(
		probe: LinearTokenProbe,
		hasRefreshToken: boolean,
	): string {
		if (probe.outcome === "ok") return "ok";
		if (probe.outcome === "unknown") return `unknown (${probe.detail})`;
		return hasRefreshToken
			? `expired (refresh available, ${probe.detail})`
			: `rejected (${probe.detail})`;
	}

	private async probeLinearToken(token: string): Promise<LinearTokenProbe> {
		try {
			const response = await fetch("https://api.linear.app/graphql", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: token,
				},
				body: JSON.stringify({ query: "{ viewer { id } }" }),
			});
			if (!response.ok)
				return { outcome: "rejected", detail: `HTTP ${response.status}` };
			const body = (await response.json()) as { errors?: unknown[] };
			return body.errors?.length
				? { outcome: "rejected", detail: "auth error" }
				: { outcome: "ok", detail: "" };
		} catch (error) {
			return { outcome: "unknown", detail: (error as Error).message };
		}
	}
}
