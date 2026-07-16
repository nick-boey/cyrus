import { once } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type DeviceFrame,
	PROTOCOL_VERSION,
	type RpcRequestFrame,
	type SessionStateFrame,
} from "cyrus-router-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RawData, type WebSocket, WebSocketServer } from "ws";
import { RouterConnection } from "../src/RouterConnection.js";

/**
 * Minimal in-test router that speaks the wire protocol. It accepts a device
 * socket on `/device`, answers `hello` with `hello_ack`, and exposes hooks so
 * each test can drive events / rpc responses and observe received frames.
 */
class TestRouter {
	readonly http: Server;
	readonly wss: WebSocketServer;
	sockets: WebSocket[] = [];
	hellos: DeviceFrame[] = [];
	received: DeviceFrame[] = [];
	/** Per-connection handler for device frames (after hello). */
	onFrame?: (ws: WebSocket, frame: DeviceFrame) => void;
	/** If true, refuse the next hello with hello_error. */
	rejectHello = false;

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

	get port(): number {
		const addr = this.http.address();
		if (addr && typeof addr === "object") return addr.port;
		throw new Error("not listening");
	}

	get url(): string {
		return `ws://127.0.0.1:${this.port}`;
	}

	private handleConnection(ws: WebSocket): void {
		this.sockets.push(ws);
		ws.on("message", (raw: RawData) => {
			const frame = JSON.parse(raw.toString()) as DeviceFrame;
			this.received.push(frame);
			if (frame.type === "hello") {
				this.hellos.push(frame);
				if (this.rejectHello) {
					ws.send(
						JSON.stringify({ type: "hello_error", reason: "invalid token" }),
					);
					ws.close();
					return;
				}
				ws.send(
					JSON.stringify({
						type: "hello_ack",
						user: { id: "u1" },
						serverVersion: "test",
					}),
				);
				return;
			}
			this.onFrame?.(ws, frame);
		});
	}

	sendEvent(ws: WebSocket, seq: number, event: unknown): void {
		ws.send(JSON.stringify({ type: "event", seq, event }));
	}

	rpcOk(ws: WebSocket, id: string, result: unknown): void {
		ws.send(JSON.stringify({ type: "rpc_response", id, ok: true, result }));
	}

	rpcErr(ws: WebSocket, id: string, error: string): void {
		ws.send(JSON.stringify({ type: "rpc_response", id, ok: false, error }));
	}

	get lastSocket(): WebSocket {
		const s = this.sockets[this.sockets.length - 1];
		if (!s) throw new Error("no socket");
		return s;
	}

	async close(): Promise<void> {
		for (const s of this.sockets) s.terminate();
		await new Promise<void>((resolve) => this.wss.close(() => resolve()));
		await new Promise<void>((resolve) => this.http.close(() => resolve()));
	}
}

function readJsonl(path: string): unknown[] {
	let raw = "";
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	return raw
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map((l) => JSON.parse(l) as unknown);
}

let router: TestRouter;
let stateDir: string;

beforeEach(async () => {
	router = await TestRouter.start();
	stateDir = mkdtempSync(join(tmpdir(), "router-client-"));
});

afterEach(async () => {
	await router.close();
});

function makeConn(overrides?: {
	url?: string;
	reconnectBaseMs?: number;
	getActiveSessions?: () => string[];
}): RouterConnection {
	return new RouterConnection({
		url: overrides?.url ?? router.url,
		deviceToken: "device-token",
		stateDir,
		reconnectBaseMs: overrides?.reconnectBaseMs ?? 10,
		rpcTimeoutMs: 1000,
		getActiveSessions: overrides?.getActiveSessions,
	});
}

