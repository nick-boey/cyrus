import { AzureMonitorLogExporter } from "@azure/monitor-opentelemetry-exporter";
import type { ILogger, LogLevel } from "cyrus-core";
import type { LogRecordExporter, OtelLoggingHandle } from "cyrus-otel-logs";
import {
	isOtelLoggingEnabled,
	readOtelLogLevel,
	readOtelResourceEnvOverrides,
	startOtelLogging,
} from "cyrus-otel-logs";

/**
 * Application Insights connection string. The standard Azure name — the exporter
 * reads it itself if we don't pass it, but we read it explicitly so a missing
 * value produces one clear warning here rather than a silent no-op inside the
 * exporter.
 */
export const APPINSIGHTS_CONNECTION_STRING_ENV =
	"APPLICATIONINSIGHTS_CONNECTION_STRING";

/**
 * Azure Container Apps injects these into every replica. They are the only
 * source for `service.instance.id` that actually distinguishes replicas, and the
 * only place the revision is available at runtime.
 */
const ACA_APP_NAME_ENV = "CONTAINER_APP_NAME";
const ACA_REVISION_ENV = "CONTAINER_APP_REVISION";
const ACA_REPLICA_NAME_ENV = "CONTAINER_APP_REPLICA_NAME";

/** `service.name` when nothing else names the service. */
const DEFAULT_SERVICE_NAME = "cyrus-router";

/**
 * Semconv values that are true by construction for this deployment. They live
 * HERE, in the Azure-aware router package, and never in `cyrus-core` or
 * `cyrus-otel-logs` — that separation is the point of NOR-281's
 * "vendor-neutral" requirement.
 */
const CLOUD_PROVIDER = "azure";
const CLOUD_PLATFORM = "azure_container_apps";

export interface StartRouterOtelLoggingOptions {
	/** Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** The router build's version, used for `service.version`. */
	serviceVersion?: string;
	/**
	 * Fallback for `cloud.region` when `CYRUS_OTEL_CLOUD_REGION` is unset.
	 *
	 * The router bootstrap passes `containers.aca.region` from
	 * router-config.json. That is strictly the region the *sandboxes* run in, and
	 * a deployment could in principle put the router elsewhere — hence a fallback
	 * behind an explicit env override rather than the primary source. In every
	 * real deployment so far they are the same region, and a populated
	 * `cloud.region` beats an absent one.
	 */
	fallbackRegion?: string;
	/**
	 * Where the "enabled but not configured" warning goes. Must NOT be a logger
	 * whose sink is the one being installed — at this point it isn't, because the
	 * warning is only ever emitted on the path where we return without
	 * installing.
	 */
	logger?: ILogger;
	/**
	 * Builds the exporter. Test seam only: the default constructs the Azure
	 * Monitor exporter, which would otherwise try to reach the ingestion endpoint
	 * from a unit test.
	 */
	createExporter?: (connectionString: string) => LogRecordExporter;
	/** Overrides the env-derived threshold. */
	minLevel?: LogLevel;
	/** Passed through to `startOtelLogging`; tests use `"simple"`. */
	processor?: "batch" | "simple";
}

/**
 * Start OTLP log export for the router, if and only if an operator asked for it.
 *
 * Returns `undefined` — leaving the console sink in place, unchanged — when
 * either:
 *
 *  - `CYRUS_OTEL_LOGS_ENABLED` is not explicitly truthy. This is the default, so
 *    upstream CLI users and every self-host deployment are byte-for-byte
 *    unaffected by this code existing.
 *  - the flag is set but no connection string is configured. This warns rather
 *    than throwing: telemetry misconfiguration must not be able to stop the
 *    router from routing issues, and the warning itself lands in
 *    `ContainerAppConsoleLogs_CL` via the Phase 0 JSON stdout path, so it is
 *    visible in exactly the place an operator would go looking.
 *
 * ── WHY APPLICATION INSIGHTS ──
 * The exporter speaks OTLP into Application Insights, which is workspace-based
 * and therefore lands in the same Log Analytics workspace the Container Apps
 * environment already ships stdout to. App Insights is used purely as an OTLP
 * endpoint; nothing above this function knows about it.
 */
