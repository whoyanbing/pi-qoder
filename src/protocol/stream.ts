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
import { getCachedModelConfig, updateQoderModelsCache } from "../catalog.js";
import { MAX_OUTPUT_TOKENS, USER_EMAIL_FALLBACK, USER_NAME_FALLBACK, getChatURL } from "../config.js";
import { buildAuthHeaders, getMachineId } from "../cosy.js";
import { readResponseTextLimited } from "../network.js";
import { qoderEncodeBody } from "./encoding.js";
import { stripThinkingTags, ThinkingTagParser } from "./thinking.js";
import { contentToText, getContentImages, getContentText, transformMessagesForQoder, transformTools } from "./transform.js";

const sessionFallbackCache = new Map<string, string>();

export function __clearSessionFallbackCacheForTests(): void {
  sessionFallbackCache.clear();
}

function resolveSessionID(stablePart: string, fingerprint: string): string {
  const hit = sessionFallbackCache.get(`${stablePart}:${fingerprint}`);
  if (hit) return hit;
  const id = `${stablePart}-${crypto.randomUUID()}`;
  sessionFallbackCache.set(`${stablePart}:${fingerprint}`, id);
  if (sessionFallbackCache.size > 200) {
    const oldest = sessionFallbackCache.keys().next();
    if (!oldest.done) sessionFallbackCache.delete(oldest.value);
  }
  return id;
}

export const lastStreamDiag: { at: number | null; error: string | null } = { at: null, error: null };

const MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024;
const MAX_TOOL_ARGUMENT_BYTES = 1024 * 1024;

interface ToolCallState {
  arguments: string;
  id: string;
  name: string;
  emittedStart?: boolean;
  emittedEnd?: boolean;
  emittedArgumentLength: number;
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
  const parts: string[] = [model];
  for (const msg of messages) {
    if (msg?.role) parts.push(msg.role);
    if (msg?.content) parts.push(typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content));
  }
  if (tools) parts.push(JSON.stringify(tools));
  parts.push(`mt=${maxTokens}`);
  return stableHash("qoder-record", ...parts);
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

const PROTECTED_HEADERS = new Set([
  "authorization",
  "cosy-key",
  "cosy-user",
  "cosy-date",
  "cosy-version",
  "cosy-machineid",
  "cosy-machinetoken",
  "cosy-bodyhash",
  "cosy-bodylength",
  "cosy-sigpath",
]);

