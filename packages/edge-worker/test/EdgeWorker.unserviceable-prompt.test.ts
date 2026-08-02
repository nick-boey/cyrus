import { describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

/**
 * The router re-establishes session affinity for EVERY prompt, including one
 * for an already-terminal session. A prompted webhook the worker silently drops
 * therefore leaves an affinity row that no terminal frame will ever clear,
 * pinning the container out of `ContainerLifecycle`'s idle sweep — the PAR-146
 * shape. Defence in depth: reconciliation catches this within a sweep tick
 * regardless, so this only stops the row being created in the first place.
 */

interface RouterConnectionStub {
	sendSessionState: ReturnType<typeof vi.fn>;
}

function makeWorker(opts?: { platform?: "router" | "linear" }) {
	const platform = opts?.platform ?? "router";
	const worker = new EdgeWorker({
		platform,
		...(platform === "linear"
			? {}
			: { router: { url: "ws://127.0.0.1:9", deviceToken: "tok" } }),
		cyrusHome: "/tmp/cyrus-unserviceable-prompt-test",
		repositories: [],
	} as never);

	const routerConnection: RouterConnectionStub = { sendSessionState: vi.fn() };
	const internals = worker as unknown as {
		routerConnection?: RouterConnectionStub;
		handleNormalPromptedActivity: (
			webhook: unknown,
			repositories: unknown[],
		) => Promise<void>;
	};
	internals.routerConnection = routerConnection;

	return { worker, routerConnection, internals };
}

/** A prompted webhook, with `issue`/`agentActivity` overridable to `undefined`. */
function promptedWebhook(opts: {
	sessionId: string;
	issue?: unknown;
	agentActivity?: unknown;
}) {
	return {
		organizationId: "ws-1",
		agentSession: {
			id: opts.sessionId,
			issue: "issue" in opts ? opts.issue : { id: "issue-1" },
		},
		agentActivity:
			"agentActivity" in opts
				? opts.agentActivity
				: { sourceCommentId: "comment-1" },
	};
}

describe("unserviceable prompted activity", () => {
	it("signals terminal when a prompted webhook has no issue", async () => {
		const { routerConnection, internals } = makeWorker();

		await internals.handleNormalPromptedActivity(
			promptedWebhook({ sessionId: "sess-1", issue: undefined }),
			[{}],
		);

		// Without this the router holds affinity for a session no runner will ever
		// finish, and ContainerLifecycle skips the device forever.
		expect(routerConnection.sendSessionState).toHaveBeenCalledWith(
			"sess-1",
			"error",
		);
	});

	it("signals terminal when a prompted webhook has no agentActivity", async () => {
		const { routerConnection, internals } = makeWorker();

		await internals.handleNormalPromptedActivity(
			promptedWebhook({ sessionId: "sess-2", agentActivity: undefined }),
			[{}],
		);

		expect(routerConnection.sendSessionState).toHaveBeenCalledWith(
			"sess-2",
			"error",
		);
	});

	it("does not signal terminal when the prompt is serviced normally", async () => {
		const { routerConnection, internals } = makeWorker();

		// A fully-formed webhook runs on past the two guards. It will fail further
		// down on machinery this unit test does not stand up — that is fine, the
		// assertion is that neither guard fired.
		await internals
			.handleNormalPromptedActivity(promptedWebhook({ sessionId: "sess-3" }), [
				{},
			])
			.catch(() => {});

		expect(routerConnection.sendSessionState).not.toHaveBeenCalledWith(
			"sess-3",
			"error",
		);
	});

	it("stays silent off the router platform, where there is no claim to release", async () => {
		const { routerConnection, internals } = makeWorker({ platform: "linear" });

		await internals.handleNormalPromptedActivity(
			promptedWebhook({ sessionId: "sess-4", issue: undefined }),
			[{}],
		);

		expect(routerConnection.sendSessionState).not.toHaveBeenCalled();
	});
});
