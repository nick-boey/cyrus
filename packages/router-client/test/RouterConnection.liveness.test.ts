import { once } from "node:events";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceFrame } from "cyrus-router-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { RouterConnection } from "../src/RouterConnection.js";

/**
 * Liveness-watchdog coverage for {@link RouterConnection}.
 *
 * These tests reproduce the ACA memory-suspend failure mode: the sandbox
 * freezes, the router terminates its side of the socket, and on resume the
 * worker's timers fire LATE while its socket still looks open. Fake timers plus
 * `vi.setSystemTime` model exactly that — the wall clock jumps forward while no
 * timer callback ran in between — which is why the watchdog must compare
 * `Date.now()` rather than count ticks.
 *
 * A real `ws` server is used deliberately (rather than a socket double) so the
 * assertions cover the real `terminate()` → `close` → reconnect path, including
 * the fresh authenticated `hello` the router needs in order to redeliver queued
 * events.
 */
class TestRouter {
	readonly http: Server;
	readonly wss: WebSocketServer;
	sockets: WebSocket[] = [];
	hellos: DeviceFrame[] = [];
	/** Advertised in every hello_ack; the device derives its deadline from it. */
	heartbeatMs: number | undefined;

	private constructor(http: Server, wss: WebSocketServer) {
		this.http = http;
		this.wss = wss;
		wss.on("connection", (ws) => this.handleConnection(ws));
	}

	static async start(heartbeatMs?: number): Promise<TestRouter> {
		const http = createServer();
		const wss = new WebSocketServer({ server: http, path: "/device" });
		await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
		const router = new TestRouter(http, wss);
		router.heartbeatMs = heartbeatMs;
		return router;
	}

	get url(): string {
		const addr = this.http.address();
		if (addr && typeof addr === "object") return `ws://127.0.0.1:${addr.port}`;
		throw new Error("not listening");
	}

	private handleConnection(ws: WebSocket): void {
		this.sockets.push(ws);
		ws.on("message", (raw: RawData) => {
			const frame = JSON.parse(raw.toString()) as DeviceFrame;
			if (frame.type !== "hello") return;
			this.hellos.push(frame);
			ws.send(
				JSON.stringify({
					type: "hello_ack",
					user: { id: "u1" },
					serverVersion: "test",
					...(this.heartbeatMs === undefined
						? {}
						: { heartbeatMs: this.heartbeatMs }),
				}),
			);
		});
		ws.on("error", () => {});
	}

	get lastSocket(): WebSocket {
		const socket = this.sockets[this.sockets.length - 1];
		if (!socket) throw new Error("no socket");
		return socket;
	}

	async close(): Promise<void> {
		for (const socket of this.sockets) socket.terminate();
		await new Promise<void>((resolve) => this.wss.close(() => resolve()));
		await new Promise<void>((resolve) => this.http.close(() => resolve()));
	}
}

const HEARTBEAT_MS = 30_000;
/** Two heartbeats — the point at which the router has already given up too. */
const LIVENESS_TIMEOUT_MS = HEARTBEAT_MS * 2;
/** The watchdog samples every half heartbeat. */
const CHECK_TICK_MS = HEARTBEAT_MS / 2;

let router: TestRouter;
let connection: RouterConnection | undefined;
let stateDir: string;

beforeEach(() => {
	// Installed BEFORE the connection is built so `Date.now()` is mocked for the
	// whole lifetime of the watchdog.
	vi.useFakeTimers();
	stateDir = mkdtempSync(join(tmpdir(), "router-liveness-"));
});

afterEach(async () => {
	connection?.close();
	connection = undefined;
	vi.useRealTimers();
	await router.close();
});

function connect(opts?: { heartbeatMs?: number }): RouterConnection {
	const conn = new RouterConnection({
		url: router.url,
		deviceToken: "device-token",
		stateDir,
		reconnectBaseMs: 10,
		serverHeartbeatMs: opts?.heartbeatMs ?? HEARTBEAT_MS,
	});
	// A listener is always needed so inbox emits find a consumer.
	conn.on("event", () => {});
	connection = conn;
	return conn;
}

