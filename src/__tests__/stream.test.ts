import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  ToolCall,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qoderDecodeBody } from "../protocol/encoding.js";
import { streamQoder } from "../protocol/stream.js";
import { loadLiveFixture } from "./live-fixture.js";

vi.mock("../auth/credentials.js", () => ({
  resolveQoderIdentity: vi.fn().mockResolvedValue({
    access: "fake",
    userID: "test-user",
    email: "test@example.com",
    name: "Test User",
    machineID: "test-machine",
    refresh: "",
    expires: 0,
  }),
}));

function sseEnvelope(body: object | string, statusCodeValue = 200, statusCode = "OK"): string {
  return (
    "data:" +
    JSON.stringify({
      headers: { "Content-Type": ["application/json"] },
      body: typeof body === "string" ? body : JSON.stringify(body),
      statusCodeValue,
      statusCode,
    }) +
    "\n\n"
  );
}

const DONE_SSE = sseEnvelope("[DONE]");

function chunk(delta: object, extra: object = {}): object {
  return {
    choices: [{ delta, index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
    ...extra,
  };
}

function finishChunk(finish_reason: string, extra: object = {}): object {
  return {
    choices: [{ finish_reason, index: 0 }],
    created: 1,
    id: "test-id",
    model: "auto",
    object: "chat.completion.chunk",
    usage: { completion_tokens: 1, prompt_tokens: 1, total_tokens: 2 },
    ...extra,
  };
}

const SUCCESS_SSE = loadLiveFixture().interactions.chat.response.body as string;

const BLOCKED_SSE = sseEnvelope(
  { code: "provider_error", message: "Session blocked", request_id: "r", type: "provider_error" },
  406,
  "Not Acceptable",
);

function mockFetch(body: string): typeof fetch {
  const response = new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  return vi.fn(async () => response) as unknown as typeof fetch;
}

function makeModel(id = "Lite"): Model<Api> {
  return { id, api: "qoder-api" as Api, provider: "qoder" } as Model<Api>;
}

function makeContext(): Context {
  return {
    systemPrompt: "test",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  } as unknown as Context;
}

async function consume(stream: AssistantMessageEventStream): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const ev of stream) {
    events.push(ev);
    if (ev.type === "done" || ev.type === "error") break;
  }
  return events;
}

