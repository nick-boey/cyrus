import { CANONICAL_RUN_ATTRIBUTE_KEYS } from "cyrus-core";
import { describe, expect, it } from "vitest";
import type { AgentRunInfo } from "../src/RouterStore.js";
import {
	emitRoutingRejection,
	emitRunEvent,
	ROUTING_EVENTS,
	type RoutingRejectReason,
	RUN_EVENTS,
	type RunAttributionLookup,
	resolveLogRunAttribution,
	runAttribution,
} from "../src/RouterTelemetry.js";
import { testLogger } from "./helpers/logger.js";

/**
 * The canonical bag as it appears when nothing at all is known — the baseline
 * every assertion below spreads over, so a test states only the facts its own
 * scenario supplies.
 */
const NO_ATTRIBUTION = {
	"cyrus.workspace_id": null,
	"cyrus.workspace_name": null,
	"cyrus.owner_id": null,
	"cyrus.owner_name": null,
	"cyrus.team_id": null,
	"cyrus.team_name": null,
	"cyrus.project_id": null,
	"cyrus.project_name": null,
	"cyrus.issue_key": null,
	"cyrus.run_id": null,
	"cyrus.session_id": null,
	"cyrus.device_id": null,
	"cyrus.runner": null,
	"cyrus.model": null,
	"cyrus.provider": null,
	"cyrus.source": "router",
};

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
			...NO_ATTRIBUTION,
			// The canonical spellings of the two facts a rejection always has.
			"cyrus.session_id": "sess-new",
			"cyrus.issue_key": "CAN-133",
			// Pre-CYR-72 keys, kept verbatim: the saved search reads them by name.
			"cyrus.reason": "issue_locked",
			"cyrus.agent_session_id": "sess-new",
			"cyrus.issue_id": "44c5ab1c",
			"cyrus.held_by_session_id": "sess-holder",
			"cyrus.held_by_device_id": 133,
		});
	});

	it("carries a supplied routing snapshot onto the rejection", () => {
		// A rejection is the one lifecycle point with no run, so without this the
		// workspace/team columns an operator scopes their whole query by would be
		// null for exactly the events that say a user's prompt went nowhere.
		const logger = testLogger();

		emitRoutingRejection(logger, {
			reason: "issue_locked",
			sessionId: "sess-new",
			issueKey: "CAN-133",
			attribution: {
				workspaceId: "ws-1",
				workspaceName: "Northrop Digital",
				teamId: "team-3",
				teamName: "Cyrus",
				source: "router",
			},
		});

		expect(logger.event).toHaveBeenCalledWith(
			"routing.rejected",
			expect.objectContaining({
				"cyrus.workspace_id": "ws-1",
				"cyrus.workspace_name": "Northrop Digital",
				"cyrus.team_id": "team-3",
				"cyrus.team_name": "Cyrus",
				// Still null: a rejection never produced a run, and saying otherwise
				// would be a guess.
				"cyrus.run_id": null,
			}),
		);
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
			...NO_ATTRIBUTION,
			"cyrus.session_id": "sess-orphan",
			"cyrus.reason": "prompt_unroutable",
			"cyrus.agent_session_id": "sess-orphan",
			"cyrus.issue_id": null,
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

/**
 * The `run.*` family, asserted verbatim for the same reason the `routing.*`
 * family is: `monitoring.bicep` keys on these literal strings and ARM will
 * never tell anyone they stopped matching.
 */
describe("RUN_EVENTS", () => {
	function runInfo(over?: Partial<AgentRunInfo>): AgentRunInfo {
		return {
			runId: "run-abc",
			userId: 9,
			deviceId: 42,
			issueKey: "CYR-72",
			sessionId: "sess-1",
			state: "active",
			runner: "claude",
			model: "claude-opus-5",
			routing: {
				workspaceId: "ws-1",
				workspaceName: "Northrop Digital",
				ownerUserId: "9",
				ownerName: "nboey",
				linearTeamId: "team-3",
				linearTeamName: "Cyrus",
				linearProjectId: "proj-7",
				linearProjectName: "Fleet observability",
				routedAtMs: 1_000,
			},
			startedMs: 1_000,
			lastRoutedMs: 1_000,
			inputs: [],
			executorKind: "container",
			provider: "aca",
			revision: 1,
			...over,
		};
	}

	it("names every event in the run. family so one KQL predicate selects them all", () => {
		for (const name of Object.values(RUN_EVENTS)) {
			expect(name).toMatch(/^run\.[a-z_]+$/);
		}
		const names = Object.values(RUN_EVENTS);
		expect(new Set(names).size).toBe(names.length);
	});

	it("stamps the whole canonical set from a run row", () => {
		const logger = testLogger();

		emitRunEvent(logger, RUN_EVENTS.routed, runAttribution(runInfo()));

		expect(logger.event).toHaveBeenCalledWith("run.routed", {
			"cyrus.workspace_id": "ws-1",
			"cyrus.workspace_name": "Northrop Digital",
			"cyrus.owner_id": "9",
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

	it("reports a fact the run row has not got as null, never as a default", () => {
		// A run routed before its worker announced a runner genuinely has none.
		// Filling in "claude" — the default runner — would make an operator's
		// `where runner == "claude"` include runs that were something else.
		const logger = testLogger();

		emitRunEvent(
			logger,
			RUN_EVENTS.routed,
			runAttribution(
				runInfo({
					runner: undefined,
					model: undefined,
					routing: { workspaceId: "ws-1" },
				}),
			),
		);

		const [, attributes] = logger.event.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(attributes["cyrus.runner"]).toBeNull();
		expect(attributes["cyrus.model"]).toBeNull();
		expect(attributes["cyrus.project_id"]).toBeNull();
		expect(attributes["cyrus.workspace_id"]).toBe("ws-1");
	});

	it("lets an event's own payload fill in around the canonical set, never over it", () => {
		const logger = testLogger();

		emitRunEvent(logger, RUN_EVENTS.finished, runAttribution(runInfo()), {
			terminal_state: "complete",
			// A caller that tried to disagree with the run row about the issue.
			issue_key: "NOR-999",
		});

		const [, attributes] = logger.event.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		expect(attributes["cyrus.terminal_state"]).toBe("complete");
		expect(attributes["cyrus.issue_key"]).toBe("CYR-72");
	});

	it("emits every canonical key on every run event", () => {
		const logger = testLogger();

		for (const name of Object.values(RUN_EVENTS)) {
			emitRunEvent(logger, name, runAttribution(runInfo()));
		}

		for (const [, attributes] of logger.event.mock.calls as Array<
			[string, Record<string, unknown>]
		>) {
			for (const key of CANONICAL_RUN_ATTRIBUTE_KEYS) {
				expect(attributes).toHaveProperty(key);
			}
		}
	});
});

/**
 * Which run a forwarded log line is attributed to.
 *
 * The rule that matters here is that a WRONG answer is worse than no answer: a
 * line attributed to another session's run is indistinguishable from a real
 * fact about that run, whereas null columns simply decline to answer.
 */
describe("resolveLogRunAttribution", () => {
	function lookup(runs: AgentRunInfo[]): RunAttributionLookup {
		return {
			getAgentRunForSession: (sessionId) =>
				runs.find((r) => r.sessionId === sessionId),
			getLatestAgentRunForDevice: (deviceId) =>
				runs.filter((r) => r.deviceId === deviceId).at(-1),
		};
	}

	function run(over: Partial<AgentRunInfo>): AgentRunInfo {
		return {
			runId: "run-1",
			userId: 9,
			deviceId: 42,
			issueKey: "CYR-72",
			sessionId: "sess-1",
			state: "active",
			routing: {},
			startedMs: 1,
			lastRoutedMs: 1,
			inputs: [],
			executorKind: "container",
			revision: 1,
			...over,
		};
	}

	it("uses the run for the session the frame names", () => {
		const runs = [run({}), run({ runId: "run-2", sessionId: "sess-2" })];

		expect(
			resolveLogRunAttribution(lookup(runs), {
				deviceId: 42,
				kind: "container",
				sessionId: "sess-2",
			})?.runId,
		).toBe("run-2");
	});

	it("refuses a session the router says belongs to another device", () => {
		// `frame.sessionId` is device-supplied. Without this gate a worker could
		// label its lines with another run's id, which is the whole thing
		// router-side attribution exists to prevent.
		const runs = [run({ deviceId: 7, sessionId: "sess-theirs" })];

		expect(
			resolveLogRunAttribution(lookup(runs), {
				deviceId: 42,
				kind: "container",
				sessionId: "sess-theirs",
			}),
		).toBeUndefined();
	});

	it("falls back to a CONTAINER's latest run for a line with no session", () => {
		// Boot and teardown lines carry no session. A container serves exactly one
		// issue for its whole life, so its latest run is the one they belong to.
		const runs = [run({})];

		expect(
			resolveLogRunAttribution(lookup(runs), {
				deviceId: 42,
				kind: "container",
			})?.runId,
		).toBe("run-1");
	});

	it("refuses that fallback for a PHYSICAL device", () => {
		// A physical device serves many issues and can run several sessions at
		// once, so "latest run" would attribute one session's lines to another
		// session's run — a wrong answer dressed as a measured one.
		const runs = [run({ executorKind: "device" })];

		expect(
			resolveLogRunAttribution(lookup(runs), { deviceId: 42, kind: "device" }),
		).toBeUndefined();
		// Same for a device whose kind the router could not read.
		expect(
			resolveLogRunAttribution(lookup(runs), { deviceId: 42 }),
		).toBeUndefined();
	});

	it("attributes to nothing when the device has never been routed", () => {
		expect(
			resolveLogRunAttribution(lookup([]), { deviceId: 42, kind: "container" }),
		).toBeUndefined();
	});
});
