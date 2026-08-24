import { InMemoryLogRecordExporter } from "@opentelemetry/sdk-logs";
import {
	createLogger,
	getGlobalLogSink,
	LogLevel,
	resetGlobalLogSink,
	setGlobalLogSink,
} from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startOtelLogging } from "../src/bootstrap.js";

const RESOURCE = {
	serviceName: "cyrus-router",
	serviceVersion: "0.2.66",
	serviceInstanceId: "router--rev-abc",
	deploymentEnvironment: "production",
	cloudProvider: "azure",
	cloudPlatform: "azure_container_apps",
	cloudRegion: "australiaeast",
};

describe("startOtelLogging", () => {
	let exporter: InMemoryLogRecordExporter;

	beforeEach(() => {
		exporter = new InMemoryLogRecordExporter();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetGlobalLogSink();
	});

	/**
	 * The end-to-end claim of NOR-281: an ordinary `logger.info(...)` call site —
	 * unchanged, one of ~957 — comes out of the pipeline as a structured record
	 * with the resource attributes attached.
	 */
	it("turns an unmodified ILogger call into an exported record with resource semconv", async () => {
		const handle = startOtelLogging({
			exporter,
			resource: RESOURCE,
			processor: "simple",
			minLevel: LogLevel.DEBUG,
		});
		try {
			createLogger({ component: "EventRouter" })
				.withContext({ issueIdentifier: "NOR-281" })
				.info("routed webhook");

			const exported = exporter.getFinishedLogRecords();
			expect(exported).toHaveLength(1);
			expect(exported[0]?.body).toBe("routed webhook");
			expect(exported[0]?.severityText).toBe("INFO");
			expect(exported[0]?.attributes).toMatchObject({
				component: "EventRouter",
				issueIdentifier: "NOR-281",
			});
			expect(exported[0]?.resource.attributes).toMatchObject({
				"service.name": "cyrus-router",
				"service.version": "0.2.66",
				"service.instance.id": "router--rev-abc",
				"deployment.environment.name": "production",
				"cloud.provider": "azure",
				"cloud.platform": "azure_container_apps",
				"cloud.region": "australiaeast",
			});
		} finally {
			await handle.shutdown();
		}
	});

	it("reports the resource attributes it applied", () => {
		const handle = startOtelLogging({
			exporter,
			resource: RESOURCE,
			processor: "simple",
		});
		try {
			expect(handle.resourceAttributes["service.name"]).toBe("cyrus-router");
			expect(handle.resourceAttributes["cloud.platform"]).toBe(
				"azure_container_apps",
			);
		} finally {
			void handle.shutdown();
		}
	});

	it("installs the sink process-wide by default", async () => {
		const handle = startOtelLogging({
			exporter,
			resource: RESOURCE,
			processor: "simple",
		});
		try {
			expect(getGlobalLogSink()).toBe(handle.sink);
		} finally {
			await handle.shutdown();
		}
	});

	it("can build the pipeline without touching global state", async () => {
		const before = getGlobalLogSink();
		const handle = startOtelLogging({
			exporter,
			resource: RESOURCE,
			processor: "simple",
			install: false,
		});
		try {
			expect(getGlobalLogSink()).toBe(before);
			expect(getGlobalLogSink()).not.toBe(handle.sink);
		} finally {
			await handle.shutdown();
		}
	});

	/**
	 * `provider.shutdown()` awaits an export, so anything logged during the rest
	 * of shutdown must already be going somewhere else — otherwise those lines
	 * (often the most interesting ones) are handed to a closing pipeline.
	 */
	it("restores the previously-installed sink on shutdown", async () => {
		const previous = { minLevel: LogLevel.DEBUG, write: (): void => {} };
		setGlobalLogSink(previous);
		const handle = startOtelLogging({
			exporter,
			resource: RESOURCE,
			processor: "simple",
		});
		expect(getGlobalLogSink()).toBe(handle.sink);
		await handle.shutdown();
		expect(getGlobalLogSink()).toBe(previous);
	});

	it("is idempotent on shutdown", async () => {
		const handle = startOtelLogging({
			exporter,
			resource: RESOURCE,
			processor: "simple",
		});
		// A SIGTERM handler and a `finally` block may both call it.
		await expect(
			Promise.all([handle.shutdown(), handle.shutdown()]),
		).resolves.toBeDefined();
		await expect(handle.shutdown()).resolves.toBeUndefined();
	});

	it("still writes to the console — the OTel sink is additional, not a replacement", async () => {
		const handle = startOtelLogging({
			exporter,
			resource: RESOURCE,
			processor: "simple",
		});
		try {
			createLogger({ component: "EventRouter" }).warn("degraded");
			expect(console.warn).toHaveBeenCalledTimes(1);
			expect(exporter.getFinishedLogRecords()).toHaveLength(1);
		} finally {
			await handle.shutdown();
		}
	});

	it("defaults the sink threshold to INFO, so debug lines stay local", async () => {
		const handle = startOtelLogging({
			exporter,
			resource: RESOURCE,
			processor: "simple",
		});
		try {
			const logger = createLogger({
				component: "EventRouter",
				level: LogLevel.DEBUG,
			});
			logger.debug("chatty");
			logger.info("worth shipping");
			expect(exporter.getFinishedLogRecords().map((r) => r.body)).toEqual([
				"worth shipping",
			]);
		} finally {
			await handle.shutdown();
		}
	});

	it("flushes buffered records on forceFlush with the batch processor", async () => {
		const handle = startOtelLogging({ exporter, resource: RESOURCE });
		try {
			createLogger({ component: "EventRouter" }).error("boom");
			// The batch processor buffers, so nothing has reached the exporter yet —
			// this is exactly why the router's SIGTERM path must flush.
			expect(exporter.getFinishedLogRecords()).toHaveLength(0);
			await handle.forceFlush();
			expect(exporter.getFinishedLogRecords().map((r) => r.body)).toEqual([
				"boom",
			]);
		} finally {
			await handle.shutdown();
		}
	});
});
