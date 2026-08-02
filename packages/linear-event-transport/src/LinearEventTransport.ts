import { EventEmitter } from "node:events";
import {
	LinearWebhookClient,
	type LinearWebhookPayload,
} from "@linear/sdk/webhooks";
import type { IAgentEventTransport, TranslationContext } from "cyrus-core";
import { createLogger, type ILogger, ipMatchesAllowlist } from "cyrus-core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { LinearMessageTranslator } from "./LinearMessageTranslator.js";
import type {
	LinearEventTransportConfig,
	LinearEventTransportEvents,
} from "./types.js";

export declare interface LinearEventTransport {
	on<K extends keyof LinearEventTransportEvents>(
		event: K,
		listener: LinearEventTransportEvents[K],
	): this;
	emit<K extends keyof LinearEventTransportEvents>(
		event: K,
		...args: Parameters<LinearEventTransportEvents[K]>
	): boolean;
}

/**
 * LinearEventTransport - Handles Linear webhook event delivery
 *
 * This class implements IAgentEventTransport to provide a platform-agnostic
 * interface for handling Linear webhooks with Linear-specific verification.
 *
 * It registers a POST /linear-webhook endpoint with a Fastify server, plus
 * a POST /webhook alias retained for backward compatibility (deprecated).
 * Incoming webhooks are verified using either:
 * 1. "direct" mode: Verifies Linear's webhook signature
 * 2. "proxy" mode: Verifies Bearer token authentication
 *
 * The class emits "event" events with AgentEvent (LinearWebhookPayload) data.
 */
