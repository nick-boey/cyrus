import { describe, expect, it } from "vitest";
import {
	recoveryOperationV1Schema,
	recoveryPhaseV1Schema,
	recoveryRefusalReasonV1Schema,
	recoveryRequestV1Schema,
	TERMINAL_RECOVERY_PHASES,
} from "../src/recoveries.js";
import {
	compact,
	failedOperation,
	needsInputOperation,
	recoveredOperation,
	recoveryRequest,
	refusedOperation,
} from "./fixtures.js";

describe("RecoveryRequestV1", () => {
	it("round-trips its complete canonical fixture", () => {
		expect(recoveryRequestV1Schema.parse(recoveryRequest)).toEqual(
			recoveryRequest,
		);
	});

	it("rejects a document with no schema version", () => {
		const { schemaVersion: _omitted, ...withoutVersion } = recoveryRequest;
		expect(recoveryRequestV1Schema.safeParse(withoutVersion).success).toBe(
			false,
		);
	});

	// ADR-0013: recovery is conditional on the revision the caller inspected, so
	// a concurrent transition cannot be overwritten by a stale decision. Neither
	// the revision nor the idempotency key is optional.
	it("requires the inspected observation revision", () => {
		const { expectedRevision: _dropped, ...withoutRevision } = recoveryRequest;
		expect(recoveryRequestV1Schema.safeParse(withoutRevision).success).toBe(
			false,
		);
		for (const expectedRevision of [-1, 1.5, "7"]) {
			expect(
				recoveryRequestV1Schema.safeParse({
					...recoveryRequest,
					expectedRevision,
				}).success,
			).toBe(false);
		}
	});

	it("requires an idempotency key so a retry joins the same operation", () => {
		const { idempotencyKey: _dropped, ...withoutKey } = recoveryRequest;
		expect(recoveryRequestV1Schema.safeParse(withoutKey).success).toBe(false);
		expect(
			recoveryRequestV1Schema.safeParse({
				...recoveryRequest,
				idempotencyKey: "short",
			}).success,
		).toBe(false);
	});

	// A strict request is load-bearing here: silently dropping a misspelled
	// `expectedRevision` would turn a conditional recovery into an unconditional
	// one, which is precisely what the revision check exists to prevent.
	it("rejects a misspelled conditional field rather than ignoring it", () => {
		const { expectedRevision: _dropped, ...withoutRevision } = recoveryRequest;
		expect(
			recoveryRequestV1Schema.safeParse({
				...withoutRevision,
				expectedrevision: 7,
			}).success,
		).toBe(false);
	});

	// The stable target is a run ID. `--issue` is resolved by the CLI before the
	// request is made, so no issue key reaches this contract.
	it("targets a canonical run ID and nothing else", () => {
		const { runId: _dropped, ...withoutRunId } = recoveryRequest;
		expect(recoveryRequestV1Schema.safeParse(withoutRunId).success).toBe(false);
		expect(
			recoveryRequestV1Schema.safeParse({
				...withoutRunId,
				issueKey: "CYR-64",
			}).success,
		).toBe(false);
	});

	// Break-glass administration is not part of the orchestrator contract.
	it("has no field requesting unlock, termination, or destruction", () => {
		for (const breakGlass of [
			{ force: true },
			{ unlock: true },
			{ destroyExecutor: true },
			{ terminate: true },
		]) {
			expect(
				recoveryRequestV1Schema.safeParse({ ...recoveryRequest, ...breakGlass })
					.success,
			).toBe(false);
		}
	});
});

describe("RecoveryPhaseV1", () => {
	it("closes the phase enum to the coordinator's sequence", () => {
		expect(recoveryPhaseV1Schema.options).toEqual([
			"accepted",
			"starting_executor",
			"reconciling",
			"replaying",
			"releasing_stale_ownership",
			"recovered",
			"needs_input",
			"refused",
			"failed",
		]);
	});

	it("rejects an unknown phase", () => {
		expect(recoveryPhaseV1Schema.safeParse("unlocking").success).toBe(false);
	});

	it("names its terminal subset", () => {
		expect([...TERMINAL_RECOVERY_PHASES]).toEqual([
			"recovered",
			"needs_input",
			"refused",
			"failed",
		]);
	});
});

