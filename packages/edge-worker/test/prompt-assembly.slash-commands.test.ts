/**
 * Prompt Assembly Tests - Leading `/skill` commands
 *
 * Claude Code expands a slash command only when the prompt STARTS with
 * `/<name>`. Cyrus wraps every comment in XML, so the token is echoed onto
 * line 1 to make the expansion fire — but only for a command that names a
 * skill this session can actually run. See NOR-368.
 *
 * The skill names used here (`debug`, `summarize`) are real bundled Cyrus
 * skills, deployed into TEST_CYRUS_HOME by test-dirs.ts, so these assertions
 * exercise the same discovery path production uses.
 */

import {
	CYRUS_EVENTS,
	type InstalledRecordingLogSink,
	installRecordingLogSink,
} from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createTestWorker,
	type PromptScenario,
	scenario,
} from "./prompt-assembly-utils.js";
import { TEST_WORKING_DIR } from "./test-dirs.js";

/** A scenario with a repository, which skill discovery requires. */
function withRepo(s: PromptScenario): PromptScenario {
	return s.withRepository({
		id: "repo-1",
		name: "Test Repo",
		repositoryPath: TEST_WORKING_DIR,
		linearWorkspaceId: "ws-1",
	});
}

describe("Prompt Assembly - Leading slash commands", () => {
	let recorder: InstalledRecordingLogSink;

	beforeEach(() => {
		recorder = installRecordingLogSink();
	});

	afterEach(() => {
		recorder.restore();
	});

	it("echoes a mentioned /skill onto line 1, leaving the wrapped comment intact", async () => {
		await withRepo(scenario(createTestWorker()).continuationSession())
			.withUserComment("@cyrus1 /debug the parser throws on empty input")
			.withCommentAuthor("Alice Smith")
			.withCommentTimestamp("2025-01-27T12:00:00Z")
			.expectUserPrompt(`/debug
<new_comment>
  <author>Alice Smith</author>
  <timestamp>2025-01-27T12:00:00Z</timestamp>
  <content>
@cyrus1 /debug the parser throws on empty input
  </content>
</new_comment>`)
			.expectSystemPrompt(undefined)
			.expectComponents("user-comment")
			.expectPromptType("continuation")
			.verify();
	});

	it("accepts a plugin-qualified skill name", async () => {
		await withRepo(scenario(createTestWorker()).continuationSession())
			.withUserComment("@cyrus1 /cyrus-skills:summarize wrap this up")
			.withCommentAuthor("Alice Smith")
			.withCommentTimestamp("2025-01-27T12:00:00Z")
			.expectUserPrompt(`/cyrus-skills:summarize
<new_comment>
  <author>Alice Smith</author>
  <timestamp>2025-01-27T12:00:00Z</timestamp>
  <content>
@cyrus1 /cyrus-skills:summarize wrap this up
  </content>
</new_comment>`)
			.expectComponents("user-comment")
			.verify();
	});

	/**
	 * The regression an F1 test drive surfaced: an unrecognised command does NOT
	 * degrade to plain text. The CLI answers "Unknown command: /foo" and the
	 * comment never reaches the model, so prefixing one would swallow the
	 * message of anyone opening with a `/word` Cyrus does not own.
	 */
	it("leaves a command that is not a discovered skill as prose", async () => {
		await withRepo(scenario(createTestWorker()).continuationSession())
			.withUserComment("@cyrus1 /deploy the app to staging please")
			.withCommentAuthor("Alice Smith")
			.withCommentTimestamp("2025-01-27T12:00:00Z")
			.expectUserPrompt(`<new_comment>
  <author>Alice Smith</author>
  <timestamp>2025-01-27T12:00:00Z</timestamp>
  <content>
@cyrus1 /deploy the app to staging please
  </content>
</new_comment>`)
			.verify();

		expect(
			recorder.sink.findAll({ event: CYRUS_EVENTS.skillSlashInvoked }),
		).toEqual([]);
	});

	it("leaves a comment with no leading command byte-for-byte unchanged", async () => {
		await withRepo(scenario(createTestWorker()).continuationSession())
			.withUserComment("Please fix the bug")
			.withCommentAuthor("Alice Smith")
			.withCommentTimestamp("2025-01-27T12:00:00Z")
			.expectUserPrompt(`<new_comment>
  <author>Alice Smith</author>
  <timestamp>2025-01-27T12:00:00Z</timestamp>
  <content>
Please fix the bug
  </content>
</new_comment>`)
			.verify();
	});

	it("treats a slash mid-sentence as prose, not a command", async () => {
		await withRepo(scenario(createTestWorker()).continuationSession())
			.withUserComment("Could you run /debug on this when you get a chance?")
			.withCommentAuthor("Alice Smith")
			.withCommentTimestamp("2025-01-27T12:00:00Z")
			.expectUserPrompt(`<new_comment>
  <author>Alice Smith</author>
  <timestamp>2025-01-27T12:00:00Z</timestamp>
  <content>
Could you run /debug on this when you get a chance?
  </content>
</new_comment>`)
			.verify();
	});

	it("does not double-prefix a streaming comment that already leads with the command", async () => {
		await withRepo(scenario(createTestWorker()).streamingSession())
			.withUserComment("/debug the parser throws")
			.expectUserPrompt("/debug the parser throws")
			.expectComponents("user-comment")
			.expectPromptType("continuation")
			.verify();
	});

	it("prefixes a streaming comment that leads with a mention", async () => {
		await withRepo(scenario(createTestWorker()).streamingSession())
			.withUserComment("@cyrus1 /debug the parser throws")
			.expectUserPrompt("/debug\n@cyrus1 /debug the parser throws")
			.expectComponents("user-comment")
			.verify();
	});

	it("emits a skill.slash_invoked event carrying the skill and issue", async () => {
		await withRepo(scenario(createTestWorker()).continuationSession())
			.withIssue({ identifier: "NOR-368" })
			.withUserComment("@cyrus1 /debug the parser throws")
			.build();

		const record = recorder.sink.find({
			event: CYRUS_EVENTS.skillSlashInvoked,
		});
		expect(record?.attributes).toMatchObject({
			"cyrus.skill": "debug",
			"cyrus.issue_key": "NOR-368",
			"cyrus.prompt_type": "continuation",
			"cyrus.new_session": false,
			"cyrus.streaming": false,
		});
	});

	it("emits nothing when there is no leading command", async () => {
		await withRepo(scenario(createTestWorker()).continuationSession())
			.withUserComment("Could you run /debug on this later?")
			.build();

		expect(
			recorder.sink.findAll({ event: CYRUS_EVENTS.skillSlashInvoked }),
		).toEqual([]);
	});
});
