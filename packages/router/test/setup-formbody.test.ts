import { describe, expect, it } from "vitest";
import {
	DEFAULT_MAX_FORM_BODY_BYTES,
	FormBodyTooLargeError,
	parseFormBody,
} from "../src/setup/formbody.js";

describe("parseFormBody", () => {
	it("parses simple key=value pairs", () => {
		expect(parseFormBody("a=1&b=2")).toEqual({ a: ["1"], b: ["2"] });
	});

	it("returns an empty record for an empty body", () => {
		expect(Object.keys(parseFormBody(""))).toEqual([]);
	});

	// Repeated keys matter for the save form (value:NAME / clear:NAME per
	// row), so every field comes back as an array, never a bare string.
	it("collects repeated keys into an array, in submission order", () => {
		expect(parseFormBody("a=1&a=2&a=3")).toEqual({ a: ["1", "2", "3"] });
	});

	it("treats a key with no '=' as present with an empty value", () => {
		expect(parseFormBody("flag")).toEqual({ flag: [""] });
	});

	it("treats a trailing '=' as an empty value", () => {
		expect(parseFormBody("a=")).toEqual({ a: [""] });
	});

	it("decodes '+' as a literal space", () => {
		expect(parseFormBody("a+b=c+d")).toEqual({ "a b": ["c d"] });
	});

	it("percent-decodes keys and values", () => {
		expect(parseFormBody("a=%20value%21")).toEqual({ a: [" value!"] });
	});

	it("percent-decodes a multi-byte UTF-8 sequence", () => {
		// "€" (U+20AC), encoded as UTF-8: E2 82 AC
		expect(parseFormBody("a=%E2%82%AC")).toEqual({ a: ["€"] });
	});

	it("skips empty pairs from doubled or boundary '&' characters", () => {
		expect(parseFormBody("&a=1&&b=2&")).toEqual({ a: ["1"], b: ["2"] });
	});

	it("does not throw on a malformed percent sequence, and keeps it literal", () => {
		expect(() => parseFormBody("a=%zz")).not.toThrow();
		expect(parseFormBody("a=%zz")).toEqual({ a: ["%zz"] });
	});

	it("does not throw on a trailing stray '%' with no following digits", () => {
		expect(() => parseFormBody("a=100%")).not.toThrow();
		expect(parseFormBody("a=100%")).toEqual({ a: ["100%"] });
	});

	it("does not throw on a '%' followed by only one hex digit", () => {
		expect(() => parseFormBody("a=100%2")).not.toThrow();
		expect(parseFormBody("a=100%2")).toEqual({ a: ["100%2"] });
	});

	describe("max body size", () => {
		it("accepts a body at the default limit", () => {
			const filler = "x".repeat(DEFAULT_MAX_FORM_BODY_BYTES - "a=".length);
			expect(() => parseFormBody(`a=${filler}`)).not.toThrow();
		});

		it("rejects a body over the default limit with a clear error", () => {
			const filler = "x".repeat(DEFAULT_MAX_FORM_BODY_BYTES + 1);
			expect(() => parseFormBody(`a=${filler}`)).toThrow(FormBodyTooLargeError);
			expect(() => parseFormBody(`a=${filler}`)).toThrow(/exceeds/);
		});

		it("honors a configurable maxBytes", () => {
			expect(() => parseFormBody("a=1234567890", { maxBytes: 5 })).toThrow(
				FormBodyTooLargeError,
			);
			expect(() => parseFormBody("a=12", { maxBytes: 5 })).not.toThrow();
		});
	});

	// Prototype-pollution guard: these three names must never appear as own
	// properties of the returned object, and must never affect the shared
	// Object.prototype, regardless of what downstream code does with the
	// parsed record (e.g. spreading it, or iterating with a `for...in`).
	describe("prototype-pollution guard", () => {
		it("drops __proto__, constructor, and prototype keys entirely", () => {
			const result = parseFormBody(
				"__proto__=evil&constructor=evil&prototype=evil&safe=1",
			);
			expect(Object.keys(result)).toEqual(["safe"]);
			expect(Object.hasOwn(result, "__proto__")).toBe(false);
			expect(Object.hasOwn(result, "constructor")).toBe(false);
			expect(Object.hasOwn(result, "prototype")).toBe(false);
		});

		it("never pollutes the global Object.prototype", () => {
			parseFormBody("__proto__=evil&__proto__=polluted");
			expect(({} as Record<string, unknown>).polluted).toBeUndefined();
		});

		it("produces a plain, JSON-serializable record", () => {
			const result = parseFormBody("a=1&b=2");
			expect(JSON.parse(JSON.stringify(result))).toEqual({
				a: ["1"],
				b: ["2"],
			});
		});
	});
});