describe("RouterConnection liveness watchdog", () => {
	it("terminates a silent socket after a frozen-timer wall-clock jump and redials", async () => {
		router = await TestRouter.start();
		const conn = connect();
		const firstConnect = once(conn, "connected");
		conn.connect();
		await firstConnect;
		expect(router.sockets).toHaveLength(1);
		expect(router.hellos).toHaveLength(1);

		const socketClosed = once(router.lastSocket, "close");
		const disconnected = once(conn, "disconnected");
		const reconnected = once(conn, "connected");

		// The suspend: the wall clock advances well past two heartbeats while NOT
		// A SINGLE timer callback runs — precisely what an ACA memory suspend does
		// to a frozen worker. A tick-counting watchdog sees nothing here.
		vi.setSystemTime(Date.now() + LIVENESS_TIMEOUT_MS + 30_000);

		// The resume: the frozen interval fires (late). One tick is enough.
		await vi.advanceTimersByTimeAsync(CHECK_TICK_MS);

		await socketClosed;
		expect(conn.connected).toBe(false);
		await disconnected;

		// And the ordinary reconnect path runs, producing a NEW authenticated
		// hello — which is what lets the router redeliver the queued prompt.
		await vi.advanceTimersByTimeAsync(50);
		await reconnected;
		expect(router.hellos).toHaveLength(2);
		expect(conn.connected).toBe(true);
	});

	it("keeps a socket that is still receiving server pings", async () => {
		router = await TestRouter.start();
		const conn = connect();
		const firstConnect = once(conn, "connected");
		conn.connect();
		await firstConnect;

		// Six half-heartbeat samples — three full heartbeats of elapsed wall clock,
		// well past the deadline in total — but the router pings before each one,
		// so measured silence never exceeds a single sample interval.
		for (let i = 0; i < 6; i++) {
			// Awaiting the server's `pong` proves the client actually received the
			// ping (and therefore stamped its activity clock). Pure socket IO, so
			// it resolves without any timer needing to fire.
			const pong = once(router.lastSocket, "pong");
			router.lastSocket.ping();
			await pong;
			// `advanceTimersByTimeAsync` moves the mocked clock as well as firing
			// timers, so this both ages the connection by half a heartbeat and runs
			// exactly one watchdog sample.
			await vi.advanceTimersByTimeAsync(CHECK_TICK_MS);
		}

		expect(conn.connected).toBe(true);
		expect(router.hellos).toHaveLength(1);
	});

	it("does not fire before two heartbeats of silence have elapsed", async () => {
		router = await TestRouter.start();
		const conn = connect();
		const firstConnect = once(conn, "connected");
		conn.connect();
		await firstConnect;

		// Jump to one millisecond short of the deadline, counting the clock
		// advance the sampling tick itself contributes.
		vi.setSystemTime(Date.now() + LIVENESS_TIMEOUT_MS - CHECK_TICK_MS - 1);
		await vi.advanceTimersByTimeAsync(CHECK_TICK_MS);

		expect(conn.connected).toBe(true);
		expect(router.hellos).toHaveLength(1);
	});

	it("derives its deadline from the heartbeat the router advertises", async () => {
		// This router pings 30x faster than the protocol default, so its deadline
		// is 2s. The device must adopt the advertised cadence: a 2.1s gap is
		// already fatal here, while under the compiled-in 30s default (which is
		// what `connect()` seeds below) it would be nowhere near the deadline.
		router = await TestRouter.start(1_000);
		const conn = connect({ heartbeatMs: HEARTBEAT_MS });
		const firstConnect = once(conn, "connected");
		conn.connect();
		await firstConnect;

		const disconnected = once(conn, "disconnected");
		// Half of a 1s heartbeat is below the 1s sampling floor, so samples land
		// every 1s; 1.2s + one sample = 2.2s of silence, past the 2s deadline.
		vi.setSystemTime(Date.now() + 1_200);
		await vi.advanceTimersByTimeAsync(1_000);
		await disconnected;
		expect(conn.connected).toBe(false);
	});
});
