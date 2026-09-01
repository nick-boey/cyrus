import type { ILogger } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import type { DevcontainerBuildRequest } from "../src/devcontainer/AcrDevcontainerBuilder.js";
import {
	AcrDevcontainerBuilder,
	type ArmRequestFn,
	buildLogTail,
	buildScript,
	composeDevcontainer,
	finalizeDockerfile,
} from "../src/devcontainer/AcrDevcontainerBuilder.js";

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
} as unknown as ILogger;

const WORKER = "ghcr.io/cyrusagents/features/cyrus-worker:0.1.0";

function request(
	overrides: Partial<DevcontainerBuildRequest> = {},
): DevcontainerBuildRequest {
	return {
		repositoryName: "api",
		githubSlug: "acme/api",
		ref: "main",
		file: {
			path: ".devcontainer/devcontainer.json",
			raw: "{}",
			config: { image: "node:22-slim" },
		},
		tag: "cafe",
		workerFeatureRef: WORKER,
		workerFeatureOptions: { tarball: "https://example/worker.tgz" },
		workerUser: "cyrus",
		...overrides,
	};
}

describe("composeDevcontainer", () => {
	it("puts the worker feature FIRST in overrideFeatureInstallOrder", () => {
		// Load-bearing, not cosmetic: rust/node/github-cli all resolve
		// `_REMOTE_USER` and silently fall back to USERNAME=root when `id -u`
		// fails, so a toolchain feature running before the one that creates the
		// worker user produces a root-owned CARGO_HOME — every `cargo build`
		// failing at runtime in an image that built without a warning.
		const composed = composeDevcontainer(
			{
				image: "node:22-slim",
				features: { "ghcr.io/devcontainers/features/rust:1": {} },
				overrideFeatureInstallOrder: ["ghcr.io/devcontainers/features/rust:1"],
			},
			request(),
		);
		expect(composed.overrideFeatureInstallOrder).toEqual([
			WORKER,
			"ghcr.io/devcontainers/features/rust:1",
		]);
	});

	it("keeps the worker first even when the repository already names it", () => {
		const composed = composeDevcontainer(
			{ image: "node:22-slim", overrideFeatureInstallOrder: [WORKER, "b"] },
			request(),
		);
		expect(composed.overrideFeatureInstallOrder).toEqual([WORKER, "b"]);
	});

	it("lets the repository's own feature options win on a collision", () => {
		const composed = composeDevcontainer(
			{ image: "node:22-slim", features: { [WORKER]: { tarball: "theirs" } } },
			request(),
		);
		expect(composed.features?.[WORKER]).toEqual({ tarball: "theirs" });
	});

	it("sets containerUser/remoteUser so features resolve _REMOTE_USER", () => {
		const composed = composeDevcontainer({ image: "x" }, request());
		expect(composed.containerUser).toBe("cyrus");
		expect(composed.remoteUser).toBe("cyrus");
	});
});

describe("finalizeDockerfile", () => {
	it("applies the two instructions the devcontainer CLI cannot emit", () => {
		const df = finalizeDockerfile("cyrus");
		expect(df).toMatch(/^USER cyrus$/m);
		expect(df).toMatch(/^ENTRYPOINT \["\/entrypoint\.sh"\]$/m);
	});

	it("fails the BUILD when the worker feature did not run", () => {
		// Without this the image builds happily and dies in ACA as a sandbox
		// stuck Running with no worker attached — the hardest symptom to trace.
		const df = finalizeDockerfile("cyrus");
		expect(df).toContain("-x /entrypoint.sh");
		expect(df).toContain('id -u "cyrus"');
	});
});

