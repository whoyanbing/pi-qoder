import crypto from "node:crypto";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  clampThinkingLevel,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { resolveQoderIdentity } from "../auth/credentials.js";
import { getCachedModelConfig } from "../catalog.js";
import { MAX_OUTPUT_TOKENS, USER_EMAIL_FALLBACK, USER_NAME_FALLBACK, getChatURL } from "../config.js";
import { buildAuthHeaders, getMachineId } from "../cosy.js";
import { qoderEncodeBody } from "./encoding.js";
import { stripThinkingTags, ThinkingTagParser } from "./thinking.js";
import { contentToText, transformMessagesForQoder, transformTools } from "./transform.js";

interface ToolCallState {
  arguments: string;
  id: string;
  name: string;
  emittedStart?: boolean;
  emittedEnd?: boolean;
  contentIndex: number;
}

function stableHash(prefix: string, ...inputs: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(prefix);
  for (const input of inputs) {
    hash.update("\0");
    hash.update(input);
  }
  return hash.digest("hex").slice(0, 16);
}

function stableChatRecordID(
  model: string,
  messages: Array<{ role?: string; content?: unknown }>,
  tools: unknown,
  maxTokens: number,
): string {
  const hash = crypto.createHash("sha256");
  hash.update("qoder-record");
  hash.update("\0");
  hash.update(model);
  for (const msg of messages) {
    if (msg?.role) {
      hash.update("\0");
      hash.update(msg.role);
    }
    if (msg?.content) {
      hash.update("\0");
      hash.update(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
    }
  }
  if (tools) {
    hash.update("\0");
    hash.update(JSON.stringify(tools));
  }
  hash.update("\0");
  hash.update(`mt=${maxTokens}`);
  return hash.digest("hex").slice(0, 16);
}

function emptyUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function mapFinishReason(reason: string): StopReason {
  if (reason === "length" || reason === "max_tokens") return "length";
  if (reason === "tool_calls" || reason === "tool_use") return "toolUse";
  if (reason === "content_filter") return "error";
  if (reason === "stop" || reason === "end_turn" || reason === "stop_sequence") return "stop";
  return "stop";
}

function doneReason(reason: StopReason): Extract<StopReason, "stop" | "length" | "toolUse"> {
  if (reason === "length") return "length";
  if (reason === "toolUse") return "toolUse";
  return "stop";
}

export function streamQoder(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };

  (async () => {
    try {
      const accessToken = options?.apiKey;
      if (!accessToken) {
        throw new Error("Qoder credentials not set. Run /login qoder or set QODER_PERSONAL_ACCESS_TOKEN.");
      }

      const ident = await resolveQoderIdentity(accessToken, model.provider);
      const userID = ident.userID || "qoder-user";
      const name = ident.name || USER_NAME_FALLBACK;
      const email = ident.email || USER_EMAIL_FALLBACK;
      const machineID = ident.machineID || getMachineId();

      const modelConfig = getCachedModelConfig(model.id);
      if (!modelConfig?.key) {
        throw new Error(`Unknown Qoder model id: ${model.id}`);
      }
      const qoderModel = modelConfig.key;
      const isReasoning = Boolean(modelConfig.is_reasoning || modelConfig.thinking_config);

      const normalizedMessages = transformMessagesForQoder(context.messages);
      const systemText = contentToText(context.systemPrompt || "");

      let lastUserText = "";
      for (let i = normalizedMessages.length - 1; i >= 0; i--) {
        if (normalizedMessages[i].role === "user") {
          const content = normalizedMessages[i].content;
          lastUserText =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content.map((c) => ("text" in c ? c.text : "")).join("")
                : "";
          break;
        }
      }

      const stablePart = stableHash("qoder-session", userID, qoderModel);
      const sessionID = options?.sessionId
        ? `${stablePart}-${options.sessionId}`
        : `${stablePart}-${crypto.randomUUID()}`;

      let maxTokens = MAX_OUTPUT_TOKENS;
      if (options?.maxTokens && options.maxTokens < maxTokens) {
        maxTokens = options.maxTokens;
      }

      const toolsRaw = context.tools && context.tools.length > 0 ? transformTools(context.tools) : undefined;
      const recordID = stableChatRecordID(qoderModel, normalizedMessages, toolsRaw, maxTokens);

      const requestedLevel = options?.reasoning;
      const clamped = requestedLevel ? clampThinkingLevel(model, requestedLevel) : undefined;
      const reasoningLevel = clamped === "off" ? undefined : clamped;
      const parameters: Record<string, unknown> = { max_tokens: maxTokens };
      if (reasoningLevel) {
        parameters.enable_thinking = true;
        const mapped = model.thinkingLevelMap?.[reasoningLevel];
        const effort = mapped && mapped !== "enabled" && mapped !== "disabled" ? mapped : reasoningLevel;
        if (modelConfig.thinking_config?.enabled?.efforts && typeof effort === "string") {
          parameters.reasoning_effort = effort;
        }
      } else {
        parameters.enable_thinking = false;
      }

      let reqBody: Record<string, unknown> = {
        request_id: crypto.randomUUID(),
        request_set_id: recordID,
        chat_record_id: recordID,
        session_id: sessionID,
        stream: true,
        chat_task: "FREE_INPUT",
        is_reply: true,
        is_retry: false,
        source: 1,
        version: "3",
        session_type: "qodercli",
        agent_id: "agent_common",
        task_id: "common",
        code_language: "",
        chat_prompt: "",
        image_urls: null,
        aliyun_user_type: "",
        system: "",
        messages: systemText ? [{ role: "system", content: systemText }, ...normalizedMessages] : normalizedMessages,
        tools: toolsRaw || [],
        parameters,
        chat_context: {
          chatPrompt: "",
          imageUrls: null,
          extra: {
            context: [],
            modelConfig: {
              key: qoderModel,
              is_reasoning: isReasoning,
            },
            originalContent: lastUserText,
          },
          features: [],
          text: lastUserText,
        },
        model_config: modelConfig,
        business: {
          product: "cli",
          version: "1.0.0",
          type: "agent",
          stage: "start",
          id: crypto.randomUUID(),
          name: lastUserText.substring(0, 30),
          begin_at: Date.now(),
        },
      };

      if (options?.onPayload) {
        const replaced = await options.onPayload(reqBody, model);
        if (replaced !== undefined && replaced !== null && typeof replaced === "object") {
          reqBody = replaced as Record<string, unknown>;
        }
      }

      const encodedBytes = Buffer.from(qoderEncodeBody(Buffer.from(JSON.stringify(reqBody))), "utf8");
      const chatURL = getChatURL();
      const headers = buildAuthHeaders(encodedBytes, chatURL, {
        userID,
        authToken: accessToken,
        name,
        email,
        machineID,
      });

      const doFetch = options?.fetch ?? globalThis.fetch;
      const response = await doFetch(chatURL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          "Cache-Control": "no-cache",
          "Accept-Encoding": "identity",
          "X-Model-Key": qoderModel,
          "X-Model-Source": String(modelConfig.source || "system"),
          ...headers,
        },
        body: encodedBytes,
        signal: options?.signal,
      });

      await options?.onResponse?.(
        {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        },
        model,
      );

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Qoder API request failed: ${response.status} ${response.statusText}. Response: ${errText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";

      let contentBlockIndex = -1;
      let thinkingBlockIndex = -1;
      const toolCallsState: ToolCallState[] = [];
      // SimpleStreamOptions.reasoning is ThinkingLevel (no "off"); absence means thinking off.
      const thinkingEnabled = options?.reasoning !== undefined;
      const thinkingParser = thinkingEnabled ? new ThinkingTagParser(output, stream) : null;

      stream.push({ type: "start", partial: output });

      // Qoder's gateway often keeps the HTTP body open after `data: [DONE]`.
      // Stop the read loop on the sentinel instead of waiting for the socket.
      let sawDone = false;

      while (!sawDone) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        while (true) {
          const lineEnd = buffer.indexOf("\n");
          if (lineEnd === -1) break;

          const line = buffer.substring(0, lineEnd).trim();
          buffer = buffer.substring(lineEnd + 1);
          if (!line.startsWith("data:")) continue;

          const dataStr = line.substring(5).trim();
          if (dataStr === "[DONE]") {
            sawDone = true;
            break;
          }

          try {
            const envelope = JSON.parse(dataStr) as {
              statusCodeValue?: number;
              body?: string;
            };
            if (envelope.statusCodeValue && envelope.statusCodeValue !== 200) {
              throw new Error(`Upstream status ${envelope.statusCodeValue}: ${envelope.body}`);
            }

            const innerStr = envelope.body;
            if (innerStr === "[DONE]") {
              sawDone = true;
              break;
            }
            if (!innerStr) continue;

            const inner = JSON.parse(innerStr) as {
              id?: string;
              model?: string;
              usage?: {
                prompt_tokens?: number;
                completion_tokens?: number;
                total_tokens?: number;
                prompt_tokens_details?: {
                  cacheable_tokens?: number;
                  cached_tokens?: number;
                  cache_write_tokens?: number;
                };
              };
              choices?: Array<{
                finish_reason?: string;
                delta?: {
                  content?: string;
                  reasoning_content?: string;
                  tool_calls?: Array<{
                    index?: number;
                    id?: string;
                    function?: { name?: string; arguments?: string };
                  }>;
                };
              }>;
            };

            if (inner.id) output.responseId = inner.id;
            if (inner.model) output.responseModel = inner.model;
            if (inner.usage) {
              const promptTokens = inner.usage.prompt_tokens ?? 0;
              const cacheReadTokens = inner.usage.prompt_tokens_details?.cached_tokens ?? 0;
              const cacheWriteTokens = inner.usage.prompt_tokens_details?.cache_write_tokens ?? 0;
              output.usage.input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
              output.usage.output = inner.usage.completion_tokens ?? 0;
              output.usage.totalTokens = inner.usage.total_tokens ?? 0;
              output.usage.cacheRead = cacheReadTokens;
              output.usage.cacheWrite = cacheWriteTokens;
            }

            const choice = inner.choices?.[0];
            const delta = choice?.delta;
            if (delta) {
              if (delta.reasoning_content) {
                const reasoningChunk = stripThinkingTags(delta.reasoning_content);
                if (reasoningChunk) {
                  if (thinkingBlockIndex === -1) {
                    thinkingBlockIndex = output.content.length;
                    output.content.push({ type: "thinking", thinking: "" });
                    stream.push({ type: "thinking_start", contentIndex: thinkingBlockIndex, partial: output });
                  }
                  const block = output.content[thinkingBlockIndex] as ThinkingContent;
                  block.thinking += reasoningChunk;
                  stream.push({
                    type: "thinking_delta",
                    contentIndex: thinkingBlockIndex,
                    delta: reasoningChunk,
                    partial: output,
                  });
                }
              }

              if (delta.content) {
                if (thinkingBlockIndex !== -1) {
                  const block = output.content[thinkingBlockIndex] as ThinkingContent;
                  stream.push({
                    type: "thinking_end",
                    contentIndex: thinkingBlockIndex,
                    content: block.thinking,
                    partial: output,
                  });
                  thinkingBlockIndex = -1;
                }

                if (thinkingParser) {
                  thinkingParser.processChunk(delta.content);
                } else {
                  if (contentBlockIndex === -1) {
                    contentBlockIndex = output.content.length;
                    output.content.push({ type: "text", text: "" });
                    stream.push({ type: "text_start", contentIndex: contentBlockIndex, partial: output });
                  }
                  const block = output.content[contentBlockIndex] as TextContent;
                  block.text += delta.content;
                  stream.push({
                    type: "text_delta",
                    contentIndex: contentBlockIndex,
                    delta: delta.content,
                    partial: output,
                  });
                }
              }

              if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCallsState[idx]) {
                    toolCallsState[idx] = { arguments: "", id: "", name: "", contentIndex: 0 };
                  }
                  const state = toolCallsState[idx];
                  if (tc.id) state.id = tc.id;
                  if (tc.function?.name) state.name = tc.function.name;

                  // Open as soon as the call is identifiable, including no-arg tools.
                  if (state.emittedStart === undefined && (state.id || state.name)) {
                    state.emittedStart = true;
                    state.contentIndex = output.content.length;
                    output.content.push({
                      type: "toolCall",
                      id: state.id,
                      name: state.name,
                      arguments: {},
                    } satisfies ToolCall);
                    stream.push({ type: "toolcall_start", contentIndex: state.contentIndex, partial: output });
                  }

                  if (state.emittedStart) {
                    const block = output.content[state.contentIndex] as ToolCall;
                    block.id = state.id;
                    block.name = state.name;
                  }

                  if (tc.function?.arguments) {
                    const argDelta = tc.function.arguments;
                    state.arguments += argDelta;
                    stream.push({
                      type: "toolcall_delta",
                      contentIndex: state.contentIndex,
                      delta: argDelta,
                      partial: output,
                    });
                  }
                }
              }
            }

            if (choice?.finish_reason) {
              output.stopReason = mapFinishReason(choice.finish_reason);
            }
          } catch (e) {
            if (e instanceof SyntaxError) {
              if (process.env.QODER_DEBUG) {
                console.error("[pi-qoder] skipping malformed SSE line:", dataStr.slice(0, 200));
              }
              continue;
            }
            throw e;
          }
        }
      }

      await reader.cancel().catch(() => {});
      thinkingParser?.finalize();

      if (thinkingBlockIndex !== -1) {
        const block = output.content[thinkingBlockIndex] as ThinkingContent;
        stream.push({
          type: "thinking_end",
          contentIndex: thinkingBlockIndex,
          content: block.thinking,
          partial: output,
        });
      }

      for (const state of toolCallsState) {
        if (state?.emittedStart && !state.emittedEnd) {
          state.emittedEnd = true;
          let args = {};
          try {
            args = JSON.parse(state.arguments || "{}");
          } catch {}
          const block = output.content[state.contentIndex] as ToolCall;
          block.arguments = args;
          stream.push({
            type: "toolcall_end",
            contentIndex: state.contentIndex,
            toolCall: {
              type: "toolCall",
              id: state.id,
              name: state.name,
              arguments: args,
            },
            partial: output,
          });
        }
      }

      if (toolCallsState.some((state) => state?.emittedStart)) {
        output.stopReason = "toolUse";
      } else if (output.stopReason === "pending") {
        output.stopReason = "stop";
      }

      if (output.stopReason === "error" || output.stopReason === "aborted") {
        throw new Error(output.errorMessage || "Qoder stream ended with an error");
      }

      stream.push({
        type: "done",
        reason: doneReason(output.stopReason),
        message: output,
      });
      stream.end();
    } catch (e: unknown) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = e instanceof Error ? e.message : String(e);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      try {
        stream.end();
      } catch {}
    }
  })();

  return stream;
}
