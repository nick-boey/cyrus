import { describe, expect, it } from "vitest";
import {
	decodeRunChangeCursor,
	decodeRunPageCursor,
	encodeRunChangeCursor,
	encodeRunPageCursor,
	executorStateV1Schema,
	runChangeKindV1Schema,
	runChangePageV1Schema,
	runLifecycleStateV1Schema,
	runObservationChangeV1Schema,
	runObservationPageV1Schema,
	runObservationV1Schema,
	TERMINAL_RUN_LIFECYCLE_STATES,
	waitReasonV1Schema,
} from "../src/runs.js";
import {
	activeRunWithPendingWork,
	CHANGE_CURSOR,
	compact,
	elicitationWaitRun,
	elicitationWaitWithPendingWork,
	otherWaitRun,
	RUN_PAGE_CURSOR,
	runChangePage,
	runObservationChange,
	runObservationPage,
	STREAM_EPOCH,
	unknownDeviceRun,
} from "./fixtures.js";

describe("RunObservationV1", () => {
	it("round-trips an active container run carrying pending work", () => {
		const parsed = runObservationV1Schema.parse(activeRunWithPendingWork);
		expect(parsed).toEqual(activeRunWithPendingWork);
	});

	it("round-trips a terminal device run with an unknown outcome", () => {
		expect(runObservationV1Schema.parse(unknownDeviceRun)).toEqual(
			unknownDeviceRun,
		);
	});

	it("rejects a document with no schema version", () => {
		const { schemaVersion: _omitted, ...withoutVersion } =
			activeRunWithPendingWork;
		expect(runObservationV1Schema.safeParse(withoutVersion).success).toBe(
			false,
		);
	});

	it("rejects invalid timestamps anywhere in the observation", () => {
		expect(
			runObservationV1Schema.safeParse({
				...activeRunWithPendingWork,
				startedAt: "2026-09-03 09:58:00",
			}).success,
		).toBe(false);
		expect(
			runObservationV1Schema.safeParse({
				...activeRunWithPendingWork,
				routing: {
					...activeRunWithPendingWork.routing,
					routedAt: "not-a-timestamp",
				},
			}).success,
		).toBe(false);
	});

	it("rejects an unknown lifecycle state", () => {
		expect(
			runObservationV1Schema.safeParse({
				...activeRunWithPendingWork,
				lifecycle: "parked",
			}).success,
		).toBe(false);
	});

	it("closes the lifecycle enum and names its terminal subset", () => {
		expect(runLifecycleStateV1Schema.options).toEqual([
			"routed",
			"active",
			"waiting",
			"complete",
			"error",
			"stopped",
			"unknown",
		]);
		expect([...TERMINAL_RUN_LIFECYCLE_STATES]).toEqual([
			"complete",
			"error",
			"stopped",
			"unknown",
		]);
	});

	describe("run lifecycle is distinct from executor state", () => {
		it("closes the executor-state enum separately from lifecycle", () => {
			expect(executorStateV1Schema.options).toEqual([
				"running",
				"stopped",
				"absent",
				"unknown",
			]);
			expect(executorStateV1Schema.safeParse("active").success).toBe(false);
			expect(runLifecycleStateV1Schema.safeParse("absent").success).toBe(false);
		});

		// Park applies only to a container, so only a container carries a sampled
		// executor state. A device run reporting one is a category error.
		it("rejects a sampled executor state on a device run", () => {
			expect(
				runObservationV1Schema.safeParse({
					...unknownDeviceRun,
					executorState: "stopped",
					executorStateObservedAt: "2026-09-03T09:00:00.000Z",
				}).success,
			).toBe(false);
		});

		it("requires an observation time alongside a sampled executor state", () => {
			const { executorStateObservedAt: _dropped, ...withoutObservedAt } =
				activeRunWithPendingWork;
			expect(runObservationV1Schema.safeParse(withoutObservedAt).success).toBe(
				false,
			);
		});

		it("accepts a stopped container executor under a still-active run", () => {
			expect(
				runObservationV1Schema.safeParse({
					...activeRunWithPendingWork,
					executorState: "stopped",
				}).success,
			).toBe(true);
		});
	});

	describe("waiting is worker-reported and distinct from pending work", () => {
		it("round-trips an elicitation wait", () => {
			const fixture = compact(elicitationWaitRun);
			expect(runObservationV1Schema.parse(fixture)).toEqual(fixture);
		});

		it("round-trips an `other` wait preserving the reported condition", () => {
			const fixture = compact(otherWaitRun);
			const parsed = runObservationV1Schema.parse(fixture);
			expect(parsed.wait?.reason).toBe("other");
			expect(parsed.wait?.reportedCondition).toBe(
				"worker reported: awaiting upstream CI",
			);
		});

		it("closes the wait-reason enum to elicitation and other", () => {
			expect(waitReasonV1Schema.options).toEqual(["elicitation", "other"]);
			expect(waitReasonV1Schema.safeParse("rate_limit").success).toBe(false);
			expect(waitReasonV1Schema.safeParse("pending_work").success).toBe(false);
		});

		// `other` exists to carry a condition the schema does not model yet. With
		// no condition it records nothing, so the contract refuses it.
		it("rejects an `other` wait with no reported condition", () => {
			const { reportedCondition: _dropped, ...wait } = otherWaitRun.wait;
			expect(
				runObservationV1Schema.safeParse(compact({ ...otherWaitRun, wait }))
					.success,
			).toBe(false);
		});

		it("rejects a waiting lifecycle with no wait evidence", () => {
			const { wait: _dropped, ...withoutWait } = elicitationWaitRun;
			expect(
				runObservationV1Schema.safeParse(compact(withoutWait)).success,
			).toBe(false);
		});

		it("rejects wait evidence on a run that is not waiting", () => {
			expect(
				runObservationV1Schema.safeParse(
					compact({
						...activeRunWithPendingWork,
						wait: elicitationWaitRun.wait,
					}),
				).success,
			).toBe(false);
		});

		// pending_work is not a wait reason — the closed `waitReasonV1Schema`
		// carries that distinction. It is NOT mutually exclusive with waiting:
		// the worker's "safe to park?" gate exists precisely for a session
		// blocked on a user answer with a background build still running, and
		// that count is what predicts a `worker_owns_active_work` refusal.
		it("accepts an elicitation wait that is still carrying background work", () => {
			const fixture = compact(elicitationWaitWithPendingWork);
			const parsed = runObservationV1Schema.parse(fixture);
			expect(parsed.lifecycle).toBe("waiting");
			expect(parsed.wait?.reason).toBe("elicitation");
			expect(parsed.pendingWorkCount).toBe(1);
		});

		it("rejects pending work on a terminal run", () => {
			expect(
				runObservationV1Schema.safeParse({
					...unknownDeviceRun,
					pendingWorkCount: 1,
				}).success,
			).toBe(false);
		});

		it("accepts an active run reporting zero pending work", () => {
			expect(
				runObservationV1Schema.safeParse({
					...activeRunWithPendingWork,
					pendingWorkCount: 0,
				}).success,
			).toBe(true);
		});

		it("rejects a fractional or negative pending-work count", () => {
			for (const pendingWorkCount of [-1, 1.5]) {
				expect(
					runObservationV1Schema.safeParse({
						...activeRunWithPendingWork,
						pendingWorkCount,
					}).success,
				).toBe(false);
			}
		});
	});

	describe("terminal outcomes carry an end time", () => {
		it("requires endedAt on every terminal lifecycle state", () => {
			const { endedAt: _dropped, ...withoutEndedAt } = unknownDeviceRun;
			for (const lifecycle of TERMINAL_RUN_LIFECYCLE_STATES) {
				expect(
					runObservationV1Schema.safeParse({ ...withoutEndedAt, lifecycle })
						.success,
				).toBe(false);
				expect(
					runObservationV1Schema.safeParse({ ...unknownDeviceRun, lifecycle })
						.success,
				).toBe(true);
			}
		});

		it("rejects endedAt on a non-terminal run", () => {
			expect(
				runObservationV1Schema.safeParse({
					...activeRunWithPendingWork,
					endedAt: "2026-09-03T10:00:00.000Z",
				}).success,
			).toBe(false);
		});
	});

	describe("routing snapshots capture names alongside canonical IDs", () => {
		it("rejects a captured name with no corresponding ID", () => {
			const { linearProjectId: _dropped, ...routing } =
				activeRunWithPendingWork.routing;
			expect(
				runObservationV1Schema.safeParse(
					compact({ ...activeRunWithPendingWork, routing }),
				).success,
			).toBe(false);
		});

		it("accepts an ID whose name was not captured", () => {
			const { linearProjectName: _dropped, ...routing } =
				activeRunWithPendingWork.routing;
			expect(
				runObservationV1Schema.safeParse(
					compact({ ...activeRunWithPendingWork, routing }),
				).success,
			).toBe(true);
		});

		it("requires a workspace and owning Cyrus user on every run", () => {
			for (const key of ["workspaceId", "ownerUserId"] as const) {
				const routing = { ...activeRunWithPendingWork.routing };
				delete (routing as Record<string, unknown>)[key];
				expect(
					runObservationV1Schema.safeParse({
						...activeRunWithPendingWork,
						routing,
					}).success,
				).toBe(false);
			}
		});
	});

	// A delegation raises `agentSessionCreated` with no agent activity and no
	// source comment, so the router's own `extractRunInput` yields just a routed
	// time. Refusing that would make the run — whose only input it is —
	// unemittable, hiding exactly the runs an operator needs from the fleet view.
	it("accepts a delegation-shaped input carrying only a routed time", () => {
		const delegated = {
			...activeRunWithPendingWork,
			inputs: [{ routedAt: "2026-09-03T09:58:00.000Z" }],
		};
		expect(runObservationV1Schema.parse(delegated).inputs).toEqual([
			{ routedAt: "2026-09-03T09:58:00.000Z" },
		]);
	});

	it("accepts an observation whose input provenance was lost", () => {
		expect(
			runObservationV1Schema.safeParse({
				...activeRunWithPendingWork,
				inputs: [],
			}).success,
		).toBe(true);
	});

	it("still rejects an input with no routed time", () => {
		expect(
			runObservationV1Schema.safeParse({
				...activeRunWithPendingWork,
				inputs: [{ commentId: "comment-1" }],
			}).success,
		).toBe(false);
	});

	it("rejects a negative or fractional observation revision", () => {
		for (const revision of [-1, 2.5]) {
			expect(
				runObservationV1Schema.safeParse({
					...activeRunWithPendingWork,
					revision,
				}).success,
			).toBe(false);
		}
	});
});

