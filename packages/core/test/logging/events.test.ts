import { describe, expect, it } from "vitest";
import { CYRUS_EVENTS, cyrusAttributes } from "../../src/logging/events.js";

describe("CYRUS_EVENTS", () => {
	it("names every event in dotted lowercase with a domain segment", () => {
		// OTel event-naming guidance, and what makes `event startswith "session."`
		// select a whole family in one KQL predicate.
		for (const name of Object.values(CYRUS_EVENTS)) {
			expect(name).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
		}
	});

	it("keeps every name distinct", () => {
		// A duplicate would silently merge two lifecycle transitions into one
		// series, and the merge would be invisible in every query built on it.
		const names = Object.values(CYRUS_EVENTS);
		expect(new Set(names).size).toBe(names.length);
	});
});

describe("cyrusAttributes", () => {
	it("moves bare keys into the cyrus namespace", () => {
		expect(cyrusAttributes({ issue_key: "NOR-282", sessions: 2 })).toEqual({
			"cyrus.issue_key": "NOR-282",
			"cyrus.sessions": 2,
		});
	});

	it("leaves an already-namespaced key alone", () => {
		// `exception.*` is stable OTel semconv and a future `gen_ai.*` would be
		// too. Prefixing them would make them unrecognisable to every backend
		// that special-cases the standard names.
		expect(
			cyrusAttributes({
				"exception.type": "TypeError",
				"gen_ai.request.model": "claude-opus-5",
			}),
		).toEqual({
			"exception.type": "TypeError",
			"gen_ai.request.model": "claude-opus-5",
		});
	});

	it("is idempotent — a second pass never double-prefixes", () => {
		const once = cyrusAttributes({ issue_key: "NOR-282" });
		expect(cyrusAttributes(once)).toEqual(once);
	});

	it("preserves null, which is distinct from absent in the event vocabulary", () => {
		// `device_id: null` marks an orphan; dropping the key would make
		// `where isnull(...)` — the only way to find them — return nothing.
		expect(cyrusAttributes({ device_id: null })).toEqual({
			"cyrus.device_id": null,
		});
	});

	it("passes undefined through for the sinks to drop", () => {
		// `undefined` has no wire representation; each sink already strips it, and
		// swallowing it here would hide a call site that meant to send a value.
		expect(cyrusAttributes({ uptime_ms: undefined })).toEqual({
			"cyrus.uptime_ms": undefined,
		});
	});

	it("returns an empty bag unchanged", () => {
		expect(cyrusAttributes({})).toEqual({});
	});
});
