import { describe, expect, it } from "vitest";
import {
	DEVCONTAINER_PATHS,
	devcontainerCacheKey,
	diskNameFor,
	fetchDevcontainer,
	ignoredFieldsIn,
	parseJsonc,
	validateDevcontainer,
} from "../src/devcontainer/config.js";

const KEY = {
	repositoryName: "cyrus-api",
	raw: '{"image":"node:22"}',
	path: ".devcontainer/devcontainer.json",
	workerFeatureVersion: "0.1.0",
	workerPayload: "https://example/worker.tgz",
};

describe("parseJsonc", () => {
	it("strips line and block comments", () => {
		expect(
			parseJsonc(`{
				// a line comment
				"image": "node:22", /* and a block one */
				"name": "x"
			}`),
		).toEqual({ image: "node:22", name: "x" });
	});

	it("allows trailing commas in objects and arrays", () => {
		expect(parseJsonc('{"a":[1,2,],"b":1,}')).toEqual({ a: [1, 2], b: 1 });
	});

	it("does NOT treat a // inside a string literal as a comment", () => {
		// The whole reason this parser tracks string state: every devcontainer
		// with an `image` or a feature id contains `//` inside a string.
		expect(
			parseJsonc('{"features":{"ghcr.io/devcontainers/features/rust:1":{}}}'),
		).toEqual({ features: { "ghcr.io/devcontainers/features/rust:1": {} } });
		expect(parseJsonc('{"a":"https://example.com/x"}')).toEqual({
			a: "https://example.com/x",
		});
	});

	it("does not end a string early on an escaped quote", () => {
		expect(parseJsonc('{"a":"say \\"hi\\" // not a comment"}')).toEqual({
			a: 'say "hi" // not a comment',
		});
	});
});

describe("validateDevcontainer", () => {
	it("rejects dockerComposeFile with a message naming the reason", () => {
		const rejection = validateDevcontainer({
			dockerComposeFile: "docker-compose.yml",
		});
		expect(rejection?.reason).toMatch(/dockerComposeFile/);
		expect(rejection?.reason).toMatch(/several containers/);
	});

	it("rejects a config with neither image nor build", () => {
		expect(validateDevcontainer({ name: "x" })?.reason).toMatch(/neither/);
	});

	it("rejects a config declaring both", () => {
		expect(
			validateDevcontainer({
				image: "node:22",
				build: { dockerfile: "Dockerfile" },
			})?.reason,
		).toMatch(/both/);
	});

	it("accepts image, build.dockerfile, and the legacy dockerFile", () => {
		expect(validateDevcontainer({ image: "node:22" })).toBeUndefined();
		expect(
			validateDevcontainer({ build: { dockerfile: "Dockerfile" } }),
		).toBeUndefined();
		expect(validateDevcontainer({ dockerFile: "Dockerfile" })).toBeUndefined();
	});
});

describe("ignoredFieldsIn", () => {
	it("names the fields an author may expect to work that do not", () => {
		expect(
			ignoredFieldsIn({
				image: "node:22",
				mounts: [],
				postStartCommand: "echo",
			}),
		).toEqual(["mounts", "postStartCommand"]);
	});
});

describe("devcontainerCacheKey", () => {
	it("is stable for identical inputs", () => {
		expect(devcontainerCacheKey(KEY)).toBe(devcontainerCacheKey(KEY));
	});

	it("changes when the worker feature version moves", () => {
		// The worker rides on top of every repository image, so bumping it must
		// invalidate every cached build — otherwise a deployment keeps booting
		// repositories on a worker it has since replaced.
		expect(
			devcontainerCacheKey({ ...KEY, workerFeatureVersion: "0.2.0" }),
		).not.toBe(devcontainerCacheKey(KEY));
	});

	it("changes when the same bytes move to the other well-known path", () => {
		expect(
			devcontainerCacheKey({ ...KEY, path: ".devcontainer.json" }),
		).not.toBe(devcontainerCacheKey(KEY));
	});

	it("cannot be collided by shifting a boundary between fields", () => {
		// The length-prefixed join is what makes this true: with a delimiter,
		// (repo "a", path "b:c") and (repo "a:b", path "c") would hash the same.
		expect(
			devcontainerCacheKey({ ...KEY, repositoryName: "a", path: "bc" }),
		).not.toBe(
			devcontainerCacheKey({ ...KEY, repositoryName: "ab", path: "c" }),
		);
	});
});

describe("diskNameFor", () => {
	it("stays inside the 63-character label budget for a maximal repo name", () => {
		// REPOSITORY_NAME_RE permits 64 characters; the `cyrus.disk` label value
		// is capped at 63. The name is therefore a derived digest, not a
		// readable composition.
		const name = diskNameFor("r".repeat(64), "a".repeat(64));
		expect(name.length).toBeLessThanOrEqual(63);
	});

	it("distinguishes two repositories with identical devcontainer files", () => {
		expect(diskNameFor("api", "abc")).not.toBe(diskNameFor("web", "abc"));
	});
});

describe("fetchDevcontainer", () => {
	function fetchReturning(byPath: Record<string, string>) {
		const seen: string[] = [];
		const fetchFn = (async (url: string) => {
			seen.push(url);
			const path = DEVCONTAINER_PATHS.find((p) =>
				url.includes(`contents/${p}?`),
			);
			const body = path ? byPath[path] : undefined;
			return body === undefined
				? { status: 404, ok: false, text: async () => "" }
				: { status: 200, ok: true, text: async () => body };
		}) as unknown as typeof fetch;
		return { fetchFn, seen };
	}

	it("follows the spec's precedence: .devcontainer/ first", async () => {
		const { fetchFn } = fetchReturning({
			".devcontainer/devcontainer.json": '{"image":"a"}',
			".devcontainer.json": '{"image":"b"}',
		});
		const file = await fetchDevcontainer("acme/api", "main", {
			token: "t",
			fetchFn,
		});
		expect(file?.path).toBe(".devcontainer/devcontainer.json");
		expect(file?.config.image).toBe("a");
	});

	it("falls back to the root file, and stops looking after that", async () => {
		const { fetchFn, seen } = fetchReturning({
			".devcontainer.json": '{"image":"b"}',
		});
		const file = await fetchDevcontainer("acme/api", "main", {
			token: "t",
			fetchFn,
		});
		expect(file?.path).toBe(".devcontainer.json");
		expect(seen).toHaveLength(2);
	});

	it("returns undefined — the common case — when neither file exists", async () => {
		const { fetchFn } = fetchReturning({});
		await expect(
			fetchDevcontainer("acme/api", "main", { token: "t", fetchFn }),
		).resolves.toBeUndefined();
	});

	it("throws with the repo, ref and path when the file is not valid JSON", async () => {
		const { fetchFn } = fetchReturning({
			".devcontainer/devcontainer.json": "{not json",
		});
		await expect(
			fetchDevcontainer("acme/api", "main", { token: "t", fetchFn }),
		).rejects.toThrow(/acme\/api@main:\.devcontainer\/devcontainer\.json/);
	});
});
