import {
	AgentActivityContentType,
	type IIssueTrackerService,
} from "cyrus-core";
import {
	RPC_METHODS,
	type RpcRequestFrame,
	type RpcResponseFrame,
	SESSION_SCOPED_RPC_METHODS,
} from "cyrus-router-protocol";
import type { RouterStore } from "./RouterStore.js";

/** 20 MiB — default ceiling for token-authenticated attachment downloads. */
const DEFAULT_ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * Reflective view of an {@link IIssueTrackerService} as a name→method table.
 * The single sanctioned `as unknown as` cast in this package: RPC methods are
 * dispatched by name (validated against {@link RPC_METHODS} first), which the
 * structural interface type cannot express. Kept localized to
 * {@link LinearExecutor.dispatch}.
 */
type TrackerMethodTable = Record<
	string,
	(...args: unknown[]) => Promise<unknown>
>;

/** Result of a token-authenticated attachment download (router extension). */
export interface DownloadedAttachment {
	base64: string;
	contentType: string;
}

export interface LinearExecutorOptions {
	/** workspaceId → issue-tracker service. */
	trackers: Map<string, IIssueTrackerService>;
	store: RouterStore;
	/**
	 * workspaceId → Linear access token, used only to authenticate
	 * `downloadAttachment` fetches (a router extension, not a tracker method).
	 * Extends the brief's stated constructor: the token cannot be recovered from
	 * the tracker instance, so it must be threaded in explicitly.
	 */
	workspaceTokens?: Map<string, string>;
	/** Reject attachment bodies larger than this. Defaults to 20 MiB. */
	attachmentMaxBytes?: number;
}

/**
 * Dispatches device RPC frames to the correct per-workspace
 * {@link IIssueTrackerService}, enforcing method allowlisting, workspace
 * selection, session-scoped authorization, and mutation idempotency. All tracker
 * errors are converted into `{ ok: false, error }` responses — a thrown
 * exception must never cross the device socket.
 */
export class LinearExecutor {
	private readonly trackers: Map<string, IIssueTrackerService>;
	private readonly store: RouterStore;
	private readonly workspaceTokens: Map<string, string>;
	private readonly attachmentMaxBytes: number;

	constructor(opts: LinearExecutorOptions) {
		this.trackers = opts.trackers;
		this.store = opts.store;
		this.workspaceTokens = opts.workspaceTokens ?? new Map();
		this.attachmentMaxBytes =
			opts.attachmentMaxBytes ?? DEFAULT_ATTACHMENT_MAX_BYTES;
	}

	async dispatch(
		deviceId: number,
		frame: RpcRequestFrame,
	): Promise<RpcResponseFrame> {
		const { id, method, params, mutationId } = frame;

		// Outer guard: dispatch must NEVER reject. A store/DB throw, a corrupt
		// cached-mutation row (JSON.parse), a tracker error, or an unparseable
		// attachment url all resolve to an `{ ok:false }` response frame — nothing
		// may cross the device socket as an unhandled rejection. The pre-invoke
		// steps (getMutation/JSON.parse, trackers.get, getSessionAffinity) live
		// INSIDE this try for exactly that reason.
		try {
			// 1. Allowlist: never invoke a method the device isn't permitted to call.
			if (!(RPC_METHODS as readonly string[]).includes(method)) {
				return fail(id, "method not allowed");
			}

			// 2. Idempotent replay: a previously-recorded mutation returns its stored
			//    response verbatim WITHOUT re-invoking the tracker (safe buffer replay
			//    after a reconnect — no duplicate activities/comments).
			if (mutationId !== undefined) {
				const cached = this.store.getMutation(deviceId, mutationId);
				if (cached !== undefined) {
					return JSON.parse(cached) as RpcResponseFrame;
				}
			}

			// 3. Every RPC's first positional param is the workspaceId (prepended by
			//    the client). Pop it to select the tracker.
			const [workspaceId, ...rest] = params;
			if (typeof workspaceId !== "string") {
				return fail(id, "missing workspaceId");
			}
			const tracker = this.trackers.get(workspaceId);
			if (!tracker) {
				return fail(id, `unknown workspace: ${workspaceId}`);
			}

			// 4. Session-scoped authorization: the target session must belong to the
			//    calling device.
			if ((SESSION_SCOPED_RPC_METHODS as readonly string[]).includes(method)) {
				const sessionId = extractSessionId(method, rest);
				if (
					sessionId === undefined ||
					this.store.getSessionAffinity(sessionId) !== deviceId
				) {
					return fail(id, "session not owned by this device");
				}
			}

			// 5. Invoke.
			let result: unknown;
			if (method === "downloadAttachment") {
				result = await this.downloadAttachment(workspaceId, rest);
			} else {
				// Sanctioned reflective dispatch — method already validated above.
				const table = tracker as unknown as TrackerMethodTable;
				const fn = table[method];
				if (typeof fn !== "function") {
					throw new Error(`method not implemented by tracker: ${method}`);
				}
				result = await fn(...rest);
			}
			const response: RpcResponseFrame = {
				type: "rpc_response",
				id,
				ok: true,
				result,
			};

			// 6. Record the successful mutation before responding so a replay hits
			//    the cache in step 2.
			if (mutationId !== undefined) {
				this.store.recordMutation(
					deviceId,
					mutationId,
					JSON.stringify(response),
					Date.now(),
				);
			}

			return response;
		} catch (err) {
			return fail(id, err instanceof Error ? err.message : String(err));
		}
	}

