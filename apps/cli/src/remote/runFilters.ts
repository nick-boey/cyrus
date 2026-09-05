import {
	type RunLifecycleStateV1,
	type RunObservationV1,
	runLifecycleStateV1Schema,
} from "cyrus-operator-protocol";
import { UsageError } from "./errors.js";

/**
 * The one filter vocabulary `runs list`, `runs watch`, and `runs wait` share.
 *
 * Parsing, validation, translation to router query parameters, and the few
 * filters the router cannot apply all live here together because they fail as
 * one thing: a filter that parses but is never sent returns a SUPERSET of what
 * was asked for, and a caller reads that superset as the answer to its narrow
 * question. Keeping the three steps in one module is what makes "every filter is
 * applied somewhere" a property you can read off a single file.
 */

/**
 * The filters as the operator typed them.
 *
 * `workspace`, `owner`, `team`, and `project` accept a canonical id OR the name
 * captured beside it when the run was routed; the router resolves those, and
 * refuses a name matching more than one id rather than picking. The rest are
 * matched literally.
 */
export interface RunFilters {
	workspace?: string;
	owner?: string;
	team?: string;
	project?: string;
	/** A run id. */
	run?: string;
	/** An agent session id. */
	session?: string;
	/** A Linear issue identifier (`NOR-402`) or issue id. */
	issue?: string;
	state?: RunLifecycleStateV1;
	runner?: string;
	model?: string;
	/** The Linear comment that started or joined a run. Applied locally. */
	comment?: string;
	/** ISO instant; keeps runs routed at or after it. Applied locally. */
	routedAfter?: string;
}

/** Flag → field, in the order `describeRunFilters` renders them. */
const FILTER_FLAGS = [
	["--workspace", "workspace"],
	["--owner", "owner"],
	["--team", "team"],
	["--project", "project"],
	["--run", "run"],
	["--session", "session"],
	["--issue", "issue"],
	["--state", "state"],
	["--runner", "runner"],
	["--model", "model"],
	["--comment", "comment"],
	["--routed-after", "routedAfter"],
] as const satisfies ReadonlyArray<readonly [string, keyof RunFilters]>;

export const RUN_FILTER_FLAGS: readonly string[] = FILTER_FLAGS.map(
	([flag]) => flag,
);

/**
 * Consumes the filter flags out of an argv, leaving everything else alone.
 *
 * Returns the leftovers rather than rejecting them so each subcommand keeps
 * owning its own options (`--json`, `--timeout`, a positional run id) — and so
 * an unknown flag is reported by the subcommand that knows what IS valid there,
 * rather than by this module listing filters at someone who mistyped `--json`.
 */
export function parseRunFilters(argv: readonly string[]): {
	filters: RunFilters;
	rest: string[];
} {
	const filters: RunFilters = {};
	const rest: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		const match = FILTER_FLAGS.find(([flag]) => flag === arg);
		if (!match) {
			rest.push(arg);
			continue;
		}
		const [flag, field] = match;
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("-")) {
			throw new UsageError(`${flag} requires a value.`);
		}
		i++;
		assignFilter(filters, field, flag, value);
	}
	return { filters, rest };
}

function assignFilter(
	filters: RunFilters,
	field: keyof RunFilters,
	flag: string,
	value: string,
): void {
	if (field === "state") {
		const parsed = runLifecycleStateV1Schema.safeParse(value);
		if (!parsed.success) {
			// Named exhaustively rather than "invalid state": the vocabulary
			// changed (`parked` became a worker-reported `waiting`), so the most
			// likely wrong value is one that used to be right.
			throw new UsageError(
				`--state must be one of ${runLifecycleStateV1Schema.options.join(", ")}, not "${value}".`,
			);
		}
		filters.state = parsed.data;
		return;
	}
	if (field === "routedAfter") {
		if (!Number.isFinite(Date.parse(value))) {
			throw new UsageError(
				`--routed-after must be an ISO-8601 instant, e.g. 2026-09-02T00:00:00Z, not "${value}".`,
			);
		}
		filters.routedAfter = value;
		return;
	}
	if (value.length === 0) {
		throw new UsageError(`${flag} requires a value.`);
	}
	filters[field] = value as never;
}

/**
 * Which `GET /api/v1/runs` parameters carry each filter.
 *
 * `comment` and `routedAfter` are deliberately absent — see
 * {@link matchesLocalRunFilters}. The route refuses an unknown parameter with a
 * 400, so adding one here without adding it there breaks every query.
 */
export function toRunsQuery(
	filters: RunFilters,
	workspaceId: string,
): Record<string, string> {
	const query: Record<string, string> = { workspace: workspaceId };
	if (filters.owner) query.owner = filters.owner;
	if (filters.team) query.team = filters.team;
	if (filters.project) query.project = filters.project;
	if (filters.run) query.runId = filters.run;
	if (filters.session) query.agentSessionId = filters.session;
	if (filters.issue) {
		// A Linear identifier and an issue id are different columns, and the
		// router matches each literally. The shapes do not overlap — an id is a
		// UUID — so the choice is decidable rather than a guess.
		query[looksLikeIssueIdentifier(filters.issue) ? "issueKey" : "issueId"] =
			filters.issue;
	}
	if (filters.state) query.state = filters.state;
	if (filters.runner) query.runner = filters.runner;
	if (filters.model) query.model = filters.model;
	return query;
}

/** `NOR-402`, `CYPACK-1478` — a Linear issue identifier rather than an id. */
function looksLikeIssueIdentifier(value: string): boolean {
	return /^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(value);
}

/**
 * The filters the router does not implement, applied to one observation.
 *
 * Only `comment` and `routedAfter` land here, and each because the fleet
 * vocabulary carries a fact `GET /api/v1/runs` has no parameter for: a run's
 * comment provenance lives inside its `inputs` array, and the route offers no
 * time bound at all. Every other filter is applied by the router, and is NOT
 * re-checked here — the router may have resolved a captured name to a canonical
 * id, and re-comparing the operator's raw text against the resolved value would
 * throw away exactly the runs the resolution found.
 *
 * The cost of applying these two client-side is that they narrow a page AFTER
 * pagination, so `runs list` fetches every page before filtering. That is why
 * it fetches every page rather than stopping at a count.
 */
export function matchesLocalRunFilters(
	observation: RunObservationV1,
	filters: RunFilters,
): boolean {
	if (
		filters.comment !== undefined &&
		!observation.inputs.some((input) => input.commentId === filters.comment)
	) {
		return false;
	}
	if (filters.routedAfter !== undefined) {
		const threshold = Date.parse(filters.routedAfter);
		// The LATEST routing instant, not the first: a run started yesterday that
		// received input a minute ago is exactly the run an operator asking "what
		// moved recently" needs to see.
		const latest = Math.max(
			Date.parse(observation.routing.routedAt),
			...observation.inputs.map((input) => Date.parse(input.routedAt)),
		);
		if (!(latest >= threshold)) return false;
	}
	return true;
}

/** A one-line rendering of the applied filters, for a diagnostic. */
export function describeRunFilters(filters: RunFilters): string {
	const parts = FILTER_FLAGS.filter(
		([, field]) => filters[field] !== undefined,
	).map(([flag, field]) => `${flag.replace(/^--/, "")}=${filters[field]}`);
	return parts.length === 0 ? "none" : parts.join(" ");
}
