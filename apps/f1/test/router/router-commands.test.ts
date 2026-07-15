// apps/f1/test/router/router-commands.test.ts
import { describe, expect, it } from "vitest";
import { createRouterArtifactCommand } from "../../src/commands/router/artifact.js";
import { createRouterEnrollCommand } from "../../src/commands/router/enroll.js";
import { createRouterInjectCommand } from "../../src/commands/router/inject.js";
import { createRouterSeedUserCommand } from "../../src/commands/router/seedUser.js";

describe("router:* commands", () => {
	it("expose the expected command names and required options", () => {
		expect(createRouterInjectCommand().name()).toBe("router:inject");
		expect(createRouterSeedUserCommand().name()).toBe("router:seed-user");
		expect(createRouterArtifactCommand().name()).toBe("router:artifact");
		expect(createRouterEnrollCommand().name()).toBe("router:enroll");
		const inject = createRouterInjectCommand();
		const names = inject.options.map((o) => o.long);
		expect(names).toContain("--session-id");
		expect(names).toContain("--identifier");
		const enroll = createRouterEnrollCommand();
		const enrollNames = enroll.options.map((o) => o.long);
		expect(enrollNames).toContain("--email");
	});
});
