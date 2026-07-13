/**
 * IIssueTrackerService methods a device may invoke over RPC. Mirrors
 * packages/core/src/issue-tracker/IIssueTrackerService.ts. downloadAttachment
 * is a router extension (Task 9) for token-authenticated attachment bytes.
 */
export const RPC_METHODS = [
	"fetchIssue",
	"fetchIssueChildren",
	"updateIssue",
	"fetchIssueAttachments",
	"fetchIssueInverseRelations",
	"fetchComments",
	"fetchComment",
	"fetchCommentWithAttachments",
	"createComment",
	"fetchTeams",
	"fetchTeam",
	"fetchLabels",
	"fetchLabel",
	"getIssueLabels",
	"fetchWorkflowStates",
	"fetchWorkflowState",
	"fetchUser",
	"fetchCurrentUser",
	"createAgentSessionOnIssue",
	"createAgentSessionOnComment",
	"fetchAgentSession",
	"emitStopSignalEvent",
	"createAgentActivity",
	"requestFileUpload",
	"downloadAttachment",
] as const;

/** Methods whose first-positional or `agentSessionId` param must belong to the calling device. */
export const SESSION_SCOPED_RPC_METHODS = [
	"createAgentActivity",
	"emitStopSignalEvent",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];
