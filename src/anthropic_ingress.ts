// Anthropic Messages API ingress.
//
// Clients built on Anthropic's SDKs speak POST /v1/messages, not the OpenAI
// chat shape. Rewriting those clients is the kind of friction that makes a
// team route around a gateway, so the gateway accepts the Messages shape,
// translates it to the internal chat request, runs the unchanged pipeline,
// and translates the answer back: a message object for a JSON response, the
// message_start to message_stop event sequence for a stream, and the
// Anthropic error object for a refusal. Nothing in policy, transformation,
// receipts, or provider selection knows which ingress was used.
//
// Fields the pipeline cannot inspect or the providers cannot honour uniformly
// are refused rather than dropped, matching the OpenAI ingress: top_k,
// stop_sequences, metadata (which carries an end-user id the gateway must
// never forward), and non-text content blocks.
import type { ChatMessage, ChatRequest, ChatTool, JsonObject, ToolCall } from "./types.ts";

interface AnthropicTextBlock {
  type: "text";
  text: string;
}
interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}
interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | AnthropicTextBlock[];
  is_error?: boolean;
}
type AnthropicBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

export interface AnthropicRequest {
  model: string;
  max_tokens: number;
  system?: string | AnthropicTextBlock[];
  messages: Array<{ role: "user" | "assistant"; content: string | AnthropicBlock[] }>;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  tools?: Array<{ name: string; description?: string; input_schema: Record<string, unknown> }>;
  tool_choice?: {
    type: "auto" | "any" | "tool";
    name?: string;
    disable_parallel_tool_use?: boolean;
  };
}

const REQUEST_FIELDS = new Set([
  "model",
  "max_tokens",
  "system",
  "messages",
  "stream",
  "temperature",
  "top_p",
  "tools",
  "tool_choice",
]);
const REFUSED_FIELDS: Record<string, string> = {
  top_k: "top_k is not supported across providers.",
  stop_sequences: "stop_sequences are not supported.",
  metadata:
    "metadata is not forwarded; the gateway never sends an end-user identity to a provider.",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function blockText(content: string | AnthropicTextBlock[] | undefined): string | null {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return null;
    parts.push(block.text);
  }
  return parts.join("");
}

// Returns a message for the caller when the request cannot be accepted, or
// null when it can. Structural checks only; the translated request still
// passes the OpenAI-shape validation afterwards.
export function validateAnthropicRequest(value: unknown): string | null {
  if (!isRecord(value)) return "Body must be an object.";
  for (const key of Object.keys(value)) {
    if (REFUSED_FIELDS[key]) return REFUSED_FIELDS[key]!;
    if (!REQUEST_FIELDS.has(key)) return "Request contains unsupported fields.";
  }
  if (typeof value.model !== "string" || !value.model) return "model is required.";
  if (!Number.isInteger(value.max_tokens) || (value.max_tokens as number) < 1) {
    return "max_tokens must be a positive integer.";
  }
  if (value.system !== undefined && blockText(value.system as never) === null) {
    return "system must be text or text blocks.";
  }
  if (!Array.isArray(value.messages) || value.messages.length === 0) {
    return "messages must contain at least one item.";
  }
  for (const message of value.messages) {
    if (!isRecord(message) || !["user", "assistant"].includes(message.role as string)) {
      return "Messages must have a user or assistant role.";
    }
    if (typeof message.content === "string") continue;
    if (!Array.isArray(message.content)) return "Message content must be text or blocks.";
    for (const block of message.content) {
      if (!isRecord(block)) return "Content blocks must be objects.";
      if (block.type === "text") {
        if (typeof block.text !== "string") return "Text blocks require text.";
      } else if (block.type === "tool_use") {
        if (message.role !== "assistant") return "tool_use blocks belong to assistant messages.";
        if (typeof block.id !== "string" || typeof block.name !== "string") {
          return "tool_use blocks require id and name.";
        }
      } else if (block.type === "tool_result") {
        if (message.role !== "user") return "tool_result blocks belong to user messages.";
        if (typeof block.tool_use_id !== "string") return "tool_result blocks require tool_use_id.";
        if (block.content !== undefined && blockText(block.content as never) === null) {
          return "tool_result content must be text or text blocks.";
        }
      } else {
        return "Only text, tool_use, and tool_result blocks are supported.";
      }
    }
  }
  if (value.tools !== undefined) {
    if (!Array.isArray(value.tools)) return "tools must be an array.";
    for (const tool of value.tools) {
      if (!isRecord(tool) || typeof tool.name !== "string" || !isRecord(tool.input_schema)) {
        return "Each tool requires a name and an input_schema.";
      }
    }
  }
  if (value.tool_choice !== undefined) {
    const choice = value.tool_choice;
    if (!isRecord(choice) || !["auto", "any", "tool"].includes(choice.type as string)) {
      return "tool_choice must be auto, any, or tool.";
    }
    if (choice.type === "tool" && typeof choice.name !== "string") {
      return "tool_choice of type tool requires a name.";
    }
  }
  return null;
}

