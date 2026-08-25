import {
	type ContextManager,
	context as contextApi,
	propagation,
	trace,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type {
	Sampler,
	SpanExporter,
	SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import {
	BasicTracerProvider,
	BatchSpanProcessor,
	ParentBasedSampler,
	SimpleSpanProcessor,
	TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import { DEFAULT_SAMPLE_RATIO } from "./env.js";

export interface StartOtelTracingOptions {
	/**
	 * Where spans go. Injected rather than constructed here — the single seam
	 * that keeps this package vendor-neutral, exactly as in `cyrus-otel-logs`.
	 * The router bootstrap passes an Azure Monitor exporter; the sandbox worker
	 * passes one that writes `span` frames onto its router WSS connection; tests
	 * pass an in-memory one.
	 */
	exporter: SpanExporter;
	/**
	 * Already-built resource semconv, as produced by `buildResourceAttributes`.
	 *
	 * Taken pre-built rather than as a `ResourceAttributeInput` so a host builds
	 * its resource ONCE and hands the same map to both the logs and the traces
	 * pipeline. Two independently-derived resources that disagree about
	 * `service.instance.id` would silently split one replica's signals in half
	 * in the backend.
	 */
	resourceAttributes: Record<string, string>;
	/**
	 * Root-span sampling ratio in `[0, 1]`. Defaults to
	 * {@link DEFAULT_SAMPLE_RATIO}. Ignored when {@link sampler} is given.
	 */
	sampleRatio?: number;
	/**
	 * Complete sampler override. Escape hatch for a host that needs something
	 * other than the parent-based ratio sampler — note that anything which is
	 * not parent-based breaks the cross-process guarantee documented in
	 * `docs/adr/0004-parent-based-head-sampling-for-traces.md`.
	 */
	sampler?: Sampler;
	/**
	 * `"batch"` (default) buffers and exports on a timer. `"simple"` exports one
	 * span at a time and exists for tests, which would otherwise wait out a
	 * 5s batch delay.
	 */
	processor?: "batch" | "simple";
	/**
	 * Register globally: tracer provider, W3C propagator, and the
	 * AsyncLocalStorage context manager. Defaults to `true`, which is what a
	 * bootstrap wants. Set `false` to build a pipeline without touching global
	 * state (tests).
	 */
	install?: boolean;
	/**
	 * Skip installing the context manager, keeping whatever is already
	 * registered. For a host that has its own (or is running under an
	 * auto-instrumentation bootstrap that installed one first) — replacing a
	 * live context manager mid-process orphans every context already captured
	 * by the old one.
	 */
	contextManager?: ContextManager | false;
}

export interface OtelTracingHandle {
	/** Resource attributes actually applied, for startup diagnostics and tests. */
	readonly resourceAttributes: Record<string, string>;
	/** The sampler in force, for startup diagnostics and tests. */
	readonly sampler: Sampler;
	/** Flush buffered spans without tearing the pipeline down. */
	forceFlush(): Promise<void>;
	/**
	 * Flush and shut down. Idempotent: a SIGTERM handler and a `finally` block
	 * may both call it.
	 */
	shutdown(): Promise<void>;
}

/**
 * Build a tracing pipeline and register it process-wide.
 *
 * ── WHY THIS REGISTERS GLOBALLY WHEN THE LOGS BRIDGE DELIBERATELY DOES NOT ──
 * `startOtelLogging` avoids `setGlobalLoggerProvider` because doing so would
 * also capture any dependency that grabs a logger off the global API, making
 * the volume we pay for a function of our dependency tree. Traces are the
 * opposite case: `trace.getTracer(...)` at a call site returns a NO-OP tracer
 * unless a provider is registered globally, so not registering would mean every
 * span in the codebase silently records nothing. And the symmetric risk does not
 * arise — a third-party library only emits spans if an auto-instrumentation
 * monkey-patched it, and we install none.
 *
 * ── NO ESM LOADER HOOK IS REQUIRED ──
 * For the same reason as the logs bridge: `register()`/`--import` exist for
 * auto-instrumentation, which must run before the modules it patches are
 * imported. This registers a provider and calls the API directly, so it has no
 * import-order constraint and can start anywhere in the bootstrap. Spans started
 * before it runs are no-ops rather than errors.
 */
export function startOtelTracing(
	options: StartOtelTracingOptions,
): OtelTracingHandle {
	const sampler = options.sampler ?? defaultSampler(options.sampleRatio);

	const processor: SpanProcessor =
		options.processor === "simple"
			? new SimpleSpanProcessor(options.exporter)
			: new BatchSpanProcessor(options.exporter);

	const provider = new BasicTracerProvider({
		resource: resourceFromAttributes(options.resourceAttributes),
		sampler,
		spanProcessors: [processor],
	});

	if (options.install !== false) {
		// Order matters. The context manager must be live before the provider is
		// registered, or the first spans started are active in a context nobody
		// can propagate — they would export, but nothing started underneath them
		// would attach.
		if (options.contextManager !== false) {
			const manager =
				options.contextManager ?? new AsyncLocalStorageContextManager();
			manager.enable();
			contextApi.setGlobalContextManager(manager);
		}
		propagation.setGlobalPropagator(new W3CTraceContextPropagator());
		trace.setGlobalTracerProvider(provider);
	}

	let shuttingDown: Promise<void> | undefined;

	return {
		resourceAttributes: options.resourceAttributes,
		sampler,
		forceFlush: () => provider.forceFlush(),
		shutdown: () => {
			if (shuttingDown) return shuttingDown;
			// Unlike the logs bridge there is nothing to "restore" — the previous
			// global tracer provider is the API's own no-op, and re-registering it
			// is not part of the public surface. Disabling the provider is enough:
			// tracers already handed out become inert once their processor is shut
			// down, so spans started during the rest of shutdown are dropped rather
			// than handed to a closing pipeline.
			shuttingDown = provider.shutdown();
			return shuttingDown;
		},
	};
}

/**
 * `ParentBased(root = TraceIdRatioBased(ratio))` — the strategy recorded in
 * `docs/adr/0004-parent-based-head-sampling-for-traces.md`.
 *
 * The remote-parent branches are left at their defaults (`AlwaysOn` for a
 * sampled remote parent, `AlwaysOff` for an unsampled one), which is precisely
 * the behaviour the cross-process guarantee needs: the sandbox worker inherits
 * the router's decision instead of taking its own, so a trace is never half
 * collected.
 *
 * A ratio of exactly 1 still goes through `TraceIdRatioBasedSampler` rather
 * than short-circuiting to `AlwaysOnSampler`. Keeping one code path means the
 * sampler an operator sees in the startup line is the sampler that runs.
 */
function defaultSampler(ratio: number | undefined): Sampler {
	const bounded = Math.min(1, Math.max(0, ratio ?? DEFAULT_SAMPLE_RATIO));
	return new ParentBasedSampler({
		root: new TraceIdRatioBasedSampler(bounded),
	});
}
