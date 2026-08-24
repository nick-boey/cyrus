import { SeverityNumber } from "@opentelemetry/api-logs";
import { LogLevel } from "cyrus-core";

/**
 * `LogLevel` → OpenTelemetry `SeverityNumber`.
 *
 * OTel's severity scale is finer-grained than ours (each named band has four
 * numeric slots: DEBUG..DEBUG4), so we map onto the *base* of each band. That
 * keeps the round trip lossless — an exporter that renders severity back to a
 * name gets exactly the level the call site used — and leaves the higher slots
 * free if we ever want a `trace`/`fatal` distinction.
 *
 * `SILENT` is deliberately absent: it is a threshold, not something a call site
 * can emit. `severityFor` treats it (and any unknown value) as UNSPECIFIED
 * rather than throwing, because a log line must never be the thing that breaks
 * the call it was describing.
 */
const SEVERITY_BY_LEVEL: Partial<Record<LogLevel, SeverityNumber>> = {
	[LogLevel.DEBUG]: SeverityNumber.DEBUG,
	[LogLevel.INFO]: SeverityNumber.INFO,
	[LogLevel.WARN]: SeverityNumber.WARN,
	[LogLevel.ERROR]: SeverityNumber.ERROR,
};

/**
 * Human-readable severity, carried alongside the number.
 *
 * The spec makes `SeverityText` the *original* level string from the source, so
 * we emit the same uppercase names the console renderer uses (`Logger`'s
 * `LEVEL_LABELS`). An operator grepping raw OTLP therefore sees the same tokens
 * as in the container's stdout.
 */
const SEVERITY_TEXT_BY_LEVEL: Partial<Record<LogLevel, string>> = {
	[LogLevel.DEBUG]: "DEBUG",
	[LogLevel.INFO]: "INFO",
	[LogLevel.WARN]: "WARN",
	[LogLevel.ERROR]: "ERROR",
};

export function severityFor(level: LogLevel): SeverityNumber {
	return SEVERITY_BY_LEVEL[level] ?? SeverityNumber.UNSPECIFIED;
}

export function severityTextFor(level: LogLevel): string | undefined {
	return SEVERITY_TEXT_BY_LEVEL[level];
}
