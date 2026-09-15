import type {
  Tool,
  ImageContent,
  Message,
} from "@earendil-works/pi-ai";

interface QoderTool {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

interface QoderToolCall {
  id?: string;
  type: "function";
  function: { name?: string; arguments: string };
}

type QoderTextPart = { type: "text"; text: string };
type QoderImagePart = { type: "image_url"; image_url: { url: string } };
type QoderContent = string | Array<QoderTextPart | QoderImagePart>;

export interface QoderMessage {
  role: "user" | "assistant" | "tool" | "system";
  content: QoderContent | null;
  tool_calls?: QoderToolCall[];
  tool_call_id?: string;
}

export function getContentText(msg: Message): string {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((c) => {
        if (c.type === "text") return c.text;
        if (c.type === "thinking") return c.thinking;
        return "";
      })
      .join("");
  }
  return "";
}

export function getContentImages(msg: Message): ImageContent[] {
  if (!Array.isArray(msg.content)) return [];
  return msg.content.filter((c): c is ImageContent => c.type === "image");
}

const MAX_QODER_TOOLS = 128;

/** Reserve valid names first so a renamed tool cannot impersonate another tool. */
export function createToolNameMap(names: string[]): Map<string, string> {
  const unique = [...new Set(names)];
  const used = new Set(unique.filter((name) => /^[a-zA-Z0-9_-]{1,64}$/.test(name)));
  const mapping = new Map<string, string>();
  for (const original of unique) {
    const clean = (original || "tool").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "tool";
    let name = clean;
    if (name !== original) {
      for (let i = 2; used.has(name); i++) {
        const suffix = `_${i}`;
        name = `${clean.slice(0, 64 - suffix.length)}${suffix}`;
      }
    }
    used.add(name);
    mapping.set(original, name);
  }
  return mapping;
}

export function transformTools(tools: Tool[], names = createToolNameMap(tools.map((tool) => tool.name))): QoderTool[] {
  const out: QoderTool[] = [];
  for (const t of tools) {
    const name = names.get(t.name) ?? t.name;
    if (name !== t.name) console.warn(`[pi-qoder] tool renamed for gateway: ${t.name} -> ${name}`);
    out.push({ type: "function", function: { name, description: t.description, parameters: t.parameters } });
    if (out.length >= MAX_QODER_TOOLS) {
      console.warn(`[pi-qoder] ${tools.length} tools exceed gateway cap ${MAX_QODER_TOOLS}, truncated`);
      break;
    }
  }
  return out;
}

function lastUserIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

function imageUrl(img: ImageContent): QoderImagePart {
  return { type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.data}` } };
}

function userImageNote(count: number): string {
  return `[${count} image attachment(s) from this earlier turn are not replayed.]`;
}

function toolImageNote(count: number): string {
  return `[${count} image(s) in this earlier tool result are not replayed.]`;
}

export function transformMessagesForQoder(
  messages: Message[],
  preserveAllImages = false,
  toolNames: ReadonlyMap<string, string> = new Map(),
): QoderMessage[] {
  const normalizedMessages: QoderMessage[] = [];
  const toolImageMessages: QoderMessage[] = [];
  const droppedToolCallIds = new Set<string>();
  const currentUserIndex = lastUserIndex(messages);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role !== "toolResult" && toolImageMessages.length > 0) {
      normalizedMessages.push(...toolImageMessages);
      toolImageMessages.length = 0;
    }
    if (msg.role === "assistant" && (msg.stopReason === "error" || msg.stopReason === "aborted")) {
      for (const block of msg.content) {
        if (block.type === "toolCall" && block.id) droppedToolCallIds.add(block.id);
      }
      continue;
    }

    if (msg.role === "toolResult" && droppedToolCallIds.has(msg.toolCallId)) {
      continue;
    }

    if (msg.role === "user") {
      let content: QoderContent = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const images = getContentImages(msg);
        if (images.length > 0 && !preserveAllImages && i !== currentUserIndex) {
          const text = getContentText(msg);
          const note = userImageNote(images.length);
          content = text ? `${text}\n\n${note}` : note;
        } else if (images.length > 0) {
          content = msg.content
            .map((c): QoderTextPart | QoderImagePart | null => {
              if (c.type === "text") return { type: "text", text: c.text };
              if (c.type === "image") return imageUrl(c);
              return null;
            })
            .filter((p): p is QoderTextPart | QoderImagePart => p !== null);
        } else {
          content = getContentText(msg);
        }
      }
      normalizedMessages.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      let content = "";
      const toolCalls: QoderToolCall[] = [];
      // Legacy shape: older persisted sessions may carry string content.
      if (typeof msg.content === "string") {
        content = msg.content;
      } else {
        for (const block of msg.content) {
        if (block.type === "text") {
          content += block.text;
        } else if (block.type === "thinking") {
          content += `<thinking>${block.thinking}</thinking>\n\n`;
        } else if (block.type === "toolCall") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: toolNames.get(block.name) ?? block.name,
              arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments),
            },
          });
        }
        }
      }

      const mapped: QoderMessage = {
        role: "assistant",
        content: content || (toolCalls.length > 0 ? " " : null),
      };
      if (toolCalls.length > 0) mapped.tool_calls = toolCalls;
      normalizedMessages.push(mapped);
    } else if (msg.role === "toolResult") {
      const images = getContentImages(msg);
      const replayImages = images.length > 0 && (preserveAllImages || i > currentUserIndex);
      const text = getContentText(msg);
      normalizedMessages.push({
        role: "tool",
        tool_call_id: msg.toolCallId,
        content: !replayImages && images.length > 0 ? `${text}\n\n${toolImageNote(images.length)}`.trim() : text,
      });

      if (replayImages) {
        // Keep parallel tool results adjacent; attach images after the whole group.
        toolImageMessages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: `[${images.length} image${images.length === 1 ? "" : "s"} returned by tool call ${msg.toolCallId}]`,
            },
            ...images.map(imageUrl),
          ],
        });
      }
    }
  }

  normalizedMessages.push(...toolImageMessages);
  return normalizedMessages;
}

export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && "text" in part) return String((part as { text: unknown }).text ?? "");
        return "";
      })
      .join("\n");
  }
  return "";
}
