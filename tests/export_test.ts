import { validateConfig } from "../src/config.ts";
import { Exporter, toOtlpLogs } from "../src/export.ts";
import { Gateway } from "../src/gateway.ts";
import { verifyReceipt } from "../src/receipts.ts";
import type { AppConfig, PrivacyReceipt, ReceiptCheckpoint } from "../src/types.ts";
import { configureTestEnvironment } from "./environment.ts";
import { testConfig } from "./fixtures.ts";

const AUTH = "Bearer a-test-client-key-that-is-long-enough";

interface Sink {
  url: string;
  batches: Array<{ headers: Headers; text: string }>;
  failNext: number;
  close: () => Promise<void>;
}

async function startSink(): Promise<Sink> {
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  const sink: Sink = { url: "", batches: [], failNext: 0, close: async () => {} };
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, async (request) => {
    const text = await request.text();
    if (sink.failNext > 0) {
      sink.failNext--;
      return new Response("busy", { status: 503 });
    }
    sink.batches.push({ headers: request.headers, text });
    return new Response(null, { status: 204 });
  });
  sink.url = `http://127.0.0.1:${await port}/collect`;
  sink.close = () => server.shutdown();
  return sink;
}

function fakeCheckpoint(): ReceiptCheckpoint {
  return {
    version: "1",
    chainId: "export-test",
    sequence: 7,
    receiptHash: null,
    timestamp: new Date().toISOString(),
    signingKeyId: "k",
    signature: "s",
  };
}

