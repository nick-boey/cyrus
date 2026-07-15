import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolvePath } from "cyrus-core";
import {
	type ContainerDeviceInfo,
	isStorableSecretKey,
	RouterServer,
	type RouterServerConfig,
	RouterStore,
	SecretStore,
	USER_SECRET_KEYS,
	type UserSecretBundle,
} from "cyrus-router";
import { z } from "zod";
import { BaseCommand } from "./ICommand.js";

/** Valid values for `cyrus router users set-executor <email> <type>`. */
const EXECUTOR_TYPES = ["device", "docker", "fly", "codespaces"] as const;
type ExecutorType = (typeof EXECUTOR_TYPES)[number];

function isExecutorType(value: string): value is ExecutorType {
	return (EXECUTOR_TYPES as readonly string[]).includes(value);
}

function isSecretKey(value: string): value is keyof UserSecretBundle {
	return (USER_SECRET_KEYS as readonly string[]).includes(value);
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
} as const;

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
			idleStopMs: z.number().optional(),
			staleDestroyMs: z.number().optional(),
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
		})
		.optional(),
});

/**
 * Router server administration:
 *
 *   cyrus router start                          # start the router server
 *   cyrus router users add <email> [--name x]   # register a user + mint an enrollment code
 *   cyrus router users list                     # list registered users
 *   cyrus router users remove <email>           # remove a user
 *   cyrus router users set-executor <email> <device|docker|fly|codespaces>
 *                                                # choose where a user's sessions run
 *   cyrus router devices revoke <email>         # revoke a user's enrolled device
 *   cyrus router secrets set <email> <key> <value>
 *                                                # store a per-user container secret
 *   cyrus router secrets unset <email> <key>    # remove a per-user container secret
 *   cyrus router containers list                # list running ephemeral container devices
 *   cyrus router containers destroy <issueKey>  # drop a container device's row
 *   cyrus router unlock <issueId>               # release a stuck issue lock
 *
 * Every subcommand except `start` opens a {@link RouterStore} directly on the
 * db file (rather than talking to a running server over HTTP). Task 6's WAL
 * pragma makes this safe to do concurrently with a running `router start`
 * process holding the same db open.
 */
