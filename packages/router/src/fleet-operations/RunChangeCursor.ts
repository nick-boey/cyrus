import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
	decodeRunChangeCursor,
	decodeRunPageCursor,
	encodeRunChangeCursor,
	encodeRunPageCursor,
} from "cyrus-operator-protocol";

/**
 * The opaque resume points `/api/v1/runs` and `/api/v1/run-changes` hand out,
 * and the rules for refusing one.
 *
 * A cursor is not a convenience here — it is the only thing standing between a
 * reconnecting client and a silently wrong answer. Three failures are possible
 * and all three are indistinguishable to a client that is handed an empty
 * success:
 *
 *  1. The cursor came from a DIFFERENT query. Resuming would page through one
 *     filter's positions against another filter's result set, skipping runs
 *     that were never in the first set and repeating ones that were.
 *  2. The cursor came from a PREVIOUS router process. `change_id` is a local
 *     SQLite AUTOINCREMENT and the router's database lives on ephemeral storage
 *     with a periodic Blob restore, so the sequence can move backwards; a stale
 *     cursor would then replay entries the client has already consumed as
 *     though they were new.
 *  3. The cursor was HAND-CRAFTED. Positions are not secrets, but a client that
 *     assembles its own lands in the middle of a stream the router never
 *     promised, and every later bug reads as a router fault.
 *
 * So each is a distinct, actionable answer: `400` for (1) and (3) — fix the
 * request — and `410 Gone` for (2), which tells the client to re-list and
 * resume rather than to keep polling a position that no longer exists.
 */

/**
 * Why a cursor was refused, carrying the status the route sends.
 *
 * `410` is separated from `400` deliberately: a client can recover from a lost
 * stream on its own (re-list, resume from the fresh cursor) but cannot recover
 * from a malformed or mismatched one without changing what it sends.
 */
export class RunCursorError extends Error {
	constructor(
		readonly status: 400 | 410,
		readonly code: "invalid_cursor" | "cursor_query_mismatch" | "stream_gone",
		message: string,
	) {
		super(message);
		this.name = "RunCursorError";
	}
}

/** A position in the paginated run listing: the last run the client received. */
export interface RunPagePosition {
	startedMs: number;
	runId: string;
}

/**
 * Separates the signed payload from its tag. Not base64url, so it cannot occur
 * inside either half — the whole string is base64url-encoded once more by the
 * protocol's own cursor helpers before it reaches a client.
 */
const TAG_SEPARATOR = "~";

/**
 * Mints and validates the two cursor families.
 *
 * One codec per router process, but its signing key is DURABLE — supplied by
 * `RouterStore.getOrCreateSecret` — while the stream epoch rotates on every
 * construction. That split is what lets the two failures be told apart: the
 * signature answers "did this router issue the cursor", the epoch answers "was
 * it this process". A per-process key collapses both into one check, and the
 * router can then only answer a forgery and a genuine restart identically.
 */
export class RunCursorCodec {
	private readonly secret: Buffer;

	constructor(
		/**
		 * Identifies this process's view of the change sequence. Supplied by
		 * `RouterStore`, which owns the sequence the epoch qualifies — a codec
		 * minting its own would be asserting a continuity it cannot observe.
		 */
		readonly streamEpoch: string,
		/**
		 * Durable HMAC key. Falls back to a per-process one so a test — or a
		 * router assembled without a store — still works; production always passes
		 * the stored value, because without it a hand-crafted cursor is reported as
		 * a restart.
		 */
		secret?: Buffer,
	) {
		this.secret = secret ?? randomBytes(32);
	}

	/**
	 * A stable digest of everything that must not change between two pages.
	 *
	 * The principal's authorization scope is folded in alongside the filters, and
	 * that is the part worth being explicit about: without it, a cursor minted
	 * for one operator would validate for another, and the second operator would
	 * resume paging through positions computed over the first operator's
	 * workspaces. Sorted keys, and `undefined` entries dropped, so an absent
	 * filter and an unspecified one fingerprint identically.
	 */
	fingerprint(query: Record<string, unknown>): string {
		const canonical = Object.entries(query)
			.filter(([, value]) => value !== undefined)
			.map(
				([key, value]) =>
					[key, Array.isArray(value) ? [...value].sort() : value] as const,
			)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return createHmac("sha256", this.secret)
			.update(JSON.stringify(canonical))
			.digest("base64url")
			.slice(0, 22);
	}

	encodeChangeCursor(lastChangeId: number, fingerprint: string): string {
		return encodeRunChangeCursor({
			streamEpoch: this.streamEpoch,
			sequence: this.sign(`${lastChangeId}:${fingerprint}`),
		});
	}

