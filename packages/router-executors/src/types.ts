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
