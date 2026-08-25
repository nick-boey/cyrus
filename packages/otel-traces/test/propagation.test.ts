import { context, ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { describe, expect, it } from "vitest";
import {
	activeTraceIds,
	extractTraceContext,
	injectTraceContext,
	isCarrierSampled,
	withTraceContext,
} from "../src/propagation.js";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

/**
 * A context whose active span is a non-recording span with the given flags.
 *
 * `trace.wrapSpanContext` is the API-only way to make a span context active
 * without an SDK, which is exactly what these tests want: the propagation
 * helpers must behave identically with and without a tracer provider
 * registered, and building one would hide a regression in the no-SDK path.
 */
function contextWith(traceFlags: number) {
	return trace.setSpanContext(ROOT_CONTEXT, {
		traceId: TRACE_ID,
		spanId: SPAN_ID,
		traceFlags,
	});
}

describe("injectTraceContext", () => {
	it("serialises the active span into a W3C traceparent", () => {
		const carrier = injectTraceContext(contextWith(TraceFlags.SAMPLED));

		expect(carrier.traceparent).toBe(`00-${TRACE_ID}-${SPAN_ID}-01`);
	});

	it("encodes the unsampled flag rather than omitting the header", () => {
		// The distinction matters: an absent traceparent means "start your own
		// trace", while an unsampled one means "this trace exists and the root
		// decided not to collect it". Collapsing them would let the sandbox
		// re-decide and produce a half-collected trace.
		const carrier = injectTraceContext(contextWith(TraceFlags.NONE));

		expect(carrier.traceparent).toBe(`00-${TRACE_ID}-${SPAN_ID}-00`);
	});

	it("returns an empty carrier when no span is active", () => {
		// The common case in any process that has not started tracing. Callers
		// spread the result into a frame, so this has to produce a frame
		// identical to what a build without tracing sends.
		expect(injectTraceContext(ROOT_CONTEXT)).toEqual({});
	});
});

describe("extractTraceContext", () => {
	it("round-trips through inject", () => {
		const carrier = injectTraceContext(contextWith(TraceFlags.SAMPLED));

		const spanContext = trace.getSpanContext(extractTraceContext(carrier));

		expect(spanContext).toMatchObject({
			traceId: TRACE_ID,
			spanId: SPAN_ID,
			traceFlags: TraceFlags.SAMPLED,
			isRemote: true,
		});
	});

	it("carries tracestate across", () => {
		const carrier = {
			traceparent: `00-${TRACE_ID}-${SPAN_ID}-01`,
			tracestate: "vendor=value",
		};

		const spanContext = trace.getSpanContext(extractTraceContext(carrier));

		expect(spanContext?.traceState?.get("vendor")).toBe("value");
	});

	it("returns the base context for an absent carrier", () => {
		expect(extractTraceContext(undefined, ROOT_CONTEXT)).toBe(ROOT_CONTEXT);
		expect(extractTraceContext({}, ROOT_CONTEXT)).toBe(ROOT_CONTEXT);
	});

	it("starts a fresh trace rather than throwing on a malformed traceparent", () => {
		// A device on a broken build must not be able to make the router reject
		// its work; losing the join is the correct degradation.
		const extracted = extractTraceContext(
			{ traceparent: "not-a-traceparent" },
			ROOT_CONTEXT,
		);

		expect(trace.getSpanContext(extracted)).toBeUndefined();
	});
});

describe("withTraceContext", () => {
	it("makes the remote parent active for the callback", () => {
		// A context manager has to be installed for `context.with` to do anything
		// — the API's default is a no-op. That is not a quirk of the test: it is
		// why `startOtelTracing` installs the AsyncLocalStorage manager, and why
		// a process with tracing disabled pays nothing for these call sites.
		const manager = new AsyncLocalStorageContextManager();
		manager.enable();
		context.setGlobalContextManager(manager);
		try {
			const carrier = injectTraceContext(contextWith(TraceFlags.SAMPLED));

			const seen = withTraceContext(carrier, () =>
				trace.getSpanContext(context.active()),
			);

			expect(seen?.traceId).toBe(TRACE_ID);
		} finally {
			context.disable();
		}
	});

	it("runs the callback unchanged when there is nothing to activate", () => {
		expect(withTraceContext(undefined, () => "ran")).toBe("ran");
	});
});

describe("activeTraceIds", () => {
	it("reports the ids and the sampled flag", () => {
		expect(activeTraceIds(contextWith(TraceFlags.SAMPLED))).toEqual({
			traceId: TRACE_ID,
			spanId: SPAN_ID,
			sampled: true,
		});
	});

	it("reports sampled=false for an unsampled trace it can still name", () => {
		// This is what makes an unsampled trace's error log still correlatable —
		// the mitigation the sampling ADR relies on.
		expect(activeTraceIds(contextWith(TraceFlags.NONE))).toMatchObject({
			traceId: TRACE_ID,
			sampled: false,
		});
	});

	it("is undefined when nothing is active", () => {
		expect(activeTraceIds(ROOT_CONTEXT)).toBeUndefined();
	});
});

describe("isCarrierSampled", () => {
	it("reads the flag off the wire without an SDK", () => {
		expect(
			isCarrierSampled({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` }),
		).toBe(true);
		expect(
			isCarrierSampled({ traceparent: `00-${TRACE_ID}-${SPAN_ID}-00` }),
		).toBe(false);
		expect(isCarrierSampled(undefined)).toBe(false);
	});
});
