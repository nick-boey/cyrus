import { chmodSync } from "node:fs";
import type { EdgeConfig, OperatorConnectionConfig } from "cyrus-core";
import { UsageError } from "./errors.js";

/**
 * A stored connection together with the name it is selected by.
 */
export interface OperatorConnectionRecord {
	name: string;
	connection: OperatorConnectionConfig;
}

/**
 * The config-file operations {@link ConnectionStore} needs.
 *
 * Narrowed to three methods so a test can supply an in-memory config without
 * standing up a `ConfigService`, an `Application`, and a `~/.cyrus` directory —
 * and so nothing else in the remote module can reach the rest of the config.
 */
export interface ConnectionStorePersistence {
	load(): EdgeConfig;
	save(config: EdgeConfig): void;
	getConfigPath(): string;
}

/**
 * A connection name must be usable as a `--connection` argument and readable in
 * a table, so no whitespace, no leading dash (Commander would read it as a
 * flag), and no shell metacharacters an operator would have to quote.
 */
const CONNECTION_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The ONLY thing that reads or writes stored operator connections.
 *
 * Every other module in `remote/` takes a resolved
 * {@link OperatorConnectionRecord} and never learns that config.json exists.
 * That is what keeps "where connections live" a single decision: today the
 * `operatorConnections` map inside config.json, tomorrow possibly its own file,
 * with the fleet commands unchanged either way.
 *
 * Deliberately does NOT touch the singular `router` block. That is the
 * device-enrollment connection written by `cyrus connect`, holds a device token
 * whose least-privilege scope ADR 0009 forbids broadening, and answers a
 * different question than operator access does.
 */
export class ConnectionStore {
	constructor(private readonly persistence: ConnectionStorePersistence) {}

	/** Every stored connection, ordered by name so output is stable. */
	list(): OperatorConnectionRecord[] {
		const stored = this.persistence.load().operatorConnections ?? {};
		return Object.entries(stored)
			.map(([name, connection]) => ({ name, connection }))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	get(name: string): OperatorConnectionConfig | undefined {
		return this.persistence.load().operatorConnections?.[name];
	}

	has(name: string): boolean {
		return this.get(name) !== undefined;
	}

	/**
	 * Persists a new connection.
	 *
	 * Refuses to overwrite an existing name rather than replacing it: `add` is
	 * the command an operator runs when setting up a SECOND router, and silently
	 * repointing the first one is how a fleet command ends up reading the wrong
	 * environment while reporting the name the operator expected.
	 */
	add(name: string, connection: OperatorConnectionConfig): void {
		assertValidConnectionName(name);
		const config = this.persistence.load();
		const existing = config.operatorConnections ?? {};
		if (existing[name]) {
			throw new UsageError(
				`A connection named "${name}" already exists (${existing[name].url}). ` +
					`Remove it first with \`cyrus connection remove ${name}\`, or choose another name.`,
			);
		}
		this.write({
			...config,
			operatorConnections: { ...existing, [name]: connection },
		});
	}

	remove(name: string): void {
		const config = this.persistence.load();
		const existing = config.operatorConnections ?? {};
		if (!existing[name]) {
			throw new UsageError(
				unknownConnectionMessage(name, Object.keys(existing)),
			);
		}
		const { [name]: _removed, ...rest } = existing;
		this.write({ ...config, operatorConnections: rest });
	}

	/**
	 * Resolves the connection a fleet command should use.
	 *
	 * One stored connection is selected implicitly; more than one requires
	 * `--connection`. The ambiguity is refused rather than resolved by "first",
	 * "most recent", or a stored default: the commands built on this observe and
	 * recover live agent runs, and guessing which fleet the operator meant is
	 * exactly the guess that must not be made silently.
	 */
	select(name?: string): OperatorConnectionRecord {
		const records = this.list();
		if (name !== undefined) {
			const match = records.find((record) => record.name === name);
			if (!match) {
				throw new UsageError(
					unknownConnectionMessage(
						name,
						records.map((record) => record.name),
					),
				);
			}
			return match;
		}
		if (records.length === 0) {
			throw new UsageError(
				"No router connections are configured. Add one with `cyrus connection add <name> <url> --auth entra`.",
			);
		}
		if (records.length > 1) {
			throw new UsageError(
				`Multiple router connections are configured (${records
					.map((record) => record.name)
					.join(", ")}). Select one with \`--connection <name>\`.`,
			);
		}
		return records[0] as OperatorConnectionRecord;
	}

	/**
	 * Writes config.json back and re-tightens its mode to 0600.
	 *
	 * A stored operator connection carries no credential, but the same file
	 * holds `router.deviceToken`, and `ConfigService.save()` writes with the
	 * process umask. Re-applying the mode here means a `cyrus connection` on a
	 * fresh machine cannot be the command that leaves a device token
	 * world-readable. Best-effort: `chmod` is meaningless on Windows and its
	 * failure must not lose the operator's connection.
	 */
	private write(config: EdgeConfig): void {
		this.persistence.save(config);
		try {
			chmodSync(this.persistence.getConfigPath(), 0o600);
		} catch {
			// Ignored — see above.
		}
	}
}

export function assertValidConnectionName(name: string): void {
	if (!CONNECTION_NAME_PATTERN.test(name)) {
		throw new UsageError(
			`"${name}" is not a valid connection name. Use letters, digits, dots, dashes, or underscores, starting with a letter or digit.`,
		);
	}
}

/**
 * Validates a router origin and returns it without a trailing slash.
 *
 * `ws://` and `wss://` are refused explicitly rather than falling into the
 * generic message: the router's device URL in `config.json` IS a `wss://` URL,
 * so it is the value an operator is most likely to paste here, and telling them
 * "use the https:// origin" is the whole answer.
 */
export function normalizeConnectionUrl(url: string): string {
	const trimmed = url.trim();
	if (/^wss?:\/\//i.test(trimmed)) {
		throw new UsageError(
			`"${trimmed}" is a WebSocket URL. Use the router's HTTP origin instead (https://… or http://…).`,
		);
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new UsageError(
			`"${trimmed}" is not a valid URL. Pass the router's origin, e.g. https://router.example.com.`,
		);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new UsageError(
			`"${trimmed}" must use http:// or https://, not ${parsed.protocol}//.`,
		);
	}
	if (parsed.search || parsed.hash) {
		throw new UsageError(
			`"${trimmed}" must be an origin without a query string or fragment.`,
		);
	}
	return trimmed.replace(/\/+$/, "");
}

function unknownConnectionMessage(name: string, known: string[]): string {
	return known.length === 0
		? `No connection named "${name}". No connections are configured; add one with \`cyrus connection add <name> <url> --auth entra\`.`
		: `No connection named "${name}". Known connections: ${[...known].sort().join(", ")}.`;
}
