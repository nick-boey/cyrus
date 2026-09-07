import { describe, expect, it } from "vitest";
import {
	CANONICAL_RUN_ATTRIBUTE_KEYS,
	runAttributionAttributes,
} from "../../src/logging/attribution.js";

/**
 * The canonical filter contract, asserted as a whole rather than key by key.
 *
 * Every query an operator writes against the fleet's console logs narrows on
 * one of these, so the set is the contract: a key that silently stops being
 * emitted turns a saved search into one that returns fewer rows without
 * erroring, which is the failure mode CYR-72 exists to close.
 */
const FULL = {
	workspaceId: "ws-1",
	workspaceName: "Northrop Digital",
	ownerId: "user-9",
	ownerName: "nboey",
	teamId: "team-3",
	teamName: "Cyrus",
	projectId: "proj-7",
	projectName: "Fleet observability",
	issueKey: "CYR-72",
	runId: "run-abc",
	sessionId: "sess-1",
	deviceId: 42,
	runner: "claude",
	model: "claude-opus-5",
	provider: "aca",
	source: "router",
};

describe("CANONICAL_RUN_ATTRIBUTE_KEYS", () => {
	it("is exactly the namespaced filter set the contract promises", () => {
		expect([...CANONICAL_RUN_ATTRIBUTE_KEYS]).toEqual([
			"cyrus.workspace_id",
			"cyrus.workspace_name",
			"cyrus.owner_id",
			"cyrus.owner_name",
			"cyrus.team_id",
			"cyrus.team_name",
			"cyrus.project_id",
			"cyrus.project_name",
			"cyrus.issue_key",
			"cyrus.run_id",
			"cyrus.session_id",
			"cyrus.device_id",
			"cyrus.runner",
			"cyrus.model",
			"cyrus.provider",
			"cyrus.source",
		]);
	});
});

describe("runAttributionAttributes", () => {
	it("emits every canonical fact under the cyrus namespace", () => {
		expect(runAttributionAttributes(FULL)).toEqual({
			"cyrus.workspace_id": "ws-1",
			"cyrus.workspace_name": "Northrop Digital",
			"cyrus.owner_id": "user-9",
			"cyrus.owner_name": "nboey",
			"cyrus.team_id": "team-3",
			"cyrus.team_name": "Cyrus",
			"cyrus.project_id": "proj-7",
			"cyrus.project_name": "Fleet observability",
			"cyrus.issue_key": "CYR-72",
			"cyrus.run_id": "run-abc",
			"cyrus.session_id": "sess-1",
			"cyrus.device_id": 42,
			"cyrus.runner": "claude",
			"cyrus.model": "claude-opus-5",
			"cyrus.provider": "aca",
			"cyrus.source": "router",
		});
	});

	it("emits an unknown fact as null rather than dropping the key", () => {
		// `where isnull(p["cyrus.project_id"])` is how an operator finds runs on
		// issues that belong to no project. A missing column answers that question
		// with silence, and silence reads as "no such runs".
		const attributes = runAttributionAttributes({ issueKey: "CYR-72" });
		for (const key of CANONICAL_RUN_ATTRIBUTE_KEYS) {
			expect(attributes).toHaveProperty(key);
		}
		expect(attributes["cyrus.issue_key"]).toBe("CYR-72");
		expect(attributes["cyrus.workspace_id"]).toBeNull();
		expect(attributes["cyrus.device_id"]).toBeNull();
		expect(attributes["cyrus.runner"]).toBeNull();
	});

	it("never guesses: an empty attribution is sixteen nulls, not defaults", () => {
		const attributes = runAttributionAttributes({});
		expect(Object.keys(attributes)).toHaveLength(
			CANONICAL_RUN_ATTRIBUTE_KEYS.length,
		);
		expect(Object.values(attributes).every((value) => value === null)).toBe(
			true,
		);
	});

	it("treats an explicit null the same as an absent fact", () => {
		// The router hands `issueKey: row.issue_key ?? null` straight through; a
		// null that rendered as the string "null" would poison every filter on it.
		expect(
			runAttributionAttributes({ issueKey: null })["cyrus.issue_key"],
		).toBe(null);
	});

	it("keeps device_id numeric so toint()/isnull() both behave", () => {
		expect(runAttributionAttributes({ deviceId: 0 })["cyrus.device_id"]).toBe(
			0,
		);
	});

	describe("trace correlation", () => {
		const TRACEPARENT =
			"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

		it("derives trace_id and span_id from a W3C traceparent", () => {
			const attributes = runAttributionAttributes(
				{},
				{ traceparent: TRACEPARENT },
			);
			expect(attributes.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
			expect(attributes.span_id).toBe("00f067aa0ba902b7");
		});

		it("leaves trace_id and span_id unnamespaced", () => {
			// They are W3C-owned names, not Cyrus ones, and Azure's own span tables
			// key `OperationId` on the same trace id — prefixing would break the join.
			const attributes = runAttributionAttributes(
				{},
				{ traceparent: TRACEPARENT },
			);
			expect(attributes).not.toHaveProperty("cyrus.trace_id");
			expect(attributes).not.toHaveProperty("cyrus.span_id");
		});

		it("omits both when no trace context is available", () => {
			// Unlike the canonical facts, these are explicitly "when available":
			// an always-null trace id is per-GB cost for a column nothing filters on.
			const attributes = runAttributionAttributes({});
			expect(attributes).not.toHaveProperty("trace_id");
			expect(attributes).not.toHaveProperty("span_id");
		});

		it("prefers explicitly supplied ids over the carrier", () => {
			const attributes = runAttributionAttributes(
				{},
				{
					traceparent: TRACEPARENT,
					traceId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					spanId: "bbbbbbbbbbbbbbbb",
				},
			);
			expect(attributes.trace_id).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
			expect(attributes.span_id).toBe("bbbbbbbbbbbbbbbb");
		});

		it.each([
			["a malformed carrier", "not-a-traceparent"],
			["a truncated carrier", "00-4bf92f3577b34da6a3ce929d0e0e4736"],
			["an all-zero trace id", `00-${"0".repeat(32)}-00f067aa0ba902b7-01`],
			[
				"an all-zero span id",
				`00-4bf92f3577b34da6a3ce929d0e0e4736-${"0".repeat(16)}-01`,
			],
		])("emits nothing for %s", (_label, traceparent) => {
			// An invalid id that reached a query would join a log line to a trace
			// that does not exist, which is worse than no correlation at all.
			const attributes = runAttributionAttributes({}, { traceparent });
			expect(attributes).not.toHaveProperty("trace_id");
			expect(attributes).not.toHaveProperty("span_id");
		});

		it("accepts a future traceparent version's extra fields", () => {
			// W3C says an unknown version with a well-formed prefix must still be
			// parsed for its trace and span ids rather than discarded.
			const attributes = runAttributionAttributes(
				{},
				{
					traceparent:
						"cc-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-future",
				},
			);
			expect(attributes.trace_id).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
			expect(attributes.span_id).toBe("00f067aa0ba902b7");
		});

		it("refuses the reserved ff version", () => {
			const attributes = runAttributionAttributes(
				{},
				{
					traceparent:
						"ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
				},
			);
			expect(attributes).not.toHaveProperty("trace_id");
		});
	});
});
