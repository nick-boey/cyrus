import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretStore } from "../src/SecretStore.js";

describe("SecretStore", () => {
	const freshPath = () =>
		join(mkdtempSync(join(tmpdir(), "secrets-")), "user-secrets.json");

	it("returns empty bundle for unknown user / missing file", () => {
		expect(new SecretStore(freshPath()).get("a@example.com")).toEqual({});
	});

	it("sets, persists, and case-insensitively reads values with 0600 perms", () => {
		const path = freshPath();
		const store = new SecretStore(path);
		store.set("A@Example.com", "claudeOauthToken", "tok-1");
		expect(new SecretStore(path).get("a@example.com").claudeOauthToken).toBe(
			"tok-1",
		);
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	it("deletes a key when set to undefined", () => {
		const path = freshPath();
		const store = new SecretStore(path);
		store.set("a@example.com", "githubPat", "pat");
		store.set("a@example.com", "githubPat", undefined);
		expect(store.get("a@example.com")).toEqual({});
	});

	it("refuses to overwrite a corrupt secrets file instead of wiping it", () => {
		const path = freshPath();
		const corruptContents = "{ not valid json ][";
		writeFileSync(path, corruptContents, { mode: 0o600 });

		const store = new SecretStore(path);
		expect(() =>
			store.set("a@example.com", "claudeOauthToken", "tok-1"),
		).toThrow();

		// The original (corrupt) bytes must still be on disk — not wiped to {}.
		expect(readFileSync(path, "utf-8")).toBe(corruptContents);
	});

	it("preserves other users' secrets when the file is valid JSON", () => {
		const path = freshPath();
		const store = new SecretStore(path);
		store.set("existing@example.com", "githubPat", "existing-pat");

		store.set("a@example.com", "claudeOauthToken", "tok-1");

		expect(store.get("existing@example.com").githubPat).toBe("existing-pat");
		expect(store.get("a@example.com").claudeOauthToken).toBe("tok-1");
	});

	it("forces 0600 on the final file even if a leftover .tmp file had looser perms", () => {
		const path = freshPath();
		const tmpPath = `${path}.tmp`;
		writeFileSync(tmpPath, "leftover", { mode: 0o644 });
		expect(statSync(tmpPath).mode & 0o777).toBe(0o644);

		const store = new SecretStore(path);
		store.set("a@example.com", "claudeOauthToken", "tok-1");

		expect(statSync(path).mode & 0o777).toBe(0o600);
	});
});
