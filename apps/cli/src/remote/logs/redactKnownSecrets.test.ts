import { describe, expect, it } from "vitest";
import { REDACTED } from "../errors.js";
import {
	collectKnownSecretValues,
	isSecretKey,
	KNOWN_SECRET_ENV_KEYS,
	redactKnownSecrets,
	redactText,
} from "./redactKnownSecrets.js";

describe("isSecretKey", () => {
	it.each([
		"token",
		"access_token",
		"refresh-token",
		"secret",
		"client_secret",
		"password",
		"passwd",
		"api_key",
		"apikey",
		"authorization",
		"private_key",
		"cyrus.shared_key",
		"connection_string",
	])("treats %s as naming a credential", (key) => {
		expect(isSecretKey(key)).toBe(true);
	});

	it.each([
		// The exceptions exist because these are real attributes an operator reads,
		// and redacting them would replace the numbers with `[redacted]` on every
		// agent-run record.
		"cyrus.token_count",
		"input_tokens",
		"output_tokens",
		"cache_read_input_tokens",
		"credential_source",
		"secret_backend",
		// Not credential-shaped at all.
		"issue_key",
		"cyrus.run_id",
		"message",
	])("leaves %s alone", (key) => {
		expect(isSecretKey(key)).toBe(false);
	});
});

describe("collectKnownSecretValues", () => {
	it("reads the values of the environment variables that hold credentials", () => {
		const values = collectKnownSecretValues({
			ANTHROPIC_API_KEY: "sk-ant-notarealkey-abcdef123456",
			GITHUB_TOKEN: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			PATH: "/usr/bin",
		});

		expect(values).toContain("sk-ant-notarealkey-abcdef123456");
		expect(values).toContain("ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
		expect(values).not.toContain("/usr/bin");
	});

	it("ignores a short value, which would redact half the output while protecting nothing", () => {
		// A variable set to `1` or `true` would otherwise turn every record
		// containing that substring into `[redacted]` — and only on the hosts that
		// happened to set it, so it would look like a backend fault.
		expect(collectKnownSecretValues({ GITHUB_TOKEN: "1" })).toEqual([]);
		expect(collectKnownSecretValues({ GITHUB_TOKEN: "short" })).toEqual([]);
	});

	it("orders longest first, so a secret containing another is replaced whole", () => {
		const values = collectKnownSecretValues({
			GITHUB_TOKEN: "aaaaaaaaaaaaaaaa",
			GH_TOKEN: "aaaaaaaaaaaaaaaaEXTRA",
		});

		expect(values[0]).toBe("aaaaaaaaaaaaaaaaEXTRA");
	});

	it("names the environment variables it reads", () => {
		// Asserted so that adding a credential to the fleet without adding it here
		// is a visible omission rather than a silent one.
		expect(KNOWN_SECRET_ENV_KEYS).toContain("ANTHROPIC_API_KEY");
		expect(KNOWN_SECRET_ENV_KEYS).toContain("CYRUS_OPERATOR_TOKEN");
		expect(KNOWN_SECRET_ENV_KEYS).toContain("LINEAR_OAUTH_CLIENT_SECRET");
	});
});

describe("redactText", () => {
	it("removes a known secret value that nothing about its shape would reveal", () => {
		// This is the case shape-matching cannot reach: an ordinary-looking string
		// logged as a bare argument, which is exactly how credentials escape.
		const result = redactText("cloning with ghp_looksLikeAnId12345", [
			"ghp_looksLikeAnId12345",
		]);

		expect(result.value).toBe(`cloning with ${REDACTED}`);
		expect(result.redacted).toBe(true);
	});

	it("removes every occurrence, not just the first", () => {
		const result = redactText("a SECRETVALUE12345 b SECRETVALUE12345", [
			"SECRETVALUE12345",
		]);

		expect(result.value).toBe(`a ${REDACTED} b ${REDACTED}`);
	});

	it("still removes credential shapes when no known values are supplied", () => {
		const result = redactText(
			"Authorization: Bearer abc.def.ghi and cyop_deadbeefdeadbeef",
		);

		expect(result.value).not.toContain("abc.def.ghi");
		expect(result.value).not.toContain("cyop_deadbeefdeadbeef");
		expect(result.redacted).toBe(true);
	});

	it("reports untouched text as unredacted, so a record does not claim a change it did not make", () => {
		const result = redactText("routed NOR-402 to device 7");

		expect(result.value).toBe("routed NOR-402 to device 7");
		expect(result.redacted).toBe(false);
	});
});

describe("redactKnownSecrets", () => {
	it("blanks a value under a credential-named key whatever it looks like", () => {
		const result = redactKnownSecrets({
			message: "authenticating",
			attributes: {
				"cyrus.token": "aaaa1111",
				"cyrus.run_id": "run-1",
			},
		});

		expect(result.value.attributes).toEqual({
			"cyrus.token": REDACTED,
			"cyrus.run_id": "run-1",
		});
		expect(result.redacted).toBe(true);
	});

	it("keeps the key, so a reader can see a credential field was present", () => {
		// Dropping it would make a redacted record indistinguishable from one that
		// never carried the field.
		const result = redactKnownSecrets({
			message: "x",
			attributes: { password: "hunter2hunter2" },
		});

		expect(Object.keys(result.value.attributes ?? {})).toEqual(["password"]);
	});

	it("redacts a known secret appearing in the message", () => {
		const result = redactKnownSecrets(
			{ message: "starting with key sk-ant-abcdef123456" },
			["sk-ant-abcdef123456"],
		);

		expect(result.value.message).toBe(`starting with key ${REDACTED}`);
		expect(result.redacted).toBe(true);
	});

	it("redacts a known secret appearing in an ordinary attribute value", () => {
		const result = redactKnownSecrets(
			{
				message: "x",
				attributes: { "cyrus.args": '["--token","sk-ant-abcdef123456"]' },
			},
			["sk-ant-abcdef123456"],
		);

		expect(result.value.attributes?.["cyrus.args"]).toBe(
			`["--token","${REDACTED}"]`,
		);
		expect(result.redacted).toBe(true);
	});

	it("reports a clean record as unredacted", () => {
		const result = redactKnownSecrets({
			message: "routed NOR-402",
			attributes: { "cyrus.run_id": "run-1", "cyrus.token_count": "1234" },
		});

		expect(result.redacted).toBe(false);
		expect(result.value.attributes).toEqual({
			"cyrus.run_id": "run-1",
			"cyrus.token_count": "1234",
		});
	});

	it("does not invent an attribute bag for a record that had none", () => {
		const result = redactKnownSecrets({ message: "hello" });

		expect(result.value.attributes).toBeUndefined();
	});
});