describe("run cursors", () => {
	it("round-trips a change cursor through its opaque encoding", () => {
		const cursor = encodeRunChangeCursor({
			streamEpoch: STREAM_EPOCH,
			sequence: "42",
		});
		expect(cursor).toBe(CHANGE_CURSOR);
		expect(decodeRunChangeCursor(cursor)).toEqual({
			streamEpoch: STREAM_EPOCH,
			sequence: "42",
		});
	});

	it("round-trips a run page cursor", () => {
		const cursor = encodeRunPageCursor("run-002");
		expect(cursor).toBe(RUN_PAGE_CURSOR);
		expect(decodeRunPageCursor(cursor)).toEqual({ position: "run-002" });
	});

	// A change cursor carries the router-start stream epoch so the router can
	// answer 410 Gone for a cursor minted before a restart.
	it("carries the stream epoch inside the change cursor", () => {
		const cursor = encodeRunChangeCursor({
			streamEpoch: "epoch-two",
			sequence: "1",
		});
		expect(decodeRunChangeCursor(cursor).streamEpoch).toBe("epoch-two");
		expect(cursor).not.toBe(CHANGE_CURSOR);
	});

	it("rejects a malformed change cursor", () => {
		for (const malformed of [
			"",
			"42",
			"v1.changes",
			"v1.changes.only-one-segment",
			"v1.changes.a.b.c",
			"v2.changes.MDE.NDI",
			"v1.runs.MDE.NDI",
			"v1.changes.not base64!.NDI",
			RUN_PAGE_CURSOR,
		]) {
			expect(() => decodeRunChangeCursor(malformed)).toThrow();
		}
	});

	it("rejects a malformed run page cursor", () => {
		for (const malformed of ["", "v1.runs", "v1.runs.a.b", CHANGE_CURSOR]) {
			expect(() => decodeRunPageCursor(malformed)).toThrow();
		}
	});
});

