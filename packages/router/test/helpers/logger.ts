import { createNoopLogger, type ILogger } from "cyrus-core";
import { type Mock, vi } from "vitest";

/**
 * A full {@link ILogger} whose five log methods are vitest mocks, so a test can
 * assert on any level without having to enumerate the rest of the interface.
 */
export type TestLogger = ILogger & {
	debug: Mock;
	info: Mock;
	warn: Mock;
	error: Mock;
	event: Mock;
};

/**
 * Build a mock logger. `overrides` replaces individual methods — e.g.
 * `testLogger({ warn: (msg) => warnings.push(msg) })` — while everything else
 * stays a recording mock.
 */
export function testLogger(overrides?: Partial<ILogger>): TestLogger {
	const logger: TestLogger = {
		...createNoopLogger(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		event: vi.fn(),
		withContext: () => logger,
		...overrides,
	} as TestLogger;
	return logger;
}

/** A full {@link ILogger} that records nothing. */
export function silentLogger(overrides?: Partial<ILogger>): ILogger {
	return { ...createNoopLogger(), ...overrides };
}

/**
 * Every `logger.event(name, attrs)` call recorded for one event name, with the
 * `cyrus.` attribute namespace stripped.
 *
 * De-namespacing on the way out is deliberate. These call sites are asserting
 * LIFECYCLE BEHAVIOUR — "the idle stop carried the uptime of the run it ended" —
 * and spelling `"cyrus.uptime_ms"` in each of them would couple every one of
 * those claims to the wire format, so a future namespace change would break
 * thirty behavioural tests that are not about naming at all. The naming contract
 * itself (dotted event names, `cyrus.*` attributes) is owned by
 * `SandboxTelemetry.test.ts`, which asserts the emitted keys verbatim.
 */
export function eventsNamed(
	logger: TestLogger,
	name: string,
): Array<Record<string, unknown>> {
	return logger.event.mock.calls
		.filter(([emitted]) => emitted === name)
		.map(([, attributes]) => stripCyrusNamespace(attributes));
}

function stripCyrusNamespace(attributes: unknown): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(
		(attributes ?? {}) as Record<string, unknown>,
	)) {
		out[key.startsWith("cyrus.") ? key.slice("cyrus.".length) : key] = value;
	}
	return out;
}
