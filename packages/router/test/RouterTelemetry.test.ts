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
 * `infra/azure/bicep/modules/monitoring.bicep`'s `Cyrus-Routing-Rejections`
 * saved search keys on these exact strings — the event name and six
 * `cyrus.*` attribute keys — and ARM stores a saved search as an opaque string
 * it never validates. So a rename here fails nowhere: every router test stays
 * green while the operator's query silently returns empty columns. The generic
 * `eventsNamed` helper deliberately strips the `cyrus.` prefix and cannot catch
 * that, which is why this file asserts the raw payload instead.
 *
 * If you change a name here, change monitoring.bicep in the same commit.
 */
describe("RouterTelemetry", () => {
	it("names every event in the routing. family so one KQL predicate selects them all", () => {
		for (const name of Object.values(ROUTING_EVENTS)) {
			expect(name).toMatch(/^routing\.[a-z_]+$/);
		}
		const names = Object.values(ROUTING_EVENTS);
		expect(new Set(names).size).toBe(names.length);
	});

	it("emits every attribute the Cyrus-Routing-Rejections query projects", () => {
		const logger = testLogger();

		emitRoutingRejection(logger, {
			reason: "issue_locked",
			sessionId: "sess-new",
			issueId: "44c5ab1c",
			issueKey: "CAN-133",
			heldBySessionId: "sess-holder",
			heldByDeviceId: 133,
		});

		expect(logger.event).toHaveBeenCalledWith("routing.rejected", {
			"cyrus.reason": "issue_locked",
			"cyrus.agent_session_id": "sess-new",
			"cyrus.issue_id": "44c5ab1c",
			"cyrus.issue_key": "CAN-133",
			"cyrus.held_by_session_id": "sess-holder",
			"cyrus.held_by_device_id": 133,
		});
	});

	it("fills absent optional fields with null rather than dropping the keys", () => {
		// The KQL projects all six unconditionally. A dropped key and a null are
		// the same in the rendered table, but `where isnull(held_by_session_id)`
		// — the way to separate a lock rejection from every other refusal — only
		// works if the column exists on every row.
		const logger = testLogger();

		emitRoutingRejection(logger, {
			reason: "prompt_unroutable",
			sessionId: "sess-orphan",
		});

		expect(logger.event).toHaveBeenCalledWith("routing.rejected", {
			"cyrus.reason": "prompt_unroutable",
			"cyrus.agent_session_id": "sess-orphan",
			"cyrus.issue_id": null,
			"cyrus.issue_key": null,
			"cyrus.held_by_session_id": null,
			"cyrus.held_by_device_id": null,
		});
	});

	it("keeps the reason set closed and snake_case so `summarize by reason` is bounded", () => {
		// Enumerated rather than derived: this is the list monitoring.bicep and
		// any operator runbook can rely on, so adding one should be a deliberate
		// edit here too. Covers both the `created` and the `prompted` paths —
		// instrumenting only the former left the refusal ISSUE_LOCKED_MESSAGE
		// steers users into as the invisible one (NOR-402).
		const reasons: RoutingRejectReason[] = [
			"issue_locked",
			"unenrolled_creator",
			"invalid_issue_key",
			"non_creator_prompt",
			"prompt_unroutable",
			"repositories_unavailable",
		];
		const logger = testLogger();

		for (const reason of reasons) {
			expect(reason).toMatch(/^[a-z_]+$/);
			emitRoutingRejection(logger, { reason, sessionId: "s" });
		}

		expect(logger.event).toHaveBeenCalledTimes(reasons.length);
	});
});
