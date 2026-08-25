import type { HrTime } from "@opentelemetry/api";
import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it } from "vitest";
import {
	deserializeSpan,
	isSpanSampled,
	type SerializedSpan,
	serializeSpan,
} from "../src/serialization.js";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";
const PARENT_SPAN_ID = "00f067aa0ba902b7";

const START: HrTime = [1_800_000_000, 250_000_000];
const END: HrTime = [1_800_000_004, 100_000_000];

function fakeSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
	return {
		name: "session.turn",
		kind: SpanKind.INTERNAL,
		spanContext: () => ({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 }),
		parentSpanContext: {
			traceId: TRACE_ID,
			spanId: PARENT_SPAN_ID,
			traceFlags: 1,
		},
		startTime: START,
		endTime: END,
		status: { code: SpanStatusCode.OK },
		attributes: { "cyrus.issue_key": "NOR-283", "cyrus.turns": 3 },
		links: [],
		events: [{ name: "tool.called", time: END, attributes: { tool: "Read" } }],
		duration: [3, 850_000_000],
		ended: true,
		resource: resourceFromAttributes({}),
		instrumentationScope: { name: "cyrus-worker", version: "0.2.66" },
		droppedAttributesCount: 0,
		droppedEventsCount: 0,
		droppedLinksCount: 0,
		...overrides,
	} as ReadableSpan;
}

describe("serializeSpan", () => {
	it("preserves the identity a distributed trace is built from", () => {
		const wire = serializeSpan(fakeSpan());

		expect(wire).toMatchObject({
			traceId: TRACE_ID,
			spanId: SPAN_ID,
			parentSpanId: PARENT_SPAN_ID,
			traceFlags: 1,
		});
	});

	it("carries HrTime tuples rather than collapsing to milliseconds", () => {
		// A millisecond number would discard the sub-millisecond precision that
		// is the entire reason to look at a span.
		const wire = serializeSpan(fakeSpan());

		expect(wire.startTime).toEqual(START);
		expect(wire.endTime).toEqual(END);
	});

	it("keeps the instrumentation scope so a relayed span keeps its provenance", () => {
		const wire = serializeSpan(fakeSpan());

		expect(wire.scopeName).toBe("cyrus-worker");
		expect(wire.scopeVersion).toBe("0.2.66");
	});

	it("omits array-valued attributes rather than mangling them", () => {
		// OTel permits arrays; the frame schema does not. Flattening would invent
		// a separator the consuming query would have to know about.
		const wire = serializeSpan(
			fakeSpan({ attributes: { ok: "yes", bad: ["a", "b"] } }),
		);

		expect(wire.attributes).toEqual({ ok: "yes" });
	});

	it("omits a parent id for a root span", () => {
		const wire = serializeSpan(
			fakeSpan({ parentSpanContext: undefined as never }),
		);

		expect(wire.parentSpanId).toBeUndefined();
	});
});

describe("deserializeSpan", () => {
	it("round-trips a span without changing its ids", () => {
		// The whole point: re-minting through a tracer would assign a new span id
		// and orphan every child the originating process already recorded.
		const wire = serializeSpan(fakeSpan());

		const rebuilt = deserializeSpan(wire);

		expect(rebuilt.spanContext().traceId).toBe(TRACE_ID);
		expect(rebuilt.spanContext().spanId).toBe(SPAN_ID);
		expect(rebuilt.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
	});

	it("marks the rebuilt context remote", () => {
		const rebuilt = deserializeSpan(serializeSpan(fakeSpan()));

		expect(rebuilt.spanContext().isRemote).toBe(true);
	});

	it("computes the duration across a nanosecond borrow", () => {
		// startTime nanos > endTime nanos, so the seconds field must borrow.
		const rebuilt = deserializeSpan({
			...serializeSpan(fakeSpan()),
			startTime: [100, 900_000_000],
			endTime: [102, 100_000_000],
		});

		expect(rebuilt.duration).toEqual([1, 200_000_000]);
	});

	it("stamps the ORIGINATING resource, not the relay's", () => {
		// A sandbox span claiming service.name = cyrus-router would be
		// indistinguishable from one the router really emitted.
		const rebuilt = deserializeSpan(serializeSpan(fakeSpan()), {
			resourceAttributes: { "service.name": "cyrus-worker" },
		});

		expect(rebuilt.resource.attributes["service.name"]).toBe("cyrus-worker");
	});

	it("lets relay attribution override the span's own attributes", () => {
		// Router-side attribution wins so a worker cannot label its spans with
		// someone else's issue.
		const wire = serializeSpan(
			fakeSpan({ attributes: { "cyrus.issue_key": "SPOOFED-1" } }),
		);

		const rebuilt = deserializeSpan(wire, {
			extraAttributes: { "cyrus.issue_key": "NOR-283" },
		});

		expect(rebuilt.attributes["cyrus.issue_key"]).toBe("NOR-283");
	});

	it("clamps an out-of-range kind instead of passing it to the exporter", () => {
		// An exporter that indexes an array by kind would throw, taking down the
		// relay for every well-formed span behind this one.
		const rebuilt = deserializeSpan({
			...serializeSpan(fakeSpan()),
			kind: 99,
		});

		expect(rebuilt.kind).toBe(SpanKind.INTERNAL);
	});

	it("clamps an out-of-range status code to UNSET", () => {
		const rebuilt = deserializeSpan({
			...serializeSpan(fakeSpan()),
			statusCode: 42,
		});

		expect(rebuilt.status.code).toBe(SpanStatusCode.UNSET);
	});

	it("falls back to a named scope when the frame carried none", () => {
		const wire: SerializedSpan = { ...serializeSpan(fakeSpan()) };
		delete wire.scopeName;

		const rebuilt = deserializeSpan(wire, { defaultScopeName: "cyrus-worker" });

		expect(rebuilt.instrumentationScope.name).toBe("cyrus-worker");
	});
});

describe("isSpanSampled", () => {
	it("reads bit 0 of the trace flags", () => {
		const wire = serializeSpan(fakeSpan());

		expect(isSpanSampled({ ...wire, traceFlags: 1 })).toBe(true);
		expect(isSpanSampled({ ...wire, traceFlags: 0 })).toBe(false);
	});
});
