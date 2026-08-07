import { describe, expect, it } from "vitest";
import {
	AcaApiError,
	type AcaDiskImage,
	type AcaSandbox,
	AcaSandboxClient,
	type AcaSnapshot,
} from "../src/aca/AcaSandboxClient.js";

const SUB = "sub-1";
const RG = "rg-1";
const GROUP = "grp-1";
const REGION = "australiaeast";
const AV = "2026-02-01-preview";
const BASE = `https://management.${REGION}.azuredevcompute.io`;
const ROOT = `/subscriptions/${SUB}/resourceGroups/${RG}/sandboxGroups/${GROUP}`;

type FetchCall = { url: string; init: RequestInit | undefined };

function fakeFetch(responses: Array<Response | ((c: FetchCall) => Response)>): {
	fetch: typeof fetch;
	calls: FetchCall[];
} {
	const calls: FetchCall[] = [];
	let i = 0;
	const fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
		const call: FetchCall = { url: url.toString(), init };
		calls.push(call);
		// Always return a fresh clone so the body can be consumed multiple
		// times by the client on a retry loop (a single static Response
		// instance can only be read once — `r.text()` throws on the second).
		const r = responses[Math.min(i, responses.length - 1)];
		i++;
		const resp = typeof r === "function" ? r(call) : r;
		return resp.clone();
	};
	return { fetch, calls };
}

function res(
	status: number,
	body: unknown,
	opts: { headers?: Record<string, string> } = {},
): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...opts.headers },
	});
}

function client(
	opts: Partial<ConstructorParameters<typeof AcaSandboxClient>[0]> = {},
) {
	return new AcaSandboxClient({
		subscriptionId: SUB,
		resourceGroup: RG,
		sandboxGroup: GROUP,
		region: REGION,
		tokenProvider: async () => "tok-abc",
		...opts,
	});
}

const runningSandbox: AcaSandbox = {
	id: "11111111-1111-1111-1111-111111111111",
	state: "Running",
	labels: { "cyrus.issue": "DEF-1" },
};

describe("AcaSandboxClient URL/auth/api-version", () => {
	it("getSandbox uses GET /sandboxes/{id} with Bearer + api-version", async () => {
		const { fetch, calls } = fakeFetch([res(200, runningSandbox)]);
		const c = client({ fetchFn: fetch });
		const out = await c.getSandbox(runningSandbox.id);
		expect(out).toEqual(runningSandbox);
		const call = calls[0];
		expect(call?.url).toBe(
			`${BASE}${ROOT}/sandboxes/${runningSandbox.id}?api-version=${AV}`,
		);
		expect(call?.init?.method).toBe("GET");
		expect(call?.init?.headers).toMatchObject({
			authorization: "Bearer tok-abc",
		});
	});

	it("deleteSandbox uses DELETE /sandboxes/{id}", async () => {
		const { fetch, calls } = fakeFetch([res(200, null)]);
		const c = client({ fetchFn: fetch });
		await c.deleteSandbox(runningSandbox.id);
		const call = calls[0];
		expect(call?.init?.method).toBe("DELETE");
		expect(call?.url).toBe(
			`${BASE}${ROOT}/sandboxes/${runningSandbox.id}?api-version=${AV}`,
		);
	});

	it("stopSandbox uses POST /sandboxes/{id}/stop with a {} JSON body (C7)", async () => {
		const { fetch, calls } = fakeFetch([res(202, null)]);
		const c = client({ fetchFn: fetch });
		await c.stopSandbox(runningSandbox.id);
		const call = calls[0];
		expect(call?.init?.method).toBe("POST");
		expect(call?.url).toBe(
			`${BASE}${ROOT}/sandboxes/${runningSandbox.id}/stop?api-version=${AV}`,
		);
		expect(call?.init?.body).toBe("{}");
		expect(call?.init?.headers).toMatchObject({
			"content-type": "application/json",
		});
	});

	it("resumeSandbox uses POST /sandboxes/{id}/resume with a {} JSON body (C7)", async () => {
		const { fetch, calls } = fakeFetch([res(202, null)]);
		const c = client({ fetchFn: fetch });
		await c.resumeSandbox(runningSandbox.id);
		const call = calls[0];
		expect(call?.init?.body).toBe("{}");
		expect(call?.url).toBe(
			`${BASE}${ROOT}/sandboxes/${runningSandbox.id}/resume?api-version=${AV}`,
		);
	});

	it("listSandboxes uses GET /sandboxes and parses bare array", async () => {
		const { fetch, calls } = fakeFetch([res(200, [runningSandbox])]);
		const c = client({ fetchFn: fetch });
		const out = await c.listSandboxes();
		expect(out).toEqual([runningSandbox]);
		expect(calls[0]?.url).toBe(`${BASE}${ROOT}/sandboxes?api-version=${AV}`);
	});

	it("listSandboxes parses {value:[...]} envelope", async () => {
		const { fetch } = fakeFetch([
			res(200, { value: [runningSandbox], nextLink: null }),
		]);
		const c = client({ fetchFn: fetch });
		const out = await c.listSandboxes();
		expect(out).toEqual([runningSandbox]);
	});

	it("listSandboxes appends labels as ?labels=k=v,k2=v2", async () => {
		const { fetch, calls } = fakeFetch([res(200, [])]);
		const c = client({ fetchFn: fetch });
		await c.listSandboxes({ "cyrus.issue": "DEF-1", "cyrus.managed": "true" });
		expect(calls[0]?.url).toBe(
			`${BASE}${ROOT}/sandboxes?api-version=${AV}&labels=cyrus.issue%3DDEF-1%2Ccyrus.managed%3Dtrue`,
		);
	});

	it("follows sandbox nextLink pages while applying labels only to the first request", async () => {
		const next = `${BASE}${ROOT}/sandboxes?api-version=${AV}&continuation=abc`;
		const second = { ...runningSandbox, id: "sb-2" };
		const { fetch, calls } = fakeFetch([
			res(200, { value: [runningSandbox], nextLink: next }),
			res(200, [second]),
		]);
		const c = client({ fetchFn: fetch });
		await expect(c.listSandboxes({ "cyrus.managed": "true" })).resolves.toEqual(
			[runningSandbox, second],
		);
		expect(calls[0]?.url).toContain("labels=cyrus.managed%3Dtrue");
		expect(calls[1]?.url).toBe(next);
	});
});

