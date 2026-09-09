/**
 * router:strand-run - Route an issue and leave its run stranded, then print the
 * run facts a guarded recovery needs.
 *
 * The shape `cyrus recover` exists for: a non-terminal run on a container
 * device whose worker never connected, with the session affinity and the issue
 * lock still held. Nothing here fabricates that state — `EventRouter` writes
 * every row of it on the way through, and the fake executor simply never dials
 * back. What the command adds is the run id and revision, which the operator
 * surface will not hand out for a run the caller has not already listed, and
 * which every recovery invocation needs.
 */

import { Command } from "commander";
import { bold, cyan, success } from "../../utils/colors.js";
import { controlPost } from "./controlClient.js";

interface RouterStrandRunOptions {
	sessionId: string;
	issueId: string;
	identifier: string;
	title: string;
	executorState: string;
	creatorId: string;
	creatorEmail: string;
	creatorName: string;
	json?: boolean;
}

const EXECUTOR_STATES = ["running", "stopped", "absent", "unknown"] as const;

interface StrandedRun {
	runId: string;
	sessionId: string;
	deviceId: number;
	issueKey: string;
	state: string;
	revision: number;
	workerOnline: boolean;
	executorState?: string;
}

export function createRouterStrandRunCommand(): Command {
	const cmd = new Command("router:strand-run");
	cmd
		.description(
			"Route an issue and leave its run stranded (worker offline, ownership retained)",
		)
		.requiredOption("-s, --session-id <id>", "Session id")
		.requiredOption("-i, --issue-id <id>", "Issue id")
		.requiredOption("--identifier <key>", "Issue identifier, e.g. CYPACK-1")
		.option("-t, --title <title>", "Issue title", "F1 stranded run")
		.option(
			"--executor-state <state>",
			`Executor state to record: ${EXECUTOR_STATES.join(" | ")}`,
			"stopped",
		)
		.requiredOption(
			"--creator-id <id>",
			"Creator linear id (matches a seeded user)",
		)
		.requiredOption("--creator-email <email>", "Creator email")
		.option("--creator-name <name>", "Creator name", "F1 User")
		.option("--json", "Print the run facts as JSON")
		.action(async (o: RouterStrandRunOptions) => {
			if (!(EXECUTOR_STATES as readonly string[]).includes(o.executorState)) {
				throw new Error(
					`--executor-state must be one of: ${EXECUTOR_STATES.join(", ")}`,
				);
			}
			const run = (await controlPost("/router/strand-run", {
				kind: "created",
				sessionId: o.sessionId,
				issueId: o.issueId,
				identifier: o.identifier,
				title: o.title,
				executorState: o.executorState,
				creator: {
					id: o.creatorId,
					email: o.creatorEmail,
					name: o.creatorName,
				},
			})) as StrandedRun;
			if (o.json) {
				console.log(JSON.stringify(run, null, 2));
				return;
			}
			console.log(success(`Stranded ${run.issueKey} (${run.state})`));
			console.log(`${cyan("Run:")}       ${bold(run.runId)}`);
			console.log(`${cyan("Session:")}   ${run.sessionId}`);
			console.log(`${cyan("Device:")}    ${run.deviceId}`);
			console.log(`${cyan("Revision:")}  ${run.revision}`);
			console.log(
				`${cyan("Worker:")}    ${run.workerOnline ? "online" : "offline"}`,
			);
			console.log(`${cyan("Executor:")}  ${run.executorState ?? "unknown"}`);
		});
	return cmd;
}
