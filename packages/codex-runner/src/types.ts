import type {
	ApprovalMode,
	ModelReasoningEffort,
	SandboxMode,
	WebSearchMode,
} from "@openai/codex-sdk";
import type {
	AgentRunnerConfig,
	AgentSessionInfo,
	SDKMessage,
} from "cyrus-core";
import type { CyrusSandboxFilesystem } from "./config/sandboxPolicy.js";

export type CodexConfigValue =
	| string
	| number
	| boolean
	| CodexConfigValue[]
	| { [key: string]: CodexConfigValue };

export type CodexConfigOverrides = { [key: string]: CodexConfigValue };

/**
 * Configuration for CodexRunner.
 */
export interface CodexRunnerConfig extends AgentRunnerConfig {
	/** Path to codex CLI binary (defaults to `codex` in PATH) */
	codexPath?: string;
	/**
	 * Override Codex home directory.
	 * Defaults to process `CODEX_HOME`, then `~/.codex`.
	 */
	codexHome?: string;
	/**
	 * Additional environment variables for the Codex child process, merged
	 * over the inherited env (per-user GH_TOKEN, git author identity, etc.).
	 */
	additionalEnv?: Record<string, string>;
	/**
	 * Multi-user credential isolation: scrub ALL globally-inherited credential
	 * groups (Claude auth, OpenAI auth, GitHub tokens, git author identity)
	 * from the child env before `additionalEnv` merges. In particular this
	 * stops a global OPENAI_API_KEY from shadowing per-user
	 * ChatGPT-subscription auth resolved from CODEX_HOME/auth.json.
	 */
	credentialIsolation?: boolean;
	/**
	 * Override Codex reasoning effort.
	 * If omitted, CodexRunner applies a safe default for known model constraints.
	 */
	modelReasoningEffort?: ModelReasoningEffort;
	/** Sandbox mode for Codex shell/tool execution */
	sandbox?: SandboxMode;
	/** Approval policy for Codex tool/shell execution */
	askForApproval?: ApprovalMode;
	/** Enable Codex web search tool */
	includeWebSearch?: boolean;
	/** Explicit Codex web search mode (takes precedence over includeWebSearch) */
	webSearchMode?: WebSearchMode;
	/** Allow execution outside git repo (defaults to true) */
	skipGitRepoCheck?: boolean;
	/** Additional global Codex config overrides passed through SDK `config` */
	configOverrides?: CodexConfigOverrides;
	/** JSON Schema for structured output (passed to turn/start as outputSchema) */
	outputSchema?: unknown;
	/**
	 * Filesystem sandbox intent (allow/deny read, allow write). When present, the
	 * session runs under a granular per-thread sandbox policy instead of the
	 * coarse default mode. Paths must be absolute.
	 */
	sandboxSettings?: CyrusSandboxFilesystem;
}

/**
 * Session metadata for CodexRunner.
 */
export interface CodexSessionInfo extends AgentSessionInfo {
	sessionId: string | null;
}

/**
 * Event emitter interface for CodexRunner.
 */
export interface CodexRunnerEvents {
	message: (message: SDKMessage) => void;
	error: (error: Error) => void;
	complete: (messages: SDKMessage[]) => void;
}