describe("RunObservationPageV1", () => {
	it("round-trips its canonical fixture", () => {
		expect(runObservationPageV1Schema.parse(runObservationPage)).toEqual(
			runObservationPage,
		);
	});

	it("accepts a final page with no continuation cursor", () => {
		const { nextCursor: _dropped, ...lastPage } = runObservationPage;
		expect(runObservationPageV1Schema.safeParse(lastPage).success).toBe(true);
	});

	it("accepts an empty page", () => {
		expect(
			runObservationPageV1Schema.safeParse({
				...runObservationPage,
				runs: [],
				nextCursor: undefined,
			}).success,
		).toBe(true);
	});

	it("rejects a malformed continuation cursor", () => {
		expect(
			runObservationPageV1Schema.safeParse({
				...runObservationPage,
				nextCursor: "page-2",
			}).success,
		).toBe(false);
	});
});

describe("RunObservationChangeV1", () => {
	it("round-trips its canonical fixture", () => {
		expect(runObservationChangeV1Schema.parse(runObservationChange)).toEqual(
			runObservationChange,
		);
	});

	it("closes the material-change kind enum", () => {
		expect(runChangeKindV1Schema.options).toEqual([
			"routing",
			"lifecycle",
			"wait",
			"worker_connectivity",
			"executor_state",
			"published_activity",
			"recovery",
		]);
	});

	it("rejects an unknown change kind", () => {
		expect(
			runObservationChangeV1Schema.safeParse({
				...runObservationChange,
				kind: "heartbeat",
			}).success,
		).toBe(false);
	});

	it("rejects a malformed cursor", () => {
		expect(
			runObservationChangeV1Schema.safeParse({
				...runObservationChange,
				cursor: "42",
			}).success,
		).toBe(false);
	});

	it("rejects a change whose embedded observation is for another run", () => {
		expect(
			runObservationChangeV1Schema.safeParse({
				...runObservationChange,
				runId: "run-somewhere-else",
			}).success,
		).toBe(false);
	});
});

