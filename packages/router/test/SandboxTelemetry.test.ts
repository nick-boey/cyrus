import { describe, expect, it } from "vitest";
import {
	emitSandboxEvent,
	emitSandboxGauge,
	SANDBOX_EVENTS,
} from "../src/SandboxTelemetry.js";
import { testLogger } from "./helpers/logger.js";

describe("SandboxTelemetry", () => {
	it("names every event in the sandbox. family so one KQL predicate selects them all", () => {
		for (const name of Object.values(SANDBOX_EVENTS)) {
			expect(name).toMatch(/^sandbox\.[a-z_]+$/);
		}
		// Distinct names — a duplicate would silently merge two lifecycle
		// transitions into one series.
		const names = Object.values(SANDBOX_EVENTS);
		expect(new Set(names).size).toBe(names.length);
	});

	it("stamps issue key, device id and provider on every event", () => {
		const logger = testLogger();

		emitSandboxEvent(
			logger,
			SANDBOX_EVENTS.bootStarted,
			{ issueKey: "NOR-279", deviceId: 7, provider: "aca" },
			{ extra: "value" },
		);

		expect(logger.event).toHaveBeenCalledWith("sandbox.boot_started", {
			"cyrus.issue_key": "NOR-279",
			"cyrus.device_id": 7,
			"cyrus.provider": "aca",
			"cyrus.extra": "value",
		});
	});

	it("emits a null device id for an orphan rather than dropping the key", () => {
		// An orphan is by definition a container with no device row. Dropping the
		// key would make `where isnull(device_id)` — the only way to find them —
		// return nothing.
		const logger = testLogger();

		emitSandboxEvent(logger, SANDBOX_EVENTS.destroyed, {
			issueKey: "NOR-279",
			provider: "docker",
		});

		expect(logger.event).toHaveBeenCalledWith("sandbox.destroyed", {
			"cyrus.issue_key": "NOR-279",
			"cyrus.device_id": null,
			"cyrus.provider": "docker",
		});
	});

	it("carries both provider state and router-side liveness on a gauge sample", () => {
		// The invariant the 6-hour alert depends on: ACA reports `Running` for a
		// sandbox whose entrypoint has exited, so a sample that carried `state`
		// alone could not tell a live agent from a zombie.
		const logger = testLogger();

		emitSandboxGauge(logger, {
			issueKey: "NOR-279",
			deviceId: 7,
			provider: "aca",
			state: "running",
			sessions: 1,
			online: true,
			ageMs: 90_000,
			uptimeMs: 60_000,
			lastSeenAgeMs: 5_000,
			lastRoutedAgeMs: 30_000,
		});

		expect(logger.event).toHaveBeenCalledWith("sandbox.gauge", {
			"cyrus.issue_key": "NOR-279",
			"cyrus.device_id": 7,
			"cyrus.provider": "aca",
			"cyrus.state": "running",
			"cyrus.sessions": 1,
			"cyrus.online": true,
			"cyrus.age_ms": 90_000,
			"cyrus.uptime_ms": 60_000,
			"cyrus.last_seen_age_ms": 5_000,
			"cyrus.parked_for_ms": null,
			"cyrus.last_routed_age_ms": 30_000,
		});
	});

	it("emits absent optional measures as null so the column always exists", () => {
		// Log Analytics projects dynamic columns from the keys present on each
		// record. Omitting `uptime_ms` on stopped sandboxes rather than sending
		// null would make `where uptime_ms >= 6h` skip rows inconsistently
		// depending on what else happened to be in the window.
		const logger = testLogger();

		emitSandboxGauge(logger, {
			issueKey: "NOR-279",
			deviceId: 7,
			provider: "aca",
			state: "stopped",
			sessions: 0,
			online: false,
			ageMs: 90_000,
		});

		expect(logger.event).toHaveBeenCalledWith(
			"sandbox.gauge",
			expect.objectContaining({
				"cyrus.uptime_ms": null,
				"cyrus.last_seen_age_ms": null,
				"cyrus.parked_for_ms": null,
				"cyrus.last_routed_age_ms": null,
			}),
		);
	});
});