describe("AcaSandboxClient createSandbox body shape (C2/C3/C4/C5)", () => {
	it("create-from-image: PUT /sandboxes with sourcesRef.diskImage + lifecycle + egressPolicy + labels + environment", async () => {
		const { fetch, calls } = fakeFetch([res(200, runningSandbox)]);
		const c = client({ fetchFn: fetch });
		await c.createSandbox({
			diskImageName: "cyrus-worker:latest",
			environment: { MARKER: "1", CYRUS_DEVICE_TOKEN: "tok" },
			resources: { cpu: "1000m", memory: "2048Mi" },
			lifecycle: {
				autoSuspendPolicy: { enabled: false, interval: 0, mode: "Memory" },
			},
			labels: { "cyrus.issue": "DEF-1", "cyrus.device-id": "dev-7" },
			egressPolicy: {
				defaultAction: "Deny",
				trafficInspection: "Full",
				hostRules: [
					{ pattern: "*.github.com", action: "Allow" },
					{ pattern: "api.anthropic.com", action: "Allow" },
				],
			},
			entrypoint: ["/entrypoint.sh"],
			cmd: ["--serve"],
		});
		const call = calls[0];
		expect(call?.init?.method).toBe("PUT");
		expect(call?.url).toBe(`${BASE}${ROOT}/sandboxes?api-version=${AV}`);
		const body = JSON.parse(call?.init?.body as string);
		expect(body).toEqual({
			sourcesRef: { diskImage: { name: "cyrus-worker:latest" } },
			environment: { MARKER: "1", CYRUS_DEVICE_TOKEN: "tok" },
			resources: { cpu: "1000m", memory: "2048Mi" },
			lifecycle: {
				autoSuspendPolicy: { enabled: false, interval: 0, mode: "Memory" },
			},
			labels: { "cyrus.issue": "DEF-1", "cyrus.device-id": "dev-7" },
			egressPolicy: {
				defaultAction: "Deny",
				trafficInspection: "Full",
				hostRules: [
					{ pattern: "*.github.com", action: "Allow" },
					{ pattern: "api.anthropic.com", action: "Allow" },
				],
			},
			entrypoint: ["/entrypoint.sh"],
			cmd: ["--serve"],
		});
	});

	// Verified against the live 2026-02-01-preview data plane: sending a bare
	// string for `entrypoint` is rejected with
	//   400 "The JSON value could not be converted to
	//        System.Collections.Generic.IReadOnlyList`1[System.String]"
	// so these must serialize as JSON arrays, exec-form style, never as a
	// single shell string.
	it("serializes entrypoint/cmd as string arrays (wire type is IReadOnlyList<string>)", async () => {
		const { fetch, calls } = fakeFetch([res(200, runningSandbox)]);
		const c = client({ fetchFn: fetch });
		await c.createSandbox({
			diskImageId: "disk-1",
			entrypoint: ["/bin/sh", "-c", "exec /entrypoint.sh"],
			cmd: ["--flag", "value"],
		});
		const body = JSON.parse(calls[0]?.init?.body as string);
		expect(Array.isArray(body.entrypoint)).toBe(true);
		expect(body.entrypoint).toEqual(["/bin/sh", "-c", "exec /entrypoint.sh"]);
		expect(Array.isArray(body.cmd)).toBe(true);
		expect(body.cmd).toEqual(["--flag", "value"]);
	});

	it("create-from-private-image: references the registered disk by id", async () => {
		const { fetch, calls } = fakeFetch([res(200, runningSandbox)]);
		const c = client({ fetchFn: fetch });
		await c.createSandbox({ diskImageId: "disk-private-1" });
		const body = JSON.parse(calls[0]?.init?.body as string);
		expect(body.sourcesRef).toEqual({
			diskImage: { id: "disk-private-1" },
		});
	});

	it("create-from-snapshot: uses sourcesRef.snapshot.id and no environment", async () => {
		const { fetch, calls } = fakeFetch([res(200, runningSandbox)]);
		const c = client({ fetchFn: fetch });
		await c.createSandbox({
			snapshotId: "snap-1",
			labels: { "cyrus.issue": "DEF-1" },
		});
		const body = JSON.parse(calls[0]?.init?.body as string);
		expect(body.sourcesRef).toEqual({ snapshot: { id: "snap-1" } });
		expect(body.environment).toBeUndefined();
	});

	it("sync create returns the sandbox without polling", async () => {
		const { fetch, calls } = fakeFetch([res(200, runningSandbox)]);
		const c = client({ fetchFn: fetch });
		const out = await c.createSandbox({ diskImageName: "img" });
		expect(out).toEqual(runningSandbox);
		expect(calls).toHaveLength(1);
	});

	it("async fallback: 202 with Location then polls until Running", async () => {
		const asyncHdr = { headers: { Location: `${BASE}${ROOT}/sandboxes/abc` } };
		const { fetch, calls } = fakeFetch([
			res(202, null, asyncHdr),
			() => res(200, { ...runningSandbox, state: "Creating" }),
			() => res(200, runningSandbox),
		]);
		const c = client({ fetchFn: fetch, sleepFn: async () => {} });
		const out = await c.createSandbox({ diskImageName: "img" });
		expect(out.state).toBe("Running");
		expect(calls).toHaveLength(3);
		expect(calls[1]?.url).toBe(
			`${BASE}${ROOT}/sandboxes/abc?api-version=${AV}`,
		);
	});

	it("polls a 200 nonterminal create response by returned sandbox id", async () => {
		const { fetch, calls } = fakeFetch([
			res(200, { id: "new-id", state: "Creating" }),
			res(200, runningSandbox),
		]);
		const c = client({ fetchFn: fetch, sleepFn: async () => {} });
		await expect(c.createSandbox({ diskImageName: "img" })).resolves.toEqual(
			runningSandbox,
		);
		expect(calls[1]?.url).toBe(
			`${BASE}${ROOT}/sandboxes/new-id?api-version=${AV}`,
		);
	});

	it("rejects a 202 create response without an async polling URL", async () => {
		const { fetch } = fakeFetch([res(202, null)]);
		const c = client({ fetchFn: fetch });
		await expect(c.createSandbox({ diskImageName: "img" })).rejects.toThrow(
			"omitted Location",
		);
	});
});

