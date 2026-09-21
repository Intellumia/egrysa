import { toChatRequest, validateAnthropicRequest } from "../src/anthropic_ingress.ts";
import { Gateway } from "../src/gateway.ts";
import type { AppConfig } from "../src/types.ts";
import { configureTestEnvironment } from "./environment.ts";
import { testConfig } from "./fixtures.ts";

const AUTH = "Bearer a-test-client-key-that-is-long-enough";

Deno.test("an Anthropic request translates to the internal chat shape", () => {
  const request = {
    model: "approved-model",
    max_tokens: 256,
    system: [{ type: "text", text: "Be brief." }],
    messages: [
      { role: "user", content: "Look up Maya Chen." },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Looking." },
          { type: "tool_use", id: "toolu_1", name: "lookup", input: { name: "Maya Chen" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "found" }],
      },
    ],
    tools: [{ name: "lookup", description: "Find a person", input_schema: { type: "object" } }],
    tool_choice: { type: "tool", name: "lookup" },
    stream: true,
    temperature: 0.2,
  };
  if (validateAnthropicRequest(request) !== null) throw new Error("valid request was refused");
  const chat = toChatRequest(request as never);
  const roles = chat.messages.map((message) => message.role).join(",");
  if (roles !== "system,user,assistant,tool") throw new Error(`roles: ${roles}`);
  const assistant = chat.messages[2]!;
  if (
    assistant.content !== "Looking." || assistant.tool_calls?.[0]?.id !== "toolu_1" ||
    assistant.tool_calls[0].function.arguments !== '{"name":"Maya Chen"}'
  ) throw new Error("assistant tool_use was not translated");
  const tool = chat.messages[3]!;
  if (tool.tool_call_id !== "toolu_1" || tool.content !== "found") {
    throw new Error("tool_result was not translated");
  }
  if (
    chat.tools?.[0]?.function.name !== "lookup" || chat.max_tokens !== 256 ||
    chat.stream !== true ||
    JSON.stringify(chat.tool_choice) !== '{"type":"function","function":{"name":"lookup"}}'
  ) throw new Error("tools, tool_choice, or tuning fields were not translated");
  for (
    const [bad, expected] of [
      [{ ...request, top_k: 5 }, "top_k"],
      [{ ...request, metadata: { user_id: "u1" } }, "metadata"],
      [{ ...request, max_tokens: 0 }, "max_tokens"],
      [{ ...request, messages: [{ role: "user", content: [{ type: "image" }] }] }, "blocks"],
    ] as Array<[unknown, string]>
  ) {
    const message = validateAnthropicRequest(bad);
    if (!message || !message.includes(expected)) {
      throw new Error(`expected refusal naming ${expected}, got ${message}`);
    }
  }
});

async function withProvider(
  action: (config: AppConfig, providerSaw: () => string) => Promise<void>,
): Promise<void> {
  await configureTestEnvironment();
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  let saw = "";
  const encoder = new TextEncoder();
  const provider = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, async (request) => {
    const body = await request.json() as {
      messages: Array<{ role: string; content: string }>;
      stream?: boolean;
      tools?: unknown[];
    };
    saw = body.messages.map((message) => message.content).join(" | ");
    const user = body.messages.find((message) => message.role === "user")?.content ?? "";
    const reply = `Noted: ${user}`;
    if (body.stream) {
      const pieces = reply.match(/[\s\S]{1,9}/g) ?? [reply];
      const frames = pieces.map((piece) =>
        `data: ${
          JSON.stringify({
            id: "chatcmpl-s",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
          })
        }\n\n`
      );
      frames.push(
        `data: ${
          JSON.stringify({
            id: "chatcmpl-s",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })
        }\n\n`,
        "data: [DONE]\n\n",
      );
      return new Response(encoder.encode(frames.join("")), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({
      id: "chatcmpl-r",
      object: "chat.completion",
      model: "approved-model",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          content: reply,
          ...(body.tools
            ? {
              tool_calls: [{
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: '{"q":"x"}' },
              }],
            }
            : {}),
        },
        finish_reason: body.tools ? "tool_calls" : "stop",
      }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
  });
  try {
    const config = testConfig();
    config.providers[1]!.baseUrl = `http://127.0.0.1:${await port}/v1`;
    config.policy.defaultProvider = "local";
    await action(config, () => saw);
  } finally {
    await provider.shutdown();
  }
}

