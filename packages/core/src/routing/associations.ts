/**
 * The `p=`/`t=` association string used by the router's setup UI to bind a
 * repository to Linear project and team names.
 *
 * Grammar: comma-separated `key=value` pairs. `p` (project name) and `t` (team
 * key) are the only keys and both are repeatable. A value may be double-quoted
 * to contain commas, equals signs, or edge whitespace; an unquoted value is
 * trimmed. Anything else is a parse error whose message is written to be shown
 * to a user verbatim.
 *
 *   p=Platform,p=Billing,t=NOR   ->  projects [Platform, Billing], teams [NOR]
 *   p="Q3 Migration",t=ENG       ->  projects [Q3 Migration],      teams [ENG]
 */

/** Parsed associations, in the order they were written. */
export interface RepositoryAssociations {
	projectKeys: string[];
	teamKeys: string[];
}

/** A malformed association string. `message` is user-facing copy. */
export class AssociationParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AssociationParseError";
	}
}

const KEY_HELP = "Use p= for a project name or t= for a team key.";

/**
 * Splits on commas that are not inside a double-quoted value.
 *
 * A plain `input.split(",")` would tear `p="Q3, Phase 2"` in half, so the scan
 * tracks quote state. A backslash inside quotes escapes the next character,
 * which is what lets a value contain a literal quote.
 */
function splitPairs(input: string): string[] {
	const pairs: string[] = [];
	let current = "";
	let inQuotes = false;
	let escaped = false;

	for (const char of input) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && inQuotes) {
			current += char;
			escaped = true;
			continue;
		}
		if (char === '"') {
			inQuotes = !inQuotes;
			current += char;
			continue;
		}
		if (char === "," && !inQuotes) {
			pairs.push(current);
			current = "";
			continue;
		}
		current += char;
	}
	if (inQuotes) throw new AssociationParseError("Unterminated quoted value.");
	pairs.push(current);
	return pairs;
}

/**
 * Reads one value, which is either a double-quoted string (returned with its
 * escapes resolved and its surrounding whitespace preserved) or a bare run of
 * characters (returned trimmed).
 */
function readValue(key: string, raw: string): string {
	const trimmed = raw.trim();
	if (!trimmed.startsWith('"')) {
		if (trimmed === "") {
			throw new AssociationParseError(`The value for "${key}" is empty.`);
		}
		return trimmed;
	}

	let value = "";
	let closed = false;
	let index = 1;
	for (; index < trimmed.length; index++) {
		const char = trimmed[index] as string;
		if (char === "\\" && index + 1 < trimmed.length) {
			index += 1;
			value += trimmed[index] as string;
			continue;
		}
		if (char === '"') {
			closed = true;
			index += 1;
			break;
		}
		value += char;
	}
	if (!closed) throw new AssociationParseError("Unterminated quoted value.");
	if (trimmed.slice(index).trim() !== "") {
		throw new AssociationParseError(
			`Unexpected characters after the closing quote in "${key}".`,
		);
	}
	if (value === "") {
		throw new AssociationParseError(`The value for "${key}" is empty.`);
	}
	return value;
}

/**
 * Appends `value` unless a case-insensitive equal is already present. Keeping
 * the FIRST spelling matters: it is what the UI renders back to the user, and
 * matching is case-insensitive anyway, so a later differing case carries no
 * information worth preserving.
 */
function pushUnique(target: string[], value: string): void {
	const folded = value.toLowerCase();
	if (target.some((existing) => existing.toLowerCase() === folded)) return;
	target.push(value);
}

export function parseAssociations(input: string): RepositoryAssociations {
	const result: RepositoryAssociations = { projectKeys: [], teamKeys: [] };
	if (input.trim() === "") return result;

	for (const pair of splitPairs(input)) {
		if (pair.trim() === "") continue;
		const separator = pair.indexOf("=");
		if (separator < 0) {
			throw new AssociationParseError(
				`Expected key=value but got "${pair.trim()}". ${KEY_HELP}`,
			);
		}
		const key = pair.slice(0, separator).trim().toLowerCase();
		const value = readValue(key, pair.slice(separator + 1));

		if (key === "p") pushUnique(result.projectKeys, value);
		else if (key === "t") pushUnique(result.teamKeys, value);
		else {
			throw new AssociationParseError(`Unknown key "${key}". ${KEY_HELP}`);
		}
	}
	return result;
}

/** True when `value` cannot be written bare without changing its meaning. */
function needsQuoting(value: string): boolean {
	return (
		value !== value.trim() ||
		value.includes(",") ||
		value.includes("=") ||
		value.includes('"') ||
		value === ""
	);
}

export function formatAssociations(input: {
	projectKeys?: string[];
	teamKeys?: string[];
}): string {
	const render = (key: string, value: string): string => {
		if (!needsQuoting(value)) return `${key}=${value}`;
		const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
		return `${key}="${escaped}"`;
	};
	return [
		...(input.projectKeys ?? []).map((value) => render("p", value)),
		...(input.teamKeys ?? []).map((value) => render("t", value)),
	].join(",");
}
