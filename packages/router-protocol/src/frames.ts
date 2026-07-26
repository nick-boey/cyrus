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

/**
 * Router → device ping cadence, in milliseconds. `DeviceGateway` pings every
 * registered socket on this interval; a socket that misses
 * {@link MAX_MISSED_HEARTBEATS} consecutive cycles is terminated.
 *
 * Shared here because BOTH sides derive liveness deadlines from it: the
 * router's own sweep, and the device's inbound-activity watchdog in
 * `RouterConnection`. Keeping one constant is what makes
 * {@link DEVICE_LIVENESS_TIMEOUT_MS} a real relationship rather than two
 * numbers that silently drift apart.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * "Misses two heartbeats" — two consecutive ping cycles pass with no pong
 * before the router terminates the socket, and (symmetrically) two cycles with
 * no inbound server activity before the device gives up on its socket.
 */
export const MAX_MISSED_HEARTBEATS = 2;

/**
 * How long a device tolerates total silence from the router before deciding
 * its socket is dead. Derived from the router's own heartbeat policy, so the
 * device gives up at the same point the router does rather than at some
 * unrelated hardcoded number.
 *
 * The device must measure this against WALL-CLOCK time (`Date.now()`), never
 * by counting timer ticks: an Azure Container Apps sandbox suspended in
 * `Memory` mode freezes every JavaScript timer, so on resume the ticks simply
 * fire late and a tick-counting watchdog observes no gap at all — while the
 * router has long since terminated its side of the socket.
 */
export const DEVICE_LIVENESS_TIMEOUT_MS =
	HEARTBEAT_INTERVAL_MS * MAX_MISSED_HEARTBEATS;

const helloFrame = z.object({
	type: z.literal("hello"),
	deviceToken: z.string().min(1),
	protocolVersion: z.number().int(),
	lastAckedSeq: z.number().int().nonnegative(),
	// Session IDs the device is currently tracking. Lets the router reclaim
	// issue locks it holds for this device whose session the device no longer
	// knows about — e.g. after the device lost its persisted state and can
	// never send those sessions' terminal frames. Optional and additive: it
	// does NOT bump PROTOCOL_VERSION. An older client omits it, which the
	// router reads as "unknown" and skips reclamation for — preserving
	// pre-reconcile behavior rather than wrongly releasing every lock.
	activeSessions: z.array(z.string()).optional(),
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
	// The router's actual ping cadence, so the device's liveness watchdog can
	// derive its deadline from the server it is really talking to rather than
	// from a compiled-in default. Optional and additive: it does NOT bump
	// PROTOCOL_VERSION. An older router omits it and the device falls back to
	// HEARTBEAT_INTERVAL_MS.
	heartbeatMs: z.number().int().positive().optional(),
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
