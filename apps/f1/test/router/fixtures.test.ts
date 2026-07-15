import { CLIIssueTrackerService } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	createdFixture,
	promptedFixture,
	seedSession,
} from "../../src/router/fixtures.js";

const CREATOR = { id: "lin-1", email: "a@example.com", name: "A" };

describe("router fixtures", () => {
	it("createdFixture is a valid agentSessionCreated event", () => {
		const ev = createdFixture({
			sessionId: "s1",
			issue: { id: "i1", identifier: "CYPACK-1", title: "T" },
			creator: CREATOR,
		});
		expect(ev.type).toBe("AgentSessionEvent");
		expect(ev.action).toBe("created");
		expect((ev as any).agentSession.issue.identifier).toBe("CYPACK-1");
	});

	it("promptedFixture carries the prompt body", () => {
		const ev = promptedFixture({
			sessionId: "s1",
			actorUserId: "lin-1",
			creator: CREATOR,
			issue: { id: "i1", identifier: "CYPACK-1", title: "T" },
			body: "go",
		});
		expect(ev.action).toBe("prompted");
		expect((ev as any).agentActivity.content.body).toBe("go");
	});

	it("seedSession makes activities recordable for the session", () => {
		const tracker = new CLIIssueTrackerService();
		tracker.seedDefaultData();
		seedSession(tracker, "s1", "i1");
		expect(tracker.getState().agentSessions.get("s1")).toBeDefined();
	});
});
