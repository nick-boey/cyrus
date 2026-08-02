import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	downloadBundle,
	postTeardownComplete,
	TEARDOWN_IDEMPOTENCY_HEADER,
	TeardownCallbackError,
	uploadBundle,
} from "../src/transport.js";

const HTTP_BASE = "https://router.example.com";
const TOKEN = "device-token-123";
const ISSUE_KEY = "CYPACK-9";
const EXPECTED_URL = `${HTTP_BASE}/artifacts/issues/${ISSUE_KEY}/bundle`;

function jsonHeaders(init?: HeadersInit): Record<string, string> {
	return Object.fromEntries(new Headers(init).entries());
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("uploadBundle", () => {
	it("PUTs the file bytes to the artifacts URL with a bearer token and gzip content-type", async () => {
		const src = mkdtempSync(join(tmpdir(), "transport-src-"));
		const bundleFile = join(src, "bundle.tar.gz");
		const bytes = Buffer.from([0x1f, 0x8b, 0x00, 0x01, 0x02, 0x03]);
		writeFileSync(bundleFile, bytes);

		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await uploadBundle(HTTP_BASE, TOKEN, ISSUE_KEY, bundleFile);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(EXPECTED_URL);
		expect(init.method).toBe("PUT");
		expect(jsonHeaders(init.headers)).toMatchObject({
			authorization: `Bearer ${TOKEN}`,
			"content-type": "application/gzip",
		});
		expect(Buffer.isBuffer(init.body)).toBe(true);
		expect(Buffer.from(init.body as Buffer).equals(bytes)).toBe(true);
	});

	it("throws on a non-2xx response", async () => {
		const src = mkdtempSync(join(tmpdir(), "transport-src-"));
		const bundleFile = join(src, "bundle.tar.gz");
		writeFileSync(bundleFile, Buffer.from([0x00]));

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 500 })),
		);

		await expect(
			uploadBundle(HTTP_BASE, TOKEN, ISSUE_KEY, bundleFile),
		).rejects.toThrow(/bundle upload failed: HTTP 500/);
	});
});

describe("downloadBundle", () => {
	it("GETs the artifacts URL with a bearer token, writes the body to disk, and returns true", async () => {
		const dst = mkdtempSync(join(tmpdir(), "transport-dst-"));
		const destFile = join(dst, "nested", "dir", "bundle.tar.gz");
		const bytes = Buffer.from([0x1f, 0x8b, 0xff, 0xee, 0xaa]);

		const fetchMock = vi.fn(async () => new Response(bytes, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		const result = await downloadBundle(HTTP_BASE, TOKEN, ISSUE_KEY, destFile);

		expect(result).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(EXPECTED_URL);
		expect(jsonHeaders(init.headers)).toMatchObject({
			authorization: `Bearer ${TOKEN}`,
		});
		expect(existsSync(destFile)).toBe(true);
		expect(Buffer.from(readFileSync(destFile)).equals(bytes)).toBe(true);
	});

	it("returns false without throwing on a 404 response", async () => {
		const dst = mkdtempSync(join(tmpdir(), "transport-dst-"));
		const destFile = join(dst, "bundle.tar.gz");

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 404 })),
		);

		const result = await downloadBundle(HTTP_BASE, TOKEN, ISSUE_KEY, destFile);

		expect(result).toBe(false);
		expect(existsSync(destFile)).toBe(false);
	});

	it("throws on other non-2xx responses", async () => {
		const dst = mkdtempSync(join(tmpdir(), "transport-dst-"));
		const destFile = join(dst, "bundle.tar.gz");

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 503 })),
		);

		await expect(
			downloadBundle(HTTP_BASE, TOKEN, ISSUE_KEY, destFile),
		).rejects.toThrow(/bundle download failed: HTTP 503/);
		expect(existsSync(destFile)).toBe(false);
	});
});

describe("postTeardownComplete", () => {
	it("POSTs with bearer auth and a 30 second deadline", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await postTeardownComplete(HTTP_BASE, TOKEN, ISSUE_KEY);

		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(url).toBe(
			`${HTTP_BASE}/containers/issues/${ISSUE_KEY}/teardown-complete`,
		);
		expect(init.method).toBe("POST");
		expect(jsonHeaders(init.headers)).toMatchObject({
			authorization: `Bearer ${TOKEN}`,
		});
		expect(init.signal).toBeInstanceOf(AbortSignal);
	});

	it("sends the idempotency key so the router can recognise a replay", async () => {
		const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
		vi.stubGlobal("fetch", fetchMock);

		await postTeardownComplete(HTTP_BASE, TOKEN, ISSUE_KEY, {
			idempotencyKey: "cb-42",
		});

		const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
		expect(jsonHeaders(init.headers)).toMatchObject({
			authorization: `Bearer ${TOKEN}`,
			[TEARDOWN_IDEMPOTENCY_HEADER]: "cb-42",
		});
	});

	it("throws on a non-2xx response", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 401 })),
		);
		await expect(
			postTeardownComplete(HTTP_BASE, TOKEN, ISSUE_KEY),
		).rejects.toThrow("teardown-complete callback failed: HTTP 401");
	});

	// The device queue keys its retry decision off `retryable`: a router the
	// worker cannot reach must be retried with the same key, while a positive
	// rejection must be dropped so it isn't replayed forever.
	it("marks a 5xx as retryable and an auth/scope rejection as fatal", async () => {
		for (const [status, retryable] of [
			[503, true],
			[500, true],
			[429, true],
			[400, false],
			[401, false],
			[403, false],
			[404, false],
		] as const) {
			vi.stubGlobal(
				"fetch",
				vi.fn(async () => new Response(null, { status })),
			);
			const error = await postTeardownComplete(
				HTTP_BASE,
				TOKEN,
				ISSUE_KEY,
			).catch((err: unknown) => err);
			expect(error).toBeInstanceOf(TeardownCallbackError);
			expect((error as TeardownCallbackError).status).toBe(status);
			expect((error as TeardownCallbackError).retryable).toBe(retryable);
		}
	});

	it("treats a network failure as retryable", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		);
		const error = await postTeardownComplete(HTTP_BASE, TOKEN, ISSUE_KEY).catch(
			(err: unknown) => err,
		);
		expect(error).toBeInstanceOf(TeardownCallbackError);
		expect((error as TeardownCallbackError).retryable).toBe(true);
		expect((error as TeardownCallbackError).status).toBeUndefined();
	});
});
