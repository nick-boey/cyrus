import { CLIIssueTrackerService } from "cyrus-core";
import { PROTOCOL_VERSION } from "cyrus-router-protocol";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
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

describe("RouterServer session_state", () => {
	let server: RouterServer | undefined;

	afterEach(async () => {
		if (server) {
			await server.stop();
			server = undefined;
		}
	});

	/** Enrolls a device and returns an authenticated socket + a frame reader. */
	async function connectDevice(srv: RouterServer) {
		srv.store.addUser({ email: "alice@example.com" });
		const code = srv.store.mintEnrollmentCode("alice@example.com", Date.now());
		const res = await fetch(`http://127.0.0.1:${srv.port}/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code }),
		});
		const { deviceToken } = (await res.json()) as { deviceToken: string };

		const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/device`);
		const queue: string[] = [];
		const waiters: Array<(m: string) => void> = [];
		ws.on("message", (d) => {
			const msg = d.toString();
			const w = waiters.shift();
			if (w) w(msg);
			else queue.push(msg);
		});
		const next = () =>
			new Promise<string>((resolve) => {
				const q = queue.shift();
				if (q !== undefined) resolve(q);
				else waiters.push(resolve);
			});

		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken,
				protocolVersion: PROTOCOL_VERSION,
				lastAckedSeq: 0,
			}),
		);
		expect(JSON.parse(await next()).type).toBe("hello_ack");
		return { ws, next };
	}

	it("acks a session_state frame and releases the issue lock before acking", async () => {
		server = makeServer();
		await server.start();
		const { ws, next } = await connectDevice(server);

		// Hold a lock the terminal frame is expected to release.
		const deviceId = 1;
		expect(server.store.acquireIssueLock("ISS-1", "sess-1", deviceId)).toBe(
			true,
		);

		ws.send(
			JSON.stringify({
				type: "session_state",
				id: "ss-42",
				sessionId: "sess-1",
				state: "complete",
			}),
		);

		const ack = JSON.parse(await next());
		expect(ack).toEqual({ type: "session_state_ack", id: "ss-42" });

		// The ack is only sent after the release is applied, so by the time the
		// device sees it the issue must be re-acquirable by another session.
		expect(server.store.acquireIssueLock("ISS-1", "sess-2", deviceId)).toBe(
			true,
		);
		ws.terminate();
	});

	it("re-acks a replayed session_state (at-least-once delivery is idempotent)", async () => {
		server = makeServer();
		await server.start();
		const { ws, next } = await connectDevice(server);

		const frame = JSON.stringify({
			type: "session_state",
			id: "ss-dup",
			sessionId: "sess-1",
			state: "stopped",
		});
		ws.send(frame);
		expect(JSON.parse(await next())).toEqual({
			type: "session_state_ack",
			id: "ss-dup",
		});

		// A device whose first ack was lost replays the same frame. The router
		// must ack again rather than ignore it, or the device buffers forever.
		ws.send(frame);
		expect(JSON.parse(await next())).toEqual({
			type: "session_state_ack",
			id: "ss-dup",
		});
		ws.terminate();
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