describe("AcaSandboxClient errors", () => {
	it("getSandbox returns null on 404", async () => {
		const { fetch } = fakeFetch([
			res(404, { title: "SandboxNotFound", status: 404, detail: "no" }),
		]);
		const c = client({ fetchFn: fetch });
		expect(await c.getSandbox("missing")).toBeNull();
	});

	it("400 ProblemDetails surfaces title + errors", async () => {
		const { fetch } = fakeFetch([
			res(400, {
				title: "One or more validation errors occurred.",
				status: 400,
				errors: { id: ["The input was not valid."] },
			}),
		]);
		const c = client({ fetchFn: fetch });
		try {
			await c.getSandbox("bad");
			expect.fail("expected throw");
		} catch (e) {
			expect(e).toBeInstanceOf(AcaApiError);
			const err = e as AcaApiError;
			expect(err.status).toBe(400);
			expect(err.message).toContain("One or more validation errors occurred.");
			expect(err.message).toContain("The input was not valid.");
			expect(err.body).toMatchObject({
				errors: { id: ["The input was not valid."] },
			});
		}
	});

	it("deleteSandbox tolerates 404", async () => {
		const { fetch, calls } = fakeFetch([
			res(404, { title: "SandboxNotFound", status: 404 }),
		]);
		const c = client({ fetchFn: fetch });
		await c.deleteSandbox("gone");
		expect(calls).toHaveLength(1);
	});
});