describe("RunChangePageV1", () => {
	it("round-trips its canonical fixture", () => {
		expect(runChangePageV1Schema.parse(runChangePage)).toEqual(runChangePage);
	});

	// A watch must always receive a resume point, including for an empty poll,
	// or a reconnecting orchestrator has to re-snapshot to make progress.
	it("requires a continuation cursor even on an empty page", () => {
		expect(
			runChangePageV1Schema.safeParse({ ...runChangePage, changes: [] })
				.success,
		).toBe(true);
		const { nextCursor: _dropped, ...withoutCursor } = runChangePage;
		expect(
			runChangePageV1Schema.safeParse({ ...withoutCursor, changes: [] })
				.success,
		).toBe(false);
	});

	// The epoch refinement decodes cursors, so it must not decode a cursor that
	// will not parse: a throw there escapes `safeParse` entirely and a client
	// validating an untrusted page crashes instead of reporting a bad response.
	it("reports a malformed cursor through safeParse rather than throwing", () => {
		for (const page of [
			{ ...runChangePage, nextCursor: "42" },
			{
				...runChangePage,
				changes: [{ ...runObservationChange, cursor: "not-a-cursor" }],
			},
		]) {
			expect(() => runChangePageV1Schema.safeParse(page)).not.toThrow();
			expect(runChangePageV1Schema.safeParse(page).success).toBe(false);
		}
	});

	it("rejects a page mixing cursors from another stream epoch", () => {
		expect(
			runChangePageV1Schema.safeParse({
				...runChangePage,
				nextCursor: encodeRunChangeCursor({
					streamEpoch: "a-later-epoch",
					sequence: "43",
				}),
			}).success,
		).toBe(false);
		expect(
			runChangePageV1Schema.safeParse({
				...runChangePage,
				changes: [
					{
						...runObservationChange,
						cursor: encodeRunChangeCursor({
							streamEpoch: "a-later-epoch",
							sequence: "41",
						}),
					},
				],
			}).success,
		).toBe(false);
	});
});
