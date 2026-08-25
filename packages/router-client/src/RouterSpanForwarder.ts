import type {
	ReadableSpan,
	SerializedSpan,
	SpanExporter,
} from "cyrus-otel-traces";
import { serializeSpan } from "cyrus-otel-traces";
import type { SpanFrame } from "cyrus-router-protocol";
import type { RouterConnection } from "./RouterConnection.js";

/**
 * Token-bucket defaults: 200 spans/second sustained, 2000 in a burst.
 *
 * Far more generous than {@link RouterLogForwarder}'s 2/40, and deliberately.
 * Spans arrive from a `BatchSpanProcessor` in batches of up to 512, so a
 * log-sized bucket would drop most of every batch and leave traces that look
 * broken rather than sampled. Volume is instead governed at the source, by the
 * head sampler — see `docs/adr/0004-parent-based-head-sampling-for-traces.md`.
 * This bucket is a backstop against a pathological span-emitting loop, not the
 * primary control.
 */
const DEFAULT_RATE_PER_SEC = 200;
const DEFAULT_BURST = 2_000;

/**
 * Hard caps applied before a frame goes on the wire.
 *
 * A span's attributes are application data — a prompt, a file path, a tool
 * result — and the OTel SDK's own default limit is 128 attributes at unlimited
 * value length. Neither bound is appropriate for a payload crossing a socket
 * into a workspace billed per GB.
 */
const MAX_SPANS_PER_FRAME = 512;
const MAX_ATTRIBUTES_PER_SPAN = 64;
const MAX_ATTRIBUTE_CHARS = 1_000;
const MAX_EVENTS_PER_SPAN = 32;
const MAX_NAME_CHARS = 256;

export interface RouterSpanForwarderOptions {
	connection: RouterConnection;
	/**
	 * The worker's resource semconv, carried once per frame and stamped on every
	 * span the router rebuilds. Without it a relayed span would inherit the
	 * router's own `service.name` and become indistinguishable from a span the
	 * router really emitted.
	 */
	resourceAttributes: Record<string, string>;
	/** Sustained spans/second. Defaults to `CYRUS_SPAN_FORWARD_RATE`, then 200. */
	ratePerSec?: number;
	/** Bucket capacity. Defaults to `CYRUS_SPAN_FORWARD_BURST`, then 2000. */
	burst?: number;
	/** Env source for the defaults above. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Injectable clock for the token bucket (tests). Defaults to `Date.now`. */
	now?: () => number;
}

/**
 * A {@link SpanExporter} that ships a sandbox worker's spans to the router over
 * the WSS connection it already holds.
 *
 * ── WHY NOT EXPORT STRAIGHT TO AZURE ──
 * The sandbox's egress allowlist is deny-by-default with the router's host as
 * its only entry. Letting a worker reach an Application Insights ingestion
 * endpoint would mean widening that allowlist AND putting an Azure connection
 * string inside every sandbox. Relaying costs one frame type and gives the
 * router the chance to stamp attribution the worker cannot forge — the same
 * trade Phase 2 made for logs.
 *
 * ── RE-ENTRANCY ──
 * This is called FROM the span pipeline, and everything it touches
 * (`RouterConnection`, `ws`) has loggers of its own — and those loggers feed
 * `RouterLogForwarder`, which touches the same socket. A `logger.warn` on this
 * path would produce a log record, which could produce a span, which would
 * re-enter `export`. Hence {@link inExport}, and hence this class never logging
 * anything itself.
 *
 * ── WHAT IT DOES NOT DO ──
 * No sampling decision. By the time a span reaches an exporter the sampler has
 * already run, and an unsampled trace produces no spans here at all — the
 * parent-based sampler saw the router's unsampled `traceparent` and recorded
 * nothing. Re-deciding here would break the invariant the ADR exists to
 * protect.
 */
export class RouterSpanForwarder implements SpanExporter {
	private readonly connection: RouterConnection;
	private readonly resourceAttributes: Record<string, string>;
	private readonly now: () => number;
	private readonly ratePerSec: number;
	private readonly burst: number;

	private tokens: number;
	private lastRefillMs: number;
	private dropped = 0;
	private inExport = false;
	private shutDown = false;