export class LinearEventTransport
	extends EventEmitter
	implements IAgentEventTransport
{
	private config: LinearEventTransportConfig;
	private linearWebhookClient: LinearWebhookClient | null = null;
	private logger: ILogger;
	private messageTranslator: LinearMessageTranslator;
	private translationContext: TranslationContext;

	constructor(
		config: LinearEventTransportConfig,
		logger?: ILogger,
		translationContext?: TranslationContext,
	) {
		super();
		this.config = config;
		this.logger = logger ?? createLogger({ component: "LinearEventTransport" });
		this.messageTranslator = new LinearMessageTranslator();
		this.translationContext = translationContext ?? {};

		// Initialize Linear webhook client for direct mode
		if (config.verificationMode === "direct") {
			this.linearWebhookClient = new LinearWebhookClient(config.secret);
		}
	}

	/**
	 * Set the translation context for message translation.
	 * This allows setting Linear API tokens and other context after construction.
	 */
	setTranslationContext(context: TranslationContext): void {
		this.translationContext = { ...this.translationContext, ...context };
	}

	/**
	 * Register the /linear-webhook endpoint (plus the deprecated /webhook alias)
	 * with the Fastify server.
	 */
	register(): void {
		const handler = async (
			request: FastifyRequest,
			reply: FastifyReply,
		): Promise<void> => {
			try {
				// Verify based on mode
				if (this.config.verificationMode === "direct") {
					await this.handleDirectWebhook(request, reply);
				} else {
					await this.handleProxyWebhook(request, reply);
				}
			} catch (error) {
				const err = new Error("Webhook error");
				if (error instanceof Error) {
					err.cause = error;
				}
				this.logger.error("Webhook error", err);
				this.emit("error", err);
				reply.code(500).send({ error: "Internal server error" });
			}
		};

		this.config.fastifyServer.post("/linear-webhook", handler);

		// Deprecated alias — retained so existing Linear webhook configurations
		// continue to deliver while users migrate to /linear-webhook.
		let deprecationWarned = false;
		this.config.fastifyServer.post(
			"/webhook",
			async (request: FastifyRequest, reply: FastifyReply) => {
				if (!deprecationWarned) {
					deprecationWarned = true;
					this.logger.warn(
						"POST /webhook is deprecated; update your Linear webhook URL to use /linear-webhook",
					);
				}
				await handler(request, reply);
			},
		);

		this.logger.info(
			`Registered POST /linear-webhook endpoint (${this.config.verificationMode} mode); POST /webhook retained as deprecated alias`,
		);
	}

	/**
	 * Handle webhook in direct mode using Linear's signature verification
	 */
	private async handleDirectWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> {
		if (!this.linearWebhookClient) {
			reply.code(500).send({ error: "Linear webhook client not initialized" });
			return;
		}

		// Validate source IP against Linear's known webhook IPs
		if (
			this.config.ipAllowlist &&
			this.config.ipAllowlist.length > 0 &&
			!ipMatchesAllowlist(request.ip, this.config.ipAllowlist)
		) {
			this.logger.warn(
				`Rejected Linear webhook from unauthorized IP: ${request.ip}`,
			);
			reply.code(403).send({ error: "Forbidden: unauthorized source IP" });
			return;
		}

		// Get Linear signature from headers
		const signature = request.headers["linear-signature"] as string;
		if (!signature) {
			// Logged, not silent: a rejected delivery that leaves no trace is
			// indistinguishable from Linear never having sent the event.
			this.logger.warn(
				`Rejected Linear webhook from ${request.ip}: missing linear-signature header`,
			);
			reply.code(401).send({ error: "Missing linear-signature header" });
			return;
		}

		// Verification is scoped to its OWN try/catch, deliberately excluding the
		// emit calls below. Previously one try wrapped both, so an exception
		// raised by a downstream "event"/"message" listener was reported to
		// Linear as `401 Invalid webhook signature` — sending the operator
		// hunting a signing-secret problem that did not exist, and telling Linear
		// to retry a delivery that had in fact already been accepted. A listener
		// failure is a server-side fault: it belongs to the 500 path in
		// `register()`, not here.
		let isValid: boolean;
		let verifyError: unknown;
		try {
			// Use the raw body bytes that SharedApplicationServer stashed on the request
			// so signature verification uses the exact payload Linear signed, rather than
			// a re-serialized version that may differ in key order or whitespace.
			const rawBody = (request as FastifyRequest & { rawBody: string }).rawBody;
			const bodyBuffer = rawBody
				? Buffer.from(rawBody)
				: Buffer.from(JSON.stringify(request.body));
			isValid = this.linearWebhookClient.verify(bodyBuffer, signature);
		} catch (error) {
			// `verify()` THROWS on a malformed/mismatched signature rather than
			// returning false, so this is a normal rejection, not an anomaly.
			isValid = false;
			verifyError = error;
		}

		if (!isValid) {
			// Name the event type when the payload parsed, so a signing-secret
			// mismatch is obvious from the log alone rather than presenting as
			// "Linear stopped sending us X".
			const detail =
				verifyError instanceof Error ? `: ${verifyError.message}` : "";
			this.logger.warn(
				`Rejected Linear webhook from ${request.ip}: signature verification failed${describePayload(
					request.body,
				)}${detail} — check that the webhook signing secret matches LINEAR_WEBHOOK_SECRET`,
			);
			reply.code(401).send({ error: "Invalid webhook signature" });
			return;
		}

		const payload = request.body as LinearWebhookPayload;

		// Emit "event" for legacy IAgentEventTransport compatibility
		this.emit("event", payload);

		// Emit "message" with translated internal message
		this.emitMessage(payload);

		// Send success response
		reply.code(200).send({ success: true });
	}

	/**
	 * Handle webhook in proxy mode using Bearer token authentication
	 */
	private async handleProxyWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> {
		// Get Authorization header
		const authHeader = request.headers.authorization;
		if (!authHeader) {
			reply.code(401).send({ error: "Missing Authorization header" });
			return;
		}

		// Verify Bearer token
		const expectedAuth = `Bearer ${this.config.secret}`;
		if (authHeader !== expectedAuth) {
			reply.code(401).send({ error: "Invalid authorization token" });
			return;
		}

		try {
			const payload = request.body as LinearWebhookPayload;

			// Emit "event" for legacy IAgentEventTransport compatibility
			this.emit("event", payload);

			// Emit "message" with translated internal message
			this.emitMessage(payload);

			// Send success response
			reply.code(200).send({ success: true });
		} catch (error) {
			const err = new Error("Proxy webhook processing failed");
			if (error instanceof Error) {
				err.cause = error;
			}
			this.logger.error("Proxy webhook processing failed", err);
			reply.code(500).send({ error: "Failed to process webhook" });
		}
	}

	/**
	 * Translate and emit an internal message from a webhook payload.
	 * Only emits if translation succeeds; logs debug message on failure.
	 */
	private emitMessage(payload: LinearWebhookPayload): void {
		const result = this.messageTranslator.translate(
			payload,
			this.translationContext,
		);

		if (result.success) {
			this.emit("message", result.message);
		} else {
			this.logger.debug(`Message translation skipped: ${result.reason}`);
		}
	}
}

/**
 * ` (AgentSessionEvent/created)` for a recognisable payload, else `""`.
 *
 * Read defensively off an untyped view: the body of a webhook that failed
 * signature verification is by definition untrusted, so this must degrade to a
 * bare string rather than throw inside the rejection path.
 */
function describePayload(body: unknown): string {
	if (!body || typeof body !== "object") return "";
	const { type, action } = body as { type?: unknown; action?: unknown };
	if (typeof type !== "string") return "";
	return typeof action === "string" ? ` (${type}/${action})` : ` (${type})`;
}
