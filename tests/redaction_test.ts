// No raw content on any output surface. The gateway is driven through its
// success and failure paths with canary values in the request, and every
// surface an operator or attacker could read afterwards is searched for
// them: the structured log, the metrics endpoint, every error body, the
// receipt log on disk, the export sink, and the bytes sent to the provider.
// Only a successful recomposed response may carry the originals, by design.

import { Gateway } from "../src/gateway.ts";
import type { AppConfig } from "../src/types.ts";
import { configureTestEnvironment } from "./environment.ts";
import { testConfig } from "./fixtures.ts";

const AUTH = "Bearer a-test-client-key-that-is-long-enough";

// Values the detectors catch, and one they do not, so plain prompt text is
// held to the same rule as findings.
const CANARIES = {
  email: "canary.person@leak-test.example",
  card: "4242 4242 4242 4242",
  secret: "sk-canaryleakcanaryleakcanaryleakcanaryleakcanary00",
  term: "Project Nightingale",
  plaintext: "CANARY-PLAINTEXT-7f3a9c",
};
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

interface Provider {
  url: string;
  bodies: string[];
  close: () => Promise<void>;
}

// Behaviour is keyed on the request's seed, which the gateway forwards.
async function startProvider(): Promise<Provider> {
  const provider: Provider = { url: "", bodies: [], close: async () => {} };
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, async (request) => {
    const text = await request.text();
    provider.bodies.push(text);
    const body = JSON.parse(text) as {
      seed?: number;
      stream?: boolean;
      messages: Array<{ content: string }>;
    };
    const content = body.messages.map((m) => m.content).join(" ");
    const token = content.match(/__EGRYSA_[A-Z_]+_[A-Za-z0-9_]+__/)?.[0] ?? "";
    switch (body.seed) {
      case 500:
        // A provider that echoes what it was sent in its error body.
        return new Response(JSON.stringify({ error: { message: `bad request: ${content}` } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      case 504:
        await new Promise((resolve) => setTimeout(resolve, 800));
        return Response.json({ id: "late" });
      case 600:
        return new Response("<html>not json</html>", { headers: { "content-type": "text/html" } });
      case 601:
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("data: {not json\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      case 602: {
        // Damaged surrogate: the middle of the token is altered.
        const damaged = token ? `${token.slice(0, 12)}XX${token.slice(14)}` : "nothing";
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(sse(`Reply to ${damaged}`, "stop")));
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      case 603:
        // Blocked class in the response.
        return Response.json({
          id: "r",
          object: "chat.completion",
          choices: [{
            index: 0,
            message: { role: "assistant", content: "Card on file: 4111 1111 1111 1111" },
            finish_reason: "stop",
          }],
        });
    }
    if (body.stream) {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(sse(`Reply to ${token}`, "stop")));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }
    return Response.json({
      id: "r",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: `Reply to ${token}` },
        finish_reason: "stop",
      }],
    });
  });
  provider.url = `http://127.0.0.1:${await port}/v1`;
  provider.close = () => server.shutdown();
  return provider;
}

async function startSink(): Promise<
  { url: string; batches: string[]; close: () => Promise<void> }
> {
  const sink = { url: "", batches: [] as string[], close: async () => {} };
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, async (request) => {
    sink.batches.push(await request.text());
    return new Response(null, { status: 204 });
  });
  sink.url = `http://127.0.0.1:${await port}/collect`;
  sink.close = () => server.shutdown();
  return sink;
}

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
  };
  const capture = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  console.log = capture;
  console.error = capture;
  console.warn = capture;
  console.info = capture;
  return {
    lines,
    restore: () => {
      console.log = original.log;
      console.error = original.error;
      console.warn = original.warn;
      console.info = original.info;
    },
  };
}

function findCanary(text: string, sensitiveOnly = false): string | null {
  for (const [name, value] of Object.entries(CANARIES)) {
    if (sensitiveOnly && name === "plaintext") continue;
    if (text.includes(value)) return name;
    // Digit-only forms of the card, in case a surface strips separators.
    if (name === "card" && text.includes(value.replaceAll(" ", ""))) return name;
  }
  return null;
}

