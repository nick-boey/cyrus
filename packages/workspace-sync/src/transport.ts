import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Default cap on how long a single bundle upload/download request may take.
 * Without this, a reachable-but-blackholed router hangs `fetch` until the OS
 * TCP timeout (minutes) — which, since this runs in the persistence floor's
 * hot path (session end + every periodic tick), can stall the whole caller
 * far longer than intended. Callers can override via the `timeoutMs` param.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

export async function uploadBundle(
	httpBase: string,
	deviceToken: string,
	issueKey: string,
	bundleFile: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<void> {
	const body = await readFile(bundleFile);
	const res = await fetch(`${httpBase}/artifacts/issues/${issueKey}/bundle`, {
		method: "PUT",
		headers: {
			authorization: `Bearer ${deviceToken}`,
			"content-type": "application/gzip",
		},
		body,
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!res.ok) throw new Error(`bundle upload failed: HTTP ${res.status}`);
}

export async function downloadBundle(
	httpBase: string,
	deviceToken: string,
	issueKey: string,
	destFile: string,
	timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<boolean> {
	const res = await fetch(`${httpBase}/artifacts/issues/${issueKey}/bundle`, {
		headers: { authorization: `Bearer ${deviceToken}` },
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (res.status === 404) return false;
	if (!res.ok) throw new Error(`bundle download failed: HTTP ${res.status}`);
	mkdirSync(dirname(destFile), { recursive: true });
	await writeFile(destFile, Buffer.from(await res.arrayBuffer()));
	return true;
}
