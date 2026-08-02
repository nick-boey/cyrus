import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerArtifactsRoute } from "../src/artifacts.js";
import { RouterStore } from "../src/RouterStore.js";

describe("artifact endpoints", () => {
	let fastify: ReturnType<typeof Fastify>;
	let store: RouterStore;
	let token: string;

	beforeEach(async () => {
		store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "a@example.com" });
		({ deviceToken: token } = store.createContainerDevice(
			userId,
			"CYPACK-1",
			"docker",
		));
		fastify = Fastify();
		registerArtifactsRoute(
			fastify,
			store,
			mkdtempSync(join(tmpdir(), "artifacts-")),
		);
		await fastify.ready();
	});
	afterEach(async () => {
		await fastify.close();
		store.close();
	});

	const put = (issueKey: string, auth?: string) =>
		fastify.inject({
			method: "PUT",
			url: `/artifacts/issues/${issueKey}/bundle`,
			headers: {
				"content-type": "application/gzip",
				...(auth ? { authorization: auth } : {}),
			},
			payload: Buffer.from("fake-gzip-bytes"),
		});

	it("round-trips a bundle with a valid device token", async () => {
		expect((await put("CYPACK-1", `Bearer ${token}`)).statusCode).toBe(200);
		const res = await fastify.inject({
			method: "GET",
			url: "/artifacts/issues/CYPACK-1/bundle",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.statusCode).toBe(200);
		expect(res.rawPayload.toString()).toBe("fake-gzip-bytes");
	});

	it("rejects missing/invalid tokens with 401", async () => {
		expect((await put("CYPACK-1")).statusCode).toBe(401);
		expect((await put("CYPACK-1", "Bearer nope")).statusCode).toBe(401);
	});

	it("rejects path-traversal issue keys with 400", async () => {
		expect((await put("..%2F..%2Fetc", `Bearer ${token}`)).statusCode).toBe(
			400,
		);
	});

	it("404s for a bundle that was never uploaded", async () => {
		// Must query the token's OWN issue (CYPACK-1, per beforeEach) — under
		// the new issue-scoped authorization, querying a different issue
		// (e.g. CYPACK-2) now correctly 403s regardless of whether a bundle
		// exists there, which is covered separately below.
		const res = await fastify.inject({
			method: "GET",
			url: "/artifacts/issues/CYPACK-1/bundle",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.statusCode).toBe(404);
	});

	it("rejects a container device touching a different issue's bundle with 403, not 404", async () => {
		// A second container device, owned by a different user, scoped to a
		// different issue. It has a real bundle of its own — proving the 403
		// below is a genuine authorization rejection, not just this issue
		// happening to have nothing uploaded yet.
		const { userId: otherUserId } = store.addUser({ email: "b@example.com" });
		const { deviceToken: otherToken } = store.createContainerDevice(
			otherUserId,
			"CYPACK-2",
			"docker",
		);
		expect((await put("CYPACK-2", `Bearer ${otherToken}`)).statusCode).toBe(
			200,
		);

		// CYPACK-1's container token must not be able to touch CYPACK-2's bundle.
		const putRes = await put("CYPACK-2", `Bearer ${token}`);
		expect(putRes.statusCode).toBe(403);
		expect(putRes.statusCode).not.toBe(404);

		const getRes = await fastify.inject({
			method: "GET",
			url: "/artifacts/issues/CYPACK-2/bundle",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(getRes.statusCode).toBe(403);
		expect(getRes.statusCode).not.toBe(404);

		// And the reverse: CYPACK-2's token must not touch CYPACK-1's bundle.
		const crossRes = await put("CYPACK-1", `Bearer ${otherToken}`);
		expect(crossRes.statusCode).toBe(403);
		expect(crossRes.statusCode).not.toBe(404);
	});

	it("lets a physical (non-container) device token PUT and GET any issue's bundle", async () => {
		// Enrolled via the same store's enrollment path used elsewhere
		// (RouterStore.test.ts), for the same user that also owns the
		// CYPACK-1 container device created in beforeEach — physical and
		// container devices coexist for one user by design.
		const code = store.mintEnrollmentCode("a@example.com", Date.now());
		const enrolled = store.redeemEnrollmentCode(code, Date.now());
		if (!enrolled) throw new Error("enrollment did not return a device");
		const physicalAuth = `Bearer ${enrolled.deviceToken}`;

		expect((await put("CYPACK-1", physicalAuth)).statusCode).toBe(200);
		expect((await put("CYPACK-2", physicalAuth)).statusCode).toBe(200);

		const getIssueA = await fastify.inject({
			method: "GET",
			url: "/artifacts/issues/CYPACK-1/bundle",
			headers: { authorization: physicalAuth },
		});
		expect(getIssueA.statusCode).toBe(200);

		const getIssueB = await fastify.inject({
			method: "GET",
			url: "/artifacts/issues/CYPACK-2/bundle",
			headers: { authorization: physicalAuth },
		});
		expect(getIssueB.statusCode).toBe(200);
	});

	it("rejects an unauthenticated PUT before the body reaches the parser (no buffering)", async () => {
		// A dedicated Fastify instance so we can attach a `preParsing` hook —
		// the lifecycle stage immediately before Fastify's body parser (and
		// thus before our custom application/gzip content-type parser would
		// buffer the payload) runs. If auth correctly happens in `onRequest`
		// (which runs BEFORE preParsing) and rejects the request, `preParsing`
		// must never fire. This directly exercises hook ordering rather than
		// asserting on timing or memory, which would be dishonest to claim
		// from a unit test.
		const freshFastify = Fastify();
		let preParsingHits = 0;
		freshFastify.addHook("preParsing", async (_req, _reply, payload) => {
			preParsingHits++;
			return payload;
		});
		registerArtifactsRoute(
			freshFastify,
			store,
			mkdtempSync(join(tmpdir(), "artifacts-")),
		);
		await freshFastify.ready();

		const res = await freshFastify.inject({
			method: "PUT",
			url: "/artifacts/issues/CYPACK-1/bundle",
			headers: { "content-type": "application/gzip" },
			// No authorization header at all.
			payload: Buffer.from("fake-gzip-bytes"),
		});

		expect(res.statusCode).toBe(401);
		expect(preParsingHits).toBe(0);

		await freshFastify.close();
	});

	it("never corrupts a bundle when two concurrent PUTs target the same issue", async () => {
		// Regression guard for a race introduced when the tmp-file+rename dance
		// moved from Sync fs calls to async fs/promises calls. With the *Sync*
		// variants, Node's single-threaded blocking execution made two same-
		// issueKey PUTs mutually exclusive by accident (the whole sequence ran
		// with no yield point). The async conversion introduced yield points
		// at every `await`, so if the tmp path were shared (the old
		// `${dest}.tmp`), two concurrent PUTs to the SAME issueKey could
		// interleave writes to that one file — producing a corrupted or
		// truncated bundle after rename. This is reachable in normal
		// operation: a physical device's floor-sync can overlap the owning
		// container's flush for the same issue.
		//
		// Each payload is several hundred KB of a single repeated byte so
		// that any interleaving (a naive shared-tmp implementation writing
		// buffer A then buffer B into the same fd, or truncating mid-write)
		// would produce a result that is neither payload exactly — bytes
		// from one pattern where the other should be, or a length that
		// matches neither. We assert the retrieved bytes exactly equal ONE
		// of the two payloads in full: never a mixture, never truncated.
		const size = 500 * 1024;
		const payloadA = Buffer.alloc(size, 0xaa);
		const payloadB = Buffer.alloc(size, 0xbb);

		const putBuffer = (payload: Buffer) =>
			fastify.inject({
				method: "PUT",
				url: "/artifacts/issues/CYPACK-1/bundle",
				headers: {
					"content-type": "application/gzip",
					authorization: `Bearer ${token}`,
				},
				payload,
			});

		const [resA, resB] = await Promise.all([
			putBuffer(payloadA),
			putBuffer(payloadB),
		]);
		expect(resA.statusCode).toBe(200);
		expect(resB.statusCode).toBe(200);

		const getRes = await fastify.inject({
			method: "GET",
			url: "/artifacts/issues/CYPACK-1/bundle",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(getRes.statusCode).toBe(200);

		const finalBytes = getRes.rawPayload;
		const matchesA = finalBytes.equals(payloadA);
		const matchesB = finalBytes.equals(payloadB);
		expect(matchesA || matchesB).toBe(true);
		// Extra-explicit guard against a "close but not quite" result (wrong
		// length, or right length but mixed content) slipping past the OR
		// above due to a subtle assertion bug.
		expect(finalBytes.length).toBe(size);
	});
});
