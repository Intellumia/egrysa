import type { ChatMessage, ChatRequest, ProviderConfig, ToolCall } from "./types.ts";
import { BodySizeLimitError, readBoundedText } from "./bounded.ts";
import { prepareProviderRequest, ProviderCapabilityError } from "./provider_capabilities.ts";

const DEFAULT_MAX_RESPONSE_BYTES = 32 * 1024 * 1024;

export class ProviderError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

export type ProviderInvocation =
  | { type: "json"; data: Record<string, unknown>; downgraded: string[] }
  | {
    type: "stream";
    response: Response;
    complete: () => void;
    downgraded: string[];
    emulated: boolean;
  };

type AdapterInvocation =
  | { type: "json"; data: Record<string, unknown> }
  | { type: "stream"; response: Response; complete: () => void };

export async function invokeProvider(
  provider: ProviderConfig,
  request: ChatRequest,
  timeoutMs: number,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<ProviderInvocation> {
  if (!provider.allowedModels.includes(request.model)) {
    throw new ProviderError("model is not approved for this provider", 403);
  }
  let prepared;
  try {
    prepared = prepareProviderRequest(provider, request);
  } catch (error) {
    if (error instanceof ProviderCapabilityError) throw new ProviderError(error.message, 422);
    throw error;
  }
  const effectiveRequest = prepared.request;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (provider.kind === "anthropic") {
      if (effectiveRequest.stream) {
        const upstream = await invokeAnthropicStream(
          provider,
          effectiveRequest,
          controller.signal,
        );
        return {
          type: "stream",
          response: translateAnthropicStream(
            upstream.body!,
            effectiveRequest.model,
            effectiveRequest.stream_options?.include_usage,
          ),
          complete: () => clearTimeout(timeout),
          downgraded: prepared.downgraded,
          emulated: false,
        };
      }
      const data = await invokeAnthropic(
        provider,
        effectiveRequest,
        controller.signal,
        maxResponseBytes,
      );
      clearTimeout(timeout);
      return { type: "json", data, downgraded: prepared.downgraded };
    }
    const invocation = await invokeOpenAiCompatible(
      provider,
      effectiveRequest,
      controller.signal,
      maxResponseBytes,
    );
    if (invocation.type === "stream") {
      return {
        ...invocation,
        complete: () => clearTimeout(timeout),
        downgraded: prepared.downgraded,
        emulated: false,
      };
    }
    clearTimeout(timeout);
    return { ...invocation, downgraded: prepared.downgraded };
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

async function invokeOpenAiCompatible(
  provider: ProviderConfig,
  request: ChatRequest,
  signal: AbortSignal,
  maxResponseBytes: number,
): Promise<AdapterInvocation> {
  const headers = new Headers({ "content-type": "application/json" });
  const key = provider.apiKeyEnv ? Deno.env.get(provider.apiKeyEnv) : undefined;
  if (!provider.local && !key) {
    throw new ProviderError(`credential unavailable for provider ${provider.id}`, 503);
  }
  if (key) headers.set("authorization", `Bearer ${key}`);
  const body = sanitizeOpenAiRequest(request);
  const response = await fetch(
    `${provider.baseUrl.replace(/\/$/, "")}/v1/chat/completions`.replace("/v1/v1/", "/v1/"),
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
      redirect: "error",
    },
  );
  if (request.stream) {
    if (!response.ok || !response.body) {
      await throwProviderResponse(response);
    }
    return { type: "stream", response, complete: () => undefined };
  }
  return { type: "json", data: await parseProviderResponse(response, maxResponseBytes) };
}

// One request shape for both the buffered and the streaming path, so the two
// cannot drift in what they send upstream.
function anthropicRequestBody(request: ChatRequest, stream: boolean): Record<string, unknown> {
  const system = request.messages.filter((message) => message.role === "system").map((message) =>
    message.content
  ).join("\n\n");
  return {
    model: request.model,
    messages: toAnthropicMessages(request.messages),
    ...(system ? { system } : {}),
    max_tokens: request.max_tokens ?? 1024,
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.tools?.length && request.tool_choice !== "none"
      ? {
        tools: request.tools.map((tool) => ({
          name: tool.function.name,
          ...(tool.function.description === undefined
            ? {}
            : { description: tool.function.description }),
          input_schema: tool.function.parameters ?? { type: "object", properties: {} },
        })),
      }
      : {}),
    ...anthropicToolChoice(request.tool_choice),
    ...(stream ? { stream: true } : {}),
  };
}

