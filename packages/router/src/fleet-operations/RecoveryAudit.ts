import {
	cyrusAttributes,
	type ILogger,
	type LogEventAttributes,
} from "cyrus-core";
import type {
	OperatorAuthMethodV1,
	RecoveryEvidenceV1,
} from "cyrus-operator-protocol";
import type { RecoveryOperationRecord } from "../RouterStore.js";

/**
 * The structured audit trail for guarded recovery.
 *
 * ── WHY AN EVENT AND NOT A LOG LINE ──
 * Recovery is the one mutation the operator contract exposes, so "who asked the
 * router to touch which run, on what evidence, and what did it do" has to be
 * QUERYABLE rather than reconstructible from prose. `ILogger.event` is the only
 * path that reaches the structured stream: `debug`/`info` are never forwarded,
 * so an audit written as an `info` line would not leave a sandbox worker at all
 * (the failure NOR-402 was diagnosed from) and would not be alertable here.
 *
 * These names share the vocabulary in `cyrus-core`'s `CYRUS_EVENTS` and
 * `SANDBOX_EVENTS`: dotted lowercase, domain segment first, so one KQL
 * predicate (`event startswith "recovery."`) selects the whole family. Every
 * attribute goes under `cyrus.*` via {@link cyrusAttributes} — and note the
 * bracket rule that implies for any query over them
 * (`p["cyrus.run_id"]`, never `p.cyrus.run_id`, which parses as a nested lookup
 * and silently returns null).
 *
 * The persisted `recovery_operations` row and these events are two halves of one
 * claim and neither replaces the other: the row is the resource a client polls
 * and is aged out with its run, while the events are the durable trail in a log
 * backend with its own retention.
 */
export const RECOVERY_EVENTS = {
	/** A request passed every gate and was persisted as `accepted`. */
	accepted: "recovery.accepted",
	/** A retry of an existing key joined the operation it already names. */
	joined: "recovery.joined",
	/**
	 * A request was turned away BEFORE any operation existed — an unheld
	 * capability, an unreadable run, a stale revision, a rebound idempotency key.
	 * These never become operations, so without this event they would leave no
	 * durable trace at all.
	 */
	refused: "recovery.refused",
	/** An operation entered a new non-terminal phase. */
	phaseChanged: "recovery.phase_changed",
	/** An operation reached an outcome: recovered, needs input, refused, failed. */
	settled: "recovery.settled",
} as const;

export type RecoveryEventName =
	(typeof RECOVERY_EVENTS)[keyof typeof RECOVERY_EVENTS];

/**
 * Who asked, and about what.
 *
 * `workspaceId` and the operation fields are optional because a refusal can be
 * emitted before any of them is known — a caller naming a run it may not read
 * has no resolved workspace, and that is precisely the refusal worth recording.
 */
export interface RecoveryAuditIdentity {
	runId: string;
	principalId: string;
	authMethod: OperatorAuthMethodV1;
	workspaceId?: string;
	operationId?: string;
	idempotencyKey?: string;
	expectedRevision?: number;
	issueKey?: string;
}

/** What `redactAuditText` substitutes for credential material. */
export const REDACTED = "[redacted]";

/**
 * Shapes that are credentials wherever they appear.
 *
 * A deliberate mirror of the CLI's `redactSecrets` rather than a shared import:
 * `apps/cli` cannot depend on router internals and this package must not depend
 * on the CLI, and the alternative — hoisting it into `cyrus-core` — would put a
 * redaction policy on the install path of every runner for the sake of one call
 * site. The patterns are broad on purpose: over-redacting a coordinator's note
 * costs an operator one question, while under-redacting writes a live bearer
 * token into a log backend that outlives it.
 */
