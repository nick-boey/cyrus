import { createReadStream } from "node:fs";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { RouterStore } from "./RouterStore.js";

const ISSUE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BODY_LIMIT = 256 * 1024 * 1024;

/**
 * Device-token-authenticated store for per-issue state bundles (the
 * persistence floor). Bundles live at <artifactsDir>/<issueKey>/bundle.tar.gz.
 *
 * Authorization is issue-scoped: a container device (one per issue, per the
 * design's isolation constraint) may only touch the bundle for its OWN issue.
 * A physical device (a teammate's laptop) has no single issue and may touch
 * any bundle, since Task 10's floor sync uploads/downloads a bundle per issue
 * it works on.
 */
export function registerArtifactsRoute(
	fastify: FastifyInstance,
	store: Pick<RouterStore, "getDeviceByToken" | "getDeviceInfo">,
	artifactsDir: string,
): void {
	fastify.addContentTypeParser(
		"application/gzip",
		{ parseAs: "buffer", bodyLimit: BODY_LIMIT },
		(_req, body, done) => done(null, body),
	);

	const bundlePath = (issueKey: string) =>
		join(artifactsDir, issueKey, "bundle.tar.gz");

	// Runs as an `onRequest` hook — i.e. BEFORE Fastify's body parser buffers
	// the (up to 256 MiB) request body. An unauthenticated or unauthorized
	// request is rejected without a single byte of body being read into
	// memory, closing off a cheap DoS (garbage/no token forcing a full 256 MiB
	// allocation per request).
	//
	// Also carries the issue-scope authorization check (not just "is this
	// token valid"): a container device may only access the bundle for the
	// issue it was minted for. A mismatch is a 403 (the token is valid, the
	// device just isn't entitled to this issue) — never a 404, which
	// `downloadBundle` on the container side treats as the ordinary "no
	// bundle yet" case. Conflating the two would let an authorization failure
	// silently masquerade as an empty restore.
	const authorizeIssueAccess = async (
		request: FastifyRequest<{ Params: { issueKey: string } }>,
		reply: FastifyReply,
	): Promise<void> => {
		const header = request.headers.authorization;
		const token = header?.startsWith("Bearer ")
			? header.slice("Bearer ".length)
			: undefined;
		const device = token ? store.getDeviceByToken(token) : undefined;
		if (!device) {
			reply.status(401).send({ error: "unauthorized" });
			return;
		}
		const { issueKey } = request.params;
		if (!ISSUE_KEY_RE.test(issueKey)) {
			reply.status(400).send({ error: "invalid issue key" });
			return;
		}
		const deviceInfo = store.getDeviceInfo(device.deviceId);
		// A physical device (kind === "device") legitimately runs sessions for
		// many issues, so it is never issue-scoped. A container device is
		// scoped to exactly the issue it was minted for. `!deviceInfo` is a
		// defensive fail-closed branch (token resolved a device row a moment
		// ago, but it's since gone) rather than a reachable state in practice.
		const scopedToOtherIssue =
			deviceInfo?.kind === "container" && deviceInfo.issueKey !== issueKey;
		if (!deviceInfo || scopedToOtherIssue) {
			reply.status(403).send({ error: "forbidden" });
			return;
		}
	};

	fastify.put<{ Params: { issueKey: string } }>(
		"/artifacts/issues/:issueKey/bundle",
		{ onRequest: authorizeIssueAccess, bodyLimit: BODY_LIMIT },
		async (request) => {
			const { issueKey } = request.params;
			const dest = bundlePath(issueKey);
			// Async fs/promises calls, not the *Sync variants: a large PUT (up
			// to 256 MiB) must not block the single JS thread shared by every
			// other connected device's WebSocket heartbeat, RPC dispatch, and
			// webhook ingestion for the duration of the disk write. The
			// tmp-file + rename dance still gives atomicity — rename(2) is
			// atomic at the filesystem level regardless of whether the JS call
			// that issues it is awaited — so a partial/failed PUT can never
			// leave a corrupt bundle at `dest`.
			await mkdir(dirname(dest), { recursive: true });
			const tmp = `${dest}.tmp`;
			await writeFile(tmp, request.body as Buffer);
			await rename(tmp, dest);
			return { ok: true };
		},
	);

	fastify.get<{ Params: { issueKey: string } }>(
		"/artifacts/issues/:issueKey/bundle",
		{ onRequest: authorizeIssueAccess },
		async (request, reply) => {
			const { issueKey } = request.params;
			const path = bundlePath(issueKey);
			try {
				await access(path);
			} catch {
				return reply.status(404).send({ error: "not found" });
			}
			// Streamed, not buffered: createReadStream reads the file in
			// chunks as Fastify writes it to the response, so even a bundle
			// near the 256 MiB ceiling never sits fully in process memory.
			return reply.type("application/gzip").send(createReadStream(path));
		},
	);
}
