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
	// ISSUE OPERATIONS
	// ========================================================================

	fetchIssue(idOrIdentifier: string): Promise<Issue> {
		return this.connection.rpc("fetchIssue", [
			this.workspaceId,
			idOrIdentifier,
		]) as Promise<Issue>;
	}

	fetchIssueChildren(
		issueId: string,
		options?: FetchChildrenOptions,
	): Promise<IssueWithChildren> {
		return this.connection.rpc("fetchIssueChildren", [
			this.workspaceId,
			issueId,
			options,
		]) as Promise<IssueWithChildren>;
	}

	updateIssue(issueId: string, updates: IssueUpdateInput): Promise<Issue> {
		return this.connection.rpc("updateIssue", [
			this.workspaceId,
			issueId,
			updates,
		]) as Promise<Issue>;
	}

	fetchIssueAttachments(
		issueId: string,
	): Promise<Array<{ title: string; url: string }>> {
		return this.connection.rpc("fetchIssueAttachments", [
			this.workspaceId,
			issueId,
		]) as Promise<Array<{ title: string; url: string }>>;
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