describe("RecoveryOperationV1", () => {
	// The operation is asynchronous: the request is accepted, then the operation
	// advances. Every terminal phase must be expressible on the wire.
	const terminalFixtures = {
		recovered: recoveredOperation,
		needs_input: needsInputOperation,
		refused: refusedOperation,
		failed: failedOperation,
	} as const;

	for (const [phase, fixture] of Object.entries(terminalFixtures)) {
		it(`round-trips a \`${phase}\` operation`, () => {
			const canonical = compact(fixture);
			const parsed = recoveryOperationV1Schema.parse(canonical);
			expect(parsed).toEqual(canonical);
			expect(parsed.phase).toBe(phase);
		});
	}

	it("covers every terminal phase with a fixture", () => {
		expect(Object.keys(terminalFixtures).sort()).toEqual(
			[...TERMINAL_RECOVERY_PHASES].sort(),
		);
	});

	it("round-trips an in-flight operation with no completion", () => {
		const inFlight = compact({
			...recoveredOperation,
			phase: "reconciling",
			phases: recoveredOperation.phases.slice(0, 3),
			completedAt: undefined,
			evidenceAfter: undefined,
		});
		expect(recoveryOperationV1Schema.parse(inFlight)).toEqual(inFlight);
	});

	it("rejects a document with no schema version", () => {
		const { schemaVersion: _omitted, ...withoutVersion } =
			compact(recoveredOperation);
		expect(recoveryOperationV1Schema.safeParse(withoutVersion).success).toBe(
			false,
		);
	});

	it("rejects an invalid phase timestamp", () => {
		expect(
			recoveryOperationV1Schema.safeParse(
				compact({ ...recoveredOperation, requestedAt: "just now" }),
			).success,
		).toBe(false);
	});

	it("persists the actor, target, key, and checked revision", () => {
		const parsed = recoveryOperationV1Schema.parse(compact(recoveredOperation));
		expect(parsed.actor.principalId).toBe(recoveredOperation.actor.principalId);
		expect(parsed.runId).toBe(recoveredOperation.runId);
		expect(parsed.idempotencyKey).toBe(recoveredOperation.idempotencyKey);
		expect(parsed.expectedRevision).toBe(7);
	});

	it("records before-and-after evidence for a completed recovery", () => {
		const parsed = recoveryOperationV1Schema.parse(compact(recoveredOperation));
		expect(parsed.evidenceBefore.issueLocked).toBe(true);
		expect(parsed.evidenceAfter?.issueLocked).toBe(false);
		expect(parsed.evidenceBefore.sessionAffinityHeld).toBe(true);
		expect(parsed.evidenceAfter?.sessionAffinityHeld).toBe(false);
	});

	it("requires before evidence on every operation", () => {
		const { evidenceBefore: _dropped, ...withoutEvidence } =
			compact(recoveredOperation);
		expect(recoveryOperationV1Schema.safeParse(withoutEvidence).success).toBe(
			false,
		);
	});

	it("rejects after-evidence on an operation that has not finished", () => {
		expect(
			recoveryOperationV1Schema.safeParse(
				compact({
					...recoveredOperation,
					phase: "reconciling",
					phases: recoveredOperation.phases.slice(0, 3),
					completedAt: undefined,
				}),
			).success,
		).toBe(false);
	});

	it("ties completion to a terminal phase in both directions", () => {
		const { completedAt: _dropped, ...withoutCompletion } =
			compact(recoveredOperation);
		expect(recoveryOperationV1Schema.safeParse(withoutCompletion).success).toBe(
			false,
		);
		expect(
			recoveryOperationV1Schema.safeParse(
				compact({
					...recoveredOperation,
					phase: "replaying",
					phases: recoveredOperation.phases.slice(0, 4),
					evidenceAfter: undefined,
				}),
			).success,
		).toBe(false);
	});

	it("allows a refusal reason only on a refused operation", () => {
		expect(
			recoveryOperationV1Schema.safeParse(
				compact({
					...recoveredOperation,
					refusalReason: "worker_owns_active_work",
				}),
			).success,
		).toBe(false);
		const { refusalReason: _dropped, ...refusedWithoutReason } =
			compact(refusedOperation);
		expect(
			recoveryOperationV1Schema.safeParse(refusedWithoutReason).success,
		).toBe(false);
	});

	it("closes the refusal-reason enum", () => {
		expect(recoveryRefusalReasonV1Schema.options).toEqual([
			"worker_owns_active_work",
			"stale_revision",
			"run_already_terminal",
			"not_authorized",
		]);
		expect(
			recoveryRefusalReasonV1Schema.safeParse("try_again_later").success,
		).toBe(false);
	});

	it("allows a failure message only on a failed operation", () => {
		expect(
			recoveryOperationV1Schema.safeParse(
				compact({ ...recoveredOperation, failure: { message: "boom" } }),
			).success,
		).toBe(false);
		const { failure: _dropped, ...failedWithoutMessage } =
			compact(failedOperation);
		expect(
			recoveryOperationV1Schema.safeParse(failedWithoutMessage).success,
		).toBe(false);
	});

	it("requires the phase history to start at accepted and end at the current phase", () => {
		expect(
			recoveryOperationV1Schema.safeParse(
				compact({
					...recoveredOperation,
					phases: recoveredOperation.phases.slice(1),
				}),
			).success,
		).toBe(false);
		expect(
			recoveryOperationV1Schema.safeParse(
				compact({
					...recoveredOperation,
					phases: recoveredOperation.phases.slice(0, 5),
				}),
			).success,
		).toBe(false);
	});
});
