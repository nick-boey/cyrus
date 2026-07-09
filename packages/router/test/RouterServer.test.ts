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

describe("RouterServer /workspaces", () => {
	let server: RouterServer | undefined;

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = undefined;
		}
	});

	/** Enrolls a device and returns its long-lived token. */
	async function enrollDevice(s: RouterServer): Promise<string> {
		s.store.addUser({ email: "alice@example.com" });
		const code = s.store.mintEnrollmentCode("alice@example.com", Date.now());
		const res = await fetch(`http://127.0.0.1:${s.port}/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code }),
		});
		return ((await res.json()) as { deviceToken: string }).deviceToken;
	}

	it("returns the configured workspace ids for a valid device token", async () => {
		server = new RouterServer({
			port: 0,
			dbPath: ":memory:",
			workspaces: {
				"ws-1": { linearToken: "token-1" },
				"ws-2": { linearToken: "token-2" },
			},
			webhook: { verificationMode: "direct", secret: "test-secret" },
			trackerFactory: () => new CLIIssueTrackerService(),
		});
		await server.start();
		const deviceToken = await enrollDevice(server);

		const res = await fetch(`http://127.0.0.1:${server.port}/workspaces`, {
			headers: { authorization: `Bearer ${deviceToken}` },
		});

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ workspaceIds: ["ws-1", "ws-2"] });
	});

	it("never leaks the workspace's Linear token", async () => {
		server = makeServer();
		await server.start();
		const deviceToken = await enrollDevice(server);

		const res = await fetch(`http://127.0.0.1:${server.port}/workspaces`, {
			headers: { authorization: `Bearer ${deviceToken}` },
		});

		expect(await res.text()).not.toContain("test-token");
	});

	it("rejects a request with no Authorization header", async () => {
		server = makeServer();
		await server.start();

		const res = await fetch(`http://127.0.0.1:${server.port}/workspaces`);

		expect(res.status).toBe(401);
	});

	it("rejects a malformed Authorization header", async () => {
		server = makeServer();
		await server.start();
		const deviceToken = await enrollDevice(server);

		// Correct token, but missing the `Bearer ` scheme prefix.
		const res = await fetch(`http://127.0.0.1:${server.port}/workspaces`, {
			headers: { authorization: deviceToken },
		});

		expect(res.status).toBe(401);
	});

	it("rejects an unknown device token", async () => {
		server = makeServer();
		await server.start();

		const res = await fetch(`http://127.0.0.1:${server.port}/workspaces`, {
			headers: { authorization: "Bearer not-a-real-token" },
		});

		expect(res.status).toBe(401);
	});

	it("rejects a revoked device's token", async () => {
		server = makeServer();
		await server.start();
		const deviceToken = await enrollDevice(server);
		server.store.revokeDevice("alice@example.com");

		const res = await fetch(`http://127.0.0.1:${server.port}/workspaces`, {
			headers: { authorization: `Bearer ${deviceToken}` },
		});

		expect(res.status).toBe(401);
	});
});
