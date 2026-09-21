import { validateConfig } from "../src/config.ts";
import { DetectorExecutionError, runDetector, runDetectorDetailed } from "../src/detectors.ts";
import { Gateway } from "../src/gateway.ts";
import { createNerDetector, REFERENCE_NER_DETECTOR_ID } from "../src/ner.ts";
import type { AppConfig } from "../src/types.ts";
import { configureTestEnvironment } from "./environment.ts";
import { testConfig } from "./fixtures.ts";

type SidecarReply = (text: string, kinds: string[]) => Response | Promise<Response>;

// A minimal stand-in for tools/ner_sidecar/server.py speaking the same contract.
async function withSidecar(
  reply: SidecarReply,
  action: (baseUrl: string, calls: () => number) => Promise<void>,
): Promise<void> {
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  let calls = 0;
  const server = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, async (request) => {
    calls++;
    const body = await request.json() as { text: string; kinds: string[] };
    return await reply(body.text, body.kinds);
  });
  try {
    await action(`http://127.0.0.1:${await port}`, () => calls);
  } finally {
    await server.shutdown();
  }
}

function findings(items: Array<{ kind: string; text: string; confidence: number }>): Response {
  return Response.json({
    contractVersion: "1",
    detector: { id: "test-sidecar", version: "0" },
    findings: items,
  });
}

function nerConfig(baseUrl: string, onFailure: "degrade" | "deny" = "degrade"): AppConfig {
  const config = testConfig();
  config.nerDetector = {
    enabled: true,
    baseUrl,
    timeoutMs: 100,
    totalTimeoutMs: 400,
    minConfidence: 0.5,
    onDetectorFailure: onFailure,
  };
  return config;
}

Deno.test("reference NER detector accepts only literal, requested, confident candidates", async () => {
  await withSidecar(
    (text) =>
      findings([
        { kind: "person_name", text: "Maya Chen", confidence: 0.91 },
        { kind: "physical_address", text: "12 Residency Road, Bengaluru 560025", confidence: 0.8 },
        { kind: "person_name", text: "Ada Lovelace", confidence: 0.9 }, // not in the text
        { kind: "person_name", text: "Ravi", confidence: 0.2 }, // below minConfidence
        { kind: "semantic_confidential", text: text.slice(0, 4), confidence: 0.9 }, // not a NER kind
      ]),
    async (baseUrl) => {
      const detector = createNerDetector(nerConfig(baseUrl))!;
      const text =
        "Send it to Maya Chen at 12 Residency Road, Bengaluru 560025; Ravi will follow up.";
      const result = await runDetector(detector, text);
      const summary = result.map((f) => `${f.kind}:${f.value}:${f.precision}`).sort();
      const expected = [
        "person_name:Maya Chen:low",
        "physical_address:12 Residency Road, Bengaluru 560025:low",
      ];
      if (JSON.stringify(summary) !== JSON.stringify(expected)) {
        throw new Error(`unexpected findings: ${summary.join(" | ")}`);
      }
      for (const finding of result) {
        if (text.slice(finding.start, finding.end) !== finding.value) {
          throw new Error("finding offsets do not match the surface");
        }
      }
    },
  );
});

Deno.test("reference NER detector times out per chunk and reports a timeout class", async () => {
  await withSidecar(
    async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return findings([]);
    },
    async (baseUrl) => {
      const detector = createNerDetector(nerConfig(baseUrl))!;
      let failure: DetectorExecutionError | undefined;
      try {
        await runDetectorDetailed(detector, "Ordinary text.");
      } catch (error) {
        if (error instanceof DetectorExecutionError) failure = error;
      }
      if (failure?.errorClass !== "timeout" || failure.detectorId !== REFERENCE_NER_DETECTOR_ID) {
        throw new Error("slow sidecar was not reported as a timeout");
      }
    },
  );
});

Deno.test("reference NER detector rejects a response outside the contract", async () => {
  await withSidecar(
    () => Response.json({ contractVersion: "2", findings: [] }),
    async (baseUrl) => {
      const detector = createNerDetector(nerConfig(baseUrl))!;
      let failure: DetectorExecutionError | undefined;
      try {
        await runDetectorDetailed(detector, "Ordinary text.");
      } catch (error) {
        if (error instanceof DetectorExecutionError) failure = error;
      }
      if (failure?.errorClass !== "schema") {
        throw new Error("contract mismatch was not a schema error");
      }
    },
  );
});

