import { AzureMonitorTraceExporter } from "@azure/monitor-opentelemetry-exporter";
import type { ILogger } from "cyrus-core";
import type { OtelTracingHandle, SpanExporter } from "cyrus-otel-traces";
import {
	isOtelTracingEnabled,
	readOtelSampleRatio,
	startOtelTracing,
} from "cyrus-otel-traces";
import { APPINSIGHTS_CONNECTION_STRING_ENV } from "./otelLogging.js";

export interface StartRouterOtelTracingOptions {
	/** Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/**
	 * The resource semconv the LOGS pipeline is already using.
	 *
	 * Taken as an input rather than rebuilt so both signals from one replica
	 * carry byte-identical resource attributes. Two independently-derived
	 * resources that disagree about `service.instance.id` would split one
	 * replica's logs from its own traces in the backend — which is precisely the
	 * correlation this phase exists to create.
	 */
	resourceAttributes: Record<string, string>;
	/**
	 * Where the "enabled but not configured" warning goes. Must NOT be a logger
	 * that would produce spans on this path; at the point the warning is emitted
	 * nothing has been registered, so it cannot.
	 */
	logger?: ILogger;
	/**
	 * Builds the exporter. Test seam only: the default constructs the Azure
	 * Monitor exporter, which would otherwise try to reach the ingestion endpoint
	 * from a unit test.
	 */
	createExporter?: (connectionString: string) => SpanExporter;
	/** Overrides the env-derived root sampling ratio. */
	sampleRatio?: number;
	/** Passed through to `startOtelTracing`; tests use `"simple"`. */
	processor?: "batch" | "simple";
}

export interface RouterOtelTracing {
	handle: OtelTracingHandle;
	/**
	 * The exporter, so `RouterServer.setSpanExporter` can hand relayed sandbox
	 * spans to the SAME destination.
	 *
	 * Exposed deliberately rather than having the relay build its own: a second
	 * exporter would mean a second connection, a second offline-retry store, and
	 * two independent things to flush at shutdown — for spans that belong in the
	 * same traces as the router's own.
	 */
	exporter: SpanExporter;
}

/**
 * Start OTLP trace export for the router, if and only if an operator asked for
 * it.
 *
 * Returns `undefined` — leaving `trace.getTracer` returning the API's no-op
 * tracer, so every span in the codebase costs a few allocations and records
 * nothing — when either:
 *
 *  - `CYRUS_OTEL_TRACES_ENABLED` is not explicitly truthy. This is the default,
 *    so upstream CLI users and every self-host deployment are unaffected by this
 *    code existing.
 *  - the flag is set but no connection string is configured. This warns rather
 *    than throwing: telemetry misconfiguration must not stop the router from
 *    routing issues, and the warning lands in `ContainerAppConsoleLogs_CL` via
 *    the Phase 0 JSON stdout path.
 *
 * ── SEPARATE FLAG FROM LOGS, ON PURPOSE ──
 * Tracing is a bigger commitment than the logs bridge: it registers a global
 * tracer provider, a global propagator, and an AsyncLocalStorage context
 * manager. An operator must be able to turn it off — during an incident, or on
 * a deployment where the context manager's overhead is unwelcome — without also
 * losing the log export they rely on to debug.
 */
export function startRouterOtelTracing(
	options: StartRouterOtelTracingOptions,
): RouterOtelTracing | undefined {
	const env = options.env ?? process.env;
	if (!isOtelTracingEnabled(env)) return undefined;

	const connectionString = env[APPINSIGHTS_CONNECTION_STRING_ENV]?.trim();
	if (!connectionString) {
		options.logger?.warn(
			`OpenTelemetry trace export is enabled but ${APPINSIGHTS_CONNECTION_STRING_ENV} is not set; ` +
				"no traces will be recorded. Set it to the Application Insights connection string, " +
				"or unset CYRUS_OTEL_TRACES_ENABLED to silence this warning.",
		);
		return undefined;
	}

	const exporter = (options.createExporter ?? createAzureMonitorExporter)(
		connectionString,
	);

	const sampleRatio = options.sampleRatio ?? readOtelSampleRatio(env);
	const handle = startOtelTracing({
		exporter,
		resourceAttributes: options.resourceAttributes,
		...(sampleRatio !== undefined ? { sampleRatio } : {}),
		...(options.processor ? { processor: options.processor } : {}),
	});

	options.logger?.info(
		`OpenTelemetry trace export enabled (root sampling ratio ${sampleRatio ?? 1})`,
	);

	return { handle, exporter };
}

/**
 * The real exporter.
 *
 * Traces land in Application Insights' `AppRequests` / `AppDependencies`
 * tables, NOT in `ContainerAppConsoleLogs_CL` — the same split that Phase 3
 * documented for `AppTraces`. Every saved search in
 * `infra/azure/bicep/modules/monitoring.bicep` that reads the console table is
 * blind to them, which is why that file gains trace-aware queries in this phase
 * rather than inheriting them.
 *
 * The component must be WORKSPACE-BASED. A classic-mode Application Insights
 * keeps its own store, out of reach of the Log Analytics queries everything
 * else in this deployment is written against.
 */
function createAzureMonitorExporter(connectionString: string): SpanExporter {
	return new AzureMonitorTraceExporter({ connectionString });
}
