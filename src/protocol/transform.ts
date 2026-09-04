import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
  ToolResultMessage,
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
        if (c.type === "text") return (c as TextContent).text;
        if (c.type === "thinking") return (c as ThinkingContent).thinking;
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

export function transformTools(tools: Tool[]): QoderTool[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
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

export function transformMessagesForQoder(messages: Message[]): QoderMessage[] {
  const normalizedMessages: QoderMessage[] = [];
  const droppedToolCallIds = new Set<string>();
  const currentUserIndex = lastUserIndex(messages);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (
      msg.role === "assistant" &&
      ((msg as AssistantMessage).stopReason === "error" || (msg as AssistantMessage).stopReason === "aborted")
    ) {
      const am = msg as AssistantMessage;
      if (Array.isArray(am.content)) {
        for (const block of am.content) {
          if (block.type === "toolCall") {
            const id = (block as ToolCall).id;
            if (id) droppedToolCallIds.add(id);
          }
        }
      }
      continue;
    }

    if (msg.role === "toolResult" && droppedToolCallIds.has((msg as ToolResultMessage).toolCallId)) {
      continue;
    }

    if (msg.role === "user") {
      let content: QoderContent = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        const images = getContentImages(msg);
        if (images.length > 0 && i !== currentUserIndex) {
          const text = getContentText(msg);
          const note = userImageNote(images.length);
          content = text ? `${text}\n\n${note}` : note;
        } else if (images.length > 0) {
          content = msg.content
            .map((c): QoderTextPart | QoderImagePart | null => {
              if (c.type === "text") return { type: "text", text: (c as TextContent).text };
              if (c.type === "image") return imageUrl(c as ImageContent);
              return null;
            })
            .filter((p): p is QoderTextPart | QoderImagePart => p !== null);
        } else {
          content = getContentText(msg);
        }
      }
      normalizedMessages.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      const am = msg as AssistantMessage;
      let content = "";
      const toolCalls: QoderToolCall[] = [];

      if (Array.isArray(am.content)) {
        for (const block of am.content) {
          if (block.type === "text") {
            content += (block as TextContent).text;
          } else if (block.type === "thinking") {
            content += `<thinking>${(block as ThinkingContent).thinking}</thinking>\n\n`;
          } else if (block.type === "toolCall") {
            const tc = block as ToolCall;
            toolCalls.push({
              id: tc.id,
              type: "function",
              function: {
                name: tc.name,
                arguments: typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments),
              },
            });
          }
        }
      } else if (typeof am.content === "string") {
        content = am.content;
      }

      const mapped: QoderMessage = {
        role: "assistant",
        content: content || (toolCalls.length > 0 ? " " : null),
      };
      if (toolCalls.length > 0) mapped.tool_calls = toolCalls;
      normalizedMessages.push(mapped);
    } else if (msg.role === "toolResult") {
      const tr = msg as ToolResultMessage;
      const images = getContentImages(tr);
      const replayImages = images.length > 0 && i > currentUserIndex;
      const text = getContentText(tr);
      normalizedMessages.push({
        role: "tool",
        tool_call_id: tr.toolCallId,
        content: !replayImages && images.length > 0 ? `${text}\n\n${toolImageNote(images.length)}`.trim() : text,
      });

      if (replayImages) {
        normalizedMessages.push({
          role: "user",
          content: [
            {
              type: "text",
              text: `[${images.length} image${images.length === 1 ? "" : "s"} returned by the previous tool call]`,
            },
            ...images.map(imageUrl),
          ],
        });
      }
    }
  }

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