// The provider legitimately receives the prompt's plain prose; every other
// surface must carry neither the sensitive values nor the prose.
function assertClean(text: string, surface: string, sensitiveOnly = false): void {
  const hit = findCanary(text, sensitiveOnly);
  if (hit) {
    throw new Error(`${surface} carried the ${hit} canary: ${JSON.stringify(text.slice(0, 300))}`);
  }
}

// The transform prompt carries a transformable class and plain text; the
// deny prompt carries blocked classes; the local-only prompt carries a
// confidential term, which routes the raw request to the in-boundary local
// provider by design, so that one provider body is exempt from the check.
const PROMPT = `Please email ${CANARIES.email}, ${CANARIES.plaintext}`;
const LOCAL_PROMPT = `Notes on ${CANARIES.term} for ${CANARIES.email}, ${CANARIES.plaintext}`;
const LOCAL_ONLY_SEED = 700;
const CARD_PROMPT =
  `Charge ${CANARIES.card} with token ${CANARIES.secret} for ${CANARIES.plaintext}`;

function chat(
  gateway: Gateway,
  body: unknown,
  headers: Record<string, string> = { authorization: AUTH },
): Promise<Response> {
  return gateway.handle(
    new Request("http://gateway/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

Deno.test("no output surface carries raw content on any success or failure path", async () => {
  await configureTestEnvironment();
  const captured = captureConsole();
  const provider = await startProvider();
  const sink = await startSink();
  const logPath = await Deno.makeTempFile({ prefix: "egrysa-redaction-", suffix: ".jsonl" });
  try {
    const config: AppConfig = testConfig();
    config.receiptLogPath = logPath;
    config.maxRequestBytes = 2048;
    config.semanticDetector!.maxInputBytes = 1024;
    config.requestTimeoutMs = 300;
    config.providers[1]!.baseUrl = provider.url;
    config.policy.defaultProvider = "local";
    config.export = { url: sink.url, batchSize: 1, flushIntervalMs: 50 };
    const gateway = await Gateway.create(config);
    const responses: Array<{ label: string; response: Response; mayCarryOriginals: boolean }> = [];
    const run = async (
      label: string,
      body: unknown,
      mayCarryOriginals = false,
      headers?: Record<string, string>,
    ) => {
      responses.push({ label, response: await chat(gateway, body, headers), mayCarryOriginals });
    };
    const base = { model: "approved-model", messages: [{ role: "user", content: PROMPT }] };

    await run("transform, json", base, true);
    await run("transform, stream", { ...base, stream: true }, true);
    await run("local_only, confidential term", {
      ...base,
      seed: LOCAL_ONLY_SEED,
      messages: [{ role: "user", content: LOCAL_PROMPT }],
    }, true);
    await run("deny, card", {
      model: "approved-model",
      messages: [{ role: "user", content: CARD_PROMPT }],
    });
    await run("provider 500 echoing the request", { ...base, seed: 500 });
    await run("provider timeout", { ...base, seed: 504 });
    await run("provider non-JSON", { ...base, seed: 600 });
    await run("malformed SSE", { ...base, seed: 601, stream: true });
    await run("damaged surrogate in stream", { ...base, seed: 602, stream: true });
    await run("blocked class in response", { ...base, seed: 603 });
    await run(
      "invalid JSON body",
      `{"model":"approved-model","messages":[{"role":"user","content":"${PROMPT}"`,
    );
    await run("oversized body", {
      ...base,
      messages: [{ role: "user", content: `${PROMPT} ${"x".repeat(2048)}` }],
    });
    await run("unapproved model", { ...base, model: "not-approved-model" });
    await run("unknown field", { ...base, extra_field: PROMPT });
    await run("unauthenticated", base, false, {});
    await run("bad bearer with canary", base, false, {
      authorization: `Bearer ${CANARIES.secret}`,
    });
    responses.push({
      label: "anthropic ingress deny",
      response: await gateway.handle(
        new Request("http://gateway/v1/messages", {
          method: "POST",
          headers: { "content-type": "application/json", authorization: AUTH },
          body: JSON.stringify({
            model: "approved-model",
            max_tokens: 64,
            messages: [{ role: "user", content: CARD_PROMPT }],
          }),
        }),
      ),
      mayCarryOriginals: false,
    });

    const seen = new Set<number>();
    for (const { label, response, mayCarryOriginals } of responses) {
      const text = await response.text();
      seen.add(response.status);
      if (!mayCarryOriginals) assertClean(text, `response body (${label}, ${response.status})`);
      for (const [name, value] of response.headers) {
        assertClean(`${name}: ${value}`, `response header (${label})`);
      }
    }
    for (const status of [200, 400, 401, 403, 413, 502, 504]) {
      if (!seen.has(status)) {
        throw new Error(`the run did not exercise a ${status} path (saw ${[...seen].sort()})`);
      }
    }

    const metrics = await (await gateway.handle(
      new Request("http://gateway/metrics", { headers: { authorization: AUTH } }),
    )).text();
    assertClean(metrics, "metrics");
    const checkpoint = await (await gateway.handle(
      new Request("http://gateway/v1/receipts/checkpoint", { headers: { authorization: AUTH } }),
    )).text();
    assertClean(checkpoint, "checkpoint");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await gateway.close();

    for (const body of provider.bodies) {
      const { seed } = JSON.parse(body) as { seed?: number };
      if (seed === LOCAL_ONLY_SEED) continue;
      assertClean(body, "bytes sent to the provider", true);
    }
    const localOnly = responses.find((r) => r.label.startsWith("local_only"))!.response;
    if (localOnly.headers.get("x-egrysa-decision") !== "local_only") {
      throw new Error("the confidential-term request was not routed local_only");
    }
    if (provider.bodies.length < 8) {
      throw new Error("provider saw too few requests for the run to be meaningful");
    }
    assertClean(await Deno.readTextFile(logPath), "receipt log on disk");
    for (const batch of sink.batches) assertClean(batch, "export sink batch");
    if (sink.batches.length === 0) throw new Error("nothing reached the export sink");
    // Most failure paths answer with a problem body and log nothing; the
    // detector-outage test below proves the log is exercised and clean.
    for (const line of captured.lines) assertClean(line, "structured log");
  } finally {
    captured.restore();
    await provider.close();
    await sink.close();
    await Deno.remove(logPath).catch(() => undefined);
  }
});

Deno.test("a required detector outage is logged and denied without content", async () => {
  await configureTestEnvironment();
  const captured = captureConsole();
  try {
    const config: AppConfig = testConfig();
    // A loopback port nothing listens on.
    config.nerDetector = {
      enabled: true,
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 200,
      totalTimeoutMs: 400,
      onDetectorFailure: "deny",
      kinds: ["person_name"],
    };
    const gateway = await Gateway.create(config);
    const response = await chat(gateway, {
      model: "approved-model",
      messages: [{ role: "user", content: PROMPT }],
    });
    const text = await response.text();
    await gateway.close();
    if (response.status !== 403) {
      throw new Error(`expected a deny, got ${response.status}: ${text}`);
    }
    assertClean(text, "detector-outage deny body");
    const degraded = captured.lines.find((line) => line.includes("detector_degraded"));
    if (!degraded) throw new Error("detector outage was not logged");
    assertClean(degraded, "detector_degraded event");
    for (const line of captured.lines) assertClean(line, "structured log");
  } finally {
    captured.restore();
  }
});

Deno.test("a rate-limited request is refused and logged without content", async () => {
  await configureTestEnvironment();
  const captured = captureConsole();
  try {
    const config: AppConfig = testConfig();
    config.policy.rateLimit = { requestsPerMinute: 1, burst: 1 };
    const gateway = await Gateway.create(config);
    const body = { model: "approved-model", messages: [{ role: "user", content: CARD_PROMPT }] };
    await (await chat(gateway, body)).text();
    const limited = await chat(gateway, body);
    const text = await limited.text();
    await gateway.close();
    if (limited.status !== 429) throw new Error(`expected 429, got ${limited.status}`);
    assertClean(text, "429 body");
    for (const line of captured.lines) assertClean(line, "structured log");
  } finally {
    captured.restore();
  }
});