function anthropicHeaders(provider: ProviderConfig): Headers {
  const key = provider.apiKeyEnv ? Deno.env.get(provider.apiKeyEnv) : undefined;
  if (!key) throw new ProviderError(`credential unavailable for provider ${provider.id}`, 503);
  return new Headers({
    "content-type": "application/json",
    "x-api-key": key,
    "anthropic-version": "2023-06-01",
  });
}

async function invokeAnthropicStream(
  provider: ProviderConfig,
  request: ChatRequest,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: anthropicHeaders(provider),
    body: JSON.stringify(anthropicRequestBody(request, true)),
    signal,
    redirect: "error",
  });
  if (!response.ok || !response.body) await throwProviderResponse(response);
  return response;
}

async function invokeAnthropic(
  provider: ProviderConfig,
  request: ChatRequest,
  signal: AbortSignal,
  maxResponseBytes: number,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/v1/messages`, {
    method: "POST",
    headers: anthropicHeaders(provider),
    body: JSON.stringify(anthropicRequestBody(request, false)),
    signal,
    redirect: "error",
  });
  const raw = await parseProviderResponse(response, maxResponseBytes);
  const blocks = Array.isArray(raw.content) ? raw.content as Array<Record<string, unknown>> : [];
  const content = blocks.filter((block) => block.type === "text").map((block) =>
    String(block.text ?? "")
  ).join("");
  const toolCalls: ToolCall[] = blocks.filter((block) => block.type === "tool_use").map((
    block,
  ) => ({
    id: String(block.id ?? ""),
    type: "function" as const,
    function: {
      name: String(block.name ?? ""),
      arguments: JSON.stringify(block.input ?? {}),
    },
  }));
  return {
    id: raw.id ?? `egrysa-${crypto.randomUUID()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: raw.model ?? request.model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: content || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: mapAnthropicFinishReason(raw.stop_reason),
    }],
    usage: raw.usage ?? {},
  };
}

// Anthropic emits its own event stream. This rewrites it into OpenAI chunks as
// they arrive, so tokens reach the caller incrementally instead of after the
// full response. Downstream recomposition is unchanged: it already reassembles
// a surrogate split across chunk boundaries, which is the case native streaming
// makes common rather than rare.
const MAX_ANTHROPIC_EVENT_BYTES = 1024 * 1024;

