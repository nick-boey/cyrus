import {
	decodeRunChangeCursor,
	runChangeCursorV1Schema,
	runPageCursorV1Schema,
} from "cyrus-operator-protocol";
import { describe, expect, it } from "vitest";
import {
	RunCursorCodec,
	RunCursorError,
} from "../../src/fleet-operations/RunChangeCursor.js";

const EPOCH = "epoch-one";
const OTHER_EPOCH = "epoch-two";

/** Deterministic across two codecs, so the epoch is the only variable. */
const SECRET = Buffer.alloc(32, 7);

describe("RunCursorCodec", () => {
	const codec = () => new RunCursorCodec(EPOCH, SECRET);

	describe("change cursors", () => {
		it("round-trips a position under the same query", () => {
			const cursors = codec();
			const fingerprint = cursors.fingerprint({ workspaceIds: ["ws-a"] });

			const cursor = cursors.encodeChangeCursor(42, fingerprint);

			expect(runChangeCursorV1Schema.safeParse(cursor).success).toBe(true);
			expect(decodeRunChangeCursor(cursor).streamEpoch).toBe(EPOCH);
			expect(cursors.decodeChangeCursor(cursor, fingerprint)).toBe(42);
		});

		it("refuses a cursor issued for a different query with 400", () => {
			const cursors = codec();
			const cursor = cursors.encodeChangeCursor(
				7,
				cursors.fingerprint({ workspaceIds: ["ws-a"] }),
			);

			expect(() =>
				cursors.decodeChangeCursor(
					cursor,
					cursors.fingerprint({ workspaceIds: ["ws-b"] }),
				),
			).toThrowError(
				expect.objectContaining({
					status: 400,
					code: "cursor_query_mismatch",
				}),
			);
		});

		it("refuses a cursor from a previous router process with 410, not 400", () => {
			// A restart rotates the EPOCH and keeps the durable signing key, which
			// is what lets the router tell this apart from a forgery. Same secret,
			// different epoch.
			const before = new RunCursorCodec(OTHER_EPOCH, SECRET);
			const after = codec();
			const fingerprint = after.fingerprint({ workspaceIds: ["ws-a"] });
			const stale = before.encodeChangeCursor(
				11,
				before.fingerprint({ workspaceIds: ["ws-a"] }),
			);

			expect(() => after.decodeChangeCursor(stale, fingerprint)).toThrowError(
				expect.objectContaining({ status: 410, code: "stream_gone" }),
			);
		});

		it("refuses a cursor signed by another router with 400, not 410", () => {
			// The distinction the durable key buys: 410 must mean "re-list", so a
			// cursor this router never issued may not be reported as a restart —
			// even though it names an epoch this process does not recognise.
			const foreign = new RunCursorCodec(OTHER_EPOCH, Buffer.alloc(32, 9));
			const after = codec();
			const fingerprint = after.fingerprint({ workspaceIds: ["ws-a"] });
			const alien = foreign.encodeChangeCursor(
				11,
				foreign.fingerprint({ workspaceIds: ["ws-a"] }),
			);

			expect(() => after.decodeChangeCursor(alien, fingerprint)).toThrowError(
				expect.objectContaining({ status: 400, code: "invalid_cursor" }),
			);
		});

		it("refuses a hand-crafted cursor claiming the current epoch", () => {
			const cursors = codec();
			const fingerprint = cursors.fingerprint({ workspaceIds: ["ws-a"] });
			// Same shape, same epoch, no signature the router would recognise.
			const forged = `v1.changes.${Buffer.from(EPOCH).toString(
				"base64url",
			)}.${Buffer.from(`9999:${fingerprint}~nope`).toString("base64url")}`;

			expect(() =>
				cursors.decodeChangeCursor(forged, fingerprint),
			).toThrowError(
				expect.objectContaining({ status: 400, code: "invalid_cursor" }),
			);
		});

		it("refuses a structurally malformed cursor", () => {
			const cursors = codec();
			expect(() =>
				cursors.decodeChangeCursor("not-a-cursor", "abc"),
			).toThrowError(RunCursorError);
		});
	});

	describe("page cursors", () => {
		it("round-trips a keyset position", () => {
			const cursors = codec();
			const fingerprint = cursors.fingerprint({ workspaceIds: ["ws-a"] });
			const position = { startedMs: 1_700_000_000_000, runId: "run-1" };

			const cursor = cursors.encodePageCursor(position, fingerprint);

			expect(runPageCursorV1Schema.safeParse(cursor).success).toBe(true);
			expect(cursors.decodePageCursor(cursor, fingerprint)).toEqual(position);
		});

		it("keeps a run id containing the field separator intact", () => {
			const cursors = codec();
			const fingerprint = cursors.fingerprint({});
			const position = { startedMs: 5, runId: "run:with:colons" };

			expect(
				cursors.decodePageCursor(
					cursors.encodePageCursor(position, fingerprint),
					fingerprint,
				),
			).toEqual(position);
		});

		it("reports a restart as 410 and a changed query as 400", () => {
			const before = new RunCursorCodec(OTHER_EPOCH, SECRET);
			const after = codec();
			const stale = before.encodePageCursor(
				{ startedMs: 1, runId: "run-1" },
				before.fingerprint({}),
			);
			expect(() =>
				after.decodePageCursor(stale, after.fingerprint({})),
			).toThrowError(expect.objectContaining({ status: 410 }));

			const mine = after.encodePageCursor(
				{ startedMs: 1, runId: "run-1" },
				after.fingerprint({ lifecycle: "active" }),
			);
			expect(() =>
				after.decodePageCursor(
					mine,
					after.fingerprint({ lifecycle: "waiting" }),
				),
			).toThrowError(expect.objectContaining({ status: 400 }));
		});
	});

	describe("fingerprints", () => {
		it("ignores key order, array order, and absent filters", () => {
			const cursors = codec();
			expect(
				cursors.fingerprint({ workspaceIds: ["b", "a"], lifecycle: "active" }),
			).toBe(
				cursors.fingerprint({ lifecycle: "active", workspaceIds: ["a", "b"] }),
			);
			expect(cursors.fingerprint({ workspaceIds: ["a"] })).toBe(
				cursors.fingerprint({ workspaceIds: ["a"], runner: undefined }),
			);
		});

		it("separates two principals holding different authority", () => {
			const cursors = codec();
			expect(cursors.fingerprint({ workspaceIds: ["a"] })).not.toBe(
				cursors.fingerprint({ workspaceIds: ["a", "b"] }),
			);
		});
	});
});
