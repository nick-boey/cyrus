import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { SkillInstaller } from "./SkillInstaller.js";

function tar(
	entries: Array<{
		name: string;
		body?: string;
		type?: "0" | "2";
		link?: string;
	}>,
): Uint8Array {
	const parts: Buffer[] = [];
	for (const entry of entries) {
		const body = Buffer.from(entry.body ?? "");
		const h = Buffer.alloc(512);
		h.write(entry.name, 0, 100);
		h.write("0000644\0", 100);
		h.write("0000000\0", 108);
		h.write("0000000\0", 116);
		h.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124);
		h.write("00000000000\0", 136);
		h.fill(32, 148, 156);
		h[156] = (entry.type ?? "0").charCodeAt(0);
		if (entry.link) h.write(entry.link, 157, 100);
		h.write(
			`${h
				.reduce((a, b) => a + b, 0)
				.toString(8)
				.padStart(6, "0")}\0 `,
			148,
			8,
		);
		parts.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512));
	}
	return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]), { mtime: 0 });
}

function fixture(archive: Uint8Array, overrideChecksum?: string) {
	const digest = createHash("sha256").update(archive).digest("hex");
	const release = {
		name: "cyrus-fleet-operator",
		version: "0.2.70",
		archiveUrl:
			"https://github.com/cyrusagents/cyrus/releases/download/v0.2.70/cyrus-fleet-operator-0.2.70.tar.gz",
		checksumUrl:
			"https://github.com/cyrusagents/cyrus/releases/download/v0.2.70/cyrus-fleet-operator-0.2.70.tar.gz.sha256",
		expectedChecksum: `sha256:${overrideChecksum ?? digest}`,
	} as const;
	const fetchFn = vi.fn(
		async (url: string | URL) =>
			new Response(
				String(url).endsWith(".sha256") ? `${digest}  skill.tar.gz\n` : archive,
			),
	);
	return { release, fetchFn, digest };
}

