import { CLIIssueTrackerService } from "cyrus-core";
import { afterEach, describe, expect, it } from "vitest";
import { RouterServer } from "../src/RouterServer.js";

function makeServer(): RouterServer {
	return new RouterServer({
		port: 0,
		dbPath: ":memory:",
		workspaces: { "ws-1": { linearToken: "test-token" } },
		webhook: { verificationMode: "direct", secret: "test-secret" },
		trackerFactory: () => new CLIIssueTrackerService(),
	});
}

describe("RouterServer /enroll", () => {
	let server: RouterServer | undefined;

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = undefined;
		}
	});

	it("redeems a minted enrollment code and returns a device token", async () => {
		server = makeServer();
		await server.start();
		server.store.addUser({ email: "alice@example.com" });
		const code = server.store.mintEnrollmentCode(
			"alice@example.com",
			Date.now(),
		);

		const res = await fetch(`http://127.0.0.1:${server.port}/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code }),
		});

		expect(res.status).toBe(200);
		const body = (await res.json()) as { deviceToken: string };
		expect(typeof body.deviceToken).toBe("string");
		expect(body.deviceToken.length).toBeGreaterThan(0);
	});

	it("rejects an invalid enrollment code with 401", async () => {
		server = makeServer();
		await server.start();

		const res = await fetch(`http://127.0.0.1:${server.port}/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code: "not-a-real-code" }),
		});

		expect(res.status).toBe(401);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("invalid or expired code");
	});
});

describe("RouterServer /healthz", () => {
	let server: RouterServer | undefined;

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = undefined;
		}
	});

	it("returns 200 ok for liveness probes", async () => {
		server = makeServer();
		await server.start();

		const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});
});
