import { describe, expect, it } from "vitest";
import {
	EXIT_AUTH,
	EXIT_OUTCOME,
	EXIT_SUCCESS,
	EXIT_TIMEOUT,
	EXIT_TRANSIENT,
	EXIT_USAGE,
	OutcomeError,
	TimeoutError,
	UsageError,
} from "./errors.js";
import { ExitCode, exitCodeFor } from "./exitCodes.js";

describe("ExitCode", () => {
	it("fixes the six categories ADR 0011 defines", () => {
		// Stable API: an orchestrating agent branches on these numbers, so a
		// change here silently changes what every skill and CI job concludes.
		expect(ExitCode).toEqual({
			success: 0,
			usage: 2,
			outcome: 3,
			timeout: 4,
			auth: 5,
			transient: 6,
		});
	});

	it("is the single source of truth behind the legacy EXIT_* constants", () => {
		// `errors.ts` shipped these first. They must remain the same numbers, or
		// two modules would disagree about what a `3` means.
		expect(EXIT_SUCCESS).toBe(ExitCode.success);
		expect(EXIT_USAGE).toBe(ExitCode.usage);
		expect(EXIT_OUTCOME).toBe(ExitCode.outcome);
		expect(EXIT_TIMEOUT).toBe(ExitCode.timeout);
		expect(EXIT_AUTH).toBe(ExitCode.auth);
		expect(EXIT_TRANSIENT).toBe(ExitCode.transient);
	});
});

describe("exitCodeFor", () => {
	it("reads the category off a deliberate remote-operator failure", () => {
		expect(exitCodeFor(new UsageError("bad flag"))).toBe(ExitCode.usage);
		expect(exitCodeFor(new TimeoutError("gave up"))).toBe(ExitCode.timeout);
		expect(exitCodeFor(new OutcomeError("run errored"))).toBe(ExitCode.outcome);
	});

	it("refuses to categorize an unexpected defect", () => {
		// A bug reported as `6` tells an operator to retry a command that will
		// never succeed, so an unknown error must be re-thrown by the caller
		// rather than flattened into a category.
		expect(exitCodeFor(new TypeError("undefined is not a function"))).toBe(
			undefined,
		);
		expect(exitCodeFor("not even an error")).toBe(undefined);
	});
});