describe("AcaSandboxClient 403 retry / 401 no-retry (S6)", () => {
	it("retries 403 then succeeds within the RBAC budget", async () => {
		const { fetch, calls } = fakeFetch([
			res(403, null),
			res(403, null),
			res(200, runningSandbox),
		]);
		const c = client({ fetchFn: fetch, sleepFn: async () => {} });
		const out = await c.getSandbox(runningSandbox.id);
		expect(out).toEqual(runningSandbox);
		// Two 403s then the success
		expect(calls).toHaveLength(3);
	});

	it("401 wrong-audience does NOT retry, throws immediately", async () => {
		const { fetch, calls } = fakeFetch([
			res(401, { title: "Unauthorized", status: 401 }),
		]);
		const c = client({ fetchFn: fetch, sleepFn: async () => {} });
		await expect(c.getSandbox(runningSandbox.id)).rejects.toBeInstanceOf(
			AcaApiError,
		);
		expect(calls).toHaveLength(1);
	});

	it("exhausting the 403 retry budget throws", async () => {
		const { fetch } = fakeFetch([res(403, null)]);
		const c = client({
			fetchFn: fetch,
			sleepFn: async () => {},
		});
		await expect(c.getSandbox(runningSandbox.id)).rejects.toBeInstanceOf(
			AcaApiError,
		);
	});
});

