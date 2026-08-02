import type { Webhook } from "cyrus-core";

/**
 * Derives the idempotency key a webhook delivery is claimed under before
 * {@link EventRouter.route} does any work.
 *
 * Linear's webhook PAYLOAD carries no delivery/event id of its own — verified
 * against `@linear/sdk`'s generated types: `AgentSessionEventWebhookPayload`,
 * `AppUserNotificationWebhookPayload`, and `EntityWebhookPayload` all expose
 * only `type`, `action`, `organizationId`, `createdAt` plus their entity blobs.
 * (Linear's per-delivery id lives in an HTTP header, which the transport does
 * not surface: `IAgentEventTransport` emits the parsed payload alone.) So the
 * key is derived from the payload itself:
 *
 *   `<type>/<action>:<organizationId>:<entityRef>:<createdAt>`
 *
 * `createdAt` is "the time the payload was created" — a property of the payload,
 * not of the delivery attempt — so a redelivery of the same webhook (a Linear
 * retry, or the same durable work replayed by a second router revision during a
 * rolling update) reproduces it byte for byte. `entityRef` prefers the most
 * specific Linear entity id the payload does carry, which is what keeps two
 * genuinely distinct events apart even in the same millisecond:
 *
 *   1. `agentActivity.id`  — the AgentActivity entity a `prompted` event created
 *   2. `notification.id`   — the Notification entity behind an AppUserNotification
 *   3. `agentSession.id`   — the session a `created` event opened (created once)
 *   4. `data.id`           — the changed entity on an EntityWebhookPayload
 *
 * Returns `undefined` when the payload carries no `createdAt` at all, which no
 * real Linear webhook does (`createdAt` is non-optional on all three payload
 * types). Callers treat that as "no key material" and route WITHOUT duplicate
 * protection rather than risk collapsing two distinct events onto one key — a
 * deliberate fail-open for malformed/synthetic payloads only.
 *
 * Every field is read defensively off an untyped view of the payload (same
 * approach as `EventRouter`'s `extractIssueKey`) rather than trusting the
 * compile-time type, since a missing field must degrade to "no key" instead of
 * throwing inside the routing hot path.
 */
export function webhookIdempotencyKey(webhook: Webhook): string | undefined {
	const payload = webhook as unknown as Record<string, unknown>;

	const createdAt = readString(payload.createdAt);
	if (createdAt === undefined) return undefined;

	const type = readString(payload.type) ?? "";
	const action = readString(payload.action) ?? "";
	const organizationId = readString(payload.organizationId) ?? "";
	const entityRef = readEntityRef(payload) ?? "";

	return `${type}/${action}:${organizationId}:${entityRef}:${createdAt}`;
}

/** Most specific Linear entity id the payload carries; see the key doc above. */
function readEntityRef(payload: Record<string, unknown>): string | undefined {
	return (
		readNestedId(payload.agentActivity, "activity") ??
		readNestedId(payload.notification, "notification") ??
		readNestedId(payload.agentSession, "session") ??
		readNestedId(payload.data, "entity")
	);
}

/** `"<label>:<id>"` for `{ id }` on an untyped nested blob, else undefined. */
function readNestedId(value: unknown, label: string): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const id = readString((value as Record<string, unknown>).id);
	return id === undefined ? undefined : `${label}:${id}`;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}
