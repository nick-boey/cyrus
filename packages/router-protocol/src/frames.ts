import { z } from "zod";

/**
 * 2 — `session_state` carries an `id` and is acknowledged by
 * `session_state_ack`, so the device can durably buffer the frame and replay it
 * until the router confirms. Bumped from 1 because both sides must agree: a v2
 * device against a v1 router would buffer terminal frames forever (no ack ever
 * arrives), and a v1 device would reject the unknown ack frame. The handshake
 * fails closed on mismatch, which surfaces the skew immediately.
 */
export const PROTOCOL_VERSION = 2;

const helloFrame = z.object({
	type: z.literal("hello"),
	deviceToken: z.string().min(1),
	protocolVersion: z.number().int(),
	lastAckedSeq: z.number().int().nonnegative(),
});
const eventAckFrame = z.object({
	type: z.literal("event_ack"),
	seq: z.number().int().positive(),
});
const rpcRequestFrame = z.object({
	type: z.literal("rpc_request"),
	id: z.string().min(1),
	method: z.string().min(1),
	params: z.array(z.unknown()),
	// Present on mutating calls: stable across buffer replays so the router
	// can dedupe (idempotent replay — see Task 9).
	mutationId: z.string().min(1).optional(),
});
const sessionStateFrame = z.object({
	type: z.literal("session_state"),
	// Correlates the router's `session_state_ack`. Stable across replays so a
	// frame delivered twice (ack lost, device reconnects and resends) is deduped
	// by the router's idempotent lock release rather than double-applied.
	id: z.string().min(1),
	sessionId: z.string().min(1),
	state: z.enum(["complete", "error", "stopped"]),
});
const sessionStateAckFrame = z.object({
	type: z.literal("session_state_ack"),
	id: z.string().min(1),
});
const helloAckFrame = z.object({
	type: z.literal("hello_ack"),
	user: z.object({
		id: z.string().optional(),
		email: z.string().optional(),
		name: z.string().optional(),
	}),
	serverVersion: z.string(),
});
const helloErrorFrame = z.object({
	type: z.literal("hello_error"),
	reason: z.string(),
});
const eventFrame = z.object({
	type: z.literal("event"),
	seq: z.number().int().positive(),
	event: z.unknown(),
});
const rpcResponseFrame = z.object({
	type: z.literal("rpc_response"),
	id: z.string().min(1),
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z.string().optional(),
});

const deviceFrame = z.discriminatedUnion("type", [
	helloFrame,
	eventAckFrame,
	rpcRequestFrame,
	sessionStateFrame,
]);
const serverFrame = z.discriminatedUnion("type", [
	helloAckFrame,
	helloErrorFrame,
	eventFrame,
	rpcResponseFrame,
	sessionStateAckFrame,
]);

export type HelloFrame = z.infer<typeof helloFrame>;
export type EventAckFrame = z.infer<typeof eventAckFrame>;
export type RpcRequestFrame = z.infer<typeof rpcRequestFrame>;
export type SessionStateFrame = z.infer<typeof sessionStateFrame>;
export type SessionStateAckFrame = z.infer<typeof sessionStateAckFrame>;
export type HelloAckFrame = z.infer<typeof helloAckFrame>;
export type HelloErrorFrame = z.infer<typeof helloErrorFrame>;
export type EventFrame = z.infer<typeof eventFrame>;
export type RpcResponseFrame = z.infer<typeof rpcResponseFrame>;
export type DeviceFrame = z.infer<typeof deviceFrame>;
export type ServerFrame = z.infer<typeof serverFrame>;

export function parseDeviceFrame(raw: string): DeviceFrame {
	return deviceFrame.parse(JSON.parse(raw));
}
export function parseServerFrame(raw: string): ServerFrame {
	return serverFrame.parse(JSON.parse(raw));
}
