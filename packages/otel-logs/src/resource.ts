import { hostname } from "node:os";

/**
 * Resource semantic-convention attribute keys, as string literals.
 *
 * Only `service.name` and `service.version` have stable exports in
 * `@opentelemetry/semantic-conventions`; the rest (`service.instance.id`,
 * `deployment.*`, `cloud.*`) live behind that package's `/incubating` entry
 * point, whose export *names* are explicitly allowed to change between minor
 * releases even when the underlying attribute key does not. Since the keys
 * themselves are the stable part of the contract — they are what an operator
 * types into a KQL query — naming them directly is more durable than importing
 * identifiers that get renamed underneath us, and it drops a dependency.
 */
const ATTR_SERVICE_NAME = "service.name";
const ATTR_SERVICE_VERSION = "service.version";
const ATTR_SERVICE_INSTANCE_ID = "service.instance.id";
const ATTR_DEPLOYMENT_ENVIRONMENT_NAME = "deployment.environment.name";
const ATTR_CLOUD_PROVIDER = "cloud.provider";
const ATTR_CLOUD_PLATFORM = "cloud.platform";
const ATTR_CLOUD_REGION = "cloud.region";

/**
 * The subset of resource semconv this foundation populates. Named fields rather
 * than a raw attribute bag so a caller cannot typo `cloud.reigon` and silently
 * lose the dimension it was trying to add.
 *
 * Everything except {@link serviceName} is optional: a partially-populated
 * resource is strictly better than no telemetry, and which fields a host can
 * fill depends on where it runs (a laptop has no `cloud.region`).
 */
export interface ResourceAttributeInput {
	/** Required — the one attribute every OTel backend groups by. */
	serviceName: string;
	serviceVersion?: string;
	/**
	 * Distinguishes replicas of the same service. Defaults to the OS hostname,
	 * which on Azure Container Apps is the replica name — exactly the value that
	 * makes "which replica logged this" answerable.
	 */
	serviceInstanceId?: string;
	/** `production`, `staging`, … */
	deploymentEnvironment?: string;
	/** `azure`, `aws`, `gcp`. */
	cloudProvider?: string;
	/** e.g. `azure_container_apps`. */
	cloudPlatform?: string;
	/** e.g. `australiaeast`. */
	cloudRegion?: string;
}

/**
 * Build the resource attribute map for a {@link ResourceAttributeInput}.
 *
 * Blank and whitespace-only values are dropped rather than emitted as `""`:
 * an absent attribute is queryable as absent, whereas an empty-string one
 * silently satisfies `isnotnull()` and reads as "populated" in every dashboard
 * that checks for presence. Env plumbing produces empty strings often enough
 * (`ENV_VAR=` in a compose file, an unset ACA secret reference) that this is
 * the difference between a correct dashboard and a lying one.
 *
 * Vendor-neutral by construction: `cloud.provider`/`cloud.platform` are inputs,
 * never defaults. The Azure-specific values are supplied by the router
 * bootstrap.
 */
export function buildResourceAttributes(
	input: ResourceAttributeInput,
): Record<string, string> {
	const attributes: Record<string, string> = {};
	const set = (key: string, value: string | undefined): void => {
		const trimmed = value?.trim();
		if (trimmed) attributes[key] = trimmed;
	};

	set(ATTR_SERVICE_NAME, input.serviceName);
	set(ATTR_SERVICE_VERSION, input.serviceVersion);
	// Falls back to the hostname rather than being omitted: without an instance
	// id, two replicas' logs are indistinguishable, which is the single most
	// confusing state to debug a multi-replica deployment in.
	set(ATTR_SERVICE_INSTANCE_ID, input.serviceInstanceId?.trim() || hostname());
	set(ATTR_DEPLOYMENT_ENVIRONMENT_NAME, input.deploymentEnvironment);
	set(ATTR_CLOUD_PROVIDER, input.cloudProvider);
	set(ATTR_CLOUD_PLATFORM, input.cloudPlatform);
	set(ATTR_CLOUD_REGION, input.cloudRegion);

	return attributes;
}
