import { createNoopLogger, type ILogger } from "cyrus-core";
import {
	extractTraceContext,
	getTracer,
	recordSpanError,
	type Span,
	SpanKind,
	SpanStatusCode,
	withSpanActive,
} from "cyrus-otel-traces";
import type { FastifyInstance, FastifyRequest } from "fastify";

/** Instrumentation scope for spans produced by this plugin. */
const HTTP_TRACER_NAME = "cyrus-router-http";

/**
 * Paths that get neither a span nor a log line.
 *
 * `/healthz` is probed by the container platform every few seconds forever. It
 * would be the overwhelming majority of both signals, it answers no question
 * anyone asks of a trace, and at the default sample ratio of 1.0 it would set
 * the volume floor for the whole deployment. Its absence is not a blind spot:
 * a failing readiness probe surfaces as the platform cycling the replica, which
 * is far louder than a span.
 */
const DEFAULT_IGNORED_PATHS = ["/healthz"];

/**
 * Per-request state, hung off the Fastify request object under a symbol.
 *
 * A symbol rather than a string key so it cannot collide with a route's own
 * decorators, and so it does not appear in anything that enumerates the
 * request's own properties.
 */
const REQUEST_STATE = Symbol("cyrus.httpTracing");

interface RequestState {
	span: Span;
	startedAtMs: number;
}

export interface HttpTracingOptions {
	/** Where request lines go. Defaults to a no-op logger. */
	logger?: ILogger;
	/** Extra paths to skip, merged with {@link DEFAULT_IGNORED_PATHS}. */
	ignorePaths?: string[];
	/** Injectable clock for the duration measurement (tests). */
	now?: () => number;
}

/**
 * Add HTTP server spans and request logging to a Fastify instance.
 *
 * ── WHY A PLUGIN RATHER THAN FASTIFY'S OWN LOGGER ──
 * `RouterServer` constructs Fastify with no options, which disables its built-in
 * pino logger — so until now there was no request logging and no timing of any
 * kind. The fix is deliberately NOT to switch pino on. Fastify's logger writes
 * straight to stdout on its own path, bypassing `ILogger` entirely, which means
 * bypassing the `LogSink` seam and therefore the OTLP export the last three
 * phases were about. Request lines would end up in a different table from every
 * other line the router writes, with a different shape, and none of the
 * `cyrus.*` context. Going through `ILogger` keeps one pipeline.
 *
 * ── WHY NOT @opentelemetry/instrumentation-fastify ──
 * The official instrumentation is auto-instrumentation: it monkey-patches the
 * Fastify module and therefore must be loaded via an ESM loader hook
 * (`--import`/`register()`) before Fastify is imported. Every other piece of
 * Cyrus telemetry is deliberately free of that constraint (see
 * `startOtelLogging`'s note), and adding a loader hook to the router's
 * entrypoint would make telemetry a startup-ordering concern for the one
 * process that must never fail to start. Four hooks are the whole surface we
 * need.
 */
