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
	RouterServer,
	type RouterServerConfig,
	RouterStore,
} from "cyrus-router";
import { z } from "zod";
import { BaseCommand } from "./ICommand.js";

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
});

/**
 * Router server administration:
 *
 *   cyrus router start                          # start the router server
 *   cyrus router users add <email> [--name x]   # register a user + mint an enrollment code
 *   cyrus router users list                     # list registered users
 *   cyrus router users remove <email>           # remove a user
 *   cyrus router devices revoke <email>         # revoke a user's enrolled device
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
			case "unlock":
				return this.unlock(rest[0]);
			default:
				this.exitWithError(
					"Usage: cyrus router <start|users add <email>|users list|users remove <email>|devices revoke <email>|unlock <issueId>>",
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
			default:
				this.exitWithError(
					"Usage: cyrus router users <add <email> [--name <name>]|list|remove <email>>",
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
			} else {
				this.exitWithError(`No registered user with email ${email}`);
			}
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
}
