/**
 * Date revival for RPC results.
 *
 * The issue-tracker types are `Pick<>`s of the Linear SDK's types, so fields
 * like `Comment.createdAt` are typed `Date`. In standalone mode the SDK hands
 * back real `Date` instances. In router mode the same objects cross a WebSocket
 * as JSON, and `JSON.parse` has no way to know a string was ever a `Date` — so
 * `createdAt` arrives as `"2026-07-10T04:25:41.345Z"` while TypeScript still
 * believes it is a `Date`. The cast in `RouterIssueTrackerService` hides this,
 * and the mismatch only surfaces at runtime as
 * `comment.createdAt.toISOString is not a function`.
 *
 * Reviving at the RPC boundary fixes every consumer at once, rather than making
 * each call site coerce defensively.
 *
 * @module date-revival
 */

/**
 * The only `Date`-typed fields on the RPC-returned issue-tracker types (`Issue`,
 * `Comment`, `IssueRelation`, `IssueRelationSummary`, `User`, `Team`, ...).
 *
 * Deliberately an allowlist rather than "revive anything that parses as a date":
 * an issue title of `"2026-01-01"` must stay a string.
 */
const DATE_KEYS = new Set(["createdAt", "updatedAt", "archivedAt"]);

/**
 * Strict ISO-8601 instant, the shape Linear's GraphQL DateTime scalar always
 * serializes to. A `DATE_KEYS` field holding anything else (an already-revived
 * `Date`, `null`, a malformed string) is left untouched rather than turned into
 * an `Invalid Date`.
 */
const ISO_INSTANT =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Walks a freshly-`JSON.parse`d RPC result and replaces ISO-8601 strings under
 * {@link DATE_KEYS} with `Date` instances.
 *
 * Mutates in place: the value has just been parsed from the wire and is owned by
 * the caller, so copying it would only add allocation. JSON cannot contain
 * cycles, so the recursion always terminates.
 */
export function reviveDates<T>(value: T): T {
	visit(value);
	return value;
}

function visit(node: unknown): void {
	if (node === null || typeof node !== "object") return;

	if (Array.isArray(node)) {
		for (const item of node) visit(item);
		return;
	}

	for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
		if (DATE_KEYS.has(key) && typeof child === "string") {
			if (ISO_INSTANT.test(child)) {
				(node as Record<string, unknown>)[key] = new Date(child);
			}
			continue;
		}
		visit(child);
	}
}
