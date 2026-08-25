import { ROOT_CONTEXT, TraceFlags, trace } from "@opentelemetry/api";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it } from "vitest";
import { startOtelTracing } from "../src/bootstrap.js";
import { getTracer } from "../src/spans.js";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

const handles: Array<{ shutdown: () => Promise<void> }> = [];

afterEach(async () => {
	// Each test registers a global provider; leaving one installed would let the
	// next test's spans land in the previous test's exporter.
	while (handles.length > 0) await handles.pop()?.shutdown();
	trace.disable();
});

function start(options: {
	exporter: InMemorySpanExporter;
	sampleRatio?: number;
}) {
	const handle = startOtelTracing({
		exporter: options.exporter,
		resourceAttributes: { "service.name": "test" },
		// Synchronous export, so a test does not wait out the 5s batch delay.
		processor: "simple",
		...(options.sampleRatio !== undefined
			? { sampleRatio: options.sampleRatio }
			: {}),
	});
	handles.push(handle);
	return handle;
}

/** A remote parent context with the given sampled flag. */
function remoteParent(sampled: boolean) {
	return trace.setSpanContext(ROOT_CONTEXT, {
		traceId: TRACE_ID,
		spanId: SPAN_ID,
		traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
		isRemote: true,
	});
}

describe("startOtelTracing sampling", () => {
	it("records a root span at ratio 1", () => {
		const exporter = new InMemorySpanExporter();
		start({ exporter });

		getTracer("test").startSpan("root").end();

		expect(exporter.getFinishedSpans()).toHaveLength(1);
	});

	it("records nothing at ratio 0", () => {
		const exporter = new InMemorySpanExporter();
		start({ exporter, sampleRatio: 0 });

		getTracer("test").startSpan("root").end();

		expect(exporter.getFinishedSpans()).toHaveLength(0);
	});

	it("HONOURS a sampled remote parent even at ratio 0", () => {
		// The cross-process guarantee. The sandbox worker must never re-decide:
		// if the router sampled this trace, the worker's half is collected
		// regardless of the worker's own ratio. Otherwise a trace comes back
		// half-collected, which renders as a complete story with a hole in it.
		const exporter = new InMemorySpanExporter();
		start({ exporter, sampleRatio: 0 });

		getTracer("test").startSpan("child", {}, remoteParent(true)).end();

		expect(exporter.getFinishedSpans()).toHaveLength(1);
	});

	it("HONOURS an unsampled remote parent even at ratio 1", () => {
		// The other half of the same guarantee, and what makes the WSS relay
		// affordable: an unsampled trace produces no spans in the sandbox at all,
		// so nothing is serialised and nothing crosses the socket.
		const exporter = new InMemorySpanExporter();
		start({ exporter, sampleRatio: 1 });

		getTracer("test").startSpan("child", {}, remoteParent(false)).end();

		expect(exporter.getFinishedSpans()).toHaveLength(0);
	});

	it("keeps the parent's trace id on a joined span", () => {
		const exporter = new InMemorySpanExporter();
		start({ exporter });

		getTracer("test").startSpan("child", {}, remoteParent(true)).end();

		const [span] = exporter.getFinishedSpans();
		expect(span?.spanContext().traceId).toBe(TRACE_ID);
		expect(span?.parentSpanContext?.spanId).toBe(SPAN_ID);
	});
});

describe("startOtelTracing installation", () => {
	it("clamps an out-of-range ratio rather than refusing to start", () => {
		const exporter = new InMemorySpanExporter();
		const handle = start({ exporter, sampleRatio: 100 });

		getTracer("test").startSpan("root").end();

		expect(handle.sampler).toBeDefined();
		expect(exporter.getFinishedSpans()).toHaveLength(1);
	});

	it("applies the resource to exported spans", () => {
		const exporter = new InMemorySpanExporter();
		start({ exporter });

		getTracer("test").startSpan("root").end();

		expect(
			exporter.getFinishedSpans()[0]?.resource.attributes["service.name"],
		).toBe("test");
	});

	it("does not touch global state when install is false", () => {
		const exporter = new InMemorySpanExporter();
		const handle = startOtelTracing({
			exporter,
			resourceAttributes: { "service.name": "test" },
			processor: "simple",
			install: false,
		});
		handles.push(handle);

		// The global tracer is still the API's no-op, so this records nothing.
		getTracer("test").startSpan("root").end();

		expect(exporter.getFinishedSpans()).toHaveLength(0);
	});

	it("is idempotent on shutdown", async () => {
		const exporter = new InMemorySpanExporter();
		const handle = start({ exporter });

		await expect(
			Promise.all([handle.shutdown(), handle.shutdown()]),
		).resolves.toBeDefined();
	});
});