export function toChatRequest(request: AnthropicRequest): ChatRequest {
  const messages: ChatMessage[] = [];
  const system = blockText(request.system);
  if (system) messages.push({ role: "system", content: system });
  for (const message of request.messages) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }
    if (message.role === "user") {
      const text: string[] = [];
      for (const block of message.content) {
        if (block.type === "text") text.push(block.text);
        else if (block.type === "tool_result") {
          messages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: blockText(block.content) ?? "",
          });
        }
      }
      if (text.length) messages.push({ role: "user", content: text.join("") });
    } else {
      const text: string[] = [];
      const toolCalls: ToolCall[] = [];
      for (const block of message.content) {
        if (block.type === "text") text.push(block.text);
        else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: { name: block.name, arguments: JSON.stringify(block.input ?? {}) },
          });
        }
      }
      messages.push({
        role: "assistant",
        content: text.length ? text.join("") : null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });
    }
  }
  const tools: ChatTool[] | undefined = request.tools?.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      parameters: tool.input_schema as JsonObject,
    },
  }));
  const choice = request.tool_choice;
  return {
    model: request.model,
    messages,
    max_tokens: request.max_tokens,
    ...(request.stream !== undefined ? { stream: request.stream } : {}),
    ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    ...(request.top_p !== undefined ? { top_p: request.top_p } : {}),
    ...(tools ? { tools } : {}),
    ...(choice
      ? {
        tool_choice: choice.type === "auto"
          ? "auto"
          : choice.type === "any"
          ? "required"
          : { type: "function", function: { name: choice.name! } },
      }
      : {}),
  };
}

function stopReason(finish: unknown): string {
  if (finish === "tool_calls") return "tool_use";
  if (finish === "length") return "max_tokens";
  return "end_turn";
}

// A completed OpenAI-shaped response as an Anthropic message.
export function toAnthropicMessage(data: Record<string, unknown>): Record<string, unknown> {
  const choice = Array.isArray(data.choices) ? data.choices[0] as Record<string, unknown> : {};
  const message = isRecord(choice?.message) ? choice.message : {};
  const content: Array<Record<string, unknown>> = [];
  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  }
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    if (!isRecord(call) || !isRecord(call.function)) continue;
    let input: unknown = {};
    try {
      input = JSON.parse(String(call.function.arguments ?? "{}"));
    } catch {
      input = { _raw: String(call.function.arguments ?? "") };
    }
    content.push({ type: "tool_use", id: call.id, name: call.function.name, input });
  }
  const usage = isRecord(data.usage) ? data.usage : {};
  return {
    id: `msg_${String(data.id ?? crypto.randomUUID()).replace(/^chatcmpl-/, "")}`,
    type: "message",
    role: "assistant",
    model: data.model,
    content,
    stop_reason: stopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: Number(usage.prompt_tokens ?? 0),
      output_tokens: Number(usage.completion_tokens ?? 0),
    },
  };
}

const ERROR_TYPES: Record<number, string> = {
  400: "invalid_request_error",
  401: "authentication_error",
  403: "permission_error",
  404: "not_found_error",
  409: "invalid_request_error",
  413: "invalid_request_error",
  422: "invalid_request_error",
  429: "rate_limit_error",
};

// A gateway problem document as an Anthropic error object. The receipt id is
// carried as an extra field, which SDKs ignore and operators can read.
export function toAnthropicError(status: number, problem: Record<string, unknown>): unknown {
  return {
    type: "error",
    error: {
      type: ERROR_TYPES[status] ?? (status >= 500 ? "api_error" : "invalid_request_error"),
      message: typeof problem.detail === "string" ? problem.detail : String(problem.title ?? ""),
      ...(typeof problem.receiptId === "string" ? { receipt_id: problem.receiptId } : {}),
      ...(typeof problem.title === "string" ? { code: problem.title } : {}),
    },
  };
}

