import { resourceFromAttributes } from "@opentelemetry/resources";
import type {
	LogRecordExporter,
	LogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import {
	BatchLogRecordProcessor,
	LoggerProvider,
	SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";
import type { LogSink } from "cyrus-core";
import { type LogLevel, setGlobalLogSink } from "cyrus-core";
import { OtelLogSink } from "./OtelLogSink.js";
import {
	buildResourceAttributes,
	type ResourceAttributeInput,
} from "./resource.js";

/**
 * Instrumentation scope name on every emitted record. Identifies these logs as
 * coming from the Cyrus logger bridge rather than from an auto-instrumentation,
 * which matters once anything else in the process starts emitting.
 */
const SCOPE_NAME = "cyrus-otel-logs";

export interface StartOtelLoggingOptions {
	/**
	 * Where records go. Injected rather than constructed here — this is the
	 * single seam that keeps the package vendor-neutral. The router bootstrap
	 * passes an Azure Monitor exporter; a self-host deployment could pass an
	 * OTLP/HTTP one, and tests pass an in-memory one.
	 */
	exporter: LogRecordExporter;
	/** Resource semconv for the emitting service. */
	resource: ResourceAttributeInput;
	/** Sink threshold. Defaults to INFO. */
	minLevel?: LogLevel;
	/**
	 * `"batch"` (default) buffers and exports on a timer — the only sane choice
	 * in production. `"simple"` exports synchronously per record and exists for
	 * tests, which would otherwise have to wait out a batch delay.
	 */
	processor?: "batch" | "simple";
	/**
	 * Install the sink process-wide via `setGlobalLogSink`. Defaults to `true`,
	 * which is what a bootstrap wants. Set `false` to build the pipeline without
	 * touching global state.
	 */
	install?: boolean;
	/** Version reported as the instrumentation scope version. */
	scopeVersion?: string;
}

export interface OtelLoggingHandle {
	/** The sink, whether or not it was installed globally. */
	readonly sink: OtelLogSink;
	/** Resource attributes actually applied, for startup diagnostics and tests. */
	readonly resourceAttributes: Record<string, string>;
	/** Flush buffered records without tearing the pipeline down. */
	forceFlush(): Promise<void>;
	/**
	 * Flush and shut down. Restores the previously-installed sink first, so
	 * anything logged during the rest of shutdown still reaches the console
	 * rather than a provider that is closing underneath it.
	 *
	 * Idempotent: a SIGTERM handler and a `finally` block may both call it.
	 */
	shutdown(): Promise<void>;
}

/**
 * Build an OTel logs pipeline and point the Cyrus logger at it.
 *
 * ── NO ESM LOADER HOOK IS REQUIRED ──
 * OTel on ESM needs `register()`/`--import` only for *auto-instrumentation*,
 * which monkey-patches modules (`http`, `pg`, …) and therefore has to run before
 * those modules are imported. This bridge patches nothing: it calls the Logs API
 * directly from a sink the application installs. So it can be started at any
 * point in the bootstrap, and records emitted before it starts simply go to the
 * console — no loader hook, no `--import` flag, no import-order constraint.
 */
export function startOtelLogging(
	options: StartOtelLoggingOptions,
): OtelLoggingHandle {
	const resourceAttributes = buildResourceAttributes(options.resource);

	const processor: LogRecordProcessor =
		options.processor === "simple"
			? new SimpleLogRecordProcessor({ exporter: options.exporter })
			: new BatchLogRecordProcessor({ exporter: options.exporter });

	const provider = new LoggerProvider({
		resource: resourceFromAttributes(resourceAttributes),
		processors: [processor],
	});

	const sink = new OtelLogSink({
		logger: provider.getLogger(
			SCOPE_NAME,
			options.scopeVersion ?? options.resource.serviceVersion,
		),
		...(options.minLevel !== undefined ? { minLevel: options.minLevel } : {}),
	});

	// Deliberately NOT registered as the OTel *global* logger provider. Doing so
	// would also capture any third-party library that grabs a logger off the
	// global API, which is a much wider blast radius than "back ILogger with
	// OTLP" and would make the volume we pay for depend on our dependencies.
	let previousSink: LogSink | undefined;
	let installed = false;
	if (options.install !== false) {
		previousSink = setGlobalLogSink(sink);
		installed = true;
	}

	let shuttingDown: Promise<void> | undefined;

	return {
		sink,
		resourceAttributes,
		forceFlush: () => provider.forceFlush(),
		shutdown: () => {
			if (shuttingDown) return shuttingDown;
			// Restore BEFORE shutting the provider down: `provider.shutdown()`
			// awaits an export, and anything logged in the meantime would otherwise
			// be handed to a closing pipeline and lost silently.
			if (installed && previousSink) setGlobalLogSink(previousSink);
			shuttingDown = provider.shutdown();
			return shuttingDown;
		},
	};
}
