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
