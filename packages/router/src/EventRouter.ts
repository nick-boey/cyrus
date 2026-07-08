import {
	type AgentEvent,
	type AgentSessionCreatedWebhook,
	isAgentSessionCreatedWebhook,
	isAgentSessionPromptedWebhook,
	type Webhook,
} from "cyrus-core";
import type { SessionStateFrame } from "cyrus-router-protocol";
import type { DeviceGateway } from "./DeviceGateway.js";
import {
	expiredMessage,
	fillTemplate,
	ISSUE_LOCKED_MESSAGE,
	offlineReleaseMessage,
	offlineWaitingMessage,
	PROMPT_REJECTION_MESSAGE,
	UNENROLLED_CREATOR_MESSAGE,
} from "./messages.js";
import type { RouterStore } from "./RouterStore.js";

/**
 * `agentSessionCreated` and `agentSessionPrompted` webhooks are the same
 * underlying `AgentSessionEventWebhookPayload`; the type guards only differ by
 * `action`. We route both through helpers typed with this alias.
 */
type SessionEvent = AgentSessionCreatedWebhook;

/** Shape we persist as `creator_json` in session affinity (a serialized creator). */
interface StoredCreator {
	id?: string;
	email?: string;
	name?: string;
}

/** Resolved routing target for a created event. */
interface ResolvedTarget {
	deviceId: number;
	/** Email used in offline/expiry notices. */
	email: string;
}

export interface EventRouterOptions {
	store: RouterStore;
	gateway: Pick<DeviceGateway, "isOnline" | "deliverPending">;
	postActivity: (
		workspaceId: string,
		agentSessionId: string,
		body: string,
	) => Promise<void>;
	config: {
		eventTtlMs: number;
		issueLock: boolean;
		creatorOnlyPrompting: boolean;
	};
	logger: { info(msg: string): void; warn(msg: string): void };
	/** Injectable clock (default `Date.now`) so TTL behavior is deterministic in tests. */
	now?: () => number;
}

const DEFAULT_EMAIL = "the delegating user";

/**
 * Routes Linear agent-session webhooks to the creator's enrolled device.
 *
 * Enforces session/issue affinity, per-issue locking, creator-only prompting,
 * and offline queueing with one-time notices. A periodic {@link sweepExpired}
 * fails out events that outlived their TTL and reclaims locks stranded by
 * devices that went dark.
 */
export class EventRouter {
	private readonly store: RouterStore;
	private readonly gateway: Pick<DeviceGateway, "isOnline" | "deliverPending">;
	private readonly postActivity: (
		workspaceId: string,
		agentSessionId: string,
		body: string,
	) => Promise<void>;
	private readonly config: {
		eventTtlMs: number;
		issueLock: boolean;
		creatorOnlyPrompting: boolean;
	};
	private readonly logger: { info(msg: string): void; warn(msg: string): void };
	private readonly now: () => number;

	/** Sessions we've already posted an offline notice for (once-per-session). */
	private readonly notifiedSessions = new Set<string>();
	/**
	 * In-memory session -> workspace map so {@link sweepExpired}'s stale-lock
	 * pass can address the offline-release activity. The DB does not persist a
	 * workspace on locks; a router restart simply loses this hint (the lock is
	 * still released, only the courtesy post may be skipped).
	 */
	private readonly sessionWorkspace = new Map<string, string>();

	constructor(opts: EventRouterOptions) {
		this.store = opts.store;
		this.gateway = opts.gateway;
		this.postActivity = opts.postActivity;
		this.config = opts.config;
		this.logger = opts.logger;
		this.now = opts.now ?? Date.now;
	}

	async route(event: AgentEvent): Promise<void> {
		const webhook = event as unknown as Webhook;
		if (isAgentSessionPromptedWebhook(webhook)) {
			await this.routePrompted(webhook);
			return;
		}
		if (isAgentSessionCreatedWebhook(webhook)) {
			await this.routeCreated(webhook);
			return;
		}
		this.logger.info(
			`EventRouter ignoring non-agent-session webhook ${webhook.type}/${webhook.action}`,
		);
	}

	/**
	 * Releases the issue lock and session affinity for a session that has
	 * reached a terminal state. Every `session_state` value (complete / error /
	 * stopped) is terminal, so this always releases.
	 */
	handleSessionState(deviceId: number, frame: SessionStateFrame): void {
		this.store.releaseIssueLockForSession(frame.sessionId);
		this.store.clearSessionAffinity(frame.sessionId);
		this.notifiedSessions.delete(frame.sessionId);
		this.sessionWorkspace.delete(frame.sessionId);
		this.logger.info(
			`Session ${frame.sessionId} reached terminal state '${frame.state}' on device ${deviceId}; released lock and affinity`,
		);
	}

