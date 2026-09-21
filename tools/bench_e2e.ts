// End-to-end gateway overhead benchmark.
//
// Run with `deno task bench:e2e`. It starts an in-process echo provider that
// runs no inference and answers in well under a millisecond, then an in-process
// gateway with a real, fsynced receipt log, and drives both with the same
// request shapes at several concurrency levels. The provider is measured on its
// own first, so the difference is what the gateway adds: authentication,
// classification, policy, surrogate replacement, the provider round trip,
// recomposition, Ed25519 signing, and the durable receipt append.
//
// Nothing here prints prompt or response content. The output is latency
// percentiles, throughput, and decision counts. The values in the request
// shapes are synthetic and documentation-reserved.
//
// Flags:
//   --requests=N        requests per cell (default 300)
//   --concurrency=1,16  comma-separated concurrency levels (default 1,16)
//   --receipts=file     "file" (default) or "memory"; memory isolates the fsync cost
import { Gateway } from "../src/gateway.ts";
import { bytesToBase64 } from "../src/crypto.ts";
import type { AppConfig } from "../src/types.ts";

interface Options {
  requests: number;
  concurrency: number[];
  receipts: "file" | "memory";
}

interface Cell {
  target: string;
  shape: string;
  concurrency: number;
  p50: number;
  p95: number;
  p99: number;
  rps: number;
  outcomes: string;
}

const MODEL = "bench-echo";
const RECEIPT_DIR = "data/bench-e2e";

function parseOptions(argv: string[]): Options {
  const options: Options = { requests: 300, concurrency: [1, 16], receipts: "file" };
  for (const arg of argv) {
    if (arg === "--") continue; // deno task forwards the separator
    const [name, value] = arg.split("=", 2);
    if (name === "--requests" && value) options.requests = Math.max(1, Number(value) || 0);
    else if (name === "--concurrency" && value) {
      options.concurrency = value.split(",").map((part) => Math.max(1, Number(part) || 0));
    } else if (name === "--receipts" && (value === "file" || value === "memory")) {
      options.receipts = value;
    } else {
      console.error(`unknown argument: ${arg}`);
      Deno.exit(2);
    }
  }
  return options;
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// The gateway reads its keys from the environment, exactly as in deployment.
async function configureEnvironment(): Promise<string> {
  const clientKey = randomHex(24);
  Deno.env.set("EGRYSA_INBOUND_KEYS", `bench-workload=${clientKey}`);
  Deno.env.set("EGRYSA_RECEIPT_FINGERPRINT_KEY", randomHex(32));
  const pair = await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ]) as CryptoKeyPair;
  Deno.env.set(
    "EGRYSA_RECEIPT_ED25519_PRIVATE_KEY",
    bytesToBase64(await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
  );
  Deno.env.set(
    "EGRYSA_RECEIPT_ED25519_PUBLIC_KEY",
    bytesToBase64(await crypto.subtle.exportKey("spki", pair.publicKey)),
  );
  return clientKey;
}

function lastUserText(body: { messages?: Array<{ role?: string; content?: unknown }> }): string {
  const last = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
  return typeof last?.content === "string" ? last.content : "";
}

// A minimal OpenAI-compatible echo. It exists so the provider side of the
// measurement is effectively free and identical for every shape.
function startProvider(): { port: Promise<number>; server: Deno.HttpServer } {
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  const encoder = new TextEncoder();
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/models") {
      return Response.json({ object: "list", data: [{ id: MODEL, object: "model" }] });
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      return Response.json({ error: { message: "not found" } }, { status: 404 });
    }
    const body = await request.json() as {
      stream?: boolean;
      messages?: Array<{ role?: string; content?: unknown }>;
    };
    const text = `Echo: ${lastUserText(body)}`;
    const created = Math.floor(Date.now() / 1000);
    if (body.stream === true) {
      const chunk = (delta: Record<string, unknown>, finish: string | null) =>
        `data: ${
          JSON.stringify({
            id: "bench",
            object: "chat.completion.chunk",
            created,
            model: MODEL,
            choices: [{ index: 0, delta, finish_reason: finish }],
          })
        }\n\n`;
      // Small pieces so holdback recomposition is exercised, as the stub does.
      const pieces = text.match(/[\s\S]{1,12}/g) ?? [text];
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(chunk({ role: "assistant" }, null)));
          for (const piece of pieces) {
            controller.enqueue(encoder.encode(chunk({ content: piece }, null)));
          }
          controller.enqueue(encoder.encode(chunk({}, "stop")));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({
      id: "bench",
      object: "chat.completion",
      created,
      model: MODEL,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });
  return { port, server };
}