describe("RouterConnection", () => {
	it("(a) sends hello carrying persisted lastAckedSeq", async () => {
		writeFileSync(
			join(stateDir, "router-connection.json"),
			JSON.stringify({ lastAckedSeq: 7 }),
		);
		const conn = makeConn();
		conn.connect();
		const [helloAck] = await once(conn, "connected");
		expect(helloAck.serverVersion).toBe("test");
		expect(router.hellos).toHaveLength(1);
		const hello = router.hellos[0];
		expect(hello).toMatchObject({
			type: "hello",
			deviceToken: "device-token",
			protocolVersion: PROTOCOL_VERSION,
			lastAckedSeq: 7,
		});
		conn.close();
	});

	it("(a2) includes freshly-evaluated activeSessions in hello when a provider is set", async () => {
		let sessions = ["sess-a", "sess-b"];
		const conn = makeConn({ getActiveSessions: () => sessions });
		conn.connect();
		await once(conn, "connected");
		expect(router.hellos.at(-1)).toMatchObject({
			activeSessions: ["sess-a", "sess-b"],
		});

		// Provider is re-evaluated on each connect, not captured once.
		sessions = ["sess-c"];
		router.lastSocket.close();
		await once(conn, "connected");
		expect(router.hellos.at(-1)).toMatchObject({ activeSessions: ["sess-c"] });
		conn.close();
	});

	it("(a3) omits activeSessions entirely when no provider is set", async () => {
		const conn = makeConn();
		conn.connect();
		await once(conn, "connected");
		expect(router.hellos.at(-1)).not.toHaveProperty("activeSessions");
		conn.close();
	});

	it("(b) emits event once, sends event_ack, drops duplicate seq", async () => {
		const conn = makeConn();
		const events: Array<{ event: unknown; seq: number }> = [];
		conn.on("event", (event: unknown, seq: number) => {
			events.push({ event, seq });
		});
		conn.connect();
		await once(conn, "connected");

		router.sendEvent(router.lastSocket, 1, { hello: "world" });
		await once(conn, "event");

		// Wait for the ack to land server-side.
		await vi.waitFor(() =>
			expect(
				router.received.some((f) => f.type === "event_ack" && f.seq === 1),
			).toBe(true),
		);
		expect(events).toEqual([{ event: { hello: "world" }, seq: 1 }]);

		// Duplicate seq must NOT re-emit but MUST re-ack.
		const ackCountBefore = router.received.filter(
			(f) => f.type === "event_ack",
		).length;
		router.sendEvent(router.lastSocket, 1, { hello: "world" });
		await vi.waitFor(() =>
			expect(router.received.filter((f) => f.type === "event_ack").length).toBe(
				ackCountBefore + 1,
			),
		);
		expect(events).toHaveLength(1);

		// lastAckedSeq persisted.
		const persisted = JSON.parse(
			readFileSync(join(stateDir, "router-connection.json"), "utf8"),
		) as { lastAckedSeq: number };
		expect(persisted.lastAckedSeq).toBe(1);
		conn.close();
	});

	it("(c) rpc resolves on ok:true, rejects with error string on ok:false", async () => {
		router.onFrame = (ws, frame) => {
			if (frame.type === "rpc_request") {
				if (frame.method === "fetchIssue") {
					router.rpcOk(ws, frame.id, { id: "ISSUE-1" });
				} else {
					router.rpcErr(ws, frame.id, "boom: not allowed");
				}
			}
		};
		const conn = makeConn();
		conn.connect();
		await once(conn, "connected");

		await expect(conn.rpc("fetchIssue", ["ISSUE-1"])).resolves.toEqual({
			id: "ISSUE-1",
		});
		await expect(conn.rpc("nope", [])).rejects.toThrow("boom: not allowed");
		conn.close();
	});

	it("(c2) rpc revives Date fields the wire flattened to ISO strings", async () => {
		// The router serializes the SDK's Date fields to strings. Without revival
		// at this boundary, EdgeWorker's `comment.createdAt.toISOString()` throws
		// "is not a function" on every prompted webhook carrying a comment.
		router.onFrame = (ws, frame) => {
			if (frame.type === "rpc_request") {
				router.rpcOk(ws, frame.id, {
					id: "c-1",
					title: "2026-01-01T00:00:00.000Z",
					createdAt: "2026-07-10T04:25:41.345Z",
					nodes: [{ updatedAt: "2026-07-10T05:00:00.000Z" }],
				});
			}
		};
		const conn = makeConn();
		conn.connect();
		await once(conn, "connected");

		const result = (await conn.rpc("fetchComment", ["c-1"])) as {
			title: string;
			createdAt: Date;
			nodes: Array<{ updatedAt: Date }>;
		};

		expect(result.createdAt).toBeInstanceOf(Date);
		expect(result.createdAt.toISOString()).toBe("2026-07-10T04:25:41.345Z");
		expect(result.nodes[0]?.updatedAt).toBeInstanceOf(Date);
		// A date-shaped value under a non-date key stays a string.
		expect(result.title).toBe("2026-01-01T00:00:00.000Z");
		conn.close();
	});

	it("(d) bufferedRpc while disconnected writes JSONL and replays after reconnect", async () => {
		// Point at the real router but do not connect yet: bufferedRpc is offline.
		const conn = makeConn();
		const result = await conn.bufferedRpc("createAgentActivity", [
			{ agentSessionId: "s1" },
		]);
		expect(result).toEqual({ success: true });

		const buffered = readJsonl(
			join(stateDir, "outbound-buffer.jsonl"),
		) as Array<{ mutationId: string; method: string; params: unknown[] }>;
		expect(buffered).toHaveLength(1);
		expect(buffered[0]?.method).toBe("createAgentActivity");

		// Now connect; the buffer should replay as an rpc_request.
		const replayed: RpcRequestFrame[] = [];
		router.onFrame = (ws, frame) => {
			if (frame.type === "rpc_request") {
				replayed.push(frame);
				router.rpcOk(ws, frame.id, { ok: 1 });
			}
		};
		conn.connect();
		await once(conn, "connected");

		await vi.waitFor(() => expect(replayed).toHaveLength(1));
		expect(replayed[0]?.method).toBe("createAgentActivity");
		expect(replayed[0]?.mutationId).toBe(buffered[0]?.mutationId);

		// Buffer file drained after the replay resolves.
		await vi.waitFor(() =>
			expect(readJsonl(join(stateDir, "outbound-buffer.jsonl"))).toHaveLength(
				0,
			),
		);
		conn.close();
	});

	it("(e) reconnects after a server-side socket close (second hello observed)", async () => {
		const conn = makeConn();
		conn.connect();
		await once(conn, "connected");
		expect(router.hellos).toHaveLength(1);

		// Server drops the socket.
		router.lastSocket.close();
		await once(conn, "disconnected");

		// Client should re-dial and hello again.
		await once(conn, "connected");
		expect(router.hellos.length).toBeGreaterThanOrEqual(2);
		conn.close();
	});

	it("(f) crash recovery: re-emits acked-but-unprocessed inbox event on startup", async () => {
		// First connection: receives + acks the event, but closes DURING the
		// event handler so the inbox entry is never marked processed (simulating
		// a crash between ack and consumer dispatch).
		const conn1 = makeConn();
		conn1.on("event", () => {
			conn1.close();
		});
		conn1.connect();
		await once(conn1, "connected");
		router.sendEvent(router.lastSocket, 1, { prompt: "do it" });
		await once(conn1, "event");

		// Inbox retains the unprocessed entry; lastAckedSeq persisted.
		await vi.waitFor(() =>
			expect(readJsonl(join(stateDir, "inbox.jsonl"))).toHaveLength(1),
		);

		// Second connection on the SAME stateDir replays the inbox on startup.
		const conn2 = makeConn();
		const replayed: Array<{ event: unknown; seq: number }> = [];
		conn2.on("event", (event: unknown, seq: number) => {
			replayed.push({ event, seq });
		});
		conn2.connect();
		await once(conn2, "event");
		expect(replayed).toEqual([{ event: { prompt: "do it" }, seq: 1 }]);

		// Inbox drained after successful replay.
		expect(readJsonl(join(stateDir, "inbox.jsonl"))).toHaveLength(0);
		conn2.close();
	});

	it("(g) bufferedRpc offline resolves {success:true}; replay carries same mutationId", async () => {
		const conn = makeConn();
		const result = await conn.bufferedRpc("createAgentActivity", [{ a: 1 }]);
		expect(result).toEqual({ success: true });

		const buffered = readJsonl(
			join(stateDir, "outbound-buffer.jsonl"),
		) as Array<{ mutationId: string }>;
		const bufferedMutationId = buffered[0]?.mutationId;
		expect(bufferedMutationId).toBeTruthy();

		const replayed: RpcRequestFrame[] = [];
		router.onFrame = (ws, frame) => {
			if (frame.type === "rpc_request") {
				replayed.push(frame);
				router.rpcOk(ws, frame.id, { ok: 1 });
			}
		};
		conn.connect();
		await once(conn, "connected");
		await vi.waitFor(() => expect(replayed).toHaveLength(1));
		expect(replayed[0]?.mutationId).toBe(bufferedMutationId);
		conn.close();
	});

	it("(h) hello_error is fatal: emits error and stops reconnecting", async () => {
		router.rejectHello = true;
		const conn = makeConn();
		conn.connect();
		const [err] = await once(conn, "error");
		expect(err).toBeInstanceOf(Error);
		// No further hello attempts after the fatal error.
		const hellosAfter = router.hellos.length;
		await new Promise((r) => setTimeout(r, 60));
		expect(router.hellos.length).toBe(hellosAfter);
		expect(conn.connected).toBe(false);
		conn.close();
	});

	it("(i) bufferedRpc buffers the mutation when the socket drops mid-call", async () => {
		const conn = makeConn();
		conn.connect();
		await once(conn, "connected");

		// The server accepts the rpc frame but closes without replying — a
		// mid-call router outage. sendRpc will reject retryably; the mutation must
		// be durably buffered rather than lost.
		let sawRpc = false;
		router.onFrame = (ws, frame) => {
			if (frame.type === "rpc_request") {
				sawRpc = true;
				ws.close();
			}
		};

		const result = await conn.bufferedRpc("createAgentActivity", [{ a: 1 }]);
		expect(result).toEqual({ success: true });
		expect(sawRpc).toBe(true);

		// The outbound buffer now holds the entry (the whole point of bufferedRpc).
		const buffered = readJsonl(
			join(stateDir, "outbound-buffer.jsonl"),
		) as Array<{ mutationId: string; method: string }>;
		expect(buffered).toHaveLength(1);
		expect(buffered[0]?.method).toBe("createAgentActivity");
		const bufferedMutationId = buffered[0]?.mutationId;
		expect(bufferedMutationId).toBeTruthy();

		// On auto-reconnect it replays with the SAME mutationId (idempotent).
		const replayed: RpcRequestFrame[] = [];
		router.onFrame = (ws, frame) => {
			if (frame.type === "rpc_request") {
				replayed.push(frame);
				router.rpcOk(ws, frame.id, { ok: 1 });
			}
		};
		await vi.waitFor(() => expect(replayed).toHaveLength(1));
		expect(replayed[0]?.mutationId).toBe(bufferedMutationId);

		// Buffer drained after the replay resolves.
		await vi.waitFor(() =>
			expect(readJsonl(join(stateDir, "outbound-buffer.jsonl"))).toHaveLength(
				0,
			),
		);
		conn.close();
	});

	it("(j) inbox replay with no event listener keeps the entry on disk (not dropped)", async () => {
		// Seed a durable inbox entry as if a prior crash left it unprocessed.
		writeFileSync(
			join(stateDir, "inbox.jsonl"),
			`${JSON.stringify({ seq: 5, event: { prompt: "hi" } })}\n`,
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		// Deliberately attach NO "event" listener before connect.
		const conn = makeConn();
		conn.connect();
		await once(conn, "connected");
		// Let the microtask-scheduled replay run.
		await new Promise((r) => setTimeout(r, 20));

		// The event had no consumer, so it must survive on disk, and be warned.
		expect(readJsonl(join(stateDir, "inbox.jsonl"))).toHaveLength(1);
		expect(warn).toHaveBeenCalled();
		conn.close();
		warn.mockRestore();

		// A later run WITH a listener drains it.
		const conn2 = makeConn();
		const seen: Array<{ event: unknown; seq: number }> = [];
		conn2.on("event", (event: unknown, seq: number) => {
			seen.push({ event, seq });
		});
		conn2.connect();
		await once(conn2, "event");
		expect(seen).toEqual([{ event: { prompt: "hi" }, seq: 5 }]);
		expect(readJsonl(join(stateDir, "inbox.jsonl"))).toHaveLength(0);
		conn2.close();
	});

	it("(k) hello_error with no error listener does not throw and stops reconnecting", async () => {
		router.rejectHello = true;
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		const conn = makeConn();
		// No "error" listener attached — emit("error") would otherwise throw.
		conn.connect();

		// The hello is sent and rejected; the process must survive.
		await vi.waitFor(() =>
			expect(router.hellos.length).toBeGreaterThanOrEqual(1),
		);
		await vi.waitFor(() => expect(err).toHaveBeenCalled());

		// No further hello attempts after the fatal error (reconnect stopped).
		const hellosAfter = router.hellos.length;
		await new Promise((r) => setTimeout(r, 60));
		expect(router.hellos.length).toBe(hellosAfter);
		expect(conn.connected).toBe(false);
		conn.close();
		err.mockRestore();
	});

	// ── session_state durability ───────────────────────────────────────────
	// The terminal frame is the ONLY thing that releases the router's issue
	// lock; the router's own sweep only reclaims locks from devices offline past
	// the 48h event TTL. Losing this frame on a live device strands the issue
	// until an operator runs `cyrus router unlock`, so it must be durable.

	const bufferPath = () => join(stateDir, "session-state-buffer.jsonl");
	const ackAll = (ws: WebSocket, frame: DeviceFrame) => {
		if (frame.type === "session_state") {
			ws.send(JSON.stringify({ type: "session_state_ack", id: frame.id }));
		}
	};
	const sessionStates = () =>
		router.received.filter(
			(f): f is SessionStateFrame => f.type === "session_state",
		);

	it("(h) sendSessionState while offline persists the frame instead of dropping it", async () => {
		const conn = makeConn(); // never connected
		conn.sendSessionState("sess-1", "complete");

		const buffered = readJsonl(bufferPath());
		expect(buffered).toHaveLength(1);
		expect(buffered[0]).toMatchObject({
			sessionId: "sess-1",
			state: "complete",
		});
		expect(sessionStates()).toHaveLength(0);
		conn.close();
	});

	it("(i) sendSessionState online is acked and clears the durable buffer", async () => {
		router.onFrame = ackAll;
		const conn = makeConn();
		conn.connect();
		await once(conn, "connected");

		conn.sendSessionState("sess-1", "complete");

		await vi.waitFor(() => expect(readJsonl(bufferPath())).toHaveLength(0));
		const sent = sessionStates();
		expect(sent).toHaveLength(1);
		expect(sent[0]).toMatchObject({ sessionId: "sess-1", state: "complete" });
		expect(sent[0]?.id).toBeTruthy();
		conn.close();
	});

	it("(j) an unacked session_state survives a restart and replays with the same id", async () => {
		// Router deliberately never acks: the frame is delivered but unconfirmed.
		const conn1 = makeConn();
		conn1.connect();
		await once(conn1, "connected");
		conn1.sendSessionState("sess-1", "stopped");
		await vi.waitFor(() => expect(sessionStates()).toHaveLength(1));

		// Unacked → still on disk.
		expect(readJsonl(bufferPath())).toHaveLength(1);
		const originalId = sessionStates()[0]?.id;
		conn1.close();

		// Restart against the same stateDir; this time the router acks.
		router.onFrame = ackAll;
		const conn2 = makeConn();
		conn2.connect();
		await once(conn2, "connected");

		await vi.waitFor(() => expect(readJsonl(bufferPath())).toHaveLength(0));
		const all = sessionStates();
		expect(all.length).toBeGreaterThanOrEqual(2);
		// Same id across the replay, so the router's idempotent release dedupes it.
		expect(all[all.length - 1]?.id).toBe(originalId);
		expect(all[all.length - 1]).toMatchObject({
			sessionId: "sess-1",
			state: "stopped",
		});
		conn2.close();
	});

	it("(k) an ack for an unknown id leaves the buffer intact", async () => {
		router.onFrame = (ws, frame) => {
			if (frame.type === "session_state") {
				ws.send(
					JSON.stringify({ type: "session_state_ack", id: "not-the-id" }),
				);
			}
		};
		const conn = makeConn();
		conn.sendSessionState("sess-1", "error"); // buffered while offline
		conn.connect();
		await once(conn, "connected");

		// The replay reaches the router, but the bogus ack must not clear it.
		await vi.waitFor(() => expect(sessionStates()).toHaveLength(1));
		await new Promise((r) => setTimeout(r, 50));
		expect(readJsonl(bufferPath())).toHaveLength(1);
		conn.close();
	});
});
