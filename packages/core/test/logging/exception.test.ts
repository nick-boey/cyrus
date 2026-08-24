import { describe, expect, it } from "vitest";
import {
	describeException,
	describeExceptionFromArgs,
	exceptionAttributes,
	extractError,
} from "../../src/logging/exception.js";

describe("extractError", () => {
	it("finds a bare Error in the trailing args", () => {
		const error = new Error("boom");
		expect(extractError(["context", error, 42])).toBe(error);
	});

	it("unwraps the `{ error: Error }` shape transports pass", () => {
		const error = new Error("boom");
		expect(extractError([{ error }])).toBe(error);
	});

	it("returns the OUTERMOST error, not the root cause", () => {
		// The outer error is the one the call site was handed and the one the
		// message describes. The cause is preserved in the stacktrace instead.
		const cause = new TypeError("inner");
		const outer = new Error("outer", { cause });
		expect(extractError([outer])).toBe(outer);
	});

	it("returns undefined when no arg is an Error", () => {
		expect(extractError(["just", "strings", { error: "not an Error" }])).toBe(
			undefined,
		);
	});
});

describe("describeException", () => {
	it("maps name and message onto exception.type and exception.message", () => {
		const exception = describeException(new TypeError("bad input"));
		expect(exception.type).toBe("TypeError");
		expect(exception.message).toBe("bad input");
	});

	it("uses the constructor name when `name` was blanked out", () => {
		class TransportError extends Error {}
		const error = new TransportError("down");
		error.name = "";
		expect(describeException(error).type).toBe("TransportError");
	});

	it("appends the cause chain to the stacktrace", () => {
		// Semconv has no attribute for a cause, and the root cause is routinely
		// the only useful frame: a wrapper's own stack points exclusively at our
		// retry helper.
		const root = new Error("ECONNREFUSED");
		const middle = new Error("request failed", { cause: root });
		const outer = new Error("could not send", { cause: middle });

		const stacktrace = describeException(outer).stacktrace ?? "";
		expect(stacktrace).toContain("could not send");
		expect(stacktrace).toContain("Caused by: Error: request failed");
		expect(stacktrace).toContain("Caused by: Error: ECONNREFUSED");
	});

	it("records a non-Error cause rather than dropping it", () => {
		const error = new Error("upload rejected", { cause: "HTTP 413" });
		expect(describeException(error).stacktrace).toContain(
			"Caused by: HTTP 413",
		);
	});

	it("stops at a cyclic cause instead of looping forever", () => {
		// `cause` is caller-supplied; nothing stops it pointing back at its wrapper.
		const a = new Error("a");
		const b = new Error("b", { cause: a });
		(a as { cause?: unknown }).cause = b;
		expect(() => describeException(b)).not.toThrow();
		const stacktrace = describeException(b).stacktrace ?? "";
		expect(stacktrace.split("Caused by:").length - 1).toBeLessThanOrEqual(5);
	});

	it("bounds a long cause chain", () => {
		let error = new Error("root");
		for (let i = 0; i < 20; i++) {
			error = new Error(`wrap-${i}`, { cause: error });
		}
		const stacktrace = describeException(error).stacktrace ?? "";
		expect(stacktrace.split("Caused by:").length - 1).toBeLessThanOrEqual(5);
	});

	it("omits the stacktrace for a frameless error it would only restate", () => {
		// `Name: message` adds nothing over exception.type + exception.message,
		// and an attribute whose value is redundant is one more billed byte.
		const error = new Error("no stack here");
		error.stack = undefined;
		expect(describeException(error).stacktrace).toBeUndefined();
	});

	it("keeps a frameless error's cause, which is NOT redundant", () => {
		const error = new Error("wrapper", { cause: new Error("real failure") });
		error.stack = undefined;
		expect(describeException(error).stacktrace).toContain(
			"Caused by: Error: real failure",
		);
	});
});

describe("describeExceptionFromArgs", () => {
	it("shapes the first Error found", () => {
		expect(describeExceptionFromArgs(["ctx", new RangeError("oops")])).toEqual(
			expect.objectContaining({ type: "RangeError", message: "oops" }),
		);
	});

	it("returns undefined when the args carry no Error", () => {
		expect(describeExceptionFromArgs(["ctx", 1, true])).toBeUndefined();
	});
});

describe("exceptionAttributes", () => {
	it("emits the stable OTel semconv key names", () => {
		expect(
			exceptionAttributes({
				type: "TypeError",
				message: "bad input",
				stacktrace: "TypeError: bad input\n    at x",
			}),
		).toEqual({
			"exception.type": "TypeError",
			"exception.message": "bad input",
			"exception.stacktrace": "TypeError: bad input\n    at x",
		});
	});

	it("omits exception.stacktrace when there is none", () => {
		expect(
			exceptionAttributes({ type: "Error", message: "m" }),
		).not.toHaveProperty("exception.stacktrace");
	});
});
