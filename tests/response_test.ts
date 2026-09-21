import { Gateway } from "../src/gateway.ts";
import { redact } from "../src/response.ts";
import type { AppConfig } from "../src/types.ts";
import { configureTestEnvironment } from "./environment.ts";
import { testConfig } from "./fixtures.ts";

const AUTH = "Bearer a-test-client-key-that-is-long-enough";
const SECRET = "sk-proj-Q7mZ2vX9pL4kR8tN1wB6yH3cJ5dF0gA2sE4uK7iM9oP1qT3vW5xZ8bC0nD";

// A provider that answers with whatever the test chooses, so the response
// path can be exercised with data the customer never sent.
async function withProvider(
  answer: (prompt: string) => string | ReadableStream<Uint8Array>,
  action: (config: AppConfig, providerSaw: () => string) => Promise<void>,
): Promise<void> {
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  let saw = "";
  const encoder = new TextEncoder();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, async (request) => {
    const body = await request.json() as { messages: Array<{ content: string }>; stream?: boolean };
    saw = body.messages[0]!.content;
    const reply = answer(saw);
    if (typeof reply !== "string") {
      return new Response(reply, { headers: { "content-type": "text/event-stream" } });
    }
    if (body.stream === true) {
      const frames = [reply.slice(0, 12), reply.slice(12)].map((piece) =>
        `data: ${
          JSON.stringify({
            id: "s",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
          })
        }\n\n`
      );
      frames.push("data: [DONE]\n\n");
      return new Response(encoder.encode(frames.join("")), {
        headers: { "content-type": "text/event-stream" },
      });
    }
    return Response.json({
      id: "r",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: reply },
        finish_reason: "stop",
      }],
    });
  });
  try {
    const config = testConfig();
    config.providers[1]!.baseUrl = `http://127.0.0.1:${await port}/v1`;
    config.policy.defaultProvider = "local";
    await action(config, () => saw);
  } finally {
    await server.shutdown();
  }
}

function chat(content: string, stream = false): Request {
  return new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: JSON.stringify({
      model: "approved-model",
      messages: [{ role: "user", content }],
      ...(stream ? { stream: true } : {}),
    }),
  });
}

async function receiptOf(gateway: Gateway, id: string) {
  const response = await gateway.handle(
    new Request(`http://gateway/v1/receipts/${id}`, { headers: { authorization: AUTH } }),
  );
  return await response.json();
}

Deno.test("a blocked-class value in a provider response is redacted by default", async () => {
  await configureTestEnvironment();
  await withProvider(() => `Use the key ${SECRET} for the job.`, async (config) => {
    const gateway = await Gateway.create(config);
    const response = await gateway.handle(chat("How do I authenticate?"));
    const body = await response.text();
    if (response.status !== 200) throw new Error(`expected 200, got ${response.status}`);
    if (body.includes("sk-proj") || !body.includes("[REDACTED:API_SECRET]")) {
      throw new Error("provider secret was not redacted from the response");
    }
    const receipt = await receiptOf(gateway, response.headers.get("x-egrysa-receipt")!);
    if (
      receipt.version !== "5" || receipt.egress !== "completed" ||
      receipt.response?.action !== "redacted" || receipt.response.findingCounts?.api_secret !== 1 ||
      JSON.stringify(receipt).includes("sk-proj")
    ) throw new Error(`receipt did not record the redaction: ${JSON.stringify(receipt.response)}`);
    if (!gateway.metrics.render().includes("egrysa_response_redactions_total 1")) {
      throw new Error("redaction was not counted");
    }
    await gateway.close();
  });
});

