import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Default cap on how long a single bundle upload request may take. Without
 * this, a reachable-but-blackholed router hangs `fetch` until the OS TCP
 * timeout (minutes) — which, since this runs in the persistence floor's hot
 * path (session end + every periodic tick), can stall the whole caller far
 * longer than intended.
 *
 * NOTE: `AbortSignal.timeout()` is a *total request* deadline, not an idle
 * timeout — it aborts a transfer that is still making progress just as
 * readily as one that's genuinely stuck. 30s was sized for "is the router
 * even reachable", not for how long a real bundle (Claude transcripts for a
 * whole session, potentially many MB) actually takes to move over a modest
 * link. A failed *upload* is low-stakes — the next periodic tick just
 * retries with a fresh bundle — so this stays a fairly short "fail fast and
 * retry" budget rather than trying to cover every possible bundle size.
 * Callers can override via the `timeoutMs` param.
 */
const DEFAULT_UPLOAD_TIMEOUT_MS = 2 * 60_000;

/**
 * Default cap on how long a single bundle *download* request may take. This
 * is the container **restore** path: a failed download starts the container
 * with NO prior context at all — exactly the failure the persistence floor
 * exists to prevent — whereas a failed upload just retries on the next tick.
 * So this budget is substantially larger than {@link DEFAULT_UPLOAD_TIMEOUT_MS},
 * generous enough that a large bundle over a slow-but-progressing connection
 * is never aborted mid-transfer. Callers can override via the `timeoutMs`
 * param when they know more about expected bundle size / link speed.
 */
const DEFAULT_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_TEARDOWN_TIMEOUT_MS = 30_000;

export async function uploadBundle(
	httpBase: string,
	deviceToken: string,
	issueKey: string,
	bundleFile: string,
	timeoutMs: number = DEFAULT_UPLOAD_TIMEOUT_MS,
): Promise<void> {
	const body = await readFile(bundleFile);
	const res = await fetch(`${httpBase}/artifacts/issues/${issueKey}/bundle`, {
		method: "PUT",
		headers: {
			authorization: `Bearer ${deviceToken}`,
			"content-type": "application/gzip",
		},
		body,
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) throw new Error(`bundle upload failed: HTTP ${res.status}`);
}

export async function downloadBundle(
	httpBase: string,
	deviceToken: string,
	issueKey: string,
	destFile: string,
	timeoutMs: number = DEFAULT_DOWNLOAD_TIMEOUT_MS,
): Promise<boolean> {
	const res = await fetch(`${httpBase}/artifacts/issues/${issueKey}/bundle`, {
		headers: { authorization: `Bearer ${deviceToken}` },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (res.status === 404) return false;
	if (!res.ok) throw new Error(`bundle download failed: HTTP ${res.status}`);
	mkdirSync(dirname(destFile), { recursive: true });
	await writeFile(destFile, Buffer.from(await res.arrayBuffer()));
	return true;
}

/** Header carrying the callback's stable idempotency key. */
export const TEARDOWN_IDEMPOTENCY_HEADER = "x-cyrus-teardown-id";

/**
 * A `teardown-complete` callback the router did not accept.
 *
 * `retryable` splits the two cases a caller must treat differently:
 *  - `true`  — the router is unreachable, overloaded, or its destroy failed
 *              (5xx). Replaying the SAME idempotency key later is safe and is
 *              the whole point of the device-side durable queue.
 *  - `false` — the router positively rejected this callback (bad/revoked token,
 *              wrong issue, malformed key). No amount of retrying changes that,
 *              so the caller should stop and let the router's grace deadline
 *              run the destroy instead.
 */
export class TeardownCallbackError extends Error {
	readonly status: number | undefined;
	readonly retryable: boolean;

	constructor(message: string, status: number | undefined, retryable: boolean) {
		super(message);
		this.name = "TeardownCallbackError";
		this.status = status;
		this.retryable = retryable;
	}
}

/** 4xx statuses that mean "the router will never accept this callback". */
const FATAL_TEARDOWN_STATUSES = new Set([400, 401, 403, 404]);

export async function postTeardownComplete(
	httpBase: string,
	deviceToken: string,
	issueKey: string,
	opts: { idempotencyKey?: string; timeoutMs?: number } = {},
): Promise<void> {
	const timeoutMs = opts.timeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
	let res: Response;
	try {
		res = await fetch(
			`${httpBase}/containers/issues/${issueKey}/teardown-complete`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${deviceToken}`,
					// Stable across replays so the router can tell a retry of the
					// same logical callback from a fresh one, and log it as such.
					...(opts.idempotencyKey
						? { [TEARDOWN_IDEMPOTENCY_HEADER]: opts.idempotencyKey }
						: {}),
				},
				signal: AbortSignal.timeout(timeoutMs),
			},
		);
	} catch (error) {
		// Network failure / timeout: the router may well have processed the
		// request, but we can't know, so this is retryable by the same key.
		throw new TeardownCallbackError(
			`teardown-complete callback failed: ${String(error)}`,
			undefined,
			true,
		);
	}
	if (!res.ok) {
		throw new TeardownCallbackError(
			`teardown-complete callback failed: HTTP ${res.status}`,
			res.status,
			!FATAL_TEARDOWN_STATUSES.has(res.status),
		);
	}
}
