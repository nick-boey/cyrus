import type { AgentPendingWork } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	formatPendingWorkSummary,
	PENDING_WORK_SUMMARY_MAX_ITEMS,
} from "../src/PendingWorkFormatter.js";

/**
 * `formatPendingWorkSummary` feeds the `cyrus.pending_work` attribute on
 * `session.terminal_deferred` — the record an operator reads to answer "is this
 * issue stranded, or is the session merely waiting?" (NOR-402). It is called
 * from `completeSession`'s `finally`, so a throw here rejects the terminal path
 * whose whole job is to release the router's issue lock.
 */

function pendingWork(over: Partial<AgentPendingWork> = {}): AgentPendingWork {
	return { sessionCrons: [], backgroundTasks: [], ...over };
}

describe("formatPendingWorkSummary", () => {
	it("names a recurring cron with its schedule and prompt", () => {
		const summary = formatPendingWorkSummary(
			pendingWork({
				sessionCrons: [
					{
						id: "c1",
						schedule: "0 9 * * 1-5",
						recurring: true,
						prompt: "check the deploy",
					},
				],
			}),
		);

		expect(summary).toBe("cron(recurring 0 9 * * 1-5): check the deploy");
	});

	it("renders the backgroundTasks branch, preferring the command over the description", () => {
		// The Stop-hook list. This branch went untested in the original change,
		// and it is the one with a fallback and a two-field interpolation.
		const summary = formatPendingWorkSummary(
			pendingWork({
				backgroundTasks: [
					{
						id: "t1",
						type: "shell",
						status: "running",
						description: "a long-running build",
						command: "pnpm build --watch",
					},
				],
			}),
		);

		expect(summary).toBe("background(shell/running: pnpm build --watch)");
	});

	it("falls back to the description when a background task carries no command", () => {
		const summary = formatPendingWorkSummary(
			pendingWork({
				backgroundTasks: [
					{
						id: "t1",
						type: "subagent",
						status: "pending",
						description: "reviewing the diff",
					},
				],
			}),
		);

		expect(summary).toBe("background(subagent/pending: reviewing the diff)");
	});

	it("does not throw when a background task has neither command nor description", () => {
		// A runner-supplied payload is not guaranteed to match its type at
		// runtime. Before this was guarded, `truncate` called `.replace` on
		// `undefined` and the TypeError escaped `completeSession`'s `finally` —
		// turning a malformed telemetry field into a leaked issue lock.
		const malformed = {
			id: "t1",
			type: "shell",
			status: "running",
		} as unknown as AgentPendingWork["backgroundTasks"][number];

		expect(() =>
			formatPendingWorkSummary(pendingWork({ backgroundTasks: [malformed] })),
		).not.toThrow();
		expect(
			formatPendingWorkSummary(pendingWork({ backgroundTasks: [malformed] })),
		).toBe("background(shell/running: (unnamed))");
	});

	it("reads liveBackgroundTasks, which the Linear-facing thought cannot see", () => {
		const summary = formatPendingWorkSummary(
			pendingWork({
				liveBackgroundTasks: [
					{ taskId: "b1", taskType: "monitor", description: "tailing CI" },
				],
			}),
		);

		expect(summary).toBe("live-background(monitor: tailing CI)");
	});

	it("joins all three sources in order", () => {
		const summary = formatPendingWorkSummary({
			sessionCrons: [
				{ id: "c1", schedule: "*/5 * * * *", recurring: true, prompt: "" },
			],
			backgroundTasks: [
				{
					id: "t1",
					type: "shell",
					status: "running",
					description: "d",
					command: "sleep 1",
				},
			],
			liveBackgroundTasks: [
				{ taskId: "b1", taskType: "monitor", description: "tailing CI" },
			],
		});

		expect(summary).toBe(
			"cron(recurring */5 * * * *); " +
				"background(shell/running: sleep 1); " +
				"live-background(monitor: tailing CI)",
		);
	});

	it("caps the ITEM COUNT, not just each item's length", () => {
		// Per-item truncation alone leaves the value bounded only by how many
		// tasks a runner reports, on an attribute exported to a per-GB backend.
		const many = Array.from(
			{ length: PENDING_WORK_SUMMARY_MAX_ITEMS + 5 },
			(_, i) => ({
				id: `c${i}`,
				schedule: `${i} * * * *`,
				recurring: true,
				prompt: "",
			}),
		);

		const summary = formatPendingWorkSummary(
			pendingWork({ sessionCrons: many }),
		);

		expect(summary.split("; ")).toHaveLength(
			PENDING_WORK_SUMMARY_MAX_ITEMS + 1,
		);
		expect(summary).toContain("+5 more");
	});

	it("truncates a long cron prompt rather than exporting it whole", () => {
		const summary = formatPendingWorkSummary(
			pendingWork({
				sessionCrons: [
					{
						id: "c1",
						schedule: "0 * * * *",
						recurring: false,
						prompt: "x".repeat(200),
					},
				],
			}),
		);

		expect(summary).toContain("…");
		expect(summary.length).toBeLessThan(140);
	});

	it("never returns an empty string, so the attribute is always readable", () => {
		expect(formatPendingWorkSummary(pendingWork())).toBe(
			"unspecified pending work",
		);
	});
});
