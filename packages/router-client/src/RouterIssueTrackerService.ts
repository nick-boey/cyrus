/**
 * Device-side implementation of `IIssueTrackerService` that forwards every
 * operation to the Cyrus Router over a `RouterConnection` RPC, instead of
 * talking to the Linear API directly. The router (not the device) holds the
 * real Linear OAuth/API tokens; the device only ever knows its own
 * `workspaceId`, which is prepended to every RPC call so the router can
 * authorize + scope the request to the right Linear workspace.
 *
 * @module RouterIssueTrackerService
 */

import type {
	AgentActivityCreateInput,
	AgentActivityPayload,
	AgentEventTransportConfig,
	AgentSessionCreateOnCommentInput,
	AgentSessionCreateOnIssueInput,
	Comment,
	CommentCreateInput,
	CommentWithAttachments,
	Connection,
	FetchChildrenOptions,
	FileUploadRequest,
	FileUploadResponse,
	IAgentEventTransport,
	IIssueTrackerService,
	Issue,
	IssueRelation,
	IssueRelationSummary,
	IssueUpdateInput,
	IssueWithChildren,
	Label,
	PaginationOptions,
	Team,
	User,
	WorkflowState,
} from "cyrus-core";
import type { RouterConnection } from "./RouterConnection.js";
import { RouterEventTransport } from "./RouterEventTransport.js";

/**
 * The data-only shape of an `Issue` as it arrives off the wire.
 *
 * `Issue` is `Pick<LinearSDK.Issue, …plain fields>` intersected with lazy
 * members — five async getters (`state`, `assignee`, `team`, `parent`,
 * `project`) and six methods (`labels()`, `comments()`, `attachments()`,
 * `children()`, `inverseRelations()`, `update()`). Those live on the SDK class's
 * prototype, so `JSON.stringify` drops every one of them; only own enumerable
 * properties survive.
 *
 * The relation *ids* are lost for the same reason: `stateId`/`teamId`/
 * `assigneeId`/`parentId`/`projectId` are ALSO prototype getters on the SDK
 * class, each reading a private backing field (`_state`, `_team`, …). Only
 * those backing fields are own properties, so only they cross the wire:
 *
 *     live getters:  stateId=st1 teamId=tm1 parentId=p1
 *     after JSON:    stateId=undefined teamId=undefined parentId=undefined
 *     what survives: _assignee, _parent, _project, _state, _team
 *
 * A non-Linear tracker (e.g. `CLIIssueTrackerService`) builds plain objects
 * that set `stateId` directly and have no backing fields at all. Both shapes
 * are therefore optional here, and {@link relationId} reads whichever arrived.
 */
type RawIssue = Partial<Pick<Issue, "assigneeId" | "stateId" | "teamId">> &
	Pick<
		Issue,
		| "id"
		| "identifier"
		| "title"
		| "description"
		| "url"
		| "branchName"
		| "labelIds"
		| "priority"
		| "createdAt"
		| "updatedAt"
		| "archivedAt"
	> & {
		parentId?: string | null;
		projectId?: string | null;
	} & RawIssueBackingFields;

/** A serialized SDK relation reference: everything but `id` is dropped too. */
type BackingRef = { id?: string | null } | null | undefined;

/**
 * The Linear SDK's private backing fields for an issue's relations. These are
 * assigned in the class constructor (`this._state = data.state`), making them
 * own enumerable properties — the only trace of the relation ids that survives
 * `JSON.stringify`.
 */
interface RawIssueBackingFields {
	_state?: BackingRef;
	_team?: BackingRef;
	_assignee?: BackingRef;
	_parent?: BackingRef;
	_project?: BackingRef;
}

/**
 * Resolves a relation id from whichever form the router sent: the explicit
 * `<name>Id` field (plain-data trackers) or the SDK's private backing field
 * (a serialized `LinearSDK.Issue`). Returns `undefined` when the relation is
 * genuinely absent — an unassigned issue, or one with no parent.
 */
function relationId(
	explicit: string | null | undefined,
	backing: BackingRef,
): string | undefined {
	return explicit ?? backing?.id ?? undefined;
}

