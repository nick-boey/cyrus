import { createNoopLogger, type ILogger } from "cyrus-core";
import type { SerializedSpan, SpanExporter } from "cyrus-otel-traces";
import { cyrusSpanAttributes, deserializeSpan } from "cyrus-otel-traces";
import type { SpanFrame } from "cyrus-router-protocol";
import { SANDBOX_LOG_SOURCE } from "./SandboxLogRelay.js";

/**
 * Defensive caps on values that arrived over the wire. The device already
 * bounds them, but the router must not depend on a well-behaved device: these
 * are the values that get written into the telemetry we pay for per GB.
 */
const MAX_SPANS_PER_FRAME = 512;
const MAX_ATTRIBUTES_PER_SPAN = 64;
const MAX_ATTRIBUTE_CHARS = 1_000;
const MAX_RESOURCE_ATTRIBUTES = 32;
const MAX_NAME_CHARS = 256;

/** Identity the ROUTER holds for a device, not anything the device asserted. */
export interface SandboxSpanOrigin {
	deviceId: number;
	issueKey?: string;
	provider?: string;
}

export interface SandboxSpanRelayOptions {
	/**
	 * Where relayed spans go. The SAME exporter the router's own tracing
	 * pipeline uses, taken directly rather than through a tracer — see the class
	 * doc on why these spans must not be re-minted.
	 */
	exporter: SpanExporter;
	logger?: ILogger;
}

/**
 * Re-exports a sandbox worker's forwarded spans through the router's own span
 * exporter, attributed to the originating device and issue.
 *
 * ── WHY THE ROUTER RELAYS INSTEAD OF THE SANDBOX EXPORTING ──
 * Identical to the Phase 2 argument for logs: the sandbox's egress allowlist is
 * deny-by-default with the router's host as its only entry, so a worker cannot
 * reach an ingestion endpoint without both a policy change and an Azure
 * credential inside the sandbox. The router already has both.
 *
 * ── WHY SPANS ARE HANDED TO THE EXPORTER, NOT RE-CREATED ──
 * The obvious-looking alternative — start a span on the router with the
 * worker's parent context — cannot work. A tracer mints its own span id, so
 * every child the worker already recorded against the original id would be
 * orphaned, and the trace would come back as a pile of disconnected fragments.
 * Reconstructing a `ReadableSpan` and exporting it directly is the only way the
 * ids survive, which is the entire point of a distributed trace.
 *
 * ── ATTRIBUTION IS ROUTER-SIDE ──
 * `cyrus.device_id` / `cyrus.issue_key` come from the device row the gateway
 * authenticated, NOT from the span, and are applied OVER the span's own
 * attributes. A worker cannot label its spans with someone else's issue. The
 * originating process's `resource` IS taken from the frame, though — that is
 * what keeps `service.name = cyrus-worker` on a relayed span instead of
 * silently reattributing it to the router.
 */
export class SandboxSpanRelay {
	private readonly exporter: SpanExporter;
	private readonly logger: ILogger;

	constructor(opts: SandboxSpanRelayOptions) {
		this.exporter = opts.exporter;
		this.logger = opts.logger ?? createNoopLogger();
	}

	/**
	 * Re-export one forwarded frame. Never throws — this runs on the gateway's
	 * message path, where an exception would take down the device socket that
	 * happened to send a malformed batch.
	 */
	relay(frame: SpanFrame, origin: SandboxSpanOrigin): void {
		try {
			const resource = boundResource(frame.resource);
			const extraAttributes = cyrusSpanAttributes({
				source: SANDBOX_LOG_SOURCE,
				device_id: origin.deviceId,
				issue_key: origin.issueKey,
				provider: origin.provider,
			});

			const spans = frame.spans.slice(0, MAX_SPANS_PER_FRAME).map((wire) =>
				deserializeSpan(bound(wire), {
					resourceAttributes: resource,
					extraAttributes,
					defaultScopeName: "cyrus-worker",
				}),
			);

			if (frame.dropped !== undefined && frame.dropped > 0) {
				// Surfaced as a log event rather than as a span attribute: the drop
				// count describes the STREAM, not any one span in it, and hanging it
				// on whichever span happened to ride the next frame would make it
				// look like a property of that span's own work.
				this.logger.warn(
					`Sandbox device ${origin.deviceId} dropped ${frame.dropped} span(s) before this batch`,
				);
			}

			// The result callback is deliberately ignored. There is nothing useful
			// to do with a failure here: the frame is fire-and-forget with no ack,
			// so we cannot ask the worker to resend, and the exporter has already
			// applied its own retry policy. Logging every failure would also put
			// the router's log volume under the control of an ingestion outage.
			this.exporter.export(spans, () => {});
		} catch (err) {
			// A malformed batch must not be able to break the socket it came from.
			this.logger.warn(
				`Failed to relay spans from device ${origin.deviceId}`,
				err,
			);
		}
	}
}

function bound(span: SerializedSpan): SerializedSpan {
	return {
		...span,
		name: truncate(span.name, MAX_NAME_CHARS),
		...(span.statusMessage !== undefined
			? { statusMessage: truncate(span.statusMessage, MAX_ATTRIBUTE_CHARS) }
			: {}),
		...(span.attributes
			? { attributes: boundAttributes(span.attributes) }
			: {}),
	};
}

function boundAttributes(
	attributes: Record<string, string | number | boolean>,
): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	let count = 0;
	for (const [key, value] of Object.entries(attributes)) {
		if (count >= MAX_ATTRIBUTES_PER_SPAN) break;
		out[key] =
			typeof value === "string" ? truncate(value, MAX_ATTRIBUTE_CHARS) : value;
		count += 1;
	}
	return out;
}

/**
 * Bound the device-supplied resource map.
 *
 * `service.name` in particular becomes `AppRoleName` in Application Insights,
 * which is a top-level grouping dimension in every chart. An unbounded map from
 * an untrusted process would let one worker create arbitrarily many of them.
 */
function boundResource(
	resource: Record<string, string> | undefined,
): Record<string, string> {
	if (!resource) return {};
	const out: Record<string, string> = {};
	let count = 0;
	for (const [key, value] of Object.entries(resource)) {
		if (count >= MAX_RESOURCE_ATTRIBUTES) break;
		out[key] = truncate(value, MAX_ATTRIBUTE_CHARS);
		count += 1;
	}
	return out;
}

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}
