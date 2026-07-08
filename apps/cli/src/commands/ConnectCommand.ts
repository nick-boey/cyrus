import { chmodSync } from "node:fs";
import type { EdgeConfig } from "cyrus-core";
import { BaseCommand } from "./ICommand.js";

/**
 * Derives the router's WebSocket URL from its HTTP(S) origin.
 *
 * `https://` → `wss://` (production/hosted router), `http://` → `ws://`
 * (local/dev router). Returns `undefined` for any other scheme so the caller
 * can surface a clear error instead of silently connecting to the wrong
 * protocol.
 */
export function deriveWebSocketUrl(httpUrl: string): string | undefined {
	if (httpUrl.startsWith("https://")) {
		return `wss://${httpUrl.slice("https://".length)}`;
	}
	if (httpUrl.startsWith("http://")) {
		return `ws://${httpUrl.slice("http://".length)}`;
	}
	return undefined;
}

/**
 * Enrolls this device with a running Cyrus Router server:
 *
 *   cyrus connect <url> --code <code>
 *
 * `<url>` is the router's public HTTP(S) origin (e.g. `https://router.example.com`
 * or `http://localhost:8787` for local/dev). `--code` is a one-time
 * enrollment code minted by `cyrus router users add <email>` (15-minute TTL).
 *
 * POSTs `{ code }` to `<url>/enroll` over the *http(s)* origin, then persists
 * `platform: "router"` and `router: { url, deviceToken }` — using the derived
 * `ws(s)://` form of the url — into config.json. The file is chmod'd to 0600
 * immediately after writing since `deviceToken` is a long-lived bearer
 * credential.
 */
export class ConnectCommand extends BaseCommand {
	async execute(args: string[]): Promise<void> {
		const { url, code } = this.parseArgs(args);
		if (!url) {
			this.exitWithError("Usage: cyrus connect <url> --code <code>");
		}
		if (!code) {
			this.exitWithError(
				"Usage: cyrus connect <url> --code <code> (missing --code)",
			);
		}

		const httpUrl = url.replace(/\/+$/, "");
		const wsUrl = deriveWebSocketUrl(httpUrl);
		if (!wsUrl) {
			this.exitWithError(
				`Unsupported URL scheme in ${httpUrl} — expected http:// or https://`,
			);
		}

		const response = await fetch(`${httpUrl}/enroll`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ code }),
		}).catch((error: unknown) => {
			this.exitWithError(
				`Failed to reach ${httpUrl}: ${(error as Error).message}`,
			);
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			this.exitWithError(
				`Enrollment failed (${response.status}): ${body || response.statusText}`,
			);
		}

		const body = (await response.json()) as { deviceToken?: string };
		if (!body.deviceToken) {
			this.exitWithError("Enrollment response was missing deviceToken");
		}

		this.writeRouterConfig(wsUrl, body.deviceToken);

		this.logSuccess(`Connected to router at ${wsUrl}.`);
		this.logger.raw("Next: run `cyrus start` to begin processing issues.");
	}

	private parseArgs(args: string[]): { url?: string; code?: string } {
		let code: string | undefined;
		const positional: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (!arg) continue;
			if (arg === "--code" && args[i + 1]) {
				code = args[i + 1];
				i++;
			} else {
				positional.push(arg);
			}
		}
		return { url: positional[0], code };
	}

	/**
	 * Merges `platform`/`router` onto the existing config.json (preserving
	 * `repositories` and everything else already there) and re-tightens the
	 * file mode to 0600 — `ConfigService.save()` writes with the process's
	 * default umask, which is not guaranteed to be restrictive enough for a
	 * file holding a bearer device token.
	 */
	private writeRouterConfig(wsUrl: string, deviceToken: string): void {
		const existing = this.app.config.load();
		const updated: EdgeConfig = {
			...existing,
			platform: "router",
			router: { url: wsUrl, deviceToken },
		};
		this.app.config.save(updated);
		chmodSync(this.app.config.getConfigPath(), 0o600);
	}
}
