import { describe, expect, it } from "vitest";
import {
	AssociationParseError,
	formatAssociations,
	parseAssociations,
} from "../../src/routing/associations.js";

describe("parseAssociations", () => {
	it("returns empty arrays for an empty string", () => {
		expect(parseAssociations("")).toEqual({ projectKeys: [], teamKeys: [] });
		expect(parseAssociations("   ")).toEqual({ projectKeys: [], teamKeys: [] });
	});

	it("parses repeated p= and t= keys in order", () => {
		expect(parseAssociations("p=Platform,p=Billing,t=NOR")).toEqual({
			projectKeys: ["Platform", "Billing"],
			teamKeys: ["NOR"],
		});
	});

	it("trims whitespace around unquoted values and separators", () => {
		expect(parseAssociations("  p = Platform , t = NOR  ")).toEqual({
			projectKeys: ["Platform"],
			teamKeys: ["NOR"],
		});
	});

	it("keeps commas and spacing inside double-quoted values", () => {
		expect(parseAssociations('p="Q3 Migration, Phase 2",t=ENG')).toEqual({
			projectKeys: ["Q3 Migration, Phase 2"],
			teamKeys: ["ENG"],
		});
	});

	it("preserves leading and trailing spaces inside quotes", () => {
		expect(parseAssociations('p=" padded "')).toEqual({
			projectKeys: [" padded "],
			teamKeys: [],
		});
	});

	it("de-duplicates case-insensitively, keeping the first spelling", () => {
		expect(parseAssociations("t=NOR,t=nor,p=Platform,p=PLATFORM")).toEqual({
			projectKeys: ["Platform"],
			teamKeys: ["NOR"],
		});
	});

	it("rejects an unknown key", () => {
		expect(() => parseAssociations("x=Platform")).toThrow(
			AssociationParseError,
		);
		expect(() => parseAssociations("x=Platform")).toThrow(
			'Unknown key "x". Use p= for a project name or t= for a team key.',
		);
	});

	it("rejects a pair with no equals sign", () => {
		expect(() => parseAssociations("Platform")).toThrow(
			'Expected key=value but got "Platform". Use p= for a project name or t= for a team key.',
		);
	});

	it("rejects an empty value", () => {
		expect(() => parseAssociations("p=,t=NOR")).toThrow(
			'The value for "p" is empty.',
		);
	});

	it("rejects an unterminated quote", () => {
		expect(() => parseAssociations('p="Q3 Migration')).toThrow(
			"Unterminated quoted value.",
		);
	});

	it("rejects trailing characters after a closing quote", () => {
		expect(() => parseAssociations('p="Platform"x')).toThrow(
			'Unexpected characters after the closing quote in "p".',
		);
	});
});

describe("formatAssociations", () => {
	it("returns an empty string when there is nothing to format", () => {
		expect(formatAssociations({})).toBe("");
		expect(formatAssociations({ projectKeys: [], teamKeys: [] })).toBe("");
	});

	it("emits projects before teams", () => {
		expect(
			formatAssociations({
				projectKeys: ["Platform", "Billing"],
				teamKeys: ["NOR"],
			}),
		).toBe("p=Platform,p=Billing,t=NOR");
	});

	it("quotes values containing a comma, an equals sign, a quote, or edge whitespace", () => {
		expect(formatAssociations({ projectKeys: ["Q3, Phase 2"] })).toBe(
			'p="Q3, Phase 2"',
		);
		expect(formatAssociations({ projectKeys: [" padded "] })).toBe(
			'p=" padded "',
		);
		expect(formatAssociations({ projectKeys: ['say "hi"'] })).toBe(
			'p="say \\"hi\\""',
		);
	});

	it("round-trips through parseAssociations", () => {
		const original = {
			projectKeys: ["Q3, Phase 2", " padded ", 'say "hi"', "Platform"],
			teamKeys: ["NOR", "ENG"],
		};
		expect(parseAssociations(formatAssociations(original))).toEqual(original);
	});
});
