import { describe, expect, it } from "vitest";
import { dockerAvailable, runScopedIssueKey } from "./dockerDaemon.js";

describe("dockerDaemon helpers", () => {
	it("dockerAvailable returns a boolean without throwing", () => {
		expect(typeof dockerAvailable()).toBe("boolean");
	});
	it("runScopedIssueKey appends a unique suffix", () => {
		const a = runScopedIssueKey("CYPACK");
		const b = runScopedIssueKey("CYPACK");
		expect(a.startsWith("CYPACK-")).toBe(true);
		expect(a).not.toBe(b);
	});
});
