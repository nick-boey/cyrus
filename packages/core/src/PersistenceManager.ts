import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
	CyrusAgentSession,
	CyrusAgentSessionEntry,
	IssueContext,
	IssueMinimal,
} from "./CyrusAgentSession.js";
import { createLogger, type ILogger } from "./logging/index.js";

/** Current persistence format version */
export const PERSISTENCE_VERSION = "4.0";

/**
 * Monotonic counter making each save's temp-file name unique within this
 * process. Saves can overlap — {@link PersistenceManager.saveEdgeWorkerState}
 * is fired from an un-awaited `onStateChange` callback as well as several
 * awaited call sites — so two writes must never share a temp path or they
 * would clobber each other mid-write.
 */
let tempFileCounter = 0;

// Serialized versions with Date fields as strings
export type SerializedCyrusAgentSession = CyrusAgentSession;
// extends Omit<CyrusAgentSession, 'createdAt' | 'updatedAt'> {
//   createdAt: string
//   updatedAt: string
// }

export type SerializedCyrusAgentSessionEntry = CyrusAgentSessionEntry;
// extends Omit<CyrusAgentSessionEntry, 'metadata'> {
//   metadata?: Omit<CyrusAgentSessionEntry['metadata'], 'timestamp'> & {
//     timestamp?: string
//   }
// }

/**
 * v2.0 session format (for migration purposes)
 */
interface V2CyrusAgentSession {
	linearAgentActivitySessionId: string;
	type: string;
	status: string;
	context: string;
	createdAt: number;
	updatedAt: number;
	issueId: string;
	issue: IssueMinimal;
	workspace: {
		path: string;
		isGitWorktree: boolean;
		historyPath?: string;
	};
	claudeSessionId?: string;
	geminiSessionId?: string;
	metadata?: Record<string, unknown>;
}

/**
 * Serializable EdgeWorker state for persistence
 *
 * v4.0: Flat session format - sessions keyed directly by sessionId (no repo nesting)
 * v3.0: Nested format - sessions keyed by [repoId][sessionId]
 */
export interface SerializableEdgeWorkerState {
	// Agent Session state - flat map of sessionId → session (v4.0)
	agentSessions?: Record<string, SerializedCyrusAgentSession>;
	agentSessionEntries?: Record<string, SerializedCyrusAgentSessionEntry[]>;
	// Child to parent agent session mapping
	childToParentAgentSession?: Record<string, string>;
	// Issue to repository mapping (for caching user repository selections)
	// v4.1: string[] (multi-repo). Migration: old Record<string, string> auto-converts.
	issueRepositoryCache?: Record<string, string[]>;
}

/**
 * v3.0 nested state format (for migration purposes)
 */
export interface V3SerializableEdgeWorkerState {
	agentSessions?: Record<string, Record<string, SerializedCyrusAgentSession>>;
	agentSessionEntries?: Record<
		string,
		Record<string, SerializedCyrusAgentSessionEntry[]>
	>;
	childToParentAgentSession?: Record<string, string>;
	issueRepositoryCache?: Record<string, string>;
}

/**
 * Manages persistence of critical mappings to survive restarts
 */
export class PersistenceManager {
	private persistencePath: string;
	private logger: ILogger;

	constructor(persistencePath?: string, logger?: ILogger) {
		this.persistencePath =
			persistencePath || join(homedir(), ".cyrus", "state");
		this.logger = logger ?? createLogger({ component: "PersistenceManager" });
	}

	/**
	 * Get the full path to the single EdgeWorker state file
	 */
	private getEdgeWorkerStateFilePath(): string {
		return join(this.persistencePath, "edge-worker-state.json");
	}

	/**
	 * Ensure the persistence directory exists
	 */
	private async ensurePersistenceDirectory(): Promise<void> {
		await mkdir(this.persistencePath, { recursive: true });
	}

	/**
	 * Save EdgeWorker state to disk (single file for all repositories).
	 *
	 * Writes to a unique temp file and atomically renames it over the real
	 * file. A partial write — the common case being ENOSPC when the disk fills
	 * — then damages only the throwaway temp file, never the last good state.
	 * This matters because {@link loadEdgeWorkerState} treats an unparseable
	 * file as "no state", so an in-place write truncated mid-JSON silently
	 * discards every session on the next restart. In router mode that strands
	 * the issue lock and affinity for every interrupted session forever, since
	 * the device no longer knows the session exists to report it terminal.
	 */
	async saveEdgeWorkerState(state: SerializableEdgeWorkerState): Promise<void> {
		const stateFile = this.getEdgeWorkerStateFilePath();
		// Unique per write (pid + counter): overlapping saves must not share a
		// temp path. Same directory as the target so the rename stays on one
		// filesystem and is therefore atomic.
		const tempFile = `${stateFile}.${process.pid}.${tempFileCounter++}.tmp`;
		try {
			await this.ensurePersistenceDirectory();
			const stateData = {
				version: PERSISTENCE_VERSION,
				savedAt: new Date().toISOString(),
				state,
			};
			await writeFile(tempFile, JSON.stringify(stateData, null, 2), "utf8");
			await rename(tempFile, stateFile);
		} catch (error) {
			// Best-effort cleanup: a failed write (e.g. ENOSPC) may leave the
			// temp file behind. Don't let its removal mask the original error.
			await unlink(tempFile).catch(() => {});
			this.logger.error("Failed to save EdgeWorker state:", error);
			throw error;
		}
	}

