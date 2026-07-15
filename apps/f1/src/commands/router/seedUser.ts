/**
 * router:seed-user - Seed a router user with a container executor + Claude secret
 */

import { Command } from "commander";
import { success } from "../../utils/colors.js";
import { controlPost } from "./controlClient.js";

interface RouterSeedUserOptions {
	email: string;
	linearId: string;
	provider: string;
	claudeToken: string;
}

export function createRouterSeedUserCommand(): Command {
	const cmd = new Command("router:seed-user");
	cmd
		.description("Seed a router user with a container executor + Claude secret")
		.requiredOption("-e, --email <email>", "User email")
		.requiredOption("-l, --linear-id <id>", "User linear id")
		.option("-p, --provider <provider>", "Executor provider", "docker")
		.requiredOption(
			"--claude-token <token>",
			"CLAUDE_CODE_OAUTH_TOKEN for the container",
		)
		.action(async (o: RouterSeedUserOptions) => {
			await controlPost("/router/seed-user", {
				email: o.email,
				linearId: o.linearId,
				provider: o.provider,
				claudeOauthToken: o.claudeToken,
			});
			console.log(success(`Seeded user ${o.email} (${o.provider})`));
		});
	return cmd;
}