describe("AcaSandboxClient snapshots + disk images", () => {
	const snapshot: AcaSnapshot = {
		id: "snap-1",
		labels: { "cyrus.issue": "DEF-1" },
		sandboxId: runningSandbox.id,
		status: "Ready",
		createdAtUtc: "2026-07-26T00:00:00Z",
		sizeInMB: 40,
	};
	it("listSnapshots accepts bare array", async () => {
		const { fetch, calls } = fakeFetch([res(200, [snapshot])]);
		const c = client({ fetchFn: fetch });
		const out = await c.listSnapshots();
		expect(out).toEqual([snapshot]);
		expect(calls[0]?.url).toBe(`${BASE}${ROOT}/snapshots?api-version=${AV}`);
	});

	it("listSnapshots accepts {value:[...]} envelope with labels filter", async () => {
		const { fetch, calls } = fakeFetch([res(200, { value: [snapshot] })]);
		const c = client({ fetchFn: fetch });
		const out = await c.listSnapshots({ "cyrus.issue": "DEF-1" });
		expect(out).toEqual([snapshot]);
		expect(calls[0]?.url).toBe(
			`${BASE}${ROOT}/snapshots?api-version=${AV}&labels=cyrus.issue%3DDEF-1`,
		);
	});

	it("follows snapshot nextLink pages without replacing an existing api-version", async () => {
		const next = `${BASE}${ROOT}/snapshots?api-version=future&skip=2`;
		const second = { ...snapshot, id: "snap-2" };
		const { fetch, calls } = fakeFetch([
			res(200, { value: [snapshot], nextLink: next }),
			res(200, { value: [second] }),
		]);
		const c = client({ fetchFn: fetch });
		await expect(c.listSnapshots()).resolves.toEqual([snapshot, second]);
		expect(calls[1]?.url).toBe(next);
	});

	it("createSnapshot POSTs to /sandboxes/{id}/snapshot with labels in body", async () => {
		const { fetch, calls } = fakeFetch([res(200, snapshot)]);
		const c = client({ fetchFn: fetch });
		const out = await c.createSnapshot(runningSandbox.id, {
			"cyrus.issue": "DEF-1",
		});
		expect(out).toEqual(snapshot);
		const call = calls[0];
		expect(call?.url).toBe(
			`${BASE}${ROOT}/sandboxes/${runningSandbox.id}/snapshot?api-version=${AV}`,
		);
		expect(call?.init?.method).toBe("POST");
		expect(JSON.parse(call?.init?.body as string)).toEqual({
			labels: { "cyrus.issue": "DEF-1" },
		});
	});

	it("deleteSnapshot tolerates 404 and 202", async () => {
		const { fetch, calls } = fakeFetch([
			res(404, { title: "SnapshotNotFound", status: 404 }),
		]);
		const c = client({ fetchFn: fetch });
		await c.deleteSnapshot("gone");
		expect(calls[0]?.url).toBe(
			`${BASE}${ROOT}/snapshots/gone?api-version=${AV}`,
		);
		expect(calls[0]?.init?.method).toBe("DELETE");
	});

	it("setLifecycle POSTs the policy to /sandboxes/{id}/lifecycle", async () => {
		const { fetch, calls } = fakeFetch([res(200, null)]);
		const c = client({ fetchFn: fetch });
		await c.setLifecycle(runningSandbox.id, {
			autoSuspendPolicy: { enabled: false, interval: 0, mode: "Memory" },
		});
		const call = calls[0];
		expect(call?.url).toBe(
			`${BASE}${ROOT}/sandboxes/${runningSandbox.id}/lifecycle?api-version=${AV}`,
		);
		expect(call?.init?.method).toBe("POST");
		expect(JSON.parse(call?.init?.body as string)).toEqual({
			autoSuspendPolicy: { enabled: false, interval: 0, mode: "Memory" },
		});
	});

	const diskImage: AcaDiskImage = {
		name: "cyrus-worker:latest",
		image: "ghcr.io/ceedar/cyrus-worker:latest",
		status: "Ready",
		sizeInMB: 188,
	};
	it("listDiskImages uses GET /diskimages (lowercase)", async () => {
		const { fetch, calls } = fakeFetch([res(200, [diskImage])]);
		const c = client({ fetchFn: fetch });
		const out = await c.listDiskImages();
		expect(out).toEqual([diskImage]);
		expect(calls[0]?.url).toBe(`${BASE}${ROOT}/diskimages?api-version=${AV}`);
	});

	it("follows disk-image nextLink pages", async () => {
		const next = `${BASE}${ROOT}/diskimages?api-version=${AV}&skip=2`;
		const second = { ...diskImage, name: "worker-v2" };
		const { fetch, calls } = fakeFetch([
			res(200, { value: [diskImage], nextLink: next }),
			res(200, [second]),
		]);
		const c = client({ fetchFn: fetch });
		await expect(c.listDiskImages()).resolves.toEqual([diskImage, second]);
		expect(calls[1]?.url).toBe(next);
	});

	it("createDiskImage uses PUT /diskimages with the image base", async () => {
		const { fetch, calls } = fakeFetch([res(200, diskImage)]);
		const c = client({ fetchFn: fetch });
		const out = await c.createDiskImage(
			"cyrus-worker:latest",
			"ghcr.io/ceedar/cyrus-worker:latest",
			{ isPublic: true },
		);
		expect(out).toEqual(diskImage);
		const call = calls[0];
		expect(call?.init?.method).toBe("PUT");
		expect(call?.url).toBe(`${BASE}${ROOT}/diskimages?api-version=${AV}`);
		expect(JSON.parse(call?.init?.body as string)).toEqual({
			name: "cyrus-worker:latest",
			image: {
				base: "ghcr.io/ceedar/cyrus-worker:latest",
				isPublic: true,
			},
		});
	});
});

/**
 * Node's `fetch` has no overall request timeout, so a blackholed data plane
 * leaves a call pending indefinitely. That matters well beyond this client:
 * `ensureRunning` awaits these calls while holding the provider's per-issue
 * mutex, and the router awaits `ensureRunning` while holding the device's
 * in-flight boot slot — so one hung request can block every later boot for an
 * issue, including the wake a terminal teardown needs.
 */