	/**
	 * Posts a plain-text thought activity to a session (used by the
	 * {@link EventRouter} for offline/expiry/enrollment notices). A no-op when the
	 * workspace has no configured tracker (e.g. a router restart lost the
	 * session→workspace hint used by the stale-lock sweep).
	 */
	async postActivity(
		workspaceId: string,
		agentSessionId: string,
		body: string,
	): Promise<void> {
		const tracker = this.trackers.get(workspaceId);
		if (!tracker) return;
		await tracker.createAgentActivity({
			agentSessionId,
			content: { type: AgentActivityContentType.Thought, body },
		});
	}

	/**
	 * Router extension (not an {@link IIssueTrackerService} method): fetches an
	 * attachment and returns its bytes as base64. Rejects bodies larger than
	 * {@link attachmentMaxBytes}.
	 *
	 * SECURITY: the `url` is fully device-controlled, so the workspace's Linear
	 * OAuth token is attached ONLY when the target is a Linear-owned https host
	 * (see {@link isLinearAttachmentHost}). Every other host — including plain
	 * http and lookalike domains — is fetched WITHOUT the Authorization header, so
	 * an enrolled device can never coerce the router into exfiltrating the token
	 * (which has broader scope than the allowlisted RPC methods and survives
	 * device revocation). External images pasted into issues still download; they
	 * just don't need the credential.
	 */
	private async downloadAttachment(
		workspaceId: string,
		rest: unknown[],
	): Promise<DownloadedAttachment> {
		const url = rest[0];
		if (typeof url !== "string") {
			throw new Error("downloadAttachment requires a url");
		}
		// Parse first: an unparseable device-supplied url resolves to an
		// `{ ok:false }` frame via dispatch's outer catch (never thrown across the
		// socket), and a url we can't parse is definitionally not a Linear host.
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			throw new Error("invalid attachment url");
		}
		const token = this.workspaceTokens.get(workspaceId);
		const sendToken =
			token !== undefined &&
			parsed.protocol === "https:" &&
			isLinearAttachmentHost(parsed.hostname);
		const headers: Record<string, string> = sendToken
			? { Authorization: `Bearer ${token}` }
			: {};
		const res = await fetch(url, { headers });
		if (!res.ok) {
			throw new Error(`attachment download failed: HTTP ${res.status}`);
		}
		// Early reject on the advertised size before buffering the whole body.
		const declared = res.headers.get("content-length");
		if (declared !== null && Number(declared) > this.attachmentMaxBytes) {
			throw new Error(
				`attachment exceeds max size ${this.attachmentMaxBytes} bytes`,
			);
		}
		// TODO: when content-length is absent we still buffer the entire body via
		// arrayBuffer() before enforcing the cap below, so a response that omits (or
		// lies about) content-length can transiently allocate more than
		// attachmentMaxBytes. A streaming Response.body reader that aborts once the
		// running byte total exceeds the cap would bound peak memory; deferred as a
		// non-critical hardening since the post-buffer check still rejects the
		// result and downloads are size-capped end to end.
		const buffer = Buffer.from(await res.arrayBuffer());
		if (buffer.byteLength > this.attachmentMaxBytes) {
			throw new Error(
				`attachment exceeds max size ${this.attachmentMaxBytes} bytes`,
			);
		}
		const contentType =
			res.headers.get("content-type") ?? "application/octet-stream";
		return { base64: buffer.toString("base64"), contentType };
	}
}

/**
 * Host allowlist for attachment downloads that may carry the workspace's Linear
 * OAuth token. Returns true only for Linear-owned hosts.
 *
 * The `.linear.app` suffix check KEEPS THE LEADING DOT so lookalike domains are
 * rejected: `evil-linear.app` does not end with `.linear.app`, and
 * `uploads.linear.app.attacker.com` ends with `.attacker.com`. The explicit
 * `uploads.linear.app` equality is redundant with the suffix check but named for
 * clarity — it is the canonical Linear attachment CDN host.
 */
function isLinearAttachmentHost(hostname: string): boolean {
	return hostname === "uploads.linear.app" || hostname.endsWith(".linear.app");
}

function fail(id: string, error: string): RpcResponseFrame {
	return { type: "rpc_response", id, ok: false, error };
}

/**
 * Extracts the session id a session-scoped method operates on, from the params
 * remaining AFTER the workspaceId has been popped:
 *  - `createAgentActivity(input)` → `input.agentSessionId`
 *  - `emitStopSignalEvent(sessionId)` → `sessionId`
 */
function extractSessionId(method: string, rest: unknown[]): string | undefined {
	if (method === "createAgentActivity") {
		const input = rest[0];
		if (input && typeof input === "object" && "agentSessionId" in input) {
			const value = (input as { agentSessionId: unknown }).agentSessionId;
			return typeof value === "string" ? value : undefined;
		}
		return undefined;
	}
	if (method === "emitStopSignalEvent") {
		const value = rest[0];
		return typeof value === "string" ? value : undefined;
	}
	return undefined;
}
