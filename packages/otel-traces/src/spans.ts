import {
	type Attributes,
	type Context,
	context as contextApi,
	type Span,
	SpanKind,
	SpanStatusCode,
	type Tracer,
	trace,
} from "@opentelemetry/api";

export type { Attributes, Context, Span, Tracer };
export { SpanKind, SpanStatusCode };

/**
 * Run `fn` with `span` as the active span, WITHOUT ending it.
 *
 * The counterpart to {@link withSpan} for spans whose lifetime is not a
 * function call — a Fastify request span, say, which is started in one hook and
 * ended in another. `startActiveSpan` cannot express that: it ends the span
 * when its callback returns.
 *
 * The caller owns `end()`. That is the trade being made deliberately, and the
 * reason this is not the default helper: a caller that forgets leaks a span,
 * which exports as nothing at all rather than as an error.
 */
export function withSpanActive<T>(span: Span, fn: () => T, base?: Context): T {
	return contextApi.with(trace.setSpan(base ?? contextApi.active(), span), fn);
}

/**
 * Get a tracer by instrumentation-scope name.
 *
 * Safe to call before — or entirely without — {@link startOtelTracing}: the API
 * hands back a no-op tracer whose spans cost a few object allocations and
 * record nothing. That is what lets instrumentation live permanently at a call
 * site in `packages/router` without the CLI or a self-host deployment paying
 * for it.
 */
export function getTracer(name: string, version?: string): Tracer {
	return trace.getTracer(name, version);
}

/**
 * The currently-active span, or `undefined` when nothing is active.
 *
 * For annotating a span from somewhere that did not start it — a branch several
 * frames below the `withSpan` call, typically. Prefer passing the span down
 * when the call chain is short; reach for this when threading it would mean
 * changing signatures purely to carry telemetry.
 *
 * Always optional-chain the result. `undefined` is the normal case in any
 * process that has not started tracing, which includes every test that does not
 * opt in.
 */
export function activeSpan(ctx?: Context): Span | undefined {
	return trace.getSpan(ctx ?? contextApi.active());
}

export interface SpanOptions {
	kind?: SpanKind;
	attributes?: Attributes;
	/** Parent context. Defaults to whatever is active. */
	context?: Context;
}

/**
 * Run `fn` inside a span, ending it exactly once and recording failure.
 *
 * The three things this exists to stop anyone getting wrong by hand:
 *
 *  1. **The span always ends.** `end()` is in a `finally`, so a throw, an early
 *     return, or a rejected promise cannot leak a span. A leaked span is not a
 *     missing span — it is a span with no duration that never exports, so the
 *     trace renders with a gap rather than an error.
 *  2. **A failure is recorded as one.** `recordException` plus
 *     `setStatus(ERROR)` is what makes a backend colour the span red and surface
 *     the stack; either alone leaves half the signal.
 *  3. **The span is ACTIVE for the duration of `fn`.** Anything `fn` starts
 *     becomes a child automatically, which is what makes nested instrumentation
 *     work without threading a parent through every signature.
 *
 * The span is deliberately NOT passed a success status. OTel's default is
 * `UNSET`, which means "no opinion"; explicitly setting `OK` is reserved for
 * cases where the application knows something the absence of an exception does
 * not tell it, and blanket-setting it would make that distinction unavailable.
 */
export function withSpan<T>(
	tracer: Tracer,
	name: string,
	options: SpanOptions,
	fn: (span: Span) => Promise<T>,
): Promise<T> {
	const parent = options.context ?? contextApi.active();
	return tracer.startActiveSpan(
		name,
		{
			kind: options.kind ?? SpanKind.INTERNAL,
			...(options.attributes ? { attributes: options.attributes } : {}),
		},
		parent,
		async (span) => {
			try {
				return await fn(span);
			} catch (err) {
				recordSpanError(span, err);
				throw err;
			} finally {
				span.end();
			}
		},
	);
}

/** Synchronous {@link withSpan}. Same guarantees, no `await`. */
export function withSpanSync<T>(
	tracer: Tracer,
	name: string,
	options: SpanOptions,
	fn: (span: Span) => T,
): T {
	const parent = options.context ?? contextApi.active();
	return tracer.startActiveSpan(
		name,
		{
			kind: options.kind ?? SpanKind.INTERNAL,
			...(options.attributes ? { attributes: options.attributes } : {}),
		},
		parent,
		(span) => {
			try {
				return fn(span);
			} catch (err) {
				recordSpanError(span, err);
				throw err;
			} finally {
				span.end();
			}
		},
	);
}

/**
 * Mark a span as failed from an unknown thrown value.
 *
 * Non-`Error` throws are common enough in this codebase's async plumbing
 * (rejected fetches, string rejections from provider SDKs) that stringifying
 * them here is worth more than the type narrowing costs. `recordException`
 * accepts a plain message, which is what produces a readable event rather than
 * `[object Object]`.
 */
export function recordSpanError(span: Span, err: unknown): void {
	if (err instanceof Error) {
		span.recordException(err);
		span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
		return;
	}
	const message = typeof err === "string" ? err : String(err);
	span.recordException({ name: "NonError", message });
	span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/**
 * Set an attribute only when the value is present.
 *
 * Emitting `undefined`/`null` attributes is worse than omitting them: an
 * absent attribute is queryable as absent, whereas a present-but-empty one
 * satisfies every `isnotnull()` predicate and reads as populated in a
 * dashboard. Same reasoning as `buildResourceAttributes` in `cyrus-otel-logs`.
 */
export function setSpanAttribute(
	span: Span,
	key: string,
	value: string | number | boolean | undefined | null,
): void {
	if (value === undefined || value === null) return;
	span.setAttribute(key, value);
}
