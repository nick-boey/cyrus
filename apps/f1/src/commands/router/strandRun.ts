/**
 * router:strand-run - Route an issue and report whether its run has reached the
 * strand guarded recovery exists for.
 *
 * It OBSERVES; it does not fabricate. Routing writes the run row, the session
 * affinity and the issue lock, and the executor boots the container whose
 * worker drains the router's queue — but what makes a run stranded is that
 * worker then going away, which is the drive's own act (stop the container,
 * suspend the sandbox, kill the process). So this waits for the strand to
 * appear and reports what it found, including why the run is not yet
 * recoverable when it is not.
 *
 * It exists because `cyrus recover` takes a run id, and the operator surface
 * will not hand one out for a run the caller has not already listed.
 */

import { Command } from "commander";
import { bold, cyan, success, warning } from "../../utils/colors.js";
import { controlPost } from "./controlClient.js";

interface RouterStrandRunOptions {
	sessionId: string;
	issueId: string;
	identifier: string;
	title: string;
	timeout: string;
	creatorId: string;
	creatorEmail: string;
	creatorName: string;
	json?: boolean;
}

interface StrandedRun {
	runId: string;
	sessionId: string;
	deviceId: number;
	issueKey: string;
	state: string;
	revision: number;
	workerOnline: boolean;
	executorState?: string;
	pendingEvents: boolean;
	sessionAffinityDeviceId?: number;
	issueLockSessionId?: string;
	sessionClaimedMsAgo?: number;
	recoverable: boolean;
	blockedBy?: string;
}

export function createRouterStrandRunCommand(): Command {
	const cmd = new Command("router:strand-run");
	cmd
		.description(
			"Route an issue and report whether its run is in a recoverable strand",
		)
		.requiredOption("-s, --session-id <id>", "Session id")
		.requiredOption("-i, --issue-id <id>", "Issue id")
		.requiredOption("--identifier <key>", "Issue identifier, e.g. CYPACK-1")
		.option("-t, --title <title>", "Issue title", "F1 stranded run")
		.option(
			"--timeout <seconds>",
			"How long to wait for the worker to receive the work and then go offline",
			"0",
		)
		.requiredOption(
			"--creator-id <id>",
			"Creator linear id (matches a seeded user)",
		)
		.requiredOption("--creator-email <email>", "Creator email")
		.option("--creator-name <name>", "Creator name", "F1 User")
		.option("--json", "Print the run facts as JSON")
		.action(async (o: RouterStrandRunOptions) => {
			const seconds = Number(o.timeout);
			if (!Number.isFinite(seconds) || seconds < 0) {
				throw new Error("--timeout must be a non-negative number of seconds");
			}
			const run = (await controlPost("/router/strand-run", {
				kind: "created",
				sessionId: o.sessionId,
				issueId: o.issueId,
				identifier: o.identifier,
				title: o.title,
				timeoutMs: Math.round(seconds * 1000),
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
			console.log(
				run.recoverable
					? success(`${run.issueKey} is stranded (${run.state})`)
					: warning(`${run.issueKey} is NOT yet recoverable: ${run.blockedBy}`),
			);
			console.log(`${cyan("Run:")}        ${bold(run.runId)}`);
			console.log(`${cyan("Session:")}    ${run.sessionId}`);
			console.log(`${cyan("Device:")}     ${run.deviceId}`);
			console.log(`${cyan("Revision:")}   ${run.revision}`);
			console.log(
				`${cyan("Worker:")}     ${run.workerOnline ? "online" : "offline"}`,
			);
			console.log(`${cyan("Executor:")}   ${run.executorState ?? "unknown"}`);
			console.log(`${cyan("Queued:")}     ${run.pendingEvents ? "yes" : "no"}`);
			console.log(
				`${cyan("Affinity:")}   ${run.sessionAffinityDeviceId ?? "released"}`,
			);
			console.log(
				`${cyan("Issue lock:")} ${run.issueLockSessionId ?? "released"}`,
			);
			if (run.sessionClaimedMsAgo !== undefined) {
				// The third precondition recovery applies is `containers.affinityGraceMs`
				// (10 minutes by default), which this command cannot read. Reported raw
				// so a drive measures it against its own router configuration rather
				// than being told a guess.
				console.log(
					`${cyan("Claimed:")}    ${run.sessionClaimedMsAgo}ms ago (must exceed containers.affinityGraceMs)`,
				);
			}
		});
	return cmd;
}
