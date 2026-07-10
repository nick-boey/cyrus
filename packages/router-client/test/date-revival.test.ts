import { describe, expect, it } from "vitest";
import { reviveDates } from "../src/date-revival.js";

describe("reviveDates", () => {
	it("revives the date fields on a comment that crossed the wire as JSON", () => {
		// Exactly what LinearExecutor.fetchComment sends back: the SDK's Date
		// fields flattened to ISO strings by JSON.stringify.
		const overTheWire = JSON.parse(
			JSON.stringify({
				id: "c-1",
				body: "hello",
				createdAt: new Date("2026-07-10T04:25:41.345Z"),
				updatedAt: new Date("2026-07-10T04:26:00.000Z"),
			}),
		);
		expect(typeof overTheWire.createdAt).toBe("string");

		const revived = reviveDates(overTheWire);

		expect(revived.createdAt).toBeInstanceOf(Date);
		expect(revived.updatedAt).toBeInstanceOf(Date);
		// This is the exact call that used to throw:
		// "comment.createdAt.toISOString is not a function"
		expect(revived.createdAt.toISOString()).toBe("2026-07-10T04:25:41.345Z");
	});

	it("revives archivedAt and leaves a null date alone", () => {
		const revived = reviveDates({
			archivedAt: "2026-01-02T03:04:05Z",
			updatedAt: null,
		});

		expect(revived.archivedAt).toBeInstanceOf(Date);
		expect(revived.updatedAt).toBeNull();
	});

	it("recurses through nested objects and arrays (Connection<Comment>)", () => {
		const revived = reviveDates({
			nodes: [
				{ id: "c-1", createdAt: "2026-07-10T04:25:41.345Z" },
				{
					id: "c-2",
					createdAt: "2026-07-10T05:00:00.000Z",
					issue: { id: "i-1", updatedAt: "2026-07-10T06:00:00.000Z" },
				},
			],
		});

		expect(revived.nodes[0]?.createdAt).toBeInstanceOf(Date);
		expect(revived.nodes[1]?.createdAt).toBeInstanceOf(Date);
		expect(revived.nodes[1]?.issue.updatedAt).toBeInstanceOf(Date);
	});

	it("does NOT touch date-looking strings under other keys", () => {
		// An issue titled with a date must stay a string, which is why the
		// reviver keys on field name rather than on string shape.
		const revived = reviveDates({
			title: "2026-07-10T04:25:41.345Z",
			body: "2026-01-01",
			dueDate: "2026-07-10T04:25:41.345Z",
		});

		expect(revived.title).toBe("2026-07-10T04:25:41.345Z");
		expect(revived.body).toBe("2026-01-01");
		expect(revived.dueDate).toBe("2026-07-10T04:25:41.345Z");
	});

	it("leaves a malformed date string as-is rather than producing Invalid Date", () => {
		const revived = reviveDates({ createdAt: "not a date" });

		expect(revived.createdAt).toBe("not a date");
	});

	it("leaves an already-revived Date untouched (idempotent)", () => {
		const date = new Date("2026-07-10T04:25:41.345Z");
		const revived = reviveDates({ createdAt: date });

		expect(revived.createdAt).toBe(date);
	});

	it("passes through primitives, null, and the attachment payload shape", () => {
		expect(reviveDates(null)).toBeNull();
		expect(reviveDates("plain")).toBe("plain");
		expect(reviveDates(42)).toBe(42);

		// downloadAttachment's result: a long base64 string under a non-date key.
		const attachment = {
			base64: "AAAA2026-07-10T04:25:41.345Z",
			contentType: "image/png",
		};
		expect(reviveDates(attachment)).toEqual(attachment);
	});
});
