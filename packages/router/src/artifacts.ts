import {
	createReadStream,
	existsSync,
	mkdirSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";

const ISSUE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BODY_LIMIT = 256 * 1024 * 1024;

/**
 * Device-token-authenticated store for per-issue state bundles (the
 * persistence floor). Bundles live at <artifactsDir>/<issueKey>/bundle.tar.gz.
 */
export function registerArtifactsRoute(
	fastify: FastifyInstance,
	store: { getDeviceByToken(token: string): unknown },
	artifactsDir: string,
): void {
	fastify.addContentTypeParser(
		"application/gzip",
		{ parseAs: "buffer", bodyLimit: BODY_LIMIT },
		(_req, body, done) => done(null, body),
	);

	const authed = (request: FastifyRequest): boolean => {
		const header = request.headers.authorization;
		if (!header?.startsWith("Bearer ")) return false;
		return Boolean(store.getDeviceByToken(header.slice("Bearer ".length)));
	};
	const bundlePath = (issueKey: string) =>
		join(artifactsDir, issueKey, "bundle.tar.gz");

	fastify.put<{ Params: { issueKey: string } }>(
		"/artifacts/issues/:issueKey/bundle",
		{ bodyLimit: BODY_LIMIT },
		async (request, reply) => {
			if (!authed(request))
				return reply.status(401).send({ error: "unauthorized" });
			const { issueKey } = request.params;
			if (!ISSUE_KEY_RE.test(issueKey)) {
				return reply.status(400).send({ error: "invalid issue key" });
			}
			const dest = bundlePath(issueKey);
			mkdirSync(dirname(dest), { recursive: true });
			const tmp = `${dest}.tmp`;
			writeFileSync(tmp, request.body as Buffer);
			renameSync(tmp, dest);
			return { ok: true };
		},
	);

	fastify.get<{ Params: { issueKey: string } }>(
		"/artifacts/issues/:issueKey/bundle",
		async (request, reply) => {
			if (!authed(request))
				return reply.status(401).send({ error: "unauthorized" });
			const { issueKey } = request.params;
			if (!ISSUE_KEY_RE.test(issueKey)) {
				return reply.status(400).send({ error: "invalid issue key" });
			}
			const path = bundlePath(issueKey);
			if (!existsSync(path))
				return reply.status(404).send({ error: "not found" });
			return reply.type("application/gzip").send(createReadStream(path));
		},
	);
}