function requestHeaders(
  custom: Record<string, string | null> | undefined,
  signed: Record<string, string>,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [name, value] of Object.entries(custom ?? {})) {
    if (value !== null && !PROTECTED_HEADERS.has(name.toLowerCase())) merged[name] = value;
  }
  return {
    ...merged,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
    "Accept-Encoding": "identity",
    ...signed,
  };
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
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let activeReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const accessToken = options?.apiKey;
      if (!accessToken) {
        throw new Error("Qoder credentials not set. Run /login qoder or set QODER_PERSONAL_ACCESS_TOKEN.");
      }

      const ident = await resolveQoderIdentity(accessToken, model.provider, options?.signal);
      const userID = ident.userID || "qoder-user";
      const name = ident.name || USER_NAME_FALLBACK;
      const email = ident.email || USER_EMAIL_FALLBACK;
      const machineID = ident.machineID || getMachineId();

      let modelConfig = getCachedModelConfig(model.id);
      if (!modelConfig?.key) {
        try {
          const refreshed = await updateQoderModelsCache(accessToken, userID, name, email, options?.signal);
          if (refreshed) modelConfig = getCachedModelConfig(model.id);
        } catch {}
      }
      if (!modelConfig?.key) {
        throw new Error(`Unknown Qoder model id: ${model.id}. Run /qoder.refresh or /qoder.model to sync the live catalog.`);
      }
      const qoderModel = modelConfig.key;
      const isReasoning = Boolean(modelConfig.is_reasoning || modelConfig.thinking_config);

      const preserveImages = model.input?.includes("image") ?? false;
      const normalizedMessages = transformMessagesForQoder(context.messages, preserveImages);
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
      // Same-process reuse: same model+user+first-prompt shares server session for caching;
      // process restart generates new ids so sessions never collide across restarts.
      const firstUserMsg = context.messages.find((m) => m.role === "user");
      const fingerprint = firstUserMsg ? `${getContentText(firstUserMsg)}|images=${getContentImages(firstUserMsg).length}` : "";
      const sessionID = options?.sessionId
        ? `${stablePart}-${options.sessionId}`
        : resolveSessionID(stablePart, fingerprint);

      let maxTokens = MAX_OUTPUT_TOKENS;
      if (options?.maxTokens && options.maxTokens < maxTokens) {
        maxTokens = options.maxTokens;
      }

      const toolsRaw =
        options?.toolChoice === "none" || !context.tools || context.tools.length === 0
          ? undefined
          : transformTools(context.tools);
      const recordID = stableChatRecordID(qoderModel, normalizedMessages, toolsRaw, maxTokens);

      const requestedLevel = options?.reasoning;
      const clamped = requestedLevel ? clampThinkingLevel(model, requestedLevel) : undefined;
      const reasoningLevel = clamped === "off" ? undefined : clamped;
      const parameters: Record<string, unknown> = { max_tokens: maxTokens };
      if (typeof options?.temperature === "number") parameters.temperature = options.temperature;
      if (model.samplingParams) Object.assign(parameters, model.samplingParams);
      if (options?.samplingParams) Object.assign(parameters, options.samplingParams);
      let effort: string | undefined;
      if (reasoningLevel) {
        parameters.enable_thinking = true;
        const mapped = model.thinkingLevelMap?.[reasoningLevel];
        effort = mapped && mapped !== "enabled" && mapped !== "disabled" ? mapped : reasoningLevel;
        output.providerThinkingLevel = effort;
        if (modelConfig.thinking_config?.enabled?.efforts && typeof effort === "string") {
          parameters.reasoning_effort = effort;
        }
      } else {
        parameters.enable_thinking = false;
      }

      const imageUrls: string[] = [];
      for (const m of normalizedMessages) {
        const c = m.content;
        if (Array.isArray(c)) {
          for (const part of c) {
            if (part.type === "image_url" && part.image_url?.url) imageUrls.push(part.image_url.url);
          }
        }
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
        chat_prompt: lastUserText,
        image_urls: imageUrls.length > 0 ? imageUrls : null,
        aliyun_user_type: "",
        system: systemText,
        messages: systemText ? [{ role: "system", content: systemText }, ...normalizedMessages] : normalizedMessages,
        tools: toolsRaw || [],
        parameters,
        chat_context: {
          chatPrompt: lastUserText,
          imageUrls: imageUrls.length > 0 ? imageUrls : null,
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

      const modelKeyAfterPayload = (reqBody.model_config as { key?: unknown } | undefined)?.key;
      const effectiveModelKey = typeof modelKeyAfterPayload === "string" && modelKeyAfterPayload ? modelKeyAfterPayload : qoderModel;
      const modelSourceAfterPayload = (reqBody.model_config as { source?: unknown } | undefined)?.source;
      const effectiveSource = typeof modelSourceAfterPayload === "string" && modelSourceAfterPayload ? modelSourceAfterPayload : String(modelConfig.source || "system");
      const encodedBytes = Buffer.from(qoderEncodeBody(Buffer.from(JSON.stringify(reqBody))), "utf8");
      const chatURL = getChatURL();
      const headers = buildAuthHeaders(encodedBytes, chatURL, {
        userID,
        authToken: accessToken,
        name,
        email,
        machineID,
      });

      // Pi supplies its configured HTTP idle timeout. Keep a finite fallback for
      // direct compat/SDK consumers that call the provider without Pi's wrapper.
      const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000;
      const idleController = timeoutMs && timeoutMs > 0 ? new AbortController() : undefined;
      const requestSignal = idleController
        ? options?.signal
          ? AbortSignal.any([options.signal, idleController.signal])
          : idleController.signal
        : options?.signal;
      const armIdleTimeout = () => {
        if (!idleController || !timeoutMs) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => idleController.abort(new Error(`Qoder stream idle timeout after ${timeoutMs}ms`)),
          timeoutMs,
        );
        idleTimer.unref?.();
      };

      const doFetch = options?.fetch ?? globalThis.fetch;
      armIdleTimeout();
      let response: Response;
      try {
        response = await doFetch(chatURL, {
          method: "POST",
          headers: requestHeaders(options?.headers, {
            "X-Model-Key": effectiveModelKey,
            "X-Model-Source": effectiveSource,
            ...headers,
          }),
          body: encodedBytes,
          signal: requestSignal,
        });
      } catch (error) {
        if (idleController?.signal.aborted && !options?.signal?.aborted) throw idleController.signal.reason || error;
        throw error;
      }

      await options?.onResponse?.(
        {
          status: response.status,
          headers: Object.fromEntries(response.headers.entries()),
        },
        model,
      );

      if (!response.ok && [429, 502, 503, 504].includes(response.status)) {
        const firstErr = await readResponseTextLimited(response).catch(() => "");
        await new Promise((r) => setTimeout(r, 800));
        armIdleTimeout();
        response = await doFetch(chatURL, {
          method: "POST",
          headers: requestHeaders(options?.headers, {
            "X-Model-Key": effectiveModelKey,
            "X-Model-Source": effectiveSource,
            ...headers,
          }),
          body: encodedBytes,
          signal: requestSignal,
        });
        await options?.onResponse?.(
          {
            status: response.status,
            headers: Object.fromEntries(response.headers.entries()),
          },
          model,
        );
        if (!response.ok) {
          const errText = await readResponseTextLimited(response).catch(() => firstErr);
          throw new Error(`Qoder API request failed: ${response.status} ${response.statusText}. Response: ${errText}`);
        }
      } else if (!response.ok) {
        const errText = await readResponseTextLimited(response);
        throw new Error(`Qoder API request failed: ${response.status} ${response.statusText}. Response: ${errText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error("No response body");
      activeReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";

      let contentBlockIndex = -1;
      let thinkingBlockIndex = -1;
      const toolCallsState: ToolCallState[] = [];
      const thinkingEnabled = reasoningLevel !== undefined;
      const thinkingParser = thinkingEnabled ? new ThinkingTagParser(output, stream) : null;
      const finishContentBlock = () => {
        if (contentBlockIndex === -1) return;
        const index = contentBlockIndex;
        const block = output.content[index] as TextContent;
        stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
        contentBlockIndex = -1;
      };
      const finishThinkingBlock = () => {
        if (thinkingBlockIndex === -1) return;
        const index = thinkingBlockIndex;
        const block = output.content[index] as ThinkingContent;
        stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
        thinkingBlockIndex = -1;
      };
      const finishOpenBlocks = () => {
        thinkingParser?.finalize();
        finishContentBlock();
        finishThinkingBlock();
      };

      stream.push({ type: "start", partial: output });

      // Qoder's gateway often keeps the HTTP body open after `data: [DONE]`.
      // Stop the read loop on the sentinel instead of waiting for the socket.
      let sawDone = false;
      let sawFinishReason = false;

      while (!sawDone) {
        armIdleTimeout();
        let readResult: ReadableStreamReadResult<Uint8Array>;
        try {
          readResult = await reader.read();
        } catch (error) {
          if (idleController?.signal.aborted && !options?.signal?.aborted) throw idleController.signal.reason || error;
          throw error;
        }
        const { done, value } = readResult;
        if (done) {
          buffer += decoder.decode();
          if (buffer && !buffer.endsWith("\n")) buffer += "\n";
        } else {
          armIdleTimeout();
          buffer += decoder.decode(value, { stream: true });
        }
        if (Buffer.byteLength(buffer, "utf8") > MAX_SSE_BUFFER_BYTES) {
          throw new Error(`Qoder SSE frame exceeded ${MAX_SSE_BUFFER_BYTES} bytes`);
        }

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
                reasoning_tokens?: number;
                prompt_tokens_details?: {
                  cacheable_tokens?: number;
                  cached_tokens?: number;
                  cache_write_tokens?: number;
                };
                completion_tokens_details?: { reasoning_tokens?: number };
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
              // Keep-alive / mid-stream zeros must not flash the footer to 0%.
              if (promptTokens > 0) {
                const cacheReadTokens = inner.usage.prompt_tokens_details?.cached_tokens ?? 0;
                const cacheWriteTokens = inner.usage.prompt_tokens_details?.cache_write_tokens ?? 0;
                output.usage.input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
                output.usage.output = inner.usage.completion_tokens ?? 0;
                output.usage.totalTokens = inner.usage.total_tokens ?? 0;
                output.usage.cacheRead = cacheReadTokens;
                output.usage.cacheWrite = cacheWriteTokens;
                const reasoningTokens = inner.usage.reasoning_tokens ?? inner.usage.completion_tokens_details?.reasoning_tokens;
                if (typeof reasoningTokens === "number") output.usage.reasoning = reasoningTokens;
              }
            }

            const choice = inner.choices?.[0];
            const delta = choice?.delta;
            if (delta) {
              if (delta.reasoning_content) {
                const reasoningChunk = stripThinkingTags(delta.reasoning_content);
                if (reasoningChunk) {
                  thinkingParser?.finishTextBlock();
                  finishContentBlock();
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
                finishThinkingBlock();

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
                    toolCallsState[idx] = {
                      arguments: "",
                      id: "",
                      name: "",
                      contentIndex: -1,
                      emittedArgumentLength: 0,
                    };
                  }
                  const state = toolCallsState[idx];
                  if (tc.id) state.id = tc.id;
                  if (tc.function?.name) state.name = tc.function.name;
                  if (tc.function?.arguments) {
                    state.arguments += tc.function.arguments;
                    if (Buffer.byteLength(state.arguments, "utf8") > MAX_TOOL_ARGUMENT_BYTES) {
                      throw new Error(`Qoder tool arguments exceeded ${MAX_TOOL_ARGUMENT_BYTES} bytes`);
                    }
                  }

                  // Buffer fragments until both identifiers are available. Emitting
                  // deltas against contentIndex=0 can otherwise mutate an unrelated block.
                  if (!state.emittedStart && state.id && state.name) {
                    finishOpenBlocks();
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
                    if (state.arguments.length > state.emittedArgumentLength) {
                      const argDelta = state.arguments.slice(state.emittedArgumentLength);
                      state.emittedArgumentLength = state.arguments.length;
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
            }

            if (choice?.finish_reason) {
              sawFinishReason = true;
              output.stopReason = mapFinishReason(choice.finish_reason);
            }
          } catch (error) {
            if (error instanceof SyntaxError) {
              throw new Error(`Malformed Qoder SSE data: ${dataStr.slice(0, 200)}`, { cause: error });
            }
            throw error;
          }
        }
        if (done) break;
      }

      if (!sawDone && !sawFinishReason) {
        throw new Error("Qoder connection closed before the response completed");
      }

      await reader.cancel().catch(() => {});
      activeReader = undefined;
      thinkingParser?.finalize();
      finishContentBlock();
      finishThinkingBlock();

      for (const state of toolCallsState) {
        if (!state) continue;
        if (!state.emittedStart && (state.id || state.name || state.arguments)) {
          throw new Error(
            `Incomplete Qoder tool call: id=${state.id || "<missing>"}, name=${state.name || "<missing>"}`,
          );
        }
        if (state.emittedStart && !state.emittedEnd) {
          state.emittedEnd = true;
          let args: Record<string, unknown> = {};
          if (state.arguments) {
            try {
              const parsed = JSON.parse(state.arguments) as unknown;
              if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("tool arguments must be a JSON object");
              }
              args = parsed as Record<string, unknown>;
            } catch (error) {
              throw new Error(
                `Invalid JSON arguments for Qoder tool ${state.name} (${state.id}): ${state.arguments.slice(0, 200)}`,
                { cause: error },
              );
            }
          }
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

      if (
        toolCallsState.some((state) => state?.emittedStart) &&
        output.stopReason !== "error" &&
        output.stopReason !== "aborted" &&
        output.stopReason !== "length"
      ) {
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
      lastStreamDiag.at = Date.now();
      lastStreamDiag.error = output.errorMessage;
      stream.push({ type: "error", reason: output.stopReason, error: output });
      try {
        stream.end();
      } catch {}
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      await activeReader?.cancel().catch(() => {});
    }
  })();

  return stream;
}
