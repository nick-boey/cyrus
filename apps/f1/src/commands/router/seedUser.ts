/**
 * router:seed-user - Seed a router user with a container executor + Claude secret
 */

import { readFileSync } from "node:fs";
import { Command } from "commander";
import { success } from "../../utils/colors.js";
import { controlPost } from "./controlClient.js";

interface RouterSeedUserOptions {
	email: string;
	linearId: string;
	provider: string;
	claudeToken?: string;
	defaultRunner?: string;
	codexAuth?: string;
	env: string[];
}

function collect(value: string, previous: string[]): string[] {
	return previous.concat([value]);
}

/** Parses KEY=VALUE pairs. Never includes a VALUE in an error (it may be a secret). */
export function parseEnvPairs(pairs: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const pair of pairs) {
		const eq = pair.indexOf("=");
		if (eq <= 0) {
			throw new Error(
				"--env expects KEY=VALUE with a non-empty key (value omitted from this error)",
			);
		}
		out[pair.slice(0, eq)] = pair.slice(eq + 1);
	}
	return out;
}

export function createRouterSeedUserCommand(): Command {
	const cmd = new Command("router:seed-user");
	cmd
		.description("Seed a router user with a container executor + Claude secret")
		.requiredOption("-e, --email <email>", "User email")
		.requiredOption("-l, --linear-id <id>", "User linear id")
		.option("-p, --provider <provider>", "Executor provider", "docker")
		.option(
			"--claude-token <token>",
			"CLAUDE_CODE_OAUTH_TOKEN for the container. Optional: a user whose default runner is Codex needs no Claude token, and seeding one hides that.",
		)
		.option(
			"--default-runner <runner:model>",
			"Per-user default runner, e.g. codex:gpt-5.5. Must be a catalog value.",
		)
		.option(
			"--codex-auth <path>",
			"Path to a `codex login --device-auth` auth.json to seal as this user's Codex credential",
		)
		.option(
			"--env <KEY=VALUE>",
			"Extra container env var (repeatable)",
			collect,
			[],
		)
		.action(async (o: RouterSeedUserOptions) => {
			await controlPost("/router/seed-user", {
				email: o.email,
				linearId: o.linearId,
				provider: o.provider,
				...(o.claudeToken ? { claudeOauthToken: o.claudeToken } : {}),
				...(o.defaultRunner ? { defaultRunner: o.defaultRunner } : {}),
				...(o.codexAuth
					? { codexAuthJson: readFileSync(o.codexAuth, "utf-8") }
					: {}),
				env: parseEnvPairs(o.env),
			});
			console.log(success(`Seeded user ${o.email} (${o.provider})`));
		});
	return cmd;
}
