import type { ExecutorRegistry } from "cyrus-router-executors";
import { containerBootFailedMessage } from "./messages.js";
import type { RouterStore } from "./RouterStore.js";
import type { SecretStore } from "./SecretStore.js";

/**
 * A device/webhook-supplied issue key flows into filesystem paths, Docker
 * object names, and artifact URLs (see `RouterStore.createContainerDevice`
 * and `registerArtifactsRoute`'s `ISSUE_KEY_RE`). `RouterStore` itself does
 * NOT validate the key, so this service is the one gate standing between an
 * arbitrary Linear webhook and a malformed key reaching the store or a
 * container provider.
 */
const ISSUE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface ContainerRoutingDeps {
	store: RouterStore;
	secrets: SecretStore;
	executors: ExecutorRegistry; // Map<providerName, ContainerExecutor>
	containersConfig: {
		routerUrlForContainers: string;
		repositories: Array<{
			name: string;
			githubSlug: string; // "owner/repo"
			linearWorkspaceId: string;
			baseBranch?: string;
		}>;
	};
	postActivity: (
		workspaceId: string,
		agentSessionId: string,
		body: string,
	) => Promise<void>;
	logger: { info(msg: string): void; warn(msg: string): void };
}

/**
 * Resolves and boots the per-issue ephemeral container device for
 * container-executor users, and holds the (issueKey -> executor) mapping
 * used by {@link EventRouter} to know when a target is a container rather
 * than a physical device.
 */
export class ContainerTargetService {
	/** Issues we've already posted a boot-failure notice for (once until a boot succeeds). */
	private readonly bootFailedNotified = new Set<string>();

	constructor(private readonly deps: ContainerRoutingDeps) {}

	/** Provider name from users.executor_json, or undefined for physical-device users. */
	executorFor(userId: number): string | undefined {
		const json = this.deps.store.getUserExecutor(userId);
		if (!json) return undefined;
		try {
			const parsed = JSON.parse(json) as { type?: string };
			return parsed.type && parsed.type !== "device" ? parsed.type : undefined;
		} catch {
			this.deps.logger.warn(
				`Corrupt executor_json for user ${userId}; using physical device`,
			);
			return undefined;
		}
	}

	/**
	 * Get-or-create the issue's container device row. Destroys + replaces the
	 * row when the stored provider no longer matches the user's executor.
	 *
	 * Throws (rather than silently proceeding) when `issueKey` fails
	 * {@link ISSUE_KEY_RE} or the user has no container executor configured —
	 * callers (EventRouter) must treat either as "cannot route", not create a
	 * broken device.
	 */
	ensureDevice(
		user: { userId: number; email: string },
		issueKey: string,
	): { deviceId: number } {
		if (!ISSUE_KEY_RE.test(issueKey)) {
			throw new Error(
				`refusing to create a container device for invalid issue key ${JSON.stringify(issueKey)}`,
			);
		}
		const provider = this.executorFor(user.userId);
		if (!provider) {
			throw new Error(`user ${user.userId} has no container executor`);
		}
		let existing = this.deps.store.getContainerDeviceForIssue(issueKey);
		if (existing && existing.provider !== provider) {
			const old = this.deps.executors.get(existing.provider);
			void old?.destroy(issueKey).catch((err: unknown) => {
				this.deps.logger.warn(
					`destroy of ${existing?.provider} container for ${issueKey} failed: ${String(err)}`,
				);
			});
			this.deps.store.deleteContainerDevice(existing.deviceId);
			existing = undefined;
		}
		if (existing) return { deviceId: existing.deviceId };
		const created = this.deps.store.createContainerDevice(
			user.userId,
			issueKey,
			provider,
		);
		return { deviceId: created.deviceId };
	}

	isContainerDevice(deviceId: number): boolean {
		return this.deps.store.getDeviceInfo(deviceId)?.kind === "container";
	}

	/**
	 * Fire-and-forget boot. On `ensureRunning` rejection, posts a
	 * container-boot-failed activity (once per issue until a boot succeeds).
	 */
	boot(
		deviceId: number,
		notify: { workspaceId: string; sessionId: string },
	): void {
		void this.bootInner(deviceId, notify);
	}

	private async bootInner(
		deviceId: number,
		notify: { workspaceId: string; sessionId: string },
	): Promise<void> {
		const device = this.deps.store.getDeviceInfo(deviceId);
		if (
			!device ||
			device.kind !== "container" ||
			!device.issueKey ||
			!device.provider
		) {
			return;
		}
		const executor = this.deps.executors.get(device.provider);
		const issueKey = device.issueKey;
		try {
			if (!executor) {
				throw new Error(
					`no executor configured for provider '${device.provider}'`,
				);
			}
			const env = this.buildEnv(device.userId, issueKey);
			await executor.ensureRunning({
				issueKey,
				env,
				mintDeviceToken: () =>
					this.deps.store.rotateContainerDeviceToken(deviceId),
			});
			this.bootFailedNotified.delete(issueKey);
		} catch (err) {
			this.deps.logger.warn(
				`container boot failed for ${issueKey}: ${String(err)}`,
			);
			if (!this.bootFailedNotified.has(issueKey)) {
				this.bootFailedNotified.add(issueKey);
				await this.deps.postActivity(
					notify.workspaceId,
					notify.sessionId,
					containerBootFailedMessage(
						issueKey,
						err instanceof Error ? err.message : String(err),
					),
				);
			}
		}
	}

	private buildEnv(userId: number, issueKey: string): Record<string, string> {
		const email = this.emailFor(userId);
		const secrets = this.deps.secrets.get(email);
		if (!secrets.claudeOauthToken) {
			throw new Error(
				`no Claude OAuth token stored for ${email} (cyrus router secrets set ${email} claudeOauthToken <token>)`,
			);
		}
		const env: Record<string, string> = {
			CYRUS_ROUTER_URL: this.deps.containersConfig.routerUrlForContainers,
			CYRUS_ISSUE_KEY: issueKey,
			CYRUS_REPOS_JSON: JSON.stringify(this.deps.containersConfig.repositories),
			CLAUDE_CODE_OAUTH_TOKEN: secrets.claudeOauthToken,
		};
		if (secrets.githubPat) env.GIT_TOKEN = secrets.githubPat;
		if (secrets.gitUserName) env.GIT_USER_NAME = secrets.gitUserName;
		if (secrets.gitUserEmail) env.GIT_USER_EMAIL = secrets.gitUserEmail;
		if (secrets.dotfilesRepo) env.DOTFILES_REPO = secrets.dotfilesRepo;
		return env;
	}

	private emailFor(userId: number): string {
		const email = this.deps.store.getUserEmail(userId);
		if (!email) throw new Error(`unknown user ${userId}`);
		return email;
	}
}
