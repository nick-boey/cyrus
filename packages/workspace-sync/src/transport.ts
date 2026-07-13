import { mkdirSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export async function uploadBundle(
	httpBase: string,
	deviceToken: string,
	issueKey: string,
	bundleFile: string,
): Promise<void> {
	const body = await readFile(bundleFile);
	const res = await fetch(`${httpBase}/artifacts/issues/${issueKey}/bundle`, {
		method: "PUT",
		headers: {
			authorization: `Bearer ${deviceToken}`,
			"content-type": "application/gzip",
		},
		body,
	});
	if (!res.ok) throw new Error(`bundle upload failed: HTTP ${res.status}`);
}

export async function downloadBundle(
	httpBase: string,
	deviceToken: string,
	issueKey: string,
	destFile: string,
): Promise<boolean> {
	const res = await fetch(`${httpBase}/artifacts/issues/${issueKey}/bundle`, {
		headers: { authorization: `Bearer ${deviceToken}` },
	});
	if (res.status === 404) return false;
	if (!res.ok) throw new Error(`bundle download failed: HTTP ${res.status}`);
	mkdirSync(dirname(destFile), { recursive: true });
	await writeFile(destFile, Buffer.from(await res.arrayBuffer()));
	return true;
}
