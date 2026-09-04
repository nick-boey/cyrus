import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DeviceFrame,
	RUN_FACTS_CAPABILITY,
	type SessionStateFrame,
	WAIT_REASON_ELICITATION,
} from "cyrus-router-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { RouterConnection } from "../src/RouterConnection.js";

/**
 * CYR-68 — the WORKER half of run-facts compatibility.
 *
 * The router half is covered in `cyrus-router`; this is the half that decides
 * whether an un-upgraded fleet keeps working, and it is the direction that
 * cannot be checked by asserting on a stubbed connection. Every test here goes
 * over a real socket to a router that either does or does not advertise
 * {@link RUN_FACTS_CAPABILITY}, because the defect this file exists to prevent —
 * a `waiting` frame reaching a router whose `state` enum rejects it, which
 * `DeviceGateway` answers by closing the socket — is invisible at any layer
 * above the wire.
 */

const WAIT = {
	reason: WAIT_REASON_ELICITATION,
	since: "2026-09-04T00:00:00.000Z",
} as const;

/** A router that can be told, per-connection, what it is able to parse. */
class TestRouter {
	readonly http: Server;
	readonly wss: WebSocketServer;
	sockets: WebSocket[] = [];
	received: DeviceFrame[] = [];
	/** What `hello_ack` advertises. Changeable between connections. */
	capabilities: string[] = [RUN_FACTS_CAPABILITY];

	private constructor(http: Server, wss: WebSocketServer) {
		this.http = http;
		this.wss = wss;
		wss.on("connection", (ws) => this.handleConnection(ws));
	}

	static async start(): Promise<TestRouter> {
		const http = createServer();
		const wss = new WebSocketServer({ server: http, path: "/device" });
		await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
		return new TestRouter(http, wss);
	}

	get url(): string {
		const addr = this.http.address();
		if (!addr || typeof addr !== "object") throw new Error("not listening");
		return `ws://127.0.0.1:${addr.port}`;
	}

	get sessionStates(): SessionStateFrame[] {
		return this.received.filter(
			(f): f is SessionStateFrame => f.type === "session_state",
		);
	}

	private handleConnection(ws: WebSocket): void {
		this.sockets.push(ws);
		ws.on("message", (raw: RawData) => {
			const frame = JSON.parse(raw.toString()) as DeviceFrame;
			this.received.push(frame);
			if (frame.type === "hello") {
				ws.send(
					JSON.stringify({
						type: "hello_ack",
						user: { id: "u1" },
						serverVersion: "test",
						capabilities: this.capabilities,
					}),
				);
			}
		});
	}

	/** Drops the live socket without closing the server, forcing a reconnect. */
	dropSocket(): void {
		this.sockets[this.sockets.length - 1]?.terminate();
	}

	async close(): Promise<void> {
		for (const s of this.sockets) s.terminate();
		await new Promise<void>((resolve) => this.wss.close(() => resolve()));
		await new Promise<void>((resolve) => this.http.close(() => resolve()));
	}
}

let router: TestRouter;
let stateDir: string;
let conn: RouterConnection | undefined;

beforeEach(async () => {
	router = await TestRouter.start();
	stateDir = mkdtempSync(join(tmpdir(), "router-client-run-facts-"));
});

afterEach(async () => {
	conn?.close();
	conn = undefined;
	await router.close();
});

async function connect(): Promise<RouterConnection> {
	const connection = new RouterConnection({
		url: router.url,
		deviceToken: "device-token",
		stateDir,
		reconnectBaseMs: 5,
		rpcTimeoutMs: 1000,
	});
	conn = connection;
	connection.connect();
	await once(connection, "connected");
	return connection;
}

/** Waits until the router has received `n` session_state frames. */
async function awaitSessionStates(n: number): Promise<SessionStateFrame[]> {
	await expect
		.poll(() => router.sessionStates.length, { timeout: 2000 })
		.toBeGreaterThanOrEqual(n);
	return router.sessionStates;
}