function messages(body: unknown): Request {
  return new Request("http://gateway/v1/messages", {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("POST /v1/messages transforms, recomposes, and answers in the Anthropic shape", async () => {
  await withProvider(async (config, providerSaw) => {
    const gateway = await Gateway.create(config);
    const response = await gateway.handle(messages({
      model: "approved-model",
      max_tokens: 64,
      system: "Be brief.",
      messages: [{ role: "user", content: "Email alex@example.com the file." }],
      tools: [{ name: "lookup", input_schema: { type: "object" } }],
    }));
    const body = await response.json();
    if (response.status !== 200) {
      throw new Error(`status ${response.status}: ${JSON.stringify(body)}`);
    }
    if (providerSaw().includes("alex@example.com") || !providerSaw().startsWith("Be brief.")) {
      throw new Error(`provider saw the original or lost the system prompt: ${providerSaw()}`);
    }
    if (
      body.type !== "message" || body.role !== "assistant" || !String(body.id).startsWith("msg_") ||
      body.content?.[0]?.type !== "text" || !body.content[0].text.includes("alex@example.com") ||
      body.content?.[1]?.type !== "tool_use" || body.content[1].name !== "lookup" ||
      body.content[1].input?.q !== "x" || body.stop_reason !== "tool_use" ||
      body.usage?.input_tokens !== 7
    ) throw new Error(`unexpected message shape: ${JSON.stringify(body)}`);
    if (
      response.headers.get("x-egrysa-decision") !== "transform" ||
      !response.headers.get("x-egrysa-receipt")
    ) throw new Error("gateway headers missing on the Anthropic route");
    await gateway.close();
  });
});

Deno.test("POST /v1/messages streams Anthropic events with recomposed text", async () => {
  await withProvider(async (config, providerSaw) => {
    const gateway = await Gateway.create(config);
    const response = await gateway.handle(messages({
      model: "approved-model",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "Call +1 415 555 0134 and email alex@example.com." }],
    }));
    const text = await response.text();
    if (
      response.status !== 200 || !response.headers.get("content-type")?.includes("event-stream")
    ) {
      throw new Error(`stream status ${response.status}`);
    }
    if (providerSaw().includes("alex@example.com")) {
      throw new Error("original reached the provider");
    }
    const events = [...text.matchAll(/^event: (\S+)$/gm)].map((match) => match[1]);
    const expected = ["message_start", "content_block_start", "content_block_delta"];
    if (!expected.every((name, index) => events[index] === name)) {
      throw new Error(`event order wrong: ${events.slice(0, 5)}`);
    }
    if (
      events.at(-1) !== "message_stop" || events.at(-2) !== "message_delta" ||
      !events.includes("content_block_stop")
    ) throw new Error(`stream did not close properly: ${events.slice(-4)}`);
    const deltas = [...text.matchAll(/"text_delta","text":"((?:[^"\\]|\\.)*)"/g)].map((m) =>
      JSON.parse(`"${m[1]}"`)
    ).join("");
    if (!deltas.includes("alex@example.com") || !deltas.includes("+1 415 555 0134")) {
      throw new Error(`streamed text was not recomposed: ${deltas}`);
    }
    await gateway.close();
  });
});

Deno.test("POST /v1/messages refusals use the Anthropic error shape and carry the receipt", async () => {
  await withProvider(async (config) => {
    const gateway = await Gateway.create(config);
    const denied = await gateway.handle(messages({
      model: "approved-model",
      max_tokens: 64,
      messages: [{ role: "user", content: "Use card 4111 1111 1111 1111 now." }],
    }));
    const body = await denied.json();
    if (
      denied.status !== 403 || body.type !== "error" || body.error?.type !== "permission_error" ||
      typeof body.error.receipt_id !== "string" || body.error.code !== "policy_denied"
    ) throw new Error(`unexpected refusal: ${denied.status} ${JSON.stringify(body)}`);
    const invalid = await gateway.handle(
      messages({ model: "approved-model", max_tokens: 64, messages: [], top_k: 3 }),
    );
    const invalidBody = await invalid.json();
    if (invalid.status !== 400 || invalidBody.error?.type !== "invalid_request_error") {
      throw new Error(
        `unexpected validation response: ${invalid.status} ${JSON.stringify(invalidBody)}`,
      );
    }
    const unauthenticated = await gateway.handle(
      new Request("http://gateway/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      }),
    );
    const unauthBody = await unauthenticated.json();
    if (unauthenticated.status !== 401 || unauthBody.error?.type !== "authentication_error") {
      throw new Error("unauthenticated Anthropic request did not use the Anthropic error shape");
    }
    await gateway.close();
  });
});
