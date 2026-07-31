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
	DEFAULT_REQUIRED_SECRET_KEYS,
	type DeviceInfo,
	GITHUB_TOKEN_SECRET_KEYS,
	isReservedEnvKey,
	isStorableSecretKey,
	KeyVaultSecretStore,
	KeyVaultTokenStore,
	type PendingTeardownInfo,
	probeGitHubTokenScopes,
	RESERVED_ENV_KEYS,
	RouterServer,
	type RouterServerConfig,
	RouterStore,
	SecretStore,
	type SecretStoreBackend,
	type SessionInfo,
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

interface SnapshotGcProvider {
	planOrphanSnapshots(activeIssueKeys: string[]): Promise<SnapshotGcItem[]>;
	gcOrphanSnapshots(
		activeIssueKeys: string[],
		printedPlan?: SnapshotGcItem[],
	): Promise<SnapshotGcItem[]>;
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
				}),
			),
			artifactsDir: z.string().optional(),
			secretsPath: z.string().optional(),
			keyVaultUrl: z.string().optional(),
			idleStopMs: z.number().optional(),
			staleDestroyMs: z.number().optional(),
			teardownGraceMs: z.number().optional(),
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
});

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
			case "unlock":
				return this.unlock(rest[0]);
			default:
				this.exitWithError(
					"Usage: cyrus router <start|users add <email>|users list|users remove <email>|users set-executor <email> <device|docker|fly|codespaces|aca>|devices list|devices revoke <email>|sessions list|secrets set <email> <ENV_VAR_NAME> <value>|secrets unset <email> <ENV_VAR_NAME>|secrets list <email> [--check-scopes]|containers list|containers destroy <issueKey>|containers gc-snapshots [--yes]|unlock <issueId>>",
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

	private openSecretStore(): SecretStoreBackend {
		const keyVaultUrl = this.readRouterConfig()?.containers?.keyVaultUrl;
		if (keyVaultUrl)
			return new KeyVaultSecretStore({
				vaultUrl: keyVaultUrl,
				logger: this.logger,
			});
		return new SecretStore(this.resolveSecretsPath());
	}

	private readRouterConfig():
		| z.infer<typeof RouterConfigFileSchema>
		| undefined {
		const configPath = join(
			resolvePath(this.app.cyrusHome),
			"router-config.json",
		);
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
		const configPath = join(
			resolvePath(this.app.cyrusHome),
			"router-config.json",
		);
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

		if (parsed.data.linearTokenStore) {
			this.linearTokenStore = new KeyVaultTokenStore({
				vaultUrl: parsed.data.linearTokenStore.keyVaultUrl,
			});
		}
		for (const [workspaceId, ws] of Object.entries(parsed.data.workspaces)) {
			if (ws.linearRefreshToken) {
				this.linearTokenSeeds.set(workspaceId, ws.linearRefreshToken);
			}
		}

		const config: RouterServerConfig = {
			...parsed.data,
			dbPath,
			oauth: this.resolveOAuthCredentials(),
			onTokenRefresh: (workspaceId, tokens) =>
				this.persistRefreshedTokens(configPath, workspaceId, tokens),
			logger: {
				info: (msg: string) => this.logger.info(msg),
				warn: (msg: string) => this.logger.warn(msg),
			},
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
			default:
				this.exitWithError(
					"Usage: cyrus router secrets <set <email> <ENV_VAR_NAME> <value>|unset <email> <ENV_VAR_NAME>|list <email> [--check-scopes]>",
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

	protected createAcaSnapshotGcProvider(
		containers: RouterServerConfig["containers"],
	): SnapshotGcProvider | undefined {
		return containers
			? createAcaSandboxesProvider(containers, {
					info: (msg) => this.logger.info(msg),
					warn: (msg) => this.logger.warn(msg),
				})
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
		return `${"ISSUE KEY".padEnd(w.issueKey)} ${"PROVIDER".padEnd(w.provider)} ${"USER".padEnd(w.email)} ${"LAST ROUTED".padEnd(w.lastRouted)} ${"LAST SEEN".padEnd(w.lastSeen)} TEARDOWN`;
	}

	private formatContainerDeviceRow(
		store: RouterStore,
		device: ContainerDeviceInfo,
	): string {
		const w = CONTAINERS_TABLE_COLUMN_WIDTHS;
		const email = store.getUserEmail(device.userId) ?? "(unknown)";
		const lastRouted = device.lastRoutedMs
			? new Date(device.lastRoutedMs).toISOString()
			: "-";
		const lastSeen = device.lastSeenMs
			? new Date(device.lastSeenMs).toISOString()
			: "-";
		const teardown = this.formatTeardownState(
			store.getPendingTeardown(device.issueKey),
		);
		return `${device.issueKey.padEnd(w.issueKey)} ${device.provider.padEnd(w.provider)} ${email.padEnd(w.email)} ${lastRouted.padEnd(w.lastRouted)} ${lastSeen.padEnd(w.lastSeen)} ${teardown}`;
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
	private containersDestroy(issueKey: string | undefined): void {
		if (!issueKey) {
			this.exitWithError("Usage: cyrus router containers destroy <issueKey>");
		}
		const store = this.openExistingStore();
		try {
			const device = store.getContainerDeviceForIssue(issueKey);
			if (!device) {
				this.exitWithError(`No container device for issue ${issueKey}`);
			}
			store.deleteContainerDevice(device.deviceId);
			this.logSuccess(`Destroyed container device for ${issueKey}.`);
			this.logger.raw(
				"Provider resources will be garbage-collected as orphans on the router's next sweep.",
			);
		} finally {
			store.close();
		}
	}
}
