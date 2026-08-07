export interface IssueExecutionContext {
	issueKey: string;
	/** Full env for the container, EXCEPT CYRUS_DEVICE_TOKEN. */
	env: Record<string, string>;
	/**
	 * Rotates and returns the issue's device token. Providers call this ONLY
	 * when they must (re)create the container — an existing stopped container
	 * keeps the env (and token) it was created with.
	 */
	mintDeviceToken: () => string;
	/**
	 * The router device-row id (stringified) for the issue's current device.
	 * Used ONLY by the ACA Sandboxes provider's snapshot-lineage check
	 * (see plan B5/D3): an explicit snapshot is restored into a fresh
	 * sandbox only when its `cyrus.device-id` label matches the live row's
	 * id, since the device token baked into a snapshot's memory image must
	 * still match the row to authenticate. Docker/Fly ignore this field
	 * entirely; it is additive and optional so existing callers and
	 * providers keep working unchanged.
	 */
	deviceId?: string;
}

export type ContainerStatus = "running" | "stopped" | "absent";

/** One managed container's issue key and current state, from a bulk listing. */
export interface ManagedContainerState {
	issueKey: string;
	status: ContainerStatus;
	/**
	 * The provider's own state string when it is richer than {@link status} —
	 * e.g. ACA distinguishes `Suspended` from `Stopped` and has transitional
	 * `Creating`/`Resuming`/`Deleting` states that all normalise to `stopped`.
	 * Diagnostic only; never branch on it.
	 */
	providerState?: string;
}

export interface ContainerExecutor {
	readonly provider: string;
	/** Idempotent: boot or resume the issue's container. */
	ensureRunning(ctx: IssueExecutionContext): Promise<void>;
	stop(issueKey: string): Promise<void>;
	/** Removes container AND its persistent volume/disk. */
	destroy(issueKey: string): Promise<void>;
	status(issueKey: string): Promise<ContainerStatus>;
	/** Issue keys of every container this provider currently manages (for orphan GC). */
	listManaged(): Promise<string[]>;
	/**
	 * Every managed container's issue key AND state in ONE provider call.
	 *
	 * Exists so the 60-second lifecycle sweep can emit a per-sandbox telemetry
	 * gauge without issuing N per-row {@link status} calls — at one ARM request
	 * per sandbox per minute that would be the single most expensive thing the
	 * router does. Where implemented this supersedes {@link listManaged} for the
	 * sweep, which derives the orphan-GC key set from the same response rather
	 * than listing twice.
	 *
	 * Optional: a provider that cannot answer in bulk omits it, and the gauge
	 * degrades to `state: "unknown"` rather than falling back to N calls.
	 */
	listStates?(): Promise<ManagedContainerState[]>;
}

export type ExecutorRegistry = ReadonlyMap<string, ContainerExecutor>;