function benchConfig(providerPort: number, receiptLogPath: string): AppConfig {
  return {
    listen: { hostname: "127.0.0.1", port: 0 },
    maxRequestBytes: 1024 * 1024,
    maxResponseBytes: 32 * 1024 * 1024,
    requestTimeoutMs: 60_000,
    receiptCapacity: 10_000,
    receiptLogPath,
    receiptMaxLogBytes: 1024 * 1024 * 1024,
    receiptChainId: "egrysa-bench-e2e",
    providers: [{
      id: "local",
      kind: "openai-compatible",
      baseUrl: `http://127.0.0.1:${providerPort}/v1`,
      allowedModels: [MODEL],
      local: true,
      dataPolicy: { training: "unknown", retention: "none", allowRaw: true },
    }],
    semanticDetector: {
      enabled: false,
      providerId: "local",
      model: MODEL,
      timeoutMs: 10_000,
      totalTimeoutMs: 30_000,
      maxInputBytes: 16_384,
      onDetectorFailure: "degrade",
      kinds: ["person_name", "physical_address", "semantic_confidential"],
    },
    policy: {
      defaultProvider: "local",
      localProvider: "local",
      blockKinds: ["credit_card", "private_key", "api_secret", "ssn"],
      localOnlyKinds: ["confidential_term", "semantic_confidential"],
      transformKinds: ["email", "phone", "ipv4", "iban", "person_name", "physical_address"],
      sensitiveTerms: [],
    },
  };
}

const SHAPES: Array<{ name: string; body: Record<string, unknown> }> = [
  {
    name: "plain",
    body: {
      model: MODEL,
      messages: [{
        role: "user",
        content: "Summarise the attached quarterly report in two lines.",
      }],
    },
  },
  {
    name: "transform x4",
    body: {
      model: MODEL,
      messages: [{
        role: "user",
        content: "Email alex@example.com and maria@example.org from host 192.0.2.44, " +
          "call +1 415 555 0134 about IBAN DE89370400440532013000.",
      }],
    },
  },
  {
    name: "transform x4, stream",
    body: {
      model: MODEL,
      stream: true,
      messages: [{
        role: "user",
        content: "Email alex@example.com and maria@example.org from host 192.0.2.44, " +
          "call +1 415 555 0134 about IBAN DE89370400440532013000.",
      }],
    },
  },
];

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

async function runCell(
  target: string,
  url: string,
  headers: HeadersInit,
  shape: { name: string; body: Record<string, unknown> },
  concurrency: number,
  requests: number,
): Promise<Cell> {
  const payload = JSON.stringify(shape.body);
  const latencies: number[] = [];
  const outcomes = new Map<string, number>();
  let issued = 0;
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (issued < requests) {
      issued++;
      const at = performance.now();
      const response = await fetch(url, { method: "POST", headers, body: payload });
      await response.text();
      latencies.push(performance.now() - at);
      const decision = response.headers.get("x-egrysa-decision");
      const key = decision ? `${response.status} ${decision}` : String(response.status);
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
    }
  }));
  const wall = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    target,
    shape: shape.name,
    concurrency,
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    rps: requests / wall,
    outcomes: [...outcomes].map(([key, count]) => `${key}:${count}`).join(" "),
  };
}

