import type { Attributes, HrTime, SpanContext } from "@opentelemetry/api";
import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

/**
 * The wire shape of one finished span, for hosts that must move spans across a
 * process boundary themselves instead of exporting them directly.
 *
 * ── WHY THIS EXISTS ──
 * A sandbox worker cannot reach an Azure ingestion endpoint: its egress
 * allowlist is deny-by-default and the router's host is the only entry in it.
 * So its spans ride the WSS connection it already holds, exactly as its logs do
 * (Phase 2), and the router re-exports them. That means one side has to turn a
 * `ReadableSpan` into JSON and the other has to turn it back, and both sides
 * must agree on the shape.
 *
 * ── WHY NOT OTLP/JSON ──
 * OTLP's JSON encoding would be the obvious candidate, but adopting it here
 * would pull `@opentelemetry/otlp-transformer` into the sandbox worker to
 * produce a payload the router immediately decodes back into SDK objects — a
 * protobuf-shaped intermediate for a hop that is neither protobuf nor OTLP. The
 * shape below is a direct projection of `ReadableSpan`, which is what both ends
 * actually hold.
 *
 * ── PRIMITIVES ONLY, AND WHY HRTIME SURVIVES ──
 * Times are carried as OTel's own `HrTime` — `[epochSeconds, nanos]` — rather
 * than as a single number. A millisecond float would silently discard the
 * sub-millisecond precision that is the entire reason to look at a span in the
 * first place, and a nanosecond integer exceeds `Number.MAX_SAFE_INTEGER` for
 * every real timestamp.
 *
 * The identical shape is declared as a Zod schema in `cyrus-router-protocol`,
 * which deliberately does not depend on OpenTelemetry. `packages/router` sees
 * both and asserts their assignability, so a change to one that is not mirrored
 * in the other fails typecheck rather than failing on the wire.
 */
export interface SerializedSpan {
	/** 32 lowercase hex chars. */
	traceId: string;
	/** 16 lowercase hex chars. */
	spanId: string;
	/** Absent for a root span. */
	parentSpanId?: string;
	/** W3C trace flags; bit 0 is `sampled`. */
	traceFlags: number;
	traceState?: string;
	name: string;
	/** {@link SpanKind} as its numeric enum value. */
	kind: number;
	startTime: HrTime;
	endTime: HrTime;
	/** {@link SpanStatusCode} as its numeric enum value. */
	statusCode: number;
	statusMessage?: string;
	attributes?: Record<string, string | number | boolean>;
	events?: Array<{
		name: string;
		time: HrTime;
		attributes?: Record<string, string | number | boolean>;
	}>;
	droppedAttributesCount?: number;
	droppedEventsCount?: number;
	droppedLinksCount?: number;
	/** Instrumentation scope, so a relayed span keeps its provenance. */
	scopeName?: string;
	scopeVersion?: string;
}

/** Project a finished span onto the wire shape. */
export function serializeSpan(span: ReadableSpan): SerializedSpan {
	const ctx = span.spanContext();
	return {
		traceId: ctx.traceId,
		spanId: ctx.spanId,
		...(span.parentSpanContext?.spanId
			? { parentSpanId: span.parentSpanContext.spanId }
			: {}),
		traceFlags: ctx.traceFlags,
		...(ctx.traceState ? { traceState: ctx.traceState.serialize() } : {}),
		name: span.name,
		kind: span.kind,
		startTime: span.startTime,
		endTime: span.endTime,
		statusCode: span.status.code,
		...(span.status.message !== undefined
			? { statusMessage: span.status.message }
			: {}),
		...(hasKeys(span.attributes)
			? { attributes: primitiveAttributes(span.attributes) }
			: {}),
		...(span.events.length > 0
			? {
					events: span.events.map((event) => ({
						name: event.name,
						time: event.time,
						...(event.attributes && hasKeys(event.attributes)
							? { attributes: primitiveAttributes(event.attributes) }
							: {}),
					})),
				}
			: {}),
		...(span.droppedAttributesCount
			? { droppedAttributesCount: span.droppedAttributesCount }
			: {}),
		...(span.droppedEventsCount
			? { droppedEventsCount: span.droppedEventsCount }
			: {}),
		...(span.droppedLinksCount
			? { droppedLinksCount: span.droppedLinksCount }
			: {}),
		...(span.instrumentationScope?.name
			? { scopeName: span.instrumentationScope.name }
			: {}),
		...(span.instrumentationScope?.version
			? { scopeVersion: span.instrumentationScope.version }
			: {}),
	};
}

export interface DeserializeSpanOptions {
	/**
	 * Resource attributes to stamp on the rebuilt span — the ORIGINATING
	 * process's resource, carried alongside the spans on the frame.
	 *
	 * Not the relaying process's own resource: a sandbox span that claimed
	 * `service.name = cyrus-router` would be indistinguishable from a span the
	 * router really emitted, which defeats the purpose of relaying it.
	 */
	resourceAttributes?: Record<string, string>;
	/**
	 * Extra attributes merged over the span's own — the relay's router-side
	 * attribution (`cyrus.source`, `cyrus.device_id`, `cyrus.issue_key`).
	 *
	 * Applied AFTER the span's own attributes precisely so a worker cannot
	 * overwrite the identity the router assigned it, mirroring the same rule in
	 * `SandboxLogRelay`.
	 */
	extraAttributes?: Attributes;
	/** Fallback scope when the frame carried none. */
	defaultScopeName?: string;
}