const REDACTION_PATTERNS: readonly RegExp[] = [
	// `Authorization: Bearer …`, in any casing.
	/\bbearer\s+[\w\-._~+/]+=*/gi,
	// A JWT anywhere — an Entra operator access token, labelled or not.
	/\beyJ[\w-]+\.[\w-]+\.[\w-]+/g,
	// A locally minted operator token.
	/\bcyop_[0-9a-f]{8,}/gi,
	// A device token: 64 hex characters from `generateTokenHex`. Bounded well
	// above anything an operator correlates on — a run id is a dashed UUID and a
	// git SHA is 40 — so this cannot eat an identifier someone is reading.
	/\b[0-9a-f]{48,}\b/gi,
	// A credential named in a JSON or header dump the coordinator quoted.
	/(["']?(?:authorization|token|access_token|secret)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
];

/**
 * The longest free-text field this audit will carry.
 *
 * Every one of them is caller- or coordinator-supplied, these events are billed
 * per GB, and a coordinator that quotes a stack trace as its detail would
 * otherwise multiply it across every phase of every operation.
 */
const MAX_AUDIT_TEXT_CHARS = 512;

/**
 * Strips credential material out of text bound for the audit stream, and bounds
 * its length.
 */
export function redactAuditText(text: string): string {
	let redacted = text;
	for (const pattern of REDACTION_PATTERNS) {
		redacted = redacted.replace(pattern, (_match, prefix?: string) =>
			// The one two-group pattern keeps its field name, so a reader can see
			// WHICH field was removed; the rest are replaced whole.
			typeof prefix === "string" ? `${prefix}${REDACTED}` : REDACTED,
		);
	}
	return redacted.length > MAX_AUDIT_TEXT_CHARS
		? `${redacted.slice(0, MAX_AUDIT_TEXT_CHARS - 1)}…`
		: redacted;
}

/** The identity half of an operation's audit attributes. */
export function recoveryAuditIdentity(
	operation: RecoveryOperationRecord,
): RecoveryAuditIdentity {
	return {
		runId: operation.runId,
		principalId: operation.principalId,
		authMethod: operation.authMethod,
		workspaceId: operation.workspaceId,
		operationId: operation.operationId,
		idempotencyKey: operation.idempotencyKey,
		expectedRevision: operation.expectedRevision,
	};
}

function identityAttributes(
	identity: RecoveryAuditIdentity,
): LogEventAttributes {
	return {
		run_id: identity.runId,
		principal_id: identity.principalId,
		auth_method: identity.authMethod,
		...defined("workspace_id", identity.workspaceId),
		...defined("issue_key", identity.issueKey),
		...defined("operation_id", identity.operationId),
		// Caller-chosen free text, so it is redacted like any other: an idempotency
		// key is the field a client is most likely to derive from something it
		// already holds, which is occasionally a token.
		...(identity.idempotencyKey !== undefined
			? { idempotency_key: redactAuditText(identity.idempotencyKey) }
			: {}),
		...defined("expected_revision", identity.expectedRevision),
	};
}

/**
 * The evidence snapshot, flattened under a prefix.
 *
 * Flat because Log Analytics projects each attribute into its own dynamic
 * column, and because the question this audit answers — "did the operation
 * release a pin that was actually held?" — is a comparison of two scalars, not a
 * document diff. Nothing here is prompt text or agent-activity content: the
 * evidence is a revision, a lifecycle, and three booleans, by construction.
 */
function evidenceAttributes(
	prefix: "before" | "after",
	evidence: RecoveryEvidenceV1,
): LogEventAttributes {
	return {
		[`${prefix}_revision`]: evidence.revision,
		[`${prefix}_lifecycle`]: evidence.lifecycle,
		[`${prefix}_worker_online`]: evidence.workerOnline,
		[`${prefix}_session_affinity_held`]: evidence.sessionAffinityHeld,
		[`${prefix}_issue_locked`]: evidence.issueLocked,
		...defined(`${prefix}_executor_state`, evidence.executorState),
		[`${prefix}_observed_at`]: evidence.observedAt,
	};
}

function operationAttributes(
	operation: RecoveryOperationRecord,
): LogEventAttributes {
	const latest = operation.phases.at(-1);
	return {
		...identityAttributes(recoveryAuditIdentity(operation)),
		phase: operation.phase,
		roles: operation.roles.join(","),
		...(operation.reason !== undefined
			? { reason: redactAuditText(operation.reason) }
			: {}),
		...(latest?.detail !== undefined
			? { detail: redactAuditText(latest.detail) }
			: {}),
		...evidenceAttributes("before", operation.evidenceBefore),
	};
}

/** Emits one recovery audit event. A router with no logger simply emits none. */
function emit(
	logger: ILogger | undefined,
	name: RecoveryEventName,
	attributes: LogEventAttributes,
): void {
	logger?.event(name, cyrusAttributes(attributes));
}

export function auditRecoveryAccepted(
	logger: ILogger | undefined,
	operation: RecoveryOperationRecord,
): void {
	emit(logger, RECOVERY_EVENTS.accepted, operationAttributes(operation));
}

export function auditRecoveryJoined(
	logger: ILogger | undefined,
	operation: RecoveryOperationRecord,
): void {
	emit(logger, RECOVERY_EVENTS.joined, operationAttributes(operation));
}

export function auditRecoveryPhase(
	logger: ILogger | undefined,
	operation: RecoveryOperationRecord,
): void {
	emit(logger, RECOVERY_EVENTS.phaseChanged, operationAttributes(operation));
}

/**
 * An operation reached its outcome.
 *
 * Separate from {@link auditRecoveryPhase} even though a terminal phase is also
 * a phase, because an alert on "how did recoveries end" must not have to filter
 * an enum out of the phase stream — and because this is the only event that
 * carries the after-evidence the whole audit exists to compare.
 */
export function auditRecoverySettled(
	logger: ILogger | undefined,
	operation: RecoveryOperationRecord,
): void {
	emit(logger, RECOVERY_EVENTS.settled, {
		...operationAttributes(operation),
		...(operation.evidenceAfter
			? evidenceAttributes("after", operation.evidenceAfter)
			: {}),
		...defined("refusal_reason", operation.refusalReason),
		...(operation.failureMessage !== undefined
			? { failure_message: redactAuditText(operation.failureMessage) }
			: {}),
		...(operation.completedMs !== undefined
			? { duration_ms: operation.completedMs - operation.requestedMs }
			: {}),
	});
}

/**
 * A request refused before it became an operation.
 *
 * `code` is the closed error code the route answers with, so a
 * `summarize by code` has a bounded set of values, and `status` is the HTTP
 * status the caller saw — the two together are what makes a client's report of a
 * failed recovery checkable against the router's own record of it.
 */
export function auditRecoveryRefusal(
	logger: ILogger | undefined,
	identity: RecoveryAuditIdentity,
	outcome: { code: string; status: number; detail?: string },
): void {
	emit(logger, RECOVERY_EVENTS.refused, {
		...identityAttributes(identity),
		code: outcome.code,
		status: outcome.status,
		...(outcome.detail !== undefined
			? { detail: redactAuditText(outcome.detail) }
			: {}),
	});
}

function defined(
	key: string,
	value: string | number | undefined,
): LogEventAttributes {
	return value === undefined ? {} : { [key]: value };
}
