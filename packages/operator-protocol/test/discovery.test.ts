import { describe, expect, it } from "vitest";
import {
	operatorApiVersionV1Schema,
	operatorAuthMethodV1Schema,
	publicRouterMetadataV1Schema,
} from "../src/discovery.js";
import { publicRouterMetadata } from "./fixtures.js";

describe("PublicRouterMetadataV1", () => {
	it("round-trips its complete canonical fixture", () => {
		const parsed = publicRouterMetadataV1Schema.parse(publicRouterMetadata);
		expect(parsed).toEqual(publicRouterMetadata);
	});

	it("rejects a document with no schema version", () => {
		const { schemaVersion: _omitted, ...withoutVersion } = publicRouterMetadata;
		expect(publicRouterMetadataV1Schema.safeParse(withoutVersion).success).toBe(
			false,
		);
	});

	it("rejects a document declaring a different schema version", () => {
		expect(
			publicRouterMetadataV1Schema.safeParse({
				...publicRouterMetadata,
				schemaVersion: 2,
			}).success,
		).toBe(false);
	});

	it("rejects an unknown authentication method", () => {
		expect(
			publicRouterMetadataV1Schema.safeParse({
				...publicRouterMetadata,
				authentication: {
					...publicRouterMetadata.authentication,
					methods: ["basic-auth"],
				},
			}).success,
		).toBe(false);
	});

	it("rejects an unknown operator API version", () => {
		expect(
			publicRouterMetadataV1Schema.safeParse({
				...publicRouterMetadata,
				operatorApiVersions: ["v2"],
			}).success,
		).toBe(false);
	});

	it("requires at least one supported operator API version", () => {
		expect(
			publicRouterMetadataV1Schema.safeParse({
				...publicRouterMetadata,
				operatorApiVersions: [],
			}).success,
		).toBe(false);
	});

	// The public document is the ONLY unauthenticated surface. It is strict so
	// that a field which was never part of the contract — a workspace list, a
	// log-source hint — cannot ride along unnoticed.
	it("rejects any field beyond router identity, versions, and auth metadata", () => {
		for (const extra of [
			{ authorizedWorkspaces: ["ws-northrop-digital"] },
			{ logSource: { kind: "azure-log-analytics" } },
			{ deviceToken: "secret" },
		]) {
			expect(
				publicRouterMetadataV1Schema.safeParse({
					...publicRouterMetadata,
					...extra,
				}).success,
			).toBe(false);
		}
	});

	it("requires Entra metadata when Entra authentication is offered", () => {
		const { entra: _dropped, ...authentication } =
			publicRouterMetadata.authentication;
		expect(
			publicRouterMetadataV1Schema.safeParse({
				...publicRouterMetadata,
				authentication,
			}).success,
		).toBe(false);
	});

	it("rejects Entra metadata when Entra authentication is not offered", () => {
		expect(
			publicRouterMetadataV1Schema.safeParse({
				...publicRouterMetadata,
				authentication: {
					...publicRouterMetadata.authentication,
					methods: ["device-token"],
				},
			}).success,
		).toBe(false);
	});

	it("closes the auth-method and API-version enums", () => {
		expect(operatorAuthMethodV1Schema.options).toEqual([
			"entra",
			"device-token",
			"local-operator-token",
		]);
		expect(operatorApiVersionV1Schema.options).toEqual(["v1"]);
	});
});
