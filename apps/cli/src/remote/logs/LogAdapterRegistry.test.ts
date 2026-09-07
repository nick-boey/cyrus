import { describe, expect, it, vi } from "vitest";
import { ExitCode } from "../exitCodes.js";
import { AzureLogAnalyticsAdapter } from "./AzureLogAnalyticsAdapter.js";
import { FakeLogSourceAdapter } from "./FakeLogSourceAdapter.js";
import { descriptor, fakeDescriptor } from "./fixtures/index.js";
import { LogAdapterRegistry } from "./LogAdapterRegistry.js";

describe("LogAdapterRegistry", () => {
	it("resolves an Azure descriptor to the Azure adapter", () => {
		expect(new LogAdapterRegistry().resolve(descriptor())).toBeInstanceOf(
			AzureLogAnalyticsAdapter,
		);
	});

	it("resolves a fake descriptor to the fake adapter", () => {
		// `fake` is reachable from the shipped binary on purpose: a router
		// configured against one is a supported deployment, so the selection code
		// that runs in that case is the same code that runs in production.
		expect(new LogAdapterRegistry().resolve(fakeDescriptor())).toBeInstanceOf(
			FakeLogSourceAdapter,
		);
	});

	it("refuses a kind it cannot read, naming what it can", () => {
		// Falling through to whichever adapter happened to be constructed would
		// fail later as an unexplained empty result.
		const registry = new LogAdapterRegistry();

		expect(() =>
			registry.resolve({ ...descriptor(), kind: "s3-archive" } as never),
		).toThrow(/s3-archive/);
	});

	it("reports an unreadable kind as invalid configuration, not a transient fault", () => {
		const registry = new LogAdapterRegistry();

		expect(() =>
			registry.resolve({ ...descriptor(), kind: "s3-archive" } as never),
		).toThrowError(expect.objectContaining({ exitCode: ExitCode.usage }));
	});

	it("builds an adapter only when a descriptor asks for it", () => {
		// The Azure adapter defers its SDK import to its first query; eagerly
		// constructing every adapter would reintroduce the cost that deferral
		// exists to avoid.
		const azure = vi.fn(() => new FakeLogSourceAdapter({}));
		const registry = new LogAdapterRegistry({
			factories: { "azure-log-analytics": azure },
		});

		expect(azure).not.toHaveBeenCalled();
		registry.resolve(descriptor());
		expect(azure).toHaveBeenCalledTimes(1);
	});

	it("returns the same adapter for repeated resolutions of one kind", () => {
		// A `follow` resolves per poll. Rebuilding would re-authenticate and open a
		// new connection pool on a 15-second cadence.
		const registry = new LogAdapterRegistry();

		expect(registry.resolve(descriptor())).toBe(registry.resolve(descriptor()));
	});

	it("lets a test replace a factory without disabling the others", () => {
		const registry = new LogAdapterRegistry({
			factories: { "azure-log-analytics": () => new FakeLogSourceAdapter({}) },
		});

		expect(registry.resolve(descriptor())).toBeInstanceOf(FakeLogSourceAdapter);
		expect(registry.resolve(fakeDescriptor())).toBeInstanceOf(
			FakeLogSourceAdapter,
		);
	});
});
