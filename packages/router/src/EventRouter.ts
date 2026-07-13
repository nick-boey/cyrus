import {
	type AgentEvent,
	type AgentSessionCreatedWebhook,
	isAgentSessionCreatedWebhook,
	isAgentSessionPromptedWebhook,
	type Webhook,
} from "cyrus-core";
import type { SessionStateFrame } from "cyrus-router-protocol";
import {
	type ContainerTargetService,
	InvalidIssueKeyError,
} from "./ContainerTargets.js";
import type { DeviceGateway } from "./DeviceGateway.js";
import {
	expiredMessage,
	fillTemplate,
	INVALID_ISSUE_KEY_MESSAGE,
	ISSUE_LOCKED_MESSAGE,
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
	/**
	 * "device" for a physical enrolled device, "container" for a per-issue
	 * ephemeral container device. Determines whether an offline target is an
	 * outage (post the waiting notice) or an expected cold start (boot it).
	 */
	kind: "device" | "container";
	/** Set for container targets: the issue key the container was minted for. */
	issueKey?: string;
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
	/**
	 * Routes container-executor users to per-issue ephemeral container
	 * devices instead of a physical enrolled device. Optional: omitting it
	 * keeps every user on the physical-device path (today's behavior).
	 */
	containerTargets?: ContainerTargetService;
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
	private readonly containerTargets: ContainerTargetService | undefined;
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
		this.containerTargets = opts.containerTargets;
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

		const { target, invalidIssueKey } = this.resolveTargetOrInvalidKey(
			webhook,
			sessionId,
			issueId,
			creator,
		);
		if (invalidIssueKey !== undefined) {
			await this.postActivity(
				workspaceId,
				sessionId,
				fillTemplate(INVALID_ISSUE_KEY_MESSAGE, { issueKey: invalidIssueKey }),
			);
			this.logger.info(
				`Refused to route session ${sessionId}: issue key ${JSON.stringify(invalidIssueKey)} can't be used for a container workspace`,
			);
			return;
		}
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
		const { target, invalidIssueKey } = this.resolveTargetOrInvalidKey(
			webhook,
			sessionId,
			issueId,
			creator,
		);
		if (invalidIssueKey !== undefined) {
			await this.postActivity(
				workspaceId,
				sessionId,
				fillTemplate(INVALID_ISSUE_KEY_MESSAGE, { issueKey: invalidIssueKey }),
			);
			this.logger.info(
				`Refused to route prompted session ${sessionId}: issue key ${JSON.stringify(invalidIssueKey)} can't be used for a container workspace`,
			);
			return;
		}
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
			{ ...target, deviceId, email },
			sessionId,
			workspaceId,
		);
	}

	/**
	 * Wraps {@link resolveTarget}, translating an {@link InvalidIssueKeyError}
	 * into a returned `invalidIssueKey` field instead of letting it propagate
	 * as an exception. Callers (`routeCreated`/`routePrompted`) use this to
	 * post the accurate "this issue's identifier can't be used" notice
	 * instead of treating a container-executor user as unenrolled or a prompt
	 * as unroutable (Finding 4). Any other error is not ours to translate and
	 * propagates unchanged.
	 */
	private resolveTargetOrInvalidKey(
		webhook: SessionEvent,
		sessionId: string,
		issueId: string | undefined,
		creator: SessionEvent["agentSession"]["creator"] | undefined,
	): { target: ResolvedTarget | undefined; invalidIssueKey?: string } {
		try {
			return {
				target: this.resolveTarget(webhook, sessionId, issueId, creator),
			};
		} catch (err) {
			if (err instanceof InvalidIssueKeyError) {
				return { target: undefined, invalidIssueKey: err.issueKey };
			}
			throw err;
		}
	}

	/**
	 * Resolves the device an event routes to, in priority order:
	 * existing session affinity (re-delivery) -> creator's enrolled/container
	 * device -> issue affinity (app-created sub-issues) -> parent-issue
	 * affinity.
	 *
	 * Shared by created and prompted events so a prompt to a session whose
	 * affinity was released still reaches its owner's device.
	 *
	 * @throws {InvalidIssueKeyError} when the creator resolves to a
	 * container-executor user whose issue key fails the container service's
	 * safety gate. Callers should use {@link resolveTargetOrInvalidKey}
	 * rather than calling this directly, unless they intend to handle that
	 * exception themselves.
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
			const info = this.store.getDeviceInfo(affinityDevice);
			if (info) {
				return {
					deviceId: affinityDevice,
					email: fallbackEmail,
					kind: info.kind,
					issueKey: info.issueKey,
				};
			}
			// Dangling affinity: the device row it pointed at is gone (e.g. its
			// container was destroyed and replaced under a different device
			// id). Clear it and fall through the chain below instead of
			// routing into the void.
			this.store.clearSessionAffinity(sessionId);
			this.logger.warn(
				`Session ${sessionId} affinity pointed at deleted device ${affinityDevice}; clearing and re-resolving`,
			);
		}

		if (creator) {
			const user = this.store.findUserForCreator({
				id: creator.id,
				email: creator.email,
			});
			if (user) {
				const containerTargets = this.containerTargets;
				const provider = containerTargets?.executorFor(user.userId);
				if (containerTargets && provider) {
					try {
						const issueKey = extractIssueKey(webhook) ?? issueId ?? sessionId;
						const { deviceId } = containerTargets.ensureDevice(user, issueKey);
						return { deviceId, email: user.email, kind: "container", issueKey };
					} catch (err) {
						if (err instanceof InvalidIssueKeyError) {
							// Distinct from "can't route this at all": the user IS
							// enrolled with a container executor, but THIS issue's
							// identifier can't name a workspace. Propagate so the
							// caller can post the accurate message instead of
							// UNENROLLED_CREATOR_MESSAGE (Finding 4).
							throw err;
						}
						// Anything else (e.g. a store error): the container service is
						// the gate against a malformed issue key (or a store error)
						// ever reaching the store/provider — a user-facing "can't
						// route this" message is a safer failure mode than either
						// crashing the router or falling back silently to some other
						// device.
						this.logger.warn(
							`Failed to resolve container device for ${user.email}: ${
								err instanceof Error ? err.message : String(err)
							}`,
						);
						return undefined;
					}
				}
				const device = this.store.getDeviceForUser(user.userId);
				if (device) {
					return {
						deviceId: device.deviceId,
						email: user.email,
						kind: "device",
					};
				}
			}
		}

		if (issueId !== undefined) {
			const issueDevice = this.store.getIssueAffinity(issueId);
			if (issueDevice !== undefined) {
				const info = this.store.getDeviceInfo(issueDevice);
				if (info) {
					return {
						deviceId: issueDevice,
						email: fallbackEmail,
						kind: info.kind,
						issueKey: info.issueKey,
					};
				}
				// Dangling issue affinity: the device it pointed at is gone.
				// `revokeDevice` deletes the `devices` row WITHOUT calling
				// `purgeDeviceScopedRows`, and `issue_affinity.device_id` has no
				// FK cascade, so a live row can point at nothing. Heal it the
				// same way the session-affinity fast path above does — clear and
				// fall through — instead of returning a target that would blow
				// up in `enqueueEvent` ("Unknown device") and take the router
				// process down (Finding 3).
				this.store.clearIssueAffinity(issueId);
				this.logger.warn(
					`Issue ${issueId} affinity pointed at deleted device ${issueDevice}; clearing and re-resolving`,
				);
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
				const info = this.store.getDeviceInfo(parentDevice);
				if (info) {
					return {
						deviceId: parentDevice,
						email: fallbackEmail,
						kind: info.kind,
						issueKey: info.issueKey,
					};
				}
				// Same healing as the issue-affinity branch above: a dangling
				// row must be cleared and fallen through, not returned as a
				// target (Finding 3).
				this.store.clearIssueAffinity(parentIssueId);
				this.logger.warn(
					`Parent issue ${parentIssueId} affinity pointed at deleted device ${parentDevice}; clearing and re-resolving`,
				);
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

		if (target.kind === "container") {
			// A container that isn't running yet is NOT an outage — cold-booting
			// it is the expected path, so no offlineWaitingMessage. boot() posts
			// its own (once-per-issue) failure notice only if ensureRunning
			// actually rejects; the queue drains once the container connects.
			this.containerTargets?.boot(target.deviceId, { workspaceId, sessionId });
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

/**
 * Extracts the issue's human-readable key (e.g. "CYPACK-123") for routing a
 * container-executor user to their per-issue container. The typed webhook
 * issue payload exposes `identifier` directly, but this still reads it
 * defensively (like {@link extractParentIssueId}) rather than trusting the
 * compile-time type, since it flows into `ContainerTargetService.ensureDevice`
 * and from there into filesystem paths and Docker object names.
 */
function extractIssueKey(webhook: SessionEvent): string | undefined {
	const issue = webhook.agentSession.issue as unknown as
		| Record<string, unknown>
		| null
		| undefined;
	if (!issue) return undefined;
	const identifier = issue.identifier;
	return typeof identifier === "string" && identifier.length > 0
		? identifier
		: undefined;
}
