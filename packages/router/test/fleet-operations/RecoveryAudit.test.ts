import { describe, expect, it } from "vitest";
import {
	auditRecoveryAccepted,
	auditRecoveryJoined,
	auditRecoveryPhase,
	auditRecoveryRefusal,
	auditRecoverySettled,
	RECOVERY_EVENTS,
	redactAuditText,
} from "../../src/fleet-operations/RecoveryAudit.js";
import type { RecoveryOperationRecord } from "../../src/RouterStore.js";
import { eventsNamed, testLogger } from "../helpers/logger.js";

const BEFORE = {
	observedAt: new Date(1_000).toISOString(),
	revision: 4,
	lifecycle: "active" as const,
	workerOnline: false,
	executorState: "stopped" as const,
	sessionAffinityHeld: true,
	issueLocked: true,
};

const OPERATION: RecoveryOperationRecord = {
	operationId: "op-1",
	runId: "run-1",
	idempotencyKey: "idem-key-0001",
	principalId: "oid-recoverer",
	authMethod: "entra",
	roles: ["fleet.read", "fleet.recover"],
	workspaceId: "ws-a",
	expectedRevision: 4,
	phase: "accepted",
	phases: [{ phase: "accepted", enteredMs: 5_000 }],
	requestedMs: 5_000,
	updatedMs: 5_000,
	evidenceBefore: BEFORE,
};

