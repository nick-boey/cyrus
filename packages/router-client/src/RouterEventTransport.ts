/**
 * Device-side implementation of `IAgentEventTransport`.
 *
 * A router-routed device never receives inbound HTTP webhooks directly —
 * the router (packages/router: `EventRouter`/`DeviceGateway`) receives the
 * real Linear webhook, decides which device owns the session, and forwards
 * the **raw Linear webhook payload verbatim** over the already-authenticated
 * WebSocket as an `"event"` frame (see `DeviceGateway.deliverPending`,
 * which sends `{ type: "event", seq, event: JSON.parse(payloadJson) }`).
 * `RouterConnection` re-emits that payload as its own `"event"`. This class
 * subscribes to that and re-emits it through the standard
 * `IAgentEventTransport` surface (`"event"` + `"message"`), so EdgeWorker
 * code can treat a router-routed device exactly like a direct Linear webhook
 * consumer — it never needs to know routing went through the router.
 *
 * @module RouterEventTransport
 */

import { EventEmitter } from "node:events";
import type {
	AgentEvent,
	AgentEventTransportEvents,
	IAgentEventTransport,
} from "cyrus-core";
import { LinearMessageTranslator } from "cyrus-linear-event-transport";
import type { RouterConnection } from "./RouterConnection.js";

export declare interface RouterEventTransport {
	on<K extends keyof AgentEventTransportEvents>(
		event: K,
		listener: AgentEventTransportEvents[K],
	): this;
	emit<K extends keyof AgentEventTransportEvents>(
		event: K,
		...args: Parameters<AgentEventTransportEvents[K]>
	): boolean;
}

/**
 * Re-emits `RouterConnection` `"event"` payloads as `IAgentEventTransport`
 * `"event"` (legacy, always) and `"message"` (translated, when the payload
 * is a webhook shape `LinearMessageTranslator` recognizes).
 *
 * **Translation helper reuse**: `LinearMessageTranslator` (from
 * `cyrus-linear-event-transport`, the same helper `LinearEventTransport`
 * uses in direct/proxy webhook mode) IS exported, and the payload forwarded
 * by the router is verbatim Linear webhook JSON (confirmed via
 * `packages/router/src/EventRouter.ts`, which routes/queues the actual
 * `Webhook` union type, not a router-invented shape) — so it is reused
 * as-is here rather than falling back to legacy-`"event"`-only emission.
 * No `TranslationContext` is passed (the device holds no Linear API token;
 * only the router does), which mirrors how `context` is optional and safe
 * to omit in `LinearMessageTranslator.translate`.
 *
 * ── SYNCHRONOUS RE-EMIT REQUIREMENT (Task 10 consumer contract) ──
 * `RouterConnection` persists `lastAckedSeq` and marks its durable inbox
 * entry processed IMMEDIATELY after its own `emit("event", …)` call returns
 * (see `RouterConnection`'s class doc: "CONSUMER CONTRACT for the 'event'
 * listener"). This transport's translate-and-re-emit therefore happens
 * SYNCHRONOUSLY inside that emit callback below — no `await`, no
 * `setImmediate`/`queueMicrotask` deferral. `LinearMessageTranslator.translate`
 * is itself synchronous, so this falls out naturally; the important
 * discipline is to not wrap `handleConnectionEvent` in anything async. A
 * deferred re-emit would let `RouterConnection` mark the inbox entry
 * processed before this transport's consumers (EdgeWorker) have actually
 * seen the event, so a crash in that window would silently lose it.
 *
 * The `"event"` listener is attached in the CONSTRUCTOR (not in `register()`,
 * which is a no-op here — see below) because the underlying
 * `RouterConnection` may already be connected, and mid-replay of its durable
 * inbox, before `register()` is ever called by application wiring code.
 * Subscribing eagerly in the constructor guarantees no window where a
 * replayed or live event arrives with zero listeners attached.
 */
export class RouterEventTransport
	extends EventEmitter
	implements IAgentEventTransport
{
	private readonly messageTranslator = new LinearMessageTranslator();

	constructor(connection: RouterConnection) {
		super();
		connection.on("event", (event: unknown) => {
			this.handleConnectionEvent(event);
		});
	}

	/**
	 * No-op: devices have no inbound HTTP surface (no Fastify server, no
	 * webhook endpoint) to register. Router-forwarded events arrive over the
	 * WebSocket connection instead; wiring happens in the constructor.
	 */
	register(): void {}

	/**
	 * Translate-and-re-emit. MUST stay synchronous end-to-end — see the
	 * class doc's "SYNCHRONOUS RE-EMIT REQUIREMENT".
	 */
	private handleConnectionEvent(event: unknown): void {
		const agentEvent = event as AgentEvent;
		// Legacy "event" — emitted unconditionally, mirroring
		// LinearEventTransport's direct/proxy webhook handlers.
		this.emit("event", agentEvent);

		// Preferred "message" — only when translation succeeds.
		const result = this.messageTranslator.translate(agentEvent);
		if (result.success) {
			this.emit("message", result.message);
		}
	}
}
