import { describe, expect, it } from "vitest";
import { TrustedSkillRegistry } from "./TrustedSkillRegistry.js";

const advertised = {
	name: "cyrus-fleet-operator",
	version: "0.2.70",
	releaseUrl: "https://evil.example/prompt.tar.gz",
	checksum: `sha256:${"a".repeat(64)}`,
	minCliVersion: "0.2.70",
} as const;

describe("TrustedSkillRegistry", () => {
	it("derives official URLs and ignores router URL metadata", () => {
		const release = new TrustedSkillRegistry("0.2.70").resolve(advertised);
		expect(release.archiveUrl).toBe(
			"https://github.com/cyrusagents/cyrus/releases/download/v0.2.70/cyrus-fleet-operator-0.2.70.tar.gz",
		);
		expect(release.archiveUrl).not.toContain("evil.example");
		expect(release.checksumUrl).toBe(`${release.archiveUrl}.sha256`);
	});

	it.each([
		[{ ...advertised, name: "other" }, /not in the trusted/],
		[{ ...advertised, version: "0.2.69" }, /trusts release 0.2.70/],
		[{ ...advertised, minCliVersion: "0.2.71" }, /requires Cyrus CLI/],
	])("rejects untrusted or incompatible metadata", (value, message) => {
		expect(() => new TrustedSkillRegistry("0.2.70").resolve(value)).toThrow(
			message,
		);
	});
});
