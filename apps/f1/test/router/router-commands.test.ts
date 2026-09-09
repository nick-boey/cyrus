// apps/f1/test/router/router-commands.test.ts
import { describe, expect, it } from "vitest";
import { createRouterArtifactCommand } from "../../src/commands/router/artifact.js";
import { createRouterEnrollCommand } from "../../src/commands/router/enroll.js";
import { createRouterInjectCommand } from "../../src/commands/router/inject.js";
import {
	createRouterSeedUserCommand,
	parseEnvPairs,
} from "../../src/commands/router/seedUser.js";
import { createRouterStrandRunCommand } from "../../src/commands/router/strandRun.js";

describe("router:* commands", () => {
	it("expose the expected command names and required options", () => {
		expect(createRouterInjectCommand().name()).toBe("router:inject");
		expect(createRouterSeedUserCommand().name()).toBe("router:seed-user");
		expect(createRouterArtifactCommand().name()).toBe("router:artifact");
		expect(createRouterEnrollCommand().name()).toBe("router:enroll");
		expect(createRouterStrandRunCommand().name()).toBe("router:strand-run");
		const inject = createRouterInjectCommand();
		const names = inject.options.map((o) => o.long);
		expect(names).toContain("--session-id");
		expect(names).toContain("--identifier");
		const enroll = createRouterEnrollCommand();
		const enrollNames = enroll.options.map((o) => o.long);
		expect(enrollNames).toContain("--email");
		const strand = createRouterStrandRunCommand();
		const strandNames = strand.options.map((o) => o.long);
		expect(strandNames).toContain("--session-id");
		expect(strandNames).toContain("--timeout");
		expect(strandNames).toContain("--json");
	});
});

describe("parseEnvPairs", () => {
	it("parses repeatable KEY=VALUE pairs, splitting on the first '='", () => {
		expect(parseEnvPairs(["A=1", "B=x=y"])).toEqual({ A: "1", B: "x=y" });
	});

	it("throws a leak-safe error (never includes the value) for a malformed pair", () => {
		expect(() => parseEnvPairs(["SECRETVALUE_NO_EQ"])).toThrow(/value omitted/);
	});
});
