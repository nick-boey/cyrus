/**
 * Prompt Assembly Tests - Leading `/skill` commands
 *
 * Claude Code expands a slash command only when the prompt STARTS with
 * `/<name>`. Cyrus wraps every comment in XML, so the token is echoed onto
 * line 1 to make the expansion fire. See NOR-368.
 */

import {
	CYRUS_EVENTS,
	type InstalledRecordingLogSink,
	installRecordingLogSink,
} from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestWorker, scenario } from "./prompt-assembly-utils.js";

describe("Prompt Assembly - Leading slash commands", () => {
	let recorder: InstalledRecordingLogSink;

	beforeEach(() => {
		recorder = installRecordingLogSink();
	});

	afterEach(() => {
		recorder.restore();
	});

	it("echoes a mentioned /skill onto line 1, leaving the wrapped comment intact", async () => {
		const worker = createTestWorker();

		await scenario(worker)
			.continuationSession()
			.withUserComment("@cyrus1 /tdd add a failing test for the parser")
			.withCommentAuthor("Alice Smith")
			.withCommentTimestamp("2025-01-27T12:00:00Z")
			.expectUserPrompt(`/tdd
<new_comment>
  <author>Alice Smith</author>
  <timestamp>2025-01-27T12:00:00Z</timestamp>
  <content>
@cyrus1 /tdd add a failing test for the parser
  </content>
</new_comment>`)
			.expectSystemPrompt(undefined)
			.expectComponents("user-comment")
			.expectPromptType("continuation")
			.verify();
	});

	it("accepts a plugin-qualified skill name", async () => {
		const worker = createTestWorker();

		await scenario(worker)
			.continuationSession()
			.withUserComment("@cyrus1 /mattpocock-skills:grilling stress-test this")
			.withCommentAuthor("Alice Smith")
			.withCommentTimestamp("2025-01-27T12:00:00Z")
			.expectUserPrompt(`/mattpocock-skills:grilling
<new_comment>
  <author>Alice Smith</author>
  <timestamp>2025-01-27T12:00:00Z</timestamp>
  <content>
@cyrus1 /mattpocock-skills:grilling stress-test this
  </content>
</new_comment>`)
			.expectComponents("user-comment")
			.verify();
	});

	it("leaves a comment with no leading command byte-for-byte unchanged", async () => {
		const worker = createTestWorker();

		await scenario(worker)
			.continuationSession()
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
		const worker = createTestWorker();

		await scenario(worker)
			.continuationSession()
			.withUserComment("Could you run /tdd on this when you get a chance?")
			.withCommentAuthor("Alice Smith")
			.withCommentTimestamp("2025-01-27T12:00:00Z")
			.expectUserPrompt(`<new_comment>
  <author>Alice Smith</author>
  <timestamp>2025-01-27T12:00:00Z</timestamp>
  <content>
Could you run /tdd on this when you get a chance?
  </content>
</new_comment>`)
			.verify();
	});

	it("does not double-prefix a streaming comment that already leads with the command", async () => {
		const worker = createTestWorker();

		await scenario(worker)
			.streamingSession()
			.withUserComment("/tdd add a failing test")
			.expectUserPrompt("/tdd add a failing test")
			.expectComponents("user-comment")
			.expectPromptType("continuation")
			.verify();
	});

	it("prefixes a streaming comment that leads with a mention", async () => {
		const worker = createTestWorker();

		await scenario(worker)
			.streamingSession()
			.withUserComment("@cyrus1 /tdd add a failing test")
			.expectUserPrompt("/tdd\n@cyrus1 /tdd add a failing test")
			.expectComponents("user-comment")
			.verify();
	});

	it("emits a skill.slash_invoked event carrying the skill and issue", async () => {
		const worker = createTestWorker();

		await scenario(worker)
			.continuationSession()
			.withIssue({ identifier: "NOR-368" })
			.withUserComment("@cyrus1 /tdd add a failing test")
			.build();

		const record = recorder.sink.find({
			event: CYRUS_EVENTS.skillSlashInvoked,
		});
		expect(record?.attributes).toMatchObject({
			"cyrus.skill": "tdd",
			"cyrus.issue_key": "NOR-368",
			"cyrus.prompt_type": "continuation",
			"cyrus.new_session": false,
			"cyrus.streaming": false,
		});
	});

	it("emits nothing when there is no leading command", async () => {
		const worker = createTestWorker();

		await scenario(worker)
			.continuationSession()
			.withUserComment("Could you run /tdd on this later?")
			.build();

		expect(
			recorder.sink.findAll({ event: CYRUS_EVENTS.skillSlashInvoked }),
		).toEqual([]);
	});
});
