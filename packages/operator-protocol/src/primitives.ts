import { z } from "zod";

/**
 * Scalars shared by every v1 operator document.
 *
 * This package is a WIRE CONTRACT and nothing else: no router, Fastify,
 * Commander, Azure, or filesystem imports, so both sides can depend on it
 * without depending on each other's implementation.
 */

/**
 * Every timestamp on the wire is an ISO-8601 instant in UTC — `Z`, never a
 * numeric offset.
 *
 * Zod's default `z.iso.datetime()` already refuses offsets, and that is the
 * behaviour we want rather than an accident: change cursors and run histories
 * are ordered by comparing these strings, and `2026-09-03T10:00:00+10:00`
 * sorts before `2026-09-03T09:00:00Z` while denoting a LATER instant. Pinning
 * UTC keeps lexicographic order and chronological order the same thing.
 */
export const isoTimestampV1Schema = z.iso.datetime();

/** IDs are opaque non-empty strings — never numbers, so no precision is lost. */
export const identifierV1Schema = z.string().min(1);

/**
 * The version of a run observation, incremented on each material change.
 * A recovery request quotes the revision it inspected, so this must be an
 * exact integer rather than anything a float could round.
 */
export const revisionV1Schema = z.int().nonnegative();

/** Marks the literal `schemaVersion: 1` every v1 document carries. */
export const schemaVersionV1Schema = z.literal(1);