function printTable(cells: Cell[]): void {
  const rows = cells.map((cell) => [
    cell.target,
    cell.shape,
    String(cell.concurrency),
    cell.p50.toFixed(2),
    cell.p95.toFixed(2),
    cell.p99.toFixed(2),
    cell.rps.toFixed(0),
    cell.outcomes,
  ]);
  const header = ["target", "shape", "conc", "p50 ms", "p95 ms", "p99 ms", "rps", "outcomes"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => row[column]?.length ?? 0))
  );
  const line = (row: string[]) =>
    "| " + row.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join(" | ") + " |";
  console.log(line(header));
  console.log("| " + widths.map((width) => "-".repeat(width)).join(" | ") + " |");
  for (const row of rows) console.log(line(row));
}

async function main(): Promise<void> {
  const options = parseOptions(Deno.args);
  const clientKey = await configureEnvironment();

  let receiptLogPath = ":memory:";
  if (options.receipts === "file") {
    await Deno.mkdir(RECEIPT_DIR, { recursive: true });
    receiptLogPath = `${RECEIPT_DIR}/receipts.${randomHex(4)}.jsonl`;
  }

  const provider = startProvider();
  const providerPort = await provider.port;
  const gateway = await Gateway.create(benchConfig(providerPort, receiptLogPath));
  let resolveGatewayPort!: (port: number) => void;
  const gatewayPort = new Promise<number>((resolve) => resolveGatewayPort = resolve);
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolveGatewayPort(port),
  }, (request) => gateway.handle(request));

  try {
    const providerUrl = `http://127.0.0.1:${providerPort}/v1/chat/completions`;
    const gatewayUrl = `http://127.0.0.1:${await gatewayPort}/v1/chat/completions`;
    const plainHeaders = { "content-type": "application/json" };
    const gatewayHeaders = { ...plainHeaders, authorization: `Bearer ${clientKey}` };

    console.log(
      `Egrysa end-to-end benchmark: Deno ${Deno.version.deno}, receipts=${options.receipts}, ` +
        `${options.requests} requests per cell, concurrency ${options.concurrency.join("/")}`,
    );
    console.log("Latency is per request as seen by the caller. Provider alone is the floor.\n");

    // Warm both servers so JIT and connection setup do not land in the first cell.
    await runCell("warm", gatewayUrl, gatewayHeaders, SHAPES[1]!, 4, 40);

    const cells: Cell[] = [];
    for (const concurrency of options.concurrency) {
      cells.push(
        await runCell(
          "provider alone",
          providerUrl,
          plainHeaders,
          SHAPES[0]!,
          concurrency,
          options.requests,
        ),
      );
    }
    for (const shape of SHAPES) {
      for (const concurrency of options.concurrency) {
        cells.push(
          await runCell(
            "gateway",
            gatewayUrl,
            gatewayHeaders,
            shape,
            concurrency,
            options.requests,
          ),
        );
      }
    }
    printTable(cells);

    const floor = cells.find((cell) => cell.target === "provider alone");
    const plain = cells.find((cell) => cell.target === "gateway" && cell.shape === "plain");
    const transform = cells.find((cell) =>
      cell.target === "gateway" && cell.shape === "transform x4"
    );
    if (floor && plain && transform) {
      console.log(
        `\nGateway overhead at concurrency ${floor.concurrency}: ` +
          `p50 ${(plain.p50 - floor.p50).toFixed(2)} ms plain, ` +
          `${(transform.p50 - floor.p50).toFixed(2)} ms with four transformed values.`,
      );
    }
    console.log(
      options.receipts === "file"
        ? "Throughput is bounded by the fsynced receipt append; compare --receipts=memory to see the disk cost."
        : "Receipts were not persisted; the default file mode adds one fsync per request on top of this.",
    );
  } finally {
    await server.shutdown();
    await gateway.close();
    await provider.server.shutdown();
    if (receiptLogPath !== ":memory:") {
      await Deno.remove(RECEIPT_DIR, { recursive: true }).catch(() => undefined);
    }
  }
}

await main();
