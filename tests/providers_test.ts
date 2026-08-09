import { invokeProvider } from "../src/providers.ts";
import { recomposeOpenAiStream } from "../src/streaming.ts";
import type { ProviderConfig } from "../src/types.ts";

Deno.test("Anthropic end_turn maps to the OpenAI stop finish reason", async () => {
  Deno.env.set("TEST_ANTHROPIC_KEY", "test-key");
  let resolveAddress!: (port: number) => void;
  const portPromise = new Promise<number>((resolve) => resolveAddress = resolve);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolveAddress(port),
  }, () =>
    Response.json({
      id: "anthropic-test",
      model: "approved-model",
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      usage: {},
    }));
  const port = await portPromise;
  try {
    const provider: ProviderConfig = {
      id: "anthropic-test",
      kind: "anthropic",
      baseUrl: `http://127.0.0.1:${port}`,
      apiKeyEnv: "TEST_ANTHROPIC_KEY",
      allowedModels: ["approved-model"],
      dataPolicy: { training: "disabled", retention: "none", allowRaw: false },
    };
    const result = await invokeProvider(provider, {
      model: "approved-model",
      messages: [{ role: "user", content: "hello" }],
    }, 5_000);
    if (result.type !== "json") throw new Error("expected JSON response");
    const choice = (result.data.choices as Array<Record<string, unknown>>)[0];
    if (choice?.finish_reason !== "stop") throw new Error("finish reason was not normalized");
  } finally {
    await server.shutdown();
    Deno.env.delete("TEST_ANTHROPIC_KEY");
  }
});

// Anthropic frames, emitted the way the provider does: one event per SSE block.
function anthropicSse(events: Array<Record<string, unknown>>): string {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function sseResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

Deno.test("native Anthropic streaming recomposes a surrogate split across deltas", async () => {
  Deno.env.set("TEST_ANTHROPIC_KEY", "test-key");
  const token = "__EGRYSA_EMAIL_0001_abc123__";
  const midpoint = Math.floor(token.length / 2);
  await withAnthropicServer(async (request) => {
    const body = await request.json() as Record<string, unknown>;
    if (body.stream !== true) throw new Error("gateway did not request a native stream");
    // The token is deliberately cut in half so bounded holdback has to
    // reassemble it, which native chunking makes the common case.
    return sseResponse(anthropicSse([
      {
        type: "message_start",
        message: { id: "anthropic-stream", model: "approved-model", role: "assistant" },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `Confirmed ${token.slice(0, midpoint)}` },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: token.slice(midpoint) },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } },
      { type: "message_stop" },
    ]));
  }, async (baseUrl) => {
    const invocation = await invokeProvider(anthropicProvider(baseUrl), {
      model: "approved-model",
      messages: [{ role: "user", content: `Email ${token}` }],
      stream: true,
      stream_options: { include_usage: true },
    }, 5_000);
    if (invocation.type !== "stream") throw new Error("expected a stream");
    if (invocation.emulated) throw new Error("Anthropic streaming is still emulated");
    if (invocation.downgraded.includes("stream-emulated")) {
      throw new Error("a retired downgrade is still disclosed");
    }
    // Two layers, tested separately. The translator must deliver a frame per
    // upstream delta; the recomposer then applies bounded holdback, which
    // legitimately coalesces small deltas so a split surrogate can be rejoined.
    const [forRecomposition, forFraming] = invocation.response.body!.tee();

    const rawFrames = parseOpenAiSse(await new Response(forFraming).text());
    const contentFrames = rawFrames.filter((frame) => {
      const choice = (frame.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;
      return typeof delta?.content === "string" && delta.content.length > 0;
    });
    // Emulation produced exactly one content frame. More than one proves tokens
    // now flow as they arrive rather than after the full response.
    if (contentFrames.length < 2) throw new Error("stream was not delivered incrementally");

    const output = await new Response(recomposeOpenAiStream(
      forRecomposition,
      new Map([[token, "stream@example.com"]]),
      (error) => {
        throw error;
      },
      invocation.complete,
    )).text();
    const frames = parseOpenAiSse(output);
    if (!output.includes("stream@example.com")) {
      throw new Error("a surrogate split across deltas was not recomposed");
    }
    if (
      !frames.some((frame) =>
        frame.choices instanceof Array && frame.choices.length === 0 && frame.usage !== undefined
      )
    ) throw new Error("usage frame was not emitted");
    assertStableTemplate(frames, "anthropic-stream", "approved-model");
  });
  Deno.env.delete("TEST_ANTHROPIC_KEY");
});