export function registerHttpTracing(
	fastify: FastifyInstance,
	options: HttpTracingOptions = {},
): void {
	const logger = options.logger ?? createNoopLogger();
	const now = options.now ?? (() => Date.now());
	const ignored = new Set([
		...DEFAULT_IGNORED_PATHS,
		...(options.ignorePaths ?? []),
	]);
	const tracer = () => getTracer(HTTP_TRACER_NAME);

	fastify.addHook("onRequest", (request, _reply, done) => {
		if (ignored.has(pathOf(request))) {
			done();
			return;
		}

		// The inbound trace context, if the caller sent one. Linear does not
		// today, so in practice this starts a new trace — but honouring it costs
		// nothing and is what makes a request from another instrumented Cyrus
		// component (or a curl with a traceparent, when debugging) join up
		// instead of forking.
		const parent = extractTraceContext({
			...(headerValue(request, "traceparent") !== undefined
				? { traceparent: headerValue(request, "traceparent") }
				: {}),
			...(headerValue(request, "tracestate") !== undefined
				? { tracestate: headerValue(request, "tracestate") }
				: {}),
		});

		// Named at onRequest time, before routing has resolved `http.route`, so
		// this is the method plus the raw path. `onResponse` renames it to the
		// semconv form once the route template is known — see below.
		const span = tracer().startSpan(
			`${request.method} ${pathOf(request)}`,
			{
				kind: SpanKind.SERVER,
				attributes: {
					"http.request.method": request.method,
					"url.path": pathOf(request),
					"url.scheme": request.protocol,
					"network.protocol.version": request.raw.httpVersion,
					...(request.hostname ? { "server.address": request.hostname } : {}),
				},
			},
			parent,
		);

		(request as unknown as Record<symbol, RequestState>)[REQUEST_STATE] = {
			span,
			startedAtMs: now(),
		};

		// `done()` is called INSIDE `context.with`, which is what makes the span
		// active for the rest of the request. Fastify continues its hook chain
		// synchronously from this call, and the AsyncLocalStorage context manager
		// carries the context through every `await` downstream — including the
		// `void eventRouter.route(event)` the webhook handler fires and does not
		// await, which is exactly the continuation this trace exists to follow.
		withSpanActive(
			span,
			() => {
				done();
			},
			parent,
		);
	});

	fastify.addHook("onError", (request, _reply, error, done) => {
		const state = stateOf(request);
		if (state) recordSpanError(state.span, error);
		done();
	});

	fastify.addHook("onResponse", (request, reply, done) => {
		const state = stateOf(request);
		if (!state) {
			done();
			return;
		}
		delete (request as unknown as Record<symbol, RequestState | undefined>)[
			REQUEST_STATE
		];

		const durationMs = now() - state.startedAtMs;
		const status = reply.statusCode;
		// Available only after routing, which is why the span is renamed here
		// rather than named correctly up front. The route TEMPLATE is the
		// low-cardinality value semconv asks for; `url.path` already carries the
		// concrete one as an attribute.
		const route = request.routeOptions?.url;

		state.span.setAttribute("http.response.status_code", status);
		if (route) {
			state.span.setAttribute("http.route", route);
			state.span.updateName(`${request.method} ${route}`);
		}
		// 4xx is deliberately NOT an error on a SERVER span, per semconv: the
		// request was handled correctly and the caller was told what was wrong.
		// Marking it red would bury the 5xx that means something is broken.
		if (status >= 500) {
			state.span.setStatus({
				code: SpanStatusCode.ERROR,
				message: `HTTP ${status}`,
			});
		}
		state.span.end();

		logRequest(logger, request, status, durationMs, route);
		done();
	});
}

/**
 * One request line, at a level chosen by what the status actually means.
 *
 * The router serves a public webhook endpoint, so 4xx is the routine noise of
 * the internet plus the occasional real signature failure — worth a warning,
 * not an error. 5xx is ours. Everything else is debug: at one line per webhook
 * this is cheap, but the sandbox artifact and workspace routes are chatty
 * enough that promoting them to info would drown the lifecycle events an
 * operator is actually reading.
 */
function logRequest(
	logger: ILogger,
	request: FastifyRequest,
	status: number,
	durationMs: number,
	route: string | undefined,
): void {
	const line = `${request.method} ${route ?? pathOf(request)} -> ${status} (${durationMs}ms)`;
	if (status >= 500) logger.error(line);
	else if (status >= 400) logger.warn(line);
	else logger.debug(line);
}

function stateOf(request: FastifyRequest): RequestState | undefined {
	return (request as unknown as Record<symbol, RequestState | undefined>)[
		REQUEST_STATE
	];
}

/**
 * The path with any query string removed.
 *
 * Stripping the query is not cosmetic. It is unvalidated caller input that ends
 * up in a span name and an attribute, and the router's own routes carry tokens
 * in query position (see the artifacts and enrollment routes). A secret that
 * reaches a telemetry backend has to be treated as disclosed.
 */
function pathOf(request: FastifyRequest): string {
	const raw = request.url;
	const queryAt = raw.indexOf("?");
	return queryAt === -1 ? raw : raw.slice(0, queryAt);
}

/**
 * A single-valued header, or `undefined`.
 *
 * A duplicated `traceparent` arrives as an array. Picking one arbitrarily would
 * be guessing at which trace the caller meant; treating it as absent starts a
 * clean trace, which is the honest outcome.
 */
function headerValue(
	request: FastifyRequest,
	name: string,
): string | undefined {
	const value = request.headers[name];
	return typeof value === "string" ? value : undefined;
}