Deno.test("a blocked-class value in a provider response denies when configured", async () => {
  await configureTestEnvironment();
  await withProvider(() => `Card 4111 1111 1111 1111 is on file.`, async (config) => {
    config.policy.response = { blocked: "deny" };
    const gateway = await Gateway.create(config);
    const response = await gateway.handle(chat("Which card?"));
    const body = await response.json();
    if (response.status !== 403 || body.title !== "response_denied" || !body.receiptId) {
      throw new Error(`expected a response denial, got ${response.status} ${JSON.stringify(body)}`);
    }
    const receipt = await receiptOf(gateway, body.receiptId);
    if (
      receipt.response?.action !== "denied" || receipt.response.findingCounts?.credit_card !== 1
    ) {
      throw new Error("receipt did not record the denial");
    }
    await gateway.close();
  });
});

Deno.test("transformable kinds in a provider response pass by default and redact by config", async () => {
  await configureTestEnvironment();
  await withProvider(() => "Write to support@example.org for help.", async (config) => {
    const passing = await Gateway.create(config);
    const passed = await passing.handle(chat("Who do I contact?"));
    const passedBody = await passed.text();
    const passedReceipt = await receiptOf(passing, passed.headers.get("x-egrysa-receipt")!);
    if (
      !passedBody.includes("support@example.org") || passedReceipt.response?.action !== "none" ||
      passedReceipt.response.findingCounts?.email !== 1
    ) throw new Error("a transformable kind was not passed and counted");
    await passing.close();

    config.policy.response = { transformable: "redact" };
    const redacting = await Gateway.create(config);
    const redacted = await redacting.handle(chat("Who do I contact?"));
    const redactedBody = await redacted.text();
    if (
      redactedBody.includes("support@example.org") || !redactedBody.includes("[REDACTED:EMAIL]")
    ) {
      throw new Error("a transformable kind was not redacted when configured");
    }
    await redacting.close();
  });
});

Deno.test("the customer's own recomposed values are not counted as response findings", async () => {
  await configureTestEnvironment();
  await withProvider((prompt) => `Confirmed: ${prompt}`, async (config, providerSaw) => {
    const gateway = await Gateway.create(config);
    const response = await gateway.handle(chat("Email alex@example.com about it."));
    const body = await response.text();
    if (providerSaw().includes("alex@example.com")) throw new Error("request was not transformed");
    if (!body.includes("alex@example.com")) throw new Error("response was not recomposed");
    const receipt = await receiptOf(gateway, response.headers.get("x-egrysa-receipt")!);
    if (
      receipt.response?.action !== "none" ||
      Object.keys(receipt.response.findingCounts ?? { x: 1 }).length !== 0
    ) throw new Error(`recomposed value was counted: ${JSON.stringify(receipt.response)}`);
    await gateway.close();
  });
});

Deno.test("a stream is observed after completion and its receipt says unscanned", async () => {
  await configureTestEnvironment();
  await withProvider(() => `Use the key ${SECRET} for the job.`, async (config) => {
    const gateway = await Gateway.create(config);
    const response = await gateway.handle(chat("How do I authenticate?", true));
    const text = await response.text();
    if (response.status !== 200 || !text.includes("[DONE]")) throw new Error("stream failed");
    const receipt = await receiptOf(gateway, response.headers.get("x-egrysa-receipt")!);
    if (receipt.version !== "5" || receipt.response?.action !== "unscanned") {
      throw new Error("stream receipt did not say unscanned");
    }
    for (let attempt = 0; attempt < 50; attempt++) {
      if (gateway.metrics.render().includes("egrysa_response_findings_total 1")) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!gateway.metrics.render().includes("egrysa_response_findings_total 1")) {
      throw new Error("stream findings were not observed");
    }
    await gateway.close();
  });
});

Deno.test("redaction replaces spans with class markers only", () => {
  const text = "key sk-proj-abc and card 4111";
  const output = redact(text, [
    { kind: "api_secret", start: 4, end: 15, value: "sk-proj-abc" },
    { kind: "credit_card", start: 25, end: 29, value: "4111" },
  ]);
  if (output !== "key [REDACTED:API_SECRET] and card [REDACTED:CREDIT_CARD]") {
    throw new Error(`unexpected redaction: ${output}`);
  }
});
