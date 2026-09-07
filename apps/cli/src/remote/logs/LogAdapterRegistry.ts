import type {
	LogSourceDescriptorV1,
	LogSourceKindV1,
} from "cyrus-operator-protocol";
import type { EntraCredentialCandidate } from "../credentials.js";
import { UsageError } from "../errors.js";
import { AzureLogAnalyticsAdapter } from "./AzureLogAnalyticsAdapter.js";
import { FakeLogSourceAdapter } from "./FakeLogSourceAdapter.js";
import type { LogSourceAdapter } from "./LogSourceAdapter.js";

/**
 * Chooses the adapter that answers for a router's advertised log source.
 *
 * ── WHY THE COMMAND DOES NOT DO THIS INLINE ──
 * Selection is a decision with a wrong answer that is hard to see. A router
 * advertising a kind this CLI does not implement must be REFUSED with a message
 * naming the kind — not fall through to whichever adapter happened to be
 * constructed, and not fail later as an unexplained empty result. Putting the
 * mapping in one table makes "which kinds are supported" a fact you can read,
 * and makes adding a backend an entry rather than an edit to a command.
 *
 * ── LAZY BY CONSTRUCTION ──
 * Adapters are built on demand. The Azure adapter defers its SDK import to its
 * first query, and a registry that eagerly constructed every adapter would
 * reintroduce exactly the import cost that deferral exists to avoid.
 */
export class LogAdapterRegistry {
	private readonly factories: Map<LogSourceKindV1, () => LogSourceAdapter>;
	private readonly built = new Map<LogSourceKindV1, LogSourceAdapter>();

	constructor(
		options: {
			/** Replaces the whole table; tests inject a fake for every kind. */
			factories?: Partial<Record<LogSourceKindV1, () => LogSourceAdapter>>;
			env?: NodeJS.ProcessEnv;
			entraChain?: EntraCredentialCandidate[];
		} = {},
	) {
		this.factories = new Map<LogSourceKindV1, () => LogSourceAdapter>([
			[
				"azure-log-analytics",
				() =>
					new AzureLogAnalyticsAdapter({
						...(options.env ? { env: options.env } : {}),
						...(options.entraChain ? { entraChain: options.entraChain } : {}),
					}),
			],
			// Present in the shipped binary on purpose. `fake` is a kind the wire
			// contract admits, so a router configured against one is a supported
			// deployment — a staging router with no Azure workspace, or an end-to-end
			// test of the whole path. Making it reachable only from tests would mean
			// the production selection code was never the code that ran.
			["fake", () => new FakeLogSourceAdapter({})],
		]);
		for (const [kind, factory] of Object.entries(options.factories ?? {})) {
			if (factory) this.factories.set(kind as LogSourceKindV1, factory);
		}
	}

	/**
	 * The adapter for this descriptor.
	 *
	 * Memoized per kind so a `follow` reuses one client — and therefore one
	 * credential cache and one connection pool — across every poll, rather than
	 * re-authenticating on a 15-second cadence.
	 */
	resolve(descriptor: LogSourceDescriptorV1): LogSourceAdapter {
		const existing = this.built.get(descriptor.kind);
		if (existing) return existing;

		const factory = this.factories.get(descriptor.kind);
		if (!factory) {
			throw new UsageError(
				`This router advertises a \`${descriptor.kind}\` log source, which this CLI cannot read. ` +
					`Supported: ${[...this.factories.keys()].join(", ")}. Upgrade whichever is older.`,
			);
		}
		const adapter = factory();
		this.built.set(descriptor.kind, adapter);
		return adapter;
	}
}