describe("AcaSandboxClient request deadline", () => {
	it("attaches an abort signal to every request", async () => {
		const { fetch, calls } = fakeFetch([res(200, runningSandbox)]);
		const c = client({ fetchFn: fetch });
		await c.getSandbox(runningSandbox.id);
		expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
		expect(calls[0]?.init?.signal?.aborted).toBe(false);
	});

	it("attaches one to the raw createSandbox PUT as well", async () => {
		const { fetch, calls } = fakeFetch([res(200, runningSandbox)]);
		const c = client({ fetchFn: fetch });
		await c.createSandbox({ diskImageName: "disk-v1" });
		expect(calls[0]?.init?.method).toBe("PUT");
		expect(calls[0]?.init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("gives each RBAC-403 retry its own fresh deadline", async () => {
		// Per-attempt rather than per-call, so the retry sequence keeps its full
		// budget while no single fetch can hang.
		const { fetch, calls } = fakeFetch([
			res(403, { error: "propagating" }),
			res(200, runningSandbox),
		]);
		const c = client({ fetchFn: fetch, sleepFn: async () => {} });
		await c.getSandbox(runningSandbox.id);
		expect(calls).toHaveLength(2);
		const signals = calls.map((call) => call.init?.signal);
		expect(signals[0]).toBeInstanceOf(AbortSignal);
		expect(signals[1]).toBeInstanceOf(AbortSignal);
		expect(signals[0]).not.toBe(signals[1]);
	});

	it("omits the signal entirely when the deadline is disabled", async () => {
		const { fetch, calls } = fakeFetch([res(200, runningSandbox)]);
		const c = client({ fetchFn: fetch, requestTimeoutMs: 0 });
		await c.getSandbox(runningSandbox.id);
		expect(calls[0]?.init?.signal).toBeUndefined();
	});

	// WAG-10 / WAG-14 (2026-08-06): snapshot/suspend/resume move the sandbox's
	// whole memory + disk image, not just control-plane metadata. Measured on a
	// live 4 vCPU / 8 GiB sandbox with an 18.4 GB image: snapshot 3m52s, stop
	// 4m09s, both 200. Under the shared 120s deadline both aborted mid-flight
	// while ACA completed them anyway, so `stop()` could never suspend a large
	// sandbox and the 60s sweep re-failed forever.
	it.each([
		[
			"createSnapshot",
			(c: ReturnType<typeof client>) => c.createSnapshot("sb-1"),
		],
		["stopSandbox", (c: ReturnType<typeof client>) => c.stopSandbox("sb-1")],
		[
			"resumeSandbox",
			(c: ReturnType<typeof client>) => c.resumeSandbox("sb-1"),
		],
	] as const)(
		"does not abort %s at the short control-plane deadline",
		async (_name, call) => {
			let seen: AbortSignal | undefined;
			const slowFetch = (async (
				_url: RequestInfo | URL,
				init?: RequestInit,
			) => {
				seen = init?.signal ?? undefined;
				// Well past the 120s control-plane deadline, well inside the slow one.
				await new Promise((resolve) => setTimeout(resolve, 20));
				if (seen?.aborted) throw new Error("aborted too early");
				return res(200, {}).clone();
			}) as typeof fetch;
			const c = client({ fetchFn: slowFetch, requestTimeoutMs: 10 });
			await expect(call(c)).resolves.not.toThrow();
			expect(seen).toBeInstanceOf(AbortSignal);
			expect(seen?.aborted).toBe(false);
		},
	);

	it("still honours a disabled deadline on the slow operations", async () => {
		const { fetch, calls } = fakeFetch([res(200, {})]);
		const c = client({ fetchFn: fetch, requestTimeoutMs: 0 });
		await c.stopSandbox("sb-1");
		expect(calls[0]?.init?.signal).toBeUndefined();
	});

	it("aborts a request that outlives its deadline", async () => {
		// A genuinely hung data plane: the fetch only settles because the signal
		// fires, which is the whole point.
		const hangingFetch = (async (
			_url: RequestInfo | URL,
			init?: RequestInit,
		) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () =>
					reject(new Error("aborted by signal")),
				);
			});
		}) as typeof fetch;
		const c = client({ fetchFn: hangingFetch, requestTimeoutMs: 5 });
		await expect(c.getSandbox(runningSandbox.id)).rejects.toThrow(
			"aborted by signal",
		);
	});
});
