import type { ReadableSpan } from "cyrus-otel-traces";
import { SpanKind, SpanStatusCode } from "cyrus-otel-traces";
import type { SpanFrame } from "cyrus-router-protocol";
import { beforeEach, describe, expect, it } from "vitest";
import type { RouterConnection } from "../src/RouterConnection.js";
import { RouterSpanForwarder } from "../src/RouterSpanForwarder.js";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

function fakeSpan(overrides: Partial<ReadableSpan> = {}): ReadableSpan {
	return {
		name: "session.turn",
		kind: SpanKind.INTERNAL,
		spanContext: () => ({ traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 }),
		startTime: [1_800_000_000, 0],
		endTime: [1_800_000_004, 0],
		status: { code: SpanStatusCode.UNSET },
		attributes: {},
		links: [],
		events: [],
		duration: [4, 0],
		ended: true,
		// The forwarder never reads a span's own resource — the frame carries the
		// process-wide one — so a stub is enough here and avoids pulling
		// `@opentelemetry/resources` into this package for a test.
		resource: { attributes: {} },
		instrumentationScope: { name: "cyrus-worker" },
		droppedAttributesCount: 0,
		droppedEventsCount: 0,
		droppedLinksCount: 0,
		...overrides,
	} as ReadableSpan;
}

/** A stand-in connection that records what it was asked to send. */
class FakeConnection {
	sent: SpanFrame[] = [];
	acceptsSpans = true;
	sendResult = true;
	sendSpans(frame: SpanFrame): boolean {
		if (!this.sendResult) return false;
		this.sent.push(frame);
		return true;
	}
}

function forwarder(
	connection: FakeConnection,
	options: { ratePerSec?: number; burst?: number } = {},
): RouterSpanForwarder {
	return new RouterSpanForwarder({
		connection: connection as unknown as RouterConnection,
		resourceAttributes: { "service.name": "cyrus-worker" },
		env: {},
		...options,
	});
}

function exportSync(
	fwd: RouterSpanForwarder,
	spans: ReadableSpan[],
): { code: number } {
	let result: { code: number } = { code: -1 };
	fwd.export(spans, (r) => {
		result = r;
	});
	return result;
}

describe("RouterSpanForwarder", () => {
	let connection: FakeConnection;

	beforeEach(() => {
		connection = new FakeConnection();
	});

	it("sends a batch as one frame carrying the worker's resource", () => {
		exportSync(forwarder(connection), [fakeSpan(), fakeSpan()]);

		expect(connection.sent).toHaveLength(1);
		expect(connection.sent[0]?.spans).toHaveLength(2);
		expect(connection.sent[0]?.resource).toEqual({
			"service.name": "cyrus-worker",
		});
	});

	it("sends nothing until the router advertises span ingest", () => {
		// An older router closes the socket on any frame it cannot parse, so a
		// worker that forwarded unconditionally would be disconnected on its
		// first batch and reconnect into the same loop.
		connection.acceptsSpans = false;

		exportSync(forwarder(connection), [fakeSpan()]);

		expect(connection.sent).toHaveLength(0);
	});

	it("does not count an unsupported router as dropped spans", () => {
		// A permanently-unsupported destination is a deployment fact, not volume
		// loss; reporting it as loss on some future upgrade would mislead.
		connection.acceptsSpans = false;
		const fwd = forwarder(connection);

		exportSync(fwd, [fakeSpan()]);

		expect(fwd.droppedCount).toBe(0);
	});

	it("reports SUCCESS even when it drops, so the processor does not retry", () => {
		// A FAILED result makes BatchSpanProcessor retry a batch we deliberately
		// dropped for cost reasons — exactly the loop the volume guard exists to
		// prevent.
		connection.acceptsSpans = false;

		expect(exportSync(forwarder(connection), [fakeSpan()]).code).toBe(0);
	});

	it("counts spans lost to a closed socket", () => {
		connection.sendResult = false;
		const fwd = forwarder(connection);

		exportSync(fwd, [fakeSpan(), fakeSpan()]);

		expect(fwd.droppedCount).toBe(2);
	});

	it("reports the accumulated drop count on the next frame that lands", () => {
		const fwd = forwarder(connection);
		connection.sendResult = false;
		exportSync(fwd, [fakeSpan()]);

		connection.sendResult = true;
		exportSync(fwd, [fakeSpan()]);

		expect(connection.sent[0]?.dropped).toBe(1);
	});

	it("clears the drop count once a frame lands", () => {
		const fwd = forwarder(connection);
		connection.sendResult = false;
		exportSync(fwd, [fakeSpan()]);
		connection.sendResult = true;
		exportSync(fwd, [fakeSpan()]);

		expect(fwd.droppedCount).toBe(0);
	});

	it("rate-limits a runaway span emitter and reports the loss on the same frame", () => {
		// The bucket holds 2, so 2 of the 4 are dropped — and the count rides out
		// on the very frame that carried the survivors, which is what makes
		// `summarize sum(dropped)` report the real loss. It is cleared afterwards
		// precisely because it has now been reported.
		const fwd = forwarder(connection, { ratePerSec: 1, burst: 2 });

		exportSync(fwd, [fakeSpan(), fakeSpan(), fakeSpan(), fakeSpan()]);

		expect(connection.sent[0]?.spans).toHaveLength(2);
		expect(connection.sent[0]?.dropped).toBe(2);
		expect(fwd.droppedCount).toBe(0);
	});

	it("truncates an oversized attribute value", () => {
		exportSync(forwarder(connection), [
			fakeSpan({ attributes: { blob: "x".repeat(5_000) } }),
		]);

		const value = connection.sent[0]?.spans[0]?.attributes?.blob as string;
		expect(value.length).toBeLessThan(1_100);
	});

	it("sends nothing after shutdown", async () => {
		const fwd = forwarder(connection);
		await fwd.shutdown();

		exportSync(fwd, [fakeSpan()]);

		expect(connection.sent).toHaveLength(0);
	});

	it("is a no-op for an empty batch", () => {
		expect(exportSync(forwarder(connection), []).code).toBe(0);
		expect(connection.sent).toHaveLength(0);
	});
});