describe("RouterConnection run facts", () => {
	it("reports an explicit wait to a router that advertises run facts", async () => {
		const connection = await connect();
		expect(connection.acceptsRunFacts).toBe(true);

		connection.sendSessionWaiting("sess-1", WAIT, {
			executorMayPark: true,
			runner: "claude",
			model: "claude-opus-5",
			pendingWorkCount: 0,
		});

		const [frame] = await awaitSessionStates(1);
		expect(frame).toMatchObject({
			state: "waiting",
			sessionId: "sess-1",
			wait: WAIT,
			executorMayPark: true,
			runner: "claude",
			model: "claude-opus-5",
			pendingWorkCount: 0,
		});
	});

	it("degrades a parkable wait to the legacy `parked` frame", async () => {
		router.capabilities = [];
		const connection = await connect();
		expect(connection.acceptsRunFacts).toBe(false);

		connection.sendSessionWaiting("sess-1", WAIT, {
			executorMayPark: true,
			runner: "claude",
		});

		// `parked` is what that frame has always meant, so an un-upgraded router
		// keeps parking containers exactly as it does today. The extra optional
		// fields ride along harmlessly — `z.object` strips unknown keys.
		const [frame] = await awaitSessionStates(1);
		expect(frame?.state).toBe("parked");
		expect(frame?.wait).toBeUndefined();
	});

	it("sends nothing when a non-parkable wait cannot be expressed", async () => {
		router.capabilities = [];
		const connection = await connect();

		connection.sendSessionWaiting("sess-1", WAIT, { executorMayPark: false });

		// Lossy in one direction on purpose. An old router has no way to record a
		// wait WITHOUT also releasing affinity, and releasing it for a run whose
		// executor must not park freezes a live background build — the completion
		// that would wake the session then never arrives. Losing the observation is
		// the cheaper failure.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(router.sessionStates).toHaveLength(0);
	});

	it("degrades a buffered wait on reconnect to a router that no longer accepts it", async () => {
		// THE DEFECT THIS FILE EXISTS FOR. The gate cannot live at the call site:
		// the entry is durable, so it can be replayed minutes later — most likely
		// onto a router that was rolled back, which is exactly when it matters.
		// An ungated replay is rejected, `DeviceGateway` closes with 1002, we
		// reconnect, we replay: a permanent loop that takes down event delivery,
		// RPC, and every OTHER session's terminal frame queued behind it.
		const connection = await connect();
		connection.sendSessionWaiting("sess-1", WAIT, { executorMayPark: true });
		await awaitSessionStates(1);
		expect(router.sessionStates[0]?.state).toBe("waiting");

		// The router is rolled back and the socket drops. The frame was never
		// acked, so it replays.
		router.capabilities = [];
		router.dropSocket();
		await once(connection, "connected");

		const frames = await awaitSessionStates(2);
		expect(frames[1]?.state).toBe("parked");
		expect(frames.some((f) => f.state === "waiting" && f !== frames[0])).toBe(
			false,
		);
	});

	it("re-reads capabilities on every connection rather than trusting the last answer", async () => {
		// A capability is one router's answer on one connection. A reconnect can
		// land on a different build — a rollback, a blue/green swap, a
		// load-balanced pair mid-deploy — so carrying it across a disconnect turns
		// an answer into an assumption.
		const connection = await connect();
		expect(connection.acceptsRunFacts).toBe(true);

		router.capabilities = [];
		router.dropSocket();
		await once(connection, "connected");

		expect(connection.acceptsRunFacts).toBe(false);
	});

	it("re-advertised capabilities restore the explicit wait", async () => {
		router.capabilities = [];
		const connection = await connect();
		expect(connection.acceptsRunFacts).toBe(false);

		router.capabilities = [RUN_FACTS_CAPABILITY];
		router.dropSocket();
		await once(connection, "connected");

		connection.sendSessionWaiting("sess-1", WAIT, { executorMayPark: false });

		const [frame] = await awaitSessionStates(1);
		expect(frame?.state).toBe("waiting");
		expect(frame?.executorMayPark).toBe(false);
	});

	it("reports pending work as fire-and-forget facts on an active run", async () => {
		const connection = await connect();

		connection.sendRunFacts("sess-1", {
			runner: "claude",
			pendingWorkCount: 3,
		});

		const [frame] = await awaitSessionStates(1);
		expect(frame).toMatchObject({
			state: "active",
			pendingWorkCount: 3,
			runner: "claude",
		});
	});

	it("does not report run facts to a router that cannot record them", async () => {
		router.capabilities = [];
		const connection = await connect();

		connection.sendRunFacts("sess-1", { pendingWorkCount: 3 });

		// An older router reads a bare `active` as an unpark attempt, so sending
		// one here would put a stray "no park on record" line in its log for every
		// deferred turn and buy nothing — it could not record the facts anyway.
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(router.sessionStates).toHaveLength(0);
	});

	it("never replays a run-facts report, unlike every other session_state", async () => {
		// Making it durable would make it REPLAYABLE, and a replayed `active`
		// against a router that has since recorded a park mints affinity back — a
		// real hazard bought for a count. A lost count costs one observation.
		const connection = await connect();
		connection.sendRunFacts("sess-1", { pendingWorkCount: 3 });
		await awaitSessionStates(1);

		router.dropSocket();
		await once(connection, "connected");

		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(router.sessionStates).toHaveLength(1);
	});

	it("carries execution identity on a terminal frame and replays it", async () => {
		// The terminal frame is the only point at which an ordinary run — one that
		// never waited — offers its runner and model, so the identity has to
		// survive the replay that makes the frame durable in the first place.
		const connection = await connect();
		connection.sendSessionState("sess-1", "complete", {
			runner: "codex",
			model: "gpt-5.5-codex",
		});
		await awaitSessionStates(1);

		router.dropSocket();
		await once(connection, "connected");

		const frames = await awaitSessionStates(2);
		expect(frames[1]).toMatchObject({
			state: "complete",
			runner: "codex",
			model: "gpt-5.5-codex",
		});
	});
});