describe("recovery audit events", () => {
	it("names every event under the recovery domain", () => {
		for (const name of Object.values(RECOVERY_EVENTS)) {
			expect(name.startsWith("recovery.")).toBe(true);
			expect(name).toMatch(/^[a-z]+\.[a-z_]+$/);
		}
	});

	it("emits the actor, target, and authority an audit is read for", () => {
		const logger = testLogger();

		auditRecoveryAccepted(logger, OPERATION);

		const [event] = eventsNamed(logger, RECOVERY_EVENTS.accepted);
		expect(event).toMatchObject({
			operation_id: "op-1",
			run_id: "run-1",
			workspace_id: "ws-a",
			principal_id: "oid-recoverer",
			auth_method: "entra",
			idempotency_key: "idem-key-0001",
			expected_revision: 4,
			phase: "accepted",
		});
	});

	it("namespaces every attribute so a KQL query can reach it", () => {
		const logger = testLogger();

		auditRecoveryAccepted(logger, OPERATION);

		const [, attributes] = logger.event.mock.calls[0] as [
			string,
			Record<string, unknown>,
		];
		for (const key of Object.keys(attributes)) {
			expect(key.startsWith("cyrus.")).toBe(true);
		}
	});

	it("records the phase an operation moved to", () => {
		const logger = testLogger();

		auditRecoveryPhase(logger, {
			...OPERATION,
			phase: "reconciling",
			phases: [
				...OPERATION.phases,
				{ phase: "reconciling", enteredMs: 6_000, detail: "asked the worker" },
			],
			updatedMs: 6_000,
		});

		expect(eventsNamed(logger, RECOVERY_EVENTS.phaseChanged)[0]).toMatchObject({
			operation_id: "op-1",
			phase: "reconciling",
			detail: "asked the worker",
		});
	});

	it("carries both evidence snapshots on a settled operation", () => {
		const logger = testLogger();
		const after = {
			...BEFORE,
			observedAt: new Date(9_000).toISOString(),
			sessionAffinityHeld: false,
			issueLocked: false,
		};

		auditRecoverySettled(logger, {
			...OPERATION,
			phase: "recovered",
			phases: [...OPERATION.phases, { phase: "recovered", enteredMs: 9_000 }],
			updatedMs: 9_000,
			completedMs: 9_000,
			evidenceAfter: after,
		});

		const [event] = eventsNamed(logger, RECOVERY_EVENTS.settled);
		expect(event).toMatchObject({
			phase: "recovered",
			before_session_affinity_held: true,
			before_issue_locked: true,
			before_worker_online: false,
			before_lifecycle: "active",
			after_session_affinity_held: false,
			after_issue_locked: false,
			duration_ms: 4_000,
		});
	});

	it("states why a refusal was refused, before any operation exists", () => {
		const logger = testLogger();

		auditRecoveryRefusal(
			logger,
			{
				runId: "run-1",
				principalId: "oid-reader",
				authMethod: "entra",
			},
			{ code: "stale_revision", status: 409 },
		);

		const [event] = eventsNamed(logger, RECOVERY_EVENTS.refused);
		expect(event).toMatchObject({
			run_id: "run-1",
			principal_id: "oid-reader",
			code: "stale_revision",
			status: 409,
		});
		expect(event?.operation_id).toBeUndefined();
	});

	it("reports a joined retry distinctly from a fresh acceptance", () => {
		const logger = testLogger();

		auditRecoveryJoined(logger, OPERATION);

		expect(eventsNamed(logger, RECOVERY_EVENTS.joined)).toHaveLength(1);
		expect(eventsNamed(logger, RECOVERY_EVENTS.accepted)).toHaveLength(0);
	});

	it("redacts credential material out of every free-text field", () => {
		const logger = testLogger();

		auditRecoverySettled(logger, {
			...OPERATION,
			// Both are caller- or coordinator-supplied prose, and both reach a log
			// backend that outlives any credential written into them.
			reason: "retrying with Authorization: Bearer abc123secretvalue",
			phase: "failed",
			phases: [
				...OPERATION.phases,
				{
					phase: "failed",
					enteredMs: 9_000,
					detail: "token cyop_deadbeefdeadbeef was rejected",
				},
			],
			updatedMs: 9_000,
			completedMs: 9_000,
			failureMessage: "upstream said eyJhbGciOi.eyJzdWIiOj.c2lnbmF0dXJl",
		});

		const [event] = eventsNamed(logger, RECOVERY_EVENTS.settled);
		const text = JSON.stringify(event);
		expect(text).not.toContain("abc123secretvalue");
		expect(text).not.toContain("cyop_deadbeefdeadbeef");
		expect(text).not.toContain("eyJhbGciOi.eyJzdWIiOj.c2lnbmF0dXJl");
		expect(text).toContain("[redacted]");
	});

	it("bounds free text so one operation cannot flood the audit stream", () => {
		const logger = testLogger();

		auditRecoverySettled(logger, {
			...OPERATION,
			phase: "failed",
			phases: [...OPERATION.phases, { phase: "failed", enteredMs: 9_000 }],
			updatedMs: 9_000,
			completedMs: 9_000,
			failureMessage: "x".repeat(5_000),
		});

		const message = eventsNamed(logger, RECOVERY_EVENTS.settled)[0]
			?.failure_message as string;
		expect(message.length).toBeLessThanOrEqual(512);
	});

	it("tolerates a router with no logger at all", () => {
		expect(() => auditRecoveryAccepted(undefined, OPERATION)).not.toThrow();
	});

	describe("redactAuditText", () => {
		it("leaves an identifier an operator correlates on alone", () => {
			const text = "run 4f1c9b2e-0b3a-4d55-9a1e-2c7f8b6d0e11 in ws-a";
			expect(redactAuditText(text)).toBe(text);
		});

		it("removes a bearer header, a JWT, and a local operator token", () => {
			expect(redactAuditText("Bearer abcdef.ghijkl")).not.toContain("abcdef");
			expect(redactAuditText("eyJa.eyJb.sig")).toBe("[redacted]");
			expect(redactAuditText("cyop_0123456789abcdef")).toBe("[redacted]");
			// A device token is bare hex, which no shape rule distinguishes from an
			// id — except by length: 64 hex characters is what `generateTokenHex`
			// mints and nothing an operator reads is that long.
			expect(redactAuditText(`token ${"a".repeat(64)}`)).not.toContain(
				"a".repeat(64),
			);
		});
	});
});
