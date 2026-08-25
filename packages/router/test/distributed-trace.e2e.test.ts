import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { context as contextApi, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { resetGlobalLogSink, setGlobalLogSink } from "cyrus-core";
import {
	getTracer,
	injectTraceContext,
	SpanKind,
	startOtelTracing,
	withSpan,
} from "cyrus-otel-traces";
import {
	RouterConnection,
	RouterLogForwarder,
	RouterSpanForwarder,
} from "cyrus-router-client";
import type { LogFrame, SpanFrame } from "cyrus-router-protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeviceGateway } from "../src/DeviceGateway.js";
import { RouterStore } from "../src/RouterStore.js";
import { SANDBOX_LOG_SOURCE, SandboxLogRelay } from "../src/SandboxLogRelay.js";
import { SandboxSpanRelay } from "../src/SandboxSpanRelay.js";
import { ROUTER_SPANS } from "../src/telemetry/tracing.js";

/**
 * End-to-end proof of NOR-283's "done when": a single trace spans the router's
 * handling of a webhook AND the sandbox worker's session, joined across the WSS
 * boundary.
 *
 * Everything real except Azure: a genuine `RouterConnection` dialling a genuine
 * `DeviceGateway` over a loopback WebSocket, real trace context on real
 * protocol frames, and a real `SandboxSpanRelay` re-exporting the worker's
 * spans.
 *
 * ── ONE PROCESS, TWO PIPELINES ──
 * The router and the worker share this process, so they cannot both register a
 * global tracer provider. The ROUTER's pipeline is the global one (it is the
 * side whose instrumentation reads `trace.getTracer` at call sites); the
 * WORKER's spans are built through its own non-installed provider and pushed
 * through the forwarder by hand. That is a faithful model of the real split —
 * two providers, two exporters, one trace id — and it is the trace id, not the
 * plumbing, that this test is about.
 */
describe("one trace, router webhook through sandbox session", () => {
	let store: RouterStore;
	let gateway: DeviceGateway;
	let httpServer: ReturnType<typeof createServer>;
	let connection: RouterConnection;
	let stateDir: string;

	/** What the router's own pipeline exported. */
	let routerExporter: InMemorySpanExporter;
	/** What the relay handed on — i.e. what Azure would receive for the worker. */
	let relayedSpans: ReadableSpan[];
	/** Log frames the router received, so we can assert log↔trace correlation. */
	let relayedLogLines: Array<Record<string, unknown>>;

	let routerTracing: { shutdown: () => Promise<void> };
	/** The worker's own provider — deliberately NOT registered globally. */
	let workerProvider: BasicTracerProvider;
	let workerExporter: InMemorySpanExporter;
	let deviceId: number;

	beforeEach(async () => {
		process.env.CYRUS_LOG_FORMAT = "json";
		relayedLogLines = [];
		const capture = (line: unknown) => {
			const record = JSON.parse(String(line)) as Record<string, unknown>;
			if (record["cyrus.source"] === SANDBOX_LOG_SOURCE) {
				relayedLogLines.push(record);
			}
		};
		vi.spyOn(console, "warn").mockImplementation(capture);
		vi.spyOn(console, "log").mockImplementation(capture);
		vi.spyOn(console, "error").mockImplementation(capture);

		store = new RouterStore(":memory:");
		const { userId } = store.addUser({ email: "alice@example.com" });
		const container = store.createContainerDevice(userId, "NOR-283", "aca");
		deviceId = container.deviceId;

		// ── ROUTER SIDE ──
		routerExporter = new InMemorySpanExporter();
		routerTracing = startOtelTracing({
			exporter: routerExporter,
			resourceAttributes: { "service.name": "cyrus-router" },
			processor: "simple",
		});

		relayedSpans = [];
		const spanRelay = new SandboxSpanRelay({
			exporter: {
				export: (spans, cb) => {
					relayedSpans.push(...spans);
					cb({ code: 0 });
				},
				shutdown: async () => {},
			},
		});
		const logRelay = new SandboxLogRelay();

		gateway = new DeviceGateway(store);
		gateway.on("span", (id: number, frame: SpanFrame) => {
			const info = store.getDeviceInfo(id);
			spanRelay.relay(frame, {
				deviceId: id,
				...(info?.issueKey ? { issueKey: info.issueKey } : {}),
			});
		});
		gateway.on("log", (id: number, frame: LogFrame) => {
			const info = store.getDeviceInfo(id);
			logRelay.relay(frame, {
				deviceId: id,
				...(info?.issueKey ? { issueKey: info.issueKey } : {}),
			});
		});

		httpServer = createServer();
		gateway.attach(httpServer, "/device");
		await new Promise<void>((r) => httpServer.listen(0, r));
		const port = (httpServer.address() as AddressInfo).port;

		// ── DEVICE SIDE ──
		stateDir = mkdtempSync(join(tmpdir(), "cyrus-trace-e2e-"));
		connection = new RouterConnection({
			url: `ws://127.0.0.1:${port}`,
			deviceToken: container.deviceToken,
			stateDir,
		});
		const connected = new Promise<void>((r) =>
			connection.once("connected", () => r()),
		);
		connection.connect();
		await connected;

		workerExporter = new InMemorySpanExporter();
		workerProvider = new BasicTracerProvider({
			resource: { attributes: { "service.name": "cyrus-worker" } } as never,
			spanProcessors: [new SimpleSpanProcessor(workerExporter)],
		});
		setGlobalLogSink(new RouterLogForwarder({ connection, env: {} }));
	});

	afterEach(async () => {
		resetGlobalLogSink();
		connection.close();
		gateway.close();
		httpServer.close();
		store.close();
		await workerProvider.shutdown();
		await routerTracing.shutdown();
		trace.disable();
		contextApi.disable();
		rmSync(stateDir, { recursive: true, force: true });
		vi.restoreAllMocks();
		delete process.env.CYRUS_LOG_FORMAT;
	});

	it("negotiates span_ingest before the device forwards anything", () => {
		expect(connection.acceptsSpans).toBe(true);
	});

	it("carries one trace id from the router's webhook span into the worker's session span", async () => {
		// ── 1. The router handles a webhook and dispatches an event. ──
		//    Modelled on `EventRouter.deliverOrNotify`: a PRODUCER span whose
		//    context is captured at ENQUEUE time and persisted with the row.
		const routerTraceId = await withSpan(
			getTracer("cyrus-router"),
			ROUTER_SPANS.route,
			{ kind: SpanKind.CONSUMER },
			async (routeSpan) =>
				withSpan(
					getTracer("cyrus-router"),
					ROUTER_SPANS.dispatch,
					{ kind: SpanKind.PRODUCER },
					async () => {
						store.enqueueEvent(
							deviceId,
							JSON.stringify({ type: "AgentSessionEvent" }),
							Date.now(),
							60_000,
							injectTraceContext(),
						);
						gateway.deliverPending(deviceId);
						return routeSpan.spanContext().traceId;
					},
				),
		);

		// ── 2. The worker receives it. `RouterConnection` activates the router's
		//    context around the emit, so the listener's work joins the trace with
		//    no call-site change.
		const workerSpanIds = await new Promise<{
			traceId: string;
			parentSpanId: string | undefined;
		}>((resolve) => {
			connection.once("event", () => {
				// Exactly what a real handler does: start work inside the emit and
				// let AsyncLocalStorage carry the context.
				const sessionSpan = workerProvider
					.getTracer("cyrus-worker")
					.startSpan("session.turn");
				sessionSpan.end();
				const ctx = sessionSpan.spanContext();
				resolve({
					traceId: ctx.traceId,
					parentSpanId: (
						workerExporter.getFinishedSpans().at(-1) as ReadableSpan
					).parentSpanContext?.spanId,
				});
			});
		});

		// THE ASSERTION THIS WHOLE PHASE IS FOR: one trace id, two processes.
		expect(workerSpanIds.traceId).toBe(routerTraceId);
		expect(workerSpanIds.parentSpanId).toBeDefined();

		// ── 3. The worker ships its span over WSS and the router re-exports it. ──
		const forwarder = new RouterSpanForwarder({
			connection,
			resourceAttributes: { "service.name": "cyrus-worker" },
			env: {},
		});
		forwarder.export(workerExporter.getFinishedSpans(), () => {});

		await vi.waitFor(() => expect(relayedSpans.length).toBeGreaterThan(0));

		const relayed = relayedSpans.find((s) => s.name === "session.turn");
		expect(relayed?.spanContext().traceId).toBe(routerTraceId);
		// Router-side attribution, from the authenticated device row.
		expect(relayed?.attributes).toMatchObject({
			"cyrus.source": "sandbox",
			"cyrus.issue_key": "NOR-283",
			"cyrus.device_id": deviceId,
		});
		// And it still says it came from the worker, not the router.
		expect(relayed?.resource.attributes["service.name"]).toBe("cyrus-worker");

		// ── 4. The router's own half of the trace is there too. ──
		const routerNames = routerExporter
			.getFinishedSpans()
			.filter((s) => s.spanContext().traceId === routerTraceId)
			.map((s) => s.name);
		expect(routerNames).toContain(ROUTER_SPANS.route);
		expect(routerNames).toContain(ROUTER_SPANS.dispatch);
	});

	it("stamps the trace id onto a worker log line so logs and spans correlate", async () => {
		// The mitigation the sampling ADR relies on: an unsampled trace still
		// leaves a queryable error record carrying the trace id.
		const workerSpan = workerProvider
			.getTracer("cyrus-worker")
			.startSpan("session.turn");

		await contextApi.with(
			trace.setSpan(contextApi.active(), workerSpan),
			async () => {
				const { createLogger, LogLevel } = await import("cyrus-core");
				createLogger({ component: "EdgeWorker", level: LogLevel.SILENT }).warn(
					"git push failed",
				);
			},
		);
		workerSpan.end();

		await vi.waitFor(() =>
			expect(relayedLogLines.some((r) => r.message === "git push failed")).toBe(
				true,
			),
		);
		const line = relayedLogLines.find((r) => r.message === "git push failed");
		expect(String(line?.traceparent)).toContain(
			workerSpan.spanContext().traceId,
		);
	});

	it("delivers the persisted context even when the device was offline at enqueue", async () => {
		// The gap the trace exists to show. `deliverPending` runs from a socket
		// callback with no relation to the enqueue's call stack, so a context
		// derived at send time would attach the event to the wrong thing.
		const traceparent = await withSpan(
			getTracer("cyrus-router"),
			ROUTER_SPANS.dispatch,
			{ kind: SpanKind.PRODUCER },
			async () => {
				const carrier = injectTraceContext();
				store.enqueueEvent(
					deviceId,
					JSON.stringify({ type: "AgentSessionEvent" }),
					Date.now(),
					60_000,
					carrier,
				);
				return carrier.traceparent;
			},
		);

		// The span has ENDED and its context is long out of scope by now — the
		// only surviving copy is the one in SQLite.
		const received = await new Promise<string | undefined>((resolve) => {
			// Read straight off the ambient context: `RouterConnection` activated
			// the persisted parent around this emit, so a handler sees the router's
			// trace without being handed anything.
			connection.once("event", () => {
				resolve(trace.getSpanContext(contextApi.active())?.traceId);
			});
			gateway.deliverPending(deviceId);
		});

		expect(traceparent).toBeDefined();
		expect(received).toBe(traceparent?.split("-")[1]);
	});
});