// Rewrites the gateway's recomposed OpenAI chunk stream into Anthropic events
// as it passes. Text deltas become one text block; each tool call becomes a
// tool_use block fed by input_json_delta; the finish reason closes the
// message. An error payload from the recomposer becomes an error event.
export function toAnthropicStream(
  upstream: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = upstream.getReader();
  let input = "";
  let started = false;
  let stopped = false;
  let nextIndex = 0;
  let textIndex: number | null = null;
  const toolIndexes = new Map<number, number>();
  let outputTokens = 0;

  const event = (name: string, payload: unknown): string =>
    `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
  const start = (): string => {
    if (started) return "";
    started = true;
    return event("message_start", {
      type: "message_start",
      message: {
        id: `msg_${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    });
  };
  const closeBlocks = (): string => {
    let out = "";
    if (textIndex !== null) {
      out += event("content_block_stop", { type: "content_block_stop", index: textIndex });
      textIndex = null;
    }
    for (const index of toolIndexes.values()) {
      out += event("content_block_stop", { type: "content_block_stop", index });
    }
    toolIndexes.clear();
    return out;
  };
  const stop = (finish: unknown): string => {
    if (stopped) return "";
    stopped = true;
    return closeBlocks() +
      event("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stopReason(finish), stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }) + event("message_stop", { type: "message_stop" });
  };
  const translate = (chunk: Record<string, unknown>): string => {
    let out = start();
    if (isRecord(chunk.error)) {
      return out + event("error", {
        type: "error",
        error: { type: "api_error", message: String(chunk.error.message ?? "stream error") },
      });
    }
    if (isRecord(chunk.usage) && typeof chunk.usage.completion_tokens === "number") {
      outputTokens = chunk.usage.completion_tokens;
    }
    for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
      if (!isRecord(choice)) continue;
      const delta = isRecord(choice.delta) ? choice.delta : {};
      if (typeof delta.content === "string" && delta.content) {
        if (textIndex === null) {
          textIndex = nextIndex++;
          out += event("content_block_start", {
            type: "content_block_start",
            index: textIndex,
            content_block: { type: "text", text: "" },
          });
        }
        out += event("content_block_delta", {
          type: "content_block_delta",
          index: textIndex,
          delta: { type: "text_delta", text: delta.content },
        });
      }
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        if (!isRecord(call)) continue;
        const toolIndex = typeof call.index === "number" ? call.index : 0;
        const fn = isRecord(call.function) ? call.function : {};
        let blockIndex = toolIndexes.get(toolIndex);
        if (blockIndex === undefined) {
          blockIndex = nextIndex++;
          toolIndexes.set(toolIndex, blockIndex);
          out += event("content_block_start", {
            type: "content_block_start",
            index: blockIndex,
            content_block: {
              type: "tool_use",
              id: String(call.id ?? `toolu_${blockIndex}`),
              name: String(fn.name ?? ""),
              input: {},
            },
          });
        }
        if (typeof fn.arguments === "string" && fn.arguments) {
          out += event("content_block_delta", {
            type: "content_block_delta",
            index: blockIndex,
            delta: { type: "input_json_delta", partial_json: fn.arguments },
          });
        }
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        out += stop(choice.finish_reason);
      }
    }
    return out;
  };

  return new ReadableStream<Uint8Array>({
    // A pull must enqueue something or close; returning empty-handed leaves
    // the caller's read pending forever. So keep reading until there is
    // output or the upstream is done.
    async pull(controller) {
      let out = "";
      let done = false;
      while (!out && !done) {
        const read = await reader.read();
        done = read.done;
        input += decoder.decode(read.value, { stream: !done });
        out += drain();
        if (done) out += start() + stop("stop");
      }
      if (out) controller.enqueue(encoder.encode(out));
      if (done) controller.close();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  function drain(): string {
    let out = "";
    let boundary: number;
    while ((boundary = input.indexOf("\n\n")) !== -1) {
      const frame = input.slice(0, boundary);
      input = input.slice(boundary + 2);
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) =>
        line.slice(5).trimStart()
      ).join("\n");
      if (!data) continue;
      if (data === "[DONE]") {
        out += start() + stop("stop");
        continue;
      }
      try {
        out += translate(JSON.parse(data) as Record<string, unknown>);
      } catch {
        out += start() + event("error", {
          type: "error",
          error: { type: "api_error", message: "malformed stream event" },
        });
      }
    }
    return out;
  }
}