Deno.test("native Anthropic tool calls stream as incremental OpenAI deltas", async () => {
  Deno.env.set("TEST_ANTHROPIC_KEY", "test-key");
  await withAnthropicServer(() =>
    Promise.resolve(sseResponse(anthropicSse([
      {
        type: "message_start",
        message: { id: "anthropic-tool-stream", model: "approved-model", role: "assistant" },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "call_weather", name: "weather", input: {} },
      },
      // Arguments arrive as fragments, which is what native tool streaming does.
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"city"' },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: ':"Pune"}' },
      },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 4 } },
      { type: "message_stop" },
    ]))), async (baseUrl) => {
    const invocation = await invokeProvider(anthropicProvider(baseUrl), {
      model: "approved-model",
      messages: [{ role: "user", content: "Check the weather" }],
      stream: true,
      tools: [{ type: "function", function: { name: "weather", parameters: { type: "object" } } }],
      tool_choice: "required",
    }, 5_000);
    if (invocation.type !== "stream") throw new Error("expected a stream");
    const frames = parseOpenAiSse(await invocation.response.text());

    const calls = frames.flatMap((frame) => {
      const choice = (frame.choices as Array<Record<string, unknown>> | undefined)?.[0];
      const delta = choice?.delta as Record<string, unknown> | undefined;
      return (delta?.tool_calls as Array<Record<string, unknown>> | undefined) ?? [];
    });
    const opening = calls.find((call) => call.id !== undefined);
    const openingFn = opening?.function as Record<string, unknown> | undefined;
    if (opening?.index !== 0 || opening.id !== "call_weather" || openingFn?.name !== "weather") {
      throw new Error("tool call was not opened with an OpenAI-shaped delta");
    }
    // Concatenating the fragments must yield the arguments the provider sent.
    const args = calls.map((call) => {
      const fn = call.function as Record<string, unknown> | undefined;
      return typeof fn?.arguments === "string" ? fn.arguments : "";
    }).join("");
    if (JSON.stringify(JSON.parse(args)) !== '{"city":"Pune"}') {
      throw new Error(`tool arguments did not reassemble: ${args}`);
    }
    const finish = frames.map((frame) =>
      ((frame.choices as Array<Record<string, unknown>> | undefined)?.[0])?.finish_reason
    ).find((reason) => typeof reason === "string");
    if (finish !== "tool_calls") throw new Error(`finish reason was ${finish}`);
    assertStableTemplate(frames, "anthropic-tool-stream", "approved-model");
    invocation.complete();
  });
  Deno.env.delete("TEST_ANTHROPIC_KEY");
});

function anthropicProvider(baseUrl: string): ProviderConfig {
  return {
    id: "anthropic-test",
    kind: "anthropic",
    baseUrl,
    apiKeyEnv: "TEST_ANTHROPIC_KEY",
    allowedModels: ["approved-model"],
    dataPolicy: { training: "disabled", retention: "none", allowRaw: false },
  };
}

async function withAnthropicServer(
  handler: (request: Request) => Response | Promise<Response>,
  action: (baseUrl: string) => Promise<void>,
): Promise<void> {
  let resolveAddress!: (port: number) => void;
  const portPromise = new Promise<number>((resolve) => resolveAddress = resolve);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolveAddress(port),
  }, handler);
  try {
    await action(`http://127.0.0.1:${await portPromise}`);
  } finally {
    await server.shutdown();
  }
}

function parseOpenAiSse(value: string): Record<string, unknown>[] {
  const events = value.split("\n\n").filter(Boolean);
  if (events.at(-1) !== "data: [DONE]") throw new Error("SSE stream lacks terminal DONE");
  return events.slice(0, -1).map((event) => {
    if (!event.startsWith("data: ")) throw new Error("SSE frame lacks data prefix");
    return JSON.parse(event.slice("data: ".length)) as Record<string, unknown>;
  });
}

function assertStableTemplate(
  frames: Record<string, unknown>[],
  id: string,
  model: string,
): void {
  if (
    frames.some((frame) =>
      frame.id !== id || frame.model !== model || frame.object !== "chat.completion.chunk" ||
      typeof frame.created !== "number"
    )
  ) throw new Error("emulated SSE frames did not preserve a stable OpenAI chunk template");
}
