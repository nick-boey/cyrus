import { describe, expect, it } from "vitest";
import {
	emitRoutingRejection,
	ROUTING_EVENTS,
	type RoutingRejectReason,
} from "../src/RouterTelemetry.js";
import { testLogger } from "./helpers/logger.js";

/**
 * The naming contract for the `routing.*` family, asserted VERBATIM.
 *
 * The behavioural tests in `EventRouter.test.ts` go through `eventsNamed`,
 * which strips the `cyrus.` prefix on purpose so they are not coupled to the
 * wire format. That leaves nothing checking the wire format itself: dropping
 * `cyrusAttributes` from `emitRoutingRejection` — the single line satisfying
 * the call-site namespacing rule — would keep every one of those tests green
 * while silently breaking every `Properties["cyrus.reason"]` query written
 * against this family. This file is where that would fail, mirroring the same
 * job `SandboxTelemetry.test.ts` does for `sandbox.*`.
 */
describe("RouterTelemetry", () => {
	it("names every event in the routing. family so one KQL predicate selects them all", () => {
		for (const name of Object.values(ROUTING_EVENTS)) {
			expect(name).toMatch(/^routing\.[a-z_]+$/);
		}
		const names = Object.values(ROUTING_EVENTS);
		expect(new Set(names).size).toBe(names.length);
	});

	it("emits the literal cyrus.* attribute keys the saved searches query", () => {
		const logger = testLogger();

		emitRoutingRejection(logger, {
			reason: "issue_locked",
			sessionId: "sess-b",
			issueId: "ISS-2",
			issueKey: "CAN-133",
			heldBySessionId: "sess-a",
			heldByDeviceId: 133,
		});

		expect(logger.event).toHaveBeenCalledWith("routing.rejected", {
			"cyrus.reason": "issue_locked",
			"cyrus.agent_session_id": "sess-b",
			"cyrus.issue_id": "ISS-2",
			"cyrus.issue_key": "CAN-133",
			"cyrus.held_by_session_id": "sess-a",
			"cyrus.held_by_device_id": 133,
		});
	});

	it("emits nulls rather than dropping keys an operator filters on", () => {
		// `where isnull(...)` is the only way to find rejections with no holder,
		// and a dropped key cannot be distinguished from a missing record.
		const logger = testLogger();

		emitRoutingRejection(logger, {
			reason: "unenrolled_creator",
			sessionId: "sess-x",
		});

		expect(logger.event).toHaveBeenCalledWith("routing.rejected", {
			"cyrus.reason": "unenrolled_creator",
			"cyrus.agent_session_id": "sess-x",
			"cyrus.issue_id": null,
			"cyrus.issue_key": null,
			"cyrus.held_by_session_id": null,
			"cyrus.held_by_device_id": null,
		});
	});

	it("carries a reason for every refusal path, on the prompted side as well as the created side", () => {
		// The vocabulary is closed so `summarize by reason` is bounded. It must
		// also be COMPLETE: `ROUTING_EVENTS` promises that
		// `event startswith "routing."` selects the whole family, so a refusal
		// with no reason value is not merely unlogged, it reads as "no rejection
		// happened" to anyone running that predicate.
		const reasons: RoutingRejectReason[] = [
			"issue_locked",
			"unenrolled_creator",
			"invalid_issue_key",
			"unroutable_prompt",
			"non_creator_prompt",
		];
		const logger = testLogger();
		for (const reason of reasons) {
			emitRoutingRejection(logger, { reason, sessionId: "sess-1" });
		}

		expect(
			logger.event.mock.calls.map(([, attrs]) => attrs?.["cyrus.reason"]),
		).toEqual(reasons);
	});
});
