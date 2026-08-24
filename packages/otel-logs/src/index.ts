/**
 * Re-exported so a host can type its own exporter factory without taking a
 * direct dependency on `@opentelemetry/sdk-logs`. Which OTel package the
 * exporter interface lives in is an implementation detail of this package's
 * abstraction, not something every caller should have to know.
 */
export type { LogRecordExporter } from "@opentelemetry/sdk-logs";
export {
	type OtelLoggingHandle,
	type StartOtelLoggingOptions,
	startOtelLogging,
} from "./bootstrap.js";
export {
	isOtelLoggingEnabled,
	OTEL_CLOUD_REGION_ENV,
	OTEL_DEPLOYMENT_ENVIRONMENT_ENV,
	OTEL_LOGS_ENABLED_ENV,
	OTEL_LOGS_LEVEL_ENV,
	OTEL_SERVICE_INSTANCE_ID_ENV,
	OTEL_SERVICE_NAME_ENV,
	OTEL_SERVICE_VERSION_ENV,
	type OtelResourceEnvOverrides,
	parseOtelLogLevel,
	readOtelLogLevel,
	readOtelResourceEnvOverrides,
} from "./env.js";
export { OtelLogSink, type OtelLogSinkOptions } from "./OtelLogSink.js";
export {
	buildResourceAttributes,
	type ResourceAttributeInput,
} from "./resource.js";
export { severityFor, severityTextFor } from "./severity.js";