export function translateAnthropicStream(
  upstream: ReadableStream<Uint8Array>,
  fallbackModel: string,
  includeUsage = false,
): Response {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = upstream.getReader();

  let pending = "";
  let identifier = `egrysa-${crypto.randomUUID()}`;
  let model = fallbackModel;
  const created = Math.floor(Date.now() / 1000);
  let finishReason = "stop";
  let usage: Record<string, unknown> | null = null;
  let roleAnnounced = false;
  let upstreamDone = false;
  const toolSlots = new Map<number, number>();

  const base = () => ({ id: identifier, object: "chat.completion.chunk", created, model });
  const chunk = (delta: Record<string, unknown>, reason: string | null) =>
    `data: ${
      JSON.stringify({ ...base(), choices: [{ index: 0, delta, finish_reason: reason }] })
    }\n\n`;

  // Anthropic can announce the role in message_start or go straight to content;
  // OpenAI clients expect the role on the first delta either way.
  const announceRole = (out: string[]) => {
    if (roleAnnounced) return;
    roleAnnounced = true;
    out.push(chunk({ role: "assistant" }, null));
  };

  const handle = (event: Record<string, unknown>, out: string[]): void => {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "error") {
      const detail = event.error && typeof event.error === "object"
        ? String((event.error as Record<string, unknown>).message ?? "provider stream error")
        : "provider stream error";
      throw new ProviderError(detail, 502);
    }
    if (type === "message_start") {
      const message = event.message && typeof event.message === "object"
        ? event.message as Record<string, unknown>
        : {};
      if (typeof message.id === "string") identifier = message.id;
      if (typeof message.model === "string") model = message.model;
      if (message.usage && typeof message.usage === "object") {
        usage = message.usage as Record<string, unknown>;
      }
      announceRole(out);
      return;
    }
    if (type === "content_block_start") {
      const block = event.content_block && typeof event.content_block === "object"
        ? event.content_block as Record<string, unknown>
        : {};
      if (block.type !== "tool_use") return;
      const index = typeof event.index === "number" ? event.index : 0;
      const slot = toolSlots.size;
      toolSlots.set(index, slot);
      announceRole(out);
      out.push(chunk({
        tool_calls: [{
          index: slot,
          id: typeof block.id === "string" ? block.id : `call_${slot}`,
          type: "function",
          function: {
            name: typeof block.name === "string" ? block.name : "unknown",
            arguments: "",
          },
        }],
      }, null));
      return;
    }
    if (type === "content_block_delta") {
      const delta = event.delta && typeof event.delta === "object"
        ? event.delta as Record<string, unknown>
        : {};
      announceRole(out);
      if (delta.type === "text_delta" && typeof delta.text === "string") {
        out.push(chunk({ content: delta.text }, null));
        return;
      }
      if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
        const index = typeof event.index === "number" ? event.index : 0;
        const slot = toolSlots.get(index) ?? 0;
        out.push(chunk({
          tool_calls: [{ index: slot, function: { arguments: delta.partial_json } }],
        }, null));
      }
      return;
    }
    if (type === "message_delta") {
      const delta = event.delta && typeof event.delta === "object"
        ? event.delta as Record<string, unknown>
        : {};
      if (typeof delta.stop_reason === "string") {
        finishReason = mapAnthropicFinishReason(delta.stop_reason);
      }
      if (event.usage && typeof event.usage === "object") {
        usage = { ...(usage ?? {}), ...(event.usage as Record<string, unknown>) };
      }
    }
    // message_stop, content_block_stop, and ping need no OpenAI equivalent.
  };

  const drain = (out: string[]): void => {
    while (true) {
      const boundary = pending.indexOf("\n\n");
      if (boundary === -1) {
        if (pending.length > MAX_ANTHROPIC_EVENT_BYTES) {
          throw new ProviderError("provider stream event exceeded the size limit", 502);
        }
        return;
      }
      const frame = pending.slice(0, boundary);
      pending = pending.slice(boundary + 2);
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim()).join("");
      if (!data) continue;
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(data) as Record<string, unknown>;
      } catch {
        throw new ProviderError("provider stream sent malformed JSON", 502);
      }
      handle(parsed, out);
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const out: string[] = [];
      try {
        while (out.length === 0 && !upstreamDone) {
          const { value, done } = await reader.read();
          pending += decoder.decode(value, { stream: !done });
          drain(out);
          if (done) {
            upstreamDone = true;
            announceRole(out);
            out.push(chunk({}, finishReason));
            if (includeUsage) {
              out.push(
                `data: ${
                  JSON.stringify({ ...base(), choices: [], usage: openAiUsage(usage ?? {}) })
                }\n\n`,
              );
            }
            out.push("data: [DONE]\n\n");
          }
        }
      } catch (error) {
        controller.error(error);
        return;
      }
      for (const piece of out) controller.enqueue(encoder.encode(piece));
      if (upstreamDone) controller.close();
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream; charset=utf-8" },
  });
}

function openAiUsage(value: unknown): Record<string, number> {
  const usage = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const prompt = numericUsage(usage.prompt_tokens ?? usage.input_tokens);
  const completion = numericUsage(usage.completion_tokens ?? usage.output_tokens);
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: numericUsage(usage.total_tokens) || prompt + completion,
  };
}

