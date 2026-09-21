import { Gateway } from "../src/gateway.ts";
import { SEMANTIC_PROMPT_VERSION } from "../src/semantic.ts";
import { configureTestEnvironment } from "./environment.ts";
import { testConfig } from "./fixtures.ts";

Deno.test("semantic timeout degrades to deterministic-only with content-free evidence", async () => {
  await configureTestEnvironment();
  const marker = "RAW-DETECTOR-MARKER-7f91";
  const logs: string[] = [];
  const originalError = console.error;
  await withSlowSemanticServer(async (baseUrl, providerCalls) => {
    const config = semanticConfig(baseUrl, "degrade");
    const gateway = await Gateway.create(config);
    console.error = (...values: unknown[]) => logs.push(values.map(String).join(" "));
    try {
      const response = await gateway.handle(chatRequest(`Discuss ${marker} locally.`));
      if (response.status !== 200 || providerCalls() !== 1) {
        throw new Error("degraded request did not continue to deterministic local policy");
      }
      const receiptId = response.headers.get("x-egrysa-receipt");
      if (!receiptId) throw new Error("degraded request did not return a receipt");
      const receiptResponse = await gateway.handle(receiptRequest(receiptId));
      const receiptText = await receiptResponse.text();
      const metrics = gateway.metrics.render();
      const logged = logs.join("\n");
      if ([receiptText, metrics, logged].some((value) => value.includes(marker))) {
        throw new Error("raw detector input appeared in receipt, metrics, or logs");
      }
      const receipt = JSON.parse(receiptText);
      if (
        receipt.version !== "5" || receipt.egress !== "completed" ||
        receipt.detectorDegraded !== true ||
        !receipt.detectors.some((item: Record<string, unknown>) =>
          item.id === "egrysa.reference.local-semantic"
        )
      ) throw new Error("degraded detector evidence is incomplete");
      if (
        !metrics.includes("egrysa_detector_failures_total 1") ||
        !metrics.includes("egrysa_detector_timeouts_total 1") ||
        !logged.includes('"errorClass":"timeout"')
      ) throw new Error("detector degradation was not recorded in content-free telemetry");
    } finally {
      console.error = originalError;
    }
  });
});

Deno.test("semantic timeout denies when high-assurance failure mode is configured", async () => {
  await configureTestEnvironment();
  await withSlowSemanticServer(async (baseUrl, providerCalls) => {
    const gateway = await Gateway.create(semanticConfig(baseUrl, "deny"));
    const response = await gateway.handle(chatRequest("Review an ordinary local request."));
    const body = await response.json();
    if (response.status !== 403 || providerCalls() !== 0 || typeof body.receiptId !== "string") {
      throw new Error("deny failure mode did not stop provider invocation");
    }
    const receipt = await (await gateway.handle(receiptRequest(body.receiptId))).json();
    if (
      receipt.version !== "3" || receipt.decision !== "deny" ||
      receipt.detectorDegraded !== true
    ) throw new Error("deny-mode detector degradation was not recorded honestly");
  });
});

Deno.test("semantic schema violation degrades without blocking local inference", async () => {
  await configureTestEnvironment();
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  let providerCalls = 0;
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, async (request) => {
    const body = await request.json() as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;
    if (String(messages[0]?.content).includes(SEMANTIC_PROMPT_VERSION)) {
      return completion("not-json");
    }
    providerCalls++;
    return completion("local inference completed");
  });
  try {
    const gateway = await Gateway.create(
      semanticConfig(`http://127.0.0.1:${await port}/v1`, "degrade"),
    );
    const response = await gateway.handle(chatRequest("An ordinary local request."));
    if (response.status !== 200 || providerCalls !== 1) {
      throw new Error("schema degradation did not continue with deterministic policy");
    }
    const receiptId = response.headers.get("x-egrysa-receipt");
    const receipt = await (await gateway.handle(receiptRequest(receiptId!))).json();
    if (receipt.detectorDegraded !== true) {
      throw new Error("schema degradation was not recorded in the receipt");
    }
    const metrics = gateway.metrics.render();
    if (
      !metrics.includes("egrysa_detector_failures_total 1") ||
      !metrics.includes("egrysa_detector_timeouts_total 0")
    ) throw new Error("schema degradation metrics are incorrect");
  } finally {
    await server.shutdown();
  }
});