	/**
	 * @throws {RunCursorError} `410` when the cursor predates this process,
	 * `400` when it is malformed, forged, or belongs to a different query.
	 */
	decodeChangeCursor(cursor: string, fingerprint: string): number {
		let decoded: { streamEpoch: string; sequence: string };
		try {
			decoded = decodeRunChangeCursor(cursor);
		} catch {
			throw new RunCursorError(
				400,
				"invalid_cursor",
				"Malformed change cursor",
			);
		}
		// Signature FIRST, epoch second, and the order is load-bearing. The key is
		// durable, so passing verification proves this router issued the cursor —
		// which leaves the epoch check meaning exactly one thing, a restart, and
		// makes `410` a reliable "re-list and resume". Checking the epoch first
		// (which a per-process key forced) answered a hand-crafted cursor as
		// though the router had restarted.
		const payload = this.verify(decoded.sequence);
		this.assertEpoch(decoded.streamEpoch);
		const [rawChangeId, cursorFingerprint] = splitOnce(payload, ":");
		const lastChangeId = Number(rawChangeId);
		if (!Number.isSafeInteger(lastChangeId) || lastChangeId < 0) {
			throw new RunCursorError(
				400,
				"invalid_cursor",
				"Malformed change cursor",
			);
		}
		this.assertFingerprint(cursorFingerprint, fingerprint);
		return lastChangeId;
	}

	encodePageCursor(position: RunPagePosition, fingerprint: string): string {
		return encodeRunPageCursor(
			this.sign(
				`${this.streamEpoch}:${position.startedMs}:${fingerprint}:${position.runId}`,
			),
		);
	}

	/**
	 * @throws {RunCursorError} on the same three conditions as
	 * {@link decodeChangeCursor}.
	 *
	 * A page cursor is keyset-based on `(started_ms, run_id)` and would survive a
	 * restart on its own, but it is still epoch-bound so that a client sees ONE
	 * recovery story across both routes: `410` always means re-list, whichever
	 * cursor it presented.
	 */
	decodePageCursor(cursor: string, fingerprint: string): RunPagePosition {
		let position: string;
		try {
			position = decodeRunPageCursor(cursor).position;
		} catch {
			throw new RunCursorError(400, "invalid_cursor", "Malformed page cursor");
		}
		// Verified before anything is read out of it — see `decodeChangeCursor`.
		const [epoch, afterEpoch] = splitOnce(this.verify(position), ":");
		this.assertEpoch(epoch);
		const [rawStartedMs, remainder] = splitOnce(afterEpoch, ":");
		// The run id is taken LAST and left un-split, so an id containing the
		// separator cannot shift the fields ahead of it.
		const [cursorFingerprint, runId] = splitOnce(remainder, ":");
		const startedMs = Number(rawStartedMs);
		if (!Number.isSafeInteger(startedMs) || runId.length === 0) {
			throw new RunCursorError(400, "invalid_cursor", "Malformed page cursor");
		}
		this.assertFingerprint(cursorFingerprint, fingerprint);
		return { startedMs, runId };
	}

	private assertEpoch(epoch: string): void {
		if (epoch !== this.streamEpoch) {
			throw new RunCursorError(
				410,
				"stream_gone",
				"The cursor belongs to a previous stream epoch",
			);
		}
	}

	private assertFingerprint(cursorValue: string, expected: string): void {
		if (cursorValue !== expected) {
			throw new RunCursorError(
				400,
				"cursor_query_mismatch",
				"The cursor was issued for a different query",
			);
		}
	}

	private sign(payload: string): string {
		const tag = createHmac("sha256", this.secret)
			.update(payload)
			.digest("base64url");
		return `${payload}${TAG_SEPARATOR}${tag}`;
	}

	private verify(signed: string): string {
		const separator = signed.lastIndexOf(TAG_SEPARATOR);
		if (separator < 0) {
			throw new RunCursorError(400, "invalid_cursor", "Unsigned cursor");
		}
		const payload = signed.slice(0, separator);
		const presented = Buffer.from(signed.slice(separator + 1), "base64url");
		const expected = createHmac("sha256", this.secret).update(payload).digest();
		if (
			presented.length !== expected.length ||
			!timingSafeEqual(presented, expected)
		) {
			throw new RunCursorError(
				400,
				"invalid_cursor",
				"Cursor signature failed",
			);
		}
		return payload;
	}
}

/** Splits on the FIRST separator, so only the tail may contain more of them. */
function splitOnce(value: string, separator: string): [string, string] {
	const index = value.indexOf(separator);
	return index < 0
		? [value, ""]
		: [value.slice(0, index), value.slice(index + separator.length)];
}
