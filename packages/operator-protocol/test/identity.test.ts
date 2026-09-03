import { describe, expect, it } from "vitest";
import {
	operatorCapabilityV1Schema,
	operatorContextV1Schema,
	operatorRoleV1Schema,
} from "../src/identity.js";
import { compact, multiWorkspaceOperatorContext } from "./fixtures.js";

describe("OperatorContextV1", () => {
	it("round-trips a multi-workspace operator fixture", () => {
		const parsed = operatorContextV1Schema.parse(multiWorkspaceOperatorContext);
		expect(parsed).toEqual(multiWorkspaceOperatorContext);
		expect(parsed.authorizedWorkspaces).toHaveLength(2);
	});

	it("rejects a document with no schema version", () => {
		const { schemaVersion: _omitted, ...withoutVersion } =
			multiWorkspaceOperatorContext;
		expect(operatorContextV1Schema.safeParse(withoutVersion).success).toBe(
			false,
		);
	});

	it("rejects an invalid observation timestamp", () => {
		for (const observedAt of [
			"2026-09-03 10:00:00",
			"2026-09-03T10:00:00+10:00",
			"yesterday",
			1_756_893_600_000,
		]) {
			expect(
				operatorContextV1Schema.safeParse({
					...multiWorkspaceOperatorContext,
					observedAt,
				}).success,
			).toBe(false);
		}
	});

	it("rejects an unknown role", () => {
		expect(
			operatorContextV1Schema.safeParse({
				...multiWorkspaceOperatorContext,
				roles: ["fleet.admin"],
			}).success,
		).toBe(false);
	});

	it("rejects an unknown capability", () => {
		expect(
			operatorContextV1Schema.safeParse({
				...multiWorkspaceOperatorContext,
				capabilities: ["router.unlock"],
			}).success,
		).toBe(false);
	});

	it("closes the role enum to read and recover", () => {
		expect(operatorRoleV1Schema.options).toEqual([
			"fleet.read",
			"fleet.recover",
		]);
	});

	it("closes the capability enum to the four operator routes", () => {
		expect(operatorCapabilityV1Schema.options).toEqual([
			"runs.list",
			"runs.changes",
			"logs.query",
			"recoveries.request",
		]);
	});

	// ADR-0009: read and recovery authority are separate roles, and a fleet read
	// role cannot recover. A context that grants the recovery capability without
	// the recovery role is not a shape the router may produce.
	it("rejects the recovery capability without the recovery role", () => {
		expect(
			operatorContextV1Schema.safeParse(
				compact({
					...multiWorkspaceOperatorContext,
					roles: ["fleet.read"],
					capabilities: ["runs.list", "recoveries.request"],
				}),
			).success,
		).toBe(false);
	});

	it("accepts a read-only operator with no recovery capability", () => {
		const readOnly = compact({
			...multiWorkspaceOperatorContext,
			roles: ["fleet.read"],
			capabilities: ["runs.list", "runs.changes", "logs.query"],
		});
		expect(operatorContextV1Schema.safeParse(readOnly).success).toBe(true);
	});

	// ADR-0010/0014: the log-source descriptor is disclosed only to a principal
	// authorized to query it — never as a side effect of authenticating.
	it("rejects a log-source descriptor without the log-query capability", () => {
		expect(
			operatorContextV1Schema.safeParse(
				compact({
					...multiWorkspaceOperatorContext,
					capabilities: ["runs.list", "runs.changes", "recoveries.request"],
				}),
			).success,
		).toBe(false);
	});

	it("accepts an operator whose router has no log source configured", () => {
		const { logSource: _dropped, ...withoutLogSource } =
			multiWorkspaceOperatorContext;
		expect(
			operatorContextV1Schema.safeParse(
				compact({
					...withoutLogSource,
					capabilities: ["runs.list", "runs.changes", "recoveries.request"],
				}),
			).success,
		).toBe(true);
	});

	it("requires at least one authorized workspace and one role", () => {
		expect(
			operatorContextV1Schema.safeParse({
				...multiWorkspaceOperatorContext,
				authorizedWorkspaces: [],
			}).success,
		).toBe(false);
		expect(
			operatorContextV1Schema.safeParse(
				compact({
					...multiWorkspaceOperatorContext,
					roles: [],
					capabilities: ["runs.list", "logs.query"],
				}),
			).success,
		).toBe(false);
	});

	it("rejects skill metadata whose checksum is not a sha256 digest", () => {
		expect(
			operatorContextV1Schema.safeParse({
				...multiWorkspaceOperatorContext,
				skill: {
					...multiWorkspaceOperatorContext.skill,
					checksum: "not-a-digest",
				},
			}).success,
		).toBe(false);
	});
});
