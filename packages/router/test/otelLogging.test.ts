import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import {
	createLogger,
	getGlobalLogSink,
	type ILogger,
	LogLevel,
	resetGlobalLogSink,
} from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	APPINSIGHTS_CONNECTION_STRING_ENV,
	type StartRouterOtelLoggingOptions,
	startRouterOtelLogging,
} from "../src/telemetry/otelLogging.js";

/** Enough of a connection string to get past the "is it set" check. */
const CONNECTION_STRING =
	"InstrumentationKey=00000000-0000-0000-0000-000000000000;IngestionEndpoint=https://example.invalid/";

const ENABLED_ENV: NodeJS.ProcessEnv = {
	CYRUS_OTEL_LOGS_ENABLED: "true",
	[APPINSIGHTS_CONNECTION_STRING_ENV]: CONNECTION_STRING,
};

describe("startRouterOtelLogging", () => {
	let exporter: InMemoryLogRecordExporter;
	let logger: ILogger;
	let warnings: string[];
	let infos: string[];

	/**
	 * Always injects the in-memory exporter. The default builds the real Azure
	 * Monitor exporter, which would try to reach the ingestion endpoint.
	 */
	function start(
		overrides: Partial<StartRouterOtelLoggingOptions> = {},
	): ReturnType<typeof startRouterOtelLogging> {
		return startRouterOtelLogging({
			env: ENABLED_ENV,
			logger,
			processor: "simple",
			createExporter: () => exporter,
			...overrides,
		});
	}

	beforeEach(() => {
		exporter = new InMemoryLogRecordExporter();
		warnings = [];
		infos = [];
		const base = createLogger({ component: "RouterCommand" });
		logger = {
			...base,
			warn: (message: string) => warnings.push(message),
			info: (message: string) => infos.push(message),
		} as ILogger;
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetGlobalLogSink();
	});

	describe("gating", () => {
		/**
		 * The single most important property of this change: a router that has not
		 * opted in behaves exactly as it did before, and no upstream CLI user pays
		 * anything for this code existing.
		 */
		it("is disabled when the flag is unset, leaving the console sink untouched", () => {
			const before = getGlobalLogSink();
			expect(start({ env: {} })).toBeUndefined();
			expect(getGlobalLogSink()).toBe(before);
			expect(warnings).toEqual([]);
		});

		it("is disabled when the flag is explicitly false", () => {
			expect(
				start({
					env: {
						CYRUS_OTEL_LOGS_ENABLED: "false",
						[APPINSIGHTS_CONNECTION_STRING_ENV]: CONNECTION_STRING,
					},
				}),
			).toBeUndefined();
		});

		it("does not even ask for an exporter when disabled", () => {
			// Constructing the Azure exporter parses the connection string and can
			// throw; a disabled path must not reach it at all.
			const createExporter = vi.fn(() => exporter);
			start({ env: {}, createExporter });
			expect(createExporter).not.toHaveBeenCalled();
		});

		/**
		 * Warns rather than throwing: telemetry misconfiguration must not stop the
		 * router from routing issues. The warning itself reaches Log Analytics via
		 * the Phase 0 JSON stdout path.
		 */
		it("warns and stays disabled when enabled without a connection string", () => {
			expect(
				start({ env: { CYRUS_OTEL_LOGS_ENABLED: "true" } }),
			).toBeUndefined();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain(APPINSIGHTS_CONNECTION_STRING_ENV);
		});

		it("treats a blank connection string as absent", () => {
			expect(
				start({
					env: {
						CYRUS_OTEL_LOGS_ENABLED: "true",
						[APPINSIGHTS_CONNECTION_STRING_ENV]: "   ",
					},
				}),
			).toBeUndefined();
			expect(warnings).toHaveLength(1);
		});

		it("installs the sink and reports what it did when fully configured", () => {
			const handle = start();
			try {
				expect(handle).toBeDefined();
				expect(getGlobalLogSink()).toBe(handle?.sink);
				expect(infos.join()).toContain("OpenTelemetry log export enabled");
			} finally {
				void handle?.shutdown();
			}
		});

		it("passes the connection string through to the exporter factory", () => {
			const createExporter = vi.fn(() => exporter);
			const handle = start({ createExporter });
			try {
				expect(createExporter).toHaveBeenCalledWith(CONNECTION_STRING);
			} finally {
				void handle?.shutdown();
			}
		});
	});

	describe("resource attributes", () => {
		it("stamps the Azure platform values, which never come from core", () => {
			const handle = start();
			try {
				expect(handle?.resourceAttributes).toMatchObject({
					"cloud.provider": "azure",
					"cloud.platform": "azure_container_apps",
				});
			} finally {
				void handle?.shutdown();
			}
		});

		it("derives service identity from the ACA-injected env vars", () => {
			const handle = start({
				env: {
					...ENABLED_ENV,
					CONTAINER_APP_NAME: "ca-cyrus-router",
					CONTAINER_APP_REVISION: "ca-cyrus-router--rev7",
					CONTAINER_APP_REPLICA_NAME: "ca-cyrus-router--rev7-abcde-1",
				},
			});
			try {
				expect(handle?.resourceAttributes).toMatchObject({
					"service.name": "ca-cyrus-router",
					"service.version": "ca-cyrus-router--rev7",
					"service.instance.id": "ca-cyrus-router--rev7-abcde-1",
				});
			} finally {
				void handle?.shutdown();
			}
		});

		it("defaults service.name when the platform does not name the app", () => {
			const handle = start();
			try {
				expect(handle?.resourceAttributes["service.name"]).toBe("cyrus-router");
			} finally {
				void handle?.shutdown();
			}
		});

		it("prefers the build version over the ACA revision", () => {
			// The revision is a deployment identifier, not a build identifier; the
			// CLI's own version is the more useful answer to "what code is this".
			const handle = start({
				env: { ...ENABLED_ENV, CONTAINER_APP_REVISION: "rev7" },
				serviceVersion: "0.2.66",
			});
			try {
				expect(handle?.resourceAttributes["service.version"]).toBe("0.2.66");
			} finally {
				void handle?.shutdown();
			}
		});

		it("lets every env override win over the platform value", () => {
			const handle = start({
				env: {
					...ENABLED_ENV,
					CONTAINER_APP_NAME: "platform-name",
					CONTAINER_APP_REVISION: "platform-rev",
					CONTAINER_APP_REPLICA_NAME: "platform-replica",
					CYRUS_OTEL_SERVICE_NAME: "override-name",
					CYRUS_OTEL_SERVICE_VERSION: "override-version",
					CYRUS_OTEL_SERVICE_INSTANCE_ID: "override-replica",
					CYRUS_OTEL_DEPLOYMENT_ENV: "staging",
					CYRUS_OTEL_CLOUD_REGION: "override-region",
				},
				serviceVersion: "0.2.66",
				fallbackRegion: "fallback-region",
			});
			try {
				expect(handle?.resourceAttributes).toMatchObject({
					"service.name": "override-name",
					"service.version": "override-version",
					"service.instance.id": "override-replica",
					"deployment.environment.name": "staging",
					"cloud.region": "override-region",
				});
			} finally {
				void handle?.shutdown();
			}
		});

		it("falls back to the configured ACA region for cloud.region", () => {
			const handle = start({ fallbackRegion: "australiaeast" });
			try {
				expect(handle?.resourceAttributes["cloud.region"]).toBe(
					"australiaeast",
				);
			} finally {
				void handle?.shutdown();
			}
		});

		it("omits cloud.region entirely when nothing supplies one", () => {
			const handle = start();
			try {
				expect(handle?.resourceAttributes).not.toHaveProperty("cloud.region");
			} finally {
				void handle?.shutdown();
			}
		});
	});

	describe("threshold", () => {
		it("reads the threshold from the environment", () => {
			const handle = start({
				env: { ...ENABLED_ENV, CYRUS_OTEL_LOGS_LEVEL: "warn" },
			});
			try {
				expect(handle?.sink.minLevel).toBe(LogLevel.WARN);
			} finally {
				void handle?.shutdown();
			}
		});

		it("defaults to INFO so debug volume stays local", () => {
			const handle = start();
			try {
				expect(handle?.sink.minLevel).toBe(LogLevel.INFO);
			} finally {
				void handle?.shutdown();
			}
		});

		it("ignores an unparseable level rather than shipping everything", () => {
			const handle = start({
				env: { ...ENABLED_ENV, CYRUS_OTEL_LOGS_LEVEL: "verbose" },
			});
			try {
				expect(handle?.sink.minLevel).toBe(LogLevel.INFO);
			} finally {
				void handle?.shutdown();
			}
		});
	});

	/**
	 * The end-to-end claim: an untouched call site anywhere in the router comes
	 * out of the pipeline as a structured record carrying the router's resource.
	 */
	it("exports an ordinary router log line as a structured record", async () => {
		const handle = start({ fallbackRegion: "australiaeast" });
		try {
			createLogger({ component: "EventRouter" })
				.withContext({ issueIdentifier: "NOR-281" })
				.warn("no repository matched");

			const exported = exporter.getFinishedLogRecords();
			expect(exported).toHaveLength(1);
			expect(exported[0]?.body).toBe("no repository matched");
			expect(exported[0]?.severityText).toBe("WARN");
			expect(exported[0]?.attributes).toMatchObject({
				component: "EventRouter",
				issueIdentifier: "NOR-281",
			});
			expect(exported[0]?.resource.attributes).toMatchObject({
				"service.name": "cyrus-router",
				"cloud.provider": "azure",
				"cloud.platform": "azure_container_apps",
				"cloud.region": "australiaeast",
			});
		} finally {
			await handle?.shutdown();
		}
	});

	it("restores the console sink on shutdown", async () => {
		const before = getGlobalLogSink();
		const handle = start();
		expect(getGlobalLogSink()).not.toBe(before);
		await handle?.shutdown();
		expect(getGlobalLogSink()).toBe(before);
	});
});
