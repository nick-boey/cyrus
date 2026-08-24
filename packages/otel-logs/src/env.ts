import { LogLevel } from "cyrus-core";

/**
 * Master switch. OTel logging is **off** unless this is explicitly truthy, so
 * adding this package to a dependency tree changes nothing until an operator
 * opts in. Upstream CLI users are unaffected.
 */
export const OTEL_LOGS_ENABLED_ENV = "CYRUS_OTEL_LOGS_ENABLED";

/** Sink threshold. See {@link parseOtelLogLevel}. */
export const OTEL_LOGS_LEVEL_ENV = "CYRUS_OTEL_LOGS_LEVEL";

/** Resource semconv overrides, all optional. */
export const OTEL_SERVICE_NAME_ENV = "CYRUS_OTEL_SERVICE_NAME";
export const OTEL_SERVICE_VERSION_ENV = "CYRUS_OTEL_SERVICE_VERSION";
export const OTEL_SERVICE_INSTANCE_ID_ENV = "CYRUS_OTEL_SERVICE_INSTANCE_ID";
export const OTEL_DEPLOYMENT_ENVIRONMENT_ENV = "CYRUS_OTEL_DEPLOYMENT_ENV";
export const OTEL_CLOUD_REGION_ENV = "CYRUS_OTEL_CLOUD_REGION";

/**
 * Whether OTel logging is enabled. Accepts `true`/`1`/`yes`/`on`
 * (case-insensitive) so an operator setting it from a Terraform variable, a
 * compose file, or a shell all get the obvious behavior.
 *
 * Anything else — including an unset or empty value — is `false`. There is
 * deliberately no "enable on any non-empty value" behavior: `ENABLED=false`
 * must mean disabled, which is the mistake that reading truthiness would make.
 */
export function isOtelLoggingEnabled(env: NodeJS.ProcessEnv): boolean {
	switch (env[OTEL_LOGS_ENABLED_ENV]?.trim().toLowerCase()) {
		case "true":
		case "1":
		case "yes":
		case "on":
			return true;
		default:
			return false;
	}
}

/**
 * Parse a level name into a {@link LogLevel}. `undefined` for an unset or
 * unrecognised value, letting the caller apply its own default rather than
 * having a typo silently mean DEBUG.
 *
 * `SILENT` is accepted: it turns exporting off without unregistering the sink,
 * which is a useful way to stop paying for volume during an incident while
 * keeping the pipeline in place. It does not silence `event()`, which rides past
 * the threshold by contract.
 */
export function parseOtelLogLevel(
	raw: string | undefined,
): LogLevel | undefined {
	switch (raw?.trim().toUpperCase()) {
		case "DEBUG":
			return LogLevel.DEBUG;
		case "INFO":
			return LogLevel.INFO;
		case "WARN":
			return LogLevel.WARN;
		case "ERROR":
			return LogLevel.ERROR;
		case "SILENT":
			return LogLevel.SILENT;
		default:
			return undefined;
	}
}

/**
 * Resource semconv values an operator can override from the environment.
 *
 * Every field is optional; a host merges these over whatever it can work out
 * for itself (its package version, a platform-provided replica name, a config
 * file's region) so the env var is an escape hatch rather than a requirement.
 */
export interface OtelResourceEnvOverrides {
	serviceName?: string;
	serviceVersion?: string;
	serviceInstanceId?: string;
	deploymentEnvironment?: string;
	cloudRegion?: string;
}

export function readOtelResourceEnvOverrides(
	env: NodeJS.ProcessEnv,
): OtelResourceEnvOverrides {
	const read = (key: string): string | undefined => {
		const value = env[key]?.trim();
		return value ? value : undefined;
	};
	return {
		...(read(OTEL_SERVICE_NAME_ENV)
			? { serviceName: read(OTEL_SERVICE_NAME_ENV) }
			: {}),
		...(read(OTEL_SERVICE_VERSION_ENV)
			? { serviceVersion: read(OTEL_SERVICE_VERSION_ENV) }
			: {}),
		...(read(OTEL_SERVICE_INSTANCE_ID_ENV)
			? { serviceInstanceId: read(OTEL_SERVICE_INSTANCE_ID_ENV) }
			: {}),
		...(read(OTEL_DEPLOYMENT_ENVIRONMENT_ENV)
			? { deploymentEnvironment: read(OTEL_DEPLOYMENT_ENVIRONMENT_ENV) }
			: {}),
		...(read(OTEL_CLOUD_REGION_ENV)
			? { cloudRegion: read(OTEL_CLOUD_REGION_ENV) }
			: {}),
	};
}

/** Sink threshold from env, or `undefined` to let the caller default it. */
export function readOtelLogLevel(env: NodeJS.ProcessEnv): LogLevel | undefined {
	return parseOtelLogLevel(env[OTEL_LOGS_LEVEL_ENV]);
}
