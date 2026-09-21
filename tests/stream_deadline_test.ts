// The upstream deadline and streamed responses. Issue #27: the acceptance
// suite's streaming stage failed intermittently in CI with an
// upstream_stream_error frame and no [DONE]. The cause was that the
// provider's deadline timer kept running while the gateway signed and
// committed the stream's receipt, so an fsync slower than the deadline on a
// loaded runner aborted a healthy stream before a byte of it was read.

import { invokeProvider } from "../src/providers.ts";
import type { ProviderConfig } from "../src/types.ts";

const encoder = new TextEncoder();

function sse(content: string, finish: string | null): string {
  return `data: ${
    JSON.stringify({
      id: "s",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content }, finish_reason: finish }],
    })
  }\n\n`;
}

// A provider whose stream sends one chunk, then stalls for stallMs before
// finishing, so a test can place the deadline on either side of the stall.
async function startProvider(
  stallMs: number,
): Promise<{ url: string; close: () => Promise<void> }> {
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, () =>
    new Response(
      new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(sse("hello", null)));
          if (stallMs) await new Promise((resolve) => setTimeout(resolve, stallMs));
          controller.enqueue(encoder.encode(sse(" world", "stop")));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    ));
  return { url: `http://127.0.0.1:${await port}/v1`, close: () => server.shutdown() };
}

function provider(baseUrl: string): ProviderConfig {
  return {
    id: "local",
    kind: "openai-compatible",
    baseUrl,
    local: true,
    allowedModels: ["m"],
    dataPolicy: { training: "disabled", retention: "none", allowRaw: false },
  };
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<string> {
  let text = "";
  const decoder = new TextDecoder();
  for await (const chunk of body) text += decoder.decode(chunk, { stream: true });
  return text;
}

Deno.test("gateway work between the stream's headers and its first read is not charged to the provider deadline", async () => {
  const upstream = await startProvider(0);
  try {
    const invocation = await invokeProvider(
      provider(upstream.url),
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
      100,
    );
    if (invocation.type !== "stream") throw new Error("expected a stream");
    // Longer than the deadline: a slow receipt commit on a loaded runner.
    await new Promise((resolve) => setTimeout(resolve, 250));
    invocation.arm();
    const text = await readAll(invocation.response.body!);
    invocation.complete();
    if (!text.includes("hello") || !text.includes("[DONE]")) {
      throw new Error(`stream was aborted by the deadline during gateway work: ${text}`);
    }
  } finally {
    await upstream.close();
  }
});

Deno.test("once armed, the deadline still bounds a stream that stalls past it", async () => {
  const upstream = await startProvider(400);
  try {
    const invocation = await invokeProvider(
      provider(upstream.url),
      { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
      100,
    );
    if (invocation.type !== "stream") throw new Error("expected a stream");
    invocation.arm();
    let aborted = false;
    let text = "";
    try {
      text = await readAll(invocation.response.body!);
    } catch (error) {
      aborted = error instanceof DOMException && error.name === "AbortError";
    } finally {
      invocation.complete();
    }
    if (!aborted) throw new Error(`stalled stream was not aborted: ${JSON.stringify(text)}`);
  } finally {
    await upstream.close();
  }
});
