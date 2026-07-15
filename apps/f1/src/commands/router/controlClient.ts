/**
 * Control-RPC client for the F1 router control server.
 *
 * Talks to the loopback, token-guarded `/router/*` control plane started by
 * `startControlServer` (see `apps/f1/src/router/ControlServer.ts`). Reads the
 * base URL and bearer token from the environment so `./f1 router:*`
 * subcommands can be run from a separate terminal/process than the one that
 * started the router rig.
 */

export function controlBase(): string {
	return process.env.F1_ROUTER_CONTROL_URL ?? "http://127.0.0.1:3601";
}

export async function controlPost(
	path: string,
	body: unknown,
): Promise<unknown> {
	const res = await fetch(`${controlBase()}${path}`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${process.env.F1_ROUTER_CONTROL_TOKEN ?? ""}`,
		},
		body: JSON.stringify(body),
	});
	if (!res.ok) throw new Error(`control ${path} → HTTP ${res.status}`);
	return res.json();
}

export async function controlGet(path: string): Promise<unknown> {
	const res = await fetch(`${controlBase()}${path}`, {
		headers: {
			authorization: `Bearer ${process.env.F1_ROUTER_CONTROL_TOKEN ?? ""}`,
		},
	});
	if (!res.ok) throw new Error(`control ${path} → HTTP ${res.status}`);
	return res.json();
}
