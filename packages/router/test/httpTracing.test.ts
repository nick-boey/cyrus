import { context as contextApi, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import type { LogRecord } from "cyrus-core";
import { createLogger, installRecordingLogSink, LogLevel } from "cyrus-core";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerHttpTracing } from "../src/telemetry/httpTracing.js";

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;
let app: FastifyInstance;
let contextManager: AsyncLocalStorageContextManager;

beforeEach(() => {
	exporter = new InMemorySpanExporter();
	provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	contextManager = new AsyncLocalStorageContextManager();
	contextManager.enable();
	contextApi.setGlobalContextManager(contextManager);
	trace.setGlobalTracerProvider(provider);
	app = Fastify();
});

afterEach(async () => {
	await app.close();
	await provider.shutdown();
	trace.disable();
	contextApi.disable();
});

describe("registerHttpTracing", () => {
	it("produces one SERVER span per request", async () => {
		registerHttpTracing(app);
		app.post("/linear-webhook", async () => ({ ok: true }));

		await app.inject({ method: "POST", url: "/linear-webhook" });

		const spans = exporter.getFinishedSpans();
		expect(spans).toHaveLength(1);
		// SpanKind.SERVER
		expect(spans[0]?.kind).toBe(1);
	});

	it("names the span with the low-cardinality ROUTE, not the concrete path", () => {
		// A span name is a grouping key in every backend. Interpolating an id
		// would make every request its own operation with a sample size of one.
		registerHttpTracing(app);
		app.get("/artifacts/:issueKey", async () => ({ ok: true }));

		return app.inject({ method: "GET", url: "/artifacts/NOR-283" }).then(() => {
			const [span] = exporter.getFinishedSpans();
			expect(span?.name).toBe("GET /artifacts/:issueKey");
			expect(span?.attributes["http.route"]).toBe("/artifacts/:issueKey");
			// The concrete path is still available, as an attribute.
			expect(span?.attributes["url.path"]).toBe("/artifacts/NOR-283");
		});
	});

	it("strips the query string, which can carry a token", async () => {
		registerHttpTracing(app);
		app.get("/artifacts", async () => ({ ok: true }));

		await app.inject({ method: "GET", url: "/artifacts?token=hunter2" });

		const [span] = exporter.getFinishedSpans();
		expect(span?.attributes["url.path"]).toBe("/artifacts");
		expect(JSON.stringify(span?.attributes)).not.toContain("hunter2");
	});

	it("joins an inbound W3C traceparent", async () => {
		registerHttpTracing(app);
		app.get("/x", async () => ({ ok: true }));

		await app.inject({
			method: "GET",
			url: "/x",
			headers: { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` },
		});

		const [span] = exporter.getFinishedSpans();
		expect(span?.spanContext().traceId).toBe(TRACE_ID);
		expect(span?.parentSpanContext?.spanId).toBe(SPAN_ID);
	});

	it("starts a fresh trace when the traceparent is duplicated", async () => {
		// Picking one arbitrarily would be guessing at which trace the caller
		// meant; a clean trace is the honest outcome.
		registerHttpTracing(app);
		app.get("/x", async () => ({ ok: true }));

		await app.inject({
			method: "GET",
			url: "/x",
			headers: { traceparent: [`00-${TRACE_ID}-${SPAN_ID}-01`, "00-b-c-01"] },
		});

		expect(exporter.getFinishedSpans()[0]?.spanContext().traceId).not.toBe(
			TRACE_ID,
		);
	});

	it("makes the span active for the handler", async () => {
		// This is what lets `void eventRouter.route(event)` — fired and not
		// awaited by the webhook handler — join the trace with no call-site
		// changes.
		registerHttpTracing(app);
		let seenTraceId: string | undefined;
		app.get("/x", async () => {
			seenTraceId = trace.getSpanContext(contextApi.active())?.traceId;
			return { ok: true };
		});

		await app.inject({ method: "GET", url: "/x" });

		expect(seenTraceId).toBe(
			exporter.getFinishedSpans()[0]?.spanContext().traceId,
		);
	});

	it("records the response status", async () => {
		registerHttpTracing(app);
		app.get("/x", async (_req, reply) => reply.code(404).send({}));

		await app.inject({ method: "GET", url: "/x" });

		expect(
			exporter.getFinishedSpans()[0]?.attributes["http.response.status_code"],
		).toBe(404);
	});

	it("does NOT mark a 4xx as a span error", async () => {
		// Per semconv: the request was handled correctly and the caller was told
		// what was wrong. Marking it red would bury the 5xx that means something
		// is actually broken.
		registerHttpTracing(app);
		app.get("/x", async (_req, reply) => reply.code(401).send({}));

		await app.inject({ method: "GET", url: "/x" });

		// SpanStatusCode.UNSET
		expect(exporter.getFinishedSpans()[0]?.status.code).toBe(0);
	});

	it("marks a 5xx as a span error", async () => {
		registerHttpTracing(app);
		app.get("/x", async () => {
			throw new Error("boom");
		});

		await app.inject({ method: "GET", url: "/x" });

		// SpanStatusCode.ERROR
		expect(exporter.getFinishedSpans()[0]?.status.code).toBe(2);
	});

	it("skips /healthz entirely", async () => {
		// Probed every few seconds forever; at the default ratio of 1.0 it would
		// set the volume floor for the whole deployment and answer no question.
		registerHttpTracing(app);
		app.get("/healthz", async () => ({ status: "ok" }));

		await app.inject({ method: "GET", url: "/healthz" });

		expect(exporter.getFinishedSpans()).toHaveLength(0);
	});
});

describe("request logging", () => {
	it("logs a 5xx at error and a 2xx at debug", async () => {
		const recorder = installRecordingLogSink(LogLevel.DEBUG);
		try {
			registerHttpTracing(app, {
				logger: createLogger({ component: "test", level: LogLevel.DEBUG }),
			});
			app.get("/ok", async () => ({ ok: true }));
			app.get("/bad", async () => {
				throw new Error("boom");
			});

			await app.inject({ method: "GET", url: "/ok" });
			await app.inject({ method: "GET", url: "/bad" });

			const levels = recorder.sink.records.map((r: LogRecord) => r.level);
			expect(levels).toContain(LogLevel.DEBUG);
			expect(levels).toContain(LogLevel.ERROR);
		} finally {
			recorder.restore();
		}
	});

	it("includes the duration, which the router had no source for before", async () => {
		const recorder = installRecordingLogSink(LogLevel.DEBUG);
		try {
			registerHttpTracing(app, {
				logger: createLogger({ component: "test", level: LogLevel.DEBUG }),
			});
			app.get("/ok", async () => ({ ok: true }));

			await app.inject({ method: "GET", url: "/ok" });

			expect(
				recorder.sink.records.some((r: LogRecord) =>
					/-> 200 \(\d+ms\)/.test(r.message),
				),
			).toBe(true);
		} finally {
			recorder.restore();
		}
	});
});
