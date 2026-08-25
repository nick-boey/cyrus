import {
	type Context,
	context as contextApi,
	type TextMapGetter,
	type TextMapSetter,
	trace,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";

/**
 * The two W3C Trace Context headers, as they appear on a Cyrus protocol frame.
 *
 * Spelled as a plain object rather than a `Headers`/`Map` because that is what
 * the frames carry: `LogFrame` reserved `traceparent`/`tracestate` in Phase 2
 * for exactly this, and the `event`/`rpc_request` frames now carry the same
 * pair. Both fields are optional in both directions — a frame from an older
 * build has neither, and a process with no active span produces neither.
 */
export interface TraceContextCarrier {
	traceparent?: string;
	tracestate?: string;
}

/**
 * Constructed once, module-scoped, and used directly rather than through
 * `propagation.inject`/`propagation.extract`.
 *
 * Going through the global propagation API would make every call site depend on
 * a global having been configured — which is true in a process that ran
 * `startOtelTracing`, and false in a unit test, in the CLI, and in any host that
 * only wants to *read* a trace id off a frame. Owning the instance means these
 * helpers behave identically everywhere, with the SDK absent as much as
 * present.
 */
const propagator = new W3CTraceContextPropagator();

const setter: TextMapSetter<TraceContextCarrier> = {
	set(carrier, key, value) {
		if (key === "traceparent") carrier.traceparent = value;
		else if (key === "tracestate") carrier.tracestate = value;
		// Any other key is ignored: this carrier is a typed frame fragment, not
		// an open header bag, and silently growing it would put unvalidated keys
		// on the wire.
	},
};

const getter: TextMapGetter<TraceContextCarrier> = {
	keys(carrier) {
		const keys: string[] = [];
		if (carrier.traceparent !== undefined) keys.push("traceparent");
		if (carrier.tracestate !== undefined) keys.push("tracestate");
		return keys;
	},
	get(carrier, key) {
		if (key === "traceparent") return carrier.traceparent;
		if (key === "tracestate") return carrier.tracestate;
		return undefined;
	},
};

/**
 * Serialise the active span's context into a {@link TraceContextCarrier}.
 *
 * Returns an EMPTY object when there is no active span, or when the active span
 * context is invalid — which is what happens in every process that has not
 * started tracing. Callers spread the result into a frame, so "no tracing" and
 * "tracing on but nothing active" both produce a frame with no trace fields,
 * identical to what an older build sends.
 */
export function injectTraceContext(ctx?: Context): TraceContextCarrier {
	const carrier: TraceContextCarrier = {};
	propagator.inject(ctx ?? contextApi.active(), carrier, setter);
	return carrier;
}

/**
 * Rebuild a {@link Context} whose active span is the REMOTE parent described by
 * the carrier, ready to pass to `context.with(...)`.
 *
 * Returns the base context unchanged when the carrier carries nothing parseable
 * — a missing or malformed `traceparent` means the work simply starts its own
 * trace, which is strictly better than refusing to run it.
 */
export function extractTraceContext(
	carrier: TraceContextCarrier | undefined,
	base?: Context,
): Context {
	const root = base ?? contextApi.active();
	if (!carrier?.traceparent) return root;
	return propagator.extract(root, carrier, getter);
}

/**
 * Run `fn` with the carrier's remote parent as the active context.
 *
 * The synchronous scope is what matters: anything `fn` *starts* — including
 * async work it does not await — inherits the context through the
 * AsyncLocalStorage context manager that {@link startOtelTracing} installs. So
 * a handler that kicks off a long-running session and returns still has that
 * session's spans land in the caller's trace.
 */
export function withTraceContext<T>(
	carrier: TraceContextCarrier | undefined,
	fn: () => T,
): T {
	if (!carrier?.traceparent) return fn();
	return contextApi.with(extractTraceContext(carrier), fn);
}

/**
 * The active span's ids, or `undefined` when nothing is active.
 *
 * Exists for LOG correlation rather than for tracing: a log record stamped with
 * the trace id it was emitted under is what joins an unsampled trace's error
 * record to the sampled trace next to it. Callers must treat `undefined` as the
 * normal case.
 */
export function activeTraceIds(
	ctx?: Context,
): { traceId: string; spanId: string; sampled: boolean } | undefined {
	const spanContext = trace.getSpanContext(ctx ?? contextApi.active());
	if (!spanContext || !trace.isSpanContextValid(spanContext)) return undefined;
	return {
		traceId: spanContext.traceId,
		spanId: spanContext.spanId,
		// TraceFlags.SAMPLED is 0x1. Compared bitwise rather than by equality so
		// a future flag being set alongside it does not read as "not sampled".
		sampled: (spanContext.traceFlags & 1) === 1,
	};
}

/**
 * Whether a carrier describes a trace the ROOT decided to sample.
 *
 * Read by the sandbox-side span forwarder as a cheap pre-check. It is not the
 * enforcement point — `ParentBasedSampler` already guarantees an unsampled
 * parent produces no recorded child spans — but it lets a caller skip work
 * before the SDK is even consulted.
 */
export function isCarrierSampled(
	carrier: TraceContextCarrier | undefined,
): boolean {
	if (!carrier?.traceparent) return false;
	const spanContext = trace.getSpanContext(extractTraceContext(carrier));
	if (!spanContext) return false;
	return (spanContext.traceFlags & 1) === 1;
}