/** The wire form of `fetchIssueChildren`, before its issues are hydrated. */
type RawIssueWithChildren = RawIssue & {
	children: RawIssue[];
	childCount: number;
};

/**
 * Forwards every `IIssueTrackerService` method to the router as
 * `connection.rpc(methodName, [workspaceId, ...args])`, except
 * `createAgentActivity`, which uses `connection.bufferedRpc` so activity
 * posts survive a router outage (durably buffered + replayed FIFO).
 *
 * Every method body is intentionally a one-liner: the router owns the real
 * Linear SDK calls (see `packages/router`'s RPC dispatch), so this class is
 * pure plumbing. The `as Promise<T>` casts bridge the `unknown` that
 * `RouterConnection.rpc`/`bufferedRpc` resolve with (raw JSON off the wire)
 * to the typed `IIssueTrackerService` contract; there is no local validation
 * of the wire payload shape (the router is a trusted peer once authenticated
 * via the device token).
 *
 * `createAgentSessionOnIssue`, `createAgentSessionOnComment`, and
 * `fetchAgentSession` return types (`IssueTrackerAgentSessionPayload` /
 * `IssueTrackerAgentSession`) are not re-exported from `cyrus-core`'s public
 * entrypoint (only reachable via the deeper `issue-tracker` module), so
 * their casts are written as `ReturnType<IIssueTrackerService["..."]>`
 * instead of importing the type by name — this is definitionally identical
 * to the interface's declared return type and needs no extra export.
 */
export class RouterIssueTrackerService implements IIssueTrackerService {
	constructor(
		private readonly connection: RouterConnection,
		private readonly workspaceId: string,
	) {}

	// ========================================================================
	// ISSUE HYDRATION
	// ========================================================================