	async sweepExpired(): Promise<void> {
		const now = this.now();

		// 1. Fail out events that outlived their TTL before delivery.
		for (const row of this.store.expireEvents(now)) {
			const session = this.asSessionEvent(row.payloadJson);
			if (!session) {
				this.logger.warn(
					`Dropping unparseable/unknown expired event on device ${row.deviceId}`,
				);
				continue;
			}
			const sessionId = session.agentSession.id;
			const workspaceId = session.organizationId;
			const email = session.agentSession.creator?.email ?? DEFAULT_EMAIL;
			await this.postActivity(workspaceId, sessionId, expiredMessage(email));
			this.logger.info(
				`Event for session ${sessionId} expired before delivery`,
			);

			// An undelivered created event never started work — free its issue so
			// it isn't held by a session that will never run.
			if (isAgentSessionCreatedWebhook(session)) {
				this.store.releaseIssueLockForSession(sessionId);
				this.store.clearSessionAffinity(sessionId);
			}
			this.notifiedSessions.delete(sessionId);
			this.sessionWorkspace.delete(sessionId);
		}

		// 2. Reclaim locks stranded by devices that went dark past the TTL, even
		//    for sessions whose event WAS delivered (Codex finding 10).
		const cutoff = now - this.config.eventTtlMs;
		for (const device of this.store.devicesOfflineSince(cutoff)) {
			const released = this.store.releaseLocksAndAffinityForDevice(
				device.deviceId,
			);
			for (const { sessionId } of released) {
				const workspaceId = this.sessionWorkspace.get(sessionId) ?? "";
				this.notifiedSessions.delete(sessionId);
				this.sessionWorkspace.delete(sessionId);
				await this.postActivity(
					workspaceId,
					sessionId,
					offlineReleaseMessage(device.email),
				);
				this.logger.info(
					`Released stale lock for session ${sessionId}; device ${device.deviceId} offline past TTL`,
				);
			}
		}
	}

	private async routeCreated(webhook: SessionEvent): Promise<void> {
		const sessionId = webhook.agentSession.id;
		const workspaceId = webhook.organizationId;
		const issueId =
			webhook.agentSession.issueId ??
			webhook.agentSession.issue?.id ??
			undefined;
		const creator = webhook.agentSession.creator ?? undefined;

		const target = this.resolveCreatedTarget(
			webhook,
			sessionId,
			issueId,
			creator,
		);
		if (!target) {
			const userName = creator?.name ?? creator?.email ?? "there";
			await this.postActivity(
				workspaceId,
				sessionId,
				fillTemplate(UNENROLLED_CREATOR_MESSAGE, { userName }),
			);
			this.logger.info(
				`No enrolled Cyrus device for creator of session ${sessionId}`,
			);
			return;
		}

		// Issue lock (created events only). A different session already holding
		// the issue rejects this one.
		if (this.config.issueLock && issueId !== undefined) {
			if (!this.store.acquireIssueLock(issueId, sessionId, target.deviceId)) {
				await this.postActivity(workspaceId, sessionId, ISSUE_LOCKED_MESSAGE);
				this.logger.info(
					`Issue ${issueId} already locked by another session; rejected session ${sessionId}`,
				);
				return;
			}
		}

		this.store.setSessionAffinity(
			sessionId,
			target.deviceId,
			creator ? JSON.stringify(creator) : undefined,
		);
		if (issueId !== undefined) {
			this.store.setIssueAffinity(issueId, target.deviceId);
		}
		this.sessionWorkspace.set(sessionId, workspaceId);

		await this.deliverOrNotify(webhook, target, sessionId, workspaceId);
	}

	private async routePrompted(webhook: SessionEvent): Promise<void> {
		const sessionId = webhook.agentSession.id;
		const workspaceId = webhook.organizationId;

		const deviceId = this.store.getSessionAffinity(sessionId);
		if (deviceId === undefined) {
			this.logger.warn(
				`Prompted event for unknown session ${sessionId}; no affinity, dropping`,
			);
			return;
		}

		if (this.config.creatorOnlyPrompting) {
			const creatorId = this.storedCreatorId(sessionId);
			if (creatorId !== undefined) {
				// Actor of the prompt: ONLY the activity's own `userId` identifies
				// who is actually prompting right now. Do NOT fall back to
				// `agentSession.creator?.id` — that field is always the session's
				// original creator, regardless of who sent this prompt, so using it
				// as a fallback would let a non-creator's prompt masquerade as the
				// creator's whenever the activity omits `userId` (a fail-open bug).
				// Fail closed instead: an actor we can't positively identify is
				// rejected exactly like one we can identify as a mismatch.
				const actorId = webhook.agentActivity?.userId ?? undefined;
				if (actorId === undefined || actorId !== creatorId) {
					await this.postActivity(
						workspaceId,
						sessionId,
						PROMPT_REJECTION_MESSAGE,
					);
					this.logger.info(
						`Rejected non-creator prompt on session ${sessionId} (actor ${actorId ?? "unknown"} != creator ${creatorId})`,
					);
					return;
				}
			}
			// else: creatorId is unknown (e.g. a session routed via issue/parent
			// affinity with no stored creator). There is nothing to compare the
			// actor against, so the gate is intentionally skipped and the prompt
			// is allowed through — a deliberate can't-compare-so-allow case, not
			// an oversight.
		}

		const email = webhook.agentSession.creator?.email ?? DEFAULT_EMAIL;
		this.sessionWorkspace.set(sessionId, workspaceId);
		await this.deliverOrNotify(
			webhook,
			{ deviceId, email },
			sessionId,
			workspaceId,
		);
	}

