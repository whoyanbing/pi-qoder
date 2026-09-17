import type {
  Api,
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Context,
  Model,
  ToolCall,
} from "@earendil-works/pi-ai";
import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qoderDecodeBody } from "../protocol/encoding.js";
import { __clearSessionFallbackCacheForTests, streamQoder } from "../protocol/stream.js";
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

function decodeRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  return JSON.parse(qoderDecodeBody(Buffer.from(init?.body as Uint8Array).toString("utf8")).toString("utf8"));
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

  it("reuses session_id for same prompt in-process, splits different prompts", async () => {
    __clearSessionFallbackCacheForTests();
    const bodies: string[] = [];
    globalThis.fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(Buffer.from(init?.body as Uint8Array).toString("utf8"));
      return new Response(SUCCESS_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const other: Context = { systemPrompt: "test", messages: [{ role: "user", content: "different prompt" }], tools: [] } as unknown as Context;
    await consume(streamQoder(makeModel(), other, { apiKey: "fake" }));
    const ids = bodies.map((encoded) => {
      const parsed = JSON.parse(qoderDecodeBody(encoded).toString("utf8")) as { session_id: string };
      return parsed.session_id;
    });
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).toBeTruthy();
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("carries the prompt like qodercli: in messages and chat_context text, not chat_prompt", async () => {
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const init = vi.mocked(globalThis.fetch).mock.calls[0][1];
    const body = decodeRequestBody(init);
    expect(body).not.toHaveProperty("chat_prompt");
    expect(body).not.toHaveProperty("code_language");
    expect(body.chat_context).toMatchObject({ text: "hi", chatPrompt: "", extra: { originalContent: "hi" } });
  });

  it("uses one random id per request and keeps request_set_id for the whole prompt", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      bodies.push(decodeRequestBody(init));
      return new Response(SUCCESS_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const prompt = { role: "user", content: "hi", timestamp: 1 };
    const toolTurn = [
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }], stopReason: "toolUse" },
      { role: "toolResult", toolCallId: "c1", toolName: "read", content: [{ type: "text", text: "data" }], isError: false, timestamp: 2 },
    ];
    const contexts = [
      [prompt],
      [prompt, ...toolTurn],
      [prompt, ...toolTurn, { role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "stop" }, { role: "user", content: "next", timestamp: 3 }],
    ];
    for (const messages of contexts) {
      const context = { systemPrompt: "test", messages, tools: [] } as unknown as Context;
      await consume(streamQoder(makeModel(), context, { apiKey: "fake", sessionId: "s1" }));
    }

    for (const body of bodies) expect(body.chat_record_id).toBe(body.request_id);
    expect(new Set(bodies.map((body) => body.request_id)).size).toBe(3);
    expect(bodies[1].request_set_id).toBe(bodies[0].request_set_id);
    expect(bodies[2].request_set_id).not.toBe(bodies[0].request_set_id);
  });

  it("re-signs retries with fresh request ids", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const attempts: Array<{ body: Record<string, unknown>; bodyHash: string | null; sig: string | null }> = [];
      globalThis.fetch = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        attempts.push({ body: decodeRequestBody(init), bodyHash: headers.get("Cosy-Bodyhash"), sig: headers.get("Authorization") });
        if (attempts.length === 1) return new Response("busy", { status: 503, statusText: "Service Unavailable" });
        return new Response(SUCCESS_SSE, { status: 200, headers: { "content-type": "text/event-stream" } });
      }) as unknown as typeof fetch;

      const result = streamQoder(makeModel(), makeContext(), { apiKey: "fake" }).result();
      await vi.advanceTimersByTimeAsync(500);
      expect((await result).stopReason).toBe("stop");

      expect(attempts).toHaveLength(2);
      const [first, retry] = attempts;
      expect(retry.body.request_id).not.toBe(first.body.request_id);
      expect(retry.body.chat_record_id).toBe(retry.body.request_id);
      expect(retry.body.request_set_id).toBe(first.body.request_set_id);
      expect(retry.bodyHash).not.toBe(first.bodyHash);
      expect(retry.sig).not.toBe(first.sig);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends images only inside messages, not duplicated into image_urls", async () => {
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    const model = { ...makeModel("Ultimate"), input: ["text", "image"] } as Model<Api>;
    const context = {
      systemPrompt: "test",
      messages: [
        { role: "user", content: [{ type: "text", text: "look" }, { type: "image", mimeType: "image/png", data: "AAAA" }] },
      ],
      tools: [],
    } as unknown as Context;
    await consume(streamQoder(model, context, { apiKey: "fake" }));

    const init = vi.mocked(globalThis.fetch).mock.calls[0][1];
    const body = JSON.parse(qoderDecodeBody(Buffer.from(init?.body as Uint8Array).toString("utf8")).toString("utf8")) as {
      chat_context: { imageUrls: unknown };
      messages: Array<{ role: string; content: unknown }>;
    };
    expect(body).not.toHaveProperty("image_urls");
    expect(body.chat_context.imageUrls).toBeNull();
    expect(body.messages.at(-1)?.content).toContainEqual({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } });
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

  it("round-trips renamed, colliding and long tool names through definitions, history and response", async () => {
    const names = ["foo.bar", "foo_bar", "x".repeat(65), `${"x".repeat(64)}y`];
    const context = makeContext();
    context.tools = names.map((name) => ({ name, description: name, parameters: { type: "object" } }));
    context.messages.push({
      role: "assistant",
      content: [...names, "retired.tool"].map((name, index) => ({ type: "toolCall", id: `old_${index}`, name, arguments: {} })),
    } as AssistantMessage);
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(qoderDecodeBody(Buffer.from(init?.body as Uint8Array).toString("utf8")).toString("utf8"));
      const wireNames = body.tools.map((tool: { function: { name: string } }) => tool.function.name);
      expect(new Set(wireNames).size).toBe(names.length);
      expect(wireNames[1]).toBe("foo_bar");
      expect(wireNames.every((name: string) => /^[a-zA-Z0-9_-]{1,64}$/.test(name))).toBe(true);
      expect(body.messages.at(-1).tool_calls.map((call: { function: { name: string } }) => call.function.name))
        .toEqual([...wireNames, "retired_tool"]);
      return new Response(sseEnvelope(chunk({
        tool_calls: wireNames.map((name: string, index: number) => ({ index, id: `new_${index}`, function: { name, arguments: "{}" } })),
      })) + sseEnvelope(finishChunk("tool_calls")) + DONE_SSE);
    }) as typeof fetch;

    const result = await streamQoder(makeModel(), context, { apiKey: "fake" }).result();
    expect(result.stopReason).toBe("toolUse");
    expect(result.content.filter((block) => block.type === "toolCall").map((block) => block.name)).toEqual(names);
    expect((context.messages.at(-1)?.content as ToolCall[])[0].name).toBe("foo.bar");
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
      { type: "text", text: "before" },
      { type: "toolCall", id: "call_1", name: "lookup", arguments: {} },
      { type: "text", text: " after" },
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
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
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
      // The stalled tail is read in the background and only given up after the drain window.
      expect(cancelled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(cancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads the tail after [DONE] instead of cancelling, so the connection can be reused", async () => {
    const encoder = new TextEncoder();
    const sse = sseEnvelope(chunk({ content: "OK", role: "assistant" })) + sseEnvelope(finishChunk("stop")) + DONE_SSE;
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(sse));
      },
      // First pull supplies the gateway's finish frame; the second (reached only if the
      // frame was read) ends the body.
      pull(controller) {
        pulls++;
        if (pulls === 1) controller.enqueue(encoder.encode('event:finish\ndata:{"totalDuration":1}\n\n'));
        else controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    globalThis.fetch = vi.fn(
      async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    ) as unknown as typeof fetch;

    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    expect(events.find((e) => e.type === "done")).toBeDefined();
    await vi.waitFor(() => expect(pulls).toBe(2));
    expect(cancelled).toBe(false);
  });

  it("skips quota and notification notice frames", async () => {
    const sse =
      sseEnvelope("[NOT_EXCEED_QUOTA]") +
      sseEnvelope('[NOTIFICATIONS]{"items":[]}') +
      "data:[EXCEED_QUOTA]{}\n\n" +
      sseEnvelope(chunk({ content: "OK", role: "assistant" })) +
      sseEnvelope(finishChunk("stop")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const done = events.find((e) => e.type === "done") as { message: AssistantMessage } | undefined;
    expect(done, "notice frames must not fail the stream").toBeDefined();
    const text = done?.message.content.find((c) => c.type === "text");
    expect(text && "text" in text ? text.text : "").toBe("OK");
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

  it("emits text_end for every started text block", async () => {
    const sse = sseEnvelope(chunk({ content: "hello", role: "assistant" })) + sseEnvelope(finishChunk("stop")) + DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const types = events.map((event) => event.type);
    expect(types).toContain("text_start");
    expect(types).toContain("text_end");
    expect(types.indexOf("text_end")).toBeLessThan(types.indexOf("done"));
  });

  it("reports a retryable error when the body closes without DONE or a finish reason", async () => {
    globalThis.fetch = mockFetch(sseEnvelope(chunk({ content: "truncated", role: "assistant" })));
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const error = events.find((event) => event.type === "error") as { error: AssistantMessage };
    expect(error.error.stopReason).toBe("error");
    expect(error.error.errorMessage).toContain("lost before the response completed");
    expect(isRetryableAssistantError(error.error), "pi should auto-retry a dropped stream").toBe(true);
    expect(events.find((event) => event.type === "done")).toBeUndefined();
  });

  it("rejects non-empty malformed tool arguments instead of executing with an empty object", async () => {
    const sse =
      sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "call_bad", function: { name: "bash", arguments: '{"command":' } }] })) +
      sseEnvelope(finishChunk("tool_calls")) +
      DONE_SSE;
    globalThis.fetch = mockFetch(sse);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const error = events.find((event) => event.type === "error") as { error: AssistantMessage };
    expect(error.error.errorMessage).toContain("Invalid JSON arguments");
    expect(events.find((event) => event.type === "done")).toBeUndefined();
  });

  it("rejects tool arguments over 1MB spread across many small fragments", async () => {
    const fragment = `"${"a".repeat(4095)}",`;
    const frames = Array.from(
      { length: 300 },
      () => sseEnvelope(chunk({ tool_calls: [{ index: 0, id: "call_big", function: { name: "bash", arguments: fragment } }] })),
    ).join("");
    globalThis.fetch = mockFetch(`${frames}${sseEnvelope(finishChunk("tool_calls"))}${DONE_SSE}`);
    const events = await consume(streamQoder(makeModel(), makeContext(), { apiKey: "fake" }));
    const error = events.find((event) => event.type === "error") as { error: AssistantMessage };
    expect(error.error.errorMessage).toContain("tool arguments exceeded");
    expect(events.find((event) => event.type === "done")).toBeUndefined();
  });

  it("merges caller headers without allowing COSY auth fields to be replaced", async () => {
    globalThis.fetch = mockFetch(SUCCESS_SSE);
    await consume(
      streamQoder(makeModel(), makeContext(), {
        apiKey: "fake",
        headers: { "X-Trace": "trace-1", Authorization: "attacker" },
      }),
    );
    const init = vi.mocked(globalThis.fetch).mock.calls[0][1];
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Trace")).toBe("trace-1");
    expect(headers.get("Authorization")).toMatch(/^Bearer COSY\./);
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
