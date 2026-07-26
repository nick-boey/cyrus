import {
	AcaSandboxClient,
	AcaSandboxesProvider,
	createDefaultTokenProvider,
} from "cyrus-router-executors";
import type { RouterContainersConfig } from "./RouterServer.js";

/** Build only the configured ACA provider, without starting a RouterServer. */
export function createAcaSandboxesProvider(
	containers: RouterContainersConfig,
	logger?: { info(msg: string): void; warn(msg: string): void },
	deviceConnectivity?: (deviceId: string) => {
		connected: boolean;
		disconnectedSinceMs: number;
	},
): AcaSandboxesProvider | undefined {
	const cfg = containers.aca;
	if (!cfg) return undefined;
	return new AcaSandboxesProvider({
		client: new AcaSandboxClient({
			subscriptionId: cfg.subscriptionId,
			resourceGroup: cfg.resourceGroup,
			sandboxGroup: cfg.sandboxGroup,
			region: cfg.region,
			tokenProvider: createDefaultTokenProvider(),
			apiVersion: cfg.apiVersion,
			baseUrl: cfg.managementEndpoint,
		}),
		image: containers.image,
		disk: cfg.disk,
		cpu: cfg.cpu,
		memory: cfg.memory,
		autoSuspendSeconds: cfg.autoSuspendSeconds,
		egress: cfg.egress,
		keepSnapshots: cfg.keepSnapshots,
		disconnectedRecreateMs: cfg.disconnectedRecreateMs,
		resumeConnectTimeoutMs: cfg.resumeConnectTimeoutMs,
		resumeConnectPollMs: cfg.resumeConnectPollMs,
		deviceConnectivity,
		routerUrlForContainers: containers.routerUrlForContainers,
		logger,
	});
}