	/**
	 * Resolves the device a created event routes to, in priority order:
	 * existing session affinity (re-delivery) -> creator's enrolled device ->
	 * issue affinity (app-created sub-issues) -> parent-issue affinity.
	 */
	private resolveCreatedTarget(
		webhook: SessionEvent,
		sessionId: string,
		issueId: string | undefined,
		creator: SessionEvent["agentSession"]["creator"] | undefined,
	): ResolvedTarget | undefined {
		const fallbackEmail = creator?.email ?? DEFAULT_EMAIL;

		const affinityDevice = this.store.getSessionAffinity(sessionId);
		if (affinityDevice !== undefined) {
			return { deviceId: affinityDevice, email: fallbackEmail };
		}

		if (creator) {
			const user = this.store.findUserForCreator({
				id: creator.id,
				email: creator.email,
			});
			if (user) {
				const device = this.store.getDeviceForUser(user.userId);
				if (device) {
					return { deviceId: device.deviceId, email: user.email };
				}
			}
		}

		if (issueId !== undefined) {
			const issueDevice = this.store.getIssueAffinity(issueId);
			if (issueDevice !== undefined) {
				return { deviceId: issueDevice, email: fallbackEmail };
			}
		}

		const parentIssueId = extractParentIssueId(webhook);
		if (parentIssueId === undefined) {
			// Nothing else resolved the target above, so this fallback was our
			// last resort before falling through to UNENROLLED. Make the gap
			// visible: the typed webhook carries no parent-issue id today, so
			// this branch never actually fires (see extractParentIssueId).
			this.logger.info(
				"Parent-issue affinity fallback: webhook carries no parent issue id (app-attributed sub-issue affinity not implemented)",
			);
		}
		if (parentIssueId !== undefined) {
			const parentDevice = this.store.getIssueAffinity(parentIssueId);
			if (parentDevice !== undefined) {
				return { deviceId: parentDevice, email: fallbackEmail };
			}
		}

		return undefined;
	}

	private async deliverOrNotify(
		event: SessionEvent,
		target: ResolvedTarget,
		sessionId: string,
		workspaceId: string,
	): Promise<void> {
		this.store.enqueueEvent(
			target.deviceId,
			JSON.stringify(event),
			this.now(),
			this.config.eventTtlMs,
		);

		if (this.gateway.isOnline(target.deviceId)) {
			this.gateway.deliverPending(target.deviceId);
			return;
		}

		if (!this.notifiedSessions.has(sessionId)) {
			this.notifiedSessions.add(sessionId);
			await this.postActivity(
				workspaceId,
				sessionId,
				offlineWaitingMessage(target.email),
			);
			this.logger.info(
				`Device ${target.deviceId} offline; queued session ${sessionId} and posted waiting notice`,
			);
		}
	}

	private storedCreatorId(sessionId: string): string | undefined {
		const json = this.store.getSessionCreator(sessionId);
		if (!json) return undefined;
		try {
			return (JSON.parse(json) as StoredCreator).id;
		} catch {
			this.logger.warn(
				`Corrupt stored creator for session ${sessionId}; skipping creator check`,
			);
			return undefined;
		}
	}

	/** Parses a queued payload and returns it only if it is an agent-session event. */
	private asSessionEvent(payloadJson: string): SessionEvent | undefined {
		let parsed: Webhook;
		try {
			parsed = JSON.parse(payloadJson) as Webhook;
		} catch {
			return undefined;
		}
		if (
			isAgentSessionCreatedWebhook(parsed) ||
			isAgentSessionPromptedWebhook(parsed)
		) {
			return parsed;
		}
		return undefined;
	}
}

/**
 * Best-effort parent-issue id probe. The typed webhook issue payload
 * (`IssueWithDescriptionChildWebhookPayload`) does not expose a parent, so we
 * defensively read a `parentId` / `parent.id` if the runtime payload carries
 * one; otherwise this fallback is simply skipped.
 */
function extractParentIssueId(webhook: SessionEvent): string | undefined {
	const issue = webhook.agentSession.issue as unknown as
		| Record<string, unknown>
		| null
		| undefined;
	if (!issue) return undefined;

	const parentId = issue.parentId;
	if (typeof parentId === "string" && parentId.length > 0) {
		return parentId;
	}

	const parent = issue.parent;
	if (parent && typeof parent === "object") {
		const id = (parent as Record<string, unknown>).id;
		if (typeof id === "string" && id.length > 0) {
			return id;
		}
	}

	return undefined;
}