async function until(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

Deno.test("receipts, events, and checkpoints reach the sink as JSON lines with sink headers", async () => {
  const sink = await startSink();
  Deno.env.set("EXPORT_TEST_HEADERS", "Authorization: Splunk abc123\nX-Tenant: t1");
  try {
    const exporter = new Exporter({
      url: sink.url,
      format: "jsonl",
      headersEnv: "EXPORT_TEST_HEADERS",
      batchSize: 2,
      flushIntervalMs: 100,
      queueCapacity: 100,
      checkpointEveryReceipts: 2,
      timeoutMs: 1000,
    }, () => Promise.resolve(fakeCheckpoint()));
    exporter.event({ event: "rate_limited", workloadId: "w" });
    exporter.receipt({ id: "r1", workloadId: "w" } as unknown as PrivacyReceipt);
    exporter.receipt({ id: "r2", workloadId: "w" } as unknown as PrivacyReceipt);
    await until(() => exporter.stats.sent >= 4);
    await exporter.close();
    const lines = sink.batches.flatMap((batch) => batch.text.trim().split("\n")).map((line) =>
      JSON.parse(line)
    );
    const kinds = lines.map((line) => line.record);
    if (!kinds.includes("event") || kinds.filter((k) => k === "receipt").length !== 2) {
      throw new Error(`unexpected records: ${kinds}`);
    }
    if (kinds.filter((k) => k === "checkpoint").length < 2) {
      throw new Error("checkpoint was not anchored every N receipts and at close");
    }
    const headers = sink.batches[0]!.headers;
    if (
      headers.get("authorization") !== "Splunk abc123" || headers.get("x-tenant") !== "t1" ||
      !headers.get("content-type")?.includes("ndjson")
    ) throw new Error("sink headers were not applied");
  } finally {
    Deno.env.delete("EXPORT_TEST_HEADERS");
    await sink.close();
  }
});

Deno.test("a failing sink is retried with backoff and an overflowing queue drops oldest with a count", async () => {
  const sink = await startSink();
  try {
    sink.failNext = 2;
    const exporter = new Exporter({
      url: sink.url,
      format: "jsonl",
      headersEnv: "",
      batchSize: 10,
      flushIntervalMs: 50,
      queueCapacity: 3,
      checkpointEveryReceipts: 1000,
      timeoutMs: 1000,
    }, () => Promise.resolve(fakeCheckpoint()));
    for (let index = 0; index < 5; index++) exporter.event({ event: "e", n: index });
    if (exporter.stats.dropped !== 2 || exporter.stats.queued !== 3) {
      throw new Error(`overflow accounting wrong: ${JSON.stringify(exporter.stats)}`);
    }
    await until(() => exporter.stats.sent >= 3, 6000);
    if (exporter.stats.failedBatches < 2 || exporter.stats.sent !== 3) {
      throw new Error(`retry accounting wrong: ${JSON.stringify(exporter.stats)}`);
    }
    const delivered = sink.batches.flatMap((b) => b.text.trim().split("\n")).map((l) =>
      JSON.parse(l).n
    );
    if (JSON.stringify(delivered) !== "[2,3,4]") {
      throw new Error(`wrong records survived: ${delivered}`);
    }
    await exporter.close();
  } finally {
    await sink.close();
  }
});

Deno.test("OTLP format wraps records as log records with attributes", () => {
  const payload = toOtlpLogs([
    { kind: "receipt", body: { id: "r", decision: "deny", findingCounts: { email: 1 } } },
  ], 1_700_000_000_000) as {
    resourceLogs: Array<{ scopeLogs: Array<{ logRecords: Array<Record<string, unknown>> }> }>;
  };
  const record = payload.resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!;
  const attributes = record.attributes as Array<{ key: string; value: Record<string, unknown> }>;
  const byKey = Object.fromEntries(attributes.map((a) => [a.key, a.value]));
  if (
    record.timeUnixNano !== "1700000000000000000" ||
    JSON.stringify(byKey["egrysa.record"]) !== '{"stringValue":"receipt"}' ||
    JSON.stringify(byKey["egrysa.decision"]) !== '{"stringValue":"deny"}' ||
    "egrysa.findingCounts" in byKey ||
    !String((record.body as { stringValue: string }).stringValue).includes('"email":1')
  ) throw new Error(`unexpected OTLP shape: ${JSON.stringify(record)}`);
});

Deno.test("the gateway exports signed receipts that verify against its public key", async () => {
  await configureTestEnvironment();
  const sink = await startSink();
  try {
    const config: AppConfig = testConfig();
    config.export = { url: sink.url, batchSize: 1, flushIntervalMs: 50 };
    const gateway = await Gateway.create(config);
    const response = await gateway.handle(
      new Request("http://gateway/v1/chat/completions", {
        method: "POST",
        headers: { authorization: AUTH, "content-type": "application/json" },
        body: JSON.stringify({
          model: "approved-model",
          messages: [{ role: "user", content: "Use card 4111 1111 1111 1111" }],
        }),
      }),
    );
    await response.text();
    await until(() => sink.batches.length >= 1);
    await gateway.close();
    const records = sink.batches.flatMap((b) => b.text.trim().split("\n")).map((l) =>
      JSON.parse(l)
    );
    const exported = records.find((r) => r.record === "receipt");
    if (!exported) throw new Error("no receipt was exported");
    const { record: _record, ...receipt } = exported;
    const publicKey = (await (await gateway.handle(
      new Request("http://gateway/v1/receipts/public-key", { headers: { authorization: AUTH } }),
    )).json()).publicKey;
    if (!await verifyReceipt(receipt as PrivacyReceipt, publicKey)) {
      throw new Error("exported receipt did not verify");
    }
    if (JSON.stringify(records).includes("4111")) throw new Error("export carried content");
    if (!records.some((r) => r.record === "checkpoint")) throw new Error("no checkpoint at close");
  } finally {
    await sink.close();
  }
});

Deno.test("export configuration is validated", () => {
  for (
    const bad of [
      { url: "http://siem.internal/collect" },
      { url: "https://user:pw@siem.internal/collect" },
      { url: "https://siem.internal/collect", format: "csv" },
      { url: "https://siem.internal/collect", batchSize: 0 },
      { url: "https://siem.internal/collect", extra: true },
    ] as never[]
  ) {
    const config = testConfig();
    config.export = bad;
    let threw = false;
    try {
      validateConfig(config);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`accepted ${JSON.stringify(bad)}`);
  }
  const good = testConfig();
  good.export = {
    url: "https://siem.internal/collect",
    format: "otlp",
    headersEnv: "SIEM_HEADERS",
  };
  validateConfig(good);
});
