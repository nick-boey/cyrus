import {
	type AgentEvent,
	type AgentSessionCreatedWebhook,
	isAgentSessionCreatedWebhook,
	isAgentSessionPromptedWebhook,
	isIssueDeletedWebhook,
	isIssueStateChangeWebhook,
	type Webhook,
} from "cyrus-core";
import type { SessionStateFrame } from "cyrus-router-protocol";
import type { DeviceGateway } from "./DeviceGateway.js";
import {
	expiredMessage,
	fillTemplate,
	ISSUE_LOCKED_MESSAGE,
	ORPHANED_LOCK_RECLAIMED_MESSAGE,
	offlineReleaseMessage,
	offlineWaitingMessage,
	PROMPT_REJECTION_MESSAGE,
	PROMPT_UNROUTABLE_MESSAGE,
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
	/**
	 * Moves an issue into its team's first `started` state, resolving with the
	 * state's name (or `undefined` when it was already started). Only the router
	 * holds a Linear token, so only the router can do this — see
	 * {@link LinearExecutor.moveIssueToStartedState}. Optional: omitting it
	 * disables promotion (tests that don't exercise it).
	 */
	moveIssueToStartedState?: (
		workspaceId: string,
		issueId: string,
	) => Promise<string | undefined>;
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
	private readonly moveIssueToStartedState:
		| ((workspaceId: string, issueId: string) => Promise<string | undefined>)
		| undefined;
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
		this.moveIssueToStartedState = opts.moveIssueToStartedState;
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
		// Terminal-state webhooks carry no agent session, so they route on issue
		// affinity rather than through resolveTarget(). The device needs them to
		// run its own terminal-state cleanup (stop sessions, cyrus-teardown.sh,
		// remove worktrees) — without this forwarding a node's worktrees are
		// never reclaimed, since the node has no other way to learn an issue
		// closed. See EdgeWorker.handleIssueStateChangeMessage.
		if (isIssueStateChangeWebhook(webhook)) {
			this.routeIssueTerminal(webhook, webhook.notification?.issue);
			return;
		}
		if (isIssueDeletedWebhook(webhook)) {
			this.routeIssueTerminal(webhook, webhook.data);
			return;
		}
		this.logger.info(
			`EventRouter ignoring non-agent-session webhook ${webhook.type}/${webhook.action}`,
		);
	}

	/**
	 * Forwards a terminal-state webhook (issue completed/canceled, or issue
	 * deleted) to the device that owns the issue, so it can reclaim the
	 * worktree.
	 *
	 * Routes on `issue_affinity` — the only mapping that survives the session
	 * ending. Session affinity and the issue lock are both torn down the moment
	 * a session reports a terminal `session_state`, which for a typical issue
	 * happens well BEFORE the human moves it to Done. Issue affinity is only
	 * purged when the device itself is removed, so it still points at the right
	 * machine days later — which is exactly the window this cleanup lives in.
	 *
	 * No Linear activity is posted on the failure paths: a status change is not
	 * an agent session, so there is no thread to post to.
	 */
	private routeIssueTerminal(
		webhook: Webhook,
		issue: { id?: string; identifier?: string } | null | undefined,
	): void {
		const label = `${webhook.type}/${webhook.action}`;
		const issueId = issue?.id;
		if (!issueId) {
			this.logger.warn(
				`Terminal webhook ${label} carries no issue id; cannot route cleanup`,
			);
			return;
		}
		const issueRef = issue?.identifier ?? issueId;

		const deviceId = this.store.getIssueAffinity(issueId);
		if (deviceId === undefined) {
			// No device ever ran a session for this issue, so no device holds a
			// worktree for it. Nothing to clean up — not an error.
			this.logger.info(
				`Terminal webhook ${label} for issue ${issueRef}: no device affinity, nothing to clean up`,
			);
			return;
		}

		// Enqueue unconditionally rather than only when online: the worktree
		// still needs reclaiming when the device comes back, and pendingEvents
		// replays anything unacked on reconnect. Cleanup is idempotent on the
		// node (deleteWorktree no-ops when the directory is already gone), so a
		// duplicate delivery is harmless.
		this.store.enqueueEvent(
			deviceId,
			JSON.stringify(webhook),
			this.now(),
			this.config.eventTtlMs,
		);
		if (this.gateway.isOnline(deviceId)) {
			this.gateway.deliverPending(deviceId);
		}
		this.logger.info(
			`Forwarded terminal webhook ${label} for issue ${issueRef} to device ${deviceId} for worktree cleanup`,
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

	/**
	 * Reclaims issue locks a reconnecting device no longer backs with a live
	 * session. A device declares its currently-tracked session IDs in the hello
	 * frame; any lock we hold for that device whose session is not in the
	 * declared set belongs to a session the device has lost — classically to a
	 * corrupted state file after an ENOSPC restart — and can therefore never be
	 * released by a terminal frame. Without this the issue stays locked forever
	 * and every re-delegation is rejected.
	 *
	 * Fires on "deviceConnected". Safe to call for every reconnect; it only acts
	 * on locks the device didn't claim.
	 *
	 * Guards:
	 * - `declaredSessions === undefined` → an older client that doesn't report
	 *   active sessions. Reclaiming would wrongly release every lock, so skip
	 *   entirely and keep pre-reconcile behavior.
	 * - The device still has undelivered events → it isn't caught up. A queued
	 *   `created` event will make it start tracking a session it can't declare
	 *   yet, so its list isn't authoritative; defer to a later reconnect. (Acked
	 *   events are deleted, so this only trips while delivery is genuinely
	 *   behind.)
	 */
	async reconcileDeviceLocks(
		deviceId: number,
		declaredSessions: string[] | undefined,
	): Promise<void> {
		if (!this.config.issueLock) return;
		if (declaredSessions === undefined) return;

		if (this.store.hasPendingEvents(deviceId, this.now())) {
			this.logger.info(
				`Skipping lock reconciliation for device ${deviceId}: it has undelivered events, so its active-session list is not yet authoritative`,
			);
			return;
		}

		const declared = new Set(declaredSessions);
		const locks = this.store.getIssueLocksForDevice(deviceId);

		// Two passes on purpose. Do every DB release synchronously first, before
		// any `await`, so a `session_state` frame the device replays right after
		// this same hello can't interleave mid-loop and race a release. Only then
		// do the (awaiting) courtesy posts.
		const reclaimed: Array<{
			issueId: string;
			sessionId: string;
			workspaceId: string | undefined;
		}> = [];
		for (const { issueId, sessionId } of locks) {
			if (declared.has(sessionId)) continue;
			this.store.releaseIssueLockForSession(sessionId);
			this.store.clearSessionAffinity(sessionId);
			const workspaceId = this.sessionWorkspace.get(sessionId);
			this.notifiedSessions.delete(sessionId);
			this.sessionWorkspace.delete(sessionId);
			reclaimed.push({ issueId, sessionId, workspaceId });
		}

		for (const { issueId, sessionId, workspaceId } of reclaimed) {
			// Best-effort courtesy post. The workspace hint is in-memory only, so
			// after a router restart we usually can't address the Linear thread —
			// the lock release (the part that unblocks re-delegation) still stands.
			if (workspaceId) {
				await this.postActivity(
					workspaceId,
					sessionId,
					ORPHANED_LOCK_RECLAIMED_MESSAGE,
				);
			}
			this.logger.info(
				`Reclaimed orphaned lock for issue ${issueId}: device ${deviceId} reconnected without tracking session ${sessionId}`,
			);
		}
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

		const target = this.resolveTarget(webhook, sessionId, issueId, creator);
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

		// Delivery first, promotion second: the device only needs the queued event
		// to start work, and promotion costs several Linear round trips.
		if (issueId !== undefined) {
			await this.promoteIssue(workspaceId, issueId);
		}
	}

	/**
	 * Marks a delegated issue as started in Linear. Reached only once the event
	 * has been accepted — an unenrolled creator or a lock rejection returns from
	 * {@link routeCreated} before this, so a rejected issue is never promoted.
	 *
	 * Best-effort: a Linear failure here must not fail the routing that already
	 * succeeded, so it is logged and swallowed.
	 */
	private async promoteIssue(
		workspaceId: string,
		issueId: string,
	): Promise<void> {
		if (!this.moveIssueToStartedState) return;
		try {
			const stateName = await this.moveIssueToStartedState(
				workspaceId,
				issueId,
			);
			if (stateName !== undefined) {
				this.logger.info(`Moved issue ${issueId} to '${stateName}'`);
			}
		} catch (err) {
			this.logger.warn(
				`Failed to move issue ${issueId} to a started state: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
		}
	}

	private async routePrompted(webhook: SessionEvent): Promise<void> {
		const sessionId = webhook.agentSession.id;
		const workspaceId = webhook.organizationId;
		const issueId =
			webhook.agentSession.issueId ??
			webhook.agentSession.issue?.id ??
			undefined;
		const creator = webhook.agentSession.creator ?? undefined;

		// A prompt must resolve through the SAME chain as a created event, not
		// through session affinity alone. Affinity is deleted the moment a session
		// reports a terminal state, but a Linear agent session outlives its turns:
		// the user can always prompt it again. Resolving on affinity only meant
		// every follow-up prompt after the first completion was dropped, leaving
		// the session in "Waiting for Cyrus" forever.
		const target = this.resolveTarget(webhook, sessionId, issueId, creator);
		if (!target) {
			await this.postActivity(
				workspaceId,
				sessionId,
				PROMPT_UNROUTABLE_MESSAGE,
			);
			this.logger.warn(
				`Prompted event for session ${sessionId} resolved to no device; notified and dropping`,
			);
			return;
		}
		const deviceId = target.deviceId;

		if (this.config.creatorOnlyPrompting) {
			// Reference creator: the stored one, else the session creator carried on
			// the webhook. The webhook's `agentSession.creator` is ALWAYS the
			// session's original creator, which is exactly what we want on the
			// *creator* side of this comparison — and it is the only thing we have
			// once a terminal state has cleared the stored affinity row. Without
			// this fallback, a session rescued by resolveTarget() above would have
			// no stored creator and the gate would silently skip, letting anyone
			// prompt someone else's finished session onto that person's machine.
			const creatorId = this.storedCreatorId(sessionId) ?? creator?.id;
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
			// else: creatorId is unknown — neither stored nor on the webhook (e.g. a
			// session routed via issue/parent affinity that never carried a creator).
			// There is nothing to compare the actor against, so the gate is
			// intentionally skipped and the prompt is allowed through — a deliberate
			// can't-compare-so-allow case, not an oversight.
		}

		// Re-establish affinity. When we got here via the fallback chain the row was
		// missing (or pointed at a device that has since been replaced), so writing
		// it back means the next prompt resolves on the fast path — and restores the
		// stored creator that the creator-only gate above compares against.
		this.store.setSessionAffinity(
			sessionId,
			deviceId,
			creator ? JSON.stringify(creator) : undefined,
		);
		if (issueId !== undefined) {
			this.store.setIssueAffinity(issueId, deviceId);
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
	 * Resolves the device an event routes to, in priority order:
	 * existing session affinity (re-delivery) -> creator's enrolled device ->
	 * issue affinity (app-created sub-issues) -> parent-issue affinity.
	 *
	 * Shared by created and prompted events so a prompt to a session whose
	 * affinity was released still reaches its owner's device.
	 */
	private resolveTarget(
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