describe("buildScript", () => {
	const script = buildScript({
		slug: "acme/api",
		ref: "main",
		configPath: ".devcontainer/devcontainer.json",
		image: "acr.azurecr.io/cyrus/devcontainers:cafe",
		cliVersion: "0.89.0",
	});

	it("exports DOCKER_BUILDKIT=0 rather than relying on --buildkit never", () => {
		// Verified on Docker 29.7.2: `devcontainer build --buildkit never` still
		// went through BuildKit and attached provenance/SBOM attestations,
		// producing an OCI image INDEX the ACA disk importer cannot consume.
		// The CLI's flag only picks which flags IT passes; the environment
		// variable is what actually selects the classic builder.
		expect(script).toMatch(/^export DOCKER_BUILDKIT=0$/m);
		expect(script).toMatch(/^export BUILDX_NO_DEFAULT_ATTESTATIONS=1$/m);
		expect(script).toContain("--buildkit never");
	});

	it("fails the BUILD when the pushed manifest is an image index", () => {
		// Every flag above is a property of the daemon, not of anything we can
		// pass — so the shape is asserted where the run id and the log are,
		// rather than at a disk import hours later.
		expect(script).toContain("docker manifest inspect");
		expect(script).toMatch(/\*index\*/);
	});

	it("writes the composed config to the path the file was found at", () => {
		// Every relative path inside it — build.dockerfile, build.context, a
		// local feature folder — resolves against that location.
		expect(script).toContain('> ".devcontainer/devcontainer.json"');
	});

	it("never puts the GitHub token in the remote URL", () => {
		// A URL-embedded credential lands in the remote's config, in
		// `git remote -v`, and in any error text the build prints.
		expect(script).toContain("http.https://github.com/.extraheader");
		expect(script).not.toMatch(/https:\/\/[^\s]*\$GH_TOKEN@/);
	});
});

describe("buildLogTail", () => {
	it("returns a short log unchanged", () => {
		expect(buildLogTail("boom")).toBe("boom");
	});

	it("bounds a long log and keeps the END, where the failure is", () => {
		const tail = buildLogTail(`${"x".repeat(5000)}THE ERROR`, 100);
		expect(tail).toContain("THE ERROR");
		expect(tail.length).toBeLessThan(200);
	});
});

describe("AcrDevcontainerBuilder.build", () => {
	function arm(script: Array<{ status: number; json: unknown }>): {
		fn: ArmRequestFn;
		calls: Array<{ method: string; url: string; body?: unknown }>;
	} {
		const calls: Array<{ method: string; url: string; body?: unknown }> = [];
		let i = 0;
		const fn: ArmRequestFn = async (method, url, body) => {
			calls.push({ method, url, body });
			const next = script[Math.min(i++, script.length - 1)] ?? {
				status: 200,
				json: null,
			};
			return { ...next, text: JSON.stringify(next.json) };
		};
		return { fn, calls };
	}

	const cfg = {
		subscriptionId: "sub",
		resourceGroup: "rg",
		registry: "cyrusacr",
		loginServer: "cyrusacr.azurecr.io",
	};

	it("returns the pushed image on a Succeeded run", async () => {
		const { fn, calls } = arm([
			{ status: 200, json: { name: "ca1" } },
			{ status: 200, json: { properties: { status: "Succeeded" } } },
		]);
		const builder = new AcrDevcontainerBuilder(cfg, fn, logger, async () => {});
		const result = await builder.build(request(), "gh-token");
		expect(result).toEqual({
			runId: "ca1",
			status: "Succeeded",
			image: "cyrusacr.azurecr.io/cyrus/devcontainers:cafe",
		});
		expect(calls[0]?.url).toContain("/scheduleRun");
	});

	it("marks the GitHub token secret in the run's values", async () => {
		const { fn, calls } = arm([
			{ status: 200, json: { name: "ca1" } },
			{ status: 200, json: { properties: { status: "Succeeded" } } },
		]);
		const builder = new AcrDevcontainerBuilder(cfg, fn, logger, async () => {});
		await builder.build(request(), "gh-token");
		const body = calls[0]?.body as
			| { values: Array<Record<string, unknown>> }
			| undefined;
		const values = body?.values ?? [];
		expect(values.find((v) => v.name === "ghToken")).toMatchObject({
			isSecret: true,
		});
	});

	it("always reports the run id on a failure — that is what an operator chases", async () => {
		const { fn } = arm([
			{ status: 200, json: { name: "ca9" } },
			{ status: 200, json: { properties: { status: "Failed" } } },
			{ status: 200, json: {} },
		]);
		const builder = new AcrDevcontainerBuilder(cfg, fn, logger, async () => {});
		const result = await builder.build(request(), "gh-token");
		expect(result.runId).toBe("ca9");
		expect(result.status).toBe("Failed");
		expect(result.image).toBeUndefined();
	});

	it("throws when ARM refuses to schedule the run at all", async () => {
		const { fn } = arm([{ status: 403, json: { error: "denied" } }]);
		const builder = new AcrDevcontainerBuilder(cfg, fn, logger, async () => {});
		await expect(builder.build(request(), "t")).rejects.toThrow(/HTTP 403/);
	});
});