	/**
	 * Rebuilds an `Issue`'s lazy members on top of the data-only payload the
	 * router sends, backing each one with an RPC.
	 *
	 * Without this, `fetchIssue` would satisfy its `Promise<Issue>` signature by
	 * a cast alone while returning an object that has none of `Issue`'s methods.
	 * Callers that reach for one get a runtime `TypeError` (`issue.labels is not
	 * a function`), and callers that read an async getter get the quieter,
	 * nastier failure: `await undefined` is `undefined`, so `await issue.team`
	 * silently yields nothing and the caller concludes the issue has no team.
	 *
	 * Each getter is memoized per hydrated issue, so re-reading `issue.state`
	 * costs one round trip rather than one per access.
	 */
	private hydrateIssue(raw: RawIssue): Issue {
		const memo = new Map<string, Promise<unknown>>();
		const once = <T>(key: string, load: () => Promise<T>): Promise<T> => {
			const cached = memo.get(key) as Promise<T> | undefined;
			if (cached) return cached;
			const pending = load();
			memo.set(key, pending);
			return pending;
		};

		// Getters in an object literal bind `this` to the literal, not the service,
		// so capture the service explicitly.
		const self = this;

		// Resolved once, up front: a serialized SDK issue carries these only in
		// its private backing fields, a plain-data tracker only in the explicit
		// `<name>Id` fields. See `relationId`.
		const stateId = relationId(raw.stateId, raw._state);
		const assigneeId = relationId(raw.assigneeId, raw._assignee);
		const teamId = relationId(raw.teamId, raw._team);
		const parentId = relationId(raw.parentId, raw._parent);

		// `Issue`'s getters are typed against the Linear SDK's own WorkflowState /
		// User / Team / Issue classes, while these RPCs resolve `cyrus-core`'s
		// structural equivalents. The casts bridge exactly that gap — the same
		// trade this class already makes for every other method. `router-client`
		// deliberately does not depend on @linear/sdk, so the SDK types are
		// referenced indirectly via `Issue[...]`.
		const hydrated: Issue = {
			...raw,

			// Re-project the resolved ids as own properties. `...raw` spreads only
			// what arrived, so on a serialized SDK issue these would otherwise stay
			// undefined even though the getters below work — and callers do read
			// `issue.teamId` directly.
			stateId,
			assigneeId,
			teamId,

			get state(): Issue["state"] {
				if (!stateId) return undefined;
				return once("state", () =>
					self.fetchWorkflowState(stateId),
				) as unknown as Issue["state"];
			},

			get assignee(): Issue["assignee"] {
				if (!assigneeId) return undefined;
				return once("assignee", () =>
					self.fetchUser(assigneeId),
				) as unknown as Issue["assignee"];
			},

			get team(): Issue["team"] {
				if (!teamId) return undefined;
				return once("team", () =>
					self.fetchTeam(teamId),
				) as unknown as Issue["team"];
			},

			get parent(): Issue["parent"] {
				if (!parentId) return undefined;
				return once("parent", () =>
					self.fetchIssue(parentId),
				) as unknown as Issue["parent"];
			},

			/**
			 * No `fetchProject` RPC exists, so this stays `undefined` rather than
			 * inventing one. `undefined` is a legal value for `Issue["project"]`
			 * and matches what an issue with no project returns.
			 */
			get project(): Issue["project"] {
				return undefined;
			},

			/**
			 * Rebuilt from `labelIds` via `fetchLabel`, which yields real `Label`
			 * objects. The `getIssueLabels` RPC returns names only and could not
			 * satisfy `Connection<Label>`.
			 */
			labels: async (): Promise<Connection<Label>> => {
				const ids = raw.labelIds ?? [];
				const nodes = await Promise.all(ids.map((id) => this.fetchLabel(id)));
				return { nodes };
			},

			/**
			 * The `fetchIssueAttachments` RPC returns `{ title, url }` only, so the
			 * reconstructed nodes carry just those two fields — every other
			 * `Attachment` property is absent. That is what the one caller
			 * (`AttachmentService`) reads.
			 */
			attachments: async () => {
				const list = await this.fetchIssueAttachments(raw.id);
				return { nodes: list } as unknown as Awaited<
					ReturnType<Issue["attachments"]>
				>;
			},

			children: async (): Promise<Connection<Issue>> => {
				const withChildren = await this.fetchIssueChildren(raw.id);
				return { nodes: withChildren.children };
			},

			comments: async (): Promise<Connection<Comment>> =>
				this.fetchComments(raw.id),

			inverseRelations: async (): Promise<Connection<IssueRelation>> => {
				const summaries = await this.fetchIssueInverseRelations(raw.id);
				return { nodes: summaries.map((s) => this.hydrateRelation(s)) };
			},

			update: async (input) => {
				const updated = await this.updateIssue(
					raw.id,
					input as IssueUpdateInput,
				);
				return { success: true, issue: updated } as unknown as Awaited<
					ReturnType<Issue["update"]>
				>;
			},
		};

		return hydrated;
	}

	/**
	 * Restores an `IssueRelation` from its wire-safe summary: the router resolved
	 * `issue`/`relatedIssue` to plain data (a `Promise` serializes to `{}`), and
	 * `IssueRelation` declares them as promises, so re-wrap each hydrated issue.
	 */
	private hydrateRelation(summary: IssueRelationSummary): IssueRelation {
		return {
			id: summary.id,
			type: summary.type,
			createdAt: summary.createdAt,
			updatedAt: summary.updatedAt,
			archivedAt: summary.archivedAt,
			issue: summary.issue
				? Promise.resolve(this.hydrateIssue(summary.issue as RawIssue))
				: undefined,
			relatedIssue: summary.relatedIssue
				? Promise.resolve(this.hydrateIssue(summary.relatedIssue as RawIssue))
				: undefined,
		};
	}

	// ========================================================================
	// ISSUE OPERATIONS
	// ========================================================================

	async fetchIssue(idOrIdentifier: string): Promise<Issue> {
		const raw = (await this.connection.rpc("fetchIssue", [
			this.workspaceId,
			idOrIdentifier,
		])) as RawIssue;
		return this.hydrateIssue(raw);
	}

	async fetchIssueChildren(
		issueId: string,
		options?: FetchChildrenOptions,
	): Promise<IssueWithChildren> {
		const raw = (await this.connection.rpc("fetchIssueChildren", [
			this.workspaceId,
			issueId,
			options,
		])) as RawIssueWithChildren;
		// Hydrate the parent *and* each child: children are `Issue`s, so a caller
		// reading `child.state` must get a promise, not `undefined`.
		return {
			...this.hydrateIssue(raw),
			children: (raw.children ?? []).map((child) => this.hydrateIssue(child)),
			childCount: raw.childCount,
		};
	}

