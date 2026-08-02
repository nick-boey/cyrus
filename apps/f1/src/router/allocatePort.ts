import { createServer } from "node:net";

/**
 * Bind an ephemeral port, read it back, then release it. The router must know
 * its port BEFORE construction (RouterContainersConfig.routerUrlForContainers
 * is consumed in the RouterServer constructor, but server.port is only known
 * after listen()), so `port: 0` is unusable here. There is a small TOCTOU
 * window between release and re-bind; acceptable for a local test rig.
 */
export function allocatePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "127.0.0.1", () => {
			const address = srv.address();
			if (address && typeof address === "object") {
				const { port } = address;
				srv.close(() => resolve(port));
			} else {
				srv.close(() => reject(new Error("allocatePort: no port assigned")));
			}
		});
	});
}
