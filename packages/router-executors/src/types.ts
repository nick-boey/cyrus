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
}

export type ExecutorRegistry = ReadonlyMap<string, ContainerExecutor>;
