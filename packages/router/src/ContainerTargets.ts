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

/**
 * Thrown by {@link ContainerTargetService.ensureDevice} specifically when
 * `issueKey` fails {@link ISSUE_KEY_RE}. Kept distinct from other
 * `ensureDevice` failures (e.g. a store error) so {@link EventRouter} can
 * tell an enrolled container-executor user that THIS issue's identifier is
 * the problem, rather than falling back to the generic "you're not
 * enrolled" message, which would point them at the wrong fix.
 */
export class InvalidIssueKeyError extends Error {
	constructor(public readonly issueKey: string) {
		super(
			`refusing to create a container device for invalid issue key ${JSON.stringify(issueKey)}`,
		);
		this.name = "InvalidIssueKeyError";
	}
}

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
			throw new InvalidIssueKeyError(issueKey);
		}
		const provider = this.executorFor(user.userId);
		if (!provider) {
			throw new Error(`user ${user.userId} has no container executor`);
		}
		let existing = this.deps.store.getContainerDeviceForIssue(issueKey);
		if (existing && existing.provider !== provider) {
			// Capture before the `existing = undefined` below — `old?.destroy`'s
			// `.catch()` callback runs later (after this function has returned),
			// so it must not read these off a `let` that's about to be reassigned.
			const staleProvider = existing.provider;
			const staleDeviceId = existing.deviceId;
			const old = this.deps.executors.get(staleProvider);
			if (old) {
				void old.destroy(issueKey).catch((err: unknown) => {
					this.deps.logger.warn(
						`destroy of ${staleProvider} container for ${issueKey} failed: ${String(err)}`,
					);
				});
			} else {
				// The operator removed/renamed this provider (e.g. migrating
				// docker -> fly) while a container still exists under it.
				// Nothing will ever destroy() it or its volume now that we're
				// deleting the device row below — make that leak visible instead
				// of letting the old `old?.destroy(...)` optional chain swallow
				// it silently (Finding 5).
				this.deps.logger.warn(
					`no executor registered for provider '${staleProvider}'; its container (and volume) for issue ${issueKey} will not be destroyed and may leak`,
				);
			}
			this.deps.store.deleteContainerDevice(staleDeviceId);
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
	 * In-flight boot attempts keyed by DEVICE ID (not issue key — see below).
	 * Linear's `created` (delegation) and `prompted` (first user message)
	 * webhooks for the same issue routinely arrive seconds apart, both while
	 * the container is still cold-booting (a first `docker run` pulls the
	 * image and can take minutes). Without this, two concurrent `boot()`
	 * calls each drive their own `ensureRunning`, and both observe `status:
	 * "absent"` and both mint a fresh device token (via
	 * `mintDeviceToken`/`rotateContainerDeviceToken`) before either `docker
	 * run` lands — the second rotation invalidates the token the first,
	 * successfully started, container was launched with, so it can never
	 * authenticate and its queued events never drain. A `boot()` for a
	 * device already in this map joins the existing attempt instead of
	 * starting a second one. Cleared once the attempt settles (success or
	 * failure) so a later retry can boot again.
	 *
	 * Keyed by device id rather than issue key: `ensureDevice` destroys and
	 * replaces a device row (new device id, same issue key) when a user's
	 * executor provider changes. If this map were keyed by issue key, a
	 * `boot()` for the NEW device — routed while the OLD device's boot is
	 * still in-flight (a real window: cold boots take minutes) — would join
	 * the stale attempt for the destroyed device instead of starting a real
	 * boot for the new provider, and the new container would never actually
	 * start. Keying by device id keeps the same-device dedup (both webhooks
	 * still resolve to the same device id when no switch happened) while
	 * making an executor switch's new device id always start a fresh attempt.
	 */
	private readonly inFlightBoots = new Map<number, Promise<void>>();

	/**
	 * Fire-and-forget boot, serialized per issue via {@link inFlightBoots}. On
	 * `ensureRunning` rejection, posts a container-boot-failed activity (once
	 * per issue until a boot succeeds).
	 *
	 * Never leaves an unhandled rejection: `bootStart`/`bootInner` are written
	 * so nothing inside them should reject, but the `.catch()` here is
	 * belt-and-suspenders — a detached promise with no rejection handler
	 * crashes the whole router process (Node >= 15 defaults to
	 * `--unhandled-rejections=throw`), which would stop routing webhooks for
	 * every teammate, not just the one whose container failed to boot.
	 */
	boot(
		deviceId: number,
		notify: { workspaceId: string; sessionId: string },
	): void {
		void this.bootStart(deviceId, notify).catch((err: unknown) => {
			this.deps.logger.warn(
				`container boot for device ${deviceId} threw unexpectedly: ${String(err)}`,
			);
		});
	}

	/**
	 * Resolves the device's issue key and either joins an in-flight boot for
	 * that issue or starts a new one. Defensive: resolving the device is in
	 * its own try/catch (not just the one inside {@link bootInner}) so a
	 * store error (e.g. SQLITE_BUSY) degrades to a logged warning instead of
	 * rejecting — this call happens outside `bootInner`'s try, so nothing
	 * else covers it.
	 */
	private async bootStart(
		deviceId: number,
		notify: { workspaceId: string; sessionId: string },
	): Promise<void> {
		let device: ReturnType<RouterStore["getDeviceInfo"]>;
		try {
			device = this.deps.store.getDeviceInfo(deviceId);
		} catch (err) {
			this.deps.logger.warn(
				`failed to load device ${deviceId} info while booting: ${String(err)}`,
			);
			return;
		}
		if (
			!device ||
			device.kind !== "container" ||
			!device.issueKey ||
			!device.provider
		) {
			return;
		}
		const issueKey = device.issueKey;
		const provider = device.provider;
		const userId = device.userId;

		const inFlight = this.inFlightBoots.get(deviceId);
		if (inFlight) {
			// Already booting this exact device elsewhere — join it rather
			// than start a second ensureRunning/mintDeviceToken.
			return inFlight;
		}

		const attempt = this.bootInner(
			deviceId,
			userId,
			provider,
			issueKey,
			notify,
		);
		this.inFlightBoots.set(deviceId, attempt);
		try {
			await attempt;
		} finally {
			if (this.inFlightBoots.get(deviceId) === attempt) {
				this.inFlightBoots.delete(deviceId);
			}
		}
	}

	/**
	 * Actually boots one issue's container. Written so it never rejects:
	 * every failure — a missing executor, an `ensureRunning` rejection, or
	 * even a failure to post the resulting activity (e.g. a Linear 5xx) — is
	 * caught and logged rather than thrown, since this always runs detached
	 * from a caller that could otherwise catch it.
	 */
	private async bootInner(
		deviceId: number,
		userId: number,
		provider: string,
		issueKey: string,
		notify: { workspaceId: string; sessionId: string },
	): Promise<void> {
		const executor = this.deps.executors.get(provider);
		try {
			if (!executor) {
				throw new Error(`no executor configured for provider '${provider}'`);
			}
			const env = this.buildEnv(userId, issueKey);
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
				try {
					await this.deps.postActivity(
						notify.workspaceId,
						notify.sessionId,
						containerBootFailedMessage(
							issueKey,
							err instanceof Error ? err.message : String(err),
						),
					);
				} catch (postErr) {
					// A Linear 5xx/network error here must not escape as a
					// rejection (Finding 1) — the boot failure itself is
					// already logged above; losing the user-facing notice is
					// an acceptable degradation, an unhandled rejection
					// crashing the router is not.
					this.deps.logger.warn(
						`failed to post boot-failure activity for ${issueKey}: ${String(postErr)}`,
					);
				}
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
