// Logging

// Error reporting
export type {
	ErrorReporter,
	ErrorReporterContext,
	ErrorReporterLogAttributes,
	ErrorReporterLogLevel,
	ErrorReporterSeverity,
} from "./error-reporting/index.js";
export {
	getGlobalErrorReporter,
	getGlobalErrorTags,
	NoopErrorReporter,
	resetGlobalErrorReporter,
	setGlobalErrorReporter,
	setGlobalErrorTags,
} from "./error-reporting/index.js";
export type {
	CyrusEventName,
	ILogger,
	InstalledRecordingLogSink,
	LogContext,
	LogEventAttributes,
	LogException,
	LogFormat,
	LogRecord,
	LogRecordQuery,
	LogSink,
} from "./logging/index.js";
export {
	CYRUS_ATTRIBUTE_NAMESPACE,
	CYRUS_EVENTS,
	createLogger,
	createNoopLogger,
	cyrusAttributes,
	describeException,
	describeExceptionFromArgs,
	exceptionAttributes,
	extractError,
	getGlobalLogSink,
	installRecordingLogSink,
	LogLevel,
	RecordingLogSink,
	resetGlobalLogSink,
	setGlobalLogSink,
} from "./logging/index.js";

// export { Session } from './Session.js'
// export type { SessionOptions, , NarrativeItem } from './Session.js'
// export { ClaudeSessionManager as SessionManager } from './ClaudeSessionManager.js'