Deno.test("NER detector configuration must stay on loopback", () => {
  for (const baseUrl of ["http://ner.internal:11436", "http://127.0.0.1:11436/?x=1"]) {
    const config = nerConfig(baseUrl);
    let rejected = false;
    try {
      validateConfig(config);
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error(`accepted a NER endpoint that is not loopback: ${baseUrl}`);
  }
  validateConfig(nerConfig("http://127.0.0.1:11436"));
});

Deno.test("a NER finding is surrogated before egress and recomposed locally", async () => {
  await configureTestEnvironment();
  let providerSaw = "";
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  const provider = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, async (request) => {
    const body = await request.json() as { messages: Array<{ content: string }> };
    providerSaw = body.messages[0]!.content;
    return Response.json({
      id: "ner-gateway-test",
      object: "chat.completion",
      choices: [{
        index: 0,
        message: { role: "assistant", content: `Noted: ${providerSaw}` },
        finish_reason: "stop",
      }],
    });
  });
  try {
    await withSidecar(
      (text) =>
        findings(
          text.includes("Maya Chen")
            ? [{ kind: "person_name", text: "Maya Chen", confidence: 0.9 }]
            : [],
        ),
      async (baseUrl) => {
        const config = nerConfig(baseUrl);
        config.providers[1]!.baseUrl = `http://127.0.0.1:${await port}/v1`;
        config.policy.defaultProvider = "local";
        const gateway = await Gateway.create(config);
        const response = await gateway.handle(chatRequest("Send the briefing to Maya Chen today."));
        const text = await response.text();
        if (response.status !== 200 || response.headers.get("x-egrysa-decision") !== "transform") {
          throw new Error(`expected a transform decision, got ${response.status} ${text}`);
        }
        if (providerSaw.includes("Maya Chen") || !/__EGRYSA_PERSON_NAME_/.test(providerSaw)) {
          throw new Error("the name reached the provider or was not surrogated");
        }
        if (!text.includes("Maya Chen")) throw new Error("the name was not recomposed locally");
        const receiptId = response.headers.get("x-egrysa-receipt")!;
        const receipt = await (await gateway.handle(receiptRequest(receiptId))).json();
        if (
          receipt.findingCounts?.person_name !== 1 || receipt.detectorDegraded !== false ||
          !receipt.detectors?.some((d: { id: string }) => d.id === REFERENCE_NER_DETECTOR_ID) ||
          JSON.stringify(receipt).includes("Maya")
        ) throw new Error("receipt evidence for the NER finding is wrong or leaks content");
        await gateway.close();
      },
    );
  } finally {
    await provider.shutdown();
  }
});

for (const onFailure of ["degrade", "deny"] as const) {
  Deno.test(`NER sidecar failure follows its own ${onFailure} policy`, async () => {
    await configureTestEnvironment();
    let providerCalls = 0;
    let resolvePort!: (port: number) => void;
    const port = new Promise<number>((resolve) => resolvePort = resolve);
    const provider = Deno.serve({
      hostname: "127.0.0.1",
      port: 0,
      onListen: ({ port }) => resolvePort(port),
    }, () => {
      providerCalls++;
      return Response.json({
        id: "ner-gateway-test",
        object: "chat.completion",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "ok" },
          finish_reason: "stop",
        }],
      });
    });
    try {
      await withSidecar(
        () => new Response("boom", { status: 500 }),
        async (baseUrl) => {
          const config = nerConfig(baseUrl, onFailure);
          config.providers[1]!.baseUrl = `http://127.0.0.1:${await port}/v1`;
          config.policy.defaultProvider = "local";
          const gateway = await Gateway.create(config);
          const response = await gateway.handle(chatRequest("An ordinary request."));
          const expectedStatus = onFailure === "degrade" ? 200 : 403;
          const expectedCalls = onFailure === "degrade" ? 1 : 0;
          if (response.status !== expectedStatus || providerCalls !== expectedCalls) {
            throw new Error(`sidecar failure did not follow ${onFailure}: ${response.status}`);
          }
          const receiptId = response.headers.get("x-egrysa-receipt") ??
            (await response.json()).receiptId;
          const receipt = await (await gateway.handle(receiptRequest(receiptId))).json();
          if (receipt.detectorDegraded !== true) {
            throw new Error("sidecar failure was not recorded as degradation");
          }
          await gateway.close();
        },
      );
    } finally {
      await provider.shutdown();
    }
  });
}

function chatRequest(content: string): Request {
  return new Request("http://gateway/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: "Bearer a-test-client-key-that-is-long-enough",
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: "approved-model", messages: [{ role: "user", content }] }),
  });
}

function receiptRequest(id: string): Request {
  return new Request(`http://gateway/v1/receipts/${id}`, {
    headers: { authorization: "Bearer a-test-client-key-that-is-long-enough" },
  });
}
