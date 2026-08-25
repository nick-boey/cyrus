/**
 * Re-exported so a host can type its own exporter factory, or implement a
 * `SpanExporter` that ships spans somewhere the SDK has no exporter for (the
 * sandbox worker's WSS relay), without taking a direct dependency on
 * `@opentelemetry/sdk-trace-base`. Which OTel package these live in is an
 * implementation detail of this package's abstraction.
 */
export type {
	ReadableSpan,
	Sampler,
	SpanExporter,
} from "@opentelemetry/sdk-trace-base";
export { cyrusSpanAttributes } from "./attributes.js";
export {
	type OtelTracingHandle,
	type StartOtelTracingOptions,
	startOtelTracing,
} from "./bootstrap.js";
export {
	DEFAULT_SAMPLE_RATIO,
	isOtelTracingEnabled,
	OTEL_TRACES_ENABLED_ENV,
	OTEL_TRACES_SAMPLE_RATIO_ENV,
	readOtelSampleRatio,
} from "./env.js";
export {
	activeTraceIds,
	extractTraceContext,
	injectTraceContext,
	isCarrierSampled,
	type TraceContextCarrier,
	withTraceContext,
} from "./propagation.js";
export {
	type DeserializeSpanOptions,
	deserializeSpan,
	isSpanSampled,
	type SerializedSpan,
	serializeSpan,
} from "./serialization.js";
export {
	type Attributes,
	activeSpan,
	type Context,
	getTracer,
	recordSpanError,
	type Span,
	SpanKind,
	type SpanOptions,
	SpanStatusCode,
	setSpanAttribute,
	type Tracer,
	withSpan,
	withSpanActive,
	withSpanSync,
} from "./spans.js";
