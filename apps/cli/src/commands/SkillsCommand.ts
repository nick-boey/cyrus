import type { OperatorContextV1 } from "cyrus-operator-protocol";
import type { Application } from "../Application.js";
import { ConnectionStore } from "../remote/ConnectionStore.js";
import {
	createCredentialProvider,
	type EntraCredentialCandidate,
} from "../remote/credentials.js";
import { redactSecrets, UsageError } from "../remote/errors.js";
import { exitCodeFor } from "../remote/exitCodes.js";
import { OperatorHttpClient } from "../remote/OperatorHttpClient.js";
import {
	SkillInstaller,
	type SupportedAgent,
} from "../remote/skills/SkillInstaller.js";
import {
	TRUSTED_SKILL_NAME,
	TrustedSkillRegistry,
} from "../remote/skills/TrustedSkillRegistry.js";
import { BaseCommand } from "./ICommand.js";

export interface SkillsCommandContext {
	connection?: string;
}
export interface SkillsCommandDeps {
	fetchFn?: typeof fetch;
	env?: NodeJS.ProcessEnv;
	entraChain?: EntraCredentialCandidate[];
	homeDir?: string;
}

export class SkillsCommand extends BaseCommand {
	private readonly store: ConnectionStore;
	constructor(
		app: Application,
		private readonly deps: SkillsCommandDeps = {},
	) {
		super(app);
		this.store = new ConnectionStore(app.config);
	}

	async execute(
		argv: string[],
		context: SkillsCommandContext = {},
	): Promise<void> {
		try {
			await this.run(argv, context);
		} catch (error) {
			const code = exitCodeFor(error);
			if (code === undefined) throw error;
			this.logger.error(redactSecrets((error as Error).message));
			process.exit(code);
		}
	}

	async run(argv: string[], context: SkillsCommandContext = {}): Promise<void> {
		const [subcommand, ...args] = argv;
		if (subcommand === "list") return this.list(context);
		if (subcommand === "install") return this.install(args, context);
		throw new UsageError(
			"Usage: cyrus skills <list|install cyrus-fleet-operator --target <claude|codex>> [--connection <name>]",
		);
	}

	private async list(context: SkillsCommandContext): Promise<void> {
		const records = context.connection
			? [this.store.select(context.connection)]
			: this.store.list();
		if (records.length === 0)
			throw new UsageError(
				"No router connections are configured. Add one with `cyrus connection add`.",
			);
		let found = false;
		for (const record of records) {
			const operator = await this.context(record);
			if (!operator.skill) continue;
			try {
				const release = new TrustedSkillRegistry(this.app.version).resolve(
					operator.skill,
				);
				this.logger.raw(
					`${record.name}\t${release.name}\t${release.version}\tcompatible`,
				);
				found = true;
			} catch (error) {
				this.logger.raw(
					`${record.name}\t${operator.skill.name}\t${operator.skill.version}\tincompatible: ${(error as Error).message}`,
				);
			}
		}
		if (!found)
			this.logger.raw(
				"No trusted compatible fleet skills are advertised by the authenticated connection context.",
			);
	}

	private async install(
		args: string[],
		context: SkillsCommandContext,
	): Promise<void> {
		const name = args[0];
		let target: string | undefined;
		for (let i = 1; i < args.length; i++) {
			if (args[i] === "--target" && args[i + 1]) target = args[++i];
			else throw new UsageError(`Unknown skills install argument: ${args[i]}`);
		}
		if (name !== TRUSTED_SKILL_NAME || !target)
			throw new UsageError(
				"Usage: cyrus skills install cyrus-fleet-operator --target <claude|codex>",
			);
		const record = this.store.select(context.connection);
		const operator = await this.context(record);
		if (!operator.skill)
			throw new UsageError(
				"The authenticated router context does not advertise a compatible operator skill.",
			);
		const release = new TrustedSkillRegistry(this.app.version).resolve(
			operator.skill,
		);
		const destination = await new SkillInstaller({
			fetchFn: this.deps.fetchFn,
			homeDir: this.deps.homeDir,
		}).install(release, target as SupportedAgent);
		this.logSuccess(
			`Installed ${release.name} ${release.version} for ${target} at ${destination}.`,
		);
	}

	private async context(
		record: ReturnType<ConnectionStore["select"]>,
	): Promise<OperatorContextV1> {
		const client = new OperatorHttpClient({
			baseUrl: record.connection.url,
			fetchFn: this.deps.fetchFn,
			credentials: createCredentialProvider(record.connection, {
				env: this.deps.env,
				entraChain: this.deps.entraChain,
			}),
		});
		return (await client.context()).context;
	}
}
