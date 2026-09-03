/**
 * Versioned wire contracts for Cyrus remote operations.
 *
 * The router's fleet-operations module and the CLI's remote-operator commands
 * both depend on THIS package and never on each other. Everything here is a
 * schema, an inferred type, or a pure encoder — no transport, no storage, no
 * cloud SDK.
 *
 * Every document carries a literal `schemaVersion: 1`. Timestamps are ISO-8601
 * UTC strings, IDs are strings, and enums are closed.
 */

export * from "./discovery.js";
export * from "./identity.js";
export * from "./logs.js";
export * from "./primitives.js";
export * from "./recoveries.js";
export * from "./runs.js";