describe("streamQoder", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("replays a recorded-format SSE fixture into text + stop", async () => {
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event").toBeDefined();
    const msg = (done as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("stop");
    const text = msg.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("OK");
  });

  it("sends the internal upstream key for a friendly model id", async () => {
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(streamQoder(makeModel("Lite"), makeContext(), { apiKey: "fake" }));

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1];
    expect(init?.headers).toEqual(expect.objectContaining({ "X-Model-Key": "lite" }));

    const body = JSON.parse(qoderDecodeBody(Buffer.from(init?.body as Uint8Array).toString("utf8")).toString("utf8")) as {
      chat_context: { extra: { modelConfig: { key: string } } };
      model_config: { key: string };
    };
    expect(body.chat_context.extra.modelConfig.key).toBe("lite");
    expect(body.model_config.key).toBe("lite");
  });

  it("binds chat to the global gateway", async () => {
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/api3\.qoder\.sh\//),
      expect.any(Object),
    );
  });

  it("surfaces an upstream 406 Session blocked as an error event, not a silent stop", async () => {
    globalThis.fetch = mockFetch(BLOCKED_SSE);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const err = events.find((e) => e.type === "error");
    expect(err, "expected an error event").toBeDefined();
    const msg = (err as { error: AssistantMessage }).error;
    expect(msg.stopReason).toBe("error");
    expect(msg.errorMessage).toMatch(/Session blocked/);
    expect(msg.errorMessage).toMatch(/406/);
    expect(events.find((e) => e.type === "done")).toBeUndefined();
  });

  it("preserves finish_reason=length instead of overwriting to stop", async () => {
    const sse = sseEnvelope(chunk({ content: "partial", role: "assistant" })) + sseEnvelope(finishChunk("length")) + DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const msg = (events.find((e) => e.type === "done") as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("length");
  });

  it("captures usage, responseId and responseModel from the finish chunk", async () => {
    const sse =
      sseEnvelope(chunk({ content: "OK", role: "assistant" })) +
      sseEnvelope(
        finishChunk("stop", {
          id: "chatcmpl-abc123",
          model: "qmodel_latest",
          usage: {
            prompt_tokens: 42,
            completion_tokens: 7,
            total_tokens: 49,
            completion_tokens_details: { reasoning_tokens: 3 },
            prompt_tokens_details: { cacheable_tokens: 99, cache_write_tokens: 10, cached_tokens: 5 },
          },
        }),
      ) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const msg = (events.find((e) => e.type === "done") as { message: AssistantMessage }).message;
    expect(msg.responseId).toBe("chatcmpl-abc123");
    expect(msg.responseModel).toBe("qmodel_latest");
    expect(msg.usage.input).toBe(27);
    expect(msg.usage.output).toBe(7);
    expect(msg.usage.totalTokens).toBe(49);
    expect(msg.usage.cacheRead).toBe(5);
    expect(msg.usage.cacheWrite).toBe(10);
  });

  it("ignores a zero-token usage chunk so the footer does not flash to 0%", async () => {
    const sse =
      sseEnvelope(
        chunk(
          { content: "a", role: "assistant" },
          { usage: { prompt_tokens: 100, completion_tokens: 1, total_tokens: 101 } },
        ),
      ) +
      sseEnvelope(
        chunk(
          { content: "b", role: "assistant" },
          { usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
        ),
      ) +
      sseEnvelope(
        finishChunk("stop", {
          usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
        }),
      ) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const inputSnapshots: number[] = [];
    let doneMessage: AssistantMessage | undefined;
    for await (const ev of streamQoder(makeModel(), makeContext(), { apiKey: "fake" })) {
      if (ev.type === "text_delta") inputSnapshots.push(ev.partial.usage.input);
      if (ev.type === "done") {
        doneMessage = ev.message;
        break;
      }
      if (ev.type === "error") break;
    }
    expect(inputSnapshots).toEqual([100, 100]);
    expect(doneMessage?.usage.input).toBe(100);
    expect(doneMessage?.usage.output).toBe(5);
    expect(doneMessage?.usage.totalTokens).toBe(105);
  });

  it("uses a stable session_id fallback when Pi does not pass sessionId", async () => {
    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(Buffer.from(init?.body as Uint8Array).toString("utf8"));
      return new Response(SUCCESS_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const ids = bodies.map((encoded) => {
      const parsed = JSON.parse(qoderDecodeBody(encoded).toString("utf8")) as { session_id: string };
      return parsed.session_id;
    });
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).toBe(ids[1]);
  });

  it("reports a tool_use stop reason when the stream emits tool calls", async () => {
    const sse =
      sseEnvelope(
        chunk({
          tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: '{"command":"ls"}' } }],
        }),
      ) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const msg = (events.find((e) => e.type === "done") as { message: AssistantMessage }).message;
    expect(msg.stopReason).toBe("toolUse");
    expect(msg.content.find((c) => c.type === "toolCall")).toBeDefined();
  });

  it("assembles reasoning chunks before the final answer", async () => {
    const sse =
      sseEnvelope(chunk({ reasoning_content: "check " })) +
      sseEnvelope(chunk({ reasoning_content: "twice" })) +
      sseEnvelope(chunk({ content: "done" })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", reasoning: "high" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };
    expect(done.message.content).toEqual([
      { type: "thinking", thinking: "check twice" },
      { type: "text", text: "done" },
    ]);
    expect(events.map((event) => event.type)).toContain("thinking_delta");
  });

  it("assembles parallel tool calls by their stream indexes", async () => {
    const sse =
      sseEnvelope(
        chunk({
          tool_calls: [
            { index: 0, id: "call_a", function: { name: "read", arguments: '{"path":' } },
            { index: 1, id: "call_b", function: { name: "search", arguments: '{"query":' } },
          ],
        }),
      ) +
      sseEnvelope(
        chunk({
          tool_calls: [
            { index: 0, function: { arguments: '"/a"}' } },
            { index: 1, function: { arguments: '"needle"}' } },
          ],
        }),
      ) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };
    const calls = done.message.content.filter((block): block is ToolCall => block.type === "toolCall");
    expect(calls).toEqual([
      { type: "toolCall", id: "call_a", name: "read", arguments: { path: "/a" } },
      { type: "toolCall", id: "call_b", name: "search", arguments: { query: "needle" } },
    ]);
  });

  it("preserves text emitted before and after a tool call", async () => {
    const sse =
      sseEnvelope(chunk({ content: "before" })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "lookup", arguments: "{}" } }] })) +
      sseEnvelope(chunk({ content: " after" })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((event) => event.type === "done") as { message: AssistantMessage };
    expect(done.message.content).toEqual([
      { type: "text", text: "before after" },
      { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
    ]);
  });

  it("emits a tool call that arrives with no arguments", async () => {
    const sse =
      sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "advisor", arguments: "" } }] })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const msg = (events.find((e) => e.type === "done") as { message: AssistantMessage }).message;
    const toolCall = msg.content.find((c) => c.type === "toolCall") as ToolCall | undefined;
    expect(toolCall?.name).toBe("advisor");
    expect(toolCall?.id).toBe("call_1");
    expect(toolCall?.arguments).toEqual({});
    expect(msg.stopReason).toBe("toolUse");
  });

  it("picks up an id and name that arrive after the block is open", async () => {
    const sse =
      sseEnvelope(chunk({ tool_calls: [{ index: 0, function: { name: "bash", arguments: '{"comm' } }] })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "call_9", function: { arguments: 'and":"ls"}' } }] })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const msg = (events.find((e) => e.type === "done") as { message: AssistantMessage }).message;
    const toolCall = msg.content.find((c) => c.type === "toolCall") as ToolCall | undefined;
    expect(toolCall?.id).toBe("call_9");
    expect(toolCall?.name).toBe("bash");
    expect(toolCall?.arguments).toEqual({ command: "ls" });
  });

  it("does not claim toolUse when no tool call reached the message", async () => {
    const sse =
      sseEnvelope(chunk({ content: "thinking about it", role: "assistant" })) +
      sseEnvelope(chunk({ tool_calls: [{ index: 0, function: {} }] })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const msg = (events.find((e) => e.type === "done") as { message: AssistantMessage }).message;
    expect(msg.content.find((c) => c.type === "toolCall")).toBeUndefined();
    expect(msg.stopReason).toBe("stop");
  });

  it("finishes when the gateway sends [DONE] but keeps the body open", async () => {
    const sse = sseEnvelope(chunk({ content: "OK", role: "assistant" })) + sseEnvelope(finishChunk("stop")) + DONE_SSE;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof fetch;

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((e) => e.type === "done");
    expect(done, "expected a done event even though the body stayed open").toBeDefined();
    const text = (done as { message: AssistantMessage }).message.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("OK");
    expect(cancelled).toBe(true);
  });

  it("finishes on a bare data: [DONE] line with the body left open", async () => {
    const sse = `${sseEnvelope(chunk({ content: "hi", role: "assistant" }))}data: [DONE]\n\n`;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(sse));
      },
    });
    globalThis.fetch = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof fetch;

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((e) => e.type === "done");
    expect(done).toBeDefined();
    const text = (done as { message: AssistantMessage }).message.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("hi");
  });

  it("reports aborted when the request is cancelled before streaming starts", async () => {
    const controller = new AbortController();
    globalThis.fetch = vi.fn(
      (_url: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
          }
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
            once: true,
          });
        }),
    ) as unknown as typeof fetch;

    const eventsPromise = consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake", signal: controller.signal }));
    controller.abort();
    const events = await eventsPromise;
    const error = events.find((event) => event.type === "error") as { error: AssistantMessage };
    expect(error.error.stopReason).toBe("aborted");
    expect(events.find((event) => event.type === "done")).toBeUndefined();
  });
});
