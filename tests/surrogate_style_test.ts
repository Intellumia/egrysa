import { validateConfig } from "../src/config.ts";
import { Gateway } from "../src/gateway.ts";
import {
  createSurrogateState,
  prepareDurableSurrogates,
  recompose,
  transform,
} from "../src/surrogate.ts";
import { synthesize } from "../src/synthetic.ts";
import type { AppConfig, Finding, FindingKind } from "../src/types.ts";
import { configureTestEnvironment } from "./environment.ts";
import { testConfig } from "./fixtures.ts";

const AUTH = "Bearer a-test-client-key-that-is-long-enough";

Deno.test("synthetic surrogates keep the shape of each kind and use reserved ranges", () => {
  const bytes = new Uint8Array(32).map((_, index) => (index * 37 + 11) % 256);
  const checks: Array<[FindingKind, RegExp]> = [
    ["email", /^[a-z]+\.[a-z]+\d+@example\.net$/],
    ["phone", /^\(\d{3}\) 555-01\d{2}$/],
    ["ipv4", /^(?:192\.0\.2|198\.51\.100|203\.0\.113)\.\d{1,3}$/],
    ["ipv6", /^2001:db8:(?:[0-9a-f]{4}:){5}[0-9a-f]{4}$/],
    ["mac_address", /^02(?::[0-9a-f]{2}){5}$/],
    ["iban", /^GB\d{2}SYNT\d{14}$/],
    ["person_name", /^[A-Z][a-z]+ [A-Z][a-z]+$/],
    ["physical_address", /^\d+ [A-Z][a-z]+ [A-Z][a-z]+, [A-Z][a-z]+$/],
    ["organization", /^[A-Z][a-z]+ [A-Z][a-z]+ [A-Za-z ]+$/],
    ["date_of_birth", /^\d{1,2} [A-Z][a-z]{2} (?:19|20)\d{2}$/],
    ["crypto_wallet", /^0x[0-9a-f]{40}$/],
    ["vin", /^[A-HJ-NPR-Z0-9]{17}$/],
  ];
  for (const [kind, shape] of checks) {
    const value = synthesize(kind, bytes);
    if (!value || !shape.test(value)) throw new Error(`${kind}: ${value} does not match ${shape}`);
    if (synthesize(kind, bytes) !== value) throw new Error(`${kind}: not deterministic`);
  }
  if (synthesize("api_secret", bytes) !== null) throw new Error("blocked kind was synthesised");
});

function finding(kind: FindingKind, text: string, value: string): Finding {
  const start = text.indexOf(value);
  return { kind, start, end: start + value.length, value, precision: "high", confidence: 1 };
}

Deno.test("synthetic style produces natural values that recompose exactly", () => {
  const text = "Email alex@example.com and call +1 415 555 0134 about it.";
  const findings = [
    finding("email", text, "alex@example.com"),
    finding("phone", text, "+1 415 555 0134"),
  ];
  const state = createSurrogateState("synthetic");
  const result = transform(text, findings, new Set(["email", "phone"]), state);
  if (result.text.includes("alex@example.com") || result.text.includes("EGRYSA")) {
    throw new Error(`synthetic transform leaked or used a token: ${result.text}`);
  }
  if (!/@example\.net/.test(result.text) || !/555-01\d\d/.test(result.text)) {
    throw new Error(`synthetic values missing: ${result.text}`);
  }
  if (recompose(result.text, result.mapping) !== text) throw new Error("recomposition failed");
});

Deno.test("workload scope gives the same surrogate for the same value across requests", async () => {
  const text = "Email alex@example.com now.";
  const findings = [finding("email", text, "alex@example.com")];
  const allowed = new Set(["email"]);
  const key = { secret: "a-test-fingerprint-key-that-is-at-least-32-characters", workloadId: "w1" };
  const first = createSurrogateState("token");
  await prepareDurableSurrogates(first, findings, allowed, key);
  const second = createSurrogateState("token");
  await prepareDurableSurrogates(second, findings, allowed, key);
  const other = createSurrogateState("token");
  await prepareDurableSurrogates(other, findings, allowed, { ...key, workloadId: "w2" });
  const a = transform(text, findings, allowed, first).text;
  const b = transform(text, findings, allowed, second).text;
  const c = transform(text, findings, allowed, other).text;
  if (a !== b) throw new Error("durable surrogate differed between requests");
  if (a === c) throw new Error("durable surrogate did not differ between workloads");
  if (!/__EGRYSA_EMAIL_[a-f0-9]{12}__/.test(a)) throw new Error(`unexpected token shape: ${a}`);
  const perRequest = transform(text, findings, allowed).text;
  const again = transform(text, findings, allowed).text;
  if (perRequest === again) throw new Error("request-scoped surrogates repeated");
});

async function withEchoProvider(
  action: (config: AppConfig, providerSaw: () => string) => Promise<void>,
): Promise<void> {
  await configureTestEnvironment();
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  let saw = "";
  const encoder = new TextEncoder();
  const provider = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, async (request) => {
    const body = await request.json() as { messages: Array<{ content: string }>; stream?: boolean };
    saw = body.messages[0]!.content;
    const reply = `Noted: ${saw}`;
    if (body.stream) {
      const pieces = reply.match(/[\s\S]{1,7}/g) ?? [reply];
      const frames = pieces.map((piece) =>
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
    await provider.shutdown();
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

Deno.test("synthetic workload-scoped surrogates round-trip through the gateway, streamed or not", async () => {
  await withEchoProvider(async (config, providerSaw) => {
    config.policy.surrogates = { style: "synthetic", scope: "workload" };
    const gateway = await Gateway.create(config);
    const prompt = "Email alex@example.com from 192.0.2.44 today.";
    const first = await gateway.handle(chat(prompt));
    const firstBody = await first.text();
    const firstSeen = providerSaw();
    if (firstSeen.includes("alex@example.com") || firstSeen.includes("192.0.2.44")) {
      throw new Error("originals reached the provider");
    }
    if (!/@example\.net/.test(firstSeen) || firstSeen.includes("EGRYSA")) {
      throw new Error(`provider did not see synthetic values: ${firstSeen}`);
    }
    if (!firstBody.includes("alex@example.com") || !firstBody.includes("192.0.2.44")) {
      throw new Error("response was not recomposed");
    }
    const receipt = await (await gateway.handle(
      new Request(`http://gateway/v1/receipts/${first.headers.get("x-egrysa-receipt")}`, {
        headers: { authorization: AUTH },
      }),
    )).json();
    if (
      receipt.response?.action !== "none" ||
      Object.keys(receipt.response.findingCounts ?? { x: 1 }).length !== 0
    ) {
      throw new Error(
        `synthetic surrogates were counted as response findings: ${
          JSON.stringify(receipt.response)
        }`,
      );
    }
    const second = await gateway.handle(chat(prompt, true));
    const streamed = await second.text();
    if (providerSaw() !== firstSeen) throw new Error("durable surrogates changed between requests");
    if (!streamed.includes("alex@example.com") || !streamed.includes("[DONE]")) {
      throw new Error(`streamed response was not recomposed: ${streamed.slice(0, 300)}`);
    }
    await gateway.close();
  });
});

Deno.test("surrogate policy is validated", () => {
  for (const surrogates of [{ style: "fancy" }, { scope: "global" }, { extra: 1 }] as never[]) {
    const config = testConfig();
    config.policy.surrogates = surrogates;
    let threw = false;
    try {
      validateConfig(config);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`accepted ${JSON.stringify(surrogates)}`);
  }
});
