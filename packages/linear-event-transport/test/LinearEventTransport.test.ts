import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { LinearEventTransport } from "../src/LinearEventTransport.js";

describe("LinearEventTransport", () => {
	describe("register", () => {
		it("registers POST /linear-webhook and a deprecated /webhook alias", () => {
			const post = vi.fn();
			const fastifyServer = { post } as unknown as FastifyInstance;

			const transport = new LinearEventTransport({
				fastifyServer,
				verificationMode: "proxy",
				secret: "test-secret",
			});

			transport.register();

			const registeredPaths = post.mock.calls.map((call: unknown[]) => call[0]);
			expect(registeredPaths).toEqual(
				expect.arrayContaining(["/linear-webhook", "/webhook"]),
			);
			expect(post).toHaveBeenCalledTimes(2);
		});

		it("deprecated /webhook alias delegates to the same handler as /linear-webhook", async () => {
			const post = vi.fn();
			const fastifyServer = { post } as unknown as FastifyInstance;

			const transport = new LinearEventTransport({
				fastifyServer,
				verificationMode: "proxy",
				secret: "test-secret",
			});

			transport.register();

			const calls = post.mock.calls as Array<
				[string, (request: unknown, reply: unknown) => Promise<void>]
			>;
			const primary = calls.find(([path]) => path === "/linear-webhook");
			const deprecated = calls.find(([path]) => path === "/webhook");
			expect(primary).toBeDefined();
			expect(deprecated).toBeDefined();

			const makeReply = () => ({
				code: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis(),
			});

			const unauthorizedRequest = {
				headers: {},
			};

			const primaryReply = makeReply();
			await primary![1](unauthorizedRequest, primaryReply);
			expect(primaryReply.code).toHaveBeenCalledWith(401);

			const deprecatedReply = makeReply();
			await deprecated![1](unauthorizedRequest, deprecatedReply);
			expect(deprecatedReply.code).toHaveBeenCalledWith(401);
		});
	});

	/**
	 * Regression guard for the 2026-07-27 diagnosis. Both direct-mode rejection
	 * paths returned a bare 401 with no log line, so a webhook Linear really did
	 * send left zero trace anywhere — the console showed only the events that
	 * were accepted. That made a delivery problem indistinguishable from Linear
	 * never having sent the event at all.
	 */
	describe("direct mode rejection logging", () => {
		const makeLogger = () => ({
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		});

		const directHandler = (logger: ReturnType<typeof makeLogger>) => {
			const post = vi.fn();
			const fastifyServer = { post } as unknown as FastifyInstance;
			const transport = new LinearEventTransport(
				{
					fastifyServer,
					verificationMode: "direct",
					secret: "test-secret",
				},
				logger as never,
			);
			transport.register();
			const calls = post.mock.calls as Array<
				[string, (request: unknown, reply: unknown) => Promise<void>]
			>;
			return calls.find(([path]) => path === "/linear-webhook")![1];
		};

		const makeReply = () => ({
			code: vi.fn().mockReturnThis(),
			send: vi.fn().mockReturnThis(),
		});

		it("logs a warning when the linear-signature header is missing", async () => {
			const logger = makeLogger();
			const handler = directHandler(logger);
			const reply = makeReply();

			await handler({ headers: {}, body: {}, ip: "1.2.3.4" }, reply);

			expect(reply.code).toHaveBeenCalledWith(401);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("linear-signature"),
			);
		});

		it("logs a warning when the signature does not verify", async () => {
			const logger = makeLogger();
			const handler = directHandler(logger);
			const reply = makeReply();

			await handler(
				{
					headers: { "linear-signature": "deadbeef" },
					body: { type: "AgentSessionEvent", action: "created" },
					rawBody: '{"type":"AgentSessionEvent","action":"created"}',
					ip: "1.2.3.4",
				},
				reply,
			);

			expect(reply.code).toHaveBeenCalledWith(401);
			expect(logger.warn).toHaveBeenCalledWith(
				expect.stringContaining("signature"),
			);
		});
	});
});
