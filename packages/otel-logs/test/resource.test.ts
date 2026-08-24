import { hostname } from "node:os";
import { describe, expect, it } from "vitest";
import { buildResourceAttributes } from "../src/resource.js";

describe("buildResourceAttributes", () => {
	it("emits the full semconv key set NOR-281 requires", () => {
		expect(
			buildResourceAttributes({
				serviceName: "cyrus-router",
				serviceVersion: "0.2.66",
				serviceInstanceId: "router--abc123-xyz",
				deploymentEnvironment: "production",
				cloudProvider: "azure",
				cloudPlatform: "azure_container_apps",
				cloudRegion: "australiaeast",
			}),
		).toEqual({
			"service.name": "cyrus-router",
			"service.version": "0.2.66",
			"service.instance.id": "router--abc123-xyz",
			"deployment.environment.name": "production",
			"cloud.provider": "azure",
			"cloud.platform": "azure_container_apps",
			"cloud.region": "australiaeast",
		});
	});

	it("omits absent optional attributes entirely", () => {
		expect(buildResourceAttributes({ serviceName: "cyrus-router" })).toEqual({
			"service.name": "cyrus-router",
			"service.instance.id": hostname(),
		});
	});

	/**
	 * An empty-string attribute satisfies `isnotnull()` and so reads as
	 * "populated" in every dashboard that checks for presence — strictly worse
	 * than being absent. Env plumbing produces these routinely (`VAR=` in a
	 * compose file, an unset ACA secret reference).
	 */
	it("drops blank and whitespace-only values instead of emitting empty strings", () => {
		const attributes = buildResourceAttributes({
			serviceName: "cyrus-router",
			serviceVersion: "",
			deploymentEnvironment: "   ",
			cloudRegion: "\t\n",
		});
		expect(attributes).not.toHaveProperty("service.version");
		expect(attributes).not.toHaveProperty("deployment.environment.name");
		expect(attributes).not.toHaveProperty("cloud.region");
	});

	it("trims surrounding whitespace on values it keeps", () => {
		expect(
			buildResourceAttributes({
				serviceName: "  cyrus-router  ",
				cloudRegion: " australiaeast ",
			}),
		).toMatchObject({
			"service.name": "cyrus-router",
			"cloud.region": "australiaeast",
		});
	});

	/**
	 * Without an instance id, two replicas' logs are indistinguishable — the most
	 * confusing state to debug a multi-replica deployment in. On ACA the hostname
	 * IS the replica name, so the fallback is the right value, not just a value.
	 */
	it("falls back to the hostname for service.instance.id", () => {
		expect(
			buildResourceAttributes({ serviceName: "cyrus-router" })[
				"service.instance.id"
			],
		).toBe(hostname());
		expect(
			buildResourceAttributes({
				serviceName: "cyrus-router",
				serviceInstanceId: "   ",
			})["service.instance.id"],
		).toBe(hostname());
	});

	it("never invents a cloud provider or platform", () => {
		// Vendor-neutrality is the whole point of this package: the Azure values
		// are supplied by the router bootstrap, never defaulted here.
		const attributes = buildResourceAttributes({ serviceName: "cyrus-cli" });
		expect(attributes).not.toHaveProperty("cloud.provider");
		expect(attributes).not.toHaveProperty("cloud.platform");
	});
});