export function startRouterOtelLogging(
	options: StartRouterOtelLoggingOptions = {},
): OtelLoggingHandle | undefined {
	const env = options.env ?? process.env;
	if (!isOtelLoggingEnabled(env)) return undefined;

	const connectionString = env[APPINSIGHTS_CONNECTION_STRING_ENV]?.trim();
	if (!connectionString) {
		options.logger?.warn(
			`OpenTelemetry log export is enabled but ${APPINSIGHTS_CONNECTION_STRING_ENV} is not set; ` +
				"router logs will only go to stdout. Set it to the Application Insights connection string, " +
				"or unset CYRUS_OTEL_LOGS_ENABLED to silence this warning.",
		);
		return undefined;
	}

	const overrides = readOtelResourceEnvOverrides(env);
	const exporter = (options.createExporter ?? createAzureMonitorExporter)(
		connectionString,
	);

	const handle = startOtelLogging({
		exporter,
		// Precedence throughout: explicit env override, then what the platform
		// tells us about itself, then a static default. Never the other way
		// round — an operator's env var has to be able to win.
		resource: {
			serviceName:
				overrides.serviceName ??
				env[ACA_APP_NAME_ENV]?.trim() ??
				DEFAULT_SERVICE_NAME,
			serviceVersion:
				overrides.serviceVersion ??
				options.serviceVersion ??
				env[ACA_REVISION_ENV],
			serviceInstanceId:
				overrides.serviceInstanceId ?? env[ACA_REPLICA_NAME_ENV],
			...(overrides.deploymentEnvironment !== undefined
				? { deploymentEnvironment: overrides.deploymentEnvironment }
				: {}),
			cloudProvider: CLOUD_PROVIDER,
			cloudPlatform: CLOUD_PLATFORM,
			cloudRegion: overrides.cloudRegion ?? options.fallbackRegion,
		},
		...(minLevelFor(options, env) !== undefined
			? { minLevel: minLevelFor(options, env) as LogLevel }
			: {}),
		...(options.processor ? { processor: options.processor } : {}),
	});

	options.logger?.info(
		`OpenTelemetry log export enabled (${Object.entries(
			handle.resourceAttributes,
		)
			.map(([key, value]) => `${key}=${value}`)
			.join(", ")})`,
	);

	return handle;
}

function minLevelFor(
	options: StartRouterOtelLoggingOptions,
	env: NodeJS.ProcessEnv,
): LogLevel | undefined {
	return options.minLevel ?? readOtelLogLevel(env);
}

/**
 * The real exporter. `disableOfflineStorage` is left at its default so a
 * transient ingestion failure is retried from disk rather than dropped — the
 * router's `/data` volume is ephemeral per deploy, which is the right lifetime
 * for a retry buffer.
 *
 * ── WHY THE ADAPTER ──
 * `@azure/monitor-opentelemetry-exporter` is still a beta built against
 * `@opentelemetry/sdk-logs@^0.200.0`, which predates `forceFlush()` becoming a
 * REQUIRED member of `LogRecordExporter`. So the class satisfies the interface's
 * behaviour but not its current shape.
 *
 * Delegating explicitly (rather than casting the type away) keeps the gap
 * visible: if a later beta adds `forceFlush`, this wrapper is the one place to
 * delete. A cast would silently keep shadowing the real method forever.
 *
 * A resolved promise is the honest implementation, not a stub. The buffer this
 * pipeline actually holds lives in `BatchLogRecordProcessor` one level up, whose
 * own `forceFlush()` drains its queue *through* `export()` and awaits the
 * result before resolving. The exporter below has nothing further of its own to
 * push — with the caveat that records already parked in the Azure SDK's offline
 * retry store are, by design, not flushable on demand by anyone.
 */
function createAzureMonitorExporter(
	connectionString: string,
): LogRecordExporter {
	const exporter = new AzureMonitorLogExporter({ connectionString });
	return {
		export: (logs, resultCallback) => exporter.export(logs, resultCallback),
		shutdown: () => exporter.shutdown(),
		forceFlush: () => Promise.resolve(),
	};
}