	/**
	 * Load EdgeWorker state from disk (single file for all repositories)
	 * Automatically migrates from v2.0 to v3.0 format if needed.
	 */
	async loadEdgeWorkerState(): Promise<SerializableEdgeWorkerState | null> {
		try {
			const stateFile = this.getEdgeWorkerStateFilePath();
			if (!existsSync(stateFile)) {
				return null;
			}

			const raw = await readFile(stateFile, "utf8");
			// `state` is an opaque blob whose real shape depends on `version`; the
			// migration branches below narrow it with explicit casts.
			let stateData: { version?: string; state?: unknown };
			try {
				stateData = JSON.parse(raw);
			} catch (parseError) {
				// A corrupt file (historically: an in-place write truncated by
				// ENOSPC) must not be silently treated as "no state" — that
				// discards every session and, in router mode, strands their
				// locks. Preserve it for diagnosis instead of overwriting it on
				// the next save, and surface the loss loudly.
				await this.preserveCorruptStateFile(stateFile);
				this.logger.error(
					"EdgeWorker state file is corrupt and could not be parsed; " +
						"preserved a copy alongside it. Starting with empty state.",
					parseError instanceof Error
						? parseError
						: new Error(String(parseError)),
				);
				return null;
			}

			// Validate state structure exists
			if (!stateData.state) {
				this.logger.warn("Invalid state file (missing state), ignoring");
				return null;
			}

			// Handle version migration
			if (stateData.version === "2.0") {
				this.logger.info("Migrating state from v2.0 to v3.0 to v4.0");
				const v3State = this.migrateV2ToV3(
					stateData.state as V3SerializableEdgeWorkerState,
				);
				const migratedState = this.migrateV3ToV4(v3State);
				await this.saveEdgeWorkerState(migratedState);
				this.logger.info(
					`Migration complete, saved as v${PERSISTENCE_VERSION}`,
				);
				return migratedState;
			}

			if (stateData.version === "3.0") {
				this.logger.info("Migrating state from v3.0 to v4.0");
				const migratedState = this.migrateV3ToV4(
					stateData.state as V3SerializableEdgeWorkerState,
				);
				await this.saveEdgeWorkerState(migratedState);
				this.logger.info(
					`Migration complete, saved as v${PERSISTENCE_VERSION}`,
				);
				return migratedState;
			}

			if (stateData.version !== PERSISTENCE_VERSION) {
				this.logger.warn(
					`Unknown state file version ${stateData.version}, ignoring`,
				);
				return null;
			}

			return stateData.state as SerializableEdgeWorkerState;
		} catch (error) {
			this.logger.error("Failed to load EdgeWorker state:", error);
			return null;
		}
	}

