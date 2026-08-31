import type { ILogger } from "cyrus-core";
import type { RouterStore } from "./RouterStore.js";
import {
	type CodexAccountStatus,
	type CodexCredential,
	CodexRefreshError,
	codexAccountStatus,
	needsRefresh,
	refreshCodexCredential,
} from "./setup/codexAuth.js";
import {
	type KeyWrapper,
	openBundle,
	type SealedBundle,
	sealBundle,
} from "./setup/envelope.js";

/**
 * Per-user Codex subscription credentials: sealed at rest on the `users` row,
 * refreshed lazily by the router, and handed to a container as a fresh
 * short-lived `auth.json` at boot.
 *
 * **Why not the per-user secret bundle** (ADR 0005): the bundle is built around
 * one writer holding a render-time ETag, with conflicts surfaced to a human,
 * and every escape hatch is closed on purpose — `putRecord` refuses
 * `If-Match: *`, and `/setup/save` refuses to retry or merge. A background
 * refresher writing there would 412 any `/setup` form a user happened to have
 * open, discarding their typed input under the message *"Your settings were
 * changed somewhere else while you were editing"*, which would be false. The
 * codebase already solved this once: `KeyVaultTokenStore` exists precisely
 * because the bundle was the wrong shape for refreshed Linear tokens.
 *
 * **Why sealed** — `users` is plaintext SQLite and `StateBackup.upload` PUTs
 * the raw `.db` file to blob storage, so an unsealed column would be a strict
 * confidentiality downgrade from the envelope-encrypted bundle. The seal reuses
 * `sealBundle`/`openBundle`, which take a {@link KeyWrapper} and an `aad`
 * string rather than an Azure Table, so they are backend-agnostic as written.
 *
 * **Refresh is lazy, at container boot, with a five-minute pre-expiry buffer** —
 * matching `GitHubAppTokenProvider`, the ACA `tokenProvider`, and the Linear
 * OAuth refresh. There is deliberately no periodic sweep: it would burn
 * refreshes (each of which rotates the token) for dormant users, and add a
 * timer whose failures need their own handling and their own user-facing story.
 */
export interface CodexTokenStoreOptions {
	store: RouterStore;
	wrapper: KeyWrapper;
	logger: ILogger;
	/** Overrides the Codex CLI's OAuth client. See ADR 0005's risk note. */
	clientId?: string;
	/** Test seams. */
	fetchFn?: typeof fetch;
	now?: () => number;
}

/** What `/setup` renders for the Codex account section. */
export interface CodexAccountView {
	status: CodexAccountStatus;
	/** When the router last minted or refreshed, for the status row. */
	updatedMs?: number;
	/** The last refresh failure, when there is one. Never a credential. */
	error?: string;
}

/**
 * The AAD binding the ciphertext to the row it lives on, so a blob copied onto
 * another user's row fails to authenticate rather than decrypting into their
 * container. Keyed by user id (the row's primary key), not email, because email
 * is mutable — a UPN rename would otherwise silently strand the credential.
 */
function codexAad(userId: number): string {
	return `codex-auth|user:${userId}|v1`;
}

export class CodexTokenStore {
	private readonly now: () => number;

	constructor(private readonly opts: CodexTokenStoreOptions) {
		this.now = opts.now ?? Date.now;
	}

	/** Seals and stores a credential, replacing any previous one. */
	async put(userId: number, credential: CodexCredential): Promise<void> {
		// `sealBundle` takes a string→string map; the credential is serialised
		// into a single member rather than spread across keys so its shape can
		// evolve without a format migration on the ciphertext.
		const sealed = await sealBundle(
			{ credential: JSON.stringify(credential) },
			this.opts.wrapper,
			codexAad(userId),
		);
		this.opts.store.setUserCodexAuth(userId, JSON.stringify(sealed));
	}

	/** Removes the stored credential. Used by the "Disconnect" control. */
	clear(userId: number): void {
		this.opts.store.setUserCodexAuth(userId, null);
	}

	/**
	 * Opens the stored credential, or `undefined` when there is none.
	 *
	 * An unreadable record — replaced KEK, tampered ciphertext, a shape from a
	 * future version — is reported as absent with an error log rather than
	 * thrown. The caller's next step either way is "this user has no usable
	 * Codex credential", and throwing here would turn a recoverable
	 * re-paste into a router-level boot exception.
	 */
	async get(userId: number): Promise<CodexCredential | undefined> {
		const raw = this.opts.store.getUserCodexAuth(userId);
		if (!raw) return undefined;
		let sealed: SealedBundle;
		try {
			sealed = JSON.parse(raw) as SealedBundle;
		} catch (error) {
			this.opts.logger.error(
				`Stored Codex credential for user ${userId} is not JSON; treating it as absent`,
				error,
			);
			return undefined;
		}
		try {
			const opened = await openBundle(
				sealed,
				this.opts.wrapper,
				codexAad(userId),
			);
			const member = opened.credential;
			if (typeof member !== "string") return undefined;
			const parsed = JSON.parse(member) as CodexCredential;
			if (
				typeof parsed?.refreshToken !== "string" ||
				typeof parsed?.accessToken !== "string"
			) {
				return undefined;
			}
			return parsed;
		} catch (error) {
			this.opts.logger.error(
				`Could not open the stored Codex credential for user ${userId}; the user must paste a fresh auth.json`,
				error,
			);
			return undefined;
		}
	}

	/** The status row, with no credential material in it. */
	async view(userId: number): Promise<CodexAccountView> {
		const credential = await this.get(userId);
		return {
			status: codexAccountStatus(credential, this.now()),
			...(credential?.updatedMs !== undefined
				? { updatedMs: credential.updatedMs }
				: {}),
			...(credential?.lastError ? { error: credential.lastError } : {}),
		};
	}

	/**
	 * Returns a live credential for the user, refreshing first when the stored
	 * access token is spent or nearly so.
	 *
	 * Returns `undefined` when the user has connected no Codex account —
	 * distinct from throwing, which means they have one and it no longer works.
	 * The caller (`ContainerTargets.buildEnv`) turns the former into "fall back
	 * to `OPENAI_API_KEY` if set, else fail the boot naming the remedy" and the
	 * latter into a failure carrying {@link CodexRefreshError.remedy}.
	 */
	async mint(userId: number): Promise<CodexCredential | undefined> {
		const stored = await this.get(userId);
		if (!stored) return undefined;
		if (!needsRefresh(stored, this.now())) return stored;

		try {
			const refreshed = await refreshCodexCredential(stored, {
				...(this.opts.clientId ? { clientId: this.opts.clientId } : {}),
				...(this.opts.fetchFn ? { fetchFn: this.opts.fetchFn } : {}),
				now: this.now,
			});
			await this.put(userId, refreshed);
			return refreshed;
		} catch (error) {
			// Persist the failure so `/setup` can show "needs attention" with the
			// real reason. Best-effort: a store failure here must not mask the
			// refresh failure the caller has to act on.
			if (error instanceof CodexRefreshError) {
				try {
					await this.put(userId, { ...stored, lastError: error.message });
				} catch (persistError) {
					this.opts.logger.warn(
						`Could not record the Codex refresh failure for user ${userId}`,
						persistError,
					);
				}
			}
			throw error;
		}
	}
}
