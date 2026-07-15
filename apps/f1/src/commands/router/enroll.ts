/**
 * router:enroll - Mint + redeem a physical-device enrollment code, print the token
 */

import { Command } from "commander";
import { success } from "../../utils/colors.js";
import { controlPost } from "./controlClient.js";

interface RouterEnrollOptions {
	email: string;
}

interface EnrollResult {
	deviceToken: string;
}

export function createRouterEnrollCommand(): Command {
	const cmd = new Command("router:enroll");
	cmd
		.description(
			"Mint + redeem a physical-device enrollment code, print the token",
		)
		.requiredOption("-e, --email <email>", "User email to enroll")
		.action(async (o: RouterEnrollOptions) => {
			const res = (await controlPost("/router/enroll", {
				email: o.email,
			})) as EnrollResult;
			console.log(success(`Device token: ${res.deviceToken}`));
		});
	return cmd;
}
