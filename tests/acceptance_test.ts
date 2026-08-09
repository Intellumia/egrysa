import { Gateway } from "../src/gateway.ts";
import { verifyReceipt } from "../src/receipts.ts";
import { SEMANTIC_PROMPT_VERSION } from "../src/semantic.ts";
import { configureTestEnvironment } from "./environment.ts";
import { testConfig } from "./fixtures.ts";

Deno.test("black-box compatibility and evidence acceptance", async () => {
  await configureTestEnvironment();
  const receiptLogPath = await Deno.makeTempFile({
    prefix: "egrysa-acceptance-",
    suffix: ".jsonl",
  });
  let resolveProviderPort!: (port: number) => void;
  const providerPortReady = new Promise<number>((resolve) => resolveProviderPort = resolve);
  let resolveGatewayPort!: (port: number) => void;
  const gatewayPortReady = new Promise<number>((resolve) => resolveGatewayPort = resolve);
  let streamCancelled = false;
  let lastProviderBody: Record<string, unknown> | null = null;
  const encoder = new TextEncoder();

  const provider = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolveProviderPort(port),
  }, async (request) => {
    const body = await request.json() as Record<string, unknown>;
    lastProviderBody = body;
    if (body.seed === 504) {
      // Comfortably past config.requestTimeoutMs so the deadline is what fires.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    const messages = body.messages as Array<Record<string, unknown>>;
    const content = String(messages[0]?.content ?? "");
    const token = content.match(/__EGRYSA_EMAIL_[A-Za-z0-9_]+__/)?.[0] ?? "";
    if (body.stream === true) {
      if (body.seed === 408) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(sseChunk("stream-cancel", "started", null)));
            },
            cancel() {
              streamCancelled = true;
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const midpoint = Math.floor(token.length / 2);
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(sseChunk("stream-ok", token.slice(0, midpoint), null)),
            );
            controller.enqueue(
              encoder.encode(sseChunk("stream-ok", token.slice(midpoint), "stop")),
            );
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    if (body.seed === 999) return completion(token.toLowerCase());
    if (Array.isArray(body.tools)) {
      return Response.json({
        id: "tool-ok",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "send_email", arguments: JSON.stringify({ email: token }) },
            }],
          },
          finish_reason: "tool_calls",
        }],
      });
    }
    return completion(`Confirmed ${content}`);
  });

  try {
    const config = testConfig();
    config.receiptLogPath = receiptLogPath;
    config.receiptChainId = "acceptance-chain";
    // Wide enough that a loaded runner cannot trip it by accident. Every
    // healthy request also pays Ed25519 signing and an fsynced receipt write,
    // and the previous 50 ms left no margin for either.
    config.requestTimeoutMs = 500;
    config.policy.defaultProvider = "local";
    config.providers[1]!.baseUrl = `http://127.0.0.1:${await providerPortReady}/v1`;
    const gateway = await Gateway.create(config);
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: ({ port }) => resolveGatewayPort(port),
    }, (request) => gateway.handle(request));
    try {
      const baseUrl = `http://127.0.0.1:${await gatewayPortReady}`;
      const models = await authorizedFetch(`${baseUrl}/v1/models`);
      const modelBody = await models.json();
      assert(models.status === 200 && modelBody.data[0]?.id === "approved-model", "models");

      const plain = await chat(baseUrl, {
        model: "approved-model",
        messages: [{ role: "user", content: "Email alex@example.com" }],
      });
      assert(plain.status === 200, "non-streaming status");
      assert(!(JSON.stringify(lastProviderBody)).includes("alex@example.com"), "egress transform");
      assert((await plain.text()).includes("alex@example.com"), "non-streaming recomposition");

      const streamed = await chat(baseUrl, {
        model: "approved-model",
        messages: [{ role: "user", content: "Email stream@example.com" }],
        stream: true,
      });
      const streamText = await streamed.text();
      assert(
        streamText.includes("stream@example.com") && streamText.includes("[DONE]"),
        `stream (status ${streamed.status}, ${streamText.length} bytes, ` +
          `recomposed=${streamText.includes("stream@example.com")}, ` +
          `done=${streamText.includes("[DONE]")}): ${JSON.stringify(streamText.slice(0, 400))}`,
      );

      const tool = await chat(baseUrl, {
        model: "approved-model",
        messages: [{ role: "user", content: "Email tool@example.com" }],
        tools: [{
          type: "function",
          function: {
            name: "send_email",
            description: "Send email",
            parameters: { type: "object", properties: { email: { type: "string" } } },
          },
        }],
      });
      assert((await tool.text()).includes("tool@example.com"), "tool recomposition");

      const residue = await chat(baseUrl, {
        model: "approved-model",
        messages: [{ role: "user", content: "Email damaged@example.com" }],
        seed: 999,
      });
      assert(residue.status === 502, "surrogate residue failure");

      const denied = await chat(baseUrl, {
        model: "approved-model",
        messages: [{ role: "user", content: "SSN 123-45-6789" }],
      });
      const deniedBody = await denied.json();
      assert(denied.status === 403 && typeof deniedBody.receiptId === "string", "deny receipt");
      const receiptResponse = await authorizedFetch(
        `${baseUrl}/v1/receipts/${deniedBody.receiptId}`,
      );
      const receipt = await receiptResponse.json();
      const keyResponse = await authorizedFetch(`${baseUrl}/v1/receipts/public-key`);
      const key = await keyResponse.json();
      assert(receipt.workloadId === "test-workload", "workload attribution");
      assert(await verifyReceipt(receipt, key.publicKey), "public receipt verification");

      const timeout = await chat(baseUrl, {
        model: "approved-model",
        messages: [{ role: "user", content: "timeout" }],
        seed: 504,
      });
      const timeoutBody = await timeout.json();
      assert(
        timeout.status === 504 && typeof timeoutBody.receiptId === "string",
        "provider timeout",
      );
      const timeoutReceipt = await (await authorizedFetch(
        `${baseUrl}/v1/receipts/${timeoutBody.receiptId}`,
      )).json();
      assert(timeoutReceipt.egress === "failed", "provider timeout receipt");

      const cancellable = await chat(baseUrl, {
        model: "approved-model",
        messages: [{ role: "user", content: "cancel stream" }],
        stream: true,
        seed: 408,
      });
      const reader = cancellable.body!.getReader();
      await reader.read();
      await reader.cancel();
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert(streamCancelled, "stream cancellation propagation");

      const checkpoint = await authorizedFetch(`${baseUrl}/v1/receipts/checkpoint`);
      const beforeRestart = await checkpoint.json();
      await gateway.close();
      const restarted = await Gateway.create(config);
      const afterRestart = await (await restarted.handle(
        new Request(
          "http://gateway/v1/receipts/checkpoint",
          { headers: authHeaders() },
        ),
      )).json();
      assert(
        afterRestart.sequence === beforeRestart.sequence &&
          afterRestart.receiptHash === beforeRestart.receiptHash,
        "receipt restart continuity",
      );
      await restarted.close();
    } finally {
      await server.shutdown();
      await gateway.close();
    }
  } finally {
    await provider.shutdown();
    await Deno.remove(receiptLogPath).catch(() => undefined);
  }
});

