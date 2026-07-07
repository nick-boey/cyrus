import { describe, expect, it } from "vitest";
import {
	EdgeConfigSchema,
	GitCommitAuthorConfigSchema,
	UserCredentialConfigSchema,
} from "../src/config-schemas.js";

describe("UserCredentialConfigSchema", () => {
	it("accepts an email-keyed user with a credentials dir", () => {
		const parsed = UserCredentialConfigSchema.parse({
			linearUser: { email: "alice@org.com" },
			credentialsDir: "~/.cyrus/users/alice",
			gitAuthor: { name: "Alice Example", email: "alice@org.com" },
		});
		expect(parsed.credentialsDir).toBe("~/.cyrus/users/alice");
	});

	it("accepts an id-keyed user without gitAuthor", () => {
		const parsed = UserCredentialConfigSchema.parse({
			linearUser: { id: "usr_abc123" },
			credentialsDir: "/home/x/.cyrus/users/bob",
		});
		expect(parsed.gitAuthor).toBeUndefined();
	});

	it("rejects a user without credentialsDir", () => {
		expect(() =>
			UserCredentialConfigSchema.parse({ linearUser: { email: "a@b.c" } }),
		).toThrow();
	});
});

describe("GitCommitAuthorConfigSchema", () => {
	it("accepts user mode without a shared author", () => {
		expect(GitCommitAuthorConfigSchema.parse({ mode: "user" }).mode).toBe(
			"user",
		);
	});

	it("accepts shared mode with a shared author", () => {
		const parsed = GitCommitAuthorConfigSchema.parse({
			mode: "shared",
			shared: { name: "Cyrus Agent", email: "cyrus@org.com" },
		});
		expect(parsed.shared?.name).toBe("Cyrus Agent");
	});

	it("rejects unknown modes", () => {
		expect(() => GitCommitAuthorConfigSchema.parse({ mode: "bot" })).toThrow();
	});
});

describe("EdgeConfigSchema users fields", () => {
	it("round-trips users and gitCommitAuthor", () => {
		const parsed = EdgeConfigSchema.parse({
			repositories: [],
			users: [
				{
					linearUser: { email: "alice@org.com" },
					credentialsDir: "~/.cyrus/users/alice",
				},
			],
			gitCommitAuthor: { mode: "user" },
		});
		expect(parsed.users).toHaveLength(1);
		expect(parsed.gitCommitAuthor?.mode).toBe("user");
	});

	it("keeps both fields optional", () => {
		const parsed = EdgeConfigSchema.parse({ repositories: [] });
		expect(parsed.users).toBeUndefined();
		expect(parsed.gitCommitAuthor).toBeUndefined();
	});
});
