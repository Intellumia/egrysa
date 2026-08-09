// A minimal OpenAI-compatible endpoint for evaluating Egrysa without a model.
//
// It implements only what the openai-compatible adapter calls: model discovery
// and chat completions, non-streaming and streaming. It runs no inference. Each
// request is echoed back, and the text as received is printed to stdout so an
// operator can read exactly what left the gateway.
//
// Nothing here is part of the data plane. It exists so an evaluator can exercise
// classification, policy, surrogates, recomposition, and receipts on a laptop.
const port = Number(Deno.env.get("EGRYSA_STUB_PORT") ?? 11435);
const MODEL = "stub-echo";

interface ChatMessage {
  role: string;
  content: unknown;
}

// Content may be a string or an array of typed parts.
function readContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        part && typeof part === "object" && "text" in part
          ? String((part as { text: unknown }).text)
          : ""
      )
      .join("");
  }
  return "";
}

function completionId(): string {
  return `chatcmpl-stub-${crypto.randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function reply(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const received = readContent(lastUser?.content);
  return `Stub provider received: ${received}`;
}

function streamResponse(model: string, text: string): Response {
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null) =>
    `data: ${
      JSON.stringify({
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finish }],
      })
    }\n\n`;

  // Emit in small pieces so bounded holdback recomposition is exercised rather
  // than bypassed by a single-chunk response.
  const pieces = text.match(/[\s\S]{1,12}/g) ?? [text];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode(chunk({ role: "assistant" }, null)));
      for (const piece of pieces) {
        controller.enqueue(encoder.encode(chunk({ content: piece }, null)));
      }
      controller.enqueue(encoder.encode(chunk({}, "stop")));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      "connection": "keep-alive",
    },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.serve({
  hostname: "127.0.0.1",
  port,
  onListen: ({ hostname, port }) => {
    console.log(`Egrysa stub provider on http://${hostname}:${port}/v1  model "${MODEL}"`);
    console.log("No inference. Text below is what the gateway actually sent upstream.\n");
  },
}, async (request) => {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/v1/models") {
    return json({
      object: "list",
      data: [{ id: MODEL, object: "model", created: 0, owned_by: "stub-echo" }],
    });
  }

  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    let body: { model?: string; messages?: ChatMessage[]; stream?: boolean };
    try {
      body = await request.json();
    } catch {
      return json({ error: { message: "invalid JSON body", type: "invalid_request_error" } }, 400);
    }

    const messages = body.messages ?? [];
    for (const message of messages) {
      console.log(`  [${message.role}] ${readContent(message.content)}`);
    }
    console.log("");

    const text = reply(messages);
    const model = body.model ?? MODEL;
    if (body.stream === true) return streamResponse(model, text);

    return json({
      id: completionId(),
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }

  return json({ error: { message: "not found", type: "invalid_request_error" } }, 404);
});
