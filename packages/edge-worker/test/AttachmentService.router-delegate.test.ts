import { mkdir, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILogger, Issue } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import { AttachmentService } from "../src/AttachmentService.js";

/**
 * Task 12 / Codex finding 9 — in router mode the device holds NO Linear token,
 * so the two early-return token guards (issue-description path and
 * prompted-comment path) must yield to the download delegate. These tests
 * exercise BOTH paths with the delegate set and no token present.
 */

function makeLogger(): ILogger {
	const logger: ILogger = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		event: vi.fn(),
		withContext: () => logger,
		getLevel: () => 0,
		setLevel: () => {},
	};
	return logger;
}

describe("AttachmentService router download delegate", () => {
	it("downloads issue-description attachments via the delegate with NO Linear token", async () => {
		const cyrusHome = await mkdtemp(join(tmpdir(), "cyrus-att-issue-"));
		const delegate = vi.fn(async () => ({
			base64: Buffer.from("fake-image-bytes").toString("base64"),
			contentType: "image/png",
		}));
		// Empty linearWorkspaces => getLinearTokenForWorkspace returns null.
		const service = new AttachmentService(
			makeLogger(),
			cyrusHome,
			{},
			delegate,
		);

		const issue = {
			id: "issue-1",
			identifier: "ABC-1",
			description:
				"See screenshot https://uploads.linear.app/a/b/screenshot.png for details",
		} as unknown as Issue;

		const result = await service.downloadIssueAttachments(
			issue,
			"ws-1",
			join(tmpdir(), "workspace-ABC-1"),
		);

		expect(delegate).toHaveBeenCalledWith(
			"https://uploads.linear.app/a/b/screenshot.png",
		);
		expect(result.attachmentsDir).not.toBeNull();
		expect(result.manifest).toContain("Downloaded Attachments");
		const files = await readdir(result.attachmentsDir as string);
		expect(files.some((f) => f.startsWith("image_"))).toBe(true);
	});

	it("downloads prompted-comment attachments via the delegate with NO Linear token", async () => {
		const cyrusHome = await mkdtemp(join(tmpdir(), "cyrus-att-comment-"));
		const attachmentsDir = join(cyrusHome, "attachments");
		await mkdir(attachmentsDir, { recursive: true });
		const delegate = vi.fn(async () => ({
			base64: Buffer.from("fake-pdf-bytes").toString("base64"),
			contentType: "application/pdf",
		}));
		const service = new AttachmentService(
			makeLogger(),
			cyrusHome,
			{},
			delegate,
		);

		const result = await service.downloadCommentAttachments(
			"Here is the doc https://uploads.linear.app/x/y/report.pdf",
			attachmentsDir,
			null, // NO token — the delegate must still be reached
			0,
		);

		expect(delegate).toHaveBeenCalledWith(
			"https://uploads.linear.app/x/y/report.pdf",
		);
		expect(result.totalNewAttachments).toBe(1);
		expect(result.failedCount).toBe(0);
	});

	it("still skips downloads when neither a delegate nor a token is present", async () => {
		const cyrusHome = await mkdtemp(join(tmpdir(), "cyrus-att-none-"));
		const service = new AttachmentService(makeLogger(), cyrusHome, {});

		const issue = {
			id: "issue-2",
			identifier: "ABC-2",
			description: "https://uploads.linear.app/a/b/c.png",
		} as unknown as Issue;

		const result = await service.downloadIssueAttachments(
			issue,
			"ws-x",
			join(tmpdir(), "workspace-ABC-2"),
		);

		expect(result.attachmentsDir).toBeNull();
		expect(result.manifest).toBe("");
	});
});
