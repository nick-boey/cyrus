/**
 * router:inject - Inject an agentSessionCreated/prompted webhook into the router
 */

import { Command } from "commander";
import { success } from "../../utils/colors.js";
import { controlPost } from "./controlClient.js";

interface RouterInjectOptions {
	sessionId: string;
	issueId: string;
	identifier: string;
	title: string;
	kind: string;
	body?: string;
	creatorId: string;
	creatorEmail: string;
	creatorName: string;
}

export function createRouterInjectCommand(): Command {
	const cmd = new Command("router:inject");
	cmd
		.description(
			"Inject an agentSessionCreated/prompted webhook into the router",
		)
		.requiredOption("-s, --session-id <id>", "Session id")
		.requiredOption("-i, --issue-id <id>", "Issue id")
		.requiredOption("--identifier <key>", "Issue identifier, e.g. CYPACK-1")
		.option("-t, --title <title>", "Issue title", "F1 router issue")
		.option("-k, --kind <kind>", "created | prompted", "created")
		.option("-b, --body <text>", "Prompt body (for kind=prompted)")
		.requiredOption(
			"--creator-id <id>",
			"Creator linear id (matches a seeded user)",
		)
		.requiredOption("--creator-email <email>", "Creator email")
		.option("--creator-name <name>", "Creator name", "F1 User")
		.action(async (o: RouterInjectOptions) => {
			await controlPost("/router/inject", {
				kind: o.kind,
				sessionId: o.sessionId,
				issueId: o.issueId,
				identifier: o.identifier,
				title: o.title,
				body: o.body,
				creator: {
					id: o.creatorId,
					email: o.creatorEmail,
					name: o.creatorName,
				},
			});
			console.log(success(`Injected ${o.kind} for ${o.identifier}`));
		});
	return cmd;
}