Deno.test("local semantic detector transforms egress and emits verifiable attribution", async () => {
  const keys = await configureTestEnvironment();
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  let providerBody = "";
  const provider = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, async (request) => {
    const body = await request.json() as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;
    if (String(messages[0]?.content).includes(SEMANTIC_PROMPT_VERSION)) {
      return completion(JSON.stringify({
        findings: [{ kind: "person_name", text: "Ada Lovelace", confidence: 0.94 }],
      }));
    }
    providerBody = JSON.stringify(body);
    return completion(`Confirmed ${String(messages[0]?.content ?? "")}`);
  });
  try {
    const config = testConfig();
    config.providers[1]!.baseUrl = `http://127.0.0.1:${await port}/v1`;
    config.policy.defaultProvider = "local";
    config.semanticDetector!.enabled = true;
    const gateway = await Gateway.create(config);
    const response = await gateway.handle(
      new Request("http://gateway/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: "Bearer a-test-client-key-that-is-long-enough",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "approved-model",
          messages: [{ role: "user", content: "Ask Ada Lovelace for an update." }],
        }),
      }),
    );
    const responseText = await response.text();
    assert(response.status === 200, "semantic response status");
    assert(!providerBody.includes("Ada Lovelace"), "semantic transformed egress");
    assert(providerBody.includes("__EGRYSA_PERSON_NAME_"), "semantic surrogate egress");
    assert(responseText.includes("Ada Lovelace"), "semantic local recomposition");
    const receiptId = response.headers.get("x-egrysa-receipt");
    assert(!!receiptId, "semantic receipt header");
    const receipt = await (await gateway.handle(
      new Request(`http://gateway/v1/receipts/${receiptId}`, { headers: authHeaders() }),
    )).json();
    assert(receipt.version === "4" && receipt.egress === "completed", "semantic receipt version");
    assert(receipt.decision === "transform", "semantic receipt decision");
    assert(receipt.findingCounts.person_name === 1, "semantic receipt finding count");
    assert(receipt.detectorDegraded === false, "semantic receipt degradation");
    assert(
      receipt.detectors.some((item: Record<string, unknown>) =>
        item.id === "egrysa.reference.local-semantic" && item.version === "0.2.0"
      ),
      "semantic receipt attribution",
    );
    assert(await verifyReceipt(receipt, keys.publicKey), "semantic receipt verification");
    assert(!JSON.stringify(receipt).includes("Ada Lovelace"), "semantic receipt content minimum");
    assert(
      gateway.metrics.render().includes("egrysa_semantic_findings_total 1"),
      "semantic findings metric",
    );
  } finally {
    await provider.shutdown();
  }
});

function completion(content: string): Response {
  return Response.json({
    id: "completion-ok",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  });
}

function sseChunk(id: string, content: string, finishReason: string | null): string {
  return `data: ${
    JSON.stringify({
      id,
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: { content }, finish_reason: finishReason }],
    })
  }\n\n`;
}

function chat(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return authorizedFetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function authorizedFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { ...authHeaders(), ...init.headers },
  });
}

function authHeaders(): Record<string, string> {
  return { authorization: "Bearer a-test-client-key-that-is-long-enough" };
}

function assert(condition: boolean, stage: string): asserts condition {
  if (!condition) throw new Error(`acceptance failed: ${stage}`);
}
