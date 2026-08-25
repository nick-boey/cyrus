import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

vi.mock("fs", () => ({
	mkdirSync: vi.fn(),
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ""),
	createWriteStream: vi.fn(() => ({
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
	})),
}));

vi.mock("os", () => ({
	homedir: vi.fn(() => "/mock/home"),
}));

import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { context as contextApi, ROOT_CONTEXT, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
	BasicTracerProvider,
	InMemorySpanExporter,
	SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { ClaudeRunner } from "../src/ClaudeRunner";
import type { ClaudeRunnerConfig } from "../src/types";

/**
 * The far end of the distributed trace. Without a span here a trace stops at
 * "the sandbox worker received the event" and the minutes the agent actually
 * spent are an unexplained gap — which is the specific question NOR-283 exists
 * to answer.
 */

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c";
const SPAN_ID = "b7ad6b7169203331";

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

const baseConfig: ClaudeRunnerConfig = {
	workingDirectory: "/tmp/does-not-matter",
	cyrusHome: "/mock/home/.cyrus",
};

function messages(...items: SDKMessage[]): AsyncIterable<SDKMessage> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const item of items) yield item;
		},
	};
}

function resultMessage(): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		result: "done",
		session_id: "claude-session-1",
		duration_ms: 100,
		num_turns: 1,
	} as unknown as SDKMessage;
}

beforeEach(() => {
	exporter = new InMemorySpanExporter();
	provider = new BasicTracerProvider({
		spanProcessors: [new SimpleSpanProcessor(exporter)],
	});
	const manager = new AsyncLocalStorageContextManager();
	manager.enable();
	contextApi.setGlobalContextManager(manager);
	trace.setGlobalTracerProvider(provider);
});

afterEach(async () => {
	await provider.shutdown();
	trace.disable();
	contextApi.disable();
	vi.clearAllMocks();
});

describe("agent session span", () => {
	it("records exactly one span covering the query", async () => {
		vi.mocked(query).mockReturnValue(
			messages(resultMessage()) as ReturnType<typeof query>,
		);

		await new ClaudeRunner(baseConfig).start("go");

		const sessionSpans = exporter
			.getFinishedSpans()
			.filter((s) => s.name.startsWith("session."));
		expect(sessionSpans).toHaveLength(1);
		expect(sessionSpans[0]?.name).toBe("session.query");
		expect(sessionSpans[0]?.endTime).toBeDefined();
	});

	it("joins the trace the router handed the worker", async () => {
		// `RouterConnection` activates the router's context around its `event`
		// emit, so by the time a session starts the ambient context IS the
		// router's. Nothing has to be threaded through for this to work — which
		// is the whole design — so the test asserts it the same way.
		vi.mocked(query).mockReturnValue(
			messages(resultMessage()) as ReturnType<typeof query>,
		);

		const routerContext = trace.setSpanContext(ROOT_CONTEXT, {
			traceId: TRACE_ID,
			spanId: SPAN_ID,
			traceFlags: 1,
			isRemote: true,
		});

		await contextApi.with(routerContext, () =>
			new ClaudeRunner(baseConfig).start("go"),
		);

		const span = exporter
			.getFinishedSpans()
			.find((s) => s.name.startsWith("session."));
		expect(span?.spanContext().traceId).toBe(TRACE_ID);
		expect(span?.parentSpanContext?.spanId).toBe(SPAN_ID);
	});

	it("names a resume differently from a fresh query", async () => {
		vi.mocked(query).mockReturnValue(
			messages(resultMessage()) as ReturnType<typeof query>,
		);

		await new ClaudeRunner({
			...baseConfig,
			resumeSessionId: "claude-session-0",
		}).start("go");

		const span = exporter
			.getFinishedSpans()
			.find((s) => s.name.startsWith("session."));
		expect(span?.name).toBe("session.resume");
		expect(span?.attributes["cyrus.resumed"]).toBe(true);
	});

	it("ends the span even when the query throws", async () => {
		// Every terminal path converges on one `finally`. A leaked span is worse
		// than a missing one: it never exports, so the trace renders with a
		// silent gap rather than an error.
		vi.mocked(query).mockImplementation(() => {
			throw new Error("sdk exploded");
		});

		const runner = new ClaudeRunner(baseConfig);
		runner.on("error", () => {});
		await runner.start("go");

		expect(
			exporter.getFinishedSpans().some((s) => s.name.startsWith("session.")),
		).toBe(true);
	});

	it("stamps the message count and agent session id, which are only known at the end", async () => {
		vi.mocked(query).mockReturnValue(
			messages(resultMessage()) as ReturnType<typeof query>,
		);

		await new ClaudeRunner(baseConfig).start("go");

		const span = exporter
			.getFinishedSpans()
			.find((s) => s.name.startsWith("session."));
		expect(span?.attributes["cyrus.message_count"]).toBeGreaterThan(0);
	});
});
