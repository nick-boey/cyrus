import type { Attributes } from "@opentelemetry/api";
import { cyrusAttributes } from "cyrus-core";

/**
 * Move a bag of span attributes into the `cyrus.*` namespace, dropping absent
 * values.
 *
 * Delegates the namespacing rule to {@link cyrusAttributes} in `cyrus-core`
 * rather than reimplementing it. That rule — namespace a bare key, pass through
 * anything already containing a `.` — is what lets `exception.*`, `http.*` and
 * a future `gen_ai.*` ride alongside Cyrus-specific keys, and it must mean the
 * same thing on a span as it does on a log record. Two copies of it would
 * diverge the first time one is amended, and the symptom would be a saved query
 * that works against logs and silently returns nothing against traces.
 *
 * The one behavioural difference is `null`. A log attribute may be `null` —
 * `LogEventAttributes` permits it, and Log Analytics gives an explicit null a
 * useful "sampled but absent" meaning distinct from a missing column. OTel span
 * attributes have no null: the type does not admit one, and an exporter handed
 * one either drops it or stringifies it to `"null"`. So nulls are dropped here,
 * which restores the same "absent is queryable as absent" property that
 * `buildResourceAttributes` relies on.
 */
export function cyrusSpanAttributes(
	attributes: Record<string, string | number | boolean | null | undefined>,
): Attributes {
	const defined: Record<string, string | number | boolean | null> = {};
	for (const [key, value] of Object.entries(attributes)) {
		if (value === undefined || value === null) continue;
		defined[key] = value;
	}
	// Safe to widen: every value that survived the loop above is a primitive
	// OTel accepts, and `cyrusAttributes` only rewrites keys.
	return cyrusAttributes(defined) as Attributes;
}