	async updateIssue(
		issueId: string,
		updates: IssueUpdateInput,
	): Promise<Issue> {
		const raw = (await this.connection.rpc("updateIssue", [
			this.workspaceId,
			issueId,
			updates,
		])) as RawIssue;
		return this.hydrateIssue(raw);
	}

	fetchIssueAttachments(
		issueId: string,
	): Promise<Array<{ title: string; url: string }>> {
		return this.connection.rpc("fetchIssueAttachments", [
			this.workspaceId,
			issueId,
		]) as Promise<Array<{ title: string; url: string }>>;
	}

	fetchIssueInverseRelations(issueId: string): Promise<IssueRelationSummary[]> {
		return this.connection.rpc("fetchIssueInverseRelations", [
			this.workspaceId,
			issueId,
		]) as Promise<IssueRelationSummary[]>;
	}

	// ========================================================================
	// COMMENT OPERATIONS
	// ========================================================================

	fetchComments(
		issueId: string,
		options?: PaginationOptions,
	): Promise<Connection<Comment>> {
		return this.connection.rpc("fetchComments", [
			this.workspaceId,
			issueId,
			options,
		]) as Promise<Connection<Comment>>;
	}

	fetchComment(commentId: string): Promise<Comment> {
		return this.connection.rpc("fetchComment", [
			this.workspaceId,
			commentId,
		]) as Promise<Comment>;
	}

	fetchCommentWithAttachments(
		commentId: string,
	): Promise<CommentWithAttachments> {
		return this.connection.rpc("fetchCommentWithAttachments", [
			this.workspaceId,
			commentId,
		]) as Promise<CommentWithAttachments>;
	}

	createComment(issueId: string, input: CommentCreateInput): Promise<Comment> {
		return this.connection.rpc("createComment", [
			this.workspaceId,
			issueId,
			input,
		]) as Promise<Comment>;
	}

	// ========================================================================
	// TEAM OPERATIONS
	// ========================================================================

	fetchTeams(options?: PaginationOptions): Promise<Connection<Team>> {
		return this.connection.rpc("fetchTeams", [
			this.workspaceId,
			options,
		]) as Promise<Connection<Team>>;
	}

	fetchTeam(idOrKey: string): Promise<Team> {
		return this.connection.rpc("fetchTeam", [
			this.workspaceId,
			idOrKey,
		]) as Promise<Team>;
	}

	// ========================================================================
	// LABEL OPERATIONS
	// ========================================================================

	fetchLabels(options?: PaginationOptions): Promise<Connection<Label>> {
		return this.connection.rpc("fetchLabels", [
			this.workspaceId,
			options,
		]) as Promise<Connection<Label>>;
	}

	fetchLabel(idOrName: string): Promise<Label> {
		return this.connection.rpc("fetchLabel", [
			this.workspaceId,
			idOrName,
		]) as Promise<Label>;
	}

	getIssueLabels(issueId: string): Promise<string[]> {
		return this.connection.rpc("getIssueLabels", [
			this.workspaceId,
			issueId,
		]) as Promise<string[]>;
	}

	// ========================================================================
	// WORKFLOW STATE OPERATIONS
	// ========================================================================

	fetchWorkflowStates(
		teamId: string,
		options?: PaginationOptions,
	): Promise<Connection<WorkflowState>> {
		return this.connection.rpc("fetchWorkflowStates", [
			this.workspaceId,
			teamId,
			options,
		]) as Promise<Connection<WorkflowState>>;
	}

	fetchWorkflowState(stateId: string): Promise<WorkflowState> {
		return this.connection.rpc("fetchWorkflowState", [
			this.workspaceId,
			stateId,
		]) as Promise<WorkflowState>;
	}

	// ========================================================================
	// USER OPERATIONS
	// ========================================================================

	fetchUser(userId: string): Promise<User> {
		return this.connection.rpc("fetchUser", [
			this.workspaceId,
			userId,
		]) as Promise<User>;
	}

