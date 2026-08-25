import type { ReadableSpan, SpanExporter } from "cyrus-otel-traces";
import type { SpanFrame, SpanRecord } from "cyrus-router-protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { SandboxSpanRelay } from "../src/SandboxSpanRelay.js";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";
const PARENT_SPAN_ID = "00f067aa0ba902b7";

function record(overrides: Partial<SpanRecord> = {}): SpanRecord {
	return {
		traceId: TRACE_ID,
		spanId: SPAN_ID,
		parentSpanId: PARENT_SPAN_ID,
		traceFlags: 1,
		name: "session.turn",
		kind: 1,
		startTime: [1_800_000_000, 0],
		endTime: [1_800_000_004, 0],
		statusCode: 0,
		...overrides,
	};
}

function frame(overrides: Partial<SpanFrame> = {}): SpanFrame {
	return {
		type: "span",
		resource: { "service.name": "cyrus-worker" },
		spans: [record()],
		...overrides,
	};
}

class CapturingExporter implements SpanExporter {
	readonly exported: ReadableSpan[] = [];
	export(
		spans: ReadableSpan[],
		resultCallback: (result: { code: number }) => void,
	): void {
		this.exported.push(...spans);
		resultCallback({ code: 0 });
	}
	async shutdown(): Promise<void> {}
}

describe("SandboxSpanRelay", () => {
	let exporter: CapturingExporter;
	let relay: SandboxSpanRelay;

	beforeEach(() => {
		exporter = new CapturingExporter();
		relay = new SandboxSpanRelay({ exporter });
	});

	it("preserves span identity so the worker's children stay attached", () => {
		// The single most important property. Re-minting these through a tracer
		// would assign a new span id and orphan everything the worker recorded
		// against the original — the trace would come back as fragments.
		relay.relay(frame(), { deviceId: 7, issueKey: "NOR-283" });

		const [span] = exporter.exported;
		expect(span?.spanContext().traceId).toBe(TRACE_ID);
		expect(span?.spanContext().spanId).toBe(SPAN_ID);
		expect(span?.parentSpanContext?.spanId).toBe(PARENT_SPAN_ID);
	});

	it("attributes the span to the ROUTER's view of the device", () => {
		relay.relay(frame(), {
			deviceId: 7,
			issueKey: "NOR-283",
			provider: "aca",
		});

		expect(exporter.exported[0]?.attributes).toMatchObject({
			"cyrus.source": "sandbox",
			"cyrus.device_id": 7,
			"cyrus.issue_key": "NOR-283",
			"cyrus.provider": "aca",
		});
	});

	it("does not let a worker claim someone else's issue", () => {
		// Router-side attribution is applied OVER the span's own attributes,
		// mirroring the same rule in SandboxLogRelay.
		relay.relay(
			frame({
				spans: [record({ attributes: { "cyrus.issue_key": "SPOOFED-1" } })],
			}),
			{ deviceId: 7, issueKey: "NOR-283" },
		);

		expect(exporter.exported[0]?.attributes["cyrus.issue_key"]).toBe("NOR-283");
	});

	it("keeps the worker's own resource rather than the router's", () => {
		// A relayed span claiming service.name = cyrus-router would be
		// indistinguishable from one the router really emitted.
		relay.relay(frame(), { deviceId: 7 });

		expect(exporter.exported[0]?.resource.attributes["service.name"]).toBe(
			"cyrus-worker",
		);
	});

	it("truncates an oversized attribute value", () => {
		relay.relay(
			frame({ spans: [record({ attributes: { blob: "x".repeat(5_000) } })] }),
			{ deviceId: 7 },
		);

		const value = exporter.exported[0]?.attributes.blob as string;
		expect(value.length).toBeLessThan(1_100);
		expect(value.endsWith("…[truncated]")).toBe(true);
	});

	it("caps the number of spans it will accept from one frame", () => {
		relay.relay(frame({ spans: Array.from({ length: 900 }, () => record()) }), {
			deviceId: 7,
		});

		expect(exporter.exported).toHaveLength(512);
	});

	it("never throws when the exporter does", () => {
		// This runs on the gateway's message path: an exception here would take
		// down the device socket that happened to send a malformed batch.
		const relayOverExploding = new SandboxSpanRelay({
			exporter: {
				export: () => {
					throw new Error("exporter is down");
				},
				shutdown: async () => {},
			},
		});

		expect(() =>
			relayOverExploding.relay(frame(), { deviceId: 7 }),
		).not.toThrow();
	});

	it("clamps an out-of-range kind rather than passing it to the exporter", () => {
		relay.relay(frame({ spans: [record({ kind: 99 })] }), { deviceId: 7 });

		// SpanKind.INTERNAL
		expect(exporter.exported[0]?.kind).toBe(0);
	});

	it("bounds a hostile resource map", () => {
		const hostile: Record<string, string> = {};
		for (let i = 0; i < 100; i++) hostile[`k${i}`] = "v";

		relay.relay(frame({ resource: hostile }), { deviceId: 7 });

		expect(
			Object.keys(exporter.exported[0]?.resource.attributes ?? {}),
		).toHaveLength(32);
	});
});