describe("SkillInstaller", () => {
	it("verifies and atomically installs, then idempotently replaces", async () => {
		const home = mkdtempSync(join(tmpdir(), "skill-home-"));
		const data = tar([
			{ name: "cyrus-fleet-operator/SKILL.md", body: "trusted" },
		]);
		const { release, fetchFn } = fixture(data);
		const installer = new SkillInstaller({
			homeDir: home,
			fetchFn: fetchFn as never,
		});
		const target = await installer.install(release, "codex");
		await installer.install(release, "codex");
		expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("trusted");
		const { readdirSync } = await import("node:fs");
		expect(
			readdirSync(
				join(home, ".codex", "skills", ".cyrus-trusted", release.name),
			),
		).toHaveLength(1);
		expect(fetchFn).toHaveBeenCalledWith(release.archiveUrl, {
			redirect: "manual",
		});
	});

	it("rejects checksum mismatch", async () => {
		const data = tar([
			{ name: "cyrus-fleet-operator/SKILL.md", body: "trusted" },
		]);
		const { release, fetchFn } = fixture(data, "0".repeat(64));
		await expect(
			new SkillInstaller({
				homeDir: tmpdir(),
				fetchFn: fetchFn as never,
			}).install(release, "claude"),
		).rejects.toThrow(/official Cyrus release checksum/);
	});

	it.each([
		[tar([{ name: "../escape", body: "bad" }]), /unsafe path/],
		[
			tar([
				{
					name: "cyrus-fleet-operator/SKILL.md",
					type: "2",
					link: "../../escape",
				},
			]),
			/contains a link/,
		],
		[new Uint8Array([1, 2, 3]), /truncated|gzip/],
	])("rejects unsafe or truncated archives", async (data, message) => {
		const { release, fetchFn } = fixture(data);
		await expect(
			new SkillInstaller({
				homeDir: mkdtempSync(join(tmpdir(), "skill-home-")),
				fetchFn: fetchFn as never,
			}).install(release, "claude"),
		).rejects.toThrow(message);
	});

	it("rejects redirects", async () => {
		const data = tar([
			{ name: "cyrus-fleet-operator/SKILL.md", body: "trusted" },
		]);
		const { release } = fixture(data);
		const fetchFn = vi.fn(
			async () =>
				new Response("", {
					status: 302,
					headers: { location: "https://evil.example" },
				}),
		);
		await expect(
			new SkillInstaller({ fetchFn: fetchFn as never }).install(
				release,
				"claude",
			),
		).rejects.toThrow(/redirected/);
	});

	it("accepts GitHub's single release-asset redirect", async () => {
		const home = mkdtempSync(join(tmpdir(), "skill-home-"));
		const data = tar([
			{ name: "cyrus-fleet-operator/SKILL.md", body: "trusted" },
		]);
		const { release, digest } = fixture(data);
		const fetchFn = vi.fn(async (url: string | URL) => {
			if (String(url).startsWith("https://github.com"))
				return new Response("", {
					status: 302,
					headers: {
						location: `https://release-assets.githubusercontent.com/${String(url).endsWith(".sha256") ? "checksum" : "archive"}`,
					},
				});
			return new Response(
				String(url).endsWith("checksum") ? `${digest}\n` : data,
			);
		});
		await expect(
			new SkillInstaller({ homeDir: home, fetchFn: fetchFn as never }).install(
				release,
				"claude",
			),
		).resolves.toContain("cyrus-fleet-operator");
	});

	it("leaves an existing install intact when interrupted before commit", async () => {
		const home = mkdtempSync(join(tmpdir(), "skill-home-"));
		const destination = join(home, ".claude", "skills", "cyrus-fleet-operator");
		const { mkdirSync } = await import("node:fs");
		mkdirSync(destination, { recursive: true });
		writeFileSync(join(destination, "SKILL.md"), "old");
		const data = tar([{ name: "cyrus-fleet-operator/SKILL.md", body: "new" }]);
		const { release, fetchFn } = fixture(data);
		await expect(
			new SkillInstaller({
				homeDir: home,
				fetchFn: fetchFn as never,
				beforeCommit: () => {
					throw new Error("interrupt");
				},
			}).install(release, "claude"),
		).rejects.toThrow("interrupt");
		expect(readFileSync(join(destination, "SKILL.md"), "utf8")).toBe("old");
		expect(existsSync(destination)).toBe(true);
	});

	it("keeps the prior pointer live when interrupted before atomic publication", async () => {
		const home = mkdtempSync(join(tmpdir(), "skill-home-"));
		const oldData = tar([
			{ name: "cyrus-fleet-operator/SKILL.md", body: "old" },
		]);
		const oldFixture = fixture(oldData);
		const destination = await new SkillInstaller({
			homeDir: home,
			fetchFn: oldFixture.fetchFn as never,
		}).install(oldFixture.release, "claude");
		const newData = tar([
			{ name: "cyrus-fleet-operator/SKILL.md", body: "new" },
		]);
		const next = fixture(newData);
		await expect(
			new SkillInstaller({
				homeDir: home,
				fetchFn: next.fetchFn as never,
				beforePublish: () => {
					throw new Error("interrupt-before-publish");
				},
			}).install(next.release, "claude"),
		).rejects.toThrow("interrupt-before-publish");
		expect(readFileSync(join(destination, "SKILL.md"), "utf8")).toBe("old");
	});

	it("rejects a missing home instead of installing under cwd", async () => {
		const data = tar([{ name: "cyrus-fleet-operator/SKILL.md", body: "new" }]);
		const { release, fetchFn } = fixture(data);
		await expect(
			new SkillInstaller({
				homeDir: "",
				fetchFn: fetchFn as never,
			}).install(release, "claude"),
		).rejects.toThrow("Cannot determine the home directory");
		expect(fetchFn).not.toHaveBeenCalled();
	});
});