// Agent Runner types
export type {
	AgentMessage,
	AgentPendingWork,
	AgentRunnerConfig,
	AgentSessionInfo,
	AgentUserMessage,
	AskUserQuestion,
	AskUserQuestionAnswers,
	AskUserQuestionInput,
	AskUserQuestionOption,
	AskUserQuestionResult,
	BackgroundTaskSummary,
	HookCallbackMatcher,
	HookEvent,
	IAgentRunner,
	IMessageFormatter,
	LiveBackgroundTask,
	McpServerConfig,
	OnAskUserQuestion,
	SDKAssistantMessage,
	SDKAssistantMessageError,
	SDKMessage,
	SDKResultMessage,
	SDKUserMessage,
	SessionCronSummary,
} from "./agent-runner-types.js";
// Per-platform default allowed tools — single source of truth for cyrus-hosted
// and self-host configurations alike.
export type { AllowedToolsPlatform } from "./allowed-tools-defaults.js";
export {
	GITHUB_DEFAULT_ALLOWED_TOOLS,
	getDefaultAllowedTools,
	LINEAR_DEFAULT_ALLOWED_TOOLS,
	SLACK_DEFAULT_ALLOWED_TOOLS,
} from "./allowed-tools-defaults.js";
export type {
	BaseBranchResolution,
	CyrusAgentSession,
	CyrusAgentSessionEntry,
	IssueContext,
	IssueMinimal,
	RepositoryContext,
	SessionCreator,
	WipRestoreOutcome,
	Workspace,
} from "./CyrusAgentSession.js";
// Configuration types
export type {
	EdgeConfig,
	EdgeConfigPayload,
	EdgeWorkerConfig,
	LinearWorkspaceConfig,
	NetworkPolicy,
	OAuthCallbackHandler,
	RepoSetupHookEvent,
	RepoSetupHookEventHandler,
	RepoSetupHookStatus,
	RepositoryConfig,
	RepositoryConfigPayload,
	RunnerType,
	SandboxConfig,
	UserAccessControlConfig,
	UserIdentifier,
} from "./config-types.js";
export {
	EdgeConfigPayloadSchema,
	// Zod schemas for runtime validation
	EdgeConfigSchema,
	LinearWorkspaceConfigSchema,
	migrateEdgeConfig,
	NetworkPolicySchema,
	RepositoryConfigPayloadSchema,
	RepositoryConfigSchema,
	RunnerTypeSchema,
	requireLinearWorkspaceId,
	resolvePath,
	SandboxConfigSchema,
	TRUSTED_DOMAINS,
	UserAccessControlConfigSchema,
	UserIdentifierSchema,
} from "./config-types.js";
// Constants
export {
	DEFAULT_BASE_BRANCH,
	DEFAULT_CONFIG_FILENAME,
	DEFAULT_PROXY_URL,
	DEFAULT_REPOS_DIR,
	DEFAULT_WORKTREES_DIR,
	getDefaultReposDir,
	getDefaultWorktreesDir,
	type ResolvedWorkspacePath,
	resolveIssueWorkspacePath,
	type WorkspaceBaseDirCarrier,
	type WorkspaceBaseDirSource,
} from "./constants.js";
export { DEVCONTAINER_PATHS, parseJsonc } from "./devcontainer.js";
// Issue Tracker Abstraction
export type {
	AgentActivity,
	AgentActivityContent,
	AgentActivityCreateInput,
	AgentActivityPayload,
	AgentActivitySDK,
	AgentEvent,
	AgentEventTransportConfig,
	AgentEventTransportEvents,
	AgentSession,
	AgentSessionCreatedWebhook,
	AgentSessionCreateOnCommentInput,
	AgentSessionCreateOnIssueInput,
	AgentSessionCreateResponse,
	AgentSessionPromptedWebhook,
	AgentSessionSDK,
	Comment,
	CommentCreateInput,
	CommentWithAttachments,
	Connection,
	FetchChildrenOptions,
	FileUploadRequest,
	FileUploadResponse,
	GuidanceRule,
	IAgentEventTransport,
	IIssueTrackerService,
	Issue,
	IssueDeletedWebhook,
	IssueRelation,
	IssueRelationSummary,
	IssueStateChangeWebhook,
	IssueUnassignedWebhook,
	IssueUpdateInput,
	IssueUpdateWebhook,
	IssueWithChildren,
	Label,
	PaginationOptions,
	Project,
	Team,
	User,
	Webhook,
	WebhookAgentSession,
	WebhookComment,
	WebhookIssue,
	WorkflowState,
} from "./issue-tracker/index.js";
export {
	AgentActivityContentType,
	AgentActivitySignal,
	AgentSessionStatus,
	AgentSessionType,
	CLIEventTransport,
	CLIIssueTrackerService,
	CLIRPCServer,
	isAgentSessionCreatedEvent,
	isAgentSessionCreatedWebhook,
	isAgentSessionPromptedEvent,
	isAgentSessionPromptedWebhook,
	isCommentMentionEvent,
	isIssueAssignedEvent,
	isIssueAssignedWebhook,
	isIssueCommentMentionWebhook,
	isIssueDeletedWebhook,
	isIssueNewCommentWebhook,
	isIssueStateChangeWebhook,
	isIssueStateIdUpdateWebhook,
	isIssueTitleOrDescriptionUpdateWebhook,
	isIssueUnassignedEvent,
	isIssueUnassignedWebhook,
	isNewCommentEvent,
} from "./issue-tracker/index.js";
// MCP connection health, bounded-backoff retry, and headless-safe selection
export type {
	HeadlessMcpFilterResult,
	McpFailureClass,
	McpFailureClassification,
	McpHealthSource,
	McpHealthState,
	McpHealthSummary,
	McpInitServerStatus,
	McpRetryAttempt,
	McpRetryOptions,
	McpRetryPolicy,
	McpRetryResult,
	McpServerHealth,
	OmittedMcpServer,
} from "./mcp/index.js";
export {
	classifyMcpFailure,
	computeMcpRetryDelayMs,
	DEFAULT_MCP_RETRY_POLICY,
	filterHeadlessSafeMcpServers,
	formatMcpHealthDiagnostics,
	formatMcpServerHealth,
	INTERACTIVE_OAUTH_MCP_SERVERS,
	isHeadlessContainerMode,
	isMcpServerPreconfigured,
	McpHealthRegistry,
	recordMcpInitStatuses,
	requiresInteractiveOAuth,
	resolveMcpRetryPolicy,
	retryMcpConnection,
} from "./mcp/index.js";
// Internal Message Bus
export type {
	ContentChanges,
	ContentUpdateMessage,
	GitHubPlatformRef,
	GitHubSessionStartPlatformData,
	GitHubUserPromptPlatformData,
	GitLabPlatformRef,
	GitLabSessionStartPlatformData,
	GitLabUserPromptPlatformData,
	GuidanceItem,
	IMessageTranslator,
	InternalMessage,
	InternalMessageBase,
	IssueStateChangeMessage,
	LinearContentUpdatePlatformData,
	LinearIssueStateChangePlatformData,
	LinearPlatformRef,
	LinearSessionStartPlatformData,
	LinearStopSignalPlatformData,
	LinearUnassignPlatformData,
	LinearUserPromptPlatformData,
	MessageAction,
	MessageAuthor,
	MessageSource,
	SessionStartMessage,
	SlackPlatformRef,
	SlackSessionStartPlatformData,
	SlackUserPromptPlatformData,
	StopSignalMessage,
	TranslationContext,
	TranslationResult,
	UnassignMessage,
	UserPromptMessage,
} from "./messages/index.js";
export {
	hasGitHubSessionStartPlatformData,
	hasGitHubUserPromptPlatformData,
	hasGitLabSessionStartPlatformData,
	hasGitLabUserPromptPlatformData,
	hasLinearSessionStartPlatformData,
	hasLinearUserPromptPlatformData,
	hasSlackSessionStartPlatformData,
	hasSlackUserPromptPlatformData,
	isContentUpdateMessage,
	isGitHubMessage,
	isGitLabMessage,
	isIssueStateChangeMessage,
	isLinearMessage,
	isSessionStartMessage,
	isSlackMessage,
	isStopSignalMessage,
	isUnassignMessage,
	isUserPromptMessage,
} from "./messages/index.js";
// Linear adapters have been moved to cyrus-linear-event-transport package
// Import them directly from that package instead of from cyrus-core
export type {
	SerializableEdgeWorkerState,
	SerializedCyrusAgentSession,
	SerializedCyrusAgentSessionEntry,
	V3SerializableEdgeWorkerState,
} from "./PersistenceManager.js";
export {
	PERSISTENCE_VERSION,
	PersistenceManager,
} from "./PersistenceManager.js";
// Repository routing — shared by the edge worker and the router so the two
// can never disagree about which repository an issue belongs to.
export type {
	AmbiguousTier,
	IssueFacts,
	MatchResult,
	RepositoryAssociations,
	RepoTag,
	RoutableRepository,
	RoutingMethod,
} from "./routing/index.js";
export {
	AssociationParseError,
	formatAssociations,
	matchRepositories,
	parseAssociations,
	parseRepoTags,
} from "./routing/index.js";
export { StreamingPrompt } from "./StreamingPrompt.js";
export type {
	WebhookIpValidatorOptions,
	WebhookProvider,
} from "./security/index.js";
// Webhook IP validation
export {
	GITHUB_WEBHOOK_CIDRS_FALLBACK,
	GITLAB_WEBHOOK_CIDRS,
	ipMatchesAllowlist,
	LINEAR_WEBHOOK_IPS,
	WebhookIpValidator,
} from "./security/index.js";
// Simple Agent Runner types
export type {
	IAgentProgressEvent,
	ISimpleAgentQueryOptions,
	ISimpleAgentResult,
	ISimpleAgentRunner,
	ISimpleAgentRunnerConfig,
} from "./simple-agent-runner-types.js";
// Platform-agnostic webhook type aliases - exported from issue-tracker
// These are now defined in issue-tracker/types.ts as aliases to Linear SDK webhook types
// EdgeWorker and other high-level code should use these generic names via issue-tracker exports
