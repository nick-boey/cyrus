/**
 * router:artifact - Check whether a floor bundle has landed for an issue
 */

import { Command } from "commander";
import { controlGet } from "./controlClient.js";

interface RouterArtifactOptions {
	identifier: string;
}

interface ArtifactResult {
	present: boolean;
	bytes?: number;
}

export function createRouterArtifactCommand(): Command {
	const cmd = new Command("router:artifact");
	cmd
		.description("Check whether a floor bundle has landed for an issue")
		.requiredOption("--identifier <key>", "Issue identifier, e.g. CYPACK-1")
		.action(async (o: RouterArtifactOptions) => {
			const res = (await controlGet(
				`/router/artifact/${o.identifier}`,
			)) as ArtifactResult;
			console.log(JSON.stringify(res));
		});
	return cmd;
}
