/**
 * Master switch. Tracing is **off** unless this is explicitly truthy, so adding
 * this package to a dependency tree changes nothing until an operator opts in.
 *
 * Deliberately separate from `CYRUS_OTEL_LOGS_ENABLED`. The two signals have
 * very different costs and very different blast radii — traces add a global
 * context manager and a propagator to the process, logs add neither — and an
 * operator turning one off during an incident must not lose the other.
 */
export const OTEL_TRACES_ENABLED_ENV = "CYRUS_OTEL_TRACES_ENABLED";

/**
 * Head-sampling ratio for ROOT spans, in `[0, 1]`. See
 * `docs/adr/0004-parent-based-head-sampling-for-traces.md`.
 *
 * Only consulted for a span with no remote parent — a span that inherits a
 * sampled `traceparent` is always recorded and a span that inherits an
 * unsampled one never is, whatever this says. That is the whole point of
 * parent-based sampling: the sandbox worker must not be able to disagree with
 * the router about whether this trace is being collected.
 */
export const OTEL_TRACES_SAMPLE_RATIO_ENV = "CYRUS_OTEL_TRACES_SAMPLE_RATIO";

/**
 * Sample everything by default.
 *
 * Cyrus root spans are driven by human actions — someone assigns an issue,
 * someone posts a prompt — so the rate is issues-per-day, not
 * requests-per-second. Dropping traces to save ingestion cost that is already
 * negligible, at the price of not having the one trace someone asks about, is
 * the wrong trade at this volume. The knob exists because that reasoning is
 * about today's volume rather than a law.
 */
export const DEFAULT_SAMPLE_RATIO = 1;

/**
 * Whether tracing is enabled. Accepts `true`/`1`/`yes`/`on`
 * (case-insensitive), matching {@link isOtelLoggingEnabled}'s contract in
 * `cyrus-otel-logs` so an operator does not have to remember two spellings.
 *
 * Anything else — including unset or empty — is `false`. There is deliberately
 * no "enable on any non-empty value" behavior: `ENABLED=false` must mean
 * disabled.
 */
export function isOtelTracingEnabled(env: NodeJS.ProcessEnv): boolean {
	switch (env[OTEL_TRACES_ENABLED_ENV]?.trim().toLowerCase()) {
		case "true":
		case "1":
		case "yes":
		case "on":
			return true;
		default:
			return false;
	}
}

/**
 * Read the root-span sampling ratio from the environment.
 *
 * Returns `undefined` for an unset value so the caller applies its own default,
 * and CLAMPS rather than rejects an out-of-range number: an operator who typed
 * `100` meant "all of it", and refusing to start tracing over a fat-fingered
 * percentage would be a worse outcome than honouring the obvious intent. A
 * value that is not a number at all returns `undefined` — a typo must not
 * silently mean "sample nothing", which is the failure that looks exactly like
 * a broken exporter.
 */
export function readOtelSampleRatio(
	env: NodeJS.ProcessEnv,
): number | undefined {
	const raw = env[OTEL_TRACES_SAMPLE_RATIO_ENV]?.trim();
	if (!raw) return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value)) return undefined;
	return Math.min(1, Math.max(0, value));
}