Deno.test("low-precision semantic finding in a structural key routes locally", async () => {
  await configureTestEnvironment();
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  let providerCalls = 0;
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, async (request) => {
    const body = await request.json() as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;
    if (String(messages[0]?.content).includes(SEMANTIC_PROMPT_VERSION)) {
      const input = String(messages[1]?.content ?? "");
      return completion(JSON.stringify({
        findings: input.includes("Maya Chen")
          ? [{ kind: "person_name", text: "Maya Chen", confidence: 0.8 }]
          : [],
      }));
    }
    providerCalls++;
    return completion("local inference completed");
  });
  try {
    const gateway = await Gateway.create(
      semanticConfig(`http://127.0.0.1:${await port}/v1`, "degrade"),
    );
    const request = chatRequest("Use the supplied schema.");
    const body = JSON.parse(await request.text());
    body.tools = [{
      type: "function",
      function: {
        name: "lookup",
        parameters: {
          type: "object",
          properties: { "Maya Chen": { type: "string" } },
        },
      },
    }];
    const response = await gateway.handle(
      new Request(request.url, {
        method: "POST",
        headers: request.headers,
        body: JSON.stringify(body),
      }),
    );
    if (
      response.status !== 200 || response.headers.get("x-egrysa-decision") !== "local_only" ||
      providerCalls !== 1
    ) throw new Error("semantic structural candidate was allowed to hard-deny the request");
  } finally {
    await server.shutdown();
  }
});

for (const onFailure of ["degrade", "deny"] as const) {
  Deno.test(`semantic finding explosion follows ${onFailure} failure policy`, async () => {
    await configureTestEnvironment();
    let resolvePort!: (port: number) => void;
    const port = new Promise<number>((resolve) => resolvePort = resolve);
    let providerCalls = 0;
    const server = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: ({ port }) => resolvePort(port),
    }, async (request) => {
      const body = await request.json() as Record<string, unknown>;
      const messages = body.messages as Array<Record<string, unknown>>;
      if (String(messages[0]?.content).includes(SEMANTIC_PROMPT_VERSION)) {
        return completion(JSON.stringify({
          findings: [{ kind: "person_name", text: "ab", confidence: 0.8 }],
        }));
      }
      providerCalls++;
      return completion("local inference completed");
    });
    try {
      const gateway = await Gateway.create(
        semanticConfig(`http://127.0.0.1:${await port}/v1`, onFailure),
      );
      const response = await gateway.handle(chatRequest(`Review ${"ab ".repeat(70)}`));
      const expectedStatus = onFailure === "degrade" ? 200 : 403;
      const expectedCalls = onFailure === "degrade" ? 1 : 0;
      if (response.status !== expectedStatus || providerCalls !== expectedCalls) {
        throw new Error(`oversized findings did not follow ${onFailure} policy`);
      }
      const receiptId = response.headers.get("x-egrysa-receipt") ??
        (await response.json()).receiptId;
      const receipt = await (await gateway.handle(receiptRequest(receiptId))).json();
      if (receipt.detectorDegraded !== true) {
        throw new Error("oversized semantic findings were not recorded as degradation");
      }
    } finally {
      await server.shutdown();
    }
  });
}

function semanticConfig(baseUrl: string, onFailure: "degrade" | "deny") {
  const config = testConfig();
  config.providers[1]!.baseUrl = baseUrl;
  config.policy.defaultProvider = "local";
  config.semanticDetector!.enabled = true;
  config.semanticDetector!.timeoutMs = 100;
  config.semanticDetector!.onDetectorFailure = onFailure;
  return config;
}

async function withSlowSemanticServer(
  action: (baseUrl: string, providerCalls: () => number) => Promise<void>,
): Promise<void> {
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  let invocations = 0;
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, async (request) => {
    const body = await request.json() as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;
    if (String(messages[0]?.content).includes(SEMANTIC_PROMPT_VERSION)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return completion(JSON.stringify({ findings: [] }));
    }
    invocations++;
    return completion(`Local response: ${String(messages[0]?.content ?? "")}`);
  });
  try {
    await action(`http://127.0.0.1:${await port}/v1`, () => invocations);
  } finally {
    await server.shutdown();
  }
}

function completion(content: string): Response {
  return Response.json({
    id: "semantic-gateway-test",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  });
}

function chatRequest(content: string): Request {
  return new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer a-test-client-key-that-is-long-enough",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "approved-model",
      messages: [{ role: "user", content }],
    }),
  });
}

function receiptRequest(id: string): Request {
  return new Request(`http://gateway/v1/receipts/${id}`, {
    headers: { authorization: "Bearer a-test-client-key-that-is-long-enough" },
  });
}