function numericUsage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function sanitizeOpenAiRequest(request: ChatRequest): Record<string, unknown> {
  const allowed: Array<keyof ChatRequest> = [
    "model",
    "messages",
    "temperature",
    "max_tokens",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "seed",
    "tools",
    "tool_choice",
    "parallel_tool_calls",
    "stream_options",
  ];
  const body: Record<string, unknown> = {};
  for (const key of allowed) if (request[key] !== undefined) body[key] = request[key];
  body.stream = request.stream ?? false;
  body.store = false;
  return body;
}

function toAnthropicMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.filter((message) => message.role !== "system").map((message) => {
    if (message.role === "tool") {
      return {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: message.tool_call_id,
          content: message.content ?? "",
        }],
      };
    }
    if (message.role === "assistant" && message.tool_calls?.length) {
      return {
        role: "assistant",
        content: [
          ...(message.content ? [{ type: "text", text: message.content }] : []),
          ...message.tool_calls.map((call) => ({
            type: "tool_use",
            id: call.id,
            name: call.function.name,
            input: parseToolArguments(call.function.arguments),
          })),
        ],
      };
    }
    return { role: message.role, content: message.content ?? "" };
  });
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new ProviderError("tool call arguments must be valid JSON", 422);
  }
}

function anthropicToolChoice(
  choice: ChatRequest["tool_choice"],
): Record<string, unknown> {
  if (choice === undefined || choice === "auto") return {};
  if (choice === "none") return {};
  if (choice === "required") return { tool_choice: { type: "any" } };
  return { tool_choice: { type: "tool", name: choice.function.name } };
}

function mapAnthropicFinishReason(value: unknown): string {
  switch (value) {
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    case "end_turn":
    case "stop_sequence":
    default:
      return "stop";
  }
}

async function parseProviderResponse(
  response: Response,
  maxResponseBytes: number,
): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readBoundedText(response, maxResponseBytes);
  } catch (error) {
    if (error instanceof BodySizeLimitError) {
      throw new ProviderError("provider response exceeded the configured size limit");
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw new ProviderError(
      `provider rejected the request (${response.status})`,
      response.status === 429 ? 429 : 502,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProviderError("provider returned an invalid response");
  }
  return parsed as Record<string, unknown>;
}

async function throwProviderResponse(response: Response): Promise<never> {
  await response.body?.cancel();
  throw new ProviderError(
    `provider rejected the request (${response.status})`,
    response.status === 429 ? 429 : 502,
  );
}

export function mapResponseContent(
  response: Record<string, unknown>,
  map: (text: string) => string,
): Record<string, unknown> {
  const choices = Array.isArray(response.choices) ? response.choices : [];
  return {
    ...response,
    choices: choices.map((choice) => {
      if (!choice || typeof choice !== "object") return choice;
      const typed = choice as Record<string, unknown>;
      const message = typed.message;
      if (!message || typeof message !== "object" || Array.isArray(message)) return choice;
      const msg = message as Record<string, unknown>;
      const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : undefined;
      return {
        ...typed,
        message: {
          ...msg,
          content: typeof msg.content === "string" ? map(msg.content) : msg.content,
          ...(toolCalls
            ? {
              tool_calls: toolCalls.map((call) => {
                if (!call || typeof call !== "object" || Array.isArray(call)) return call;
                const typedCall = call as Record<string, unknown>;
                const fn = typedCall.function;
                if (!fn || typeof fn !== "object" || Array.isArray(fn)) return call;
                const typedFunction = fn as Record<string, unknown>;
                return {
                  ...typedCall,
                  function: {
                    ...typedFunction,
                    arguments: typeof typedFunction.arguments === "string"
                      ? map(typedFunction.arguments)
                      : typedFunction.arguments,
                  },
                };
              }),
            }
            : {}),
        },
      };
    }),
  };
}

export function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => ({ ...message }));
}