	fetchCurrentUser(): Promise<User> {
		return this.connection.rpc("fetchCurrentUser", [
			this.workspaceId,
		]) as Promise<User>;
	}

	// ========================================================================
	// AGENT SESSION OPERATIONS
	// ========================================================================

	createAgentSessionOnIssue(
		input: AgentSessionCreateOnIssueInput,
	): ReturnType<IIssueTrackerService["createAgentSessionOnIssue"]> {
		return this.connection.rpc("createAgentSessionOnIssue", [
			this.workspaceId,
			input,
		]) as ReturnType<IIssueTrackerService["createAgentSessionOnIssue"]>;
	}

	createAgentSessionOnComment(
		input: AgentSessionCreateOnCommentInput,
	): ReturnType<IIssueTrackerService["createAgentSessionOnComment"]> {
		return this.connection.rpc("createAgentSessionOnComment", [
			this.workspaceId,
			input,
		]) as ReturnType<IIssueTrackerService["createAgentSessionOnComment"]>;
	}

	fetchAgentSession(
		sessionId: string,
	): ReturnType<IIssueTrackerService["fetchAgentSession"]> {
		return this.connection.rpc("fetchAgentSession", [
			this.workspaceId,
			sessionId,
		]) as ReturnType<IIssueTrackerService["fetchAgentSession"]>;
	}

	emitStopSignalEvent(sessionId: string): Promise<void> {
		return this.connection.rpc("emitStopSignalEvent", [
			this.workspaceId,
			sessionId,
		]) as Promise<void>;
	}

	// ========================================================================
	// AGENT ACTIVITY OPERATIONS
	// ========================================================================

	/**
	 * Uses `bufferedRpc` (not `rpc`): activity posts are the highest-volume,
	 * most latency-sensitive traffic Cyrus emits, and losing one to a router
	 * blip would silently drop timeline visibility in Linear. `bufferedRpc`
	 * durably queues the mutation offline (or on a mid-call outage) and
	 * resolves immediately with a synthetic `{ success: true }`, matching the
	 * `AgentActivityPayload` shape `LinearActivitySink` reads (`.success`).
	 */
	createAgentActivity(
		input: AgentActivityCreateInput,
	): Promise<AgentActivityPayload> {
		return this.connection.bufferedRpc("createAgentActivity", [
			this.workspaceId,
			input,
		]) as Promise<AgentActivityPayload>;
	}

	// ========================================================================
	// FILE OPERATIONS
	// ========================================================================

	requestFileUpload(request: FileUploadRequest): Promise<FileUploadResponse> {
		return this.connection.rpc("requestFileUpload", [
			this.workspaceId,
			request,
		]) as Promise<FileUploadResponse>;
	}

	/**
	 * Router extension, NOT part of `IIssueTrackerService`: fetches
	 * attachment bytes through the router (which holds the Linear API token
	 * needed to authenticate the download) rather than the device fetching
	 * the attachment URL directly.
	 */
	downloadAttachment(
		url: string,
	): Promise<{ base64: string; contentType: string }> {
		return this.connection.rpc("downloadAttachment", [
			this.workspaceId,
			url,
		]) as Promise<{ base64: string; contentType: string }>;
	}

	// ========================================================================
	// PLATFORM METADATA
	// ========================================================================

	/**
	 * Always "linear": devices route to a Linear workspace through the
	 * router, so downstream `trackerId`/platform checks must behave exactly
	 * as they would against a direct Linear connection.
	 */
	getPlatformType(): string {
		return "linear";
	}

	getPlatformMetadata(): Record<string, unknown> {
		return { transport: "router", workspaceId: this.workspaceId };
	}

	// ========================================================================
	// EVENT TRANSPORT
	// ========================================================================

	/**
	 * `config` is unused: a router-routed device has no inbound HTTP surface
	 * to configure (no Fastify server, no webhook secret/verification mode —
	 * events arrive over the already-authenticated WebSocket). Kept as a
	 * parameter solely to satisfy the `IIssueTrackerService` signature.
	 */
	createEventTransport(
		_config: AgentEventTransportConfig,
	): IAgentEventTransport {
		return new RouterEventTransport(this.connection);
	}
}
