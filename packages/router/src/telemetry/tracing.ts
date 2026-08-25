import type { Tracer } from "cyrus-otel-traces";
import { getTracer } from "cyrus-otel-traces";

/**
 * Instrumentation scope for every span the router itself produces.
 *
 * Distinct from the sandbox worker's scope, which arrives on `span` frames and
 * is preserved verbatim by {@link SandboxSpanRelay}. Keeping them apart is what
 * lets a query separate "the router was slow" from "the worker was slow" without
 * having to know which span names belong to which process.
 */
export const ROUTER_TRACER_NAME = "cyrus-router";

/**
 * The router's span vocabulary.
 *
 * ── NAMING ──
 * Dotted lowercase with a domain segment first, matching the event vocabulary
 * in `cyrus-core`'s `CYRUS_EVENTS` and `SANDBOX_EVENTS`. The domain prefix is
 * load-bearing for the same reason it is there: `name startswith "sandbox."`
 * selects the whole sandbox family in one predicate.
 *
 * ── LOW CARDINALITY IS A HARD RULE, NOT A PREFERENCE ──
 * A span name is a grouping key in every tracing backend: latency percentiles,
 * error rates and sampling policies are all computed per name. Interpolating an
 * issue key or a session id into one does not enrich the trace, it destroys the
 * aggregate — every request becomes its own unique operation with a sample size
 * of one. Identity belongs in attributes, which is what `cyrus.*` is for.
 *
 * HTTP server spans are the deliberate exception and are NOT listed here: OTel
 * semconv specifies `{method} {http.route}` for them, and the route template
 * (`POST /linear-webhook`) is itself low-cardinality. See `httpTracing.ts`.
 */
export const ROUTER_SPANS = {
	/** One inbound webhook, from claim through to dispatch or refusal. */
	route: "router.route",
	/** Choosing which device/container an event goes to. */
	resolveTarget: "router.resolve_target",
	/** Choosing which repositories an issue's workspace will clone. */
	resolveRepository: "router.resolve_repository",
	/** Queueing an event for a device and, if it is online, sending it. */
	dispatch: "router.dispatch",
	/** Booting or resuming an issue's container, end to end. */
	sandboxBoot: "sandbox.boot",
	/** One lifecycle sweep tick. Root span for everything the sweep does. */
	sandboxSweep: "sandbox.sweep",
	/** One call to the Linear API. */
	linearRequest: "linear.request",
	/** One call to the ACA sandboxes data plane. */
	acaRequest: "aca.request",
} as const;

export type RouterSpanName = (typeof ROUTER_SPANS)[keyof typeof ROUTER_SPANS];

/**
 * The router's tracer.
 *
 * Resolved per call rather than cached in a module-level constant. The provider
 * is registered by `startRouterOtelTracing` during bootstrap, and a tracer
 * captured at import time would be the API's no-op — permanently, for the life
 * of the process. `trace.getTracer` is a map lookup, so there is nothing to
 * save by caching it.
 */
export function routerTracer(): Tracer {
	return getTracer(ROUTER_TRACER_NAME);
}