/**
 * Rebuild a `ReadableSpan` from the wire shape, ready to hand to a
 * `SpanExporter`.
 *
 * Handing the reconstructed span straight to an exporter — rather than
 * re-creating it through a `Tracer` — is the only approach that preserves span
 * identity. A tracer mints its own span id, which would orphan every child the
 * originating process had already recorded against the original id, and it
 * cannot be told to adopt an arbitrary one without a custom `IdGenerator` that
 * would then apply to every span in the relaying process.
 *
 * The result is a plain object rather than an SDK `Span`. `ReadableSpan` is an
 * interface, exporters consume it read-only, and constructing a real SDK span
 * would require a live tracer, a sampling decision, and a span processor — all
 * of which would re-derive the very fields being carried.
 */
export function deserializeSpan(
	wire: SerializedSpan,
	options: DeserializeSpanOptions = {},
): ReadableSpan {
	const spanContext: SpanContext = {
		traceId: wire.traceId,
		spanId: wire.spanId,
		traceFlags: wire.traceFlags,
		// Marked remote: this span was produced in another process. Exporters and
		// backends use it to reason about process boundaries, and asserting
		// otherwise would be a lie about the one fact the relay exists to record.
		isRemote: true,
	};

	const attributes: Attributes = {
		...(wire.attributes ?? {}),
		...(options.extraAttributes ?? {}),
	};

	return {
		name: wire.name,
		kind: normaliseKind(wire.kind),
		spanContext: () => spanContext,
		...(wire.parentSpanId
			? {
					parentSpanContext: {
						traceId: wire.traceId,
						spanId: wire.parentSpanId,
						traceFlags: wire.traceFlags,
						isRemote: true,
					},
				}
			: {}),
		startTime: wire.startTime,
		endTime: wire.endTime,
		status: {
			code: normaliseStatus(wire.statusCode),
			...(wire.statusMessage !== undefined
				? { message: wire.statusMessage }
				: {}),
		},
		attributes,
		links: [],
		events: (wire.events ?? []).map((event) => ({
			name: event.name,
			time: event.time,
			...(event.attributes ? { attributes: event.attributes } : {}),
		})),
		duration: hrTimeDuration(wire.startTime, wire.endTime),
		ended: true,
		resource: resourceFromAttributes(options.resourceAttributes ?? {}),
		instrumentationScope: {
			name: wire.scopeName ?? options.defaultScopeName ?? "unknown",
			...(wire.scopeVersion ? { version: wire.scopeVersion } : {}),
		},
		droppedAttributesCount: wire.droppedAttributesCount ?? 0,
		droppedEventsCount: wire.droppedEventsCount ?? 0,
		droppedLinksCount: wire.droppedLinksCount ?? 0,
	};
}

/**
 * `endTime - startTime` as an `HrTime`.
 *
 * `@opentelemetry/core` exports a `hrTimeDuration`, but it is not re-exported
 * from `sdk-trace-base` and taking a direct dependency on `core`'s internals for
 * six lines of arithmetic is not worth the coupling — that package's non-`api`
 * surface has moved between majors before.
 */
function hrTimeDuration(start: HrTime, end: HrTime): HrTime {
	let seconds = end[0] - start[0];
	let nanos = end[1] - start[1];
	if (nanos < 0) {
		seconds -= 1;
		nanos += 1_000_000_000;
	}
	return [seconds, nanos];
}

/**
 * Clamp a wire `kind` to a real {@link SpanKind}.
 *
 * The value came from another process. An out-of-range enum would flow into an
 * exporter that indexes an array with it, so the failure would surface as an
 * exporter crash — taking down the relay for every well-formed span behind it —
 * rather than as one mislabelled span.
 */
function normaliseKind(kind: number): SpanKind {
	switch (kind) {
		case SpanKind.SERVER:
		case SpanKind.CLIENT:
		case SpanKind.PRODUCER:
		case SpanKind.CONSUMER:
			return kind;
		default:
			return SpanKind.INTERNAL;
	}
}

function normaliseStatus(code: number): SpanStatusCode {
	switch (code) {
		case SpanStatusCode.OK:
		case SpanStatusCode.ERROR:
			return code;
		default:
			return SpanStatusCode.UNSET;
	}
}

function hasKeys(value: object | undefined): boolean {
	return value !== undefined && Object.keys(value).length > 0;
}

/**
 * Drop array- and `undefined`-valued attributes.
 *
 * OTel permits arrays; the frame schema does not. Flattening them would invent
 * a separator that the consuming query has to know about, so they are omitted —
 * nothing in Cyrus's own instrumentation emits one, and a dropped attribute
 * from a future dependency is a smaller surprise than a silently mangled value.
 */
function primitiveAttributes(
	attributes: Attributes,
): Record<string, string | number | boolean> {
	const out: Record<string, string | number | boolean> = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			out[key] = value;
		}
	}
	return out;
}

/** Whether a serialised span's trace flags say the root sampled this trace. */
export function isSpanSampled(wire: SerializedSpan): boolean {
	return (wire.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED;
}
