import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { DeviceGateway } from "../src/DeviceGateway.js";
import { RouterStore } from "../src/RouterStore.js";

const NOW = 1_000_000;

async function setup() {
	const store = new RouterStore(":memory:");
	store.addUser({ email: "alice@example.com" });
	const code = store.mintEnrollmentCode("alice@example.com", NOW);
	const device = store.redeemEnrollmentCode(code, NOW);
	if (!device) throw new Error("redeem failed");
	const gateway = new DeviceGateway(store);
	const httpServer = createServer();
	gateway.attach(httpServer, "/device");
	await new Promise<void>((r) => httpServer.listen(0, r));
	const port = (httpServer.address() as AddressInfo).port;
	return { store, gateway, device, port, httpServer };
}

function connect(port: number): WebSocket {
	return new WebSocket(`ws://127.0.0.1:${port}/device`);
}

// A naive `ws.once("message", ...)` per call races against bursts: when the
// server writes several frames back-to-back (e.g. hello_ack immediately
// followed by queued events), the underlying `ws` receiver can emit multiple
// "message" events synchronously for frames already buffered from a single
// socket read — faster than an `await`-then-re-register-listener chain can
// keep up, silently dropping every frame but the first. Buffer messages in
// a FIFO queue instead so `nextMessage` never misses one regardless of
// arrival timing.
function messageReader(ws: WebSocket): () => Promise<string> {
	const queue: string[] = [];
	const waiters: Array<(msg: string) => void> = [];
	ws.on("message", (d) => {
		const msg = d.toString();
		const waiter = waiters.shift();
		if (waiter) {
			waiter(msg);
		} else {
			queue.push(msg);
		}
	});
	return () =>
		new Promise<string>((resolve) => {
			const queued = queue.shift();
			if (queued !== undefined) {
				resolve(queued);
			} else {
				waiters.push(resolve);
			}
		});
}

describe("DeviceGateway", () => {
	it("rejects a bad token with hello_error", async () => {
		const { port, gateway, httpServer } = await setup();
		const ws = connect(port);
		const nextMessage = messageReader(ws);
		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken: "bad",
				protocolVersion: 1,
				lastAckedSeq: 0,
			}),
		);
		const msg = JSON.parse(await nextMessage());
		expect(msg.type).toBe("hello_error");
		gateway.close();
		httpServer.close();
	});

	it("delivers queued events in order after hello and removes them on ack", async () => {
		const { store, gateway, device, port, httpServer } = await setup();
		store.enqueueEvent(device.deviceId, '{"n":1}', NOW, 60_000);
		store.enqueueEvent(device.deviceId, '{"n":2}', NOW, 60_000);
		const ws = connect(port);
		const nextMessage = messageReader(ws);
		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken: device.deviceToken,
				protocolVersion: 1,
				lastAckedSeq: 0,
			}),
		);
		const first = JSON.parse(await nextMessage()); // hello_ack
		expect(first.type).toBe("hello_ack");
		const e1 = JSON.parse(await nextMessage());
		const e2 = JSON.parse(await nextMessage());
		expect([e1.seq, e2.seq]).toEqual([1, 2]);
		ws.send(JSON.stringify({ type: "event_ack", seq: 1 }));
		await new Promise((r) => setTimeout(r, 50));
		expect(
			store.pendingEvents(device.deviceId, 0, NOW).map((e) => e.seq),
		).toEqual([2]);
		gateway.close();
		httpServer.close();
	});

	it("emits rpc frames and reports online state", async () => {
		const { gateway, device, port, httpServer } = await setup();
		const ws = connect(port);
		const nextMessage = messageReader(ws);
		await new Promise((r) => ws.once("open", r));
		ws.send(
			JSON.stringify({
				type: "hello",
				deviceToken: device.deviceToken,
				protocolVersion: 1,
				lastAckedSeq: 0,
			}),
		);
		await nextMessage(); // hello_ack
		expect(gateway.isOnline(device.deviceId)).toBe(true);
		const rpcPromise = new Promise<[number, { method: string }]>((r) =>
			gateway.once("rpc", (id, frame) => r([id, frame])),
		);
		ws.send(
			JSON.stringify({
				type: "rpc_request",
				id: "r1",
				method: "fetchIssue",
				params: ["ABC-1"],
			}),
		);
		const [deviceId, frame] = await rpcPromise;
		expect(deviceId).toBe(device.deviceId);
		expect(frame.method).toBe("fetchIssue");
		gateway.close();
		httpServer.close();
	});
});