	/**
	 * Move a corrupt state file aside so the next save doesn't overwrite the
	 * evidence and an operator can inspect what was lost. Best-effort: if the
	 * rename fails the caller still proceeds with empty state.
	 */
	private async preserveCorruptStateFile(stateFile: string): Promise<void> {
		const backup = `${stateFile}.corrupt-${Date.now()}`;
		try {
			await rename(stateFile, backup);
			this.logger.warn(`Preserved corrupt state file as ${backup}`);
		} catch (error) {
			this.logger.error(
				"Failed to preserve corrupt state file:",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	/**
	 * Migrate v2.0 state format to v3.0 format
	 *
	 * Changes:
	 * - linearAgentActivitySessionId -> id
	 * - Add externalSessionId (set to original linearAgentActivitySessionId for Linear sessions)
	 * - Add issueContext object with trackerId, issueId, issueIdentifier
	 * - issueId becomes optional (kept for backwards compatibility)
	 * - issue becomes optional
	 */
	private migrateV2ToV3(
		v2State: V3SerializableEdgeWorkerState,
	): V3SerializableEdgeWorkerState {
		const migratedState: V3SerializableEdgeWorkerState = {
			...v2State,
			agentSessions: {},
		};

		// Migrate agent sessions
		if (v2State.agentSessions) {
			for (const [repoId, repoSessions] of Object.entries(
				v2State.agentSessions,
			)) {
				migratedState.agentSessions![repoId] = {};
				for (const [_sessionId, v2Session] of Object.entries(repoSessions)) {
					const session = v2Session as unknown as V2CyrusAgentSession;
					const migratedSession = this.migrateSessionV2ToV3(session);
					// Use the new id as the key
					migratedState.agentSessions![repoId][migratedSession.id] =
						migratedSession;
				}
			}
		}

		// agentSessionEntries keys need to be updated to use new session IDs
		// Since linearAgentActivitySessionId becomes id, the keys remain the same
		// The entries themselves don't need modification

		return migratedState;
	}

	/**
	 * Migrate v3.0 state format to v4.0 format
	 *
	 * Changes:
	 * - Flatten nested {[repoId]: {[sessionId]: session}} to flat {[sessionId]: session}
	 * - Flatten nested entries similarly
	 */
	private migrateV3ToV4(
		v3State: V3SerializableEdgeWorkerState,
	): SerializableEdgeWorkerState {
		const flatSessions: Record<string, SerializedCyrusAgentSession> = {};
		const flatEntries: Record<string, SerializedCyrusAgentSessionEntry[]> = {};

		// Flatten sessions: merge all repo-keyed sessions into a single flat map
		// Preserve the repoId key as a RepositoryContext so migrated sessions
		// know which repository they belong to (instead of defaulting to [])
		if (v3State.agentSessions) {
			for (const [repoId, repoSessions] of Object.entries(
				v3State.agentSessions,
			)) {
				for (const [sessionId, session] of Object.entries(repoSessions)) {
					if (!session.repositories?.length) {
						session.repositories = [
							{
								repositoryId: repoId,
							},
						];
					}
					flatSessions[sessionId] = session;
				}
			}
		}

		// Flatten entries similarly
		if (v3State.agentSessionEntries) {
			for (const repoEntries of Object.values(v3State.agentSessionEntries)) {
				for (const [sessionId, entries] of Object.entries(repoEntries)) {
					flatEntries[sessionId] = entries;
				}
			}
		}

		// Migrate issueRepositoryCache from old Record<string, string> to Record<string, string[]>
		let migratedCache: Record<string, string[]> | undefined;
		if (v3State.issueRepositoryCache) {
			migratedCache = {};
			for (const [issueId, repoId] of Object.entries(
				v3State.issueRepositoryCache,
			)) {
				migratedCache[issueId] = [repoId];
			}
		}

		return {
			agentSessions: flatSessions,
			agentSessionEntries: flatEntries,
			childToParentAgentSession: v3State.childToParentAgentSession,
			issueRepositoryCache: migratedCache,
		};
	}

	/**
	 * Migrate a single session from v2.0 to v3.0 format
	 */
	private migrateSessionV2ToV3(
		v2Session: V2CyrusAgentSession,
	): SerializedCyrusAgentSession {
		// Build issueContext from v2.0 fields
		const issueContext: IssueContext = {
			trackerId: "linear", // v2.0 only supported Linear
			issueId: v2Session.issueId,
			issueIdentifier: v2Session.issue?.identifier || v2Session.issueId,
		};

		return {
			// New field: rename linearAgentActivitySessionId to id
			id: v2Session.linearAgentActivitySessionId,
			// New field: store the original Linear session ID as externalSessionId
			externalSessionId: v2Session.linearAgentActivitySessionId,
			// Preserved fields
			type: v2Session.type,
			status: v2Session.status,
			context: v2Session.context,
			createdAt: v2Session.createdAt,
			updatedAt: v2Session.updatedAt,
			workspace: v2Session.workspace,
			claudeSessionId: v2Session.claudeSessionId,
			geminiSessionId: v2Session.geminiSessionId,
			metadata: v2Session.metadata,
			// New field: structured issue context
			issueContext,
			// Kept for backwards compatibility (marked as deprecated in interface)
			issueId: v2Session.issueId,
			// Now optional
			issue: v2Session.issue,
			// New field: empty repositories for migrated sessions
			repositories: [],
		} as SerializedCyrusAgentSession;
	}

	/**
	 * Check if EdgeWorker state file exists
	 */
	hasStateFile(): boolean {
		return existsSync(this.getEdgeWorkerStateFilePath());
	}

	/**
	 * Delete EdgeWorker state file
	 */
	async deleteStateFile(): Promise<void> {
		try {
			const stateFile = this.getEdgeWorkerStateFilePath();
			if (existsSync(stateFile)) {
				await writeFile(stateFile, "", "utf8"); // Clear file instead of deleting
			}
		} catch (error) {
			this.logger.error("Failed to delete EdgeWorker state file:", error);
		}
	}

	/**
	 * Convert Map to Record for serialization
	 */
	static mapToRecord<T>(map: Map<string, T>): Record<string, T> {
		return Object.fromEntries(map.entries());
	}

	/**
	 * Convert Record to Map for deserialization
	 */
	static recordToMap<T>(record: Record<string, T>): Map<string, T> {
		return new Map(Object.entries(record));
	}

	/**
	 * Convert Set to Array for serialization
	 */
	static setToArray<T>(set: Set<T>): T[] {
		return Array.from(set);
	}

	/**
	 * Convert Array to Set for deserialization
	 */
	static arrayToSet<T>(array: T[]): Set<T> {
		return new Set(array);
	}
}