export class RouterCommand extends BaseCommand {
	async execute(args: string[]): Promise<void> {
		const [subcommand, ...rest] = args;
		switch (subcommand) {
			case "start":
				return this.start();
			case "users":
				return this.users(rest);
			case "devices":
				return this.devices(rest);
			case "secrets":
				return this.secrets(rest);
			case "containers":
				return this.containers(rest);
			case "unlock":
				return this.unlock(rest[0]);
			default:
				this.exitWithError(
					"Usage: cyrus router <start|users add <email>|users list|users remove <email>|users set-executor <email> <device|docker|fly|codespaces>|devices revoke <email>|secrets set <email> <key> <value>|secrets unset <email> <key>|containers list|containers destroy <issueKey>|unlock <issueId>>",
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

		const configPath = join(
			resolvePath(this.app.cyrusHome),
			"router-config.json",
		);
		if (!existsSync(configPath)) {
			return defaultPath;
		}

		try {
			const raw = JSON.parse(readFileSync(configPath, "utf-8"));
			const parsed = RouterConfigFileSchema.safeParse(raw);
			return parsed.success && parsed.data.containers?.secretsPath
				? parsed.data.containers.secretsPath
				: defaultPath;
		} catch {
			// A missing/unparsable router-config.json shouldn't block `secrets
			// set/unset` — they work fine (against the default path) before an
			// operator has ever written a router config.
			return defaultPath;
		}
	}

	private openSecretStore(): SecretStore {
		return new SecretStore(this.resolveSecretsPath());
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

		const server = new RouterServer(config);
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
	 * Writes a refreshed token pair back to `router-config.json`.
	 *
	 * Re-reads the file rather than mutating the parsed startup copy: an operator
	 * may have edited an unrelated field (ports, webhook secret) while the router
	 * was running, and a refresh must not revert it. The write is atomic
	 * (tmp + rename) so a crash mid-write cannot leave a truncated config that
	 * fails to parse on the next start — which would strand the router with no
	 * credentials at all.
	 */
	private persistRefreshedTokens(
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
					"Usage: cyrus router users <add <email> [--name <name>]|list|remove <email>|set-executor <email> <device|docker|fly|codespaces>>",
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
		const store = this.openStore();
		try {
			const users = store.listUsers();
			if (users.length === 0) {
				this.logger.info("No users registered.");
				return;
			}
			this.logger.raw(
				"EMAIL                          NAME                 DEVICE ENROLLED",
			);
			for (const user of users) {
				this.logger.raw(
					`${user.email.padEnd(30)} ${(user.name ?? "").padEnd(20)} ${user.deviceEnrolled ? "yes" : "no"}`,
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
		const store = this.openStore();
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
				"Usage: cyrus router users set-executor <email> <device|docker|fly|codespaces>",
			);
		}
		if (!isExecutorType(type)) {
			this.exitWithError(
				`Unknown executor type "${type}". Valid types: ${EXECUTOR_TYPES.join(", ")}`,
			);
		}
		const store = this.openStore();
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
			case "revoke":
				return this.devicesRevoke(deviceRest[0]);
			default:
				this.exitWithError("Usage: cyrus router devices revoke <email>");
		}
	}

	private devicesRevoke(email: string | undefined): void {
		if (!email) {
			this.exitWithError("Usage: cyrus router devices revoke <email>");
		}
		const store = this.openStore();
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

	private unlock(issueId: string | undefined): void {
		if (!issueId) {
			this.exitWithError("Usage: cyrus router unlock <issueId>");
		}
		const store = this.openStore();
		try {
			const lock = store.getIssueLock(issueId);
			if (!lock) {
				this.logger.info(`No lock found for issue ${issueId}.`);
				return;
			}
			store.releaseIssueLockForSession(lock.sessionId);
			this.logSuccess(
				`Released lock on ${issueId} (session ${lock.sessionId}).`,
			);
		} finally {
			store.close();
		}
	}

	private async secrets(rest: string[]): Promise<void> {
		const [action, ...secretRest] = rest;
		switch (action) {
			case "set":
				return this.secretsSet(secretRest[0], secretRest[1], secretRest[2]);
			case "unset":
				return this.secretsUnset(secretRest[0], secretRest[1]);
			default:
				this.exitWithError(
					"Usage: cyrus router secrets <set <email> <key> <value>|unset <email> <key>>",
				);
		}
	}

	/**
	 * Never logs `value` — the secret is provided on the command line and
	 * must not be echoed back into stdout/logs. Only the key name is
	 * confirmed.
	 */
	private secretsSet(
		email: string | undefined,
		key: string | undefined,
		value: string | undefined,
	): void {
		if (!email || !key || value === undefined) {
			this.exitWithError(
				"Usage: cyrus router secrets set <email> <key> <value>",
			);
		}
		if (!isSecretKey(key)) {
			this.exitWithError(
				`Unknown secret key "${key}". Valid keys: ${USER_SECRET_KEYS.join(", ")}`,
			);
		}
		this.openSecretStore().set(email, key, value);
		this.logSuccess(`Set ${key} for ${email}.`);
	}

	private secretsUnset(
		email: string | undefined,
		key: string | undefined,
	): void {
		if (!email || !key) {
			this.exitWithError("Usage: cyrus router secrets unset <email> <key>");
		}
		if (!isSecretKey(key)) {
			this.exitWithError(
				`Unknown secret key "${key}". Valid keys: ${USER_SECRET_KEYS.join(", ")}`,
			);
		}
		this.openSecretStore().set(email, key, undefined);
		this.logSuccess(`Unset ${key} for ${email}.`);
	}

	private async containers(rest: string[]): Promise<void> {
		const [action, ...containerRest] = rest;
		switch (action) {
			case "list":
				return this.containersList();
			case "destroy":
				return this.containersDestroy(containerRest[0]);
			default:
				this.exitWithError(
					"Usage: cyrus router containers <list|destroy <issueKey>>",
				);
		}
	}

	private containersList(): void {
		const store = this.openStore();
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
	 * Header row for `containers list`. Padded with the exact same
	 * {@link CONTAINERS_TABLE_COLUMN_WIDTHS} as {@link formatContainerDeviceRow}
	 * so column labels always line up with their data.
	 */
	private formatContainerDeviceHeader(): string {
		const w = CONTAINERS_TABLE_COLUMN_WIDTHS;
		return `${"ISSUE KEY".padEnd(w.issueKey)} ${"PROVIDER".padEnd(w.provider)} ${"USER".padEnd(w.email)} ${"LAST ROUTED".padEnd(w.lastRouted)} LAST SEEN`;
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
		return `${device.issueKey.padEnd(w.issueKey)} ${device.provider.padEnd(w.provider)} ${email.padEnd(w.email)} ${lastRouted.padEnd(w.lastRouted)} ${lastSeen}`;
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
		const store = this.openStore();
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
