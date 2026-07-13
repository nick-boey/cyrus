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
		const res = await fastify.inject({
			method: "GET",
			url: "/artifacts/issues/CYPACK-2/bundle",
			headers: { authorization: `Bearer ${token}` },
		});
		expect(res.statusCode).toBe(404);
	});
});
