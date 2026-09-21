import { validateConfig } from "../src/config.ts";
import { Gateway } from "../src/gateway.ts";
import { RateLimiter } from "../src/ratelimit.ts";
import type { AppConfig, RateLimitConfig } from "../src/types.ts";
import { configureTestEnvironment } from "./environment.ts";
import { testConfig } from "./fixtures.ts";

const TEST_KEY = "a-test-client-key-that-is-long-enough";
const FINANCE_KEY = "a-finance-client-key-that-is-long-enough";
const AUDITOR_KEY = "an-auditor-read-only-key-that-is-long-enough";

Deno.test("token bucket refills at the configured rate up to the burst", () => {
  let clock = 0;
  const limiter = new RateLimiter(() => clock);
  const limit = { requestsPerMinute: 60, burst: 3 };
  if ([0, 0, 0].some(() => limiter.take("w", limit) !== 0)) throw new Error("burst not honoured");
  const wait = limiter.take("w", limit);
  if (wait <= 0 || wait > 1000) throw new Error(`expected a wait of about one second, got ${wait}`);
  clock += 1000;
  if (limiter.take("w", limit) !== 0) throw new Error("one token did not refill after a second");
  clock += 60_000;
  if ([0, 0, 0].some(() => limiter.take("w", limit) !== 0) || limiter.take("w", limit) === 0) {
    throw new Error("refill was not capped at the burst");
  }
  if (limiter.take("other", limit) !== 0) throw new Error("buckets are not per workload");
});

async function withLocalProvider(
  action: (config: AppConfig, providerCalls: () => number) => Promise<void>,
): Promise<void> {
  await configureTestEnvironment();
  Deno.env.set("EGRYSA_INBOUND_KEYS", `test-workload=${TEST_KEY},finance=${FINANCE_KEY}`);
  Deno.env.set("EGRYSA_AUDITOR_KEYS", `audit-team=${AUDITOR_KEY}`);
  let resolvePort!: (port: number) => void;
  const port = new Promise<number>((resolve) => resolvePort = resolve);
  let calls = 0;
  const provider = Deno.serve({
    hostname: "127.0.0.1",
    port: 0,
    onListen: ({ port }) => resolvePort(port),
  }, () => {
    calls++;
    return Response.json({
      id: "r",
      object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
    });
  });
  try {
    const config = testConfig();
    config.providers[1]!.baseUrl = `http://127.0.0.1:${await port}/v1`;
    config.policy.defaultProvider = "local";
    await action(config, () => calls);
  } finally {
    await provider.shutdown();
    Deno.env.set("EGRYSA_INBOUND_KEYS", `test-workload=${TEST_KEY}`);
    Deno.env.delete("EGRYSA_AUDITOR_KEYS");
  }
}

function request(key: string, path: string, body?: unknown): Request {
  return new Request(`http://gateway${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const CHAT = { model: "approved-model", messages: [{ role: "user", content: "Summarise it." }] };

Deno.test("a workload over its rate limit receives 429 with Retry-After and is counted", async () => {
  await withLocalProvider(async (config, providerCalls) => {
    config.policy.rateLimit = { requestsPerMinute: 60, burst: 2 };
    config.workloads = { finance: { rateLimit: { requestsPerMinute: 600, burst: 5 } } };
    const gateway = await Gateway.create(config);
    const statuses: number[] = [];
    for (let index = 0; index < 3; index++) {
      const response = await gateway.handle(request(TEST_KEY, "/v1/chat/completions", CHAT));
      statuses.push(response.status);
      if (response.status === 429) {
        const retry = Number(response.headers.get("retry-after"));
        const body = await response.json();
        if (!(retry >= 1) || body.title !== "rate_limited") {
          throw new Error("429 lacked Retry-After or the problem title");
        }
      } else {
        await response.text();
      }
    }
    if (JSON.stringify(statuses) !== "[200,200,429]") {
      throw new Error(`expected 200,200,429; got ${statuses}`);
    }
    if (providerCalls() !== 2) throw new Error("a limited request reached the provider");
    // The finance workload has its own, larger bucket.
    for (let index = 0; index < 5; index++) {
      const response = await gateway.handle(request(FINANCE_KEY, "/v1/chat/completions", CHAT));
      await response.text();
      if (response.status !== 200) throw new Error("per-workload limit was not applied");
    }
    if (!gateway.metrics.render().includes("egrysa_rate_limited_total 1")) {
      throw new Error("rate limiting was not counted");
    }
    await gateway.close();
  });
});

Deno.test("an auditor key reads any workload's receipts and metrics but cannot submit", async () => {
  await withLocalProvider(async (config) => {
    const gateway = await Gateway.create(config);
    const made = await gateway.handle(request(FINANCE_KEY, "/v1/chat/completions", CHAT));
    await made.text();
    const receiptId = made.headers.get("x-egrysa-receipt")!;
    const asAuditor = await gateway.handle(request(AUDITOR_KEY, `/v1/receipts/${receiptId}`));
    const asOtherCaller = await gateway.handle(request(TEST_KEY, `/v1/receipts/${receiptId}`));
    const metrics = await gateway.handle(request(AUDITOR_KEY, "/metrics"));
    const submit = await gateway.handle(request(AUDITOR_KEY, "/v1/chat/completions", CHAT));
    const receipt = await asAuditor.json();
    await asOtherCaller.text();
    await metrics.text();
    const refused = await submit.json();
    if (asAuditor.status !== 200 || receipt.workloadId !== "finance") {
      throw new Error("auditor could not read another workload's receipt");
    }
    if (asOtherCaller.status !== 404) throw new Error("a caller read another workload's receipt");
    if (metrics.status !== 200) throw new Error("auditor could not read metrics");
    if (submit.status !== 403 || refused.title !== "forbidden") {
      throw new Error("auditor key was allowed to submit a request");
    }
    await gateway.close();
  });
});

Deno.test("rate limit configuration is validated", () => {
  const bad: RateLimitConfig[] = [
    { requestsPerMinute: 0 },
    { requestsPerMinute: 60, burst: 0 },
    { requestsPerMinute: 1.5 },
    { requestsPerMinute: 60, extra: 1 } as never,
  ];
  for (const rateLimit of bad) {
    const config = testConfig();
    config.policy.rateLimit = rateLimit;
    let threw = false;
    try {
      validateConfig(config);
    } catch {
      threw = true;
    }
    if (!threw) throw new Error(`accepted ${JSON.stringify(rateLimit)}`);
  }
  const good = testConfig();
  good.policy.rateLimit = { requestsPerMinute: 120 };
  validateConfig(good);
});