	constructor(opts: RouterSpanForwarderOptions) {
		const env = opts.env ?? process.env;
		this.connection = opts.connection;
		this.resourceAttributes = opts.resourceAttributes;
		this.now = opts.now ?? (() => Date.now());
		this.ratePerSec =
			opts.ratePerSec ??
			parsePositiveNumber(env.CYRUS_SPAN_FORWARD_RATE) ??
			DEFAULT_RATE_PER_SEC;
		this.burst =
			opts.burst ??
			parsePositiveNumber(env.CYRUS_SPAN_FORWARD_BURST) ??
			DEFAULT_BURST;
		this.tokens = this.burst;
		this.lastRefillMs = this.now();
	}

	/** Spans the volume guard has discarded and not yet reported. Test seam. */
	get droppedCount(): number {
		return this.dropped;
	}

	export(
		spans: ReadableSpan[],
		resultCallback: (result: { code: number; error?: Error }) => void,
	): void {
		// `ExportResultCode.SUCCESS` is 0, `FAILED` is 1. Spelled numerically to
		// avoid importing `@opentelemetry/core` for two constants — the enum's
		// values are part of the wire-visible OTLP contract and do not move.
		const SUCCESS = 0;

		if (this.shutDown || spans.length === 0) {
			resultCallback({ code: SUCCESS });
			return;
		}
		// See the class doc's RE-ENTRANCY note. A batch produced while we are
		// mid-export is discarded outright and NOT counted as dropped: it would
		// be our own plumbing's spans, not the worker's real volume.
		if (this.inExport) {
			resultCallback({ code: SUCCESS });
			return;
		}

		if (!this.connection.acceptsSpans) {
			// The router cannot ingest spans (older deployment). Not counted as
			// dropped: a permanently-unsupported destination is a deployment fact,
			// and reporting it as loss on some future upgrade would be misleading.
			// SUCCESS, not FAILED — a failed export makes the batch processor retry
			// a destination that will never accept it.
			resultCallback({ code: SUCCESS });
			return;
		}

		const capped = spans.slice(0, MAX_SPANS_PER_FRAME);
		this.dropped += spans.length - capped.length;

		const affordable: SerializedSpan[] = [];
		for (const span of capped) {
			if (!this.takeToken()) {
				this.dropped += 1;
				continue;
			}
			affordable.push(bound(serializeSpan(span)));
		}
		if (affordable.length === 0) {
			resultCallback({ code: SUCCESS });
			return;
		}

		this.inExport = true;
		try {
			const frame: SpanFrame = {
				type: "span",
				resource: this.resourceAttributes,
				spans: affordable,
				...(this.dropped > 0 ? { dropped: this.dropped } : {}),
			};
			const sent = this.connection.sendSpans(frame);
			// Offline, or a socket that closed mid-send. Counted: these are real
			// spans the operator will not see, and the count rides the first frame
			// that lands after the worker reconnects.
			if (!sent) this.dropped += affordable.length;
			else this.dropped = 0;
		} catch {
			this.dropped += affordable.length;
		} finally {
			this.inExport = false;
		}
		// Always SUCCESS. A FAILED result makes `BatchSpanProcessor` log through
		// the OTel diagnostic channel and, depending on version, retry — and a
		// retry of a batch we dropped for cost reasons is precisely the loop the
		// volume guard exists to prevent. The loss is reported honestly instead,
		// via `dropped` on the next frame that lands.
		resultCallback({ code: SUCCESS });
	}

	async shutdown(): Promise<void> {
		this.shutDown = true;
	}

	/** Nothing is buffered here — the batch processor above holds the queue. */
	async forceFlush(): Promise<void> {}

	/**
	 * Classic token bucket, refilled from elapsed WALL-CLOCK time rather than on
	 * a timer. Same reasoning as `RouterLogForwarder`: an ACA memory suspend
	 * freezes every JavaScript timer, and a timer-driven refill would resume with
	 * an empty bucket and throttle exactly the post-resume spans that explain
	 * what the suspend cost.
	 */
	private takeToken(): boolean {
		const now = this.now();
		const elapsedMs = Math.max(0, now - this.lastRefillMs);
		this.lastRefillMs = now;
		this.tokens = Math.min(
			this.burst,
			this.tokens + (elapsedMs / 1000) * this.ratePerSec,
		);
		if (this.tokens < 1) return false;
		this.tokens -= 1;
		return true;
	}
}

/** Apply the size caps to one serialised span. */
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
		...(span.events
			? {
					events: span.events.slice(0, MAX_EVENTS_PER_SPAN).map((event) => ({
						...event,
						name: truncate(event.name, MAX_NAME_CHARS),
						...(event.attributes
							? { attributes: boundAttributes(event.attributes) }
							: {}),
					})),
				}
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

function truncate(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}…[truncated]`;
}

function parsePositiveNumber(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : undefined;
}
